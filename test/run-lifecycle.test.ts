import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, LiveDoc, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";

const directory = await mkdtemp(join(tmpdir(), "dwell-lifecycle-"));
process.env.DWELL_STATE = join(directory, "state");
await mkdir(process.env.DWELL_STATE);
const approval = await import("../src/ext/approval.ts");
const bg = await import("../src/ext/background.ts");
const workspace = await import("../src/workspace.ts");
const schedule = await import("../src/ext/schedule.ts");
after(() => rm(directory, { recursive: true, force: true }));

const done = () => fauxAssistantMessage(fauxText("done"));
const dangerous = () => fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf output" }), { stopReason: "toolUse" });
const entry = (sender: string) => ({ kind: "chat.message", data: { sender, via: "panel" } });
const until = async (check: () => boolean | Promise<boolean>) => {
	for (const deadline = Date.now() + 5000; !await check();) {
		if (Date.now() > deadline) throw new Error("Lifecycle test timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};
const gate = () => {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
};

async function setup(name: string, responses: FauxResponseStep[], withApproval = true) {
	approval.approvals.clear(); approval.pendingApprovals.clear(); approval.approvalDecisions.clear(); approval.runSender.clear(); approval.runVia.clear(); approval.conversationScope.clear();
	await approval.persistApprovals();
	const faux = fauxProvider({ tokensPerSecond: 100_000 }); faux.setResponses(responses);
	const models = createModels(); models.setProvider(faux.provider);
	let harness: Harness;
	let executed = 0;
	const fired: SubmissionId[] = [];
	const deps = {
		attribute: async (id: number, creator: string) => {
			if ((await harness.snapshot(LiveDoc, id as ConversationId, context))?.run === undefined) await approval.setRunAttribution(id, creator, "panel");
		},
		onFired: (_id: number, submission: SubmissionId) => { fired.push(submission); },
		onStarted: (child: number, parent: number) => { approval.conversationScope.set(child, parent); },
		getHarness: () => harness,
		senderOf: () => "alice", viaOf: () => "panel" as const, forbidden: () => [],
	};
	const registry = createRegistry();
	if (withApproval) registry.install(approval.makeApprovalExtension(() => harness));
	registry.install(bg.makeBackgroundExtension(deps));
	registry.install(schedule.makeScheduleExtension(deps));
	registry.install(workspace.makeWorkspaceExtension(() => harness));
	registry.install(defineExtension({ name: "lifecycle-fake-shell", tools: [defineTool({ name: "bash", description: "Count calls without shell side effects", parameters: Type.Object({ command: Type.String() }), execute: async () => { executed++; return { output: [] }; } })] }));
	const open = async () => { harness = await Harness.open(await openNodeSqliteStorage(join(directory, `${name}.sqlite`)), { models, registry }, context); return harness; };
	await open();
	const conversation = () => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory } }, context);
	return { get harness() { return harness; }, open, conversation, faux, deps, fired, executions: () => executed };
}

test("a schedule queued behind Bob restores Alice before checking Bob's approval window", { timeout: 10_000 }, async () => {
	const held = gate();
	const s = await setup("schedule-actor", [async () => { await held.promise; return done(); }, dangerous(), done()]);
	try {
		const parent = await s.conversation();
		approval.approvals.set(`${parent.id}:bob`, Date.now() + 60_000);
		const current = await parent.submit({ type: "input", content: "Bob's task", entry: entry("bob") }, context);
		await until(() => s.faux.state.callCount === 1);
		await parent.commit((tx) => tx.createTask(schedule.makeScheduleRunTask(s.deps), { id: "alice", conversationId: parent.id, creator: "alice", creatorVia: "panel", instruction: "Alice's task", firstAt: Date.now(), tz: "UTC" }, { ownership: { kind: "conversation" }, background: true }), context);
		await until(() => s.fired.length === 1);
		const queued = (await s.harness.submission(s.fired[0]!, context))!;
		assert.equal((await queued.status(context)).status, "queued");
		assert.equal(approval.runSender.get(parent.id), "bob");
		held.release(); await current.wait(context); await queued.wait(context);
		assert.equal(approval.runSender.get(parent.id), "alice");
		assert.equal(s.executions(), 0);
		assert.ok(approval.pendingApprovals.has(`${parent.id}:alice`));
	} finally { held.release(); await s.harness.close(context); }
});

