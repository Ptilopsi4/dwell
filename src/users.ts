// 用户与角色：DWELL_ADMINS / DWELL_ALLOW 播种，state/users.json 为运行时真相（/allow 热更新）。
import { readFile } from "node:fs/promises";
import { stateFile, writeStateJson } from "./state.ts";

export type Role = "member" | "admin";

export class Users {
	private members = new Set<string>();
	private admins = new Set<string>();
	private file = stateFile("users.json");

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
			const saved = JSON.parse(await readFile(this.file, "utf8")) as { members?: string[]; admins?: string[] };
			// users.json 是运行时真相：存在即整体覆盖 env 播种
			this.members = new Set(saved.members ?? []);
			this.admins = new Set(saved.admins ?? []);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[dwell] users.json 损坏，角色回退为 env 播种:", err);
			await this.save(); // 首次运行或损坏：把 env 播种落盘
		}
	}

	private async save(): Promise<void> {
		await writeStateJson(this.file, { members: [...this.members], admins: [...this.admins] });
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

	async add(openId: string, role: Role): Promise<void> {
		this.members.add(openId);
		if (role === "admin") this.admins.add(openId);
		await this.save();
	}

	async remove(openId: string): Promise<void> {
		this.members.delete(openId);
		this.admins.delete(openId);
		await this.save();
	}
}
