import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

for (const method of ["getUpdates", "getFile"]) test(`Telegram acceptance transport retains ${method} cancellation after garbage collection`, async () => {
	await promisify(execFile)(process.execPath, ["--expose-gc", "--input-type=module", "--eval", `
		await import(${JSON.stringify(new URL("./telegram-main-hook.ts", import.meta.url).href)});
		const controller = new AbortController();
		const pending = fetch("https://api.telegram.org/bot100:SYNTHETIC_TEST_TOKEN/${method}", {
			method: "POST", body: '{"file_id":"hold-gc"}',
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
		});
		await new Promise(setImmediate);
		globalThis.gc();
		await new Promise(setImmediate);
		globalThis.gc();
		controller.abort();
		const deadline = setTimeout(() => { throw new Error("Synthetic request lost its abort signal"); }, 500);
		await pending.catch(() => {});
		clearTimeout(deadline);
	`], { timeout: 5000 });
});
