// 飞书通讯录查询：open_id → 用户名、chat_id → 群名，供 panel 显示。
// 需要应用开通 contact:user.base:readonly（或 contact:user.basic_profile:readonly）与 im:chat:readonly；
// 未开通时查询返回空，panel 回退显示 ID。
import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";

type Cached = { name: string | undefined; at: number };

const HIT_TTL = 6 * 3600_000;
const MISS_TTL = 10 * 60_000;

// SDK 默认 logger 在请求失败时打印完整 axios 请求（含 Authorization 头），这里只留一行摘要
const quietLogger = {
	error: () => {},
	warn: () => {},
	info: () => {},
	debug: () => {},
	trace: () => {},
};

export class Directory {
	private client: Client | undefined;
	private users = new Map<string, Cached>();
	private chats = new Map<string, Cached>();
	private inflight = new Map<string, Promise<string | undefined>>();
	private warned = new Set<string>();

	constructor(appId: string | undefined, appSecret: string | undefined) {
		this.client = appId && appSecret ? new Client({ appId, appSecret, logger: quietLogger, loggerLevel: LoggerLevel.fatal }) : undefined;
	}

	async userName(openId: string): Promise<string | undefined> {
		return this.lookup(this.users, `u:${openId}`, openId, async (client) => {
			const r = await client.contact.v3.user.get({ path: { user_id: openId }, params: { user_id_type: "open_id" } });
			const user = r.data?.user;
			// 昵称优先（与聊天内提及显示一致），无昵称回退本名
			const name = user?.nickname || user?.name || undefined;
			// 缺字段权限时接口仍返回 code=0，只是不带 name
			if (name === undefined && !this.warned.has("u:noname")) {
				this.warned.add("u:noname");
				console.error("[dwell] 飞书用户名为空：应用可能未开通 contact:user.base:readonly");
			}
			return name;
		});
	}

	async chatName(chatId: string): Promise<string | undefined> {
		return this.lookup(this.chats, `c:${chatId}`, chatId, async (client) => {
			const r = await client.im.v1.chat.get({ path: { chat_id: chatId } });
			return r.data?.name || undefined;
		});
	}

	/** 批量查用户名，返回查到的部分。 */
	async userNames(openIds: readonly string[]): Promise<Record<string, string>> {
		const out: Record<string, string> = {};
		await Promise.all(
			[...new Set(openIds)].map(async (id) => {
				const name = await this.userName(id);
				if (name !== undefined) out[id] = name;
			}),
		);
		return out;
	}

	private async lookup(
		cache: Map<string, Cached>,
		key: string,
		id: string,
		fetch: (client: Client) => Promise<string | undefined>,
	): Promise<string | undefined> {
		if (this.client === undefined || id === "") return undefined;
		const hit = cache.get(id);
		if (hit !== undefined && Date.now() - hit.at < (hit.name === undefined ? MISS_TTL : HIT_TTL)) return hit.name;
		const pending = this.inflight.get(key);
		if (pending !== undefined) return pending;
		const client = this.client;
		const p = fetch(client)
			.catch((err: unknown) => {
				const e = err as { response?: { data?: { code?: number; msg?: string } } };
				const code = e.response?.data?.code;
				const tag = `${key.slice(0, 1)}:${code ?? "?"}`;
				if (!this.warned.has(tag)) {
					this.warned.add(tag);
					console.error(`[dwell] 飞书${key.startsWith("u:") ? "用户" : "群"}名查询失败（code=${code ?? "?"}）:`, e.response?.data?.msg ?? String(err).slice(0, 160));
				}
				return undefined;
			})
			.then((name) => {
				cache.set(id, { name, at: Date.now() });
				this.inflight.delete(key);
				return name;
			});
		this.inflight.set(key, p);
		return p;
	}
}
