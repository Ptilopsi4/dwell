import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { FileError, err, getOrThrow, ok, type BinaryReader, type DirReader, type FileInfo, type FileWatcher, type Result, type TextLineReader, type WatchChange, type WatchTarget } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { filePathViolation, physicalBases, physicalPath, type PathBases } from "./file-policy.ts";
import type { FileRequest } from "./file-worker.ts";

type Reply = { ok: true; value: unknown } | { ok: false; error: { code?: string; message: string } };
const toError = (cause: unknown, path?: string): FileError => {
	if (cause instanceof FileError) return cause;
	const error = cause as NodeJS.ErrnoException;
	const code = error.code === "ENOENT" ? "not_found" : error.code === "ENOTDIR" ? "not_directory"
		: error.code === "EISDIR" ? "is_directory" : error.code === "EINVAL" ? "invalid" : error.code === "ABORT_ERR" ? "aborted"
		: ["EACCES", "EPERM", "ELOOP"].includes(error.code ?? "") ? "permission_denied" : "unknown";
	return new FileError(code, error.message ?? "Guarded file access failed.", path);
};

/** A fixed worker pins cwd and the final fd; subsequent operations never reopen a checked path. */
class FileWorker {
	child: ChildProcess;
	private pending?: { resolve: (reply: Reply) => void; reject: (error: unknown) => void };
	private initial: Promise<Reply>;
	private timer: NodeJS.Timeout;
	private stopped = false;
	constructor(cwd: string, request: FileRequest, onClose: () => void) {
		this.child = fork(new URL("./file-worker.ts", import.meta.url), [JSON.stringify(request)], {
			cwd, env: {}, execArgv: [], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		this.initial = new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
		void this.initial.catch(() => {}); // Cancellation can happen before receive attaches its handler.
		this.timer = setTimeout(() => this.stop(new Error("File operation exceeded 30 seconds.")), 30_000);
		this.child.on("message", (reply: Reply) => { const pending = this.pending; this.pending = undefined; pending?.resolve(reply); });
		this.child.on("error", (error) => this.stop(error));
		this.child.on("exit", () => { this.stop(new Error("File worker exited before completing the operation.")); onClose(); });
	}
	stop(error = new Error("File worker closed.")): void {
		if (this.stopped) return;
		this.stopped = true;
		clearTimeout(this.timer);
		this.pending?.reject(error); this.pending = undefined;
		this.child.kill("SIGKILL");
	}
	async receive<T>(context: Context, command?: object): Promise<Result<T, FileError>> {
		if (context.abortSignal?.aborted) { this.stop(); return err(new FileError("aborted", "File operation aborted.")); }
		const abort = () => this.stop(Object.assign(new Error("File operation aborted."), { code: "ABORT_ERR" }));
		context.abortSignal?.addEventListener("abort", abort, { once: true });
		try {
			let reply: Reply;
			if (command === undefined) reply = await this.initial;
			else {
				if (this.stopped) throw new Error("File worker is closed.");
				reply = await new Promise<Reply>((resolve, reject) => {
					this.pending = { resolve, reject };
					this.child.send(command, (error) => { if (error) this.stop(error); });
				});
			}
			return reply.ok ? ok(reply.value as T) : err(toError(reply.error));
		} catch (error) { return err(toError(error)); }
		finally { context.abortSignal?.removeEventListener("abort", abort); }
	}
}

/** Read one authorized inode with a strict size bound for delivery and panel downloads. */
export async function readWorkspaceFile(path: string, bases: PathBases, maxBytes: number, context: Context): Promise<{ buffer: Buffer; real: string; name: string }> {
	const env = await GuardedExecutionEnv.create({ cwd: bases.cwd }, { ...bases, readScope: bases.cwd });
	try {
		const reader = getOrThrow(await env.openBinaryReader(path, undefined, context));
		try {
			const info = getOrThrow(await reader.info(context));
			if (info.size > maxBytes) throw new FileError("invalid", "File exceeds the 30MB limit.", path);
			const buffer = Buffer.from(getOrThrow(await reader.read(0, maxBytes + 1, context)));
			if (buffer.length > maxBytes) throw new FileError("invalid", "File exceeds the 30MB limit.", path);
			return { buffer, real: info.path, name: info.name };
		} finally { await reader.close(context); }
	} finally { await env.cleanup(context); }
}

export class GuardedExecutionEnv extends NodeExecutionEnv {
	private bases: PathBases;
	private workers = new Set<FileWorker>();
	private constructor(options: ConstructorParameters<typeof NodeExecutionEnv>[0], bases: PathBases) { super(options); this.bases = bases; }
	static async create(options: ConstructorParameters<typeof NodeExecutionEnv>[0], bases: PathBases): Promise<GuardedExecutionEnv> {
		return new GuardedExecutionEnv(options, await physicalBases(bases));
	}

	private async start(path: string, operation: FileRequest["operation"], context: Context, recursive?: boolean): Promise<Result<{ worker: FileWorker; value: unknown }, FileError>> {
		if (process.platform === "win32") return err(new FileError("not_supported", "Guarded file access is unavailable on Windows.", path));
		if (context.abortSignal?.aborted) return err(new FileError("aborted", "File operation aborted.", path));
		try {
			// Use exactly the backend's normalization, after CodingTools has applied its aliases and fallbacks.
			const absolute = await super.absolutePath(path, context);
			if (!absolute.ok) return absolute;
			const target = await physicalPath(absolute.value);
			const mode = ["write", "append", "truncate", "flush", "mkdir"].includes(operation) ? "write" : "read";
			const problem = filePathViolation(mode, target, this.bases);
			if (problem !== undefined) return err(new FileError("permission_denied", problem, path));
			let root = dirname(target);
			for (;;) {
				try { root = await realpath(root); break; }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; root = dirname(root); }
			}
			const identity = await lstat(root);
			if (!identity.isDirectory()) return err(new FileError("not_directory", "File parent is not a directory.", path));
			const parts = relative(root, target).split(sep);
			let worker!: FileWorker;
			worker = new FileWorker(root, { path: target, parts, root: { dev: identity.dev, ino: identity.ino }, bases: this.bases, operation, recursive }, () => this.workers.delete(worker));
			this.workers.add(worker);
			const opened = await worker.receive(context);
			if (!opened.ok) { worker.stop(); return opened; }
			return ok({ worker, value: opened.value });
		} catch (error) { return err(toError(error, path)); }
	}
	private async once<T>(path: string, operation: FileRequest["operation"], context: Context, recursive?: boolean): Promise<Result<T, FileError>> {
		const result = await this.start(path, operation, context, recursive);
		if (!result.ok) return result;
		result.value.worker.stop();
		return ok(result.value.value as T);
	}
	private async mutate(path: string, operation: "write" | "append" | "truncate" | "flush", context: Context, parameters: object = {}): Promise<Result<void, FileError>> {
		const opened = await this.start(path, operation, context);
		if (!opened.ok) return opened;
		try { return await opened.value.worker.receive(context, { op: operation, ...parameters }); }
		finally { opened.value.worker.stop(); }
	}
	override async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		if (options?.noFollow) {
			const absolute = await super.absolutePath(path, context);
			if (!absolute.ok) return absolute;
			try { if ((await lstat(absolute.value)).isSymbolicLink()) return err(new FileError("invalid", "Symbolic links are not allowed.", path)); }
			catch (error) { return err(toError(error, path)); }
		}
		const opened = await this.start(path, "read", context);
		if (!opened.ok) return opened;
		const { worker } = opened.value;
		return ok({
			info: (context) => worker.receive(context, { op: "info" }),
			read: async (offset, length, context) => {
				if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) return err(new FileError("invalid", "Invalid read range.", path));
				const chunks: Uint8Array[] = []; let size = 0;
				while (size < length) {
					const result = await worker.receive<Uint8Array>(context, { op: "read", offset: offset + size, length: length - size });
					if (!result.ok) return result;
					if (result.value.length === 0) break;
					chunks.push(result.value); size += result.value.length;
				}
				return ok(Buffer.concat(chunks));
			},
			scanLines: (options, context) => worker.receive(context, { op: "scan", ...options }),
			close: async () => worker.stop(),
		});
	}
	override async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const opened = await this.openBinaryReader(path, undefined, context);
		if (!opened.ok) return opened;
		try {
			const info = await opened.value.info(context);
			return info.ok ? await opened.value.read(0, info.value.size, context) : info;
		} finally { await opened.value.close(context); }
	}
	override async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const result = await this.readBinaryFile(path, context);
		return result.ok ? ok(new TextDecoder().decode(result.value)) : result;
	}
	override async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const opened = await this.openBinaryReader(path, undefined, context);
		if (!opened.ok) return opened;
		const reader = opened.value, decoder = new TextDecoder();
		let position = 0, pending = "", ended = false;
		return ok({ readLine: async (context) => {
			for (;;) {
				const newline = pending.indexOf("\n");
				if (newline !== -1) { const text = pending.slice(0, newline); pending = pending.slice(newline + 1); return ok({ text, terminated: true }); }
				if (ended) { const text = pending; pending = ""; return ok(text === "" ? undefined : { text, terminated: false }); }
				const chunk = await reader.read(position, 64 * 1024, context);
				if (!chunk.ok) return chunk;
				position += chunk.value.length;
				ended = chunk.value.length === 0;
				pending += ended ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
			}
		}, close: (context) => reader.close(context) });
	}
	override async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (lines.length < (options?.maxLines ?? Infinity)) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				if (line.value === undefined) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally { await opened.value.close(context); }
	}
	override writeFile(path: string, content: string | Uint8Array, context: Context) { return this.mutate(path, "write", context, { content: typeof content === "string" ? Buffer.from(content) : content }); }
	override appendFile(path: string, content: string | Uint8Array, context: Context) { return this.mutate(path, "append", context, { content: typeof content === "string" ? Buffer.from(content) : content }); }
	override truncateFile(path: string, size: number, context: Context) { return this.mutate(path, "truncate", context, { size }); }
	override flushFile(path: string, context: Context) { return this.mutate(path, "flush", context); }
	override fileInfo(path: string, context: Context) { return this.once<FileInfo>(path, "info", context); }
	override async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const canonical = await this.canonicalPath(path, context);
		return canonical.ok ? ok(true) : canonical.error.code === "not_found" ? ok(false) : canonical;
	}
	override listDir(path: string, context: Context) { return this.once<FileInfo[]>(path, "directory", context); }
	override createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) { return this.once<void>(path, "mkdir", context, options?.recursive); }
	override async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		try {
			const absolute = await super.absolutePath(path, context);
			if (!absolute.ok) return absolute;
			const target = await physicalPath(absolute.value);
			const problem = filePathViolation("read", target, this.bases);
			if (problem !== undefined) return err(new FileError("permission_denied", problem, path));
			// Canonicalization only supplies a queue key or fallback candidate. Byte access rechecks in the pinned worker.
			return ok(await realpath(target));
		} catch (error) { return err(toError(error, path)); }
	}
	override async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const result = await this.listDir(path, context);
		if (!result.ok) return result;
		let cursor = 0;
		return ok({ next: async (maxEntries) => { const entries = result.value.slice(cursor, cursor + maxEntries); cursor += entries.length; return ok({ entries, done: cursor >= result.value.length }); }, close: async () => {} });
	}
	override async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const path = join(this.bases.tmp, `${basename(prefix ?? "dwell-")}${randomUUID()}`);
		const result = await this.createDir(path, undefined, context);
		return result.ok ? ok(path) : result;
	}
	override async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		const path = join(this.bases.tmp, `${basename(options?.prefix ?? "dwell-")}${randomUUID()}${basename(options?.suffix ?? "")}`);
		const result = await this.writeFile(path, "", context);
		return result.ok ? ok(path) : result;
	}
	// CodingTools does not use these capabilities. Never fall back to unchecked host mutations.
	override async renameFile(_source: string, _destination: string, _context: Context): Promise<Result<void, FileError>> { return err(new FileError("not_supported", "Guarded rename is unavailable; use the sandboxed shell.")); }
	override async remove(_path: string, _options: { recursive?: boolean; force?: boolean } | undefined, _context: Context): Promise<Result<void, FileError>> { return err(new FileError("not_supported", "Guarded removal is unavailable; use the sandboxed shell.")); }
	override async watch(_targets: readonly WatchTarget[], _onChange: (change: WatchChange) => void, _context: Context): Promise<Result<FileWatcher, FileError>> { return err(new FileError("not_supported", "Guarded watches are unavailable.")); }
	override async cleanup(context: Context): Promise<void> { for (const worker of this.workers) worker.stop(); await super.cleanup(context); }
}
