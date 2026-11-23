import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BudgetDoc } from "../src/ext/budget.ts";
import { getWork, WorkDoc, type WorkRecord } from "../src/ext/work.ts";
import { NewGoalDoc } from "../src/new-goal.ts";
import { messageAction } from "../src/pipeline.ts";
import { normalizeTelegramUpdate, type TelegramUpdate } from "../src/telegram.ts";
import { TelegramInbox } from "../src/telegram-entry.ts";
import { startPanel } from "../src/web/server.ts";
import { mainFixture, message, posixOnly } from "./telegram-main-fixture.ts";

// node:sqlite can keep the -shm sidecar locked briefly after close on Windows; teardown then fails with EBUSY.
const winSqlite = { skip: process.platform === "win32" ? "Windows holds SQLite sidecar files locked during teardown" : false };

function workRecord(id: string): WorkRecord {
	return {
		id, creator: "tg:300", goal: "Keep the previous report",
		progress: "Waiting for feedback", blockers: ["A reviewer has not replied"], status: "active", createdAt: 1, updatedAt: 2,
		limits: { modelAdmissions: 7, toolAdmissions: 11 }, stopped: "model_limit", members: {}, tasks: {},
		usage: { scope: "generation_and_tools", pricingKnown: false, modelAdmissions: 7, toolAdmissions: 3, modelResponses: 7, toolResults: 3, inputTokens: 140, outputTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0, cost: null },
	};
}

async function panel(t: TestContext, harness: Harness): Promise<string> {
	const before = { only: process.env.DWELL_PANEL_ONLY, host: process.env.DWELL_PANEL_HOST };
	process.env.DWELL_PANEL_ONLY = "1";
	process.env.DWELL_PANEL_HOST = "127.0.0.1";
	let server: ReturnType<typeof startPanel>;
	try {
		server = startPanel({
			harness, sessions: {} as never, users: {} as never, directory: {} as never,
			feishu: { operator: () => "tg:700", status: () => "off", relay: async () => {}, notice: async () => {}, notifyPanel: async () => {}, decide: async () => ({ ok: true }) },
			port: 0, describer: () => null, sandbox: () => false, saveUpload: async () => { throw new Error("Uploads are not used by this test"); },
		});
	} finally {
		if (before.only === undefined) delete process.env.DWELL_PANEL_ONLY; else process.env.DWELL_PANEL_ONLY = before.only;
		if (before.host === undefined) delete process.env.DWELL_PANEL_HOST; else process.env.DWELL_PANEL_HOST = before.host;
	}
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	await once(server, "listening");
	const address = server.address();
	assert.ok(address !== null && typeof address !== "string");
	return `http://127.0.0.1:${address.port}`;
}

