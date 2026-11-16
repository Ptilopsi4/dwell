import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MODEL } from "../src/harness.ts";
import { messageDestination, sameDestination, type NormalizedMessage, type TelegramDestination } from "../src/pipeline.ts";
import { Sessions, TelegramSessionDoc } from "../src/sessions.ts";

const message = (changes: Partial<NormalizedMessage> = {}): NormalizedMessage => {
	const destination: TelegramDestination = { kind: "telegram", botId: "100", chatId: "200" };
	const msg: NormalizedMessage = {
		platform: "telegram", destination,
		messageId: "tg:100:200:1", chatId: "tg:100:200", chatType: "p2p", senderId: "tg:300",
		content: "hello", rawContentType: "text", resources: [], mentions: [], mentionAll: false,
		mentionedBot: false, createTime: 0,
		...changes,
	};
	if (msg.destination?.kind === "telegram") {
		msg.chatId = `tg:${msg.destination.botId}:${msg.destination.chatId}`;
		msg.threadId = msg.destination.threadId;
		msg.messageId = `${msg.chatId}:1`;
	}
	return msg;
};

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "dwell-telegram-routing-"));
	const prepared: string[] = [];
	const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }] });
	faux.setResponses([fauxAssistantMessage("local faux reply")]);
	const models = createModels();
	models.setProvider(faux.provider);
	let active: Harness;
	const sessionsFor = (harness: Harness, prepare = async (cwd: string) => { prepared.push(cwd); }) => {
		const sessions = new Sessions(harness, prepare);
		Object.assign(sessions, { file: join(directory, "sessions.json"), mapFile: join(directory, "message-map.json") });
		return sessions;
	};
	const open = async () => {
		active = await Harness.open(await openNodeSqliteStorage(join(directory, "dwell.sqlite")), { models, registry: createRegistry() }, context);
		active.resume();
		return active;
	};
	await open();
	return {
		directory, prepared, faux, sessionsFor,
		get harness() { return active; },
		async reopen() { await active.close(context); return open(); },
		async count() { return (await active.commit((tx) => tx.scanConversations({}, 100), context)).items.length; },
		async close() { await active.close(context); await rm(directory, { recursive: true, force: true }); },
	};
}

test("legacy routes keep their keys, owners and Feishu-only chat lookup", async () => {
	const t = await setup();
	try {
		const feishu = await t.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL } }, context);
		const panel = await t.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL } }, context);
		const saved = { "oc_chat#ou_user": { id: feishu.id, owner: "ou_user", name: "legacy", emoji: "🔵" }, "panel:local#1": { id: panel.id, owner: "panel" } };
		await writeFile(join(t.directory, "sessions.json"), JSON.stringify(saved));
		const sessions = t.sessionsFor(t.harness);
		await sessions.load();
		assert.equal((await sessions.forGroup("oc_chat", "ou_user")).id, feishu.id);
		assert.deepEqual(sessions.destinationOf(feishu.id), { kind: "feishu", chatId: "oc_chat" });
		assert.deepEqual(sessions.destinationOf(panel.id), { kind: "panel" });
		assert.equal(sessions.chatOf(feishu.id), "oc_chat");
		assert.equal(sessions.chatOf(panel.id), undefined);
		assert.equal(sessions.ownerOf(feishu.id), "ou_user");
		const rows = sessions.listConversations();
		assert.deepEqual(rows.map(({ key, platform, type }) => ({ key, platform, type })), [
			{ key: "oc_chat#ou_user", platform: "feishu", type: "group" },
			{ key: "panel:local#1", platform: "panel", type: "panel" },
		]);
		await sessions.forTelegram(message());
		const projected = JSON.parse(await readFile(join(t.directory, "sessions.json"), "utf8"));
		assert.equal(projected["oc_chat#ou_user"].owner, "ou_user");
		assert.equal(projected["oc_chat#ou_user"].emoji, "🔵");
		assert.equal(projected["oc_chat#ou_user"].name, "legacy");
	} finally { await t.close(); }
});

