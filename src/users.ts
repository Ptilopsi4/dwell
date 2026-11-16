// 用户与角色：DWELL_ADMINS / DWELL_ALLOW 播种，state/users.json 为运行时真相（/allow 热更新）。
import { readFile } from "node:fs/promises";
import { stateFile, writeStateJson } from "./state.ts";

export type Role = "member" | "admin";

const COMMAND_HISTORY_LIMIT = 10_000;
type SavedUsers = { members?: string[]; admins?: string[]; appliedCommands?: string[] };

export class Users {
	private members = new Set<string>();
	private admins = new Set<string>();
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
			const saved = JSON.parse(await readFile(this.file, "utf8")) as SavedUsers;
			const members = new Set(saved.members ?? []);
			const admins = new Set(saved.admins ?? []);
			const appliedCommands = new Set((saved.appliedCommands ?? []).slice(-COMMAND_HISTORY_LIMIT));
			// users.json 是运行时真相：存在即整体覆盖 env 播种
			this.members = members;
			this.admins = admins;
			this.appliedCommands = appliedCommands;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[dwell] users.json 损坏，角色回退为 env 播种:", err);
			await this.save(); // 首次运行或损坏：把 env 播种落盘
		}
	}

	private async save(members = this.members, admins = this.admins, appliedCommands = this.appliedCommands): Promise<void> {
		await writeStateJson(this.file, { members: [...members], admins: [...admins], appliedCommands: [...appliedCommands] });
	}

	private change(change: (members: Set<string>, admins: Set<string>) => void, requestId?: string): Promise<void> {
		const run = async (): Promise<void> => {
			if (requestId !== undefined && this.appliedCommands.has(requestId)) return;
			// Snapshot after preceding writes commit; publish roles and replay receipts together.
			const members = new Set(this.members);
			const admins = new Set(this.admins);
			const appliedCommands = new Set(this.appliedCommands);
			change(members, admins);
			if (requestId !== undefined) {
				appliedCommands.add(requestId);
				if (appliedCommands.size > COMMAND_HISTORY_LIMIT) appliedCommands.delete(appliedCommands.values().next().value!);
			}
			await this.save(members, admins, appliedCommands);
			this.members = members;
			this.admins = admins;
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

	adminCount(): number {
		return this.admins.size;
	}

	list(): { id: string; role: Role }[] {
		// 管理员可能只在 admins 里（DWELL_ADMINS 播种），两集合取并
		return [...new Set([...this.admins, ...this.members])].map((id) => ({ id, role: this.admins.has(id) ? ("admin" as const) : ("member" as const) }));
	}

	async add(openId: string, role: Role, requestId?: string): Promise<void> {
		await this.change((members, admins) => {
			members.add(openId);
			if (role === "admin") admins.add(openId);
		}, requestId);
	}

	async remove(openId: string, requestId?: string, protectLastAdmin = false): Promise<void> {
		await this.change((members, admins) => {
			if (protectLastAdmin && admins.has(openId) && admins.size <= 1) throw new Error("无法移除最后一名管理员（会自锁）。");
			members.delete(openId);
			admins.delete(openId);
		}, requestId);
	}
}
