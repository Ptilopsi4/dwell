// 一次性探针（不在 npm test 内）：Linux 上验证 scrubSecretEnv 把密钥从 /proc 原始环境区真正擦掉。
// 用法：ZAI_CODING_CN_API_KEY=<随机标记> node test/probe-scrub.ts（标记必须在启动命令里注入——进程启动后才 set 的 env 不在原始环境区）。
// 注意不要用 `sudo -u <user> env VAR=<标记> node ...`：sudo 会把整条命令记进 SUDO_COMMAND 环境变量，标记值出现在
// 非密钥条目里，自检（environ 全文不含标记值，fail-closed）必误报。确需换用户时用 bash 包装脚本：
//   sudo -u <user> bash /tmp/wrap.sh   # wrap.sh 内 export VAR=<标记> && exec node test/probe-scrub.ts
//   （/tmp 常见 noexec，须经解释器调用；SUDO_COMMAND 只记 "bash /tmp/wrap.sh"，不含标记）
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

if (process.platform !== "linux") {
	console.log(`skip：当前平台 ${process.platform} 非 Linux（开发机跳过，服务器上跑）`);
	process.exit(0);
}

const MARK = process.env.ZAI_CODING_CN_API_KEY ?? "";
if (MARK === "") {
	console.error("用法：ZAI_CODING_CN_API_KEY=<随机标记> node test/probe-scrub.ts（标记必须经启动命令注入）");
	process.exit(1);
}

// 前置：标记确实在原始环境区，否则 spans 为空、scrub 静默跳过，探针变成假绿
if (!(await readFile("/proc/self/environ")).includes(MARK)) {
	console.error("前置失败：标记不在 /proc/self/environ（进程内 set 的 env 不进原始环境区，须由启动命令注入）");
	process.exit(1);
}

const { scrubSecretEnv } = await import("../src/harness.ts");

try {
	await scrubSecretEnv();
} catch (err) {
	console.error("FAIL：scrubSecretEnv 抛错（fail-closed 语义生效，但覆写未成功）:", err);
	process.exit(1);
}

if (process.env.ZAI_CODING_CN_API_KEY !== undefined) {
	console.error("FAIL：process.env 未删除");
	process.exit(1);
}

// 子进程视角：bash 读父进程原始环境区（这是模型能执行的路径）。grep -q：退出码 0=仍能读回（FAIL），1=已擦净
const probe = spawnSync("bash", ["-c", 'grep -a -q "$1" /proc/$PPID/environ', "probe", MARK], { encoding: "utf8" });
if (probe.status === 0) {
	console.error("FAIL：/proc/$PPID/environ 仍能读回密钥标记");
	process.exit(1);
}
if (probe.status !== 1) {
	console.error(`FAIL：探针 bash 异常（exit ${probe.status}）:`, probe.stderr);
	process.exit(1);
}
console.log("PASS：env 已删、/proc 原始环境区已覆写（子进程读不回密钥）");
