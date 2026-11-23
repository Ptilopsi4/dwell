import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { TelegramBot, TelegramError, normalizeTelegramUpdate, telegramChatKey, telegramMessageKey, telegramFetch,
	type TelegramUpdate, type TelegramCallback } from "../src/telegram.ts";
import type { NormalizedMessage, TelegramDestination } from "../src/pipeline.ts";

const identity = { id: "123", username: "DwellTestBot" };
const destination: TelegramDestination = { kind: "telegram", botId: "123", chatId: "42" };
const token = "123:FAKE_TOKEN_FOR_TESTS_ONLY";
function update(text = "hello", overrides: Record<string, unknown> = {}): TelegramUpdate {
	return { update_id: 9, message: { message_id: 7, date: 10, chat: { id: 42, type: "private" },
		from: { id: 55, first_name: "Test" }, text, ...overrides } } as TelegramUpdate;
}

test("delivered unqualified group controls identify the current group without admitting ordinary chat", () => {
	for (const command of ["/allowgroup", "/disallowgroup", "/allowgroup@DwellTestBot"]) {
		const normalized = normalizeTelegramUpdate(update(command, { chat: { id: -400, type: "supergroup" } }), identity);
		assert.equal(normalized?.destination?.kind, "telegram");
		assert.equal(normalized?.chatId, "tg:123:-400");
		assert.equal(normalized?.mentionedBot, true);
	}
	for (const text of ["hello", "/allowgroup@AnotherBot", "@DwellTestBot hello"]) assert.equal(normalizeTelegramUpdate(update(text, { chat: { id: -400, type: "supergroup" } }), identity), null);
});
function ok(result: unknown): Response { return Response.json({ ok: true, result }); }
function failure(code: number, retryAfter?: number): Response {
	return Response.json({ ok: false, error_code: code, description: `secret ${token}`,
		parameters: { retry_after: retryAfter } }, { status: code });
}
type Request = { method: string; body: Record<string, unknown> | FormData; signal: AbortSignal; at: number };
function blocked(signal: AbortSignal): Promise<Response> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) reject(new Error(`aborted ${token}`));
		else signal.addEventListener("abort", () => reject(new Error(`aborted ${token}`)), { once: true });
	});
}
async function until(predicate: () => boolean): Promise<void> {
	const deadline = performance.now() + 5_000;
	while (performance.now() < deadline) { if (predicate()) return; await delay(1); }
	assert.fail("condition was not reached");
}
async function fixture(t: TestContext, options: {
	respond?: (request: Request) => Response | Promise<Response>;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	onMessage?: (message: NormalizedMessage) => Promise<void>;
	onCallback?: (callback: TelegramCallback) => Promise<void>;
	isDestinationAllowed?: (destination: TelegramDestination) => boolean;
	saved?: unknown;
} = {}) {
	const dir = await mkdtemp(join(tmpdir(), "dwell-telegram-"));
	const stateFile = join(dir, "cursor.json");
	if (options.saved !== undefined) await writeFile(stateFile, JSON.stringify(options.saved));
	let clock = 10_000;
	const waits: number[] = [];
	const requests: Request[] = [];
	const errors: TelegramError[] = [];
	const messages: NormalizedMessage[] = [];
	const callbacks: TelegramCallback[] = [];
	const fakeFetch: typeof fetch = async (url, init) => {
		const method = String(url).split("/").at(-1)!;
		const request = { method, body: init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body ?? "{}")), signal: init!.signal!, at: clock };
		requests.push(request);
		if (method === "getMe") return ok({ id: 123, username: identity.username, is_bot: true });
		if (method === "getWebhookInfo") return ok({ url: "" });
		if (options.respond) return options.respond(request);
		if (method === "getUpdates") return blocked(request.signal);
		return ok({ message_id: requests.length });
	};
	let bot: TelegramBot;
	try {
		bot = await TelegramBot.connect({ token, stateFile, fetch: fakeFetch,
			onError: (error) => errors.push(error),
			onMessage: options.onMessage ?? (async (message) => { messages.push(message); }),
			onCallback: options.onCallback ?? (async (callback) => { callbacks.push(callback); }),
			isDestinationAllowed: options.isDestinationAllowed,
			timing: { now: () => clock, sleep: async (ms, signal) => { assert.equal(signal.aborted, false); waits.push(ms); await options.sleep?.(ms, signal); clock += ms; } },
		});
	} catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
	t.after(async () => { await bot.close(); await rm(dir, { recursive: true, force: true }); });
	return { bot, stateFile, dir, requests, waits, errors, messages, callbacks, advanceClock: (ms: number) => { clock += ms; } };
}

test("Telegram activity merges same-topic leases, rotates topics once per chat interval, and stops on release", async (t) => {
	const f = await fixture(t);
	t.mock.timers.enable({ apis: ["setInterval"] });
	const first = { ...destination, chatId: "-42", threadId: "7" };
	const second = { ...first, threadId: "8" };
	const stopFirst = f.bot.startActivity(first);
	const stopDuplicate = f.bot.startActivity(first);
	const controller = new AbortController();
	f.bot.startActivity(second, controller.signal);
	await setImmediate();
	const actions = () => f.requests.filter((request) => request.method === "sendChatAction");
	assert.deepEqual(actions().map((request) => request.body), [{ chat_id: "-42", message_thread_id: 7, action: "typing" }]);
	f.advanceClock(4_000); t.mock.timers.tick(4_000); await setImmediate();
	assert.deepEqual(actions().map((request) => (request.body as Record<string, unknown>).message_thread_id), [7, 8]);
	stopFirst();
	f.advanceClock(4_000); t.mock.timers.tick(4_000); await setImmediate();
	assert.deepEqual(actions().map((request) => (request.body as Record<string, unknown>).message_thread_id), [7, 8, 7]);
	stopDuplicate(); controller.abort();
	f.advanceClock(8_000); t.mock.timers.tick(8_000); await setImmediate();
	assert.equal(actions().length, 3);
	const stopRestarted = f.bot.startActivity(first);
	await setImmediate();
	assert.equal(actions().length, 4);
	stopRestarted();
	const stopImmediate = f.bot.startActivity(first);
	await setImmediate();
	assert.equal(actions().length, 4, "Restarting a lease cannot bypass the chat activity interval");
	stopImmediate();
});

