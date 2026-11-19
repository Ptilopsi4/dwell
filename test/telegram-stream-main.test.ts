import assert from "node:assert/strict";
import { test } from "node:test";
import { mainFixture, message, posixOnly } from "./telegram-main-fixture.ts";

for (const group of [false, true]) test(`main Telegram streams text before settlement in a ${group ? "group topic" : "private chat"}`, { ...posixOnly, timeout: 60_000 }, async (t) => {
	const partial = "逐步生成的开头。";
	const final = `${partial}最终内容已完整送达。`;
	const f = await mainFixture(t, [{ text: final, partial: { text: partial, wait: "finish-text" } }]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(801, group ? "/ask@AcceptanceBot Stream this reply" : "Stream this reply", group ? { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 } : {})]);
		await f.until((event) => event.method === "model.stream.waiting");
		const preview = await f.until((event) => event.method === "editMessageText" && String(event.body.text).includes(partial));
		assert.equal(preview.body.chat_id, group ? "-300" : "200");
		if (group) assert.equal(preview.body.message_thread_id, 9);
		assert.ok(!f.events.some((event) => event.method === "telegram.output" && event.body.state === "done"));
		const placeholder = f.requests("telegram", "sendMessage")[0];
		assert.equal(preview.body.message_id, placeholder.messageId);
		f.release("finish-text");
		await f.until((event) => event.method === "telegram.output" && event.body.state === "done");
		const edits = f.requests("telegram", "editMessageText");
		assert.equal(edits.at(-1)!.body.text, final);
		assert.ok(edits.every((event) => event.body.message_id === placeholder.messageId));
		assert.equal(f.requests("telegram", "sendMessage").length, 1);
		assert.equal(f.requests("model").length, 1);
		passed = true;
	} finally { f.release("finish-text"); await f.close(passed); }
});

test("main Telegram retains measured tool progress without command arguments or output", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const secret = "synthetic-command-and-output-marker";
	const f = await mainFixture(t, [
		{ tool: "bash", arguments: { command: `node -e 'setTimeout(() => console.log("${secret}"), 750)'` } },
		{ text: "检查完成。", wait: "finish-tool" },
	]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(802, "Run the small local check")]);
		await f.until((event) => event.method === "editMessageText" && /执行检查/.test(String(event.body.text)));
		await f.until((event) => event.method === "model.waiting" && event.body.token === "finish-tool");
		assert.doesNotMatch(JSON.stringify(f.requests("telegram")), new RegExp(secret));
		f.release("finish-tool");
		await f.until((event) => event.method === "telegram.output" && event.body.state === "done");
		const final = String(f.requests("telegram", "editMessageText").at(-1)!.body.text);
		assert.match(final, /^检查完成。\n\n执行记录/);
		assert.match(final, /bash.*执行检查.*已完成.*(?:毫秒|秒)/);
		passed = true;
	} finally { f.release("finish-tool"); await f.close(passed); }
});

test("main Telegram cancellation replaces a visible partial and prevents late overwrite", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "这段过期内容不应在取消后出现。", partial: { text: "这段过期内容", wait: "cancel-stream" } }]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(803, "Begin a cancellable reply")]);
		await f.until((event) => event.method === "editMessageText" && String(event.body.text).includes("这段过期内容"));
		const placeholder = f.requests("telegram", "sendMessage")[0];
		f.updates([message(804, "/cancel", { reply_to_message: { message_id: placeholder.messageId, date: 10, chat: { id: 200, type: "private" }, from: { id: 100, is_bot: true, first_name: "Acceptance" } } })]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:803" && event.body.state === "done");
		f.release("cancel-stream");
		const final = f.requests("telegram", "editMessageText").at(-1)!;
		assert.match(String(final.body.text), /处理失败/);
		assert.doesNotMatch(String(final.body.text), /过期内容/);
		assert.equal(f.requests("model").length, 1);
		passed = true;
	} finally { f.release("cancel-stream"); await f.close(passed); }
});
