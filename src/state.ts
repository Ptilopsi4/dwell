// 状态文件写：tmp + rename 原子替换，实例内 promise 链互斥（并发消息不损坏 JSON）。
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR } from "./harness.ts";

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
