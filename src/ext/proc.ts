// 托管后台进程：dwell.proc 工具 + dwell.proc-run durable 任务。
// 一个进程对应一个 background task：宿主直接 spawn（shell 与 bash 工具同一沙箱 wrapper，进沙箱语义不变），
// watch 阶段等退出，report 以 followUp 回会话并开卡。进程与任务同生命周期：stop（abortTask）杀进程组；
// dwell 重启后（--die-with-parent + systemd cgroup）任务 resume 发现内存表无记录 → 回报「被服务重启中断」。
// 不做跨重启存活：那要求进程脱离沙箱与 cgroup，安全边界需另行论证。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTask, defineTool, section, type ConversationId, type Extension, type Harness, type SubmissionId, type TaskId, type TaskRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "typebox";
import { creatorVia, type RunVia } from "./approval.ts";
import { scanLiveTasks } from "./schedule.ts";
import { STATE_DIR } from "../state.ts";

export const PROC_TASK_KIND = "dwell.proc-run";

/** 成本闸：并发进程数（真进程不烧 token，但占内存与外联带宽，沙箱下还各占一个 bwrap 实例）。 */
export const PROC_MAX_PER_CONVERSATION = 5;
export const PROC_MAX_TOTAL = 10;
/** A parent-held append handle enforces the cap before each write. */
export const PROC_LOG_MAX_BYTES = 50 * 1024 * 1024;
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_READ_MAX_BYTES = 64 * 1024;
const OUTPUT_DRAIN_MS = 5000;
const TRUNCATION_MARKER = Buffer.from("[dwell] log truncated (size cap)\n");
const LOG_ROOT = join(resolve(STATE_DIR), "proc-logs");

export type ProcInput = {
	readonly name: string;
	readonly command: string;
	readonly notify: boolean;
	readonly creator: string;
	readonly creatorVia?: RunVia;
	readonly conversationId: number;
};

type ProcCheckpoint =
	| { phase: "start" }
	| { phase: "watch"; pid: number; startedAt: number; logVersion?: 1; logPath?: string }
	| { phase: "report"; code: number | null; lost: boolean; startedAt: number; logVersion?: 1; logPath?: string; note?: string }
	| { phase: "announce"; submissionId: number };

export type ProcDeps = {
	/** run 归属登记（退出回报触发的会话 run 归到创建者）。report 阶段 await 它完成才 submit（约束同 ScheduleDeps.attribute） */
	attribute: (conversationId: number, creator: string) => Promise<void>;
	/** 回报 run 由宿主开回复卡（与定时/后台任务同一入口） */
	onFired: (conversationId: number, submissionId: SubmissionId, header: string) => void | Promise<void>;
	/** stop 需要 abortTask；装配时 harness 尚未创建，getter 延迟绑定 */
	getHarness: () => Pick<Harness, "abortTask"> | undefined;
	/** 当前 run 发起者（进程创建者记录用） */
	senderOf: (conversationId: number) => string | undefined;
	viaOf?: (conversationId: number) => RunVia | undefined;
	/** spawn 用的 shell（沙箱 wrapper 或系统 bash）；空 path = 不可用，start 阶段报错 */
	shell: () => { readonly path: string; readonly sandboxed: boolean };
};

// ── 纯函数（单测覆盖） ──

export function procNameViolation(name: string): string | undefined {
	const n = name.trim();
	if (n === "") return "name is required.";
	if (n.length > 40) return "name must be at most 40 characters.";
	if (!/^[\w.-]+$/.test(n)) return "name may only contain letters, digits, '_', '-', and '.'.";
	return undefined;
}

export function procCapViolation(perConversation: number, total: number): string | undefined {
	if (perConversation >= PROC_MAX_PER_CONVERSATION) return `This conversation already runs ${perConversation} background processes (max ${PROC_MAX_PER_CONVERSATION}); stop one first.`;
	if (total >= PROC_MAX_TOTAL) return `The server already runs ${total} background processes in total (max ${PROC_MAX_TOTAL}); stop one or wait.`;
	return undefined;
}

