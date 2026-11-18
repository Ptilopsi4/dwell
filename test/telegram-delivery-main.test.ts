import { test } from "node:test";
import assert from "node:assert/strict";
import { mainFixture, message } from "./telegram-main-fixture.ts";

for (const topic of [false, true]) test(`Telegram completes once after its source reply disappears in ${topic ? "a forum topic" : "private chat"}`, { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "RESULT_WITHOUT_SOURCE" }]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.deleteReplies([950]);
		f.updates([message(950, topic ? "/ask@AcceptanceBot Deliver the result." : "Deliver the result.", topic ? { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 } : {})]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:950" && event.body.state === "done");
		const sends = f.requests("telegram", "sendMessage");
		assert.equal(sends.length, 1);
		assert.deepEqual(sends[0].body.reply_parameters, { message_id: 950, allow_sending_without_reply: true });
		assert.equal(sends[0].body.message_thread_id, topic ? 9 : undefined);
		assert.equal(f.requests("telegram", "editMessageText").filter((event) => event.body.text === "RESULT_WITHOUT_SOURCE").length, 1);
		assert.equal(f.requests("model").length, 1);
		passed = true;
	} finally { await f.close(passed); }
});

test("Telegram definite placeholder rejection is failed rather than uncertain and is not retried", { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "REJECTED_RESULT" }]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.rejectReplies([960]);
		f.updates([message(960, "The remote API will reject this destination.")]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:960" && event.body.state === "failed");
		assert.equal(f.requests("telegram", "sendMessage").length, 1);
		await f.stop();
		assert.equal((await f.snapshot()).inbox.inputs["tg-update:100:960"].output, "failed");
		passed = true;
	} finally { await f.close(passed); }
});
