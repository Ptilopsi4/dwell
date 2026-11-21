// node --test "test/proc.test.ts"
// 托管后台进程：退出回报与归属顺序 / stop 杀进程不回报 / notify:false 静默 / 重启后 lost 回报 / 工具层重名。
import { after, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineTask, Harness, type Conversation, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { resolveSpawnShell } from "../src/sandbox.ts";
import type { ProcDeps, ProcInput } from "../src/ext/proc.ts";

const privateState = await mkdtemp(join(tmpdir(), "dwell-proc-state-"));
process.env.DWELL_STATE = privateState;
const { PROC_LOG_MAX_BYTES, PROC_TASK_KIND, formatDuration, formatProcExitReport, formatProcList, makeProcExtension, makeProcTask, procCapViolation, procNameViolation, procTable, pruneProcLogs, tailLines } = await import("../src/ext/proc.ts");
const { scanLiveTasks } = await import("../src/ext/schedule.ts");
beforeEach(async () => { await rm(join(privateState, "proc-logs"), { recursive: true, force: true }); });
after(async () => { await rm(privateState, { recursive: true, force: true }); });

const until = async (check: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> => {
	for (const end = Date.now() + ms; ;) {
		if (await check()) return;
		if (Date.now() > end) throw new Error("until: timeout");
		await new Promise((r) => setTimeout(r, 15));
	}
};

/** Windows 下进程/句柄释放是异步的：rm 遇 EBUSY/EPERM 重试（目录里还有活跃 cwd 指向时杀不掉，先清进程再清目录）。 */
const cleanupDir = async (dir: string): Promise<void> => {
	for (let i = 0; ; i++) {
		try {
			await rm(dir, { recursive: true, force: true });
			return;
		} catch (err) {
			if (i >= 40 || !/EBUSY|EPERM/.test(String((err as NodeJS.ErrnoException).code))) throw err;
			await new Promise((r) => setTimeout(r, 250));
		}
	}
};

// 进程集成用例依赖真 bash（echo/sleep）；本机找不到就跳过（服务器/CI 有）
const shell = resolveSpawnShell({ enabled: false });
const procSkip = shell.path === "" ? "本机无 bash，跳过进程集成用例" : false;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const resultText = (result: unknown) => String((result as { output?: { text?: string }[] }).output?.[0]?.text ?? "");

async function withProcessHarness(run: (fixture: {
	harness: Harness;
	conversation: Conversation;
	workDir: string;
	dir: string;
	reports: string[];
	start: (name: string, command: string, notify?: boolean, conversation?: Conversation) => Promise<TaskId>;
	wait: (taskId: TaskId) => Promise<void>;
	logs: (taskId: number, lines?: number, conversation?: Conversation) => Promise<unknown>;
}) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "dwell-proc-boundary-"));
	const workDir = resolve(join(dir, "work"));
	await mkdir(workDir);
	let harness: Harness | undefined;
	const deps: ProcDeps = { attribute: async () => {}, onFired: () => {}, getHarness: () => harness, senderOf: () => "ou_test", shell: () => shell };
	const ProcRun = makeProcTask(deps);
	const extension = makeProcExtension(deps);
	const registry = createRegistry();
	registry.install(extension);
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage([fauxText("ok")])));
	const models = createModels();
	models.setProvider(faux.provider);
	const context = BACKGROUND_CONTEXT;
	const reports: string[] = [];
	harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry, onReport: (err) => reports.push(err instanceof Error ? err.message : String(err)), env: async ({ cwd }) => new NodeExecutionEnv({ cwd: resolve(cwd ?? workDir) }) }, context);
	const activeHarness = harness;
	harness.resume();
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workDir } }, context);
		await run({
			harness,
			conversation,
			workDir,
			dir,
			reports,
			start: (name, command, notify = false, target = conversation) => target.commit((tx) => tx.createTask(ProcRun, { name, command, notify, creator: "ou_test", conversationId: target.id as number }, { ownership: { kind: "conversation" }, background: true }), context),
			wait: (id) => until(async () => (await activeHarness.getTask(id, context))?.state.status === "terminal"),
			logs: (id, lines, target = conversation) => {
				const tool = extension.tools?.find((each) => each.name === "dwell.proc.logs");
				assert.ok(tool);
				const api = { conversationId: target.id, commit: <T,>(fn: (tx: never) => T | Promise<T>) => target.commit(fn as never, context), now: () => Date.now() } as never;
				return tool.execute({ taskId: id, ...(lines === undefined ? {} : { lines }) }, api, context as never);
			},
		});
	} finally {
		for (const record of await harness.commit((tx) => scanLiveTasks(tx, { kind: PROC_TASK_KIND }), context)) {
			await harness.abortTask(record.id as TaskId, context);
			await until(async () => (await activeHarness.getTask(record.id as TaskId, context))?.state.status === "terminal");
		}
		await harness.close(context).catch(() => {});
		await cleanupDir(dir);
	}
}

