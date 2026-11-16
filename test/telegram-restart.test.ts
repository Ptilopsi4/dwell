import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { PendingApproval, ApprovalDecision } from "../src/ext/approval.ts";
import { mainFixture, message } from "./telegram-main-fixture.ts";
import type { JsonRecord, MainFixtureEvent } from "./telegram-main-hook.ts";

const topic = { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 };
const topicDestination = { kind: "telegram", botId: "100", chatId: "-300", threadId: "9" };
const isOutput = (id: string, state: string) => (event: MainFixtureEvent) => event.method === "telegram.output" && event.body.id === id && event.body.state === state;
const isWaiting = (token: string) => (event: MainFixtureEvent) => event.method === "model.waiting" && event.body.token === token;
type ApprovalState = { pending: [string, PendingApproval][]; decisions: [string, ApprovalDecision][] };

async function approvalState(directory: string, predicate: (state: ApprovalState) => boolean): Promise<ApprovalState> {
	const expires = Date.now() + 20_000;
	for (;;) {
		const state = JSON.parse(await readFile(join(directory, "state", "approvals.json"), "utf8")) as ApprovalState;
		if (predicate(state)) return state;
		assert.ok(Date.now() < expires, `Approval state did not settle: ${JSON.stringify(state)}`);
		await delay(10);
	}
}

function callback(updateId: number, actor: number, id: string, card: MainFixtureEvent, data: string): JsonRecord {
	return { update_id: updateId, callback_query: {
		id, from: { id: actor, first_name: "Member" }, data,
		message: { message_id: card.messageId, date: 10, ...topic, from: { id: 100, is_bot: true, first_name: "Acceptance" } },
	} };
}

