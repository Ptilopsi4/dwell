import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { JsonRecord } from "./telegram-main-hook.ts";
import { mainFixture, message, posixOnly } from "./telegram-main-fixture.ts";

test("main Telegram delivers both answers when a busy input becomes a later generation", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "ANSWER_A", wait: "first-answer" }, { text: "ANSWER_B" }]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(201, "Question A")]);
		await f.until((event) => event.method === "model.waiting");
		f.updates([message(202, "Question B while A awaits final answer")]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 203);
		// Admission must finish before releasing A so B exercises the busy submission path.
		await f.until((event) => event.method === "telegram.admitted" && event.body.id === "tg-update:100:202");
		f.release("first-answer");
		await f.until((event) => event.method === "editMessageText" && event.body.text === "ANSWER_A");
		await f.until((event) => event.method === "editMessageText" && event.body.text === "ANSWER_B");
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:202" && event.body.state === "done");
		await f.stop();
		const { inbox, submissions } = await f.snapshot();
		for (const id of [201, 202]) {
			const row = inbox.inputs[`tg-update:100:${id}`];
			assert.equal(row.output, "done");
			assert.equal(row.sender, "tg:200");
			assert.equal(row.replyTo, `tg:100:200:${id}`);
			assert.equal(row.requestId, `tg-update:100:${id}`);
			assert.equal(submissions.find((submission) => submission.id === row.submissionId)?.answer, row.answerId);
		}
		assert.notEqual(inbox.inputs["tg-update:100:201"].answerId, inbox.inputs["tg-update:100:202"].answerId);
		assert.equal(f.requests("model").length, 2);
		for (const text of ["ANSWER_A", "ANSWER_B"]) assert.equal(f.requests("telegram", "editMessageText").filter((event) => event.body.text === text).length, 1);
		passed = true;
	} finally { await f.close(passed); }
});

