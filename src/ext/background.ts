// 后台任务：dwell.task 工具把自包含任务派给后台子代理（Anchor 持有子会话 + Reporter 投递与回报）。
// 子会话继承父会话的 cwd/模型/工具（去掉 dwell.task / dwell.schedule / dwell.proc 防递归派生）；父线 /cancel 与 idle 等待
// 不穿越 background 边界。答案以 followUp 回到父会话，由宿主 onFired 开卡（模式同官方 example 23）。
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { AssistantEntry, configure, defineDoc, defineExtension, defineTask, defineTool, InboxDoc, LiveDoc, section, ToolResultEntry, type ConversationId, type Cursor, type EntryId, type Extension, type Harness, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { scanLiveTasks } from "./schedule.ts";
import { creatorVia, decisionInput, removeApprovalTarget, type RunVia } from "./approval.ts";
import { canonicalWorkspace, checkBackgroundWorkspace, markBackgroundWorkspaceStopped, prepareBackgroundWorkspace, readOnlyWorkspaceTool, registerBackgroundWorkspace, releaseStoppedWorkspace, workspaceStartViolation, WorkspaceDoc } from "../workspace.ts";
import { DEFAULT_CWD } from "../state.ts";
import { resolve } from "node:path";
import { inheritWork, workIdentity, type WorkIdentity } from "./work.ts";

export const BACKGROUND_ANCHOR_KIND = "dwell.background-anchor";
export const BACKGROUND_REPORTER_KIND = "dwell.background-reporter";
export const BACKGROUND_WAIT_TOOL = "dwell.task.wait";

/** Match the settled answer's own wait receipt, rather than an earlier wait in its history. */
export async function backgroundWaitingAnswer(harness: Pick<Harness, "commit">, conversationId: number, answerEntryId: number, context: Context = BACKGROUND_CONTEXT): Promise<boolean> {
	return harness.commit(async (tx) => {
		const answer = await tx.entry(AssistantEntry, answerEntryId as EntryId);
		if (answer?.conversationId !== conversationId) return false;
		const message = answer.model?.[0];
		if (message?.role !== "assistant") return false;
		const calls = message.content.filter((part) => part.type === "toolCall");
		if (calls.length !== 1 || calls[0]!.name !== BACKGROUND_WAIT_TOOL) return false;
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanEntries({ conversationId: conversationId as ConversationId, minEntryId: (answerEntryId + 1) as EntryId, order: "ascending" }, 100, cursor);
			for (const entry of page.items) {
				if (AssistantEntry.is(entry)) return false;
				if (!ToolResultEntry.is(entry) || entry.byTaskId === undefined) continue;
				const result = entry.model?.[0];
				if (result?.role !== "toolResult" || result.toolName !== BACKGROUND_WAIT_TOOL || result.toolCallId !== calls[0]!.id || result.isError) continue;
				if (typeof result.details !== "object" || result.details === null || !("waitingForBackground" in result.details) || result.details.waitingForBackground !== true) continue;
				const task = await tx.task(entry.byTaskId);
				const input = task?.input as { kind?: string; assistant?: number; callId?: string } | undefined;
				return task?.kind === "pi.tool" && task.conversationId === conversationId && input?.kind === "model" && input.assistant === answerEntryId && input.callId === calls[0]!.id;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return false;
	}, context);
}

/** 成本闸：并发后台任务数（子代理会真烧 token，超限让模型等或停）。 */
export const BG_MAX_PER_CONVERSATION = 3;
export const BG_MAX_TOTAL = 6;

/** 超限判定（纯函数，单测覆盖）。 */
export function backgroundCapViolation(perConversation: number, total: number): string | undefined {
	if (perConversation >= BG_MAX_PER_CONVERSATION) return `This conversation already runs ${perConversation} background tasks (max ${BG_MAX_PER_CONVERSATION}); stop one or wait for it to finish.`;
	if (total >= BG_MAX_TOTAL) return `The server already runs ${total} background tasks in total (max ${BG_MAX_TOTAL}); stop one or wait.`;
	return undefined;
}

export type BackgroundDeps = {
	/** run 归属登记（后台回报触发的父线 run 归到创建者）。report 阶段 await 它完成才 submit；必须返回 Promise，约束同 ScheduleDeps.attribute */
	attribute: (conversationId: number, creator: string) => Promise<void>;
	/** 触发的 run 由宿主开回复卡（与定时任务同一入口） */
	onFired: (conversationId: number, submissionId: SubmissionId, header: string) => void | Promise<void>;
	getHarness?: () => Harness | undefined;
	/** 子会话创建登记：审批 scope 映射（子→父）与 panel 展示用 */
	onStarted: (child: number, parent: number) => void;
	/** 当前 run 发起者（后台任务创建者，回报归属用） */
	senderOf: (conversationId: number) => string | undefined;
	viaOf?: (conversationId: number) => RunVia | undefined;
	/** 子代理 agent 变更中要移除的扩展对象（防递归派生；AgentChange 按对象引用，getter 延迟取装配产物） */
	forbidden: () => readonly Extension[];
	budgetStopReason?: (conversationId: number, budgetId?: string) => Promise<string | undefined>;
};

/** 审批后向后台子会话投递续跑输入：宿主拿这个 handle 在父线上建 Reporter（结果按 followUp 回父线，开卡走 onFired）。
 *  经 Reporter 而非直接 submitAndReply 子会话：直接续跑会把回复卡锢在子会话上（回复即进子会话聊天），且结果无回报。
 *  Reporter 定义与扩展内同名同版（注册表按 name 解析，重启后续跑不受影响）。 */
export type BackgroundDeliverer = {
	/** 子会话所属的后台任务名（名册已删 = 已 stop） */
	nameOf: (parent: number, child: number) => Promise<string | undefined>;
	/** 在父线上建 Reporter 投递 content；false = 无名册（已 stop）或 harness 未就绪 */
	deliver: (parent: number, child: number, content: string, approval?: BackgroundApprovalDelivery) => Promise<boolean>;
};

type BackgroundApprovalDelivery = { deliveryId: string; budgetId?: string; sender: string; via?: RunVia; action?: "approve" | "deny"; minutes?: number; expiresAt?: number };

export const BackgroundDeliveryDoc = defineDoc<{ receipts: Record<string, number> }>({
	kind: "dwell.background-deliveries", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ receipts: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export const BackgroundStopDoc = defineDoc<{ children: Record<string, boolean>; cleanup?: Record<string, number> }>({
	kind: "dwell.background-stops", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ children: {} }), checkpointWhen: () => true,
});

/** Attribution can persist independently, but cancellation must end the invocation before it can submit. */
async function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	let cancel: (() => void) | undefined;
	try {
		return await Promise.race([work, new Promise<never>((_resolve, reject) => {
			cancel = () => reject(signal.reason);
			signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) cancel();
		})]);
	} finally { if (cancel !== undefined) signal.removeEventListener("abort", cancel); }
}

