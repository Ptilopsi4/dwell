import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, hook, LiveDoc, ToolTask, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { BudgetDoc, makeBudgetController, type BudgetLimits } from "../src/ext/budget.ts";

const approvalStateDir = await mkdtemp(join(tmpdir(), "dwell-budget-approval-"));
process.env.DWELL_STATE = approvalStateDir;
const approval = await import("../src/ext/approval.ts");
const { BackgroundAnchor } = await import("../src/ext/background.ts");
after(() => rm(approvalStateDir, { recursive: true, force: true }));

const context = BACKGROUND_CONTEXT;
const until = async (check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> => {
	for (const end = Date.now() + ms; ;) {
		if (await check()) return;
		if (Date.now() > end) throw new Error("Budget test timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};
const text = () => fauxAssistantMessage(fauxText("done"));
const call = (count = 1) => fauxAssistantMessage(Array.from({ length: count }, (_, i) => fauxToolCall("work", {}, { id: `call-${i}` })), { stopReason: "toolUse" });

async function setup(options: { limits?: Partial<BudgetLimits>; responses?: FauxResponseStep[]; path?: string; contextWindow?: number; extensions?: (budget: ReturnType<typeof makeBudgetController>) => Extension[] } = {}) {
	const dir = options.path === undefined ? await mkdtemp(join(tmpdir(), "dwell-budget-")) : undefined;
	const path = options.path ?? join(dir!, "s.sqlite");
	const budget = makeBudgetController({ limits: options.limits });
	const faux = fauxProvider({ tokensPerSecond: 100_000, ...(options.contextWindow === undefined ? {} : { models: [{ id: "faux-1", contextWindow: options.contextWindow, maxTokens: 128 }] }) });
	faux.setResponses(options.responses ?? [text()]);
	const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry(); registry.install(budget.extension);
	for (const extension of options.extensions?.(budget) ?? []) registry.install(extension);
	const harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry, settings: { retry: { enabled: true, maxRetries: 4, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1, reserveTokens: 64 } } }, context);
	await budget.attach(harness);
	return {
		harness, budget, faux, path,
		conversation: () => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context),
		close: async (keep = false) => { await budget.close(); await harness.close(context); if (dir !== undefined && !keep) await rm(dir, { recursive: true, force: true }); },
	};
}

const workExtension = (execute: () => void | Promise<void>) => defineExtension({ name: "test-work", tools: [defineTool({ name: "work", description: "Do work", parameters: Type.Object({}), replay: "safe", async execute() { await execute(); return { output: [{ type: "text", text: "ok" }] }; } })] });

test("budget rejects before the provider and terminates without a retry spin", { timeout: 5000 }, async () => {
	const s = await setup({ limits: { modelAdmissions: 0 } });
	try {
		const conversation = await s.conversation();
		const receipt = await (await conversation.submit({ type: "input", content: "hello" }, context)).wait(context);
		assert.equal(receipt.status, "unanswered");
		assert.equal(s.faux.state.callCount, 0);
		assert.equal(await s.budget.stopReason(conversation.id), "model_limit");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(s.faux.state.callCount, 0);
	} finally { await s.close(); }
});

test("budget caps multiple tool admissions atomically", { timeout: 5000 }, async () => {
	let executions = 0;
	const s = await setup({ limits: { toolAdmissions: 2 }, responses: [call(5), text()], extensions: () => [workExtension(() => { executions++; })] });
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "work" }, context)).wait(context);
		const doc = await s.harness.snapshot(BudgetDoc, conversation.id, context);
		assert.equal(doc?.records[doc.current!]?.toolAdmissions, 2);
		assert.ok(executions <= 2);
		assert.equal(s.faux.state.callCount, 1);
		assert.equal(await s.budget.stopReason(conversation.id), "tool_limit");
	} finally { await s.close(); }
});

