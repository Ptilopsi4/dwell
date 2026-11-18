import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("configured key references are scrubbed while the captured client remains usable", { timeout: 10_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-model-scrub-"));
	try {
		const file = join(dir, "models.json");
		await writeFile(file, JSON.stringify({ main: { api: "openai-completions", baseUrl: "https://synthetic-model.example.test/v1", model: "opaque-model-alias", apiKeyEnv: "SYNTHETIC_MODEL_SECRET" }, vision: null }));
		const harnessUrl = new URL("../src/harness.ts", import.meta.url).href;
		const modelsUrl = new URL("../src/models.ts", import.meta.url).href;
		const program = `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const expected = process.env.SYNTHETIC_MODEL_SECRET;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const { MODEL_CONFIG, scrubSecretEnv } = await import(${JSON.stringify(harnessUrl)});
const { createModelClient } = await import(${JSON.stringify(modelsUrl)});
const client = createModelClient(MODEL_CONFIG.main, expected);
await scrubSecretEnv();
assert.equal(process.env.SYNTHETIC_MODEL_SECRET, undefined);
assert.equal(process.env.TELEGRAM_BOT_TOKEN, undefined);
if (process.platform === "linux") {
  const environment = await readFile("/proc/self/environ", "utf8");
  assert.equal(environment.includes(expected), false);
  assert.equal(environment.includes(telegramToken), false);
}
let requests = 0;
globalThis.fetch = async (input, init) => {
  requests++;
  const request = new Request(input, init);
  assert.equal(request.headers.get("Authorization"), "Bearer " + expected);
  assert.equal((await request.json()).model, "opaque-model-alias");
  const value = {choices:[{index:0,delta:{role:"assistant",content:"captured"},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
  return new Response("data: " + JSON.stringify(value) + "\\n\\ndata: [DONE]\\n\\n", {headers:{"Content-Type":"text/event-stream"}});
};
const answer = await client.models.completeSimple(client.model, {messages:[{role:"user",content:"test",timestamp:Date.now()}]});
assert.equal(answer.stopReason, "stop");
assert.equal(requests, 1);
console.log("configured model credential capture and scrub verified");
`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
			cwd: resolve(import.meta.dirname, ".."),
			env: { PATH: process.env.PATH, DWELL_DATA: join(dir, "data"), DWELL_STATE: join(dir, "state"), DWELL_MODELS_FILE: file, SYNTHETIC_MODEL_SECRET: "synthetic-initial-environment-marker", TELEGRAM_BOT_TOKEN: "123:synthetic-telegram-secret-marker" },
			encoding: "utf8", timeout: 8000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /capture and scrub verified/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
