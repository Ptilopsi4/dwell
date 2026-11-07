// 后台任务：dwell.task 工具把自包含任务派给后台子代理（Anchor 持有子会话 + Reporter 投递与回报）。
// 子会话继承父会话的 cwd/模型/工具（去掉 dwell.task / dwell.schedule 防递归派生）；父线 /cancel 与 idle 等待
// 不穿越 background 边界。答案以 followUp 回到父会话，由宿主 onFired 开卡（模式同官方 example 23）。
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineDoc, defineExtension, defineTask, defineTool, LiveDoc, section, type ConversationId, type Extension, type SubmissionId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { scanLiveTasks } from "./schedule.ts";

export const BACKGROUND_ANCHOR_KIND = "dwell.background-anchor";
export const BACKGROUND_REPORTER_KIND = "dwell.background-reporter";

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
	/** run 归属登记（后台回报触发的父线 run 归到创建者） */
	attribute: (conversationId: number, creator: string) => void;
	/** 触发的 run 由宿主开回复卡（与定时任务同一入口） */
	onFired: (conversationId: number, submissionId: SubmissionId, header: string) => void;
	/** 子会话创建登记：审批 scope 映射（子→父）与 panel 展示用 */
	onStarted: (child: number, parent: number) => void;
	/** 当前 run 发起者（后台任务创建者，回报归属用） */
	senderOf: (conversationId: number) => string | undefined;
	/** 子代理 agent 变更中要移除的扩展对象（防递归派生；AgentChange 按对象引用，getter 延迟取装配产物） */
	forbidden: () => readonly Extension[];
};

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

type ReporterInput = { name: string; parent: number; child: number; message: string; creator: string; followUp: boolean };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

