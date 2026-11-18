// node --test "test/sessions.test.ts"
// Route creation concurrency and group-line emoji allocation.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Conversation, ConversationId, Harness } from "@earendil-works/pi-durable";

const directory = await mkdtemp(join(tmpdir(), "dwell-sessions-"));
process.env.DWELL_DATA = join(directory, "data");
process.env.DWELL_STATE = join(directory, "state");
delete process.env.DWELL_MODELS_FILE;
process.env.DWELL_PROVIDER = "deepseek";
process.env.DWELL_MODEL = "deepseek-chat";
const { allocateEmoji, LINE_EMOJI_POOL, Sessions } = await import("../src/sessions.ts");
after(() => rm(directory, { recursive: true, force: true }));

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

async function routingSetup(prepare: (cwd: string) => Promise<void> = async () => {}) {
	const state = await mkdtemp(join(directory, "route-"));
	const conversations = new Map<ConversationId, Conversation>();
	let created = 0;
	const harness = {
		async createConversation(options: Parameters<Harness["createConversation"]>[0]) {
			const conversation = { id: ++created as ConversationId, agent: async () => options.agent } as unknown as Conversation;
			conversations.set(conversation.id, conversation);
			return conversation;
		},
		async conversation(id: ConversationId) { return conversations.get(id); },
		async snapshot() { return undefined; },
	} as unknown as Harness;
	const prepared: string[] = [];
	const sessions = new Sessions(harness, async (cwd) => {
		prepared.push(cwd);
		await prepare(cwd);
		await mkdir(cwd, { recursive: true });
	});
	const file = join(state, "sessions.json");
	Object.assign(sessions, { file, mapFile: join(state, "message-map.json") });
	return { sessions, conversations, prepared, file, harness, get created() { return created; } };
}

for (const target of ["private", "group", "topic"] as const) test(`Telegram ${target} retains its canonical send anchor and all reply mappings across reload`, async () => {
	const t = await routingSetup();
	const conversation = await t.sessions.forDirect("oc_fixture", "tg:200");
	const chatId = target === "private" ? "200" : "-300";
	Object.assign(t.sessions, { destinations: new Map([[conversation.id, { kind: "telegram", botId: "100", chatId, ...(target === "topic" ? { threadId: "9" } : {}) }]]) });
	await t.sessions.rename(conversation.id, "Canonical Telegram task");
	const foreign = target === "private" ? "tg:100:201:1" : "tg:100:200:1";
	await t.sessions.anchor(foreign, conversation.id);
	assert.equal(t.sessions.lastAnchor(conversation.id), undefined, "A foreign chat cannot supply the canonical send anchor");
	const canonical = `tg:100:${chatId}:2`;
	await t.sessions.anchor(canonical, conversation.id);
	for (const anchor of [`tg:999:${chatId}:3`, `${foreign.slice(0, -1)}4`]) await t.sessions.anchor(anchor, conversation.id);
	assert.equal(t.sessions.lastAnchor(conversation.id), canonical);
	assert.equal(t.sessions.follow(foreign), conversation.id);
	const reloaded = new Sessions(t.harness, async () => {});
	Object.assign(reloaded, { file: t.file, mapFile: join(t.file, "..", "message-map.json") });
	await reloaded.load();
	assert.equal(reloaded.lastAnchor(conversation.id), canonical);
	assert.equal(reloaded.follow(foreign), conversation.id);
	assert.equal(reloaded.follow(`tg:999:${chatId}:3`), conversation.id);
});

test("a pure panel task keeps its latest private notification anchor across reload", async () => {
	const t = await routingSetup();
	const conversation = await t.sessions.createPanelConversation("Notification task");
	await t.sessions.anchor("om_feishu_notice", conversation.id);
	await t.sessions.anchor("tg:100:200:9", conversation.id);
	assert.equal(t.sessions.lastAnchor(conversation.id), "tg:100:200:9");
	const reloaded = new Sessions(t.harness, async () => {});
	Object.assign(reloaded, { file: t.file, mapFile: join(t.file, "..", "message-map.json") });
	await reloaded.load();
	assert.equal(reloaded.lastAnchor(conversation.id), "tg:100:200:9");
	assert.equal(reloaded.follow("om_feishu_notice"), conversation.id);
	assert.equal(reloaded.follow("tg:100:200:9"), conversation.id);
});

