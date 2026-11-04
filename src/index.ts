// dwell 主程序：harness + 飞书 Channel + 多用户会话路由 + 权限矩阵 + 消息管线。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, type Conversation, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { MODEL, makeImageDescriber, openDwell, scrubSecretEnv, type ImageDescriber } from "./harness.ts";
import { describeResources } from "./media.ts";
import { initStateDir } from "./state.ts";
import { Sessions } from "./sessions.ts";
import { Users } from "./users.ts";
import { connectChannel, downloadMessageResource, matchMention, type CardActionEvent, type LarkChannel, type MarkdownStreamController, type NormalizedMessage } from "./feishu/channel.ts";
import { Directory } from "./feishu/directory.ts";
import { startPanel, type FeishuBridge } from "./web/server.ts";
import { approvals, pendingApprovals, runSender, runVia, setApprovalCallback, windowKey } from "./ext/approval.ts";
import { makeLarkExtension } from "./ext/lark.ts";

type ReplyTarget = { chatId: string; messageId: string };

let harness: Harness;
let sessions: Sessions;
let channel: LarkChannel;
const users = new Users();
const directory = new Directory(process.env.LARK_APP_ID, process.env.LARK_APP_SECRET);
/** panel 操作者（pt）：panel 发起的输入/审批/控制都记在这个 open_id 名下 */
let panelUser = "";
/** 图片理解 subagent（启动时装配；无 ZAI key 时为 null，图片降级为落盘+提示） */
const imageDescriber: ImageDescriber | null = makeImageDescriber();

