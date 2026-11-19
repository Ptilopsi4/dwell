import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mainFixture, message, posixOnly } from "./telegram-main-fixture.ts";
import type { JsonRecord } from "./telegram-main-hook.ts";

for (const action of ["approve", "deny"] as const) test(`Telegram /${action} closes the original approval card without replaying the control effect`, { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ tool: "bash", arguments: { command: "docker ps" } }, { text: "WAITING_APPROVAL" }, { text: "APPROVED_CONTINUATION" }]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(930, "Request docker approval.")]);
		const card = await f.until((event) => event.method === "sendMessage" && event.body.reply_markup !== undefined);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:930" && event.body.state === "done");
		const update = message(931, `/${action}`, { reply_to_message: { message_id: card.messageId, from: { id: 100, is_bot: true } } });
		f.updates([update]);
		const edited = await f.until((event) => event.method === "editMessageText" && event.body.message_id === card.messageId);
		assert.match(String(edited.body.text), action === "approve" ? /^已批准 · 10 分钟 · Telegram 命令/ : /^已拒绝 · Telegram 命令/);
		assert.deepEqual(edited.body.reply_markup, { inline_keyboard: [] });
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 932);
		if (action === "approve") await f.until((event) => event.method === "editMessageText" && event.body.text === "APPROVED_CONTINUATION");
		const beforeReplay = f.events.length;
		f.updates([update]);
		await f.until((event) => event.method === "getUpdates", beforeReplay);
		await f.stop();
		const state = JSON.parse(await readFile(join(f.directory, "state", "approvals.json"), "utf8")) as { pending: unknown[]; decisions: unknown[] };
		assert.equal(state.pending.length, 0);
		assert.equal(state.decisions.length, action === "approve" ? 1 : 0);
		assert.equal(f.requests("model").length, action === "approve" ? 3 : 2);
		assert.equal(f.requests("telegram", "editMessageText").filter((event) => event.body.message_id === card.messageId).length, 1);
		passed = true;
	} finally { await f.close(passed); }
});

test("Telegram owner preapproval explains another actor's pending request and preserves their authority", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "OWNER_SEED" }, { tool: "bash", arguments: { command: "docker ps" } }, { text: "COLLABORATOR_WAITING" }, { text: "COLLABORATOR_CONTINUED" }]);
	let passed = false;
	const topic = { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 };
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(940, "/ask@AcceptanceBot Start this shared topic.", topic)]);
		await f.until((event) => event.method === "editMessageText" && event.body.text === "OWNER_SEED");
		const seed = f.requests("telegram", "sendMessage").find((event) => event.body.reply_parameters !== undefined)!;
		f.updates([message(941, "Request docker approval.", { ...topic, from: { id: 201 }, reply_to_message: { message_id: seed.messageId, from: { id: 100, is_bot: true } } })]);
		const card = await f.until((event) => event.method === "sendMessage" && event.body.reply_markup !== undefined);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:941" && event.body.state === "done");
		f.updates([message(942, "/approve@AcceptanceBot", { ...topic, reply_to_message: { message_id: card.messageId, from: { id: 100, is_bot: true } } })]);
		const response = await f.until((event) => event.method === "sendMessage" && (event.body.reply_parameters as JsonRecord)?.message_id === 942);
		assert.match(String(response.body.text), /仅由你触发/);
		assert.match(String(response.body.text), /他人的待审请求尚未处理/);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 943);
		const pending = JSON.parse(await readFile(join(f.directory, "state", "approvals.json"), "utf8")) as { pending: [string, { trigger: string }][]; windows: [string, number][] };
		assert.equal(pending.pending[0][1].trigger, "tg:201");
		assert.ok(pending.windows.some(([key]) => key.endsWith(":tg:200")));
		assert.equal(pending.windows.some(([key]) => key.endsWith(":tg:201")), false);
		assert.equal(f.requests("model").length, 3);
		assert.equal(f.requests("telegram", "editMessageText").filter((event) => event.body.message_id === card.messageId).length, 0);
		f.updates([message(943, "/approve@AcceptanceBot", { ...topic, from: { id: 201 }, reply_to_message: { message_id: card.messageId, from: { id: 100, is_bot: true } } })]);
		await f.until((event) => event.method === "editMessageText" && event.body.text === "COLLABORATOR_CONTINUED");
		assert.equal(f.requests("model").length, 4);
		passed = true;
	} finally { await f.close(passed); }
});
