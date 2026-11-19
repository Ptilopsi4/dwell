import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_WAIT_NOTICE } from "../src/answer.ts";
import { WorkDoc } from "../src/ext/work.ts";
import { mainFixture, message, posixOnly } from "./telegram-main-fixture.ts";

for (const reason of ["model_limit", "tool_limit"] as const) test(`main Telegram reports a persisted shared ${reason} after recovering a waiting child without another model request`, { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [
		{ tool: "dwell.work", arguments: { action: "start", goal: "Inspect isolated material", acceptance: ["Report the inspection"] }, match: "Work-limit delivery acceptance" },
		{ tool: "dwell.task", arguments: { action: "start", name: "reader", message: "worker:work-limit-fixture" }, match: "Work-limit delivery acceptance" },
		{ tool: "dwell.task.wait", arguments: {}, match: "Work-limit delivery acceptance" },
		{ text: "The child was interrupted before completing.", wait: "work-limit-child", match: "worker:work-limit-fixture" },
	]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(901, "/ask@AcceptanceBot Work-limit delivery acceptance", { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 })]);
		await f.until((event) => event.method === "model.waiting" && event.body.token === "work-limit-child");
		await f.until((event) => event.method === "editMessageText" && String(event.body.text).startsWith(BACKGROUND_WAIT_NOTICE));
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:901" && event.body.state === "done");
		await f.stop();
		const saved = await f.snapshot();
		const conversationId = saved.inbox.inputs["tg-update:100:901"]!.conversationId;
		// Seed only this stopped fixture's state; admission-limit behavior is covered separately with real controllers.
		const fixture = await Harness.open(await openNodeSqliteStorage(join(f.directory, "data", "dwell.sqlite")), { models: createModels(), registry: createRegistry() }, context);
		try {
			await fixture.commit(async (tx) => {
				const doc = await tx.doc(WorkDoc, conversationId as ConversationId);
				assert.ok(doc.current);
				const record = doc.records[doc.current]!;
				record.stopped = reason;
				const key = reason === "model_limit" ? "modelAdmissions" : "toolAdmissions";
				record.usage[key] = record.limits[key];
			}, context);
		} finally { await fixture.close(context); }
		const restart = f.events.length;
		const providerCalls = f.requests("model").length;
		f.start();
		const notice = await f.until((event) => event.method === "editMessageText" && /工作预算/.test(String(event.body.text)), restart);
		assert.match(String(notice.body.text), reason === "model_limit" ? /模型请求次数达到上限/ : /工具调用次数达到上限/);
		assert.equal(notice.body.chat_id, "-300");
		assert.equal(notice.body.message_thread_id, 9);
		const completed = await f.until((event) => event.method === "telegram.output" && String(event.body.id).startsWith("tg-reply:") && event.body.state === "done", restart);
		assert.equal(f.requests("model").length, providerCalls, "Neither the stopped child nor its parent report may call the provider again");
		assert.equal(f.requests("telegram", "sendMessage").length, 2, "Recover the original waiting answer and deliver one terminal report");
		assert.equal(f.requests("unexpected").length, 0);
		await f.stop();
		const terminal = await f.snapshot();
		assert.equal(terminal.inbox.inputs[String(completed.body.id)]?.output, "done");
		assert.equal(terminal.submissions.filter((item) => item.requestId?.startsWith("bg-report:")).length, 1);
		const reporters = terminal.tasks.filter((task) => task.kind === "dwell.background-reporter");
		assert.equal(reporters.length, 1);
		assert.equal(reporters[0]!.state.status, "terminal");
		passed = true;
	} finally { await f.close(passed); }
});