export function makeBackgroundDeliverer(deps: BackgroundDeps, getHarness: () => Harness | undefined): BackgroundDeliverer {
	const Reporter = makeBackgroundReporter(deps);
	const nameOf = async (parent: number, child: number): Promise<string | undefined> => {
		const harness = getHarness();
		if (harness === undefined) return undefined;
		const doc = await harness.snapshot(BackgroundDoc, parent as ConversationId, BACKGROUND_CONTEXT);
		if (doc === undefined) return undefined;
		if ((await harness.snapshot(BackgroundStopDoc, parent as ConversationId, BACKGROUND_CONTEXT))?.children[String(child)] === true) return undefined;
		return Object.entries(doc.agents).find(([, v]) => v.conversationId === child)?.[0];
	};
	return {
		nameOf,
		deliver: async (parent, child, content, approval) => {
			const harness = getHarness();
			if (harness === undefined) return false;
			return harness.commit(async (tx) => {
				const receipts = approval === undefined ? undefined : await tx.doc(BackgroundDeliveryDoc, parent as ConversationId);
				if (approval !== undefined && receipts?.receipts[approval.deliveryId] !== undefined) {
					return true;
				}
				const roster = await tx.doc(BackgroundDoc, parent as ConversationId);
				if ((await tx.doc(BackgroundStopDoc, parent as ConversationId)).children[String(child)] === true) return false;
				const name = Object.entries(roster.agents).find(([, v]) => v.conversationId === child)?.[0];
				if (name === undefined || await tx.conversation(child as ConversationId) === undefined) return false;
				const live = await scanLiveTasks(tx, { kind: BACKGROUND_REPORTER_KIND }, 1000);
				const cap = backgroundCapViolation(live.filter((task) => task.conversationId === parent).length, live.length);
				// Throwing leaves the decision journal pending; false would permanently discard its delivery.
				if (cap !== undefined) throw new Error(cap);
				await checkBackgroundWorkspace(tx, parent, child);
				const taskId = await tx.createTask(
					Reporter,
					{ name, parent, child, message: content, creator: approval?.sender ?? deps.senderOf(parent) ?? "", ...actorVia(deps, parent, approval?.via), work: (await workIdentity(tx, child, approval?.budgetId)) ?? null, followUp: false, ...(approval === undefined ? {} : { approval }) },
					{ ownership: { kind: "conversation" }, background: true, conversationId: parent as ConversationId },
				);
				if (approval !== undefined && receipts !== undefined) receipts.receipts[approval.deliveryId] = taskId as number;
				await prepareBackgroundWorkspace(tx, parent, child, taskId);
				return true;
			}, BACKGROUND_CONTEXT);
		},
	};
}