test("main Telegram cancels a blocked attachment and admits later input on the same route", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "Other chat completed.", match: "Another chat ordinary input" }, { text: "Replacement completed.", match: "Replacement after attachment cancellation" }]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(210, "Analyze slow attachment", { document: { file_id: "hold-cancel", file_name: "slow.txt" } })]);
		await f.until((event) => event.method === "media.waiting");
		await f.until((event) => event.method === "sendChatAction");
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 211);
		f.updates([
			message(211, "Another chat ordinary input", { from: { id: 201, first_name: "Other" }, chat: { id: 201, type: "private" } }),
			message(212, "/cancel"),
		]);
		await f.until((event) => event.method === "sendMessage" && event.body.text === "已中止当前任务。");
		await f.until((event) => event.method === "media.aborted" && event.body.token === "file:hold-cancel");
		await f.until((event) => event.method === "editMessageText" && event.body.text === "Other chat completed.");
		assert.equal(f.requests("checkpoint", "media.downloaded").length, 0);
		const activityCount = f.requests("telegram", "sendChatAction").length;
		await delay(4_100);
		assert.equal(f.requests("telegram", "sendChatAction").length, activityCount, "Cancelled preprocessing must release its activity");
		f.updates([message(213, "Replacement after attachment cancellation")]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:213" && event.body.state === "done");
		await f.stop();
		const { inbox } = await f.snapshot();
		const row = inbox.inputs["tg-update:100:210"];
		assert.equal(row.output, "failed");
		assert.equal(row.prepared, false);
		assert.equal(row.content, "");
		assert.equal(row.preparationAttempts, undefined);
		assert.equal(row.submissionId, undefined);
		assert.match(row.raw!, /hold-cancel/);
		assert.equal(inbox.inputs["tg-update:100:213"].conversationId, row.conversationId);
		assert.equal(f.requests("checkpoint", "media.downloaded").length, 0);
		assert.equal(f.requests("model").length, 2, "Only the other chat and replacement input may request the model");
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("main Telegram cancels vision preparation and preserves the cancelled receipt across restart", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [
		{ text: "Cancelled vision description", wait: "cancel-vision", match: "Describe this image" },
		{ text: "Vision replacement completed.", match: "Replacement after vision cancellation" },
	], { vision: true });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(216, "Analyze this image", { photo: [{ file_id: "image-cancel", width: 1, height: 1, file_size: 12 }] })]);
		await f.until((event) => event.method === "model.waiting" && event.body.token === "cancel-vision");
		assert.equal(f.requests("model")[0].body.model, "opaque-acceptance-vision");
		f.updates([message(217, "/cancel")]);
		await f.until((event) => event.method === "sendMessage" && event.body.text === "已中止当前任务。");
		await f.until((event) => event.method === "model.aborted" && event.body.token === "cancel-vision");
		f.updates([message(218, "Replacement after vision cancellation")]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:218" && event.body.state === "done");
		await f.stop();
		const before = await f.snapshot();
		const cancelled = before.inbox.inputs["tg-update:100:216"];
		assert.equal(cancelled.output, "failed");
		assert.equal(cancelled.prepared, false);
		assert.equal(cancelled.submissionId, undefined);
		assert.equal(cancelled.preparationAttempts, undefined);
		assert.equal(f.requests("model").length, 2, "Cancelled vision must not submit its description to the main model");
		const afterRestart = f.events.length;
		f.start([{ text: "Later work completed.", wait: "later-work" }]);
		await f.until((event) => event.method === "getUpdates", afterRestart);
		f.updates([message(219, "New work after restart")]);
		await f.until((event) => event.method === "model.waiting" && event.body.token === "later-work", afterRestart);
		const replay = f.events.length;
		f.updates([message(217, "/cancel")]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 220, replay);
		assert.equal(f.requests("checkpoint", "model.aborted").filter((event) => event.body.token === "later-work").length, 0);
		f.release("later-work");
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:219" && event.body.state === "done", afterRestart);
		await f.stop();
		const after = await f.snapshot();
		assert.deepEqual(after.inbox.inputs["tg-update:100:216"], cancelled);
		assert.equal(f.events.slice(afterRestart).filter((event) => event.method === "getFile").length, 0);
		assert.equal(after.submissions.filter((submission) => submission.requestId === "tg-update:100:218").length, 1);
		assert.equal(after.submissions.filter((submission) => submission.requestId === "tg-update:100:219").length, 1);
		assert.equal(f.requests("model").length, 3);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

for (const failActivity of [false, true]) test(`main Telegram attachment preparation is visible before model admission${failActivity ? " even when the activity endpoint fails" : ""}`, { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "ATTACHMENT_PROCESSED" }], { failActivity });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(215, "Read this attachment.", { document: { file_id: "hold-activity", file_name: "notes.txt" } })]);
		const activity = await f.until((event) => event.method === "sendChatAction");
		await f.until((event) => event.method === "media.waiting");
		assert.deepEqual(activity.body, { chat_id: "200", action: "typing" });
		// 附件准备前就发持久占位（下载+视觉描述可达数秒），且不触发模型
		const placeholder = f.requests("telegram", "sendMessage").find((event) => event.body.text === "正在接收附件…");
		assert.ok(placeholder, "A persistent placeholder must appear before attachment preparation");
		const reply = placeholder.body.reply_parameters as { message_id?: number } | undefined;
		assert.equal(reply?.message_id, 215);
		assert.equal(f.requests("model").length, 0);
		f.release("file:hold-activity");
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:215" && event.body.state === "done");
		assert.equal(f.requests("model").length, 1);
		assert.equal(f.requests("telegram", "editMessageText").filter((event) => event.body.text === "ATTACHMENT_PROCESSED").length, 1);
		const count = f.requests("telegram", "sendChatAction").length;
		await delay(4_100);
		assert.equal(f.requests("telegram", "sendChatAction").length, count, "Prepared input must release its activity before ordinary model handling");
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { f.release("file:hold-activity"); await f.close(passed); }
});

test("main Telegram recovers the persisted raw attachment after cursor advancement and a hard restart", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(220, "Recover my attachment", { document: { file_id: "hold-restart", file_name: "original.txt" } })]);
		await f.until((event) => event.method === "media.waiting");
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 221);
		await f.kill();
		const before = (await f.snapshot()).inbox.inputs["tg-update:100:220"];
		assert.equal(before.prepared, false);
		assert.equal(before.submissionId, undefined);
		assert.match(before.raw!, /hold-restart/);
		const start = f.events.length;
		f.start([{ text: "Recovered attachment answer." }]);
		await f.until((event) => event.method === "media.waiting", start);
		f.release("file:hold-restart");
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:220" && event.body.state === "done", start);
		await f.stop();
		const { inbox, submissions } = await f.snapshot();
		const after = inbox.inputs["tg-update:100:220"];
		assert.equal(after.conversationId, before.conversationId);
		assert.equal(after.sender, before.sender);
		assert.deepEqual(after.destination, before.destination);
		assert.equal(after.prepared, true);
		assert.equal(after.output, "done");
		assert.equal(submissions.filter((submission) => submission.requestId === "tg-update:100:220").length, 1);
		assert.equal(f.requests("model").length, 1);
		assert.match(JSON.stringify(f.requests("model")[0].body.input), /Recover my attachment/);
		passed = true;
	} finally { await f.close(passed); }
});