async function main(): Promise<void> {
	await initStateDir();
	harness = await openDwell(undefined, [
		// lark 依赖运行时对象（channel/sessions/directory 后于 harness 初始化），getter 延迟绑定
		makeLarkExtension({
			getClient: () => channel?.rawClient,
			getDirectory: () => directory,
			chatOf: (id) => sessions.chatOf(id),
		}),
	]);
	sessions = new Sessions(harness);
	await sessions.load();
	const realigned = await sessions.alignModel();
	console.log(`[dwell] 模型 ${MODEL.provider}/${MODEL.modelId}${realigned > 0 ? `（${realigned} 个会话已切换到该模型）` : ""}`);
	await users.load();
	if (users.list().length === 0) {
		console.error("[dwell] 白名单为空，dwell 将拒绝所有消息（用 /allow 添加或配置 DWELL_ALLOW/DWELL_ADMINS）");
	}

	setApprovalCallback((conversationId, sender, command, match) => {
		const pending = pendingApprovals.get(windowKey(conversationId, sender));
		// panel 发起的 run：审批卡私发给操作者（不发到发起群），回复通知即可续接任务
		if (pending?.via === "panel") {
			void (async () => {
				try {
					const sent = await channel.send(panelUser, { card: approvalCard(conversationId, sender, command, match, { kind: "request" }) });
					pending.cardMessageId = sent.messageId;
					await sessions.anchor(sent.messageId, conversationId as ConversationId);
				} catch (err) {
					console.error("[dwell] panel 审批卡片私发失败:", err);
				}
			})();
			return;
		}
		const chatId = sessions.chatOf?.(conversationId);
		if (chatId === undefined) return;
		void sendApprovalCard(chatId, conversationId, sender, command, match);
	});

	panelUser = process.env.DWELL_PANEL_USER || users.list().find((u) => u.role === "admin")?.id || "panel";

	// Web panel（无内置鉴权，部署侧自行保证网络边界）；DWELL_PANEL_ONLY=1 时不连飞书，仅 panel（本地开发/review）
	const panelPort = Number(process.env.DWELL_PANEL_PORT ?? 0);
	if (panelPort > 0) {
		startPanel({ harness, sessions, users, directory, feishu: feishuBridge, port: panelPort });
		if (process.env.DWELL_PANEL_ONLY === "1") {
			console.log("[dwell] panel-only 模式（未连接飞书）");
			return;
		}
	}

	channel = await connectChannel({
		onMessage: (msg) => void handleMessage(msg),
		onCardAction: (evt) => void handleCardAction(evt),
	});
	// 凭证均已注入内存（credential store / SDK Client），从进程环境移除，堵死 bash 工具的 printenv 窃取面
	scrubSecretEnv();
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
		// 群聊准入（SDK policy 已放开 mention 门，由这里细化）：话题内消息与回复已锚定消息视为显式指向，平消息仍需 @bot
		if (msg.chatType === "group" && !msg.mentionedBot) {
			const inThread = msg.threadId !== undefined;
			const repliesAnchored = msg.replyToMessageId !== undefined && sessions.follow(msg.replyToMessageId) !== undefined;
			if (!inThread && !repliesAnchored) return;
		}
		if (!users.isAllowed(msg.senderId)) {
			await channel.send(msg.chatId, { text: "未授权使用，请联系管理员开通。" }, { replyTo: msg.messageId });
			return;
		}
		const text = msg.content.trim();
		if ((msg.resources?.length ?? 0) === 0 && text === "") {
			if (msg.rawContentType !== "text") {
				await channel.send(msg.chatId, { text: "目前支持文本、图片和文件消息。" }, { replyTo: msg.messageId });
			}
			return;
		}

		const routed = await route(msg);
		if (routed === null) return;
		const { conversation, degraded } = routed;
		sessions.touchActivity(conversation.id);
		// 归档只是 panel 的整理动作；飞书侧有新消息说明这条线又活了
		if (sessions.isArchived(conversation.id)) await sessions.setArchived(conversation.id, false);
		await sessions.anchor(msg.messageId, conversation.id);

		const target: ReplyTarget = { chatId: msg.chatId, messageId: msg.messageId };
		if (degraded) {
			await replyTo(target, "原任务线的记录已过期，这条在新的任务线上开始。", conversation);
		}

		// run 归属：审批与 /cancel 按触发者判定
		// panel 会话（无对应 chat）经飞书续接时保持 panel 入口语义：审批仍私发管理员，不发到发起群
		runSender.set(conversation.id as number, msg.senderId);
		runVia.set(conversation.id as number, sessions.chatOf(conversation.id as number) === undefined ? "panel" : "feishu");

		const content = msg.content.trim();
		if (content.startsWith("/")) {
			await runCommand(content, conversation, msg, target);
			return;
		}
		// 多模态：媒体消息走独立流式流程（先占位再接主模型流，避免预处理 10s 黑盒）
		if ((msg.resources?.length ?? 0) > 0) {
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			void mediaStreamAndReply(conversation, msg, agent.cwd ?? process.cwd(), target);
			return;
		}

		const submission = await submitInput(conversation, content, msg);
		// queued = 插话并入活跃 run（或紧随排队）：旧卡的 watcher 会把新轮文本 append 进原卡，
		// 再开新卡会出现两张内容相同的卡（实测），故 queued 不开卡
		const record = await submission.status(BACKGROUND_CONTEXT);
		if (record.status !== "queued") void submitAndReply(conversation, submission, target);
	} catch (err) {
		console.error("[dwell] 消息处理出错:", err);
	}
}

/** 统一的输入提交（媒体/文本两条路径共用：transcript 记 sender，requestId 幂等，steer）。 */
function submitInput(conversation: Conversation, content: string, msg: NormalizedMessage) {
	return conversation.submit(
		{
			type: "input",
			content,
			// transcript 记录 sender（审计/分账基础；model 仍只看 content）
			entry: { kind: "chat.message", data: { sender: msg.senderId, senderName: msg.senderName ?? "", chatType: msg.chatType } },
			requestId: msg.messageId,
			whenBusy: "steer",
		},
		BACKGROUND_CONTEXT,
	);
}

