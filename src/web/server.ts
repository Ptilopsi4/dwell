// Panel HTTP 服务：无内置鉴权（部署侧自行保证网络边界，可用 DWELL_PANEL_HOST 绑定内网接口），SSE 推流（transcript + live 状态），静态页面。
// SSE 帧：mode=append 只带新 entries；活动 entries 前缀变化（reset/compaction/重连首帧）时 mode=replace 带全量。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { LiveDoc as PiLiveDoc, ToolResultEntry } from "@earendil-works/pi-durable";
import { MODEL, type ImageDescriber } from "../harness.ts";
import { ingestBuffer, sniffImageMime } from "../media.ts";
import { UploadError, type SaveUpload } from "../uploads.ts";
import { FileError } from "@earendil-works/pi-durable/env";
import { readWorkspaceFile } from "../guarded-env.ts";
import { fileGuardBases } from "../ext/approval.ts";
import { clampMinutes, conversationScope, pendingApprovals, setRunAttribution, sendPathViolation } from "../ext/approval.ts";
import { SCHEDULE_TASK_KIND, scanLiveTasks, type ScheduleInput } from "../ext/schedule.ts";
import { PROC_TASK_KIND, type ProcInput } from "../ext/proc.ts";
import { BackgroundDoc } from "../ext/background.ts";
import { getWork } from "../ext/work.ts";
import { beginNewGoal } from "../new-goal.ts";
import { recentReports } from "../report.ts";
import type { Sessions } from "../sessions.ts";
import type { Users } from "../users.ts";
import type { Directory } from "../feishu/directory.ts";
import type { RuntimeTelemetrySnapshot } from "../telemetry.ts";
import { modelFailure } from "../model-failure.ts";

export interface PanelRuntime {
	telemetry?: RuntimeTelemetrySnapshot;
	telegram: { transport: string; workers?: { activeRoutes: number; concurrency: number; stopped: boolean }; inbox: { pending: number; sending: number; tracking: number } };
}

interface PanelOptions {
	harness: Harness;
	sessions: Sessions;
	users: Users;
	directory: Directory;
	feishu: FeishuBridge;
	telegram?: () => string;
	runtime?: () => Promise<PanelRuntime>;
	ready?: () => boolean;
	port: number;
	/** Vision is disabled when its selected connection or credential is unavailable. */
	describer: () => ImageDescriber | null;
	/** bash 沙箱是否启用（main 里探测完成后才起 panel；getter 延迟读取探测结果） */
	sandbox: () => boolean;
	saveUpload: SaveUpload;
}

