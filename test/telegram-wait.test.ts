import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_WAIT_NOTICE } from "../src/answer.ts";
import { modelFailure } from "../src/model-failure.ts";
import { mainFixture, message } from "./telegram-main-fixture.ts";

test("main Telegram presents a real background wait and later report in the original topic", { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [
		{ tool: "dwell.task", arguments: { action: "start", name: "reader", message: "worker:late-topic-result" }, match: "Wait topic acceptance" },
		{ tool: "dwell.task.wait", arguments: {}, match: "Wait topic acceptance" },
		{ text: "Child completed after the wait.", wait: "late-child", match: "worker:late-topic-result" },
		{ text: "The background result is ready.", match: "Background task" },
	]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(301, "/ask@AcceptanceBot Wait topic acceptance", { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 })]);
		await f.until((event) => event.method === "model.waiting" && event.body.token === "late-child");
		await f.until((event) => event.method === "editMessageText" && event.body.text === BACKGROUND_WAIT_NOTICE);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:301" && event.body.state === "done");
		assert.equal(f.requests("model").length, 3, "The wait must settle without asking the provider for another answer");
		f.release("late-child");
		await f.until((event) => event.method === "editMessageText" && event.body.text === "The background result is ready.");
		const sends = f.requests("telegram", "sendMessage");
		assert.equal(sends.length, 2, "The late report opens one new answer after the waiting answer");
		for (const sent of sends) {
			assert.equal(sent.body.chat_id, "-300");
			assert.equal(sent.body.message_thread_id, 9);
		}
		assert.deepEqual(sends[0].body.reply_parameters, { message_id: 301, allow_sending_without_reply: true });
		assert.deepEqual(sends[1].body.reply_parameters, { message_id: sends[0].messageId, allow_sending_without_reply: true });
		assert.doesNotMatch(JSON.stringify(f.requests("telegram")), /空回复|没有产出文本|处理失败/);
		assert.equal(f.requests("model").length, 4);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { f.release("late-child"); await f.close(passed); }
});

for (const status of [401, 403]) test(`main Telegram and panel present a safe HTTP ${status} model failure after one request`, { timeout: 60_000 }, async (t) => {
	const secret = `provider-private-body-${status}`;
	const f = await mainFixture(t, [{ error: JSON.stringify({ error: { message: `${secret}; credential=synthetic-secret`, type: "api_error" } }), status }], { panel: true });
	let passed = false;
	try {
		const listening = await f.until((event) => event.method === "panel.listening");
		const base = `http://127.0.0.1:${listening.body.port}`;
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(status, `Exercise model HTTP ${status}`)]);
		const expected = modelFailure(`HTTP ${status}`).message;
		await f.until((event) => event.method === "editMessageText" && event.body.text === `处理失败：${expected}`);
		await f.until((event) => event.method === "telegram.output" && event.body.id === `tg-update:100:${status}` && event.body.state === "done");
		assert.equal(f.requests("model").length, 1);
		assert.doesNotMatch(JSON.stringify(f.requests("telegram")), /provider-private-body|synthetic-secret/);
		const conversations = await (await fetch(`${base}/api/conversations`)).json() as { id: number }[];
		assert.equal(conversations.length, 1);
		const response = await fetch(`${base}/api/events?conv=${conversations[0].id}`, { signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200);
		const reader = response.body!.getReader();
		let data = "";
		try {
			while (!data.includes("\n\n")) {
				const part = await reader.read();
				assert.equal(part.done, false);
				data += new TextDecoder().decode(part.value);
			}
		} finally { await reader.cancel(); }
		assert.ok(data.includes(expected), data);
		assert.doesNotMatch(data, /provider-private-body|synthetic-secret/);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});
