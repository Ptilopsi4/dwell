// Linux-only probe of the real durable process task, sandbox, private logs and stop path.
// No model/network API is used. Service-restart cgroup cleanup remains a deployment check.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

if (process.platform !== "linux") {
	console.log(`skip：当前平台 ${process.platform} 非 Linux（开发机跳过，服务器上跑）`);
	process.exit(0);
}

const dataBase = resolve(process.env.DWELL_DATA ?? "./data");
const stateBase = resolve(process.env.DWELL_STATE ?? "./state");
await mkdir(dataBase, { recursive: true });
await mkdir(stateBase, { recursive: true });
// Keep the isolated private store outside /tmp, which the sandbox shares.
const dataDir = await mkdtemp(join(dataBase, ".probe-proc-"));
const stateDir = await mkdtemp(join(stateBase, ".probe-proc-"));
process.env.DWELL_STATE = stateDir;
process.env.DWELL_DATA = dataDir;
const { APP_ROOT } = await import("../src/state.ts");
const { probeSandbox, resolveSpawnShell } = await import("../src/sandbox.ts");
const { makeProcExtension, makeProcTask, PROC_TASK_KIND } = await import("../src/ext/proc.ts");
const { scanLiveTasks } = await import("../src/ext/schedule.ts");

let fails = 0;
const check = (name: string, pass: boolean): void => {
	console.log(`${pass ? "PASS" : "FAIL"}：${name}`);
	if (!pass) fails++;
};
const until = async (checkState: () => Promise<boolean>, timeout = 15000): Promise<void> => {
	for (const deadline = Date.now() + timeout; ;) {
		if (await checkState()) return;
		if (Date.now() > deadline) throw new Error("进程探针等待超时");
		await new Promise((r) => setTimeout(r, 25));
	}
};
let harness: Harness | undefined;
try {
	const sandbox = await probeSandbox({ dataDir, stateDir, appRoot: APP_ROOT, forceOff: false });
	if (!sandbox.enabled) throw new Error(`沙箱未启用：${sandbox.reason}`);
	const shell = resolveSpawnShell(sandbox);
	const cwd = join(dataDir, "work", "probe");
	await mkdir(cwd, { recursive: true });
	const deps = { attribute: async () => {}, onFired: () => {}, getHarness: () => harness, senderOf: () => "probe", shell: () => shell };
	const ProcRun = makeProcTask(deps);
	const extension = makeProcExtension(deps);
	const registry = createRegistry();
	registry.install(extension);
	const models = createModels();
	models.setProvider(fauxProvider().provider);
	const context = BACKGROUND_CONTEXT;
	harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, "probe.sqlite")), { models, registry, env: async ({ cwd: target }) => new NodeExecutionEnv({ cwd: resolve(target ?? cwd) }) }, context);
	const activeHarness = harness;
	harness.resume();
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd, model: { provider: "faux", modelId: "faux-1" } } }, context);
	const start = (name: string, command: string) => conversation.commit((tx) => tx.createTask(ProcRun, { name, command, creator: "probe", conversationId: conversation.id as number, notify: false }, { ownership: { kind: "conversation" }, background: true }), context);
	const wait = (id: TaskId) => until(async () => (await activeHarness.getTask(id, context))?.state.status === "terminal");
	const watch = async (id: TaskId) => {
		let pid = -1;
		await until(async () => {
			const task = await activeHarness.getTask(id, context);
			const ck = task?.state.status === "running" ? task.state.checkpoint as { phase: string; pid: number } : undefined;
			if (ck?.phase === "watch") pid = ck.pid;
			return ck?.phase === "watch";
		});
		return pid;
	};
	const stop = async (id: TaskId) => { await activeHarness.abortTask(id, context); await wait(id); };

	const sleeper = await start("sleep", "sleep 300");
	const pid = await watch(sleeper);
	let alive = true;
	try { process.kill(-pid, 0); } catch { alive = false; }
	check("真实 proc 任务在调用结束后持续运行", alive);
	await stop(sleeper);
	let gone = false;
	try { process.kill(-pid, 0); } catch { gone = true; }
	check("真实 abort 路径杀掉进程组", gone);

	const heartbeat = join(cwd, "descendant-heartbeat");
	const tree = await start("tree", "setsid sh -c 'while :; do printf x >> descendant-heartbeat; sleep 0.05; done' >/dev/null 2>&1 & echo grandchild-started; sleep 300");
	const treePid = await watch(tree);
	await until(async () => (await readFile(heartbeat).catch(() => Buffer.alloc(0))).length >= 3);
	await stop(tree);
	const heartbeatAfterStop = (await readFile(heartbeat)).length;
	await new Promise((r) => setTimeout(r, 250));
	let treeGone = false;
	try { process.kill(-treePid, 0); } catch { treeGone = true; }
	check("沙箱中含 setsid 子进程的进程组停止清场", treeGone);
	check("setsid 后代停止写入心跳", (await readFile(heartbeat)).length === heartbeatAfterStop);

	const server = await start("http", `node -e 'require("node:http").createServer((req,res)=>res.end("probe")).listen(18765,"127.0.0.1")'`);
	await watch(server);
	let connected = false;
	for (let i = 0; i < 20 && !connected; i++) {
		const response = spawnSync(shell.path, ["-c", `node -e 'fetch("http://127.0.0.1:18765/",{signal:AbortSignal.timeout(2000)}).then(r=>console.log(r.status)).catch(()=>process.exitCode=1)'`], { cwd, encoding: "utf8", timeout: 3000 });
		connected = response.status === 0 && response.stdout.trim() === "200";
		if (!connected) await new Promise((r) => setTimeout(r, 100));
	}
	check("沙箱内托管进程可由同 cwd bash 通过本机网络访问", connected);
	await stop(server);

	const outside = join(stateDir, "outside-marker");
	await writeFile(outside, "untouched");
	await mkdir(join(cwd, ".dwell-proc"));
	await symlink(outside, join(cwd, ".dwell-proc", "echo.log"));
	const echo = await start("echo", "echo probe-stdout; echo probe-stderr >&2; for fd in /proc/self/fd/*; do readlink \"$fd\"; done");
	await wait(echo);
	const log = await readFile(join(stateDir, "proc-logs", String(conversation.id), `${echo}.log`), "utf8");
	check("真实 pipe 捕获 stdout 与 stderr", log.includes("probe-stdout") && log.includes("probe-stderr"));
	check("agent 的旧日志软链无法覆盖私有文件", await readFile(outside, "utf8") === "untouched");
	check("子进程没有继承私有日志的可写 fd", !log.includes(stateDir));
	const logTool = extension.tools?.find((tool) => tool.name === "dwell.proc.logs");
	if (logTool === undefined) throw new Error("日志工具未注册");
	const result = await logTool.execute({ taskId: echo as number }, { conversationId: conversation.id, now: () => Date.now(), commit: <T,>(fn: (tx: never) => T | Promise<T>) => conversation.commit(fn as never, context) } as never, context as never);
	check("日志工具能读取本会话已完成任务", JSON.stringify(result).includes("probe-stdout"));
} catch (err) {
	console.error("FAIL：进程探针失败", err);
	fails++;
} finally {
	if (harness !== undefined) {
		for (const task of await harness.commit((tx) => scanLiveTasks(tx, { kind: PROC_TASK_KIND }), BACKGROUND_CONTEXT)) {
			await harness.abortTask(task.id, BACKGROUND_CONTEXT);
			await until(async () => (await harness!.getTask(task.id, BACKGROUND_CONTEXT))?.state.status === "terminal");
		}
		await harness.close(BACKGROUND_CONTEXT);
	}
	await rm(dataDir, { recursive: true, force: true });
	await rm(stateDir, { recursive: true, force: true });
}
process.exitCode = fails === 0 ? 0 : 1;
