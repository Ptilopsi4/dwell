// 一次性探针（不在 npm test 内）：Linux 服务器上验证 bash 沙箱的真实行为（挂载视图、pid namespace、DNS、环境擦除）。
// 用法：node test/probe-bwrap.ts（DWELL_DATA/DWELL_STATE 缺省 ./data ./state，与 src/state.ts 一致）。
// 需要先 apt install bubblewrap；本机（非 Linux）跑会直接 skip。每条断言打 PASS/FAIL，任一 FAIL exit 1。
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_ROOT, DATA_DIR, STATE_DIR } from "../src/state.ts";
import { probeSandbox } from "../src/sandbox.ts";

if (process.platform !== "linux") {
	console.log(`skip：当前平台 ${process.platform} 非 Linux（开发机跳过，服务器上跑）`);
	process.exit(0);
}

// 断言路径一律绝对：相对路径在沙箱内按 workDir 解析，"不可见"会假通过
const DATA = resolve(DATA_DIR);
const STATE = resolve(STATE_DIR);
const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

const state = await probeSandbox({ dataDir: DATA, stateDir: STATE, appRoot: APP_ROOT, forceOff: false });
if (!state.enabled) {
	console.error(`FAIL：沙箱未启用：${state.reason}`);
	process.exit(1);
}
console.log(`PASS：probeSandbox 启用（wrapper: ${state.wrapperPath}）`);
const wrapper = state.wrapperPath!;

let fails = 0;
const check = (name: string, pass: boolean, detail?: string): void => {
	console.log(`${pass ? "PASS" : "FAIL"}：${name}${pass || detail === undefined || detail === "" ? "" : `（${detail}）`}`);
	if (!pass) fails++;
};

// 断言用目录：沙箱外的兄弟目录（沙箱内应不可见）+ 可写的 cwd
const sibling = join(DATA, "work", ".probe-bwrap-sibling");
const workDir = join(DATA, "work", ".probe-bwrap");
mkdirSync(sibling, { recursive: true });
mkdirSync(workDir, { recursive: true });

// 注入假密钥标记：wrapper 的 --clearenv 应把它们全擦掉（证明 clearenv 生效，不依赖探针进程自己的 env）
const spawnEnv = { ...process.env, ZAI_CODING_CN_API_KEY: "probe-ZAI-marker", DEEPSEEK_API_KEY: "probe-DEEPSEEK-marker", LARK_APP_SECRET: "probe-LARK-token" };

const run = (cmd: string): { status: number | null; out: string; err: string } => {
	const r = spawnSync(wrapper, ["-c", cmd], { cwd: workDir, env: spawnEnv, encoding: "utf8", timeout: 30000 });
	return { status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

try {
	// 禁区不可见（白名单挂载表之外整个不存在）
	check("state 目录不可见", run(`test -e ${q(STATE)}`).status !== 0);
	check("应用根不可见", run(`test -e ${q(APP_ROOT)}`).status !== 0);
	check("兄弟会话目录不可见", run(`test -e ${q(sibling)}`).status !== 0);

	// cwd 可写 / /usr 只读
	const write = run("touch .probe-write && rm .probe-write");
	check("写 cwd 成功", write.status === 0, write.err);
	check("写 /usr 失败（EROFS）", run("touch /usr/.sb-probe").status !== 0);

	// 环境干净：clearenv 后只剩 PATH/HOME，任何密钥形态都不该出现
	const env = run(`printenv | grep -E "ZAI_CODING_CN_API_KEY|DEEPSEEK_API_KEY|LARK_APP_ID|LARK_APP_SECRET|SECRET|TOKEN|API_KEY" || true`);
	check("printenv 不含密钥（ZAI/DEEPSEEK/LARK/SECRET/TOKEN/API_KEY）", env.out === "", env.out);

	// DNS（ro-bind-try 的解析目录生效才算通）
	const dns = run("getent hosts deb.debian.org");
	check("getent hosts deb.debian.org 通", dns.status === 0, dns.err);

	// unshare-pid：沙箱内 /proc/1 是 namespace 的 init（bwrap 本体），不是宿主 systemd。
	// 断言用肯定式：cmdline 含 bwrap。否定式正则会踩坑——bwrap 参数里的 /run/systemd/resolve 含字面 "systemd"
	const pid1 = run(`tr "\\0" " " < /proc/1/cmdline`);
	check("/proc/1 是沙箱 init（bwrap）", pid1.status === 0 && pid1.out.includes("bwrap"), pid1.out.slice(0, 80));
} finally {
	rmSync(workDir, { recursive: true, force: true });
	rmSync(sibling, { recursive: true, force: true });
}

if (fails > 0) {
	console.error(`共 ${fails} 项 FAIL`);
	process.exit(1);
}
console.log("全部断言通过");