test("durable model retries consume admissions before each request", { timeout: 5000 }, async () => {
	const retry = fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 temporary unavailable" });
	const s = await setup({ limits: { modelAdmissions: 2 }, responses: [retry, retry, text()] });
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "retry" }, context)).wait(context);
		assert.equal(s.faux.state.callCount, 2);
		assert.equal(await s.budget.stopReason(conversation.id), "model_limit");
	} finally { await s.close(); }
});

test("steer shares a live allowance, while a later normal input starts a new one", { timeout: 5000 }, async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const s = await setup({ limits: { modelAdmissions: 1 }, responses: [async () => { await gate; return call(); }, text()], extensions: () => [workExtension(() => {})] });
	try {
		const conversation = await s.conversation();
		const first = await conversation.submit({ type: "input", content: "first" }, context);
		await until(() => s.faux.state.callCount === 1);
		const original = await s.budget.current(conversation.id);
		const steer = await conversation.submit({ type: "input", content: "steer", whenBusy: "steer" }, context);
		release!();
		await first.wait(context); await steer.wait(context);
		assert.deepEqual(await s.budget.current(conversation.id), original);
		assert.equal(await s.budget.stopReason(conversation.id), "model_limit");
		await (await conversation.submit({ type: "input", content: "new" }, context)).wait(context);
		assert.notDeepEqual(await s.budget.current(conversation.id), original);
		assert.equal(s.faux.state.callCount, 2);
	} finally { release!(); await s.close(); }
});

test("approval wait pauses only after completion and continuation inherits remaining allowance", { timeout: 5000 }, async () => {
	const s = await setup({ limits: { modelAdmissions: 2, executionMs: 500 }, responses: [call(), text(), text()], extensions: (budget) => [workExtension(() => {}), defineExtension({ name: "approval-test", hooks: [hook(ToolTask, { beforeTool: async (_call, api) => { await budget.captureApproval(api.conversationId); return { block: "approval required" }; } })] })] });
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "dangerous" }, context)).wait(context);
		const budgetId = (await s.budget.current(conversation.id))!.budgetId;
		await until(async () => (await s.harness.snapshot(BudgetDoc, conversation.id, context))?.records[budgetId]?.activeSince === undefined);
		const before = (await s.harness.snapshot(BudgetDoc, conversation.id, context))!.records[budgetId]!.executionMs;
		await new Promise((resolve) => setTimeout(resolve, 550));
		assert.equal((await s.harness.snapshot(BudgetDoc, conversation.id, context))!.records[budgetId]!.executionMs, before);
		await (await conversation.submit({ type: "input", content: "approved", entry: { kind: "dwell.approval", data: { budgetId } } }, context)).wait(context);
		assert.equal(s.faux.state.callCount, 2);
		assert.equal(await s.budget.stopReason(conversation.id), "model_limit");
	} finally { await s.close(); }
});

test("unknown approval budget fails closed", { timeout: 5000 }, async () => {
	const s = await setup();
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "approved", entry: { kind: "dwell.approval", data: { budgetId: "missing" } } }, context)).wait(context);
		assert.equal(s.faux.state.callCount, 0);
		assert.equal(await s.budget.stopReason(conversation.id), "unknown_budget");
	} finally { await s.close(); }
});

test("an approval-blocked run keeps its clock until the model actually finishes", { timeout: 5000 }, async () => {
	const s = await setup({ limits: { executionMs: 80 }, responses: [call(), async (_context, options) => { await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true })); return text(); }], extensions: (budget) => [workExtension(() => {}), defineExtension({ name: "waiting-approval", hooks: [hook(ToolTask, { beforeTool: async (_call, api) => { await budget.captureApproval(api.conversationId); return { block: "approval required" }; } })] })] });
	try {
		const conversation = await s.conversation();
		const result = await (await conversation.submit({ type: "input", content: "approval" }, context)).wait(context);
		assert.equal(result.status, "unanswered");
		assert.equal(await s.budget.stopReason(conversation.id), "execution_limit");
	} finally { await s.close(); }
});

