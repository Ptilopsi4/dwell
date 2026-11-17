// Bot API URLs contain credentials. Keep them inside this transport and never retain raw failures.
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NormalizedMessage, TelegramDestination } from "./pipeline.ts";
import { stateFile, writeStateJson } from "./state.ts";
import { formatTelegramText, type TelegramTextFormat } from "./telegram-format.ts";

export interface TelegramIdentity { id: string; username: string }
export interface TelegramCallback {
	id: string;
	senderId: string;
	destination: TelegramDestination;
	messageId: string;
	data: string;
}
export interface TelegramButton { text: string; data: string }
export interface TelegramSent { messageId: string; messageIds: string[] }

export class TelegramError extends Error {
	readonly code?: number;
	readonly retryAfter?: number;
	readonly uncertain: boolean;
	constructor(message: string, options: { code?: number; retryAfter?: number; uncertain?: boolean } = {}) {
		super(message);
		this.name = "TelegramError";
		this.code = options.code;
		this.retryAfter = options.retryAfter;
		this.uncertain = options.uncertain ?? false;
	}
}

type User = { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string };
type TelegramMessage = {
	message_id: number;
	date: number;
	chat: { id: number; type: string };
	from?: User;
	sender_chat?: unknown;
	message_thread_id?: number;
	reply_to_message?: TelegramMessage;
	text?: string;
	caption?: string;
	photo?: { file_id: string; file_size?: number }[];
	document?: { file_id: string; file_name?: string; file_size?: number };
	audio?: unknown;
	voice?: unknown;
	video?: unknown;
	sticker?: unknown;
	animation?: unknown;
};
export type TelegramUpdate = {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: { id: string; from: User; message?: TelegramMessage; data?: string };
};

export function telegramChatKey(botId: string, chatId: string | number): string {
	return `tg:${botId}:${chatId}`;
}

export function telegramMessageKey(destination: TelegramDestination, messageId: string | number): string {
	return `${telegramChatKey(destination.botId, destination.chatId)}:${messageId}`;
}

function destinationFor(message: TelegramMessage, identity: TelegramIdentity): TelegramDestination {
	return {
		kind: "telegram", botId: identity.id, chatId: String(message.chat.id),
		...(message.message_thread_id !== undefined ? { threadId: String(message.message_thread_id) } : {}),
	};
}

export function normalizeTelegramUpdate(update: TelegramUpdate, identity: TelegramIdentity): NormalizedMessage | null {
	const message = update.message;
	if (!message || !message.from || message.from.is_bot || message.sender_chat
		|| !["private", "group", "supergroup"].includes(message.chat.type)) return null;
	let content = message.text ?? message.caption ?? "";
	const command = /^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?=\s|$)/.exec(content);
	if (command?.[2] && command[2].toLowerCase() !== identity.username.toLowerCase()) return null;
	const directed = command?.[2]?.toLowerCase() === identity.username.toLowerCase();
	const repliesToBot = message.reply_to_message?.from?.is_bot === true
		&& String(message.reply_to_message.from.id) === identity.id;
	// 本 bot 最后在群里发言时，Telegram 可能投递不带 bot 后缀的命令。
	const groupControl = command?.[2] === undefined && ["allowgroup", "disallowgroup"].includes(command?.[1]?.toLowerCase() ?? "");
	if (message.chat.type !== "private" && !directed && !repliesToBot && !groupControl) return null;
	const destination = destinationFor(message, identity);
	const resources: NormalizedMessage["resources"] = [];
	if (message.photo?.length) resources.push({ type: "image", fileKey: message.photo.at(-1)!.file_id });
	if (message.document) resources.push({ type: "file", fileKey: message.document.file_id, fileName: message.document.file_name });
	if (command) {
		const body = content.slice(command[0].length).trimStart();
		content = command[1]!.toLowerCase() === "ask" ? body || (resources.length ? "" : "/ask") : `/${command[1]}${body ? ` ${body}` : ""}`;
	}
	let rawContentType = message.text !== undefined ? "text" : "unknown";
	if (resources.length) rawContentType = resources[0]!.type;
	else for (const kind of ["audio", "voice", "video", "sticker", "animation"] as const) {
		if (message[kind] !== undefined) { rawContentType = kind; break; }
	}
	return {
		platform: "telegram", destination, requestId: `tg-update:${identity.id}:${update.update_id}`,
		chatId: telegramChatKey(identity.id, message.chat.id), chatType: message.chat.type === "private" ? "p2p" : "group",
		messageId: telegramMessageKey(destination, message.message_id), senderId: `tg:${message.from.id}`,
		senderName: [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || message.from.username,
		content, rawContentType, resources, mentions: [], mentionAll: false, mentionedBot: directed || repliesToBot || groupControl,
		...(destination.threadId !== undefined ? { threadId: destination.threadId } : {}),
		...(message.reply_to_message ? { replyToMessageId: telegramMessageKey(destination, message.reply_to_message.message_id) } : {}),
		createTime: message.date * 1000,
	};
}

