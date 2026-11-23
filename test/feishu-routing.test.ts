import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, ToolResultEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { NormalizedMessage } from "../src/pipeline.ts";

const root = await mkdtemp(join(tmpdir(), "dwell-feishu-routing-"));
process.env.DWELL_DATA = join(root, "data");
process.env.DWELL_STATE = join(root, "state");
delete process.env.DWELL_MODELS_FILE;
process.env.DWELL_PROVIDER = "deepseek";
process.env.DWELL_MODEL = "deepseek-chat";
const { MODEL } = await import("../src/harness.ts");
const { WorkDoc } = await import("../src/ext/work.ts");
const { Sessions, TelegramSessionDoc } = await import("../src/sessions.ts");
const { getWork, makeWorkController } = await import("../src/ext/work.ts");
const { beginNewGoal } = await import("../src/new-goal.ts");
after(() => rm(root, { recursive: true, force: true }));

function message(kind: "direct" | "group" | "thread", changes: Partial<NormalizedMessage> = {}): NormalizedMessage {
	return { platform: "feishu", destination: { kind: "feishu", chatId: "oc_shared" }, chatId: "oc_shared", chatType: kind === "direct" ? "p2p" : "group",
		...(kind === "thread" ? { threadId: "topic-9" } : {}), messageId: "om_original", requestId: "om_original", senderId: "ou_owner", content: "/new", rawContentType: "text", resources: [], mentions: [], mentionAll: false, mentionedBot: true, createTime: 0, ...changes };
}

async function setup(options: { work?: boolean; prepare?: (cwd: string) => Promise<void> } = {}) {
	const directory = await mkdtemp(join(root, "case-"));
	const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 100_000 });
	const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry();
	const work = options.work ? makeWorkController() : undefined;
	if (work !== undefined) registry.install(work.extension);
	let harness: Harness;
	const sessionsFor = () => {
		const sessions = new Sessions(harness, options.prepare ?? (async () => {}));
		Object.assign(sessions, { file: join(directory, "sessions.json"), mapFile: join(directory, "message-map.json") });
		return sessions;
	};
	const open = async () => {
		harness = await Harness.open(await openNodeSqliteStorage(join(directory, "dwell.sqlite")), { models, registry }, context);
		await work?.attach(harness);
		harness.resume();
	};
	await open();
	return { directory, faux, sessionsFor,
		get harness() { return harness; },
		async count() { return (await harness.commit((tx) => tx.scanConversations({}, 100), context)).items.length; },
		async reopen() { await work?.close(); await harness.close(context); await open(); },
		async close() { await work?.close(); await harness.close(context); await rm(directory, { recursive: true, force: true }); },
	};
}

for (const kind of ["direct", "group", "thread"] as const) test(`Feishu ${kind} /new keeps the old line and replays one durable default across restart`, async () => {
	const t = await setup();
	try {
		let sessions = t.sessionsFor();
		const msg = message(kind);
		const original = await sessions.forFeishu(msg);
		await sessions.anchor("om_old_reply", original.id);
		const [first, duplicate] = await Promise.all([sessions.forFeishu(msg, "om_new_1"), sessions.forFeishu(msg, "om_new_1")]);
		assert.equal(first.id, duplicate.id);
		assert.notEqual(first.id, original.id);
		const latest = await sessions.forFeishu(msg, "om_new_2");
		assert.equal((await sessions.forFeishu(msg, "om_new_1")).id, first.id);
		assert.equal((await sessions.forFeishu(msg)).id, latest.id);
		assert.equal(sessions.follow("om_old_reply"), original.id);
		for (const conversation of [original, first, latest]) {
			assert.equal(sessions.ownerOf(conversation.id), "ou_owner");
			assert.deepEqual(sessions.destinationOf(conversation.id), msg.destination);
			assert.equal((await conversation.agent(context)).cwd, (await original.agent(context)).cwd);
		}
		assert.equal(await t.count(), 3);
		await t.reopen();
		sessions = t.sessionsFor();
		await sessions.load();
		assert.equal((await sessions.forFeishu(msg)).id, latest.id);
		assert.equal((await sessions.forFeishu(msg, "om_new_1")).id, first.id);
		assert.equal(sessions.follow("om_old_reply"), original.id);
		assert.equal(await t.count(), 3);
		assert.equal(sessions.listConversations().filter((row) => row.type === kind).length, 3);
	} finally { await t.close(); }
});

