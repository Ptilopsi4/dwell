// 危险命令审批（简版 Mandate）+ 文件工具路径治理 + 审批状态持久化。
// 窗口键 = (conversationId, sender)：谁触发谁申请，互不搭车。
// 注意：正则与路径检查是减速带，硬边界是凭证擦除（harness.scrubSecretEnv）+ 部署隔离（容器/systemd）。
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { defineExtension, hook, ToolTask, type Conversation, type Submission } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DATA_DIR, STATE_DIR, stateFile, writeStateJson } from "../state.ts";

/** conversationId → 当前 run 的发起者（submit 前设置，run 归属判定用）。 */
export const runSender = new Map<number, string>();

/** conversationId → 当前 run 的发起入口；决定审批卡片是否发到飞书。 */
export const runVia = new Map<number, "panel" | "feishu">;

/** 审批窗口：(conversationId, sender) → 到期时间戳。 */
export const approvals = new Map<string, number>();

export type PendingApproval = {
	command: string;
	match: string;
	trigger: string;
	via: "panel" | "feishu";
	/** 飞书审批卡片的消息 ID，其他入口做出决定后据此更新卡片 */
	cardMessageId?: string;
	cardChatId?: string;
};

/** 待审批上下文：key 同审批窗口，卡片点击后更新形态 / 校验归属用。 */
export const pendingApprovals = new Map<string, PendingApproval>();

/** 审批窗口的分钟数上下限：负数立即过期、超大值等同永久，都违背审批语义。 */
export const APPROVAL_MIN_MINUTES = 1;
export const APPROVAL_MAX_MINUTES = 120;

export function clampMinutes(raw: number): number {
	return Math.min(Math.max(Number.isFinite(raw) ? raw : 10, APPROVAL_MIN_MINUTES), APPROVAL_MAX_MINUTES);
}

export let onApprovalNeeded: ((conversationId: number, sender: string, command: string, match: string) => void) | null = null;

export function setApprovalCallback(fn: (conversationId: number, sender: string, command: string, match: string) => void): void {
	onApprovalNeeded = fn;
}

// ── 持久化：重启后窗口/待审/归属不丢（旧审批卡点击不再静默失效，续跑 run 的归属不漂移） ──

/** 审批状态落盘。fire-and-forget 调用（内部兜错），返回的 promise 供测试等待写入完成。 */
export function persistApprovals(): Promise<void> {
	return writeStateJson(stateFile("approvals.json"), {
		windows: [...approvals.entries()],
		pending: [...pendingApprovals.entries()],
		runSender: [...runSender.entries()].map(([id, sender]) => [String(id), sender]),
		runVia: [...runVia.entries()].map(([id, via]) => [String(id), via]),
	}).catch((err: unknown) => console.error("[dwell] approvals 状态写入失败:", err));
}

/** 启动时恢复审批状态（在 harness.resume 前，续跑任务的审批判定用得上）。 */
export async function loadApprovalState(): Promise<void> {
	let saved: { windows?: [string, number][]; pending?: [string, PendingApproval][]; runSender?: [string, string][]; runVia?: [string, "panel" | "feishu"][] };
	try {
		saved = JSON.parse(await readFile(stateFile("approvals.json"), "utf8")) as typeof saved;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[dwell] approvals.json 损坏，审批窗口/归属将重置:", err);
		return;
	}
	const now = Date.now();
	for (const [key, expiry] of saved.windows ?? []) {
		if (typeof expiry === "number" && expiry > now) approvals.set(key, expiry); // 过期窗口不复活
	}
	for (const [key, pending] of saved.pending ?? []) {
		if (typeof pending?.command === "string") pendingApprovals.set(key, pending);
	}
	for (const [id, sender] of saved.runSender ?? []) runSender.set(Number(id), sender);
	for (const [id, via] of saved.runVia ?? []) runVia.set(Number(id), via);
}

const DANGEROUS: RegExp[] = [
	/\bssh\b|\bscp\b|\brsync\b.*(-e\s*ssh|@)/,
	/curl[^|]*\s(-[a-z]*d\b|--data|--form\b|-F\b|-T\b|--upload|--json)|curl[^|]*-X\s*(POST|PUT|PATCH|DELETE)/,
	/wget[^|]*--post/,
	/npm\s+install\s+-g|apt(-get)?\s+install|pip3?\s+install/,
	/\bdocker\b|\bsystemctl\b|\bcrontab\b/,
	/\bfind\b[^|;&]*\s-delete\b/,
];

