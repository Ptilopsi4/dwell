import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionTask, GenerationTask, LiveDoc, ToolResultEntry, ToolTask, defineDoc, defineExtension, defineTool, hook, section, type ConversationId, type EntryId, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { abortBeforeRequest } from "./approval.ts";
import { BudgetDoc } from "./budget.ts";
import { artifactManifest, manifestSummary, unexpectedChanges, verificationContract, type ArtifactManifest, type CheckReceipt, type VerificationContract, type WorkVerification } from "../verification.ts";

export type WorkIdentity = { conversationId: number; id: string };
export type WorkLimits = { modelAdmissions: number; toolAdmissions: number };
export const DEFAULT_WORK_LIMITS: Readonly<WorkLimits> = { modelAdmissions: 128, toolAdmissions: 512 };
export type WorkRecord = {
	id: string; creator: string; goal: string; acceptance: string[]; progress: string; blockers: string[];
	evidence: number[]; review: string; status: "active" | "ready_for_review" | "accepted";
	createdAt: number; updatedAt: number; acceptedBy?: string; acceptedAt?: number;
	limits: WorkLimits; stopped?: "model_limit" | "tool_limit";
	verification?: WorkVerification;
	usage: { scope: "generation_and_tools"; pricingKnown: boolean; modelAdmissions: number; toolAdmissions: number; modelResponses: number; toolResults: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cost: number | null };
	availableEvidence: Record<string, { conversationId: number; toolName: string }>;
	// Cursors and task claims deduplicate committed results across restart; admissions bound their size.
	members: Record<string, number>;
	tasks: Record<string, { conversationId: number; kind: "model" | "tool" }>;
};
export const WorkDoc = defineDoc<{
	current?: string; inherited?: WorkIdentity | null;
	runs: Record<string, WorkIdentity | null>; records: Record<string, WorkRecord>;
}>({ kind: "dwell.work", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ runs: {}, records: {} }), checkpointWhen: () => true });

type VerificationEnv = (conversationId: number, context: Context) => Promise<ExecutionEnv>;
const verificationReaders = new WeakMap<Harness, VerificationEnv>();
async function snapshotArtifacts(harness: Harness, conversationId: number, contract: VerificationContract, context: Context, allowMissing = false): Promise<ArtifactManifest> {
	const factory = verificationReaders.get(harness);
	if (factory === undefined) throw new Error("Governed verification file access is unavailable");
	const env = await factory(conversationId, context);
	try { return await artifactManifest(env, contract, context, allowMissing); }
	finally { await env.cleanup(context); }
}

async function requireFreshVerification(harness: Harness, conversationId: number, record: WorkRecord, context: Context): Promise<void> {
	const verification = record.verification;
	if (verification === undefined) return;
	if (verification.status !== "verified" || verification.receipt?.workId !== record.id) throw new Error("Run verify successfully before requesting review or accepting this work");
	try {
		const current = await snapshotArtifacts(harness, conversationId, verification.contract, context);
		if (current.cwd !== verification.receipt.manifest.cwd || current.digest !== verification.receipt.manifest.digest) throw new Error("Verified artifacts changed; run verify again before review or acceptance");
	} catch (error) {
		await harness.commit(async (tx) => {
			const current = (await tx.doc(WorkDoc, conversationId as ConversationId)).records[record.id];
			if (current?.verification?.receipt?.taskId !== verification.receipt!.taskId || current.status === "accepted") return;
			current.status = "active"; current.updatedAt = Date.now();
			current.verification.status = "stale"; current.verification.failure = (error as Error).message;
		}, BACKGROUND_CONTEXT);
		throw error;
	}
}

