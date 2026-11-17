import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const MANIFEST = "backup-manifest.json";
const CODE_PATHS = ["src", "eval", "test", "templates", "docs", "README.md", "README.zh-CN.md", "Dockerfile", "docker-compose.yml", "package.json", "package-lock.json", "tsconfig.json"];
type FileRecord = { path: string; mode: number } & ({ bytes: number; sha256: string; type?: never } | { type: "symlink"; target: string });
type Manifest = { version: 1; createdAt: string; stoppedByOperator: true; files: FileRecord[] };
export type BackupOptions = { data: string; state: string; code: string; models: string; env?: string; output: string; stopped: boolean };

function within(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

const workspaceLink = (path: string): boolean => path.startsWith(join("data", "work") + sep);

async function files(root: string, prefix = ""): Promise<FileRecord[]> {
	const result: FileRecord[] = [];
	for (const name of (await readdir(join(root, prefix))).sort()) {
		const path = join(prefix, name);
		if (!prefix && path === MANIFEST) continue;
		const absolute = join(root, path);
		const stat = await lstat(absolute);
		if (stat.isDirectory()) result.push(...await files(root, path));
		else if (stat.isFile()) {
			const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const digest = createHash("sha256");
				for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
				result.push({ path, bytes: stat.size, sha256: digest.digest("hex"), mode: stat.mode & 0o777 });
			} finally { await handle.close(); }
		} else if (stat.isSymbolicLink() && workspaceLink(path)) {
			result.push({ path, type: "symlink", target: await readlink(absolute), mode: stat.mode & 0o777 });
		} else throw new Error(`Backup contains an unsupported file type: ${path}`);
	}
	return result;
}

async function copyTree(source: string, target: string, path = ""): Promise<void> {
	const stat = await lstat(source);
	if (stat.isDirectory()) {
		await mkdir(target, { mode: 0o700 });
		for (const name of await readdir(source)) await copyTree(join(source, name), join(target, name), join(path, name));
	} else if (stat.isFile()) {
		await copyFile(source, target, constants.COPYFILE_EXCL);
		await chmod(target, stat.mode & 0o700);
	} else if (stat.isSymbolicLink() && workspaceLink(path)) {
		// Workspace links are data: preserve their text without accessing the target.
		await symlink(await readlink(source), target);
	} else throw new Error(`Backup refuses symlinks outside data/work and special files: ${source}`);
}

async function sqliteIntegrity(directory: string): Promise<void> {
	// SQLite may create or modify sidecars even during inspection. Check a disposable copy.
	const scratch = await mkdtemp(join(tmpdir(), "dwell-backup-check-"));
	try {
		for (const suffix of ["", "-wal", "-shm"]) {
			try { await copyFile(join(directory, "data", `dwell.sqlite${suffix}`), join(scratch, `dwell.sqlite${suffix}`)); }
			catch (error) { if (suffix && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
		}
		const db = new DatabaseSync(join(scratch, "dwell.sqlite"), { readOnly: true });
		try {
			const rows = db.prepare("PRAGMA integrity_check").all();
			if (rows.length !== 1 || rows[0].integrity_check !== "ok") throw new Error("Backup SQLite integrity check failed");
		} finally { db.close(); }
	} finally { await rm(scratch, { recursive: true, force: true }); }
}

/** The operator must stop every writer first; filesystem copying cannot make a cross-store live snapshot. */
export async function createBackup(options: BackupOptions): Promise<Manifest> {
	if (!options.stopped) throw new Error("Stop the service and all workspace writers before creating a backup; pass --stopped to acknowledge this requirement");
	const [data, state, code] = await Promise.all([options.data, options.state, options.code].map((path) => realpath(path)));
	const output = join(await realpath(dirname(resolve(options.output))), resolve(options.output).split(sep).at(-1)!);
	if ([data, state, code].some((root) => within(output, root))) throw new Error("Backup output must be outside code, data and state directories");
	if (within(data, state) || within(state, data)) throw new Error("Data and state directories must be separate");
	await mkdir(output, { mode: 0o700 });
	await copyTree(data, join(output, "data"), "data");
	await copyTree(state, join(output, "state"), "state");
	await mkdir(join(output, "app"), { mode: 0o700 });
	for (const name of CODE_PATHS) {
		try { await copyTree(join(code, name), join(output, "app", name), join("app", name)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !["src", "package.json", "package-lock.json"].includes(name)) continue; throw error; }
	}
	await copyTree(resolve(options.models), join(output, "models.json"), "models.json");
	if (options.env) await copyTree(resolve(options.env), join(output, ".env"), ".env");
	await sqliteIntegrity(output);
	const manifest: Manifest = { version: 1, createdAt: new Date().toISOString(), stoppedByOperator: true, files: await files(output) };
	await writeFile(join(output, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
	return manifest;
}

export async function verifyBackup(directory: string): Promise<Manifest> {
	const manifest = JSON.parse(await readFile(join(directory, MANIFEST), "utf8")) as Manifest;
	if (manifest.version !== 1 || manifest.stoppedByOperator !== true || !Array.isArray(manifest.files)) throw new Error("Unsupported backup manifest");
	const actual = await files(directory);
	if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error("Backup file list, permissions, symlink targets or SHA-256 checksums do not match the manifest");
	for (const required of ["data/dwell.sqlite", "models.json", "app/package.json", "app/package-lock.json"]) {
		if (!actual.some((file) => file.path === required)) throw new Error(`Backup is missing ${required}`);
	}
	await sqliteIntegrity(directory);
	return manifest;
}

/** Restore to a fresh staging directory only. Starting or replacing a service is an operator action. */
export async function restoreBackup(directory: string, output: string): Promise<Manifest> {
	const manifest = await verifyBackup(directory);
	const source = await realpath(directory);
	const target = join(await realpath(dirname(resolve(output))), resolve(output).split(sep).at(-1)!);
	if (within(target, source)) throw new Error("Restore output must be outside the backup");
	await copyTree(source, target);
	await verifyBackup(target);
	return manifest;
}

async function main(args: string[]): Promise<void> {
	const action = args.shift();
	const flags = new Map<string, string>();
	let stopped = false;
	while (args.length) {
		const flag = args.shift()!;
		if (flag === "--stopped") { stopped = true; continue; }
		if (!flag.startsWith("--") || !args.length || args[0].startsWith("--") || flags.has(flag)) throw new Error(`Invalid argument: ${flag}`);
		flags.set(flag, args.shift()!);
	}
	const required = (key: string): string => { const value = flags.get(key); if (!value) throw new Error(`Missing ${key}`); return value; };
	let manifest: Manifest;
	if (action === "create") manifest = await createBackup({ data: required("--data"), state: required("--state"), code: required("--code"), models: required("--models"), env: flags.get("--env"), output: required("--output"), stopped });
	else if (action === "verify") manifest = await verifyBackup(required("--backup"));
	else if (action === "restore") manifest = await restoreBackup(required("--backup"), required("--output"));
	else throw new Error("Usage: node src/backup.ts create|verify|restore [--data DIR --state DIR --code DIR --models FILE --env FILE --stopped] [--backup DIR] [--output NEW_DIR]");
	console.log(JSON.stringify({ action, files: manifest.files.length, createdAt: manifest.createdAt, verified: true }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv.slice(2)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Backup operation failed"); process.exitCode = 1; });
}
