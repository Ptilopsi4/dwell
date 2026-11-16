import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow, type DirReader } from "@earendil-works/pi-durable/env";
import { GuardedExecutionEnv } from "../src/guarded-env.ts";
import { artifactManifest, unexpectedChanges, VERIFICATION_MAX_ENTRIES } from "../src/verification.ts";

const supported = { skip: process.platform === "win32" ? "POSIX directory boundary; Windows fails closed" : false, timeout: 15_000 };
const childProcesses = () => process.getActiveResourcesInfo().filter((name) => name === "ProcessWrap").length;
async function childrenSettled(baseline: number): Promise<void> {
	for (const end = Date.now() + 5000; childProcesses() > baseline;) {
		assert.ok(Date.now() < end, "Guarded file helper did not exit");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function fixture(t: TestContext) {
	const baseline = childProcesses();
	const directory = await mkdtemp(join(tmpdir(), "dwell-verification-directory-"));
	const cwd = join(directory, "work"), state = join(directory, "state");
	await mkdir(cwd); await mkdir(state);
	const env = await GuardedExecutionEnv.create({ cwd }, { cwd, readScope: cwd, tmp: join(directory, "tmp"), state,
		appRoot: join(directory, "app"), data: join(directory, "app/data"), sqlite: join(directory, "dwell.sqlite") });
	t.after(async () => {
		await env.cleanup(context);
		await childrenSettled(baseline);
		await rm(directory, { recursive: true, force: true });
	});
	return { cwd, state, env, baseline };
}

test("verification stops a 2048-file directory at its remaining entry allowance", supported, async (t) => {
	const { cwd, env, baseline } = await fixture(t);
	await mkdir(join(cwd, "wide"));
	await Promise.all(Array.from({ length: 2048 }, (_, i) => writeFile(join(cwd, "wide", String(i)), "")));
	let listed = 0, closed = 0;
	const open = env.openDirReader.bind(env);
	env.listDir = async () => { throw new Error("Verification must not enumerate a whole directory"); };
	env.openDirReader = async (path, ctx) => {
		const reader = getOrThrow(await open(path, ctx));
		return { ok: true, value: {
			next: async (maxEntries, nextContext) => {
				const page = await reader.next(maxEntries, nextContext);
				if (page.ok) { assert.ok(page.value.entries.length <= maxEntries); listed += page.value.entries.length; }
				return page;
			},
			close: async (closeContext) => { closed++; await reader.close(closeContext); },
		} };
	};
	await assert.rejects(artifactManifest(env, { checks: [], artifacts: ["wide"] }, context), /exceeds 1024 entries/);
	assert.equal(listed, VERIFICATION_MAX_ENTRIES, "The containing directory uses one slot; read at most its remaining 1023 plus one");
	assert.equal(closed, 1);
	await childrenSettled(baseline);
});

test("nested directories share the allowance reserved for unvisited siblings", supported, async (t) => {
	const { cwd, env } = await fixture(t);
	await mkdir(join(cwd, "tree"));
	await Promise.all(Array.from({ length: 512 }, (_, i) => mkdir(join(cwd, "tree", String(i).padStart(4, "0")))));
	await Promise.all(Array.from({ length: 512 }, (_, i) => writeFile(join(cwd, "tree/0000", `${i}.txt`), "")));
	const open = env.openDirReader.bind(env);
	let listed = 0;
	env.openDirReader = async (path, ctx) => {
		const reader = getOrThrow(await open(path, ctx));
		return { ok: true, value: {
			next: async (maxEntries, nextContext) => {
				const page = await reader.next(maxEntries, nextContext);
				if (page.ok) listed += page.value.entries.length;
				return page;
			},
			close: (closeContext) => reader.close(closeContext),
		} };
	};
	await assert.rejects(artifactManifest(env, { checks: [], artifacts: ["tree"] }, context), /exceeds 1024 entries/);
	assert.equal(listed, VERIFICATION_MAX_ENTRIES);
});

test("directory pages read metadata on demand and close without leaving helpers", supported, async (t) => {
	const { cwd, env, baseline } = await fixture(t);
	await mkdir(join(cwd, "normal"));
	await Promise.all(Array.from({ length: 5 }, (_, i) => writeFile(join(cwd, "normal", `${i}.txt`), "old")));
	const reader = getOrThrow(await env.openDirReader("normal", context));
	await Promise.all(Array.from({ length: 5 }, (_, i) => writeFile(join(cwd, "normal", `${i}.txt`), "current metadata")));
	const names: string[] = [];
	for (;;) {
		const page = getOrThrow(await reader.next(2, context));
		assert.ok(page.entries.length <= 2);
		for (const entry of page.entries) { names.push(entry.name); assert.equal(entry.size, 16); }
		if (page.done) break;
	}
	assert.deepEqual(names.sort(), ["0.txt", "1.txt", "2.txt", "3.txt", "4.txt"]);
	assert.deepEqual(getOrThrow(await reader.next(2, context)), { entries: [], done: true });
	await reader.close(context); await reader.close(context);
	assert.equal((await reader.next(2, context)).ok, false);
	await childrenSettled(baseline);
});

test("abort and environment cleanup release unopened and partially read directory helpers", supported, async (t) => {
	const { cwd, env, baseline } = await fixture(t);
	await mkdir(join(cwd, "normal"));
	await writeFile(join(cwd, "normal/file.txt"), "safe");
	const reader = getOrThrow(await env.openDirReader("normal", context));
	const controller = new AbortController(); controller.abort();
	const result = await reader.next(1, withAbortSignal(controller.signal, context));
	assert.ok(!result.ok && result.error.code === "aborted");
	await childrenSettled(baseline);
	const unused = getOrThrow(await env.openDirReader("normal", context));
	const partial = getOrThrow(await env.openDirReader("normal", context));
	assert.equal(getOrThrow(await partial.next(1, context)).entries.length, 1);
	await env.cleanup(context);
	for (const opened of [unused, partial]) { assert.equal((await opened.next(1, context)).ok, false); await opened.close(context); }
	await childrenSettled(baseline);
});

test("directory readers stay on their authorized directory after path replacement", supported, async (t) => {
	const { cwd, state, env } = await fixture(t);
	const path = join(cwd, "normal");
	await mkdir(path); await writeFile(join(path, "safe.txt"), "safe");
	await writeFile(join(state, "secret.txt"), "synthetic secret");
	const reader: DirReader = getOrThrow(await env.openDirReader("normal", context));
	await rename(path, `${path}-old`); await symlink(state, path);
	try { assert.deepEqual(getOrThrow(await reader.next(10, context)).entries.map((entry) => entry.name), ["safe.txt"]); }
	finally { await reader.close(context); }
	assert.equal((await env.openDirReader("normal", context)).ok, false);
});

test("an exact file allowance also permits removing its empty parent directories", supported, async (t) => {
	const { cwd, env } = await fixture(t);
	await mkdir(join(cwd, "job/disposable/nested"), { recursive: true });
	await writeFile(join(cwd, "job/disposable/nested/marker.txt"), "disposable");
	await writeFile(join(cwd, "job/result.txt"), "complete");
	const contract = { checks: [], artifacts: ["job", "job/result.txt"], allowedChanges: ["job/disposable/nested/marker.txt"] };
	const baseline = await artifactManifest(env, contract, context);
	await rm(join(cwd, "job/disposable"), { recursive: true });
	const current = await artifactManifest(env, contract, context);
	assert.deepEqual(unexpectedChanges(baseline, current, contract.allowedChanges), []);
});

test("parent directory removal does not permit undeclared descendants or type changes", supported, async (t) => {
	for (const variant of ["extra-file", "extra-directory", "directory-to-file"]) await t.test(variant, async (subtest) => {
		const { cwd, env } = await fixture(subtest);
		await mkdir(join(cwd, "job/disposable"), { recursive: true });
		await writeFile(join(cwd, "job/disposable/marker.txt"), "disposable");
		if (variant === "extra-file") await writeFile(join(cwd, "job/disposable/keep.txt"), "must not disappear");
		if (variant === "extra-directory") await mkdir(join(cwd, "job/disposable/keep"));
		const contract = { checks: [], artifacts: ["job"], allowedChanges: ["job/disposable/marker.txt"] };
		const baseline = await artifactManifest(env, contract, context);
		await rm(join(cwd, "job/disposable"), { recursive: true });
		if (variant === "directory-to-file") await writeFile(join(cwd, "job/disposable"), "replacement");
		const current = await artifactManifest(env, contract, context);
		const expected = variant === "extra-file" ? "job/disposable/keep.txt" : variant === "extra-directory" ? "job/disposable/keep" : "job/disposable";
		assert.ok(unexpectedChanges(baseline, current, contract.allowedChanges).includes(expected));
	});
});