test("Telegram activity yields to queued messages and an in-flight action cannot block a real reply", async (t) => {
	const f = await fixture(t, { respond: (request) => request.method === "sendChatAction" ? blocked(request.signal) : ok({ message_id: 7 }) });
	const stop = f.bot.startActivity(destination);
	await until(() => f.requests.some((request) => request.method === "sendChatAction"));
	await f.bot.send(destination, "Real answer");
	assert.deepEqual(f.waits, [], "Activity must not consume a formal message's send interval");
	const action = f.requests.find((request) => request.method === "sendChatAction")!;
	stop();
	assert.equal(action.signal.aborted, true);

	let release!: () => void;
	const queued = await fixture(t, { respond: async (request) => {
		if (request.method === "sendMessage") await new Promise<void>((resolve) => { release = resolve; });
		return ok({ message_id: 8 });
	} });
	const reply = queued.bot.send(destination, "Pending reply");
	await until(() => queued.requests.some((request) => request.method === "sendMessage"));
	const stopQueued = queued.bot.startActivity(destination);
	await setImmediate();
	assert.equal(queued.requests.filter((request) => request.method === "sendChatAction").length, 0);
	stopQueued(); release(); await reply;
});

test("Telegram activity failures are quiet, never retry immediately, and respect token cooldown", async (t) => {
	for (const code of [400, 401, 429, 500]) {
		const f = await fixture(t, { respond: (request) => request.method === "sendChatAction" ? failure(code, code === 429 ? 1 : undefined) : ok({ message_id: 7 }) });
		const stop = f.bot.startActivity(destination);
		await setImmediate();
		assert.equal(f.requests.filter((request) => request.method === "sendChatAction").length, 1);
		assert.equal(f.bot.status(), "ready");
		assert.deepEqual(f.errors, []);
		stop();
		await f.bot.send(destination, "Ordinary input remains available");
		assert.deepEqual(f.waits, code === 429 ? [1_000] : []);
	}
});

test("Telegram close aborts an activity request and clears its heartbeat", async (t) => {
	const f = await fixture(t, { respond: (request) => blocked(request.signal) });
	t.mock.timers.enable({ apis: ["setInterval"] });
	f.bot.startActivity(destination);
	await until(() => f.requests.some((request) => request.method === "sendChatAction"));
	const action = f.requests.find((request) => request.method === "sendChatAction")!;
	await f.bot.close();
	assert.equal(action.signal.aborted, true);
	f.advanceClock(12_000); t.mock.timers.tick(12_000); await setImmediate();
	assert.equal(f.requests.filter((request) => request.method === "sendChatAction").length, 1);
});

test("a send refused because the connection is already closed is marked as never sent", async (t) => {
	const f = await fixture(t);
	await f.bot.close();
	await assert.rejects(f.bot.send(destination, "late"), (error: unknown) => error instanceof TelegramError && error.notSent === true && error.uncertain === false);
});

test("unchanged message edits are idempotent while other 400 responses remain failures", async (t) => {
	const f = await fixture(t, { respond: (request) => Response.json({ ok: false, error_code: 400, description: request.method === "editMessageText" ? "Bad Request: message is not modified: specified content is exactly the same" : "Bad Request: message is not modified" }, { status: 400 }) });
	await f.bot.edit(destination, telegramMessageKey(destination, 7), "Already delivered");
	await assert.rejects(f.bot.send(destination, "New content"), (error: unknown) => error instanceof TelegramError && error.code === 400);
	const rejected = await fixture(t, { respond: () => failure(400) });
	await assert.rejects(rejected.bot.edit(destination, telegramMessageKey(destination, 7), "Other edit"), (error: unknown) => error instanceof TelegramError && error.code === 400 && !error.message.includes(token));
});

test("Telegram IDs include bot and chat while topic remains a delivery field", () => {
	assert.equal(telegramChatKey("123", -42), "tg:123:-42");
	assert.equal(telegramMessageKey(destination, 7), "tg:123:42:7");
	const normalized = normalizeTelegramUpdate(update("/ask@DwellTestBot hello", { message_thread_id: 88 }), identity)!;
	assert.equal(normalized.content, "hello");
	assert.equal(normalized.requestId, "tg-update:123:9");
	assert.equal(normalized.senderId, "tg:55");
	assert.equal(normalized.messageId, "tg:123:42:7");
	assert.equal(normalized.chatId, "tg:123:42");
	assert.equal(normalized.threadId, "88");
	assert.equal(normalized.createTime, 10_000);
	assert.deepEqual(normalized.destination, { ...destination, threadId: "88" });
});

test("Telegram retains empty asks for host guidance while attachment-only asks remain media", () => {
	assert.equal(normalizeTelegramUpdate(update("/ask"), identity)?.content, "/ask");
	assert.equal(normalizeTelegramUpdate(update("/ask@DwellTestBot \n\t"), identity)?.content, "/ask");
	assert.equal(normalizeTelegramUpdate(update("/start@DwellTestBot"), identity)?.content, "/start");
	for (const attachment of [{ photo: [{ file_id: "image" }] }, { document: { file_id: "document", file_name: "notes.txt" } }]) {
		const normalized = normalizeTelegramUpdate(update("", { text: undefined, caption: "/ask@DwellTestBot", ...attachment }), identity)!;
		assert.equal(normalized.content, "");
		assert.equal(normalized.resources.length, 1);
	}
});

