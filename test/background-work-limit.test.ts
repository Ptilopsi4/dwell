import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { makeBudgetController } from "../src/ext/budget.ts";

const directory = await mkdtemp(join(tmpdir(), "dwell-bg-work-limit-"));
process.env.DWELL_STATE = join(directory, "state");
const workModule = await import("../src/ext/work.ts");
const { getWork, inheritWork, makeWorkController, workBudgetStopReason, workIdentity, WorkDoc } = workModule;
const { BackgroundAnchor, BackgroundDoc, makeBackgroundExtension, makeBackgroundReporter } = await import("../src/ext/background.ts");
after(() => rm(directory, { recursive: true, force: true }));
const done = () => fauxAssistantMessage(fauxText("done"));
const call = (name: string, args = {}) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const actor = { kind: "chat.message", data: { sender: "owner", via: "panel" } };
const until = async (check: () => boolean | Promise<boolean>) => {
	for (const deadline = Date.now() + 5000; !await check();) {
		if (Date.now() > deadline) throw new Error("Work limit test timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

for (const reason of ["model_limit", "tool_limit"] as const) test(`shared ${reason} produces one durable parent report without another provider request`, { timeout: 10_000 }, async () => {
	const work = makeWorkController({ limits: reason === "model_limit" ? { modelAdmissions: 2 } : { toolAdmissions: 1 } });
	const budget = makeBudgetController();
	let harness!: Harness; let parentId: number | undefined; let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const fired: SubmissionId[] = []; let probes = 0;
	const deps = {
		getHarness: () => harness, senderOf: () => "owner", viaOf: () => "panel" as const, forbidden: () => [], onStarted: () => {},
		attribute: async (id: number) => { if (id !== parentId) await gate; },
		onFired: (_id: number, submission: SubmissionId) => { fired.push(submission); },
		budgetStopReason: (id: number, budgetId?: string) => budget.stopReason(id, budgetId),
	};
	const registry = createRegistry(); registry.install(budget.extension); registry.install(work.extension); registry.install(makeBackgroundExtension(deps));
	registry.install(defineExtension({ name: "limit-probe", tools: [defineTool({ name: "probe", description: "Offline observable check", parameters: Type.Object({}), execute: async () => { probes++; return { output: [] }; } })] }));
	const faux = fauxProvider({ tokensPerSecond: 100_000 }); const models = createModels(); models.setProvider(faux.provider);
	const open = async () => { harness = await Harness.open(await openNodeSqliteStorage(join(directory, `${reason}.sqlite`)), { models, registry }, context); };
	await open(); await budget.attach(harness); await work.attach(harness);
	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context); parentId = parent.id;
		faux.setResponses([call("dwell.work", { action: "start", goal: "Inspect existing material", acceptance: ["Return an inspection"] }), done()]);
		await (await parent.submit({ type: "input", content: "start", entry: actor }, context)).wait(context);
		const child = await parent.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			await inheritWork(tx, parent.id, child.id);
			(await tx.doc(BackgroundDoc, parent.id)).agents.worker = { conversationId: child.id };
			const reporter = await tx.createTask(makeBackgroundReporter(deps), { name: "worker", parent: parent.id, child: child.id, message: "read", creator: "owner", creatorVia: "panel", work: await workIdentity(tx, child.id), followUp: false }, { ownership: { kind: "conversation" }, background: true });
			return { id: child.id, reporter };
		}, context);
		faux.setResponses([call("dwell.task.wait"), ...(reason === "tool_limit" ? [call("probe")] : []), done()]);
		await (await parent.submit({ type: "input", content: "wait", entry: actor }, context)).wait(context);
		release(); await harness.waitForTask(child.reporter, context);
		const record = await getWork(harness, parent.id); assert.equal(record.records[record.current!]!.stopped, reason);
		assert.equal(fired.length, 1, "the host must receive the parent failure presentation through onFired");
		const report = (await parent.entries({}, 100, undefined, context)).items.filter((entry) => entry.kind === "chat.message" && typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data) && entry.data.via === "background");
		assert.equal(report.length, 1); assert.match(JSON.stringify(report), new RegExp(reason));
		const outcome = await (await harness.submission(fired[0]!, context))!.wait(context);
		assert.ok(outcome.status === "unanswered" && outcome.reason === "aborted");
		assert.equal(await workBudgetStopReason(harness, parent.id, `${parent.id}:${fired[0]}`), reason);
		assert.equal(faux.state.callCount, reason === "model_limit" ? 3 : 4); assert.equal(probes, 0);
		await harness.close(context); await open();
		await harness.waitForTask(child.reporter, context);
		assert.equal(fired.length, 1); assert.equal(faux.state.callCount, reason === "model_limit" ? 3 : 4);
	} finally { release(); await budget.close(); await work.close(); await harness.close(context); }
});

