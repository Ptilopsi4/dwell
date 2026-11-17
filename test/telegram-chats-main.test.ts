import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonRecord, MainFixtureEvent } from "./telegram-main-hook.ts";
import { mainFixture, message } from "./telegram-main-fixture.ts";

const group = { chat: { id: -301, type: "supergroup" }, message_thread_id: 9 };
const seededGroup = { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 };
const replyId = (event: MainFixtureEvent) => (event.body.reply_parameters as JsonRecord)?.message_id;
async function enabled(directory: string): Promise<string[]> {
	return JSON.parse(await readFile(join(directory, "state", "telegram-chats.json"), "utf8")).bots["100"].chats;
}
function callback(updateId: number, actor: number, id: string, card: MainFixtureEvent, overrides: JsonRecord = {}): JsonRecord {
	return { update_id: updateId, callback_query: { id, from: { id: actor }, data: "dwell:allowchat",
		message: { message_id: card.messageId, date: 10, ...group, from: { id: 100, is_bot: true }, ...overrides } } };
}

test("main Telegram administrators manage group admission before routing, attachments, or model execution", { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [], { admins: "tg:200" });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([
			message(1, "/allowchat@AcceptanceBot", { ...group, from: { id: 201 }, document: { file_id: "never-download-member", file_name: "private.txt" } }),
			message(2, "/chats", { from: { id: 999 }, chat: { id: 999, type: "private" } }),
			message(3, "/allowchat"),
			message(4, "/allowchat@AnotherBot", group),
			message(5, "/allowchat@AcceptanceBot", { ...group, sender_chat: { id: -301 } }),
			message(6, "/allowchat@AcceptanceBot", { ...group, photo: [{ file_id: "never-download-admin" }] }),
			message(7, "/chats"),
		]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 8);
		const sends = f.requests("telegram", "sendMessage");
		assert.equal(sends.length, 5);
		assert.equal(sends.find((event) => replyId(event) === 1)!.body.text, "群白名单管理仅 dwell 管理员可用。");
		assert.equal(sends.find((event) => replyId(event) === 2)!.body.text, "群白名单管理仅 dwell 管理员可用。");
		assert.match(String(sends.find((event) => replyId(event) === 3)!.body.text), /私聊必须明确指定/);
		assert.match(String(sends.find((event) => replyId(event) === 6)!.body.text), /^已启用群 -301/);
		assert.equal(sends.find((event) => replyId(event) === 7)!.body.text, "当前 bot 已启用的群：\n-300 · 仅授权用户\n-301 · 仅授权用户");
		assert.equal(f.requests("telegram", "getFile").length, 0);
		assert.equal(f.requests("model").length, 0);
		await assert.rejects(readFile(join(f.directory, "state", "sessions.json")), { code: "ENOENT" });
		assert.deepEqual(await enabled(f.directory), ["-300", "-301"]);
		f.replies([{ text: "New group accepted." }, { text: "Seeded group still accepted." }]);
		f.updates([message(8, "/ask@AcceptanceBot New group question", { ...group, from: { id: 201 } })]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:8" && event.body.state === "done");
		f.updates([
			message(9, "/ask@AcceptanceBot Seeded group question", { ...seededGroup, from: { id: 201 } }),
			message(10, "/ask@AcceptanceBot Unknown sender must remain denied", { ...group, from: { id: 999 } }),
		]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:9" && event.body.state === "done");
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 11);
		assert.equal(f.requests("model").length, 2);
		await f.stop();
		const { inbox, submissions } = await f.snapshot();
		assert.deepEqual(inbox.commands, {});
		assert.deepEqual(Object.keys(inbox.inputs).sort(), ["tg-update:100:8", "tg-update:100:9"]);
		assert.equal(submissions.length, 2);
		assert.ok(Object.values(inbox.inputs).every((row) => row.sender === "tg:201"));
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("main Telegram group buttons use current dwell roles and persist effects even when acknowledgement fails", { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [], { admins: "tg:200,tg:202" });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(30, "/whoami@AcceptanceBot", group)]);
		const card = await f.until((event) => event.method === "sendMessage" && event.body.reply_markup !== undefined);
		assert.deepEqual(card.body.reply_markup, { inline_keyboard: [[{ text: "允许本群成员使用", callback_data: "dwell:allowgroup" }], [{ text: "仅允许已授权用户", callback_data: "dwell:allowchat" }]] });
		f.rejectCallbacks(["original-grant"]);
		f.updates([
			callback(31, 201, "member", card), callback(32, 999, "unknown", card),
			callback(33, 202, "other-bot", card, { from: { id: 999, is_bot: true } }),
			callback(34, 202, "original-grant", card),
		]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 35);
		const acks = f.requests("telegram", "answerCallbackQuery");
		for (const id of ["member", "unknown"]) assert.equal(acks.find((event) => event.body.callback_query_id === id)!.body.text, "启用群仅 dwell 管理员可用。");
		assert.equal(acks.some((event) => event.body.callback_query_id === "other-bot"), false);
		assert.ok((await enabled(f.directory)).includes("-301"));
		f.updates([message(35, "/disallowchat@AcceptanceBot", group), callback(36, 202, "original-grant", card)]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 37);
		assert.deepEqual(await enabled(f.directory), ["-300"], "A redelivered grant must not resurrect a revoked group");
		assert.ok(f.requests("telegram", "answerCallbackQuery").some((event) => event.body.callback_query_id === "original-grant" && String(event.body.text).includes("未重复更改")));
		f.updates([message(37, "/disallow tg:202"), callback(38, 202, "after-role-revocation", card)]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 39);
		assert.deepEqual(await enabled(f.directory), ["-300"]);
		assert.equal(f.requests("telegram", "answerCallbackQuery").find((event) => event.body.callback_query_id === "after-role-revocation")!.body.text, "启用群仅 dwell 管理员可用。");
		f.updates([message(39, "/allowchat -301")]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 40);
		assert.deepEqual(await enabled(f.directory), ["-300", "-301"]);
		assert.equal(f.requests("model").length, 0);
		assert.equal(f.requests("telegram", "getFile").length, 0);
		await f.stop();
		const { inbox } = await f.snapshot();
		assert.deepEqual(inbox.inputs, {});
		assert.deepEqual(Object.keys(inbox.commands), ["tg-update:100:37"]);
		passed = true;
	} finally { await f.close(passed); }
});