test("Feishu /new adopts legacy JSON and recovers only managed keys after a failed projection", async () => {
	const t = await setup();
	try {
		let sessions = t.sessionsFor();
		const msg = message("group");
		const original = await sessions.forFeishu(msg);
		const independent = await sessions.forGroup("oc_independent", "ou_other");
		const telegram = { ...message("direct"), platform: "telegram" as const, destination: { kind: "telegram" as const, botId: "100", chatId: "200" }, chatId: "tg:100:200", messageId: "tg:100:200:1", senderId: "tg:200" };
		const telegramLine = await sessions.forTelegram(telegram);
		await sessions.anchor("om_old_reply", original.id);
		await mkdir(join(t.directory, "sessions.json.tmp"));
		await assert.rejects(sessions.forFeishu(msg, "om_committed_new"), { code: "EISDIR" });
		const durable = await t.harness.snapshot(TelegramSessionDoc, context);
		const committed = durable!.resets["feishu:om_committed_new"].id;
		assert.notEqual(committed, original.id);
		assert.equal(durable!.routes["oc_independent#ou_other"], undefined);
		const stale = JSON.parse(await readFile(join(t.directory, "sessions.json"), "utf8"));
		assert.equal(stale["oc_shared#ou_owner"].id, original.id);
		await writeFile(join(t.directory, "sessions.json"), JSON.stringify(stale));
		await rm(join(t.directory, "sessions.json.tmp"), { recursive: true });
		await t.reopen();
		sessions = t.sessionsFor();
		await sessions.load();
		assert.equal((await sessions.forFeishu(msg)).id, committed);
		assert.equal((await sessions.forFeishu(msg, "om_committed_new")).id, committed);
		assert.equal((await sessions.forGroup("oc_independent", "ou_other")).id, independent.id);
		assert.equal((await sessions.forTelegram(telegram)).id, telegramLine.id);
		assert.equal(sessions.follow("om_old_reply"), original.id);
		assert.equal(sessions.ownerOf(original.id), "ou_owner");
		assert.deepEqual(sessions.destinationOf(original.id), msg.destination);
		assert.equal(await t.count(), 4);
	} finally { await t.close(); }
});

test("Feishu /new waits for its pending create while other route keys remain available", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const t = await setup({ prepare: async (cwd) => { if (cwd.endsWith("oc_shared")) await gate; } });
	try {
		const sessions = t.sessionsFor();
		const msg = message("group");
		const initial = sessions.forGroup(msg.chatId, msg.senderId);
		const reset = sessions.forFeishu(msg, "om_concurrent_new");
		const laterLookup = sessions.forGroup(msg.chatId, msg.senderId);
		const independent = await sessions.forDirect("oc_independent", "ou_other");
		assert.equal(await t.count(), 1);
		release();
		const [old, fresh, later] = await Promise.all([initial, reset, laterLookup]);
		assert.notEqual(old.id, fresh.id);
		assert.equal(later.id, fresh.id);
		assert.equal((await sessions.forGroup(msg.chatId, msg.senderId)).id, fresh.id);
		const saved = JSON.parse(await readFile(join(t.directory, "sessions.json"), "utf8"));
		assert.equal(saved["oc_shared#ou_owner"].id, fresh.id);
		assert.equal(saved[`oc_shared#ou_owner#old:${old.id}`].id, old.id);
		assert.equal(saved.oc_independent.id, independent.id);
		assert.equal(await t.count(), 3);
	} finally { release(); await t.close(); }
});

test("bot reset receipt namespaces stay independent and historical Telegram receipts remain replayable", async () => {
	const t = await setup();
	try {
		const sessions = t.sessionsFor();
		const msg = message("direct");
		await sessions.forFeishu(msg);
		const telegram = { ...msg, platform: "telegram" as const, destination: { kind: "telegram" as const, botId: "100", chatId: "200" }, chatId: "tg:100:200", messageId: "tg:100:200:1", senderId: "tg:200" };
		await sessions.forTelegram(telegram);
		const feishuNew = await sessions.forFeishu(msg, "same-delivery-id");
		const telegramNew = await sessions.forTelegram(telegram, "same-delivery-id");
		assert.notEqual(feishuNew.id, telegramNew.id);
		await t.harness.commit(async (tx) => {
			const doc = await tx.doc(TelegramSessionDoc);
			assert.equal(doc.resets["feishu:same-delivery-id"].id, feishuNew.id);
			doc.resets["same-delivery-id"] = doc.resets["telegram:same-delivery-id"];
			delete doc.resets["telegram:same-delivery-id"];
		}, context);
		assert.equal((await sessions.forTelegram(telegram, "same-delivery-id")).id, telegramNew.id);
		assert.equal(await t.count(), 4);
	} finally { await t.close(); }
});

test("Feishu /new starts work after a real Harness has retained 64 goals without deleting the old records", { timeout: 60_000 }, async () => {
	const t = await setup({ work: true });
	try {
		const sessions = t.sessionsFor();
		const msg = message("direct");
		const original = await sessions.forFeishu(msg);
		let work = await getWork(t.harness, original.id);
		for (let index = 0; index < 64; index++) {
			await beginNewGoal(t.harness, { conversationId: original.id, expectedWorkId: work.current ?? null, operator: msg.senderId, requestId: `retained-goal-${index}`, goal: `Retained goal ${index}` });
			work = await getWork(t.harness, original.id);
			assert.ok(work.current);
		}
		await assert.rejects(beginNewGoal(t.harness, { conversationId: original.id, expectedWorkId: work.current ?? null, operator: msg.senderId, requestId: "retained-goal-64", goal: "Goal exceeding the old line limit" }), /64 条工作记录/);
		const exhausted = await getWork(t.harness, original.id);
		assert.equal(Object.keys(exhausted.records).length, 64);
		assert.ok(exhausted.current);
		const fresh = await sessions.forFeishu(msg, "om_work_limit_new");
		assert.notEqual(fresh.id, original.id);
		await beginNewGoal(t.harness, { conversationId: fresh.id, expectedWorkId: null, operator: msg.senderId, requestId: "fresh-goal", goal: "Fresh goal after new task line" });
		const renewed = await getWork(t.harness, fresh.id);
		assert.ok(renewed.current);
		assert.equal(Object.keys(renewed.records).length, 1);
		assert.equal(Object.keys((await getWork(t.harness, original.id)).records).length, 64);
	} finally { await t.close(); }
});
