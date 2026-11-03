// Panel HTTP 服务：token 准入（内网穿透直连场景），SSE 推流（transcript + live 状态），静态页面。
// SSE 帧：mode=append 只带新 entries；活动 entries 前缀变化（reset/compaction/重连首帧）时 mode=replace 带全量。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness, Submission } from "@earendil-works/pi-durable";
import { MODEL } from "../harness.ts";
import { approvalDecision, pendingApprovals, runSender, runVia, type PendingApproval } from "../ext/approval.ts";
import type { Sessions } from "../sessions.ts";
import type { Users } from "../users.ts";
import type { Directory } from "../feishu/directory.ts";

interface PanelOptions {
	harness: Harness;
	sessions: Sessions;
	users: Users;
	directory: Directory;
	feishu: FeishuBridge;
	port: number;
	token: string;
}

/** panel 操作飞书会话所需的飞书侧动作，由主程序提供（未连飞书时 relay 报错、其余空操作）。 */
export interface FeishuBridge {
	/** panel 操作者 open_id */
	operator(): string;
	operatorName(): Promise<string>;
	/** 以操作者身份把消息发到会话所在 chat，并像飞书消息一样由 bot 流式回复 */
	relay(conversation: Conversation, text: string): Promise<void>;
	/** 向会话所在 chat 发一条通知；没有 chat 的会话忽略 */
	notice(conversationId: number, text: string): Promise<void>;
	/** panel 做出审批决定后：同步飞书卡片，续跑结果回复到卡片下 */
	afterDecision(conversation: Conversation, pending: PendingApproval, action: "approve" | "deny", minutes: number, submission: Submission): Promise<void>;
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (body.length > 100_000) throw new HttpError(413, "body too large");
	}
	if (body === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new HttpError(400, "bad json");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "bad json");
	return parsed as Record<string, unknown>;
}

/** pi.live 中 panel 用到的部分（完整定义见 pi-durable LiveState）。 */
type LiveDoc = {
	run?: unknown;
	generation?: { message?: { content?: { type: string; text?: string }[] }; retry?: { error: string } };
	tools?: { callId: string; name: string; status: string }[];
};
type UsageDoc = { models?: Record<string, { totalTokens?: number; cost?: { total?: number } }> };
type AgentDoc = { model?: { provider: string; modelId: string } };

/** 通讯录查询不阻塞列表：超时即返回未解析，下一轮轮询命中缓存。 */
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
	Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