test("Telegram privacy mode admits addressed commands or actual replies, never a topic alone", () => {
	const group = { chat: { id: -42, type: "supergroup" }, message_thread_id: 88 };
	assert.equal(normalizeTelegramUpdate(update("hello", group), identity), null);
	assert.equal(normalizeTelegramUpdate(update("/ask hello", group), identity), null);
	assert.equal(normalizeTelegramUpdate(update("/ask@someoneElse hello", group), identity), null);
	assert.equal(normalizeTelegramUpdate(update("@DwellTestBot hello", group), identity), null);
	assert.equal(normalizeTelegramUpdate(update("/status@dwelltestbot", group), identity)?.content, "/status");
	assert.equal(normalizeTelegramUpdate(update("/unknown@dwelltestbot one two", group), identity)?.content, "/unknown one two");
	const reply = update("hello", { ...group, reply_to_message: { message_id: 6, from: { id: 123, is_bot: true } } });
	const normalized = normalizeTelegramUpdate(reply, identity)!;
	assert.equal(normalized.mentionedBot, true);
	assert.equal(normalized.replyToMessageId, "tg:123:-42:6");
	assert.equal(normalizeTelegramUpdate(update("hello", { ...group, reply_to_message: { message_id: 6, from: { id: 999, is_bot: true } } }), identity), null);
});

test("Telegram ignores bots, anonymous senders, channels and edited updates", () => {
	assert.equal(normalizeTelegramUpdate(update("hi", { from: { id: 55, is_bot: true } }), identity), null);
	assert.equal(normalizeTelegramUpdate(update("hi", { sender_chat: { id: -42 } }), identity), null);
	assert.equal(normalizeTelegramUpdate(update("hi", { from: undefined }), identity), null);
	assert.equal(normalizeTelegramUpdate(update("hi", { chat: { id: -42, type: "channel" } }), identity), null);
	assert.equal(normalizeTelegramUpdate({ update_id: 1, edited_message: update().message } as TelegramUpdate, identity), null);
	assert.equal(normalizeTelegramUpdate(update("/ask@someoneElse hello"), identity), null);
});

test("Telegram photos and documents retain captions and unsupported media is represented", () => {
	const photo = normalizeTelegramUpdate(update("", { text: undefined, caption: "describe", photo: [{ file_id: "small" }, { file_id: "large" }] }), identity)!;
	assert.deepEqual(photo.resources, [{ type: "image", fileKey: "large" }]);
	assert.equal(photo.content, "describe");
	const document = normalizeTelegramUpdate(update("", { text: undefined, caption: "read", document: { file_id: "doc", file_name: "notes.txt" } }), identity)!;
	assert.deepEqual(document.resources, [{ type: "file", fileKey: "doc", fileName: "notes.txt" }]);
	const unsupported = normalizeTelegramUpdate(update("", { text: undefined, voice: { file_id: "voice" } }), identity)!;
	assert.equal(unsupported.rawContentType, "voice");
	assert.deepEqual(unsupported.resources, []);
});

test("Telegram refuses an existing webhook without deleting it", async () => {
	const calls: string[] = [];
	await assert.rejects(TelegramBot.connect({ token,
		onMessage: async () => {}, onCallback: async () => {}, onError: () => {},
		fetch: async (url) => {
			const method = String(url).split("/").at(-1)!; calls.push(method);
			return method === "getMe" ? ok({ id: 123, username: identity.username }) : ok({ url: "https://already-configured.test" });
		},
	}), (error: unknown) => error instanceof TelegramError && error.code === 409);
	assert.deepEqual(calls, ["getMe", "getWebhookInfo"]);
});

test("Telegram connect discards raw network errors and their token-bearing causes", async () => {
	await assert.rejects(TelegramBot.connect({ token,
		onMessage: async () => {}, onCallback: async () => {}, onError: () => {},
		fetch: async () => { throw new Error(`https://api.telegram.org/bot${token}/getMe`, { cause: new Error(token) }); },
	}), (error: unknown) => {
		assert.ok(error instanceof TelegramError);
		assert.equal(error.cause, undefined);
		assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(token), false);
		return true;
	});
});

test("Telegram skips a handler update after repeated failures instead of failing the bot", async (t) => {
	// 毒消息：重试 6 次后跳过（游标推进、告警留痕），传输层继续服务，onFatal 不触发
	let attempts = 0;
	let fatal = 0;
	const ids: string[] = [];
	const f = await fixture(t, {
		respond: async (request) => request.method === "getUpdates" && (request.body as { offset: number }).offset === 0 ? ok([update()]) : blocked(request.signal),
		onMessage: async (message) => { ids.push(message.requestId!); attempts++; throw new Error(`poison ${message.requestId}`); },
	});
	f.bot.start();
	await until(() => f.requests.some((r) => r.method === "getUpdates" && (r.body as { offset: number }).offset === 10));
	assert.equal(attempts, 6, "第六次失败后跳过，不再重试");
	assert.deepEqual(JSON.parse(await readFile(f.stateFile, "utf8")), { botId: "123", offset: 10 }, "游标已跳过毒消息");
	assert.equal(f.errors.some((error) => error.message.includes("已跳过该消息")), true, "跳过已告警");
	assert.equal(f.bot.status() !== "failed", true, "bot 未进入 failed");
});

test("Telegram cursor advances only after durable admission; failed handlers replay the same request ID", async (t) => {
	let attempts = 0;
	const ids: string[] = [];
	const f = await fixture(t, {
		respond: async (request) => request.method === "getUpdates" && (request.body as { offset: number }).offset === 0 ? ok([update()]) : blocked(request.signal),
		onMessage: async (message) => { ids.push(message.requestId!); if (++attempts === 1) throw new Error(token); },
	});
	assert.equal(f.bot.status(), "ready");
	f.bot.start(); f.bot.start();
	await until(() => f.requests.filter((r) => r.method === "getUpdates").length >= 3);
	assert.deepEqual(ids, ["tg-update:123:9", "tg-update:123:9"]);
	assert.deepEqual(f.requests.filter((r) => r.method === "getUpdates").map((r) => (r.body as { offset: number }).offset), [0, 0, 10]);
	assert.deepEqual(JSON.parse(await readFile(f.stateFile, "utf8")), { botId: "123", offset: 10 });
	assert.equal(f.errors.length, 1);
	assert.equal(f.errors[0]!.stack!.includes(token), false);
});

