// 一次性探针（不在 npm test 内）：Linux 上验证 scrubSecretEnv 把密钥从 /proc 原始环境区真正擦掉。
// 用法：node test/probe-scrub.ts   （需 bash；本机 Windows 跳过并提示）
// 背景：unsetenv 不改 /proc/<pid>/environ，bash 里 `grep -a <key> /proc/$PPID/environ` 仍能读回启动时的值。
import { spawnSync } from "node:child_process";

if (process.platform !== "linux") {
	console.log(`skip：当前平台 ${process.platform} 非 Linux（开发机跳过，服务器上跑）`);
	process.exit(0);
}

const MARK = `dwell-probe-${Date.now().toString(36)}`;
process.env.ZAI_CODING_CN_API_KEY = MARK;
process.env.DWELL_ADMINS = "ou_probe_admin";

const { scrubSecretEnv } = await import("../src/harness.ts");

try {
	await scrubSecretEnv();
} catch (err) {
	console.error("FAIL：scrubSecretEnv 抛错（fail-closed 语义生效，但覆写未成功）:", err);
	process.exit(1);
}

if (process.env.ZAI_CODING_CN_API_KEY !== undefined || process.env.DWELL_ADMINS !== undefined) {
	console.error("FAIL：process.env 未删除");
	process.exit(1);
}

// 子进程视角：bash 里读父进程的原始环境区（这是模型能执行的路径）
const probe = spawnSync("bash", ["-c", 'grep -a -c "$1" /proc/$PPID/environ || echo 0', "probe", MARK], { encoding: "utf8" });
const hits = Number((probe.stdout ?? "").trim());
if (!Number.isFinite(hits) || hits > 0) {
	console.error(`FAIL：/proc/$PPID/environ 仍能读回密钥标记（命中 ${hits} 行）`);
	process.exit(1);
}
console.log("PASS：env 已删、/proc 原始环境区已覆写（子进程读不回密钥）");