test("goal panel requests require admitted JSON, establish the record and use the configured operator across replay", async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	const previous = workRecord("previous-work");
	await harness.commit(async (tx) => {
		const doc = await tx.doc(WorkDoc, conversation.id);
		doc.current = previous.id;
		doc.records[previous.id] = previous;
		await tx.appendEntry(conversation.id, { kind: "chat.fixture", data: { text: "Keep the old conversation" } });
	}, context);
	const base = await panel(t, harness);
	const body = { id: conversation.id, workId: previous.id, requestId: "panel-original", operator: "untrusted-body", goal: "Renew the durable goal" };
	const post = (value: unknown, headers: Record<string, string> = { "content-type": "application/json", origin: base }) => fetch(`${base}/api/work/goal`, { method: "POST", headers, body: JSON.stringify(value) });
	assert.equal((await post(body, { "content-type": "text/plain", origin: base })).status, 415);
	assert.equal((await post(body, { "content-type": "application/json", origin: "https://untrusted.example" })).status, 403);
	for (const invalid of [
		{ ...body, id: "invalid" }, { ...body, workId: undefined }, { ...body, workId: "" },
		{ ...body, requestId: " " }, { ...body, requestId: "x".repeat(201) },
		{ ...body, goal: undefined }, { ...body, goal: " " }, { ...body, goal: "x".repeat(4001) },
	]) assert.equal((await post(invalid)).status, 400);
	assert.equal((await post({ ...body, id: 999999 })).status, 404);
	assert.equal((await harness.snapshot(WorkDoc, conversation.id, context))?.current, previous.id);
	assert.equal(await harness.snapshot(NewGoalDoc, conversation.id, context), undefined);

	const response = await post(body);
	assert.equal(response.status, 200);
	const first = await response.json();
	assert.equal(first.changed, true);
	assert.equal(first.workId, previous.id);
	assert.ok(first.created);
	const saved = await (await fetch(`${base}/api/work?id=${conversation.id}`)).json();
	assert.equal(saved.current, first.created);
	assert.equal(saved.records[previous.id].status, "superseded");
	assert.ok(saved.records[previous.id].updatedAt > previous.updatedAt);
	assert.deepEqual(saved.records[previous.id].usage, previous.usage);
	assert.equal(saved.records[first.created].goal, body.goal);
	assert.equal(saved.records[first.created].creator, "tg:700");
	assert.equal(saved.records[first.created].status, "active");
	const journal = await harness.snapshot(NewGoalDoc, conversation.id, context);
	assert.equal(journal?.requests[body.requestId].operator, "tg:700");
	const entries = await harness.commit((tx) => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 100), context);
	assert.ok(entries.items.some((entry) => entry.kind === "chat.fixture"));
	const transition = entries.items.find((entry) => entry.id === first.entryId);
	assert.equal(transition?.kind, "work.new_goal");
	assert.deepEqual(transition?.data, { sender: "tg:700", workId: previous.id, requestId: body.requestId });

	const later = workRecord("later-work");
	await harness.commit(async (tx) => {
		const doc = await tx.doc(WorkDoc, conversation.id);
		doc.current = later.id;
		doc.records[later.id] = later;
	}, context);
	const duplicate = await post({ ...body, operator: "another-untrusted-body" });
	assert.equal(duplicate.status, 200);
	assert.deepEqual(await duplicate.json(), first);
	assert.equal((await post({ ...body, requestId: "stale-new-request" })).status, 409);
	assert.equal((await harness.snapshot(WorkDoc, conversation.id, context))?.current, later.id);
	const records = (await harness.snapshot(WorkDoc, conversation.id, context))?.records ?? {};
	assert.deepEqual(Object.keys(records).sort(), [previous.id, first.created as string, "later-work"].sort());
	assert.equal(records[previous.id].status, "superseded");
	assert.equal(records[first.created as string].status, "active");
	assert.equal(records["later-work"].status, "active");
	assert.equal((await harness.commit((tx) => tx.scanEntries({ conversationId: conversation.id }, 100), context)).items.filter((entry) => entry.kind === "work.new_goal").length, 1);
});

test("goal command recognition preserves Telegram addressing and takes priority over attachments", () => {
	for (const content of ["/goal", "/goal extra"]) assert.equal(messageAction(content, true), "command");
	assert.equal(messageAction("/goal-file", false), "input");
	const update = message(1, "/goal@AcceptanceBot", { chat: { id: -300, type: "supergroup" }, message_thread_id: 9, document: { file_id: "must-not-download", file_name: "old.txt" } });
	const normalized = normalizeTelegramUpdate(update as TelegramUpdate, { id: "100", username: "AcceptanceBot" });
	assert.ok(normalized);
	assert.equal(normalized.content, "/goal");
	assert.equal(messageAction(normalized.content, normalized.resources.length > 0), "command");
	assert.equal(normalizeTelegramUpdate(message(2, "/goal@AnotherBot", { chat: { id: -300, type: "supergroup" } }) as TelegramUpdate, { id: "100", username: "AcceptanceBot" }), null);
});

test("goal Telegram receipts retain the original work target, including no current work, after reopen", winSqlite, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-goal-receipt-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const open = () => openNodeSqliteStorage(join(directory, "dwell.sqlite")).then((storage) => Harness.open(storage, { models: createModels(), registry: createRegistry() }, context));
	let harness = await open();
	t.after(() => harness.close(context));
	let inbox = new TelegramInbox(harness);
	const original = await inbox.beginCommand("has-work", { conversationId: 42, command: "/goal", goalWorkId: "original-work" });
	const empty = await inbox.beginCommand("no-work", { conversationId: 42, command: "/goal", goalWorkId: null });
	await harness.close(context);
	harness = await open();
	inbox = new TelegramInbox(harness);
	assert.deepEqual(await inbox.beginCommand("has-work", { conversationId: 99, command: "/new", goalWorkId: "later-work" }), original);
	assert.deepEqual(await inbox.beginCommand("no-work", { conversationId: 42, command: "/goal", goalWorkId: "later-work" }), empty);
	await inbox.finishCommand("has-work");
	assert.deepEqual(await inbox.beginCommand("has-work", { conversationId: 42, command: "/goal", goalWorkId: "latest-work" }), { ...original, done: true });
});

