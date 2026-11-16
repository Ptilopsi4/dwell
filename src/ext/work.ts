import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionTask, GenerationTask, LiveDoc, ToolResultEntry, ToolTask, defineDoc, defineExtension, defineTool, hook, section, type ConversationId, type Cursor, type EntryId, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { abortBeforeRequest } from "./approval.ts";
import { BudgetDoc } from "./budget.ts";
import { artifactManifest, manifestSummary, unexpectedChanges, verificationContract, type ArtifactManifest, type CheckReceipt, type VerificationContract, type WorkVerification } from "../verification.ts";

export type WorkIdentity = { conversationId: number; id: string };
export type WorkLimits = { modelAdmissions: number; toolAdmissions: number };
export const DEFAULT_WORK_LIMITS: Readonly<WorkLimits> = { modelAdmissions: 128, toolAdmissions: 512 };
export const WORK_MAX_REVISIONS = 32;
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
const revision = (value: WorkVerification | undefined) => value?.revision ?? 0;
export type WorkReadyAnswer = { workId: string; verified: boolean; summary?: string };

/** Match only the settled answer's direct ready call and its own successful host receipt. */
export async function workReadyAnswer(store: Pick<Harness, "commit">, conversationId: number, answerEntryId: number, context: Context = BACKGROUND_CONTEXT): Promise<WorkReadyAnswer | undefined> {
	return store.commit(async (tx) => {
		const answer = await tx.entry(AssistantEntry, answerEntryId as EntryId);
		if (answer?.conversationId !== conversationId) return undefined;
		const message = answer.model?.[0];
		const calls = message?.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [];
		if (calls.length !== 1 || calls[0]!.name !== "dwell.work" || calls[0]!.arguments.action !== "ready") return undefined;
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanEntries({ conversationId: conversationId as ConversationId, minEntryId: (answerEntryId + 1) as EntryId, order: "ascending" }, 100, cursor);
			for (const entry of page.items) {
				if (AssistantEntry.is(entry)) return undefined;
				if (!ToolResultEntry.is(entry) || entry.byTaskId === undefined) continue;
				const result = entry.model?.[0];
				if (result?.role !== "toolResult" || result.toolName !== "dwell.work" || result.toolCallId !== calls[0]!.id || result.isError) continue;
				const details = result.details;
				if (typeof details !== "object" || details === null || !("workReady" in details) || details.workReady !== true || !("workId" in details) || typeof details.workId !== "string" || !("verified" in details) || typeof details.verified !== "boolean") continue;
				const task = await tx.task(entry.byTaskId);
				const input = task?.input as { kind?: string; assistant?: number; callId?: string } | undefined;
				if (task?.kind === "pi.tool" && task.conversationId === conversationId && input?.kind === "model" && input.assistant === answerEntryId && input.callId === calls[0]!.id) return { workId: details.workId, verified: details.verified, ...("summary" in details && typeof details.summary === "string" ? { summary: details.summary } : {}) };
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return undefined;
	}, context);
}
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
	if (verification.status !== "verified" || verification.receipt?.workId !== record.id || (verification.receipt.revision ?? 0) !== revision(verification)) throw new Error("Run verify successfully before requesting review or accepting this work");
	try {
		const current = await snapshotArtifacts(harness, conversationId, verification.contract, context);
		if (current.cwd !== verification.receipt.manifest.cwd || current.digest !== verification.receipt.manifest.digest) throw new Error("Verified artifacts changed; run verify again before review or acceptance");
	} catch (error) {
		await harness.commit(async (tx) => {
			const current = (await tx.doc(WorkDoc, conversationId as ConversationId)).records[record.id];
			if (current?.verification?.receipt?.taskId !== verification.receipt!.taskId || revision(current.verification) !== revision(verification) || current.status === "accepted") return;
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

/** Failure presentation must follow the stopped input, even after its current goal changes. */
export async function workBudgetStopReason(store: Pick<Harness, "snapshot">, conversationId: number, budgetId: string, context: Context = BACKGROUND_CONTEXT): Promise<WorkRecord["stopped"]> {
	const prefix = `${conversationId}:`;
	if (!budgetId.startsWith(prefix)) return undefined;
	const input = budgetId.slice(prefix.length);
	if (!/^\d+$/.test(input)) return undefined;
	const doc = await store.snapshot(WorkDoc, conversationId as ConversationId, context);
	const identity = doc?.runs[input];
	if (identity == null) return undefined;
	const record = (await store.snapshot(WorkDoc, identity.conversationId as ConversationId, context))?.records[identity.id];
	return record?.stopped;
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
		if (record.verification?.receipt?.taskId !== before.verification?.receipt?.taskId || revision(record.verification) !== revision(before.verification)) throw new Error("Work verification changed during acceptance");
		await reconcileUsage(tx, record);
		record.status = "accepted"; record.acceptedBy = operator; record.acceptedAt = record.updatedAt = Date.now();
		return JSON.parse(JSON.stringify(record)) as WorkRecord;
	}, BACKGROUND_CONTEXT);
}

function revisionSummary(verification: WorkVerification) {
	const history = verification.revisionHistory ?? [];
	const latest = history.at(-1);
	return { count: history.length, ...(latest === undefined ? {} : { latest: { revision: latest.revision, reason: latest.reason, actor: latest.actor, taskId: latest.taskId, revisedAt: latest.revisedAt, checkCount: latest.oldChecks.length, checkNames: latest.oldChecks.map((check) => check.name), ...(latest.oldReceipt === undefined ? {} : { oldReceiptTaskId: latest.oldReceipt.taskId }), ...(latest.oldAttempt === undefined ? {} : { oldAttemptTaskId: latest.oldAttempt.taskId }) } }) };
}

const summary = (record: WorkRecord) => ({
	...(record.status !== "accepted" && record.stopped === undefined && record.blockers.length === 0 && record.verification?.status === "verified" && record.verification.receipt?.workId === record.id && (record.verification.receipt.revision ?? 0) === revision(record.verification) ? { nextCall: { name: "dwell.work", arguments: { action: "ready", review: reviewNote(record) } } } : {}),
	...(record.status !== "accepted" && record.blockers.length > 0 ? { nextStep: "Recorded blockers still prevent review. Resolve them, then call dwell.work checkpoint to record their resolution and explicitly clear blockers. Inspect status for the ready nextCall after the blockers are cleared." } : {}),
	id: record.id, creator: record.creator, goal: record.goal, acceptance: record.acceptance, progress: record.progress, blockers: record.blockers, evidence: record.evidence, review: record.review, status: record.status, usage: record.usage, limits: record.limits, stopped: record.stopped, availableEvidence: record.availableEvidence,
	verification: record.verification === undefined ? { status: "unverified", failure: "No verification contract was declared" } : { contract: record.verification.contract, revision: revision(record.verification), revisionHistory: revisionSummary(record.verification), status: record.verification.status, receipt: record.verification.receipt, failure: record.verification.failure, lastAttempt: record.verification.lastAttempt },
});

function reviewNote(record: WorkRecord): string {
	const receipt = record.verification?.receipt;
	return receipt === undefined ? "Review the supplied evidence; no verification contract was declared." : `Declared checks passed: ${receipt.checks.map((check) => `${check.name} (exit ${check.exitCode})`).join("; ")}. Artifact snapshot: ${receipt.manifest.files} files, ${receipt.manifest.bytes} bytes. These results cover the declared checks and file versions; operator review is still required.`;
}

/** Freeze the user-facing handoff in its receipt; later goals and revisions cannot rewrite it. */
function readySummary(record: WorkRecord): string {
	const clip = (value: string, limit: number) => {
		const text = value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
		return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
	};
	const list = (values: readonly string[], limit: number) => [...values.slice(0, 8).map((value) => `• ${clip(value, limit)}`), ...(values.length > 8 ? [`• 另 ${values.length - 8} 项，请在面板查看完整记录。`] : [])].join("\n");
	const verification = record.verification;
	const parts = [`目标（工作声明）：${clip(record.goal, 240)}`];
	if (verification !== undefined) {
		parts.push(`交付范围（声明的相对路径）：\n${list(verification.contract.artifacts, 120)}`);
		parts.push(`声明检查的执行结果：\n${list(verification.receipt!.checks.map((check) => `${clip(check.name, 80)}：退出码 ${check.exitCode}`), 100)}`);
	} else parts.push(`验证：未声明验证契约；已记录 ${record.evidence.length} 条成功工具结果。`);
	parts.push(`评审说明（代理声明）：${clip(record.review, 720)}`);
	return parts.join("\n\n");
}

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
		description: "Keep an explicit durable work goal across compaction and restarts. Ordinary conversation does not require a work record. For code or file work, declare verification at start: checks are exact commands to run; artifacts are required workspace-relative files or directories, recursively hashed (1024 entries, 16 MiB total). Optional allowedChanges restricts all changes since start to exact file paths inside that scope; declare a narrow containing directory plus each required output file to catch extra files and missing outputs. verify runs declared commands through the governed bash tool and records a host receipt only if every exit code is zero and the artifact scope passes. Once recorded blockers are resolved and explicitly cleared with checkpoint, an eligible verified result supplies a ready nextCall, requiring no evidence IDs. revise replaces only checks with a required reason, retains the original scope, baseline and budgets, records history, and invalidates verification. After revising, verify again. ready and operator acceptance recheck artifact hashes without running commands. start creates a goal owned by the original sender; checkpoint saves progress, blockers and optional successful tool-result entry IDs. Call ready directly and alone in its response to request operator review and end this run; do not send another model response. This tool cannot accept work. Records without a verification contract remain labeled unverified. Call start in its own batch before substantive work and checkpoint before waiting for clarification.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("checkpoint"), Type.Literal("revise"), Type.Literal("verify"), Type.Literal("ready")]),
			goal: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
			acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 32 })),
			progress: Type.Optional(Type.String({ maxLength: 8000 })), blockers: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 32 })),
			evidence: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 64 })), review: Type.Optional(Type.String({ maxLength: 8000 })),
			checks: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), command: Type.String({ minLength: 1, maxLength: 8000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 32, description: "Replacement verification commands for revise only. Supply reason and omit verification; artifacts and allowedChanges cannot be revised." })),
			reason: Type.Optional(Type.String({ minLength: 1, maxLength: 4000, description: "Why revise must replace the verification commands. Required for revise; it cannot change the artifact scope or allowedChanges." })),
			verification: Type.Optional(Type.Object({
				checks: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), command: Type.String({ minLength: 1, maxLength: 8000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 32, description: "Named commands run by verify in the workspace; every command must exit zero." }),
				artifacts: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 128, description: 'Required final workspace-relative files or directories that remain after the task; directories are scanned recursively. Example: artifacts ["job", "job/result.json"] with allowedChanges ["job/result.json"]; the directory captures extra files and the explicit file detects a missing output. For cleanup, declare a parent directory that remains, such as "job" when deleting "job/disposable", plus required final outputs; list exact deleted file paths in allowedChanges.' }),
				allowedChanges: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 128, description: 'Optional exact workspace-relative file paths allowed to change inside artifacts, such as ["job/result.json"]. List files only, without directories or globs.' })),
			}, { additionalProperties: false })),
		}, { additionalProperties: false }),
		replay: "unsafe",
		executionMode: "sequential",
		async execute(args, api, context) {
			try {
				if (args.action === "ready") await api.commit(async (tx) => {
					const task = await tx.task(api.taskId);
					const input = task?.input as { kind?: string; assistant?: number; callId?: string } | undefined;
					if (input?.kind !== "model" || input.assistant === undefined) throw new Error("Call dwell.work ready directly, not from another tool");
					const entry = await tx.entry(AssistantEntry, input.assistant as EntryId);
					const message = entry?.model?.[0];
					const calls = message?.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [];
					if (entry?.conversationId !== api.conversationId || calls.length !== 1 || calls[0]!.name !== "dwell.work" || calls[0]!.arguments.action !== "ready" || calls[0]!.id !== api.callId || input.callId !== api.callId) throw new Error("Call dwell.work ready alone, with no other tool calls in the same response");
				}, context);
				const run = await runInput(api.conversationId, context);
				if (args.verification !== undefined && args.action !== "start") throw new Error("Artifact scope and allowedChanges are fixed at work start; revise changes checks only. If the original scope is wrong, save a checkpoint with a blocker and end this run with an explanation. Ask the operator to use /newgoal for a new goal with the corrected scope; do not retry scope changes or request review.");
				if ((args.checks !== undefined || args.reason !== undefined) && args.action !== "revise") throw new Error("checks and reason are only valid for revise");
				if (args.action === "revise" && (args.goal !== undefined || args.acceptance !== undefined || args.progress !== undefined || args.blockers !== undefined || args.evidence !== undefined || args.review !== undefined)) throw new Error("revise changes only checks and requires a reason");
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
					preparedVerification = { contract, revision: 0, status: "unverified", ...(contract.allowedChanges === undefined ? {} : { baseline }) };
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
						if (record.status === "accepted" || revision(record.verification) !== revision(target.verification)) throw new Error("Work verification was revised while checks were running; run verify again");
						const verification = record.verification!;
						verification.lastAttempt = { taskId: api.taskId, revision: revision(verification), checks, completedAt: Date.now() };
						if (failure !== undefined || manifest === undefined) { verification.status = "failed"; verification.failure = failure ?? "Artifact snapshot unavailable"; }
						else {
							verification.status = "verified"; delete verification.failure;
							verification.receipt = { workId: record.id, taskId: api.taskId, revision: revision(verification), checks, verifiedAt: Date.now(), manifest: manifestSummary(manifest) };
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
					if (args.action === "revise") {
						if (api.conversationId !== identity.conversationId || doc.inherited !== undefined) throw new Error("Only the root conversation can revise work verification");
						if (record.creator !== run.sender) throw new Error("Only the original work creator may revise its record");
						if (record.status === "accepted") throw new Error("Accepted work is immutable; start another goal");
						const verification = record.verification;
						if (verification === undefined) throw new Error("This work has no verification contract to revise");
						if (args.checks === undefined || !args.reason?.trim()) throw new Error("revise requires replacement checks and a nonempty reason");
						const history = verification.revisionHistory ?? [];
						if (history.length >= WORK_MAX_REVISIONS) throw new Error(`This work already retains ${WORK_MAX_REVISIONS} verification revisions`);
						const checks = verificationContract({ ...verification.contract, checks: args.checks }).checks;
						const previous = revision(verification);
						verification.revisionHistory = [...history, { revision: previous, oldChecks: verification.contract.checks, reason: args.reason.trim(), actor: run.sender, taskId: api.taskId, revisedAt: Date.now(), ...(verification.receipt === undefined ? {} : { oldReceipt: verification.receipt }), ...(verification.lastAttempt === undefined ? {} : { oldAttempt: verification.lastAttempt }) }];
						verification.contract.checks = checks; verification.revision = previous + 1; verification.status = "unverified";
						delete verification.receipt; delete verification.failure; delete verification.lastAttempt;
						record.status = "active"; record.updatedAt = Date.now();
					}
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
							if (readySnapshot?.id !== record.id || readySnapshot.verification?.receipt?.taskId !== record.verification?.receipt?.taskId || revision(readySnapshot.verification) !== revision(record.verification)) throw new Error("Work verification changed during review");
							if ((evidence.length === 0 && record.verification?.receipt === undefined) || !(args.review ?? record.review).trim()) throw new Error("ready requires verified evidence and a review note explaining acceptance checks");
							if ((args.blockers ?? record.blockers).length > 0) throw new Error("Resolve the recorded blockers before requesting review");
						}
						if (args.progress !== undefined) record.progress = args.progress;
						if (args.blockers !== undefined) record.blockers = args.blockers;
						if (args.review !== undefined) record.review = args.review;
						record.evidence = [...new Set(evidence)]; record.status = args.action === "ready" ? "ready_for_review" : "active"; record.updatedAt = Date.now();
					}
					return { text: JSON.stringify(summary(record)), ...(args.action === "ready" ? { ready: { workReady: true, workId: record.id, verified: record.verification !== undefined, summary: readySummary(record) } } : {}) };
				}, context);
				return { output: [{ type: "text" as const, text: result.text }], ...(result.ready === undefined ? {} : { details: result.ready, control: { terminate: true } }) };
			} catch (error) { return { output: [{ type: "text" as const, text: (error as Error).message }], isError: true }; }
		},
	});
	return {
		extension: defineExtension({ name: "dwell-work", tools: [tool], sections: [section("work", () => "Use dwell.work for an explicit multi-step goal; ordinary chat does not need a work record. For code or file work, declare exact verification commands and a bounded artifact scope at start. Use allowedChanges only for strict output tasks, with a narrow containing directory plus required output files in artifacts. Correct invalid check commands using revise with replacement checks and a reason; this preserves the original scope, baseline, ownership and budgets, invalidates the receipt and requires verify again. A successful verify preserves recorded blockers. Resolve them and checkpoint their resolution with an explicitly cleared blocker list before requesting review; only eligible verified work supplies an actionable ready nextCall. No evidence IDs are required, and supplementary evidence must still be successful results from this work tree. Call ready directly and alone to end the run and request operator review. Any later artifact change requires another verify. Receipts establish declared command results and file versions, not semantic correctness. ready_for_review is an agent request for operator review, never user acceptance. Legacy records without verification remain unverified. Work budgets cover the root and its background descendants; do not restart a stopped goal to bypass its limits.", { tag: false })], hooks: [
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
