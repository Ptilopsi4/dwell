import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export type PathBases = { cwd: string; tmp: string; state: string; appRoot: string; data: string; sqlite: string; modelConfig?: string };

const within = (path: string, root: string) => path === root || path.startsWith(root + sep);

/** Inputs are already normalized, and all bases use the same physical namespace. */
export function filePathViolation(tool: string, path: string, bases: PathBases): string | undefined {
	if (path === bases.modelConfig) return "Access to the selected model configuration is not allowed.";
	if (within(path, "/proc") || within(path, bases.state) || path.startsWith(bases.sqlite)
		|| (within(path, bases.appRoot) && !within(path, bases.data))) {
		return tool === "read" ? "Access to state files, the application directory, the database, and /proc is not allowed."
			: "Writes are limited to the session's working directory and system temp; protected state, application files, the database, and /proc are excluded.";
	}
	if (tool === "read" || within(path, bases.cwd) || within(path, bases.tmp)) return undefined;
	return "Writes are limited to this session's working directory and the system temp directory.";
}

/** Resolve missing suffixes without swallowing permission errors or symlink loops. */
export async function physicalPath(path: string): Promise<string> {
	try { return await realpath(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return join(await physicalPath(parent), basename(path));
	}
}

export async function physicalBases(bases: PathBases): Promise<PathBases> {
	const entries = await Promise.all(Object.entries(bases).filter((entry) => entry[1] !== undefined).map(async ([name, path]) => [name, await physicalPath(resolve(path!))]));
	return Object.fromEntries(entries) as PathBases;
}
