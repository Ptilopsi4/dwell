import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, InboxDoc, LiveDoc, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import type { WorkLimits } from "../src/ext/work.ts";

const privateState = await mkdtemp(join(tmpdir(), "dwell-new-goal-state-"));
process.env.DWELL_STATE = privateState;
const { getWork, inheritWork, makeWorkController, WorkDoc, workIdentity } = await import("../src/ext/work.ts");
const { BudgetDoc, makeBudgetController } = await import("../src/ext/budget.ts");
const { BackgroundAnchor, BackgroundDoc, makeBackgroundDeliverer, makeBackgroundExtension } = await import("../src/ext/background.ts");
const { makeProcExtension, PROC_TASK_KIND } = await import("../src/ext/proc.ts");
const { beginNewGoal, NewGoalDoc } = await import("../src/new-goal.ts");
const { TelegramInboxDoc } = await import("../src/telegram-entry.ts");
after(() => rm(privateState, { recursive: true, force: true }));

const done = () => fauxAssistantMessage(fauxText("done"));
const call = (name: string, args = {}) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const start = (goal = "Repair the old example") => call("dwell.work", { action: "start", goal, acceptance: ["The observable check passes"] });
const actor = () => ({ kind: "chat.message", data: { sender: "owner", via: "panel" } });
const gate = () => {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
};

async function setup(options: { path?: string; limits?: Partial<WorkLimits>; responses?: FauxResponseStep[]; background?: boolean; extra?: (harness: () => Harness) => Extension[] } = {}) {
	const dir = options.path === undefined ? await mkdtemp(join(tmpdir(), "dwell-new-goal-")) : undefined;
	const path = options.path ?? join(dir!, "work.sqlite");
	const work = makeWorkController({ limits: options.limits });
	const budget = makeBudgetController();
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	faux.setResponses(options.responses ?? [start(), done()]);
	const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry(); registry.install(work.extension); registry.install(budget.extension);
	registry.install(defineExtension({ name: "new-goal-fixtures", tasks: options.background ? [] : [BackgroundAnchor], tools: [
		defineTool({ name: "probe", description: "Run an observable check", parameters: Type.Object({}), replay: "safe", async execute() { return { output: [{ type: "text", text: "check passed" }] }; } }),
	] }));
	let harness!: Harness;
	for (const extension of options.extra?.(() => harness) ?? []) registry.install(extension);
	harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
	await work.attach(harness); await budget.attach(harness);
	let closed = false;
	return {
		harness, faux, budget, dir, path,
		conversation: () => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context),
		close: async (keep = false) => { if (closed) return; closed = true; await budget.close(); await work.close(); await harness.close(context); if (dir !== undefined && !keep) await rm(dir, { recursive: true, force: true }); },
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

async function childOf(s: Awaited<ReturnType<typeof setup>>, parent: ConversationId) {
	const id = await s.harness.commit(async (tx) => {
		const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true, conversationId: parent });
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
		await inheritWork(tx, parent, child.id);
		return child.id;
	}, context);
	return (await s.harness.conversation(id, context))!;
}

