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

test("Telegram access modes exist only for enabled groups belonging to the loaded bot", async (t) => {
	const { file, chats } = await fixture(t);
	const destination = { kind: "telegram" as const, botId: "100", chatId: "-300" };
	const unloaded = new TelegramChats("100", file);
	assert.equal(unloaded.accessMode(destination), undefined);
	assert.equal(chats.accessMode(destination), "allowlist");
	assert.equal(chats.accessMode({ ...destination, botId: "200" }), undefined);
	assert.equal(chats.accessMode({ ...destination, chatId: "300" }), undefined);
	assert.equal(chats.accessMode({ ...destination, chatId: "-301" }), undefined);
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")).bots["100"], { chats: ["-300"], requests: [] });
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

test("Telegram group modes can be enabled, switched, disabled, and reopened without retaining removed access", async (t) => {
	const { file, chats } = await fixture(t);
	const destination = { kind: "telegram" as const, botId: "100", chatId: "-301" };
	assert.equal(await chats.change("-301", true, "enable-members", "members"), "changed");
	assert.equal(chats.allows(destination), true);
	assert.equal(chats.accessMode(destination), "members");
	assert.equal(await chats.change("-301", true, "same-members", "members"), "unchanged");
	assert.equal(await chats.change("-301", true, "switch-allowlist"), "changed");
	assert.equal(chats.accessMode(destination), "allowlist");
	assert.equal(await chats.change("-301", true, "same-allowlist"), "unchanged");
	assert.equal(await chats.change("-301", true, "switch-members", "members"), "changed");
	const reopened = new TelegramChats("100", file);
	await reopened.load(["-302"]);
	assert.deepEqual(reopened.list(), ["-300", "-301"]);
	assert.equal(reopened.accessMode(destination), "members");
	assert.equal(reopened.accessMode({ ...destination, chatId: "-300" }), "allowlist");
	assert.equal(await reopened.change("-301", false, "disable-members", "members"), "changed");
	assert.equal(reopened.allows(destination), false);
	assert.equal(reopened.accessMode(destination), undefined);
	assert.equal(JSON.parse(await readFile(file, "utf8")).bots["100"].memberChats, undefined);
	assert.equal(await reopened.change("-301", false, "already-disabled", "members"), "unchanged");
	assert.equal(await reopened.change("-301", true, "enable-default"), "changed");
	assert.equal(reopened.accessMode(destination), "allowlist");
});

test("Telegram member access remains scoped to its bot while other bot records survive writes", async (t) => {
	const { file, chats } = await fixture(t);
	await chats.change("-300", true, "first-members", "members");
	const other = new TelegramChats("200", file);
	await other.load(["-300"]);
	const destination = { kind: "telegram" as const, botId: "200", chatId: "-300" };
	assert.equal(other.accessMode(destination), "allowlist");
	await other.change("-400", true, "second-members", "members");
	const firstAgain = new TelegramChats("100", file);
	await firstAgain.load([]);
	assert.equal(firstAgain.accessMode({ ...destination, botId: "100" }), "members");
	assert.equal(firstAgain.accessMode({ ...destination, botId: "100", chatId: "-400" }), undefined);
	await firstAgain.change("-301", true, "first-extra");
	const otherAgain = new TelegramChats("200", file);
	await otherAgain.load([]);
	assert.equal(otherAgain.accessMode(destination), "allowlist");
	assert.equal(otherAgain.accessMode({ ...destination, chatId: "-400" }), "members");
	assert.deepEqual(otherAgain.list(), ["-300", "-400"]);
});

test("Telegram chat changes serialize and persist replay receipts with their effects", async (t) => {
	const { file, chats } = await fixture(t);
	const results = await Promise.all([
		chats.change("-301", true, "grant", "members"),
		chats.change("-302", true, "another-grant"),
		chats.change("-301", false, "revoke"),
		chats.change("-301", true, "grant", "members"),
	]);
	assert.deepEqual(results, ["changed", "changed", "changed", "replayed"]);
	assert.deepEqual(chats.list(), ["-300", "-302"]);
	await chats.change("-301", true, "new-grant", "members");
	assert.equal(await chats.change("-301", false, "revoke"), "replayed");
	assert.ok(chats.list().includes("-301"));
	const reopened = new TelegramChats("100", file);
	await reopened.load([]);
	assert.equal(await reopened.change("-301", false, "revoke"), "replayed");
	assert.equal(await reopened.change("-301", true, "new-grant"), "replayed");
	assert.equal(reopened.accessMode({ kind: "telegram", botId: "100", chatId: "-301" }), "members");
	assert.deepEqual(reopened.list(), chats.list());
});

test("Telegram chat persistence failure publishes neither policy nor receipt and later changes recover", async (t) => {
	const { file, chats } = await fixture(t);
	await mkdir(`${file}.tmp`);
	await assert.rejects(chats.change("-301", true, "grant-after-write", "members"));
	await assert.rejects(chats.change("-300", true, "switch-after-write", "members"));
	assert.deepEqual(chats.list(), ["-300"]);
	assert.equal(chats.accessMode({ kind: "telegram", botId: "100", chatId: "-300" }), "allowlist");
	assert.equal(chats.accessMode({ kind: "telegram", botId: "100", chatId: "-301" }), undefined);
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")).bots["100"].requests, []);
	await rm(`${file}.tmp`, { recursive: true });
	assert.equal(await chats.change("-301", true, "grant-after-write", "members"), "changed");
	assert.equal(await chats.change("-300", true, "switch-after-write", "members"), "changed");
	assert.deepEqual(chats.list(), ["-300", "-301"]);
	assert.equal(chats.accessMode({ kind: "telegram", botId: "100", chatId: "-300" }), "members");
	assert.equal(chats.accessMode({ kind: "telegram", botId: "100", chatId: "-301" }), "members");
});

test("Telegram legacy version 1 records remain strict allowlists until explicitly changed", async (t) => {
	const { file } = await fixture(t);
	await writeFile(file, JSON.stringify({ version: 1, bots: { 100: { chats: ["-300"], requests: ["legacy-grant"] } } }));
	const chats = new TelegramChats("100", file);
	await chats.load(["-301"]);
	assert.deepEqual(chats.list(), ["-300"]);
	assert.equal(chats.accessMode({ kind: "telegram", botId: "100", chatId: "-300" }), "allowlist");
	assert.equal(await chats.change("-300", true, "legacy-grant", "members"), "replayed");
	assert.equal(chats.accessMode({ kind: "telegram", botId: "100", chatId: "-300" }), "allowlist");
	assert.equal(await chats.change("-300", true, "explicit-members", "members"), "changed");
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")).bots["100"], {
		chats: ["-300"], memberChats: ["-300"], requests: ["legacy-grant", "explicit-members"],
	});
});