test("纯函数：名称校验 / 上限 / 日志尾 / 时长 / 退出回报", () => {
	assert.equal(procNameViolation("build.1-a"), undefined);
	assert.match(procNameViolation("") ?? "", /required/);
	assert.match(procNameViolation("a b") ?? "", /letters/);
	assert.match(procNameViolation("x".repeat(41)) ?? "", /40/);

	assert.equal(procCapViolation(4, 9), undefined);
	assert.match(procCapViolation(5, 0) ?? "", /max 5/);
	assert.match(procCapViolation(4, 10) ?? "", /max 10/, "总闸与会话内闸独立判定");

	assert.equal(tailLines("a\nb\nc", 2), "b\nc");
	assert.equal(tailLines("solo", 30), "solo");

	assert.equal(formatDuration(59_000), "59s");
	assert.equal(formatDuration(60_000), "1m");
	assert.equal(formatDuration(125_000), "2m 5s");
	assert.equal(formatDuration(3_900_000), "1h 5m");

	const ok = formatProcExitReport("srv", 0, false, 90, "line1\nline2", 42);
	assert.match(ok, /\[Background process srv exited with code 0\] after 1m 30s/);
	assert.match(ok, /Last log lines:\nline1\nline2/);
	assert.match(ok, /taskId: 42/);
	assert.match(formatProcExitReport("srv", 1, false, 5, "", 42), /\[Background process srv exited with code 1\]/);
	assert.ok(!formatProcExitReport("srv", 1, false, 5, "", 42).includes("Last log lines"), "无日志不带尾巴");
	assert.match(formatProcExitReport("srv", null, true, 5, "", 42), /service restarted/);
	assert.match(formatProcExitReport("srv", null, false, 5, "", 42), /abnormally/);
});

test("纯函数：列表格式", () => {
	assert.equal(formatProcList([], 0), "No background processes in this conversation.");
	const tasks = [
		{ id: 1, input: { name: "a", command: "x", notify: true, creator: "u", conversationId: 1 }, state: { status: "running", checkpoint: { phase: "watch", pid: 4242, startedAt: 1000, logPath: "/w/.dwell-proc/a.log" } } },
		{ id: 2, input: { name: "b", command: "y", notify: false, creator: "u", conversationId: 1 }, state: { status: "running", checkpoint: { phase: "report", code: 0, lost: false, startedAt: 1000 } } },
		{ id: 3, input: { name: "c", command: "z", notify: true, creator: "u", conversationId: 1 }, state: { status: "running", checkpoint: { phase: "start" } } },
	];
	const out = formatProcList(tasks as never, 61_000);
	assert.match(out, /- a · taskId 1 \(pid 4242\) · running for 1m/);
	assert.match(out, /- b · taskId 2 · exiting/);
	assert.match(out, /- c · taskId 3 · starting/);
});

