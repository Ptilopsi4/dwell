import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MODEL } from "../src/harness.ts";
import { messageDestination, type NormalizedMessage, type TelegramDestination } from "../src/pipeline.ts";
import { Sessions, TelegramSessionDoc } from "../src/sessions.ts";

function message(changes: Partial<NormalizedMessage> = {}): NormalizedMessage {
	const destination: TelegramDestination = { kind: "telegram", botId: "100", chatId: "-200", threadId: "9" };
	const msg: NormalizedMessage = {
		platform: "telegram", destination,
		messageId: "tg:100:-200:1", chatId: "tg:100:-200", chatType: "group", senderId: "tg:300",
		content: "hello", rawContentType: "text", resources: [], mentions: [], mentionAll: false,
		mentionedBot: true, createTime: 0,
		...changes,
	};
	if (msg.destination?.kind === "telegram") {
		msg.chatId = `tg:${msg.destination.botId}:${msg.destination.chatId}`;
		msg.threadId = msg.destination.threadId;
		msg.messageId = `${msg.chatId}:1`;
	}
	return msg;
}

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "dwell-telegram-members-"));
	const models = createModels();
	models.setProvider(fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }] }).provider);
	let active: Harness;
	const sessionsFor = (harness: Harness) => {
		const sessions = new Sessions(harness, async () => {});
		Object.assign(sessions, { file: join(directory, "sessions.json"), mapFile: join(directory, "message-map.json") });
		return sessions;
	};
	const open = async () => {
		active = await Harness.open(await openNodeSqliteStorage(join(directory, "dwell.sqlite")), { models, registry: createRegistry() }, context);
		active.resume();
	};
	await open();
	return {
		directory, sessionsFor,
		get harness() { return active; },
		async reopen() { await active.close(context); await open(); },
		async count() { return (await active.commit((tx) => tx.scanConversations({}, 100), context)).items.length; },
		async close() { await active.close(context); await rm(directory, { recursive: true, force: true }); },
	};
}

test("member group routes isolate each bot, chat, topic and actor from legacy defaults and writable workspaces", async () => {
	const t = await setup();
	try {
		const sessions = t.sessionsFor(t.harness);
		const msg = message();
		const [first, same] = await Promise.all([sessions.forTelegram(msg, undefined, true), sessions.forTelegram(msg, undefined, true)]);
		assert.equal(first.id, same.id);
		assert.equal((await sessions.forTelegram(msg, undefined, true)).id, first.id);
		const members = [first];
		for (const changes of [
			{ senderId: "tg:301" },
			{ destination: { kind: "telegram" as const, botId: "100", chatId: "-200", threadId: "10" } },
			{ destination: { kind: "telegram" as const, botId: "101", chatId: "-200", threadId: "9" } },
			{ destination: { kind: "telegram" as const, botId: "100", chatId: "-201", threadId: "9" } },
			{ destination: { kind: "telegram" as const, botId: "100", chatId: "-200" } },
		]) {
			const input = message(changes);
			const conversation = await sessions.forTelegram(input, undefined, true);
			assert.deepEqual(sessions.destinationOf(conversation.id), messageDestination(input));
			assert.equal(sessions.ownerOf(conversation.id), input.senderId);
			members.push(conversation);
		}
		assert.equal(new Set(members.map(({ id }) => id)).size, members.length);
		assert.deepEqual(sessions.destinationOf(first.id), msg.destination);
		for (const member of members) assert.equal(sessions.isActorScoped(member.id), true);
		const workspaces = await Promise.all(members.map(async (conversation) => (await conversation.agent(context)).cwd));
		assert.ok(workspaces.every((cwd) => cwd !== undefined && isAbsolute(cwd)));
		assert.equal(new Set(workspaces).size, members.length);

		const legacyTopic = await sessions.forTelegram(msg);
		assert.equal((await sessions.forTelegram(message({ senderId: "tg:301" }))).id, legacyTopic.id);
		const plain = message({ destination: { kind: "telegram", botId: "100", chatId: "-200" } });
		const legacyPlain = await sessions.forTelegram(plain);
		const legacyOther = await sessions.forTelegram({ ...plain, senderId: "tg:301" });
		assert.notEqual(legacyPlain.id, legacyOther.id);
		for (const legacy of [legacyTopic, legacyPlain, legacyOther]) {
			assert.equal(sessions.isActorScoped(legacy.id), false);
			assert.ok(!members.some(({ id }) => id === legacy.id));
			assert.ok(!workspaces.includes((await legacy.agent(context)).cwd));
		}
		assert.equal((await legacyTopic.agent(context)).cwd, (await legacyPlain.agent(context)).cwd);
		assert.equal((await legacyPlain.agent(context)).cwd, (await legacyOther.agent(context)).cwd);
	} finally { await t.close(); }
});

