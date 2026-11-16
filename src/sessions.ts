// 会话路由与映射：chat_id（私聊）/ (chat,sender)（群平消息）/ (chat,thread)（话题群）→ conversation；
// replyTo 命中 message-map 则跟随该任务线。messageMap 持久化，上限淘汰 + 显式降级。
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure, defineDoc, type Conversation, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { MODEL } from "./harness.ts";
import { messageDestination, sameDestination, type ConversationDestination, type NormalizedMessage } from "./pipeline.ts";
import { DATA_DIR, stateFile, writeStateJson } from "./state.ts";

const MAP_LIMIT = 10_000;

type SavedRoute = { id: number; owner: string; name?: string; archived?: boolean; lastTs?: number; notify?: boolean; emoji?: string; destination?: ConversationDestination };
type BotDestination = Exclude<ConversationDestination, { kind: "panel" }>;
type BotRoute = { id: number; owner: string; destination: BotDestination };
type BotRouteState = { routes: Record<string, BotRoute>; resets: Record<string, { key: string; id: number }> };

// Route changes and /new receipts share the conversation's SQLite commit. JSON is a projection.
// Keep the original document kind so existing Telegram receipts remain replayable.
export const TelegramSessionDoc = defineDoc<BotRouteState>({
	kind: "dwell.telegram-sessions", version: 1, scope: "session",
	initial: () => ({ routes: {}, resets: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

/** 群平消息线回复卡首行标签的 emoji 池（同 chat 内唯一分配）。 */
export const LINE_EMOJI_POOL = ["🔵", "🟢", "🟣", "🟠", "🟡", "🔴", "🟤", "⚫", "🔷", "🔶"];

/** 纯分配逻辑：优先未占用；池满则转移最久未活跃线的 emoji（正常群到不了 10 条活跃线，边界兑底）。 */
export function allocateEmoji(active: { id: number; emoji?: string; lastTs: number }[], pool: readonly string[] = LINE_EMOJI_POOL): { emoji: string; stealFrom?: number } {
	const taken = new Map<string, number>();
	for (const line of active) if (line.emoji !== undefined) taken.set(line.emoji, line.id);
	for (const e of pool) if (!taken.has(e)) return { emoji: e };
	let oldest: { id: number; lastTs: number } | undefined;
	for (const line of active) {
		if (line.emoji === undefined) continue;
		if (oldest === undefined || line.lastTs < oldest.lastTs) oldest = { id: line.id, lastTs: line.lastTs };
	}
	if (oldest === undefined) return { emoji: pool[0] };
	return { emoji: active.find((l) => l.id === oldest.id)!.emoji!, stealFrom: oldest.id };
}

export class Sessions {
	private convKeys = new Map<string, ConversationId>(); // 路由键 → conversation
	private pendingRoutes = new Map<string, Promise<Conversation>>();
	private owners = new Map<ConversationId, string>(); // conversation → owner open_id
	private names = new Map<ConversationId, string>(); // conversation → 显示名（panel 重命名）
	private archived = new Set<ConversationId>(); // 归档（panel 隐藏，不删数据）
	private notify = new Set<ConversationId>(); // panel 任务飞书通知开关
	private emojis = new Map<ConversationId, string>(); // 群平消息线的标签 emoji（同 chat 内唯一）
	private lastTs = new Map<ConversationId, number>(); // conversation → 最后活动时间戳（panel 排序）
	private messageMap = new Map<string, ConversationId>(); // messageId → conversation（任务线锚点）
	private destinations = new Map<ConversationId, ConversationDestination>();
	private telegramChain: Promise<unknown> = Promise.resolve();
	private file = stateFile("sessions.json");
	private mapFile = stateFile("message-map.json");
	private harness: Harness;
	private prepareWorkspace: (cwd: string) => Promise<void>;

	constructor(harness: Harness, prepareWorkspace: (cwd: string) => Promise<void>) {
		this.harness = harness;
		this.prepareWorkspace = prepareWorkspace;
	}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.file, "utf8")) as Record<string, SavedRoute>;
			for (const [key, v] of Object.entries(saved)) {
				if (v.emoji !== undefined) this.emojis.set(v.id as ConversationId, v.emoji);
				this.convKeys.set(key, v.id as ConversationId);
				this.owners.set(v.id as ConversationId, v.owner);
				if (v.name !== undefined) this.names.set(v.id as ConversationId, v.name);
				if (v.archived === true) this.archived.add(v.id as ConversationId);
				if (v.lastTs !== undefined) this.lastTs.set(v.id as ConversationId, v.lastTs);
				if (v.notify === true) this.notify.add(v.id as ConversationId);
				if (v.destination !== undefined) this.destinations.set(v.id as ConversationId, v.destination);
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[dwell] sessions.json 损坏，任务线映射将重建:", err);
		}
		try {
			const saved = JSON.parse(await readFile(this.mapFile, "utf8")) as Record<string, number>;
			for (const [mid, cid] of Object.entries(saved)) this.messageMap.set(mid, cid as ConversationId);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[dwell] message-map.json 损坏，replyTo 路由将全部降级:", err);
		}
		const telegram = await this.harness.snapshot(TelegramSessionDoc, BACKGROUND_CONTEXT);
		if (telegram !== undefined) this.projectBotRoutes(telegram.routes);
		for (const id of new Set(this.convKeys.values())) {
			const conversation = await this.harness.conversation(id, BACKGROUND_CONTEXT);
			const cwd = conversation === undefined ? undefined : (await conversation.agent(BACKGROUND_CONTEXT)).cwd;
			if (cwd !== undefined) await this.prepareWorkspace(cwd);
		}
		if (telegram !== undefined) await this.save();
	}

	/** fire-and-forget 写入统一兜错：磁盘满/权限错误只记日志，不变成 unhandledRejection 拖垮进程。 */
	private kickSave(): void {
		this.save().catch((err: unknown) => console.error("[dwell] sessions 状态写入失败:", err));
	}

	private async save(): Promise<void> {
		const out: Record<string, SavedRoute> = {};
		for (const [key, id] of this.convKeys) {
			const name = this.names.get(id);
			const archived = this.archived.has(id);
			const ts = this.lastTs.get(id);
			const notify = this.notify.has(id);
			const emoji = this.emojis.get(id);
			const destination = this.destinations.get(id);
			out[key] = { id: id as number, owner: this.owners.get(id) ?? "", ...(name !== undefined ? { name } : {}), ...(archived ? { archived } : {}), ...(ts !== undefined ? { lastTs: ts } : {}), ...(notify ? { notify } : {}), ...(emoji !== undefined ? { emoji } : {}), ...(destination !== undefined ? { destination } : {}) };
		}
		await writeStateJson(this.file, out);
	}

	private async saveMap(): Promise<void> {
		await writeStateJson(this.mapFile, Object.fromEntries(this.messageMap));
	}

	/** 记录消息锚点（进过任务线的消息都记，供后续 replyTo 跟随）。 */
	async anchor(messageId: string, conversationId: ConversationId): Promise<void> {
		this.messageMap.set(messageId, conversationId);
		while (this.messageMap.size > MAP_LIMIT) {
			const oldest = this.messageMap.keys().next().value;
			if (oldest === undefined) break;
			this.messageMap.delete(oldest);
		}
		await this.saveMap();
	}

	follow(replyToMessageId: string): ConversationId | undefined {
		return this.messageMap.get(replyToMessageId);
	}

	/** 该任务线最近一条锚点消息（panel 往群里发消息时回复它，标明归属）。 */
	lastAnchor(conversationId: ConversationId): string | undefined {
		let last: string | undefined;
		for (const [messageId, id] of this.messageMap) if (id === conversationId) last = messageId;
		return last;
	}

	/** 面板显示名（手动重命名优先）。 */
	nameOf(conversationId: number): string | undefined {
		return this.names.get(conversationId as ConversationId);
	}

	ownerOf(conversationId: ConversationId): string | undefined {
		return this.owners.get(conversationId);
	}

	/** 反查：conversationId → chat_id（审批提醒发回原 chat 用）。 */
	chatOf(conversationId: number): string | undefined {
		const destination = this.destinationOf(conversationId);
		return destination.kind === "feishu" ? destination.chatId : undefined;
	}

	destinationOf(conversationId: number): ConversationDestination {
		const explicit = this.destinations.get(conversationId as ConversationId);
		if (explicit !== undefined) return { ...explicit };
		for (const [key, id] of this.convKeys) {
			if ((id as number) === conversationId) {
				const chat = key.split("#")[0];
				if (chat.startsWith("oc_")) return { kind: "feishu", chatId: chat };
			}
		}
		return { kind: "panel" };
	}

	/** 消息进入时调用：记录会话最后活动（panel 列表排序/显示）。 */
	touchActivity(conversationId: ConversationId): void {
		this.lastTs.set(conversationId, Date.now());
		this.kickSave();
	}

	/** 线标签 emoji（只读；分配用 lineEmoji）。 */
	emojiOf(conversationId: number): string | undefined {
		return this.emojis.get(conversationId as ConversationId);
	}

	/** 群平消息线的标签 emoji：已有则返回；否则在 chat 内唯一分配（池满转移最久未活跃线）并落盘。 */
	lineEmoji(conversationId: number, chatId: string): string {
		const id = conversationId as ConversationId;
		const existing = this.emojis.get(id);
		if (existing !== undefined) return existing;
		const active = this.listConversations()
			.filter((c) => c.chatId === chatId && !c.archived)
			.map((c) => ({ id: c.id, emoji: this.emojis.get(c.id as ConversationId), lastTs: c.lastTs }));
		const got = allocateEmoji(active);
		if (got.stealFrom !== undefined) this.emojis.delete(got.stealFrom as ConversationId);
		this.emojis.set(id, got.emoji);
		this.kickSave();
		return got.emoji;
	}

	/** panel 用：全部会话线概览。 */
	listConversations(): { id: number; key: string; owner: string; name: string; archived: boolean; type: string; platform: "feishu" | "telegram" | "panel"; lastTs: number; chatId: string | null; notify: boolean; emoji: string | null }[] {
		return [...this.convKeys.entries()].map(([key, id]) => {
			const destination = this.destinationOf(id);
			const routeKey = key.replace(/#old:\d+$/, "");
			return {
				id: id as number,
				key,
				owner: this.owners.get(id) ?? "",
				name: this.names.get(id) ?? key,
				archived: this.archived.has(id),
				type: destination.kind === "panel" ? "panel" : routeKey.includes("#t:") ? "thread" : routeKey.includes("#") ? "group" : "direct",
				platform: destination.kind,
				lastTs: this.lastTs.get(id) ?? 0,
				chatId: destination.kind === "panel" ? null : destination.kind === "feishu" ? destination.chatId : `tg:${destination.botId}:${destination.chatId}`,
				notify: this.notify.has(id),
				emoji: this.emojis.get(id) ?? null,
			};
		});
	}

	isArchived(conversationId: number): boolean {
		return this.archived.has(conversationId as ConversationId);
	}

	/** panel 任务的飞书通知开关。 */
	setNotify(conversationId: number, on: boolean): void {
		if (on) this.notify.add(conversationId as ConversationId);
		else this.notify.delete(conversationId as ConversationId);
		this.kickSave();
	}

	notifyEnabled(conversationId: number): boolean {
		return this.notify.has(conversationId as ConversationId);
	}

	async rename(conversationId: number, name: string): Promise<void> {
		if (!this.owners.has(conversationId as ConversationId)) return;
		this.names.set(conversationId as ConversationId, name);
		await this.save();
	}

	async setArchived(conversationId: number, archived: boolean): Promise<void> {
		if (!this.owners.has(conversationId as ConversationId)) return;
		if (archived) this.archived.add(conversationId as ConversationId);
		else this.archived.delete(conversationId as ConversationId);
		await this.save();
	}

	/**
	 * 已有会话的 agent 模型在创建时持久化；切换 DWELL_PROVIDER/DWELL_MODEL 后启动时统一对齐到当前 MODEL，
	 * 否则旧会话仍会请求已不再注册的 provider。返回被改动的会话数。
	 */
	async alignModel(): Promise<number> {
		const context = BACKGROUND_CONTEXT;
		let changed = 0;
		for (const id of new Set(this.convKeys.values())) {
			const conversation = await this.harness.conversation(id, context);
			if (conversation === undefined) continue;
			const current = (await conversation.agent(context)).model;
			if (current?.provider === MODEL.provider && current.modelId === MODEL.modelId) continue;
			await conversation.configure({ model: MODEL }, context);
			changed++;
		}
		return changed;
	}

	/** panel 新建独立会话线（cwd 独立，不与飞书会话共享）。 */
	async createPanelConversation(name: string): Promise<Conversation> {
		const context = BACKGROUND_CONTEXT;
		let n = 1;
		while (this.convKeys.has(`panel:${name}#${n}`)) n++;
		const key = `panel:${name}#${n}`;
		const cwd = resolve(join(DATA_DIR, "work", `panel-${Date.now().toString(36)}`));
		await this.prepareWorkspace(cwd);
		const conversation = await this.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: MODEL, cwd } },
			context,
		);
		this.convKeys.set(key, conversation.id);
		this.owners.set(conversation.id, "panel");
		this.names.set(conversation.id, name);
		await this.save();
		return conversation;
	}

	private async create(key: string, owner: string, cwdName: string): Promise<Conversation> {
		const context = BACKGROUND_CONTEXT;
		const cwd = resolve(join(DATA_DIR, "work", cwdName));
		await this.prepareWorkspace(cwd);
		const conversation = await this.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: MODEL, cwd } },
			context,
		);
		this.convKeys.set(key, conversation.id);
		this.owners.set(conversation.id, owner);
		await this.save();
		return conversation;
	}

	/** 私聊：chat 级 conversation，owner = 用户。 */
	async forDirect(chatId: string, senderId: string): Promise<Conversation> {
		return this.byKey(chatId, senderId, chatId);
	}

	/** 群聊平消息：per-sender conversation，cwd 按 chat 共享。 */
	async forGroup(chatId: string, senderId: string): Promise<Conversation> {
		return this.byKey(`${chatId}#${senderId}`, senderId, chatId);
	}

	/** 话题群：per-thread conversation，owner = 话题首消息 sender。 */
	async forThread(chatId: string, threadId: string, senderId: string): Promise<Conversation> {
		return this.byKey(`${chatId}#t:${threadId}`, senderId, chatId);
	}

	private projectBotRoutes(routes: Readonly<Record<string, BotRoute>>): void {
		// Only durable keys are authoritative; legacy JSON routes are adopted on use.
		for (const [key, route] of Object.entries(routes)) {
			const id = route.id as ConversationId;
			this.convKeys.set(key, id);
			this.owners.set(id, route.owner);
			this.destinations.set(id, { ...route.destination });
		}
	}

	/** Telegram defaults are private-chat, group-sender or forum-topic scoped. */
	forTelegram(msg: NormalizedMessage, resetRequestId?: string): Promise<Conversation> {
		const run = this.telegramChain.then(() => this.routeTelegram(msg, resetRequestId));
		this.telegramChain = run.catch(() => {});
		return run;
	}

	private async routeTelegram(msg: NormalizedMessage, resetRequestId?: string): Promise<Conversation> {
		const destination = messageDestination(msg);
		if (destination.kind !== "telegram") throw new Error("Telegram routing requires a Telegram destination");
		const chatKey = `tg:${destination.botId}:${destination.chatId}`;
		if (msg.chatId !== chatKey || msg.threadId !== destination.threadId) throw new Error("Telegram routing destination does not match its input");
		const key = msg.chatType === "p2p" ? chatKey : destination.threadId !== undefined ? `${chatKey}#t:${destination.threadId}` : `${chatKey}#${msg.senderId}`;
		const cwd = resolve(DATA_DIR, "work", `telegram-${createHash("sha256").update(chatKey).digest("hex")}`);
		return this.routeBot(key, msg.senderId, destination, cwd, resetRequestId);
	}

	/** Feishu keeps its legacy lookup path; /new atomically adopts and replaces one default. */
	forFeishu(msg: NormalizedMessage, resetRequestId?: string): Promise<Conversation> {
		const destination = messageDestination(msg);
		if (destination.kind !== "feishu" || destination.chatId !== msg.chatId) return Promise.reject(new Error("Feishu routing destination does not match its input"));
		const key = msg.chatType === "p2p" ? msg.chatId : msg.threadId !== undefined ? `${msg.chatId}#t:${msg.threadId}` : `${msg.chatId}#${msg.senderId}`;
		if (resetRequestId === undefined) return this.byKey(key, msg.senderId, msg.chatId);
		// Join an in-flight create before switching the same key. Other keys remain independent.
		const run = (this.pendingRoutes.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.routeBot(key, msg.senderId, destination, resolve(DATA_DIR, "work", msg.chatId), resetRequestId));
		const pending = run.finally(() => { if (this.pendingRoutes.get(key) === pending) this.pendingRoutes.delete(key); });
		this.pendingRoutes.set(key, pending);
		return pending;
	}

	private async routeBot(key: string, sender: string, destination: BotDestination, cwd: string, resetRequestId?: string): Promise<Conversation> {
		await this.prepareWorkspace(cwd);
		const result = await this.harness.commit(async (tx) => {
			const doc = await tx.doc(TelegramSessionDoc);
			// Preserve projected Telegram routes, but adopt only the Feishu key being reset.
			for (const [savedKey, id] of this.convKeys) {
				const savedDestination = this.destinationOf(id);
				if (savedDestination.kind === "panel" || doc.routes[savedKey] !== undefined) continue;
				if (savedDestination.kind !== "telegram" && (destination.kind !== "feishu" || savedKey !== key)) continue;
				if (await tx.conversation(id) !== undefined) doc.routes[savedKey] = { id: id as number, owner: this.owners.get(id) ?? "", destination: { ...savedDestination } };
			}
			const requestKey = resetRequestId === undefined ? undefined : `${destination.kind}:${resetRequestId}`;
			const receipt = requestKey === undefined ? undefined : doc.resets[requestKey] ?? (destination.kind === "telegram" ? doc.resets[resetRequestId!] : undefined);
			let target: number;
			if (receipt !== undefined) {
				if (receipt.key !== key) throw new Error("Bot /new request was already used for a different route");
				const route = Object.values(doc.routes).find((route) => route.id === receipt.id);
				if (route === undefined || !sameDestination(route.destination, destination)) throw new Error("Bot /new receipt has no matching destination");
				if (await tx.conversation(receipt.id as ConversationId) === undefined) throw new Error("Bot /new conversation is missing");
				target = receipt.id;
			} else {
				const existing = doc.routes[key];
				if (resetRequestId === undefined && existing !== undefined && await tx.conversation(existing.id as ConversationId) !== undefined) {
					if (!sameDestination(existing.destination, destination)) throw new Error("Bot route has a different destination");
					target = existing.id;
				} else {
					const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
					await configure(tx, conversation.id, { model: MODEL, cwd });
					if (existing !== undefined) doc.routes[`${key}#old:${existing.id}`] = { ...existing, destination: { ...existing.destination } };
					target = conversation.id as number;
					doc.routes[key] = { id: target, owner: sender, destination: { ...destination } };
					if (requestKey !== undefined) doc.resets[requestKey] = { key, id: target };
				}
			}
			return { target, routes: JSON.parse(JSON.stringify(doc.routes)) as Record<string, BotRoute> };
		}, BACKGROUND_CONTEXT);
		this.projectBotRoutes(result.routes);
		await this.save();
		const conversation = await this.harness.conversation(result.target as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error("Bot conversation is missing after route creation");
		return conversation;
	}

	/** replyTo 跟随：进入被回复消息的 conversation（不改 owner）。 */
	async byConversation(id: ConversationId): Promise<Conversation | undefined> {
		return this.harness.conversation(id, BACKGROUND_CONTEXT);
	}

	private byKey(key: string, owner: string, cwdName: string): Promise<Conversation> {
		const pending = this.pendingRoutes.get(key);
		if (pending !== undefined) return pending;
		// Share lookup and creation so concurrent messages cannot split one route.
		const resolving = this.resolveKey(key, owner, cwdName).finally(() => { if (this.pendingRoutes.get(key) === resolving) this.pendingRoutes.delete(key); });
		this.pendingRoutes.set(key, resolving);
		return resolving;
	}

	private async resolveKey(key: string, owner: string, cwdName: string): Promise<Conversation> {
		const existing = this.convKeys.get(key);
		if (existing !== undefined) {
			const found = await this.harness.conversation(existing, BACKGROUND_CONTEXT);
			// sessions.json 与 sqlite 不一致（如 data 半删）时重建映射
			if (found !== undefined) return found;
		}
		return this.create(key, owner, cwdName);
	}
}