/** 流式回复：watch pi.live 的节流 partial，前缀检测 append 增量（轮切换/重试自动重置游标），settled 后补齐最终答案。 */
async function submitAndReply(
	conversation: Conversation,
	submission: Awaited<ReturnType<Conversation["submit"]>>,
	target: ReplyTarget,
): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	try {
		// 回答卡登记锚点：回复这张卡即续接该任务线（群聊免 @），否则 route 必 miss
		const sent = await channel.stream(target.chatId, { markdown: (s) => streamReplyCore(conversation, submission, s, context) }, { replyTo: target.messageId });
		await sessions.anchor(sent.messageId, conversation.id);
	} catch (err) {
		// 流式通道失败时退回普通回复
		console.error("[dwell] 流式回复失败，退回普通回复:", err);
		try {
			await submitAndReplyPlain(conversation, submission, target);
		} catch (err2) {
			console.error("[dwell] 回复彻底失败:", err2);
		}
	}
}

/** 媒体消息流式流程：同一张卡内先占位（图片分析/文件接收），预处理完成后清占位接主模型流。 */
async function mediaStreamAndReply(conversation: Conversation, msg: NormalizedMessage, cwd: string, target: ReplyTarget): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	let submission: Awaited<ReturnType<Conversation["submit"]>> | undefined;
	try {
		const sent = await channel.stream(
			target.chatId,
			{
				markdown: async (s) => {
					const resources = msg.resources ?? [];
					const images = resources.filter((r) => r.type === "image" || r.type === "sticker").length;
					const files = resources.filter((r) => r.type === "file").length;
					const bits = [images > 0 ? `📷 ${images} 张图片` : "", files > 0 ? `📎 ${files} 个文件` : ""].filter(Boolean).join(" + ");
					await s.setContent(`${bits}，正在处理…`);
					const attachment = await describeResources(msg, cwd, {
						download: (fileKey, type) => downloadMessageResource(channel, msg.messageId, fileKey, type),
						describer: imageDescriber,
					});
					const text = msg.content.trim();
					submission = await submitInput(conversation, text === "" ? attachment : `${text}\n\n${attachment}`, msg);
					const record = await submission.status(context);
					if (record.status === "queued") {
						// 插话并入活跃 run：答案会在原任务的卡上继续，这张占位卡给终态即可
						await s.setContent("✅ 已并入正在进行的回答（见上方卡片）");
						return;
					}
					await s.setContent(""); // 清占位，主模型流从空白起
					await streamReplyCore(conversation, submission, s, context);
				},
			},
			{ replyTo: target.messageId },
		);
		await sessions.anchor(sent.messageId, conversation.id);
	} catch (err) {
		console.error("[dwell] 媒体流式回复失败:", err);
		try {
			if (submission !== undefined) {
					await submitAndReplyPlain(conversation, submission, target);
			} else {
					await replyTo(target, "图片/文件处理失败，请重试。", conversation);
			}
		} catch (err2) {
			console.error("[dwell] 回复彻底失败:", err2);
		}
	}
}

