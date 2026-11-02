// dwell 主程序：harness + 飞书事件循环 + 消息管线（白名单 → 命令 → submit → 回复）。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, type Conversation, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { openDwell } from "./harness.ts";
import { Sessions } from "./sessions.ts";
import { startEventLoop, type LarkMessage } from "./feishu/consumer.ts";
import { lark, sendText, splitMessage, updateCard } from "./feishu/reply.ts";
import { approvals, setApprovalCallback } from "./ext/approval.ts";

type ReplyTarget = { chat_id: string; message_id: string };

const ALLOW = (process.env.DWELL_ALLOW ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter((s) => s !== "");
if (ALLOW.length === 0) {
	console.error("DWELL_ALLOW 未设置（逗号分隔的 open_id 白名单），dwell 将拒绝所有消息");
}

let harness: Harness;
let sessions: Sessions;

async function main(): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	harness = await openDwell();
	sessions = new Sessions(harness);
	await sessions.load();
	setApprovalCallback((conversationId, command, reason) => {
		const chatId = sessions.chatOf(conversationId);
		if (chatId === undefined) return;
		void sendText(chatId, `⚠ 需要审批（${reason}）：\n${command.slice(0, 200)}\n\n回复 -approve 批准（默认 10 分钟）或 -deny 拒绝`).catch(() => {});
	});
	startEventLoop((raw) => void handleMessage(raw as unknown as LarkMessage));
	startEventLoop((raw) => void handleCardAction(raw), "card.action.trigger");
	console.log("[dwell] 就绪");
}

async function handleMessage(m: LarkMessage): Promise<void> {
	try {
		if (m.message_type !== "text" || m.sender_type !== "user" || m.content.trim() === "") return;
		if (!ALLOW.includes(m.sender_id)) return; // 白名单外静默丢弃
		if (m.chat_type === "group" && (m.mentions?.length ?? 0) === 0) return; // 群聊仅 @bot 时响应

		const text = m.content.trim();
		const conversation = await sessions.forChat(m.chat_id);
		const context = BACKGROUND_CONTEXT;

		if (text.startsWith("-")) {
			await runCommand(text, conversation, m);
			return;
		}

		const submission = await conversation.submit(
			{ type: "input", content: text, requestId: m.message_id, whenBusy: "steer" },
			context,
		);
		await submitAndReply(conversation, submission, m);
	} catch (err) {
		console.error("[dwell] 消息处理出错:", err);
		try {
			await replyTo(m, `内部错误：${err instanceof Error ? err.message : String(err)}`);
		} catch {
			// 回复失败不再重试，错误已进日志
		}
	}
}

/** 等 submission 完成，把最终回复发回飞书。 */
async function submitAndReply(conversation: Conversation, submission: Awaited<ReturnType<Conversation["submit"]>>, m: ReplyTarget): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const settled = await submission.wait(context);
	if (settled.status === "done" && settled.type === "input") {
		const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const answer = entry?.model?.[0] as AssistantMessage | undefined;
		const reply = (answer?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
		await replyTo(m, reply || "（空回复）");
	} else {
		const reason = settled.status === "unanswered" ? settled.reason : settled.status;
		await replyTo(m, `处理失败：${reason}`);
	}
}

async function replyTo(m: ReplyTarget, text: string): Promise<void> {
	for (const part of splitMessage(text)) {
		await sendText(m.chat_id, part, m.message_id);
	}
}

async function runCommand(text: string, conversation: Awaited<ReturnType<Sessions["forChat"]>>, m: LarkMessage): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const cmd = text.split(/\s+/)[0];
	switch (cmd) {
		case "-new":
			await conversation.reset(undefined, context);
			await replyTo(m, "已开启新对话。");
			break;
		case "-status": {
			const graph = await harness.taskGraph?.(context);
			await replyTo(m, graph ? `运行中任务：\n${JSON.stringify(graph, null, 1).slice(0, 1500)}` : "当前无任务运行。");
			break;
		}
		case "-cancel": {
			await conversation.abort(context);
			await replyTo(m, "已中止当前任务。");
			break;
		}
		case "-approve": {
			const minutes = Number(text.split(/\s+/)[1]) || 10;
			approvals.set(conversation.id as number, Date.now() + minutes * 60_000);
			await replyTo(m, `已批准：本会话 ${minutes} 分钟内危险命令免拦截。`);
			// 唤醒模型继续被拦的任务（run 已结束时作为新输入，运行中则 steer）
			const s = await conversation.submit({
				type: "input",
				content: `用户已批准危险命令窗口（${minutes} 分钟）。请继续之前的任务，重试被拦截的命令。`,
				whenBusy: "steer",
				requestId: `${m.message_id}-approve`,
			}, context);
			await submitAndReply(conversation, s, m);
			break;
		}
		case "-deny": {
			approvals.delete(conversation.id as number);
			await replyTo(m, "已关闭批准窗口。");
			break;
		}
		default:
			await replyTo(m, `未知命令 ${cmd}。可用：-new / -status / -cancel / -approve [分钟] / -deny`);
	}
}

