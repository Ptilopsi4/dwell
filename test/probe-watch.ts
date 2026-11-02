// dump watch value 的真实结构（entries / pi.live），验证工具概述的字段假设
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const faux = fauxProvider();
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" }, { id: "call-1" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("done.")]),
]);
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(CodingTools);
registry.install(defineExtension({ name: "t", sections: [section("preamble", () => "x", { tag: false })] }));

const harness = await Harness.open(await openNodeSqliteStorage("./data/probe.sqlite"), {
	models,
	registry,
	env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
}, BACKGROUND_CONTEXT);
const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, BACKGROUND_CONTEXT);

const sub = await conv.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
const watch = await conv.watch(BACKGROUND_CONTEXT);
let n = 0;
await watch.start(async (value) => {
	n++;
	const entries = (value as unknown as { entries?: unknown[] }).entries ?? [];
	const live = (value as { docs?: Record<string, unknown> }).docs?.["pi.live"];
	if (n <= 40) {
		console.log(`--- frame ${n}: entries=${entries.length}`);
		for (const e of entries.slice(-2)) {
			console.log("ENTRY:", JSON.stringify(e).slice(0, 220));
		}
		console.log("LIVE:", JSON.stringify(live).slice(0, 260));
	}
});
await sub.wait(BACKGROUND_CONTEXT);
await watch.stop();
await harness.close(BACKGROUND_CONTEXT);
console.log("frames:", n);
