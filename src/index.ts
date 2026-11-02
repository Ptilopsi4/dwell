// dwell 主程序：harness + 飞书事件循环 + 消息管线（白名单 → 命令 → submit → 回复）。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { openDwell } from "./harness.ts";
import { Sessions } from "./sessions.ts";
import { startEventLoop, type LarkMessage } from "./feishu/consumer.ts";
import { sendText, splitMessage } from "./feishu/reply.ts";
import { approvals, setApprovalCallback } from "./ext/approval.ts";

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
	startEventLoop(handleMessage);
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
async function submitAndReply(conversation: Conversation, submission: Awaited<ReturnType<Conversation["submit"]>>, m: LarkMessage): Promise<void> {
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

async function replyTo(m: LarkMessage, text: string): Promise<void> {
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

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
async function shutdown(): Promise<void> {
	console.log("[dwell] 关闭中…");
	await harness.close(BACKGROUND_CONTEXT);
	process.exit(0);
}

void main();
