import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileToolViolation, fileToolViolationReal, setModelConfigGuard, stateFileBlocked } from "../src/ext/approval.ts";

test("the selected model configuration is protected even inside an otherwise writable workspace", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "dwell-model-guard-"));
	t.after(async () => { setModelConfigGuard(undefined); await rm(cwd, { recursive: true, force: true }); });
	const selected = join(cwd, "models.json");
	await writeFile(selected, "{}");
	for (const tool of ["read", "write", "edit"]) {
		assert.equal(await fileToolViolationReal(tool, selected, cwd), undefined);
	}
	setModelConfigGuard(selected);
	for (const tool of ["read", "write", "edit"]) {
		assert.match(fileToolViolation(tool, "./models.json", cwd) ?? "", /selected model configuration/);
		assert.match(await fileToolViolationReal(tool, "./models.json", cwd) ?? "", /selected model configuration/);
		assert.equal(await fileToolViolationReal(tool, "project/models.json", cwd), undefined);
	}
	setModelConfigGuard(undefined);
	assert.equal(await fileToolViolationReal("write", selected, cwd), undefined);
});

test("model configuration protection resolves directory aliases for both the selected file and tool target", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dwell-model-alias-"));
	t.after(async () => { setModelConfigGuard(undefined); await rm(base, { recursive: true, force: true }); });
	const actual = join(base, "actual");
	const alias = join(base, "alias");
	await mkdir(actual);
	await writeFile(join(actual, "models.json"), "{}");
	try {
		await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
		t.skip("Directory symlinks are unavailable on this platform");
		return;
	}
	for (const selected of [join(actual, "models.json"), join(alias, "models.json")]) {
		setModelConfigGuard(selected);
		for (const target of [join(actual, "models.json"), join(alias, "models.json")]) {
			for (const tool of ["read", "write", "edit"]) assert.match(await fileToolViolationReal(tool, target, base) ?? "", /selected model configuration/);
		}
		assert.equal(stateFileBlocked(`cat "${selected}"`), true);
		assert.equal(stateFileBlocked(`cat "${await realpath(selected)}"`), true);
	}
});

test("bash protects the selected path and its environment reference without blocking unrelated models.json files", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "dwell-model-command-"));
	t.after(async () => { setModelConfigGuard(undefined); await rm(cwd, { recursive: true, force: true }); });
	const selected = join(cwd, "models.json");
	await writeFile(selected, "{}");
	setModelConfigGuard(selected);
	assert.equal(stateFileBlocked(`cat "${selected}"`), true);
	assert.equal(stateFileBlocked('cat "$DWELL_MODELS_FILE"'), true);
	assert.equal(stateFileBlocked('cat "${DWELL_MODELS_FILE}"'), true);
	assert.equal(stateFileBlocked('cat "${DWELL_MODELS_FILE:-fallback}"'), true);
	assert.equal(stateFileBlocked("cat models.json"), false);
	assert.equal(stateFileBlocked("cat project/models.json"), false);
	setModelConfigGuard(undefined);
	assert.equal(stateFileBlocked(`cat "${selected}"`), false);
	assert.equal(stateFileBlocked('cat "$DWELL_MODELS_FILE"'), false);
});
