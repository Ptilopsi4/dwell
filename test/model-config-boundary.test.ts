import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkModelConfigBoundary } from "../src/harness.ts";

test("startup rejects model configuration in writable roots, including writable aliases", async (t) => {
	const template = resolve(import.meta.dirname, "../templates/models.openai-responses.json");
	await checkModelConfigBoundary(template, []);
	await assert.rejects(checkModelConfigBoundary(template, [dirname(template)]), /agent 可写目录/);
	const dir = await mkdtemp(join(tmpdir(), "dwell-config-boundary-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "models.json");
	await writeFile(file, "{}");
	await assert.rejects(checkModelConfigBoundary(file, []), /agent 可写目录/);
	const alias = join(dir, "readonly-target.json");
	try { await symlink(template, alias); }
	catch (error) {
		if (process.platform !== "win32") throw error;
		return;
	}
	await assert.rejects(checkModelConfigBoundary(alias, []), /agent 可写目录/);
});
