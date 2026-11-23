import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { GenerationTask, ToolResultEntry, configure, createRegistry, defineExtension, defineTool, Harness, hook, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import type { WorkLimits } from "../src/ext/work.ts";
import { makeBudgetController } from "../src/ext/budget.ts";

const privateState = await mkdtemp(join(tmpdir(), "dwell-work-state-"));
process.env.DWELL_STATE = privateState;
const { createWorkRecord, getWork, inheritWork, makeWorkController, WorkDoc, workIdentity } = await import("../src/ext/work.ts");
const { BackgroundAnchor, BackgroundDoc, BACKGROUND_REPORTER_KIND, makeBackgroundDeliverer, makeBackgroundExtension } = await import("../src/ext/background.ts");
const { makeProcExtension, PROC_TASK_KIND } = await import("../src/ext/proc.ts");
const { beginNewGoal } = await import("../src/new-goal.ts");
after(() => rm(privateState, { recursive: true, force: true }));

const context = BACKGROUND_CONTEXT;
const done = () => fauxAssistantMessage(fauxText("done"));
const call = (name: string, args = {}) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
// 一发即忘：dwell.work 只有 checkpoint 形态 { progress?, blockers? }
const checkpoint = (progress?: string, blockers?: string[]) => call("dwell.work", { ...(progress === undefined ? {} : { progress }), ...(blockers === undefined ? {} : { blockers }) });
const actor = (sender = "owner", extra = {}) => ({ kind: "chat.message", data: { sender, via: "panel", ...extra } });

async function setup(options: { path?: string; limits?: Partial<WorkLimits>; pricingKnown?: boolean; responses?: FauxResponseStep[]; background?: boolean; beforeRequest?: (messages: readonly Message[]) => void; extra?: (harness: () => Harness) => Extension[] } = {}) {
	const dir = options.path === undefined ? await mkdtemp(join(tmpdir(), "dwell-work-")) : undefined;
	const path = options.path ?? join(dir!, "work.sqlite");
	const work = makeWorkController({ limits: options.limits, pricingKnown: options.pricingKnown });
	const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 128, cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 2 } }] });
	faux.setResponses(options.responses ?? [done()]);
	const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry();
	if (options.beforeRequest !== undefined) registry.install(defineExtension({ name: "work-request-observer", hooks: [hook(GenerationTask, { beforeRequest: (request) => { options.beforeRequest!(request.messages); } })] }));
	registry.install(work.extension);
	registry.install(defineExtension({ name: "work-fixtures", tasks: options.background ? [] : [BackgroundAnchor], tools: [
		defineTool({ name: "probe", description: "Run an observable check", parameters: Type.Object({}), replay: "safe", async execute() { return { output: [{ type: "text", text: "check passed" }] }; } }),
	] }));
	let harness!: Harness;
	for (const extension of options.extra?.(() => harness) ?? []) registry.install(extension);
	harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry, settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1, reserveTokens: 64 } } }, context);
	await work.attach(harness);
	return { harness, faux, path, dir, work,
		// goal 为 null 时不播种记录；否则 host 直建记录（一发即忘），并恢复默认工具面
		conversation: async (goal: string | null = "Repair the example so the observable check passes") => {
			const c = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
			if (goal !== null) await harness.commit(async (tx) => { await createWorkRecord(tx, c.id as ConversationId, goal, "owner"); await configure(tx, c.id as ConversationId, { tools: null }); }, context);
			return c;
		},
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

test("createWorkRecord seeds the host record that checkpoints bind to", { timeout: 10_000 }, async () => {
	const s = await setup({ limits: { modelAdmissions: 3 }, pricingKnown: true });
	try {
		const conversation = await s.conversation(null);
		const goalId = await s.harness.commit(async (tx) => createWorkRecord(tx, conversation.id as ConversationId, "  Trim the goal text  ", "owner"), context);
		const state = await getWork(s.harness, conversation.id);
		assert.equal(state.current, goalId);
		const record = state.records[goalId]!;
		assert.equal(record.goal, "Trim the goal text");
		assert.equal(record.creator, "owner");
		assert.equal(record.status, "active");
		assert.equal(record.progress, "");
		assert.deepEqual(record.blockers, []);
		assert.equal(record.limits.modelAdmissions, 3, "record limits follow the controller contract");
		assert.equal(record.usage.pricingKnown, true);
		assert.equal(record.usage.cost, 0);
		assert.deepEqual(record.members, { [String(conversation.id)]: 0 });
		await assert.rejects(s.harness.commit(async (tx) => createWorkRecord(tx, conversation.id as ConversationId, "   ", "owner"), context), /缺少目标描述/);
		await assert.rejects(s.harness.commit(async (tx) => createWorkRecord(tx, conversation.id as ConversationId, "goal text", "  "), context), /缺少可信用户身份/);
		s.faux.setResponses([checkpoint("Seeded and bound"), done()]);
		await (await conversation.submit({ type: "input", content: "checkpoint", entry: actor() }, context)).wait(context);
		assert.equal((await current(s.harness, conversation.id)).progress, "Seeded and bound");
	} finally { await s.close(); }
});

test("work checkpoints retain the original creator and only the creator may update the record", { timeout: 10_000 }, async () => {
	const s = await setup();
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "begin", entry: actor() }, context)).wait(context);
		const original = await current(s.harness, conversation.id);
		assert.equal(original.creator, "owner");
		assert.equal(original.status, "active");
		assert.equal(original.usage.scope, "generation_and_tools");
		assert.equal(original.usage.cost, null, "unspecified model pricing must remain unknown");
		s.faux.setResponses([checkpoint("First step recorded"), done()]);
		await (await conversation.submit({ type: "input", content: "progress", entry: actor() }, context)).wait(context);
		assert.equal((await current(s.harness, conversation.id)).progress, "First step recorded");
		s.faux.setResponses([checkpoint("Hijacked"), done()]);
		await (await conversation.submit({ type: "input", content: "change it", entry: actor("other") }, context)).wait(context);
		assert.equal((await current(s.harness, conversation.id)).progress, "First step recorded");
		assert.ok((await entries(s.harness, conversation.id)).some((entry) => ToolResultEntry.is(entry) && entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "dwell.work" && entry.model[0].isError && JSON.stringify(entry.model).includes("Only the original work creator")));
		s.faux.setResponses([checkpoint(undefined, ["Waiting for review"]), done()]);
		await (await conversation.submit({ type: "input", content: "blockers", entry: actor() }, context)).wait(context);
		assert.deepEqual((await current(s.harness, conversation.id)).blockers, ["Waiting for review"]);
	} finally { await s.close(); }
});

