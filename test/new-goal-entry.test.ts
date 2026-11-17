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
import { mainFixture, message } from "./telegram-main-fixture.ts";

function workRecord(id: string): WorkRecord {
	return {
		id, creator: "tg:300", goal: "Keep the previous report", acceptance: ["The old report remains available"],
		progress: "Waiting for feedback", blockers: ["A reviewer has not replied"], evidence: [], review: "", status: "active", createdAt: 1, updatedAt: 2,
		limits: { modelAdmissions: 7, toolAdmissions: 11 }, stopped: "model_limit", availableEvidence: {}, members: {}, tasks: {},
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

test("new-goal panel requests require admitted JSON and use the configured operator across replay", async (t) => {
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
	const body = { id: conversation.id, workId: previous.id, requestId: "panel-original", operator: "untrusted-body" };
	const post = (value: unknown, headers: Record<string, string> = { "content-type": "application/json", origin: base }) => fetch(`${base}/api/work/newgoal`, { method: "POST", headers, body: JSON.stringify(value) });
	assert.equal((await post(body, { "content-type": "text/plain", origin: base })).status, 415);
	assert.equal((await post(body, { "content-type": "application/json", origin: "https://untrusted.example" })).status, 403);
	for (const invalid of [
		{ ...body, id: "invalid" }, { ...body, workId: undefined }, { ...body, workId: "" },
		{ ...body, requestId: " " }, { ...body, requestId: "x".repeat(201) },
	]) assert.equal((await post(invalid)).status, 400);
	assert.equal((await post({ ...body, id: 999999 })).status, 404);
	assert.equal((await harness.snapshot(WorkDoc, conversation.id, context))?.current, previous.id);
	assert.equal(await harness.snapshot(NewGoalDoc, conversation.id, context), undefined);

	const response = await post(body);
	assert.equal(response.status, 200);
	const first = await response.json();
	assert.equal(first.changed, true);
	assert.equal(first.workId, previous.id);
	const saved = await (await fetch(`${base}/api/work?id=${conversation.id}`)).json();
	assert.equal(saved.current, undefined);
	assert.deepEqual(saved.records[previous.id], previous);
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
	assert.deepEqual((await harness.snapshot(WorkDoc, conversation.id, context))?.records, { [previous.id]: previous, [later.id]: later });
	assert.equal((await harness.commit((tx) => tx.scanEntries({ conversationId: conversation.id }, 100), context)).items.filter((entry) => entry.kind === "work.new_goal").length, 1);
});

test("new-goal command recognition preserves Telegram addressing and takes priority over attachments", () => {
	for (const content of ["/newgoal", "/newgoal extra"]) assert.equal(messageAction(content, true), "command");
	assert.equal(messageAction("/newgoal-file", false), "input");
	const update = message(1, "/newgoal@AcceptanceBot", { chat: { id: -300, type: "supergroup" }, message_thread_id: 9, document: { file_id: "must-not-download", file_name: "old.txt" } });
	const normalized = normalizeTelegramUpdate(update as TelegramUpdate, { id: "100", username: "AcceptanceBot" });
	assert.ok(normalized);
	assert.equal(normalized.content, "/newgoal");
	assert.equal(messageAction(normalized.content, normalized.resources.length > 0), "command");
	assert.equal(normalizeTelegramUpdate(message(2, "/newgoal@AnotherBot", { chat: { id: -300, type: "supergroup" } }) as TelegramUpdate, { id: "100", username: "AcceptanceBot" }), null);
});

test("new-goal Telegram receipts retain the original work target, including no current work, after reopen", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-new-goal-receipt-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const open = () => openNodeSqliteStorage(join(directory, "dwell.sqlite")).then((storage) => Harness.open(storage, { models: createModels(), registry: createRegistry() }, context));
	let harness = await open();
	t.after(() => harness.close(context));
	let inbox = new TelegramInbox(harness);
	const original = await inbox.beginCommand("has-work", { conversationId: 42, command: "/newgoal", newGoalWorkId: "original-work" });
	const empty = await inbox.beginCommand("no-work", { conversationId: 42, command: "/newgoal", newGoalWorkId: null });
	await harness.close(context);
	harness = await open();
	inbox = new TelegramInbox(harness);
	assert.deepEqual(await inbox.beginCommand("has-work", { conversationId: 99, command: "/new", newGoalWorkId: "later-work" }), original);
	assert.deepEqual(await inbox.beginCommand("no-work", { conversationId: 42, command: "/newgoal", newGoalWorkId: "later-work" }), empty);
	await inbox.finishCommand("has-work");
	assert.deepEqual(await inbox.beginCommand("has-work", { conversationId: 42, command: "/newgoal", newGoalWorkId: "latest-work" }), { ...original, done: true });
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

function assertWorkPreserved(actual: WorkRecord, expected: WorkRecord): void {
	const { members: actualCursors, ...actualWork } = actual;
	const { members: expectedCursors, ...expectedWork } = expected;
	assert.deepEqual(actualWork, expectedWork);
	assert.deepEqual(Object.keys(actualCursors), Object.keys(expectedCursors));
	for (const [member, position] of Object.entries(expectedCursors)) assert.ok(actualCursors[member] >= position);
}

test("main Telegram new-goal enforces owner and admin authority without model calls or history reset", { timeout: 90_000 }, async (t) => {
	const start = (goal: string) => ({ tool: "dwell.work", arguments: { action: "start", goal, acceptance: ["The old goal remains inspectable"] } });
	const f = await mainFixture(t, [start("Original goal"), { text: "Original goal saved." }]);
	const topic = (id: number, text: string, actor = 200) => message(id, text, { chat: { id: -300, type: "supergroup" }, message_thread_id: 9, from: { id: actor, first_name: "Member" } });
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([topic(300, "/ask@AcceptanceBot Keep an explicit old goal.")]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:300" && event.body.state === "done");
		await f.stop();
		const conversationId = (await f.snapshot()).inbox.inputs["tg-update:100:300"].conversationId;
		const before = await stoppedState(f.directory, conversationId);
		const oldId = before.work.current;
		assert.ok(oldId);
		assert.equal(before.work.records[oldId].goal, "Original goal");
		const afterStart = f.events.length;
		f.start();
		await f.until((event) => event.method === "getUpdates", afterStart);
		f.updates([topic(301, "/newgoal@AcceptanceBot", 201)]);
		await f.until((event) => event.method === "sendMessage" && event.body.text === "这是他人的任务线，仅线主或管理员可开启新目标。", afterStart);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 302, afterStart);
		f.updates([topic(302, "/newgoal@AcceptanceBot")]);
		await f.until((event) => event.method === "sendMessage" && event.body.text === "已开启新目标。聊天历史、旧任务记录和预算保留，请发送新的目标。", afterStart);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 303, afterStart);
		await f.stop();
		const detached = await stoppedState(f.directory, conversationId);
		assert.equal(detached.work.current, undefined);
		assertWorkPreserved(detached.work.records[oldId], before.work.records[oldId]);
		assert.deepEqual(detached.budget, before.budget);
		for (const entry of before.entries) assert.deepEqual(detached.entries.find((candidate) => candidate.id === entry.id), entry);
		assert.equal(detached.journal?.requests["command:tg-update:100:302"].operator, "tg:200");
		assert.equal(detached.journal?.requests["command:tg-update:100:301"], undefined);
		const ownerReceipt = (await f.snapshot()).inbox.commands["tg-update:100:302"] as { newGoalWorkId: string; done: boolean };
		assert.equal(ownerReceipt.newGoalWorkId, oldId);
		assert.equal(ownerReceipt.done, true);
		assert.equal(f.requests("model").length, 2);

		await writeFile(join(f.directory, "state", "users.json"), JSON.stringify({ members: ["tg:200", "tg:201"], admins: ["tg:201"] }));
		const laterStart = f.events.length;
		f.start([start("Later goal"), { text: "Later goal saved." }]);
		await f.until((event) => event.method === "getUpdates", laterStart);
		f.updates([topic(303, "/ask@AcceptanceBot Establish the later goal.")]);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:303" && event.body.state === "done", laterStart);
		await f.stop();
		const later = await stoppedState(f.directory, conversationId);
		assert.ok(later.work.current);
		assert.notEqual(later.work.current, oldId);
		assert.equal(later.work.records[later.work.current].goal, "Later goal");

		// Rewind only the isolated transport cursor to redeliver a completed old control request.
		await writeFile(join(f.directory, "state", "telegram", "100.json"), JSON.stringify({ botId: "100", offset: 302 }));
		const replayStart = f.events.length;
		f.start();
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 302, replayStart);
		f.updates([topic(302, "/newgoal@AcceptanceBot")]);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 303, replayStart);
		assert.equal(f.requests("telegram", "sendMessage").filter((event) => event.generation === f.generation).length, 0, "A completed old command must not announce or detach the later goal");
		f.updates([topic(304, "/newgoal@AcceptanceBot", 201)]);
		await f.until((event) => event.method === "sendMessage" && event.body.text === "已开启新目标。聊天历史、旧任务记录和预算保留，请发送新的目标。", replayStart);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 305, replayStart);
		f.updates([topic(305, "/newgoal@AcceptanceBot", 201)]);
		await f.until((event) => event.method === "sendMessage" && event.body.text === "当前没有工作目标，请直接发送新的目标。", replayStart);
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 306, replayStart);
		await f.stop();
		const final = await stoppedState(f.directory, conversationId);
		assert.equal(final.work.current, undefined);
		assert.deepEqual(Object.keys(final.work.records), Object.keys(later.work.records));
		for (const [id, record] of Object.entries(later.work.records)) assertWorkPreserved(final.work.records[id], record);
		assert.deepEqual(final.budget, later.budget);
		assert.equal(final.journal?.requests["command:tg-update:100:304"].workId, later.work.current);
		assert.equal(final.journal?.requests["command:tg-update:100:304"].operator, "tg:201");
		const requests = final.journal?.requests ?? {};
		assert.deepEqual(Object.keys(requests).sort(), ["command:tg-update:100:302", "command:tg-update:100:304", "command:tg-update:100:305"]);
		assert.deepEqual(requests["command:tg-update:100:302"], detached.journal?.requests["command:tg-update:100:302"]);
		assert.equal(Object.values(requests).filter((request) => request.workId !== null).length, 2);
		assert.equal(Object.values(requests).filter((request) => request.workId === null).length, 1);
		assert.equal(requests["command:tg-update:100:305"].workId, null);
		assert.equal(requests["command:tg-update:100:305"].operator, "tg:201");
		assert.equal(requests["command:tg-update:100:305"].entryId, undefined);
		assert.equal(final.entries.filter((entry) => entry.kind === "work.new_goal").length, 2);
		for (const entry of later.entries) assert.deepEqual(final.entries.find((candidate) => candidate.id === entry.id), entry);
		assert.equal(f.requests("model").length, 4, "Control commands must not admit a model generation");
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});
