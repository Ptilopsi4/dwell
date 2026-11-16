import { createHash } from "node:crypto";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { getOrThrow, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-durable/env";

export type VerificationContract = {
	checks: { name: string; command: string }[];
	artifacts: string[];
	allowedChanges?: string[];
};
export type ArtifactEntry = { path: string; kind: "file" | "directory" | "missing"; bytes: number; sha256?: string };
export type ArtifactManifest = { cwd: string; entries: ArtifactEntry[]; digest: string; bytes: number };
export type CheckReceipt = { name: string; command: string; taskId: number; exitCode: number | null; isError: boolean };
export type VerificationReceipt = {
	workId: string; taskId: number; checks: CheckReceipt[]; verifiedAt: number;
	manifest: { cwd: string; digest: string; files: number; bytes: number };
};
export type WorkVerification = {
	contract: VerificationContract;
	baseline?: ArtifactManifest;
	status: "unverified" | "verified" | "failed" | "stale";
	receipt?: VerificationReceipt;
	failure?: string;
	lastAttempt?: { taskId: number; checks: CheckReceipt[]; completedAt: number };
};

export const VERIFICATION_MAX_ENTRIES = 1024;
export const VERIFICATION_MAX_BYTES = 16 * 1024 * 1024;

function scopePath(path: string): string {
	if (!path || path.includes("\\") || path.includes("\0") || isAbsolute(path) || path.split("/").includes("..")) throw new Error("Verification paths must be relative to the workspace without '..' or symbolic links");
	const normalized = posix.normalize(path).replace(/\/$/, "");
	if (normalized.length > 1000) throw new Error("Verification path exceeds 1000 characters");
	return normalized;
}

export function verificationContract(value: VerificationContract): VerificationContract {
	const artifacts = [...new Set(value.artifacts.map(scopePath))];
	const allowedChanges = value.allowedChanges?.map(scopePath);
	if (allowedChanges?.some((path) => path === "." || !artifacts.some((scope) => scope === "." || path === scope || path.startsWith(`${scope}/`)))) throw new Error('allowedChanges must contain exact file paths inside the declared artifact scope. List files only, without directories or globs. For example, use artifacts ["job", "job/result.json"] with allowedChanges ["job/result.json"]; the directory captures extra files and the explicit file detects a missing output.');
	if (value.checks.some((check) => !check.name.trim() || !check.command.trim())) throw new Error("Verification checks need nonempty names and commands");
	return { checks: value.checks.map((check) => ({ name: check.name, command: check.command })), artifacts, ...(allowedChanges === undefined ? {} : { allowedChanges: [...new Set(allowedChanges)] }) };
}

/** The caller supplies a governed environment whose final IO boundary has readScope=cwd. */
export async function artifactManifest(env: ExecutionEnv, contract: VerificationContract, context: Context, allowMissing = false): Promise<ArtifactManifest> {
	const cwd = getOrThrow(await env.canonicalPath(env.cwd, context));
	const entries = new Map<string, ArtifactEntry>();
	const reserved = new Set<string>();
	let bytes = 0;
	const reserve = (path: string) => {
		if (path.split("/").length > 64) throw new Error("Verification scope exceeds 64 directory levels");
		if (reserved.has(path)) return;
		if (reserved.size >= VERIFICATION_MAX_ENTRIES) throw new Error(`Verification scope exceeds ${VERIFICATION_MAX_ENTRIES} entries`);
		reserved.add(path);
	};
	const visit = async (path: string): Promise<void> => {
		if (entries.has(path)) return;
		reserve(path);
		const expected = resolve(cwd, path);
		const rel = relative(cwd, expected);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Verification scope escapes the workspace");
		const canonical = await env.canonicalPath(path, context);
		if (!canonical.ok) {
			if (allowMissing && canonical.error.code === "not_found") { entries.set(path, { path, kind: "missing", bytes: 0 }); return; }
			throw canonical.error;
		}
		if (canonical.value !== expected) throw new Error(`Symbolic links are not allowed in verification scope: ${path}`);
		const info = getOrThrow(await env.fileInfo(path, context));
		if (info.kind === "symlink") throw new Error(`Symbolic links are not allowed in verification scope: ${path}`);
		if (info.kind === "directory") {
			entries.set(path, { path, kind: "directory", bytes: 0 });
			const children = new Map<string, FileInfo>();
			const directory = getOrThrow(await env.openDirReader(path, context));
			try {
				for (;;) {
					const page = getOrThrow(await directory.next(Math.min(128, VERIFICATION_MAX_ENTRIES - reserved.size + 1), context));
					for (const child of page.entries) {
						if (!child.name || /[\/\\\0]/.test(child.name) || child.name === "." || child.name === "..") throw new Error("Invalid directory entry in verification scope");
						if (child.kind === "symlink") throw new Error(`Symbolic links are not allowed in verification scope: ${child.name}`);
						const childPath = path === "." ? child.name : `${path}/${child.name}`;
						reserve(childPath);
						children.set(child.name, child);
					}
					if (page.done) break;
				}
			} finally { await directory.close(context); }
			for (const child of [...children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
				await visit(path === "." ? child.name : `${path}/${child.name}`);
			}
			return;
		}
		if (info.size > VERIFICATION_MAX_BYTES - bytes) throw new Error(`Verification scope exceeds ${VERIFICATION_MAX_BYTES} bytes`);
		const reader = getOrThrow(await env.openBinaryReader(path, { noFollow: true }, context));
		try {
			const opened = getOrThrow(await reader.info(context));
			if (opened.path !== expected || opened.kind !== "file") throw new Error(`Verification file changed while opening: ${path}`);
			const hash = createHash("sha256");
			let size = 0;
			for (;;) {
				const chunk = getOrThrow(await reader.read(size, Math.min(64 * 1024, VERIFICATION_MAX_BYTES - bytes - size + 1), context));
				if (chunk.length === 0) break;
				size += chunk.length;
				if (size + bytes > VERIFICATION_MAX_BYTES) throw new Error(`Verification scope exceeds ${VERIFICATION_MAX_BYTES} bytes`);
				hash.update(chunk);
			}
			const after = getOrThrow(await reader.info(context));
			if (size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error(`Verification file changed while reading: ${path}`);
			bytes += size;
			entries.set(path, { path, kind: "file", bytes: size, sha256: hash.digest("hex") });
		} finally { await reader.close(context); }
	};
	for (const path of contract.artifacts) await visit(path);
	const ordered = [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	return { cwd, entries: ordered, bytes, digest: createHash("sha256").update(JSON.stringify(ordered)).digest("hex") };
}

export function unexpectedChanges(baseline: ArtifactManifest, current: ArtifactManifest, allowedChanges: readonly string[]): string[] {
	if (baseline.cwd !== current.cwd) throw new Error("Verification workspace changed since work start");
	const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
	const after = new Map(current.entries.map((entry) => [entry.path, entry]));
	return [...new Set([...before.keys(), ...after.keys()])].filter((path) => {
		const a = before.get(path), b = after.get(path);
		if (JSON.stringify(a) === JSON.stringify(b)) return false;
		if (allowedChanges.includes(path) && (a === undefined || a.kind === "file" || a.kind === "missing") && (b === undefined || b.kind === "file" || b.kind === "missing")) return false;
		const ancestor = allowedChanges.some((allowed) => allowed.startsWith(`${path}/`));
		const absentBefore = a === undefined || a.kind === "missing";
		const absentAfter = b === undefined || b.kind === "missing";
		return !(ancestor && ((absentBefore && b?.kind === "directory") || (a?.kind === "directory" && absentAfter)));
	}).sort();
}

export function manifestSummary(manifest: ArtifactManifest): VerificationReceipt["manifest"] {
	return { cwd: manifest.cwd, digest: manifest.digest, files: manifest.entries.filter((entry) => entry.kind === "file").length, bytes: manifest.bytes };
}