/** 全部后台子会话及其父会话：子会话由锚任务持有，扫会话记录拿到 (child, 锚任务)，锚任务所在会话即父线。
 *  启动时重建审批 scope 用（conversationScope 只在内存）；非锚任务持有的 task-owned 会话跳过。 */
export async function backgroundChildren(harness: Pick<Harness, "commit" | "getTask">): Promise<{ child: number; parent: number }[]> {
	const context = BACKGROUND_CONTEXT;
	const owned = await harness.commit(async (tx) => {
		const out: { child: number; anchor: TaskId }[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanConversations({}, 200, cursor);
			for (const record of page.items) if (record.owner !== undefined) out.push({ child: record.id as number, anchor: record.owner.taskId });
			cursor = page.next;
		} while (cursor !== undefined);
		return out;
	}, context);
	const pairs: { child: number; parent: number }[] = [];
	for (const { child, anchor } of owned) {
		const task = await harness.getTask(anchor, context);
		if (task?.kind === BACKGROUND_ANCHOR_KIND) pairs.push({ child, parent: task.conversationId as number });
	}
	return pairs;
}

/** 父会话的名册：name → 子会话。停止即移除（名字可复用）；durable，重启不丢。 */
export const BackgroundDoc = defineDoc<{ agents: Record<string, { conversationId: number }> }>({
	kind: "dwell.background",
	version: 1,
	scope: "conversation",
	history: "latest",
	// fork 出的会话不带后台任务
	fork: "initial",
	initial: () => ({ agents: {} }),
	// 名册只在增删时写；为空时存 base，控制 doc 回放长度
	checkpointWhen: (value) => Object.keys(value.agents).length === 0,
});

type AnchorState = { phase: "done" };

