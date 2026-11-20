import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, GenerationTask, ToolResultEntry, createRegistry, defineExtension, defineTool, Harness, hook, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import type { WorkLimits } from "../src/ext/work.ts";
import { makeBudgetController } from "../src/ext/budget.ts";

const privateState = await mkdtemp(join(tmpdir(), "dwell-work-state-"));
process.env.DWELL_STATE = privateState;
const { acceptWork, getWork, inheritWork, makeWorkController, WorkDoc, workIdentity, workReadyAnswer } = await import("../src/ext/work.ts");
const { BackgroundAnchor, BackgroundDoc, BACKGROUND_REPORTER_KIND, makeBackgroundDeliverer, makeBackgroundExtension } = await import("../src/ext/background.ts");
const { makeProcExtension, PROC_TASK_KIND } = await import("../src/ext/proc.ts");
after(() => rm(privateState, { recursive: true, force: true }));

const context = BACKGROUND_CONTEXT;
const done = () => fauxAssistantMessage(fauxText("done"));
const call = (name: string, args = {}) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const start = (goal = "Repair the example") => call("dwell.work", { action: "start", goal, acceptance: ["The observable check passes"] });
const actor = (sender = "owner", extra = {}) => ({ kind: "chat.message", data: { sender, via: "panel", ...extra } });

async function setup(options: { path?: string; limits?: Partial<WorkLimits>; pricingKnown?: boolean; responses?: FauxResponseStep[]; background?: boolean; beforeRequest?: (messages: readonly Message[]) => void; extra?: (harness: () => Harness) => Extension[] } = {}) {
	const dir = options.path === undefined ? await mkdtemp(join(tmpdir(), "dwell-work-")) : undefined;
	const path = options.path ?? join(dir!, "work.sqlite");
	const work = makeWorkController({ limits: options.limits, pricingKnown: options.pricingKnown });
	const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 128, cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 2 } }] });
	faux.setResponses(options.responses ?? [start(), done()]);
	const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry();
	if (options.beforeRequest !== undefined) registry.install(defineExtension({ name: "work-request-observer", hooks: [hook(GenerationTask, { beforeRequest: (request) => { options.beforeRequest!(request.messages); } })] }));
	registry.install(work.extension);
	registry.install(defineExtension({ name: "work-fixtures", tasks: options.background ? [] : [BackgroundAnchor], tools: [
		defineTool({ name: "probe", description: "Run an observable check", parameters: Type.Object({}), replay: "safe", async execute() { return { output: [{ type: "text", text: "check passed" }] }; } }),
		defineTool({ name: "failure", description: "Return a failed check", parameters: Type.Object({}), async execute() { return { output: [{ type: "text", text: "check failed" }], isError: true }; } }),
		defineTool({ name: "nested.ready", description: "Try a nested ready call", parameters: Type.Object({}), async execute(_args, api, ctx) { const result = await api.executeTool("dwell.work", { action: "ready", review: "Nested review" }, ctx); return { output: [{ type: "text", text: JSON.stringify(result) }] }; } }),
	] }));
	let harness!: Harness;
	for (const extension of options.extra?.(() => harness) ?? []) registry.install(extension);
	harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry, settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1, reserveTokens: 64 } } }, context);
	await work.attach(harness);
	return { harness, faux, path, dir, work,
		conversation: async () => { const c = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context); await harness.commit(async (tx) => { (await tx.doc(WorkDoc, c.id)).goalMode = true; }, context); return c; },
		close: async (keep = false) => { await work.close(); await harness.close(context); if (dir !== undefined && !keep) await rm(dir, { recursive: true, force: true }); },
	};
}

async function current(harness: Harness, conversationId: number) {
	const state = await getWork(harness, conversationId);
	assert.ok(state.current);
	return state.records[state.current]!;
}

async function entries(harness: Harness, conversationId: ConversationId) {
	return harness.commit(async (tx) => (await tx.scanEntries({ conversationId, order: "ascending" }, 1000)).items, context);
}

