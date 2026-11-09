// bash 沙箱装配：bwrap wrapper 脚本生成 + 启动探测（探测失败不启用，回退文件工具路径治理 + 危险命令正则）。
// wrapperScript / selfTestScript 是纯函数；真实 bwrap 行为（挂载视图、DNS、pid namespace）由服务器探针
// test/probe-bwrap.ts 验证，本模块单测只覆盖拼装（Windows 开发机无 bwrap）。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** 只读挂载的额外目录：node 安装前缀（execPath 的 bin/ 上级，沙箱内 node/npm 可用）与两个 DNS 解析目录；
 *  前缀落在 /usr 下时与固定项重叠，冗余挂载无害。/etc 与 DNS 目录在 exec 行里另有固定项，重复时按目标去重。 */
const DEFAULT_RO_DIRS = ["/etc", dirname(dirname(process.execPath)), "/run/resolvconf", "/run/systemd/resolve"];

/** sh 引号：常规路径原样嵌入（脚本可读、探针可 grep），含特殊字符时退回单引号转义。 */
const shWord = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** 透传进沙箱的 env 名单（GitHub 接入）：gh/git 只从 env 读 token 与非交互设置，--clearenv 后须显式设回。 */
export const SANDBOX_PASS_ENV = ["GH_TOKEN", "GH_PROMPT_DISABLED", "GIT_TERMINAL_PROMPT", "GH_NO_UPDATE_NOTIFIER", "GH_PAGER", "GH_CONFIG_DIR", "XDG_STATE_HOME"] as const;

/** bash 沙箱 wrapper（POSIX sh）：作为 bash 工具的 shellPath，spawn(shellPath, ["-c", cmd]) 在此进入 mount namespace。
 *  passEnv 只写变量名、值在运行期从 wrapper 自身的 env 取（值不落盘）；名单在生成期按存在与否定好，不做运行期条件展开。 */
export function wrapperScript(bwrapPath: string, roDirs: readonly string[], passEnv: readonly string[] = []): string {
	// 挂载表按目标路径去重、保持首次出现顺序：/usr 与 /etc 是固定项，roDirs 已含 /etc 或 DNS 解析目录时不重复拼
	const mounts: readonly (readonly [string, string])[] = [
		["--ro-bind", "/usr"],
		["--ro-bind-try", "/etc"],
		...roDirs.map((dir): readonly [string, string] => ["--ro-bind-try", dir]),
		["--ro-bind-try", "/run/resolvconf"],
		["--ro-bind-try", "/run/systemd/resolve"],
	];
	const seen = new Set<string>();
	const mountArgs: string[] = [];
	for (const [flag, dir] of mounts) {
		if (seen.has(dir)) continue;
		seen.add(dir);
		mountArgs.push(`${flag} ${shWord(dir)} ${shWord(dir)}`);
	}
	return `#!/bin/sh
# exec 让 bwrap 顶替 shell 进程：pid 不变，pi-durable 的进程组击杀语义保持
BWRAP=${shWord(bwrapPath)}
# pwd -P 取物理路径：spawn 传入的 cwd 可能经软链，bwrap 的挂载源与 --chdir 都要真实路径
CWD=$(pwd -P)
# clearenv 必须在两个 setenv 之前：bwrap 按出现顺序应用参数，先清空再设 PATH/HOME（反序会把两者一并清掉）。
# 注：exec 的续行内不能插注释（注释的行尾会终结整条命令）
exec "$BWRAP" ${mountArgs.join(" ")} \\
	--symlink usr/bin /bin --symlink usr/bin /sbin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \\
	--dev /dev --proc /proc --unshare-pid --die-with-parent \\
	--bind /tmp /tmp --bind "$CWD" "$CWD" --chdir "$CWD" \\
	--clearenv --setenv PATH "$PATH" --setenv HOME "$CWD"${passEnv.map((name) => ` --setenv ${name} "$${name}"`).join("")} \\
	/bin/bash "$@"
`;
}

/** 沙箱自检脚本（在 wrapper 内执行）：任一断言失败把失败项打到 stderr 并 exit 1，全过 exit 0。 */
export function selfTestScript(paths: { state: string; appRoot: string; sibling: string; marker: string }): string {
	const { state, appRoot, sibling, marker } = paths;
	return `fail() { echo "selftest FAIL: $1" >&2; exit 1; }
# pwd -P 已在 wrapper 内取物理路径；这里的三类路径必须经白名单挂载隔离（bind 只挂了 cwd 本身）
[ -e ${shWord(state)} ] && fail "state 目录可见"
[ -e ${shWord(appRoot)} ] && fail "应用根可见"
[ -e ${shWord(sibling)} ] && fail "兄弟目录可见"
# cwd 可写：bind RW 的会话目录
touch ${shWord(marker)} 2>/dev/null && rm -f ${shWord(marker)} || fail "cwd 不可写"
# /usr 只读：全局写入类操作在沙箱内天然失效
if touch /usr/.sb-test 2>/dev/null; then rm -f /usr/.sb-test; fail "/usr 可写"; fi
# resolv.conf 可能是普通文件，也可能是指向 /run 的 symlink（不挂解析目录则 DNS 断）：两种形态都算可用
if [ -s /etc/resolv.conf ]; then :; elif [ -L /etc/resolv.conf ] && [ -e /etc/resolv.conf ]; then :; else fail "resolv.conf 不可读"; fi
echo "selftest OK"
`;
}