async function stoppedState(directory: string, id: number) {
	const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "data", "dwell.sqlite")), { models: createModels(), registry: createRegistry() }, context);
	try {
		const conversationId = id as ConversationId;
		return {
			work: await getWork(harness, id),
			budget: await harness.snapshot(BudgetDoc, conversationId, context),
			journal: await harness.snapshot(NewGoalDoc, conversationId, context),
			entries: (await harness.commit((tx) => tx.scanEntries({ conversationId, order: "ascending" }, 1000), context)).items,
		};
	} finally { await harness.close(context); }
}

/** /goal 解绑只改写 status 与 updatedAt；其余字段（含用量与预算）原样保留。 */
function assertWorkPreserved(actual: WorkRecord, expected: WorkRecord): void {
	const { members: actualCursors, status: _actualStatus, updatedAt: _actualUpdatedAt, ...actualWork } = actual;
	const { members: expectedCursors, status: _expectedStatus, updatedAt: _expectedUpdatedAt, ...expectedWork } = expected;
	assert.deepEqual(actualWork, expectedWork);
	assert.deepEqual(Object.keys(actualCursors), Object.keys(expectedCursors));
	for (const [member, position] of Object.entries(expectedCursors)) assert.ok(actualCursors[member] >= position);
}

test("main Telegram /goal enforces owner and admin authority, establishes and supersedes records without extra model calls", { ...posixOnly, timeout: 90_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "Original goal saved." }]);
	const topic = (id: number, text: string, actor = 200) => message(id, text, { chat: { id: -300, type: "supergroup" }, message_thread_id: 9, from: { id: actor, first_name: "Member" } });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([topic(299, "/goal@AcceptanceBot")]);
		await f.until((event) => event.method === "sendMessage" && event.body.text === "用法：/goal <目标描述>。命令直接建立目标并开始执行，完成后在此报告结果。");
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 300);
		f.updates([topic(300, "/goal@AcceptanceBot Sneaky goal", 201)]);
		await f.until((event) => event.method === "sendMessage" && event.body.text === "这是他人的任务线，仅线主或管理员可开启新目标。");
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 301);
		f.updates([topic(301, "/goal@AcceptanceBot Original goal")]);
		await f.until((event) => event.method === "sendMessage" && event.body.text === "目标已建立，开始执行…");
		await f.until((event) => event.method === "editMessageText" && String(event.body.text).startsWith("Original goal saved."));
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-goal:tg-update:100:301" && event.body.state === "done");
		await f.stop();
		const conversationId = (await f.snapshot()).inbox.inputs["tg-goal:tg-update:100:301"].conversationId;
		const before = await stoppedState(f.directory, conversationId);
		const firstId = before.work.current;
		assert.ok(firstId);
		assert.equal(before.work.records[firstId].goal, "Original goal");
		assert.equal(before.work.records[firstId].creator, "tg:200");
		assert.equal(before.work.records[firstId].status, "active");
		assert.equal(before.journal?.requests["command:tg-update:100:301"].workId, null);
		assert.equal(before.journal?.requests["command:tg-update:100:301"].created, firstId);
		assert.equal(before.journal?.requests["command:tg-update:100:301"].operator, "tg:200");
		assert.equal(before.journal?.requests["command:tg-update:100:299"], undefined);
		assert.equal(before.journal?.requests["command:tg-update:100:300"], undefined);
		assert.equal(f.requests("model").length, 1);
		const ownerReceipt = (await f.snapshot()).inbox.commands["tg-update:100:301"] as { goalWorkId: string | null; done: boolean };
		assert.equal(ownerReceipt.goalWorkId, null);
		assert.equal(ownerReceipt.done, true);

		await writeFile(join(f.directory, "state", "users.json"), JSON.stringify({ members: ["tg:200", "tg:201"], admins: ["tg:201"] }));
		const laterStart = f.events.length;
		f.start([{ text: "Later goal saved." }]);
		await f.until((event) => event.method === "getUpdates", laterStart);
		f.updates([topic(302, "/goal@AcceptanceBot Later goal", 201)]);
		await f.until((event) => event.method === "sendMessage" && event.body.text === "已解绑旧目标，新目标已建立，开始执行…", laterStart);
		await f.until((event) => event.method === "editMessageText" && String(event.body.text).startsWith("Later goal saved."), laterStart);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-goal:tg-update:100:302" && event.body.state === "done", laterStart);
		await f.stop();
		const detached = await stoppedState(f.directory, conversationId);
		const secondId = detached.work.current;
		assert.ok(secondId);
		assert.notEqual(secondId, firstId);
		assert.equal(detached.work.records[secondId].goal, "Later goal");
		assert.equal(detached.work.records[secondId].status, "active");
		assert.equal(detached.work.records[firstId].status, "superseded");
		assert.ok(detached.work.records[firstId].updatedAt > before.work.records[firstId].updatedAt);
		assertWorkPreserved(detached.work.records[firstId], before.work.records[firstId]);
		// 解绑不碰预算，但新目标起跑会新增一条按输入键控的 run 预算记录并成为 current；旧记录原样保留
		const priorBudgets = before.budget?.records ?? {};
		for (const [key, record] of Object.entries(priorBudgets)) assert.deepEqual(detached.budget?.records[key], record);
		assert.equal(Object.keys(detached.budget?.records ?? {}).length, Object.keys(priorBudgets).length + 1);
		assert.notEqual(detached.budget?.current, before.budget?.current);
		for (const entry of before.entries) assert.deepEqual(detached.entries.find((candidate) => candidate.id === entry.id), entry);
		assert.equal(detached.journal?.requests["command:tg-update:100:302"].operator, "tg:201");
		assert.equal(detached.journal?.requests["command:tg-update:100:302"].workId, firstId);
		assert.equal(detached.journal?.requests["command:tg-update:100:302"].created, secondId);
		assert.equal(detached.entries.filter((entry) => entry.kind === "work.new_goal").length, 1);
		assert.equal(f.requests("model").length, 2, "each goal run admits exactly one generation");

		// Rewind only the isolated transport cursor to redeliver a completed old control request.
		await writeFile(join(f.directory, "state", "telegram", "100.json"), JSON.stringify({ botId: "100", offset: 302 }));
		const replayStart = f.events.length;
		f.start();
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 302, replayStart);
		f.updates([topic(302, "/goal@AcceptanceBot Later goal", 201)]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 303, replayStart);
		assert.equal(f.requests("telegram", "sendMessage").filter((event) => event.generation === f.generation).length, 0, "A completed old command must not announce or detach the later goal");
		f.updates([topic(303, "/goal@AcceptanceBot", 201)]);
		await f.until((event) => event.method === "sendMessage" && event.body.text === "用法：/goal <目标描述>。命令直接建立目标并开始执行，完成后在此报告结果。", replayStart);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 304, replayStart);
		await f.stop();
		const final = await stoppedState(f.directory, conversationId);
		assert.equal(final.work.current, secondId);
		assert.deepEqual(Object.keys(final.work.records), Object.keys(detached.work.records));
		for (const [id, record] of Object.entries(detached.work.records)) assertWorkPreserved(final.work.records[id], record);
		assert.deepEqual(final.budget, detached.budget);
		const requests = final.journal?.requests ?? {};
		assert.deepEqual(Object.keys(requests).sort(), ["command:tg-update:100:301", "command:tg-update:100:302"]);
		assert.equal(requests["command:tg-update:100:303"], undefined);
		assert.equal(final.entries.filter((entry) => entry.kind === "work.new_goal").length, 1);
		for (const entry of detached.entries) assert.deepEqual(final.entries.find((candidate) => candidate.id === entry.id), entry);
		assert.equal(f.requests("model").length, 2, "Control commands must not admit a model generation");
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

test("main Telegram /goal with an objective establishes the work record directly", { ...posixOnly, timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [{ text: "Record established." }]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(320, "/goal@AcceptanceBot Direct objective from the command")]);
		await f.until((event) => event.method === "sendMessage" && event.body.text === "目标已建立，开始执行…");
		await f.until((event) => event.method === "editMessageText" && String(event.body.text).startsWith("Record established."));
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-goal:tg-update:100:320" && event.body.state === "done");
		await f.stop();
		const snapshot = await f.snapshot();
		const conversationId = snapshot.inbox.inputs["tg-goal:tg-update:100:320"].conversationId;
		const work = (await stoppedState(f.directory, conversationId)).work;
		assert.ok(work.current);
		assert.equal(work.records[work.current].goal, "Direct objective from the command");
		assert.equal(work.records[work.current].creator, "tg:200");
		passed = true;
	} finally { await f.close(passed); }
});