/** 发送带按钮的审批卡片。 */
function sendApprovalCard(chatId: string, conversationId: number, command: string, reason: string): void {
	const value = (action: string, minutes = 0) => JSON.stringify({ action, minutes, conversationId });
	const card = {
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: `⚠ 需要审批：${reason}` }, template: "orange" },
		elements: [
			{ tag: "div", text: { tag: "lark_md", content: `命令：\`\`\`${command.slice(0, 300)}\`\`\`\n批准后窗口内同类命令不再逐条询问。` } },
			{ tag: "action", actions: [
				{ tag: "button", text: { tag: "plain_text", content: "批准 10 分钟" }, type: "primary", value: value("approve", 10) },
				{ tag: "button", text: { tag: "plain_text", content: "批准 30 分钟" }, type: "primary", value: value("approve", 30) },
				{ tag: "button", text: { tag: "plain_text", content: "拒绝" }, type: "danger", value: value("deny") },
			] },
		],
	};
	void lark(["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--msg-type", "interactive", "--content", "-"], JSON.stringify(card))
		.catch((err) => console.error("[dwell] 审批卡片发送失败:", err));
}

interface CardActionEvent {
	action_tag?: string;
	action_value?: string;
	operator_id?: string;
	chat_id?: string;
	event_id?: string;
	token?: string;
}

/** 卡片按钮回调：审批/拒绝后更新卡片并唤醒模型。 */
async function handleCardAction(raw: Record<string, unknown>): Promise<void> {
	const e = raw as unknown as CardActionEvent;
	if (e.action_tag !== "button" || e.action_value === undefined || e.operator_id === undefined) return;
	if (!ALLOW.includes(e.operator_id)) return; // 只有白名单用户能审
	let v: { action?: string; minutes?: number; conversationId?: number };
	try {
		v = JSON.parse(e.action_value) as typeof v;
	} catch {
		return;
	}
	if (v.action !== "approve" && v.action !== "deny") return;
	const conversationId = v.conversationId;
	if (conversationId === undefined) return;
	const context = BACKGROUND_CONTEXT;
	const conversation = await harness.conversation(conversationId as ConversationId, context);
	if (conversation === undefined) return;

	if (e.token !== undefined && e.operator_id !== undefined && e.chat_id !== undefined) {
		const minutes = v.minutes ?? 10;
		void updateCard({
			token: e.token,
			openId: e.operator_id,
			header: v.action === "approve" ? `✅ 已批准（${minutes} 分钟）` : "❌ 已拒绝",
			template: v.action === "approve" ? "green" : "red",
			lines: v.action === "approve" ? ["窗口内危险命令免拦截，agent 将继续执行。"] : ["agent 将收到拒绝通知并改用其他方案。"],
		}).catch(() => {});
	}

	if (v.action === "approve") {
		const minutes = v.minutes ?? 10;
		approvals.set(conversationId, Date.now() + minutes * 60_000);
		await submitAndReply(conversation, await conversation.submit({
			type: "input",
			content: `用户已批准危险命令窗口（${minutes} 分钟）。请继续之前的任务，重试被拦截的命令。`,
			whenBusy: "steer",
			requestId: `${e.event_id}-approve`,
		}, context), { chat_id: e.chat_id ?? "", message_id: e.event_id ?? "" });
	} else {
		approvals.delete(conversationId);
		await submitAndReply(conversation, await conversation.submit({
			type: "input",
			content: "用户拒绝了危险命令。请停止该操作并改用其他方案，或询问用户意图。",
			whenBusy: "steer",
			requestId: `${e.event_id}-deny`,
		}, context), { chat_id: e.chat_id ?? "", message_id: e.event_id ?? "" });
	}
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
async function shutdown(): Promise<void> {
	console.log("[dwell] 关闭中…");
	await harness.close(BACKGROUND_CONTEXT);
	process.exit(0);
}

void main();
