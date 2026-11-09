// 危险命令审批（简版 Mandate）+ 文件工具路径治理 + 审批状态持久化。
// 窗口键 = (conversationId, sender)：谁触发谁申请，互不搭车。
// 注意：正则与路径检查是减速带，硬边界是凭证擦除（harness.scrubSecretEnv）+ 部署隔离（容器/systemd）。
import { readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { APP_ROOT, DATA_DIR, DEFAULT_CWD, STATE_DIR, stateFile, writeStateJson } from "../state.ts";

/** conversationId → 当前 run 的发起者（submit 前设置，run 归属判定用）。 */
export const runSender = new Map<number, string>();

/** conversationId → 当前 run 的发起入口；决定审批卡片是否发到飞书。 */
export const runVia = new Map<number, "panel" | "feishu">();

/** 后台子会话 → 父会话：审批窗口/归属/卡片路由按父线（scope）算，续跑输入发到子会话本身。
 *  index 启动时从 sqlite 重建，background 扩展 start 时登记；只在进程内存，不落盘。 */
export const conversationScope = new Map<number, number>();

/** 审批与归属用的会话 scope：子会话归并到父会话，其余原样。 */
export function scopeOf(conversationId: number): number {
	return conversationScope.get(conversationId) ?? conversationId;
}

/** 审批窗口：(conversationId, sender) → 到期时间戳。 */
export const approvals = new Map<string, number>();

export type PendingApproval = {
	command: string;
	match: string;
	trigger: string;
	via: "panel" | "feishu";
	/** 等待这次审批的会话：scope 本身和/或它的后台子会话（同一窗口键下可能先后被拦多个，决定后逐个唤醒）。缺省 = scope */
	targets?: number[];
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

/** 审批决定后交给模型的续跑输入（卡片、/approve、panel 三条路径共用）。 */
export function decisionInput(action: "approve" | "deny", minutes: number): string {
	return action === "approve"
		? `The user approved a ${minutes}-minute window for dangerous commands. Continue the previous task and retry the blocked command.`
		: "The user denied the dangerous command. Stop that operation and take another approach, or ask the user what they intend.";
}

/** 审批决定的状态记账（卡片、/approve、panel 三条路径共用）：取走待审，批准开窗、拒绝关窗。无待审返回 undefined 且不动窗口。
 *  唤醒谁、回复发到哪里由调用方按 splitTargets 决定。 */
export function takeDecision(key: string, action: "approve" | "deny", minutes: number): PendingApproval | undefined {
	const pending = pendingApprovals.get(key);
	if (pending === undefined) return undefined;
	pendingApprovals.delete(key);
	if (action === "approve") approvals.set(key, Date.now() + clampMinutes(minutes) * 60_000);
	else approvals.delete(key);
	void persistApprovals();
	return pending;
}

/** 待审的唤醒目标拆分：self = scope 本身被拦（调用方按自己的回复位置续跑），children = 被拦的后台子会话（经 Reporter 投回）。 */
export function splitTargets(scope: number, pending: PendingApproval): { self: boolean; children: number[] } {
	const targets = pending.targets ?? [scope];
	return { self: targets.includes(scope), children: targets.filter((t) => t !== scope) };
}

// ── S2 文件工具路径治理 ──

// 目录常量可能是相对路径（本地开发默认 ./data ./state）：比较前统一归一为绝对路径
const STATE_PATH = resolve(STATE_DIR);
const DATA_PATH = resolve(DATA_DIR);
const SQLITE_FILE = join(DATA_PATH, "dwell.sqlite");

// 应用根子树拒读，但 data/（会话工作目录与上传物所在）除外——data 常就部署在应用根下
const READ_FORBIDDEN = (path: string, bases: PathBases): boolean =>
	path === bases.state || path.startsWith(bases.state + sep)
	|| path.startsWith(bases.sqlite) // 含 -wal/-shm
	|| ((path === bases.appRoot || path.startsWith(bases.appRoot + sep)) && !(path === bases.data || path.startsWith(bases.data + sep)));

/** 路径判定基准（均为绝对路径）。目标与基准必须同形态（同为字面 resolve 或同为 realpath）才可比。 */
export type PathBases = { cwd: string; tmp: string; state: string; appRoot: string; data: string; sqlite: string };

/** 字面基准（不做软链解析）：fileToolViolation 用。 */
const literalBases = (cwd: string): PathBases => ({ cwd: resolve(cwd), tmp: tmpdir(), state: STATE_PATH, appRoot: APP_ROOT, data: DATA_PATH, sqlite: SQLITE_FILE });

/** 判定核心：`abs` 与 `bases` 同形态。`rawPath` 用于 /proc 的原始路径检查（Windows 下 resolve 会把 POSIX 绝对路径变成盘符路径）。 */
function violationOf(tool: string, rawPath: string, abs: string, bases: PathBases): string | undefined {
	if (tool === "read") {
		if (rawPath.startsWith("/proc/") || abs.startsWith("/proc/") || READ_FORBIDDEN(abs, bases)) return `Reading ${abs} is not allowed (state files, the application directory, the database, and /proc are outside the readable area).`;
		return undefined;
	}
	if (abs === bases.cwd || abs.startsWith(bases.cwd + sep) || abs.startsWith(bases.tmp + sep)) return undefined;
	return `Writes are limited to this session's working directory and the system temp directory (denied: ${abs}).`;
}

/**
 * 文件工具（read/write/edit）路径治理（字面路径版，无软链解析，单测用）。write/edit 限本会话 cwd 与系统临时目录；
 * read 只禁状态/应用根/数据库/proc（读系统其余部分是合法探索）。相对路径与 .. 逃逸都归一化后再判。
 */
export function fileToolViolation(tool: string, path: string, cwd: string): string | undefined {
	return violationOf(tool, path, resolve(cwd, path), literalBases(cwd));
}

/** 解析到真实路径：取最近一个已存在的祖先 realpath 后拼回余下部分（write 新建文件时终段不存在，祖先足够定去向）。
 *  防 bash 先建软链再走文件工具的逃逸（ln -s /opt/dwell lnk 后 write lnk/state/users.json）；悬空软链按链接目标继续解析（写入会穿过链接落到目标处），
 *  非 ENOENT 异常退回字面路径（减速带非硬墙）。 */
async function resolveReal(abs: string, hops = 0): Promise<string> {
	let prefix = abs;
	const rest: string[] = [];
	for (;;) {
		try {
			return join(await realpath(prefix), ...rest);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") return abs;
			const target = hops < 40 ? await readlink(prefix).catch(() => undefined) : undefined;
			if (target !== undefined) return resolveReal(join(resolve(dirname(prefix), target), ...rest), hops + 1);
			const parent = dirname(prefix);
			if (parent === prefix) return abs;
			rest.unshift(basename(prefix));
			prefix = parent;
		}
	}
}

/** 路径治理（含软链解析）：目标与全部基准（cwd/tmp/state/应用根/data/sqlite）统一到 realpath 再判——
 *  只解析目标会把含软链的部署路径搞成两边不可比：写入误拦（cwd 在软链下）或读取漏拦（禁区经软链解析后不再匹配字面前缀）。 */
export async function fileToolViolationReal(tool: string, path: string, cwd: string): Promise<string | undefined> {
	const real = await resolveReal(resolve(cwd, path));
	const [rcwd, rtmp, rstate, rappRoot, rdata, rsqlite] = await Promise.all(
		[resolve(cwd), tmpdir(), STATE_PATH, APP_ROOT, DATA_PATH, SQLITE_FILE].map((p) => resolveReal(p)),
	);
	return violationOf(tool, path, real, { cwd: rcwd, tmp: rtmp, state: rstate, appRoot: rappRoot, data: rdata, sqlite: rsqlite });
}

/** dwell.lark.send 的来源判定：目标与 cwd 都 realpath 后判包含，不放行系统临时目录（外发比写盘更严）。 */
export async function sendPathViolation(path: string, cwd: string): Promise<string | undefined> {
	const real = await resolveReal(resolve(cwd, path));
	const realCwd = await resolveReal(resolve(cwd));
	if (real === realCwd || real.startsWith(realCwd + sep)) return undefined;
	return `Only files inside this session's working directory can be sent (denied: ${real}).`;
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
					const cwd = (await cwdOf(api.conversationId as number, context)) ?? DEFAULT_CWD;
					const violation = await fileToolViolationReal(call.name, path, resolve(cwd));
					if (violation === undefined) return undefined;
					return { block: violation };
				},
			}),
		],
	});
}

