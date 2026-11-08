// 托管后台进程：dwell.proc 工具 + dwell.proc-run durable 任务。
// 一个进程对应一个 background task：宿主直接 spawn（shell 与 bash 工具同一沙箱 wrapper，进沙箱语义不变），
// watch 阶段等退出，report 以 followUp 回会话并开卡。进程与任务同生命周期：stop（abortTask）杀进程组；
// dwell 重启后（--die-with-parent + systemd cgroup）任务 resume 发现内存表无记录 → 回报「被服务重启中断」。
// 不做跨重启存活：那要求进程脱离沙箱与 cgroup，安全边界需另行论证。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, open, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, defineTask, defineTool, section, type ConversationId, type Extension, type Harness, type SubmissionId, type TaskId, type TaskRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "typebox";
import { scanLiveTasks } from "./schedule.ts";

export const PROC_TASK_KIND = "dwell.proc-run";

/** 成本闸：并发进程数（真进程不烧 token，但占内存与外联带宽，沙箱下还各占一个 bwrap 实例）。 */
export const PROC_MAX_PER_CONVERSATION = 5;
export const PROC_MAX_TOTAL = 10;
/** 单个日志文件上限：watch 期间周期检查，超过即截断并写标记行（fd 以 append 模式持有，截断安全）。 */
export const PROC_LOG_MAX_BYTES = 50 * 1024 * 1024;

export type ProcInput = {
	readonly name: string;
	readonly command: string;
	readonly notify: boolean;
	readonly creator: string;
	readonly conversationId: number;
};

type ProcCheckpoint =
	| { phase: "start" }
	| { phase: "watch"; pid: number; startedAt: number; logPath: string }
	| { phase: "report"; code: number | null; lost: boolean; startedAt: number; logPath?: string; note?: string }
	| { phase: "announce"; submissionId: number };

export type ProcDeps = {
	/** run 归属登记（退出回报触发的会话 run 归到创建者）。report 阶段 await 它完成才 submit（约束同 ScheduleDeps.attribute） */
	attribute: (conversationId: number, creator: string) => Promise<void>;
	/** 回报 run 由宿主开回复卡（与定时/后台任务同一入口） */
	onFired: (conversationId: number, submissionId: SubmissionId, header: string) => void;
	/** stop 需要 abortTask；装配时 harness 尚未创建，getter 延迟绑定 */
	getHarness: () => Pick<Harness, "abortTask"> | undefined;
	/** 当前 run 发起者（进程创建者记录用） */
	senderOf: (conversationId: number) => string | undefined;
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

export function procLogDir(cwd: string): string {
	return join(cwd, ".dwell-proc");
}

export function procLogPath(cwd: string, name: string): string {
	// name 唯一性只按会话计：群聊 per-sender 会话共享 cwd 时，两会话同名进程会互覆日志（同 cwd 本就共享文件空间，接受，不另做隔离）
	return join(procLogDir(cwd), `${name}.log`);
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
export function formatProcExitReport(name: string, code: number | null, lost: boolean, seconds: number, logTail: string): string {
	const head = lost
		? `[Background process ${name}] The dwell service restarted while it was running, so the process was terminated. It had run for ${formatDuration(seconds * 1000)}.`
		: code === null
			? `[Background process ${name}] exited abnormally (spawn failure or killed by a signal) after ${formatDuration(seconds * 1000)}.`
			: `[Background process ${name} exited with code ${code}] after ${formatDuration(seconds * 1000)}.`;
	const tail = logTail.trim() === "" ? "" : `\nLast log lines:\n${logTail.trim()}`;
	return `${head}${tail}\n(Relay or act on this result; the log is at .dwell-proc/${name}.log if you need more.)`;
}

export function formatProcList(tasks: TaskRecord<JsonValue, JsonValue, JsonValue>[], now: number): string {
	if (tasks.length === 0) return "No background processes in this conversation.";
	const lines = tasks.map((task) => {
		const input = task.input as ProcInput;
		const ck = task.state.status === "running" && task.state.checkpoint !== undefined ? (task.state.checkpoint as ProcCheckpoint | { phase: "announce"; submissionId: number }) : undefined;
		if (ck === undefined) return `- ${input.name} · finishing`;
		if (ck.phase === "start") return `- ${input.name} · starting`;
		if (ck.phase === "watch") return `- ${input.name} (pid ${ck.pid}) · running for ${formatDuration(now - ck.startedAt)} · log .dwell-proc/${input.name}.log`;
		if (ck.phase === "report") return `- ${input.name} · exiting (reporting the result)`;
		return `- ${input.name} · finishing`;
	});
	return `Background processes in this conversation:\n${lines.join("\n")}`;
}

// ── 进程表与杀树 ──

/** taskId → 活着的 ChildProcess（仅内存）。重启后空 → watch 报 lost；杀进程只经它，永不按记录 pid 杀（可能已被复用）。
 *  导出供测试：同进程内 close→reopen 模拟服务重启时先 clear（真重启是新进程，表天然为空；同进程复用旧 child 继续等也正确，但 lost 语义测不到）。 */
export const procTable = new Map<number, ChildProcess>();

function killTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
	// Windows 无进程组信号：taskkill /F /T 即刻强杀整树，SIGTERM/SIGKILL 之分的优雅停止只在 POSIX 存在
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
		return;
	}
	try {
		process.kill(-pid, signal); // 组击杀：沙箱下 SIGTERM 即拆 pidns 全灭
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// 已死则罢
		}
	}
}