test("process access is rechecked before spawn and report without killing an already running process", { skip: procSkip }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-proc-access-"));
	const workDir = resolve(join(dir, "work"));
	await mkdir(workDir);
	let allowed = false;
	let revokeInEnv = false;
	let fired = 0;
	const checks: unknown[][] = [];
	const deps: ProcDeps = {
		attribute: async () => {}, onFired: () => { fired++; }, getHarness: () => undefined,
		senderOf: () => "current-admin", viaOf: () => "panel", shell: () => shell,
		isAllowed: (creator, id, via) => { checks.push([creator, id, via]); return allowed && creator === "tg:42" && via === "telegram"; },
	};
	const extension = makeProcExtension(deps);
	const registry = createRegistry(); registry.install(extension);
	const faux = fauxProvider(); faux.setResponses([fauxAssistantMessage(fauxText("ack"))]);
	const models = createModels(); models.setProvider(faux.provider);
	const context = BACKGROUND_CONTEXT;
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), {
		models, registry,
		env: async () => { if (revokeInEnv) allowed = false; return new NodeExecutionEnv({ cwd: workDir }); },
	}, context);
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workDir } }, context);
		const create = (name: string, command: string) => conversation.commit((tx) => tx.createTask(makeProcTask(deps), {
			name, command, notify: true, creator: "tg:42", creatorVia: "telegram", conversationId: conversation.id,
		}, { ownership: { kind: "conversation" }, background: true }), context);
		const wait = (id: TaskId) => until(async () => (await harness.getTask(id, context))?.state.status === "terminal");
		const marker = join(workDir, "marker");
		const denied = await create("queued", `echo denied > ${quote(marker)}`);
		harness.resume();
		await wait(denied);
		await assert.rejects(readFile(marker), { code: "ENOENT" });
		allowed = true; revokeInEnv = true;
		const beforeSpawn = await create("before-spawn", `echo denied > ${quote(marker)}`);
		await wait(beforeSpawn);
		await assert.rejects(readFile(marker), { code: "ENOENT" });
		allowed = true; revokeInEnv = false;
		const running = await create("running", `echo started; sleep 0.4; echo completed > ${quote(marker)}`);
		await until(async () => {
			const record = await harness.getTask(running, context);
			return record?.state.status === "running" && (record.state.checkpoint as { phase: string }).phase === "watch";
		});
		allowed = false;
		await wait(running);
		assert.equal((await readFile(marker, "utf8")).trim(), "completed");
		assert.match(await readFile(join(privateState, "proc-logs", String(conversation.id), `${running}.log`), "utf8"), /started/);
		assert.equal((await conversation.entries({}, 100, undefined, context)).items.length, 0);
		assert.equal(fired, 0);
		allowed = true;
		const permitted = await create("allowed", "echo permitted");
		await wait(permitted);
		assert.equal(fired, 1);
		assert.match(JSON.stringify((await conversation.entries({}, 100, undefined, context)).items), /permitted/);
		assert.ok(checks.every(([creator, id, via]) => creator === "tg:42" && id === conversation.id && via === "telegram"));
	} finally { await harness.close(context); await cleanupDir(dir); }
});

test("集成：自然退出回报会话并带日志尾；归属先于开卡", { skip: procSkip }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-proc-"));
	const order: string[] = [];
	const fired: { header: string }[] = [];
	let announce!: () => void;
	const announcement = new Promise<void>((resolve) => { announce = resolve; });
	const deps: ProcDeps = {
		attribute: async () => {
			order.push("attribute:start");
			await new Promise((r) => setTimeout(r, 30));
			order.push("attribute:done");
		},
		onFired: async (_c, _s, header) => {
			order.push("fired");
			fired.push({ header });
			await announcement;
		},
		getHarness: () => undefined,
		senderOf: () => "ou_test",
		shell: () => shell,
	};
	const ProcRun = makeProcTask(deps);
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("ok")])));
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const context = BACKGROUND_CONTEXT;
	const registry = createRegistry();
	registry.install(makeProcExtension(deps));
	const workDir = resolve(join(dir, "work"));
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry, env: async ({ cwd }) => new NodeExecutionEnv({ cwd: resolve(cwd ?? workDir) }) }, context);
	harness.resume();
	try {
		const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const taskId = await conv.commit((tx) => tx.createTask(ProcRun, { name: "ping", command: "echo hello-proc && sleep 0.3", notify: true, creator: "ou_test", conversationId: conv.id as number }, { ownership: { kind: "conversation" }, background: true }), context);
		await until(() => fired.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal((await harness.getTask(taskId, context))?.state.status, "running", "The process must retain its announce checkpoint until presentation is durable");
		announce();
		await until(async () => (await harness.getTask(taskId, context))?.state.status === "terminal");
		assert.deepEqual(order, ["attribute:start", "attribute:done", "fired"], "归属登记完成后才 submit 回报并开卡");
		assert.match(fired[0]?.header ?? "", /后台进程 ping 已退出/);
		const page = await conv.entries({}, 20, undefined, context);
		const report = page.items.find((e) => JSON.stringify(e).includes("exited with code 0"));
		assert.ok(report !== undefined, "会话应收到退出回报");
		assert.match(JSON.stringify(report), /hello-proc/, "回报带日志尾");
		const log = await readFile(join(privateState, "proc-logs", String(conv.id), `${taskId}.log`), "utf8");
		assert.match(log, /hello-proc/);
		assert.match(log, /\[dwell\] exited with code 0/);
	} finally {
		announce();
		await harness.close(context).catch(() => {});
		await cleanupDir(dir);
	}
});