test("main Telegram entry enforces admission and delivers real Harness results to private and directed topic inputs", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t);
	let passed = false;
	try {
		f.replies([{ text: "Private acceptance answer." }, { text: "Topic acceptance answer." }]);
		await f.until((event) => event.method === "getUpdates");
		f.updates([
			message(1, "/whoami", { from: { id: 999, first_name: "Unknown" }, chat: { id: 999, type: "private" } }),
			message(2, "", { from: { id: 999, first_name: "Unknown" }, chat: { id: 999, type: "private" }, document: { file_id: "must-never-download", file_name: "private.txt" } }),
			message(3, "Ignored group input", { chat: { id: -300, type: "supergroup" } }),
			message(4, "Ignored topic input", { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 }),
			message(5, "/ask@AcceptanceBot Rejected chat input", { chat: { id: -301, type: "supergroup" } }),
			message(6, "Private acceptance question."),
		]);
		await f.until((event) => event.method === "editMessageText" && event.body.text === "Private acceptance answer.");
		assert.equal(f.requests("model").length, 1);
		assert.ok(f.requests("telegram", "sendMessage").some((event) => event.body.text === "你的 ID：tg:999；聊天 ID：999"));
		assert.ok(f.requests("telegram", "sendMessage").some((event) => event.body.text === "未授权使用，请联系管理员开通。"));
		assert.equal(f.requests("unexpected").length, 0, "Unauthorized files and ignored inputs must not trigger downloads, vision, or other network calls");
		const start = f.events.length;
		f.updates([message(7, "/ask@AcceptanceBot Topic acceptance question.", { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 })]);
		await f.until((event) => event.method === "editMessageText" && event.body.text === "Topic acceptance answer.", start);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 8, start);
		const modelRequests = f.requests("model");
		assert.equal(modelRequests.length, 2);
		assert.match(JSON.stringify(modelRequests[0].body.input), /Private acceptance question\./);
		assert.match(JSON.stringify(modelRequests[1].body.input), /Topic acceptance question\./);
		assert.doesNotMatch(JSON.stringify(modelRequests), /Ignored (group|topic)|Rejected chat|must-never-download/);
		for (const event of modelRequests) assert.equal(event.body.model, "opaque-acceptance-model");
		const topicEdits = f.requests("telegram", "editMessageText").filter((event) => event.body.chat_id === "-300");
		assert.equal(topicEdits.length, 1);
		assert.equal(topicEdits[0].body.text, "Topic acceptance answer.");
		const topicSends = f.requests("telegram", "sendMessage").filter((event) => event.body.chat_id === "-300");
		assert.equal(topicSends.length, 1);
		assert.equal(topicSends[0].body.message_thread_id, 9);
		assert.deepEqual(topicSends[0].body.reply_parameters, { message_id: 7, allow_sending_without_reply: true });
		const routes = JSON.parse(await readFile(join(f.directory, "state", "sessions.json"), "utf8")) as Record<string, { owner: string; destination: JsonRecord }>;
		assert.equal(Object.keys(routes).length, 2);
		for (const route of Object.values(routes)) { assert.equal(route.owner, "tg:200"); assert.equal(route.destination.botId, "100"); }
		const anchors = JSON.parse(await readFile(join(f.directory, "state", "message-map.json"), "utf8")) as Record<string, number>;
		assert.ok(anchors["tg:100:200:6"]);
		assert.ok(anchors["tg:100:-300:7"]);
		assert.notEqual(anchors["tg:100:200:6"], anchors["tg:100:-300:7"]);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("main Telegram identity commands return the current chat ID without admitting an unlisted group", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([
			message(50, "/whoami"),
			message(51, "/whoami@AcceptanceBot", { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 }),
			message(52, "/whoami@AcceptanceBot", { chat: { id: -301, type: "supergroup" } }),
			message(53, "/ask@AcceptanceBot Read this private attachment", { from: { id: 999, first_name: "Unknown" }, chat: { id: -301, type: "supergroup" }, document: { file_id: "must-not-download", file_name: "secret.txt" } }),
			message(54, "Ordinary group chat", { chat: { id: -301, type: "supergroup" } }),
			message(55, "/help@AnotherBot", { chat: { id: -301, type: "supergroup" } }),
			message(56, "/help@AcceptanceBot", { chat: { id: -301, type: "supergroup" }, sender_chat: { id: -301, type: "supergroup" } }),
		]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 57);
		const replies = f.requests("telegram", "sendMessage");
		assert.equal(replies.length, 4);
		assert.equal(replies[0].body.text, "你的 ID：tg:200；聊天 ID：200");
		assert.equal(replies[1].body.text, "你的 ID：tg:200；聊天 ID：-300");
		assert.equal(replies[1].body.chat_id, "-300");
		assert.equal(replies[1].body.message_thread_id, 9);
		for (const [index, sender] of [[2, "tg:200"], [3, "tg:999"]] as const) {
			assert.equal(replies[index].body.chat_id, "-301");
			assert.match(String(replies[index].body.text), /这个群尚未启用/);
			assert.match(String(replies[index].body.text), /聊天 ID：-301/);
			assert.ok(String(replies[index].body.text).includes(`你的 ID：${sender}`));
			assert.doesNotMatch(String(replies[index].body.text), /private attachment|secret\.txt|Ordinary group chat/);
			assert.deepEqual(replies[index].body.reply_parameters, { message_id: 50 + index, allow_sending_without_reply: true });
		}
		assert.equal(f.requests("model").length, 0);
		assert.equal(f.requests("telegram", "getFile").length, 0);
		assert.equal(f.requests("unexpected").length, 0);
		await f.stop();
		const { inbox } = await f.snapshot();
		assert.equal(Object.values(inbox.inputs).length, 0, "Admission notices must not enqueue model input");
		const routes = JSON.parse(await readFile(join(f.directory, "state", "sessions.json"), "utf8")) as Record<string, { destination: { chatId?: string } }>;
		assert.ok(Object.values(routes).every((route) => route.destination.chatId !== "-301"), "An unlisted group must not acquire a conversation route");
		passed = true;
	} finally { await f.close(passed); }
});