/** bash 危险命令判定与拦截（同步；beforeTool 调用，单测直接覆盖）：
 *  scope = 子会话归并后的父线——窗口/归属/卡片按父线，待审记录被拦截命令所在的真实会话（后台子会话），审批后由此唤醒。 */
export function bashApprovalBlock(command: string, conversationId: number): { block: string } | undefined {
	if (stateFileBlocked(command)) {
		return { block: "Access to service state files or the process environment is not allowed." };
	}
	// sudo 在本环境永不可能成功（NoNewPrivileges + dwell 无 sudo 组），直接说明，不走审批
	if (/\bsudo\b/.test(command)) {
		return { block: "The service runs as a non-root user without sudo, so this command cannot run. Tell the user and use an approach that does not need elevated privileges." };
	}
	const match = dangerMatch(command);
	if (match === null) return undefined;
	const scope = scopeOf(conversationId);
	// 后台子会话优先用自己的归属（start 时登记的创建者，不随父线新消息漂移）；普通会话即自身
	const sender = runSender.get(conversationId) ?? runSender.get(scope) ?? "";
	if (windowOpen(scope, sender)) return undefined;
	// 父线与其子会话（同创建者）共用窗口键：后到的拦截并入目标列表，不覆盖先到者——否则先被拦的会话审批后无人唤醒
	const key = windowKey(scope, sender);
	const targets = [...new Set([...(pendingApprovals.get(key)?.targets ?? []), conversationId])];
	pendingApprovals.set(key, { command, match, trigger: sender, via: runVia.get(scope) ?? "feishu", targets });
	void persistApprovals();
	onApprovalNeeded?.(scope, sender, command, match);
	// 面板入口的审批只在面板处理（飞书成员 /approve 开的是自己的窗口，帮不上忙）
	const viaPanel = runVia.get(scope) === "panel";
	return { block: viaPanel
		? `The approval policy blocked this command (${match}). An admin has been notified to approve it in the panel; tell the user to wait. Continue the original task after approval, and do not try to work around the block.`
		: `The approval policy blocked this command (${match}). Tell the user to tap the button on the approval card or reply /approve (10-minute window by default). Continue the original task after approval, and do not try to work around the block.` };
}

/** 挂到 registry 的 extension；只管 bash，其余工具放行。 */
export function makeApprovalExtension() {
	return defineExtension({
		name: "dwell-approval",
		hooks: [
			hook(ToolTask, {
				beforeTool: (call, api) => {
					// dwell.proc start 与 bash 同一条危险命令闸（否则它就是绕过审批的通道）；status/stop 只读/受控，放行
					if (call.name === "dwell.proc") {
						const args = call.arguments as { action?: unknown; command?: unknown };
						if (args.action !== "start") return undefined;
						return bashApprovalBlock(typeof args.command === "string" ? args.command : "", api.conversationId as number);
					}
					if (call.name !== "bash") return undefined;
					return bashApprovalBlock((call.arguments as { command?: string }).command ?? "", api.conversationId as number);
				},
			}),
		],
	});
}