/** 主模型流式回复主体：watch pi.live 增量 append，settled 后补齐最终答案。占位阶段的 setContent 由调用方负责。 */
async function streamReplyCore(
	conversation: Conversation,
	submission: Awaited<ReturnType<Conversation["submit"]>>,
	s: MarkdownStreamController,
	context: typeof BACKGROUND_CONTEXT,
): Promise<void> {
	try {
		{
			const watch = await conversation.watch(context);
				let cursor = "";
				// 工具概述：callId → 摘要（从 transcript 的 assistant toolCall 取参数），done 后报告一次
				const callSummary = new Map<string, string>();
				const reported = new Set<string>();
				let scanned = 0;
				const summarize = (name: string, args: Record<string, unknown>): string => {
					const arg = args.command ?? args.path ?? JSON.stringify(args);
					return `> 🔧 ${name} · ${String(arg).replace(/\s+/g, " ").slice(0, 80)}`;
				};
				try {
					const settledP = submission.wait(context);
					void settledP.then(() => {}, () => {});
					const handleFrame = async (value: unknown): Promise<void> => {
						// 增量扫描 transcript：登记 toolCall 参数
						const entries = (value as unknown as { entries?: { kind?: string; model?: { content?: { type: string; id?: string; name?: string; arguments?: Record<string, unknown> }[] }[] }[] }).entries ?? [];
						for (let i = scanned; i < entries.length; i++) {
							const e = entries[i];
							if (e.kind !== "pi.assistant") continue;
							for (const c of e.model?.[0]?.content ?? []) {
								if (c.type === "toolCall" && c.id !== undefined && c.name !== undefined) {
									callSummary.set(c.id, summarize(c.name, c.arguments ?? {}));
							}
							}
						}
						scanned = entries.length;
						// 工具完成：报告概述行
						const live = (value as unknown as { docs?: Record<string, { generation?: { message?: { content?: { type: string; text?: string }[] } }; tools?: { callId: string; status: string }[] } | undefined> }).docs?.["pi.live"];
						for (const slot of live?.tools ?? []) {
							if (slot.status === "done" && !reported.has(slot.callId) && callSummary.has(slot.callId)) {
								reported.add(slot.callId);
								// 尾部空行不可省：markdown 引用块（>）会把紧邻的下一行吸入——正文首句会被包进工具概述
							await s.append(`\n${callSummary.get(slot.callId) ?? ""}\n\n`);
						}
						}
						// 模型文本流
						const parts = live?.generation?.message?.content ?? [];
						const text = parts.flatMap((c) => (c.type === "text" && c.text !== undefined ? [c.text] : [])).join("");
						if (text.length === 0) return;
						if (text.startsWith(cursor) && text.length > cursor.length) {
							await s.append(text.slice(cursor.length));
							cursor = text;
						} else if (!text.startsWith(cursor)) {
							// 新轮或重试：响应从头开始，重置游标并加分隔
							cursor = text;
							await s.append(`\n\n${text}`);
						}
					};
					// 占位卡发送期间 run 可能已推进：先处理初始快照，再监听后续帧
					await handleFrame(watch.value);
					watch.start((value) => handleFrame(value));
					// settled 后补齐最终答案（partial 节流可能落后）
					const settled = await settledP;
					let final = "";
					if (settled.status === "done" && settled.type === "input") {
						const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
						const answer = entry?.model?.[0] as AssistantMessage | undefined;
						final = (answer?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
					} else {
						final = `处理失败：${settled.status === "unanswered" ? settled.reason : settled.status}`;
					}
					if (final.startsWith(cursor) && final.length > cursor.length) {
						await s.append(final.slice(cursor.length));
					} else if (!final.startsWith(cursor) && final.length > 0) {
						// cursor 是作废 partial（重试/换轮）：分隔后追加完整最终答案，不丢尾
						await s.append(`\n\n${final}`);
					} else if (final.length === 0 && cursor.length === 0) {
						// 无任何文本产出（模型连续出错/被中止）：给群里一个明确终态，不留悬空卡
						await s.append("（本次运行没有产出文本：模型出错或被中止，可重发）");
					}
			} finally {
				await watch.stop();
			}
		}
	} catch (err) {
		// 流式帧处理失败：卡片已创建，最多丢部分流式效果
		console.error("[dwell] 流式帧处理失败:", err);
	}
}

/** 非流式回复（流式通道失败时的兜底）。 */
async function submitAndReplyPlain(
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
		await replyTo(target, reply || "（空回复）", conversation);
	} else {
		const reason = settled.status === "unanswered" ? settled.reason : settled.status;
		await replyTo(target, `处理失败：${reason}`, conversation);
	}
}

async function replyTo(target: ReplyTarget, text: string, conversation?: Conversation): Promise<void> {
	const sent = await channel.send(target.chatId, { markdown: text }, { replyTo: target.messageId });
	if (conversation !== undefined) await sessions.anchor(sent.messageId, conversation.id);
}

/** 命令参数解析：@提及 → openId+姓名（SDK 已把占位符渲染成名字，见 matchMention）；否则原样返回。 */
function resolveArg(parts: string[], msg: NormalizedMessage): { id: string; name: string } | null {
	const arg = parts[1];
	if (arg === undefined) return null;
	return matchMention(arg, msg.mentions) ?? { id: arg, name: arg };
}

