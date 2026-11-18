import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { BackgroundAnchor } from "../src/ext/background.ts";
import { makeWorkspaceExtension, registerBackgroundWorkspace, registerLegacyWorkspaces, setWorkspaceApprovalGetter, WorkspaceDoc } from "../src/workspace.ts";

const Hold = defineTask<null, { phase: "hold" }, null>({
	name: "test.history-holder", version: 1, initial: () => ({ phase: "hold" }),
	phases: { hold: (_task, runtime, ctx) => runtime.sleepUntil(Date.now() + 60_000, { phase: "hold" }, ctx) },
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

for (const registered of [true, false]) test(`missing terminal historical workspace does not block unrelated runs (${registered ? "registered" : "legacy"})`, { timeout: 10_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-history-"));
	const old = join(directory, "old"); await mkdir(old);
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	const models = createModels(); models.setProvider(faux.provider);
	let harness!: Harness;
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(makeWorkspaceExtension(() => harness));
	registry.install(defineExtension({ name: "history-fixtures", tasks: [BackgroundAnchor, Hold] }));
	const open = async () => { harness = await Harness.open(await openNodeSqliteStorage(join(directory, "s.sqlite")), { models, registry, env: async ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? directory }) }, context); };
	await open();
	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd: old, model: { provider: "faux", modelId: "faux-1" } } }, context);
		const child = await parent.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			if (registered) await registerBackgroundWorkspace(tx, parent.id, child.id, "read", old, anchor);
			return { id: child.id, anchor };
		}, context);
		await harness.waitForTask(child.anchor, context);
		await harness.close(context); await rm(old, { recursive: true }); await open();
		await registerLegacyWorkspaces(harness);
		const access = (await harness.snapshot(WorkspaceDoc, context))?.children[String(child.id)];
		assert.equal(access?.mode, "read");
		if (!registered) assert.equal(access?.stopped, true, "a missing legacy workspace stays quarantined if its path is recreated");
		const restored = (await harness.conversation(child.id, context))!;
		const missingBefore = faux.state.callCount;
		const missingRun = await (await restored.submit({ type: "input", content: "directory still missing" }, context)).wait(context);
		assert.equal(missingRun.status, "unanswered"); assert.equal(faux.state.callCount, missingBefore);
		const unrelated = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd: directory, model: { provider: "faux", modelId: "faux-1" } } }, context);
		faux.setResponses([fauxAssistantMessage(fauxText("unrelated runs"))]);
		assert.equal((await (await unrelated.submit({ type: "input", content: "hello" }, context)).wait(context)).status, "done");
		await mkdir(old);
		const before = faux.state.callCount;
		faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: "unsafe.txt", content: "unsafe" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("done"))]);
		const settled = await (await restored.submit({ type: "input", content: "try to write" }, context)).wait(context);
		if (!registered) { assert.equal(settled.status, "unanswered"); assert.equal(faux.state.callCount, before); }
		await assert.rejects(readFile(join(old, "unsafe.txt")), { code: "ENOENT" });
	} finally { await harness.close(context); await rm(directory, { recursive: true, force: true }); }
});

for (const active of ["task", "approval", "unknown-writer"] as const) test(`an unregistered child with ${active} and a missing directory fails closed`, { timeout: 10_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-active-history-"));
	const old = join(directory, "old"); await mkdir(old);
	let harness!: Harness;
	const registry = createRegistry(); registry.install(defineExtension({ name: "active-history", tasks: [BackgroundAnchor, Hold] }));
	const open = async () => { harness = await Harness.open(await openNodeSqliteStorage(join(directory, "s.sqlite")), { models: createModels(), registry }, context); };
	await open();
	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd: old } }, context);
		const child = await parent.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			if (active === "task") await tx.createTask(Hold, null, { ownership: { kind: "conversation" }, background: true, conversationId: child.id });
			if (active === "unknown-writer") (await tx.doc(WorkspaceDoc)).writers[old] = { conversationId: child.id, reporterId: -1, workspace: old };
			return { id: child.id, anchor };
		}, context);
		await harness.waitForTask(child.anchor, context);
		if (active === "approval") setWorkspaceApprovalGetter((id) => id === child.id);
		await harness.close(context); await rm(old, { recursive: true }); await open();
		await assert.rejects(registerLegacyWorkspaces(harness), { code: "ENOENT" });
	} finally { setWorkspaceApprovalGetter(() => false); await harness.close(context); await rm(directory, { recursive: true, force: true }); }
});
