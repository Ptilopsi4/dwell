// Fixed host file operations. No user code or command text is evaluated here.
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { LineScanner, type FileInfo } from "@earendil-works/pi-durable/env";
import { filePathViolation, type PathBases } from "./file-policy.ts";

export type FileRequest = {
	path: string;
	parts: string[];
	root: { dev: number; ino: number };
	bases: PathBases;
	operation: "read" | "write" | "append" | "truncate" | "flush" | "info" | "exists" | "directory" | "mkdir";
	recursive?: boolean;
};

const request: FileRequest = JSON.parse(process.argv[2]!);
let file: FileHandle | undefined;
const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;
const denied = (message: string): never => { throw Object.assign(new Error(message), { code: "EACCES" }); };
const check = (path: string, write: boolean) => {
	const problem = filePathViolation(write ? "write" : "read", path, request.bases);
	if (problem !== undefined) denied(problem);
};
const write = ["write", "append", "truncate", "flush", "mkdir"].includes(request.operation);
const metadata = (stats: Stats, path: string): FileInfo => ({
	name: basename(path), path, size: stats.size, mtimeMs: stats.mtimeMs,
	kind: stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "file",
});
const send = (value: unknown) => new Promise<void>((done, reject) => process.send!({ ok: true, value }, (error) => error ? reject(error) : done()));
const fail = (error: unknown) => {
	const cause = error as NodeJS.ErrnoException;
	process.send?.({ ok: false, error: { code: cause.code, message: cause.message } }, () => process.exit(1));
};

// cwd pins a directory inode on POSIX. No unchecked absolute path is used after entry.
async function enter(name: string, create: boolean): Promise<void> {
	if (create) await mkdir(name).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
	const directory = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const before = await directory.stat();
		process.chdir(name);
		if (!same(before, await lstat("."))) denied("Directory changed while opening it.");
		check(await realpath("."), write);
	} finally { await directory.close(); }
}

async function start(): Promise<void> {
	if (process.platform === "win32") denied("Guarded file access requires POSIX directory semantics.");
	if (!same(request.root, await lstat("."))) denied("Directory changed before file access.");
	if (request.parts.some((part) => !part || part === "." || part === ".." || /[\/\\\0]/.test(part))) denied("Invalid path component.");
	const parts = [...request.parts];
	const name = parts.pop() ?? ".";
	// A read may traverse a protected ancestor (e.g. app/data/work); authorize the target.
	check(join(await realpath("."), ...parts, name), write);
	for (const part of parts) await enter(part, request.operation === "write" || (request.operation === "mkdir" && request.recursive === true));
	const actual = join(await realpath("."), name);
	check(actual, write);
	if (request.operation === "mkdir") {
		if (name !== ".") await enter(name, true);
		await send(undefined); process.disconnect!(); return;
	}
	if (request.operation === "exists") {
		try {
			const entry = await lstat(name);
			if (entry.isSymbolicLink()) denied("File changed to a symbolic link.");
			await send(true);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await send(false);
		}
		process.disconnect!(); return;
	}
	if (request.operation === "directory") {
		await enter(name, false);
		const directory = await realpath(".");
		const entries: FileInfo[] = [];
		for (const entry of await readdir(".")) {
			const path = join(directory, entry);
			if (filePathViolation("read", path, request.bases) !== undefined) continue;
			try { entries.push(metadata(await lstat(entry), path)); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		await send(entries); process.disconnect!(); return;
	}
	if (request.operation === "info") {
		const entry = await lstat(name);
		if (entry.isSymbolicLink()) denied("File changed to a symbolic link.");
		await send(metadata(entry, request.path)); process.disconnect!(); return;
	}
	// Opening never truncates. Check the opened inode before any byte is read or changed.
	const flags = constants.O_NOFOLLOW | constants.O_NONBLOCK | (write ? constants.O_RDWR : constants.O_RDONLY);
	try { file = await open(name, flags); }
	catch (error) {
		if (!["write", "append"].includes(request.operation) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		file = await open(name, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
	}
	const stats = await file.stat();
	if (!stats.isFile()) throw Object.assign(new Error("Not a regular file."), { code: stats.isDirectory() ? "EISDIR" : "EINVAL" });
	if (stats.nlink !== 1) denied("Only regular files with one link may be accessed.");
	if (!same(stats, await lstat(name))) denied("File changed while opening it.");
	check(join(await realpath("."), name), write);
	await send(metadata(stats, request.path));
	let chain = Promise.resolve();
	process.on("message", (input: { op: string; offset?: number; length?: number; startLine?: number; endLine?: number; content?: Uint8Array; size?: number }) => {
		chain = chain.then(async () => {
			if (input.op === "close") { await file!.close(); file = undefined; await send(undefined); process.disconnect!(); return; }
			if (input.op === "info") { await send(metadata(await file!.stat(), request.path)); return; }
			if (input.op === "read") {
				const buffer = Buffer.alloc(Math.min(input.length!, 1024 * 1024));
				const { bytesRead } = await file!.read(buffer, 0, buffer.length, input.offset!);
				await send(buffer.subarray(0, bytesRead)); return;
			}
			if (input.op === "scan") {
				const scanner = new LineScanner(input.startLine!, input.endLine);
				const buffer = Buffer.alloc(64 * 1024);
				for (let position = 0;;) {
					const { bytesRead } = await file!.read(buffer, 0, buffer.length, position);
					if (bytesRead === 0) break;
					scanner.push(buffer.subarray(0, bytesRead)); position += bytesRead;
				}
				await send(scanner.finish()); return;
			}
			if (input.op !== request.operation || !write) denied("Unsupported file operation.");
			if (input.op === "truncate") await file!.truncate(input.size!);
			else if (input.op === "flush") await file!.sync();
			else {
				if (input.op === "write") await file!.truncate(0);
				const content = input.content!;
				const start = input.op === "append" ? (await file!.stat()).size : 0;
				for (let position = 0; position < content.length;) {
					const { bytesWritten } = await file!.write(content, position, content.length - position, start + position);
					position += bytesWritten;
				}
			}
			await send(undefined);
		}).catch(fail);
	});
}

process.on("disconnect", () => { void file?.close().finally(() => process.exit()); });
start().catch(fail);