/** 日志超限截断（watch 周期检查调用；fd 为 append 打开，截断后新写入从 0 开始）。 */
async function trimLogIfLarge(path: string): Promise<void> {
	try {
		if ((await stat(path)).size > PROC_LOG_MAX_BYTES) {
			await truncate(path, 0);
			await appendFile(path, "[dwell] log truncated (size cap)\n");
		}
	} catch {
		// 文件不在/写不进都不值得报错
	}
}

/** 日志尾：只读文件末段（64KB 窗口），不整文件进内存——体积上限靠巡检裁剪，两次巡检间仍可能到 50MB。 */
async function readTail(path: string, lines: number): Promise<string> {
	try {
		const handle = await open(path, "r");
		try {
			const size = (await handle.stat()).size;
			const length = Math.min(size, 65536);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, size - length);
			return tailLines(buffer.toString("utf8"), lines);
		} finally {
			await handle.close();
		}
	} catch {
		return "";
	}
}

// ── durable 任务 ──

export const makeProcTask = (deps: ProcDeps) =>
	defineTask<ProcInput, ProcCheckpoint, null>({
		name: PROC_TASK_KIND,
		version: 1,
		initial: () => ({ phase: "start" }),
		phases: {
			/** 读形式判重放（memo 写形式「不存在则存入并返回」，candidate 与既有值恒为 true，拦不住重放）：
			 *  memo 落盘后本阶段任一步崩溃，重启续跑一律按 lost 回报，不再次执行命令（副作用双跑不可接受）。
			 *  已知残留：崩溃恰在读判与写入之间 → 进程从未启动也报 lost（多一条无害通知）。 */
			start: async (task, runtime, context) => {
				const spawned = await runtime.memo<boolean>("spawned", context);
				if (spawned !== undefined) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", code: null, lost: true, startedAt: runtime.now() } }), context);
					return;
				}
				await runtime.memo<boolean>("spawned", true, context);
				const input = task.input;
				const env = await runtime.env(context);
				const cwd = env?.cwd;
				const shell = deps.shell();
				if (cwd === undefined || shell.path === "") {
					const problem = cwd === undefined ? "the conversation has no working directory" : "no shell is available to run it";
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", code: null, lost: false, startedAt: runtime.now(), note: `Cannot start: ${problem}.` } }), context);
					return;
				}
				const logPath = procLogPath(cwd, input.name);
				await mkdir(procLogDir(cwd), { recursive: true });
				// 子进程经 stdio 继承同一文件描述（共享 offset），无 O_APPEND 时截断后写在原 offset 续写 → 稀疏巨文件；
				// O_APPEND 每次写落 EOF，体积巡检才有意义。先 "w" 清同名旧日志再关。win32 例外退回 "w"：MSYS Git Bash
				// 写不了继承来的 append 句柄（exit 1 无输出），本机开发下 50MB 巡检退化为记录性截断（Linux 生产不受影响）
				await (await open(logPath, "w")).close();
				const logFd = await open(logPath, process.platform === "win32" ? "w" : "a");
				const child = spawn(shell.path, ["-c", input.command], {
					cwd,
					detached: process.platform !== "win32",
					env: { ...process.env, ...(process.env.DWELL_TOOL_PATH ? { PATH: process.env.DWELL_TOOL_PATH } : {}) },
					stdio: ["ignore", logFd.fd, logFd.fd],
					windowsHide: true,
				});
				child.once("exit", () => void logFd.close().catch(() => {}));
				child.once("error", () => void logFd.close().catch(() => {}));
				procTable.set(runtime.taskId as number, child);
				// abort 竞态：mkdir/open 的 await 窗口内 abortTask 可能已终局本任务（abort 处理器查表无记录）；
				// spawn 已成事实就要收尾，不能留一个无人管理也不在表里的进程
				if (runtime.signal.aborted) {
					procTable.delete(runtime.taskId as number);
					if (child.pid !== undefined) killTree(child.pid, "SIGKILL");
					return;
				}
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "watch", pid: child.pid ?? -1, startedAt: runtime.now(), logPath } }), context);
			},
			/** 等进程退出（或本任务被 abort）。重启后进程必死：表里无记录 → lost。 */
			watch: async (task, runtime, context) => {
				const child = procTable.get(runtime.taskId as number);
				const prior = task.state.checkpoint;
				const startedAt = "startedAt" in prior ? prior.startedAt : runtime.now();
				const logPath = "logPath" in prior && prior.logPath !== undefined ? prior.logPath : undefined;
				if (child === undefined) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", code: null, lost: true, startedAt, ...(logPath === undefined ? {} : { logPath }) } }), context);
					return;
				}
				const finish = async (): Promise<void> => {
					procTable.delete(runtime.taskId as number);
					const code = child.exitCode;
					try {
						if (logPath !== undefined) await appendFile(logPath, `\n[dwell] exited with code ${code === null ? "signal" : code}\n`);
					} catch {
						// 日志写不进不拦回报
					}
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", code, lost: false, startedAt, ...(logPath === undefined ? {} : { logPath }) } }), context);
				};
				// 已退出（commit 前崩溃重跑，或 error 先于 exit）：直接收尾
				if (child.exitCode !== null || child.signalCode !== null || child.killed) {
					await finish();
					return;
				}
				const exited = new Promise<void>((resolve) => {
					child.once("exit", () => resolve());
					child.once("error", () => resolve()); // spawn 失败（如 ENOENT）只发 error 不发 exit
				});
				if (runtime.signal.aborted) return; // abort 定义接手
				// 日志体积巡检：O_APPEND fd 截断后新写入从 0 开始，无需重开
				const trim = logPath === undefined ? undefined : setInterval(() => void trimLogIfLarge(logPath), 60_000);
				trim?.unref();
				try {
					await new Promise<void>((resolve) => {
						const onAbort = (): void => resolve();
						runtime.signal.addEventListener("abort", onAbort, { once: true });
						void exited.then(() => {
							runtime.signal.removeEventListener("abort", onAbort);
							resolve();
						});
					});
				} finally {
					if (trim !== undefined) clearInterval(trim);
				}
				if (runtime.signal.aborted) return;
				await finish();
			},
			/** 退出（或 lost）回报：followUp 投回会话后先进 announce（submissionId 落盘），再开卡——重放时 requestId 幂等拿到同一 submission，
			 *  不会重复投递；announce 在回调与终局 commit 间崩溃重放会多开一张卡（与 schedule 的 announce 同款已知残留）。notify: false 直接终结。 */
			report: async (task, runtime, context) => {
				const input = task.input;
				const ck = task.state.checkpoint.phase === "report" ? task.state.checkpoint : undefined;
				if (ck === undefined) {
					// 不会到达（report 只由 start/watch 进入），防御性收尾
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
					return;
				}
				if (input.notify) {
					await deps.attribute(input.conversationId, input.creator);
					const conversation = await runtime.conversation(input.conversationId as ConversationId, context);
					if (conversation === undefined) {
						runtime.report(new Error(`Process task ${input.name}: conversation ${input.conversationId} is missing`));
					} else {
						const tail = ck.logPath !== undefined && ck.note === undefined ? await readTail(ck.logPath, 30) : "";
						const content = ck.note ?? formatProcExitReport(input.name, ck.code, ck.lost, Math.round((runtime.now() - ck.startedAt) / 1000), tail);
						const submission = await conversation.submit(
							{ type: "input", content, requestId: `proc:${String(runtime.taskId)}:exit`, whenBusy: "followUp", entry: { kind: "chat.message", data: { sender: input.creator, via: "proc" } } },
							context,
						);
						await runtime.commit(() => ({ status: "running", checkpoint: { phase: "announce", submissionId: submission.id as number } }), context);
						return;
					}
				}
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
			},
			announce: async (task, runtime, context) => {
				const ck = task.state.checkpoint.phase === "announce" ? task.state.checkpoint : undefined;
				if (ck !== undefined) deps.onFired(task.input.conversationId, ck.submissionId as SubmissionId, `⚙️ 后台进程 ${task.input.name} 已退出`);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
			},
		},
		/** 用户 stop 或 harness 关闭：杀进程组（沙箱下即拆 pidns 含孙进程），5 秒兜底强杀（POSIX；win32 首杀已是强杀，兜底为空转）；主动 stop 不回报。 */
		abort: async (_task, runtime, context) => {
			const child = procTable.get(runtime.taskId as number);
			procTable.delete(runtime.taskId as number);
			if (child?.pid !== undefined && child.exitCode === null) {
				killTree(child.pid, "SIGTERM");
				const pid = child.pid;
				const timer = setTimeout(() => {
					if (child.exitCode === null) killTree(pid, "SIGKILL");
				}, 5000);
				timer.unref();
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});