test("work mutations retain the original actor and only host acceptance can accept verified work", { timeout: 10_000 }, async () => {
	const s = await setup();
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "start", entry: actor() }, context)).wait(context);
		const original = await current(s.harness, conversation.id);
		assert.equal(original.creator, "owner");
		assert.equal(original.status, "active");
		assert.equal(original.usage.scope, "generation_and_tools");
		assert.equal(original.usage.cost, null, "unspecified model pricing must remain unknown");
		s.faux.setResponses([call("dwell.work", { action: "checkpoint", progress: "Hijacked" }), done()]);
		await (await conversation.submit({ type: "input", content: "change it", entry: actor("other") }, context)).wait(context);
		assert.equal((await current(s.harness, conversation.id)).progress, "");
		s.faux.setResponses([call("probe"), call("failure"), done()]);
		await (await conversation.submit({ type: "input", content: "check", entry: actor() }, context)).wait(context);
		const all = await entries(s.harness, conversation.id);
		const success = all.find((entry) => ToolResultEntry.is(entry) && entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "probe")!;
		const failed = all.find((entry) => ToolResultEntry.is(entry) && entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "failure")!;
		const assistant = all.find(AssistantEntry.is)!;
		for (const evidence of [[failed.id], [assistant.id], [999999]]) {
			s.faux.setResponses([call("dwell.work", { action: "ready", evidence, review: "Checked" }), done()]);
			await (await conversation.submit({ type: "input", content: "review", entry: actor() }, context)).wait(context);
			assert.equal((await current(s.harness, conversation.id)).status, "active");
		}
		await assert.rejects(acceptWork(s.harness, conversation.id, original.id, "operator"), /ready for review/);
		s.faux.setResponses([call("dwell.work", { action: "ready", evidence: [success.id], progress: "Fixed and checked", blockers: [], review: "The observable check passed" }), done()]);
		await (await conversation.submit({ type: "input", content: "review", entry: actor() }, context)).wait(context);
		assert.equal((await current(s.harness, conversation.id)).status, "ready_for_review");
		s.faux.setResponses([start("Unrelated goal"), done()]);
		await (await conversation.submit({ type: "input", content: "replace", entry: actor("other") }, context)).wait(context);
		assert.equal((await current(s.harness, conversation.id)).id, original.id);
		const accepted = await acceptWork(s.harness, conversation.id, original.id, "panel:admin");
		assert.equal(accepted.acceptedBy, "panel:admin");
		assert.equal(accepted.status, "accepted");
		s.faux.setResponses([call("dwell.work", { action: "checkpoint", progress: "Rewrite accepted result" }), done()]);
		await (await conversation.submit({ type: "input", content: "rewrite", entry: actor() }, context)).wait(context);
		assert.equal((await current(s.harness, conversation.id)).progress, "Fixed and checked");
	} finally { await s.close(); }
});

test("unattributed inputs cannot create a work owner", { timeout: 5000 }, async () => {
	const s = await setup();
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "start without actor" }, context)).wait(context);
		assert.equal((await getWork(s.harness, conversation.id)).current, undefined);
		assert.ok((await entries(s.harness, conversation.id)).some((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].isError));
	} finally { await s.close(); }
});

test("ready ends the run at its own correlated receipt without another provider request", { timeout: 5000 }, async () => {
	const s = await setup({ responses: [start(), call("probe"), done()] });
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "work", entry: actor() }, context)).wait(context);
		const before = await current(s.harness, conversation.id);
		const evidence = Object.keys(before.availableEvidence).map(Number);
		s.faux.setResponses([call("dwell.work", { action: "ready", evidence, review: "The probe completed successfully" }), async () => { throw new Error("ready must not request another model answer"); }]);
		const calls = s.faux.state.callCount;
		const settled = await (await conversation.submit({ type: "input", content: "review", entry: actor() }, context)).wait(context);
		assert.ok(settled.type === "input" && settled.status === "done");
		assert.equal(s.faux.state.callCount, calls + 1);
		const summary = "目标（工作声明）：Repair the example\n\n验证：未声明验证契约；已记录 1 条成功工具结果。\n\n评审说明（代理声明）：The probe completed successfully";
		assert.deepEqual(await workReadyAnswer(s.harness, conversation.id, settled.answer), { workId: before.id, verified: false, summary });
		assert.equal(await workReadyAnswer(s.harness, conversation.id + 1, settled.answer), undefined);
		const record = await current(s.harness, conversation.id);
		assert.equal(record.status, "ready_for_review");
		assert.equal(record.usage.modelAdmissions, before.usage.modelAdmissions + 1);
		const receipt = (await entries(s.harness, conversation.id)).find((entry) => ToolResultEntry.is(entry) && entry.model?.[0]?.role === "toolResult" && entry.model[0].details && typeof entry.model[0].details === "object" && "workReady" in entry.model[0].details);
		assert.deepEqual(receipt?.model?.[0]?.role === "toolResult" ? receipt.model[0].details : undefined, { workReady: true, workId: before.id, verified: false, summary });
		s.faux.setResponses([done()]);
		const later = await (await conversation.submit({ type: "input", content: "ordinary conversation", entry: actor() }, context)).wait(context);
		assert.ok(later.type === "input" && later.status === "done");
		assert.equal(await workReadyAnswer(s.harness, conversation.id, later.answer), undefined);
		assert.equal(s.work.extension.tools?.find((tool) => tool.name === "dwell.work")?.replay, "unsafe");
	} finally { await s.close(); }
});