/** 命令权限矩阵：/new owner|admin；/cancel admin；/allow /deny admin。 */
async function runCommand(text: string, conversation: Conversation, msg: NormalizedMessage, target: ReplyTarget): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const parts = text.split(/\s+/);
	const cmd = parts[0];
	const convId = conversation.id as number;
	const owner = sessions.ownerOf(conversation.id) ?? "";
	const admin = users.isAdmin(msg.senderId);
	const isOwner = msg.senderId === owner;

	switch (cmd) {
		case "/help": {
			const sent = await channel.send(target.chatId, { card: helpCard() }, { replyTo: target.messageId });
			await sessions.anchor(sent.messageId, conversation.id);
			break;
		}
		case "/whoami":
			await replyTo(target, `你的 ID：${msg.senderId}${users.isAdmin(msg.senderId) ? "（管理员）" : ""}`);
			break;
		case "/new":
			if (!isOwner && !admin) {
				await replyTo(target, "这是他人的任务线，仅线主或管理员可重置。");
				return;
			}
			await conversation.reset(undefined, context);
			// 新上下文里落一条展示型分隔回（模型不可见），panel 侧可见「已清空」而非无声空白
			await conversation.submit({ type: "write", entry: { kind: "context.reset", data: { by: "feishu" } } }, context);
			await replyTo(target, "已开启新对话。");
			break;
		case "/status": {
			if (!admin) {
				await replyTo(target, "/status 仅管理员可用。");
				return;
			}
			const graphState = await harness.taskGraph?.(context);
			let tasks: StatusTask[] = [];
			try {
					tasks = Object.values((graphState?.value as { tasks?: Record<string, StatusTask> } | undefined)?.tasks ?? {});
				} finally {
					graphState?.dispose();
			}
			if (tasks.length === 0) {
				await replyTo(target, "当前无任务运行。");
				break;
			}
			const typeZh: Record<string, string> = { direct: "私聊线", group: "群聊线", thread: "话题线", panel: "panel 线" };
			const lines = await Promise.all(tasks.map(async (t) => {
				const conv = sessions.listConversations().find((c) => c.id === (t.conversationId as number));
				const convLabel = sessions.nameOf(t.conversationId as number)
					?? `${conv !== undefined ? typeZh[conv.type] ?? "会话" : "会话"} #${t.conversationId}`;
				const owner = sessions.ownerOf(t.conversationId);
				const ownerName = owner !== undefined && owner !== "panel" ? await directory.userName(owner) : undefined;
				return `**${statusZh(t)}** \`${t.kind}\` · ${convLabel}${ownerName !== undefined ? ` · ${ownerName}` : ""}${t.abortRequested ? " · ⏹ 已请求中止" : ""}${t.blocked !== undefined ? ` · 阻塞：${t.blocked}` : ""}${t.background ? " · 后台" : ""}`;
			}));
			const sent = await channel.send(target.chatId, { card: statusCard(lines) }, { replyTo: target.messageId });
			await sessions.anchor(sent.messageId, conversation.id);
			break;
		}
		case "/cancel":
			if (!isOwner && !admin) {
				await replyTo(target, "仅线主或管理员可中止当前任务。");
				return;
			}
			await conversation.abort(context);
			await replyTo(target, "已中止当前任务。");
			break;
		case "/approve": {
			const minutes = Number(parts[1]) || 10;
			approvals.set(windowKey(convId, msg.senderId), Date.now() + minutes * 60_000);
			const pending = pendingApprovals.get(windowKey(convId, msg.senderId));
			if (pending !== undefined) {
				// 事后批准：存在被拦截的待审命令，唤醒模型重试
				pendingApprovals.delete(windowKey(convId, msg.senderId));
				await replyTo(target, `已批准：本任务线 ${minutes} 分钟内危险命令免拦截，继续执行。`);
				const s = await conversation.submit({
					type: "input",
					content: `用户已批准危险命令窗口（${minutes} 分钟）。请继续之前的任务，重试被拦截的命令。`,
					whenBusy: "steer",
					requestId: `${msg.messageId}-approve`,
				}, context);
				void submitAndReply(conversation, s, target);
			} else {
				// 预授：没有待审命令，只开窗口，不唤醒模型
				await replyTo(target, `已预先批准：本任务线 ${minutes} 分钟内危险命令免拦截。`);
			}
			break;
		}
		case "/deny":
			if (admin) {
				// 管理员：关闭该任务线全部窗口与待审请求（救场）
				const prefix = `${convId}:`;
				for (const k of approvals.keys()) if (k.startsWith(prefix)) approvals.delete(k);
				for (const k of pendingApprovals.keys()) if (k.startsWith(prefix)) pendingApprovals.delete(k);
				await replyTo(target, "已关闭本任务线的全部批准窗口。");
				return;
			}
			approvals.delete(windowKey(convId, msg.senderId));
			pendingApprovals.delete(windowKey(convId, msg.senderId));
			await replyTo(target, "已关闭你的批准窗口并取消待审请求。");
			break;
		case "/allow": {
			if (!admin) {
				await replyTo(target, "/allow 仅管理员可用。");
				return;
			}
			const who = resolveArg(parts, msg);
			if (who === null || !who.id.startsWith("ou_")) {
				await replyTo(target, "用法：/allow @某人 [admin]");
				return;
			}
			await users.add(who.id, parts[2] === "admin" ? "admin" : "member");
			await replyTo(target, `已添加 ${who.name} 为${parts[2] === "admin" ? "管理员" : "成员"}（立即生效）。`);
			break;
		}
		case "/disallow": {
			if (!admin) {
				await replyTo(target, "/disallow 仅管理员可用。");
				return;
			}
			const who = resolveArg(parts, msg);
			if (who === null) {
				await replyTo(target, "用法：/disallow @某人");
				return;
			}
			if (who.id === msg.senderId && users.adminCount() <= 1) {
				await replyTo(target, "无法移除最后一名管理员（会自锁）。");
				return;
			}
			await users.remove(who.id);
			await replyTo(target, `已移除 ${who.name}。`);
			break;
		}
		default:
			await replyTo(target, `未知命令 ${cmd}，回复 /help 查看可用命令。`);
	}
}

