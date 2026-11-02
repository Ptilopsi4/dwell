// dwell 主程序：harness + 飞书 Channel（消息/卡片回调）+ 消息管线（白名单 → 命令 → submit → 回复）。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, type Conversation, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { openDwell } from "./harness.ts";
import { Sessions } from "./sessions.ts";
import { connectChannel, type CardActionEvent, type LarkChannel, type NormalizedMessage } from "./feishu/channel.ts";
import { approvals, pendingApprovals, setApprovalCallback } from "./ext/approval.ts";

const ALLOW = (process.env.DWELL_ALLOW ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter((s) => s !== "");
if (ALLOW.length === 0) {
	console.error("DWELL_ALLOW 未设置（逗号分隔的 open_id 白名单），dwell 将拒绝所有消息");
}

type ReplyTarget = { chatId: string; messageId: string };

let harness: Harness;
let sessions: Sessions;
let channel: LarkChannel;

async function main(): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	harness = await openDwell();
	sessions = new Sessions(harness);
	await sessions.load();

	setApprovalCallback((conversationId, command, match) => {
		const chatId = sessions.chatOf(conversationId);
		if (chatId === undefined) return;
		void sendApprovalCard(chatId, conversationId, command, match);
	});

	channel = await connectChannel({
		onMessage: (msg) => void handleMessage(msg),
		onCardAction: (evt) => void handleCardAction(evt),
	});
	console.log(`[dwell] 就绪（bot: ${channel.botIdentity?.name ?? "?"}）`);
}

async function handleMessage(msg: NormalizedMessage): Promise<void> {
	try {
		if (msg.rawContentType !== "text" || msg.content.trim() === "") return;
		if (!ALLOW.includes(msg.senderId)) return; // 白名单外静默丢弃

		const text = msg.content.trim();
		const conversation = await sessions.forChat(msg.chatId);
		const context = BACKGROUND_CONTEXT;

		if (text.startsWith("/")) {
			await runCommand(text, conversation, { chatId: msg.chatId, messageId: msg.messageId });
			return;
		}

		const submission = await conversation.submit(
			{ type: "input", content: text, requestId: msg.messageId, whenBusy: "steer" },
			context,
		);
		// 3 秒 ack 约束：不在此等待，后台完成后回复（requestId 幂等，飞书重推安全）
		void submitAndReply(conversation, submission, { chatId: msg.chatId, messageId: msg.messageId });
	} catch (err) {
		console.error("[dwell] 消息处理出错:", err);
	}
}

/** 等 submission 完成，把最终回复发回飞书。 */
async function submitAndReply(
	conversation: Conversation,
	submission: Awaited<ReturnType<Conversation["submit"]>>,
	target: ReplyTarget,
): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const settled = await submission.wait(context);
	if (settled.status === "done" && settled.type === "input") {
		const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const answer = entry?.model?.[0] as AssistantMessage | undefined;
		const reply = (answer?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
		await replyTo(target, reply || "（空回复）");
	} else {
		const reason = settled.status === "unanswered" ? settled.reason : settled.status;
		await replyTo(target, `处理失败：${reason}`);
	}
}

async function replyTo(target: ReplyTarget, text: string): Promise<void> {
	await channel.send(target.chatId, { markdown: text }, { replyTo: target.messageId });
}

async function runCommand(text: string, conversation: Conversation, target: ReplyTarget): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const cmd = text.split(/\s+/)[0];
	switch (cmd) {
		case "/new":
			await conversation.reset(undefined, context);
			await replyTo(target, "已开启新对话。");
			break;
		case "/status": {
			const graph = await harness.taskGraph?.(context);
			await replyTo(target, graph ? `运行中任务：\n${JSON.stringify(graph, null, 1).slice(0, 1500)}` : "当前无任务运行。");
			break;
		}
		case "/cancel": {
			await conversation.abort(context);
			await replyTo(target, "已中止当前任务。");
			break;
		}
		case "/approve": {
			const minutes = Number(text.split(/\s+/)[1]) || 10;
			approvals.set(conversation.id as number, Date.now() + minutes * 60_000);
			await replyTo(target, `已批准：本会话 ${minutes} 分钟内危险命令免拦截。`);
			const s = await conversation.submit({
				type: "input",
				content: `用户已批准危险命令窗口（${minutes} 分钟）。请继续之前的任务，重试被拦截的命令。`,
				whenBusy: "steer",
				requestId: `${target.messageId}-approve`,
			}, context);
			void submitAndReply(conversation, s, target);
			break;
		}
		case "/deny": {
			approvals.delete(conversation.id as number);
			await replyTo(target, "已关闭批准窗口。");
			break;
		}
		default:
			await replyTo(target, `未知命令 ${cmd}。可用：/new /status /cancel /approve [分钟] /deny`);
	}
}