test("mixed and nested ready calls fail before changing the review state", { timeout: 5000 }, async () => {
	const s = await setup({ responses: [start(), call("probe"), done()] });
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "work", entry: actor() }, context)).wait(context);
		const before = await current(s.harness, conversation.id);
		const evidence = Object.keys(before.availableEvidence).map(Number);
		const mixed = fauxAssistantMessage([fauxToolCall("dwell.work", { action: "ready", evidence, review: "Mixed review", progress: "Must not persist" }, { id: "mixed-ready" }), fauxToolCall("probe", {}, { id: "mixed-probe" })], { stopReason: "toolUse" });
		for (const response of [mixed, call("nested.ready")]) {
			s.faux.setResponses([response, done()]);
			const result = await (await conversation.submit({ type: "input", content: "invalid ready", entry: actor() }, context)).wait(context);
			assert.ok(result.type === "input" && result.status === "done");
			assert.equal(await workReadyAnswer(s.harness, conversation.id, result.answer), undefined);
			const record = await current(s.harness, conversation.id);
			assert.equal(record.status, "active");
			assert.equal(record.review, before.review);
			assert.equal(record.progress, before.progress);
		}
		const failures = (await entries(s.harness, conversation.id)).filter(ToolResultEntry.is).filter((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "dwell.work" && entry.model[0].isError);
		assert.ok(failures.some((entry) => JSON.stringify(entry.model).includes("alone")));
		assert.ok((await entries(s.harness, conversation.id)).some((entry) => JSON.stringify(entry.model).includes("directly")), "the nested call's rejection is retained in its caller result");
	} finally { await s.close(); }
});

test("ordinary chat does not create a work record", { timeout: 5000 }, async () => {
	const s = await setup({ responses: [done()] });
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "hello", entry: actor() }, context)).wait(context);
		assert.deepEqual(await getWork(s.harness, conversation.id), { records: {} });
	} finally { await s.close(); }
});

test("work snapshots refresh before the original user input and preserve the tool-result tail", { timeout: 5000 }, async () => {
	let originalRequest: readonly Message[] = [];
	const s = await setup({ responses: [done()], beforeRequest: (messages) => { originalRequest = messages; } });
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "Earlier user context", entry: actor() }, context)).wait(context);
		const observations: { messages: readonly Message[]; original: readonly Message[]; persisted: readonly Message[]; progress: string; tailTool: string; workId: string }[] = [];
		const inspect = (progress: string, tailTool: string, response: ReturnType<typeof done>): FauxResponseStep => async (request) => {
			observations.push({ messages: request.messages, original: originalRequest, persisted: (await conversation.context(context)).messages, progress, tailTool, workId: (await current(s.harness, conversation.id)).id });
			return response;
		};
		s.faux.setResponses([
			start(),
			inspect("", "dwell.work", call("dwell.work", { action: "checkpoint", progress: "Checkpoint visible on the next request" })),
			inspect("Checkpoint visible on the next request", "dwell.work", call("probe")),
			inspect("Checkpoint visible on the next request", "probe", done()),
		]);
		await (await conversation.submit({ type: "input", content: "Complete the original task", entry: actor() }, context)).wait(context);
		assert.equal(observations.length, 3);
		for (const { messages, original, persisted, progress, tailTool, workId } of observations) {
			const snapshots = messages.filter((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Durable work record;"));
			assert.equal(snapshots.length, 1);
			const snapshot = snapshots[0]!;
			assert.ok(snapshot.role === "user" && typeof snapshot.content === "string");
			const unchanged = messages.filter((message) => message !== snapshot);
			assert.deepEqual(unchanged, original, "all original messages retain their order and contents");
			assert.deepEqual(original, persisted, "the snapshot is request-only");
			for (let i = 0; i < original.length; i++) assert.equal(unchanged[i], original[i], "original message objects are preserved");
			assert.deepEqual(original.filter((message) => message.role === "user").map((message) => message.content), ["Earlier user context", "Complete the original task"]);
			const snapshotIndex = messages.indexOf(snapshot);
			assert.equal(snapshotIndex, original.findLastIndex((message) => message.role === "user"));
			assert.equal(messages[snapshotIndex + 1]!.content, "Complete the original task");
			const tail = messages.at(-1)!;
			assert.equal(tail, original.at(-1));
			assert.ok(tail.role === "toolResult");
			assert.equal(tail.toolName, tailTool);
			const record = JSON.parse(snapshot.content.slice(snapshot.content.indexOf("{")));
			assert.equal(record.progress, progress);
			assert.equal(record.id, workId);
		}
	} finally { await s.close(); }
});