test("queued ordinary input changes the actor, while steering retains the first input's actor", { timeout: 10_000 }, async () => {
	for (const mode of ["steer", "followUp"] as const) {
		const held = gate();
		const s = await setup(`ordinary-${mode}`, [async () => { await held.promise; return mode === "steer" ? dangerous() : done(); }, mode === "steer" ? done() : dangerous(), done()]);
		try {
			const parent = await s.conversation();
			const first = await parent.submit({ type: "input", content: "Bob", entry: entry("bob") }, context);
			await until(() => s.faux.state.callCount === 1);
			const second = await parent.submit({ type: "input", content: "Alice", entry: entry("alice"), whenBusy: mode }, context);
			held.release(); await first.wait(context); await second.wait(context);
			assert.equal(approval.runSender.get(parent.id), mode === "steer" ? "bob" : "alice");
			assert.ok(approval.pendingApprovals.has(`${parent.id}:${mode === "steer" ? "bob" : "alice"}`));
			assert.equal(s.executions(), 0);
		} finally { held.release(); await s.harness.close(context); }
	}
});

test("missing durable actor cannot reuse the previous run's approval", { timeout: 5000 }, async () => {
	const s = await setup("missing-actor", [dangerous(), done()]);
	try {
		const parent = await s.conversation();
		await approval.setRunAttribution(parent.id, "previous", "panel");
		approval.approvals.set(`${parent.id}:previous`, Date.now() + 60_000);
		const result = await (await parent.submit({ type: "input", content: "legacy missing actor" }, context)).wait(context);
		assert.equal(result.status, "unanswered");
		assert.equal(s.faux.state.callCount, 0);
		assert.equal(s.executions(), 0);
	} finally { await s.harness.close(context); }
});

test("tool admission restores the durable actor after a late attribution write", { timeout: 5000 }, async () => {
	const held = gate();
	const s = await setup("tool-actor", [async () => { await held.promise; return dangerous(); }, done()]);
	try {
		const parent = await s.conversation();
		const submission = await parent.submit({ type: "input", content: "Alice", entry: entry("alice") }, context);
		await until(() => s.faux.state.callCount === 1);
		await approval.setRunAttribution(parent.id, "bob", "panel");
		approval.approvals.set(`${parent.id}:bob`, Date.now() + 60_000);
		held.release(); await submission.wait(context);
		assert.equal(s.executions(), 0);
		assert.ok(approval.pendingApprovals.has(`${parent.id}:alice`));
		assert.equal(approval.runSender.get(parent.id), "alice");
	} finally { held.release(); await s.harness.close(context); }
});