export async function workIdentity(tx: Tx, conversationId: number, budgetId?: string): Promise<WorkIdentity | undefined> {
	const doc = await tx.doc(WorkDoc, conversationId as ConversationId);
	if (budgetId !== undefined) {
		const prefix = `${conversationId}:`;
		const input = budgetId.startsWith(prefix) ? budgetId.slice(prefix.length) : "";
		// Pending approvals from before work tracking have no work to charge or mutate.
		if (doc.current === undefined && doc.inherited === undefined && Object.keys(doc.runs).length === 0 && Object.keys(doc.records).length === 0) return undefined;
		if (!Object.hasOwn(doc.runs, input)) throw new Error("Approval work attribution is unavailable");
		const identity = doc.runs[input];
		return identity == null ? undefined : { ...identity };
	}
	const live = await tx.doc(LiveDoc, conversationId as ConversationId);
	const input = live.run?.inputs[0];
	if (input !== undefined && Object.hasOwn(doc.runs, String(input))) {
		const identity = doc.runs[String(input)];
		return identity == null ? undefined : { ...identity };
	}
	if (doc.inherited !== undefined) return doc.inherited === null ? undefined : { ...doc.inherited };
	return doc.current === undefined ? undefined : { conversationId, id: doc.current };
}

/** A child retains its creation-time goal, including an explicit absence of one. */
export async function inheritWork(tx: Tx, parent: number, child: number): Promise<void> {
	const doc = await tx.doc(WorkDoc, child as ConversationId);
	if (doc.inherited !== undefined) return;
	const identity = await workIdentity(tx, parent);
	doc.inherited = identity ?? null;
	if (identity !== undefined) {
		const record = (await tx.doc(WorkDoc, identity.conversationId as ConversationId)).records[identity.id];
		if (record === undefined) throw new Error("The parent work record is missing");
		if (Object.keys(record.members).length >= 64) throw new Error("This work already has 63 descendants");
		record.members[String(child)] = 0;
	}
}

async function reconcileUsage(tx: Tx, record: WorkRecord): Promise<void> {
	for (const [member, position] of Object.entries(record.members)) {
		let after = position;
		for (;;) {
			const page = await tx.scanEntries({ conversationId: Number(member) as ConversationId, minEntryId: (after + 1) as EntryId, order: "ascending" }, 200);
			if (page.items.length === 0) break;
			for (const entry of page.items) {
				after = Math.max(after, entry.id);
				const claim = entry.byTaskId === undefined ? undefined : record.tasks[String(entry.byTaskId)];
				if (claim?.conversationId !== entry.conversationId) continue;
				const message = entry.model?.[0];
				if (AssistantEntry.is(entry) && claim.kind === "model" && message?.role === "assistant") {
					record.usage.modelResponses++;
					record.usage.inputTokens += message.usage.input;
					record.usage.outputTokens += message.usage.output;
					record.usage.cacheReadTokens += message.usage.cacheRead;
					record.usage.cacheWriteTokens += message.usage.cacheWrite;
					if (record.usage.cost !== null) record.usage.cost += message.usage.cost.total;
				} else if (ToolResultEntry.is(entry) && claim.kind === "tool" && message?.role === "toolResult") {
					record.usage.toolResults++;
					if (!message.isError && message.toolName !== "dwell.work") record.availableEvidence[String(entry.id)] = { conversationId: entry.conversationId, toolName: message.toolName };
				}
			}
			record.members[member] = after;
			if (page.items.length < 200) break;
		}
	}
}

export async function getWork(harness: Harness, conversationId: number) {
	return harness.commit(async (tx) => {
		const doc = await tx.doc(WorkDoc, conversationId as ConversationId);
		for (const record of Object.values(doc.records)) await reconcileUsage(tx, record);
		return JSON.parse(JSON.stringify({ ...(doc.current === undefined ? {} : { current: doc.current }), ...(doc.inherited === undefined ? {} : { inherited: doc.inherited }), records: doc.records })) as { current?: string; inherited?: WorkIdentity | null; records: Record<string, WorkRecord> };
	}, BACKGROUND_CONTEXT);
}