test("durable work survives reopen, reset and compaction while accounting remains deduplicated", { timeout: 10_000 }, async () => {
	const s = await setup({ pricingKnown: true, responses: [start(), call("probe"), call("dwell.work", { action: "checkpoint", progress: "First check completed", blockers: ["Waiting for the answer"] }), done()] });
	let reopened: Awaited<ReturnType<typeof setup>> | undefined;
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "work", entry: actor() }, context)).wait(context);
		const before = await current(s.harness, conversation.id);
		assert.ok(before.usage.modelResponses > 0);
		assert.ok(before.usage.inputTokens > 0);
		assert.equal(before.usage.cost, 0, "the faux provider explicitly reports zero cost");
		assert.deepEqual((await current(s.harness, conversation.id)).usage, before.usage);
		await s.close(true);
		let observed = "";
		let expectedInput = "continue";
		const inspectedInputs: string[] = [];
		const observe: FauxResponseStep = async (request) => {
			observed = JSON.stringify(request.messages);
			const tail = request.messages.at(-1)!;
			assert.ok(tail.role === "user");
			assert.equal(tail.content, expectedInput);
			const snapshot = request.messages.at(-2)!;
			assert.ok(snapshot.role === "user" && typeof snapshot.content === "string" && snapshot.content.startsWith("[Durable work record;"));
			assert.equal(JSON.parse(snapshot.content.slice(snapshot.content.indexOf("{"))).progress, "First check completed");
			inspectedInputs.push(expectedInput);
			return done();
		};
		reopened = await setup({ path: s.path, responses: [observe] });
		assert.deepEqual((await current(reopened.harness, conversation.id)).usage, before.usage);
		const resumed = (await reopened.harness.conversation(conversation.id, context))!;
		await resumed.reset(undefined, context);
		await (await resumed.submit({ type: "input", content: "continue", entry: actor() }, context)).wait(context);
		assert.deepEqual(inspectedInputs, ["continue"]);
		assert.match(observed, /First check completed/);
		assert.match(observed, /Waiting for the answer/);
		assert.match(observed, /The observable check passes/);
		assert.match(observed, /Durable work record/);
		for (let i = 0; i < 4; i++) await resumed.submit({ type: "write", entry: { kind: "fixture.context", model: [{ role: "user", content: "old detail ".repeat(100), timestamp: Date.now() }] } }, context);
		reopened.faux.setResponses([fauxAssistantMessage("Summary deliberately omits the work goal"), observe]);
		const compact = await resumed.compact("Keep this short", context);
		const result = await reopened.harness.waitForTask(compact, context);
		assert.equal(result.state.outcome.status, "completed");
		expectedInput = "continue after compaction";
		await (await resumed.submit({ type: "input", content: "continue after compaction", entry: actor() }, context)).wait(context);
		assert.deepEqual(inspectedInputs, ["continue", "continue after compaction"]);
		assert.match(observed, /First check completed/);
		assert.match(observed, /The observable check passes/);
		const after = await current(reopened.harness, conversation.id);
		assert.equal(after.usage.modelResponses, before.usage.modelResponses + 2, "summary requests are outside generation accounting");
		assert.deepEqual((await current(reopened.harness, conversation.id)).usage, after.usage);
		assert.equal(after.usage.pricingKnown, true, "reopen does not reinterpret the work's original pricing contract");
	} finally { if (reopened !== undefined) await reopened.close(); else await s.close(); await rm(s.dir!, { recursive: true, force: true }); }
});