test("Telegram persisted cursors are scoped to the bot", async (t) => {
	const matching = await fixture(t, { saved: { botId: "123", offset: 19 } });
	matching.bot.start();
	await until(() => matching.requests.some((r) => r.method === "getUpdates"));
	assert.equal((matching.requests.at(-1)!.body as { offset: number }).offset, 19);
	const other = await fixture(t, { saved: { botId: "999", offset: 999 } });
	other.bot.start();
	await until(() => other.requests.some((r) => r.method === "getUpdates"));
	assert.equal((other.requests.at(-1)!.body as { offset: number }).offset, 0);
});

test("Telegram rejects callbacks attached to another bot's message before host handling", async (t) => {
	let polls = 0;
	const callbacks = [999, 123].map((id, index) => ({ update_id: index + 1, callback_query: {
		id: `callback-${id}`, from: { id: 55 }, data: "dwell:allowchat",
		message: { ...update().message!, from: { id, is_bot: true } },
	} }));
	const f = await fixture(t, { respond: (request) => request.method === "getUpdates" && polls++ === 0 ? ok(callbacks) : blocked(request.signal) });
	f.bot.start();
	await until(() => polls >= 2);
	assert.deepEqual(f.callbacks.map((callback) => callback.id), ["callback-123"]);
});

test("Telegram checks admission after queueing and reserves control replies for the host", async (t) => {
	let allowed = true;
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => { finish = resolve; });
	const f = await fixture(t, { isDestinationAllowed: () => allowed,
		respond: async (request) => { if ((request.body as Record<string, unknown>).text === "first") await pending; return ok({ message_id: 7 }); } });
	const first = f.bot.send(destination, "first");
	await until(() => f.requests.some((request) => request.method === "sendMessage"));
	const second = assert.rejects(f.bot.send(destination, "must not leave the queue"), (error: unknown) => error instanceof TelegramError && !error.uncertain && error.code === undefined);
	allowed = false;
	finish();
	await first;
	await second;
	await assert.rejects(f.bot.edit(destination, "tg:123:42:7", "blocked edit"), /未启用/);
	await assert.rejects(f.bot.sendFile(destination, Buffer.from("private"), "private.txt"), /未启用/);
	assert.equal(f.requests.filter((request) => ["sendMessage", "editMessageText", "sendDocument"].includes(request.method)).length, 1);
	await f.bot.sendControl(destination, "群白名单管理仅 dwell 管理员可用。");
	await f.bot.acknowledge("control-callback", "已处理");
	assert.equal(f.requests.filter((request) => request.method === "sendMessage").length, 2);
	assert.equal(f.bot.status(), "ready");
	assert.equal(f.errors.length, 0);
});

test("Telegram stops later chunks, entity retries, and rate-limit retries when admission is revoked", async (t) => {
	for (const mode of ["chunks", "entities", "rate-limit"] as const) {
		let allowed = true;
		const f = await fixture(t, { isDestinationAllowed: () => allowed, respond: () => {
			allowed = false;
			if (mode === "entities") return Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 });
			if (mode === "rate-limit") return failure(429, 1);
			return ok({ message_id: 7 });
		} });
		await assert.rejects(f.bot.send(destination, mode === "chunks" ? "x".repeat(9000) : "**message**", { format: "markdown" }), /未启用/);
		assert.equal(f.requests.filter((request) => request.method === "sendMessage").length, 1, mode);
	}
});

test("Telegram rechecks admission after throttle waits and suppresses disabled chat activity", async (t) => {
	let allowed = true;
	const f = await fixture(t, { isDestinationAllowed: () => allowed, sleep: async () => { allowed = false; } });
	await f.bot.send(destination, "first");
	await assert.rejects(f.bot.send(destination, "blocked after wait"), /未启用/);
	t.mock.timers.enable({ apis: ["setInterval"] });
	const stop = f.bot.startActivity(destination);
	await setImmediate();
	f.advanceClock(4_000); t.mock.timers.tick(4_000); await setImmediate();
	stop();
	assert.equal(f.requests.filter((request) => request.method === "sendChatAction").length, 0);
	assert.equal(f.requests.filter((request) => request.method === "sendMessage").length, 1);
});

test("Telegram awaits callbacks and intentionally skips irrelevant updates before saving cursor", async (t) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	let seen: TelegramCallback | undefined;
	const updates = [{ update_id: 1, callback_query: { id: "callback", from: { id: 55 }, data: "opaque",
		message: { ...update().message!, from: { id: 123, is_bot: true }, message_thread_id: 88 } } }, { update_id: 2 }];
	let polls = 0;
	const f = await fixture(t, { respond: (r) => r.method === "getUpdates" && polls++ === 0 ? ok(updates) : blocked(r.signal),
		onCallback: async (callback) => { seen = callback; await pending; } });
	f.bot.start();
	await until(() => seen !== undefined);
	await assert.rejects(readFile(f.stateFile), { code: "ENOENT" });
	assert.equal(seen!.messageId, "tg:123:42:7");
	assert.equal(seen!.destination.threadId, "88");
	release();
	await until(() => polls >= 2);
	assert.deepEqual(JSON.parse(await readFile(f.stateFile, "utf8")), { botId: "123", offset: 3 });
});

test("Telegram cursor write failure retains offset and stops after bounded recovery", async (t) => {
	let admits = 0;
	const f = await fixture(t, { respond: () => ok([update()]), onMessage: async () => { admits++; } });
	await rm(f.dir, { recursive: true });
	f.bot.start();
	await until(() => f.bot.status() === "failed");
	assert.equal(admits, 6);
	assert.equal(f.errors.length, 6);
	assert.deepEqual(new Set(f.requests.filter((r) => r.method === "getUpdates").map((r) => (r.body as { offset: number }).offset)), new Set([0]));
});