for (const kind of ["direct", "group", "thread"] as const) {
	test(`concurrent ${kind} messages share one new conversation and preserve its first owner`, async () => {
		const ready = gate();
		const t = await routingSetup(async () => ready.promise);
		const route = (sender: string) => kind === "direct"
			? t.sessions.forDirect("oc_same", sender)
			: kind === "group"
				? t.sessions.forGroup("oc_same", "ou_first")
				: t.sessions.forThread("oc_same", "thread", sender);
		const first = route("ou_first");
		const second = route("ou_second");
		ready.release();
		const [a, b] = await Promise.all([first, second]);
		assert.equal(t.created, 1);
		assert.equal(a.id, b.id);
		assert.equal((await route("ou_later")).id, a.id);
		assert.equal(t.sessions.ownerOf(a.id), "ou_first");
		assert.deepEqual(t.prepared, [resolve(directory, "data", "work", "oc_same")]);
		const key = kind === "direct" ? "oc_same" : kind === "group" ? "oc_same#ou_first" : "oc_same#t:thread";
		assert.deepEqual(t.sessions.listConversations().map(({ key, id, owner }) => ({ key, id, owner })), [{ key, id: a.id, owner: "ou_first" }]);
		assert.deepEqual(JSON.parse(await readFile(t.file, "utf8")), { [key]: { id: a.id, owner: "ou_first" } });
	});
}

test("concurrent requests rebuild a missing conversation once", async () => {
	const ready = gate();
	let rebuilding = false;
	const t = await routingSetup(async () => { if (rebuilding) await ready.promise; });
	const old = await t.sessions.forThread("oc_missing", "thread", "ou_old");
	t.conversations.delete(old.id);
	rebuilding = true;
	const first = t.sessions.forThread("oc_missing", "thread", "ou_first");
	const second = t.sessions.forThread("oc_missing", "thread", "ou_second");
	ready.release();
	const [a, b] = await Promise.all([first, second]);
	assert.equal(t.created, 2);
	assert.notEqual(a.id, old.id);
	assert.equal(a.id, b.id);
	assert.equal((await t.sessions.forThread("oc_missing", "thread", "ou_later")).id, a.id);
	assert.equal(t.sessions.ownerOf(a.id), "ou_first");
	assert.equal(t.sessions.listConversations().length, 1);
});

test("an unresolved route does not block a different route key", async () => {
	const ready = gate();
	const t = await routingSetup(async (cwd) => { if (cwd.endsWith("oc_blocked")) await ready.promise; });
	const blocked = t.sessions.forDirect("oc_blocked", "ou_first");
	const independent = t.sessions.forDirect("oc_independent", "ou_second");
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(t.prepared, [
			resolve(directory, "data", "work", "oc_blocked"),
			resolve(directory, "data", "work", "oc_independent"),
		]);
		const other = await independent;
		assert.equal(t.created, 1);
		assert.equal(t.sessions.ownerOf(other.id), "ou_second");
	} finally {
		ready.release();
		await Promise.all([blocked, independent]);
	}
	assert.equal(t.created, 2);
});

test("failed route creation rejects its waiters and permits a later retry", async () => {
	const ready = gate();
	let unavailable = true;
	const failure = new Error("workspace unavailable");
	const t = await routingSetup(async () => {
		if (unavailable) {
			await ready.promise;
			throw failure;
		}
	});
	const first = t.sessions.forDirect("oc_retry", "ou_first");
	const second = t.sessions.forDirect("oc_retry", "ou_second");
	const settled = Promise.allSettled([first, second]);
	ready.release();
	assert.deepEqual(await settled, [{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
	assert.equal(t.created, 0);
	assert.equal(t.prepared.length, 1);
	unavailable = false;
	const retried = await t.sessions.forDirect("oc_retry", "ou_retry");
	assert.equal(t.created, 1);
	assert.equal(t.sessions.ownerOf(retried.id), "ou_retry");
	assert.equal((await t.sessions.forDirect("oc_retry", "ou_later")).id, retried.id);
});

test("未占用优先：依次分配不重复", () => {
	const active: { id: number; emoji?: string; lastTs: number }[] = [];
	const got: string[] = [];
	for (let i = 1; i <= 5; i++) {
		const r = allocateEmoji(active);
		got.push(r.emoji);
		active.push({ id: i, emoji: r.emoji, lastTs: i });
	}
	assert.equal(new Set(got).size, 5);
});

test("已占用的 emoji 不再分配", () => {
	const r = allocateEmoji([{ id: 1, emoji: "🔵", lastTs: 1 }, { id: 2, emoji: "🟢", lastTs: 2 }]);
	assert.ok(!["🔵", "🟢"].includes(r.emoji));
});

test("池满转移最久未活跃线的 emoji", () => {
	const r = allocateEmoji([{ id: 1, emoji: "🔵", lastTs: 100 }, { id: 2, emoji: "🟢", lastTs: 50 }], ["🔵", "🟢"]);
	assert.deepEqual(r, { emoji: "🟢", stealFrom: 2 });
});

test("空线集退化用池首项", () => {
	assert.equal(allocateEmoji([]).emoji, LINE_EMOJI_POOL[0]);
});