async function childOf(s: Awaited<ReturnType<typeof setup>>, parent: ConversationId) {
	const childId = await s.harness.commit(async (tx) => {
		const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true, conversationId: parent });
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
		await inheritWork(tx, parent, child.id);
		return child.id;
	}, context);
	return (await s.harness.conversation(childId, context))!;
}

test("root and child share a persisted model allowance and stop before the next provider call", { timeout: 5000 }, async () => {
	const s = await setup({ limits: { modelAdmissions: 2 } });
	try {
		const parent = await s.conversation();
		await (await parent.submit({ type: "input", content: "start", entry: actor() }, context)).wait(context);
		const inherited = await current(s.harness, parent.id);
		const child = await childOf(s, parent.id);
		let inspected = false;
		s.faux.setResponses([async (request) => {
			const snapshot = request.messages.find((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Durable work record;"));
			assert.ok(snapshot?.role === "user" && typeof snapshot.content === "string");
			const record = JSON.parse(snapshot.content.slice(snapshot.content.indexOf("{")));
			assert.equal(record.id, inherited.id);
			assert.equal(record.goal, inherited.goal);
			assert.equal(request.messages.at(-1)!.content, "child check");
			inspected = true;
			return done();
		}, done()]);
		await (await child.submit({ type: "input", content: "child check", entry: actor() }, context)).wait(context);
		assert.equal(inspected, true);
		const calls = s.faux.state.callCount;
		const result = await (await parent.submit({ type: "input", content: "one more", entry: actor() }, context)).wait(context);
		assert.equal(result.status, "unanswered");
		assert.equal(s.faux.state.callCount, calls);
		const record = await current(s.harness, parent.id);
		assert.equal(record.usage.modelAdmissions, 2);
		assert.equal(record.usage.modelResponses, 2);
		assert.equal(record.stopped, "model_limit");
	} finally { await s.close(); }
});

test("parallel child tools cannot exceed the root tool allowance", { timeout: 5000 }, async () => {
	const s = await setup({ limits: { toolAdmissions: 2 } });
	try {
		const parent = await s.conversation();
		await (await parent.submit({ type: "input", content: "start", entry: actor() }, context)).wait(context);
		const child = await childOf(s, parent.id);
		s.faux.setResponses([fauxAssistantMessage(Array.from({ length: 5 }, (_, i) => fauxToolCall("probe", {}, { id: `probe-${i}` })), { stopReason: "toolUse" }), done()]);
		await (await child.submit({ type: "input", content: "many checks", entry: actor() }, context)).wait(context);
		const record = await current(s.harness, parent.id);
		assert.equal(record.usage.toolAdmissions, 2);
		assert.equal(record.stopped, "tool_limit");
		assert.ok(record.usage.toolResults <= 2);
		const calls = s.faux.state.callCount;
		await (await parent.submit({ type: "input", content: "continue", entry: actor() }, context)).wait(context);
		assert.equal(s.faux.state.callCount, calls);
	} finally { await s.close(); }
});

test("work limits persist on reopen and cannot be enlarged by a new controller", { timeout: 5000 }, async () => {
	const s = await setup({ limits: { modelAdmissions: 1 } });
	let reopened: Awaited<ReturnType<typeof setup>> | undefined;
	try {
		const parent = await s.conversation();
		await (await parent.submit({ type: "input", content: "start", entry: actor() }, context)).wait(context);
		const old = await current(s.harness, parent.id);
		await s.close(true);
		reopened = await setup({ path: s.path, limits: { modelAdmissions: 4096 }, responses: [done()] });
		const conversation = (await reopened.harness.conversation(parent.id, context))!;
		const result = await (await conversation.submit({ type: "input", content: "another request", entry: actor() }, context)).wait(context);
		assert.equal(result.status, "unanswered");
		assert.equal(reopened.faux.state.callCount, 0);
		const after = await current(reopened.harness, parent.id);
		assert.equal(after.limits.modelAdmissions, 1);
		assert.equal(after.usage.modelAdmissions, old.usage.modelAdmissions);
		assert.equal(after.stopped, "model_limit");
	} finally { if (reopened !== undefined) await reopened.close(); else await s.close(); await rm(s.dir!, { recursive: true, force: true }); }
});

test("work attribution or storage failure aborts before a provider request", { timeout: 5000 }, async (t) => {
	const s = await setup();
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "start", entry: actor() }, context)).wait(context);
		const calls = s.faux.state.callCount;
		t.mock.method(s.harness, "commit", async () => { throw new Error("simulated work storage failure"); });
		t.mock.method(console, "error", () => {});
		const result = await (await conversation.submit({ type: "input", content: "continue", entry: actor() }, context)).wait(context);
		assert.equal(result.status, "unanswered");
		assert.equal(s.faux.state.callCount, calls);
		t.mock.restoreAll();
		assert.ok((await s.harness.snapshot(WorkDoc, conversation.id, context))?.current);
	} finally { t.mock.restoreAll(); await s.close(); }
});

