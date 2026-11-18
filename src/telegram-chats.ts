import { readFile } from "node:fs/promises";
import type { TelegramDestination } from "./pipeline.ts";
import { stateFile, writeStateJson } from "./state.ts";

const REQUEST_LIMIT = 10_000;
export type TelegramChatAccess = "allowlist" | "members";
type SavedBot = { chats: string[]; memberChats?: string[]; requests: string[] };
type SavedChats = { version: 1; bots: Record<string, SavedBot> };

export function isTelegramGroupId(id: string): boolean {
	return /^-[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
}

function savedChats(value: unknown): SavedChats {
	if (value === null || typeof value !== "object" || !("version" in value) || value.version !== 1
		|| !("bots" in value) || value.bots === null || typeof value.bots !== "object" || Array.isArray(value.bots)) throw new Error("Telegram 群白名单状态格式无效");
	for (const [id, bot] of Object.entries(value.bots)) {
		if (!/^[1-9]\d*$/.test(id) || bot === null || typeof bot !== "object"
			|| !Array.isArray(bot.chats) || !bot.chats.every((chat: unknown) => typeof chat === "string" && isTelegramGroupId(chat))
			|| ("memberChats" in bot && (!Array.isArray(bot.memberChats)
				|| !bot.memberChats.every((chat: unknown) => typeof chat === "string" && isTelegramGroupId(chat) && bot.chats.includes(chat))))
			|| !Array.isArray(bot.requests) || !bot.requests.every((request: unknown) => typeof request === "string" && request.length > 0)) throw new Error("Telegram 群白名单状态格式无效");
	}
	return value as SavedChats;
}

/** One bot owns this process; other bots' records survive replacements of the shared file. */
export class TelegramChats {
	readonly botId: string;
	#file: string;
	#saved: SavedChats = { version: 1, bots: {} };
	#loaded = false;
	#changes: Promise<void> = Promise.resolve();

	constructor(botId: string, file = stateFile("telegram-chats.json")) {
		if (!/^[1-9]\d*$/.test(botId)) throw new Error("Telegram bot 身份无效");
		this.botId = botId;
		this.#file = file;
	}

	async load(seed: readonly string[]): Promise<void> {
		let saved: SavedChats;
		try { saved = savedChats(JSON.parse(await readFile(this.#file, "utf8"))); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Telegram 群白名单无法读取，已拒绝启动", { cause: error });
			saved = { version: 1, bots: {} };
		}
		if (saved.bots[this.botId] === undefined) {
			const chats = [...new Set(seed.filter(isTelegramGroupId))];
			saved = { version: 1, bots: { ...saved.bots, [this.botId]: { chats, requests: [] } } };
			await writeStateJson(this.#file, saved);
		}
		this.#saved = saved;
		this.#loaded = true;
	}

	allows(destination: TelegramDestination): boolean {
		return this.#loaded && destination.botId === this.botId
			&& (!destination.chatId.startsWith("-") || this.#saved.bots[this.botId]!.chats.includes(destination.chatId));
	}

	accessMode(destination: TelegramDestination): TelegramChatAccess | undefined {
		if (!this.#loaded || destination.botId !== this.botId || !isTelegramGroupId(destination.chatId)) return undefined;
		const bot = this.#saved.bots[this.botId]!;
		if (!bot.chats.includes(destination.chatId)) return undefined;
		return bot.memberChats?.includes(destination.chatId) ? "members" : "allowlist";
	}

	list(): string[] {
		return [...(this.#saved.bots[this.botId]?.chats ?? [])];
	}

	change(chatId: string, allowed: boolean, requestId: string, accessMode: TelegramChatAccess = "allowlist"): Promise<"changed" | "unchanged" | "replayed"> {
		const run = async (): Promise<"changed" | "unchanged" | "replayed"> => {
			if (!this.#loaded) throw new Error("Telegram 群白名单尚未加载");
			if (!isTelegramGroupId(chatId) || requestId.length === 0 || (accessMode !== "allowlist" && accessMode !== "members")) throw new Error("Telegram 群白名单命令参数无效");
			const previous = this.#saved.bots[this.botId]!;
			if (previous.requests.includes(requestId)) return "replayed";
			const chats = new Set(previous.chats);
			const memberChats = new Set(previous.memberChats);
			const previousAccess = memberChats.has(chatId) ? "members" : "allowlist";
			const changed = chats.has(chatId) !== allowed || (allowed && previousAccess !== accessMode);
			if (allowed) chats.add(chatId); else chats.delete(chatId);
			if (allowed && accessMode === "members") memberChats.add(chatId); else memberChats.delete(chatId);
			const bot: SavedBot = {
				chats: [...chats],
				...(memberChats.size > 0 ? { memberChats: [...memberChats] } : {}),
				requests: [...previous.requests, requestId].slice(-REQUEST_LIMIT),
			};
			const saved: SavedChats = { version: 1, bots: { ...this.#saved.bots, [this.botId]: bot } };
			// Publish the policy and its receipt only after the atomic replacement succeeds.
			await writeStateJson(this.#file, saved);
			this.#saved = saved;
			return changed ? "changed" : "unchanged";
		};
		const result = this.#changes.then(run, run);
		this.#changes = result.then(() => {}, () => {});
		return result;
	}
}