function makeProcTool(deps: ProcDeps, ProcRun: ReturnType<typeof makeProcTask>) {
	const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
	return defineTool({
		name: "dwell.proc",
		description:
			"Manage background processes that keep running while the conversation stays free (dev servers, watchers, crawls, builds too long for one bash call). " +
			"start: launch `command` under a name; it runs in this conversation's sandbox and working directory, its output goes to .dwell-proc/<name>.log, and when it exits its exit code and the last log lines arrive here as a follow-up. " +
			"status: list this conversation's processes. stop: terminate one (also kills its children). " +
			"Long waits are what this is for — poll the log with read/tail to watch progress. /cancel and clearing context do not stop processes — use stop. If the dwell service restarts, processes are terminated and reported as interrupted.",
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
				return text(`Stopped ${name}.`);
			}
			// start
			const command = (args.command ?? "").trim();
			if (command === "") return text("start needs a command.", true);
			type StartResult = { ok: false; error: string } | { ok: true };
			const created = await api.commit<StartResult>(async (tx) => {
				const live = await scanLiveTasks(tx, { kind: PROC_TASK_KIND }, 500);
				if (live.some((t) => (t.input as ProcInput).name === name && (t.input as ProcInput).conversationId === api.conversationId)) return { ok: false, error: `${name} is already running; use status to list processes or stop to end one.` };
				const cap = procCapViolation(live.filter((t) => (t.input as ProcInput).conversationId === api.conversationId).length, live.length);
				if (cap !== undefined) return { ok: false, error: cap };
				await tx.createTask(ProcRun, { name, command, notify: args.notify !== false, creator: deps.senderOf(api.conversationId as number) ?? "", conversationId: api.conversationId as number }, { ownership: { kind: "conversation" }, background: true });
				return { ok: true };
			}, context);
			if (!created.ok) return text(created.error, true);
			return text(`Started ${name}. Output goes to .dwell-proc/${name}.log; tell the user it runs in the background. When it exits, the result arrives here as a follow-up — relay or act on it then.`);
		},
	});
}

/** 装配：任务定义与工具同扩展（watch 中的任务重启后续跑报 lost）。 */
export function makeProcExtension(deps: ProcDeps): Extension {
	const ProcRun = makeProcTask(deps);
	return defineExtension({
		name: "dwell-proc",
		tools: [makeProcTool(deps, ProcRun)],
		tasks: [ProcRun],
		sections: [
			section("proc", () =>
				"For processes that must keep running beyond a single bash call (dev servers, watchers, long crawls), use dwell.proc start; its exit code and log tail arrive as a follow-up. /cancel and clearing context do not stop them — use dwell.proc stop.",
				{ tag: false },
			),
		],
	});
}
