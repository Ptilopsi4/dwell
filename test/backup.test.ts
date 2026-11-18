import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { TelegramInbox, TelegramInboxDoc } from "../src/telegram-entry.ts";
import { createBackup, restoreBackup, verifyBackup, type BackupOptions } from "../src/backup.ts";

async function fixture(t: import("node:test").TestContext): Promise<BackupOptions> {
	const root = await mkdtemp(join(tmpdir(), "dwell-backup-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const name of ["data", "state", "app", "app/src"]) await mkdir(join(root, name));
	await writeFile(join(root, "app/package.json"), '{"type":"module"}');
	await writeFile(join(root, "app/package-lock.json"), '{"lockfileVersion":3}');
	await writeFile(join(root, "app/src/index.ts"), "// Isolated restore fixture.\n");
	await writeFile(join(root, "models.json"), '{"main":{"apiKeyEnv":"TEST_KEY"}}');
	await writeFile(join(root, ".env"), "TEST_KEY=synthetic-fixture\n");
	const db = new DatabaseSync(join(root, "data/dwell.sqlite"));
	db.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('before-backup')"); db.close();
	return { data: join(root, "data"), state: join(root, "state"), code: join(root, "app"), models: join(root, "models.json"), env: join(root, ".env"), output: join(root, "backup"), stopped: true };
}

test("backup restores a matched SQLite and JSON checkpoint into a fresh directory", async (t) => {
	const options = await fixture(t);
	await rm(join(options.data, "dwell.sqlite"));
	const models = createModels(); models.setProvider(fauxProvider().provider);
	const open = (data: string) => openNodeSqliteStorage(join(data, "dwell.sqlite")).then((storage) => Harness.open(storage, { models, registry: createRegistry() }, context));
	const original = await open(options.data);
	const conversation = await original.createConversation({ ownership: { kind: "ownerless" } }, context);
	const raw = { platform: "telegram", messageId: "tg:100:-200:7", senderId: "tg:300", chatId: "-200", content: "/ask@fixture inspect attachment", attachments: [] };
	await original.commit(async (tx) => { (await tx.doc(TelegramInboxDoc)).inputs["tg-update:100:42"] = {
		conversationId: conversation.id, sender: "tg:300", destination: { kind: "telegram", botId: "100", chatId: "-200" }, replyTo: "tg:100:-200:7", content: "", raw: JSON.stringify(raw), prepared: false, output: "pending",
	}; }, context);
	await original.close(context);
	const approval = { requestId: "approval-fixture", trigger: "tg:300", conversationId: conversation.id };
	await writeFile(join(options.state, "approvals.json"), JSON.stringify(approval));
	await writeFile(join(options.state, "cursor.json"), '{"offset":43}');
	await createBackup(options);
	await writeFile(join(options.state, "cursor.json"), '{"offset":99}');
	const target = join(options.output, "..", "restored");
	const manifest = await restoreBackup(options.output, target);
	assert.ok(manifest.files.some((file) => file.path === ".env" && file.mode === 0o600));
	assert.deepEqual(JSON.parse(await readFile(join(target, "state/cursor.json"), "utf8")), { offset: 43 });
	assert.deepEqual(JSON.parse(await readFile(join(target, "state/approvals.json"), "utf8")), approval);
	assert.equal(await readFile(join(target, ".env"), "utf8"), "TEST_KEY=synthetic-fixture\n");
	const restored = await open(join(target, "data"));
	try {
		const receipt = await new TelegramInbox(restored).input("tg-update:100:42");
		assert.equal(receipt?.conversationId, conversation.id);
		assert.equal(receipt?.sender, "tg:300");
		assert.deepEqual(JSON.parse(receipt!.raw!), raw);
		assert.equal(receipt?.prepared, false);
	} finally { await restored.close(context); }
});

test("backup verification detects changed files, omitted state, extra files and corrupt SQLite", async (t) => {
	const options = await fixture(t);
	await writeFile(join(options.state, "approvals.json"), "{}");
	await createBackup(options);
	const state = join(options.output, "state/approvals.json");
	await writeFile(state, '{"changed":true}');
	await assert.rejects(verifyBackup(options.output), /checksums/);
	await writeFile(state, "{}");
	await rm(state);
	await assert.rejects(verifyBackup(options.output), /checksums/);
	await writeFile(state, "{}", { mode: 0o600 });
	await writeFile(join(options.output, "extra"), "unexpected");
	await assert.rejects(verifyBackup(options.output), /checksums/);
	await rm(join(options.output, "extra"));
	await verifyBackup(options.output);
	await writeFile(join(options.data, "dwell.sqlite"), "not sqlite");
	await assert.rejects(createBackup({ ...options, output: options.output + "-broken" }), /database/);
});

test("backup requires a stopped source and refuses existing destinations and symlinks", async (t) => {
	const options = await fixture(t);
	await assert.rejects(createBackup({ ...options, stopped: false }), /Stop the service/);
	await assert.rejects(createBackup({ ...options, output: join(options.data, "backup") }), /outside/);
	await createBackup(options);
	await assert.rejects(createBackup(options), /EEXIST/);
	await assert.rejects(restoreBackup(options.output, options.data), /EEXIST/);
	await symlink(options.env!, join(options.state, "key-link"));
	await assert.rejects(createBackup({ ...options, output: options.output + "-symlink" }), /symlinks/);
});

test("workspace symlinks survive backup and restore without reading external targets", async (t) => {
	const options = await fixture(t);
	const workspace = join(options.data, "work", "2");
	await mkdir(join(workspace, "node_modules", ".bin"), { recursive: true });
	await writeFile(join(workspace, "node_modules", "tool.js"), "// Workspace executable.\n");
	await symlink("../tool.js", join(workspace, "node_modules", ".bin", "tool"));
	const privateFile = join(options.state, "private.txt");
	await writeFile(privateFile, "PRIVATE CONTENT");
	await symlink(options.state, join(workspace, "external"));
	const absent = join(options.state, "missing.txt");
	await symlink(absent, join(workspace, "missing"));
	const manifest = await createBackup(options);
	const links = manifest.files.filter((file) => file.type === "symlink");
	assert.deepEqual(links.map((file) => [file.path, file.target]), [
		["data/work/2/external", options.state],
		["data/work/2/missing", absent],
		["data/work/2/node_modules/.bin/tool", "../tool.js"],
	]);
	assert.ok(!manifest.files.some((file) => file.path.startsWith("data/work/2/external/")));
	await writeFile(privateFile, "EXTERNAL TARGET CHANGED");
	await verifyBackup(options.output);
	const target = join(options.output, "..", "restored-links");
	await restoreBackup(options.output, target);
	for (const link of links) {
		assert.equal((await lstat(join(target, link.path))).isSymbolicLink(), true);
		assert.equal(await readlink(join(target, link.path)), link.target);
	}
	assert.equal(await readFile(join(target, "data/work/2/node_modules/.bin/tool"), "utf8"), "// Workspace executable.\n");
	assert.equal(await readFile(join(target, "state/private.txt"), "utf8"), "PRIVATE CONTENT");
});

test("changed workspace symlink targets invalidate verification and block restore", async (t) => {
	const options = await fixture(t);
	await mkdir(join(options.data, "work", "2"), { recursive: true });
	await symlink("original.txt", join(options.data, "work", "2", "result"));
	await createBackup(options);
	const link = join(options.output, "data/work/2/result");
	await rm(link);
	await symlink("changed.txt", link);
	await assert.rejects(verifyBackup(options.output), /symlink targets/);
	const target = join(options.output, "..", "rejected-restore");
	await assert.rejects(restoreBackup(options.output, target), /symlink targets/);
	await assert.rejects(lstat(target), { code: "ENOENT" });
});

test("symlink support stays confined to workspace descendants during creation and verification", async (t) => {
	const options = await fixture(t);
	for (const [name, path] of [
		["state", join(options.state, "private-link")],
		["app", join(options.code, "src", "private-link")],
		["work-root", join(options.data, "work")],
	] as const) {
		await symlink(options.env!, path);
		await assert.rejects(createBackup({ ...options, output: options.output + `-${name}` }), /symlinks/);
		await rm(path);
	}
	const modelLink = join(options.output, "..", "model-link");
	await symlink(options.models, modelLink);
	await assert.rejects(createBackup({ ...options, models: modelLink, output: options.output + "-models" }), /symlinks/);
	const envLink = join(options.output, "..", "env-link");
	await symlink(options.env!, envLink);
	await assert.rejects(createBackup({ ...options, env: envLink, output: options.output + "-env" }), /symlinks/);
	await createBackup(options);
	for (const name of ["state", "app/src"]) {
		const path = join(options.output, name, "private-link");
		await symlink(options.env!, path);
		await assert.rejects(verifyBackup(options.output), /unsupported file type/);
		await rm(path);
	}
});