/** Channel actions supplied by the entrypoint; the legacy name remains compatible with existing callers. */
export interface FeishuBridge {
	/** The configured panel operator's platform-qualified user ID. */
	operator(): string;
	/** Feishu connection state; Telegram health is supplied separately. */
	status(): string;
	/** Forward text and attachments visibly to the original chat before submitting model input. */
	relay(conversation: Conversation, text: string, attachments?: { path: string; part: string }[]): Promise<void>;
	/** Notify the conversation's original chat, if it has one. */
	notice(conversationId: number, text: string): Promise<void>;
	/** Privately notify the configured operator, anchoring replies to the panel task. */
	notifyPanel(conversationId: number, status: string, text: string): Promise<void>;
	/** Record the decision, update its channel message, and resume blocked conversations. */
	decide(key: string, action: "approve" | "deny", minutes: number, requestId?: string): Promise<{ ok: boolean; error?: string }>;
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** Host 头里的主机名（去端口；IPv6 字面量去方括号）。 */
export function hostNameOf(host: string): string {
	const h = host.trim().toLowerCase();
	if (h.startsWith("[")) {
		const end = h.indexOf("]");
		return end === -1 ? h.slice(1) : h.slice(1, end);
	}
	return h.split(":")[0];
}

const isIpv4 = (s: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s);
const isIpv6 = (s: string): boolean => s.includes(":");

/**
 * panel 请求准入：POST 强制 JSON Content-Type；有 Origin 时必须与 Host 同源；Host 限 IP 字面量或配置名。
 * 依据：text/plain 跨域 POST 不触发预检、攻击页可借操作者浏览器打内网 panel（CSRF）；DNS rebinding 用任意域名作 Host 读 SSE。
 * IP 字面量放行是因为绑定地址不定（DWELL_PANEL_HOST 缺省监听全部接口），而 rebinding 域名不会是 IP。
 */
export function checkPanelRequest(
	req: { method?: string; host?: string; origin?: string; contentType?: string },
	allowedHosts: ReadonlySet<string>,
): void {
	if (req.method === "POST") {
		const contentType = (req.contentType ?? "").toLowerCase();
		if (!contentType.startsWith("application/json")) throw new HttpError(415, "json only");
	}
	if (req.origin !== undefined) {
		if (req.origin === "null") throw new HttpError(403, "bad origin");
		let originHost: string;
		try {
			originHost = new URL(req.origin).host.toLowerCase();
		} catch {
			throw new HttpError(403, "bad origin");
		}
		if (originHost !== (req.host ?? "").toLowerCase()) throw new HttpError(403, "cross-origin denied");
	}
	const name = hostNameOf(req.host ?? "");
	if (!isIpv4(name) && !isIpv6(name) && !allowedHosts.has(name)) throw new HttpError(403, "bad host");
}

/** A failed channel fails health; disabled or reconnecting channels and sandbox state do not. */
export function healthOf(feishu: string, uptimeSec: number, sandbox: boolean, telegram?: string): { code: number; body: { ok: boolean; uptimeSec: number; feishu: string; sandbox: boolean; telegram?: string } } {
	const ok = feishu !== "failed" && telegram !== "failed";
	return { code: ok ? 200 : 503, body: { ok, uptimeSec, feishu, sandbox, ...(telegram === undefined ? {} : { telegram }) } };
}

/** 地址归一：IPv4-mapped IPv6（双栈 socket 上的 IPv4 连接）去 `::ffff:`，链路本地地址去 `%scope`。 */
const normalizeAddr = (addr: string): string => {
	const a = addr.toLowerCase().split("%")[0];
	return a.startsWith("::ffff:") && a.includes(".") ? a.slice("::ffff:".length) : a;
};

/** 本机全部接口地址（归一后）。每请求取：wg/DHCP 地址会变。 */
export function localAddresses(): Set<string> {
	return new Set(Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => normalizeAddr(i.address))));
}

/**
 * 连接源是否本机：本机发起的 TCP 连接源地址必为本机地址，bash（含沙箱）与 panel 同机且无 CAP_NET_RAW 伪造源地址，
 * 所以拒绝本机来源 = 拒绝 agent 自己调 panel（自批审批、加管理员、读全部会话）。remote 缺失（socket 已断）按本机处理。
 */
export function isLocalSource(remote: string | undefined, localAddrs: ReadonlySet<string>): boolean {
	if (remote === undefined || remote === "") return true;
	const a = normalizeAddr(remote);
	return a.startsWith("127.") || a === "::1" || localAddrs.has(a);
}

/** GET /api/file 判定：限本会话 cwd 内的普通文件。cwd 缺失（root 会话不设 cwd）绝不能退回 process.cwd()——那是应用根。 */
export async function resolveDownload(cwd: string | undefined, path: string): Promise<{ status: 200; real: string; size: number; name: string; buffer: Buffer } | { status: 400 | 403 | 404 | 413; error: string }> {
	if (cwd === undefined) return { status: 404, error: "该会话没有工作目录" };
	if (path === "") return { status: 400, error: "path required" };
	if ((await sendPathViolation(path, cwd)) !== undefined) return { status: 403, error: "只能下载本会话工作目录内的文件" };
	try {
		const result = await readWorkspaceFile(path, fileGuardBases(cwd), 30 * 1024 * 1024, BACKGROUND_CONTEXT);
		return { status: 200, ...result, size: result.buffer.length };
	} catch (error) {
		if (error instanceof FileError && error.code === "is_directory") return { status: 404, error: "不是普通文件" };
		if (error instanceof FileError && error.code === "permission_denied") return { status: 403, error: "只能下载本会话工作目录内的文件" };
		if (error instanceof FileError && error.code === "invalid") return { status: 413, error: "文件超过 30MB 限制或不是普通文件" };
		return { status: 404, error: "文件不存在" };
	}
}

/** 下载响应头：一律 attachment + nosniff——工作目录里的 html/svg 若被浏览器在 panel 同源下当页面执行，就能带会话上下文打 /api/*。 */
export function downloadHeaders(name: string, size: number): Record<string, string> {
	const ascii = name.replace(/[^\w.\-]/g, "_");
	return {
		"content-type": "application/octet-stream",
		"content-length": String(size),
		"content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
		"x-content-type-options": "nosniff",
		"cache-control": "no-store",
	};
}

