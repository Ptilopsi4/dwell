// Run in an isolated Linux environment with bubblewrap; no model or Feishu credentials are needed.
import assert from "node:assert/strict";
import { watch, renameSync, symlinkSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Uploads } from "../src/uploads.ts";
import { probeSandbox } from "../src/sandbox.ts";
import { APP_ROOT, DATA_DIR, STATE_DIR } from "../src/state.ts";

if (process.platform !== "linux") {
	console.log("skip: the upload sandbox probe requires Linux");
} else {
	await mkdir(DATA_DIR, { recursive: true });
	const base = await mkdtemp(join(resolve(DATA_DIR), "probe-uploads-"));
	try {
		const sandbox = await probeSandbox({ dataDir: base, stateDir: STATE_DIR, appRoot: APP_ROOT, forceOff: false });
		assert.ok(sandbox.enabled, sandbox.reason ?? "The sandbox must be enabled");
		const writer = await Uploads.open(join(base, "work"), () => sandbox);
		const cwd = join(base, "work", "session");
		await writer.register(cwd);
		await writer.save(cwd, "normal.txt", Buffer.from("stdin bytes: 中文\0binary"));
		assert.equal(await readFile(join(cwd, "uploads", "normal.txt"), "utf8"), "stdin bytes: 中文\0binary");
		console.log("PASS: fixed Node writer runs through bwrap and preserves stdin bytes");

		const outside = join(base, "outside");
		await mkdir(outside);
		const marker = join(outside, "marker.txt");
		await writeFile(marker, "unchanged");
		await link(marker, join(cwd, "uploads", "hard.txt"));
		await assert.rejects(writer.save(cwd, "hard.txt", Buffer.from("new")), { status: 409 });
		await rm(join(cwd, "uploads"), { recursive: true });
		await symlink(outside, join(cwd, "uploads"));
		await assert.rejects(writer.save(cwd, "marker.txt", Buffer.from("new")), { status: 409 });
		assert.equal(await readFile(marker, "utf8"), "unchanged");
		console.log("PASS: directory links and linked existing files are refused");

		await rm(join(cwd, "uploads"));
		await mkdir(join(cwd, "uploads"));
		let replaced = false;
		const observer = watch(join(cwd, "uploads"), (_event, name) => {
			if (name !== "raced.txt" || replaced) return;
			replaced = true;
			renameSync(join(cwd, "uploads"), join(cwd, "moved-uploads"));
			symlinkSync(outside, join(cwd, "uploads"));
		});
		try {
			await assert.rejects(writer.save(cwd, "raced.txt", Buffer.alloc(16 * 1024 * 1024, 0x61)), { status: 409 });
			assert.ok(replaced, "the directory replacement must actually occur during the write");
			assert.equal(await readFile(marker, "utf8"), "unchanged");
		} finally { observer.close(); }
		console.log("PASS: an in-flight directory replacement is reported without changing outside files");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}
