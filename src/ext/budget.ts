import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { CompactionTask, defineDoc, defineExtension, defineTask, GenerationTask, hook, LiveDoc, ToolTask, type ConversationId, type Cursor, type Harness, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";

export type BudgetLimits = { modelAdmissions: number; toolAdmissions: number; executionMs: number };
export const DEFAULT_BUDGET_LIMITS: Readonly<BudgetLimits> = { modelAdmissions: 32, toolAdmissions: 128, executionMs: 15 * 60_000 };
export type BudgetStopReason = "model_limit" | "tool_limit" | "execution_limit" | "unknown_budget" | "storage_error";
export type BudgetRecord = {
	limits: BudgetLimits;
	modelAdmissions: number;
	toolAdmissions: number;
	toolTasks: Record<string, true>;
	executionMs: number;
	activeSince?: number;
	activeInput?: string;
	lastTaskId?: TaskId;
	awaitingApproval?: boolean;
	watchdog?: TaskId;
	stopped?: BudgetStopReason;
};

/** Separate records preserve an old approval's allowance while newer runs use their own. */
export const BudgetDoc = defineDoc<{ current?: string; records: Record<string, BudgetRecord> }>({
	kind: "dwell.budget", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ records: {} }), checkpointWhen: () => true,
});

type RunIdentity = { input: SubmissionId; budgetId: string; continuation: boolean };
type WatchInput = { conversationId: number; budgetId: string; input: string };
type WatchState = { phase: "watch" };

