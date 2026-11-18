import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { GuardedExecutionEnv, readWorkspaceFile } from "../src/guarded-env.ts";
import type { PathBases } from "../src/file-policy.ts";

const context = BACKGROUND_CONTEXT;
async function fixture(t: TestContext) {
	const base = await mkdtemp(join(tmpdir(), "dwell-file-boundary-"));
	const bases: PathBases = { cwd: join(base, "work"), tmp: join(base, "tmp"), state: join(base, "state space"),
		appRoot: join(base, "app"), data: join(base, "app", "data"), sqlite: join(base, "app", "data", "dwell.sqlite"), modelConfig: join(base, "models.json") };
	for (const path of [bases.cwd, bases.tmp, bases.state, bases.data]) await mkdir(path, { recursive: true });
	await writeFile(bases.modelConfig!, "SYNTHETIC CONFIG");
	const env = await GuardedExecutionEnv.create({ cwd: bases.cwd }, bases);
	t.after(async () => { await env.cleanup(context); await rm(base, { recursive: true, force: true }); });
	return { base, bases, env, api: { env } as never };
}
const supported = { skip: process.platform === "win32" ? "POSIX file boundary; Windows fails closed" : false };

test("actual CodingTools reject normalized protected paths before read, write, or edit", supported, async (t) => {
	const { bases, api } = await fixture(t);
	const target = join(bases.state, "secret.txt");
	await writeFile(target, "SYNTHETIC SECRET");
	const paths = [target, `@${target}`, target.replace("state space", "state\u00a0space"), pathToFileURL(target).href,
		`@${pathToFileURL(target).href}`, `~/${relative(homedir(), target)}`, `@~/${relative(homedir(), target)}`];
	const read = createReadTool(), write = createWriteTool(), edit = createEditTool();
	for (const path of paths) {
		await assert.rejects(read.execute({ path }, api, context as never), /not allowed/);
		await assert.rejects(write.execute({ path, content: "CHANGED" }, api, context as never), /not allowed|limited to/);
		await assert.rejects(edit.execute({ path, edits: [{ oldText: "SYNTHETIC SECRET", newText: "CHANGED" }] }, api, context as never), /not allowed|limited to/);
	}
	assert.equal(await readFile(target, "utf8"), "SYNTHETIC SECRET");
});

test("read fallback candidates cannot expose the selected model configuration", supported, async (t) => {
	const { bases, env } = await fixture(t);
	const read = createReadTool();
	for (const [stored, requested] of [["owner’s.json", "owner's.json"], ["shot\u202fAM.json", "shot AM.json"], ["cafe\u0301.json", "café.json"]]) {
		const selected = join(bases.cwd, stored!);
		await writeFile(selected, "SYNTHETIC CONFIG");
		const guarded = await GuardedExecutionEnv.create({ cwd: bases.cwd }, { ...bases, modelConfig: selected });
		try { await assert.rejects(read.execute({ path: requested! }, { env: guarded } as never, context as never), /not allowed/); }
		finally { await guarded.cleanup(context); }
	}
	assert.equal((await env.readTextFile("/proc/self/environ", context)).ok, false);
});

test("actual CodingTools preserve nested writes, edits, read aliases and bounded text reads", supported, async (t) => {
	const { bases, api, env } = await fixture(t);
	const started = performance.now();
	await createWriteTool().execute({ path: "nested/normal.txt", content: "one\ntwo\nthree\n" }, api, context as never);
	await createEditTool().execute({ path: "nested/normal.txt", edits: [{ oldText: "two", newText: "changed" }] }, api, context as never);
	await symlink(join(bases.cwd, "nested/normal.txt"), join(bases.cwd, "alias.txt"));
	const result = await createReadTool().execute({ path: "@alias.txt", offset: 2, limit: 1 }, api, context as never);
	assert.deepEqual(result.output, [{ type: "text", text: "changed" }]);
	assert.equal(await readFile(join(bases.cwd, "nested/normal.txt"), "utf8"), "one\nchanged\nthree\n");
	const binary = getOrThrow(await env.openBinaryReader("nested/normal.txt", undefined, context));
	assert.deepEqual(getOrThrow(await binary.read(0, 4, context)), Buffer.from("one\n"));
	await binary.close(context);
	assert.equal((await env.writeFile(join(bases.tmp, "normal.txt"), "allowed", context)).ok, true);
	t.diagnostic(`Local guarded write/edit/read flow and extra file calls: ${Math.round(performance.now() - started)} ms; fixed workers add process startup per file operation.`);
});

