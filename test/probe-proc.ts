// 一次性探针（不在 npm test 内）：Linux 服务器上验证 dwell.proc 的真实行为——进程活过单次命令、
// 进程组停止清场（pidns 内含孙进程）、沙箱网络可达（同 cwd 的 server 可被 bash 连上）。
// 用法：node test/probe-proc.ts（需沙箱启用：先跑 probe-bwrap 确认 PASS）。非 Linux 自动 skip。
// 重启清场（服务重启进程随 cgroup 消失）不在本探针内：属 systemd 行为，部署时手动验证。
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { APP_ROOT, DATA_DIR, STATE_DIR } from "../src/state.ts";
import { probeSandbox, resolveSpawnShell } from "../src/sandbox.ts";

if (process.platform !== "linux") {
	console.log(`skip：当前平台 ${process.platform} 非 Linux（开发机跳过，服务器上跑）`);
	process.exit(0);
}

let fails = 0;
const check = (name: string, pass: boolean, detail?: string): void => {
	console.log(`${pass ? "PASS" : "FAIL"}：${name}${pass || detail === undefined || detail === "" ? "" : `（${detail}）`}`);
	if (!pass) fails++;
};

const state = await probeSandbox({ dataDir: resolve(DATA_DIR), stateDir: resolve(STATE_DIR), appRoot: APP_ROOT, forceOff: false });
if (!state.enabled) {
	console.error(`FAIL：沙箱未启用（${state.reason}）；dwell.proc 探针只验证沙箱形态`);
	process.exit(1);
}
const shell = resolveSpawnShell(state);
if (shell.path === "") {
	console.error("FAIL：resolveSpawnShell 找不到 shell");
	process.exit(1);
}
console.log(`PASS：沙箱启用，proc shell = ${shell.path}`);

const workDir = mkdtempSync(join(tmpdir(), "probe-proc-"));
mkdirSync(join(workDir, ".dwell-proc"), { recursive: true });

/** 按 proc.ts 的 start 阶段同参数 spawn（detached + 进程组 + 日志 fd）。 */
const spawnProc = (command: string, logName: string) => {
	const logFd = openSync(join(workDir, ".dwell-proc", `${logName}.log`), "w");
	const child = spawn(shell.path, ["-c", command], {
		cwd: workDir,
		detached: true,
		env: { ...process.env },
		stdio: ["ignore", logFd, logFd],
	});
	return { child, logFd };
};

try {
	// 1. 进程活过 spawn 调用（sleep 在 pidns 里持续运行）
	const { child: sleeper } = spawnProc("sleep 300", "sleep");
	check("sleep 进程已起（pid 非 0）", typeof sleeper.pid === "number" && sleeper.pid > 0);
	await new Promise((r) => setTimeout(r, 500));
	let alive = true;
	try {
		process.kill(-sleeper.pid!, 0);
	} catch {
		alive = false;
	}
	check("spawn 返回后进程组仍存活", alive, "die-with-parent 不应在父进程活着时触发");
	// 组击杀清场（abort 路径同款）
	try {
		process.kill(-sleeper.pid!, "SIGTERM");
	} catch {}
	await new Promise((r) => setTimeout(r, 500));
	let gone = false;
	try {
		process.kill(-sleeper.pid!, 0);
	} catch {
		gone = true;
	}
	check("SIGTERM 组击杀后进程组消失", gone);

	// 2. pidns 内孙进程随组终止：setsid 也逃不出 pid namespace
	const { child: tree } = spawnProc("setsid sleep 300 >/dev/null 2>&1 & echo grandchild-started; sleep 300", "tree");
	await new Promise((r) => setTimeout(r, 500));
	try {
		process.kill(-tree.pid!, "SIGTERM");
	} catch {}
	await new Promise((r) => setTimeout(r, 500));
	let treeGone = false;
	try {
		process.kill(-tree.pid!, 0);
	} catch {
		treeGone = true;
	}
	check("组击杀后 setsid 孙进程同样消亡", treeGone, "pidns 内 SIGTERM 应拆掉整个 namespace");

	// 3. 沙箱内起 server，宿主 spawn 的同 cwd bash 能连上（网络共享）
	const { child: server } = spawnProc("python3 -m http.server 18765 --bind 127.0.0.1", "http");
	await new Promise((r) => setTimeout(r, 1200));
	const curl = spawnSync(shell.path, ["-c", "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18765/"], { cwd: workDir, encoding: "utf8", timeout: 15000 });
	check("同 cwd 的 bash 能连上 proc 起的 server", (curl.stdout ?? "").includes("200"), `curl=${(curl.stdout ?? "").trim()} err=${(curl.stderr ?? "").trim()}`);
	try {
		process.kill(-server.pid!, "SIGTERM");
	} catch {}

	// 4. 日志捕获：stdout 进 .dwell-proc/<name>.log
	const { child: echoer } = spawnProc("echo probe-log-line", "echo");
	await new Promise((r) => setTimeout(r, 800));
	let logOk = false;
	try {
		logOk = readFileSync(join(workDir, ".dwell-proc", "echo.log"), "utf8").includes("probe-log-line");
	} catch {}
	check("stdout 落日志文件", logOk);
	try {
		echoer.kill("SIGTERM");
	} catch {}
} finally {
	await new Promise((r) => setTimeout(r, 300));
	rmSync(workDir, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);
