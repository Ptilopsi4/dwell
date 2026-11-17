import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, GenerationTask, Harness, hook, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { checkResumableModels } from "../src/harness.ts";

test("startup preserves a frozen request when its model is no longer configured", { timeout: 10_000 }, async () => {
	const context = BACKGROUND_CONTEXT;
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	const pause = defineExtension({ name: "pause-before-provider", hooks: [hook(GenerationTask, {
		beforeRequest: async (_request, _api, invocation) => {
			entered();
			await new Promise<void>((_resolve, reject) => {
				const signal = invocation.abortSignal!;
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				if (signal.aborted) reject(signal.reason);
			});
		},
	})] });
	const registry = createRegistry(); registry.install(pause);
	const models = createModels(); models.setProvider(fauxProvider().provider);
	const replacement = createModels(); replacement.setProvider(fauxProvider({ models: [{ id: "faux-new", contextWindow: 8192, maxTokens: 1024 }] }).provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
		await conversation.submit({ type: "input", content: "keep this request" }, context);
		await ready;
		const live = await harness.snapshot(LiveDoc, conversation.id, context);
		const before = await harness.getTask(live!.run!.taskId, context);
		await conversation.configure({ model: { provider: "faux", modelId: "faux-new" } }, context);
		await checkResumableModels(harness, models);
		await assert.rejects(checkResumableModels(harness, replacement), /faux\/faux-1.*完成或取消/);
		const after = await harness.getTask(live!.run!.taskId, context);
		assert.deepEqual(after?.state, before?.state);
		assert.notEqual(after?.state.status, "terminal");
	} finally { await harness.close(context); }
});