/** 审批卡片（Card V2 + behaviors.callback，官方 Channel 按钮回调要求）。 */
function approvalCard(
	conversationId: number,
	command: string,
	match: string,
	state: { kind: "request" } | { kind: "approved"; minutes: number } | { kind: "denied" },
): Record<string, unknown> {
	const done = state.kind !== "request";
	const header = state.kind === "denied"
		? { title: { tag: "plain_text", content: "已拒绝" }, template: "red" }
		: state.kind === "approved"
			? { title: { tag: "plain_text", content: `已批准 · ${state.minutes} 分钟` }, template: "green" }
			: { title: { tag: "plain_text", content: "需要你的批准" }, template: "grey" };
	const chosen = state.kind === "approved" ? state.minutes : 0;
	const buttons = [
		{ text: chosen === 10 || state.kind === "denied" ? "已批准 10 分钟" : "批准 10 分钟", type: "primary", value: { action: "approve", minutes: 10, conversationId } },
		{ text: chosen === 30 || state.kind === "denied" ? "已批准 30 分钟" : "批准 30 分钟", type: "primary", value: { action: "approve", minutes: 30, conversationId } },
		{ text: state.kind === "denied" ? "已拒绝" : "拒绝", type: "danger", value: { action: "deny", conversationId } },
	];
	return {
		schema: "2.0",
		config: { width_mode: "fill" },
		header: { ...header, text_tag_list: [{ tag: "text_tag", text: { tag: "plain_text", content: match }, color: "carmine" }] },
		body: { elements: [
			{ tag: "markdown", content: `**\`${match}\`**\n即将执行：\n\`\`\`bash\n${command.slice(0, 300)}\n\`\`\`` },
			{ tag: "column_set", columns: buttons.map((b) => ({
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [{
					tag: "button",
					text: { tag: "plain_text", content: b.text },
					type: b.type,
					width: "fill",
					...(done ? { disabled: true } : {}),
					behaviors: [{ type: "callback", value: b.value }],
				}],
			})) },
		] },
	};
}

async function sendApprovalCard(chatId: string, conversationId: number, command: string, match: string): Promise<void> {
	try {
		await channel.send(chatId, { card: approvalCard(conversationId, command, match, { kind: "request" }) });
	} catch (err) {
		console.error("[dwell] 审批卡片发送失败:", err);
	}
}

/** 卡片按钮回调：审批/拒绝后更新卡片并唤醒模型。 */
async function handleCardAction(evt: CardActionEvent): Promise<void> {
	const v = evt.action.value as { action?: string; minutes?: number; conversationId?: number } | undefined;
	if (v?.action !== "approve" && v?.action !== "deny") return;
	if (!ALLOW.includes(evt.operator.openId)) return; // 只有白名单用户能审
	const conversationId = v.conversationId;
	if (conversationId === undefined) return;
	const context = BACKGROUND_CONTEXT;
	const conversation = await harness.conversation(conversationId as ConversationId, context);
	if (conversation === undefined) return;

	const pending = pendingApprovals.get(conversationId);
	const minutes = v.minutes ?? 10;
	const state = v.action === "approve" ? { kind: "approved" as const, minutes } : { kind: "denied" as const };
	if (pending !== undefined) {
		await channel.updateCard(evt.messageId, approvalCard(conversationId, pending.command, pending.match, state)).catch(() => {});
	}

	if (v.action === "approve") {
		approvals.set(conversationId, Date.now() + minutes * 60_000);
		const s = await conversation.submit({
			type: "input",
			content: `用户已批准危险命令窗口（${minutes} 分钟）。请继续之前的任务，重试被拦截的命令。`,
			whenBusy: "steer",
			requestId: `card-${evt.messageId}-approve`,
		}, context);
		void submitAndReply(conversation, s, { chatId: evt.chatId, messageId: evt.messageId });
	} else {
		approvals.delete(conversationId);
		const s = await conversation.submit({
			type: "input",
			content: "用户拒绝了危险命令。请停止该操作并改用其他方案，或询问用户意图。",
			whenBusy: "steer",
			requestId: `card-${evt.messageId}-deny`,
		}, context);
		void submitAndReply(conversation, s, { chatId: evt.chatId, messageId: evt.messageId });
	}
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
async function shutdown(): Promise<void> {
	console.log("[dwell] 关闭中…");
	await channel?.disconnect();
	await harness?.close(BACKGROUND_CONTEXT);
	process.exit(0);
}

void main();