export type SandboxState = { enabled: boolean; reason?: string; wrapperPath?: string };

/** dwell.proc 直接 spawn 用的 shell：沙箱启用即 wrapper（与 bash 工具同一进沙箱路径）；否则找系统 bash。
 *  NodeExecutionEnv 的默认解析是私有函数，这里用同一套候选（win32：Git Bash 安装位 → PATH；其余：/bin/bash → which）。
 *  找不到返回空 path：proc 任务的 start 阶段会拒并回报，不影响其他工具。 */
export function resolveSpawnShell(state: SandboxState): { path: string; sandboxed: boolean } {
	if (state.enabled && state.wrapperPath !== undefined) return { path: state.wrapperPath, sandboxed: true };
	if (process.platform === "win32") {
		const candidates = [`${process.env.ProgramFiles ?? ""}\\Git\\bin\\bash.exe`, `${process.env["ProgramFiles(x86)"] ?? ""}\\Git\\bin\\bash.exe`].filter((p) => p !== "\\Git\\bin\\bash.exe");
		for (const candidate of candidates) if (existsSync(candidate)) return { path: candidate, sandboxed: false };
		const where = spawnSync("where", ["bash"], { encoding: "utf8" });
		if (where.status === 0) {
			const found = where.stdout.split(/\r?\n/).find((p) => p.trim() !== "");
			if (found !== undefined) return { path: found.trim(), sandboxed: false };
		}
		return { path: "", sandboxed: false };
	}
	if (existsSync("/bin/bash")) return { path: "/bin/bash", sandboxed: false };
	const which = spawnSync("which", ["bash"], { encoding: "utf8" });
	if (which.status === 0 && which.stdout.trim() !== "") return { path: which.stdout.trim(), sandboxed: false };
	return { path: "", sandboxed: false };
}

/** 启动探测：Linux + bwrap 存在 + 在 $dataDir/work/.selftest 里跑 wrapper 自检通过 → 启用；
 *  任一步失败返回 disabled（不算错误，调用方记日志后照常运行）。 */
export async function probeSandbox(opts: { dataDir: string; stateDir: string; appRoot: string; forceOff: boolean }): Promise<SandboxState> {
	// 平台检查在前：非 Linux（本地开发机）直接短路，不触碰文件系统
	if (process.platform !== "linux") return { enabled: false, reason: `非 Linux 平台（${process.platform}）` };
	if (opts.forceOff) return { enabled: false, reason: "DWELL_SANDBOX=off" };
	// PATH 里找 bwrap，找不到退回常见安装路径
	let bwrap = "";
	const which = spawnSync("which", ["bwrap"], { encoding: "utf8" });
	if (which.status === 0 && which.stdout.trim() !== "") bwrap = which.stdout.trim();
	else if (existsSync("/usr/bin/bwrap")) bwrap = "/usr/bin/bwrap";
	if (bwrap === "") return { enabled: false, reason: "未找到 bwrap（apt install bubblewrap）" };

	// 目录统一绝对路径：selftest 断言按绝对路径判，相对路径在沙箱内会落到 cwd 上
	const dataDir = resolve(opts.dataDir);
	const selftestDir = join(dataDir, "work", ".selftest");
	const sibling = join(dataDir, "work", ".selftest-sibling");
	try {
		await mkdir(selftestDir, { recursive: true });
		await mkdir(sibling, { recursive: true }); // 兄弟会话目录要真实存在，断言才有意义
		// wrapper 落盘：tmp 写 + chmod + rename 原子替换，回读校验内容一致
		const passEnv = SANDBOX_PASS_ENV.filter((name) => (process.env[name] ?? "") !== "");
		const script = wrapperScript(bwrap, DEFAULT_RO_DIRS, passEnv);
		const wrapperPath = join(dataDir, "bin", "sandbox-bash");
		await mkdir(join(dataDir, "bin"), { recursive: true });
		const tmp = `${wrapperPath}.tmp`;
		await writeFile(tmp, script, "utf8");
		await chmod(tmp, 0o755);
		await rename(tmp, wrapperPath);
		if ((await readFile(wrapperPath, "utf8")) !== script) return { enabled: false, reason: "wrapper 落盘校验不一致" };

		const result = spawnSync(wrapperPath, ["-c", selfTestScript({ state: resolve(opts.stateDir), appRoot: resolve(opts.appRoot), sibling, marker: join(selftestDir, ".marker") })], {
			cwd: selftestDir,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			timeout: 15000,
			encoding: "utf8",
		});
		if (result.status === 0) return { enabled: true, wrapperPath };
		// stderr 摘要截 300 字；wrapper 本身起不来时 stderr 为空，补 spawn 错误信息
		const detail = [(result.stderr ?? "").trim(), result.error === undefined ? "" : result.error.message].filter((s) => s !== "").join("; ").replaceAll("\n", "; ").slice(0, 300);
		return { enabled: false, reason: `自检失败（exit ${result.status}）：${detail}` };
	} catch (e) {
		// 目录/wrapper 落盘失败也只是不启用，不阻断启动
		return { enabled: false, reason: `探测出错：${e instanceof Error ? e.message : String(e)}` };
	} finally {
		await rm(selftestDir, { recursive: true, force: true });
		await rm(sibling, { recursive: true, force: true });
	}
}