test("opened readers stay on the authorized inode after directory replacement", supported, async (t) => {
	const { bases, env } = await fixture(t);
	const directory = join(bases.cwd, "directory");
	await mkdir(directory);
	await writeFile(join(directory, "same.txt"), "SAFE");
	await writeFile(join(bases.state, "same.txt"), "SYNTHETIC SECRET");
	const reader = getOrThrow(await env.openBinaryReader(join(directory, "same.txt"), undefined, context));
	await rename(directory, `${directory}-old`);
	await symlink(bases.state, directory);
	assert.equal(Buffer.from(getOrThrow(await reader.read(0, 100, context))).toString(), "SAFE");
	await reader.close(context);
	assert.equal((await env.writeFile(join(directory, "same.txt"), "CHANGED", context)).ok, false);
	assert.equal(await readFile(join(bases.state, "same.txt"), "utf8"), "SYNTHETIC SECRET");
});

test("hard links and unsupported host mutations cannot bypass the file boundary", supported, async (t) => {
	const { bases, env } = await fixture(t);
	const secret = join(bases.state, "secret.txt"), alias = join(bases.cwd, "hardlink");
	await writeFile(secret, "SYNTHETIC SECRET"); await link(secret, alias);
	for (const result of [await env.readTextFile(alias, context), await env.writeFile(alias, "CHANGED", context),
		await env.appendFile(alias, "CHANGED", context), await env.truncateFile(alias, 0, context),
		await env.remove(secret, { force: true }, context), await env.renameFile(secret, join(bases.cwd, "moved"), context)]) assert.equal(result.ok, false);
	assert.equal(await readFile(secret, "utf8"), "SYNTHETIC SECRET");
});

test("delivery reader enforces cwd scope and size before returning a pinned snapshot", supported, async (t) => {
	const { bases } = await fixture(t);
	await writeFile(join(bases.cwd, "normal.txt"), "SAFE");
	await writeFile(join(bases.tmp, "outside.txt"), "OUTSIDE");
	await assert.rejects(readWorkspaceFile(join(bases.tmp, "outside.txt"), bases, 30 * 1024 * 1024, context), /limited to/);
	const snapshot = await readWorkspaceFile("normal.txt", bases, 30 * 1024 * 1024, context);
	await rm(join(bases.cwd, "normal.txt"));
	await symlink(join(bases.tmp, "outside.txt"), join(bases.cwd, "normal.txt"));
	assert.equal(snapshot.buffer.toString(), "SAFE");
	const oversized = await open(join(bases.cwd, "large.bin"), "w");
	try { await oversized.truncate(30 * 1024 * 1024 + 1); } finally { await oversized.close(); }
	await assert.rejects(readWorkspaceFile("large.bin", bases, 30 * 1024 * 1024, context), /30MB limit/);
});

test("bounded directory swap race cannot redirect writes into protected synthetic state", { ...supported, timeout: 20_000 }, async (t) => {
	const { bases, env } = await fixture(t);
	const directory = join(bases.cwd, "racing"), parked = `${directory}-old`;
	await mkdir(directory); await writeFile(join(directory, "same.txt"), "SAFE");
	await writeFile(join(bases.state, "same.txt"), "SYNTHETIC SECRET");
	const racer = spawn(process.execPath, ["--input-type=commonjs", "--eval", `
const fs = require('node:fs');
const [directory, parked, state] = process.argv.slice(1);
process.stdout.write('ready\\n');
const end = Date.now() + 5000;
while (Date.now() < end) {
  try { fs.renameSync(directory, parked); fs.symlinkSync(state, directory); fs.unlinkSync(directory); fs.renameSync(parked, directory); } catch {}
}
`, directory, parked, bases.state], { env: {}, stdio: ["ignore", "pipe", "ignore"] });
	t.after(() => { racer.kill("SIGKILL"); });
	await new Promise<void>((done, reject) => { racer.stdout.once("data", () => done()); racer.once("error", reject); });
	for (let i = 0; i < 12; i++) await env.writeFile(join(directory, "same.txt"), "CHANGED", context);
	racer.kill("SIGKILL");
	await new Promise<void>((done) => { if (racer.exitCode !== null || racer.signalCode !== null) done(); else racer.once("exit", () => done()); });
	assert.equal(await readFile(join(bases.state, "same.txt"), "utf8"), "SYNTHETIC SECRET");
});