test("集成：stop 杀进程且不回报", { skip: procSkip }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-proc-stop-"));
	const fired: unknown[] = [];
	const deps: ProcDeps = {
		attribute: async () => {},
		onFired: () => { fired.push(1); },
		getHarness: () => undefined,
		senderOf: () => "ou_test",
		shell: () => shell,
	};
	const ProcRun = makeProcTask(deps);
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("ok")])));
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const context = BACKGROUND_CONTEXT;
	const registry = createRegistry();
	registry.install(makeProcExtension(deps));
	const workDir = resolve(join(dir, "work"));
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry, env: async ({ cwd }) => new NodeExecutionEnv({ cwd: resolve(cwd ?? workDir) }) }, context);
	harness.resume();
	try {
		const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const taskId = await conv.commit((tx) => tx.createTask(ProcRun, { name: "hang", command: "sleep 30", notify: true, creator: "ou_test", conversationId: conv.id as number }, { ownership: { kind: "conversation" }, background: true }), context);
		let pid = -1;
		await until(async () => {
			const t = await harness.getTask(taskId, context);
			const ck = t?.state.status === "running" ? (t.state.checkpoint as { phase?: string; pid?: number } | undefined) : undefined;
			if (ck?.phase === "watch") pid = ck.pid ?? -1;
			return ck?.phase === "watch";
		});
		await harness.abortTask(taskId, context);
		await until(async () => (await harness.getTask(taskId, context))?.state.status === "terminal");
		await new Promise((r) => setTimeout(r, 200));
		// 进程树已死：bash pid 不复存在（Windows 同样以 process.kill(pid,0) 探活）
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		assert.equal(alive, false, "stop 后进程应被杀");
		const page = await conv.entries({}, 20, undefined, context);
		assert.ok(!JSON.stringify(page.items).includes("Background process hang"), "主动 stop 不回报");
		assert.equal(fired.length, 0);
	} finally {
		await harness.close(context).catch(() => {});
		await cleanupDir(dir);
	}
});

test("集成：notify=false 退出后静默终结", { skip: procSkip }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-proc-quiet-"));
	const fired: unknown[] = [];
	const deps: ProcDeps = { attribute: async () => {}, onFired: () => { fired.push(1); }, getHarness: () => undefined, senderOf: () => "ou_test", shell: () => shell };
	const ProcRun = makeProcTask(deps);
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("ok")])));
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const context = BACKGROUND_CONTEXT;
	const registry = createRegistry();
	registry.install(makeProcExtension(deps));
	const workDir = resolve(join(dir, "work"));
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry, env: async ({ cwd }) => new NodeExecutionEnv({ cwd: resolve(cwd ?? workDir) }) }, context);
	harness.resume();
	try {
		const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const taskId = await conv.commit((tx) => tx.createTask(ProcRun, { name: "quiet", command: "sleep 0.3", notify: false, creator: "ou_test", conversationId: conv.id as number }, { ownership: { kind: "conversation" }, background: true }), context);
		await until(async () => (await harness.getTask(taskId, context))?.state.status === "terminal");
		const record = await harness.getTask(taskId, context);
		assert.equal(record?.state.status === "terminal" ? record.state.outcome.status : undefined, "completed", "静默终结也是 completed（fault 会让本断言红）");
		await new Promise((r) => setTimeout(r, 200));
		const page = await conv.entries({}, 20, undefined, context);
		assert.ok(!JSON.stringify(page.items).includes("Background process quiet"), "notify=false 不回报");
		assert.equal(fired.length, 0);
	} finally {
		await harness.close(context).catch(() => {});
		await cleanupDir(dir);
	}
});

test("集成：服务重启后任务按 lost 回报", { skip: procSkip }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-proc-lost-"));
	const fired: unknown[] = [];
	const deps: ProcDeps = { attribute: async () => {}, onFired: () => { fired.push(1); }, getHarness: () => undefined, senderOf: () => "ou_test", shell: () => shell };
	const ProcRun = makeProcTask(deps);
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("ok")])));
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const context = BACKGROUND_CONTEXT;
	const workDir = resolve(join(dir, "work"));
	const open = async () => {
		const registry = createRegistry();
		registry.install(makeProcExtension(deps));
		const h = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry, env: async ({ cwd }) => new NodeExecutionEnv({ cwd: resolve(cwd ?? workDir) }) }, context);
		h.resume();
		return h;
	};
	let harness = await open();
	try {
		const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const convId = conv.id as ConversationId;
		const taskId = await conv.commit((tx) => tx.createTask(ProcRun, { name: "gone", command: "sleep 60", notify: true, creator: "ou_test", conversationId: conv.id as number }, { ownership: { kind: "conversation" }, background: true }), context);
		let pid = -1;
		await until(async () => {
			const t = await harness.getTask(taskId, context);
			const ck = t?.state.status === "running" ? (t.state.checkpoint as { phase?: string; pid?: number } | undefined) : undefined;
			if (ck?.phase === "watch") pid = ck.pid ?? -1;
			return ck?.phase === "watch";
		});
		await harness.close(context);
		// 模拟服务重启：真重启是新进程（内存表天然为空），同进程复刻要显式清表，resume 后 watch 才按 lost 分支走
		procTable.clear();
		harness = await open();
		await until(async () => (await harness.getTask(taskId, context))?.state.status === "terminal");
		const final = await harness.getTask(taskId, context);
		assert.equal(final?.state.status === "terminal" ? final.state.outcome.status : undefined, "completed", "lost 回报后 completed");
		// 旧 handle 随旧实例关闭：重开后用新实例的会话 handle 读
		const conv2 = await harness.conversation(convId, context);
		assert.ok(conv2 !== undefined);
		const page = await conv2.entries({}, 20, undefined, context);
		assert.match(JSON.stringify(page.items), /service restarted/, "重启后按中断回报");
		// 清理孤儿进程（close 不杀 background 任务；本机无 systemd，重启后旧进程成孤儿）。句柄释放异步：等一拍再清目录
		if (pid > 0) {
			if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
			else {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
		await new Promise((r) => setTimeout(r, 800));
	} finally {
		await harness.close(context).catch(() => {});
		await cleanupDir(dir);
	}
});