export function startPanel({ harness, sessions, users, directory, feishu, port, token }: PanelOptions): void {
	const panelFile = join(dirname(fileURLToPath(import.meta.url)), "panel.html");
	const vendorDir = join(dirname(fileURLToPath(import.meta.url)), "vendor");
	const MIME: Record<string, string> = {
		css: "text/css; charset=utf-8",
		js: "text/javascript; charset=utf-8",
	};

	const tokenDigest = digest(token);

	/** 会话显示名：手动重命名优先；飞书会话按 key 结构组合群名/用户名；查不到返回 null，由前端回退。 */
	async function titleOf(c: { key: string; owner: string; name: string; type: string }): Promise<string | null> {
		if (c.name !== c.key || c.type === "panel") return c.name;
		const [chatId = "", rest] = c.key.split("#");
		if (c.type === "direct") return (await directory.userName(c.owner)) ?? null;
		const [chat, user] = await Promise.all([directory.chatName(chatId), c.type === "group" ? directory.userName(c.owner) : Promise.resolve(undefined)]);
		if (chat === undefined && user === undefined) return null;
		const tail = c.type === "thread" ? `话题 ${String(rest ?? "").slice(2, 10)}` : (user ?? c.owner.slice(0, 10));
		return `${chat ?? "群聊"} · ${tail}`;
	}
	const COOKIE = "dwell_panel";
	const cookieToken = (req: IncomingMessage): string | undefined => {
		const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`).exec(req.headers.cookie ?? "");
		if (m === null) return undefined;
		try { return decodeURIComponent(m[1] ?? ""); } catch { return undefined; }
	};
	// 首次 ?token= 进入后换发 HttpOnly cookie，页面随即把 token 从地址栏移除；SameSite=Strict 挡跨站请求
	const authed = (req: IncomingMessage, url: URL): boolean => {
		const t = url.searchParams.get("token") ?? req.headers["x-panel-token"] ?? cookieToken(req);
		return typeof t === "string" && timingSafeEqual(digest(t), tokenDigest);
	};

	const json = (res: ServerResponse, code: number, body: unknown): void => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};

	// 未捕获的 rejection 会终止整个进程（飞书 bot 同进程），所有请求错误在此收口
	const server = createServer((req, res) => {
		handle(req, res).catch((err: unknown) => {
			const status = err instanceof HttpError ? err.status : 500;
			if (status === 500) console.error("[dwell] panel 请求失败:", req.method, req.url?.split("?")[0], err);
			if (res.headersSent) res.end();
			else json(res, status, { error: err instanceof Error ? err.message : String(err) });
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		// vendor 静态资源（UI 库）免 token：内容无敏感性，页面本体仍受保护
		if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
			const rel = url.pathname.slice("/vendor/".length);
			if (!/^[\w.-]+\.(css|js)$/.test(rel)) { json(res, 400, { error: "bad asset" }); return; }
			try {
				const asset = await readFile(join(vendorDir, rel));
				res.writeHead(200, { "content-type": MIME[rel.split(".").pop() ?? ""] ?? "application/octet-stream", "cache-control": "public, max-age=86400" });
				res.end(asset);
			} catch { json(res, 404, { error: "asset not found" }); }
			return;
		}
		if (!authed(req, url)) {
			json(res, 401, { error: "unauthorized" });
			return;
		}
		if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			void readFile(panelFile, "utf8")
				.then((html) => {
					res.writeHead(200, {
						"content-type": "text/html; charset=utf-8",
						"cache-control": "no-store",
						"referrer-policy": "no-referrer",
						"set-cookie": `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
					});
					res.end(html);
				})
				.catch(() => json(res, 500, { error: "panel missing" }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/conversations") {
			let list = [...sessions.listConversations()];
			if (list.length === 0) {
				// 本地/空库兑底：root 会话总可用（带默认模型）
				const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: MODEL } });
				list = [{ id: root.id as number, key: "root", owner: "", name: "root", archived: false, type: "panel", lastTs: 0, chatId: null }];
			}
			const titled = await within(Promise.all(list.map(async (c) => ({ ...c, title: await titleOf(c) }))), 2500);
			json(res, 200, titled ?? list);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/me") {
			json(res, 200, { id: feishu.operator(), name: await within(feishu.operatorName(), 2500) ?? null });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/approvals") {
			// 待审队列（等人事项优先展示，借 dsh panel 哲学）
			const list = [...pendingApprovals.entries()].map(([key, p]) => ({ key, ...p }));
			json(res, 200, list);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/users") {
			const list = users.list();
			const names = (await within(directory.userNames(list.map((u) => u.id)), 2500)) ?? {};
			json(res, 200, list.map((u) => ({ ...u, name: names[u.id] ?? null })));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/names") {
			const ids = (url.searchParams.get("ids") ?? "").split(",").filter((id) => /^ou_\w+$/.test(id)).slice(0, 50);
			json(res, 200, (await within(directory.userNames(ids), 2500)) ?? {});
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/conversations") {
			// 新建 panel 会话
			const body = await readBody(req);
			const name = String(body?.name ?? "").trim().slice(0, 40) || `panel-${new Date().toISOString().slice(11, 19)}`;
			const conv = await sessions.createPanelConversation(name);
			json(res, 200, { id: conv.id });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/rename") {
			const body = await readBody(req);
			const name = String(body?.name ?? "").trim().slice(0, 40);
			if (name === "") throw new HttpError(400, "name required");
			await sessions.rename(Number(body?.id), name);
			json(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/archive") {
			const body = await readBody(req);
			await sessions.setArchived(Number(body?.id), Boolean(body?.archived));
			json(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/reset") {
			const conv = await convFromBody(req);
			if (conv === undefined) { json(res, 404, { error: "conversation not found" }); return; }
			await conv.reset(undefined, BACKGROUND_CONTEXT);
			void feishu.notice(conv.id as number, `${await feishu.operatorName()} 在 panel 清空了这条任务线的上下文，之后的消息从新对话开始。`);
			json(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/abort") {
			const conv = await convFromBody(req);
			if (conv === undefined) { json(res, 404, { error: "conversation not found" }); return; }
			await conv.abort(BACKGROUND_CONTEXT);
			void feishu.notice(conv.id as number, `${await feishu.operatorName()} 在 panel 中止了当前任务。`);
			json(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/approve") {
			const body = await readBody(req);
			const key = String(body?.key ?? "");
			const convId = Number(key.split(":")[0]);
			const conv = Number.isFinite(convId) ? await harness.conversation(convId as ConversationId, BACKGROUND_CONTEXT) : undefined;
			if (conv === undefined) { json(res, 404, { error: "conversation not found" }); return; }
			const action = body?.action === "deny" ? "deny" : "approve";
			const minutes = Number(body?.minutes ?? 10);
			const result = await approvalDecision(conv, key, action, minutes);
			if (!result.ok) { json(res, 200, result); return; }
			await feishu.afterDecision(conv, result.pending, action, minutes, result.submission);
			json(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/users") {
			const body = await readBody(req);
			const id = String(body?.id ?? "");
			if (!id.startsWith("ou_")) { json(res, 400, { error: "bad open_id" }); return; }
			const action = String(body?.action ?? "");
			if (action === "remove") {
				if (users.isAdmin(id) && users.adminCount() <= 1) throw new HttpError(409, "无法移除最后一名管理员");
				await users.remove(id);
			} else await users.add(id, body?.role === "admin" ? "admin" : "member");
			json(res, 200, { ok: true });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/events") {
			await handleEvents(url, res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/send") {
			await handleSend(req, res);
			return;
		}
		json(res, 404, { error: "not found" });
	}

	async function handleEvents(url: URL, res: ServerResponse): Promise<void> {
		const convId = Number(url.searchParams.get("conv"));
		const conversation = Number.isFinite(convId) ? await harness.conversation(convId as ConversationId, BACKGROUND_CONTEXT) : undefined;
		if (conversation === undefined) {
			json(res, 404, { error: "conversation not found" });
			return;
		}
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		// close 先于 viewState 挂上：客户端在 attach 期间断开时也能释放订阅
		let closed = false;
		const cleanups: (() => void)[] = [];
		res.on("close", () => {
			closed = true;
			for (const fn of cleanups) fn();
		});
		const view = await conversation.viewState(BACKGROUND_CONTEXT);
		cleanups.push(() => view.dispose());
		if (closed) {
			view.dispose();
			return;
		}
		let sent: string[] = [];
		const frame = (): void => {
			if (closed) return;
			const v = view.value as unknown as { entries: { id: unknown }[]; docs?: Record<string, unknown> };
			const ids = v.entries.map((e) => String(e.id));
			const append = sent.length > 0 && sent.length <= ids.length && ids[0] === sent[0] && ids[sent.length - 1] === sent[sent.length - 1];
			const entries = append ? v.entries.slice(sent.length) : v.entries;
			const live = v.docs?.["pi.live"] as LiveDoc | undefined;
			const slim = live?.run === undefined ? null : {
				tools: (live.tools ?? []).map((t) => ({ callId: t.callId, name: t.name, status: t.status })),
				text: (live.generation?.message?.content ?? []).flatMap((c) => (c.type === "text" && c.text !== undefined ? [c.text] : [])).join(""),
				retry: live.generation?.retry?.error,
			};
			sent = ids;
			const usage = Object.values((v.docs?.["pi.usage"] as UsageDoc | undefined)?.models ?? {});
			const model = (v.docs?.["pi.agent"] as AgentDoc | undefined)?.model;
			const meta = {
				model: model === undefined ? null : `${model.provider}/${model.modelId}`,
				tokens: usage.reduce((n, u) => n + (u.totalTokens ?? 0), 0),
				cost: usage.reduce((n, u) => n + (u.cost?.total ?? 0), 0),
			};
			res.write(`event: sync\ndata: ${JSON.stringify({ mode: append ? "append" : "replace", entries, live: slim, meta })}\n\n`);
		};
		frame();
		cleanups.push(view.subscribe(frame));
		// 心跳保活（穿透链路）
		const beat = setInterval(() => res.write(": ping\n\n"), 25_000);
		cleanups.push(() => clearInterval(beat));
	}

	async function convFromBody(req: IncomingMessage): Promise<Conversation | undefined> {
		const body = await readBody(req);
		const id = Number(body?.conv ?? body?.id);
		if (!Number.isFinite(id)) return undefined;
		return harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
	}

	async function handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readBody(req);
		const conv = Number(body?.conv);
		const content = body?.content;
		if (!Number.isFinite(conv) || typeof content !== "string" || content.trim() === "") throw new HttpError(400, "bad request");
		const conversation = await harness.conversation(conv as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) {
			json(res, 404, { error: "conversation not found" });
			return;
		}
		sessions.touchActivity(conversation.id);
		const id = conversation.id as number;
		const inFeishu = sessions.chatOf(id) !== undefined;
		if (inFeishu && body?.mode !== "note") {
			await feishu.relay(conversation, content);
			json(res, 200, { ok: true, via: "feishu" });
			return;
		}
		if (inFeishu) {
			// 内部指令：只进模型上下文，不触发 run、不发飞书；运行中在下一个边界生效
			await conversation.submit({
				type: "write",
				requestId: `panel-note-${Date.now()}`,
				entry: {
					kind: "panel.note",
					data: { sender: feishu.operator(), senderName: "管理员" },
					model: [{ role: "user", content: `（panel 管理员的公开补充说明：这条说明是任务背景的一部分，正常按内容处理即可。）\n${content}`, timestamp: Date.now() }],
				},
			}, BACKGROUND_CONTEXT);
			json(res, 200, { ok: true, via: "note" });
			return;
		}
		runSender.set(id, feishu.operator());
		runVia.set(id, "panel");
		const submission = await conversation.submit(
			{ type: "input", content, requestId: `panel-${Date.now()}`, whenBusy: "steer", entry: { kind: "panel.message", data: { sender: feishu.operator(), via: "panel" } } },
			BACKGROUND_CONTEXT,
		);
		void submission.wait(BACKGROUND_CONTEXT).catch(() => {});
		json(res, 200, { ok: true, via: "panel" });
	}

	server.listen(port, "0.0.0.0", () => {
		console.log(`[dwell] panel: http://0.0.0.0:${port}/?token=<DWELL_PANEL_TOKEN>`);
	});
}

export type { Conversation };
