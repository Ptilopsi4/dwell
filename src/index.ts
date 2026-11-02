// dwell 主程序：harness + 飞书 Channel + 多用户会话路由 + 权限矩阵 + 消息管线。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, type Conversation, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { openDwell } from "./harness.ts";
import { Sessions } from "./sessions.ts";
import { Users } from "./users.ts";
import { connectChannel, type CardActionEvent, type LarkChannel, type NormalizedMessage } from "./feishu/channel.ts";
import { approvals, pendingApprovals, runSender, setApprovalCallback, windowKey } from "./ext/approval.ts";

type ReplyTarget = { chatId: string; messageId: string };

let harness: Harness;
let sessions: Sessions;
let channel: LarkChannel;
const users = new Users();

async function main(): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	harness = await openDwell();
	sessions = new Sessions(harness);
	await sessions.load();
	await users.load();
	if (!users.isAllowed("__none__") && [...new Set([process.env.DWELL_ALLOW, process.env.DWELL_ADMINS])].every((s) => !s?.trim())) {
		if (!users.isAllowed("")) console.error("[dwell] 白名单为空，dwell 将拒绝所有消息（用 /allow 添加或配置 DWELL_ALLOW/DWELL_ADMINS）");
	}

	setApprovalCallback((conversationId, sender, command, match) => {
		const chatId = sessions.chatOf?.(conversationId);
		if (chatId === undefined) return;
		void sendApprovalCard(chatId, conversationId, sender, command, match);
	});

	channel = await connectChannel({
		onMessage: (msg) => void handleMessage(msg),
		onCardAction: (evt) => void handleCardAction(evt),
	});
	console.log(`[dwell] 就绪（bot: ${channel.botIdentity?.name ?? "?"}）`);
}

/** 会话路由：私聊 chat 级 / 群平消息 per-sender / 话题 per-thread / replyTo 跟随。 */
async function route(msg: NormalizedMessage): Promise<{ conversation: Conversation; degraded: boolean } | null> {
	// replyTo 跟随（优先级最高，群聊/私聊通用）
	if (msg.replyToMessageId !== undefined) {
		const target = sessions.follow(msg.replyToMessageId);
		if (target !== undefined) {
			const conversation = await sessions.byConversation(target);
			if (conversation !== undefined) return { conversation, degraded: false };
		}
		// 未命中（未记录或已被上限淘汰）——降级到自己的线，由调用方显式提示
	}
	if (msg.chatType === "p2p") {
		return { conversation: await sessions.forDirect(msg.chatId, msg.senderId), degraded: msg.replyToMessageId !== undefined };
	}
	if (msg.threadId !== undefined) {
		return { conversation: await sessions.forThread(msg.chatId, msg.threadId, msg.senderId), degraded: false };
	}
	return { conversation: await sessions.forGroup(msg.chatId, msg.senderId), degraded: msg.replyToMessageId !== undefined };
}

async function handleMessage(msg: NormalizedMessage): Promise<void> {
	try {
		if (msg.rawContentType !== "text" || msg.content.trim() === "") return;
		if (!users.isAllowed(msg.senderId)) {
			await channel.send(msg.chatId, { text: "未授权使用，请联系管理员开通。" }, { replyTo: msg.messageId });
			return;
		}

		const routed = await route(msg);
		if (routed === null) return;
		const { conversation, degraded } = routed;
		await sessions.anchor(msg.messageId, conversation.id);

		const target: ReplyTarget = { chatId: msg.chatId, messageId: msg.messageId };
		if (degraded) {
			await replyTo(target, "（原任务线已归档，已开启新任务线）");
		}

		// run 归属：审批与 /cancel 按触发者判定
		runSender.set(conversation.id as number, msg.senderId);

		const text = msg.content.trim();
		if (text.startsWith("/")) {
			await runCommand(text, conversation, msg, target);
			return;
		}

		const context = BACKGROUND_CONTEXT;
		const submission = await conversation.submit(
			{
				type: "input",
				content: text,
				// transcript 记录 sender（审计/分账基础；model 仍只看 content）
				entry: { kind: "chat.message", data: { sender: msg.senderId, senderName: msg.senderName ?? "", chatType: msg.chatType } },
				requestId: msg.messageId,
				whenBusy: "steer",
			},
			context,
		);
		void submitAndReply(conversation, submission, target);
	} catch (err) {
		console.error("[dwell] 消息处理出错:", err);
	}
}

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