test("工具层：start 返回与 status 展示；同名拒绝；stop 收进程", { skip: procSkip }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-proc-tool-"));
	const fired: unknown[] = [];
	// getHarness 延迟接真实例：stop 分支要走 abortTask（finally 里也用它收尾）
	let harnessRef: Harness | undefined;
	const deps: ProcDeps = { attribute: async () => {}, onFired: () => { fired.push(1); }, getHarness: () => harnessRef, senderOf: () => "ou_test", shell: () => shell };
	const ext = makeProcExtension(deps);
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("ok")])));
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const context = BACKGROUND_CONTEXT;
	const registry = createRegistry();
	registry.install(ext);
	const workDir = resolve(join(dir, "work"));
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry, env: async ({ cwd }) => new NodeExecutionEnv({ cwd: resolve(cwd ?? workDir) }) }, context);
	harness.resume();
	harnessRef = harness;
	try {
		const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const tool = ext.tools?.[0];
		if (tool === undefined) throw new Error("dwell.proc 未注册");
		const api = {
			conversationId: conv.id as number,
			commit: <T,>(fn: (tx: never) => T | Promise<T>) => conv.commit(fn as never, context),
			now: () => Date.now(),
		} as never;
		const out = (r: unknown) => String((r as { output?: { text?: string }[] }).output?.[0]?.text ?? "");
		const ctx = context as never;

		assert.match(out(await tool.execute({ action: "start", name: "srv", command: "sleep 30" }, api, ctx)), /^Started srv\./);
		// 同名在跑：拒绝
		let listed = "";
		await until(async () => {
			listed = out(await tool.execute({ action: "status" }, api, ctx));
			return /- srv · taskId \d+ \(pid \d+\)/.test(listed);
		});
		assert.match(listed, /running for/);
		assert.match(out(await tool.execute({ action: "start", name: "srv", command: "sleep 5" }, api, ctx)), /already running/);
		assert.match(out(await tool.execute({ action: "start", name: "bad name", command: "x" }, api, ctx)), /letters/);
		assert.match(out(await tool.execute({ action: "start", name: "x", command: "" }, api, ctx)), /needs a command/);
		// stop：真 abortTask 收进程（getHarness 就绪）
		assert.match(out(await tool.execute({ action: "stop", name: "srv" }, api, ctx)), /^Stopped srv\./);
	} finally {
		// 残留进程清掉，否则 Windows 下临时目录 rm 永 EBUSY
		const records = await harness.commit((tx) => scanLiveTasks(tx, { kind: PROC_TASK_KIND }, 100), context).catch(() => []);
		for (const record of records as { id: number }[]) {
			await harness.abortTask(record.id as TaskId, context).catch(() => {});
		}
		await new Promise((r) => setTimeout(r, 300));
		await harness.close(context).catch(() => {});
		await cleanupDir(dir);
	}
});

