import { spawn } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { SandboxState } from "./sandbox.ts";

export type SaveUpload = (cwd: string, name: string, data: Buffer) => Promise<void>;

export class UploadError extends Error {
	readonly status: 409 | 500 | 501;
	constructor(status: 409 | 500 | 501, message: string) {
		super(message);
		this.status = status;
	}
}

type DirectoryIdentity = { path: string; dev: string; ino: string };

async function uploadEntry(path: string) {
	try { return await lstat(path, { bigint: true }); }
	catch (err) {
		if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) throw new UploadError(409, "Workspace changed; upload was refused.");
		throw err;
	}
}

// The child owns its cwd; the HTTP/Feishu process must never chdir per request.
// All writes use a newly created fd in a pinned directory, never a checked path.
const WRITER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [rootPath, rootDev, rootIno, name] = process.argv.slice(1);
const identity = (s, dev, ino) => String(s.dev) === dev && String(s.ino) === ino;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
let root, uploads, file, created = false;
(async () => {
  try {
    if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('invalid filename');
    root = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    if (!identity(fs.fstatSync(root, {bigint:true}), rootDev, rootIno)) throw new Error('workspace changed');
    try { fs.mkdirSync('uploads', {mode:0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    uploads = fs.openSync('uploads', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const directory = fs.fstatSync(uploads, {bigint:true});
    process.chdir('uploads');
    if (!same(directory, fs.statSync('.', {bigint:true}))) throw new Error('uploads changed');
    file = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    for await (const chunk of process.stdin) {
      let offset = 0;
      while (offset < chunk.length) offset += fs.writeSync(file, chunk, offset, chunk.length - offset);
    }
    const rootNow = fs.lstatSync(rootPath, {bigint:true});
    const uploadsNow = fs.lstatSync(path.join(rootPath, 'uploads'), {bigint:true});
    const fileNow = fs.lstatSync(name, {bigint:true});
    if (!rootNow.isDirectory() || !identity(rootNow, rootDev, rootIno)
      || !uploadsNow.isDirectory() || !same(directory, uploadsNow)
      || !fileNow.isFile() || !same(fs.fstatSync(file, {bigint:true}), fileNow)) throw new Error('workspace changed');
    fs.closeSync(file); file = undefined;
    process.stdout.write(JSON.stringify({ok:true, directory:{dev:String(directory.dev), ino:String(directory.ino)}, file:{dev:String(fileNow.dev), ino:String(fileNow.ino)}}));
  } catch (e) {
    if (created && file !== undefined) {
      try {
        if (same(fs.fstatSync(file, {bigint:true}), fs.lstatSync(name, {bigint:true}))) fs.unlinkSync(name);
      } catch {}
    }
    process.stdout.write(JSON.stringify({ok:false, code:e.code || 'CHANGED'}));
    process.exitCode = 1;
  } finally {
    for (const fd of [file, uploads, root]) if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
})();`;

/** Registered roots are established before resume, or while creating a workspace. */
export class Uploads {
	private roots = new Map<string, DirectoryIdentity>();
	private constructor(privateRoot: DirectoryIdentity, workRoot: string, sandbox: () => SandboxState) {
		this.base = privateRoot;
		this.workRoot = workRoot;
		this.sandbox = sandbox;
	}
	private base: DirectoryIdentity;
	private workRoot: string;
	private sandbox: () => SandboxState;

	static async open(workRoot: string, sandbox: () => SandboxState): Promise<Uploads> {
		await mkdir(workRoot, { recursive: true });
		const path = await realpath(workRoot);
		const st = await lstat(path, { bigint: true });
		return new Uploads({ path, dev: String(st.dev), ino: String(st.ino) }, resolve(workRoot), sandbox);
	}

	async register(cwd: string): Promise<void> {
		const key = resolve(cwd);
		const entry = relative(this.workRoot, key);
		if (entry === "" || entry === ".." || entry.startsWith(`..${sep}`) || dirname(entry) !== ".") throw new UploadError(409, "Workspace is outside the managed work directory.");
		const base = await lstat(this.base.path, { bigint: true });
		if (!base.isDirectory() || String(base.dev) !== this.base.dev || String(base.ino) !== this.base.ino) throw new UploadError(409, "Managed work directory changed.");
		const path = join(this.base.path, entry);
		await mkdir(path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "EEXIST") throw err; });
		const st = await lstat(path, { bigint: true });
		if (!st.isDirectory()) throw new UploadError(409, "Workspace root must be a directory, not a link.");
		const known = this.roots.get(key);
		if (known !== undefined && (known.dev !== String(st.dev) || known.ino !== String(st.ino))) throw new UploadError(409, "Workspace changed; upload was refused.");
		this.roots.set(key, { path, dev: String(st.dev), ino: String(st.ino) });
	}

	readonly save: SaveUpload = async (cwd, name, data) => {
		if (process.platform === "win32") throw new UploadError(501, "Safe attachment uploads are unavailable on Windows.");
		if (basename(name) !== name || name === "." || name === ".." || /[\\\0]/.test(name)) throw new UploadError(409, "Invalid upload filename.");
		const root = this.roots.get(resolve(cwd));
		if (root === undefined) throw new UploadError(409, "Workspace has not been registered for uploads.");
		try {
			const st = await uploadEntry(root.path);
			if (!st.isDirectory() || String(st.dev) !== root.dev || String(st.ino) !== root.ino) throw new UploadError(409, "Workspace changed; upload was refused.");
			const args = ["--input-type=commonjs", "--eval", WRITER, root.path, root.dev, root.ino, name];
			const sandbox = this.sandbox();
			const child = sandbox.enabled && sandbox.wrapperPath !== undefined
				? spawn(sandbox.wrapperPath, ["-c", 'exec "$@"', "dwell-upload", process.execPath, ...args], { cwd: root.path, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, killSignal: "SIGKILL" })
				: spawn(process.execPath, args, { cwd: root.path, env: {}, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, killSignal: "SIGKILL" });
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				if (output.length > 4096) child.kill("SIGKILL");
			});
			child.stderr.resume();
			child.stdin.on("error", () => {}); // Early rejection closes stdin before the caller finishes sending.
			const code = await new Promise<number | null>((done, reject) => {
				child.once("error", reject);
				child.once("close", done);
				child.stdin.end(data);
			});
			let result: { ok?: boolean; code?: string; directory?: { dev: string; ino: string }; file?: { dev: string; ino: string } };
			try { result = JSON.parse(output); } catch { throw new UploadError(500, "Attachment writer did not complete."); }
			if (code !== 0 || result.ok !== true) {
				const conflict = ["CHANGED", "ELOOP", "ENOTDIR", "EEXIST", "ENOENT"].includes(result.code ?? "");
				throw new UploadError(conflict ? 409 : 500, conflict ? "Workspace or upload target changed; attachment was not saved." : "Attachment could not be saved.");
			}
			// A bind mount can keep the old root visible after the host path is renamed.
			const [rootNow, directoryNow, fileNow] = await Promise.all([root.path, join(root.path, "uploads"), join(root.path, "uploads", name)].map(uploadEntry));
			if (!rootNow.isDirectory() || String(rootNow.dev) !== root.dev || String(rootNow.ino) !== root.ino
				|| !directoryNow.isDirectory() || String(directoryNow.dev) !== result.directory?.dev || String(directoryNow.ino) !== result.directory?.ino
				|| !fileNow.isFile() || String(fileNow.dev) !== result.file?.dev || String(fileNow.ino) !== result.file?.ino) throw new UploadError(409, "Workspace changed; attachment path is no longer available.");
		} catch (err) {
			if (err instanceof UploadError) throw err;
			throw new UploadError(500, "Attachment writer could not run.");
		}
	};
}