test("an old approval retains its allowance across a newer normal run", { timeout: 5000 }, async () => {
	let blocks = 0;
	const s = await setup({ limits: { modelAdmissions: 3 }, responses: [call(), text(), text(), call(), text()], extensions: (budget) => [workExtension(() => {}), defineExtension({ name: "first-approval", hooks: [hook(ToolTask, { beforeTool: async (_call, api) => { if (blocks++ > 0) return; await budget.captureApproval(api.conversationId); return { block: "approval required" }; } })] })] });
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "approval" }, context)).wait(context);
		const oldBudget = (await s.budget.current(conversation.id))!.budgetId;
		await (await conversation.submit({ type: "input", content: "unrelated" }, context)).wait(context);
		const newerBudget = (await s.budget.current(conversation.id))!.budgetId;
		assert.notEqual(newerBudget, oldBudget);
		await (await conversation.submit({ type: "input", content: "approved", entry: { kind: "dwell.approval", data: { budgetId: oldBudget } } }, context)).wait(context);
		assert.equal(s.faux.state.callCount, 4);
		assert.equal(await s.budget.stopReason(conversation.id, oldBudget), "model_limit");
		assert.equal(await s.budget.stopReason(conversation.id, newerBudget), undefined);
		const doc = await s.harness.snapshot(BudgetDoc, conversation.id, context);
		assert.equal(doc!.records[oldBudget]!.modelAdmissions, 3);
		assert.equal(doc!.records[newerBudget]!.modelAdmissions, 1);
	} finally { await s.close(); }
});

test("an old approval queued behind a busy normal run cannot borrow its allowance", { timeout: 5000 }, async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let blocks = 0;
	const s = await setup({ limits: { modelAdmissions: 2 }, responses: [call(), text(), async () => { await gate; return text(); }, text()], extensions: (budget) => [workExtension(() => {}), defineExtension({ name: "queued-approval", hooks: [hook(ToolTask, { beforeTool: async (_call, api) => { if (blocks++ > 0) return; await budget.captureApproval(api.conversationId); return { block: "approval required" }; } })] })] });
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "original task", entry: { kind: "chat.message", data: { sender: "original", via: "panel" } } }, context)).wait(context);
		const oldBudget = (await s.budget.current(conversation.id))!.budgetId;
		const newer = await conversation.submit({ type: "input", content: "unrelated task" }, context);
		await until(() => s.faux.state.callCount === 3);
		const newerBudget = (await s.budget.current(conversation.id))!.budgetId;
		assert.notEqual(newerBudget, oldBudget);
		const continuation = await conversation.submit({ type: "input", content: "approved original task", whenBusy: "followUp", entry: { kind: "dwell.approval", data: { budgetId: oldBudget } } }, context);
		assert.equal((await continuation.status(context)).status, "queued");
		release!();
		assert.equal((await newer.wait(context)).status, "done");
		assert.equal((await continuation.wait(context)).status, "unanswered");
		assert.equal(s.faux.state.callCount, 3, "the exhausted approval continuation must stop before another provider request");
		const doc = await s.harness.snapshot(BudgetDoc, conversation.id, context);
		assert.equal(doc!.records[oldBudget]!.modelAdmissions, 2);
		assert.equal(doc!.records[oldBudget]!.stopped, "model_limit");
		assert.equal(doc!.records[newerBudget]!.modelAdmissions, 1);
		assert.equal(doc!.records[newerBudget]!.stopped, undefined);
	} finally { release!(); await s.close(); }
});

