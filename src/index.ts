// dwell 主程序：harness + 飞书 Channel + 多用户会话路由 + 权限矩阵 + 消息管线。
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { LiveDoc, type Conversation, type ConversationId, type Harness, type SubmissionId, type SubmissionRecord, type TaskId, type TaskGraph, type TaskGraphNode, type TaskGraphState } from "@earendil-works/pi-durable";
import { MODEL, applyGithubEnv, busyConversations, checkGithubToken, githubEnabled, makeImageDescriber, openDwell, runConversations, runtimeBudgets, runtimeTelemetry, sandboxState, scrubSecretEnv, setSandboxState, type ImageDescriber } from "./harness.ts";
import { Uploads } from "./uploads.ts";
import { readWorkspaceFile } from "./guarded-env.ts";
import { makeReporter } from "./report.ts";
import { describeResources, sniffImageMime } from "./media.ts";
import { probeSandbox, requireSandbox, resolveSpawnShell, sandboxMode } from "./sandbox.ts";
import { APP_ROOT, DATA_DIR, DEFAULT_CWD, STATE_DIR, initStateDir, stateFile } from "./state.ts";
import { Sessions } from "./sessions.ts";
import { Users } from "./users.ts";
import { beginNewGoal, NewGoalDoc } from "./new-goal.ts";
import { getWork, workBudgetStopReason } from "./ext/work.ts";
import { connectChannel, downloadMessageResource, matchMention, type CardActionEvent, type LarkChannel, type MarkdownStreamController, type SendInput } from "./feishu/channel.ts";
import { emptyReply, fallbackRoute, groupAdmits, messageAction, messageDestination, sameDestination, type ConversationDestination, type NormalizedMessage, type TelegramDestination } from "./pipeline.ts";
import { TelegramBot, TelegramError, telegramChatKey, type TelegramCallback } from "./telegram.ts";
import { TelegramChats, isTelegramGroupId } from "./telegram-chats.ts";
import { creatorVia } from "./ext/approval.ts";
import { createTelegramStreamPresenter } from "./telegram-stream.ts";
import { formatTelegramText } from "./telegram-format.ts";
import { TelegramInbox, TelegramInputWorkers, telegramApprovalData, telegramApprovalMatch, type TelegramCommandReceipt, type TelegramInputReceipt } from "./telegram-entry.ts";
import { Directory } from "./feishu/directory.ts";
import { mirrorRestoredSubmission } from "./feishu/recovery.ts";
import { FeishuDeliveries, type FeishuDelivery } from "./feishu-delivery.ts";
import { startPanel, type FeishuBridge } from "./web/server.ts";
import { approvalDecisions, approvals, captureApprovalRevocation, claimApprovalNotification, clampMinutes, conversationScope, decisionInput, drainApprovalDecisions, failApprovalNotification, fileGuardBases, grantApprovalWindow, loadApprovalState, makePathGuardExtension, pendingApprovals, revokeApprovalSnapshot, revokeApprovalWindows, runSender, runVia, scopeOf, setApprovalCallback, setPendingApprovalCard, setRunAttribution, takeDecision, windowKey, type ApprovalDecision, type ApprovalTarget, type RunVia } from "./ext/approval.ts";
import { makeLarkExtension } from "./ext/lark.ts";
import { makeSendExtension, type FileSendInput } from "./ext/send.ts";
import { makeScheduleExtension } from "./ext/schedule.ts";
import { backgroundChildren, makeBackgroundDeliverer, makeBackgroundExtension, reconcileBackgroundStops } from "./ext/background.ts";
import { makeProcExtension, pruneProcLogs } from "./ext/proc.ts";
import { presentAnswer } from "./answer.ts";
import { modelFailure } from "./model-failure.ts";

type ReplyTarget = { chatId: string; messageId: string; destination?: ConversationDestination };