/** taskGraph 节点中 /status 用到的字段（结构性类型，避免依赖内部导出）。 */
type StatusTask = {
	kind: string;
	conversationId: ConversationId;
	background: boolean;
	abortRequested: boolean;
	state: { status: string; phase?: string; until?: number; on?: readonly unknown[]; outcome?: string };
	blocked?: string;
};

/** 任务状态 → 中文摘要。 */
function statusZh(t: StatusTask): string {
	switch (t.state.status) {
		case "pending": return "排队中";
		case "running": return `运行中 · ${t.state.phase ?? ""}`;
		case "waiting": return `等待依赖 ×${t.state.on?.length ?? 0}`;
		case "sleeping": return `休眠至 ${new Date(t.state.until ?? 0).toLocaleTimeString("zh-CN", { hour12: false })}`;
		case "completing": return `收尾 · ${t.state.outcome ?? ""}`;
		default: return t.state.status;
	}
}

/** /status 卡片：每个运行中任务一行（状态 · 类型 · 任务线 · 触发人）。 */
function statusCard(lines: string[]): Record<string, unknown> {
	return {
		schema: "2.0",
		config: { width_mode: "fill" },
		header: { title: { tag: "plain_text", content: `运行中任务 ×${lines.length}` }, template: "turquoise" },
		body: { elements: [{ tag: "markdown", content: lines.join("\n") }] },
	};
}