test("Telegram 409 poller conflicts fail visibly without retry", async (t) => {
	const f = await fixture(t, { respond: () => failure(409) });
	f.bot.start();
	await until(() => f.bot.status() === "failed");
	assert.equal(f.requests.filter((r) => r.method === "getUpdates").length, 1);
	assert.equal(f.errors[0]!.code, 409);
	assert.equal(f.errors[0]!.stack!.includes(token), false);
});

test("Telegram polling reconnects after more than six transport failures with capped backoff", async (t) => {
	let polls = 0;
	const f = await fixture(t, { respond: (request) => {
		polls++;
		if (polls <= 10) throw new Error("temporary connection failure");
		if (polls === 11) return ok([update()]);
		return blocked(request.signal);
	} });
	f.bot.start();
	await until(() => polls === 12);
	assert.equal(f.bot.status(), "polling");
	assert.equal(f.messages.length, 1);
	assert.equal(f.errors.length, 10);
	assert.deepEqual(f.waits.slice(0, 10), [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
	assert.deepEqual(JSON.parse(await readFile(f.stateFile, "utf8")), { botId: "123", offset: 10 });
});

test("Telegram invalid credentials stop polling without retrying", async (t) => {
	const f = await fixture(t, { respond: () => failure(401) });
	f.bot.start();
	await until(() => f.bot.status() === "failed");
	assert.equal(f.errors.length, 1);
	assert.equal(f.errors[0].code, 401);
});

test("Telegram close aborts and joins a pending long poll", async (t) => {
	const f = await fixture(t);
	f.bot.start();
	await until(() => f.requests.some((r) => r.method === "getUpdates"));
	const request = f.requests.find((r) => r.method === "getUpdates")!;
	assert.equal((request.body as { timeout: number }).timeout, 25);
	await f.bot.close();
	assert.equal(request.signal.aborted, true);
	assert.equal(f.bot.status(), "off");
	assert.deepEqual(f.errors, []);
});

test("Telegram chunks plain text without breaking surrogates and attaches buttons only to the last message", async (t) => {
	const f = await fixture(t);
	const text = `${"x".repeat(4095)}😀${"y".repeat(4096)}`;
	const sent = await f.bot.send(destination, text, { replyTo: "tg:123:42:2", buttons: [[{ text: "approve", data: "opaque" }]] });
	const bodies = f.requests.filter((r) => r.method === "sendMessage").map((r) => r.body as Record<string, unknown>);
	assert.equal(bodies.length, 3);
	assert.equal(bodies.map((b) => b.text).join(""), text);
	for (const body of bodies) {
		assert.ok(String(body.text).length <= 4096);
		assert.equal(/[\uD800-\uDBFF]$/.test(String(body.text)), false);
		assert.equal(body.parse_mode, undefined);
		assert.deepEqual(body.reply_parameters, { message_id: 2, allow_sending_without_reply: true });
	}
	assert.equal(bodies[0]!.reply_markup, undefined);
	assert.deepEqual(bodies.at(-1)!.reply_markup, { inline_keyboard: [[{ text: "approve", callback_data: "opaque" }]] });
	assert.equal(sent.messageIds.length, 3);
	assert.equal(sent.messageId, sent.messageIds.at(-1));
});

test("Telegram send and edit use rendered text and entities while explicit plain mode preserves literals", async (t) => {
	const f = await fixture(t);
	await f.bot.send(destination, "**bold** [link](https://example.com)", { format: "markdown" });
	await f.bot.edit(destination, "tg:123:42:3", "*edited* `code`", undefined, { format: "markdown" });
	await f.bot.send(destination, "**literal**", { format: "plain" });
	await f.bot.edit(destination, "tg:123:42:3", "*literal*", undefined, { format: "plain" });
	const bodies = f.requests.filter((r) => ["sendMessage", "editMessageText"].includes(r.method)).map((r) => r.body as Record<string, unknown>);
	assert.equal(bodies[0]!.text, "bold link");
	assert.deepEqual(bodies[0]!.entities, [{ type: "bold", offset: 0, length: 4 }, { type: "text_link", url: "https://example.com", offset: 5, length: 4 }]);
	assert.equal(bodies[1]!.text, "edited code");
	assert.deepEqual(bodies[1]!.entities, [{ type: "italic", offset: 0, length: 6 }, { type: "code", offset: 7, length: 4 }]);
	assert.equal(bodies[2]!.text, "**literal**");
	assert.equal(bodies[3]!.text, "*literal*");
	assert.equal(bodies[2]!.entities, undefined);
	assert.equal(bodies[3]!.entities, undefined);
	for (const body of bodies) assert.equal(body.parse_mode, undefined);
});

test("Telegram defaults preserve approval commands and relayed user text without Markdown interpretation", async (t) => {
	const f = await fixture(t);
	const text = "待审批命令：rm -rf '**/cache/**'\n输入文本：**literal** <raw>";
	await f.bot.send(destination, text);
	await f.bot.edit(destination, "tg:123:42:3", text);
	for (const request of f.requests.filter((r) => ["sendMessage", "editMessageText"].includes(r.method))) {
		const body = request.body as Record<string, unknown>;
		assert.equal(body.text, text);
		assert.equal(body.entities, undefined);
		assert.equal(body.parse_mode, undefined);
	}
});

test("Telegram intermediate previews may edit only the first rendered chunk without sending extras", async (t) => {
	const f = await fixture(t);
	const text = `**preview**\n\n${Array.from({ length: 500 }, () => "---").join("\n\n")}`;
	assert.ok(text.length < 4096);
	await assert.rejects(f.bot.edit(destination, "tg:123:42:3", text, undefined, { format: "markdown" }), /长度/);
	await f.bot.edit(destination, "tg:123:42:3", text, undefined, { format: "markdown", preview: true });
	const requests = f.requests.filter((r) => ["sendMessage", "editMessageText"].includes(r.method));
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.method, "editMessageText");
	const body = requests[0]!.body as { text: string; entities: unknown };
	assert.equal(body.text.length, 4096);
	assert.ok(body.text.startsWith("preview\n\n────────"));
	assert.deepEqual(body.entities, [{ type: "bold", offset: 0, length: 7 }]);
	await assert.rejects(f.bot.edit(destination, "tg:123:42:3", "x".repeat(4097), undefined, { format: "markdown", preview: true }), /长度/);
});

test("Telegram chunks the rendered document and keeps long pre entities valid", async (t) => {
	const f = await fixture(t);
	const code = `${"x".repeat(4095)}😀${"y".repeat(4096)}`;
	await f.bot.send(destination, `\`\`\`js\n${code}\n\`\`\``, { buttons: [[{ text: "done", data: "ok" }]], format: "markdown" });
	const bodies = f.requests.filter((r) => r.method === "sendMessage").map((r) => r.body as { text: string; entities: unknown; reply_markup?: unknown });
	assert.equal(bodies.length, 3);
	assert.equal(bodies.map((body) => body.text).join(""), code);
	for (const body of bodies) assert.deepEqual(body.entities, [{ type: "pre", language: "js", offset: 0, length: body.text.length }]);
	assert.equal(bodies[0]!.reply_markup, undefined);
	assert.ok(bodies.at(-1)!.reply_markup);
});

test("Telegram retries an explicit entity rejection once as plain text inside the same ordered queue", async (t) => {
	let calls = 0;
	const f = await fixture(t, { respond: () => ++calls === 1
		? Response.json({ ok: false, error_code: 400, description: `Bad Request: entity bounds invalid ${token}` }, { status: 400 })
		: ok({ message_id: calls }) });
	const buttons = [[{ text: "approve", data: "opaque" }]];
	await Promise.all([f.bot.send(destination, "**first**", { replyTo: "tg:123:42:2", buttons, format: "markdown" }), f.bot.send(destination, "second")]);
	const requests = f.requests.filter((r) => r.method === "sendMessage");
	const bodies = requests.map((r) => r.body as Record<string, unknown>);
	assert.deepEqual(requests.map((r) => r.at), [10_000, 11_000, 12_000]);
	assert.deepEqual(bodies.map((body) => body.text), ["first", "first", "second"]);
	const { entities, ...plain } = bodies[0]!;
	assert.ok(entities);
	assert.deepEqual(bodies[1], plain);
	assert.deepEqual(bodies[1]!.reply_parameters, { message_id: 2, allow_sending_without_reply: true });
	assert.deepEqual(bodies[1]!.reply_markup, { inline_keyboard: [[{ text: "approve", callback_data: "opaque" }]] });
});

test("Telegram formatted edits retry rejected entities once while unchanged edits stay idempotent", async (t) => {
	let calls = 0;
	const f = await fixture(t, { respond: () => ++calls === 1
		? Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 }) : ok({}) });
	await f.bot.edit(destination, "tg:123:42:3", "**edited**", undefined, { format: "markdown" });
	const bodies = f.requests.filter((r) => r.method === "editMessageText").map((r) => r.body as Record<string, unknown>);
	assert.equal(bodies.length, 2);
	assert.equal(bodies[0]!.text, "edited");
	assert.ok(bodies[0]!.entities);
	assert.deepEqual(bodies[1], { chat_id: "42", message_id: 3, text: "edited" });
	const unchanged = await fixture(t, { respond: () => Response.json({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, { status: 400 }) });
	await unchanged.bot.edit(destination, "tg:123:42:3", "**edited**", undefined, { format: "markdown" });
	assert.equal(unchanged.requests.filter((r) => r.method === "editMessageText").length, 1);
});

