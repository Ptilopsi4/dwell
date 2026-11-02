// 用户与角色：DWELL_ADMINS / DWELL_ALLOW 播种，data/users.json 为运行时真相（/allow 热更新）。
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { DATA_DIR } from "./harness.ts";

export type Role = "member" | "admin";

export class Users {
	private members = new Set<string>();
	private admins = new Set<string>();
	private file = join(DATA_DIR, "users.json");

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
		} catch {
			await this.save(); // 首次运行：把 env 播种落盘
		}
	}

	private async save(): Promise<void> {
		await writeFile(this.file, JSON.stringify({ members: [...this.members], admins: [...this.admins] }, null, "\t"));
	}

	isAllowed(openId: string): boolean {
		return this.members.has(openId) || this.admins.has(openId);
	}

	isAdmin(openId: string): boolean {
		return this.admins.has(openId);
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
