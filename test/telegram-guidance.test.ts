import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { JsonRecord } from "./telegram-main-hook.ts";
import { mainFixture, message } from "./telegram-main-fixture.ts";

const group = { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 };
const replyTo = (id: number) => ({ message_id: id, date: 10, chat: group.chat, from: { id: 100, is_bot: true } });

test("main Telegram host guidance uses the real username and preserves admission without model calls", { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [], { admins: "tg:200" });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([
			message(1, "/start", { from: { id: 999 }, chat: { id: 999, type: "private" } }),
			message(2, "/ask", { from: { id: 999 }, chat: { id: 999, type: "private" } }),
			message(3, "/start", group),
			message(4, "/ask@AnotherBot", group),
			message(5, "/start@AcceptanceBot", { chat: { id: -301, type: "supergroup" } }),
			message(6, "/ask@AcceptanceBot", { ...group, from: { id: 999 } }),
			message(7, "/start"),
			message(8, "/ask \n\t"),
			message(9, "/help"),
			message(10, "/start@AcceptanceBot", group),
			message(11, "/ask@AcceptanceBot", group),
		]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 12);
		const sends = f.requests("telegram", "sendMessage");
		const sentFor = (id: number) => sends.find((event) => (event.body.reply_parameters as JsonRecord)?.message_id === id)!;
		for (const id of [1, 2, 6]) assert.equal(sentFor(id).body.text, "未授权使用，请联系管理员开通。");
		for (const id of [3, 4]) assert.equal(sentFor(id), undefined);
		assert.equal(sentFor(5).body.chat_id, "-301");
		assert.match(String(sentFor(5).body.text), /^这个群尚未启用/);
		assert.match(String(sentFor(5).body.text), /聊天 ID：-301/);
		for (const id of [7, 9, 10]) {
			const text = String(sentFor(id).body.text);
			assert.match(text, /私聊：直接发送文字、图片或文件/);
			assert.match(text, /\/ask@AcceptanceBot 内容，或回复 @AcceptanceBot 的消息/);
			assert.match(text, /\/new：开启新任务线，原任务线与历史消息保留/);
			assert.match(text, /\/newgoal：开启新目标，保留聊天历史与旧任务记录/);
			assert.match(text, /\/cancel：中止当前任务，不会取消后台任务/);
			assert.match(text, /\/approve \[分钟\]：开启危险命令批准窗口，默认 10 分钟/);
			assert.match(text, /\/deny：关闭批准窗口并取消待审请求/);
			assert.doesNotMatch(text, /@bot\b/);
		}
		assert.match(String(sentFor(9).body.text), /管理员命令：[\s\S]*\/status：[\s\S]*\/allow tg:用户ID \[admin\]、\/disallow tg:用户ID/);
		assert.match(String(sentFor(9).body.text), /\/allowchat \[负数群ID\]、\/disallowchat \[负数群ID\]/);
		assert.match(String(sentFor(9).body.text), /\/chats：查看当前 bot 已启用的群/);
		for (const id of [7, 10]) assert.doesNotMatch(String(sentFor(id).body.text), /\/status|\/allow|\/disallow/);
		for (const id of [8, 11]) {
			assert.match(String(sentFor(id).body.text), /^请在命令后写下任务，例如：\/ask@AcceptanceBot/);
			assert.doesNotMatch(String(sentFor(id).body.text), /\/status|\/allow|\/disallow/);
		}
		const after = f.events.length;
		f.updates([message(12, "/ask", { ...group, reply_to_message: replyTo(sentFor(10).messageId!) })]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 13, after);
		const replyGuide = f.requests("telegram", "sendMessage").find((event) => (event.body.reply_parameters as JsonRecord)?.message_id === 12)!;
		assert.match(String(replyGuide.body.text), /^请在命令后写下任务，例如：\/ask@AcceptanceBot/);
		assert.equal(replyGuide.body.chat_id, "-300");
		assert.equal(replyGuide.body.message_thread_id, 9);
		f.updates([message(13, "/help", { from: { id: 201 }, chat: { id: 201, type: "private" } })]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 14);
		const memberHelp = f.requests("telegram", "sendMessage").find((event) => (event.body.reply_parameters as JsonRecord)?.message_id === 13)!;
		assert.doesNotMatch(String(memberHelp.body.text), /管理员命令|\/status|\/allow|\/disallow|\/chats/);
		assert.equal(f.requests("model").length, 0);
		assert.equal(f.requests("unexpected").length, 0);
		await f.stop();
		const { inbox, submissions } = await f.snapshot();
		assert.equal(submissions.length, 0);
		assert.deepEqual(inbox.inputs, {});
		assert.deepEqual(Object.keys(inbox.commands).sort(), [7, 8, 9, 10, 11, 12, 13].map((id) => `tg-update:100:${id}`).sort());
		for (const receipt of Object.values(inbox.commands)) assert.equal((receipt as JsonRecord).done, true);
		passed = true;
	} finally { await f.close(passed); }
});