/** POST /api/upload 判定：base64 解码后非空且 ≤10MB，魔数嗅探分流；落盘该会话 cwd 的 uploads/（随机 8 位前缀防同 cwd 覆盖），图片当场走视觉描述（发送不再阻塞）。 */
export async function ingestUpload(
	cwd: string | undefined,
	name: unknown,
	data: unknown,
	describer: ImageDescriber | null,
	save: SaveUpload,
): Promise<{ status: 200; path: string; kind: "image" | "file"; size: number; part: string } | { status: 400 | 404 | 409 | 413 | 500 | 501; error: string }> {
	if (cwd === undefined) return { status: 404, error: "该会话没有工作目录" };
	if (typeof name !== "string" || name === "" || typeof data !== "string") return { status: 400, error: "name 与 data(base64) 必填" };
	const buffer = Buffer.from(data, "base64");
	if (buffer.length === 0) return { status: 400, error: "空文件" };
	if (buffer.length > 10 * 1024 * 1024) return { status: 413, error: "超过 10MB 上限" };
	const kind = sniffImageMime(buffer) !== null ? "image" : "file";
	try {
		const { saved, part } = await ingestBuffer(buffer, { kind, index: 1, tag: `${randomBytes(16).toString("hex")}-`, name }, cwd, describer, save);
		return { status: 200, path: saved, kind, size: buffer.length, part };
	} catch (err) {
		if (!(err instanceof UploadError)) throw err;
		const error = err.status === 409 ? "工作目录或上传目标发生变化，附件未保存，请重试。" : err.status === 501 ? "当前平台不支持安全附件上传。" : "附件保存失败，请检查磁盘和目录权限后重试。";
		return { status: err.status, error };
	}
}