test("Telegram private, sender and topic defaults isolate bot/chat while sharing group workspaces", async () => {
	const t = await setup();
	try {
		const sessions = t.sessionsFor(t.harness);
		const direct = await sessions.forTelegram(message());
		assert.equal((await sessions.forTelegram(message({ senderId: "tg:301" }))).id, direct.id);
		assert.equal(sessions.ownerOf(direct.id), "tg:300");
		const group = message({ chatType: "group", destination: { kind: "telegram", botId: "100", chatId: "-200" } });
		const a = await sessions.forTelegram(group);
		const b = await sessions.forTelegram({ ...group, senderId: "tg:301" });
		assert.notEqual(a.id, b.id);
		const firstTopic = message({ chatType: "group", destination: { kind: "telegram", botId: "100", chatId: "-200", threadId: "9" } });
		const topic = await sessions.forTelegram(firstTopic);
		assert.equal((await sessions.forTelegram({ ...firstTopic, senderId: "tg:301" })).id, topic.id);
		const secondTopic = await sessions.forTelegram(message({ chatType: "group", destination: { kind: "telegram", botId: "100", chatId: "-200", threadId: "10" } }));
		const otherBot = await sessions.forTelegram(message({ chatType: "group", destination: { kind: "telegram", botId: "101", chatId: "-200", threadId: "9" } }));
		const otherChat = await sessions.forTelegram(message({ chatType: "group", destination: { kind: "telegram", botId: "100", chatId: "-201", threadId: "9" } }));
		assert.equal(new Set([direct.id, a.id, b.id, topic.id, secondTopic.id, otherBot.id, otherChat.id]).size, 7);
		const cwd = (await a.agent(context)).cwd!;
		assert.ok(isAbsolute(cwd));
		assert.match(basename(cwd), /^telegram-[a-f0-9]{64}$/);
		assert.equal((await b.agent(context)).cwd, cwd);
		assert.equal((await topic.agent(context)).cwd, cwd);
		assert.equal((await secondTopic.agent(context)).cwd, cwd);
		assert.notEqual((await otherBot.agent(context)).cwd, cwd);
		assert.notEqual((await otherChat.agent(context)).cwd, cwd);
		assert.equal(sessions.chatOf(topic.id), undefined);
		assert.equal(sessions.listConversations().find((row) => row.id === topic.id)?.platform, "telegram");
		assert.equal(sessions.listConversations().find((row) => row.id === topic.id)?.chatId, "tg:100:-200");
		await sessions.anchor(firstTopic.messageId, topic.id);
		const followWithin = (msg: NormalizedMessage) => {
			const id = sessions.follow(firstTopic.messageId);
			return id !== undefined && sameDestination(sessions.destinationOf(id), messageDestination(msg)) ? id : undefined;
		};
		assert.equal(followWithin(firstTopic), topic.id);
		for (const destination of [
			{ kind: "telegram" as const, botId: "101", chatId: "-200", threadId: "9" },
			{ kind: "telegram" as const, botId: "100", chatId: "-201", threadId: "9" },
			{ kind: "telegram" as const, botId: "100", chatId: "-200", threadId: "10" },
			{ kind: "telegram" as const, botId: "100", chatId: "-200" },
		]) assert.equal(followWithin(message({ destination, chatType: "group" })), undefined);
		const result = await (await direct.submit({ type: "input", content: "hello", requestId: "local-only" }, context)).wait(context);
		assert.equal(result.status, "done");
		assert.equal(t.faux.state.callCount, 1);
	} finally { await t.close(); }
});