export function makeBudgetController(options: {
	limits?: Partial<BudgetLimits>;
	onStopped?: (conversationId: number, budgetId: string, reason: BudgetStopReason) => void | Promise<void>;
} = {}) {
	const limits = { ...DEFAULT_BUDGET_LIMITS, ...options.limits };
	for (const [key, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < (key === "executionMs" ? 1 : 0)) throw new Error(`Invalid budget limit: ${key}`);
	}
	let harness: Harness | undefined;
	let closed = false;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeClose: (() => void) | undefined;
	let draining: Promise<void> = Promise.resolve();
	let scheduled = false;
	const dirty = new Set<ConversationId>();
	const notified = new Set<string>();
	const failures = new Map<number, BudgetStopReason>();
	const host = () => {
		if (harness === undefined) throw new Error("Budget controller is not attached");
		return harness;
	};
	const notify = (conversationId: number, budgetId: string, reason: BudgetStopReason) => {
		const key = `${conversationId}:${budgetId}:${reason}`;
		if (notified.has(key)) return;
		notified.add(key);
		try {
			void Promise.resolve(options.onStopped?.(conversationId, budgetId, reason)).catch((error: unknown) => console.error("[dwell] 预算停止通知失败:", error));
		} catch (error) { console.error("[dwell] 预算停止通知失败:", error); }
	};
	/** Abort must be started outside the hook's own join; throwing alone is swallowed by pi-durable. */
	const halt = async (taskId: TaskId, context: Context): Promise<never> => {
		const current = host();
		const abort = current.abortTask(taskId, BACKGROUND_CONTEXT);
		const observed = abort.catch((error: unknown) => {
			// A failed abort must not let the provider proceed, including an uncertain storage failure.
			void current.close(BACKGROUND_CONTEXT).catch(() => {});
			throw error;
		});
		void observed.catch(() => {});
		const signal = context.abortSignal;
		if (signal === undefined) throw new Error("Budget stop requires an invocation abort signal");
		if (!signal.aborted) {
			let listener: (() => void) | undefined;
			try {
				await Promise.race([
					new Promise<void>((resolve) => {
						listener = resolve;
						signal.addEventListener("abort", listener, { once: true });
						if (signal.aborted) resolve();
					}),
					observed,
				]);
			} finally { if (listener !== undefined) signal.removeEventListener("abort", listener); }
		}
		signal.throwIfAborted();
		throw new Error("Budget stopped");
	};
	const elapsed = (record: Readonly<BudgetRecord>, now: number) => record.executionMs + (record.activeSince === undefined ? 0 : Math.max(0, now - record.activeSince));
	const finish = async (tx: Tx, record: BudgetRecord, now: number) => {
		if (record.activeSince === undefined) return;
		const task = record.lastTaskId === undefined ? undefined : await tx.task(record.lastTaskId);
		record.executionMs = elapsed(record, Math.min(now, task?.endedAt ?? now));
		delete record.activeSince;
		delete record.activeInput;
		delete record.watchdog;
	};
	const identity = async (conversationId: ConversationId): Promise<RunIdentity | undefined> => {
		const current = host();
		const live = await current.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT);
		const input = live?.run?.inputs[0];
		if (input === undefined) return undefined;
		const submission = await current.submission(input, BACKGROUND_CONTEXT);
		const status = await submission?.status(BACKGROUND_CONTEXT);
		const entry = status?.entry === undefined ? undefined : await current.commit((tx) => tx.entry(status.entry!), BACKGROUND_CONTEXT);
		const data = entry?.data;
		if (entry?.kind === "dwell.approval") {
			const budgetId = typeof data === "object" && data !== null && !Array.isArray(data) && typeof data.budgetId === "string" ? data.budgetId : "";
			return { input, budgetId, continuation: true };
		}
		return { input, budgetId: `${conversationId}:${input}`, continuation: false };
	};

	const Watchdog = defineTask<WatchInput, WatchState, null>({
		name: "dwell.budget-watch", version: 1, initial: () => ({ phase: "watch" }),
		phases: {
			watch: async (task, runtime, context) => {
				let cancel: TaskId | undefined;
				let compactions: TaskId[] = [];
				let reason: BudgetStopReason | undefined;
				await runtime.commit(async (tx) => {
					const conversationId = task.input.conversationId as ConversationId;
					const live = await tx.doc(LiveDoc, conversationId);
					const doc = await tx.doc(BudgetDoc, conversationId);
					const record = doc.records[task.input.budgetId];
					if (record === undefined || record.activeInput !== task.input.input || String(live.run?.inputs[0]) !== task.input.input || record.activeSince === undefined) {
						return { status: "terminal", outcome: { status: "completed", result: null } };
					}
					const remaining = record.limits.executionMs - elapsed(record, Date.now());
					if (record.stopped === undefined && remaining > 0) return { status: "sleeping", until: Date.now() + remaining, checkpoint: { phase: "watch" } };
					reason = record.stopped ?? "execution_limit";
					record.stopped = reason;
					cancel = live.run?.taskId;
					compactions = live.compactions?.map((item) => item.taskId) ?? [];
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context);
				if (reason !== undefined) notify(task.input.conversationId, task.input.budgetId, reason);
				if (cancel !== undefined) await Promise.all([cancel, ...compactions].map((id) => host().abortTask(id, BACKGROUND_CONTEXT)));
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	const admit = async (conversationId: ConversationId, taskId: TaskId, kind: "model" | "tool" | "observe", context: Context) => {
		let cancel = taskId;
		let budgetId = "unavailable";
		let reason: BudgetStopReason | undefined;
		try {
			const current = host();
			const run = await identity(conversationId);
			if (run === undefined) throw new Error("Missing budget run");
			budgetId = run.budgetId;
			reason = await current.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, conversationId);
				if (live.run?.inputs[0] !== run.input) throw new Error("Budget run changed during admission");
				cancel = live.run.taskId;
				const doc = await tx.doc(BudgetDoc, conversationId);
				const previous = doc.current === undefined ? undefined : doc.records[doc.current];
				if (previous !== undefined && previous.activeInput !== String(run.input)) await finish(tx, previous, Date.now());
				let record = doc.records[budgetId];
				if (record === undefined) {
					record = { limits: { ...limits }, modelAdmissions: 0, toolAdmissions: 0, toolTasks: {}, executionMs: 0, ...(run.continuation ? { stopped: "unknown_budget" as const } : {}) };
					doc.records[budgetId] = record;
					record = doc.records[budgetId]!;
				}
				doc.current = budgetId;
				// Retain approval records, but bound bookkeeping for completed ordinary runs.
				const settled = Object.keys(doc.records).filter((key) => key !== budgetId && doc.records[key]!.activeSince === undefined && doc.records[key]!.awaitingApproval !== true);
				for (const key of settled.slice(0, Math.max(0, settled.length - 32))) delete doc.records[key];
				if (record.activeSince === undefined) {
					record.activeSince = Date.now();
					record.activeInput = String(run.input);
					delete record.awaitingApproval;
				}
				record.lastTaskId = live.run.taskId;
				if (record.stopped === undefined && elapsed(record, Date.now()) >= record.limits.executionMs) record.stopped = "execution_limit";
				if (record.stopped === undefined) {
					if (kind === "model") {
						if (record.modelAdmissions >= record.limits.modelAdmissions) record.stopped = "model_limit";
						else record.modelAdmissions++;
					} else if (kind === "tool" && record.toolTasks[String(taskId)] === undefined) {
						if (record.toolAdmissions >= record.limits.toolAdmissions) record.stopped = "tool_limit";
						else { record.toolAdmissions++; record.toolTasks[String(taskId)] = true; }
					}
				}
				if (record.stopped === undefined && record.watchdog === undefined) {
					record.watchdog = await tx.createTask(Watchdog, { conversationId: conversationId as number, budgetId, input: String(run.input) }, { ownership: { kind: "conversation" }, background: true, conversationId });
				}
				return record.stopped;
			}, BACKGROUND_CONTEXT);
			failures.delete(conversationId as number);
		} catch (error) {
			if (context.abortSignal?.aborted) throw error;
			reason = "storage_error";
			failures.set(conversationId as number, reason);
			console.error("[dwell] 预算状态不可用，停止本次运行:", error);
		}
		if (reason !== undefined) {
			notify(conversationId as number, budgetId, reason);
			if (kind !== "observe") await halt(cancel, context);
		}
		return reason;
	};
	const reconcile = async (conversationId: ConversationId) => {
		await host().commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			const doc = await tx.doc(BudgetDoc, conversationId);
			const watchers: { budgetId: string; record: BudgetRecord }[] = [];
			for (const [budgetId, record] of Object.entries(doc.records)) {
				if (record.activeSince === undefined) continue;
				if (record.activeInput === String(live.run?.inputs[0])) {
					record.lastTaskId = live.run!.taskId;
					if (record.watchdog === undefined) {
						watchers.push({ budgetId, record });
					}
				} else await finish(tx, record, Date.now());
			}
			for (const { budgetId, record } of watchers) record.watchdog = await tx.createTask(Watchdog, { conversationId: conversationId as number, budgetId, input: record.activeInput! }, { ownership: { kind: "conversation" }, background: true, conversationId });
		}, BACKGROUND_CONTEXT);
	};
	const enqueue = () => {
		if (scheduled || closed) return;
		scheduled = true;
		// Commit listeners may not re-enter the Session; defer until the publication callback has returned.
		queueMicrotask(() => {
			draining = draining.then(async () => {
				while (!closed && dirty.size > 0) {
					const ids = [...dirty]; dirty.clear();
					for (const id of ids) await reconcile(id);
				}
			}).catch((error: unknown) => { if (!closed) console.error("[dwell] 预算运行状态同步失败:", error); }).finally(() => { scheduled = false; if (dirty.size > 0 && !closed) enqueue(); });
		});
	};
	const shutdown = async (): Promise<void> => {
		closed = true;
		unsubscribe?.(); unsubscribeClose?.(); dirty.clear();
		await draining;
	};
	return {
		extension: defineExtension({ name: "dwell-budget", tasks: [Watchdog], hooks: [
			hook(GenerationTask, { beforeRequest: async (_request, api, context) => { await admit(api.conversationId, api.taskId, "model", context); } }),
			hook(ToolTask, { beforeTool: async (_call, api, context) => { await admit(api.conversationId, api.taskId, "tool", context); } }),
			hook(CompactionTask, { beforeCompact: async (_request, api, context) => {
				try {
					const current = host();
					const live = await current.snapshot(LiveDoc, api.conversationId, BACKGROUND_CONTEXT);
					if (live?.run === undefined) return;
					// Threshold compaction can precede the first generation request; start its execution clock too.
					if (await admit(api.conversationId, api.taskId, "observe", context) !== undefined) return { decline: true };
					const doc = await current.snapshot(BudgetDoc, api.conversationId, BACKGROUND_CONTEXT);
					const record = doc?.current === undefined ? undefined : doc.records[doc.current];
					if (record?.activeInput === String(live.run.inputs[0]) && (record.stopped !== undefined || record.modelAdmissions >= record.limits.modelAdmissions || elapsed(record, Date.now()) >= record.limits.executionMs)) return { decline: true };
				} catch (error) {
					console.error("[dwell] 预算状态不可用，跳过压缩:", error);
					return { decline: true };
				}
			} }),
		] }),
		async attach(value: Harness): Promise<void> {
			if (harness !== undefined) throw new Error("Budget controller already attached");
			harness = value;
			const ids = await value.commit(async (tx) => {
				const out: ConversationId[] = [];
				let cursor: Cursor | undefined;
				do { const page = await tx.scanConversations({}, 200, cursor); out.push(...page.items.map((item) => item.id)); cursor = page.next; } while (cursor !== undefined);
				return out;
			}, BACKGROUND_CONTEXT);
			for (const id of ids) await reconcile(id);
			unsubscribe = value.subscribeCommits((publication) => {
				for (const change of publication.changes) {
					if (change.type === "document" && change.record.kind === LiveDoc.definition.kind && change.conversationId !== undefined) dirty.add(change.conversationId);
				}
				if (dirty.size > 0) enqueue();
			});
			unsubscribeClose = value.subscribeClose(() => {
				closed = true;
				queueMicrotask(() => { void shutdown(); });
			});
		},
		close: shutdown,
		async current(conversationId: number): Promise<{ budgetId: string } | undefined> {
			const doc = await host().snapshot(BudgetDoc, conversationId as ConversationId, BACKGROUND_CONTEXT);
			return doc?.current === undefined ? undefined : { budgetId: doc.current };
		},
		async captureApproval(conversationId: number): Promise<string | undefined> {
			return host().commit(async (tx) => {
				const doc = await tx.doc(BudgetDoc, conversationId as ConversationId);
				if (doc.current === undefined) return undefined;
				const record = doc.records[doc.current];
				if (record !== undefined) record.awaitingApproval = true;
				return doc.current;
			}, BACKGROUND_CONTEXT);
		},
		async stopReason(conversationId: number, budgetId?: string): Promise<BudgetStopReason | undefined> {
			if (failures.has(conversationId)) return failures.get(conversationId);
			const doc = await host().snapshot(BudgetDoc, conversationId as ConversationId, BACKGROUND_CONTEXT);
			const key = budgetId ?? doc?.current;
			return key === undefined ? undefined : doc?.records[key]?.stopped;
		},
	};
}