test("a work-limit report interrupted during onFired reuses its parent submission after restart", { timeout: 10_000 }, async () => {
	const faux = fauxProvider({ tokensPerSecond: 100_000 }); const models = createModels(); models.setProvider(faux.provider);
	let harness!: Harness; let budget!: ReturnType<typeof makeBudgetController>; let work!: ReturnType<typeof makeWorkController>;
	let release!: () => void; const firedGate = new Promise<void>((resolve) => { release = resolve; });
	const fired: SubmissionId[] = [];
	const deps = {
		getHarness: () => harness, senderOf: () => "owner", viaOf: () => "panel" as const, forbidden: () => [], onStarted: () => {}, attribute: async () => {},
		onFired: async (_id: number, submission: SubmissionId) => { fired.push(submission); if (fired.length === 1) await firedGate; },
		budgetStopReason: (id: number, budgetId?: string) => budget.stopReason(id, budgetId),
	};
	const open = async () => {
		budget = makeBudgetController(); work = makeWorkController();
		const registry = createRegistry(); registry.install(budget.extension); registry.install(work.extension); registry.install(makeBackgroundExtension(deps));
		harness = await Harness.open(await openNodeSqliteStorage(join(directory, "interrupted-report.sqlite")), { models, registry }, context);
		await budget.attach(harness); await work.attach(harness);
	};
	await open();
	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
		faux.setResponses([call("dwell.work", { action: "start", goal: "Inspect material", acceptance: ["Return a result"] }), done()]);
		await (await parent.submit({ type: "input", content: "start", entry: actor }, context)).wait(context);
		const reporter = await parent.commit(async (tx) => {
			const doc = await tx.doc(WorkDoc, parent.id); const record = doc.records[doc.current!]!;
			record.limits.modelAdmissions = record.usage.modelAdmissions;
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			await inheritWork(tx, parent.id, child.id);
			return tx.createTask(makeBackgroundReporter(deps), { name: "worker", parent: parent.id, child: child.id, message: "read", creator: "owner", creatorVia: "panel", work: await workIdentity(tx, child.id), followUp: false }, { ownership: { kind: "conversation" }, background: true });
		}, context);
		harness.resume(); await until(() => fired.length === 1);
		const first = await (await harness.submission(fired[0]!, context))!.wait(context);
		assert.ok(first.status === "unanswered" && first.reason === "aborted");
		await budget.close(); await work.close(); await harness.close(context); await open();
		await harness.waitForTask(reporter, context);
		assert.deepEqual(fired, [fired[0], fired[0]], "onFired retries the same durable input after an interrupted presentation");
		const restored = (await harness.conversation(parent.id, context))!;
		const entries = (await restored.entries({}, 100, undefined, context)).items;
		assert.equal(entries.filter((entry) => entry.kind === "chat.message" && JSON.stringify(entry.data).includes('"via":"background"')).length, 1);
		assert.equal(faux.state.callCount, 2, "neither the child nor either parent report attempt can consume another provider request");
	} finally { release(); await budget.close(); await work.close(); await harness.close(context); }
});

test("a run budget stop before work binding does not borrow the current work's reason", { timeout: 5000 }, async () => {
	const budget = makeBudgetController({ limits: { modelAdmissions: 0 } });
	const work = makeWorkController();
	const registry = createRegistry(); registry.install(budget.extension); registry.install(work.extension);
	const faux = fauxProvider({ tokensPerSecond: 100_000 }); const models = createModels(); models.setProvider(faux.provider);
	const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "before-bind.sqlite")), { models, registry }, context);
	await budget.attach(harness); await work.attach(harness);
	try {
		const root = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
		await harness.commit(async (tx) => {
			const doc = await tx.doc(WorkDoc, root.id); doc.current = "old";
			doc.records.old = { stopped: "tool_limit" } as typeof doc.records[string];
		}, context);
		const submission = await root.submit({ type: "input", content: "stopped before bind", entry: actor }, context);
		const settled = await submission.wait(context); assert.ok(settled.status === "unanswered" && settled.reason === "aborted");
		assert.equal(await budget.stopReason(root.id, `${root.id}:${submission.id}`), "model_limit");
		assert.equal(await workBudgetStopReason(harness, root.id, `${root.id}:${submission.id}`), undefined);
		assert.equal(faux.state.callCount, 0);
	} finally { await budget.close(); await work.close(); await harness.close(context); }
});

test("work stop lookup stays bound to its input and returns no reason before work admission", async () => {
	const registry = createRegistry(); const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "lookup.sqlite")), { models: createModels(), registry }, context);
	try {
		const root = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		await harness.commit(async (tx) => {
			const doc = await tx.doc(WorkDoc, root.id);
			doc.current = "new";
			doc.runs["123"] = { conversationId: root.id, id: "old" };
			doc.runs["124"] = null;
			doc.records.old = { stopped: "tool_limit" } as typeof doc.records[string];
			doc.records.new = { stopped: "model_limit" } as typeof doc.records[string];
		}, context);
		assert.equal(await workBudgetStopReason(harness, root.id, `${root.id}:123`), "tool_limit");
		for (const key of [`${root.id}:124`, `${root.id}:125`, "invalid", `${root.id + 1}:123`]) assert.equal(await workBudgetStopReason(harness, root.id, key), undefined);
	} finally { await harness.close(context); }
});
