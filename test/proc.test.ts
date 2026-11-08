// node --test "test/proc.test.ts"
// 托管后台进程：退出回报与归属顺序 / stop 杀进程不回报 / notify:false 静默 / 重启后 lost 回报 / 工具层重名。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { resolveSpawnShell } from "../src/sandbox.ts";
import { PROC_TASK_KIND, formatDuration, formatProcExitReport, formatProcList, makeProcExtension, makeProcTask, procCapViolation, procNameViolation, procTable, tailLines, type ProcDeps } from "../src/ext/proc.ts";
import { scanLiveTasks } from "../src/ext/schedule.ts";

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

	const ok = formatProcExitReport("srv", 0, false, 90, "line1\nline2");
	assert.match(ok, /\[Background process srv exited with code 0\] after 1m 30s/);
	assert.match(ok, /Last log lines:\nline1\nline2/);
	assert.match(formatProcExitReport("srv", 1, false, 5, ""), /\[Background process srv exited with code 1\]/);
	assert.ok(!formatProcExitReport("srv", 1, false, 5, "").includes("Last log lines"), "无日志不带尾巴");
	assert.match(formatProcExitReport("srv", null, true, 5, ""), /service restarted/);
	assert.match(formatProcExitReport("srv", null, false, 5, ""), /abnormally/);
});

test("纯函数：列表格式", () => {
	assert.equal(formatProcList([], 0), "No background processes in this conversation.");
	const tasks = [
		{ input: { name: "a", command: "x", notify: true, creator: "u", conversationId: 1 }, state: { status: "running", checkpoint: { phase: "watch", pid: 4242, startedAt: 1000, logPath: "/w/.dwell-proc/a.log" } } },
		{ input: { name: "b", command: "y", notify: false, creator: "u", conversationId: 1 }, state: { status: "running", checkpoint: { phase: "report", code: 0, lost: false, startedAt: 1000 } } },
		{ input: { name: "c", command: "z", notify: true, creator: "u", conversationId: 1 }, state: { status: "running", checkpoint: { phase: "start" } } },
	];
	const out = formatProcList(tasks as never, 61_000);
	assert.match(out, /- a \(pid 4242\) · running for 1m · log \.dwell-proc\/a\.log/);
	assert.match(out, /- b · exiting/);
	assert.match(out, /- c · starting/);
});

test("集成：自然退出回报会话并带日志尾；归属先于开卡", { skip: procSkip }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-proc-"));
	const order: string[] = [];
	const fired: { header: string }[] = [];
	const deps: ProcDeps = {
		attribute: async () => {
			order.push("attribute:start");
			await new Promise((r) => setTimeout(r, 30));
			order.push("attribute:done");
		},
		onFired: (_c, _s, header) => {
			order.push("fired");
			fired.push({ header });
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
		await until(async () => (await harness.getTask(taskId, context))?.state.status === "terminal");
		assert.deepEqual(order, ["attribute:start", "attribute:done", "fired"], "归属登记完成后才 submit 回报并开卡");
		assert.match(fired[0]?.header ?? "", /后台进程 ping 已退出/);
		const page = await conv.entries({}, 20, undefined, context);
		const report = page.items.find((e) => JSON.stringify(e).includes("exited with code 0"));
		assert.ok(report !== undefined, "会话应收到退出回报");
		assert.match(JSON.stringify(report), /hello-proc/, "回报带日志尾");
		const log = await readFile(join(workDir, ".dwell-proc", "ping.log"), "utf8");
		assert.match(log, /hello-proc/);
		assert.match(log, /\[dwell\] exited with code 0/);
	} finally {
		await harness.close(context).catch(() => {});
		await cleanupDir(dir);
	}
});

test("集成：stop 杀进程且不回报", { skip: procSkip }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-proc-stop-"));
	const fired: unknown[] = [];
	const deps: ProcDeps = {
		attribute: async () => {},
		onFired: () => fired.push(1),
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
	const deps: ProcDeps = { attribute: async () => {}, onFired: () => fired.push(1), getHarness: () => undefined, senderOf: () => "ou_test", shell: () => shell };
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
	const deps: ProcDeps = { attribute: async () => {}, onFired: () => fired.push(1), getHarness: () => undefined, senderOf: () => "ou_test", shell: () => shell };
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
	const deps: ProcDeps = { attribute: async () => {}, onFired: () => fired.push(1), getHarness: () => harnessRef, senderOf: () => "ou_test", shell: () => shell };
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
			return /- srv \(pid \d+\)/.test(listed);
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