/** rm 递归强删：合并 flag（-rf）与拆开/长参数（-r -f、--recursive --force）都算；flags 只看操作数之前的 token。 */
export function rmRecursiveMatch(command: string): string | null {
	for (const segment of command.split(/[|;&\n]/)) {
		const tokens = segment.trim().split(/\s+/);
		const rmIndex = tokens.findIndex((t) => t === "rm" || t.endsWith("/rm"));
		if (rmIndex === -1) continue;
		let recursive = false;
		let force = false;
		for (const token of tokens.slice(rmIndex + 1)) {
			if (token === "--recursive" || /^-[a-zA-Z]*r/.test(token)) recursive = true;
			if (token === "--force" || /^-[a-zA-Z]*f/.test(token)) force = true;
			if (!token.startsWith("-")) break; // rm 的 flags 都在操作数前（POSIX）
		}
		if (recursive && force) return "rm 递归强删";
	}
	return null;
}

/** 状态文件与凭证面兜底：路径已移出 agent 可写域，此检查防 cwd 相对猜测与 /proc 回读（减速带非硬墙）。 */
const STATE_FILES = /users\.json|sessions\.json|message-map\.json|approvals\.json|(?:^|[\s"'=/\\])\.env\b|(?<![\w-])state[\\/]|\/proc\/[^\s/]*\/environ/;

export function stateFileBlocked(command: string): boolean {
	return STATE_FILES.test(command);
}

/** 返回命中的敏感片段（如 "rm -rf"），未命中返回 null。 */
export function dangerMatch(command: string): string | null {
	const rm = rmRecursiveMatch(command);
	if (rm !== null) return rm;
	for (const pattern of DANGEROUS) {
		const m = pattern.exec(command);
		if (m !== null) return m[0];
	}
	return null;
}

export function windowKey(conversationId: number, sender: string): string {
	return `${conversationId}:${sender}`;
}

export function windowOpen(conversationId: number, sender: string): boolean {
	const key = windowKey(conversationId, sender);
	const expiry = approvals.get(key);
	if (expiry === undefined) return false;
	if (expiry < Date.now()) {
		approvals.delete(key);
		void persistApprovals();
		return false;
	}
	return true;
}

/** 面板/卡片共用的审批决策：开/关窗口并唤醒（或通知）模型。返回已处理的待审与续跑 submission，调用方决定回复发到哪里。 */
export async function approvalDecision(
	conversation: Conversation,
	key: string,
	action: "approve" | "deny",
	minutes: number,
): Promise<{ ok: true; pending: PendingApproval; submission: Submission } | { ok: false; error: string }> {
	const pending = pendingApprovals.get(key);
	if (pending === undefined) return { ok: false, error: "该请求已失效" };
	pendingApprovals.delete(key);
	if (action === "approve") approvals.set(key, Date.now() + clampMinutes(minutes) * 60_000);
	else approvals.delete(key);
	void persistApprovals();
	const submission = await conversation.submit({
		type: "input",
		content: action === "approve"
			? `用户已批准危险命令窗口（${clampMinutes(minutes)} 分钟）。请继续之前的任务，重试被拦截的命令。`
			: "用户拒绝了危险命令。请停止该操作并改用其他方案，或询问用户意图。",
		whenBusy: "steer",
		requestId: `decision-${key}-${Date.now()}`,
	}, BACKGROUND_CONTEXT);
	return { ok: true, pending, submission };
}

// ── S2 文件工具路径治理 ──

/** 应用根（src/ 的上级）：dwell 自身源码与部署配置所在，agent 不可读写。 */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// 目录常量可能是相对路径（本地开发默认 ./data ./state）：比较前统一归一为绝对路径
const STATE_PATH = resolve(STATE_DIR);
const DATA_PATH = resolve(DATA_DIR);
const SQLITE_FILE = join(DATA_PATH, "dwell.sqlite");

// 应用根子树拒读，但 data/（会话工作目录与上传物所在）除外——data 常就部署在应用根下
const READ_FORBIDDEN = (path: string): boolean =>
	path === STATE_PATH || path.startsWith(STATE_PATH + sep)
	|| path.startsWith(SQLITE_FILE) // 含 -wal/-shm
	|| ((path === APP_ROOT || path.startsWith(APP_ROOT + sep)) && !(path === DATA_PATH || path.startsWith(DATA_PATH + sep)));

/**
 * 文件工具（read/write/edit）路径治理。write/edit 限本会话 cwd 与系统临时目录；
 * read 只禁状态/应用根/数据库/proc（读系统其余部分是合法探索）。cwd 由调用方按会话解析（相对路径与 .. 逃逸都归一化后再判）。
 */
export function fileToolViolation(tool: string, path: string, cwd: string): string | undefined {
	const abs = resolve(cwd, path);
	if (tool === "read") {
		// /proc 判原始路径：Windows 下 resolve 会把 POSIX 绝对路径变成盘符路径，前缀判断会失效
		if (path.startsWith("/proc/") || READ_FORBIDDEN(abs)) return `不允许读取 ${abs}（状态文件、应用目录、数据库、/proc 不在可读域）。`;
		return undefined;
	}
	if (abs === cwd || abs.startsWith(cwd + sep) || abs.startsWith(tmpdir() + sep)) return undefined;
	return `写入仅限本会话工作目录与系统临时目录（已拒绝 ${abs}）。`;
}

/** cwd 访问器：按 conversationId 查 agent cwd（conversation.agent().cwd）。 */
export type CwdOf = (conversationId: number, context: typeof BACKGROUND_CONTEXT) => Promise<string | undefined>;

/** 路径治理扩展：挂 beforeTool，read/write/edit 的 path 逐个校验。 */
export function makePathGuardExtension(cwdOf: CwdOf) {
	return defineExtension({
		name: "dwell-path-guard",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					if (call.name !== "read" && call.name !== "write" && call.name !== "edit") return undefined;
					const path = (call.arguments as { path?: string }).path;
					if (typeof path !== "string" || path === "") return undefined;
					const cwd = (await cwdOf(api.conversationId as number, context)) ?? join(DATA_DIR, "work");
					const violation = fileToolViolation(call.name, path, resolve(cwd));
					if (violation === undefined) return undefined;
					return { block: violation };
				},
			}),
		],
	});
}