test("host new-goal preserves an exhausted goal, its receipts and history while enabling a fresh goal", { timeout: 10_000 }, async () => {
	const s = await setup({ limits: { modelAdmissions: 4 }, responses: [start(), call("probe"), done()] });
	try {
		const parent = await s.conversation();
		const original = await parent.submit({ type: "input", content: "old user history", entry: actor() }, context);
		await original.wait(context);
		const old = await current(s.harness, parent.id);
		const evidence = Number(Object.keys(old.availableEvidence)[0]);
		assert.ok(evidence);
		s.faux.setResponses([call("dwell.work", { action: "checkpoint", progress: "The old check passed", evidence: [evidence], blockers: ["Waiting for operator"] }), done()]);
		await (await parent.submit({ type: "input", content: "checkpoint", entry: actor() }, context)).wait(context);
		const child = await childOf(s, parent.id);
		const calls = s.faux.state.callCount;
		for (const content of ["continue", "start another goal"]) {
			assert.equal((await (await parent.submit({ type: "input", content, entry: actor() }, context)).wait(context)).status, "unanswered");
			assert.equal(s.faux.state.callCount, calls);
		}
		assert.equal((await current(s.harness, parent.id)).stopped, "model_limit");
		// Preserve opaque record fields written by another version.
		await s.harness.commit(async (tx) => {
			Object.assign((await tx.doc(WorkDoc, parent.id)).records[old.id]!, { verification: {
				contract: { checks: [{ name: "old check", command: "node --test old.test.ts" }], artifacts: ["result.txt"] }, status: "verified",
				receipt: { workId: old.id, taskId: 123, verifiedAt: 456, checks: [{ name: "old check", command: "node --test old.test.ts", taskId: 124, exitCode: 0, isError: false }], manifest: { cwd: "/fixture", digest: "old-artifact-digest", files: 1, bytes: 12 } },
			} });
		}, context);
		await s.budget.close();
		const before = (await s.harness.snapshot(WorkDoc, parent.id, context))!;
		const budgetBefore = await s.harness.snapshot(BudgetDoc, parent.id, context);
		const history = await entries(s.harness, parent.id);
		const result = await beginNewGoal(s.harness, { conversationId: parent.id, expectedWorkId: old.id, operator: "owner", requestId: "new-goal-1" });
		assert.equal(result.changed, true); assert.equal(result.workId, old.id);
		const { current: detached, ...retained } = before;
		assert.equal(detached, old.id);
		assert.deepEqual(await s.harness.snapshot(WorkDoc, parent.id, context), retained);
		assert.deepEqual(await s.harness.snapshot(BudgetDoc, parent.id, context), budgetBefore);
		const after = await entries(s.harness, parent.id);
		assert.deepEqual(after.slice(0, history.length), history);
		assert.equal(after.length, history.length + 1);
		assert.equal(after.at(-1)!.id, result.entryId);
		assert.equal(after.at(-1)!.kind, "work.new_goal");
		assert.equal(after.at(-1)!.head, undefined);
		let observed = "";
		s.faux.setResponses([async (request) => { observed = JSON.stringify(request.messages); return start("Build the new example"); }, done()]);
		await (await parent.submit({ type: "input", content: "new explicit goal", entry: actor() }, context)).wait(context);
		const newer = await current(s.harness, parent.id);
		assert.notEqual(newer.id, old.id);
		assert.match(observed, /old user history/);
		assert.equal(newer.stopped, undefined);
		const afterNewGoal = s.faux.state.callCount;
		await (await child.submit({ type: "input", content: "late old child", entry: actor() }, context)).wait(context);
		await (await parent.submit({ type: "input", content: "late old approval", entry: { kind: "dwell.approval", data: { sender: "owner", budgetId: `${parent.id}:${original.id}` } } }, context)).wait(context);
		assert.equal(s.faux.state.callCount, afterNewGoal, "old descendants and approvals retain the old exhausted allowance");
		assert.equal((await current(s.harness, parent.id)).id, newer.id);
		const preserved = (await getWork(s.harness, parent.id)).records[old.id]!;
		assert.deepEqual(preserved.usage, before.records[old.id]!.usage);
		assert.deepEqual(preserved.evidence, [evidence]);
		assert.deepEqual((preserved as unknown as { verification: unknown }).verification, (before.records[old.id]! as unknown as { verification: unknown }).verification);
		assert.equal(preserved.stopped, "model_limit");
	} finally { await s.close(); }
});