test("background approval delivery freezes the approved run's work while a newer child run is active", { timeout: 5000 }, async () => {
	const s = await setup({ background: true, extra: (getHarness) => [makeBackgroundExtension({ getHarness, senderOf: () => "owner", forbidden: () => [], attribute: async () => {}, onStarted: () => {}, onFired: () => {} })] });
	let release!: () => void;
	try {
		const parent = await s.conversation();
		await (await parent.submit({ type: "input", content: "start", entry: actor() }, context)).wait(context);
		const work = await current(s.harness, parent.id);
		const child = await childOf(s, parent.id);
		s.faux.setResponses([done()]);
		const original = await child.submit({ type: "input", content: "original", entry: actor() }, context);
		await original.wait(context);
		await parent.commit(async (tx) => { (await tx.doc(BackgroundDoc, parent.id)).agents.worker = { conversationId: child.id }; }, context);
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		s.faux.setResponses([async (_request, options) => { entered(); await Promise.race([gate, new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }))]); return done(); }]);
		const newer = await child.submit({ type: "input", content: "unrelated input", entry: actor("owner", { work: null }) }, context);
		const waiting = newer.wait(context);
		await started;
		const deps = { senderOf: () => "owner", forbidden: () => [], attribute: async () => {}, onStarted: () => {}, onFired: () => {} };
		assert.equal(await makeBackgroundDeliverer(deps, () => s.harness).deliver(parent.id, child.id, "continue", { deliveryId: "approved-old-input", sender: "owner", budgetId: `${child.id}:${original.id}` }), true);
		const reporters = await s.harness.commit(async (tx) => JSON.parse(JSON.stringify((await tx.scanTasks({ kind: BACKGROUND_REPORTER_KIND }, 100)).items)), context);
		assert.deepEqual(reporters[0].input.work, { conversationId: parent.id, id: work.id });
		release(); await waiting;
	} finally { release?.(); await s.close(); }
});

test("child creation freezes the old work and explicit absence before the parent starts another goal", { timeout: 10_000 }, async () => {
	const s = await setup({ responses: [start(), call("probe"), done()] });
	try {
		const parent = await s.conversation();
		const unbound = await childOf(s, parent.id);
		await (await parent.submit({ type: "input", content: "start old goal", entry: actor() }, context)).wait(context);
		const old = await current(s.harness, parent.id);
		const child = await childOf(s, parent.id);
		const evidence = Number(Object.keys(old.availableEvidence)[0]);
		s.faux.setResponses([call("dwell.work", { action: "ready", evidence: [evidence], review: "Verified old goal" }), done()]);
		await (await parent.submit({ type: "input", content: "review", entry: actor() }, context)).wait(context);
		s.faux.setResponses([start("A new goal"), done()]);
		await (await parent.submit({ type: "input", content: "start new goal", entry: actor() }, context)).wait(context);
		const newer = await current(s.harness, parent.id);
		assert.notEqual(newer.id, old.id);
		s.faux.setResponses([call("probe"), done()]);
		await (await child.submit({ type: "input", content: "late old check", entry: actor() }, context)).wait(context);
		const state = await getWork(s.harness, parent.id);
		assert.ok(state.records[old.id]!.usage.toolResults > old.usage.toolResults);
		assert.equal(state.records[newer.id]!.usage.toolResults, 0);
		assert.deepEqual((await getWork(s.harness, child.id)).inherited, { conversationId: parent.id, id: old.id });
		assert.equal((await getWork(s.harness, unbound.id)).inherited, null);
		s.faux.setResponses([start("Illicit child goal"), done()]);
		await (await unbound.submit({ type: "input", content: "try create", entry: actor() }, context)).wait(context);
		assert.equal((await getWork(s.harness, unbound.id)).current, undefined);
	} finally { await s.close(); }
});

