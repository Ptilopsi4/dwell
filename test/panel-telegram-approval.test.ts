import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PendingApproval } from "../src/ext/approval.ts";
import type { JsonRecord } from "./telegram-main-hook.ts";
import { mainFixture, message } from "./telegram-main-fixture.ts";

async function post(base: string, path: string, body: JsonRecord): Promise<JsonRecord> {
	const response = await fetch(`${base}${path}`, {
		method: "POST", headers: { "content-type": "application/json", origin: base, connection: "close" },
		body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
	});
	assert.equal(response.status, 200);
	return await response.json() as JsonRecord;
}

async function pending(directory: string): Promise<PendingApproval[]> {
	const state = JSON.parse(await readFile(join(directory, "state", "approvals.json"), "utf8")) as { pending: [string, PendingApproval][] };
	return state.pending.map(([, approval]) => approval);
}

for (const target of ["private", "group", "topic"] as const) test(`ordinary Telegram ${target} approval retains its destination and local reply anchor`, { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [
		{ tool: "bash", arguments: { command: "ssh synthetic.invalid" } },
		{ text: "Ordinary Telegram approval is required." },
	]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(920, "/ask@AcceptanceBot Run the ordinary task requiring approval", target === "private" ? {} : {
			chat: { id: -300, type: "supergroup" }, ...(target === "topic" ? { message_thread_id: 9 } : {}),
		})]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:920" && event.body.state === "done");
		await f.stop();
		const card = f.requests("telegram", "sendMessage").find((event) => event.body.reply_markup !== undefined)!;
		assert.ok(card);
		assert.equal(card.body.chat_id, target === "private" ? "200" : "-300");
		assert.equal(card.body.message_thread_id, target === "topic" ? 9 : undefined);
		const anchor = (card.body.reply_parameters as { message_id: number }).message_id;
		assert.ok(anchor === 920 || f.requests("telegram", "sendMessage").some((event) => event.messageId === anchor && event.body.chat_id === card.body.chat_id && event.body.message_thread_id === card.body.message_thread_id));
		assert.equal((await pending(f.directory))[0]!.via, "telegram");
		assert.equal(f.requests("model").length, 2);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

for (const topic of [false, true]) test(`panel input on a Telegram ${topic ? "topic" : "group"} sends its approval privately without a foreign anchor`, { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [
		{ text: "Original group task prepared." },
		{ tool: "bash", arguments: { command: "ssh synthetic.invalid" } },
		{ text: "Panel approval is required." },
	], { panel: true });
	let passed = false;
	try {
		const listening = await f.until((event) => event.method === "panel.listening");
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(900, "/ask@AcceptanceBot Prepare the group task", {
			chat: { id: -300, type: "supergroup" }, ...(topic ? { message_thread_id: 9 } : {}),
		})]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:900" && event.body.state === "done");
		const routes = Object.values(JSON.parse(await readFile(join(f.directory, "state", "sessions.json"), "utf8"))) as { id: number; destination: JsonRecord }[];
		const conversationId = routes[0]!.id;
		await post(`http://127.0.0.1:${listening.body.port}`, "/api/send", { conv: conversationId, content: "Run the panel task requiring approval" });
		await f.until((event) => event.method === "telegram.output" && String(event.body.id).startsWith("tg-panel:") && event.body.state === "done");
		await f.stop();
		const approvals = await pending(f.directory);
		const cards = f.requests("telegram", "sendMessage").filter((event) => event.body.reply_markup !== undefined);
		assert.equal(cards.length, 1, "A panel task must receive one private approval notification");
		assert.equal(cards[0]!.body.chat_id, "200");
		assert.equal(cards[0]!.body.reply_parameters, undefined);
		assert.equal(cards[0]!.body.message_thread_id, undefined);
		assert.equal(approvals[0]!.via, "panel");
		assert.equal(approvals[0]!.notificationState, "sent");
		assert.equal(approvals[0]!.cardMessageId, `tg:100:200:${cards[0]!.messageId}`);
		const forwarded = f.requests("telegram", "sendMessage").find((event) => String(event.body.text).includes("Run the panel task requiring approval"));
		assert.equal(forwarded?.body.chat_id, "-300");
		assert.equal(forwarded?.body.message_thread_id, topic ? 9 : undefined);
		const restartAt = f.events.length;
		f.start();
		await f.until((event) => event.method === "getUpdates", restartAt);
		await f.stop();
		assert.equal(f.requests("telegram", "sendMessage").filter((event) => event.body.reply_markup !== undefined).length, 1, "A sent approval must not be sent again after restart");
		assert.equal((await pending(f.directory))[0]!.cardMessageId, approvals[0]!.cardMessageId);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("private approval completion preserves the topic send anchor after restart", { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [
		{ text: "The original topic is ready." },
		{ tool: "bash", arguments: { command: "ssh synthetic.invalid" } },
		{ text: "The first panel task requires approval." },
		{ text: "The private approval continuation completed." },
	], { panel: true });
	let passed = false;
	try {
		const listening = await f.until((event) => event.method === "panel.listening");
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(930, "/ask@AcceptanceBot Prepare this topic", { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 })]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:930" && event.body.state === "done");
		const routes = Object.values(JSON.parse(await readFile(join(f.directory, "state", "sessions.json"), "utf8"))) as { id: number }[];
		const conversationId = routes[0]!.id;
		await post(`http://127.0.0.1:${listening.body.port}`, "/api/send", { conv: conversationId, content: "First gated panel input" });
		await f.until((event) => event.method === "telegram.output" && String(event.body.id).startsWith("tg-panel:") && event.body.state === "done");
		const firstCard = f.requests("telegram", "sendMessage").find((event) => event.body.reply_markup !== undefined)!;
		const markup = firstCard.body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
		f.updates([{ update_id: 931, callback_query: {
			id: "private-topic-approval", from: { id: 200 }, data: markup.inline_keyboard[0]![0]!.callback_data,
			message: { message_id: firstCard.messageId, date: 10, chat: { id: 200, type: "private" }, from: { id: 100, is_bot: true } },
		} }]);
		await f.until((event) => event.method === "answerCallbackQuery" && event.body.callback_query_id === "private-topic-approval" && event.body.text === "已批准");
		await f.until((event) => event.method === "editMessageText" && event.body.chat_id === "200" && event.body.text === "The private approval continuation completed.");
		await f.until((event) => event.method === "telegram.output" && String(event.body.id).startsWith("tg-reply:") && event.body.state === "done");
		await f.stop();
		const before = await f.snapshot();
		const continuation = Object.values(before.inbox.inputs).find((row) => row.destination.chatId === "200" && row.submissionId !== undefined)!;
		assert.equal(continuation.conversationId, conversationId);
		const mapFile = join(f.directory, "state", "message-map.json");
		const anchors = JSON.parse(await readFile(mapFile, "utf8")) as Record<string, number>;
		assert.equal(anchors[`tg:100:200:${firstCard.messageId}`], conversationId);
		assert.equal(anchors[continuation.messageId!], conversationId, "Private replies must remain followable through the original conversation map");
		const topicAnchors = Object.keys(anchors).filter((key) => key.startsWith("tg:100:-300:") && anchors[key] === conversationId);
		const approvalFile = join(f.directory, "state", "approvals.json");
		const approvals = JSON.parse(await readFile(approvalFile, "utf8")) as { windows: [string, number][] };
		// Expire only this stopped fixture's window so another dangerous command stays blocked.
		approvals.windows = approvals.windows.map(([key]) => [key, 0]);
		await writeFile(approvalFile, JSON.stringify(approvals));
		const restartAt = f.events.length;
		f.start([
			{ tool: "bash", arguments: { command: "ssh synthetic.invalid" } },
			{ text: "The second panel task requires approval." },
		]);
		const restarted = await f.until((event) => event.method === "panel.listening", restartAt);
		await f.until((event) => event.method === "getUpdates", restartAt);
		await post(`http://127.0.0.1:${restarted.body.port}`, "/api/send", { conv: conversationId, content: "Second gated panel input" });
		await f.until((event) => event.method === "telegram.output" && String(event.body.id).startsWith("tg-panel:") && event.body.state === "done", restartAt);
		await f.stop();
		const forwarded = f.requests("telegram", "sendMessage").find((event) => String(event.body.text).includes("Second gated panel input"))!;
		assert.equal(forwarded.body.chat_id, "-300");
		assert.equal(forwarded.body.message_thread_id, 9);
		assert.equal(`tg:100:-300:${(forwarded.body.reply_parameters as { message_id: number }).message_id}`, topicAnchors.at(-1));
		const cards = f.requests("telegram", "sendMessage").filter((event) => event.body.reply_markup !== undefined);
		assert.equal(cards.length, 2);
		assert.equal(cards[1]!.body.chat_id, "200");
		assert.equal(cards[1]!.body.reply_parameters, undefined);
		assert.equal((await pending(f.directory))[0]!.via, "panel");
		const restoredAnchors = JSON.parse(await readFile(mapFile, "utf8")) as Record<string, number>;
		for (const key of Object.keys(anchors)) assert.equal(restoredAnchors[key], anchors[key]);
		assert.equal(f.requests("model").length, 6);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

for (const legacy of [false, true]) test(`replying to a panel notification retains panel approval authority across ${legacy ? "legacy" : "current"} Telegram preprocessing recovery`, { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "Panel task initial answer." }, { text: "Another member keeps a separate task." }], { panel: true, legacyTelegramInput: legacy });
	let passed = false;
	try {
		const listening = await f.until((event) => event.method === "panel.listening");
		await f.until((event) => event.method === "getUpdates");
		const base = `http://127.0.0.1:${listening.body.port}`;
		const { id } = await post(base, "/api/conversations", { name: "Synthetic panel task" });
		const conversationId = id as number;
		await post(base, "/api/notify", { id: conversationId, on: true });
		await post(base, "/api/send", { conv: conversationId, content: "Prepare the panel task" });
		const notice = await f.until((event) => event.method === "sendMessage" && String(event.body.text).includes("Panel task initial answer."));
		const reply = { message_id: notice.messageId, date: 10, chat: { id: 200, type: "private" }, from: { id: 100, is_bot: true } };
		f.updates([
			message(908, "An unallowed actor cannot continue the panel task", { from: { id: 999 }, chat: { id: 999, type: "private" }, reply_to_message: reply }),
			message(909, "Another allowed actor starts their own task", { from: { id: 201 }, chat: { id: 201, type: "private" }, reply_to_message: reply }),
		]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:909" && event.body.state === "done");
		assert.ok(f.requests("telegram", "sendMessage").some((event) => event.body.chat_id === "999" && event.body.text === "未授权使用，请联系管理员开通。"));
		f.updates([message(910, "Continue the original panel task with approval", {
			reply_to_message: reply, document: { file_id: "hold-panel-continuation", file_name: "continuation.txt" },
		})]);
		await f.until((event) => event.method === "media.waiting");
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 911);
		await f.kill();
		const before = (await f.snapshot()).inbox.inputs["tg-update:100:910"]!;
		assert.equal(before.conversationId, conversationId);
		assert.equal(before.submissionId, undefined);
		assert.equal(before.authorityVia, legacy ? undefined : "panel");
		const restartAt = f.events.length;
		f.start([
			{ tool: "bash", arguments: { command: "ssh synthetic.invalid" } },
			{ text: "Panel authority still requires private approval." },
		]);
		await f.until((event) => event.method === "media.waiting", restartAt);
		f.release("file:hold-panel-continuation");
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:910" && event.body.state === "done", restartAt);
		await f.stop();
		const snapshot = await f.snapshot();
		const row = snapshot.inbox.inputs["tg-update:100:910"]!;
		assert.equal(row.conversationId, conversationId);
		assert.notEqual(snapshot.inbox.inputs["tg-update:100:909"]!.conversationId, conversationId);
		assert.equal(snapshot.inbox.inputs["tg-update:100:908"], undefined);
		assert.equal(row.authorityVia, legacy ? undefined : "panel", "The durable receipt must retain its original metadata");
		const submission = snapshot.submissions.find((item) => item.id === row.submissionId)!;
		const entry = snapshot.entries.find((item) => item.id === submission.entry)!;
		assert.equal(entry.conversationId, conversationId);
		assert.ok(typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data));
		assert.equal(entry.data.via, "telegram", "The transcript must record the actual input transport");
		assert.equal(entry.data.authorityVia, "panel");
		const approvals = await pending(f.directory);
		assert.equal(approvals.length, 1);
		assert.equal(approvals[0]!.via, "panel", "Tool-time attribution restoration must retain panel authority");
		assert.equal(approvals[0]!.notificationState, "sent");
		const cards = f.requests("telegram", "sendMessage").filter((event) => event.body.reply_markup !== undefined);
		assert.equal(cards.length, 1);
		assert.equal(cards[0]!.body.chat_id, "200");
		assert.equal(cards[0]!.body.reply_parameters, undefined);
		assert.equal(f.requests("model").length, 4);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});
