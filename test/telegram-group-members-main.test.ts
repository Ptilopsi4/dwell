import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { mainFixture, message, posixOnly } from "./telegram-main-fixture.ts";
import type { JsonRecord, MainFixtureEvent } from "./telegram-main-hook.ts";

const group = { chat: { id: -301, type: "supergroup" }, message_thread_id: 9 };
const guest = { from: { id: 999, first_name: "Guest" } };
const replyId = (event: MainFixtureEvent) => (event.body.reply_parameters as JsonRecord)?.message_id;
const done = (id: number) => (event: MainFixtureEvent) => event.method === "telegram.output" && event.body.id === `tg-update:100:${id}` && event.body.state === "done";
async function policy(directory: string) {
	return JSON.parse(await readFile(join(directory, "state", "telegram-chats.json"), "utf8")).bots["100"] as { chats: string[]; memberChats?: string[] };
}
function approvalCallback(id: number, actor: number, card: MainFixtureEvent): JsonRecord {
	const markup = card.body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
	return { update_id: id, callback_query: { id: `approval-${id}`, from: { id: actor }, data: markup.inline_keyboard[0]![0]!.callback_data,
		message: { message_id: card.messageId, date: 10, ...group, from: { id: 100, is_bot: true } } } };
}
async function post(base: string, path: string, body: JsonRecord): Promise<JsonRecord> {
	const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base, connection: "close" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
	const result = await response.json() as JsonRecord;
	assert.equal(response.status, 200, JSON.stringify(result));
	return result;
}

function replyToBot(card: MainFixtureEvent): JsonRecord {
	return { reply_to_message: { message_id: card.messageId, date: 10, ...group, from: { id: 100, is_bot: true } } };
}