test("private logs ignore legacy workspace symlinks and keep same-name runs separate", { skip: procSkip }, async (t) => {
	await withProcessHarness(async ({ start, wait, logs, conversation, workDir, dir }) => {
		const outside = join(dir, "outside-marker");
		await writeFile(outside, "unchanged outside marker");
		await mkdir(join(workDir, ".dwell-proc"));
		try { await symlink(outside, join(workDir, ".dwell-proc", "same.log")); }
		catch (err) { if (process.platform === "win32") { t.skip(`Symlink unavailable: ${String(err)}`); return; } throw err; }
		const first = await start("same", "echo first-run");
		await wait(first);
		const second = await start("same", "echo second-run");
		await wait(second);
		assert.equal(await readFile(outside, "utf8"), "unchanged outside marker");
		assert.equal((await lstat(join(workDir, ".dwell-proc", "same.log"))).isSymbolicLink(), true);
		assert.match(resultText(await logs(first)), /first-run/);
		assert.doesNotMatch(resultText(await logs(first)), /second-run/);
		assert.match(resultText(await logs(second)), /second-run/);
		assert.deepEqual((await readdir(join(privateState, "proc-logs", String(conversation.id)))).sort(), [`${first}.log`, `${second}.log`].sort());
	});
});

test("logs check durable kind and exact conversation, including shared-cwd conversations", { skip: procSkip }, async () => {
	await withProcessHarness(async ({ harness, conversation, workDir, start, wait, logs }) => {
		const own = await start("own", "echo visible-to-owner");
		await wait(own);
		const other = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workDir } }, BACKGROUND_CONTEXT);
		const foreign = await start("own", "echo private-other-conversation", false, other);
		await wait(foreign);
		assert.match(resultText(await logs(own)), /visible-to-owner/);
		const denied = await logs(foreign);
		assert.equal((denied as { isError?: boolean }).isError, true);
		assert.doesNotMatch(resultText(denied), /private-other-conversation/);
		assert.match(resultText(await logs(foreign, undefined, other)), /private-other-conversation/);
		await (await conversation.submit({ type: "input", content: "Create an unrelated task" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
		const wrongKind = await harness.commit((tx) => tx.scanTasks({ conversationId: conversation.id }, 100), BACKGROUND_CONTEXT);
		const entry = wrongKind.items.find((each) => each.kind !== PROC_TASK_KIND);
		assert.ok(entry);
		assert.match(resultText(await logs(entry.id)), /No process log/);
		assert.match(resultText(await logs(999999)), /No process log/);
	});
});

test("pipe capture flushes stdout and stderr before reporting and bounds log/tool output", { skip: process.platform === "win32" ? "POSIX pipe capture semantics" : procSkip }, async () => {
	await withProcessHarness(async ({ start, wait, logs, conversation }) => {
		const flushed = await start("flush", "echo FINAL-STDOUT; echo FINAL-STDERR >&2", true);
		await wait(flushed);
		const report = JSON.stringify((await conversation.entries({}, 50, undefined, BACKGROUND_CONTEXT)).items);
		assert.match(report, /FINAL-STDERR/);
		assert.match(report, /FINAL-STDOUT/);
		assert.match(report, new RegExp(`taskId: ${flushed}`));
		const script = "const {once}=require('node:events');(async()=>{const chunk=Buffer.alloc(65536,120);for(let i=0;i<832;i++)if(!process.stdout.write(chunk))await once(process.stdout,'drain');for(let i=0;i<260;i++)process.stdout.write('\\nline-'+i);process.stderr.write('\\nFINAL-STDERR');process.stdout.write('\\nFINAL-STDOUT');})()";
		const id = await start("flood", `${quote(process.execPath)} -e ${quote(script)}`);
		await wait(id);
		const path = join(privateState, "proc-logs", String(conversation.id), `${id}.log`);
		assert.ok((await stat(path)).size <= PROC_LOG_MAX_BYTES);
		const full = await readFile(path, "utf8");
		assert.match(full, /^\[dwell\] log truncated \(size cap\)/);
		assert.match(full, /FINAL-STDERR/);
		assert.match(full, /FINAL-STDOUT/);
		const defaults = resultText(await logs(id));
		assert.match(defaults, /last 50 lines/);
		assert.match(defaults, /status terminal/);
		assert.match(defaults, /Earlier output omitted/);
		assert.doesNotMatch(defaults, /\nline-200(?:\n|$)/);
		const result = resultText(await logs(id, 200));
		assert.match(result, /FINAL-STDOUT/);
		assert.ok(Buffer.byteLength(result) <= 64 * 1024);
		const binary = await start("long-line", `${quote(process.execPath)} -e ${quote("process.stdout.write('中'.repeat(50000))")}`);
		await wait(binary);
		const bounded = resultText(await logs(binary));
		assert.ok(Buffer.byteLength(bounded) <= 64 * 1024);
		assert.match(bounded, /Earlier output omitted/);
		const invalid = await start("invalid-utf8", `${quote(process.execPath)} -e ${quote("process.stdout.write(Buffer.alloc(100000,255))")}`, true);
		await wait(invalid);
		const decoded = resultText(await logs(invalid));
		assert.ok(Buffer.byteLength(decoded) <= 64 * 1024);
		assert.match(decoded, /Earlier output omitted/);
		const entries = (await conversation.entries({}, 50, undefined, BACKGROUND_CONTEXT)).items;
		const invalidReport = entries.find((entry) => entry.kind === "chat.message" && JSON.stringify(entry.model).includes(`taskId: ${invalid}`));
		assert.ok(invalidReport);
		assert.ok(Buffer.byteLength(JSON.stringify(invalidReport.model)) < 65 * 1024);
	});
});