test("member /new receipts retain sticky isolation and old reply anchors across replay and restart", async () => {
	const t = await setup();
	try {
		let sessions = t.sessionsFor(t.harness);
		const msg = message();
		const original = await sessions.forTelegram(msg, undefined, true);
		await sessions.anchor("tg:100:-200:11", original.id);
		const [first, duplicate] = await Promise.all([
			sessions.forTelegram(msg, "tg:100:update:1", true),
			sessions.forTelegram(msg, "tg:100:update:1", true),
		]);
		assert.equal(first.id, duplicate.id);
		assert.notEqual(first.id, original.id);
		await sessions.anchor("tg:100:-200:12", first.id);
		const second = await sessions.forTelegram(msg, "tg:100:update:2", true);
		await sessions.setArchived(original.id, true);
		assert.equal((await sessions.forTelegram(msg, "tg:100:update:1", true)).id, first.id);
		assert.equal((await sessions.forTelegram(msg, undefined, true)).id, second.id);
		assert.equal(await t.count(), 3);

		const saved = JSON.parse(await readFile(join(t.directory, "sessions.json"), "utf8"));
		for (const route of Object.values(saved) as { actorScoped?: boolean }[]) {
			assert.equal(route.actorScoped, true);
			delete route.actorScoped;
		}
		await writeFile(join(t.directory, "sessions.json"), JSON.stringify(saved));
		await t.reopen();
		sessions = t.sessionsFor(t.harness);
		await sessions.load();
		assert.equal((await sessions.forTelegram(msg, "tg:100:update:1", true)).id, first.id);
		assert.equal((await sessions.forTelegram(msg, undefined, true)).id, second.id);
		assert.equal(await t.count(), 3);
		for (const conversation of [original, first, second]) {
			assert.equal(sessions.isActorScoped(conversation.id), true);
			assert.deepEqual(sessions.destinationOf(conversation.id), msg.destination);
			assert.equal((await sessions.byConversation(conversation.id))?.id, conversation.id);
		}
		assert.equal(sessions.isArchived(original.id), true);
		assert.equal(sessions.follow("tg:100:-200:11"), original.id);
		assert.equal(sessions.follow("tg:100:-200:12"), first.id);
		const rows = sessions.listConversations();
		assert.ok(rows.some(({ key, id }) => key.endsWith(`#old:${original.id}`) && id === original.id));
		assert.ok(rows.some(({ key, id }) => key.endsWith(`#old:${first.id}`) && id === first.id));
		const durable = await t.harness.snapshot(TelegramSessionDoc, context);
		assert.ok(Object.values(durable!.routes).every((route) => route.actorScoped === true));
		await assert.rejects(sessions.forTelegram({ ...msg, senderId: "tg:301" }, "tg:100:update:1", true), /different route/);
		assert.equal(await t.count(), 3);
	} finally { await t.close(); }
});

test("a failed member projection recovers isolation from the atomic SQLite route and reset receipt", async () => {
	const t = await setup();
	try {
		let sessions = t.sessionsFor(t.harness);
		const msg = message();
		const original = await sessions.forTelegram(msg, undefined, true);
		await mkdir(join(t.directory, "sessions.json.tmp"));
		await assert.rejects(sessions.forTelegram(msg, "tg:100:update:crash", true), { code: "EISDIR" });
		const durable = await t.harness.snapshot(TelegramSessionDoc, context);
		const committedId = durable!.resets["telegram:tg:100:update:crash"].id;
		assert.notEqual(committedId, original.id);
		assert.ok(Object.values(durable!.routes).every((route) => route.actorScoped === true));
		await rm(join(t.directory, "sessions.json.tmp"), { recursive: true });
		await t.reopen();
		sessions = t.sessionsFor(t.harness);
		await sessions.load();
		assert.equal((await sessions.forTelegram(msg, undefined, true)).id, committedId);
		assert.equal((await sessions.forTelegram(msg, "tg:100:update:crash", true)).id, committedId);
		assert.equal(sessions.isActorScoped(original.id), true);
		assert.equal(sessions.isActorScoped(committedId), true);
		assert.equal(await t.count(), 2);
	} finally { await t.close(); }
});

test("actor-scoped routing rejects private or non-Telegram input without creating a conversation", async () => {
	const t = await setup();
	try {
		const sessions = t.sessionsFor(t.harness);
		await assert.rejects(sessions.forTelegram(message({ chatType: "p2p" }), undefined, true), /requires a group/);
		await assert.rejects(sessions.forTelegram(message({ platform: "feishu", destination: { kind: "feishu", chatId: "oc_chat" } }), undefined, true), /requires a Telegram destination/);
		assert.equal(await t.count(), 0);
		assert.equal(sessions.isActorScoped(999), false);
	} finally { await t.close(); }
});
