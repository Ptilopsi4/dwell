import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "dwell-users-"));
const previousEnv = { DWELL_STATE: process.env.DWELL_STATE, DWELL_ALLOW: process.env.DWELL_ALLOW, DWELL_ADMINS: process.env.DWELL_ADMINS };
process.env.DWELL_STATE = directory;
const { Users } = await import("../src/users.ts");
const file = join(directory, "users.json");
const temporaryFile = `${file}.tmp`;

beforeEach(async () => {
	delete process.env.DWELL_ALLOW;
	delete process.env.DWELL_ADMINS;
	await rm(file, { force: true });
	await rm(temporaryFile, { recursive: true, force: true });
});
after(async () => {
	await rm(directory, { recursive: true, force: true });
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

async function openUsers(): Promise<InstanceType<typeof Users>> {
	const users = new Users();
	await users.load();
	return users;
}

test("missing state persists environment seeds, including admin-only identities", async () => {
	process.env.DWELL_ALLOW = " tg:1, ou_member, , tg:1 ";
	process.env.DWELL_ADMINS = " ou_admin, tg:2 ";
	const users = await openUsers();
	assert.equal(users.isAllowed("tg:1"), true);
	assert.equal(users.isAdmin("tg:1"), false);
	assert.equal(users.isAllowed("ou_admin"), true);
	assert.equal(users.isAdmin("tg:2"), true);
	assert.equal(users.adminCount(), 2);
	assert.deepEqual(users.list(), [
		{ id: "ou_admin", role: "admin" }, { id: "tg:2", role: "admin" },
		{ id: "tg:1", role: "member" }, { id: "ou_member", role: "member" },
	]);
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
		members: ["tg:1", "ou_member"], admins: ["ou_admin", "tg:2"], appliedCommands: [],
	});
});

test("legacy state overrides environment seeds without requiring command receipts", async () => {
	process.env.DWELL_ALLOW = "ignored-member";
	process.env.DWELL_ADMINS = "ignored-admin";
	await writeFile(file, JSON.stringify({ members: ["saved-member"], admins: ["saved-admin"] }));
	const users = await openUsers();
	assert.equal(users.isAllowed("ignored-member"), false);
	assert.equal(users.isAdmin("ignored-admin"), false);
	assert.equal(users.isAllowed("saved-member"), true);
	assert.equal(users.isAllowed("saved-admin"), true);
	assert.equal(users.commandApplied("tg:bot:update:1"), false);
	await users.add("saved-admin", "member");
	assert.equal(users.isAdmin("saved-admin"), true, "adding membership preserves an existing admin role");
	await users.remove("saved-member");
	const reopened = await openUsers();
	assert.equal(reopened.isAllowed("saved-member"), false);
	assert.equal(reopened.isAdmin("saved-admin"), true);
});

test("persisted role command receipts prevent replay from undoing later role changes", async () => {
	let users = await openUsers();
	await users.add("tg:7", "admin", "tg:bot:update:1");
	assert.equal(users.commandApplied("tg:bot:update:1"), true);
	await users.remove("tg:7");
	users = await openUsers();
	await users.add("tg:7", "admin", "tg:bot:update:1");
	assert.equal(users.isAllowed("tg:7"), false, "replaying a completed grant cannot restore removed access");

	await users.add("tg:7", "member");
	await users.remove("tg:7", "tg:bot:update:2");
	await users.add("tg:7", "admin");
	users = await openUsers();
	assert.equal(users.commandApplied("tg:bot:update:2"), true);
	await users.remove("tg:7", "tg:bot:update:2");
	assert.equal(users.isAdmin("tg:7"), true, "replaying a completed removal cannot revoke later access");
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
		members: ["tg:7"], admins: ["tg:7"], appliedCommands: ["tg:bot:update:1", "tg:bot:update:2"],
	});
});

test("failed writes publish neither role changes nor command receipts and allow a later retry", async () => {
	const users = await openUsers();
	await users.add("original-admin", "admin");
	await mkdir(temporaryFile);
	try {
		await assert.rejects(users.add("new-admin", "admin", "grant"));
		assert.equal(users.isAllowed("new-admin"), false);
		assert.equal(users.isAdmin("new-admin"), false);
		assert.equal(users.commandApplied("grant"), false);
		await assert.rejects(users.remove("original-admin", "remove"));
		assert.equal(users.isAdmin("original-admin"), true);
		assert.equal(users.adminCount(), 1);
		assert.equal(users.commandApplied("remove"), false);
		const reopened = await openUsers();
		assert.equal(reopened.isAllowed("new-admin"), false);
		assert.equal(reopened.isAdmin("original-admin"), true);
		assert.equal(reopened.commandApplied("grant"), false);
		assert.equal(reopened.commandApplied("remove"), false);
	} finally {
		await rm(temporaryFile, { recursive: true, force: true });
	}
	await users.add("new-admin", "admin", "grant");
	await users.remove("original-admin", "remove");
	const reopened = await openUsers();
	assert.equal(reopened.isAdmin("new-admin"), true);
	assert.equal(reopened.isAllowed("original-admin"), false);
	assert.equal(reopened.commandApplied("grant"), true);
	assert.equal(reopened.commandApplied("remove"), true);
});

test("concurrent commands retain every committed role change and receipt", async () => {
	const users = await openUsers();
	await users.add("old-admin", "admin");
	await Promise.all([
		users.add("first-member", "member", "first"),
		users.add("second-admin", "admin", "second"),
		users.remove("old-admin", "third"),
	]);
	const reopened = await openUsers();
	assert.equal(reopened.isAllowed("first-member"), true);
	assert.equal(reopened.isAdmin("second-admin"), true);
	assert.equal(reopened.isAllowed("old-admin"), false);
	for (const id of ["first", "second", "third"]) assert.equal(reopened.commandApplied(id), true);
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
		members: ["first-member", "second-admin"], admins: ["second-admin"], appliedCommands: ["first", "second", "third"],
	});
});

test("command history retains the latest ten thousand completed commands", async () => {
	await writeFile(file, JSON.stringify({ members: [], admins: [], appliedCommands: Array.from({ length: 10_001 }, (_, id) => `command-${id}`) }));
	const users = await openUsers();
	assert.equal(users.commandApplied("command-0"), false);
	assert.equal(users.commandApplied("command-1"), true);
	await users.add("member", "member", "new-command");
	const reopened = await openUsers();
	assert.equal(reopened.commandApplied("command-1"), false);
	assert.equal(reopened.commandApplied("command-2"), true);
	assert.equal(reopened.commandApplied("new-command"), true);
	assert.equal(JSON.parse(await readFile(file, "utf8")).appliedCommands.length, 10_000);
});

test("concurrent protected removals leave one administrator and do not acknowledge the rejected command", async () => {
	const users = await openUsers();
	await users.add("tg:1", "admin");
	await users.add("tg:2", "admin");
	const results = await Promise.allSettled([users.remove("tg:1", "remove-first", true), users.remove("tg:2", "remove-second", true)]);
	assert.deepEqual(results.map((item) => item.status), ["fulfilled", "rejected"]);
	assert.equal(users.adminCount(), 1);
	assert.equal(users.isAdmin("tg:2"), true);
	assert.equal(users.commandApplied("remove-first"), true);
	assert.equal(users.commandApplied("remove-second"), false);
	const reopened = await openUsers();
	assert.equal(reopened.isAdmin("tg:2"), true);
});