test("main restarts a tracked Telegram topic run without input redelivery or a second placeholder", { timeout: 60_000 }, async (t) => {
	const answer = "The restarted topic run completed.";
	const f = await mainFixture(t, [{ text: answer, wait: "topic-before-kill" }]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(80, "/ask@AcceptanceBot Keep this topic run across a process crash.", topic)]);
		const tracked = await f.until(isOutput("tg-update:100:80", "tracking"));
		await f.until(isWaiting("topic-before-kill"));
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 81);
		const placeholder = f.requests("telegram", "sendMessage")[0];
		assert.equal(placeholder.body.text, "正在处理…");
		assert.equal(placeholder.body.message_thread_id, 9);
		assert.deepEqual(await f.kill(), [null, "SIGKILL"]);
		const before = await f.snapshot();
		const row = before.inbox.inputs["tg-update:100:80"];
		assert.equal(row.output, "tracking");
		assert.equal(row.messageId, tracked.body.messageId);
		assert.equal(row.messageId, `tg:100:-300:${placeholder.messageId}`);
		assert.deepEqual(row.destination, topicDestination);
		assert.ok(row.submissionId);
		assert.equal(before.submissions.filter((item) => item.requestId === "tg-update:100:80").length, 1);
		const restart = f.events.length;
		f.start([{ text: answer, wait: "topic-after-restart" }]);
		await f.until(isWaiting("topic-after-restart"), restart);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 81, restart);
		assert.equal(f.requests("telegram", "sendMessage").length, 1);
		f.release("topic-after-restart");
		const edited = await f.until((event) => event.method === "editMessageText" && event.body.text === answer, restart);
		await f.until(isOutput("tg-update:100:80", "done"), restart);
		assert.equal(edited.body.message_id, placeholder.messageId);
		assert.equal(edited.body.chat_id, "-300");
		assert.equal(edited.body.message_thread_id, 9);
		assert.equal(f.requests("telegram", "sendMessage").length, 1);
		assert.equal(f.requests("model").length, 2, "Only the interrupted generation and its recovered generation should call the model");
		await f.stop();
		const after = await f.snapshot();
		assert.equal(after.inbox.inputs["tg-update:100:80"].output, "done");
		assert.equal(after.inbox.inputs["tg-update:100:80"].submissionId, row.submissionId);
		assert.equal(after.submissions.filter((item) => item.requestId === "tg-update:100:80").length, 1);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("main restores the original approval card and recovers one actor-authorized topic continuation across crashes", { timeout: 90_000 }, async (t) => {
	const f = await mainFixture(t);
	let passed = false;
	try {
		const disposable = join(f.directory, "disposable-fixture");
		await mkdir(disposable);
		await writeFile(join(disposable, "marker.txt"), "The blocked command must not execute.");
		f.replies([
			{ tool: "bash", arguments: { command: `rm -rf '${disposable}'` } },
			{ text: "Approval is required before continuing." },
		]);
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(120, "/ask@AcceptanceBot Request approval before removing the fixture.", topic)]);
		const card = await f.until((event) => event.method === "sendMessage" && event.body.reply_markup !== undefined);
		await f.until(isOutput("tg-update:100:120", "done"));
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 121);
		const saved = await approvalState(f.directory, (state) => state.pending[0]?.[1].cardMessageId === `tg:100:-300:${card.messageId}`);
		assert.equal(saved.pending.length, 1);
		assert.equal(saved.pending[0][1].notificationState, "sent");
		assert.equal(saved.pending[0][1].trigger, "tg:200");
		assert.deepEqual(saved.pending[0][1].cardDestination, topicDestination);
		const markup = card.body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
		const data = markup.inline_keyboard[0][0].callback_data;
		assert.deepEqual(await f.kill(), [null, "SIGKILL"]);
		const firstRestart = f.events.length;
		f.start([{ text: "The approved topic continuation completed.", wait: "approval-before-second-kill" }]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 121, firstRestart);
		assert.equal(f.requests("telegram", "sendMessage").filter((event) => event.body.reply_markup !== undefined).length, 1);
		f.updates([callback(121, 201, "other-member-after-restart", card, data)]);
		const rejected = await f.until((event) => event.method === "answerCallbackQuery" && event.body.callback_query_id === "other-member-after-restart", firstRestart);
		assert.equal(rejected.body.text, "请求已失效或你没有审批权限");
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 122, firstRestart);
		assert.equal(f.requests("model").length, 2);
		assert.equal((await approvalState(f.directory, (state) => state.pending.length === 1)).pending[0][1].requestId, saved.pending[0][1].requestId);
		f.updates([callback(122, 200, "original-actor-after-restart", card, data)]);
		const approved = await f.until((event) => event.method === "answerCallbackQuery" && event.body.callback_query_id === "original-actor-after-restart", firstRestart);
		assert.equal(approved.body.text, "已批准");
		const continuation = await f.until((event) => event.method === "telegram.output" && String(event.body.id).startsWith("tg-reply:") && event.body.state === "tracking", firstRestart);
		await f.until(isWaiting("approval-before-second-kill"), firstRestart);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 123, firstRestart);
		const continuationPlaceholder = f.requests("telegram", "sendMessage").find((event) => `tg:100:-300:${event.messageId}` === continuation.body.messageId)!;
		assert.equal(continuationPlaceholder.body.message_thread_id, 9);
		assert.deepEqual(continuationPlaceholder.body.reply_parameters, { message_id: card.messageId, allow_sending_without_reply: true });
		assert.deepEqual(await f.kill(), [null, "SIGKILL"]);
		const checkpoint = await f.snapshot();
		const replyId = String(continuation.body.id);
		const tracked = checkpoint.inbox.inputs[replyId];
		assert.equal(tracked.output, "tracking");
		assert.ok(tracked.submissionId, "The delivery receipt must retain the existing continuation submission");
		assert.deepEqual(tracked.destination, topicDestination);
		assert.equal(checkpoint.submissions.filter((item) => item.requestId?.startsWith("approval:")).length, 1);
		const secondRestart = f.events.length;
		f.start([{ text: "The approved topic continuation completed.", wait: "approval-after-second-restart" }]);
		await f.until(isWaiting("approval-after-second-restart"), secondRestart);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 123, secondRestart);
		f.release("approval-after-second-restart");
		const edited = await f.until((event) => event.method === "editMessageText" && event.body.text === "The approved topic continuation completed.", secondRestart);
		await f.until(isOutput(replyId, "done"), secondRestart);
		assert.equal(edited.body.message_id, continuationPlaceholder.messageId);
		assert.equal(edited.body.chat_id, "-300");
		assert.equal(edited.body.message_thread_id, 9);
		assert.equal(f.requests("telegram", "sendMessage").filter((event) => event.body.reply_markup !== undefined).length, 1);
		assert.equal(f.requests("telegram", "sendMessage").length, 3, "Original placeholder, original approval card and one continuation placeholder");
		f.updates([callback(123, 200, "consumed-after-restart", card, data)]);
		const consumed = await f.until((event) => event.method === "answerCallbackQuery" && event.body.callback_query_id === "consumed-after-restart", secondRestart);
		assert.equal(consumed.body.text, "请求已失效或你没有审批权限");
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 124, secondRestart);
		assert.equal(f.requests("model").length, 4, "The accepted continuation has one interrupted and one recovered model generation");
		assert.match(JSON.stringify(f.requests("model")[2].body.input), /The user approved a 10-minute window for dangerous commands/);
		assert.equal(await readFile(join(disposable, "marker.txt"), "utf8"), "The blocked command must not execute.");
		await f.stop();
		const final = await f.snapshot();
		assert.equal(final.submissions.filter((item) => item.requestId?.startsWith("approval:")).length, 1);
		assert.equal(final.inbox.inputs[replyId].output, "done");
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("main recovers a real background child and delivers one autonomous report to its original Telegram topic", { timeout: 90_000 }, async (t) => {
	const childTask = "Perform the isolated restart acceptance child task and return its result.";
	const f = await mainFixture(t, [
		{ tool: "dwell.task", arguments: { action: "start", name: "restart-worker", message: childTask } },
		{ text: "The background task is running.", match: "Started restart-worker." },
		{ text: "The child completed after restart.", match: childTask, wait: "background-before-kill" },
	]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(160, "/ask@AcceptanceBot Run the isolated background child and report its result here.", topic)]);
		await f.until(isWaiting("background-before-kill"));
		await f.until(isOutput("tg-update:100:160", "done"));
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 161);
		assert.deepEqual(await f.kill(), [null, "SIGKILL"]);
		const before = await f.snapshot();
		const reporters = before.tasks.filter((item) => item.kind === "dwell.background-reporter");
		assert.equal(reporters.length, 1);
		assert.notEqual(reporters[0].state.status, "terminal");
		const reporter = reporters[0];
		assert.equal(before.submissions.filter((item) => item.requestId === `bg:${reporter.id}`).length, 1);
		const restart = f.events.length;
		f.start([
			{ text: "The recovered background report reached this topic.", match: "[Background task restart-worker finished]", wait: "background-report-before-kill" },
			{ text: "The child completed after restart.", match: childTask, wait: "background-after-restart" },
		]);
		await f.until(isWaiting("background-after-restart"), restart);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 161, restart);
		f.release("background-after-restart");
		await f.until(isWaiting("background-report-before-kill"), restart);
		const tracking = await f.until((event) => event.method === "telegram.output" && String(event.body.id).startsWith("tg-reply:") && event.body.state === "tracking", restart);
		assert.deepEqual(await f.kill(), [null, "SIGKILL"]);
		const reportCheckpoint = await f.snapshot();
		const replyId = String(tracking.body.id);
		assert.equal(reportCheckpoint.inbox.inputs[replyId].output, "tracking");
		assert.ok(reportCheckpoint.inbox.inputs[replyId].submissionId);
		assert.equal(reportCheckpoint.submissions.filter((item) => item.requestId === `bg-report:${reporter.id}`).length, 1);
		const reportRestart = f.events.length;
		f.start([{ text: "The recovered background report reached this topic.", match: "[Background task restart-worker finished]", wait: "background-report-after-restart" }]);
		await f.until(isWaiting("background-report-after-restart"), reportRestart);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 161, reportRestart);
		f.release("background-report-after-restart");
		const reported = await f.until((event) => event.method === "editMessageText" && event.body.text === "The recovered background report reached this topic.", reportRestart);
		const delivery = await f.until(isOutput(replyId, "done"), reportRestart);
		assert.equal(reported.body.chat_id, "-300");
		assert.equal(reported.body.message_thread_id, 9);
		const sends = f.requests("telegram", "sendMessage");
		assert.equal(sends.length, 2, "The child stays private; only the original run and its autonomous parent report open placeholders");
		assert.equal(sends[1].generation, 2);
		assert.equal(sends[1].body.message_thread_id, 9);
		assert.deepEqual(sends[1].body.reply_parameters, { message_id: sends[0].messageId, allow_sending_without_reply: true });
		assert.ok(sends[1].messageId! > sends[0].messageId!, "The fake Telegram service must retain allocated IDs across process restarts");
		assert.equal(reported.body.message_id, sends[1].messageId);
		await f.stop();
		const after = await f.snapshot();
		assert.equal(after.submissions.filter((item) => item.requestId === "tg-update:100:160").length, 1);
		assert.equal(after.submissions.filter((item) => item.requestId === `bg:${reporter.id}`).length, 1);
		assert.equal(after.submissions.filter((item) => item.requestId === `bg-report:${reporter.id}`).length, 1);
		assert.equal(after.tasks.find((item) => item.id === reporter.id)?.state.status, "terminal");
		const row = after.inbox.inputs[String(delivery.body.id)];
		assert.ok(row.submissionId);
		assert.equal(row.output, "done");
		assert.deepEqual(row.destination, topicDestination);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("main visibly relays real panel HTTP input before its model run and recovers the original topic placeholder after a crash", { timeout: 60_000 }, async (t) => {
	const content = "Continue this topic with **literal asterisks** and `literal backticks` sent through the local panel.";
	const answer = "The panel input completed in its original Telegram topic.";
	const f = await mainFixture(t, [
		{ text: "The topic is ready for panel input." },
		{ text: answer, wait: "panel-before-kill" },
	], { panel: true });
	let passed = false;
	try {
		const listening = await f.until((event) => event.method === "panel.listening");
		assert.equal(listening.body.host, "127.0.0.1");
		assert.ok(Number.isInteger(listening.body.port) && Number(listening.body.port) > 0);
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(200, "/ask@AcceptanceBot Prepare this topic for panel input.", topic)]);
		await f.until(isOutput("tg-update:100:200", "done"));
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 201);
		const routes = Object.values(JSON.parse(await readFile(join(f.directory, "state", "sessions.json"), "utf8"))) as { id: number; destination: JsonRecord }[];
		assert.equal(routes.length, 1);
		const conversationId = routes[0].id;
		const sendStart = f.events.length;
		// Only this parent-side request reaches a socket, on the fixture's own loopback server.
		const base = `http://127.0.0.1:${listening.body.port}`;
		const response = await fetch(`${base}/api/send`, {
			method: "POST", headers: { "content-type": "application/json", origin: base, connection: "close" },
			body: JSON.stringify({ conv: conversationId, content }), signal: AbortSignal.timeout(20_000),
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true, via: "telegram" });
		const visible = await f.until((event) => event.method === "sendMessage" && event.body.text === `From admin: ${content}`, sendStart);
		assert.equal(visible.body.entities, undefined, "Panel input remains a literal user relay");
		await f.until(isWaiting("panel-before-kill"), sendStart);
		const tracking = await f.until((event) => event.method === "telegram.output" && String(event.body.id).startsWith("tg-panel:") && event.body.state === "tracking", sendStart);
		const panelModelIndex = f.events.findIndex((event, index) => index >= sendStart && event.kind === "model" && JSON.stringify(event.body.input).includes(content));
		assert.ok(panelModelIndex > f.events.indexOf(visible), "The visible Telegram relay must be sent before admitting panel input to the model");
		assert.equal(visible.body.chat_id, "-300");
		assert.equal(visible.body.message_thread_id, 9);
		const placeholder = f.requests("telegram", "sendMessage").find((event) => `tg:100:-300:${event.messageId}` === tracking.body.messageId)!;
		assert.equal(placeholder.body.text, "正在处理…");
		assert.equal(placeholder.body.message_thread_id, 9);
		assert.deepEqual(placeholder.body.reply_parameters, { message_id: visible.messageId, allow_sending_without_reply: true });
		assert.deepEqual(await f.kill(), [null, "SIGKILL"]);
		const before = await f.snapshot();
		const receiptId = String(tracking.body.id);
		const row = before.inbox.inputs[receiptId];
		assert.equal(row.output, "tracking");
		assert.equal(row.conversationId, conversationId);
		assert.equal(row.sender, "tg:200");
		assert.equal(row.content, content);
		assert.deepEqual(row.destination, topicDestination);
		assert.equal(row.replyTo, `tg:100:-300:${visible.messageId}`);
		assert.equal(row.messageId, `tg:100:-300:${placeholder.messageId}`);
		assert.equal(row.requestId, `panel-tg:100:-300:${visible.messageId}`);
		assert.ok(row.submissionId);
		assert.equal(before.submissions.filter((item) => item.requestId === row.requestId).length, 1);
		const restart = f.events.length;
		f.start([{ text: answer, wait: "panel-after-restart" }]);
		await f.until((event) => event.method === "panel.listening", restart);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 201, restart);
		await f.until(isWaiting("panel-after-restart"), restart);
		f.release("panel-after-restart");
		const edited = await f.until((event) => event.method === "editMessageText" && event.body.text === answer, restart);
		await f.until(isOutput(receiptId, "done"), restart);
		assert.equal(edited.body.message_id, placeholder.messageId);
		assert.equal(edited.body.chat_id, "-300");
		assert.equal(edited.body.message_thread_id, 9);
		assert.equal(f.requests("telegram", "sendMessage").length, 3, "Only the route placeholder, visible panel relay and original panel-run placeholder may be sent");
		assert.equal(f.requests("telegram", "sendMessage").filter((event) => event.body.text === `From admin: ${content}`).length, 1);
		assert.equal(f.requests("model").length, 3, "The initial topic run and interrupted/recovered panel model generations are expected");
		await f.stop();
		const after = await f.snapshot();
		assert.equal(after.inbox.inputs[receiptId].output, "done");
		assert.equal(after.inbox.inputs[receiptId].submissionId, row.submissionId);
		assert.equal(after.submissions.filter((item) => item.requestId === row.requestId).length, 1);
		assert.equal(after.submissions.length, 2, "A restart must not create a hidden second panel submission");
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});