test("approval continuation resolves its original work even after a newer goal and rejects unknown attribution", { timeout: 10_000 }, async () => {
	const s = await setup({ responses: [start(), call("probe"), done()] });
	try {
		const parent = await s.conversation();
		const original = await parent.submit({ type: "input", content: "start", entry: actor() }, context);
		await original.wait(context);
		const old = await current(s.harness, parent.id);
		s.faux.setResponses([call("dwell.work", { action: "ready", evidence: [Number(Object.keys(old.availableEvidence)[0])], review: "Verified" }), done()]);
		await (await parent.submit({ type: "input", content: "review", entry: actor() }, context)).wait(context);
		s.faux.setResponses([start("New goal"), done()]);
		await (await parent.submit({ type: "input", content: "new", entry: actor() }, context)).wait(context);
		const newer = await current(s.harness, parent.id);
		s.faux.setResponses([call("dwell.work", { action: "checkpoint", progress: "Approved old continuation" }), done()]);
		await (await parent.submit({ type: "input", content: "approved", entry: { kind: "dwell.approval", data: { sender: "owner", budgetId: `${parent.id}:${original.id}` } } }, context)).wait(context);
		const state = await getWork(s.harness, parent.id);
		assert.equal(state.records[old.id]!.progress, "Approved old continuation");
		assert.equal(state.records[newer.id]!.progress, "");
		assert.deepEqual(await s.harness.commit((tx) => workIdentity(tx, parent.id, `${parent.id}:${original.id}`), context), { conversationId: parent.id, id: old.id });
		const calls = s.faux.state.callCount;
		const failed = await (await parent.submit({ type: "input", content: "bad approval", entry: { kind: "dwell.approval", data: { sender: "owner", budgetId: `999:${original.id}` } } }, context)).wait(context);
		assert.equal(failed.status, "unanswered");
		assert.equal(s.faux.state.callCount, calls);
	} finally { await s.close(); }
});

test("waiting approvals retain their original work or explicit absence after ordinary history rolls over", { timeout: 15_000 }, async (t) => {
	for (const tracked of [true, false]) await t.test(tracked ? "original work" : "original absence", async () => {
		const budget = makeBudgetController();
		const s = await setup({ responses: tracked ? [start(), done()] : [done()], extra: () => [budget.extension] });
		await budget.attach(s.harness);
		try {
			const parent = await s.conversation();
			const original = await parent.submit({ type: "input", content: "original", entry: actor() }, context);
			await original.wait(context);
			const pinned = await budget.captureApproval(parent.id);
			assert.equal(pinned, `${parent.id}:${original.id}`);
			const identity = await s.harness.commit((tx) => workIdentity(tx, parent.id, pinned), context);
			if (!tracked) {
				s.faux.setResponses([start("Later unrelated goal"), done()]);
				await (await parent.submit({ type: "input", content: "later goal", entry: actor() }, context)).wait(context);
			}
			s.faux.setResponses(Array.from({ length: 65 }, done));
			for (let i = 0; i < 65; i++) await (await parent.submit({ type: "input", content: `ordinary ${i}`, entry: actor() }, context)).wait(context);
			const before = await current(s.harness, parent.id);
			assert.equal(Object.hasOwn((await s.harness.snapshot(WorkDoc, parent.id, context))!.runs, String(original.id)), true);
			assert.deepEqual(await s.harness.commit((tx) => workIdentity(tx, parent.id, pinned), context), identity);
			s.faux.setResponses([done()]);
			const calls = s.faux.state.callCount;
			const result = await (await parent.submit({ type: "input", content: "approved", entry: { kind: "dwell.approval", data: { sender: "owner", via: "panel", budgetId: pinned } } }, context)).wait(context);
			assert.equal(result.status, "done");
			assert.equal(s.faux.state.callCount, calls + 1);
			assert.equal((await current(s.harness, parent.id)).usage.modelAdmissions, before.usage.modelAdmissions + (tracked ? 1 : 0));
		} finally { await budget.close(); await s.close(); }
	});
});

