import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { TelegramBot, TelegramError, normalizeTelegramUpdate, telegramChatKey, telegramMessageKey,
	type TelegramUpdate, type TelegramCallback } from "../src/telegram.ts";
import type { NormalizedMessage, TelegramDestination } from "../src/pipeline.ts";

const identity = { id: "123", username: "DwellTestBot" };
const destination: TelegramDestination = { kind: "telegram", botId: "123", chatId: "42" };
const token = "123:FAKE_TOKEN_FOR_TESTS_ONLY";
function update(text = "hello", overrides: Record<string, unknown> = {}): TelegramUpdate {
	return { update_id: 9, message: { message_id: 7, date: 10, chat: { id: 42, type: "private" },
		from: { id: 55, first_name: "Test" }, text, ...overrides } } as TelegramUpdate;
}
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
	for (let i = 0; i < 300; i++) { if (predicate()) return; await setImmediate(); }
	assert.fail("condition was not reached");
}
async function fixture(t: TestContext, options: {
	respond?: (request: Request) => Response | Promise<Response>;
	onMessage?: (message: NormalizedMessage) => Promise<void>;
	onCallback?: (callback: TelegramCallback) => Promise<void>;
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
			timing: { now: () => clock, sleep: async (ms, signal) => { assert.equal(signal.aborted, false); waits.push(ms); clock += ms; } },
		});
	} catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
	t.after(async () => { await bot.close(); await rm(dir, { recursive: true, force: true }); });
	return { bot, stateFile, dir, requests, waits, errors, messages, callbacks };
}

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

test("Telegram awaits callbacks and intentionally skips irrelevant updates before saving cursor", async (t) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	let seen: TelegramCallback | undefined;
	const updates = [{ update_id: 1, callback_query: { id: "callback", from: { id: 55 }, data: "opaque",
		message: { ...update().message!, message_thread_id: 88 } } }, { update_id: 2 }];
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