test("main Telegram entry replays a cursor-write failure without a second model run or answer", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t);
	let passed = false;
	try {
		f.replies([{ text: "One accepted answer." }]);
		await f.until((event) => event.method === "getUpdates");
		const obstruction = join(f.directory, "state", "telegram", "100.json.tmp");
		await mkdir(obstruction);
		const update = message(10, "Exactly one accepted question.");
		const first = f.events.length;
		f.updates([update]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 0, first);
		await rm(obstruction, { recursive: true });
		const replay = f.events.length;
		f.updates([update]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 11, replay);
		await f.until((event) => event.method === "editMessageText" && event.body.text === "One accepted answer.");
		assert.equal(f.requests("model").length, 1);
		assert.equal(f.requests("telegram", "sendMessage").length, 1);
		assert.equal(f.requests("telegram", "editMessageText").length, 1);
		assert.equal(f.requests("unexpected").length, 0);
		assert.deepEqual(JSON.parse(await readFile(join(f.directory, "state", "telegram", "100.json"), "utf8")), { botId: "100", offset: 11 });
		passed = true;
	} finally { await f.close(passed); }
});

test("main Telegram entry advances past failed unsupported-media notices and accepts the next private input", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t);
	let passed = false;
	try {
		f.replies([{ text: "The next private input completed." }]);
		f.rejectReplies([40, 41]);
		await f.until((event) => event.method === "getUpdates");
		const first = f.events.length;
		f.updates([
			message(40, "", { text: undefined, caption: "Do not submit this voice caption.", voice: { file_id: "unsupported-voice", duration: 1 } }),
			message(41, "", { text: undefined, caption: "Do not submit this sticker caption.", sticker: { file_id: "unsupported-sticker", type: "regular", width: 64, height: 64 } }),
		]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 42, first);
		assert.equal(f.requests("model").length, 0, "Unsupported media captions must not reach the model");
		const failedNotices = f.requests("telegram", "sendMessage");
		assert.equal(failedNotices.length, 2);
		for (const notice of failedNotices) assert.equal(notice.body.text, "目前支持文本、图片和文件消息。");
		assert.deepEqual(failedNotices.map((event) => event.body.reply_parameters), [{ message_id: 40, allow_sending_without_reply: true }, { message_id: 41, allow_sending_without_reply: true }]);
		const next = f.events.length;
		f.updates([message(42, "Continue with this ordinary private input.")]);
		await f.until((event) => event.method === "editMessageText" && event.body.text === "The next private input completed.", next);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 43, next);
		assert.equal(f.requests("model").length, 1);
		assert.match(JSON.stringify(f.requests("model")[0].body.input), /Continue with this ordinary private input\./);
		assert.doesNotMatch(JSON.stringify(f.requests("model")), /Do not submit this (voice|sticker) caption/);
		assert.equal(f.requests("telegram", "sendMessage").length, 3);
		assert.equal(f.requests("telegram", "editMessageText").length, 1);
		assert.deepEqual(JSON.parse(await readFile(join(f.directory, "state", "telegram", "100.json"), "utf8")), { botId: "100", offset: 43 });
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("main Telegram approval buttons reject another member and admit one continuation for the original actor", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t);
	let passed = false;
	try {
		const disposable = join(f.directory, "disposable-fixture");
		await mkdir(disposable);
		await writeFile(join(disposable, "marker.txt"), "The blocked command must not execute.");
		f.replies([
			{ tool: "bash", arguments: { command: `rm -rf '${disposable}'` } },
			{ text: "Approval is required before continuing." },
			{ text: "The approved continuation was received once." },
		]);
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(20, "/ask@AcceptanceBot Remove the disposable fixture after approval.", { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 })]);
		const card = await f.until((event) => event.method === "sendMessage" && event.body.reply_markup !== undefined);
		const pending = await f.until((event) => event.method === "editMessageText" && String(event.body.text).startsWith("Approval is required before continuing.\n\n执行记录"));
		assert.match(String(pending.body.text), /bash.*失败或中断/);
		assert.equal(await readFile(join(disposable, "marker.txt"), "utf8"), "The blocked command must not execute.");
		assert.equal(f.requests("model").length, 2);
		const blocked = (f.requests("model")[1].body.input as JsonRecord[]).find((item) => item.type === "function_call_output");
		assert.match(String(blocked?.output), /approval policy blocked this command/);
		const markup = card.body.reply_markup as { inline_keyboard: { callback_data: string; text: string }[][] };
		assert.equal(markup.inline_keyboard[0].length, 3);
		const data = markup.inline_keyboard[0][0].callback_data;
		const callback = (updateId: number, actor: number, id: string): JsonRecord => ({ update_id: updateId, callback_query: {
			id, from: { id: actor, first_name: "Member" }, data,
			message: { message_id: card.messageId, date: 10, chat: { id: -300, type: "supergroup" }, message_thread_id: 9, from: { id: 100, is_bot: true, first_name: "Acceptance" } },
		} });
		let start = f.events.length;
		f.updates([callback(21, 201, "other-member")]);
		const rejected = await f.until((event) => event.method === "answerCallbackQuery" && event.body.callback_query_id === "other-member", start);
		assert.equal(rejected.body.text, "请求已失效或你没有审批权限");
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 22, start);
		assert.equal(f.requests("model").length, 2, "Another allowed member must not start the approval continuation");
		start = f.events.length;
		f.updates([callback(22, 200, "original-actor")]);
		const approved = await f.until((event) => event.method === "answerCallbackQuery" && event.body.callback_query_id === "original-actor", start);
		assert.equal(approved.body.text, "已批准");
		await f.until((event) => event.method === "editMessageText" && event.body.text === "The approved continuation was received once.", start);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 23, start);
		assert.equal(f.requests("model").length, 3);
		assert.match(JSON.stringify(f.requests("model")[2].body.input), /The user approved a 10-minute window for dangerous commands/);
		assert.equal(f.requests("telegram", "editMessageText").filter((event) => event.body.text === "The approved continuation was received once.").length, 1);
		assert.ok(f.requests("telegram", "editMessageText").some((event) => String(event.body.text).startsWith("已批准 · 10 分钟") && event.body.message_id === card.messageId));
		start = f.events.length;
		f.updates([callback(23, 200, "consumed-request")]);
		const consumed = await f.until((event) => event.method === "answerCallbackQuery" && event.body.callback_query_id === "consumed-request", start);
		assert.equal(consumed.body.text, "请求已失效或你没有审批权限");
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 24, start);
		assert.equal(f.requests("model").length, 3, "A consumed button must not create another continuation");
		assert.equal(await readFile(join(disposable, "marker.txt"), "utf8"), "The blocked command must not execute.");
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});