let harness: Harness;
let sessions: Sessions;
let channel: LarkChannel;
let telegram: TelegramBot | undefined;
let telegramInbox: TelegramInbox;
let feishuDeliveries: FeishuDeliveries | undefined;
let telegramWorkers: TelegramInputWorkers;
const telegramAdmissions = new Map<number, Promise<unknown>>();
const telegramChatSeed = (process.env.DWELL_TELEGRAM_CHATS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
let telegramChats: TelegramChats | undefined;
const telegramReplies = new Set<string>();
const telegramPreparationActivities = new Map<string, () => void>();
const users = new Users();
let directory: Directory;
/** 审批后续跑后台子会话的投递器（main 装配；定义与投递语义见 ext/background.ts） */
let backgroundDeliverer: ReturnType<typeof makeBackgroundDeliverer>;
/** panel 操作者：panel 发起的输入/审批/控制都记在这个 open_id 名下 */
let panelUser = "";
/** Vision captures the selected connection's key before shell environments are scrubbed. */
let imageDescriber: ImageDescriber | null = null;
let uploads: Uploads;
/** dwell.proc 直接 spawn 用的 shell（沙箱探测后赋值；proc 扩展的 shell getter 延迟读它） */
let spawnShell: { path: string; sandboxed: boolean } = { path: "", sandboxed: false };
let panel: ReturnType<typeof startPanel> | undefined;
let ready = false;
let shutdownPromise: Promise<void> | undefined;
let shutdownCode = 0;

async function main(): Promise<void> {
	// 密钥只在启动期读一次：Directory/Channel 用参数接，provider/web/vision 在 openDwell 内读进闭包。
	// 之后 scrubSecretEnv 把 env 与 /proc 原始环境区彻底擦净，resume 才放行任何任务（含续跑的 bash）
	const larkAppId = process.env.LARK_APP_ID;
	const larkAppSecret = process.env.LARK_APP_SECRET;
	const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
	directory = new Directory(larkAppId, larkAppSecret);
	imageDescriber = makeImageDescriber();
	await initStateDir();
	await loadApprovalState();
	// 运行告警：pi-durable 默认丢弃的故障（任务 faulted、hook 抛错、Session 失败）记日志并私发管理员；
	// nameOf 延迟访问——sessions 在 openDwell 之后才初始化
	const notifyAdmins = async (text: string): Promise<void> => {
		for (const u of users.list()) {
			if (u.role !== "admin") continue;
			try {
				if (u.id.startsWith("tg:")) {
					if (telegram !== undefined) await telegram.send(telegramPrivate(u.id), text);
				} else if (connected()) await channel.send(u.id, { markdown: text });
			} catch (err) {
				console.error("[dwell] 告警私发失败:", u.id, err);
			}
		}
	};
	const onReport = makeReporter({
		notify: notifyAdmins,
		onSessionFailed: async (text) => {
			// Session 关闭后进程留着只是僵尸：尽力通知（5s 截断，失败也不拦退出）后退出，交给 systemd/docker 重启
			await Promise.race([notifyAdmins(text).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
			process.exit(1);
		},
		nameOf: (id) => sessions?.nameOf(id),
	});
	// 定时触发/后台回报的自治 run：归属登记与开卡入口（schedule/background 两扩展共用；sessions/channel 运行时才解引用）。
	// Attribution must be durable before admitting an autonomous submission.
	const attributeRun = (conversationId: number, creator: string): Promise<void> =>
		setRunAttributionIfIdle(conversationId, creator, sessions.destinationOf(conversationId).kind);
	const onAutonomousRun = async (conversationId: number, submissionId: SubmissionId, header: string): Promise<void> => {
		// Each bot's presentation receipt must survive before its producer finishes announcing.
		await openAutonomousCard(conversationId, submissionId, header);
	};
	// 定时任务：sleep → 触发 → 周期续睡；后台子代理：锚任务持有子会话，Reporter 投递与回报
	// 子代理移除的扩展对象经 getter 延迟取（backgroundExt 自引用，装配后才存在）
	const scheduleExt = makeScheduleExtension({
		attribute: attributeRun,
		onFired: onAutonomousRun,
		getHarness: () => harness,
		senderOf: (id) => runSender.get(id),
		viaOf: (id) => runVia.get(id),
		isAllowed: conversationActorAllowed,
		onCreatorRevoked: (input) => console.error(`[dwell] 定时任务 ${input.id} 已终止：创建者 ${input.creator} 已无当前入口的使用权限`),
	});
	const backgroundExt = makeBackgroundExtension({
		isAllowed: conversationActorAllowed,
		inputMode: conversationInputMode,
		getHarness: () => harness,
		budgetStopReason: async (id, budgetId) => runtimeBudgets(harness)?.stopReason(id, budgetId),
		attribute: attributeRun,
		onFired: onAutonomousRun,
		// Child attribution is restored from its own durable input before model execution.
		onStarted: (child, parent) => {
			conversationScope.set(child, parent);
		},
		senderOf: (id) => runSender.get(id),
		viaOf: (id) => runVia.get(id),
		forbidden: () => [scheduleExt, backgroundExt, procExt],
	});
	const procExt = makeProcExtension({
		isAllowed: conversationActorAllowed,
		attribute: attributeRun,
		onFired: onAutonomousRun,
		getHarness: () => harness,
		senderOf: (id) => runSender.get(id),
		viaOf: (id) => runVia.get(id),
		// 与 bash 工具同一 shell：沙箱启用即 wrapper（spawn 也进沙箱）；spawnShell 在探测后赋值，装配期间还空
		shell: () => spawnShell,
	});
	// 审批续跑后台子会话的投递器：在父线上建 Reporter，结果按 followUp 回父线
	backgroundDeliverer = makeBackgroundDeliverer({
		isAllowed: conversationActorAllowed,
		inputMode: conversationInputMode,
		budgetStopReason: async (id, budgetId) => runtimeBudgets(harness)?.stopReason(id, budgetId),
		attribute: attributeRun,
		onFired: onAutonomousRun,
		onStarted: () => {},
		senderOf: (id) => runSender.get(id),
		viaOf: (id) => runVia.get(id),
		forbidden: () => [scheduleExt, backgroundExt, procExt],
	}, () => harness);
	harness = await openDwell(undefined, [
		// lark 依赖运行时对象（channel/sessions/directory 后于 harness 初始化），getter 延迟绑定
		makeLarkExtension({
			getClient: () => channel?.rawClient,
			getDirectory: () => directory,
			chatOf: (id) => sessions.chatOf(scopeOf(id)),
			destinationOf: (id) => sessions.destinationOf(scopeOf(id)),
			getDescriber: () => imageDescriber,
			isAdmin: (id) => users.isAdmin(id),
			senderOf: (id) => runSender.get(id),
			getSelfAppId: () => larkAppId,
			// dwell.lark.send 的出口：发送复用 index 的锚点/话题规则，发出的文件消息即成为新锚点（回复它即续接任务线）；scope：后台子会话按父线的 chat 发
			sendToChat: async (id, input) => {
				const scope = scopeOf(id);
				const sent = await sendToConversationChat(scope, input);
				if (sent !== undefined) await sessions.anchor(sent.messageId, scope as ConversationId);
				return sent;
			},
		}),
		makeSendExtension({ destinationOf: (id) => sessions.destinationOf(scopeOf(id)), send: sendFileToConversation }),
		// 文件工具路径治理：按会话解析 cwd（write/edit 限 cwd+tmp；read 禁 state/应用根/sqlite/proc）
		makePathGuardExtension(async (id, context) => {
			const conversation = await harness.conversation(id as ConversationId, context);
			return conversation === undefined ? undefined : (await conversation.agent(context)).cwd ?? undefined;
		}),
		// 定时任务、后台任务与托管进程（定义见 openDwell 前的扩展对象）
		scheduleExt,
		backgroundExt,
		procExt,
	], onReport,
		(_conversationId, sender, via) => users.isAllowed(sender) || (via === "panel" && sender === panelUser),
		(id) => sessions?.isActorScoped(scopeOf(id)) === true,
	);
	uploads = await Uploads.open(resolve(DATA_DIR, "work"), () => sandboxState);
	await uploads.register(DEFAULT_CWD);
	sessions = new Sessions(harness, (cwd) => uploads.register(cwd));
	await sessions.load();
	telegramInbox = new TelegramInbox(harness);
	feishuDeliveries = new FeishuDeliveries(harness, { deliver: presentFeishuAutonomous, report: (receipt, alert) => {
		const reason = { capacity: "待发回报已达上限，生产任务保留投递阶段等待空位", delayed: "回报排队超过 30 分钟，仍保留等待投递", uncertain: "回报发送结果不确定，未自动重发，请核对飞书与任务记录", missing: "回报关联的任务输入已不可用，未发送", storage: "回报状态处理失败，将保留记录重试" }[alert];
		onReport(new Error(`飞书自治回报 #${receipt.submissionId}：${reason}`), { type: "extension_error", extension: "dwell-feishu-delivery", conversationId: receipt.conversationId as ConversationId });
	} });
	telegramWorkers = new TelegramInputWorkers(telegramInbox, processTelegramInput, async (id, row, error, terminal) => {
		console.error(`[dwell] Telegram 输入预处理${terminal ? "失败，已保留原始消息" : "稍后重试"}（${id}）:`, error);
		if (terminal) await replyNotice({ chatId: telegramChatKey(row.destination.botId, row.destination.chatId), messageId: row.replyTo, destination: row.destination }, "消息预处理失败，请重新发送；原始消息已保留供排查。");
	});
	await pruneProcLogs(harness).catch((err: unknown) => console.error("[dwell] 旧进程日志清理失败:", err));
	// 后台子会话 → 父会话映射重建（审批窗口按父线开；重启后 approval 扩展立即能用）
	await rebuildConversationScope();
	const realigned = await sessions.alignModel();
	console.log(`[dwell] 模型 ${MODEL.provider}/${MODEL.modelId}${realigned > 0 ? `（${realigned} 个会话已切换到该模型）` : ""}`);
	await users.load();
	if (users.list().length === 0) {
		console.error("[dwell] 全局用户名单为空，私聊与逐人授权群将拒绝任务；群成员开放仍按群策略检查（首次启动可配置 DWELL_ALLOW/DWELL_ADMINS）");
	}

	setApprovalCallback((conversationId, sender, command, match) => {
		const pending = pendingApprovals.get(windowKey(conversationId, sender));
		const destination = pending?.via === "panel" ? panelDestination() : sessions.destinationOf(conversationId);
		if (destination.kind === "telegram") {
			void sendTelegramApproval(destination, conversationId, sender, command, match);
			return;
		}
		// panel 发起的 run：审批卡私发给操作者（不发到发起群），回复通知即可续接任务
		if (pending?.via === "panel") {
			void (async () => {
				try {
					const sent = await channel.send(panelUser, { card: approvalCard(conversationId, sender, command, match, { kind: "request" }) });
					await setPendingApprovalCard(windowKey(conversationId, sender), pending, panelUser, sent.messageId);
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

	// 密钥已全部进入闭包：从 env 与 /proc 原始环境区彻底移除（失败即拒绝启动），此后任何任务都读不回
	await scrubSecretEnv();
	await reconcileBackgroundStops(harness);

	// 须在沙箱探测前：wrapper 的透传名单按生成期 env 定
	applyGithubEnv();
	// Enforce the deployment's isolation requirement before resuming any durable work.
	const mode = sandboxMode();
	const sandbox = await probeSandbox({ dataDir: DATA_DIR, stateDir: STATE_DIR, appRoot: APP_ROOT, forceOff: mode === "off" });
	requireSandbox(mode, sandbox);
	setSandboxState(sandbox);
	spawnShell = resolveSpawnShell(sandbox);
	if (sandbox.enabled) console.log(`[dwell] bash 沙箱已启用（wrapper: ${sandbox.wrapperPath}）`);
	else console.log(`[dwell] bash 沙箱未启用，回退路径治理：${sandbox.reason}`);

	// GH_TOKEN 自检：告警直发管理员（不是 pi-durable 故障，不走 onReport），网络失败只记日志
	const githubCheck = async (): Promise<void> => {
		const warnings = await checkGithubToken(process.env.GH_TOKEN ?? "");
		if (warnings === null) {
			console.error("[dwell] GH_TOKEN 自检：请求 GitHub 失败，跳过");
			return;
		}
		if (warnings.length === 0) console.log("[dwell] GH_TOKEN 自检通过");
		for (const text of warnings) {
			console.error(`[dwell] ${text}`);
			await notifyAdmins(`⚠️ ${text}`);
		}
	};
	if (githubEnabled()) {
		if (!sandbox.enabled) console.error("[dwell] 已配 GH_TOKEN 但沙箱未启用：bash 继承完整环境");
		setInterval(() => void githubCheck(), 24 * 3600_000).unref();
	}

	// Web panel（无内置鉴权，请求准入靠 Host/Origin/Content-Type 检查 + 部署侧网络边界）；DWELL_PANEL_ONLY=1 时不连飞书，仅 panel（本地开发/review）
	const panelPort = Number(process.env.DWELL_PANEL_PORT ?? 0);
	if (panelPort > 0) {
		panel = startPanel({ harness, sessions, users, directory, feishu: feishuBridge, telegram: () => telegram?.status() ?? "off", port: panelPort, describer: () => imageDescriber, sandbox: () => sandboxState.enabled, saveUpload: uploads.save,
			ready: () => ready && shutdownPromise === undefined,
			runtime: async () => {
				const inbox = { pending: 0, sending: 0, tracking: 0 };
				for (const [, row] of await telegramInbox.recoverable()) if (row.output === "pending" || row.output === "sending" || row.output === "tracking") inbox[row.output]++;
				return { telemetry: runtimeTelemetry(harness)?.snapshot(), telegram: { transport: telegram?.status() ?? "off", workers: telegramWorkers.status(), inbox } };
			},
		});
	}
	if (process.env.DWELL_PANEL_ONLY === "1") {
		console.log("[dwell] panel-only 模式（未连接飞书或 Telegram）");
		if (githubEnabled()) void githubCheck();
		await replayApprovalDecisions();
		harness.resume();
		ready = true;
		return;
	}

	// 飞书凭证只在真连 Channel 时要求（panel-only 本地开发无凭证可跑）；scrub 前已捕获进参数，环境已擦净
	if (larkAppId || larkAppSecret) {
		if (!larkAppId || !larkAppSecret) throw new Error("LARK_APP_ID / LARK_APP_SECRET 必须一起设置");
		channel = await connectChannel({ appId: larkAppId, appSecret: larkAppSecret, onMessage: (msg) => void handleMessage(msg), onCardAction: (evt) => void handleCardAction(evt) });
	}
	if (telegramToken) {
		telegram = await TelegramBot.connect({ token: telegramToken, onMessage: handleMessage, onCallback: handleTelegramCallback, onError: (error) => console.error("[dwell] Telegram 连接异常:", error.message),
			isDestinationAllowed: telegramChatAllowed,
			onFatal: (error) => { console.error("[dwell] Telegram 已停止，退出并交由服务管理器恢复:", error.message); void shutdown(1); },
		});
		telegramChats = new TelegramChats(telegram.identity.id);
		await telegramChats.load(telegramChatSeed);
	}
	if (!connected() && telegram === undefined) throw new Error("请配置飞书或 TELEGRAM_BOT_TOKEN，或启用 panel-only 模式");
	await feishuDeliveries.recover();
	// 部署重启会切断活跃 run 与原流式卡的绑定（watcher 死在旧进程）：为续跑中的飞书会话重挂镜像卡
	await reattachStreams();
	await reattachTelegramReplies();
	for (const [key, pending] of pendingApprovals) {
		const scope = Number(key.split(":")[0]);
		const destination = pending.via === "panel" ? panelDestination() : sessions.destinationOf(scope);
		if (destination.kind === "telegram" && pending.notificationState === undefined && pending.cardMessageId === undefined) await sendTelegramApproval(destination, scope, pending.trigger, pending.command, pending.match);
		else if (destination.kind === "telegram" && pending.notificationState === "sending") {
			await failApprovalNotification(key, pending.requestId ?? "", true);
			console.error(`[dwell] Telegram 审批提示投递结果未知，可用命令处理（#${scope}）`);
		}
	}
	// Channel 连上之后才能私发告警
	if (githubEnabled()) void githubCheck();
	await replayApprovalDecisions();
	// resume 放在擦除密钥与飞书重挂之后：续跑任务（含其 bash）从这里才开跑
	if (connected()) await feishuDeliveries.start();
	harness.resume();
	telegramWorkers.start();
	telegram?.start();
	ready = true;
	console.log(`[dwell] 就绪（飞书: ${connected() ? channel.botIdentity?.name ?? "?" : "off"}，Telegram: ${telegram?.identity.username ?? "off"}）`);
}

/** run 归属登记：仅当该线无活跃 run 时更新（插话并入活跃 run 时不覆写，防 steer 把审批归属漂移到插话者）。 */
async function setRunAttributionIfIdle(conversationId: number, sender: string, via: RunVia): Promise<void> {
	const graphState = await harness.taskGraph?.(BACKGROUND_CONTEXT);
	try {
		const busy = busyConversations(graphState?.value);
		if (!busy.has(conversationId)) {
			await setRunAttribution(conversationId, sender, via);
		}
	} finally {
		graphState?.dispose();
	}
}

/** 会话路由：私聊 chat 级 / 群平消息 per-sender / 话题 per-thread / replyTo 跟随。 */
async function route(msg: NormalizedMessage): Promise<{ conversation: Conversation; degraded: boolean; isolated?: boolean } | null> {
	const destination = messageDestination(msg);
	if (msg.platform === "telegram" && msg.requestId !== undefined) {
		const receipt = await telegramInbox.input(msg.requestId) ?? await telegramInbox.command(msg.requestId);
		if (receipt !== undefined) {
			const conversation = await sessions.byConversation(receipt.conversationId as ConversationId);
			if (conversation === undefined) throw new Error("Telegram 已接纳的任务线不存在，游标未推进");
			return { conversation, degraded: false };
		}
	}
	const members = destination.kind === "telegram" && msg.chatType === "group" && telegramChats?.accessMode(destination) === "members";
	// replyTo 跟随（优先级最高，群聊/私聊通用）
	if (msg.replyToMessageId !== undefined) {
		const target = sessions.follow(msg.replyToMessageId);
		if (target !== undefined) {
			const conversation = await sessions.byConversation(target);
			const previousDestination = sessions.destinationOf(target);
			const panelReply = destination.kind === "telegram" && msg.chatType === "p2p" && msg.senderId === panelUser && previousDestination.kind === "panel";
			if (conversation !== undefined && (msg.platform !== "telegram" || sameDestination(destination, previousDestination) || panelReply)) {
				if (members || sessions.isActorScoped(target)) {
					if (sessions.isActorScoped(target) && sessions.ownerOf(target) === msg.senderId) return { conversation, degraded: false };
					return { conversation: await sessions.forTelegram(msg, undefined, true), degraded: false, isolated: true };
				}
				return { conversation, degraded: false };
			}
		}
		// 未命中（未记录或已被上限淘汰）——降级到自己的线，由调用方显式提示
	}
	const fb = fallbackRoute(msg);
	if (msg.platform === "telegram") return { conversation: await sessions.forTelegram(msg, undefined, members), degraded: fb.degraded };
	switch (fb.kind) {
		case "direct":
			return { conversation: await sessions.forDirect(msg.chatId, msg.senderId), degraded: fb.degraded };
		case "thread":
			return { conversation: await sessions.forThread(msg.chatId, fb.threadId, msg.senderId), degraded: fb.degraded };
		default:
			return { conversation: await sessions.forGroup(msg.chatId, msg.senderId), degraded: fb.degraded };
	}
}

async function handleMessage(msg: NormalizedMessage): Promise<void> {
	try {
		const destination = messageDestination(msg);
		const target: ReplyTarget = { chatId: msg.chatId, messageId: msg.messageId, destination };
		// 群聊准入（SDK policy 已放开 mention 门，由这里细化）：话题内消息与回复已锚定消息视为显式指向，平消息仍需 @bot
		if (!groupAdmits(msg, (messageId) => sessions.follow(messageId) !== undefined)) return;
		if (destination.kind === "telegram" && await handleTelegramChatCommand(msg, destination)) return;
		if (destination.kind === "telegram" && !telegramChatAllowed(destination)) {
			// A host-only notice can explain group admission without opening a task or its general delivery path.
			if (telegram !== undefined && destination.botId === telegram.identity.id && msg.chatType === "group") {
				try {
					const admin = users.isAdmin(msg.senderId);
					const instruction = admin ? `你可点击“允许本群成员使用”，或在本群发送 /allowgroup@${telegram.identity.username}。` : "请让 dwell 管理员在本群发送 /allowgroup，开放群成员使用。";
					await telegram.sendControl(destination, `这个群尚未启用，暂时不能在这里执行任务。\n\n聊天 ID：${destination.chatId}\n你的 ID：${msg.senderId}\n\n${instruction}\n使用 /ask@${telegram.identity.username} 内容，或回复我的消息。`, { replyTo: msg.messageId, ...(admin ? { buttons: [[{ text: "允许本群成员使用", data: "dwell:allowgroup" }], [{ text: "仅允许已授权用户", data: "dwell:allowchat" }]] } : {}) });
				} catch (error) { console.error("[dwell] Telegram 群接入提示未能送达:", error instanceof TelegramError ? error.message : "发送失败"); }
			}
			return;
		}
		if (msg.platform === "telegram" && msg.content.trim() === "/whoami" && !users.isAllowed(msg.senderId)) {
			await replyTo(target, `你的 ID：${msg.senderId}；聊天 ID：${destination.kind === "telegram" ? destination.chatId : "?"}`).catch((error: unknown) => console.error("[dwell] 身份回复失败:", error));
			return;
		}
		if (!actorAllowed(msg.senderId, destination, msg.platform === "telegram" ? "telegram" : "feishu")) {
			await replyTo(target, "未授权使用，请联系管理员开通。").catch((error: unknown) => console.error("[dwell] 准入提示失败:", error));
			return;
		}
		if (msg.platform === "telegram" && !["text", "image", "file"].includes(msg.rawContentType)) {
			await replyNotice(target, "目前支持文本、图片和文件消息。");
			return;
		}
		const empty = emptyReply(msg);
		if (empty !== null) {
			if (empty === "unsupported") {
				await replyNotice(target, "目前支持文本、图片和文件消息。");
			}
			return;
		}

		const routed = await route(msg);
		if (routed === null) return;
		const { conversation, degraded, isolated } = routed;
		sessions.touchActivity(conversation.id);
		// 归档只是 panel 的整理动作；飞书侧有新消息说明这条线又活了
		if (sessions.isArchived(conversation.id)) await sessions.setArchived(conversation.id, false);
		await sessions.anchor(msg.messageId, conversation.id);

		if (isolated) {
			await replyNotice(target, "本群按成员使用独立任务线，已转到你自己的任务线；回复你自己的 bot 消息可继续。", conversation);
		} else if (degraded) {
			await replyNotice(target, "未找到引用的任务线，已在你当前线上继续。", conversation);
		}

		// run 归属：审批与 /cancel 按触发者判定
		// panel 会话（无对应 chat）经飞书续接时保持 panel 入口语义：审批仍私发管理员，不发到发起群
		// run 归属：审批与 /cancel 按触发者判定（线内已有活跃 run 时保留原归属，见 setRunAttributionIfIdle）
		await setRunAttributionIfIdle(conversation.id as number, msg.senderId, sessions.destinationOf(conversation.id as number).kind);

		const content = msg.content.trim();
		const action = messageAction(content, (msg.resources?.length ?? 0) > 0, msg.platform);
		if (action === "command") {
			const executeCommand = async (): Promise<void> => {
			let commandReceipt: TelegramCommandReceipt | undefined;
			if (msg.platform === "telegram" && msg.requestId !== undefined) {
				const live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
				const expiresAt = approvals.get(windowKey(conversation.id as number, msg.senderId));
				commandReceipt = await telegramInbox.beginCommand(msg.requestId, {
					conversationId: conversation.id as number, command: content,
					...(live?.run === undefined ? {} : { cancelTaskId: live.run.taskId as number }),
					...(content.split(/\s+/)[0] === "/cancel" ? { cancelInputIds: (await telegramInbox.pendingInputs()).filter(([, row]) => row.conversationId === conversation.id).map(([id]) => id) } : {}),
					approvalRequestId: pendingApprovals.get(windowKey(conversation.id as number, msg.senderId))?.requestId ?? "",
					...(expiresAt === undefined ? {} : { windowExpiresAt: expiresAt }),
					...(content.split(/\s+/)[0] === "/deny" ? { denial: captureApprovalRevocation(conversation.id as number, users.isAdmin(msg.senderId) ? undefined : msg.senderId) } : {}),
					...(content.split(/\s+/)[0] === "/newgoal" ? { newGoalWorkId: (await getWork(harness, conversation.id as number)).current ?? null } : {}),
				});
				if (commandReceipt.done) return;
				if (["/allow", "/disallow"].includes(commandReceipt.command.split(/\s+/)[0]) && users.commandApplied(msg.requestId)) {
					await telegramInbox.finishCommand(msg.requestId);
					await replyNotice(target, "这条权限命令已处理，未重复更改成员状态。");
					return;
				}
			}
			try { await runCommand(commandReceipt?.command ?? content, conversation, msg, target, commandReceipt); }
			catch (error) {
				if (commandReceipt === undefined || !(error instanceof TelegramError)) throw error;
				console.error(`[dwell] Telegram 控制命令回复未确认，未重放控制效果（${msg.requestId}）:`, error);
			}
			if (commandReceipt !== undefined) await telegramInbox.finishCommand(msg.requestId!);
			};
			if (msg.platform === "telegram") await withTelegramAdmission(conversation.id as number, executeCommand);
			else await executeCommand();
			return;
		}
		if (destination.kind === "telegram") {
			const id = msg.requestId!;
			const authorityVia = sessions.destinationOf(conversation.id as number).kind === "panel" ? "panel" : "telegram";
			await telegramInbox.enqueue(id, { conversationId: conversation.id as number, sender: msg.senderId, authorityVia, destination, replyTo: msg.messageId, requestId: id, raw: msg });
			telegramWorkers.wake();
			return;
		}
		// 多模态：媒体消息走独立流式流程（先占位再接主模型流，避免预处理 10s 黑盒）
		if (action === "media") {
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			void mediaStreamAndReply(conversation, msg, agent.cwd ?? DEFAULT_CWD, target);
			return;
		}

		const submission = await submitInput(conversation, content, msg);
		// queued = 插话并入活跃 run（或紧随排队）：旧卡的 watcher 会把新轮文本 append 进原卡，
		// 再开新卡会出现两张内容相同的卡（实测），故 queued 不开卡
		const record = await submission.status(BACKGROUND_CONTEXT);
		if (record.status !== "queued") void submitAndReply(conversation, submission, target);
	} catch (err) {
		console.error("[dwell] 消息处理出错:", err);
		if (msg.platform === "telegram") throw err;
	}
}

/** 统一的输入提交（媒体/文本两条路径共用：transcript 记 sender，requestId 幂等，steer）。 */
function submitInput(conversation: Conversation, content: string, msg: NormalizedMessage, authorityVia?: RunVia) {
	const via = msg.platform ?? "feishu";
	const authority = authorityVia ?? (sessions.destinationOf(conversation.id as number).kind === "panel" ? "panel" : via);
	if (!conversationActorAllowed(msg.senderId, conversation.id, authority)) throw new Error("输入提交前使用权限已撤销，未启动模型。");
	return conversation.submit(
		{
			type: "input",
			content,
			// transcript 记录 sender（审计/分账基础；model 仍只看 content）
			entry: { kind: "chat.message", data: { sender: msg.senderId, senderName: msg.senderName ?? "", chatType: msg.chatType, via, ...(authority === via ? {} : { authorityVia: authority }) } },
			requestId: msg.requestId ?? msg.messageId,
			whenBusy: conversationInputMode(conversation.id),
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
	if (target.destination?.kind === "telegram") {
		await presentTelegramSubmission(conversation, submission, target);
		return;
	}
	// 插话并入活跃 run 时不开新卡：旧卡的 watcher 会把续跑文本 append 进原卡，再开卡即重复（同 handleMessage 的 queued 检查）
	const record = await submission.status(context);
	if (record.status === "queued") return;
	try {
		// 回答卡登记锚点：回复这张卡即续接该任务线（群聊免 @），否则 route 必 miss
		// 终态替换须在 stream resolve（SDK flush + finishStreamingCard）之后，否则遗留的流式 patch 会覆盖回旧内容
		let full = "";
		const sent = await channel.stream(
			target.chatId,
			{ markdown: async (s) => {
				full = await streamReplyCore(conversation, submission, s, context);
			} },
			{ replyTo: target.messageId },
		);
		if (full !== "") await finalizeCard(target.chatId, sent.messageId, full);
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
	let streamed = "";
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
						save: uploads.save,
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
					streamed = await streamReplyCore(conversation, submission, s, context);
				},
			},
			{ replyTo: target.messageId },
		);
		if (streamed !== "") await finalizeCard(target.chatId, sent.messageId, streamed);
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

/** 群平消息线的回复卡首行标签：同 chat 内 emoji 唯一（Sessions 分配），多线并行时标识归属；其余线型无线歧义不带。 */
function lineLabel(conversationId: number): string | undefined {
	const info = sessions.listConversations().find((c) => c.id === conversationId);
	if (info?.type !== "group" || info.chatId === null) return undefined;
	return `当前会话：${sessions.lineEmoji(conversationId, info.chatId)}`;
}

/** 流式卡保活与镜像累积：飞书流式窗口约 10 分钟无更新即静默失效，>60s 无 append 时补一条状态行续命；
 *  镜像供终态替换（finalizeCard）使用，保活行本身不进镜像。 */
function cardKeeper(s: MarkdownStreamController): { append: (text: string) => Promise<void>; full: () => string; stop: () => void } {
	const chunks: string[] = [];
	let lastActivity = Date.now();
	const runStart = lastActivity;
	let finished = false;
	const timer = setInterval(() => {
		if (finished || Date.now() - lastActivity < 60_000) return;
		lastActivity = Date.now();
		const secs = Math.round((Date.now() - runStart) / 1000);
		void s.append(`> ⏳ 仍在运行 · ${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s\n\n`).catch(() => {});
	}, 15_000);
	return {
		append: async (text) => {
			chunks.push(text);
			lastActivity = Date.now();
			await s.append(text);
		},
		full: () => chunks.join(""),
		stop: () => {
			finished = true;
			clearInterval(timer);
		},
	};
}

/** 主模型流式回复主体：watch pi.live 的节流 partial，前缀检测 append 增量（轮切换/重试自动重置游标），settled 后补齐最终答案。占位阶段的 setContent 由调用方负责。
 *  返回卡片全文镜像，调用方用于终态兜底替换（finalizeCard）。 */
async function streamReplyCore(
	conversation: Conversation,
	submission: Awaited<ReturnType<Conversation["submit"]>>,
	s: MarkdownStreamController,
	context: typeof BACKGROUND_CONTEXT,
	throwOnError = false,
): Promise<string> {
	const keeper = cardKeeper(s);
	const append = keeper.append;
	try {
		{
			const label = lineLabel(conversation.id as number);
			if (label !== undefined) await append(`${label}\n\n`);
			const watch = await conversation.watch(context);
				let cursor = "";
				// 工具概述：callId → 摘要（从 transcript 的 assistant toolCall 取参数），done 后报告一次
				const callSummary = new Map<string, string>();
				const reported = new Set<string>();
				// 运行中输出尾行：callId → 首见时间 / 上次 append 时间 / 已消费的完整输出长度
				const runningOut = new Map<string, { firstSeen: number; lastAppend: number; baseline: number }>();
				// 工具耗时与终态：首见时间 / 已标 done 的调用
				const startedAt = new Map<string, number>();
				const doneMarked = new Set<string>();
				let scanned = 0;
				let frameWork = Promise.resolve();
				let watchStopped = false;
				const summarize = (name: string, args: Record<string, unknown>): string => {
					const arg = args.command ?? args.path ?? JSON.stringify(args);
					return `> 🔧 ${name} · ${String(arg).replace(/\s+/g, " ").slice(0, 80)}`;
				};
				try {
					const settledP = submission.wait(context);
					void settledP.then(() => {}, () => {});
					const handleFrame = async (value: unknown): Promise<void> => {
						const live = (value as { docs?: Record<string, { run?: { inputs: SubmissionId[] }; generation?: { message?: { content?: { type: string; text?: string }[] } }; tools?: { callId: string; status: string; name?: string; output?: string; entry?: unknown }[] } | undefined> }).docs?.["pi.live"];
						if (!live?.run?.inputs.includes(submission.id)) return;
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
						for (const slot of live?.tools ?? []) {
							if (!startedAt.has(slot.callId)) startedAt.set(slot.callId, Date.now());
							// 工具开跑即报：槽位首次可见（pending/running）就 append 概述行，长命令运行期间卡片不再静默；
						// append-only 流无法回改已完成标记，故不区分状态、只报一次
						if (!reported.has(slot.callId) && callSummary.has(slot.callId)) {
								reported.add(slot.callId);
								// 尾部空行不可省：markdown 引用块（>）会把紧邻的下一行吸入——正文首句会被包进工具概述
							await append(`\n${callSummary.get(slot.callId) ?? ""}\n\n`);
						}
						// 长命令进展：运行 >3s 且距上次 ≥3s 时，把新增完整输出的最后一行 append 进卡（输出型命令可见进展；无输出命令不扰）
						if (slot.status === "running") {
							const now = Date.now();
							let prog = runningOut.get(slot.callId);
							if (prog === undefined) {
								prog = { firstSeen: now, lastAppend: 0, baseline: 0 };
								runningOut.set(slot.callId, prog);
							}
							const out = slot.output ?? "";
							const cut = out.lastIndexOf("\n");
							if (cut < prog.baseline) prog.baseline = Math.max(0, cut); // 输出窗前移致长度回缩：重同步，本轮跳过
							else if (cut > prog.baseline && now - prog.firstSeen >= 3_000 && now - prog.lastAppend >= 3_000) {
								const fresh = out.slice(prog.baseline, cut);
								const line = fresh.slice(fresh.lastIndexOf("\n") + 1).trim();
								if (line !== "") {
									await append(`> ▸ ${line.slice(0, 120)}\n\n`);
									prog.lastAppend = now;
								}
								prog.baseline = cut;
							}
						}
						// 终态标记：成功/失败 + 耗时（entry 缺席 = 任务 faulted/orphaned）
						if (slot.status === "done" && !doneMarked.has(slot.callId)) {
							doneMarked.add(slot.callId);
							const secs = ((Date.now() - (startedAt.get(slot.callId) ?? Date.now())) / 1000).toFixed(1);
							await append(`> ${slot.entry !== undefined ? "✓" : "✗"} ${slot.name ?? "?"}（${secs}s）

`);
						}
					}
						// 模型文本流
						const parts = live?.generation?.message?.content ?? [];
						const text = parts.flatMap((c) => (c.type === "text" && c.text !== undefined ? [c.text] : [])).join("");
						if (text.length === 0) return;
						if (text.startsWith(cursor) && text.length > cursor.length) {
							await append(text.slice(cursor.length));
							cursor = text;
						} else if (!text.startsWith(cursor)) {
							// 新轮或重试：响应从头开始，重置游标并加分隔
							cursor = text;
							await append(`\n\n${text}`);
						}
					};
					// 占位卡发送期间 run 可能已推进：先处理初始快照，再监听后续帧
					await handleFrame(watch.value);
					watch.start((value) => { frameWork = handleFrame(value); return frameWork; });
					// settled 后补齐最终答案（partial 节流可能落后）
					const settled = await settledP;
					await watch.stop();
					watchStopped = true;
					await frameWork;
					let final = "";
					if (settled.status === "done" && settled.type === "input") {
						final = (await presentAnswer(harness, conversation.id, settled.answer, context)).text;
					} else {
						final = `处理失败：${await runFailureReason(conversation.id as number, settled)}`;
					}
					if (final.startsWith(cursor) && final.length > cursor.length) {
						await append(final.slice(cursor.length));
					} else if (!final.startsWith(cursor) && final.length > 0) {
						// cursor 是作废 partial（重试/换轮）：分隔后追加完整最终答案，不丢尾
						await append(`\n\n${final}`);
					} else if (final.length === 0 && cursor.length === 0) {
						// 无任何文本产出（模型连续出错/被中止）：给群里一个明确终态，不留悬空卡
						await append("（本次运行没有产出文本：模型出错或被中止，可重发）");
					}
			} finally {
				if (!watchStopped) await watch.stop();
				await frameWork;
			}
		}
	} catch (err) {
		// 流式帧处理失败：卡片已创建，最多丢部分流式效果
		console.error("[dwell] 流式帧处理失败:", err);
		if (throwOnError) throw err;
	} finally {
		keeper.stop();
	}
	return keeper.full();
}

/** run 结束后的卡片终态替换：流式 element 更新受飞书流式窗口限制，message.patch 不依赖 streaming_mode，
 *  把卡片全量替换为最终内容；patch 不生效或内容超 30KB 时退回发一条普通消息。 */
async function finalizeCard(chatId: string, messageId: string, full: string, throwOnError = false): Promise<void> {
	try {
		if (Buffer.byteLength(full, "utf8") <= 28_000) {
			await channel.updateCard(messageId, {
				schema: "2.0",
				config: { update_multi: true },
				body: { elements: [{ tag: "markdown", content: full }] },
			});
			return;
		}
	} catch (err) {
		console.error("[dwell] 终态卡替换失败，退回普通消息:", err);
	}
	try {
		const clipped = full.length > 48_000 ? `${full.slice(0, 48_000)}\n\n…（超长已截断）` : full;
		await channel.send(chatId, { markdown: clipped }, { replyTo: messageId });
	} catch (err) {
		console.error("[dwell] 终态兜底消息发送失败:", err);
		if (throwOnError) throw err;
	}
}

/** 非流式回复（流式通道失败时的兜底）。 */
async function submitAndReplyPlain(
	conversation: Conversation,
	submission: Awaited<ReturnType<Conversation["submit"]>>,
	target: ReplyTarget,
): Promise<void> {
	if (target.destination?.kind === "telegram") { await presentTelegramSubmission(conversation, submission, target); return; }
	const context = BACKGROUND_CONTEXT;
	const settled = await submission.wait(context);
	if (settled.status === "done" && settled.type === "input") {
		const { text: reply } = await presentAnswer(harness, conversation.id, settled.answer, context);
		const label = lineLabel(conversation.id as number);
		await replyTo(target, (label !== undefined ? `${label}\n\n` : "") + (reply || "（空回复）"), conversation);
	} else {
		const reason = await runFailureReason(conversation.id as number, settled);
		await replyTo(target, `处理失败：${reason}`, conversation);
	}
}

/** Persist bot presentation before the producer finishes; panel summaries keep their notification switch. */
async function openAutonomousCard(conversationId: number, submissionId: SubmissionId, header: string): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const submission = await harness.submission(submissionId, context);
	if (submission === undefined) return;
	const destination = sessions.destinationOf(conversationId);
	if (destination.kind === "telegram") {
		const conversation = await sessions.byConversation(conversationId as ConversationId);
		if (conversation !== undefined) await presentTelegramSubmission(conversation, submission, { chatId: telegramChatKey(destination.botId, destination.chatId), messageId: sessions.lastAnchor(conversation.id) ?? "", destination });
		return;
	}
	const chatId = sessions.chatOf(conversationId);
	if (chatId === undefined) {
		if (sessions.notifyEnabled(conversationId)) void notifyAutonomousPanelResult(conversationId, submission);
		return;
	}
	const kind = sessions.listConversations().find((c) => c.id === conversationId)?.type;
	const anchor = kind === "direct" ? undefined : sessions.lastAnchor(conversationId as ConversationId);
	if (feishuDeliveries === undefined) throw new Error("飞书自治投递尚未就绪");
	await feishuDeliveries.enqueue({ conversationId, submissionId: submissionId as number, chatId, header, ...(anchor === undefined ? {} : { replyTo: anchor, replyInThread: kind === "thread" }) });
}

async function presentFeishuAutonomous(receipt: FeishuDelivery, signal: AbortSignal): Promise<void> {
	const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
	const conversation = await harness.conversation(receipt.conversationId as ConversationId, context);
	const submission = await harness.submission(receipt.submissionId as SubmissionId, context);
	if (conversation === undefined || submission === undefined) throw new Error("飞书自治回报的任务输入已不可用");
	signal.throwIfAborted();
	let streamed = "";
	const sent = await channel.stream(receipt.chatId, { markdown: async (s) => {
		signal.throwIfAborted();
		await s.append(`${receipt.header}\n\n`);
		streamed = `${receipt.header}\n\n${await streamReplyCore(conversation, submission, s, context, true)}`;
	} }, receipt.replyTo === undefined ? undefined : { replyTo: receipt.replyTo, replyInThread: receipt.replyInThread });
	signal.throwIfAborted();
	if (streamed !== "") await finalizeCard(receipt.chatId, sent.messageId, streamed, true);
	signal.throwIfAborted();
	await sessions.anchor(sent.messageId, receipt.conversationId as ConversationId);
}

/** panel 会话的自治 run（定时/后台）结束后私发结果摘要（通知开关开启时；回复通知即续接任务线）。 */
async function notifyAutonomousPanelResult(conversationId: number, submission: Awaited<ReturnType<Conversation["submit"]>>): Promise<void> {
	try {
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		let status = "完成";
		let text = "";
		if (settled.status === "done" && settled.type === "input") {
			const answer = await presentAnswer(harness, conversationId, settled.answer);
			text = answer.text;
			if (answer.waiting) status = "等待后台任务";
			else if (answer.ready) status = "待验收";
		} else {
			status = "失败";
			text = await runFailureReason(conversationId, settled);
		}
		await feishuBridge.notifyPanel(conversationId, status, text === "" ? "（无文本输出）" : text);
	} catch (err) {
		console.error("[dwell] panel 自治任务通知失败:", err);
	}
}

/** Restore scope routing without borrowing a parent's current actor. */
async function rebuildConversationScope(): Promise<void> {
	for (const { child, parent } of await backgroundChildren(harness)) {
		conversationScope.set(child, parent);
		const conversation = await harness.conversation(child as ConversationId, BACKGROUND_CONTEXT);
		if (conversation !== undefined) {
			const model = (await conversation.agent(BACKGROUND_CONTEXT)).model;
			if (model?.provider !== MODEL.provider || model.modelId !== MODEL.modelId) await conversation.configure({ model: MODEL }, BACKGROUND_CONTEXT);
		}
	}
}

async function replyTo(target: ReplyTarget, text: string, conversation?: Conversation): Promise<void> {
	if (target.destination?.kind === "telegram") {
		if (telegram === undefined || !telegramChatAllowed(target.destination)) throw new Error("Telegram 目的地未启用");
		const sent = await telegram.send(target.destination, text, { replyTo: target.messageId });
		if (conversation !== undefined) for (const messageId of sent.messageIds) await sessions.anchor(messageId, conversation.id);
		return;
	}
	const sent = await channel.send(target.chatId, { markdown: text }, { replyTo: target.messageId });
	if (conversation !== undefined) await sessions.anchor(sent.messageId, conversation.id);
}

async function replyNotice(target: ReplyTarget, text: string, conversation?: Conversation): Promise<void> {
	try { await replyTo(target, text, conversation); }
	catch (error) {
		if (target.destination?.kind !== "telegram" || !(error instanceof TelegramError)) throw error;
		console.error("[dwell] Telegram 提示未能送达，已消费该提示事件:", error.message);
	}
}

function telegramPrivate(sender: string): TelegramDestination {
	if (telegram === undefined || !/^tg:\d+$/.test(sender)) throw new Error("Telegram 私聊身份不可用");
	return { kind: "telegram", botId: telegram.identity.id, chatId: sender.slice(3) };
}

function panelDestination(): ConversationDestination {
	return panelUser.startsWith("tg:") && telegram !== undefined ? telegramPrivate(panelUser) : { kind: "panel" };
}

function telegramChatAllowed(destination: TelegramDestination): boolean {
	return telegram !== undefined && destination.botId === telegram.identity.id
		&& telegramChats?.allows(destination) === true;
}

function actorAllowed(sender: string, destination: ConversationDestination, via: RunVia = destination.kind): boolean {
	if (users.isBlocked(sender)) return false;
	if (destination.kind === "telegram" && !telegramChatAllowed(destination)) return false;
	if (via === "panel" && sender === panelUser) return true;
	if (users.isAllowed(sender)) return true;
	return via === "telegram" && destination.kind === "telegram" && /^tg:\d+$/.test(sender)
		&& telegramChats?.accessMode(destination) === "members";
}

function conversationActorAllowed(sender: string, conversationId: number, via?: RunVia): boolean {
	if (sessions === undefined) return false;
	const scope = scopeOf(conversationId);
	if (!actorAllowed(sender, sessions.destinationOf(scope), creatorVia(sender, via))) return false;
	return users.isAllowed(sender) || (via === "panel" && sender === panelUser) || (sessions.isActorScoped(scope) && sessions.ownerOf(scope as ConversationId) === sender);
}

function conversationInputMode(conversationId: number): "steer" | "followUp" {
	// pi-durable 可能将 steer 与 followUp 合并为同一轮；隔离线统一输入模式，避免混入其他操作者。
	return sessions.isActorScoped(scopeOf(conversationId)) ? "followUp" : "steer";
}

async function telegramControlReply(destination: TelegramDestination, text: string, replyTo?: string): Promise<void> {
	if (telegram === undefined || destination.botId !== telegram.identity.id) return;
	try { await telegram.sendControl(destination, text, { replyTo }); }
	catch (error) { console.error("[dwell] Telegram 群管理提示未能送达:", error instanceof TelegramError ? error.message : "发送失败"); }
}

async function handleTelegramChatCommand(msg: NormalizedMessage, destination: TelegramDestination): Promise<boolean> {
	const parts = msg.content.trim().split(/\s+/);
	const command = parts[0]!;
	if (!["/allowgroup", "/disallowgroup", "/allowchat", "/disallowchat", "/chats"].includes(command)) return false;
	if (telegram === undefined || telegramChats === undefined || destination.botId !== telegram.identity.id) return true;
	if (!users.isAdmin(msg.senderId)) {
		await telegramControlReply(destination, "群白名单管理仅 dwell 管理员可用。", msg.messageId);
		return true;
	}
	if (command === "/chats") {
		if (parts.length !== 1) await telegramControlReply(destination, "用法：/chats，查看当前 bot 已启用的群。", msg.messageId);
		else {
			const chats = telegramChats.list();
			const labels = chats.map((chatId) => `${chatId} · ${telegramChats!.accessMode({ ...destination, chatId, threadId: undefined }) === "members" ? "群成员可用" : "仅授权用户"}`);
			await telegramControlReply(destination, chats.length ? `当前 bot 已启用的群：\n${labels.join("\n")}` : "当前 bot 尚未启用任何群。", msg.messageId);
		}
		return true;
	}
	const groupCommand = command === "/allowgroup" || command === "/disallowgroup";
	if (groupCommand && (msg.chatType !== "group" || parts.length !== 1)) {
		await telegramControlReply(destination, `请在目标群发送 ${command}@${telegram.identity.username}，我会自动识别群，无需填写 ID。`, msg.messageId);
		return true;
	}
	const chatId = groupCommand ? destination.chatId : parts[1] ?? (msg.chatType === "group" ? destination.chatId : "");
	if (parts.length > 2 || !isTelegramGroupId(chatId)) {
		await telegramControlReply(destination, `用法：${command} 负数群ID。群内可省略群ID，私聊必须明确指定。`, msg.messageId);
		return true;
	}
	const allowed = command === "/allowchat" || command === "/allowgroup";
	const result = await telegramChats.change(chatId, allowed, msg.requestId ?? msg.messageId, command === "/allowgroup" ? "members" : "allowlist");
	const text = result === "replayed" ? "这条群白名单命令已处理，未重复更改群状态。"
		: command === "/allowgroup" ? `已开放本群成员使用（群 ${chatId}）。\n无需逐个授权；请用 /ask@${telegram.identity.username} 内容，或回复我的消息。\n群授权仅在本群有效，危险操作需 dwell 管理员审批。`
		: command === "/allowchat" ? `已启用群 ${chatId}，仅已授权用户可以提交任务。`
		: `已停用群 ${chatId}，停止接收新输入与后续投递。既有会话、任务、定时和进程保留。`;
	await telegramControlReply(destination, text, msg.messageId);
	return true;
}

async function sendFileToConversation(id: number, input: FileSendInput): Promise<boolean> {
	const scope = scopeOf(id);
	const destination = sessions.destinationOf(scope);
	if (destination.kind === "telegram") {
		if (telegram === undefined || !telegramChatAllowed(destination)) return false;
		const sent = await telegram.sendFile(destination, input.buffer, input.fileName, { image: input.image, replyTo: sessions.lastAnchor(scope as ConversationId) });
		for (const messageId of sent.messageIds) await sessions.anchor(messageId, scope as ConversationId);
		return true;
	}
	const sent = await sendToConversationChat(scope, input.image ? { image: { source: input.buffer } } : { file: { source: input.buffer, fileName: input.fileName } });
	if (sent === undefined) return false;
	await sessions.anchor(sent.messageId, scope as ConversationId);
	return true;
}

async function withTelegramAdmission<T>(id: number, action: () => Promise<T>): Promise<T> {
	const result = (telegramAdmissions.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
	telegramAdmissions.set(id, result);
	try { return await result; }
	finally { if (telegramAdmissions.get(id) === result) telegramAdmissions.delete(id); }
}

async function processTelegramInput(id: string, row: TelegramInputReceipt, signal: AbortSignal): Promise<void> {
	const conversation = await sessions.byConversation(row.conversationId as ConversationId);
	if (signal.aborted || (await telegramInbox.input(id))?.output !== "pending") return;
	if (conversation === undefined || !actorAllowed(row.sender, row.destination, row.authorityVia ?? "telegram")) { await telegramInbox.output(id, "failed"); return; }
	const msg = JSON.parse(row.raw!) as NormalizedMessage;
	let content = row.content;
	if (!row.prepared) {
		content = msg.content.trim();
		if (msg.resources.length > 0) {
			const stopActivity = telegram!.startActivity(row.destination, signal);
			telegramPreparationActivities.set(id, stopActivity);
			try {
				const cwd = (await conversation.agent(BACKGROUND_CONTEXT)).cwd ?? DEFAULT_CWD;
				const attachment = await describeResources(msg, cwd, { download: (key, _type, signal) => telegram!.download(key, signal), describer: imageDescriber, save: uploads.save }, signal);
				content = [content, attachment].filter(Boolean).join("\n\n");
			} finally {
				stopActivity();
				if (telegramPreparationActivities.get(id) === stopActivity) telegramPreparationActivities.delete(id);
			}
		}
		if (signal.aborted) return;
		await telegramInbox.prepared(id, content);
	}
	await withTelegramAdmission(row.conversationId, async () => {
		if (signal.aborted || (await telegramInbox.input(id))?.output !== "pending") return;
		if (!actorAllowed(row.sender, row.destination, row.authorityVia ?? "telegram")) { await telegramInbox.output(id, "failed"); return; }
		const authorityVia = row.authorityVia ?? (sessions.destinationOf(row.conversationId).kind === "panel" ? "panel" : "telegram");
		await setRunAttributionIfIdle(row.conversationId, row.sender, authorityVia);
		if (!actorAllowed(row.sender, row.destination, authorityVia) || !conversationActorAllowed(row.sender, row.conversationId, authorityVia)) { await telegramInbox.output(id, "failed"); return; }
		const submission = await submitInput(conversation, content, msg, authorityVia);
		await telegramInbox.admitted(id, submission.id as number);
		void replyTelegram(id, conversation, submission);
	});
}

async function replyTelegram(id: string, conversation: Conversation, submission: Awaited<ReturnType<Conversation["submit"]>>): Promise<void> {
	if (telegram === undefined || telegramReplies.has(id)) return;
	telegramReplies.add(id);
	let watch: Awaited<ReturnType<Conversation["watch"]>> | undefined;
	let preview: ReturnType<typeof createTelegramStreamPresenter> | undefined;
	let stoppingPreview: Promise<void> | undefined;
	const stopPreview = (): Promise<void> => stoppingPreview ??= (async () => {
		try { await watch?.stop(); }
		catch { console.error("[dwell] Telegram 实时状态订阅关闭失败，将尝试投递最终结果"); }
		await preview?.stop();
	})();
	try {
		// A queued input can become a later generation with a different answer. Delay its
		// placeholder until settlement so inputs merged into one answer share one reply.
		let settled: Awaited<ReturnType<typeof submission.wait>> | undefined;
		const initial = await submission.status(BACKGROUND_CONTEXT);
		if (initial.status === "queued") {
			settled = await submission.wait(BACKGROUND_CONTEXT);
			if (settled === undefined) throw new Error("Telegram 输入不存在");
			if (settled.status === "done" && settled.type === "input" && !await telegramInbox.claimAnswer(id, settled.answer as number)) return;
		}
		const row = await telegramInbox.claim(id);
		if (row === undefined) return;
		if (!telegramChatAllowed(row.destination)) { await telegramInbox.output(id, "failed"); return; }
		let messageId = row.messageId;
		if (messageId === undefined) {
			const sent = await telegram.send(row.destination, "正在处理…", { replyTo: row.replyTo || undefined });
			messageId = sent.messageId;
			await telegramInbox.output(id, "tracking", messageId);
			await sessions.anchor(messageId, conversation.id);
		}
		{
			try {
				watch = await conversation.watch(BACKGROUND_CONTEXT);
				const anchor = messageId;
				preview = createTelegramStreamPresenter({
					submissionId: submission.id as number,
					inputEntryId: (settled?.entry ?? initial.entry) as number | undefined,
					chatType: row.destination.chatId.startsWith("-") ? "group" : "p2p",
					edit: (text) => telegram!.edit(row.destination, anchor, text, undefined, { format: "markdown", preview: true }),
					onEditError: () => console.error("[dwell] Telegram 进度更新失败，已停止中间更新，将尝试投递最终结果"),
				});
				if (settled === undefined) {
					preview.update(watch.value);
					watch.start(async (value) => { preview!.update(value); });
				}
			} catch {
				await stopPreview();
				console.error("[dwell] Telegram 实时状态订阅失败，将尝试投递最终结果");
			}
		}
		settled ??= await submission.wait(BACKGROUND_CONTEXT);
		await stopPreview();
		if (!telegramChatAllowed(row.destination)) { await telegramInbox.output(id, "failed"); return; }
		if (settled === undefined) throw new Error("Telegram 输入不存在");
		let answer = "";
		if (settled.status === "done" && settled.type === "input") {
			if (!await telegramInbox.claimAnswer(id, settled.answer as number)) {
				await telegram.edit(row.destination, messageId, "该输入已并入同一轮回复。");
				return;
			}
			answer = (await presentAnswer(harness, conversation.id, settled.answer)).text || "（本次运行没有产出文本）";
		} else answer = `处理失败：${await runFailureReason(conversation.id as number, settled)}`;
		const execution = preview?.summary(watch?.value, settled.status === "done" && settled.type === "input" ? settled.answer as number : undefined);
		if (execution) answer += `\n\n${execution}`;
		if (answer.length <= 4096 && formatTelegramText(answer, "markdown").length === 1) await telegram.edit(row.destination, messageId, answer, undefined, { format: "markdown" });
		else {
			await telegram.edit(row.destination, messageId, "处理完成，结果见以下分段消息。");
			await telegramInbox.output(id, "sending");
			const sent = await telegram.send(row.destination, answer, { replyTo: messageId, format: "markdown" });
			for (const anchor of sent.messageIds) await sessions.anchor(anchor, conversation.id);
		}
		await telegramInbox.output(id, "done");
	} catch (error) {
		const row = await telegramInbox.input(id).catch(() => undefined);
		const uncertain = error instanceof TelegramError ? error.uncertain : row?.output === "sending";
		if (row !== undefined) await telegramInbox.output(id, uncertain ? "uncertain" : "failed").catch(() => {});
		console.error(`[dwell] Telegram 投递${uncertain ? "状态不确定，未自动重发" : "失败"}（${id}）:`, error);
	} finally { await stopPreview(); telegramReplies.delete(id); }
}

async function presentTelegramSubmission(conversation: Conversation, submission: Awaited<ReturnType<Conversation["submit"]>>, target: ReplyTarget): Promise<void> {
	if (target.destination?.kind !== "telegram") return;
	const id = `tg-reply:${target.destination.botId}:${submission.id}`;
	const sender = await telegramInbox.submissionSender(conversation.id as number, submission.id as number);
	if (sender === undefined) throw new Error("Telegram 回复缺少持久发送者，未创建投递凭据");
	await telegramInbox.prepare(id, { conversationId: conversation.id as number, sender, destination: target.destination, replyTo: target.messageId, submissionId: submission.id as number }, async () => "");
	void replyTelegram(id, conversation, submission);
}

async function reattachTelegramReplies(): Promise<void> {
	if (telegram === undefined) return;
	for (const [id, row] of await telegramInbox.recoverable()) {
		if (row.destination.botId !== telegram.identity.id) continue;
		if (row.raw !== undefined && row.submissionId === undefined) continue;
		if (row.output === "sending") {
			await telegramInbox.output(id, "uncertain");
			console.error(`[dwell] Telegram 上次发送结果未知，未重发（${id}）`);
			continue;
		}
		const conversation = await sessions.byConversation(row.conversationId as ConversationId);
		let submission = row.submissionId === undefined ? undefined : await harness.submission(row.submissionId as SubmissionId, BACKGROUND_CONTEXT);
		const sender = submission === undefined ? row.sender : await telegramInbox.reconcileSender(id);
		if (conversation === undefined || sender === undefined || !actorAllowed(sender, row.destination, row.authorityVia ?? "telegram")) { await telegramInbox.output(id, "failed"); continue; }
		if (submission === undefined) {
			const requestId = row.requestId ?? (id.startsWith("tg-update:") ? id : undefined);
			if (requestId === undefined) { await telegramInbox.output(id, "failed"); continue; }
			const via = id.startsWith("tg-panel:") ? "panel" : "telegram";
			const authorityVia = row.authorityVia ?? (sessions.destinationOf(row.conversationId).kind === "panel" ? "panel" : via);
			await setRunAttributionIfIdle(row.conversationId, row.sender, authorityVia);
			if (!actorAllowed(row.sender, row.destination, authorityVia) || !conversationActorAllowed(row.sender, row.conversationId, authorityVia)) { await telegramInbox.output(id, "failed"); continue; }
			submission = await conversation.submit({ type: "input", content: row.content, requestId, whenBusy: conversationInputMode(conversation.id), entry: { kind: "chat.message", data: { sender: row.sender, via, ...(authorityVia === via ? {} : { authorityVia }) } } }, BACKGROUND_CONTEXT);
			await telegramInbox.admitted(id, submission.id as number);
		}
		void replyTelegram(id, conversation, submission);
	}
}

async function sendTelegramApproval(destination: TelegramDestination, scope: number, sender: string, command: string, match: string): Promise<void> {
	const key = windowKey(scope, sender);
	const pending = pendingApprovals.get(key);
	if (telegram === undefined || pending?.requestId === undefined || !telegramChatAllowed(destination)) return;
	try {
		if (!await claimApprovalNotification(key, pending.requestId)) return;
		const sent = await telegram.send(destination, `需要批准 · ${match}\n任务 #${scope}\n${command.slice(0, 2500)}`, {
			...(sameDestination(sessions.destinationOf(scope), destination) ? { replyTo: sessions.lastAnchor(scope as ConversationId) } : {}),
			buttons: [[{ text: "批准 10 分钟", data: telegramApprovalData(pending.requestId, "approve", 10) }, { text: "批准 30 分钟", data: telegramApprovalData(pending.requestId, "approve", 30) }, { text: "拒绝", data: telegramApprovalData(pending.requestId, "deny") }]],
		});
		await setPendingApprovalCard(key, pending, telegramChatKey(destination.botId, destination.chatId), sent.messageId, destination);
		await sessions.anchor(sent.messageId, scope as ConversationId);
	} catch (error) {
		await failApprovalNotification(key, pending.requestId, error instanceof TelegramError && error.uncertain).catch(() => {});
		console.error("[dwell] Telegram 审批提示发送失败，可使用 /approve 或 /deny:", error);
	}
}

async function handleTelegramCallback(callback: TelegramCallback): Promise<void> {
	if (telegram === undefined) return;
	if (callback.data === "dwell:allowchat" || callback.data === "dwell:allowgroup") {
		let text = "启用群仅 dwell 管理员可用。";
		if (telegramChats !== undefined && callback.destination.botId === telegram.identity.id
			&& isTelegramGroupId(callback.destination.chatId) && users.isAdmin(callback.senderId)) {
			const members = callback.data === "dwell:allowgroup";
			const result = await telegramChats.change(callback.destination.chatId, true, `tg-chat-callback:${callback.id}`, members ? "members" : "allowlist");
			text = result === "replayed" ? "该启用请求已处理，未重复更改群状态。" : members ? "已开放本群成员使用，危险操作需 dwell 管理员审批。" : "已启用本群，仅已授权用户可以提交任务。";
		}
		await telegram.acknowledge(callback.id, text).catch((error: unknown) => console.error("[dwell] Telegram 群管理回调提示失败:", error));
		return;
	}
	const matched = telegramApprovalMatch(callback, pendingApprovals, {
		allowed: actorAllowed,
		canApprove: (id, destination, trigger) => actorAllowed(id, destination) && (users.isAllowed(trigger) ? users.isAllowed(id) : users.isAdmin(id)),
		admin: (id) => users.isAdmin(id), owner: (id) => sessions.ownerOf(id as ConversationId), chatAllowed: telegramChatAllowed,
	});
	if (matched === undefined) {
		await telegram.acknowledge(callback.id, "请求已失效或你没有审批权限").catch((error: unknown) => console.error("[dwell] Telegram 过期回调提示失败:", error));
		return;
	}
	const decision = await takeDecision(matched.key, matched.action, matched.minutes, { chatId: telegramChatKey(callback.destination.botId, callback.destination.chatId), messageId: callback.messageId, destination: callback.destination }, callback.data.split(":")[1]);
	await telegram.acknowledge(callback.id, decision === undefined ? "该请求已处理" : matched.action === "approve" ? "已批准" : "已拒绝").catch((error: unknown) => console.error("[dwell] Telegram 回调提示失败:", error));
	if (decision !== undefined) await replayApprovalDecisions(decision.id, () => updateApprovalPresentation(decision, "Telegram"));
}

async function updateApprovalPresentation(decision: Pick<ApprovalDecision, "cardDestination" | "cardMessageId" | "action" | "minutes" | "scope" | "trigger" | "command" | "match">, by: string): Promise<void> {
	if (decision.cardMessageId === undefined) return;
	if (decision.cardDestination?.kind === "telegram") {
		if (telegram !== undefined) await telegram.edit(decision.cardDestination, decision.cardMessageId, `${decision.action === "approve" ? `已批准 · ${decision.minutes} 分钟` : "已拒绝"} · ${by}\n任务 #${decision.scope}\n${decision.command.slice(0, 2500)}`, []);
	} else if (connected()) await channel.updateCard(decision.cardMessageId, approvalCard(decision.scope, decision.trigger, decision.command, decision.match, decision.action === "approve" ? { kind: "approved", minutes: decision.minutes, by } : { kind: "denied", by }));
}

/** 命令参数解析：@提及 → openId+姓名（SDK 已把占位符渲染成名字，见 matchMention）；否则原样返回。 */
function resolveArg(parts: string[], msg: NormalizedMessage): { id: string; name: string } | null {
	const arg = parts[1];
	if (arg === undefined) return null;
	return matchMention(arg, msg.mentions) ?? { id: arg, name: arg };
}

/** 命令权限矩阵：/new owner|admin；/cancel admin；/allow /deny admin。 */
async function runCommand(text: string, conversation: Conversation, msg: NormalizedMessage, target: ReplyTarget, receipt?: TelegramCommandReceipt): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const parts = text.split(/\s+/);
	const cmd = parts[0];
	const convId = conversation.id as number;
	const owner = sessions.ownerOf(conversation.id) ?? "";
	const admin = users.isAdmin(msg.senderId);
	const isOwner = msg.senderId === owner;

	switch (cmd) {
		case "/ask":
			await replyTo(target, `请在命令后写下任务，例如：/ask@${telegram!.identity.username} 帮我整理这段文字。\n也可以附上图片或文件；私聊可直接发送内容。\n发送 /help 查看完整用法。`, conversation);
			break;
		case "/start":
		case "/help": {
			if (msg.platform === "telegram") {
				const bot = `@${telegram!.identity.username}`;
				const guide = [
					`私聊：直接发送文字、图片或文件，也可使用 /ask 内容。`,
					`群聊：使用 /ask${bot} 内容，或回复 ${bot} 的消息继续；群聊需先获准使用。`,
					"/new：开启新任务线，原任务线与历史消息保留（线主/管理员）",
					"/newgoal：开启新目标，保留聊天历史与旧任务记录（线主/管理员）",
					"/cancel：中止当前任务，不会取消后台任务（线主/管理员）",
					users.isAllowed(msg.senderId) ? "/approve [分钟]：开启危险命令批准窗口，默认 10 分钟" : "危险操作：需 dwell 管理员点击审批卡批准，群成员不能自行 /approve",
					"/deny：关闭批准窗口并取消待审请求",
					"/whoami：查看你的 ID 和当前聊天 ID",
					"/help：查看完整使用说明",
					...(cmd === "/help" && admin ? ["管理员命令：", "/status：查看运行中任务", "/allow tg:用户ID [admin]、/disallow tg:用户ID：授权或封禁用户", "/allowgroup、/disallowgroup：在目标群开放全体成员或停用本群，无需填写 ID", "/allowchat [负数群ID]、/disallowchat [负数群ID]：仅允许已授权用户或停用群（群内可省略 ID）", "/chats：查看各群的开放模式"] : []),
				];
				await replyTo(target, guide.join("\n"), conversation);
				break;
			}
			const sent = await channel.send(target.chatId, { card: helpCard() }, { replyTo: target.messageId });
			await sessions.anchor(sent.messageId, conversation.id);
			break;
		}
		case "/whoami":
			await replyTo(target, `你的 ID：${msg.senderId}${users.isAdmin(msg.senderId) ? "（管理员）" : ""}${target.destination?.kind === "telegram" ? `；聊天 ID：${target.destination.chatId}` : ""}`);
			break;
		case "/newgoal": {
			if (!isOwner && !admin) {
				await replyTo(target, "这是他人的任务线，仅线主或管理员可开启新目标。");
				return;
			}
			const requestId = `command:${msg.requestId ?? msg.messageId}`;
			const previous = receipt === undefined ? (await harness.snapshot(NewGoalDoc, conversation.id, context))?.requests[requestId] : undefined;
			const expectedWorkId = receipt === undefined ? previous === undefined ? (await getWork(harness, convId)).current ?? null : previous.workId : receipt.newGoalWorkId ?? null;
			let result;
			try { result = await beginNewGoal(harness, { conversationId: convId, expectedWorkId, operator: msg.senderId, requestId }); }
			catch (error) { await replyTo(target, (error as Error).message); return; }
			await replyTo(target, result.changed ? "已开启新目标。聊天历史、旧任务记录和预算保留，请发送新的目标。" : "当前没有工作目标，请直接发送新的目标。", conversation);
			break;
		}
		case "/new":
			if (!isOwner && !admin) {
				await replyTo(target, "这是他人的任务线，仅线主或管理员可重置。");
				return;
			}
			const next = msg.platform === "telegram" ? await sessions.forTelegram(msg, msg.requestId!, sessions.isActorScoped(convId)) : await sessions.forFeishu(msg, msg.requestId ?? msg.messageId);
			await sessions.anchor(msg.messageId, next.id);
			await replyTo(target, "已开启新任务线，原任务线与历史消息保留。", next);
			break;
		case "/status": {
			if (!admin) {
				await replyTo(target, "/status 仅管理员可用。");
				return;
			}
			const graphState = await harness.taskGraph?.(context);
			let tasks: TaskGraphNode[] = [];
			try {
					tasks = Object.values((graphState?.value as TaskGraph | undefined)?.tasks ?? {});
				} finally {
					graphState?.dispose();
			}
			if (tasks.length === 0) {
				await replyTo(target, "当前无任务运行。");
				break;
			}
			// 聚合到任务线：一个 run 的 tool/generation 图节点不逐条展示，只报线级状态与人能认识的标签
			const byConv = new Map<number, TaskGraphNode[]>();
			for (const t of tasks) {
				const id = t.conversationId as number;
				const list = byConv.get(id);
				if (list === undefined) byConv.set(id, [t]);
				else list.push(t);
			}
			const convs = sessions.listConversations();
			const lines = await Promise.all([...byConv.entries()].map(async ([convId, ts]) => {
				const conv = convs.find((c) => c.id === convId);
				const owner = sessions.ownerOf(convId as ConversationId) ?? "";
				const ownerName = owner.startsWith("tg:") ? owner : owner !== "" && owner !== "panel" ? await directory.userName(owner) : undefined;
				let label = sessions.nameOf(convId);
				if (label === undefined && conv?.type === "group" && conv.chatId !== null) {
					const chatName = conv.platform === "telegram" ? `Telegram ${conv.chatId}` : await directory.chatName(conv.chatId);
					label = `${sessions.emojiOf(convId) ?? "▫️"} ${chatName ?? "群聊"} · ${ownerName ?? conv.owner.slice(-6)}`;
				} else if (label === undefined && conv?.type === "thread" && conv.chatId !== null) {
					const chatName = conv.platform === "telegram" ? `Telegram ${conv.chatId}` : await directory.chatName(conv.chatId);
					label = `${chatName ?? "群聊"} · 话题`;
				} else if (label === undefined && conv?.type === "direct") {
					label = `私聊 · ${ownerName ?? "?"}`;
				} else if (label === undefined) {
					label = "panel 任务";
				}
				const abort = ts.some((t) => t.abortRequested);
				const sleeper = ts.find((t) => t.state.status === "sleeping")?.state as Extract<TaskGraphState, { status: "sleeping" }> | undefined;
				const state = ts.some((t) => t.state.status === "running") ? "运行中"
					: sleeper !== undefined ? `休眠至 ${new Date(sleeper.until ?? 0).toLocaleTimeString("zh-CN", { hour12: false })}`
					: "排队中";
				return `**${state}${abort ? " · ⏹ 已请求中止" : ""}** · ${label}`;
			}));
			if (msg.platform === "telegram") await replyTo(target, lines.join("\n"), conversation);
			else {
				const sent = await channel.send(target.chatId, { card: statusCard(lines) }, { replyTo: target.messageId });
				await sessions.anchor(sent.messageId, conversation.id);
			}
			break;
		}
		case "/cancel":
			if (!isOwner && !admin) {
				await replyTo(target, "仅线主或管理员可中止当前任务。");
				return;
			}
			if (receipt !== undefined) {
				await telegramInbox.cancelInputs(receipt.cancelInputIds ?? []);
				telegramWorkers.cancel(receipt.cancelInputIds ?? []);
				for (const id of receipt.cancelInputIds ?? []) { telegramPreparationActivities.get(id)?.(); telegramPreparationActivities.delete(id); }
				if (receipt.cancelTaskId !== undefined) await harness.abortTask(receipt.cancelTaskId as TaskId, context);
			} else await conversation.abort(context);
			await replyTo(target, "已中止当前任务。");
			break;
		case "/approve": {
			if (!users.isAllowed(msg.senderId)) {
				await replyTo(target, "群成员任务的危险操作需 dwell 管理员点击审批卡批准；你可以用 /deny 拒绝自己的请求。");
				return;
			}
			const minutes = clampMinutes(Number(parts[1]) || 10);
			const key = windowKey(convId, msg.senderId);
			if (receipt?.approvalRequestId && pendingApprovals.get(key)?.requestId !== receipt.approvalRequestId) {
				await replyTo(target, "原审批请求已处理或失效，未更改新的请求。");
				break;
			}
			if (receipt?.approvalRequestId === "" && pendingApprovals.has(key)) {
				await replyTo(target, "当前待审请求晚于这条命令，请重新发送 /approve。");
				break;
			}
			const decision = await takeDecision(key, "approve", minutes, target, receipt?.approvalRequestId);
			if (decision !== undefined) {
				void replyTo(target, `已批准：本任务线 ${minutes} 分钟内由你触发的危险命令免拦截，继续执行。`).catch((err: unknown) => console.error("[dwell] 审批通知失败:", err));
				const result = await replayApprovalDecisions(decision.id, (saved) => updateApprovalPresentation(saved, msg.platform === "telegram" ? "Telegram 命令" : "飞书命令"));
				if (result.unavailable > 0) await replyTo(target, "部分后台任务已停止，无法续跑。", conversation);
				if (result.pending > 0) await replyTo(target, "审批已保存，部分续跑尚未接纳，将自动重试。", conversation);
			} else {
				if (receipt?.approvalRequestId) { await replyTo(target, "原审批请求已处理或变更，未开新窗口。"); break; }
				// 预授：没有待审命令，只开窗口，不唤醒模型
				const granted = await grantApprovalWindow(key, minutes, receipt === undefined ? undefined : receipt.createdAt + minutes * 60_000, receipt === undefined ? undefined : { previousExpiresAt: receipt.windowExpiresAt, noPending: true });
				const otherPending = [...pendingApprovals].some(([otherKey]) => otherKey.startsWith(`${convId}:`) && otherKey !== key);
				await replyTo(target, granted ? `已预先批准：本任务线 ${minutes} 分钟内仅由你触发的危险命令免拦截。${otherPending ? "\n他人的待审请求尚未处理；有审批权限的人可点击原请求的按钮，或请原触发者发送 /approve。" : ""}` : "审批状态已变化，请重新发送 /approve。");
			}
			break;
		}
		case "/deny": {
			const revoked = receipt?.denial ?? captureApprovalRevocation(convId, admin ? undefined : msg.senderId);
			const cards = revoked.pending.flatMap(([key, requestId]) => {
				const pending = pendingApprovals.get(key);
				return pending?.requestId === requestId ? [{ ...structuredClone(pending), scope: Number(key.split(":")[0]), action: "deny" as const, minutes: 0 }] : [];
			});
			if (receipt?.denial !== undefined) await revokeApprovalSnapshot(receipt.denial);
			else if (admin) {
				// 管理员：关闭该任务线全部窗口与待审请求（救场）
				await revokeApprovalWindows(convId);
			} else await revokeApprovalWindows(convId, msg.senderId);
			for (const card of cards) void updateApprovalPresentation(card, msg.platform === "telegram" ? "Telegram 命令" : "飞书命令").catch((error: unknown) => console.error("[dwell] 审批卡片更新失败:", error));
			await replyTo(target, receipt?.denial !== undefined ? "已关闭这条命令记录的批准窗口与待审请求。" : admin ? "已关闭本任务线的全部批准窗口。" : "已关闭你的批准窗口并取消待审请求。");
			break;
		}
		case "/allow": {
			if (!admin) {
				await replyTo(target, "/allow 仅管理员可用。");
				return;
			}
			const who = resolveArg(parts, msg);
			if (who === null || !(who.id.startsWith("ou_") || /^tg:\d+$/.test(who.id))) {
				await replyTo(target, "用法：/allow @某人 [admin]，或 /allow tg:用户ID [admin]");
				return;
			}
			await users.add(who.id, parts[2] === "admin" ? "admin" : "member", msg.platform === "telegram" ? msg.requestId : undefined);
			await replyTo(target, `已添加 ${who.name} 为${parts[2] === "admin" ? "管理员" : "成员"}（立即生效）。`);
			break;
		}
		case "/disallow": {
			if (!admin) {
				await replyTo(target, "/disallow 仅管理员可用。");
				return;
			}
			const who = resolveArg(parts, msg);
			if (who === null || !(who.id.startsWith("ou_") || /^tg:\d+$/.test(who.id))) {
				await replyTo(target, "用法：/disallow @某人，或 /disallow tg:用户ID");
				return;
			}
			if (users.isAdmin(who.id) && users.adminCount() <= 1) {
				await replyTo(target, "无法移除最后一名管理员（会自锁）。");
				return;
			}
			try { await users.remove(who.id, msg.platform === "telegram" ? msg.requestId : undefined, true); }
			catch (error) {
				if (error instanceof Error && error.message.includes("最后一名管理员")) { await replyTo(target, error.message); break; }
				throw error;
			}
			await replyTo(target, `已封禁 ${who.name}，群成员开放也不会绕过封禁；/allow 可解除。`);
			break;
		}
		default:
			await replyTo(target, `未知命令 ${cmd}，回复 /help 查看可用命令。`);
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
				cmd("/new", "开启新任务线，保留原任务线与历史消息（线主/管理员）"),
				cmd("/newgoal", "开启新目标，保留聊天历史与旧任务记录（线主/管理员）"),
				cmd("/status", "查看运行中任务（管理员）"),
				cmd("/cancel", "中止当前任务（线主/管理员；不影响后台任务）"),
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
	const value = (action: string, minutes = 0) => ({ action, minutes, conversationId, sender, requestId: pendingApprovals.get(windowKey(conversationId, sender))?.requestId });
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
		// 群/话题线回复该线锚点（成员看得出属于哪条任务；话题线发回话题内），私聊直接发
		const kind = sessions.listConversations().find((c) => c.id === conversationId)?.type;
		const anchor = kind === undefined || kind === "direct" ? undefined : sessions.lastAnchor(conversationId as ConversationId);
		const sent = await channel.send(
			chatId,
			{ card: approvalCard(conversationId, sender, command, match, { kind: "request" }) },
			anchor === undefined ? undefined : { replyTo: anchor, replyInThread: kind === "thread" },
		);
		// 记下卡片位置：panel 做出决定时同步卡片状态，并把续跑结果回复到卡片下
		const pending = pendingApprovals.get(windowKey(conversationId, sender));
		if (pending !== undefined) {
			await setPendingApprovalCard(windowKey(conversationId, sender), pending, chatId, sent.messageId);
		}
		await sessions.anchor(sent.messageId, conversationId as ConversationId);
	} catch (err) {
		console.error("[dwell] 审批卡片发送失败:", err);
	}
}

const connected = (): boolean => (channel as LarkChannel | undefined) !== undefined;

/** 发到会话所在 chat；群聊线/话题线回复该线最近的消息，让群成员看出属于哪条任务（话题内发到话题里）。input 为 SDK SendInput（markdown/图片/文件…）。 */
async function sendToConversationChat(conversationId: number, input: SendInput): Promise<ReplyTarget | undefined> {
	const destination = sessions.destinationOf(conversationId);
	if (destination.kind === "telegram") {
		if (telegram === undefined || !telegramChatAllowed(destination)) return undefined;
		const replyTo = sessions.lastAnchor(conversationId as ConversationId);
		let sent;
		if ("markdown" in input || "text" in input) sent = await telegram.send(destination, "markdown" in input ? input.markdown : input.text, { replyTo, format: "markdown" in input ? "markdown" : "plain" });
		else if ("file" in input || "image" in input) {
			const source = "file" in input ? input.file.source : input.image.source;
			if (!Buffer.isBuffer(source)) throw new Error("Telegram 文件发送需要已校验的文件内容");
			sent = await telegram.sendFile(destination, source, "file" in input ? input.file.fileName : "image.png", { replyTo, image: "image" in input });
		} else throw new Error("Telegram 不支持此消息格式");
		for (const messageId of sent.messageIds) await sessions.anchor(messageId, conversationId as ConversationId);
		return { chatId: telegramChatKey(destination.botId, destination.chatId), messageId: sent.messageId, destination };
	}
	const chatId = sessions.chatOf(conversationId);
	if (chatId === undefined || !connected()) return undefined;
	const kind = sessions.listConversations().find((c) => c.id === conversationId)?.type;
	const anchor = kind === "direct" ? undefined : sessions.lastAnchor(conversationId as ConversationId);
	const sent = await channel.send(chatId, input, anchor === undefined ? undefined : { replyTo: anchor, replyInThread: kind === "thread" });
	return { chatId, messageId: sent.messageId };
}

/** panel 操作在飞书侧与模型上下文中一律以「管理员」指代，不备注具体名字 */
const OPERATOR_LABEL = "管理员";

const feishuBridge: FeishuBridge = {
	operator: () => panelUser,
	// 长连接状态供 /healthz：panel-only 未连接为 "off"；已连接但 WS 尚未就绪按 "connecting" 计
	status: () => (connected() ? (channel.getConnectionStatus()?.state ?? "connecting") : "off"),
	async relay(conversation, text, attachments) {
		const id = conversation.id as number;
		const destination = sessions.destinationOf(id);
		if (destination.kind === "panel" || (destination.kind === "feishu" && !connected()) || (destination.kind === "telegram" && !telegramChatAllowed(destination))) throw new Error("会话聊天入口未连接，未提交模型");
		// 附件先以图片/文件消息发到原 chat（可见转发，panel 不设隐藏通道），每条登记锚点：回复附件即续接任务线
		if (attachments !== undefined && attachments.length > 0) {
			const cwd = (await conversation.agent(BACKGROUND_CONTEXT)).cwd;
			if (cwd === undefined) throw new Error("该会话没有工作目录");
			for (const a of attachments) {
				const { buffer, name } = await readWorkspaceFile(a.path, fileGuardBases(cwd), 30 * 1024 * 1024, BACKGROUND_CONTEXT);
				const input: SendInput = sniffImageMime(buffer) !== null && buffer.length <= 10 * 1024 * 1024
					? { image: { source: buffer } }
					: { file: { source: buffer, fileName: name } };
				const sent = await sendToConversationChat(id, input);
				if (sent === undefined) throw new Error("该会话聊天入口不可用");
				await sessions.anchor(sent.messageId, conversation.id);
			}
		}
		// 飞书侧以「From admin:」前缀 + 整段斜体呈现，和成员自己的消息区分；逐段包斜体（markdown 强调不跨空行）
		const ital = (t: string) => t.split(/\n{2,}/).map((p) => (p.trim() !== "" ? `*${p}*` : p)).join("\n\n");
		const visible = `From admin: ${text.trim() === "" ? "（附件）" : text}`;
		const sent = await sendToConversationChat(id, destination.kind === "telegram" ? { text: visible } : { markdown: ital(visible) });
		if (sent === undefined) throw new Error("该会话聊天入口不可用");
		await sessions.anchor(sent.messageId, conversation.id);
		sessions.touchActivity(conversation.id);
		// 飞书侧有新动静的线不再留在归档组
		if (sessions.isArchived(id)) await sessions.setArchived(id, false);
		await setRunAttributionIfIdle(id, panelUser, destination.kind);
		// 提交内容与 panel 会话同规则：文本 + 各附件 part 合并
		const content = [text.trim(), ...(attachments ?? []).map((a) => a.part)].filter((s) => s !== "").join("\n\n");
		const requestId = `panel-${sent.messageId}`;
		const receiptId = destination.kind === "telegram" ? `tg-panel:${destination.botId}:${sent.messageId}` : undefined;
		if (receiptId !== undefined && destination.kind === "telegram") {
			await telegramInbox.prepare(receiptId, { conversationId: id, sender: panelUser, authorityVia: "panel", destination, replyTo: sent.messageId, requestId }, async () => content);
		}
		if (!conversationActorAllowed(panelUser, id, "panel")) throw new Error("输入提交前使用权限已撤销，未启动模型。");
		const submission = await conversation.submit({
			type: "input",
			content,
			entry: { kind: "chat.message", data: { sender: panelUser, senderName: OPERATOR_LABEL, via: "panel" } },
			requestId,
			whenBusy: conversationInputMode(conversation.id),
		}, BACKGROUND_CONTEXT);
		if (receiptId !== undefined) {
			await telegramInbox.admitted(receiptId, submission.id as number);
			void replyTelegram(receiptId, conversation, submission);
		} else void submitAndReply(conversation, submission, sent);
	},
	async notice(conversationId, text) {
		// 通知也锚定到任务线：回复通知即在原线上继续
		try {
			const sent = await sendToConversationChat(conversationId, { markdown: text });
			if (sent !== undefined) await sessions.anchor(sent.messageId, conversationId as ConversationId);
		} catch (err: unknown) {
			console.error("[dwell] 飞书通知发送失败:", err);
		}
	},
	async notifyPanel(conversationId, status, text) {
		const name = sessions.nameOf(conversationId) ?? `任务 #${conversationId}`;
		const link = process.env.DWELL_PANEL_URL ? `\n[打开 panel](${process.env.DWELL_PANEL_URL}?conv=${conversationId})` : "";
		try {
			if (panelUser.startsWith("tg:")) {
				if (telegram === undefined) return;
				const sent = await telegram.send(telegramPrivate(panelUser), `任务${status} · ${name}\n\n${text.slice(0, 200)}${text.length > 200 ? "…" : ""}${link}`);
				for (const messageId of sent.messageIds) await sessions.anchor(messageId, conversationId as ConversationId);
				return;
			}
			if (!connected()) return;
			// 私发给操作者；消息锚到任务线，回复这条通知即在该任务线上继续
			const sent = await channel.send(panelUser, { markdown: `**任务${status}** · ${name}\n\n${text.slice(0, 200)}${text.length > 200 ? "…" : ""}${link}` });
			await sessions.anchor(sent.messageId, conversationId as ConversationId);
		} catch (err) {
			console.error("[dwell] panel 任务通知发送失败:", err);
		}
	},
	async decide(key, action, minutes, requestId) {
		let decision: ApprovalDecision | undefined;
		try { decision = await takeDecision(key, action, minutes, undefined, requestId ?? pendingApprovals.get(key)?.requestId); }
		catch (err) { console.error("[dwell] 审批决定保存失败:", err); return { ok: false, error: "审批保存失败，请重试" }; }
		if (decision === undefined) return { ok: false, error: "该请求已失效" };
		const present = async (): Promise<void> => {
			await updateApprovalPresentation(decision, "panel");
		};
		const result = await replayApprovalDecisions(decision.id, present);
		return result.pending > 0 ? { ok: false, error: "审批已保存，续跑尚未接纳，将自动重试" }
			: result.unavailable > 0 ? { ok: false, error: "部分任务已停止或不存在，无法续跑" } : { ok: true };
	},
};

async function deliverApprovalDecision(decision: ApprovalDecision, target: ApprovalTarget): Promise<"accepted" | "unavailable"> {
	if (!conversationActorAllowed(decision.trigger, decision.scope, decision.via)) return "unavailable";
	const content = decisionInput(decision.action, decision.minutes, decision.expiresAt);
	const deliveryId = `approval:${decision.id}:${target.conversationId}`;
	if (target.conversationId !== decision.scope) {
		const accepted = await backgroundDeliverer.deliver(decision.scope, target.conversationId, content, {
			deliveryId, sender: decision.trigger, via: decision.via, action: decision.action, minutes: decision.minutes, expiresAt: decision.expiresAt,
			...(target.budgetId === undefined ? {} : { budgetId: target.budgetId }),
		});
		return accepted ? "accepted" : "unavailable";
	}
	const conversation = await harness.conversation(decision.scope as ConversationId, BACKGROUND_CONTEXT);
	if (conversation === undefined) return "unavailable";
	await setRunAttributionIfIdle(decision.scope, decision.trigger, decision.via);
	if (!conversationActorAllowed(decision.trigger, decision.scope, decision.via)) return "unavailable";
	const submission = await conversation.submit({
		type: "input", content, whenBusy: "followUp", requestId: deliveryId,
		entry: { kind: target.budgetId === undefined ? "dwell.approval.legacy" : "dwell.approval", data: { sender: decision.trigger, via: decision.via, ...(target.budgetId === undefined ? {} : { budgetId: target.budgetId }) } },
	}, BACKGROUND_CONTEXT);
	const reply: ReplyTarget | undefined = decision.reply ?? (decision.cardMessageId === undefined || decision.cardChatId === undefined ? undefined : { chatId: decision.cardChatId, messageId: decision.cardMessageId, destination: decision.cardDestination });
	if (reply !== undefined && (reply.destination?.kind === "telegram" ? telegram !== undefined : connected())) {
		if (reply.destination?.kind === "telegram") await presentTelegramSubmission(conversation, submission, reply);
		else if ((await submission.status(BACKGROUND_CONTEXT)).status === "queued") void submitAndReplyPlain(conversation, submission, reply).catch((error: unknown) => console.error("[dwell] 排队审批续跑回复失败:", error));
		else void submitAndReply(conversation, submission, reply);
	}
	else void submission.wait(BACKGROUND_CONTEXT).catch(() => {});
	return "accepted";
}

let approvalReplayTimer: ReturnType<typeof setTimeout> | undefined;
let approvalReplayDelay = 1000;
async function replayApprovalDecisions(decisionId?: string, present?: (decision: ApprovalDecision) => Promise<void>): Promise<{ pending: number; unavailable: number }> {
	const result = await drainApprovalDecisions(deliverApprovalDecision, decisionId, present);
	const hasPending = [...approvalDecisions.values()].some((decision) => decision.deliveryTargets.some((target) => target.status === "pending"));
	if (hasPending && approvalReplayTimer === undefined) {
		approvalReplayTimer = setTimeout(() => {
			approvalReplayTimer = undefined;
			void replayApprovalDecisions().catch((error: unknown) => console.error("[dwell] 审批续跑重试失败:", error));
		}, approvalReplayDelay);
		approvalReplayTimer.unref();
		approvalReplayDelay = Math.min(60_000, approvalReplayDelay * 2);
	} else if (!hasPending) {
		if (approvalReplayTimer !== undefined) clearTimeout(approvalReplayTimer);
		approvalReplayTimer = undefined;
		approvalReplayDelay = 1000;
	}
	return result;
}

async function runFailureReason(conversationId: number, settled: SubmissionRecord): Promise<string> {
	let budgetId = `${conversationId}:${String(settled.id)}`;
	if (settled.entry !== undefined) {
		const entry = await harness.commit((tx) => tx.entry(settled.entry!), BACKGROUND_CONTEXT);
		if (entry?.kind === "dwell.approval" && typeof entry.data === "object" && entry.data !== null && "budgetId" in entry.data && typeof entry.data.budgetId === "string") budgetId = entry.data.budgetId;
	}
	const reason = await runtimeBudgets(harness)?.stopReason(conversationId, budgetId);
	const labels = { model_limit: "模型请求次数达到上限", tool_limit: "工具调用次数达到上限", execution_limit: "执行时间达到上限", unknown_budget: "无法恢复原运行预算", storage_error: "无法可靠保存运行预算" };
	if (reason !== undefined) return `运行预算已停止任务：${labels[reason]}`;
	const workReason = await workBudgetStopReason(harness, conversationId, budgetId);
	if (workReason !== undefined) return `工作预算已停止任务：${labels[workReason]}`;
	if (settled.status === "unanswered" && settled.reason === "model_error") return modelFailure(typeof settled.detail === "string" ? settled.detail : "").message;
	return settled.status === "unanswered" ? settled.reason : settled.status;
}

/** 卡片按钮回调：触发者/conversation owner/admin 可审，其余忽略。 */
async function handleCardAction(evt: CardActionEvent): Promise<void> {
	try {
		await handleCardActionInner(evt);
	} catch (err) {
		console.error("[dwell] 卡片回调处理出错:", err);
	}
}

async function handleCardActionInner(evt: CardActionEvent): Promise<void> {
	const v = evt.action.value as { action?: string; minutes?: number; conversationId?: number; sender?: string; requestId?: string } | undefined;
	if (v?.action !== "approve" && v?.action !== "deny") return;
	if (!users.isAllowed(evt.operator.openId)) return;
	const conversationId = v.conversationId;
	if (conversationId === undefined || v.sender === undefined) return;
	// 卡片上的 conversationId 是审批 scope（后台子会话已归并到父线）；归属校验按 scope 的 owner
	const scope = scopeOf(conversationId);
	const owner = sessions.ownerOf(scope as ConversationId) ?? "";
	if (evt.operator.openId !== v.sender && evt.operator.openId !== owner && !users.isAdmin(evt.operator.openId)) {
		console.log(`[dwell] 卡片审批被忽略：operator 非触发者/owner/admin`);
		return;
	}

	const key = windowKey(scope, v.sender);
	const action = v.action === "approve" ? "approve" : "deny";
	const minutes = clampMinutes(v.minutes ?? 10);
	if (typeof v.requestId !== "string" || v.requestId.length === 0) return;
	const decision = await takeDecision(key, action, minutes, { chatId: evt.chatId, messageId: evt.messageId }, v.requestId);
	if (decision === undefined) return; // 历史卡/已处理：点击无效，防隔夜开窗
	const state = action === "approve" ? { kind: "approved" as const, minutes } : { kind: "denied" as const };
	await replayApprovalDecisions(decision.id, () => channel.updateCard(evt.messageId, approvalCard(scope, decision.trigger, decision.command, decision.match, state)));
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// Node ≥15 默认把 unhandledRejection 当致命错拖垮整个进程（飞书 bot 同进程）：兜底记日志不退出
process.on("unhandledRejection", (reason) => {
	console.error("[dwell] 未处理的 rejection:", reason);
});
/** 重启后为活跃 run 重挂流式镜像卡：镜像 live 文本至 run 结束并补齐最终答案（tool 行不重放，只保结果可见）。 */
async function reattachStreams(): Promise<void> {
	if (!connected()) return;
	const context = BACKGROUND_CONTEXT;
	const graphState = await harness.taskGraph?.(context);
	try {
		// 只重挂真正有活跃 run（pi.generation）的会话：后台 compaction 等任务没有 pi.live.run，挂卡只会把上一轮旧答案当续跑结果重发
		for (const id of runConversations(graphState?.value)) {
			const chatId = sessions.chatOf(id);
			if (chatId === undefined) continue;
			const conversation = await harness.conversation(id as ConversationId, context);
			if (conversation === undefined) continue;
			const live = await harness.snapshot(LiveDoc, conversation.id, context);
			const input = live?.run?.inputs[0];
			if (input === undefined) continue;
			const kind = sessions.listConversations().find((c) => c.id === id)?.type;
			const autonomousAnchor = kind === "direct" ? undefined : sessions.lastAnchor(id as ConversationId);
			if (await feishuDeliveries?.adoptActive({ conversationId: id, submissionId: input as number, chatId, ...(autonomousAnchor === undefined ? {} : { replyTo: autonomousAnchor, replyInThread: kind === "thread" }) })) continue;
			const submission = await harness.submission(input, context);
			if (submission === undefined) continue;
			console.log(`[dwell] 重启后续跑 #${id}，重挂流式卡`);
			const anchor = sessions.lastAnchor(id as ConversationId);
			let streamed = "";
			void (async () => {
				try {
					const sent = await channel.stream(
						chatId,
						{ markdown: async (s) => {
							streamed = await mirrorStream(conversation, submission, s);
						} },
						anchor === undefined ? undefined : { replyTo: anchor },
					);
					if (streamed !== "") await finalizeCard(chatId, sent.messageId, streamed);
					await sessions.anchor(sent.messageId, id as ConversationId);
				} catch (err) {
					console.error(`[dwell] 续跑镜像卡失败 #${id}:`, err instanceof Error ? err.message : err);
				}
			})();
		}
	} finally {
		graphState?.dispose();
	}
}

/** Reattach only the captured input; later runs and historical answers belong to other cards. */
async function mirrorStream(conversation: Conversation, submission: Awaited<ReturnType<Conversation["submit"]>>, s: MarkdownStreamController): Promise<string> {
	const keeper = cardKeeper(s);
	try {
		const label = lineLabel(conversation.id as number);
		if (label !== undefined) await keeper.append(`${label}\n\n`);
		await keeper.append("（服务重启，任务续跑中）\n\n");
		await mirrorRestoredSubmission(conversation, submission, keeper.append, (settled) => runFailureReason(conversation.id as number, settled));
	} finally {
		keeper.stop();
	}
	return keeper.full();
}

function shutdown(code = 0): Promise<void> {
	shutdownCode = Math.max(shutdownCode, code);
	return shutdownPromise ??= (async () => {
		ready = false;
		console.log("[dwell] 关闭中…");
		// Media and SDK shutdown may stall; durable receipts retain unfinished work for restart.
		const deadline = setTimeout(() => { console.error("[dwell] 关闭超过 30 秒，强制退出"); process.exit(1); }, 30_000);
		const panelClosed = panel === undefined ? Promise.resolve() : new Promise<void>((resolve) => panel!.close(() => resolve()));
		telegramWorkers?.stop();
		for (const stop of telegramPreparationActivities.values()) stop();
		telegramPreparationActivities.clear();
		if (approvalReplayTimer !== undefined) clearTimeout(approvalReplayTimer);
		const feishuClosed = feishuDeliveries?.close();
		try {
			const closed = await Promise.allSettled([telegram?.close(), telegramWorkers?.close(), channel?.disconnect()]);
			if (closed.some((result) => result.status === "rejected")) { shutdownCode = 1; console.error("[dwell] 聊天入口关闭失败"); }
			await feishuClosed;
			await harness?.close(BACKGROUND_CONTEXT);
			await runtimeTelemetry(harness)?.close();
			panel?.closeAllConnections();
			await panelClosed;
		} catch { shutdownCode = 1; console.error("[dwell] 运行时关闭失败"); }
		finally { clearTimeout(deadline); process.exit(shutdownCode); }
	})();
}

// 启动失败必须遇错即遇（退出码非 0，systemd/docker 可感知重启）；不走 unhandledRejection 兜底（那会挂着不退）
void main().catch((err: unknown) => {
	console.error("[dwell] 启动失败:", err);
	process.exit(1);
});