test("allowgroup discovers its own group and recovers group-only work without granting private access", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "Before restart", wait: "group-member-restart" }], { admins: "tg:200" });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(1, "/allowgroup"), message(2, "/allowgroup@AnotherBot", group), message(3, "/allowgroup", { ...group, ...guest }), message(4, "/allowgroup", group)]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 5);
		const controls = f.requests("telegram", "sendMessage");
		assert.match(String(controls.find((event) => replyId(event) === 1)!.body.text), /目标群.*自动识别/);
		assert.match(String(controls.find((event) => replyId(event) === 3)!.body.text), /仅 dwell 管理员/);
		assert.match(String(controls.find((event) => replyId(event) === 4)!.body.text), /已开放本群成员使用.*-301/);
		assert.equal(f.requests("model").length, 0);
		assert.deepEqual((await policy(f.directory)).memberChats, ["-301"]);
		f.updates([
			message(5, "Guest private must remain denied", { ...guest, chat: { id: 999, type: "private" } }),
			message(6, "/ask@AcceptanceBot Other group must remain denied", { ...guest, chat: { id: -300, type: "supergroup" } }),
			message(7, "/ask@AcceptanceBot Group-only request", { ...group, ...guest }),
		]);
		await f.until((event) => event.method === "model.waiting" && event.body.token === "group-member-restart");
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:7" && event.body.state === "tracking");
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 8);
		assert.equal(f.requests("model").length, 1);
		await f.kill();
		const before = await f.snapshot();
		const original = before.inbox.inputs["tg-update:100:7"]!;
		assert.equal(original.sender, "tg:999");
		const restart = f.events.length;
		f.start([{ text: "Recovered group result." }]);
		await f.until(done(7), restart);
		await f.stop();
		const after = await f.snapshot();
		assert.equal(after.inbox.inputs["tg-update:100:7"]!.submissionId, original.submissionId);
		assert.equal(after.submissions.filter((submission) => submission.requestId === "tg-update:100:7").length, 1);
		assert.deepEqual((await policy(f.directory)).memberChats, ["-301"]);
		const users = JSON.parse(await readFile(join(f.directory, "state", "users.json"), "utf8"));
		assert.equal(users.members.includes("tg:999"), false);
		assert.equal(users.admins.includes("tg:999"), false);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("group grants cannot bypass explicit blocks, old control receipts, or a later group shutdown", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "Explicit private access works." }], { admins: "tg:200" });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(20, "/allowgroup@AcceptanceBot", group), message(21, "/disallow tg:999")]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 22);
		f.updates([message(22, "/ask@AcceptanceBot Blocked guest", { ...group, ...guest }), message(23, "/allow tg:999")]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 24);
		assert.equal(f.requests("model").length, 0);
		f.updates([message(21, "/disallow tg:999"), message(24, "Private after explicit allow", { ...guest, chat: { id: 999, type: "private" } })]);
		await f.until(done(24));
		f.updates([message(25, "/disallowgroup", group)]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 26);
		f.updates([message(20, "/allowgroup@AcceptanceBot", group), message(26, "/ask@AcceptanceBot Closed group", { ...group, ...guest })]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 27);
		assert.equal((await policy(f.directory)).chats.includes("-301"), false);
		assert.equal(f.requests("model").length, 1);
		const users = JSON.parse(await readFile(join(f.directory, "state", "users.json"), "utf8"));
		assert.equal(users.blocked.includes("tg:999"), false);
		assert.equal(users.members.includes("tg:999"), true);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("group-only users cannot preapprove or click approval while a dwell admin can resume the original actor", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ tool: "bash", arguments: { command: "rm -rf scratch/group-fixture" } }, { text: "Waiting for admin approval." }, { text: "Admin-approved continuation." }], { admins: "tg:200" });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(40, "/allowgroup", group), message(41, "/ask@AcceptanceBot Perform fixture cleanup", { ...group, ...guest })]);
		const card = await f.until((event) => event.method === "sendMessage" && JSON.stringify(event.body.reply_markup ?? {}).includes("a:"));
		await f.until(done(41));
		assert.match(JSON.stringify(f.requests("model")[1]!.body), /group-only user cannot approve/);
		f.updates([message(42, "/approve@AcceptanceBot", { ...group, ...guest }), approvalCallback(43, 999, card), approvalCallback(44, 998, card)]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 45);
		assert.equal(f.requests("model").length, 2);
		assert.ok(f.requests("telegram", "sendMessage").some((event) => String(event.body.text).includes("需 dwell 管理员点击审批卡")));
		assert.equal(f.requests("telegram", "answerCallbackQuery").filter((event) => event.body.text === "请求已失效或你没有审批权限").length, 2);
		f.updates([approvalCallback(45, 200, card)]);
		await f.until((event) => event.method === "editMessageText" && String(event.body.text).startsWith("Admin-approved continuation."));
		await f.stop();
		const state = await f.snapshot();
		const followup = Object.entries(state.inbox.inputs).find(([id]) => id.startsWith("tg-reply:"));
		assert.equal(followup?.[1].sender, "tg:999");
		assert.equal(f.requests("model").length, 3);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("group-member attachments recheck a block before model admission", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [], { admins: "tg:200" });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(60, "/allowgroup", group), message(61, "/ask@AcceptanceBot Read fixture", { ...group, ...guest, document: { file_id: "hold-members", file_name: "fixture.txt" } })]);
		await f.until((event) => event.method === "getFile" && event.body.file_id === "hold-members");
		f.updates([message(62, "/disallow tg:999")]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 63);
		f.release("file:hold-members");
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:61" && event.body.state === "failed");
		await f.stop();
		const row = (await f.snapshot()).inbox.inputs["tg-update:100:61"]!;
		assert.equal(row.sender, "tg:999");
		assert.equal(row.submissionId, undefined);
		assert.equal(f.requests("model").length, 0);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("members replying to a busy legacy thread cannot borrow its actor or approval window", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [
		{ text: "Legacy admin finished.", wait: "legacy-active" },
		{ tool: "bash", arguments: { command: "rm -rf scratch/member-isolation" } },
		{ text: "Guest requires a separate admin approval." },
		{ text: "Own thread continued." },
	], { admins: "tg:200" });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(80, "/allowchat -301"), message(81, "/approve@AcceptanceBot", group), message(82, "/ask@AcceptanceBot Keep the legacy admin active", group)]);
		await f.until((event) => event.method === "model.waiting" && event.body.token === "legacy-active");
		const legacy = await f.until((event) => event.method === "sendMessage" && replyId(event) === 82);
		f.updates([message(83, "/allowgroup", group), message(84, "Guest cleanup request", { ...group, ...guest, ...replyToBot(legacy) })]);
		const card = await f.until((event) => event.method === "sendMessage" && JSON.stringify(event.body.reply_markup ?? {}).includes("a:"));
		await f.until(done(84));
		assert.ok(f.requests("telegram", "sendMessage").some((event) => String(event.body.text).includes("已转到你自己的任务线")));
		f.updates([message(85, "Continue my own line", { ...group, ...guest, ...replyToBot(card) })]);
		await f.until(done(85));
		f.release("legacy-active");
		await f.until(done(82));
		await f.stop();
		const state = await f.snapshot();
		const inputs = state.inbox.inputs;
		assert.notEqual(inputs["tg-update:100:82"]!.conversationId, inputs["tg-update:100:84"]!.conversationId);
		assert.equal(inputs["tg-update:100:84"]!.conversationId, inputs["tg-update:100:85"]!.conversationId);
		assert.equal(inputs["tg-update:100:84"]!.sender, "tg:999");
		const pending = JSON.parse(await readFile(join(f.directory, "state", "approvals.json"), "utf8")).pending;
		assert.equal(pending.length, 1);
		assert.equal(pending[0][1].trigger, "tg:999");
		assert.equal(f.requests("model").length, 4);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("isolated lines keep panel and member inputs in separate runs while busy", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "Guest's first result.", wait: "member-busy" }, { text: "Panel result." }, { text: "Guest followup result." }], { admins: "tg:200", panel: true });
	let passed = false;
	try {
		const listening = await f.until((event) => event.method === "panel.listening");
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(100, "/allowgroup", group), message(101, "/ask@AcceptanceBot Initial member input", { ...group, ...guest })]);
		await f.until((event) => event.method === "model.waiting" && event.body.token === "member-busy");
		const placeholder = await f.until((event) => event.method === "sendMessage" && replyId(event) === 101);
		const routes = Object.values(JSON.parse(await readFile(join(f.directory, "state", "sessions.json"), "utf8"))) as { id: number; owner: string; actorScoped?: boolean }[];
		const own = routes.find((route) => route.owner === "tg:999" && route.actorScoped)!;
		await post(`http://127.0.0.1:${listening.body.port}`, "/api/send", { conv: own.id, content: "Distinct panel followup" });
		f.updates([message(102, "Distinct guest followup", { ...group, ...guest, ...replyToBot(placeholder) })]);
		await f.until((event) => event.method === "telegram.admitted" && event.body.id === "tg-update:100:102");
		assert.equal(f.requests("model").length, 1);
		f.release("member-busy");
		await f.until(done(102));
		await f.until((event) => event.method === "telegram.output" && String(event.body.id).startsWith("tg-panel:") && event.body.state === "done");
		await f.stop();
		const state = await f.snapshot();
		const accepted = Object.entries(state.inbox.inputs).filter(([id]) => id === "tg-update:100:101" || id === "tg-update:100:102" || id.startsWith("tg-panel:"));
		assert.equal(new Set(accepted.map(([, row]) => row.submissionId)).size, 3);
		assert.equal(f.requests("model").length, 3, "Each actor input must get its own model run");
		const inputs = f.requests("model").map((event) => event.body.input as { role?: string; content?: unknown }[]);
		assert.equal(inputs[1]!.filter((entry) => entry.role === "user").some((entry) => JSON.stringify(entry).includes("Distinct guest followup")), false);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("revocation during attribution prevents prepared member input from reaching the model", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [], { admins: "tg:200", panel: true, holdAttributionFor: "tg-update:100:121" });
	let passed = false;
	try {
		const listening = await f.until((event) => event.method === "panel.listening");
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(120, "/allowgroup", group), message(121, "/ask@AcceptanceBot Prepared then revoked", { ...group, ...guest })]);
		await f.until((event) => event.method === "attribution.waiting");
		await post(`http://127.0.0.1:${listening.body.port}`, "/api/users", { id: "tg:999", action: "remove" });
		f.release("attribution");
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:121" && event.body.state === "failed");
		await f.stop();
		assert.equal((await f.snapshot()).inbox.inputs["tg-update:100:121"]!.submissionId, undefined);
		assert.equal(f.requests("model").length, 0);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("revocation while an accepted approval awaits attribution prevents its continuation", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ tool: "bash", arguments: { command: "rm -rf scratch/revoked-continuation" } }, { text: "Waiting for an administrator." }], { admins: "tg:200", panel: true, holdAttributionFor: "approval" });
	let passed = false;
	try {
		const listening = await f.until((event) => event.method === "panel.listening");
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(140, "/allowgroup", group), message(141, "/ask@AcceptanceBot Await admin approval", { ...group, ...guest })]);
		const card = await f.until((event) => event.method === "sendMessage" && JSON.stringify(event.body.reply_markup ?? {}).includes("a:"));
		await f.until(done(141));
		f.updates([approvalCallback(142, 200, card)]);
		await f.until((event) => event.method === "attribution.waiting");
		await post(`http://127.0.0.1:${listening.body.port}`, "/api/users", { id: "tg:999", action: "remove" });
		f.release("attribution");
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 143);
		await f.stop();
		const state = await f.snapshot();
		assert.equal(state.submissions.some((submission) => submission.requestId?.startsWith("approval:")), false);
		assert.equal(f.requests("model").length, 2);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("default panel operators retain approval authority without a global bot role", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ tool: "bash", arguments: { command: "ssh synthetic.invalid" } }, { text: "Panel approval is required." }, { text: "Panel approval continued." }], { panel: true, defaultPanelOperator: true });
	let passed = false;
	try {
		const listening = await f.until((event) => event.method === "panel.listening");
		const base = `http://127.0.0.1:${listening.body.port}`;
		const conversation = await post(base, "/api/conversations", { name: "Default operator regression" });
		await post(base, "/api/send", { conv: conversation.id, content: "Default panel requires approval" });
		await f.until((event) => event.kind === "model" && JSON.stringify(event.body.input).includes("The approval policy blocked"));
		const state = JSON.parse(await readFile(join(f.directory, "state", "approvals.json"), "utf8"));
		const [key, approval] = state.pending[0];
		assert.equal(approval.trigger, "panel");
		assert.equal(approval.via, "panel");
		const result = await post(base, "/api/approve", { key, action: "approve", minutes: 10, requestId: approval.requestId });
		assert.equal(result.ok, true);
		await f.until((event) => event.kind === "model" && JSON.stringify(event.body.input).includes("The user approved"));
		await f.stop();
		assert.equal(f.requests("model").length, 3);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("member file tools apply their isolated scope through the main assembly", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [], { admins: "tg:200" });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		const outside = join(f.directory, "outside-member-workspace.txt");
		await writeFile(outside, "PRIVATE_FIXTURE_MUST_NOT_ENTER_MODEL");
		f.replies([{ tool: "read", arguments: { path: outside } }, { text: "Scoped file access handled." }]);
		f.updates([message(160, "/allowgroup", group), message(161, "/ask@AcceptanceBot Read the supplied path", { ...group, ...guest })]);
		await f.until(done(161));
		await f.stop();
		assert.equal(f.requests("model").length, 2);
		assert.match(JSON.stringify(f.requests("model")[1]!.body.input), /Access is limited to this session/);
		assert.equal(JSON.stringify(f.requests("model")).includes("PRIVATE_FIXTURE_MUST_NOT_ENTER_MODEL"), false);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});
