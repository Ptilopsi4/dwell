// chat_id ↔ conversation 映射。低频写，JSON 文件写穿足够，不进 SQLite。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { DATA_DIR, MODEL } from "./harness.ts";

export class Sessions {
	private map = new Map<string, ConversationId>();
	private file = join(DATA_DIR, "sessions.json");
	private harness: Harness;

	constructor(harness: Harness) {
		this.harness = harness;
	}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.file, "utf8")) as Record<string, number>;
			this.map = new Map(Object.entries(saved).map(([k, v]) => [k, v as ConversationId]));
		} catch {
			// 首次运行，无映射文件
		}
	}

	private async save(): Promise<void> {
		await writeFile(this.file, JSON.stringify(Object.fromEntries(this.map), null, "\t"));
	}

	/** 取该 chat 的 conversation；首次见面则创建，独立 cwd 实现会话文件隔离。 */
	async forChat(chatId: string): Promise<Conversation> {
		const context = BACKGROUND_CONTEXT;
		const existing = this.map.get(chatId);
		if (existing !== undefined) {
			const found = await this.harness.conversation(existing, context);
			// sessions.json 与 sqlite 不一致（如 data 半删）时重建映射
			if (found !== undefined) return found;
		}

		const cwd = resolve(join(DATA_DIR, "work", chatId));
		await mkdir(cwd, { recursive: true });
		const conversation = await this.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: MODEL, cwd } },
			context,
		);
		this.map.set(chatId, conversation.id);
		await this.save();
		return conversation;
	}
}