/** 锚任务：创建即终局，只为持有子会话（background 边界：父线 abort/idle 不穿越）。导出供测试直接建任务。 */
export const BackgroundAnchor = defineTask<null, AnchorState, null>({
	name: BACKGROUND_ANCHOR_KIND,
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** Cleanup has its own durable lifetime, so a cancelled stop tool cannot leave the child runnable. */
function makeBackgroundStopper(getHarness: () => Harness | undefined) {
	return defineTask<{ parent: number; child: number }, { phase: "stop" }, null>({
		name: "dwell.background-stop", version: 1, initial: () => ({ phase: "stop" }),
		phases: { stop: async (task, runtime, context) => {
			const harness = getHarness();
			if (harness === undefined) throw new Error("Background stop controller is unavailable");
			const { parent, child } = task.input;
			const reporters = await harness.commit(async (tx) => (await scanLiveTasks(tx, { kind: BACKGROUND_REPORTER_KIND }, 1000)).filter((reporter) => (reporter.input as ReporterInput).child === child).map((reporter) => reporter.id), context);
			for (const reporter of reporters) {
				await harness.abortTask(reporter, context);
				await harness.waitForTask(reporter, context);
			}
			const conversation = await runtime.conversation(child as ConversationId, context);
			if (conversation !== undefined) await conversation.abort(context);
			await removeApprovalTarget(child);
			await runtime.commit(async (tx) => {
				const roster = await tx.doc(BackgroundDoc, parent as ConversationId);
				for (const [name, agent] of Object.entries(roster.agents)) if (agent.conversationId === child) delete roster.agents[name];
				await releaseStoppedWorkspace(tx, child);
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context);
		} },
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

async function ensureStopCleanup(tx: Tx, parent: number, child: number, Stopper: ReturnType<typeof makeBackgroundStopper>): Promise<TaskId> {
	const doc = await tx.doc(BackgroundStopDoc, parent as ConversationId);
	const previous = doc.cleanup?.[String(child)];
	if (previous !== undefined) {
		const task = await tx.task(previous as TaskId);
		if (task !== undefined && (task.state.status !== "terminal" || task.state.outcome.status === "completed")) return previous as TaskId;
	}
	const task = await tx.createTask(Stopper, { parent, child }, { ownership: { kind: "conversation" }, conversationId: parent as ConversationId, background: true });
	doc.cleanup ??= {};
	doc.cleanup[String(child)] = task as number;
	return task;
}

/** Call while scheduling is paused: abort marks precede every resumed model or Reporter invocation. */
export async function reconcileBackgroundStops(harness: Harness): Promise<void> {
	const stopping = await harness.commit(async (tx) => {
		const out: { parent: number; child: number; tasks: TaskId[]; queued: SubmissionId[] }[] = [];
		const live = await scanLiveTasks(tx, {}, Number.MAX_SAFE_INTEGER);
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanConversations({}, 200, cursor);
			for (const parent of page.items) {
				const stops = await tx.doc(BackgroundStopDoc, parent.id);
				for (const [id, stopped] of Object.entries(stops.children)) {
					if (!stopped) continue;
					const child = Number(id);
					const queued = (await tx.doc(InboxDoc, child as ConversationId)).items.filter((item) => item.mode !== "write").map((item) => item.id);
					out.push({ parent: parent.id, child, queued, tasks: live.filter((task) => task.conversationId === child || (task.kind === BACKGROUND_REPORTER_KIND && (task.input as ReporterInput).child === child)).map((task) => task.id) });
				}
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return out;
	}, BACKGROUND_CONTEXT);
	// abortTask joins an active invocation without enabling scheduling; waitForTask would enable all work.
	for (const stop of stopping) {
		for (const id of stop.tasks) await harness.abortTask(id, BACKGROUND_CONTEXT);
		for (const id of stop.queued) await harness.abortSubmission(id, BACKGROUND_CONTEXT);
	}
	const Stopper = makeBackgroundStopper(() => harness);
	for (const stop of stopping) await harness.commit(async (tx) => {
		await markBackgroundWorkspaceStopped(tx, stop.child);
		await ensureStopCleanup(tx, stop.parent, stop.child, Stopper);
	}, BACKGROUND_CONTEXT);
}

type ReporterInput = { name: string; parent: number; child: number; message: string; creator: string; creatorVia?: RunVia; work?: WorkIdentity | null; followUp: boolean; approval?: BackgroundApprovalDelivery };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

function actorVia(deps: BackgroundDeps, parent: number, override?: RunVia): { creatorVia?: RunVia } {
	const via = override ?? deps.viaOf?.(parent);
	return via === undefined ? {} : { creatorVia: via };
}

function actorEntry(input: ReporterInput) {
	const via = creatorVia(input.creator, input.creatorVia);
	return { kind: "chat.message", data: { sender: input.creator, via: "background", work: input.work ?? null, ...(via === undefined ? {} : { authorityVia: via }) } };
}

/** 报告任务：把消息投给子会话，等答案，再以 followUp 回报父会话。requestId 保证重启后不重发。导出供测试直接建任务。 */
export const makeBackgroundReporter = (deps: BackgroundDeps) =>
	defineTask<ReporterInput, ReporterState, null>({
		name: BACKGROUND_REPORTER_KIND,
		version: 1,
		initial: () => ({ phase: "deliver" }),
		phases: {
			deliver: async (task, runtime, context) => {
				const input = task.input;
				const stopped = async () => (await runtime.snapshot(BackgroundStopDoc, input.parent as ConversationId, context))?.children[String(input.child)] === true;
				if (await stopped()) {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
					return;
				}
				if (input.approval !== undefined) {
					const roster = await runtime.snapshot(BackgroundDoc, input.parent as ConversationId, context);
					if (!Object.values(roster?.agents ?? {}).some((agent) => agent.conversationId === input.child)) {
						await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
						return;
					}
				}
				const child = await runtime.conversation(input.child as ConversationId, context);
				if (child === undefined) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", report: `[Background task ${input.name}] The task conversation is missing; nothing to report.` } }), context);
					return;
				}
				const content = input.approval?.action === undefined ? input.message : decisionInput(input.approval.action, input.approval.minutes ?? 10, input.approval.expiresAt);
				await cancellable(deps.attribute(input.child, input.creator), runtime.signal);
				if (await stopped()) {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
					return;
				}
				const submission = await child.submit(
					{ type: "input", content, requestId: `bg:${String(runtime.taskId)}`, whenBusy: input.approval !== undefined || input.followUp ? "followUp" : "steer", entry: input.approval === undefined ? actorEntry(input) : { kind: input.approval.budgetId === undefined ? "dwell.approval.legacy" : "dwell.approval", data: { sender: input.approval.sender, via: input.approval.via ?? creatorVia(input.creator, input.creatorVia) ?? "feishu", work: input.work ?? null, ...(input.approval.budgetId === undefined ? {} : { budgetId: input.approval.budgetId }) } } },
					context,
				);
				const settled = await submission.wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					// 被中止（stop/重启级联）不回报；失败把原因带回父会话
					const aborted = settled.status === "unanswered" && settled.reason === "aborted";
					const budget = aborted ? await deps.budgetStopReason?.(input.child, input.approval?.budgetId ?? `${input.child}:${String(submission.id)}`) : undefined;
					const note = budget !== undefined ? `[Background task ${input.name}] stopped at its execution budget (${budget}). Report this limit to the user; do not silently restart it.` : aborted ? undefined : `[Background task ${input.name}] failed: ${settled.status === "unanswered" ? settled.reason : settled.status}.`;
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", ...(note === undefined ? {} : { report: note }) } }), context);
					return;
				}
				await runtime.commit(async (tx) => {
					const entry = await tx.entry(AssistantEntry, settled.answer);
					const answer = entry?.model?.[0] as AssistantMessage | undefined;
					const text = (answer?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
					const report = text === ""
						? `[Background task ${input.name}] finished with no text output.`
						: `[Background task ${input.name} finished] ${text.slice(0, 4000)}`;
					return { status: "running", checkpoint: { phase: "report", report } };
				}, context);
			},
			report: async (task, runtime, context) => {
				const stopped = async () => (await runtime.snapshot(BackgroundStopDoc, task.input.parent as ConversationId, context))?.children[String(task.input.child)] === true;
				if (await stopped()) {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
					return;
				}
				const report = task.state.checkpoint.report;
				if (report !== undefined) {
					await cancellable(deps.attribute(task.input.parent, task.input.creator), runtime.signal);
					if (await stopped()) {
						await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
						return;
					}
					const parent = await runtime.conversation(task.input.parent as ConversationId, context);
					if (parent !== undefined) {
						const submission = await parent.submit(
							{ type: "input", content: report, requestId: `bg-report:${String(runtime.taskId)}`, whenBusy: "followUp", entry: actorEntry(task.input) },
							context,
						);
						await cancellable(Promise.resolve(deps.onFired(task.input.parent, submission.id, `🧵 后台任务 ${task.input.name} 完成`)), runtime.signal);
					}
				}
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

function makeBackgroundTool(deps: BackgroundDeps, Reporter: ReturnType<typeof makeBackgroundReporter>) {
	const Stopper = makeBackgroundStopper(() => deps.getHarness?.());
	const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
	return defineTool({
		name: "dwell.task",
		description:
			"Manage background task agents that keep working while this conversation stays free. start: spawn a named background agent with a self-contained message (English, include everything it needs; it starts with this conversation's tools and working directory but an empty context, and it cannot start background tasks of its own). " +
			"Its answer comes back here as a follow-up message when done, and you are then expected to relay or act on it. The follow-up waits until this run ends: when you need the child's result, call dwell.task.wait by itself to end this run and let the result resume you. send: give a running agent another message (steer by default; followUp: true queues it after its current answer). status: list agents and whether each is busy; status does not deliver results. stop: abort an agent's current work. " +
			"Tasks default to mode=read: no shell commands or file changes. Explicit mode=write hands off exclusive workspace write access; dispatch it in a tool batch by itself, then keep this main run read-only until it ends. Use a writable task for builds or other commands. /cancel and clearing the context do not stop background tasks; use stop.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("send"), Type.Literal("status"), Type.Literal("stop")]),
			name: Type.Optional(Type.String({ description: "Agent name (1-40 chars, unique in this conversation)" })),
			message: Type.Optional(Type.String({ description: "The task (start) or the follow-up message (send), self-contained, in English" })),
			followUp: Type.Optional(Type.Boolean({ description: "send only: true queues the message after the agent's current answer instead of steering" })),
			mode: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")], { description: "start only: read by default, or write to hand off exclusive workspace write access; a task's mode cannot change later" })),
		}),
		// 崩溃重放可能重复 start/stop 新的工作，不重跑；模型看到 interrupted 后可用 status 核对
		replay: "unsafe",
		async execute(args, api, context) {
			const name = (args.name ?? "").trim().slice(0, 40);

			if (args.action === "status") {
				const state = (await api.snapshot(BackgroundDoc, api.conversationId, context)) ?? { agents: {} };
				const names = name === "" ? Object.keys(state.agents) : [name];
				const lines: string[] = [];
				for (const each of names) {
					const found = state.agents[each];
					if (found === undefined) continue;
					const busy = (await api.snapshot(LiveDoc, found.conversationId as ConversationId, context))?.run !== undefined;
					const access = (await api.snapshot(WorkspaceDoc, context))?.children[String(found.conversationId)];
					lines.push(`${each}: ${busy ? "working" : "idle"} (${access?.mode ?? "read"})`);
				}
				return text(lines.length === 0 ? "No background tasks in this conversation." : `${lines.join("\n")}\nStatus does not deliver results. Call dwell.task.wait by itself when you need a pending result; it ends this run so the follow-up can resume you.`);
			}
			if (name === "") return text(`${args.action} needs a name.`, true);
			if (args.action === "stop") {
				const harness = deps.getHarness?.();
				if (harness === undefined) return text("The background task controller is unavailable; stop could not be completed.", true);
				const stopping = await api.commit(async (tx) => {
					const found = (await tx.doc(BackgroundDoc, api.conversationId)).agents[name];
					if (found === undefined) return undefined;
					(await tx.doc(BackgroundStopDoc, api.conversationId)).children[String(found.conversationId)] = true;
					await markBackgroundWorkspaceStopped(tx, found.conversationId);
					return ensureStopCleanup(tx, api.conversationId, found.conversationId, Stopper);
				}, context);
				if (stopping === undefined) return text(`No background task named ${name}.`, true);
				const result = await harness.waitForTask(stopping, context);
				if (result.state.outcome.status !== "completed") return text(`Stopping ${name} did not finish. Its stop intent is saved; retry stop to finish cancellation.`, true);
				return text(`Stopped ${name}.`);
			}
			const message = (args.message ?? "").trim();
			if (message === "") return text(`${args.action} needs a message.`, true);

			if (args.action === "send") {
				if (args.mode !== undefined) return text("Task mode is fixed at start. Stop it and start a new task to choose a different mode.", true);
				// send 同样过成本闸：空闲代理逐个 send 可并发起 N 个 run，与 start 同限
				const error = await api.commit(async (tx) => {
					const existing = (await tx.doc(BackgroundDoc, api.conversationId)).agents[name];
					if (existing === undefined) return `No background task named ${name}; use start.`;
					if ((await tx.doc(BackgroundStopDoc, api.conversationId)).children[String(existing.conversationId)] === true) return "This background task has been stopped.";
					const live = await scanLiveTasks(tx, { kind: BACKGROUND_REPORTER_KIND }, 1000);
					const cap = backgroundCapViolation(live.filter((t) => (t.conversationId as number) === (api.conversationId as number)).length, live.length);
					if (cap !== undefined) return cap;
					await checkBackgroundWorkspace(tx, api.conversationId, existing.conversationId, api.taskId);
					const reporter = await tx.createTask(Reporter, { name, parent: api.conversationId as number, child: existing.conversationId, message, creator: deps.senderOf(api.conversationId as number) ?? "", ...actorVia(deps, api.conversationId), work: (await workIdentity(tx, existing.conversationId)) ?? null, followUp: args.followUp === true }, { ownership: { kind: "conversation" }, background: true });
					await prepareBackgroundWorkspace(tx, api.conversationId, existing.conversationId, reporter);
					return undefined;
				}, context);
				if (error !== undefined) return text(error, true);
				return text(`Sent to ${name}.`);
			}
			// start
			const mode = args.mode ?? "read";
			const cwd = api.env?.cwd;
			if (mode === "write" && cwd === undefined) return text("A writable background task needs an execution workspace.", true);
			const workspace = mode === "write" ? await canonicalWorkspace(cwd!) : resolve(cwd ?? DEFAULT_CWD);
			type StartResult = { ok: false; error: string } | { ok: true; child: number };
			const created = await api.commit<StartResult>(async (tx) => {
				const doc = await tx.doc(BackgroundDoc, api.conversationId);
				if (doc.agents[name] !== undefined) return { ok: false, error: `${name} already exists; use send.` };
				const live = await scanLiveTasks(tx, { kind: BACKGROUND_REPORTER_KIND }, 1000);
				const cap = backgroundCapViolation(live.filter((t) => (t.conversationId as number) === (api.conversationId as number)).length, live.length);
				if (cap !== undefined) return { ok: false, error: cap };
				if (mode === "write") {
					const violation = await workspaceStartViolation(tx, api.conversationId, workspace, api.taskId);
					if (violation !== undefined) return { ok: false, error: violation };
				}
				const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
				// 子会话由锚持有：复制父 agent（cwd/模型/工具），再收掉递归派生工具
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
				await inheritWork(tx, api.conversationId, child.id);
				await configure(tx, child.id, {
					// 移除后台/定时/托管进程扩展对象：子代理不能递归派生，也不起后台进程（任务定义随扩展走，子会话也不会跑这几类任务）
					extensions: { remove: [...deps.forbidden()] },
					...(mode === "read" ? { tools: { remove: api.registry.tools().filter(({ tool }) => !readOnlyWorkspaceTool(tool.name)).map(({ tool }) => tool) } } : {}),
					instructions:
						`You are a background task agent working for the main dwell conversation. The user does not see this conversation directly. ` +
						`Your workspace mode is ${mode}. ${mode === "read" ? "Read and analyze existing material; do not run shell commands or change files. Return any proposed edits as part of your answer. " : "You hold the workspace write lease for this task. "}` +
						`Do the job you were given, then end with a concise, self-contained summary of the result: your final answer is reported back to the main agent verbatim.`,
				});
				doc.agents[name] = { conversationId: child.id as number };
				const reporter = await tx.createTask(Reporter, { name, parent: api.conversationId as number, child: child.id as number, message, creator: deps.senderOf(api.conversationId as number) ?? "", ...actorVia(deps, api.conversationId), work: (await workIdentity(tx, child.id)) ?? null, followUp: false }, { ownership: { kind: "conversation" }, background: true });
				await registerBackgroundWorkspace(tx, api.conversationId, child.id, mode, workspace, reporter);
				return { ok: true, child: child.id as number };
			}, context);
			if (!created.ok) return text(created.error, true);
			deps.onStarted(created.child, api.conversationId as number);
			return text(`Started ${name}. Its answer will arrive here as a follow-up; tell the user it runs in the background.`);
		},
	});
}

function makeBackgroundWaitTool() {
	return defineTool({
		name: BACKGROUND_WAIT_TOOL,
		description: "End this run while waiting for a pending background agent result. Call this tool alone, with no other tool calls in the same response. A background Reporter's follow-up starts a new run when its result is available. This does not stop or poll the agent; status does not deliver its result. Cannot be called by another tool.",
		parameters: Type.Object({}),
		replay: "safe",
		executionMode: "sequential",
		async execute(_args, api, context) {
			const error = await api.commit(async (tx) => {
				const current = await tx.task(api.taskId);
				const input = current?.input as { kind?: string; assistant?: number; callId?: string } | undefined;
				if (input?.kind !== "model" || input.assistant === undefined) return "Call dwell.task.wait directly, not from another tool.";
				const entry = await tx.entry(AssistantEntry, input.assistant as EntryId);
				const message = entry?.model?.[0];
				const calls = message?.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [];
				// pi-durable only terminates when every result of a round requests it.
				if (entry?.conversationId !== api.conversationId || calls.length !== 1 || calls[0]!.name !== BACKGROUND_WAIT_TOOL || calls[0]!.id !== api.callId) return "Call dwell.task.wait alone, with no other tool calls in the same response.";
				const roster = await tx.doc(BackgroundDoc, api.conversationId);
				const stops = await tx.doc(BackgroundStopDoc, api.conversationId);
				const belongs = (task: { kind: string; conversationId: number; input: unknown }) => {
					const reporter = task.input as ReporterInput;
					return task.kind === BACKGROUND_REPORTER_KIND && task.conversationId === api.conversationId && reporter.parent === api.conversationId && roster.agents[reporter.name]?.conversationId === reporter.child && stops.children[String(reporter.child)] !== true;
				};
				if ((await scanLiveTasks(tx, { kind: BACKGROUND_REPORTER_KIND }, 1000)).some(belongs)) return undefined;
				// A Reporter can finish before the wait call reaches this transaction.
				const queued = new Set((await tx.doc(InboxDoc, api.conversationId)).items.filter((item) => item.mode === "followUp").map((item) => item.id));
				let cursor: Cursor | undefined;
				if (queued.size > 0) do {
					const page = await tx.scanTasks({ conversationId: api.conversationId, kind: BACKGROUND_REPORTER_KIND, order: "descending" }, 200, cursor);
					for (const reporter of page.items) {
						if (!belongs(reporter)) continue;
						const submission = await tx.submissionByRequest(api.conversationId, `bg-report:${String(reporter.id)}`);
						if (submission?.status === "queued" && queued.has(submission.id)) return undefined;
					}
					cursor = page.next;
				} while (cursor !== undefined);
				return "No pending background result belongs to this conversation. Continue the task or start a background agent first.";
			}, context);
			if (error !== undefined) return { output: [{ type: "text", text: error }], isError: true };
			return {
				output: [{ type: "text", text: "Waiting for a background result. This run has ended; the Reporter's follow-up will resume the conversation." }],
				details: { waitingForBackground: true },
				control: { terminate: true },
			};
		},
	});
}

/** 装配：任务定义与工具同扩展（pending 的 Reporter 重启后续跑）。 */
export function makeBackgroundExtension(deps: BackgroundDeps): Extension {
	const Reporter = makeBackgroundReporter(deps);
	return defineExtension({
		name: "dwell-background",
		tools: [makeBackgroundTool(deps, Reporter), makeBackgroundWaitTool()],
		tasks: [BackgroundAnchor, Reporter, makeBackgroundStopper(() => deps.getHarness?.())],
		sections: [
			section("background", () =>
				"For long jobs that should not block the conversation (builds, crawls, batch processing), start a background agent with dwell.task and keep talking; its answer arrives as a follow-up after the current run ends. When you need its result, call dwell.task.wait alone to end this run; the durable Reporter's follow-up resumes you in a new run. Status does not deliver results. Do not poll status or start a process to wait. /cancel and clearing context do not stop background tasks — use dwell.task stop.",
				{ tag: false },
			),
		],
	});
}