/** Only a trusted host route may call this; the model tool deliberately has no accept action. */
export async function acceptWork(harness: Harness, conversationId: number, workId: string, operator: string): Promise<WorkRecord> {
	if (operator.trim() === "") throw new Error("An operator identity is required");
	const before = (await getWork(harness, conversationId)).records[workId];
	if (before === undefined) throw new Error("Work record not found");
	if (before.status !== "ready_for_review") throw new Error("Work must be ready for review before acceptance");
	await requireFreshVerification(harness, conversationId, before, BACKGROUND_CONTEXT);
	return harness.commit(async (tx) => {
		const record = (await tx.doc(WorkDoc, conversationId as ConversationId)).records[workId];
		if (record === undefined) throw new Error("Work record not found");
		if (record.status !== "ready_for_review") throw new Error("Work must be ready for review before acceptance");
		if (record.verification?.receipt?.taskId !== before.verification?.receipt?.taskId) throw new Error("Work verification changed during acceptance");
		await reconcileUsage(tx, record);
		record.status = "accepted"; record.acceptedBy = operator; record.acceptedAt = record.updatedAt = Date.now();
		return JSON.parse(JSON.stringify(record)) as WorkRecord;
	}, BACKGROUND_CONTEXT);
}

const summary = (record: WorkRecord) => ({ id: record.id, creator: record.creator, goal: record.goal, acceptance: record.acceptance, progress: record.progress, blockers: record.blockers, evidence: record.evidence, review: record.review, status: record.status, usage: record.usage, limits: record.limits, stopped: record.stopped, availableEvidence: record.availableEvidence,
	verification: record.verification === undefined ? { status: "unverified", failure: "No verification contract was declared" } : { contract: record.verification.contract, status: record.verification.status, receipt: record.verification.receipt, failure: record.verification.failure, lastAttempt: record.verification.lastAttempt },
});