test("approval Reporter capacity failures remain pending and retry after capacity is freed", { timeout: 10_000 }, async () => {
	const s = await setup("approval-cap", Array.from({ length: 30 }, done), false);
	try {
		const parent = await s.conversation(); const other = await s.conversation();
		const makeChild = (owner: typeof parent, name: string) => owner.commit(async (tx) => {
			const anchor = await tx.createTask(bg.BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			(await tx.doc(bg.BackgroundDoc, owner.id)).agents[name] = { conversationId: child.id };
			await workspace.registerBackgroundWorkspace(tx, owner.id, child.id, "read", directory, anchor);
			return child.id;
		}, context);
		const child = await makeChild(parent, "waiter");
		const reporters = [];
		for (let i = 0; i < 6; i++) {
			const owner = i < 3 ? parent : other;
			const reader = await makeChild(owner, `reader-${i}`);
			reporters.push(await owner.commit((tx) => tx.createTask(bg.makeBackgroundReporter(s.deps), { name: `reader-${i}`, parent: owner.id, child: reader, creator: "alice", creatorVia: "panel", message: "read", followUp: false }, { ownership: { kind: "conversation" }, background: true }), context));
		}
		approval.pendingApprovals.set(`${parent.id}:alice`, { command: "rm -rf output", match: "rm", trigger: "alice", via: "panel", targets: [child] });
		const decision = (await approval.takeDecision(`${parent.id}:alice`, "approve", 10))!;
		const deliverer = bg.makeBackgroundDeliverer(s.deps, () => s.harness);
		const deliver = async () => await deliverer.deliver(parent.id, child, "approved", { deliveryId: decision.id, sender: "alice", via: "panel", action: "approve" }) ? "accepted" as const : "unavailable" as const;
		assert.deepEqual(await approval.drainApprovalDecisions(deliver, decision.id), { pending: 1, unavailable: 0 });
		assert.equal((await s.harness.commit((tx) => schedule.scanLiveTasks(tx, { kind: bg.BACKGROUND_REPORTER_KIND }), context)).length, 6);
		assert.deepEqual((await s.harness.snapshot(bg.BackgroundDeliveryDoc, parent.id, context))?.receipts ?? {}, {});
		for (const reporter of reporters) await s.harness.abortTask(reporter, context);
		for (const reporter of reporters) await s.harness.waitForTask(reporter, context);
		assert.deepEqual(await approval.drainApprovalDecisions(deliver, decision.id), { pending: 0, unavailable: 0 });
		assert.equal(await deliver(), "accepted", "duplicate delivery retains its original receipt");
		assert.equal(Object.keys((await s.harness.snapshot(bg.BackgroundDeliveryDoc, parent.id, context))!.receipts).length, 1);
	} finally { await s.harness.close(context); }
});

test("a legacy child marked stopped only in the workspace doc is refused as an approval target instead of retrying forever", { timeout: 10_000 }, async () => {
	const s = await setup("legacy-stopped", Array.from({ length: 4 }, done), false);
	try {
		const parent = await s.conversation();
		const child = await parent.commit(async (tx) => {
			const anchor = await tx.createTask(bg.BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			(await tx.doc(bg.BackgroundDoc, parent.id)).agents["legacy"] = { conversationId: conversation.id };
			// 遗留隔离子会话：WorkspaceDoc 标 stopped，但从未经过 dwell.task stop（无 StopDoc 记录）
			(await tx.doc(workspace.WorkspaceDoc)).children[String(conversation.id)] = { parent: parent.id, mode: "read", workspace: directory, stopped: true, stopComplete: true };
			return conversation.id;
		}, context);
		approval.pendingApprovals.set(`${parent.id}:alice`, { command: "rm -rf output", match: "rm", trigger: "alice", via: "panel", targets: [child] });
		const decision = (await approval.takeDecision(`${parent.id}:alice`, "approve", 10))!;
		const deliverer = bg.makeBackgroundDeliverer(s.deps, () => s.harness);
		const deliver = async () => await deliverer.deliver(parent.id, child, "approved", { deliveryId: decision.id, sender: "alice", via: "panel", action: "approve" }) ? "accepted" as const : "unavailable" as const;
		assert.deepEqual(await approval.drainApprovalDecisions(deliver, decision.id), { pending: 0, unavailable: 1 });
	} finally { await s.harness.close(context); }
});

test("restart after stop intent aborts old child work before any model request and finishes cleanup", { timeout: 10_000 }, async () => {
	const s = await setup("stop-restart", [done(), done()], false);
	try {
		const parent = await s.conversation();
		const child = await parent.commit(async (tx) => {
			const anchor = await tx.createTask(bg.BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			(await tx.doc(bg.BackgroundDoc, parent.id)).agents.writer = { conversationId: child.id };
			await workspace.registerBackgroundWorkspace(tx, parent.id, child.id, "write", directory, anchor);
			return child.id;
		}, context);
		const conversation = (await s.harness.conversation(child, context))!;
		const submission = await conversation.submit({ type: "input", content: "old work", entry: entry("alice") }, context);
		await parent.commit(async (tx) => {
			(await tx.doc(bg.BackgroundStopDoc, parent.id)).children[String(child)] = true;
			await workspace.markBackgroundWorkspaceStopped(tx, child);
		}, context);
		await s.harness.close(context);
		const before = s.faux.state.callCount;
		await s.open();
		await bg.reconcileBackgroundStops(s.harness);
		assert.equal(s.faux.state.callCount, before, "startup reconciliation must keep scheduling paused");
		assert.ok(Object.values((await s.harness.snapshot(workspace.WorkspaceDoc, context))!.writers).some((writer) => writer.conversationId === child), "lease remains until cancellation cleanup finishes");
		s.harness.resume();
		await (await s.harness.submission(submission.id, context))!.wait(context);
		await until(async () => (await s.harness.snapshot(bg.BackgroundDoc, parent.id, context))?.agents.writer === undefined);
		assert.equal(s.faux.state.callCount, before);
		assert.deepEqual((await s.harness.snapshot(workspace.WorkspaceDoc, context))!.writers, {});
		const stopped = (await s.harness.conversation(child, context))!;
		const rejected = await (await stopped.submit({ type: "input", content: "late old input", entry: entry("alice") }, context)).wait(context);
		assert.equal(rejected.status, "unanswered");
		assert.equal(s.faux.state.callCount, before);
	} finally { await s.harness.close(context); }
});