async function readBody(req: IncomingMessage, maxBytes = 100_000): Promise<Record<string, unknown> | undefined> {
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (body.length > maxBytes) throw new HttpError(413, "body too large");
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

/** Provider diagnostics can contain request data; only classified messages reach the panel. */
export function presentPanelEntry(entry: EntryRecord): EntryRecord {
	if (entry.kind !== "pi.assistant" || entry.model === undefined) return entry;
	return { ...entry, model: entry.model.map((message) => message.role === "assistant" && message.stopReason === "error"
		? { ...message, errorMessage: modelFailure(message.errorMessage ?? "").message }
		: message) };
}

export async function presentPanelAnswerEntry(harness: Pick<Harness, "commit">, conversationId: number, entry: EntryRecord): Promise<EntryRecord> {
	return presentPanelEntry(entry);
}

/** 通讯录查询不阻塞列表：超时即返回未解析，下一轮轮询命中缓存。 */
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
	Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

export function startPanel({ harness, sessions, users, directory, feishu, telegram, runtime, ready, port, describer, sandbox, saveUpload }: PanelOptions): ReturnType<typeof createServer> {
	const panelFile = join(dirname(fileURLToPath(import.meta.url)), "panel.html");
	const vendorDir = join(dirname(fileURLToPath(import.meta.url)), "vendor");
	const MIME: Record<string, string> = {
		css: "text/css; charset=utf-8",
		js: "text/javascript; charset=utf-8",
	};

	type ConvRow = ReturnType<Sessions["listConversations"]>[number] & { parent?: number; busy?: boolean };
	/** Telegram has no Feishu directory identity; retain explicit ID fallbacks until renamed. */
	async function titleOf(c: ConvRow): Promise<string | null> {
		if (c.name !== c.key || c.type === "panel") return c.name;
		if (c.platform === "telegram") {
			const destination = sessions.destinationOf(c.id);
			if (destination.kind !== "telegram") return c.name;
			if (c.type === "direct") return `Telegram · 用户 ${c.owner.replace(/^tg:/, "") || destination.chatId}`;
			return `Telegram 群 ${destination.chatId} · ${c.type === "thread" ? `话题 ${destination.threadId ?? ""}` : `用户 ${c.owner.replace(/^tg:/, "")}`}`;
		}
		const [chatId = "", rest] = c.key.split("#");
		if (c.type === "direct") return (await directory.userName(c.owner)) ?? null;
		const [chat, user] = await Promise.all([directory.chatName(chatId), c.type === "group" ? directory.userName(c.owner) : Promise.resolve(undefined)]);
		if (chat === undefined && user === undefined) return null;
		const tail = c.type === "thread" ? `话题 ${String(rest ?? "").slice(2, 10)}` : (user ?? c.owner.slice(0, 10));
		return `${chat ?? "群聊"} · ${tail}`;
	}
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

	// Host 白名单：本机名 + 显式配置（DWELL_PANEL_HOST / DWELL_PANEL_URL）；IP 字面量由 checkPanelRequest 直接放行
	const allowedHosts = new Set(["localhost", "127.0.0.1", "::1"]);
	const addHost = (value: string | undefined): void => {
		if (value !== undefined && value !== "") allowedHosts.add(hostNameOf(value));
	};
	addHost(process.env.DWELL_PANEL_HOST);
	if (process.env.DWELL_PANEL_URL !== undefined) {
		try {
			addHost(new URL(process.env.DWELL_PANEL_URL).host);
		} catch {
			console.error("[dwell] DWELL_PANEL_URL 不是合法 URL，已忽略:", process.env.DWELL_PANEL_URL);
		}
	}

	// 本地开发（panel-only）浏览器走 localhost；同机反代/ssh -L 部署只能显式信任本机（此时 bash 可直连 panel）
	const denyLocal = process.env.DWELL_PANEL_ONLY !== "1" && process.env.DWELL_PANEL_TRUST_LOCAL !== "1";

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		checkPanelRequest({ method: req.method, host: req.headers.host, origin: req.headers.origin, contentType: req.headers["content-type"] }, allowedHosts);
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (req.method === "GET" && url.pathname === "/healthz") {
			const { code, body } = healthOf(feishu.status(), Math.round(process.uptime()), sandbox(), telegram?.());
			json(res, code, body);
			return;
		}
		// /healthz 之后：本机探活可用，其余接口（含静态页与 SSE）不对本机进程开放
		if (denyLocal && isLocalSource(req.socket.remoteAddress, localAddresses())) throw new HttpError(403, "local source denied");
		if (req.method === "GET" && url.pathname === "/api/ready") {
			const ok = (ready?.() ?? true) && healthOf(feishu.status(), 0, sandbox(), telegram?.()).code === 200;
			res.setHeader("cache-control", "no-store");
			json(res, ok ? 200 : 503, { ready: ok });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/runtime") {
			if (runtime === undefined) throw new HttpError(503, "runtime unavailable");
			res.setHeader("cache-control", "no-store");
			json(res, 200, await runtime());
			return;
		}
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
		if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			void readFile(panelFile, "utf8")
				.then((html) => {
					res.writeHead(200, {
						"content-type": "text/html; charset=utf-8",
						"cache-control": "no-store",
						"referrer-policy": "no-referrer",
					});
					res.end(html);
				})
				.catch(() => json(res, 500, { error: "panel missing" }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/conversations") {
			let list: ConvRow[] = [...sessions.listConversations()];
			if (list.length === 0) {
				// 本地/空库兜底：root 会话总可用（带默认模型）
				const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: MODEL } });
				list = [{ id: root.id as number, key: "root", owner: "", name: "root", archived: false, type: "panel", platform: "panel", lastTs: 0, chatId: null, notify: false, emoji: null }];
			}
			// 后台任务子会话：挂在父会话下（type "task"；名字取父会话名册，停止后名册删除即从侧栏消失）
			for (const [child, parent] of [...conversationScope.entries()]) {
				const parentRow = list.find((c) => c.id === parent);
				if (parentRow === undefined) continue;
				const doc = await harness.snapshot(BackgroundDoc, parent as ConversationId, BACKGROUND_CONTEXT);
				const name = Object.entries(doc?.agents ?? {}).find(([, v]) => v.conversationId === child)?.[0];
				if (name === undefined) continue;
				const busy = (await harness.snapshot(PiLiveDoc, child as ConversationId, BACKGROUND_CONTEXT))?.run !== undefined;
				list.push({ id: child, key: `bg:${name}`, owner: "", name: `🧵 ${name}`, archived: false, type: "task", platform: parentRow.platform, lastTs: 0, chatId: null, notify: false, emoji: null, parent, busy });
			}
			const titled = await within(
				Promise.all(list.map(async (c) => {
					const title = await titleOf(c);
					const chatName = c.chatId === null ? undefined : c.platform === "telegram" ? `Telegram ${c.type === "direct" ? "私聊" : "群"} ${c.chatId.split(":").pop()}` : await directory.chatName(c.chatId);
					// 群/话题线的组内短名（侧栏按群分组后不再需要群名前缀）
					const short = title?.split(" · ").pop();
					return { ...c, title, chatName: chatName ?? null, shortTitle: c.type === "group" || c.type === "thread" ? (short ?? title ?? c.name) : (title ?? c.name) };
				})),
				2500,
			);
			json(res, 200, titled ?? list);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/approvals") {
			// 待审队列（等人事项优先展示，借 dsh panel 哲学）
			const list = [...pendingApprovals.entries()].map(([key, p]) => ({ key, ...p }));
			json(res, 200, list);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/reports") {
			json(res, 200, recentReports());
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/work") {
			const id = Number(url.searchParams.get("id"));
			if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "有效的会话 ID 为必填项");
			if (await harness.conversation(id as ConversationId, BACKGROUND_CONTEXT) === undefined) throw new HttpError(404, "会话不存在");
			json(res, 200, await getWork(harness, id));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/work/goal") {
			const body = await readBody(req);
			const id = Number(body?.id);
			const workId = body?.workId;
			const requestId = body?.requestId;
			const goal = typeof body?.goal === "string" ? body.goal : "";
			if (!Number.isSafeInteger(id) || id <= 0 || (workId !== null && (typeof workId !== "string" || workId === "")) || typeof requestId !== "string" || requestId.trim() === "" || requestId.length > 200 || goal.trim() === "" || goal.length > 4000) throw new HttpError(400, "会话 ID、目标描述和请求 ID 为必填项");
			if (await harness.conversation(id as ConversationId, BACKGROUND_CONTEXT) === undefined) throw new HttpError(404, "会话不存在");
			try { json(res, 200, await beginNewGoal(harness, { conversationId: id, expectedWorkId: workId, operator: feishu.operator(), requestId, goal })); }
			catch (error) {
				// 只有已知冲突才向操作者呈现原文（409）；其余是内部故障，统一 500 避免英文堆栈或 undefined 透给面板
				const known = new Set(["该开启目标请求与原记录不一致", "请在父会话中开启新目标", "当前仍在运行或有排队输入，请先等待完成或取消", "当前目标已变化，请刷新后重试", "本会话的目标操作记录已满，请开启新的会话", "缺少目标描述，用法：/goal <目标描述>"]);
				const message = error instanceof Error && error.message !== undefined ? error.message : "";
				console.error("[dwell] 开启新目标未通过:", error);
				throw known.has(message) ? new HttpError(409, message) : new HttpError(500, "开启新目标失败，请稍后重试；若持续失败请查看服务日志。");
			}
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/users") {
			const list = users.list();
			const names = (await within(directory.userNames(list.map((u) => u.id).filter((id) => !id.startsWith("tg:"))), 2500)) ?? {};
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
			// 清空上下文不清 work 记录：当前 goal 会以宿主数据继续注入，提示操作者用 /goal 切换
			const open = Object.values((await getWork(harness, conv.id as number)).records).filter((record) => record.status === "active");
			await conv.reset(undefined, BACKGROUND_CONTEXT);
			// 新上下文里落一条展示型分隔回（模型不可见），panel 侧可见「已清空」而非无声空白
			await conv.submit({ type: "write", entry: { kind: "context.reset", data: { by: "panel" } } }, BACKGROUND_CONTEXT);
			void feishu.notice(conv.id as number, "管理员在 panel 清空了这条任务线的上下文，之后的消息从新对话开始。");
			json(res, 200, { ok: true, ...(open.length === 0 ? {} : { notice: `此任务线仍有 ${open.length} 条进行中的工作记录（goal 文本会在新对话中继续注入）；用 /goal <描述> 建立新目标可解绑旧目标。` }) });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/abort") {
			const conv = await convFromBody(req);
			if (conv === undefined) { json(res, 404, { error: "conversation not found" }); return; }
			await conv.abort(BACKGROUND_CONTEXT);
			void feishu.notice(conv.id as number, "管理员在 panel 中止了当前任务。");
			json(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/approve") {
			const body = await readBody(req);
			const key = String(body?.key ?? "");
			const action = body?.action === "deny" ? "deny" : "approve";
			const minutes = clampMinutes(Number(body?.minutes ?? 10));
			json(res, 200, await feishu.decide(key, action, minutes, typeof body?.requestId === "string" ? body.requestId : undefined));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/users") {
			const body = await readBody(req);
			const id = String(body?.id ?? "");
			if (!/^ou_\w+$/.test(id) && !/^tg:\d+$/.test(id)) { json(res, 400, { error: "需要飞书 open_id 或 Telegram 用户 ID（tg:数字）" }); return; }
			const action = String(body?.action ?? "");
			if (action === "remove") {
				if (users.isAdmin(id) && users.adminCount() <= 1) throw new HttpError(409, "无法移除最后一名管理员");
				try { await users.remove(id, undefined, true); }
				catch (error) {
					if (error instanceof Error && error.message.includes("最后一名管理员")) throw new HttpError(400, error.message);
					throw error;
				}
			} else await users.add(id, body?.role === "admin" ? "admin" : "member");
			json(res, 200, { ok: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/notify") {
			const body = await readBody(req);
			const id = Number(body?.id);
			if (!Number.isFinite(id)) throw new HttpError(400, "bad request");
			sessions.setNotify(id, body?.on === true);
			json(res, 200, { ok: true, on: body?.on === true });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/file") {
			const convId = Number(url.searchParams.get("conv"));
			const conversation = Number.isFinite(convId) ? await harness.conversation(convId as ConversationId, BACKGROUND_CONTEXT) : undefined;
			if (conversation === undefined) { json(res, 404, { error: "conversation not found" }); return; }
			const cwd = (await conversation.agent(BACKGROUND_CONTEXT)).cwd ?? undefined;
			const result = await resolveDownload(cwd, url.searchParams.get("path") ?? "");
			if (result.status !== 200) { json(res, result.status, { error: result.error }); return; }
			// 整读而非流式：复用 guarded-env 的统一读取与 30MB 限额，代价是内存峰值 = 并发下载数 × 文件大小（panel 为内网信任边界）
			res.writeHead(200, downloadHeaders(result.name, result.size));
			res.end(result.buffer);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/upload") {
			// body 上限 15MB：10MB 附件的 base64（≈13.4MB）够用
			const body = await readBody(req, 15_000_000);
			const conv = Number(body?.conv);
			const conversation = Number.isFinite(conv) ? await harness.conversation(conv as ConversationId, BACKGROUND_CONTEXT) : undefined;
			if (conversation === undefined) { json(res, 404, { error: "conversation not found" }); return; }
			const cwd = (await conversation.agent(BACKGROUND_CONTEXT)).cwd ?? undefined;
			const result = await ingestUpload(cwd, body?.name, body?.data, describer(), saveUpload);
			if (result.status !== 200) { json(res, result.status, { error: result.error }); return; }
			json(res, 200, { path: result.path, kind: result.kind, size: result.size, part: result.part });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/schedules") {
			// 全部活跃定时任务（面板只读展示 + 取消；创建走对话）
			const records = await harness.commit((tx) => scanLiveTasks(tx, { kind: SCHEDULE_TASK_KIND }, 500), BACKGROUND_CONTEXT);
			const convs = sessions.listConversations();
			json(res, 200, records.map((t) => {
				const input = t.input as ScheduleInput;
				const conv = convs.find((c) => c.id === input.conversationId);
				return {
					taskId: String(t.id),
					id: input.id,
					conversationId: input.conversationId,
					conversation: conv?.name ?? `#${input.conversationId}`,
					instruction: input.instruction,
						next: t.state.status === "sleeping" ? new Date(t.state.until).toISOString() : null,
					repeat: input.repeat ?? null,
					creator: input.creator,
				};
			}));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/schedules/cancel") {
			const body = await readBody(req);
			const taskId = Number(body?.taskId);
			if (!Number.isFinite(taskId)) throw new HttpError(400, "taskId required");
			// 只允许取消定时任务：先校验 kind（panel 能 abort 任意任务的面收窄）
			const task = await harness.getTask(taskId as never, BACKGROUND_CONTEXT);
			if (task?.kind !== SCHEDULE_TASK_KIND) throw new HttpError(404, "schedule not found");
			const state = await harness.abortTask(taskId as never, BACKGROUND_CONTEXT);
			json(res, 200, { ok: true, state });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/procs") {
			// 全部活跃后台进程（面板只读展示 + 停止；创建走对话）
			const records = await harness.commit((tx) => scanLiveTasks(tx, { kind: PROC_TASK_KIND }, 500), BACKGROUND_CONTEXT);
			const convs = sessions.listConversations();
			json(res, 200, records.map((t) => {
				const input = t.input as ProcInput;
				const conv = convs.find((c) => c.id === input.conversationId);
				const ck = t.state.status === "running" && t.state.checkpoint !== undefined ? (t.state.checkpoint as { phase?: string; pid?: number; startedAt?: number }) : undefined;
				return {
					taskId: String(t.id),
					name: input.name,
					conversationId: input.conversationId,
					conversation: conv?.name ?? `#${input.conversationId}`,
					command: input.command,
					pid: ck?.phase === "watch" ? (ck.pid ?? null) : null,
					startedAt: ck?.startedAt !== undefined ? new Date(ck.startedAt).toISOString() : null,
				};
			}));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/procs/stop") {
			const body = await readBody(req);
			const taskId = Number(body?.taskId);
			if (!Number.isFinite(taskId)) throw new HttpError(400, "taskId required");
			const task = await harness.getTask(taskId as never, BACKGROUND_CONTEXT);
			if (task?.kind !== PROC_TASK_KIND) throw new HttpError(404, "process not found");
			const state = await harness.abortTask(taskId as never, BACKGROUND_CONTEXT);
			json(res, 200, { ok: true, state });
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
		const frame = async (): Promise<void> => {
			if (closed) return;
			const v = view.value as unknown as { entries: EntryRecord[]; docs?: Record<string, unknown> };
			const ids = v.entries.map((e) => String(e.id));
			const append = sent.length > 0 && sent.length <= ids.length && ids[0] === sent[0] && ids[sent.length - 1] === sent[sent.length - 1];
			const entries = await Promise.all((append ? v.entries.slice(sent.length) : v.entries).map((entry) => presentPanelAnswerEntry(harness, convId, entry)));
			if (closed) return;
			const live = v.docs?.["pi.live"] as LiveDoc | undefined;
			const slim = live?.run === undefined ? null : {
				tools: (live.tools ?? []).map((t) => ({ callId: t.callId, name: t.name, status: t.status })),
				text: (live.generation?.message?.content ?? []).flatMap((c) => (c.type === "text" && c.text !== undefined ? [c.text] : [])).join(""),
				retry: live.generation?.retry?.error === undefined ? undefined : modelFailure(live.generation.retry.error).message,
			};
			sent = ids;
			const usage = Object.values((v.docs?.["pi.usage"] as UsageDoc | undefined)?.models ?? {});
			const model = (v.docs?.["pi.agent"] as AgentDoc | undefined)?.model;
			const meta = {
				model: model === undefined ? null : `${model.provider}/${model.modelId}`,
				tokens: usage.reduce((n, u) => n + (u.totalTokens ?? 0), 0),
				cost: usage.reduce((n, u) => n + (u.cost?.total ?? 0), 0),
			};
			// 背压保护：停滞客户端（TCP 窗归零不 RST）会让写队列无限堆积 sync 帧；超过水位直接断开，由前端重连逻辑重新订阅
			if (res.write(`event: sync\ndata: ${JSON.stringify({ mode: append ? "append" : "replace", entries, live: slim, meta })}\n\n`) === false && res.writableLength > 4 * 1024 * 1024) {
				console.error("[dwell] panel SSE 客户端停滞，写队列超水位，断开重连");
				res.destroy();
			}
		};
		// subscribe 契约先投当前值再投变更（chord Readable），首帧由它发；手动再发会重复一帧全量 replace
		let frameWork = Promise.resolve();
		cleanups.push(view.subscribe(() => {
			frameWork = frameWork.then(frame).catch((error) => {
				console.error("[dwell] panel 回答呈现失败:", error);
				res.end();
			});
		}));
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
		if (!Number.isFinite(conv) || typeof content !== "string") throw new HttpError(400, "bad request");
		// 附件 = 上传接口返回的 {path, part} 回传：part 是进入上下文的描述文本，path 仍过路径治理
		const rawAttachments: unknown[] = Array.isArray(body?.attachments) ? (body.attachments as unknown[]) : [];
		if (rawAttachments.length > 5) throw new HttpError(400, "最多 5 个附件");
		const attachments: { path: string; part: string }[] = [];
		for (const raw of rawAttachments) {
			const att = (raw ?? {}) as { path?: unknown; part?: unknown };
			if (typeof att.path !== "string" || typeof att.part !== "string") throw new HttpError(400, "bad attachments");
			attachments.push({ path: att.path, part: att.part });
		}
		if (content.trim() === "" && attachments.length === 0) throw new HttpError(400, "bad request");
		const conversation = await harness.conversation(conv as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) {
			json(res, 404, { error: "conversation not found" });
			return;
		}
		if (attachments.length > 0) {
			const cwd = (await conversation.agent(BACKGROUND_CONTEXT)).cwd ?? undefined;
			if (cwd === undefined) { json(res, 404, { error: "该会话没有工作目录" }); return; }
			for (const a of attachments) {
				if ((await sendPathViolation(a.path, cwd)) !== undefined) { json(res, 403, { error: "只能使用本会话工作目录内的附件" }); return; }
			}
		}
		// Keep direct panel input consistent with channel relay input.
		const input = [content.trim(), ...attachments.map((a) => a.part)].filter((s) => s !== "").join("\n\n");
		sessions.touchActivity(conversation.id);
		const id = conversation.id as number;
		// Channel conversations always pass through the visible relay before model submission.
		const destination = sessions.destinationOf(id);
		if (destination.kind !== "panel") {
			await feishu.relay(conversation, content, attachments);
			json(res, 200, { ok: true, via: destination.kind });
			return;
		}
		if ((await harness.snapshot(PiLiveDoc, conversation.id, BACKGROUND_CONTEXT))?.run === undefined) await setRunAttribution(id, feishu.operator(), "panel");
		const submission = await conversation.submit(
			{ type: "input", content: input, requestId: `panel-${Date.now()}-${randomBytes(4).toString("hex")}`, whenBusy: "steer", entry: { kind: "panel.message", data: { sender: feishu.operator(), via: "panel" } } },
			BACKGROUND_CONTEXT,
		);
		void submission.wait(BACKGROUND_CONTEXT).catch(() => {});
		// Operator notifications retain an anchor for continuing the panel task.
		if (sessions.notifyEnabled(id)) void notifyPanelResult(conversation, submission, feishu);
		json(res, 200, { ok: true, via: "panel" });
	}

	/** panel 任务结束后私发操作者结果摘要：完成取最后一条 assistant 文本，失败取原因。 */
	async function notifyPanelResult(conversation: Conversation, submission: Awaited<ReturnType<Conversation["submit"]>>, feishu: FeishuBridge): Promise<void> {
		try {
			const settled = await submission.wait(BACKGROUND_CONTEXT);
			let status = "完成";
			let text = "";
			if (settled.status === "done" && settled.type === "input") {
				const view = await conversation.viewState(BACKGROUND_CONTEXT);
				try {
					const entries = (view.value as unknown as { entries: { kind: string; model?: { content?: unknown }[] }[] }).entries;
					for (let i = entries.length - 1; i >= 0; i--) {
						const e = entries[i];
						if (e.kind !== "pi.assistant") continue;
						const m = e.model?.[0] as { content?: { type: string; text?: string }[] | string } | undefined;
						text = typeof m?.content === "string" ? m.content : (m?.content ?? []).flatMap((c) => (c.type === "text" && c.text !== undefined ? [c.text] : [])).join("");
						if (text !== "") break;
					}
				} finally {
					view.dispose();
				}
			} else {
				status = "失败";
				text = settled.status === "unanswered" ? settled.reason : settled.status;
			}
			await feishu.notifyPanel(conversation.id as number, status, text === "" ? "（无文本输出）" : text);
		} catch (err) {
			console.error("[dwell] panel 任务通知失败:", err);
		}
	}

	// DWELL_PANEL_HOST：绑定指定网络接口（不设则监听全部接口）
	const host = process.env.DWELL_PANEL_HOST;
	server.listen(port, host, () => {
		console.log(`[dwell] panel: http://${host ?? "0.0.0.0"}:${port}/`);
	});
	return server;
}

export type { Conversation };
