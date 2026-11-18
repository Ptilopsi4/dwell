import { test } from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UploadError, Uploads } from "../src/uploads.ts";
import { describeResources, ingestBuffer } from "../src/media.ts";
import { ingestUpload } from "../src/web/server.ts";
import type { NormalizedMessage } from "../src/feishu/channel.ts";

const posix = { skip: process.platform === "win32" ? "Safe uploads are disabled on Windows" : false };
async function workspace(t: import("node:test").TestContext) {
	const base = await mkdtemp(join(tmpdir(), "dwell-upload-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const work = join(base, "work");
	const cwd = join(work, "session");
	const writer = await Uploads.open(work, () => ({ enabled: false }));
	await writer.register(cwd);
	return { base, work, cwd, writer };
}

test("uploads create new writable files and never overwrite an existing upload", posix, async (t) => {
	const { cwd, writer } = await workspace(t);
	await writer.save(cwd, "file.txt", Buffer.from("first"));
	await assert.rejects(writer.save(cwd, "file.txt", Buffer.from("second")), { status: 409 });
	const path = join(cwd, "uploads", "file.txt");
	assert.equal(await readFile(path, "utf8"), "first");
	await writeFile(path, "agent edit");
	assert.equal(await readFile(path, "utf8"), "agent edit");
});

test("uploads reject directory links and existing linked leaf files", posix, async (t) => {
	const { base, cwd, writer } = await workspace(t);
	const outside = join(base, "outside");
	await mkdir(outside);
	const marker = join(outside, "marker.txt");
	await writeFile(marker, "unchanged");
	await symlink(outside, join(cwd, "uploads"));
	await assert.rejects(writer.save(cwd, "marker.txt", Buffer.from("new")), { status: 409 });
	await rm(join(cwd, "uploads"));
	await mkdir(join(cwd, "uploads"));
	await link(marker, join(cwd, "uploads", "hard.txt"));
	await symlink(marker, join(cwd, "uploads", "soft.txt"));
	for (const name of ["hard.txt", "soft.txt"]) await assert.rejects(writer.save(cwd, name, Buffer.from("new")), { status: 409 });
	assert.equal(await readFile(marker, "utf8"), "unchanged");
});

test("registered roots cannot be rebound, removed, or replaced by links", posix, async (t) => {
	const { base, cwd, writer } = await workspace(t);
	await rename(cwd, join(base, "original"));
	await assert.rejects(writer.save(cwd, "a.txt", Buffer.from("x")), { status: 409 });
	await mkdir(cwd);
	await assert.rejects(writer.save(cwd, "a.txt", Buffer.from("x")), { status: 409 });
	await assert.rejects(writer.register(cwd), { status: 409 });
	await rm(cwd, { recursive: true });
	await symlink(join(base, "original"), cwd);
	await assert.rejects(writer.save(cwd, "a.txt", Buffer.from("x")), { status: 409 });
	await assert.rejects(writer.register(cwd), { status: 409 });
});

test("unregistered workspaces and basename escapes are rejected", posix, async (t) => {
	const { base, cwd, writer } = await workspace(t);
	await assert.rejects(writer.register(base), { status: 409 });
	await assert.rejects(writer.save(join(base, "other"), "x.txt", Buffer.from("x")), { status: 409 });
	for (const name of ["../x", "a/b", "a\\b", "..", "a\0b"]) await assert.rejects(writer.save(cwd, name, Buffer.from("x")), { status: 409 });
});

test("writer startup errors are storage failures, not workspace conflicts", posix, async (t) => {
	const { base, work, cwd } = await workspace(t);
	const writer = await Uploads.open(work, () => ({ enabled: true, wrapperPath: join(base, "missing-wrapper") }));
	await writer.register(cwd);
	await assert.rejects(writer.save(cwd, "a.txt", Buffer.from("data")), { status: 500 });
	assert.deepEqual(await readdir(cwd), []);
});

test("redelivery gets distinct files and long Unicode filenames fit the filesystem", posix, async (t) => {
	const { cwd, writer } = await workspace(t);
	const msg = { messageId: "om_repeat", resources: [{ type: "file", fileKey: "key", fileName: "日".repeat(200) + ".txt" }] } as unknown as NormalizedMessage;
	for (let i = 0; i < 2; i++) await describeResources(msg, cwd, { download: async () => Buffer.from("content"), describer: null, save: writer.save });
	const names = await readdir(join(cwd, "uploads"));
	assert.equal(names.length, 2);
	for (const name of names) { assert.ok(Buffer.byteLength(name) <= 255); assert.ok(name.endsWith(".txt")); }
	const result = await ingestBuffer(Buffer.from("content"), { kind: "file", index: 1, tag: "id-", name: "x".repeat(230) + ".csv" }, cwd, null, writer.save);
	assert.ok(Buffer.byteLength(result.saved.slice(8)) <= 255);
	assert.ok(result.saved.endsWith(".csv"));
});

test("attachment save failure is explicit and does not discard later resources", async () => {
	let attempts = 0;
	const msg = { messageId: "om_partial", resources: [{ type: "file", fileKey: "one" }, { type: "file", fileKey: "two" }] } as unknown as NormalizedMessage;
	const result = await describeResources(msg, "/unused", {
		download: async () => Buffer.from("data"), describer: null,
		save: async () => { if (++attempts === 1) throw new UploadError(409, "changed"); },
	});
	assert.match(result, /Attachment 1.*Could not save/);
	assert.match(result, /\[文件2\]/);
	assert.equal(attempts, 2);
	const response = await ingestUpload("/unused", "file", "eA==", null, async () => { throw new UploadError(409, "changed"); });
	assert.equal(response.status, 409);
});

test("Windows explicitly rejects safe uploads", { skip: process.platform !== "win32" }, async (t) => {
	const { cwd, writer } = await workspace(t);
	await assert.rejects(writer.save(cwd, "a.txt", Buffer.from("x")), { status: 501 });
});