function normalizeCallback(update: TelegramUpdate, identity: TelegramIdentity): TelegramCallback | null {
	const callback = update.callback_query;
	if (!callback?.message || callback.from.is_bot || callback.data === undefined
		|| callback.message.from?.is_bot !== true || String(callback.message.from.id) !== identity.id
		|| !["private", "group", "supergroup"].includes(callback.message.chat.type)) return null;
	const destination = destinationFor(callback.message, identity);
	return { id: callback.id, senderId: `tg:${callback.from.id}`, destination,
		messageId: telegramMessageKey(destination, callback.message.message_id), data: callback.data };
}

type Timing = {
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	privateIntervalMs?: number;
	groupIntervalMs?: number;
};
type ConnectOptions = {
	token: string;
	onMessage: (message: NormalizedMessage) => Promise<void>;
	onCallback: (callback: TelegramCallback) => Promise<void>;
	onError: (error: TelegramError) => void;
	onFatal?: (error: TelegramError) => void;
	isDestinationAllowed?: (destination: TelegramDestination) => boolean;
	stateFile?: string;
	fetch?: typeof fetch;
	timing?: Timing;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(new TelegramError("Telegram 连接已关闭")); return; }
		const abort = () => { clearTimeout(timer); reject(new TelegramError("Telegram 连接已关闭")); };
		const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
		signal.addEventListener("abort", abort, { once: true });
	});
}

const DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const UPLOAD_LIMIT = 50 * 1024 * 1024;
const ACTIVITY_INTERVAL_MS = 4_000;
type ActivityGroup = {
	leases: Map<symbol, TelegramDestination>;
	stops: Set<() => void>;
	timer?: ReturnType<typeof setInterval>;
	next: number;
	active?: Promise<void>;
	controller?: AbortController;
	destination?: TelegramDestination;
};