test("main Telegram host guidance command receipts survive a failed cursor write without duplicate replies", { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		let offset = 0;
		for (const [id, text] of [[60, "/start"], [61, "/ask"]] as const) {
			const obstruction = join(f.directory, "state", "telegram", "100.json.tmp");
			await mkdir(obstruction);
			const start = f.events.length;
			f.updates([message(id, text)]);
			await f.until((event) => event.method === "getUpdates" && event.body.offset === offset, start);
			await rm(obstruction, { recursive: true });
			const replay = f.events.length;
			f.updates([message(id, text)]);
			offset = id + 1;
			await f.until((event) => event.method === "getUpdates" && event.body.offset === offset, replay);
			assert.equal(f.requests("telegram", "sendMessage").filter((event) => (event.body.reply_parameters as JsonRecord)?.message_id === id).length, 1);
		}
		assert.equal(f.requests("model").length, 0);
		assert.equal(f.requests("unexpected").length, 0);
		await f.stop();
		const { inbox, submissions } = await f.snapshot();
		assert.equal(submissions.length, 0);
		assert.deepEqual(inbox.inputs, {});
		for (const id of [60, 61]) assert.equal((inbox.commands[`tg-update:100:${id}`] as JsonRecord).done, true);
		passed = true;
	} finally { await f.close(passed); }
});

test("main Telegram ask text, directed group replies and attachment-only asks still reach the model", { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		for (const [id, text, overrides, answer] of [
			[100, "/ask Plain ask body.", {}, "Private ask completed."],
			[101, "/ask@AcceptanceBot Directed group ask body.", group, "Group ask completed."],
		] as const) {
			f.replies([{ text: answer }]);
			f.updates([message(id, text, overrides)]);
			await f.until((event) => event.method === "telegram.output" && event.body.id === `tg-update:100:${id}` && event.body.state === "done");
		}
		const groupAnswer = f.requests("telegram", "sendMessage").find((event) => event.body.chat_id === "-300")!;
		f.replies([{ text: "Reply completed." }]);
		f.updates([message(102, "Continue through an actual reply.", { ...group, reply_to_message: replyTo(groupAnswer.messageId!) })]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:102" && event.body.state === "done");
		for (const [id, overrides, answer] of [
			[103, { text: undefined, caption: "/ask", document: { file_id: "ask-document", file_name: "notes.txt" } }, "Document ask completed."],
			[104, { ...group, text: undefined, caption: "/ask@AcceptanceBot", photo: [{ file_id: "ask-image" }] }, "Image ask completed."],
		] as const) {
			f.replies([{ text: answer }]);
			f.updates([message(id, "", overrides)]);
			await f.until((event) => event.method === "telegram.output" && event.body.id === `tg-update:100:${id}` && event.body.state === "done");
		}
		const requests = f.requests("model");
		assert.equal(requests.length, 5);
		assert.match(JSON.stringify(requests[0].body.input), /Plain ask body\./);
		assert.match(JSON.stringify(requests[1].body.input), /Directed group ask body\./);
		assert.match(JSON.stringify(requests[2].body.input), /Continue through an actual reply\./);
		assert.match(JSON.stringify(requests[3].body.input), /notes\.txt/);
		assert.match(JSON.stringify(requests[4].body.input), /uploads\/[^"\s]*image-1\.bin/);
		assert.equal(f.requests("checkpoint", "media.downloaded").length, 2);
		assert.equal(f.requests("unexpected").length, 0);
		assert.ok(f.requests("telegram", "sendMessage").every((event) => event.body.text === "正在处理…"));
		await f.stop();
		const { inbox, submissions } = await f.snapshot();
		assert.equal(submissions.filter((submission) => submission.type === "input").length, 5);
		assert.deepEqual(inbox.commands, {});
		assert.equal(inbox.inputs["tg-update:100:101"].conversationId, inbox.inputs["tg-update:100:102"].conversationId);
		for (const id of [103, 104]) {
			const receipt = inbox.inputs[`tg-update:100:${id}`];
			assert.equal(receipt.prepared, true);
			assert.equal(receipt.output, "done");
			assert.equal(JSON.parse(receipt.raw!).content, "");
		}
		passed = true;
	} finally { await f.close(passed); }
});