test("new-goal request replay survives reopen without detaching a later goal", { timeout: 10_000 }, async () => {
	const s = await setup();
	let reopened: Awaited<ReturnType<typeof setup>> | undefined;
	try {
		const parent = await s.conversation();
		assert.deepEqual(await beginNewGoal(s.harness, { conversationId: parent.id, expectedWorkId: null, operator: "owner", requestId: "empty" }), { changed: false });
		await (await parent.submit({ type: "input", content: "old", entry: actor() }, context)).wait(context);
		const old = await current(s.harness, parent.id);
		const input = { conversationId: parent.id, expectedWorkId: old.id, operator: "owner", requestId: "stable-request" };
		await assert.rejects(beginNewGoal(s.harness, { ...input, expectedWorkId: "stale-work" }));
		await assert.rejects(beginNewGoal(s.harness, { ...input, operator: " " }));
		await assert.rejects(beginNewGoal(s.harness, { ...input, requestId: " " }));
		const first = await beginNewGoal(s.harness, input);
		s.faux.setResponses([start("Later goal"), done()]);
		await (await parent.submit({ type: "input", content: "later", entry: actor() }, context)).wait(context);
		const later = await current(s.harness, parent.id);
		await s.close(true);
		reopened = await setup({ path: s.path });
		assert.deepEqual(await beginNewGoal(reopened.harness, input), first);
		assert.equal((await current(reopened.harness, parent.id)).id, later.id);
		await assert.rejects(beginNewGoal(reopened.harness, { ...input, operator: "other" }));
		await assert.rejects(beginNewGoal(reopened.harness, { ...input, expectedWorkId: later.id }));
		await assert.rejects(beginNewGoal(reopened.harness, { ...input, requestId: "new-request" }));
		assert.equal((await entries(reopened.harness, parent.id)).filter((entry) => entry.kind === "work.new_goal").length, 1);
		assert.deepEqual((await reopened.harness.snapshot(NewGoalDoc, parent.id, context))!.requests["stable-request"], { workId: old.id, operator: "owner", at: (await reopened.harness.snapshot(NewGoalDoc, parent.id, context))!.requests["stable-request"]!.at, entryId: first.entryId });
	} finally { if (reopened !== undefined) await reopened.close(); else await s.close(); await rm(s.dir!, { recursive: true, force: true }); }
});

test("an empty new-goal request remains a no-op after a later goal and reopen", { timeout: 10_000 }, async () => {
	const s = await setup();
	let reopened: Awaited<ReturnType<typeof setup>> | undefined;
	try {
		const parent = await s.conversation();
		const input = { conversationId: parent.id, expectedWorkId: null, operator: "owner", requestId: "empty-first-request" };
		assert.deepEqual(await beginNewGoal(s.harness, input), { changed: false });
		const receipt = (await s.harness.snapshot(NewGoalDoc, parent.id, context))!.requests[input.requestId]!;
		assert.equal(receipt.workId, null);
		assert.equal(receipt.entryId, undefined);
		await (await parent.submit({ type: "input", content: "establish a later goal", entry: actor() }, context)).wait(context);
		const later = await current(s.harness, parent.id);
		await s.close(true);
		reopened = await setup({ path: s.path });
		const before = await reopened.harness.snapshot(WorkDoc, parent.id, context);
		const history = await entries(reopened.harness, parent.id);
		assert.deepEqual(await beginNewGoal(reopened.harness, input), { changed: false });
		await assert.rejects(beginNewGoal(reopened.harness, { ...input, expectedWorkId: later.id }));
		assert.deepEqual(await reopened.harness.snapshot(WorkDoc, parent.id, context), before);
		assert.deepEqual(await entries(reopened.harness, parent.id), history);
		assert.equal((await current(reopened.harness, parent.id)).id, later.id);
		assert.deepEqual((await reopened.harness.snapshot(NewGoalDoc, parent.id, context))!.requests[input.requestId], receipt);
	} finally { if (reopened !== undefined) await reopened.close(); else await s.close(); await rm(s.dir!, { recursive: true, force: true }); }
});