test("a queued approval restores its original sender only when its own run starts", { timeout: 5000 }, async () => {
	let harness: Harness | undefined;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let executions = 0;
	const dangerous = () => fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf output" }), { stopReason: "toolUse" });
	const s = await setup({ responses: [dangerous(), text(), async () => { await gate; return text(); }, dangerous(), text()], extensions: (budget) => {
		approval.setApprovalBudgetGetter((id) => budget.captureApproval(id));
		return [approval.makeApprovalExtension(() => harness), defineExtension({ name: "fake-bash", tools: [defineTool({ name: "bash", description: "Fake shell without side effects", parameters: Type.Object({ command: Type.String() }), async execute() { executions++; return { output: [] }; } })] })];
	} });
	harness = s.harness;
	try {
		const conversation = await s.conversation();
		await approval.setRunAttribution(conversation.id, "original", "panel");
		await (await conversation.submit({ type: "input", content: "original task", entry: { kind: "chat.message", data: { sender: "original", via: "panel" } } }, context)).wait(context);
		const oldBudget = (await s.budget.current(conversation.id))!.budgetId;
		const decision = (await approval.takeDecision(`${conversation.id}:original`, "approve", 10))!;
		await approval.setRunAttribution(conversation.id, "newer", "feishu");
		const newer = await conversation.submit({ type: "input", content: "newer sender's task", entry: { kind: "chat.message", data: { sender: "newer", via: "feishu" } } }, context);
		await until(() => s.faux.state.callCount === 3);
		const continuation = await conversation.submit({ type: "input", content: approval.decisionInput(decision.action, decision.minutes, decision.expiresAt), whenBusy: "followUp", entry: { kind: "dwell.approval", data: { budgetId: oldBudget, sender: "original", via: "panel" } } }, context);
		assert.equal(approval.runSender.get(conversation.id), "newer", "queuing must preserve the active run's sender");
		release!();
		await newer.wait(context);
		assert.equal((await continuation.wait(context)).status, "done");
		assert.equal(approval.runSender.get(conversation.id), "original");
		assert.equal(approval.runVia.get(conversation.id), "panel");
		assert.equal(executions, 1, "the original sender's approval window must authorize its own continuation");
		assert.equal(approval.pendingApprovals.has(`${conversation.id}:newer`), false);
	} finally { release!(); approval.setApprovalBudgetGetter(() => undefined); await s.close(); }
});

test("approval attribution save failure stops before the provider or a dangerous tool", { timeout: 5000 }, async () => {
	let harness: Harness | undefined;
	let executions = 0;
	const s = await setup({ responses: [fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf output" }), { stopReason: "toolUse" }), text()], extensions: () => [approval.makeApprovalExtension(() => harness), defineExtension({ name: "fake-bash-failure", tools: [defineTool({ name: "bash", description: "Fake shell without side effects", parameters: Type.Object({ command: Type.String() }), async execute() { executions++; return { output: [] }; } })] })] });
	harness = s.harness;
	try {
		const conversation = await s.conversation();
		await approval.setRunAttribution(conversation.id, "newer", "feishu");
		await mkdir(join(approvalStateDir, "approvals.json.tmp"));
		const result = await (await conversation.submit({ type: "input", content: "legacy approval", entry: { kind: "dwell.approval.legacy", data: { sender: "original", via: "panel" } } }, context)).wait(context);
		assert.equal(result.status, "unanswered");
		assert.equal(s.faux.state.callCount, 0);
		assert.equal(executions, 0);
		assert.equal(approval.runSender.get(conversation.id), "newer");
	} finally { await rm(join(approvalStateDir, "approvals.json.tmp"), { recursive: true, force: true }); await s.close(); }
});

test("parent and background child use independent conversation allowances", { timeout: 5000 }, async () => {
	const s = await setup({ limits: { modelAdmissions: 1 }, responses: [call(), text()], extensions: () => [workExtension(() => {}), defineExtension({ name: "anchor", tasks: [BackgroundAnchor] })] });
	try {
		const parent = await s.conversation();
		const childId = await parent.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			return (await tx.createConversation({ ownership: { kind: "task", taskId: anchor } })).id;
		}, context);
		await (await parent.submit({ type: "input", content: "exhaust parent" }, context)).wait(context);
		assert.equal(await s.budget.stopReason(parent.id), "model_limit");
		const child = await s.harness.conversation(childId, context);
		const result = await (await child!.submit({ type: "input", content: "child" }, context)).wait(context);
		assert.equal(result.status, "done");
		assert.equal(await s.budget.stopReason(childId), undefined);
		assert.notDeepEqual(await s.budget.current(parent.id), await s.budget.current(childId));
	} finally { await s.close(); }
});

test("watchdog aborts a slow model and an old watchdog does not abort a later run", { timeout: 5000 }, async () => {
	const s = await setup({ limits: { executionMs: 90 }, responses: [text(), async (_context, options) => { await new Promise<void>((resolve) => { options?.signal?.addEventListener("abort", () => resolve(), { once: true }); }); return text(); }, text()] });
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "fast" }, context)).wait(context);
		const second = await conversation.submit({ type: "input", content: "slow" }, context);
		const result = await second.wait(context);
		assert.equal(result.status, "unanswered");
		assert.equal(await s.budget.stopReason(conversation.id), "execution_limit");
		await (await conversation.submit({ type: "input", content: "later" }, context)).wait(context);
		assert.equal(s.faux.state.callCount, 3);
		assert.equal(await s.budget.stopReason(conversation.id), undefined);
	} finally { await s.close(); }
});