test("Telegram entity fallback is bounded and unrelated failures never trigger plain-text retries", async (t) => {
	const invalid = await fixture(t, { respond: () => Response.json({ ok: false, error_code: 400, description: "Bad Request: ENTITY_BOUNDS_INVALID" }, { status: 400 }) });
	await assert.rejects(invalid.bot.send(destination, "**bold**", { format: "markdown" }), (error: unknown) => error instanceof TelegramError && error.code === 400);
	assert.equal(invalid.requests.filter((r) => r.method === "sendMessage").length, 2);
	const plain = await fixture(t, { respond: () => Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 }) });
	await assert.rejects(plain.bot.send(destination, "literal"), TelegramError);
	assert.equal(plain.requests.filter((r) => r.method === "sendMessage").length, 1);
	const unrelated = await fixture(t, { respond: () => failure(400) });
	await assert.rejects(unrelated.bot.send(destination, "**bold**", { format: "markdown" }), TelegramError);
	assert.equal(unrelated.requests.filter((r) => r.method === "sendMessage").length, 1);
	const limited = await fixture(t, { respond: () => failure(429, 1) });
	await assert.rejects(limited.bot.send(destination, "**bold**", { format: "markdown" }), TelegramError);
	assert.equal(limited.requests.filter((r) => r.method === "sendMessage").length, 3);
	for (const request of limited.requests.filter((r) => r.method === "sendMessage")) assert.ok((request.body as Record<string, unknown>).entities);
	const uncertain = await fixture(t, { respond: () => { throw new Error(token); } });
	await assert.rejects(uncertain.bot.send(destination, "**bold**", { format: "markdown" }), (error: unknown) => error instanceof TelegramError && error.uncertain);
	assert.equal(uncertain.requests.filter((r) => r.method === "sendMessage").length, 1);
});

test("Telegram send and edit share per-chat throttling across topics", async (t) => {
	const f = await fixture(t);
	await Promise.all([f.bot.send(destination, "first"), f.bot.send({ ...destination, threadId: "99" }, "second")]);
	await f.bot.edit(destination, "tg:123:42:3", "edited");
	const privateRequests = f.requests.filter((r) => ["sendMessage", "editMessageText"].includes(r.method));
	assert.deepEqual(privateRequests.map((r) => r.at), [10_000, 11_000, 12_000]);
	const group = { ...destination, chatId: "-42", threadId: "88" };
	await f.bot.send(group, "one");
	await f.bot.send(group, "two");
	const groupRequests = f.requests.filter((r) => (r.body as { chat_id?: string }).chat_id === "-42");
	assert.equal(groupRequests[1]!.at - groupRequests[0]!.at, 3000);
	assert.equal((groupRequests[0]!.body as { message_thread_id: number }).message_thread_id, 88);
});