test("new-goal rejects live runs and persisted SDK or raw Telegram input backlogs", { timeout: 10_000 }, async () => {
	const s = await setup();
	const held = gate(); const started = gate();
	try {
		const parent = await s.conversation();
		const original = await parent.submit({ type: "input", content: "old", entry: actor() }, context);
		await original.wait(context);
		const old = await current(s.harness, parent.id);
		const input = { conversationId: parent.id, expectedWorkId: old.id, operator: "owner", requestId: "busy" };
		s.faux.setResponses([async (_request, options) => {
			started.release();
			await Promise.race([held.promise, new Promise<void>((resolve) => { options!.signal!.addEventListener("abort", () => resolve(), { once: true }); })]);
			return done();
		}]);
		const running = await parent.submit({ type: "input", content: "held run", entry: actor() }, context);
		const waiting = running.wait(context);
		await started.promise;
		assert.ok((await s.harness.snapshot(LiveDoc, parent.id, context))!.run);
		await assert.rejects(beginNewGoal(s.harness, input));
		held.release(); await waiting;
		for (const mode of ["steer", "followUp"] as const) {
			await s.harness.commit(async (tx) => { (await tx.doc(InboxDoc, parent.id)).items.push({ id: original.id, mode, content: "persisted queued input" }); }, context);
			assert.equal((await s.harness.snapshot(LiveDoc, parent.id, context))!.run, undefined);
			await assert.rejects(beginNewGoal(s.harness, input));
			await s.harness.commit(async (tx) => { (await tx.doc(InboxDoc, parent.id)).items = []; }, context);
		}
		for (const output of ["pending", "sending"] as const) {
			await s.harness.commit(async (tx) => { (await tx.doc(TelegramInboxDoc)).inputs.raw = { conversationId: parent.id, sender: "owner", destination: { kind: "telegram", botId: "test", chatId: "1" }, replyTo: "1", content: "", raw: "{}", output }; }, context);
			await assert.rejects(beginNewGoal(s.harness, input));
			await s.harness.commit(async (tx) => { delete (await tx.doc(TelegramInboxDoc)).inputs.raw; }, context);
		}
		assert.equal((await current(s.harness, parent.id)).id, old.id);
		assert.equal(Object.keys((await s.harness.snapshot(NewGoalDoc, parent.id, context))?.requests ?? {}).length, 0);
		assert.equal((await beginNewGoal(s.harness, input)).changed, true);
	} finally { held.release(); await s.close(); }
});

test("children cannot detach inherited work or explicit absence of work", { timeout: 5000 }, async () => {
	const s = await setup();
	try {
		const parent = await s.conversation();
		const unbound = await childOf(s, parent.id);
		await (await parent.submit({ type: "input", content: "old", entry: actor() }, context)).wait(context);
		const old = await current(s.harness, parent.id);
		const bound = await childOf(s, parent.id);
		for (const child of [unbound, bound]) {
			await assert.rejects(beginNewGoal(s.harness, { conversationId: child.id, expectedWorkId: null, operator: "owner", requestId: `child-${child.id}` }));
			assert.equal((await getWork(s.harness, child.id)).current, undefined);
		}
		assert.equal((await getWork(s.harness, unbound.id)).inherited, null);
		assert.deepEqual((await getWork(s.harness, bound.id)).inherited, { conversationId: parent.id, id: old.id });
		assert.equal((await current(s.harness, parent.id)).id, old.id);
	} finally { await s.close(); }
});