test("watchdog aborts a slow tool through its generation owner", { timeout: 5000 }, async () => {
	let aborted = false;
	const s = await setup({ limits: { executionMs: 80 }, responses: [call()], extensions: () => [defineExtension({ name: "slow-tool", tools: [defineTool({ name: "work", description: "Slow work", parameters: Type.Object({}), async execute(_args, _api, invocation) {
		await new Promise<void>((resolve) => invocation.abortSignal!.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
		invocation.abortSignal!.throwIfAborted();
		return { output: [] };
	} })] })] });
	try {
		const conversation = await s.conversation();
		const result = await (await conversation.submit({ type: "input", content: "slow tool" }, context)).wait(context);
		assert.equal(result.status, "unanswered");
		assert.equal(aborted, true);
		assert.equal(await s.budget.stopReason(conversation.id), "execution_limit");
	} finally { await s.close(); }
});

test("compaction declines an exhausted live run while idle manual compaction remains available", { timeout: 5000 }, async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const s = await setup({ limits: { modelAdmissions: 1, executionMs: 2000 }, responses: [async () => { await gate; return text(); }, text()] });
	try {
		const conversation = await s.conversation();
		for (let i = 0; i < 4; i++) await conversation.submit({ type: "write", entry: { kind: "fixture.message", model: [{ role: "user", content: `Old context ${i}: ${"word ".repeat(100)}`, timestamp: Date.now() }] } }, context);
		const run = await conversation.submit({ type: "input", content: "slow request" }, context);
		await until(() => s.faux.state.callCount === 1);
		const compact = await conversation.compact("", context);
		await s.harness.waitForTask(compact, context);
		assert.equal(s.faux.state.callCount, 1, "an exhausted live generation cannot start a summary request");
		release!(); await run.wait(context);
		const idleCompact = await conversation.compact("", context);
		await s.harness.waitForTask(idleCompact, context);
		assert.equal(s.faux.state.callCount, 2, "normal manual compaction remains available outside a live run");
	} finally { release!(); await s.close(); }
});