test("Telegram explicit 429 retries with retry_after and shares token cooldown across chats", async (t) => {
	let sends = 0;
	const f = await fixture(t, { respond: () => ++sends === 1 ? failure(429, 2) : ok({ message_id: sends }) });
	await f.bot.send(destination, "one");
	assert.deepEqual(f.requests.filter((r) => r.method === "sendMessage").map((r) => r.at), [10_000, 12_000]);
	let limited = true;
	const shared = await fixture(t, { respond: () => limited ? failure(429, 120) : ok({ message_id: 1 }) });
	await assert.rejects(shared.bot.send(destination, "one"), (e: unknown) => e instanceof TelegramError && e.retryAfter === 120);
	limited = false;
	await shared.bot.send({ ...destination, chatId: "43" }, "two");
	assert.deepEqual(shared.requests.filter((r) => r.method === "sendMessage").map((r) => r.at), [10_000, 130_000]);
});

test("Telegram rate-limit retries are bounded", async (t) => {
	const f = await fixture(t, { respond: () => failure(429, 1) });
	await assert.rejects(f.bot.send(destination, "one"), (e: unknown) => e instanceof TelegramError && e.code === 429 && !e.uncertain);
	assert.equal(f.requests.filter((r) => r.method === "sendMessage").length, 3);
});

test("Telegram queued messages remain spaced after token cooldown and zero-delay 429", async (t) => {
	let limited = true;
	let messageId = 0;
	const f = await fixture(t, { respond: () => limited ? failure(429, 120) : ok({ message_id: ++messageId }) });
	await assert.rejects(f.bot.send(destination, "limited"), (e: unknown) => e instanceof TelegramError && e.code === 429);
	limited = false;
	await Promise.all([f.bot.send(destination, "first"), f.bot.send(destination, "second")]);
	assert.deepEqual(f.requests.filter((r) => r.method === "sendMessage").map((r) => r.at), [10_000, 130_000, 131_000]);
	let tries = 0;
	const zero = await fixture(t, { respond: () => ++tries === 1 ? failure(429, 0) : ok({ message_id: 1 }) });
	await zero.bot.send(destination, "one");
	assert.deepEqual(zero.requests.filter((r) => r.method === "sendMessage").map((r) => r.at), [10_000, 11_000]);
});

test("Telegram close aborts a queued throttle wait and prevents further sends", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-telegram-close-"));
	let sendCalls = 0;
	let waiting = false;
	const bot = await TelegramBot.connect({ token, stateFile: join(dir, "cursor.json"),
		onMessage: async () => {}, onCallback: async () => {}, onError: () => {},
		fetch: async (url) => {
			const method = String(url).split("/").at(-1)!;
			if (method === "getMe") return ok({ id: 123, username: identity.username });
			if (method === "getWebhookInfo") return ok({ url: "" });
			return ok({ message_id: ++sendCalls });
		},
		timing: { now: () => 10_000, sleep: async (_ms, signal) => { waiting = true; await blocked(signal); } },
	});
	t.after(async () => { await bot.close(); await rm(dir, { recursive: true, force: true }); });
	await bot.send(destination, "first");
	const second = assert.rejects(bot.send(destination, "second"));
	await until(() => waiting);
	await bot.close();
	await second;
	assert.equal(sendCalls, 1);
	assert.equal(bot.status(), "off");
});

test("Telegram ambiguous send failures have no raw cause and are never blindly retried", async (t) => {
	const f = await fixture(t, { respond: () => { throw new Error(`https://api.telegram.org/bot${token}/sendMessage`, { cause: new Error(token) }); } });
	await assert.rejects(f.bot.send(destination, "hello", { replyTo: "tg:123:42:2" }), (error: unknown) => {
		assert.ok(error instanceof TelegramError);
		assert.equal(error.uncertain, true);
		assert.equal(error.cause, undefined);
		assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(token), false);
		return true;
	});
	assert.equal(f.requests.filter((r) => r.method === "sendMessage").length, 1);
});

test("Telegram missing reply anchors preserve delivery in the same chat and forum topic without retries", async (t) => {
	let messageId = 0;
	const f = await fixture(t, { respond: ({ body }) => {
		const reply = body instanceof FormData ? JSON.parse(String(body.get("reply_parameters"))) : body.reply_parameters as { allow_sending_without_reply?: boolean };
		return reply?.allow_sending_without_reply === true ? ok({ message_id: ++messageId })
			: Response.json({ ok: false, error_code: 400, description: "Bad Request: message to be replied not found" }, { status: 400 });
	} });
	for (const target of [destination, { ...destination, chatId: "-42", threadId: "88" }]) {
		const replyTo = telegramMessageKey(target, 2);
		await f.bot.send(target, "The source message was deleted.", { replyTo });
		await f.bot.sendFile(target, Buffer.from("result"), "result.txt", { replyTo });
	}
	const requests = f.requests.filter((request) => ["sendMessage", "sendDocument"].includes(request.method));
	assert.equal(requests.length, 4);
	for (const [index, { body }] of requests.entries()) {
		const address = body instanceof FormData ? Object.fromEntries(body.entries()) : body;
		assert.equal(address.chat_id, index < 2 ? "42" : "-42");
		assert.equal(String(address.message_thread_id ?? ""), index < 2 ? "" : "88");
	}
	const rejected = await fixture(t, { respond: () => failure(400) });
	await assert.rejects(rejected.bot.send(destination, "Unrelated invalid request", { replyTo: "tg:123:42:2" }), (error: unknown) => error instanceof TelegramError && error.code === 400 && !error.uncertain);
	assert.equal(rejected.requests.filter((request) => request.method === "sendMessage").length, 1);
});

