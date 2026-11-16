import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { TelegramChats, isTelegramGroupId } from "../src/telegram-chats.ts";

async function fixture(t: TestContext, botId = "100", seed = ["-300"]) {
	const directory = await mkdtemp(join(tmpdir(), "dwell-telegram-chats-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, "telegram-chats.json");
	const chats = new TelegramChats(botId, file);
	await chats.load(seed);
	return { file, chats };
}

test("Telegram group identities reject private, ambiguous, and unsafe IDs", () => {
	for (const id of ["-1", "-100300"]) assert.equal(isTelegramGroupId(id), true);
	for (const id of ["0", "-0", "300", "-0300", "-1.0", "-1e3", "-9007199254740992", " -300", "tg:100:-300"]) assert.equal(isTelegramGroupId(id), false, id);
});

test("Telegram chat state seeds each bot once and preserves an explicitly empty set across reopen", async (t) => {
	const { file, chats } = await fixture(t);
	const destination = { kind: "telegram" as const, botId: "100", chatId: "-300" };
	assert.equal(chats.allows(destination), true);
	assert.equal(chats.allows({ ...destination, botId: "200" }), false);
	assert.equal(chats.allows({ ...destination, chatId: "300" }), true);
	await chats.change("-300", false, "revoke-original");
	const reopened = new TelegramChats("100", file);
	await reopened.load(["-300", "-301"]);
	assert.deepEqual(reopened.list(), []);
	assert.equal(reopened.allows(destination), false);
	assert.equal(reopened.allows({ ...destination, chatId: "300" }), true);
	const other = new TelegramChats("200", file);
	await other.load(["-400"]);
	assert.deepEqual(other.list(), ["-400"]);
	assert.equal(other.allows(destination), false);
	const firstAgain = new TelegramChats("100", file);
	await firstAgain.load(["-301"]);
	assert.deepEqual(firstAgain.list(), []);
	const saved = JSON.parse(await readFile(file, "utf8"));
	assert.deepEqual(saved.bots["100"].chats, []);
	assert.deepEqual(saved.bots["200"].chats, ["-400"]);
});

test("Telegram chat changes serialize and persist replay receipts with their effects", async (t) => {
	const { file, chats } = await fixture(t);
	const results = await Promise.all([
		chats.change("-301", true, "grant"),
		chats.change("-302", true, "another-grant"),
		chats.change("-301", false, "revoke"),
		chats.change("-301", true, "grant"),
	]);
	assert.deepEqual(results, ["changed", "changed", "changed", "replayed"]);
	assert.deepEqual(chats.list(), ["-300", "-302"]);
	await chats.change("-301", true, "new-grant");
	assert.equal(await chats.change("-301", false, "revoke"), "replayed");
	assert.ok(chats.list().includes("-301"));
	const reopened = new TelegramChats("100", file);
	await reopened.load([]);
	assert.equal(await reopened.change("-301", false, "revoke"), "replayed");
	assert.deepEqual(reopened.list(), chats.list());
});

test("Telegram chat persistence failure publishes neither policy nor receipt and later changes recover", async (t) => {
	const { file, chats } = await fixture(t);
	await mkdir(`${file}.tmp`);
	await assert.rejects(chats.change("-301", true, "grant-after-write"));
	assert.deepEqual(chats.list(), ["-300"]);
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")).bots["100"].requests, []);
	await rm(`${file}.tmp`, { recursive: true });
	assert.equal(await chats.change("-301", true, "grant-after-write"), "changed");
	assert.deepEqual(chats.list(), ["-300", "-301"]);
});

test("Telegram chat load fails closed for corrupt state without replacing it with environment seeds", async (t) => {
	const { file } = await fixture(t);
	for (const contents of ["{broken", JSON.stringify({ version: 1, bots: { 100: { chats: ["300"], requests: [] } } })]) {
		await writeFile(file, contents);
		const chats = new TelegramChats("100", file);
		await assert.rejects(chats.load(["-300"]), /已拒绝启动/);
		assert.equal(chats.allows({ kind: "telegram", botId: "100", chatId: "-300" }), false);
		assert.equal(await readFile(file, "utf8"), contents);
	}
});

test("Telegram chat request history stays bounded while keeping the latest effect receipt", async (t) => {
	const { file } = await fixture(t);
	const requests = Array.from({ length: 10_000 }, (_, id) => `old-${id}`);
	await writeFile(file, JSON.stringify({ version: 1, bots: { 100: { chats: [], requests } } }));
	const chats = new TelegramChats("100", file);
	await chats.load(["-300"]);
	await chats.change("-301", true, "latest");
	const saved = JSON.parse(await readFile(file, "utf8")).bots["100"];
	assert.equal(saved.requests.length, 10_000);
	assert.equal(saved.requests[0], "old-1");
	assert.equal(saved.requests.at(-1), "latest");
	assert.deepEqual(saved.chats, ["-301"]);
});