test("execution deadline aborts a live background compaction as well as its generation", { timeout: 5000 }, async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	let generationStarted!: () => void;
	let compactionStarted!: () => void;
	const generationEntered = new Promise<void>((resolve) => { generationStarted = resolve; });
	const compactionEntered = new Promise<void>((resolve) => { compactionStarted = resolve; });
	const phases: string[] = [];
	let compactAborted = false;
	const waitForAbort: FauxResponseStep = async (_context, options) => {
		await new Promise<void>((resolve) => {
			options!.signal!.addEventListener("abort", () => resolve(), { once: true });
			if (options!.signal!.aborted) resolve();
		});
		return text();
	};
	const s = await setup({ limits: { executionMs: 120 }, responses: [
		async (input, options, state, model) => {
			const aborted = waitForAbort(input, options, state, model);
			phases.push("generation entered"); generationStarted();
			return aborted;
		},
		async (input, options, state, model) => {
			const aborted = waitForAbort(input, options, state, model);
			phases.push("compaction entered"); compactionStarted();
			const message = await aborted;
			compactAborted = options!.signal!.aborted;
			phases.push("compaction aborted");
			return message;
		},
	] });
	try {
		const conversation = await s.conversation();
		for (let i = 0; i < 4; i++) await conversation.submit({ type: "write", entry: { kind: "fixture.message", model: [{ role: "user", content: `Old context ${i}: ${"word ".repeat(100)}`, timestamp: Date.now() }] } }, context);
		const run = await conversation.submit({ type: "input", content: "slow request" }, context);
		await generationEntered;
		const compact = await conversation.compact("", context);
		await compactionEntered;
		assert.equal((await run.status(context)).status, "placed");
		assert.equal((await s.harness.getTask(compact, context))?.state.status, "running");
		// Keep setup outside the deadline: slow CI must not turn this into an idle manual compaction.
		now += 120;
		phases.push("deadline advanced");
		assert.equal((await run.wait(context)).status, "unanswered");
		const settled = await s.harness.waitForTask(compact, context);
		assert.equal(settled.state.outcome.status, "aborted");
		assert.equal(compactAborted, true);
		assert.deepEqual(phases, ["generation entered", "compaction entered", "deadline advanced", "compaction aborted"]);
		t.diagnostic(phases.join(" -> "));
	} finally { await s.close(); t.mock.restoreAll(); }
});

test("initial threshold compaction starts the deadline before the first generation admission", { timeout: 5000 }, async () => {
	const s = await setup({ contextWindow: 1000, limits: { executionMs: 90 }, responses: [async (_context, options) => { await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true })); return text(); }] });
	try {
		const conversation = await s.conversation();
		for (let i = 0; i < 4; i++) await conversation.submit({ type: "write", entry: { kind: "fixture.message", model: [{ role: "user", content: `Old context ${i}: ${"word ".repeat(500)}`, timestamp: Date.now() }] } }, context);
		const run = await conversation.submit({ type: "input", content: "requires compaction first" }, context);
		await until(() => s.faux.state.callCount === 1);
		const before = await s.harness.snapshot(BudgetDoc, conversation.id, context);
		assert.equal(before!.records[before!.current!]!.modelAdmissions, 0, "the in-flight request is a summary, not a generation request");
		assert.ok(before!.records[before!.current!]!.activeSince !== undefined);
		assert.equal((await run.wait(context)).status, "unanswered");
		assert.equal(await s.budget.stopReason(conversation.id), "execution_limit");
	} finally { await s.close(); }
});

test("closed controller retains active state; expired restart stops before another provider request", { timeout: 5000 }, async () => {
	const s = await setup({ limits: { executionMs: 80 }, responses: [async (_context, options) => { await new Promise<void>((resolve) => { options?.signal?.addEventListener("abort", () => resolve(), { once: true }); }); return text(); }] });
	let reopened: Awaited<ReturnType<typeof setup>> | undefined;
	try {
		const conversation = await s.conversation();
		const first = await conversation.submit({ type: "input", content: "slow" }, context);
		await until(() => s.faux.state.callCount === 1);
		const budgetId = (await s.budget.current(conversation.id))!.budgetId;
		await s.close(true);
		await new Promise((resolve) => setTimeout(resolve, 100));
		reopened = await setup({ path: s.path });
		assert.equal(reopened.faux.state.callCount, 0, "attach must preserve paused scheduling before credential scrubbing");
		const retained = await reopened.harness.snapshot(BudgetDoc, conversation.id, context);
		assert.equal(retained?.records[budgetId]?.modelAdmissions, 1);
		assert.ok(retained?.records[budgetId]?.activeSince !== undefined);
		const submission = await reopened.harness.submission(first.id, context);
		assert.ok(submission);
		await submission.wait(context);
		assert.equal(reopened.faux.state.callCount, 0);
		assert.equal(await reopened.budget.stopReason(conversation.id), "execution_limit");
	} finally { if (reopened) await reopened.close(); await rm(join(s.path, ".."), { recursive: true, force: true }); }
});

