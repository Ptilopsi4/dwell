// 用户与角色：DWELL_ADMINS / DWELL_ALLOW 播种，state/users.json 为运行时真相（/allow 热更新）。
import { readFile } from "node:fs/promises";
import { stateFile, writeStateJson } from "./state.ts";

export type Role = "member" | "admin";

const COMMAND_HISTORY_LIMIT = 10_000;
type SavedUsers = { members: string[]; admins: string[]; appliedCommands?: string[]; blocked?: string[] };

function parseSavedUsers(value: unknown): SavedUsers {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("users.json 必须是用户权限对象。");
	const saved = value as Record<string, unknown>;
	for (const field of ["members", "admins", "appliedCommands", "blocked"] as const) {
		if (saved[field] === undefined && (field === "appliedCommands" || field === "blocked")) continue;
		if (!Array.isArray(saved[field]) || !saved[field].every((id) => typeof id === "string")) {
			throw new Error(`users.json 的 ${field} 必须是字符串数组。`);
		}
	}
	const users = saved as SavedUsers;
	const blocked = new Set(users.blocked ?? []);
	if (users.members.some((id) => blocked.has(id)) || users.admins.some((id) => blocked.has(id))) {
		throw new Error("users.json 的用户不能同时拥有角色并被封禁。");
	}
	return users;
}

export class Users {
	private members = new Set<string>();
	private admins = new Set<string>();
	private blocked = new Set<string>();
	private appliedCommands = new Set<string>();
	private file = stateFile("users.json");
	private changeChain: Promise<void> = Promise.resolve();

	constructor() {
		for (const id of (process.env.DWELL_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
			this.members.add(id);
		}
		for (const id of (process.env.DWELL_ADMINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
			this.admins.add(id);
		}
	}

	async load(): Promise<void> {
		try {
			const saved = parseSavedUsers(JSON.parse(await readFile(this.file, "utf8")));
			const members = new Set(saved.members);
			const admins = new Set(saved.admins);
			const blocked = new Set(saved.blocked ?? []);
			const appliedCommands = new Set((saved.appliedCommands ?? []).slice(-COMMAND_HISTORY_LIMIT));
			// users.json 是运行时真相：存在即整体覆盖 env 播种
			this.members = members;
			this.admins = admins;
			this.blocked = blocked;
			this.appliedCommands = appliedCommands;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			await this.save();
		}
	}

	private async save(members = this.members, admins = this.admins, blocked = this.blocked, appliedCommands = this.appliedCommands): Promise<void> {
		await writeStateJson(this.file, { members: [...members], admins: [...admins], blocked: [...blocked], appliedCommands: [...appliedCommands] });
	}

	private change(change: (members: Set<string>, admins: Set<string>, blocked: Set<string>) => void, requestId?: string): Promise<void> {
		const run = async (): Promise<void> => {
			if (requestId !== undefined && this.appliedCommands.has(requestId)) return;
			// Snapshot after preceding writes commit; publish roles and replay receipts together.
			const members = new Set(this.members);
			const admins = new Set(this.admins);
			const blocked = new Set(this.blocked);
			const appliedCommands = new Set(this.appliedCommands);
			change(members, admins, blocked);
			if (requestId !== undefined) {
				appliedCommands.add(requestId);
				if (appliedCommands.size > COMMAND_HISTORY_LIMIT) appliedCommands.delete(appliedCommands.values().next().value!);
			}
			await this.save(members, admins, blocked, appliedCommands);
			this.members = members;
			this.admins = admins;
			this.blocked = blocked;
			this.appliedCommands = appliedCommands;
		};
		const result = this.changeChain.then(run, run);
		this.changeChain = result.catch(() => {});
		return result;
	}

	commandApplied(id: string): boolean {
		return this.appliedCommands.has(id);
	}

	isAllowed(openId: string): boolean {
		return this.members.has(openId) || this.admins.has(openId);
	}

	isAdmin(openId: string): boolean {
		return this.admins.has(openId);
	}

	isBlocked(openId: string): boolean {
		return this.blocked.has(openId);
	}

	adminCount(): number {
		return this.admins.size;
	}

	list(): { id: string; role: Role }[] {
		// 管理员可能只在 admins 里（DWELL_ADMINS 播种），两集合取并
		return [...new Set([...this.admins, ...this.members])].map((id) => ({ id, role: this.admins.has(id) ? ("admin" as const) : ("member" as const) }));
	}

	async add(openId: string, role: Role, requestId?: string): Promise<void> {
		await this.change((members, admins, blocked) => {
			blocked.delete(openId);
			members.add(openId);
			if (role === "admin") admins.add(openId);
		}, requestId);
	}

	async remove(openId: string, requestId?: string, protectLastAdmin = false): Promise<void> {
		await this.change((members, admins, blocked) => {
			if (protectLastAdmin && admins.has(openId) && admins.size <= 1) throw new Error("无法移除最后一名管理员（会自锁）。");
			members.delete(openId);
			admins.delete(openId);
			blocked.add(openId);
		}, requestId);
	}
}