test("the real background Reporter preserves the child's work on both delivery and a late parent report", { timeout: 10_000 }, async () => {
	let fired!: () => void;
	const reported = new Promise<void>((resolve) => { fired = resolve; });
	const s = await setup({ background: true, responses: [start(), call("probe"), done()], extra: (getHarness) => [makeBackgroundExtension({ getHarness, senderOf: () => "owner", viaOf: () => "panel", forbidden: () => [], onStarted: () => {}, attribute: async () => {}, onFired: () => { fired(); } })] });
	try {
		const parent = await s.conversation();
		await (await parent.submit({ type: "input", content: "start", entry: actor() }, context)).wait(context);
		const old = await current(s.harness, parent.id);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let entered!: () => void;
		const running = new Promise<void>((resolve) => { entered = resolve; });
		const respond: FauxResponseStep = async (request, options) => {
			if (JSON.stringify(request.messages).includes("Your workspace mode is read.")) {
				entered();
				await Promise.race([gate, new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }))]);
			}
			return done();
		};
		s.harness.resume();
		s.faux.setResponses([call("dwell.task", { action: "start", name: "check", message: "Read the existing example" }), respond, respond]);
		await (await parent.submit({ type: "input", content: "spawn", entry: actor() }, context)).wait(context);
		await running;
		s.faux.setResponses([call("dwell.work", { action: "ready", evidence: [Number(Object.keys(old.availableEvidence)[0])], review: "Verified" }), start("New goal"), done(), done()]);
		await (await parent.submit({ type: "input", content: "review", entry: actor() }, context)).wait(context);
		await (await parent.submit({ type: "input", content: "new goal", entry: actor() }, context)).wait(context);
		const newer = await current(s.harness, parent.id);
		release();
		await reported;
		await parent.waitForIdle(context);
		const report = (await entries(s.harness, parent.id)).find((entry) => entry.kind === "chat.message" && typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data) && entry.data.via === "background");
		assert.deepEqual((report!.data as { work: unknown }).work, { conversationId: parent.id, id: old.id });
		assert.equal((await current(s.harness, parent.id)).id, newer.id);
		assert.ok((await getWork(s.harness, parent.id)).records[old.id]!.usage.modelAdmissions > old.usage.modelAdmissions);
	} finally { await s.close(); }
});

test("managed process admission and its delayed failure report retain their creation-time work", { timeout: 5000 }, async () => {
	let fired!: () => void;
	const reported = new Promise<void>((resolve) => { fired = resolve; });
	const s = await setup({ responses: [start(), call("probe"), done()], extra: (getHarness) => [makeProcExtension({ getHarness, senderOf: () => "owner", viaOf: () => "panel", shell: () => ({ path: "", sandboxed: false }), attribute: async () => {}, onFired: () => { fired(); } })] });
	try {
		const parent = await s.conversation();
		await (await parent.submit({ type: "input", content: "start", entry: actor() }, context)).wait(context);
		const old = await current(s.harness, parent.id);
		s.faux.setResponses([call("dwell.proc", { action: "start", name: "check", command: "unused" }), done()]);
		await (await parent.submit({ type: "input", content: "start process", entry: actor() }, context)).wait(context);
		const tasks = await s.harness.commit(async (tx) => JSON.parse(JSON.stringify((await tx.scanTasks({ kind: PROC_TASK_KIND }, 100)).items)), context);
		assert.deepEqual(tasks[0].input.work, { conversationId: parent.id, id: old.id });
		s.faux.setResponses([call("dwell.work", { action: "ready", evidence: [Number(Object.keys(old.availableEvidence)[0])], review: "Verified" }), start("New goal"), done(), done()]);
		await (await parent.submit({ type: "input", content: "review", entry: actor() }, context)).wait(context);
		await (await parent.submit({ type: "input", content: "new goal", entry: actor() }, context)).wait(context);
		const newer = await current(s.harness, parent.id);
		s.harness.resume();
		await reported;
		await parent.waitForIdle(context);
		const report = (await entries(s.harness, parent.id)).find((entry) => entry.kind === "chat.message" && typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data) && entry.data.via === "proc");
		assert.deepEqual((report!.data as { work: unknown }).work, { conversationId: parent.id, id: old.id });
		assert.equal((await current(s.harness, parent.id)).id, newer.id);
		assert.equal((await s.harness.waitForTask(tasks[0].id, context)).state.outcome.status, "completed");
	} finally { await s.close(); }
});