test("Telegram reply anchors reject other bots and chats; edits and callbacks honor API bounds", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.bot.send(destination, "hello", { replyTo: "tg:999:42:1" }), /锚点/);
	await assert.rejects(f.bot.send(destination, "hello", { replyTo: "tg:123:43:1" }), /锚点/);
	await assert.rejects(f.bot.send({ ...destination, botId: "999" }, "hello"), /不匹配/);
	await assert.rejects(f.bot.edit(destination, "tg:123:42:1", "x".repeat(4097)), /长度/);
	await assert.rejects(f.bot.send(destination, "hello", { buttons: [[{ text: "x", data: "😀".repeat(17) }]] }), /按钮/);
	await f.bot.acknowledge("callback");
	assert.deepEqual(f.requests.at(-1)!.body, { callback_query_id: "callback" });
});

test("Telegram file upload sends multipart data and binds destination/reply; oversized upload never sends", async (t) => {
	const f = await fixture(t);
	const sent = await f.bot.sendFile({ ...destination, threadId: "88" }, Buffer.from("hello"), "notes.txt", { replyTo: "tg:123:42:2" });
	const request = f.requests.find((r) => r.method === "sendDocument")!;
	assert.ok(request.body instanceof FormData);
	assert.equal(request.body.get("chat_id"), "42");
	assert.equal(request.body.get("message_thread_id"), "88");
	assert.equal(request.body.get("reply_parameters"), '{"message_id":2,"allow_sending_without_reply":true}');
	const file = request.body.get("document") as File;
	assert.equal(file.name, "notes.txt");
	assert.equal(await file.text(), "hello");
	assert.equal(sent.messageId, "tg:123:42:3");
	await assert.rejects(f.bot.sendFile(destination, Buffer.alloc(10 * 1024 * 1024 + 1), "image.jpg", { image: true }), /大小限制/);
	assert.equal(f.requests.filter((r) => r.method === "sendPhoto").length, 0);
});

test("Telegram downloads enforce getFile size before making a tokenized download request", async (t) => {
	const f = await fixture(t, { respond: () => ok({ file_path: "documents/file", file_size: 20 * 1024 * 1024 + 1 }) });
	await assert.rejects(f.bot.download("doc"), /20 MiB/);
	assert.deepEqual(f.requests.map((r) => r.method), ["getMe", "getWebhookInfo", "getFile"]);
});

for (const stage of ["getFile", "download", "body"] as const) test(`Telegram input cancellation aborts ${stage} without exposing tokenized URLs`, async (t) => {
	const controller = new AbortController();
	let waiting = false;
	let pendingSignal: AbortSignal | undefined;
	const f = await fixture(t, { respond: (request) => {
		if (request.method === "getFile" && stage !== "getFile") return ok({ file_path: "documents/file" });
		pendingSignal = request.signal;
		waiting = true;
		if (stage !== "body") return blocked(request.signal);
		return new Response(new ReadableStream<Uint8Array>({
			start(stream) { request.signal.addEventListener("abort", () => stream.error(new Error(`download aborted ${token}`)), { once: true }); },
		}));
	} });
	const pending = assert.rejects(f.bot.download("doc", controller.signal), (error: unknown) => {
		assert.ok(error instanceof TelegramError);
		assert.doesNotMatch(error.stack ?? "", /FAKE_TOKEN|\/file\/bot/);
		assert.equal(error.cause, undefined);
		return true;
	});
	await until(() => waiting);
	controller.abort();
	await pending;
	assert.equal(pendingSignal?.aborted, true);
});

test("Telegram cancelled getFile retry leaves cooldown waiting without another request", async (t) => {
	const controller = new AbortController();
	let waiting = false;
	const f = await fixture(t, {
		respond: () => failure(429, 30),
		sleep: async (_ms, signal) => {
			waiting = true;
			await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		},
	});
	const pending = assert.rejects(f.bot.download("doc", controller.signal), /abort/i);
	await until(() => waiting);
	controller.abort();
	await pending;
	assert.equal(f.requests.filter((request) => request.method === "getFile").length, 1);
	await assert.rejects(f.bot.download("doc", controller.signal), /abort/i);
	assert.equal(f.requests.filter((request) => request.method === "getFile").length, 1);
});

test("Telegram download caps Content-Length and streaming data; successful bytes remain intact", async (t) => {
	let mode = "success";
	let cancelled = false;
	const f = await fixture(t, { respond: (r) => {
		if (r.method === "getFile") return ok({ file_path: "documents/file" });
		if (mode === "header") return new Response("x", { headers: { "Content-Length": String(20 * 1024 * 1024 + 1) } });
		if (mode === "stream") return new Response(new ReadableStream<Uint8Array>({
			start(controller) { controller.enqueue(new Uint8Array(20 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); },
			cancel() { cancelled = true; },
		}));
		if (mode === "error") throw new Error(`https://api.telegram.org/file/bot${token}/documents/file`);
		return new Response(Buffer.from("downloaded"));
	} });
	assert.equal((await f.bot.download("doc")).toString(), "downloaded");
	mode = "header";
	await assert.rejects(f.bot.download("doc"), /20 MiB/);
	mode = "stream";
	await assert.rejects(f.bot.download("doc"), /20 MiB/);
	assert.equal(cancelled, true);
	mode = "error";
	await assert.rejects(f.bot.download("doc"), (e: unknown) => e instanceof TelegramError && !e.stack!.includes(token) && !e.cause);
});

test("TELEGRAM_PROXY 校验：未设置用全局 fetch，非法值拒绝且报错不回显 URL", () => {
	assert.equal(telegramFetch(undefined), fetch);
	assert.equal(telegramFetch(""), fetch);
	for (const bad of ["not a url", "ftp://example.invalid:8080", "telegram.org"]) {
		assert.throws(() => telegramFetch(bad), (e: unknown) => e instanceof TelegramError && !String(e.message).includes(bad) && !e.stack!.includes(bad), bad);
	}
	// 合法 scheme 构造不抛（后续请求才连代理）；带凭证的 URL 不进任何报错路径
	assert.equal(typeof telegramFetch("http://user:pass@192.168.128.1:7890"), "function");
	assert.equal(typeof telegramFetch("socks5://192.168.128.1:1080"), "function");
});