test("direct Harness.close automatically drains budget subscriptions", { timeout: 5000 }, async () => {
	const s = await setup();
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "finish" }, context)).wait(context);
		await s.harness.close(context);
		await s.budget.close();
	} finally { await s.close(); }
});

test("SIGKILL after provider admission preserves the debit and frozen limits", { timeout: 8000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-budget-kill-"));
	const path = join(dir, "s.sqlite");
	const child = spawn(process.execPath, [fileURLToPath(new URL("./budget-crash-child.ts", import.meta.url)), path], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
	let stderr = "";
	child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
	let reopened: Awaited<ReturnType<typeof setup>> | undefined;
	try {
		const conversationId = await new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`No provider boundary: ${stderr}`)), 4000);
			child.once("message", (message) => { clearTimeout(timer); resolve((message as { conversationId: number }).conversationId); });
			child.once("error", reject);
			child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${stderr}`)); });
		});
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL"); await exited;
		reopened = await setup({ path, limits: { modelAdmissions: 99 }, responses: [call(), text()], extensions: () => [workExtension(() => {})] });
		const before = await reopened.harness.snapshot(BudgetDoc, conversationId as ConversationId, context);
		const budgetId = before!.current!;
		assert.equal(before!.records[budgetId]!.modelAdmissions, 1);
		assert.equal(before!.records[budgetId]!.limits.modelAdmissions, 2);
		const conversation = await reopened.harness.conversation(conversationId as ConversationId, context);
		assert.ok(conversation);
		await conversation.waitForIdle(context);
		assert.equal(reopened.faux.state.callCount, 1, "recovery spends admission two, then the next request is rejected");
		assert.equal(await reopened.budget.stopReason(conversationId), "model_limit");
		const after = await reopened.harness.snapshot(BudgetDoc, conversationId as ConversationId, context);
		assert.equal(after!.records[budgetId]!.modelAdmissions, 2);
	} finally { child.kill("SIGKILL"); if (reopened) await reopened.close(); await rm(dir, { recursive: true, force: true }); }
});

test("storage admission failure never reaches the provider", { timeout: 5000 }, async () => {
	const s = await setup();
	const original = s.harness.commit.bind(s.harness);
	try {
		const conversation = await s.conversation();
		s.harness.commit = async () => { throw new Error("injected budget storage failure"); };
		await (await conversation.submit({ type: "input", content: "fail" }, context)).wait(context);
		assert.equal(s.faux.state.callCount, 0);
		assert.equal(await s.budget.stopReason(conversation.id), "storage_error");
	} finally { s.harness.commit = original; await s.close(); }
});

test("a finished run releases its watchdog instead of sleeping to the deadline", { timeout: 5000 }, async () => {
	const s = await setup({ limits: { executionMs: 60_000 } });
	try {
		const conversation = await s.conversation();
		await (await conversation.submit({ type: "input", content: "quick" }, context)).wait(context);
		// The watchdog is created on the first admission; after the run settles, reconcile must abort it
		// instead of leaving a sleeping task in the graph for the rest of the execution budget.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const tasks = await s.harness.taskGraph?.(context);
		try {
			const sleeping = Object.values(tasks?.value.tasks ?? {}).filter((t) => t.kind === "dwell.budget-watch");
			assert.equal(sleeping.length, 0);
		} finally { tasks?.dispose(); }
	} finally { await s.close(); }
});
