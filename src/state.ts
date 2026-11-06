// 状态文件写：tmp + rename 原子替换，实例内 promise 链互斥（并发消息不损坏 JSON）。
// 目录常量定义在这里：approval（路径治理/持久化）要引用它们，若放 harness.ts 会形成 approval→harness→approval 环。
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 应用根（src/ 的上级）：dwell 自身源码与部署配置所在，agent 不可读写，沙箱内不可见。 */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 数据目录（默认 ./data，容器内 /data）：dwell.sqlite + work/<会话工作目录>，agent 可写域。 */
export const DATA_DIR = process.env.DWELL_DATA ?? "./data";

/** 状态目录（默认 ./state，容器内 /state）：users/sessions/message-map/approvals。必须在 agent 可写域之外。 */
export const STATE_DIR = process.env.DWELL_STATE ?? "./state";

/** 未设 cwd 的会话（root）的工作目录：不能退回 process.cwd()（应用根），沙箱会把它可写挂进去。 */
export const DEFAULT_CWD = resolve(DATA_DIR, "work", "root");

let chain: Promise<void> = Promise.resolve();

export async function initStateDir(): Promise<void> {
	await mkdir(STATE_DIR, { recursive: true });
}

/** 串行 + 原子写 JSON 状态文件。 */
export function writeStateJson(file: string, data: unknown): Promise<void> {
	const run = async (): Promise<void> => {
		const tmp = `${file}.tmp`;
		await writeFile(tmp, JSON.stringify(data, null, "\t"));
		await rename(tmp, file);
	};
	chain = chain.then(run, run);
	return chain;
}

export function stateFile(name: string): string {
	return join(STATE_DIR, name);
}