test("unattributed inputs cannot checkpoint a work record", { timeout: 5000 }, async () => {
	const s = await setup();
	try {
		const conversation = await s.conversation();
		s.faux.setResponses([checkpoint("Ghost progress"), done()]);
		await (await conversation.submit({ type: "input", content: "checkpoint without actor" }, context)).wait(context);
		assert.equal((await current(s.harness, conversation.id)).progress, "");
		assert.ok((await entries(s.harness, conversation.id)).some((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].isError));
	} finally { await s.close(); }
});

test("ordinary chat does not create a work record and checkpoint finds none", { timeout: 5000 }, async () => {
	const s = await setup({ responses: [done()] });
	try {
		const conversation = await s.conversation(null);
		await (await conversation.submit({ type: "input", content: "hello", entry: actor() }, context)).wait(context);
		assert.deepEqual(await getWork(s.harness, conversation.id), { records: {} });
		s.faux.setResponses([checkpoint("Nothing to save"), done()]);
		await (await conversation.submit({ type: "input", content: "checkpoint", entry: actor() }, context)).wait(context);
		assert.deepEqual(await getWork(s.harness, conversation.id), { records: {} });
		assert.ok((await entries(s.harness, conversation.id)).some((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].isError));
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
			call("probe"),
			inspect("", "probe", checkpoint("Checkpoint visible on the next request")),
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
			const record = JSON.parse(snapshot.content.slice(snapshot.content.indexOf("{"), snapshot.content.lastIndexOf("}") + 1));
			assert.equal(record.progress, progress);
			assert.equal(record.id, workId);
		}
	} finally { await s.close(); }
});