test("Telegram chat load fails closed for corrupt state without replacing it with environment seeds", async (t) => {
	const { file } = await fixture(t);
	const corruptMemberChats = [null, "-300", {}, [300], ["300"], ["-0"], ["-9007199254740992"], ["-301"]];
	const corruptStates = [
		"{broken",
		JSON.stringify({ version: 1, bots: { 100: { chats: ["300"], requests: [] } } }),
		...corruptMemberChats.map((memberChats) => JSON.stringify({ version: 1, bots: { 100: { chats: ["-300"], memberChats, requests: [] } } })),
		JSON.stringify({ version: 1, bots: { 100: { chats: ["-300"], requests: [] }, 200: { chats: [], memberChats: ["-300"], requests: [] } } }),
	];
	for (const contents of corruptStates) {
		await writeFile(file, contents);
		const chats = new TelegramChats("100", file);
		await assert.rejects(chats.load(["-300"]), /已拒绝启动/);
		assert.equal(chats.allows({ kind: "telegram", botId: "100", chatId: "-300" }), false);
		assert.equal(chats.accessMode({ kind: "telegram", botId: "100", chatId: "-300" }), undefined);
		assert.equal(await readFile(file, "utf8"), contents);
	}
});

test("Telegram chat request history stays bounded while keeping the latest effect receipt", async (t) => {
	const { file } = await fixture(t);
	const requests = Array.from({ length: 10_000 }, (_, id) => `old-${id}`);
	await writeFile(file, JSON.stringify({ version: 1, bots: { 100: { chats: [], requests } } }));
	const chats = new TelegramChats("100", file);
	await chats.load(["-300"]);
	await chats.change("-301", true, "latest", "members");
	const saved = JSON.parse(await readFile(file, "utf8")).bots["100"];
	assert.equal(saved.requests.length, 10_000);
	assert.equal(saved.requests[0], "old-1");
	assert.equal(saved.requests.at(-1), "latest");
	assert.deepEqual(saved.chats, ["-301"]);
	assert.deepEqual(saved.memberChats, ["-301"]);
});