test("late child, approval and real background Reporter keep their old work after new-goal", { timeout: 10_000 }, async () => {
	const fired = gate();
	const deps = { senderOf: () => "owner", viaOf: () => "panel" as const, forbidden: () => [], attribute: async () => {}, onStarted: () => {}, onFired: () => { fired.release(); } };
	const s = await setup({ background: true, extra: (getHarness) => [makeBackgroundExtension({ ...deps, getHarness })] });
	try {
		const parent = await s.conversation();
		const original = await parent.submit({ type: "input", content: "old", entry: actor() }, context);
		await original.wait(context);
		const old = await current(s.harness, parent.id);
		const child = await childOf(s, parent.id);
		await parent.commit(async (tx) => { (await tx.doc(BackgroundDoc, parent.id)).agents.worker = { conversationId: child.id }; }, context);
		await beginNewGoal(s.harness, { conversationId: parent.id, expectedWorkId: old.id, operator: "owner", requestId: "detach" });
		s.faux.setResponses([start("New current goal"), done()]);
		await (await parent.submit({ type: "input", content: "new", entry: actor() }, context)).wait(context);
		const newer = await current(s.harness, parent.id);
		s.faux.setResponses([call("probe"), done()]);
		const childInput = await child.submit({ type: "input", content: "late child check", entry: actor() }, context);
		await childInput.wait(context);
		s.faux.setResponses([call("dwell.work", { action: "checkpoint", progress: "Late approval belongs to old goal" }), done()]);
		await (await parent.submit({ type: "input", content: "approved", entry: { kind: "dwell.approval", data: { sender: "owner", budgetId: `${parent.id}:${original.id}` } } }, context)).wait(context);
		assert.deepEqual(await s.harness.commit((tx) => workIdentity(tx, parent.id, `${parent.id}:${original.id}`), context), { conversationId: parent.id, id: old.id });
		s.faux.setResponses([done(), done()]);
		assert.equal(await makeBackgroundDeliverer(deps, () => s.harness).deliver(parent.id, child.id, "old child report", { deliveryId: "old-report", sender: "owner", budgetId: `${child.id}:${childInput.id}` }), true);
		s.harness.resume(); await fired.promise;
		await parent.waitForIdle(context);
		const state = await getWork(s.harness, parent.id);
		assert.equal(state.current, newer.id);
		assert.equal(state.records[old.id]!.progress, "Late approval belongs to old goal");
		assert.ok(state.records[old.id]!.usage.toolResults > old.usage.toolResults);
		assert.equal(state.records[newer.id]!.progress, "");
		assert.equal(state.records[newer.id]!.usage.toolResults, newer.usage.toolResults);
		const report = (await entries(s.harness, parent.id)).find((entry) => entry.kind === "chat.message" && (entry.data as { via?: string } | undefined)?.via === "background");
		assert.deepEqual((report!.data as { work: unknown }).work, { conversationId: parent.id, id: old.id });
	} finally { await s.close(); }
});

test("managed process follow-up retains its creation work after new-goal", { timeout: 10_000 }, async () => {
	const fired = gate();
	const reportHeld = gate();
	const s = await setup({ extra: (getHarness) => [makeProcExtension({ getHarness, senderOf: () => "owner", viaOf: () => "panel", shell: () => ({ path: "", sandboxed: false }), attribute: async () => { await reportHeld.promise; }, onFired: () => { fired.release(); } })] });
	try {
		const parent = await s.conversation();
		await (await parent.submit({ type: "input", content: "old", entry: actor() }, context)).wait(context);
		const old = await current(s.harness, parent.id);
		s.faux.setResponses([call("dwell.proc", { action: "start", name: "old-check", command: "unused" }), done()]);
		await (await parent.submit({ type: "input", content: "start old process", entry: actor() }, context)).wait(context);
		const tasks = await s.harness.commit(async (tx) => JSON.parse(JSON.stringify((await tx.scanTasks({ kind: PROC_TASK_KIND }, 100)).items)), context);
		assert.deepEqual(tasks[0].input.work, { conversationId: parent.id, id: old.id });
		await beginNewGoal(s.harness, { conversationId: parent.id, expectedWorkId: old.id, operator: "owner", requestId: "detach-with-process" });
		s.faux.setResponses([start("New goal while process remains managed"), done(), done()]);
		await (await parent.submit({ type: "input", content: "new", entry: actor() }, context)).wait(context);
		const newer = await current(s.harness, parent.id);
		reportHeld.release();
		s.harness.resume(); await fired.promise;
		await parent.waitForIdle(context);
		const report = (await entries(s.harness, parent.id)).find((entry) => entry.kind === "chat.message" && (entry.data as { via?: string } | undefined)?.via === "proc");
		assert.deepEqual((report!.data as { work: unknown }).work, { conversationId: parent.id, id: old.id });
		assert.equal((await current(s.harness, parent.id)).id, newer.id);
		assert.equal((await s.harness.waitForTask(tasks[0].id, context)).state.outcome.status, "completed");
	} finally { reportHeld.release(); await s.close(); }
});