/** /help 说明卡片：命令 + 对话规则，一次讲清。 */
function helpCard(): Record<string, unknown> {
	const cmd = (name: string, desc: string) => `\`${name}\` ${desc}`;
	return {
		schema: "2.0",
		config: { width_mode: "fill" },
		header: { title: { tag: "plain_text", content: "dwell 使用说明" }, template: "blue" },
		body: { elements: [
			{ tag: "markdown", content: [
				cmd("/new", "开启新对话（清空本任务线上下文）"),
				cmd("/status", "查看运行中任务（管理员）"),
				cmd("/cancel", "中止当前任务（线主/管理员）"),
				cmd("/approve [分钟]", "批准危险命令窗口，默认 10 分钟"),
				cmd("/deny", "关闭批准窗口"),
				cmd("/allow @某人 [admin]", "添加成员/管理员（管理员）"),
				cmd("/disallow @某人", "移除用户（管理员）"),
				cmd("/whoami", "显示你的 ID"),
				cmd("/help", "显示本说明"),
			].join("\n") },
			{ tag: "markdown", content: "---" },
			{ tag: "markdown", content: "**对话规则**\n群里 @dwell 发消息（每人独立任务线，互不打扰）；回复某条消息可加入该任务线；话题群内直接发言即可。" },
		] },
	};
}

/** 审批卡片（Card V2 + behaviors.callback）。 */
function approvalCard(
	conversationId: number,
	sender: string,
	command: string,
	match: string,
	state: { kind: "request" } | { kind: "approved"; minutes: number; by?: string } | { kind: "denied"; by?: string },
): Record<string, unknown> {
	const value = (action: string, minutes = 0) => ({ action, minutes, conversationId, sender });
	const done = state.kind !== "request";
	const by = state.kind !== "request" && state.by ? ` · ${state.by}` : "";
	const header = state.kind === "denied"
		? { title: { tag: "plain_text", content: `已拒绝${by}` }, template: "red" }
		: state.kind === "approved"
			? { title: { tag: "plain_text", content: `已批准 · ${state.minutes} 分钟${by}` }, template: "green" }
			: { title: { tag: "plain_text", content: "需要你的批准" }, template: "grey" };
	const chosen = state.kind === "approved" ? state.minutes : 0;
	const buttons = [
		{ text: chosen === 10 ? "已批准 10 分钟" : "批准 10 分钟", type: "primary", v: value("approve", 10) },
		{ text: chosen === 30 ? "已批准 30 分钟" : "批准 30 分钟", type: "primary", v: value("approve", 30) },
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
		const sent = await channel.send(chatId, { card: approvalCard(conversationId, sender, command, match, { kind: "request" }) });
		// 记下卡片位置：panel 做出决定时同步卡片状态，并把续跑结果回复到卡片下
		const pending = pendingApprovals.get(windowKey(conversationId, sender));
		if (pending !== undefined) {
			pending.cardMessageId = sent.messageId;
			pending.cardChatId = chatId;
		}
		await sessions.anchor(sent.messageId, conversationId as ConversationId);
	} catch (err) {
		console.error("[dwell] 审批卡片发送失败:", err);
	}
}

const connected = (): boolean => (channel as LarkChannel | undefined) !== undefined;

/** 发到会话所在 chat；群聊线/话题线回复该线最近的消息，让群成员看出属于哪条任务（话题内发到话题里）。 */
async function sendToConversationChat(conversationId: number, markdown: string): Promise<{ chatId: string; messageId: string } | undefined> {
	const chatId = sessions.chatOf(conversationId);
	if (chatId === undefined || !connected()) return undefined;
	const kind = sessions.listConversations().find((c) => c.id === conversationId)?.type;
	const anchor = kind === "direct" ? undefined : sessions.lastAnchor(conversationId as ConversationId);
	const sent = await channel.send(chatId, { markdown }, anchor === undefined ? undefined : { replyTo: anchor, replyInThread: kind === "thread" });
	return { chatId, messageId: sent.messageId };
}

/** panel 操作在飞书侧与模型上下文中一律以「管理员」指代，不备注具体名字 */
const OPERATOR_LABEL = "管理员";

