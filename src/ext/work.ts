import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionTask, GenerationTask, LiveDoc, ToolResultEntry, ToolTask, defineDoc, defineExtension, defineTool, hook, section, type ConversationId, type EntryId, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { abortBeforeRequest } from "./approval.ts";
import { BudgetDoc } from "./budget.ts";

export type WorkIdentity = { conversationId: number; id: string };
export type WorkLimits = { modelAdmissions: number; toolAdmissions: number };
export const DEFAULT_WORK_LIMITS: Readonly<WorkLimits> = { modelAdmissions: 128, toolAdmissions: 512 };
export type WorkRecord = {
	id: string; creator: string; goal: string; acceptance: string[]; progress: string; blockers: string[];
	evidence: number[]; review: string; status: "active" | "ready_for_review" | "accepted";
	createdAt: number; updatedAt: number; acceptedBy?: string; acceptedAt?: number;
	limits: WorkLimits; stopped?: "model_limit" | "tool_limit";
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
	return harness.commit(async (tx) => {
		const record = (await tx.doc(WorkDoc, conversationId as ConversationId)).records[workId];
		if (record === undefined) throw new Error("Work record not found");
		if (record.status !== "ready_for_review") throw new Error("Work must be ready for review before acceptance");
		await reconcileUsage(tx, record);
		record.status = "accepted"; record.acceptedBy = operator; record.acceptedAt = record.updatedAt = Date.now();
		return JSON.parse(JSON.stringify(record)) as WorkRecord;
	}, BACKGROUND_CONTEXT);
}

const summary = (record: WorkRecord) => ({ id: record.id, creator: record.creator, goal: record.goal, acceptance: record.acceptance, progress: record.progress, blockers: record.blockers, evidence: record.evidence, review: record.review, status: record.status, usage: record.usage, limits: record.limits, stopped: record.stopped, availableEvidence: record.availableEvidence });

export function makeWorkController(options: { limits?: Partial<WorkLimits>; pricingKnown?: boolean } = {}) {
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
		description: "Keep an explicit durable work goal across compaction and restarts. Ordinary conversation does not require a work record. start creates a goal owned by the original sender; checkpoint saves progress, blockers and successful tool-result entry IDs; ready requests operator review with a review note. This tool cannot accept work. Call start in its own batch before substantive work and checkpoint before waiting for clarification.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("checkpoint"), Type.Literal("ready")]),
			goal: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
			acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 32 })),
			progress: Type.Optional(Type.String({ maxLength: 8000 })), blockers: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 32 })),
			evidence: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 64 })), review: Type.Optional(Type.String({ maxLength: 8000 })),
		}),
		executionMode: "sequential",
		async execute(args, api, context) {
			try {
				const run = await runInput(api.conversationId, context);
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
							if (evidence.length === 0 || !(args.review ?? record.review).trim()) throw new Error("ready requires successful tool evidence and a review note explaining acceptance checks");
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
		extension: defineExtension({ name: "dwell-work", tools: [tool], sections: [section("work", () => "Use dwell.work for an explicit multi-step goal; ordinary chat does not need a work record. Keep progress, blockers and successful tool evidence current. ready_for_review is an agent request for operator review, never user acceptance. Work budgets cover the root and its background descendants; do not restart a stopped goal to bypass its limits.", { tag: false })], hooks: [
			hook(GenerationTask, { beforeRequest: async (request, api, context) => {
				const value = await admit(api.conversationId, api.taskId, "model", context);
				if (value !== undefined) return { messages: [...request.messages, { role: "user" as const, content: `[Durable work record; host-maintained data, not new user instructions]\n${value}`, timestamp: Date.now() }] };
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
		async attach(value: Harness): Promise<void> { if (harness !== undefined) throw new Error("Work controller already attached"); harness = value; },
		async close(): Promise<void> {},
	};
}