export function makeWorkController(options: { limits?: Partial<WorkLimits>; pricingKnown?: boolean; verificationEnv?: VerificationEnv } = {}) {
	const limits = { ...DEFAULT_WORK_LIMITS, ...options.limits };
	for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 0 || value > 4096) throw new Error(`Invalid work limit: ${key}`);
	let harness: Harness | undefined;
	const host = () => { if (harness === undefined) throw new Error("Work controller is not attached"); return harness; };
	const runInput = async (conversationId: ConversationId, context: Context) => {
		const live = await host().snapshot(LiveDoc, conversationId, context);
		const input = live?.run?.inputs[0];
		if (input === undefined) throw new Error("Work operation has no active input");
		const status = await (await host().submission(input, context))?.status(context);
		const entry = status?.entry === undefined ? undefined : await host().commit((tx) => tx.entry(status.entry!), context);
		const data = entry?.data;
		const metadata = typeof data === "object" && data !== null && !Array.isArray(data) ? data : {};
		const trusted = entry !== undefined && ["chat.message", "panel.message", "dwell.approval", "dwell.approval.legacy"].includes(entry.kind);
		return { input, entry, metadata, sender: trusted && typeof metadata.sender === "string" ? metadata.sender : "" };
	};
	const bind = async (tx: Tx, conversationId: ConversationId, run: Awaited<ReturnType<typeof runInput>>) => {
		const live = await tx.doc(LiveDoc, conversationId);
		if (live.run?.inputs[0] !== run.input) throw new Error("Work input changed during admission");
		const doc = await tx.doc(WorkDoc, conversationId);
		const key = String(run.input);
		if (!Object.hasOwn(doc.runs, key)) {
			let identity: WorkIdentity | undefined;
			if (Object.hasOwn(run.metadata, "work")) {
				const value = run.metadata.work;
				if (value !== null) {
					if (typeof value !== "object" || Array.isArray(value) || typeof value.conversationId !== "number" || typeof value.id !== "string") throw new Error("Invalid work attribution");
					identity = { conversationId: value.conversationId, id: value.id };
				}
			} else if (run.entry?.kind === "dwell.approval") {
				if (typeof run.metadata.budgetId !== "string") throw new Error("Approval work attribution is unavailable");
				identity = await workIdentity(tx, conversationId, run.metadata.budgetId);
			} else if (run.metadata.via !== "schedule") identity = await workIdentity(tx, conversationId);
			if (identity !== undefined) {
				const record = (await tx.doc(WorkDoc, identity.conversationId as ConversationId)).records[identity.id];
				if (record === undefined || !Object.hasOwn(record.members, String(conversationId))) throw new Error("Work attribution is outside this task tree");
			}
			doc.runs[key] = identity ?? null;
			const budgets = await tx.doc(BudgetDoc, conversationId);
			// Approval continuations still refer to the original run after ordinary history rolls over.
			const settled = Object.keys(doc.runs).filter((id) => {
				const budget = budgets.records[`${conversationId}:${id}`];
				return budget?.awaitingApproval !== true && budget?.activeSince === undefined;
			});
			for (const old of settled.slice(0, Math.max(0, settled.length - 64))) if (old !== key) delete doc.runs[old];
		}
		return doc.runs[key] ?? undefined;
	};
	const admit = async (conversationId: ConversationId, taskId: TaskId, kind: "model" | "tool", context: Context) => {
		try {
			const run = await runInput(conversationId, context);
			const result = await host().commit(async (tx) => {
				const identity = await bind(tx, conversationId, run);
				if (identity === undefined) return undefined;
				const record = (await tx.doc(WorkDoc, identity.conversationId as ConversationId)).records[identity.id]!;
				await reconcileUsage(tx, record);
				const count = kind === "model" ? "modelAdmissions" : "toolAdmissions";
				if (record.stopped === undefined && (kind === "model" || record.tasks[String(taskId)] === undefined)) {
					if (record.usage[count] >= record.limits[count]) record.stopped = kind === "model" ? "model_limit" : "tool_limit";
					else { record.usage[count]++; record.tasks[String(taskId)] = { conversationId, kind }; }
				}
				return { stopped: record.stopped, summary: JSON.stringify(summary(record)) };
			}, BACKGROUND_CONTEXT);
			if (result?.stopped !== undefined) await abortBeforeRequest(host(), taskId, context);
			return result?.summary;
		} catch (error) {
			if (context.abortSignal?.aborted) throw error;
			console.error("[dwell] 工作记录不可用，停止本次运行:", error);
			return abortBeforeRequest(host(), taskId, context);
		}
	};
	const tool = defineTool({
		name: "dwell.work",
		description: "Keep an explicit durable work goal across compaction and restarts. Ordinary conversation does not require a work record. For code or file work, declare verification at start: checks are exact commands to run; artifacts are required workspace-relative files or directories, recursively hashed (1024 entries, 16 MiB total). Optional allowedChanges restricts all changes since start to exact file paths inside that scope; declare a narrow containing directory plus each required output file to catch extra files and missing outputs. verify runs the declared commands through the governed bash tool and records a host-generated receipt only if every exit code is zero and the artifact scope passes. ready and operator acceptance recheck artifact hashes without running commands. start creates a goal owned by the original sender; checkpoint saves progress, blockers and successful tool-result entry IDs; ready requests operator review with a review note. This tool cannot accept work. Records without a verification contract remain labeled unverified. Call start in its own batch before substantive work and checkpoint before waiting for clarification.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("checkpoint"), Type.Literal("verify"), Type.Literal("ready")]),
			goal: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
			acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 32 })),
			progress: Type.Optional(Type.String({ maxLength: 8000 })), blockers: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 32 })),
			evidence: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 64 })), review: Type.Optional(Type.String({ maxLength: 8000 })),
			verification: Type.Optional(Type.Object({
				checks: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), command: Type.String({ minLength: 1, maxLength: 8000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
				artifacts: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 128, description: 'Required final workspace-relative files or directories that remain after the task; directories are scanned recursively. Example: artifacts ["job", "job/result.json"] with allowedChanges ["job/result.json"]; the directory captures extra files and the explicit file detects a missing output. For cleanup, declare a parent directory that remains, such as "job" when deleting "job/disposable", plus required final outputs; list exact deleted file paths in allowedChanges.' }),
				allowedChanges: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 128, description: 'Optional exact workspace-relative file paths allowed to change inside artifacts, such as ["job/result.json"]. List files only, without directories or globs.' })),
			}, { additionalProperties: false })),
		}),
		executionMode: "sequential",
		async execute(args, api, context) {
			try {
				const run = await runInput(api.conversationId, context);
				if (args.verification !== undefined && args.action !== "start") throw new Error("Verification contracts are fixed at work start");
				let preparedVerification: WorkVerification | undefined;
				if (args.action === "start" && args.verification !== undefined) {
					await api.commit(async (tx) => {
						const identity = await bind(tx, api.conversationId, run);
						const doc = await tx.doc(WorkDoc, api.conversationId);
						if (doc.inherited !== undefined) throw new Error("A background child cannot create or replace its inherited work");
						if (!run.sender) throw new Error("Work requires the original input's durable sender identity");
						if (identity !== undefined && identity.id !== doc.current) throw new Error("A late continuation cannot replace the current work");
						const previous = doc.current === undefined ? undefined : doc.records[doc.current];
						if (previous !== undefined && previous.creator !== run.sender) throw new Error("Only the work creator can replace this conversation's goal");
						if (previous?.status === "active") throw new Error("The current work is still active");
					}, context);
					const contract = verificationContract(args.verification);
					const baseline = await snapshotArtifacts(host(), api.conversationId, contract, context, true);
					preparedVerification = { contract, status: "unverified", ...(contract.allowedChanges === undefined ? {} : { baseline }) };
				}
				let readySnapshot: WorkRecord | undefined;
				if (args.action === "ready") {
					readySnapshot = await api.commit(async (tx) => {
						const identity = await bind(tx, api.conversationId, run);
						if (identity === undefined) throw new Error("No work record is active for this input");
						if (identity.conversationId !== api.conversationId) throw new Error("Only the root conversation can request work review");
						const record = (await tx.doc(WorkDoc, identity.conversationId as ConversationId)).records[identity.id]!;
						if (record.creator !== run.sender) throw new Error("Only the original work creator may change its record");
						if (record.status === "accepted") throw new Error("Accepted work is immutable; start another goal");
						return JSON.parse(JSON.stringify(record)) as WorkRecord;
					}, context);
					await requireFreshVerification(host(), api.conversationId, readySnapshot, context);
				}
				if (args.action === "verify") {
					const target = await api.commit(async (tx) => {
						const identity = await bind(tx, api.conversationId, run);
						if (identity === undefined) throw new Error("No work record is active for this input");
						if (api.conversationId !== identity.conversationId) throw new Error("Only the root conversation can verify work");
						const record = (await tx.doc(WorkDoc, identity.conversationId as ConversationId)).records[identity.id]!;
						if (record.creator !== run.sender) throw new Error("Only the original work creator may verify its record");
						if (record.status === "accepted") throw new Error("Accepted work is immutable; start another goal");
						if (record.verification === undefined) throw new Error("This work has no verification contract; its evidence remains unverified");
						record.status = "active"; record.updatedAt = Date.now();
						record.verification.status = "unverified"; delete record.verification.receipt; delete record.verification.failure;
						return JSON.parse(JSON.stringify({ identity, verification: record.verification })) as { identity: WorkIdentity; verification: WorkVerification };
					}, context);
					const checks: CheckReceipt[] = [];
					let manifest: ArtifactManifest | undefined, failure: string | undefined;
					try {
						for (const check of target.verification.contract.checks) {
							const result = await api.executeTool("bash", { command: check.command }, context, { key: `verify-${checks.length}` });
							const output = result.structuredOutput;
							const exitCode = typeof output === "object" && output !== null && !Array.isArray(output) && typeof output.exitCode === "number" ? output.exitCode : null;
							checks.push({ ...check, taskId: result.taskId, exitCode, isError: result.isError });
							if (result.isError || exitCode !== 0) throw new Error(`Verification check failed: ${check.name}${exitCode === null ? " (no successful exit receipt)" : ` (exit ${exitCode})`}`);
						}
						manifest = await snapshotArtifacts(host(), api.conversationId, target.verification.contract, context);
						if (target.verification.contract.allowedChanges !== undefined) {
							if (target.verification.baseline === undefined) throw new Error("The strict verification baseline is unavailable");
							const unexpected = unexpectedChanges(target.verification.baseline, manifest, target.verification.contract.allowedChanges);
							if (unexpected.length > 0) throw new Error(`Changes outside allowedChanges: ${unexpected.slice(0, 20).join(", ")}`);
						}
					} catch (error) { failure = (error as Error).message; }
					const result = await api.commit(async (tx) => {
						const identity = await bind(tx, api.conversationId, run);
						if (identity?.id !== target.identity.id || identity.conversationId !== target.identity.conversationId) throw new Error("Work changed during verification");
						const record = (await tx.doc(WorkDoc, identity.conversationId as ConversationId)).records[identity.id]!;
						const verification = record.verification!;
						verification.lastAttempt = { taskId: api.taskId, checks, completedAt: Date.now() };
						if (failure !== undefined || manifest === undefined) { verification.status = "failed"; verification.failure = failure ?? "Artifact snapshot unavailable"; }
						else {
							verification.status = "verified"; delete verification.failure;
							verification.receipt = { workId: record.id, taskId: api.taskId, checks, verifiedAt: Date.now(), manifest: manifestSummary(manifest) };
						}
						await reconcileUsage(tx, record); record.updatedAt = Date.now();
						return JSON.stringify(summary(record));
					}, context);
					return { output: [{ type: "text" as const, text: result }], ...(failure === undefined ? {} : { isError: true }) };
				}
				const result = await api.commit(async (tx) => {
					let identity = await bind(tx, api.conversationId, run);
					const doc = await tx.doc(WorkDoc, api.conversationId);
					if (args.action === "start") {
						if (doc.inherited !== undefined) throw new Error("A background child cannot create or replace its inherited work");
						if (!run.sender) throw new Error("Work requires the original input's durable sender identity");
						if (!args.goal?.trim() || !args.acceptance?.length || args.acceptance.some((item) => !item.trim())) throw new Error("start requires a goal and nonempty acceptance criteria");
						if (identity !== undefined && identity.id !== doc.current) throw new Error("A late continuation cannot replace the current work");
						const previous = doc.current === undefined ? undefined : doc.records[doc.current];
						if (previous !== undefined && previous.creator !== run.sender) throw new Error("Only the work creator can replace this conversation's goal");
						if (previous !== undefined && previous.status === "active") throw new Error("Checkpoint the active goal before starting another; it must be ready for review or accepted first");
						if (Object.keys(doc.records).length >= 64) throw new Error("This conversation already retains 64 work records; start a new conversation");
						const id = `work:${api.taskId}`;
						identity = { conversationId: api.conversationId, id };
						doc.records[id] = { id, creator: run.sender, goal: args.goal.trim(), acceptance: args.acceptance, progress: "", blockers: [], evidence: [], review: "", status: "active", createdAt: Date.now(), updatedAt: Date.now(), limits: { ...limits }, usage: { scope: "generation_and_tools", pricingKnown: options.pricingKnown === true, modelAdmissions: 0, toolAdmissions: 0, modelResponses: 0, toolResults: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: options.pricingKnown === true ? 0 : null }, availableEvidence: {}, members: { [String(api.conversationId)]: 0 }, tasks: {} };
						if (preparedVerification !== undefined) doc.records[id]!.verification = preparedVerification;
						doc.current = id; doc.runs[String(run.input)] = identity;
					}
					if (identity === undefined) throw new Error("No work record is active for this input");
					const record = (await tx.doc(WorkDoc, identity.conversationId as ConversationId)).records[identity.id]!;
					await reconcileUsage(tx, record);
					if (args.action === "checkpoint" || args.action === "ready") {
						if (record.creator !== run.sender) throw new Error("Only the original work creator may change its record");
						if (record.status === "accepted") throw new Error("Accepted work is immutable; start another goal");
						const evidence = args.evidence ?? record.evidence;
						for (const id of evidence) {
							const entry = await tx.entry(ToolResultEntry, id as EntryId);
							const message = entry?.model?.[0];
							if (record.availableEvidence[String(id)] === undefined || message?.role !== "toolResult" || message.isError || message.toolName === "dwell.work") throw new Error(`Evidence ${id} is not a successful tool result from this work tree`);
						}
						if (args.action === "ready") {
							if (api.conversationId !== identity.conversationId) throw new Error("Only the root conversation can request work review");
							if (readySnapshot?.id !== record.id || readySnapshot.verification?.receipt?.taskId !== record.verification?.receipt?.taskId) throw new Error("Work verification changed during review");
							if ((evidence.length === 0 && record.verification?.receipt === undefined) || !(args.review ?? record.review).trim()) throw new Error("ready requires verified evidence and a review note explaining acceptance checks");
							if ((args.blockers ?? record.blockers).length > 0) throw new Error("Resolve the recorded blockers before requesting review");
						}
						if (args.progress !== undefined) record.progress = args.progress;
						if (args.blockers !== undefined) record.blockers = args.blockers;
						if (args.review !== undefined) record.review = args.review;
						record.evidence = [...new Set(evidence)]; record.status = args.action === "ready" ? "ready_for_review" : "active"; record.updatedAt = Date.now();
					}
					return JSON.stringify(summary(record));
				}, context);
				return { output: [{ type: "text" as const, text: result }] };
			} catch (error) { return { output: [{ type: "text" as const, text: (error as Error).message }], isError: true }; }
		},
	});
	return {
		extension: defineExtension({ name: "dwell-work", tools: [tool], sections: [section("work", () => "Use dwell.work for an explicit multi-step goal; ordinary chat does not need a work record. For code or file work, declare exact verification commands and a bounded artifact scope at start. Use allowedChanges only for strict output tasks, with a narrow containing directory plus required output files in artifacts. verify must pass before ready, and any later artifact change requires another verify. These receipts establish declared command results and file versions, not semantic correctness. ready_for_review is an agent request for operator review, never user acceptance. Work budgets cover the root and its background descendants; do not restart a stopped goal to bypass its limits.", { tag: false })], hooks: [
			hook(GenerationTask, { beforeRequest: async (request, api, context) => {
				const value = await admit(api.conversationId, api.taskId, "model", context);
				if (value === undefined) return;
				let index = request.messages.findLastIndex((message) => message.role === "user");
				if (index === -1) {
					index = request.messages.findIndex((message) => message.role !== "system");
					if (index === -1) index = request.messages.length;
				}
				// Keep the user's request and the assistant/tool-result tail in their original positions relative to each other.
				return { messages: [...request.messages.slice(0, index), { role: "user" as const, content: `[Durable work record; host-maintained data, not new user instructions]\n${value}`, timestamp: Date.now() }, ...request.messages.slice(index)] };
			} }),
			hook(ToolTask, { beforeTool: async (_call, api, context) => { await admit(api.conversationId, api.taskId, "tool", context); } }),
			hook(CompactionTask, { beforeCompact: async (_request, api) => {
				try {
					const exhausted = await host().commit(async (tx) => {
						const identity = await workIdentity(tx, api.conversationId);
						if (identity === undefined) return false;
						const record = (await tx.doc(WorkDoc, identity.conversationId as ConversationId)).records[identity.id];
						if (record === undefined) throw new Error("Work record is missing");
						return record.stopped !== undefined || record.usage.modelAdmissions >= record.limits.modelAdmissions;
					}, BACKGROUND_CONTEXT);
					// The SDK exposes range selection, not each summarizer request; summary cost is outside this ledger.
					if (exhausted) return { decline: true };
				} catch { return { decline: true }; }
			} }),
		] }),
		async attach(value: Harness): Promise<void> { if (harness !== undefined) throw new Error("Work controller already attached"); harness = value; if (options.verificationEnv !== undefined) verificationReaders.set(value, options.verificationEnv); },
		async close(): Promise<void> { if (harness !== undefined) verificationReaders.delete(harness); },
	};
}