const feishuBridge: FeishuBridge = {
	operator: () => panelUser,
	async relay(conversation, text) {
		if (!connected()) throw new Error("飞书未连接，无法发到飞书");
		const id = conversation.id as number;
		// 飞书侧以「From admin:」前缀 + 整段斜体呈现，和成员自己的消息区分；逐段包斜体（markdown 强调不跨空行）
		const ital = (t: string) => t.split(/\n{2,}/).map((p) => (p.trim() !== "" ? `*${p}*` : p)).join("\n\n");
		const sent = await sendToConversationChat(id, ital(`From admin: ${text}`));
		if (sent === undefined) throw new Error("该会话没有对应的飞书 chat");
		await sessions.anchor(sent.messageId, conversation.id);
		sessions.touchActivity(conversation.id);
		// 飞书侧有新动静的线不再留在归档组
		if (sessions.isArchived(id)) await sessions.setArchived(id, false);
		runSender.set(id, panelUser);
		runVia.set(id, "feishu");
		const submission = await conversation.submit({
			type: "input",
			content: text,
			entry: { kind: "chat.message", data: { sender: panelUser, senderName: OPERATOR_LABEL, via: "panel" } },
			requestId: `panel-${sent.messageId}`,
			whenBusy: "steer",
		}, BACKGROUND_CONTEXT);
		void submitAndReply(conversation, submission, sent);
	},
	async notice(conversationId, text) {
		// 通知也锚定到任务线：回复通知即在原线上继续
		try {
			const sent = await sendToConversationChat(conversationId, text);
			if (sent !== undefined) await sessions.anchor(sent.messageId, conversationId as ConversationId);
		} catch (err: unknown) {
			console.error("[dwell] 飞书通知发送失败:", err);
		}
	},
	async notifyPanel(conversationId, status, text) {
		if (!connected()) return;
		const name = sessions.nameOf(conversationId) ?? `任务 #${conversationId}`;
		const link = process.env.DWELL_PANEL_URL ? `\n[打开 panel](${process.env.DWELL_PANEL_URL}?conv=${conversationId})` : "";
		try {
			// 私发给操作者；消息锚到任务线，回复这条通知即在该任务线上继续
			const sent = await channel.send(panelUser, { markdown: `**任务${status}** · ${name}\n\n${text.slice(0, 200)}${text.length > 200 ? "…" : ""}${link}` });
			await sessions.anchor(sent.messageId, conversationId as ConversationId);
		} catch (err) {
			console.error("[dwell] panel 任务通知发送失败:", err);
		}
	},
	async afterDecision(conversation, pending, action, minutes, submission) {
		if (pending.cardMessageId === undefined || pending.cardChatId === undefined || !connected()) {
			void submission.wait(BACKGROUND_CONTEXT).catch(() => {});
			return;
		}
		const id = conversation.id as number;
		const state = action === "approve" ? { kind: "approved" as const, minutes, by: "panel" } : { kind: "denied" as const, by: "panel" };
		await channel.updateCard(pending.cardMessageId, approvalCard(id, pending.trigger, pending.command, pending.match, state)).catch(() => {});
		void submitAndReply(conversation, submission, { chatId: pending.cardChatId, messageId: pending.cardMessageId });
	},
};

/** 卡片按钮回调：触发者/conversation owner/admin 可审，其余忽略。 */
async function handleCardAction(evt: CardActionEvent): Promise<void> {
	try {
		await handleCardActionInner(evt);
	} catch (err) {
		console.error("[dwell] 卡片回调处理出错:", err);
	}
}

async function handleCardActionInner(evt: CardActionEvent): Promise<void> {
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
	if (pending === undefined) return; // 历史卡/已处理：点击无效，防隔夜开窗
	const minutes = v.minutes ?? 10;
	const state = v.action === "approve" ? { kind: "approved" as const, minutes } : { kind: "denied" as const };
	if (pending !== undefined) {
		await channel.updateCard(evt.messageId, approvalCard(conversationId, v.sender, pending.command, pending.match, state)).catch(() => {});
	}

	if (v.action === "approve") {
		pendingApprovals.delete(key);
		approvals.set(key, Date.now() + minutes * 60_000);
		const s = await conversation.submit({
			type: "input",
			content: `用户已批准危险命令窗口（${minutes} 分钟）。请继续之前的任务，重试被拦截的命令。`,
			whenBusy: "steer",
			requestId: `card-${evt.messageId}-approve`,
		}, context);
		void submitAndReply(conversation, s, { chatId: evt.chatId, messageId: evt.messageId });
	} else {
		pendingApprovals.delete(key);
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
