import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { RuntimeTelemetry } from "../src/telemetry.ts";

async function fixture(t: import("node:test").TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "dwell-telemetry-"));
	const file = join(directory, "runtime-telemetry.json");
	const telemetry = new RuntimeTelemetry(file);
	t.after(async () => { await telemetry.close(); await rm(directory, { recursive: true, force: true }); });
	await telemetry.start();
	return { telemetry, file };
}

test("telemetry keeps SDK metadata while excluding content, errors and arbitrary names", async (t) => {
	const { telemetry, file } = await fixture(t);
	const ctx = telemetry.context;
	await ctx.startSpan({ name: "pi.durable.submit", attributes: { "conversation.id": 7, "submission.type": "input", prompt: "PRIVATE_PROMPT" } }, async (span) => {
		span.addEvent("pi.durable.entry", { "entry.id": 9, "entry.kind": "chat.message", content: "PRIVATE_CONTENT" });
		span.addEvent("pi.durable.PRIVATE_EVENT", { phase: "PRIVATE_PHASE" });
		span.setAttributes({ result: "placed", "submission.id": 4, arguments: "PRIVATE_ARGUMENTS" });
		span.setStatus({ status: "error", error: { name: "Error", message: "PRIVATE_ERROR" } });
		const carrier = span.propagation!.inject(span);
		await ctx.propagation!.extract(carrier).startSpan({ name: "pi.durable.phase", attributes: { "task.id": 3, phase: "run", resumed: true, "tool.name": "https://secret.invalid/token" } }, () => {});
	});
	await ctx.startSpan({ name: "pi.durable.PRIVATE_NAME" }, () => {});
	ctx.metrics!.counter("pi.durable.PRIVATE_METRIC").add(1);
	ctx.metrics!.counter("pi.durable.reports").add(2, { type: "task_error", prompt: "PRIVATE_METRIC_CONTENT" });
	await telemetry.flush();
	const snapshot = telemetry.snapshot();
	assert.equal(snapshot.traces.length, 2);
	assert.equal(snapshot.traces[0].parentId, snapshot.traces[1].id);
	assert.equal(snapshot.traces[0].traceId, snapshot.traces[1].traceId);
	assert.equal(snapshot.traces[1].failed, true);
	assert.equal(snapshot.traces[1].attributes.result, "placed");
	assert.equal(snapshot.traces[1].events.length, 1);
	assert.deepEqual(snapshot.metrics[0].attributes, { type: "task_error" });
	assert.doesNotMatch(await readFile(file, "utf8"), /PRIVATE_|secret.invalid/);
	if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("telemetry bounds retention, persists totals, resets live gauges and sanitizes restored data", async (t) => {
	const { telemetry, file } = await fixture(t);
	for (let i = 0; i < 300; i++) {
		await telemetry.context.startSpan({ name: "pi.durable.phase", attributes: { "task.id": i } }, (span) => {
			for (let j = 0; j < 40; j++) span.addEvent("pi.durable.checkpoint", { phase: "run" });
		});
		telemetry.context.metrics!.histogram("pi.durable.phase.duration").record(i, { task: `task-${i}`, phase: "run", outcome: "done" });
	}
	assert.equal(telemetry.snapshot().traces.length, 200);
	assert.equal(telemetry.snapshot().traces[0].attributes["task.id"], 100);
	assert.equal(telemetry.snapshot().traces[0].events.length, 32);
	assert.equal(telemetry.snapshot().metrics.length, 256);
	const saved = telemetry.snapshot();
	saved.metrics[0].attributes.prompt = "RESTORED_SECRET";
	saved.traces[0].attributes.prompt = "RESTORED_SECRET";
	saved.traces[0].events[0].attributes.content = "RESTORED_SECRET";
	saved.metrics[1] = { name: "pi.durable.tasks.active", kind: "gauge", attributes: { task: "pi.generation" }, count: 1, sum: 4, min: 4, max: 4 };
	await telemetry.close();
	await writeFile(file, JSON.stringify(saved));
	const restored = new RuntimeTelemetry(file);
	try {
		await restored.start();
		const snapshot = restored.snapshot();
		assert.equal(snapshot.metrics[0].sum, saved.metrics[0].sum);
		assert.equal(snapshot.metrics.some((metric) => metric.kind === "gauge"), false);
		assert.doesNotMatch(JSON.stringify(snapshot), /RESTORED_SECRET/);
		const copy = restored.snapshot(); copy.traces.length = 0;
		assert.equal(restored.snapshot().traces.length, 200);
	} finally { await restored.close(); }
});

test("real Harness faux execution emits persisted phase, submission, entry and metric records without content", { timeout: 10_000 }, async (t) => {
	const { telemetry, file } = await fixture(t);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("PRIVATE_MODEL_REPLY")])]);
	const models = createModels(); models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), telemetry: telemetry.context }, BACKGROUND_CONTEXT);
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, BACKGROUND_CONTEXT);
		const submission = await conversation.submit({ type: "input", content: "PRIVATE_USER_INPUT" }, BACKGROUND_CONTEXT);
		assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
	} finally { await harness.close(BACKGROUND_CONTEXT); }
	await telemetry.close();
	const snapshot = telemetry.snapshot();
	assert.ok(snapshot.traces.some((span) => span.name === "pi.durable.submit"));
	assert.ok(snapshot.traces.some((span) => span.name === "pi.durable.phase"));
	assert.ok(snapshot.traces.some((span) => span.events.some((event) => event.name === "pi.durable.entry")));
	assert.ok(snapshot.metrics.some((metric) => metric.name === "pi.durable.phase.duration" && metric.count > 0));
	assert.doesNotMatch(await readFile(file, "utf8"), /PRIVATE_/);
});

test("concurrent flushes and repeated close preserve the last admitted snapshot", async (t) => {
	const { telemetry, file } = await fixture(t);
	const metric = telemetry.context.metrics!.counter("pi.durable.reports");
	metric.add(1, { type: "task_error" });
	const first = telemetry.flush();
	assert.equal(telemetry.flush(), first);
	metric.add(2, { type: "task_error" });
	const closing = telemetry.close();
	assert.equal(telemetry.close(), closing);
	await closing;
	const saved = JSON.parse(await readFile(file, "utf8"));
	assert.equal(saved.metrics[0].sum, 3);
	metric.add(10, { type: "task_error" });
	assert.equal(telemetry.snapshot().metrics[0].sum, 3);
	await telemetry.flush();
	assert.equal(JSON.parse(await readFile(file, "utf8")).metrics[0].sum, 3);
});

test("restore rejects malformed statistics and unsupported schema names", async (t) => {
	const { telemetry, file } = await fixture(t);
	telemetry.context.metrics!.counter("pi.durable.reports").add(1, { type: "task_error" });
	await telemetry.context.startSpan({ name: "pi.durable.phase" }, () => {});
	const saved = telemetry.snapshot();
	saved.metrics[0].count = -1;
	saved.traces[0].durationMs = -1;
	saved.metrics.push({ ...saved.metrics[0], name: "__proto__", count: 1 });
	saved.traces.push({ ...saved.traces[0], name: "__proto__", durationMs: 1 });
	await telemetry.close();
	await writeFile(file, JSON.stringify(saved));
	const restored = new RuntimeTelemetry(file);
	try {
		await restored.start();
		assert.deepEqual(restored.snapshot().metrics, []);
		assert.deepEqual(restored.snapshot().traces, []);
	} finally { await restored.close(); }
});