test("/new receipts survive restart and replay without duplicate conversations or route regression", async () => {
	const t = await setup();
	try {
		let sessions = t.sessionsFor(t.harness);
		const msg = message();
		const original = await sessions.forTelegram(msg);
		const [first, duplicate] = await Promise.all([sessions.forTelegram(msg, "tg:100:update:1"), sessions.forTelegram(msg, "tg:100:update:1")]);
		assert.equal(first.id, duplicate.id);
		assert.notEqual(first.id, original.id);
		assert.equal(await t.count(), 2);
		const second = await sessions.forTelegram(msg, "tg:100:update:2");
		assert.notEqual(second.id, first.id);
		assert.equal((await sessions.forTelegram(msg, "tg:100:update:1")).id, first.id);
		assert.equal((await sessions.forTelegram(msg)).id, second.id);
		await t.reopen();
		sessions = t.sessionsFor(t.harness);
		await sessions.load();
		assert.equal((await sessions.forTelegram(msg, "tg:100:update:1")).id, first.id);
		assert.equal((await sessions.forTelegram(msg)).id, second.id);
		assert.equal(await t.count(), 3);
		for (const conversation of [original, first, second]) assert.deepEqual(sessions.destinationOf(conversation.id), messageDestination(msg));
		await assert.rejects(sessions.forTelegram(message({ destination: { kind: "telegram", botId: "101", chatId: "200" } }), "tg:100:update:1"), /different route/);
		assert.equal(await t.count(), 3);
	} finally { await t.close(); }
});

test("a failed JSON projection recovers the committed /new target and canonical destination", async () => {
	const t = await setup();
	try {
		let sessions = t.sessionsFor(t.harness);
		const msg = message({ chatType: "group", destination: { kind: "telegram", botId: "100", chatId: "-200", threadId: "9" } });
		const original = await sessions.forTelegram(msg);
		await mkdir(join(t.directory, "sessions.json.tmp"));
		await assert.rejects(sessions.forTelegram(msg, "tg:100:update:crash"), { code: "EISDIR" });
		const durable = await t.harness.snapshot(TelegramSessionDoc, context);
		const committedId = durable!.resets["telegram:tg:100:update:crash"].id;
		assert.notEqual(committedId, original.id);
		assert.equal(await t.count(), 2);
		const stale = JSON.parse(await readFile(join(t.directory, "sessions.json"), "utf8"));
		assert.equal(stale["tg:100:-200#t:9"].id, original.id);
		stale["tg:100:-200#t:9"].destination = { kind: "panel" };
		await writeFile(join(t.directory, "sessions.json"), JSON.stringify(stale));
		await rm(join(t.directory, "sessions.json.tmp"), { recursive: true });
		await t.reopen();
		sessions = t.sessionsFor(t.harness);
		await sessions.load();
		assert.equal((await sessions.forTelegram(msg)).id, committedId);
		assert.equal((await sessions.forTelegram(msg, "tg:100:update:crash")).id, committedId);
		assert.deepEqual(sessions.destinationOf(committedId), messageDestination(msg));
		assert.deepEqual(sessions.destinationOf(original.id), messageDestination(msg));
		assert.equal(await t.count(), 2);
		assert.deepEqual(JSON.parse(await readFile(join(t.directory, "sessions.json"), "utf8"))["tg:100:-200#t:9"].destination, msg.destination);
	} finally { await t.close(); }
});

test("workspace preparation failure and mismatched destinations create no conversation", async () => {
	const t = await setup();
	try {
		const sessions = t.sessionsFor(t.harness, async () => { throw new Error("workspace unavailable"); });
		await assert.rejects(sessions.forTelegram(message()), /workspace unavailable/);
		assert.equal(await t.count(), 0);
		const ready = t.sessionsFor(t.harness);
		await assert.rejects(ready.forTelegram({ ...message(), destination: undefined }), /explicit destination/);
		await assert.rejects(ready.forTelegram({ ...message(), threadId: "8" }), /does not match/);
		assert.equal(await t.count(), 0);
		await ready.forTelegram(message());
		assert.equal(await t.count(), 1);
	} finally { await t.close(); }
});