/** 命令权限矩阵：/new owner|admin；/cancel 自己|admin；/allow /deny admin（/deny 自己的窗口也可）。 */
async function runCommand(text: string, conversation: Conversation, msg: NormalizedMessage, target: ReplyTarget): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const parts = text.split(/\s+/);
	const cmd = parts[0];
	const convId = conversation.id as number;
	const owner = sessions.ownerOf(conversation.id) ?? "";
	const admin = users.isAdmin(msg.senderId);
	const isOwner = msg.senderId === owner;

	switch (cmd) {
		case "/new":
			if (!isOwner && !admin) {
				await replyTo(target, `这是 ${owner === msg.senderId ? "你" : "其他人"}的任务线，仅线主或管理员可重置。`);
				return;
			}
			await conversation.reset(undefined, context);
			await replyTo(target, "已开启新对话。");
			break;
		case "/status": {
			const graph = await harness.taskGraph?.(context);
			await replyTo(target, graph ? `运行中任务：\n${JSON.stringify(graph, null, 1).slice(0, 1500)}` : "当前无任务运行。");
			break;
		}
		case "/cancel":
			if (!admin) {
				await replyTo(target, "群聊中 /cancel 仅管理员可用（会中止当前任务线）。");
				return;
			}
			await conversation.abort(context);
			await replyTo(target, "已中止当前任务。");
			break;
		case "/approve": {
			const minutes = Number(parts[1]) || 10;
			approvals.set(windowKey(convId, msg.senderId), Date.now() + minutes * 60_000);
			await replyTo(target, `已批准：你的任务线 ${minutes} 分钟内危险命令免拦截。`);
			const s = await conversation.submit({
				type: "input",
				content: `用户已批准危险命令窗口（${minutes} 分钟）。请继续之前的任务，重试被拦截的命令。`,
				whenBusy: "steer",
				requestId: `${msg.messageId}-approve`,
			}, context);
			void submitAndReply(conversation, s, target);
			break;
		}
		case "/deny":
			if (!admin) {
				approvals.delete(windowKey(convId, msg.senderId));
				await replyTo(target, "已关闭你的批准窗口。");
				return;
			}
			approvals.delete(windowKey(convId, msg.senderId));
			await replyTo(target, "已关闭批准窗口。");
			break;
		case "/allow": {
			if (!admin) {
				await replyTo(target, "/allow 仅管理员可用。");
				return;
			}
			const openId = parts[1];
			if (openId === undefined || !openId.startsWith("ou_")) {
				await replyTo(target, "用法：/allow <open_id> [admin]");
				return;
			}
			await users.add(openId, parts[2] === "admin" ? "admin" : "member");
			await replyTo(target, `已添加 ${openId} 为 ${parts[2] === "admin" ? "管理员" : "成员"}（立即生效，已持久化）。`);
			break;
		}
		case "/disallow": {
			if (!admin) {
				await replyTo(target, "/disallow 仅管理员可用。");
				return;
			}
			if (parts[1] === undefined) {
				await replyTo(target, "用法：/disallow <open_id>");
				return;
			}
			await users.remove(parts[1]);
			await replyTo(target, `已移除 ${parts[1]}。`);
			break;
		}
		default:
			await replyTo(target, `未知命令 ${cmd}。可用：/new /status /cancel /approve [分钟] /deny /allow <id> [admin] /disallow <id>`);
	}
}

/** 审批卡片（Card V2 + behaviors.callback）。 */
function approvalCard(
	conversationId: number,
	sender: string,
	command: string,
	match: string,
	state: { kind: "request" } | { kind: "approved"; minutes: number } | { kind: "denied" },
): Record<string, unknown> {
	const value = (action: string, minutes = 0) => ({ action, minutes, conversationId, sender });
	const done = state.kind !== "request";
	const header = state.kind === "denied"
		? { title: { tag: "plain_text", content: "已拒绝" }, template: "red" }
		: state.kind === "approved"
			? { title: { tag: "plain_text", content: `已批准 · ${state.minutes} 分钟` }, template: "green" }
			: { title: { tag: "plain_text", content: "需要你的批准" }, template: "grey" };
	const chosen = state.kind === "approved" ? state.minutes : 0;
	const buttons = [
		{ text: chosen === 10 || state.kind === "denied" ? "已批准 10 分钟" : "批准 10 分钟", type: "primary", v: value("approve", 10) },
		{ text: chosen === 30 || state.kind === "denied" ? "已批准 30 分钟" : "批准 30 分钟", type: "primary", v: value("approve", 30) },
		{ text: state.kind === "denied" ? "已拒绝" : "拒绝", type: "danger", v: value("deny") },
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
					behaviors: [{ type: "callback", value: b.v }],
				}],
			})) },
		] },
	};
}

async function sendApprovalCard(chatId: string, conversationId: number, sender: string, command: string, match: string): Promise<void> {
	try {
		await channel.send(chatId, { card: approvalCard(conversationId, sender, command, match, { kind: "request" }) });
	} catch (err) {
		console.error("[dwell] 审批卡片发送失败:", err);
	}
}

/** 卡片按钮回调：触发者/conversation owner/admin 可审，其余忽略。 */
async function handleCardAction(evt: CardActionEvent): Promise<void> {
	const v = evt.action.value as { action?: string; minutes?: number; conversationId?: number; sender?: string } | undefined;
	if (v?.action !== "approve" && v?.action !== "deny") return;
	if (!users.isAllowed(evt.operator.openId)) return;
	const conversationId = v.conversationId;
	if (conversationId === undefined || v.sender === undefined) return;
	const context = BACKGROUND_CONTEXT;
	const conversation = await harness.conversation(conversationId as ConversationId, context);
	if (conversation === undefined) return;

	// 归属校验：触发者 ∪ owner ∪ admin
	const owner = sessions.ownerOf(conversation.id) ?? "";
	if (evt.operator.openId !== v.sender && evt.operator.openId !== owner && !users.isAdmin(evt.operator.openId)) {
		console.log(`[dwell] 卡片审批被忽略：operator 非触发者/owner/admin`);
		return;
	}

	const key = windowKey(conversationId, v.sender);
	const pending = pendingApprovals.get(key);
	const minutes = v.minutes ?? 10;
	const state = v.action === "approve" ? { kind: "approved" as const, minutes } : { kind: "denied" as const };
	if (pending !== undefined) {
		await channel.updateCard(evt.messageId, approvalCard(conversationId, v.sender, pending.command, pending.match, state)).catch(() => {});
	}

	if (v.action === "approve") {
		approvals.set(key, Date.now() + minutes * 60_000);
		const s = await conversation.submit({
			type: "input",
			content: `用户已批准危险命令窗口（${minutes} 分钟）。请继续之前的任务，重试被拦截的命令。`,
			whenBusy: "steer",
			requestId: `card-${evt.messageId}-approve`,
		}, context);
		void submitAndReply(conversation, s, { chatId: evt.chatId, messageId: evt.messageId });
	} else {
		approvals.delete(key);
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
