// Panel HTTP 服务：token 准入（内网穿透直连场景），SSE 推流（transcript + live 状态），静态页面。
// 协议简化：SSE 每帧全量 sync（活动 entries + live 概要），panel 按 id 增量渲染。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness } from "@earendil-works/pi-durable";
import { MODEL } from "../harness.ts";
import { approvals, approvalDecision, pendingApprovals } from "../ext/approval.ts";
import type { Sessions } from "../sessions.ts";
import type { Users } from "../users.ts";

interface PanelOptions {
	harness: Harness;
	sessions: Sessions;
	users: Users;
	port: number;
	token: string;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (body.length > 100_000) throw new Error("body too large");
	}
	return body === "" ? undefined : (JSON.parse(body) as Record<string, unknown>);
}

export function startPanel({ harness, sessions, users, port, token }: PanelOptions): void {
	const panelFile = join(dirname(fileURLToPath(import.meta.url)), "panel.html");

	const authed = (req: IncomingMessage, url: URL): boolean => {
		const t = url.searchParams.get("token") ?? req.headers["x-panel-token"];
		return t === token;
	};

	const json = (res: ServerResponse, code: number, body: unknown): void => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};

	const server = createServer((req, res) => {
		void handle(req, res);
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (!authed(req, url)) {
			json(res, 401, { error: "unauthorized" });
			return;
		}
		if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			void readFile(panelFile, "utf8")
				.then((html) => {
					res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
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
				list = [{ id: root.id as number, key: "root", owner: "", name: "root", archived: false, type: "panel" }];
			}
			json(res, 200, list);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/approvals") {
			// 待审队列（等人事项优先展示，借 dsh panel 哲学）
			const list = [...pendingApprovals.entries()].map(([key, p]) => ({ key, ...p }));
			json(res, 200, list);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/users") {
			json(res, 200, users.list());
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
			await sessions.rename(Number(body?.id), String(body?.name ?? "").slice(0, 40));
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
			json(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/abort") {
			const conv = await convFromBody(req);
			if (conv === undefined) { json(res, 404, { error: "conversation not found" }); return; }
			await conv.abort(BACKGROUND_CONTEXT);
			json(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/approve") {
			const body = await readBody(req).catch(() => undefined);
			const key = String(body?.key ?? "");
			const convId = Number(key.split(":")[0]);
			const conv = Number.isFinite(convId) ? await harness.conversation(convId as ConversationId, BACKGROUND_CONTEXT) : undefined;
			if (conv === undefined) { json(res, 404, { error: "conversation not found" }); return; }
			const result = await approvalDecision(conv, key, body?.action === "deny" ? "deny" : "approve", Number(body?.minutes ?? 10));
			json(res, 200, result);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/users") {
			const body = await readBody(req);
			const id = String(body?.id ?? "");
			if (!id.startsWith("ou_")) { json(res, 400, { error: "bad open_id" }); return; }
			const action = String(body?.action ?? "");
			if (action === "remove") await users.remove(id);
			else await users.add(id, body?.role === "admin" ? "admin" : "member");
			json(res, 200, { ok: true });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/events") {
			handleEvents(url, res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/send") {
			handleSend(req, url, res);
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
		const send = (event: string, data: unknown): void => {
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		};
		const context = BACKGROUND_CONTEXT;
		const view = await conversation.viewState(context);
		const frame = async (): Promise<void> => {
			const v = view.value as unknown as {
				entries: unknown[];
				docs?: Record<string, unknown>;
			};
			send("sync", { entries: v.entries, live: v.docs?.["pi.live"] ?? null });
		};
		await frame();
		const unsubscribe = view.subscribe(() => void frame());
		// 心跳保活（穿透链路）
		const beat = setInterval(() => res.write(": ping\n\n"), 25_000);
		reqClose(res, () => {
			clearInterval(beat);
			unsubscribe();
			view.dispose();
		});
	}

	async function convFromBody(req: IncomingMessage): Promise<Conversation | undefined> {
		const body = await readBody(req).catch(() => undefined);
		const id = Number(body?.conv ?? body?.id);
		if (!Number.isFinite(id)) return undefined;
		return harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
	}

	function handleSend(req: IncomingMessage, url: URL, res: ServerResponse): void {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk;
			if (body.length > 100_000) req.destroy();
		});
		req.on("end", () => {
			void (async () => {
				try {
					const { conv, content } = JSON.parse(body) as { conv?: number; content?: string };
					if (conv === undefined || typeof content !== "string" || content.trim() === "") {
						json(res, 400, { error: "bad request" });
						return;
					}
					const conversation = await harness.conversation(conv as ConversationId, BACKGROUND_CONTEXT);
					if (conversation === undefined) {
						json(res, 404, { error: "conversation not found" });
						return;
					}
					const context = BACKGROUND_CONTEXT;
					const submission = await conversation.submit(
						{ type: "input", content, requestId: `panel-${Date.now()}`, whenBusy: "steer", entry: { kind: "panel.message", data: {} } },
						context,
					);
					void submission.wait(context).catch(() => {});
					json(res, 200, { ok: true });
				} catch (err) {
					json(res, 500, { error: String(err) });
				}
			})();
		});
	}

	function reqClose(res: ServerResponse, fn: () => void): void {
		res.on("close", fn);
	}

	server.listen(port, "0.0.0.0", () => {
		console.log(`[dwell] panel: http://0.0.0.0:${port}/?token=<DWELL_PANEL_TOKEN>`);
	});
}

export type { Conversation };