test("durable work survives reopen, reset and compaction while accounting remains deduplicated", { timeout: 10_000 }, async () => {
	const s = await setup({ pricingKnown: true, responses: [checkpoint("First check completed", ["Waiting for the answer"]), call("probe"), done()] });
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
			assert.equal(JSON.parse(snapshot.content.slice(snapshot.content.indexOf("{"), snapshot.content.lastIndexOf("}") + 1)).progress, "First check completed");
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
		assert.match(observed, /observable check passes/);
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
		assert.match(observed, /observable check passes/);
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
			const record = JSON.parse(snapshot.content.slice(snapshot.content.indexOf("{"), snapshot.content.lastIndexOf("}") + 1));
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

test("child creation freezes the old work and explicit absence before the host binds a newer goal", { timeout: 10_000 }, async () => {
	const s = await setup({ responses: [done(), call("probe"), done()] });
	try {
		const parent = await s.conversation(null);
		const unbound = await childOf(s, parent.id);
		await (await parent.submit({ type: "input", content: "warmup", entry: actor() }, context)).wait(context);
		const first = await beginNewGoal(s.harness, { conversationId: parent.id, expectedWorkId: null, operator: "owner", requestId: "first-goal", goal: "Repair the old example" });
		assert.equal(first.created, (await getWork(s.harness, parent.id)).current);
		const old = await current(s.harness, parent.id);
		const bound = await childOf(s, parent.id);
		await beginNewGoal(s.harness, { conversationId: parent.id, expectedWorkId: old.id, operator: "owner", requestId: "next-goal", goal: "A new goal" });
		const newer = await current(s.harness, parent.id);
		assert.notEqual(newer.id, old.id);
		assert.equal(newer.status, "active");
		s.faux.setResponses([call("probe"), done()]);
		await (await bound.submit({ type: "input", content: "late old check", entry: actor() }, context)).wait(context);
		let state = await getWork(s.harness, parent.id);
		assert.ok(state.records[old.id]!.usage.toolResults > 0, "late child tools still charge the frozen old record");
		assert.equal(state.records[newer.id]!.usage.toolResults, 0);
		assert.deepEqual((await getWork(s.harness, bound.id)).inherited, { conversationId: parent.id, id: old.id });
		assert.equal((await getWork(s.harness, unbound.id)).inherited, null);
		// 被 /goal 解绑的记录是历史：冻结的子会话不能再 checkpoint 它
		s.faux.setResponses([checkpoint("Late progress on a superseded goal"), done()]);
		await (await bound.submit({ type: "input", content: "late checkpoint", entry: actor() }, context)).wait(context);
		assert.equal((await getWork(s.harness, parent.id)).records[old.id]!.progress, "");
		assert.ok((await entries(s.harness, bound.id)).some((entry) => ToolResultEntry.is(entry) && entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "dwell.work" && entry.model[0].isError && JSON.stringify(entry.model).includes("superseded")));
		// 无记录冻结的子会话 checkpoint 无处可绑，且即使父会话后来有了记录也保持无记录
		s.faux.setResponses([checkpoint("Ghost progress"), done()]);
		await (await unbound.submit({ type: "input", content: "try checkpoint", entry: actor() }, context)).wait(context);
		assert.ok((await entries(s.harness, unbound.id)).some((entry) => ToolResultEntry.is(entry) && entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "dwell.work" && entry.model[0].isError && JSON.stringify(entry.model).includes("No work record is active")));
		assert.equal((await getWork(s.harness, unbound.id)).current, undefined);
	} finally { await s.close(); }
});

test("approval continuation resolves its original work even after a newer goal and rejects unknown attribution", { timeout: 10_000 }, async () => {
	const s = await setup({ responses: [done()] });
	try {
		const parent = await s.conversation();
		const original = await parent.submit({ type: "input", content: "start", entry: actor() }, context);
		await original.wait(context);
		const old = await current(s.harness, parent.id);
		await beginNewGoal(s.harness, { conversationId: parent.id, expectedWorkId: old.id, operator: "owner", requestId: "newer", goal: "New goal" });
		const newer = await current(s.harness, parent.id);
		const chargedBefore = (await getWork(s.harness, parent.id)).records[old.id]!.usage.modelAdmissions;
		s.faux.setResponses([checkpoint("Approved old continuation"), done()]);
		await (await parent.submit({ type: "input", content: "approved", entry: { kind: "dwell.approval", data: { sender: "owner", budgetId: `${parent.id}:${original.id}` } } }, context)).wait(context);
		const state = await getWork(s.harness, parent.id);
		assert.equal(state.records[old.id]!.usage.modelAdmissions, chargedBefore + 2, "the approval continuation still charges the original record");
		assert.equal(state.records[old.id]!.progress, "", "superseded records refuse late checkpoints");
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
		const s = await setup({ responses: [done()], extra: () => [budget.extension] });
		await budget.attach(s.harness);
		try {
			const parent = await s.conversation(tracked ? "Repair the tracked example" : null);
			const original = await parent.submit({ type: "input", content: "original", entry: actor() }, context);
			await original.wait(context);
			const pinned = await budget.captureApproval(parent.id);
			assert.equal(pinned, `${parent.id}:${original.id}`);
			const identity = await s.harness.commit((tx) => workIdentity(tx, parent.id, pinned), context);
			if (!tracked) await beginNewGoal(s.harness, { conversationId: parent.id, expectedWorkId: null, operator: "owner", requestId: "later-goal", goal: "Later unrelated goal" });
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
	const s = await setup({ background: true, responses: [done()], extra: (getHarness) => [makeBackgroundExtension({ getHarness, senderOf: () => "owner", viaOf: () => "panel", forbidden: () => [], onStarted: () => {}, attribute: async () => {}, onFired: () => { fired(); } })] });
	try {
		const parent = await s.conversation();
		await (await parent.submit({ type: "input", content: "spawn", entry: actor() }, context)).wait(context);
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
		// host 直接建新目标并解绑旧记录；子会话的迟回报文仍归属旧记录
		await beginNewGoal(s.harness, { conversationId: parent.id, expectedWorkId: old.id, operator: "owner", requestId: "newer-goal", goal: "New goal" });
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
	let release!: () => void;
	const reportHeld = new Promise<void>((resolve) => { release = resolve; });
	const s = await setup({ responses: [call("probe"), done()], extra: (getHarness) => [makeProcExtension({ getHarness, senderOf: () => "owner", viaOf: () => "panel", shell: () => ({ path: "", sandboxed: false }), attribute: async () => { await reportHeld; }, onFired: () => { fired(); } })] });
	try {
		const parent = await s.conversation();
		await (await parent.submit({ type: "input", content: "start process", entry: actor() }, context)).wait(context);
		const old = await current(s.harness, parent.id);
		s.faux.setResponses([call("dwell.proc", { action: "start", name: "check", command: "unused" }), done()]);
		await (await parent.submit({ type: "input", content: "start managed process", entry: actor() }, context)).wait(context);
		const tasks = await s.harness.commit(async (tx) => JSON.parse(JSON.stringify((await tx.scanTasks({ kind: PROC_TASK_KIND }, 100)).items)), context);
		assert.deepEqual(tasks[0].input.work, { conversationId: parent.id, id: old.id });
		await beginNewGoal(s.harness, { conversationId: parent.id, expectedWorkId: old.id, operator: "owner", requestId: "newer-goal", goal: "New goal" });
		const newer = await current(s.harness, parent.id);
		release();
		s.harness.resume();
		await reported;
		await parent.waitForIdle(context);
		const report = (await entries(s.harness, parent.id)).find((entry) => entry.kind === "chat.message" && typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data) && entry.data.via === "proc");
		assert.deepEqual((report!.data as { work: unknown }).work, { conversationId: parent.id, id: old.id });
		assert.equal((await current(s.harness, parent.id)).id, newer.id);
		assert.equal((await s.harness.waitForTask(tasks[0].id, context)).state.outcome.status, "completed");
	} finally { release?.(); await s.close(); }
});

test("the injected record escapes markup in narrative fields and wraps the JSON in a work_record block", { timeout: 10_000 }, async () => {
	let lastMessages: readonly Message[] = [];
	const s = await setup({ responses: [async (request) => { lastMessages = request.messages; return done(); }] });
	try {
		const conversation = await s.conversation("Fix </work_record> and <b>bold</b>");
		await (await conversation.submit({ type: "input", content: "start", entry: actor() }, context)).wait(context);
		const content = String(lastMessages.findLast((item) => item.role === "user" && typeof item.content === "string" && item.content.startsWith("[Durable work record;"))!.content);
		assert.match(content, /supersedes earlier work-record content/);
		assert.match(content, /<work_record>\n\{/);
		assert.match(content, /\n<\/work_record>$/);
		// 未转义的闭合标记不得出现：字段文本里只能是 &lt;/work_record&gt;
		assert.ok(!content.includes("</work_record> and"));
		const record = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
		assert.equal(record.goal, "Fix &lt;/work_record&gt; and &lt;b&gt;bold&lt;/b&gt;");
	} finally { await s.close(); }
});
