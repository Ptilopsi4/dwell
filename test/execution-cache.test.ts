import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const directory = await mkdtemp(join(tmpdir(), "dwell-execution-cache-"));
process.env.DWELL_DATA = join(directory, "data");
process.env.DWELL_STATE = join(directory, "state");
process.env.npm_config_cache = join(directory, "inherited-cache");
delete process.env.DWELL_MODELS_FILE;
const { openDwell, scrubSecretEnv, runtimeTelemetry } = await import("../src/harness.ts");
const { npmCacheEnv } = await import("../src/sandbox.ts");

test("the actual Harness shell keeps npm and npm-exec cache outside its artifact directory", { timeout: 20_000, skip: process.platform === "win32" }, async () => {
	const cwd = join(directory, "workspace"); await mkdir(cwd);
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "npm config get cache && npm exec --offline -- node --version", timeout: 10 }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Verified the native runtime without adding workspace artifacts.")),
	]);
	const models = createModels(); models.setProvider(faux.provider);
	const harness = await openDwell(models);
	try {
		await scrubSecretEnv();
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd, model: { provider: "faux", modelId: "faux-1" } } }, context);
		const result = await (await conversation.submit({ type: "input", content: "Check npm cache placement", entry: { kind: "chat.message", data: { sender: "cache-test", via: "panel" } } }, context)).wait(context);
		assert.equal(result.status, "done");
		const transcript = await conversation.commit(async (tx) => (await tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 100)).items, context);
		const tool = transcript.flatMap((entry) => entry.model ?? []).find((message) => message.role === "toolResult");
		assert.equal(tool?.role, "toolResult");
		if (tool?.role === "toolResult") {
			assert.equal(tool.isError, false);
			assert.match(tool.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""), new RegExp(npmCacheEnv().NPM_CONFIG_CACHE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
		assert.deepEqual(await readdir(cwd), []);
		assert.ok((await readFile(join(process.env.DWELL_STATE!, "approvals.json"), "utf8")).length > 0);
	} finally { await harness.close(context); await runtimeTelemetry(harness)?.close(); await rm(directory, { recursive: true, force: true }); }
});
