// 危险命令审批（简版 Mandate）+ 文件工具路径治理 + 审批状态持久化。
// 窗口键 = (conversationId, sender)：谁触发谁申请，互不搭车。
// 注意：正则与路径检查是减速带，硬边界是凭证擦除（harness.scrubSecretEnv）+ 部署隔离（容器/systemd）。
import { readFile, readlink, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { defineExtension, GenerationTask, hook, LiveDoc, ToolTask, type ConversationId, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { APP_ROOT, DATA_DIR, DEFAULT_CWD, STATE_DIR, stateFile, writeStateJson } from "../state.ts";
import { filePathViolation, type PathBases } from "../file-policy.ts";
export type { PathBases } from "../file-policy.ts";

/** conversationId → 当前 run 的发起者（submit 前设置，run 归属判定用）。 */
export const runSender = new Map<number, string>();

/** conversationId → 当前 run 的发起入口；决定审批卡片是否发到飞书。 */
export type RunVia = "panel" | "feishu" | "telegram";
export const runVia = new Map<number, RunVia>();

/** Legacy autonomous tasks predate creatorVia; infer only identities with a known namespace. */
export function creatorVia(sender: string, via?: RunVia): RunVia | undefined {
	return via ?? (sender.startsWith("tg:") ? "telegram" : sender.startsWith("ou_") ? "feishu" : undefined);
}

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
	via: RunVia;
	createdAt?: number;
	/** 等待这次审批的会话：scope 本身和/或它的后台子会话（同一窗口键下可能先后被拦多个，决定后逐个唤醒）。缺省 = scope */
	targets?: number[];
	targetBudgetIds?: Record<string, string>;
	requestId?: string;
	/** 飞书审批卡片的消息 ID，其他入口做出决定后据此更新卡片 */
	cardMessageId?: string;
	cardChatId?: string;
	cardDestination?: import("../pipeline.ts").ConversationDestination;
	notificationState?: "sending" | "sent" | "uncertain" | "failed";
};

/** 待审批上下文：key 同审批窗口，卡片点击后更新形态 / 校验归属用。 */
export const pendingApprovals = new Map<string, PendingApproval>();

export type ApprovalTarget = { conversationId: number; budgetId?: string; status: "pending" | "accepted" | "unavailable" };
export type ApprovalDecision = PendingApproval & {
	id: string;
	key: string;
	scope: number;
	action: "approve" | "deny";
	minutes: number;
	decidedAt: number;
	expiresAt: number;
	reply?: { chatId: string; messageId: string; destination?: import("../pipeline.ts").ConversationDestination };
	deliveryTargets: ApprovalTarget[];
};

export const approvalDecisions = new Map<string, ApprovalDecision>();
let captureBudget: (conversationId: number) => string | undefined | Promise<string | undefined> = () => undefined;
export function setApprovalBudgetGetter(fn: typeof captureBudget): void { captureBudget = fn; }

type ApprovalState = {
	windows: [string, number][];
	pending: [string, PendingApproval][];
	runSender: [string, string][];
	runVia: [string, RunVia][];
	decisions: [string, ApprovalDecision][];
};
let stateChain: Promise<unknown> = Promise.resolve();
const snapshot = (): ApprovalState => structuredClone({
	windows: [...approvals], pending: [...pendingApprovals],
	runSender: [...runSender].map(([id, sender]) => [String(id), sender]),
	runVia: [...runVia].map(([id, via]) => [String(id), via]), decisions: [...approvalDecisions],
});
function publish(state: ApprovalState): void {
	approvals.clear(); for (const [key, value] of state.windows) approvals.set(key, value);
	pendingApprovals.clear(); for (const [key, value] of state.pending) pendingApprovals.set(key, value);
	runSender.clear(); for (const [id, value] of state.runSender) runSender.set(Number(id), value);
	runVia.clear(); for (const [id, value] of state.runVia) runVia.set(Number(id), value);
	approvalDecisions.clear(); for (const [id, value] of state.decisions) approvalDecisions.set(id, value);
}

// Snapshot inside the queue: a queued card/pending write must see committed decisions.
function changeState<T>(change: (state: ApprovalState) => T | Promise<T>): Promise<T> {
	const run = async (): Promise<T> => {
		const candidate = snapshot();
		const result = await change(candidate);
		await writeStateJson(stateFile("approvals.json"), candidate);
		publish(candidate);
		return result;
	};
	const result = stateChain.then(run, run);
	stateChain = result.catch(() => {});
	return result;
}

export function setRunAttribution(conversationId: number, sender: string, via?: RunVia): Promise<void> {
	return changeState((state) => {
		state.runSender = [...state.runSender.filter(([id]) => id !== String(conversationId)), [String(conversationId), sender]];
		if (via !== undefined) state.runVia = [...state.runVia.filter(([id]) => id !== String(conversationId)), [String(conversationId), via]];
	});
}

export function setPendingApprovalCard(key: string, expected: PendingApproval, chatId: string, messageId: string, destination?: import("../pipeline.ts").ConversationDestination): Promise<void> {
	return changeState((state) => {
		const pending = state.pending.find(([k]) => k === key)?.[1];
		if (pending === undefined || pending.requestId !== expected.requestId) return;
		pending.cardChatId = chatId;
		pending.cardMessageId = messageId;
		if (destination !== undefined) pending.cardDestination = destination;
		if (destination?.kind === "telegram") pending.notificationState = "sent";
	});
}

export function claimApprovalNotification(key: string, requestId: string): Promise<boolean> {
	return changeState((state) => {
		const pending = state.pending.find(([k]) => k === key)?.[1];
		if (pending?.requestId !== requestId || pending.cardMessageId !== undefined || pending.notificationState !== undefined) return false;
		pending.notificationState = "sending";
		return true;
	});
}

export function failApprovalNotification(key: string, requestId: string, uncertain: boolean): Promise<void> {
	return changeState((state) => {
		const pending = state.pending.find(([k]) => k === key)?.[1];
		if (pending?.requestId === requestId && pending.notificationState === "sending") pending.notificationState = uncertain ? "uncertain" : "failed";
	});
}

/** 重试入口：确定性发送失败（failed）且尚无卡片的通知，重启时清回未发送态重发一次；uncertain 不重试 */
export function resetApprovalNotification(key: string, requestId: string): Promise<boolean> {
	return changeState((state) => {
		const pending = state.pending.find(([k]) => k === key)?.[1];
		if (pending?.requestId !== requestId || pending.notificationState !== "failed") return false;
		pending.notificationState = undefined;
		return true;
	});
}

export function grantApprovalWindow(key: string, minutes: number, expiresAt = Date.now() + clampMinutes(minutes) * 60_000, expected?: { previousExpiresAt?: number; noPending: boolean }): Promise<boolean> {
	return changeState((state) => {
		if (expected !== undefined && (state.windows.find(([k]) => k === key)?.[1] !== expected.previousExpiresAt || (expected.noPending && state.pending.some(([k]) => k === key)))) return false;
		state.windows = [...state.windows.filter(([k]) => k !== key), [key, expiresAt]];
		return true;
	});
}

export type ApprovalRevocation = { windows: [string, number][]; pending: [string, string][]; decisions: string[] };

export function captureApprovalRevocation(scope: number, sender?: string): ApprovalRevocation {
	const matches = (key: string): boolean => sender === undefined ? key.startsWith(`${scope}:`) : key === windowKey(scope, sender);
	return {
		windows: [...approvals].filter(([key]) => matches(key)),
		pending: [...pendingApprovals].filter(([key, value]) => matches(key) && value.requestId !== undefined).map(([key, value]) => [key, value.requestId!]),
		decisions: [...approvalDecisions.values()].filter((decision) => matches(decision.key)).map((decision) => decision.id),
	};
}

export function revokeApprovalSnapshot(targets: ApprovalRevocation): Promise<void> {
	return changeState((state) => {
		state.windows = state.windows.filter(([key, expiresAt]) => !targets.windows.some(([k, at]) => k === key && at === expiresAt));
		state.pending = state.pending.filter(([key, value]) => !targets.pending.some(([k, id]) => k === key && id === value.requestId));
		for (const [id, decision] of state.decisions) if (targets.decisions.includes(id)) {
			for (const target of decision.deliveryTargets) if (target.status === "pending") target.status = "unavailable";
		}
	});
}

export function revokeApprovalWindows(scope: number, sender?: string): Promise<void> {
	return changeState((state) => {
		const matches = (key: string): boolean => sender === undefined ? key.startsWith(`${scope}:`) : key === windowKey(scope, sender);
		state.windows = state.windows.filter(([key]) => !matches(key));
		state.pending = state.pending.filter(([key]) => !matches(key));
		for (const [, decision] of state.decisions) if (matches(decision.key)) {
			for (const target of decision.deliveryTargets) if (target.status === "pending") target.status = "unavailable";
		}
	});
}

/** Stop one child without revoking the shared approval window or other waiting conversations. */
export function removeApprovalTarget(conversationId: number): Promise<void> {
	return stateChain.then(() => {
		const waiting = [...pendingApprovals].some(([key, pending]) => (pending.targets ?? [Number(key.split(":")[0])]).includes(conversationId));
		const undelivered = [...approvalDecisions.values()].some((decision) => decision.deliveryTargets.some((target) => target.conversationId === conversationId && target.status === "pending"));
		if (!waiting && !undelivered) return;
		return changeState((state) => {
			state.pending = state.pending.filter(([key, pending]) => {
				const previous = pending.targets ?? [Number(key.split(":")[0])];
				if (!previous.includes(conversationId)) return true;
				pending.targets = previous.filter((id) => id !== conversationId);
				if (pending.targetBudgetIds !== undefined) delete pending.targetBudgetIds[String(conversationId)];
				return pending.targets.length > 0;
			});
			for (const [, decision] of state.decisions) {
				for (const target of decision.deliveryTargets) if (target.conversationId === conversationId && target.status === "pending") target.status = "unavailable";
			}
		});
	});
}

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

/** Persist a fresh snapshot after earlier approval mutations; failures reach the caller. */
export function persistApprovals(): Promise<void> {
	return changeState(() => {});
}

/** 启动时恢复审批状态（在 harness.resume 前，续跑任务的审批判定用得上）。 */
export async function loadApprovalState(): Promise<void> {
	await stateChain;
	let saved: Partial<ApprovalState>;
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
	for (const [id, decision] of saved.decisions ?? []) approvalDecisions.set(id, decision);
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
const STATE_FILES = /users\.json|sessions\.json|message-map\.json|approvals\.json|telegram-chats\.json|runtime-telemetry\.json|telegram[\\/]\d+\.json|(?:^|[\s"'=/\\])\.env\b|(?<![\w-])state[\\/]|\$\{?DWELL_STATE\b|\/proc\/[^\s/]*\/environ/;
let modelConfigPaths: string[] = [];

/** Protect only the selected connection file; project files may also be named models.json. */
export function setModelConfigGuard(path: string | undefined): void {
	modelConfigPaths = path === undefined ? [] : [...new Set([resolve(path), realpathSync(path)])];
}

export function stateFileBlocked(command: string): boolean {
	return STATE_FILES.test(command) || (modelConfigPaths.length > 0 && (
		modelConfigPaths.some((path) => command.includes(path)) || /\$(?:DWELL_MODELS_FILE\b|\{DWELL_MODELS_FILE(?:\}|[:?+\-]))/.test(command)
	));
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
	if (expiry <= Date.now()) {
		return false;
	}
	return true;
}

/** 审批决定后交给模型的续跑输入（卡片、/approve、panel 三条路径共用）。 */
export function decisionInput(action: "approve" | "deny", minutes: number, expiresAt?: number): string {
	if (action === "approve" && expiresAt !== undefined && expiresAt <= Date.now()) return "The user approved the blocked command, but that approval window has already expired. Continue the original task subject to the current approval policy; request approval again before retrying a dangerous command.";
	if (action === "approve" && expiresAt !== undefined) return `The user approved a ${minutes}-minute window for dangerous commands, expiring at ${new Date(expiresAt).toISOString()}. Continue the previous task and retry the blocked command only while that window remains valid; request approval again if it has expired.`;
	return action === "approve"
		? `The user approved a ${minutes}-minute window for dangerous commands. Continue the previous task and retry the blocked command.`
		: "The user denied the dangerous command. Stop that operation and take another approach, or ask the user what they intend.";
}

/** Commit the decision and its delivery journal before publishing a new approval window. */
export function takeDecision(key: string, action: "approve" | "deny", minutes: number, reply?: ApprovalDecision["reply"], expectedRequestId?: string): Promise<ApprovalDecision | undefined> {
	return changeState((state) => {
		const pending = state.pending.find(([k]) => k === key)?.[1];
		if (pending === undefined || (expectedRequestId !== undefined && pending.requestId !== expectedRequestId)) return undefined;
		const scope = Number(key.split(":")[0]);
		const decidedAt = Date.now();
		const used = clampMinutes(minutes);
		const expiresAt = action === "approve" ? decidedAt + used * 60_000 : decidedAt;
		const decision: ApprovalDecision = {
			...pending, id: randomUUID(), key, scope, action, minutes: used, decidedAt, expiresAt,
			...(reply === undefined ? {} : { reply }),
			deliveryTargets: [...new Set(pending.targets ?? [scope])].map((conversationId) => ({
				conversationId, status: "pending", ...(pending.targetBudgetIds?.[String(conversationId)] === undefined ? {} : { budgetId: pending.targetBudgetIds[String(conversationId)] }),
			})),
		};
		state.pending = state.pending.filter(([k]) => k !== key);
		state.windows = state.windows.filter(([k]) => k !== key);
		if (action === "approve") state.windows.push([key, expiresAt]);
		state.decisions.push([decision.id, decision]);
		return structuredClone(decision);
	});
}

let drainChain: Promise<unknown> = Promise.resolve();
export function drainApprovalDecisions(deliver: (decision: ApprovalDecision, target: ApprovalTarget) => Promise<"accepted" | "unavailable">, decisionId?: string, present?: (decision: ApprovalDecision) => Promise<void>): Promise<{ pending: number; unavailable: number }> {
	const run = async () => {
		const ids = decisionId === undefined ? [...approvalDecisions.keys()] : [decisionId];
		for (const id of ids) {
			const saved = approvalDecisions.get(id);
			if (present !== undefined && saved !== undefined) void Promise.resolve().then(() => present(structuredClone(saved))).catch((err: unknown) => console.error("[dwell] 审批卡片更新失败:", err));
			const targets = approvalDecisions.get(id)?.deliveryTargets ?? [];
			for (const target of targets) {
				const decision = approvalDecisions.get(id);
				const current = decision?.deliveryTargets.find((t) => t.conversationId === target.conversationId);
				if (decision === undefined || current?.status !== "pending") continue;
				try {
					const status = await deliver(structuredClone(decision), structuredClone(current));
					await changeState((state) => {
						const found = state.decisions.find(([key]) => key === id)?.[1].deliveryTargets.find((t) => t.conversationId === target.conversationId);
						if (found?.status === "pending") found.status = status;
					});
				} catch (err) { console.error(`[dwell] 审批续跑待重试 ${id}/#${target.conversationId}:`, err); }
			}
		}
		const targets = ids.flatMap((id) => approvalDecisions.get(id)?.deliveryTargets ?? []);
		return { pending: targets.filter((t) => t.status === "pending").length, unavailable: targets.filter((t) => t.status === "unavailable").length };
	};
	const result = drainChain.then(run, run);
	drainChain = result.catch(() => {});
	return result;
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

/** 字面基准（不做软链解析）：fileToolViolation 用。 */
const literalBases = (cwd: string): PathBases => ({ cwd: resolve(cwd), tmp: tmpdir(), state: STATE_PATH, appRoot: APP_ROOT, data: DATA_PATH, sqlite: SQLITE_FILE, modelConfig: modelConfigPaths[0] });

export const fileGuardBases = literalBases;

/** 判定核心：`abs` 与 `bases` 同形态。`rawPath` 用于 /proc 的原始路径检查（Windows 下 resolve 会把 POSIX 绝对路径变成盘符路径）。 */
function violationOf(tool: string, rawPath: string, abs: string, bases: PathBases): string | undefined {
	if (rawPath === "/proc" || rawPath.startsWith("/proc/")) return "Access to /proc is not allowed.";
	return filePathViolation(tool, abs, bases);
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
	const modelConfig = modelConfigPaths[0] === undefined ? undefined : await resolveReal(modelConfigPaths[0]);
	return violationOf(tool, path, real, { cwd: rcwd, tmp: rtmp, state: rstate, appRoot: rappRoot, data: rdata, sqlite: rsqlite, modelConfig });
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
export function bashApprovalBlock(command: string, conversationId: number, selfApproval = true): { block: string; saved?: Promise<void> } | undefined {
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
	const sender = runSender.get(conversationId) ?? "";
	if (sender === "") return { block: "The run has no verified creator. Ask the user to submit the task again; do not request or reuse an approval window." };
	if (windowOpen(scope, sender)) return undefined;
	// 父线与其子会话（同创建者）共用窗口键：后到的拦截并入目标列表，不覆盖先到者——否则先被拦的会话审批后无人唤醒
	const key = windowKey(scope, sender);
	const via = runVia.get(conversationId) ?? "feishu";
	const saved = changeState(async (state) => {
		const previous = state.pending.find(([k]) => k === key)?.[1];
		const budgetId = await captureBudget(conversationId);
		const targets = [...new Set([...(previous?.targets ?? []), conversationId])];
		const pending: PendingApproval = {
			...previous, command, match, trigger: sender, via, targets, requestId: previous?.requestId ?? randomUUID(), createdAt: previous?.createdAt ?? Date.now(),
			targetBudgetIds: { ...previous?.targetBudgetIds, ...(budgetId === undefined ? {} : { [String(conversationId)]: budgetId }) },
		};
		state.pending = [...state.pending.filter(([k]) => k !== key), [key, pending]];
	}).then(() => { onApprovalNeeded?.(scope, sender, command, match); });
	void saved.catch((err: unknown) => console.error("[dwell] 待审批状态写入失败:", err));
	// 面板入口的审批只在面板处理（飞书成员 /approve 开的是自己的窗口，帮不上忙）
	const viaPanel = via === "panel";
	return { saved, block: viaPanel
		? `The approval policy blocked this command (${match}). An admin has been notified to approve it in the panel; tell the user to wait. Continue the original task after approval, and do not try to work around the block.`
		: !selfApproval ? `The approval policy blocked this command (${match}). This group-only user cannot approve dangerous commands. A dwell administrator must approve the original approval card; tell the user to wait. Continue the original task after approval, and do not try to work around the block.`
		: `The approval policy blocked this command (${match}). Tell the user to tap the button on the approval card or reply /approve (10-minute window by default). Continue the original task after approval, and do not try to work around the block.` };
}

/** Generation hooks ignore ordinary errors; cancellation must reach the invocation before returning. */
export async function abortBeforeRequest(harness: Harness, taskId: TaskId, context: Context): Promise<never> {
	const abort = harness.abortTask(taskId, BACKGROUND_CONTEXT).catch((error: unknown) => {
		void harness.close(BACKGROUND_CONTEXT).catch(() => {});
		throw error;
	});
	void abort.catch(() => {});
	const signal = context.abortSignal;
	if (signal === undefined) throw new Error("Stopping a model request requires an invocation abort signal");
	if (!signal.aborted) {
		let listener: (() => void) | undefined;
		try {
			await Promise.race([
				new Promise<void>((resolve) => {
					listener = resolve;
					signal.addEventListener("abort", listener, { once: true });
					if (signal.aborted) resolve();
				}),
				abort,
			]);
		} finally { if (listener !== undefined) signal.removeEventListener("abort", listener); }
	}
	signal.throwIfAborted();
	throw new Error("The run was stopped before its model request");
}

/** Restore the first input's actor; steering messages never transfer the active run's authority. */
export type CanSelfApprove = (conversationId: number, sender: string, via: RunVia) => boolean;

export function makeApprovalExtension(getHarness?: () => Harness | undefined, canSelfApprove?: CanSelfApprove) {
	const restore = async (harness: Harness, conversationId: ConversationId, context: Context, expectedTask?: TaskId) => {
		const live = await harness.snapshot(LiveDoc, conversationId, context);
		const input = live?.run?.inputs[0];
		if (input === undefined) throw new Error("Run has no first input");
		const submission = await harness.submission(input, context);
		const status = await submission?.status(context);
		const attribution = await harness.commit(async (tx) => {
			const current = await tx.doc(LiveDoc, conversationId);
			if (current.run?.inputs[0] !== input || (expectedTask !== undefined && current.run.taskId !== expectedTask)) throw new Error("Run changed before attribution");
			const entry = status?.entry === undefined ? undefined : await tx.entry(status.entry);
			if (entry?.kind !== "chat.message" && entry?.kind !== "panel.message" && entry?.kind !== "dwell.approval" && entry?.kind !== "dwell.approval.legacy") throw new Error("Run input has no durable actor metadata");
			const data = entry.data;
			if (typeof data !== "object" || data === null || Array.isArray(data) || typeof data.sender !== "string" || data.sender === "") throw new Error("Run input has no verified creator");
			const source = data.authorityVia ?? data.via;
			const via = creatorVia(data.sender, source === "panel" || source === "feishu" || source === "telegram" ? source : undefined);
			if (via === undefined) throw new Error("Run input has no verified authority entry point");
			return { sender: data.sender, via };
		}, context);
		if (runSender.get(conversationId) !== attribution.sender || runVia.get(conversationId) !== attribution.via) await setRunAttribution(conversationId, attribution.sender, attribution.via);
	};
	return defineExtension({
		name: "dwell-approval",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					const harness = getHarness?.();
					if (harness !== undefined) {
						try { await restore(harness, api.conversationId, context); }
						catch { return { block: "The run's creator could not be verified. Ask the user to submit the task again; do not continue tools under another actor." }; }
					}
					// dwell.proc start 与 bash 同一条危险命令闸（否则它就是绕过审批的通道）；status/stop 只读/受控，放行
					if (call.name === "dwell.proc") {
						const args = call.arguments as { action?: unknown; command?: unknown };
						if (args.action !== "start") return undefined;
						const id = api.conversationId as number;
						const blocked = bashApprovalBlock(typeof args.command === "string" ? args.command : "", id, canSelfApprove?.(id, runSender.get(id) ?? "", runVia.get(id) ?? "panel"));
						await blocked?.saved;
						return blocked === undefined ? undefined : { block: blocked.block };
					}
					if (call.name !== "bash") return undefined;
					const id = api.conversationId as number;
					const blocked = bashApprovalBlock((call.arguments as { command?: string }).command ?? "", id, canSelfApprove?.(id, runSender.get(id) ?? "", runVia.get(id) ?? "panel"));
					await blocked?.saved;
					return blocked === undefined ? undefined : { block: blocked.block };
				},
			}),
			hook(GenerationTask, {
				beforeRequest: async (_request, api, context) => {
					const harness = getHarness?.();
					if (harness === undefined) return;
					try {
						await restore(harness, api.conversationId, context, api.taskId);
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						console.error("[dwell] 运行归属恢复失败，停止本次运行:", error);
						await abortBeforeRequest(harness, api.taskId, context);
					}
				},
			}),
		],
	});
}