/** 报告任务：把消息投给子会话，等答案，再以 followUp 回报父会话。requestId 保证重启后不重发。导出供测试直接建任务。 */
export const makeBackgroundReporter = (deps: BackgroundDeps) =>
	defineTask<ReporterInput, ReporterState, null>({
		name: BACKGROUND_REPORTER_KIND,
		version: 1,
		initial: () => ({ phase: "deliver" }),
		phases: {
			deliver: async (task, runtime, context) => {
				const input = task.input;
				const child = await runtime.conversation(input.child as ConversationId, context);
				if (child === undefined) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", report: `[Background task ${input.name}] The task conversation is missing; nothing to report.` } }), context);
					return;
				}
				const submission = await child.submit(
					{ type: "input", content: input.message, requestId: `bg:${String(runtime.taskId)}`, whenBusy: input.followUp ? "followUp" : "steer" },
					context,
				);
				const settled = await submission.wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					// 被中止（stop/重启级联）不回报；失败把原因带回父会话
					const aborted = settled.status === "unanswered" && settled.reason === "aborted";
					const note = aborted ? undefined : `[Background task ${input.name}] failed: ${settled.status === "unanswered" ? settled.reason : settled.status}.`;
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
				const report = task.state.checkpoint.report;
				if (report !== undefined) {
					deps.attribute(task.input.parent, task.input.creator);
					const parent = await runtime.conversation(task.input.parent as ConversationId, context);
					if (parent !== undefined) {
						const submission = await parent.submit(
							{ type: "input", content: report, requestId: `bg-report:${String(runtime.taskId)}`, whenBusy: "followUp", entry: { kind: "chat.message", data: { sender: task.input.creator, via: "background" } } },
							context,
						);
						deps.onFired(task.input.parent, submission.id, `🧵 后台任务 ${task.input.name} 完成`);
					}
				}
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

function makeBackgroundTool(deps: BackgroundDeps, Reporter: ReturnType<typeof makeBackgroundReporter>) {
	const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
	return defineTool({
		name: "dwell.task",
		description:
			"Manage background task agents that keep working while this conversation stays free. start: spawn a named background agent with a self-contained message (English, include everything it needs; it starts with this conversation's tools and working directory but an empty context, and it cannot start background tasks of its own). " +
			"Its answer comes back here as a follow-up message when done, and you are then expected to relay or act on it. send: give a running agent another message (steer by default; followUp: true queues it after its current answer). status: list agents and whether each is busy. stop: abort an agent's current work. " +
			"Use it for long jobs that should not block the conversation (builds, crawls, batch processing). /cancel and clearing the context do not stop background tasks; use stop.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("send"), Type.Literal("status"), Type.Literal("stop")]),
			name: Type.Optional(Type.String({ description: "Agent name (1-40 chars, unique in this conversation)" })),
			message: Type.Optional(Type.String({ description: "The task (start) or the follow-up message (send), self-contained, in English" })),
			followUp: Type.Optional(Type.Boolean({ description: "send only: true queues the message after the agent's current answer instead of steering" })),
		}),
		// 崩溃重放可能重复 start/stop 新的工作，不重跑；模型看到 interrupted 后可用 status 核对
		replay: "unsafe",
		async execute(args, api, context) {
			const state = (await api.snapshot(BackgroundDoc, api.conversationId, context)) ?? { agents: {} };
			const name = (args.name ?? "").trim().slice(0, 40);

			if (args.action === "status") {
				const names = name === "" ? Object.keys(state.agents) : [name];
				const lines: string[] = [];
				for (const each of names) {
					const found = state.agents[each];
					if (found === undefined) continue;
					const busy = (await api.snapshot(LiveDoc, found.conversationId as ConversationId, context))?.run !== undefined;
					lines.push(`${each}: ${busy ? "working" : "idle"}`);
				}
				return text(lines.length === 0 ? "No background tasks in this conversation." : lines.join("\n"));
			}
			if (name === "") return text(`${args.action} needs a name.`, true);
			if (args.action === "stop") {
				const found = state.agents[name];
				if (found === undefined) return text(`No background task named ${name}.`, true);
				const child = await api.conversation(found.conversationId as ConversationId, context);
				if (child !== undefined) await child.abort(context);
				await api.commit(async (tx) => {
					const doc = await tx.doc(BackgroundDoc, api.conversationId);
					delete doc.agents[name];
				}, context);
				return text(`Stopped ${name}.`);
			}
			const message = (args.message ?? "").trim();
			if (message === "") return text(`${args.action} needs a message.`, true);
			const existing = state.agents[name];

			if (args.action === "send") {
				if (existing === undefined) return text(`No background task named ${name}; use start.`, true);
				await api.commit(async (tx) => {
					await tx.createTask(Reporter, { name, parent: api.conversationId as number, child: existing.conversationId, message, creator: deps.senderOf(api.conversationId as number) ?? "", followUp: args.followUp === true }, { ownership: { kind: "conversation" }, background: true });
				}, context);
				return text(`Sent to ${name}.`);
			}
			// start
			if (existing !== undefined) return text(`${name} already exists; use send.`, true);
			type StartResult = { ok: false; error: string } | { ok: true; child: number };
			const created = await api.commit<StartResult>(async (tx) => {
				const live = await scanLiveTasks(tx, { kind: BACKGROUND_REPORTER_KIND }, 1000);
				const cap = backgroundCapViolation(live.filter((t) => (t.conversationId as number) === (api.conversationId as number)).length, live.length);
				if (cap !== undefined) return { ok: false, error: cap };
				const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
				// 子会话由锚持有：复制父 agent（cwd/模型/工具），再收掉递归派生工具
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
				await configure(tx, child.id, {
					// 移除后台/定时扩展对象：子代理不能递归派生（任务定义随扩展走，子会话也不会跑这两类任务）
					extensions: { remove: [...deps.forbidden()] },
					instructions:
						`You are a background task agent working for the main dwell conversation. The user does not see this conversation directly. ` +
						`Do the job you were given with the tools and working directory you start with, then end with a concise, self-contained summary of the result: your final answer is reported back to the main agent verbatim.`,
				});
				const doc = await tx.doc(BackgroundDoc, api.conversationId);
				doc.agents[name] = { conversationId: child.id as number };
				await tx.createTask(Reporter, { name, parent: api.conversationId as number, child: child.id as number, message, creator: deps.senderOf(api.conversationId as number) ?? "", followUp: false }, { ownership: { kind: "conversation" }, background: true });
				return { ok: true, child: child.id as number };
			}, context);
			if (!created.ok) return text(created.error, true);
			deps.onStarted(created.child, api.conversationId as number);
			return text(`Started ${name}. Its answer will arrive here as a follow-up; tell the user it runs in the background.`);
		},
	});
}

/** 装配：任务定义与工具同扩展（pending 的 Reporter 重启后续跑）。 */
export function makeBackgroundExtension(deps: BackgroundDeps): Extension {
	const Reporter = makeBackgroundReporter(deps);
	return defineExtension({
		name: "dwell-background",
		tools: [makeBackgroundTool(deps, Reporter)],
		tasks: [BackgroundAnchor, Reporter],
		sections: [
			section("background", () =>
				"For long jobs that should not block the conversation (builds, crawls, batch processing), start a background agent with dwell.task and keep talking; its answer arrives as a follow-up. /cancel and clearing context do not stop background tasks — use dwell.task stop.",
				{ tag: false },
			),
		],
	});
}