export class TelegramBot {
	readonly identity: TelegramIdentity;
	#token: string;
	#fetch: typeof fetch;
	#options: ConnectOptions;
	#controller = new AbortController();
	#state: "ready" | "polling" | "failed" | "off" = "ready";
	#poll?: Promise<void>;
	#fatalReported = false;
	#cursorFile = "";
	#offset = 0;
	#cooldown = 0;
	#queues = new Map<string, Promise<unknown>>();
	#lastSend = new Map<string, number>();
	#activities = new Map<string, ActivityGroup>();
	#lastActivity = new Map<string, number>();
	#activityRequests = new Set<Promise<void>>();
	#invalidEntityErrors = new WeakSet<TelegramError>();
	#now: () => number;
	#sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	private constructor(options: ConnectOptions, identity: TelegramIdentity) {
		this.identity = identity;
		this.#token = options.token;
		this.#fetch = options.fetch ?? fetch;
		// Do not retain the options object: it contains a second copy of the credential.
		this.#options = { ...options, token: "" };
		this.#now = options.timing?.now ?? Date.now;
		this.#sleep = options.timing?.sleep ?? sleep;
	}

	static async connect(options: ConnectOptions): Promise<TelegramBot> {
		if (!options.token || /[\s/]/.test(options.token)) throw new TelegramError("Telegram token 格式无效");
		const bot = new TelegramBot(options, { id: "", username: "" });
		try {
			const me = await bot.#api<User>("getMe", {});
			if (!Number.isSafeInteger(me.id) || me.id <= 0 || !me.username) throw new TelegramError("Telegram getMe 返回无效身份");
			bot.identity.id = String(me.id);
			bot.identity.username = me.username;
			const webhook = await bot.#api<{ url: string }>("getWebhookInfo", {});
			if (webhook.url) throw new TelegramError("Telegram 已配置 webhook；请由维护者处理后启用长轮询", { code: 409 });
			bot.#cursorFile = options.stateFile ?? join(stateFile("telegram"), `${bot.identity.id}.json`);
			await mkdir(dirname(bot.#cursorFile), { recursive: true, mode: 0o700 });
			let saved: unknown;
			try { saved = JSON.parse(await readFile(bot.#cursorFile, "utf8")); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new TelegramError("Telegram 轮询游标读取失败");
			}
			if (saved && typeof saved === "object" && "botId" in saved && saved.botId === bot.identity.id) {
				const offset = (saved as { offset?: unknown }).offset;
				if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new TelegramError("Telegram 轮询游标无效");
				bot.#offset = offset as number;
			}
			return bot;
		} catch (error) {
			await bot.close();
			throw error instanceof TelegramError ? error : new TelegramError("Telegram 初始化失败");
		}
	}

	status(): string { return this.#state; }
	#fail(error: TelegramError): void {
		this.#state = "failed";
		if (this.#fatalReported) return;
		this.#fatalReported = true;
		try { this.#options.onFatal?.(error); } catch { /* Reporting must not replace the transport failure. */ }
	}
	start(): void {
		if (this.#state !== "ready") return;
		this.#state = "polling";
		this.#poll = this.#pollLoop();
	}
	async close(): Promise<void> {
		this.#state = "off";
		for (const group of this.#activities.values()) for (const stop of [...group.stops]) stop();
		this.#controller.abort();
		await this.#poll;
		await Promise.allSettled([...this.#queues.values(), ...this.#activityRequests]);
		this.#token = "";
	}

	async #wait(ms: number, signal = this.#controller.signal): Promise<void> {
		if (this.#controller.signal.aborted) throw new TelegramError("Telegram 连接已关闭");
		signal.throwIfAborted();
		if (ms > 0) await this.#sleep(ms, signal);
	}

	async #api<T>(method: string, body: Record<string, unknown> | FormData, mutates = false, destination?: TelegramDestination, requestSignal?: AbortSignal, hostControl = false): Promise<T> {
		const activity = method === "sendChatAction";
		const requestLifetime = AbortSignal.any([this.#controller.signal, ...(requestSignal === undefined ? [] : [requestSignal])]);
		for (let attempt = 0; ; attempt++) {
			await this.#wait(0, requestLifetime);
			const chatKey = destination ? telegramChatKey(destination.botId, destination.chatId) : undefined;
			const interval = destination?.chatId.startsWith("-") ? this.#options.timing?.groupIntervalMs ?? 3000 : this.#options.timing?.privateIntervalMs ?? 1000;
			for (;;) {
				if (destination !== undefined && !hostControl && this.#options.isDestinationAllowed?.(destination) === false) throw new TelegramError("Telegram 目的地未启用");
				const deadline = Math.max(this.#cooldown, chatKey ? (this.#lastSend.get(chatKey) ?? -Infinity) + interval : 0);
				if (activity && (requestSignal?.aborted || chatKey !== undefined && this.#queues.has(chatKey) || deadline > this.#now())) return undefined as T;
				if (deadline <= this.#now()) break;
				await this.#wait(Math.min(60_000, deadline - this.#now()), requestLifetime);
			}
			if (chatKey && !activity) this.#lastSend.set(chatKey, this.#now());
			const signal = AbortSignal.any([requestLifetime, AbortSignal.timeout(activity ? 2_000 : method === "getUpdates" ? 35_000 : 30_000)]);
			let response: Response;
			let payload: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
			try {
				response = await this.#fetch(`https://api.telegram.org/bot${this.#token}/${method}`, {
					method: "POST", body: body instanceof FormData ? body : JSON.stringify(body),
					...(body instanceof FormData ? {} : { headers: { "Content-Type": "application/json" } }),
					signal, redirect: "error",
				});
				payload = await response.json() as typeof payload;
				if (!payload || typeof payload !== "object") throw new Error();
			} catch {
				throw new TelegramError("Telegram 请求失败", { uncertain: mutates });
			}
			if (response.ok && payload.ok === true) return payload.result as T;
			const code = Number.isSafeInteger(payload.error_code) ? payload.error_code! : response.status;
			if (method === "editMessageText" && code === 400 && typeof payload.description === "string" && /\bmessage is not modified\b/i.test(payload.description)) return undefined as T;
			const rawRetry = payload.parameters?.retry_after;
			const retryAfter = typeof rawRetry === "number" && Number.isFinite(rawRetry) && rawRetry >= 0 ? rawRetry : undefined;
			if (code === 429) {
				this.#cooldown = Math.max(this.#cooldown, this.#now() + (retryAfter ?? 1) * 1000);
					if (!activity && attempt < 2 && (retryAfter ?? 1) <= 60) continue;
			}
			const error = new TelegramError(`Telegram API 请求失败（${code}）`, { code, retryAfter });
			if (code === 400 && typeof payload.description === "string"
				&& /\bentit(?:y|ies)\b|\bENTITY_BOUNDS_INVALID\b/i.test(payload.description)) this.#invalidEntityErrors.add(error);
				if (!activity && (code === 401 || code === 409)) this.#fail(error);
			throw error;
		}
	}

	async #pollLoop(): Promise<void> {
		let failures = 0;
		let handlerFailures = 0;
		while (!this.#controller.signal.aborted) {
			let phase: "transport" | "handler" | "cursor" = "transport";
			try {
				const updates = await this.#api<TelegramUpdate[]>("getUpdates", {
					offset: this.#offset, timeout: 25, allowed_updates: ["message", "callback_query"],
				});
				if (!Array.isArray(updates)) throw new TelegramError("Telegram 轮询响应无效");
				failures = 0;
				for (const update of updates) {
					if (this.#controller.signal.aborted) return;
					if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new TelegramError("Telegram update ID 无效");
					if (update.update_id < this.#offset) continue;
					phase = "handler";
					const callback = normalizeCallback(update, this.identity);
					const message = normalizeTelegramUpdate(update, this.identity);
					if (callback) await this.#options.onCallback(callback);
					else if (message) await this.#options.onMessage(message);
					phase = "cursor";
					const offset = update.update_id + 1;
					await writeStateJson(this.#cursorFile, { botId: this.identity.id, offset });
					await chmod(this.#cursorFile, 0o600);
					this.#offset = offset;
					handlerFailures = 0;
				}
				// Empty mocked responses and unexpected proxy responses must not busy-spin.
				if (!updates.length) await this.#wait(50);
			} catch (error) {
				if (this.#controller.signal.aborted) return;
				const safe = phase === "transport"
					? error instanceof TelegramError ? error : new TelegramError("Telegram 轮询请求失败")
					: new TelegramError(phase === "handler" ? "Telegram 更新处理失败；保留游标以便重试" : "Telegram 游标保存失败；保留游标以便重试");
				try { this.#options.onError(safe); } catch { /* Reporting must not break recovery. */ }
				if (safe.code === 401 || safe.code === 409 || (phase !== "transport" && ++handlerFailures >= 6)) { this.#fail(safe); return; }
				const attempts = phase === "transport" ? ++failures : handlerFailures;
				try { await this.#wait(Math.min(30_000, 500 * 2 ** Math.min(attempts - 1, 6))); } catch { return; }
			}
		}
	}

	#validateDestination(destination: TelegramDestination): void {
		if (destination.botId !== this.identity.id || !/^-?\d+$/.test(destination.chatId)
			|| (destination.threadId !== undefined && !/^\d+$/.test(destination.threadId))) throw new TelegramError("Telegram 目标与当前 bot 不匹配");
	}
	#numericMessage(destination: TelegramDestination, messageId: string): number {
		const prefix = `${telegramChatKey(destination.botId, destination.chatId)}:`;
		const raw = messageId.startsWith(prefix) ? messageId.slice(prefix.length) : "";
		if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) throw new TelegramError("Telegram 消息锚点不属于当前目标");
		return Number(raw);
	}
	#address(destination: TelegramDestination, replyTo?: string): Record<string, unknown> {
		this.#validateDestination(destination);
		return { chat_id: destination.chatId,
			...(destination.threadId !== undefined ? { message_thread_id: Number(destination.threadId) } : {}),
			// Reply anchors always belong to this chat; a deleted anchor must not discard the result.
			...(replyTo ? { reply_parameters: { message_id: this.#numericMessage(destination, replyTo), allow_sending_without_reply: true } } : {}) };
	}

	/** Optional activity never enters the message queue or consumes its send interval. */
	startActivity(destination: TelegramDestination, signal?: AbortSignal): () => void {
		this.#validateDestination(destination);
		if (this.#controller.signal.aborted || signal?.aborted) return () => {};
		const key = telegramChatKey(destination.botId, destination.chatId);
		let group = this.#activities.get(key);
		const first = group === undefined;
		if (group === undefined) {
			group = { leases: new Map(), stops: new Set(), next: 0 };
			this.#activities.set(key, group);
			const active = group;
			group.timer = setInterval(() => this.#activityPulse(key, active), ACTIVITY_INTERVAL_MS);
			group.timer.unref?.();
		}
		const active = group;
		const lease = Symbol();
		active.leases.set(lease, { ...destination });
		const stop = (): void => {
			if (!active.leases.delete(lease)) return;
			active.stops.delete(stop);
			signal?.removeEventListener("abort", stop);
			if (active.leases.size === 0) {
				clearInterval(active.timer);
				if (this.#activities.get(key) === active) this.#activities.delete(key);
			}
			if (active.destination !== undefined && ![...active.leases.values()].some((target) => target.threadId === active.destination!.threadId)) active.controller?.abort();
		};
		active.stops.add(stop);
		signal?.addEventListener("abort", stop, { once: true });
		if (first) this.#activityPulse(key, active);
		return stop;
	}

	#activityPulse(key: string, group: ActivityGroup): void {
		if (group.active !== undefined || group.leases.size === 0 || this.#controller.signal.aborted) return;
		if (this.#now() - (this.#lastActivity.get(key) ?? -Infinity) < ACTIVITY_INTERVAL_MS) return;
		const destinations = [...new Map([...group.leases.values()].map((target) => [target.threadId ?? "", target])).values()];
		const destination = destinations[group.next++ % destinations.length]!;
		this.#lastActivity.set(key, this.#now());
		const controller = new AbortController();
		group.controller = controller;
		group.destination = destination;
		const request = this.#api("sendChatAction", { ...this.#address(destination), action: "typing" }, false, destination, controller.signal).then(() => {}, () => {}).finally(() => {
			group.active = undefined;
			group.controller = undefined;
			group.destination = undefined;
			this.#activityRequests.delete(request);
		});
		group.active = request;
		this.#activityRequests.add(request);
	}
	#markup(buttons?: TelegramButton[][]): Record<string, unknown> | undefined {
		if (!buttons) return undefined;
		for (const row of buttons) for (const button of row) {
			if (!button.text || Buffer.byteLength(button.data) < 1 || Buffer.byteLength(button.data) > 64) throw new TelegramError("Telegram 按钮参数超出限制");
		}
		return { inline_keyboard: buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))) };
	}
	#queued<T>(destination: TelegramDestination, action: () => Promise<T>): Promise<T> {
		this.#validateDestination(destination);
		const key = telegramChatKey(destination.botId, destination.chatId);
		const operation = (this.#queues.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
		this.#queues.set(key, operation);
		void operation.finally(() => { if (this.#queues.get(key) === operation) this.#queues.delete(key); }).catch(() => {});
		return operation;
	}
	async #messageApi<T>(destination: TelegramDestination, body: Record<string, unknown> | FormData, method: string, hostControl = false): Promise<T> {
		try { return await this.#api<T>(method, body, true, destination, undefined, hostControl); }
		catch (error) {
			if (body instanceof FormData || !Array.isArray(body.entities) || !body.entities.length
				|| !(error instanceof TelegramError) || !this.#invalidEntityErrors.has(error)) throw error;
			// Only an explicit entity rejection proves the first mutation did not succeed.
			const { entities: _entities, ...plain } = body;
			return this.#api<T>(method, plain, true, destination, undefined, hostControl);
		}
	}
	async #sendOne(destination: TelegramDestination, body: Record<string, unknown> | FormData, method: string, hostControl = false): Promise<string> {
		const result = await this.#queued(destination, () => this.#messageApi<{ message_id: number }>(destination, body, method, hostControl));
		if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0) throw new TelegramError("Telegram 未返回有效消息锚点", { uncertain: true });
		return telegramMessageKey(destination, result.message_id);
	}
	async send(destination: TelegramDestination, text: string, options: { replyTo?: string; buttons?: TelegramButton[][]; format?: TelegramTextFormat } = {}): Promise<TelegramSent> {
		return this.#sendText(destination, text, options);
	}
	/** Fixed host admission and management responses can reach a disabled group. */
	async sendControl(destination: TelegramDestination, text: string, options: { replyTo?: string; buttons?: TelegramButton[][] } = {}): Promise<TelegramSent> {
		return this.#sendText(destination, text, options, true);
	}
	async #sendText(destination: TelegramDestination, text: string, options: { replyTo?: string; buttons?: TelegramButton[][]; format?: TelegramTextFormat }, hostControl = false): Promise<TelegramSent> {
		if (!text) throw new TelegramError("Telegram 消息不能为空");
		const address = this.#address(destination, options.replyTo);
		const markup = this.#markup(options.buttons);
		const chunks = formatTelegramText(text, options.format ?? "plain");
		const messageIds: string[] = [];
		for (let i = 0; i < chunks.length; i++) messageIds.push(await this.#sendOne(destination, {
			...address, text: chunks[i]!.text, ...(chunks[i]!.entities.length ? { entities: chunks[i]!.entities } : {}),
			...(i === chunks.length - 1 && markup ? { reply_markup: markup } : {}),
		}, "sendMessage", hostControl));
		return { messageId: messageIds.at(-1)!, messageIds };
	}
	async edit(destination: TelegramDestination, messageId: string, text: string, buttons?: TelegramButton[][], options: { format?: TelegramTextFormat; preview?: boolean } = {}): Promise<void> {
		if (!text || text.length > 4096) throw new TelegramError("Telegram 编辑消息长度超出限制");
		const markup = this.#markup(buttons);
		const chunks = formatTelegramText(text, options.format ?? "plain");
		if (chunks.length !== 1 && !options.preview) throw new TelegramError("Telegram 编辑消息长度超出限制");
		await this.#queued(destination, () => this.#messageApi(destination, {
			...this.#address(destination), message_id: this.#numericMessage(destination, messageId), text: chunks[0]!.text,
			...(chunks[0]!.entities.length ? { entities: chunks[0]!.entities } : {}),
			...(markup ? { reply_markup: markup } : {}),
		}, "editMessageText"));
	}
	async sendFile(destination: TelegramDestination, buffer: Buffer, fileName: string, options: { replyTo?: string; image?: boolean } = {}): Promise<TelegramSent> {
		if (buffer.length > (options.image ? 10 * 1024 * 1024 : UPLOAD_LIMIT)) throw new TelegramError("Telegram 上传文件超出大小限制");
		const address = this.#address(destination, options.replyTo);
		const form = new FormData();
		for (const [key, value] of Object.entries(address)) form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
		form.set(options.image ? "photo" : "document", new Blob([Uint8Array.from(buffer)]), fileName);
		const messageId = await this.#sendOne(destination, form, options.image ? "sendPhoto" : "sendDocument");
		return { messageId, messageIds: [messageId] };
	}
	async acknowledge(callbackId: string, text?: string): Promise<void> {
		await this.#api("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text: text.slice(0, 200) } : {}) });
	}
	async download(fileId: string, signal?: AbortSignal): Promise<Buffer> {
		const file = await this.#api<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId }, false, undefined, signal);
		signal?.throwIfAborted();
		if ((file.file_size ?? 0) > DOWNLOAD_LIMIT) throw new TelegramError("Telegram 下载文件超过 20 MiB");
		if (!file.file_path || !/^[a-zA-Z0-9_./-]+$/.test(file.file_path) || file.file_path.split("/").includes("..")) throw new TelegramError("Telegram 下载路径无效");
		let response: Response;
		try {
			response = await this.#fetch(`https://api.telegram.org/file/bot${this.#token}/${file.file_path}`, {
				signal: AbortSignal.any([this.#controller.signal, ...(signal === undefined ? [] : [signal]), AbortSignal.timeout(30_000)]), redirect: "error",
			});
			if (!response.ok || !response.body) throw new TelegramError("Telegram 文件下载失败");
			if (Number(response.headers.get("content-length")) > DOWNLOAD_LIMIT) {
				await response.body.cancel();
				throw new TelegramError("Telegram 下载文件超过 20 MiB");
			}
			const reader = response.body.getReader();
			const chunks: Buffer[] = [];
			let size = 0;
			try {
				for (;;) {
					signal?.throwIfAborted();
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > DOWNLOAD_LIMIT) { await reader.cancel(); throw new TelegramError("Telegram 下载文件超过 20 MiB"); }
					chunks.push(Buffer.from(value));
				}
			} finally { reader.releaseLock(); }
			return Buffer.concat(chunks, size);
		} catch (error) {
			throw error instanceof TelegramError ? error : new TelegramError("Telegram 文件下载失败");
		}
	}
}
