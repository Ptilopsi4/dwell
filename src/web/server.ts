// Panel HTTP 服务：token 准入（内网穿透直连场景），SSE 推流（transcript + live 状态），静态页面。
// 协议简化：SSE 每帧全量 sync（活动 entries + live 概要），panel 按 id 增量渲染。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness } from "@earendil-works/pi-durable";
import { MODEL } from "../harness.ts";
import type { Sessions } from "../sessions.ts";

interface PanelOptions {
	harness: Harness;
	sessions: Sessions;
	port: number;
	token: string;
}

export function startPanel({ harness, sessions, port, token }: PanelOptions): void {
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
					res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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
				list = [{ id: root.id as number, key: "root", owner: "" }];
			}
			json(res, 200, list);
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
