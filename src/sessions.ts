// 会话路由与映射：chat_id（私聊）/ (chat,sender)（群平消息）/ (chat,thread)（话题群）→ conversation；
// replyTo 命中 message-map 则跟随该任务线。messageMap 持久化，上限淘汰 + 显式降级。
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness } from "@earendil-works/pi-durable";
import { DATA_DIR, MODEL } from "./harness.ts";
import { stateFile, writeStateJson } from "./state.ts";

const MAP_LIMIT = 10_000;

export interface RouteTarget {
	conversation: Conversation;
	/** 本次消息是否因映射淘汰降级到了新任务线（用于显式提示） */
	degraded: boolean;
}

export class Sessions {
	private convKeys = new Map<string, ConversationId>(); // 路由键 → conversation
	private owners = new Map<ConversationId, string>(); // conversation → owner open_id
	private names = new Map<ConversationId, string>(); // conversation → 显示名（panel 重命名）
	private archived = new Set<ConversationId>(); // 归档（panel 隐藏，不删数据）
	private messageMap = new Map<string, ConversationId>(); // messageId → conversation（任务线锚点）
	private file = stateFile("sessions.json");
	private mapFile = stateFile("message-map.json");
	private harness: Harness;

	constructor(harness: Harness) {
		this.harness = harness;
	}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.file, "utf8")) as Record<string, { id: number; owner: string; name?: string; archived?: boolean }>;
			for (const [key, v] of Object.entries(saved)) {
				this.convKeys.set(key, v.id as ConversationId);
				this.owners.set(v.id as ConversationId, v.owner);
				if (v.name !== undefined) this.names.set(v.id as ConversationId, v.name);
				if (v.archived === true) this.archived.add(v.id as ConversationId);
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
	}

	private async save(): Promise<void> {
		const out: Record<string, { id: number; owner: string; name?: string; archived?: boolean }> = {};
		for (const [key, id] of this.convKeys) {
			const name = this.names.get(id);
			const archived = this.archived.has(id);
			out[key] = { id: id as number, owner: this.owners.get(id) ?? "", ...(name !== undefined ? { name } : {}), ...(archived ? { archived } : {}) };
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

	ownerOf(conversationId: ConversationId): string | undefined {
		return this.owners.get(conversationId);
	}

	/** 反查：conversationId → chat_id（审批提醒发回原 chat 用）。 */
	chatOf(conversationId: number): string | undefined {
		for (const [key, id] of this.convKeys) {
			if ((id as number) === conversationId) {
				const chat = key.split("#")[0];
				if (chat.startsWith("oc_")) return chat;
			}
		}
		return undefined;
	}

	/** panel 用：全部会话线概览。 */
	listConversations(): { id: number; key: string; owner: string; name: string; archived: boolean; type: string }[] {
		return [...this.convKeys.entries()].map(([key, id]) => ({
			id: id as number,
			key,
			owner: this.owners.get(id) ?? "",
			name: this.names.get(id) ?? key,
			archived: this.archived.has(id),
			type: key.includes("#t:") ? "thread" : key.includes("#") ? "group" : key.startsWith("oc_") ? "direct" : "panel",
		}));
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

	/** panel 新建独立会话线（cwd 独立，不与飞书会话共享）。 */
	async createPanelConversation(name: string): Promise<Conversation> {
		const context = BACKGROUND_CONTEXT;
		let n = 1;
		while (this.convKeys.has(`panel:${name}#${n}`)) n++;
		const key = `panel:${name}#${n}`;
		const cwd = resolve(join(DATA_DIR, "work", `panel-${Date.now().toString(36)}`));
		await mkdir(cwd, { recursive: true });
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
		await mkdir(cwd, { recursive: true });
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

	/** replyTo 跟随：进入被回复消息的 conversation（不改 owner）。 */
	async byConversation(id: ConversationId): Promise<Conversation | undefined> {
		return this.harness.conversation(id, BACKGROUND_CONTEXT);
	}

	private async byKey(key: string, owner: string, cwdName: string): Promise<Conversation> {
		const existing = this.convKeys.get(key);
		if (existing !== undefined) {
			const found = await this.harness.conversation(existing, BACKGROUND_CONTEXT);
			// sessions.json 与 sqlite 不一致（如 data 半删）时重建映射
			if (found !== undefined) return found;
		}
		return this.create(key, owner, cwdName);
	}
}