/** 日志尾（工具与回报共用；行数保留最近的）。 */
export function tailLines(text: string, lines: number): string {
	return text.split("\n").slice(-lines).join("\n");
}

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60 === 0 ? "" : ` ${s % 60}s`}`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** 退出回报正文（纯函数：正文构造与 IO 分离，单测覆盖）。 */
export function formatProcExitReport(name: string, code: number | null, lost: boolean, seconds: number, logTail: string, taskId: number): string {
	const head = lost
		? `[Background process ${name}] The dwell service restarted while it was running, so the process was terminated. It had run for ${formatDuration(seconds * 1000)}.`
		: code === null
			? `[Background process ${name}] exited abnormally (spawn failure or killed by a signal) after ${formatDuration(seconds * 1000)}.`
			: `[Background process ${name} exited with code ${code}] after ${formatDuration(seconds * 1000)}.`;
	const tail = logTail.trim() === "" ? "" : `\nLast log lines:\n${logTail.trim()}`;
	return `${head} taskId: ${taskId}.${tail}\n(Relay or act on this result. Read more with dwell.proc.logs using taskId ${taskId}.)`;
}

export function formatProcList(tasks: TaskRecord<JsonValue, JsonValue, JsonValue>[], now: number): string {
	if (tasks.length === 0) return "No background processes in this conversation.";
	const lines = tasks.map((task) => {
		const input = task.input as ProcInput;
		const label = `${input.name} · taskId ${task.id}`;
		const ck = task.state.status === "running" && task.state.checkpoint !== undefined ? (task.state.checkpoint as ProcCheckpoint | { phase: "announce"; submissionId: number }) : undefined;
		if (ck === undefined) return `- ${label} · finishing`;
		if (ck.phase === "start") return `- ${label} · starting`;
		if (ck.phase === "watch") return `- ${label} (pid ${ck.pid}) · running for ${formatDuration(now - ck.startedAt)}`;
		if (ck.phase === "report") return `- ${label} · exiting (reporting the result)`;
		return `- ${label} · finishing`;
	});
	return `Background processes in this conversation:\n${lines.join("\n")}`;
}

// ── 进程表与杀树 ──

/** taskId → 活着的 ChildProcess（仅内存）。重启后空 → watch 报 lost；杀进程只经它，永不按记录 pid 杀（可能已被复用）。
 *  导出供测试：同进程内 close→reopen 模拟服务重启时先 clear（真重启是新进程，表天然为空；同进程复用旧 child 继续等也正确，但 lost 语义测不到）。 */
export const procTable = new Map<number, ChildProcess>();
type CaptureResult = { code: number | null; note?: string };
type Capture = { done: Promise<CaptureResult>; closed: boolean; leaderExited: boolean; beginDrain: () => void };
const captures = new Map<number, Capture>();

function killTree(pid: number, signal: "SIGTERM" | "SIGKILL", allowPidFallback = true): void {
	// Windows 无进程组信号：taskkill /F /T 即刻强杀整树，SIGTERM/SIGKILL 之分的优雅停止只在 POSIX 存在
	if (process.platform === "win32") {
		if (!allowPidFallback) return;
		spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
		return;
	}
	try {
		process.kill(-pid, signal); // 组击杀：沙箱下 SIGTERM 即拆 pidns 全灭
	} catch {
		if (!allowPidFallback) return;
		try {
			process.kill(pid, signal);
		} catch {
			// 已死则罢
		}
	}
}

function errorLabel(err: unknown): string {
	return (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
}

async function logDirectory(conversationId: number, create: boolean): Promise<string> {
	const state = resolve(STATE_DIR);
	if (create) await mkdir(state, { recursive: true, mode: 0o700 });
	for (const path of [state, LOG_ROOT, join(LOG_ROOT, String(conversationId))]) {
		if (create && path !== state) await mkdir(path, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => { if (err.code !== "EEXIST") throw err; });
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Process log directory is not a private regular directory");
	}
	return join(LOG_ROOT, String(conversationId));
}

async function openLog(conversationId: number, taskId: number, create: boolean): Promise<FileHandle> {
	const dir = await logDirectory(conversationId, create);
	const flags = create
		? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0)
		: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
	const path = join(dir, `${taskId}.log`);
	if (!create) {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("Process log is not a regular file");
	}
	const handle = await open(path, flags, 0o600);
	try {
		if ((await handle.stat()).isFile()) return handle;
		throw new Error("Process log is not a regular file");
	} catch (err) {
		await handle.close();
		throw err;
	}
}

async function readLogTail(conversationId: number, taskId: number, lines: number): Promise<{ text: string; omitted: boolean }> {
	const handle = await openLog(conversationId, taskId, false);
	try {
		const size = (await handle.stat()).size;
		// Leave room for the tool header and a replacement character at a UTF-8 boundary.
		const length = Math.min(size, LOG_READ_MAX_BYTES - 256);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, size - length);
		let decoded = buffer.subarray(0, bytesRead).toString("utf8");
		const encoded = Buffer.from(decoded);
		const expanded = encoded.length > LOG_READ_MAX_BYTES - 256;
		if (expanded) {
			let start = encoded.length - (LOG_READ_MAX_BYTES - 256);
			while ((encoded[start]! & 0xc0) === 0x80) start++;
			decoded = encoded.subarray(start).toString("utf8");
		}
		return { text: tailLines(decoded, lines), omitted: expanded || size > length || decoded.split("\n").length > lines };
	} finally { await handle.close(); }
}

/** Prune only verified terminal task logs. Active tasks and legacy workspace files are untouched. */
export async function pruneProcLogs(harness: Pick<Harness, "getTask">, now = Date.now()): Promise<void> {
	const stateInfo = await lstat(resolve(STATE_DIR)).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
	if (stateInfo === undefined) return;
	if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) throw new Error("Process log state directory is not a regular directory");
	const rootInfo = await lstat(LOG_ROOT).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
	if (rootInfo === undefined) return;
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Process log store is not a private regular directory");
	for (const entry of await readdir(LOG_ROOT, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
		const conversationId = Number(entry.name);
		if (!Number.isSafeInteger(conversationId)) continue;
		const dir = await logDirectory(conversationId, false);
		for (const file of await readdir(dir, { withFileTypes: true })) {
			if (!file.isFile() || !/^[1-9]\d*\.log$/.test(file.name)) continue;
			const taskId = Number(file.name.slice(0, -4));
			if (!Number.isSafeInteger(taskId)) continue;
			const task = await harness.getTask(taskId as TaskId, BACKGROUND_CONTEXT);
			if (task?.kind !== PROC_TASK_KIND || task.conversationId !== conversationId || task.state.status !== "terminal") continue;
			const path = join(dir, file.name);
			const info = await lstat(path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
			if (info?.isFile() && !info.isSymbolicLink() && (task.endedAt ?? info.mtimeMs) < now - LOG_RETENTION_MS) {
				await unlink(path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
			}
		}
	}
}

function captureOutput(child: ChildProcess, handle: FileHandle): Capture {
	let note: string | undefined;
	let size = 0;
	let writes = Promise.resolve();
	const capture: Capture = { done: Promise.resolve({ code: null }), closed: false, leaderExited: false, beginDrain: () => {} };
	let drainTimer: ReturnType<typeof setTimeout> | undefined;
	let resolveClosed: (code: number | null) => void;
	const closed = new Promise<number | null>((resolveClose) => { resolveClosed = resolveClose; });
	capture.beginDrain = (): void => {
		if (drainTimer !== undefined || capture.closed) return;
		drainTimer = setTimeout(() => {
			const warning = "Output drain timed out after 5 seconds; some output may be missing. Descendants outside the sandbox may still be running.";
			note = note === undefined ? warning : `${note} ${warning}`;
			if (child.pid !== undefined && !capture.closed) killTree(child.pid, "SIGKILL", !capture.leaderExited);
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.unref();
			resolveClosed(child.exitCode);
		}, OUTPUT_DRAIN_MS);
		drainTimer.unref();
	};
	const fail = (err: unknown): void => {
		if (note !== undefined) return;
		note = `Log capture failed (${errorLabel(err)}); the process was terminated.`;
		if (child.pid !== undefined && !capture.closed) killTree(child.pid, "SIGKILL", !capture.leaderExited);
		child.stdout?.destroy();
		child.stderr?.destroy();
		capture.beginDrain();
	};
	child.once("error", (err) => { note ??= `Cannot run the command (${errorLabel(err)}).`; capture.leaderExited = true; capture.beginDrain(); });
	// A descendant can retain a pipe after the leader exits, so close alone is not a deadline.
	child.once("exit", () => { capture.leaderExited = true; capture.beginDrain(); });
	child.once("close", (code) => {
		capture.closed = true;
		if (drainTimer !== undefined) clearTimeout(drainTimer);
		resolveClosed(code);
	});
	const append = (chunk: Buffer): Promise<void> => {
		writes = writes.then(async () => {
			let data = chunk;
			if (size + data.length > PROC_LOG_MAX_BYTES) {
				await handle.truncate(0);
				size = 0;
				data = Buffer.concat([TRUNCATION_MARKER, data.subarray(Math.max(0, data.length - (PROC_LOG_MAX_BYTES - TRUNCATION_MARKER.length)))]);
			}
			for (let offset = 0; offset < data.length;) {
				const { bytesWritten } = await handle.write(data, offset, data.length - offset);
				if (bytesWritten === 0) throw new Error("The process log write made no progress");
				offset += bytesWritten;
				size += bytesWritten;
			}
		});
		return writes;
	};
	const pump = async (stream: Readable | null): Promise<void> => {
		try {
			// Each pipe waits for its write: at most one chunk per pipe joins the queue.
			if (stream !== null) for await (const chunk of stream) await append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		} catch (err) { fail(err); }
	};
	capture.done = (async () => {
		await Promise.all([pump(child.stdout), pump(child.stderr)]);
		const code = await closed;
		if (note === undefined) {
			try { await append(Buffer.from(`\n[dwell] exited with code ${code === null ? "signal" : code}\n`)); }
			catch (err) { fail(err); }
		}
		await handle.close().catch((err: unknown) => { fail(err); });
		if (drainTimer !== undefined) clearTimeout(drainTimer);
		return { code, ...(note === undefined ? {} : { note }) };
	})();
	return capture;
}

async function cleanupLogs(harness: Pick<Harness, "getTask">): Promise<void> {
	await pruneProcLogs(harness).catch((err: unknown) => console.error("[dwell] 进程日志清理失败:", err));
}

// ── durable 任务 ──

export const makeProcTask = (deps: ProcDeps) =>
	defineTask<ProcInput, ProcCheckpoint, null>({
		name: PROC_TASK_KIND,
		version: 1,
		initial: () => ({ phase: "start" }),
		phases: {
			start: async (task, runtime, context) => {
				// Persist intent before spawning; replay must never execute the command twice.
				if (await runtime.memo<boolean>("spawned", context) !== undefined) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", code: null, lost: true, startedAt: runtime.now(), logVersion: 1 } }), context);
					return;
				}
				await runtime.memo<boolean>("spawned", true, context);
				const cwd = (await runtime.env(context))?.cwd;
				const shell = deps.shell();
				let log: FileHandle;
				try {
					if (cwd === undefined || shell.path === "") throw new Error(cwd === undefined ? "the conversation has no working directory" : "no shell is available");
					await mkdir(cwd, { recursive: true });
					log = await openLog(runtime.conversationId as number, runtime.taskId as number, true);
				} catch (err) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", code: null, lost: false, startedAt: runtime.now(), note: `Cannot initialize the process (${errorLabel(err)}). The command was not started.`, logVersion: 1 } }), context);
					return;
				}
				if (runtime.signal.aborted) { await log.close(); return; }
				let child: ChildProcess;
				try {
					child = spawn(shell.path, ["-c", task.input.command], {
						cwd,
						detached: process.platform !== "win32",
							env: { ...process.env, ...(process.env.DWELL_TOOL_PATH ? { PATH: process.env.DWELL_TOOL_PATH } : {}) },
						stdio: ["ignore", "pipe", "pipe"],
						windowsHide: true,
					});
				} catch (err) {
					await log.close();
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", code: null, lost: false, startedAt: runtime.now(), note: `Cannot run the command (${errorLabel(err)}).`, logVersion: 1 } }), context);
					return;
				}
				const capture = captureOutput(child, log);
				procTable.set(runtime.taskId as number, child);
				captures.set(runtime.taskId as number, capture);
				if (runtime.signal.aborted) {
					procTable.delete(runtime.taskId as number);
					captures.delete(runtime.taskId as number);
					capture.beginDrain();
					if (child.pid !== undefined) killTree(child.pid, "SIGKILL", !capture.leaderExited);
					await capture.done;
					return;
				}
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "watch", pid: child.pid ?? -1, startedAt: runtime.now(), logVersion: 1 } }), context);
			},
			watch: async (task, runtime, context) => {
				const prior = task.state.checkpoint;
				const startedAt = "startedAt" in prior ? prior.startedAt : runtime.now();
				const logVersion = "logVersion" in prior ? prior.logVersion : undefined;
				const capture = procTable.has(runtime.taskId as number) ? captures.get(runtime.taskId as number) : undefined;
				if (capture === undefined) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", code: null, lost: true, startedAt, ...(logVersion === undefined ? {} : { logVersion }) } }), context);
					return;
				}
				const result = await new Promise<CaptureResult | undefined>((resolveWait) => {
					const aborted = (): void => resolveWait(undefined);
					if (runtime.signal.aborted) { aborted(); return; }
					runtime.signal.addEventListener("abort", aborted, { once: true });
					void capture.done.then((done) => { runtime.signal.removeEventListener("abort", aborted); resolveWait(done); });
				});
				if (result === undefined || runtime.signal.aborted) return;
				procTable.delete(runtime.taskId as number);
				captures.delete(runtime.taskId as number);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", ...result, lost: false, startedAt, logVersion: 1 } }), context);
			},
			report: async (task, runtime, context) => {
				const input = task.input;
				const ck = task.state.checkpoint.phase === "report" ? task.state.checkpoint : undefined;
				if (ck !== undefined && (input.notify || ck.note !== undefined)) {
					await deps.attribute(input.conversationId, input.creator);
					const conversation = await runtime.conversation(input.conversationId as ConversationId, context);
					if (conversation === undefined) runtime.report(new Error(`Process task ${input.name}: conversation ${input.conversationId} is missing`));
					else {
						const tail = ck.logVersion === 1
							? await readLogTail(runtime.conversationId as number, runtime.taskId as number, 30).then((log) => `${log.omitted ? "[Earlier output omitted.]\n" : ""}${log.text}`).catch(() => "Process log is unavailable.")
							: "Legacy workspace log is unavailable; it was not read or migrated.";
						const content = ck.note === undefined
							? formatProcExitReport(input.name, ck.code, ck.lost, Math.round((runtime.now() - ck.startedAt) / 1000), tail, runtime.taskId as number)
							: `[Background process ${input.name}] taskId: ${runtime.taskId}. ${ck.note}\n${tail}`;
						const submission = await conversation.submit(
								{ type: "input", content, requestId: `proc:${String(runtime.taskId)}:exit`, whenBusy: "followUp", entry: { kind: "chat.message", data: { sender: input.creator, via: "proc", ...(creatorVia(input.creator, input.creatorVia) === undefined ? {} : { authorityVia: creatorVia(input.creator, input.creatorVia)! }) } } },
							context,
						);
						await runtime.commit(() => ({ status: "running", checkpoint: { phase: "announce", submissionId: submission.id as number } }), context);
						return;
					}
				}
				await cleanupLogs(runtime);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
			},
			announce: async (task, runtime, context) => {
				const ck = task.state.checkpoint.phase === "announce" ? task.state.checkpoint : undefined;
				if (ck !== undefined) await deps.onFired(task.input.conversationId, ck.submissionId as SubmissionId, `⚙️ 后台进程 ${task.input.name} 已退出`);
				await cleanupLogs(runtime);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
			},
		},
		abort: async (_task, runtime, context) => {
			const child = procTable.get(runtime.taskId as number);
			const capture = captures.get(runtime.taskId as number);
			procTable.delete(runtime.taskId as number);
			captures.delete(runtime.taskId as number);
			capture?.beginDrain();
			if (child?.pid !== undefined && !(capture?.closed ?? (child.exitCode !== null || child.signalCode !== null))) {
				killTree(child.pid, "SIGTERM", !(capture?.leaderExited ?? (child.exitCode !== null || child.signalCode !== null)));
			}
			if (capture !== undefined) {
				const result = await capture.done;
				if (result.note !== undefined) runtime.report(new Error(result.note));
			}
			await cleanupLogs(runtime);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});

function makeProcTool(deps: ProcDeps, ProcRun: ReturnType<typeof makeProcTask>) {
	const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
	return defineTool({
		name: "dwell.proc",
		description:
			"Manage background processes that keep running while the conversation stays free (dev servers, watchers, crawls, builds too long for one bash call). " +
			"start launches command in this conversation's sandbox and working directory and returns taskId. The service captures output privately; use dwell.proc.logs with taskId to inspect it. " +
			"status lists active processes and their taskIds; stop terminates a named process and its children. The exit code and log tail arrive as a follow-up unless notify is false. " +
			"/cancel and clearing context do not stop processes. Service restarts terminate them and report interruption. Completed logs are retained for seven days.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("stop")]),
			name: Type.Optional(Type.String({ description: "Process name (1-40 chars, unique among this conversation's running processes)" })),
			command: Type.Optional(Type.String({ description: "Shell command to run in the background (start only); it inherits the working directory and the sandbox" })),
			notify: Type.Optional(Type.Boolean({ description: "start only: false skips the follow-up report when the process exits (for long-lived watchers); default true" })),
		}),
		// 崩溃重放可能重复 start 新进程，不重跑；模型看到 interrupted 后可用 status 核对
		replay: "unsafe",
		async execute(args, api, context) {
			if (args.action === "status") {
				const live = await api.commit((tx) => scanLiveTasks(tx, { conversationId: api.conversationId, kind: PROC_TASK_KIND }), context);
				return text(formatProcList(live, api.now()));
			}
			const name = (args.name ?? "").trim();
			const violation = procNameViolation(name);
			if (violation !== undefined) return text(violation, true);
			if (args.action === "stop") {
				const found = await api.commit(async (tx) => {
					const live = await scanLiveTasks(tx, { conversationId: api.conversationId, kind: PROC_TASK_KIND });
					return live.find((t) => (t.input as ProcInput).name === name);
				}, context);
				if (found === undefined) return text(`No background process named ${name}.`, true);
				const harness = deps.getHarness();
				if (harness === undefined) return text("Cannot stop now (harness is not ready); try again.", true);
				await harness.abortTask(found.id as TaskId, context);
				return text(`Stopped ${name}. taskId: ${found.id}.`);
			}
			// start
			const command = (args.command ?? "").trim();
			if (command === "") return text("start needs a command.", true);
			type StartResult = { ok: false; error: string } | { ok: true; taskId: number };
			const created = await api.commit<StartResult>(async (tx) => {
				const live = await scanLiveTasks(tx, { kind: PROC_TASK_KIND }, 500);
				if (live.some((t) => (t.input as ProcInput).name === name && (t.input as ProcInput).conversationId === api.conversationId)) return { ok: false, error: `${name} is already running; use status to list processes or stop to end one.` };
				const cap = procCapViolation(live.filter((t) => (t.input as ProcInput).conversationId === api.conversationId).length, live.length);
				if (cap !== undefined) return { ok: false, error: cap };
					const taskId = await tx.createTask(ProcRun, { name, command, notify: args.notify !== false, creator: deps.senderOf(api.conversationId as number) ?? "", ...(deps.viaOf?.(api.conversationId) === undefined ? {} : { creatorVia: deps.viaOf!(api.conversationId)! }), conversationId: api.conversationId as number }, { ownership: { kind: "conversation" }, background: true });
				return { ok: true, taskId: taskId as number };
			}, context);
			if (!created.ok) return text(created.error, true);
			return text(`Started ${name}. taskId: ${created.taskId}. Read output with dwell.proc.logs using this taskId. Tell the user it runs in the background; relay or act on the exit follow-up when it arrives.`);
		},
	});
}

function makeLogsTool() {
	const text = (value: string, isError = false) => ({ output: [{ type: "text" as const, text: value }], ...(isError ? { isError: true } : {}) });
	return defineTool({
		name: "dwell.proc.logs",
		description: "Read the last lines of a background process from this conversation by taskId (from dwell.proc start/status/exit). Works for active and completed tasks; completed logs expire after seven days. Returns at most 64KiB. No host path is accepted.",
		parameters: Type.Object({
			taskId: Type.Integer({ minimum: 1, description: "The process taskId returned by dwell.proc" }),
			lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Last lines to return, default 50, maximum 200" })),
		}),
		replay: "safe",
		outputLimits: { retain: "tail", maxBytes: LOG_READ_MAX_BYTES },
		async execute(args, api, context) {
			const task = await api.commit((tx) => tx.task(args.taskId as TaskId), context);
			if (task?.kind !== PROC_TASK_KIND || task.conversationId !== api.conversationId) return text("No process log for that taskId in this conversation.", true);
			if (task.state.status === "terminal" && task.endedAt !== undefined && task.endedAt < api.now() - LOG_RETENTION_MS) return text("The process log has expired (seven-day retention).", true);
			try {
				const lines = Math.min(200, Math.max(1, args.lines ?? 50));
				const tail = await readLogTail(api.conversationId as number, args.taskId, lines);
				return text(`Process taskId ${args.taskId} · status ${task.state.status} (last ${lines} lines, at most 64KiB):\n${tail.omitted ? "[Earlier output omitted.]\n" : ""}${tail.text === "" ? "[No output yet]" : tail.text}`);
			} catch { return text("Process log is unavailable (not created, expired, or from a legacy workspace log).", true); }
		},
	});
}

/** Task definitions remain version 1 so legacy checkpoints resume without migration. */
export function makeProcExtension(deps: ProcDeps): Extension {
	const ProcRun = makeProcTask(deps);
	return defineExtension({
		name: "dwell-proc",
		tools: [makeProcTool(deps, ProcRun), makeLogsTool()],
		tasks: [ProcRun],
		sections: [
			section("proc", () =>
				"For processes that must keep running beyond one bash call, use dwell.proc start. Inspect captured output with dwell.proc.logs using its taskId. Relay or act on the exit follow-up. /cancel and clearing context do not stop processes; use dwell.proc stop.",
				{ tag: false },
			),
		],
	});
}