for (const stop of [false, true]) {
	test(`${stop ? "stop" : "leader exit"} bounds draining when an unsandboxed detached descendant holds a pipe`, { skip: process.platform === "win32" ? "POSIX detached process groups only" : procSkip }, async () => {
		await withProcessHarness(async ({ harness, start, wait, conversation, workDir, reports }) => {
			const script = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync('descendant.pid',String(child.pid));child.unref();" + (stop ? "setInterval(()=>{},1000);" : "");
			let descendant: number | undefined;
			try {
				const id = await start("detached", `exec ${quote(process.execPath)} -e ${quote(script)}`);
				await until(async () => {
					const pid = await readFile(join(workDir, "descendant.pid"), "utf8").catch(() => "");
					if (pid !== "") descendant = Number(pid);
					return descendant !== undefined;
				});
				const begun = Date.now();
				if (stop) await harness.abortTask(id, BACKGROUND_CONTEXT);
				await wait(id);
				assert.ok(Date.now() - begun < 8000, "Pipe drain must have a bounded deadline");
				if (stop) assert.ok(reports.some((report) => report.includes("Output drain timed out")));
				else {
					const transcript = JSON.stringify((await conversation.entries({}, 50, undefined, BACKGROUND_CONTEXT)).items);
					assert.match(transcript, /Output drain timed out/);
					assert.match(transcript, /Descendants outside the sandbox may still be running/);
				}
			} finally {
				if (descendant !== undefined) {
					try { process.kill(-descendant, "SIGKILL"); } catch { /* The test-owned descendant already exited. */ }
				}
			}
		});
	});
}

test("private-store symlink initialization failure prevents spawning and reports even with notify false", { skip: procSkip }, async (t) => {
	await withProcessHarness(async ({ start, wait, conversation, dir, workDir }) => {
		const outside = join(dir, "outside");
		await mkdir(outside);
		try { await symlink(outside, join(privateState, "proc-logs"), process.platform === "win32" ? "junction" : "dir"); }
		catch (err) { if (process.platform === "win32") { t.skip(`Symlink unavailable: ${String(err)}`); return; } throw err; }
		const id = await start("must-not-run", "echo BAD > started-marker");
		await wait(id);
		await assert.rejects(stat(join(workDir, "started-marker")), { code: "ENOENT" });
		assert.deepEqual(await readdir(outside), []);
		assert.match(JSON.stringify((await conversation.entries({}, 50, undefined, BACKGROUND_CONTEXT)).items), /command was not started/);
	});
});

test("log write failure kills the process and is reported instead of silent success", { skip: procSkip }, async () => {
	await withProcessHarness(async ({ start, wait, conversation, workDir }) => {
		const handle = await open(join(workDir, "prototype"), "w");
		const prototype = Object.getPrototypeOf(handle);
		await handle.close();
		const original = prototype.write;
		const writer = mock.method(prototype, "write", function (this: FileHandle, buffer: Buffer, ...args: unknown[]) {
			if (buffer.toString().includes("trigger-log-failure")) throw Object.assign(new Error("disk failed"), { code: "EIO" });
			return original.call(this, buffer, ...args);
		});
		try {
			const id = await start("fail", "echo trigger-log-failure; sleep 10; echo BAD > survived-marker");
			await wait(id);
			await assert.rejects(stat(join(workDir, "survived-marker")), { code: "ENOENT" });
			assert.match(JSON.stringify((await conversation.entries({}, 50, undefined, BACKGROUND_CONTEXT)).items), /Log capture failed \(EIO\); the process was terminated/);
			assert.equal(procTable.has(id as number), false);
		} finally { writer.mock.restore(); }
	});
});