test("main Telegram disabling a group stops later streaming and prepared input without cancelling admitted work", { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "Visible progress before disabling. The admitted work still completed.", partial: { text: "Visible progress before disabling.", wait: "finish-after-disable" } }], { admins: "tg:200" });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(50, "/ask@AcceptanceBot Keep this admitted work", { ...seededGroup, from: { id: 201 } })]);
		await f.until((event) => event.method === "model.stream.waiting");
		await f.until((event) => event.method === "editMessageText" && event.body.text === "Visible progress before disabling.");
		f.updates([message(51, "/ask@AcceptanceBot This attachment is preparing", { ...seededGroup, from: { id: 201 }, message_thread_id: 10, document: { file_id: "hold-disable", file_name: "slow.txt" } })]);
		await f.until((event) => event.method === "media.waiting");
		f.updates([message(52, "/disallowchat@AcceptanceBot", seededGroup)]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 53);
		assert.deepEqual(await enabled(f.directory), []);
		const afterDisable = f.events.length;
		f.release("finish-after-disable");
		f.release("file:hold-disable");
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:50" && event.body.state === "failed", afterDisable);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:51" && event.body.state === "failed", afterDisable);
		f.updates([message(53, "/ask@AcceptanceBot No new run after disabling", seededGroup)]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 54, afterDisable);
		assert.equal(f.events.slice(afterDisable).some((event) => ["sendMessage", "editMessageText", "sendChatAction"].includes(event.method ?? "") && event.body.chat_id === "-300" && !String(event.body.text).startsWith("这个群尚未启用")), false);
		assert.equal(f.requests("model").length, 1);
		assert.equal(f.requests("checkpoint", "model.aborted").length, 0);
		await f.stop();
		const { inbox, submissions, entries } = await f.snapshot();
		assert.equal(submissions.length, 1, "Only the originally admitted input executes");
		assert.equal(submissions[0].status, "done", "Disabling delivery must not cancel the running model work");
		assert.ok(JSON.stringify(entries).includes("Keep this admitted work"));
		assert.equal(inbox.inputs["tg-update:100:50"].output, "failed");
		assert.equal(inbox.inputs["tg-update:100:51"].submissionId, undefined);
		assert.equal(inbox.inputs["tg-update:100:53"], undefined);
		const attribution = JSON.parse(await readFile(join(f.directory, "state", "approvals.json"), "utf8")) as { runSender: [string, string][] };
		assert.equal(new Map(attribution.runSender).get(String(inbox.inputs["tg-update:100:50"].conversationId)), "tg:201", "A host management command must not replace the active run's actor");
		const routes = JSON.parse(await readFile(join(f.directory, "state", "sessions.json"), "utf8"));
		assert.equal(Object.values(routes).filter((route) => (route as { destination: { chatId?: string } }).destination.chatId === "-300").length, 2, "The existing task lines remain available");
		passed = true;
	} finally { await f.close(passed); }
});