/** 挂到 registry 的 extension；只管 bash，其余工具放行。 */
export function makeApprovalExtension() {
	return defineExtension({
		name: "dwell-approval",
		hooks: [
			hook(ToolTask, {
				beforeTool: (call, api) => {
					if (call.name !== "bash") return undefined;
					const command = (call.arguments as { command?: string }).command ?? "";
					if (stateFileBlocked(command)) {
						return { block: "不允许访问服务状态文件或进程环境。" };
					}
					// sudo 在本环境永不可能成功（NoNewPrivileges + dwell 无 sudo 组），直接说明，不走审批
					if (/\bsudo\b/.test(command)) {
						return { block: "dwell 用户无 sudo 权限（服务以非 root 运行），此命令无法执行。向用户说明并改用不需要提权的方案。" };
					}
					const match = dangerMatch(command);
					if (match === null) return undefined;
					const convId = api.conversationId as number;
					const sender = runSender.get(convId) ?? "";
					if (windowOpen(convId, sender)) return undefined;
					pendingApprovals.set(windowKey(convId, sender), { command, match, trigger: sender, via: runVia.get(convId) ?? "feishu" });
					void persistApprovals();
					onApprovalNeeded?.(convId, sender, command, match);
					// 面板入口的审批只在面板处理（飞书成员 /approve 开的是自己的窗口，帮不上忙）
					const viaPanel = runVia.get(convId) === "panel";
					return { block: viaPanel
						? `该命令被审批策略拦截（${match}）。已通知管理员在面板审批，请告知用户稍候。批准后继续原任务；不要尝试其他方式绕过。`
						: `该命令被审批策略拦截（${match}）。请告知用户：点击审批卡片按钮，或回复 /approve 批准（默认 10 分钟窗口）。批准后继续原任务；不要尝试其他方式绕过。` };
				},
			}),
		],
	});
}