test("capture handles short writes and log reads reject private-file symlinks", { skip: procSkip }, async (t) => {
	await withProcessHarness(async ({ start, wait, logs, conversation, workDir, dir }) => {
		const handle = await open(join(workDir, "prototype"), "w");
		const prototype = Object.getPrototypeOf(handle);
		await handle.close();
		const original = prototype.write;
		const writer = mock.method(prototype, "write", function (this: FileHandle, buffer: Buffer, offset: number, length: number) {
			return original.call(this, buffer, offset, Math.min(3, length));
		});
		let id: TaskId;
		try {
			id = await start("short", "echo COMPLETE-SHORT-WRITE-MARKER");
			await wait(id);
			assert.match(resultText(await logs(id)), /COMPLETE-SHORT-WRITE-MARKER/);
		} finally { writer.mock.restore(); }
		const path = join(privateState, "proc-logs", String(conversation.id), `${id}.log`);
		const outside = join(dir, "outside");
		await writeFile(outside, "SECRET-MARKER");
		await rm(path);
		try { await symlink(outside, path); }
		catch (err) { if (process.platform === "win32") { t.skip(`Symlink unavailable: ${String(err)}`); return; } throw err; }
		const denied = await logs(id);
		assert.equal((denied as { isError?: boolean }).isError, true);
		assert.doesNotMatch(resultText(denied), /SECRET-MARKER/);
	});
});

test("retention removes only expired terminal logs and does not follow private-store links", { skip: procSkip }, async (t) => {
	await withProcessHarness(async ({ harness, start, wait, logs, conversation, dir }) => {
		const finished = await start("finished", "echo historic");
		await wait(finished);
		const active = await start("active", "echo active; sleep 30");
		await until(async () => {
			const task = await harness.getTask(active, BACKGROUND_CONTEXT);
			return task?.state.status === "running" && (task.state.checkpoint as { phase: string }).phase === "watch";
		});
		await until(async () => /\nactive\n/.test(resultText(await logs(active))));
		assert.match(resultText(await logs(active)), /status running/);
		const store = join(privateState, "proc-logs", String(conversation.id));
		const outside = join(dir, "outside");
		await writeFile(outside, "leave alone");
		try { await symlink(outside, join(store, "999999.log")); }
		catch (err) { if (process.platform === "win32") t.diagnostic(`Symlink unavailable: ${String(err)}`); else throw err; }
		await pruneProcLogs(harness, Date.now() + 8 * 24 * 60 * 60 * 1000);
		await assert.rejects(stat(join(store, `${finished}.log`)), { code: "ENOENT" });
		assert.equal((await stat(join(store, `${active}.log`))).isFile(), true);
		assert.equal(await readFile(outside, "utf8"), "leave alone");
	});
});

test("legacy checkpoints report interruption without reading or migrating their workspace log path", { skip: procSkip }, async (t) => {
	await withProcessHarness(async ({ harness, conversation, workDir, dir, wait, logs }) => {
		const outside = join(dir, "outside");
		await writeFile(outside, "PRIVATE-MARKER-MUST-NOT-APPEAR");
		const legacyLog = join(workDir, "legacy.log");
		try { await symlink(outside, legacyLog); }
		catch (err) { if (process.platform === "win32") { t.skip(`Symlink unavailable: ${String(err)}`); return; } throw err; }
		const Legacy = defineTask<ProcInput, { phase: "watch"; pid: number; startedAt: number; logPath: string }, null>({
			name: PROC_TASK_KIND,
			version: 1,
			initial: () => ({ phase: "watch", pid: -1, startedAt: Date.now() - 1000, logPath: legacyLog }),
			phases: { watch: () => { throw new Error("The installed current definition must resume this legacy checkpoint"); } },
			abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
		});
		const id = await conversation.commit((tx) => tx.createTask(Legacy, { name: "legacy", command: "never-run", notify: true, creator: "ou_test", conversationId: conversation.id as number }, { ownership: { kind: "conversation" }, background: true }), BACKGROUND_CONTEXT);
		await wait(id);
		const record = await harness.getTask(id, BACKGROUND_CONTEXT);
		assert.equal(record?.state.status === "terminal" ? record.state.outcome.status : undefined, "completed");
		const transcript = JSON.stringify((await conversation.entries({}, 50, undefined, BACKGROUND_CONTEXT)).items);
		assert.match(transcript, /service restarted/);
		assert.match(transcript, /Legacy workspace log is unavailable/);
		assert.doesNotMatch(transcript, /PRIVATE-MARKER-MUST-NOT-APPEAR/);
		assert.equal(await readFile(outside, "utf8"), "PRIVATE-MARKER-MUST-NOT-APPEAR");
		assert.equal((await lstat(legacyLog)).isSymbolicLink(), true);
		assert.match(resultText(await logs(id)), /unavailable/);
	});
});
