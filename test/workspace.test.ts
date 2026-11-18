import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTask, defineTool, Harness, LiveDoc, type Conversation, type ConversationId, type JsonObject } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import { BackgroundAnchor, BackgroundDoc, makeBackgroundExtension, makeBackgroundReporter, type BackgroundDeps } from "../src/ext/background.ts";
import { canonicalWorkspace, makeWorkspaceExtension, registerBackgroundWorkspace, registerLegacyWorkspaces, setWorkspaceApprovalGetter, WorkspaceDoc } from "../src/workspace.ts";

const done = () => fauxAssistantMessage(fauxText("done"));
const calls = (...items: { name: string; args: JsonObject }[]) => fauxAssistantMessage(items.map((item, i) => fauxToolCall(item.name, item.args, { id: `call-${i}` })), { stopReason: "toolUse" });
const write = (path: string, content = "written") => ({ name: "write", args: { path, content } });
const start = (name: string, mode?: "read" | "write") => ({ name: "dwell.task", args: { action: "start", name, message: `worker:${name}`, ...(mode === undefined ? {} : { mode }) } });
const until = async (check: () => Promise<boolean> | boolean): Promise<void> => {
	for (const deadline = Date.now() + 5000; ;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error("Workspace test timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};
const missing = async (path: string) => assert.rejects(access(path), { code: "ENOENT" });
const submit = async (conversation: Conversation, content: string) => {
	const receipt = await (await conversation.submit({ type: "input", content }, context)).wait(context);
	assert.equal(receipt.status, "done", JSON.stringify(receipt));
};
const gate = () => {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
};
const userText = (messages: Parameters<FauxResponseFactory>[0]["messages"]) => messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).join("\n");

// A durable lease holder makes restart and terminal-state checks independent of model timing.
const Holder = defineTask<{ until: number; fail: boolean }, { phase: "wait" | "finish" }, null>({
	name: "test.workspace-holder", version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: (task, runtime, ctx) => runtime.sleepUntil(task.input.until, { phase: "finish" }, ctx),
		finish: (task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: task.input.fail ? { status: "failed", error: { message: "intentional test failure" } } : { status: "completed", result: null } }), ctx),
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

async function setup(options: { directory?: string; responder?: FauxResponseFactory; attribute?: BackgroundDeps["attribute"] } = {}) {
	const directory = options.directory ?? await mkdtemp(join(tmpdir(), "dwell-workspace-"));
	const cwd = join(directory, "work");
	await mkdir(cwd, { recursive: true });
	const started: number[] = [];
	const reports: string[] = [];
	const registry = createRegistry();
	let harness: Harness | undefined;
	let background: ReturnType<typeof makeBackgroundExtension>;
	const deps: BackgroundDeps = {
		getHarness: () => harness,
		attribute: options.attribute ?? (async () => {}), onFired: () => {},
		onStarted: (child) => { started.push(child); }, senderOf: () => "test-user", forbidden: () => [background],
	};
	background = makeBackgroundExtension(deps);
	const nested = defineTool({
		name: "dwell.proc.logs", description: "Test nested tool governance", parameters: Type.Object({}), replay: "safe",
		execute: (_args, api, ctx) => api.executeTool("write", { path: "nested.txt", content: "unsafe nested write" }, ctx),
	});
	registry.install(CodingTools);
	registry.install(background);
	registry.install(makeWorkspaceExtension(() => harness));
	registry.install(defineExtension({ name: "test-workspace", tools: [nested], tasks: [Holder] }));
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	faux.setResponses(Array.from({ length: 100 }, () => options.responder ?? (() => done())));
	const models = createModels(); models.setProvider(faux.provider);
	harness = await Harness.open(await openNodeSqliteStorage(join(directory, "s.sqlite")), {
		models, registry, env: async ({ cwd: workspace }) => new NodeExecutionEnv({ cwd: workspace ?? cwd }),
		onReport: (error) => reports.push(String(error)),
	}, context);
	await registerLegacyWorkspaces(harness);
	harness.resume();
	const active = harness;
	return {
		harness: active, cwd, directory, started, reports, background, deps,
		conversation: (workspace = cwd) => active.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workspace } }, context),
		child: async (parent: Conversation, mode: "read" | "write", holdUntil = Date.now() + 60_000, fail = false) => {
			const workspace = await canonicalWorkspace((await parent.agent(context)).cwd!);
			return parent.commit(async (tx) => {
				const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
				const holder = await tx.createTask(Holder, { until: holdUntil, fail }, { ownership: { kind: "conversation" }, background: true });
				await registerBackgroundWorkspace(tx, parent.id, child.id, mode, workspace, holder);
				return { child: child.id, holder };
			}, context);
		},
		close: async (keep = false) => { await active.close(context); if (!keep) await rm(directory, { recursive: true, force: true }); },
	};
}

test("default background tasks read files; unavailable, re-offered and nested mutations cannot change the workspace", { timeout: 15_000 }, async () => {
	let parentStep = 0; let childStep = 0;
	const s = await setup({ responder: (transcript) => {
		if (userText(transcript.messages).includes("worker:reader")) {
			if (childStep++ % 2 === 0) return calls(
				{ name: "read", args: { path: "seed.txt" } }, write("blocked.txt"),
				{ name: "edit", args: { path: "seed.txt", edits: [{ oldText: "original", newText: "changed" }] } },
				{ name: "bash", args: { command: "echo shell > shell.txt" } },
				{ name: "dwell.proc.logs", args: {} },
			);
			return done();
		}
		return parentStep++ === 0 ? calls(start("reader")) : done();
	} });
	try {
		await writeFile(join(s.cwd, "seed.txt"), "original");
		const parent = await s.conversation();
		await submit(parent, "parent:reader");
		await until(() => s.started.length === 1);
		const child = (await s.harness.conversation(s.started[0] as ConversationId, context))!;
		await until(async () => (await s.harness.snapshot(LiveDoc, child.id, context))?.run === undefined && childStep >= 2);
		assert.deepEqual((await child.agent(context)).tools.map((tool) => tool.name).sort(), ["dwell.proc.logs", "read"]);
		let entries = await child.entries({}, 100, undefined, context);
		assert.match(JSON.stringify(entries.items), /original/);
		assert.match(JSON.stringify(entries.items), /not offered|not available|not enabled|Unknown tool/i);
		// Offering removed tools again must not grant a read-only child write authority.
		await child.configure({ tools: [...CodingTools.tools!, ...(await child.agent(context)).tools] }, context);
		await submit(child, "worker:reader second pass");
		entries = await child.entries({}, 100, undefined, context);
		assert.match(JSON.stringify(entries.items), /read-only/);
		assert.equal(await readFile(join(s.cwd, "seed.txt"), "utf8"), "original");
		for (const path of ["blocked.txt", "shell.txt", "nested.txt"]) await missing(join(s.cwd, path));
		assert.deepEqual(s.reports, []);
	} finally { await s.close(); }
});

test("stop cancels a Reporter awaiting attribution; reopening and reusing its name cannot revive the old child", { timeout: 15_000 }, async () => {
	const attribute = gate();
	let waiting = false;
	let parentId: number | undefined;
	const steps = new Map<string, number>();
	const responder: FauxResponseFactory = (transcript) => {
		const users = userText(transcript.messages);
		const key = users.includes("worker:replacement") ? "replacement" : users.includes("worker:writer") ? "old-child" : users.includes("reuse-name") ? "reuse" : users.includes("stop-now") ? "stop" : "start";
		const step = steps.get(key) ?? 0; steps.set(key, step + 1);
		if (step > 0) return done();
		if (key === "old-child") return calls(write("after-stop.txt"));
		if (key === "replacement") return calls(write("replacement.txt"));
		if (key === "stop") return calls({ name: "dwell.task", args: { action: "stop", name: "writer" } });
		if (key === "reuse") return calls({ name: "dwell.task", args: { action: "start", mode: "write", name: "writer", message: "worker:replacement" } });
		return calls(start("writer", "write"));
	};
	let s = await setup({ responder, attribute: async (id) => { if (id !== parentId) { waiting = true; await attribute.promise; } } });
	try {
		const parent = await s.conversation(); parentId = parent.id;
		await submit(parent, "start");
		await until(() => waiting && s.started.length === 1);
		const oldChild = s.started[0]!;
		await submit(parent, "stop-now");
		assert.deepEqual((await s.harness.snapshot(BackgroundDoc, parent.id, context))!.agents, {});
		attribute.release();
		await until(async () => (await s.harness.commit((tx) => tx.scanTasks({ kind: "dwell.background-reporter" }, 100), context)).items.every((task) => task.state.status === "terminal"));
		await missing(join(s.cwd, "after-stop.txt"));
		await submit(parent, "reuse-name");
		await until(() => s.started.length === 2);
		await until(async () => { try { await access(join(s.cwd, "replacement.txt")); return true; } catch { return false; } });
		const newChild = s.started[1]!;
		assert.notEqual(oldChild, newChild);
		const directory = s.directory; await s.close(true);
		s = await setup({ directory, responder });
		const reopened = (await s.harness.conversation(parent.id, context))!;
		const replayed = await reopened.commit((tx) => tx.createTask(makeBackgroundReporter(s.deps), { name: "writer", parent: parent.id, child: oldChild, creator: "test-user", message: "worker:writer", followUp: false }, { ownership: { kind: "conversation" }, background: true }), context);
		await until(async () => (await s.harness.getTask(replayed, context))?.state.status === "terminal");
		await missing(join(s.cwd, "after-stop.txt"));
		const stopped = (await s.harness.conversation(oldChild as ConversationId, context))!;
		assert.equal((await stopped.entries({}, 100, undefined, context)).items.length, 0, "a stopped child must receive no old or replayed input");
		assert.equal((await s.harness.snapshot(BackgroundDoc, parent.id, context))!.agents.writer!.conversationId, newChild);
		assert.deepEqual(s.reports, []);
	} finally { attribute.release(); await s.close(); }
});

test("a writable child can use coding tools; its parent stays read-only through lease release, then a new run can write", { timeout: 15_000 }, async () => {
	let parentStep = 0; let childStep = 0;
	const parentAfterHandoff = gate();
	const writerCanWork = gate();
	let parentWaiting = false;
	let newRunStep = 0;
	let competitorStep = 0; let readerStep = 0;
	const s = await setup({ responder: async (transcript) => {
		const users = userText(transcript.messages);
		if (users.includes("worker:parallelreader")) return readerStep++ === 0 ? calls({ name: "read", args: { path: "seed.txt" } }) : done();
		if (users.includes("parent:competitor")) {
			const step = competitorStep++;
			return step === 0 ? calls(start("competitor", "write")) : step === 1 ? calls(start("parallelreader")) : done();
		}
		if (users.includes("worker:writer")) {
			if (childStep++ !== 0) return done();
			await writerCanWork.promise;
			return calls(write("child.txt"),
				{ name: "edit", args: { path: "seed.txt", edits: [{ oldText: "original", newText: "child edit" }] } },
				{ name: "bash", args: { command: "echo child-shell > child-shell.txt" } });
		}
		if (users.includes("parent:new-run")) return newRunStep++ === 0 ? calls(write("new-run.txt")) : done();
		const step = parentStep++;
		if (step === 0) return calls(start("writer", "write"));
		if (step === 1) return calls(write("parent-during-writer.txt"));
		if (step === 2) { parentWaiting = true; await parentAfterHandoff.promise; return calls(write("parent.txt"), { name: "bash", args: { command: "echo parent > parent-shell.txt" } }); }
		return done();
	} });
	try {
		await writeFile(join(s.cwd, "seed.txt"), "original");
		const parent = await s.conversation();
		const first = await parent.submit({ type: "input", content: "parent:writer" }, context);
		await until(() => parentWaiting && childStep >= 1);
		await missing(join(s.cwd, "parent-during-writer.txt"));
		const competitor = await s.conversation();
		await submit(competitor, "parent:competitor");
		await until(() => readerStep >= 2);
		const roster = (await s.harness.snapshot(BackgroundDoc, competitor.id, context))!.agents;
		assert.deepEqual(Object.keys(roster), ["parallelreader"]);
		assert.equal(s.started.length, 2, "the conflicting writer must not create a child");
		const reader = (await s.harness.conversation(roster.parallelreader!.conversationId as ConversationId, context))!;
		assert.match(JSON.stringify((await reader.entries({}, 100, undefined, context)).items), /original/);
		assert.match(JSON.stringify((await competitor.entries({}, 100, undefined, context)).items), /already has a writable background task/);
		writerCanWork.release();
		await until(async () => {
			const tasks = await s.harness.commit((tx) => tx.scanTasks({ kind: "dwell.background-reporter" }, 20), context);
			return tasks.items.length === 2 && tasks.items.every((task) => task.state.status === "terminal");
		});
		assert.equal(await readFile(join(s.cwd, "child.txt"), "utf8"), "written");
		assert.equal(await readFile(join(s.cwd, "seed.txt"), "utf8"), "child edit");
		assert.equal((await readFile(join(s.cwd, "child-shell.txt"), "utf8")).trim(), "child-shell");
		parentAfterHandoff.release();
		assert.equal((await first.wait(context)).status, "done");
		await parent.waitForIdle(context);
		await missing(join(s.cwd, "parent.txt")); await missing(join(s.cwd, "parent-shell.txt"));
		assert.match(JSON.stringify((await parent.entries({}, 100, undefined, context)).items), /does not own workspace write access/);
		await submit(parent, "parent:new-run");
		assert.equal(await readFile(join(s.cwd, "new-run.txt"), "utf8"), "written");
		assert.deepEqual(s.reports, []);
	} finally { writerCanWork.release(); parentAfterHandoff.release(); await s.close(); }
});

test("mixed or concurrent writable starts reject before creating orphan children", { timeout: 15_000 }, async (t) => {
	for (const mixed of [false, true]) await t.test(mixed ? "writer plus mutation" : "two writers", async () => {
		let step = 0;
		const s = await setup({ responder: () => step++ === 0 ? calls(start("one", "write"), mixed ? write("main.txt") : start("two", "write")) : done() });
		try {
			const parent = await s.conversation(); await submit(parent, "parent:mixed");
			assert.deepEqual(s.started, []);
			assert.deepEqual((await s.harness.snapshot(BackgroundDoc, parent.id, context))?.agents ?? {}, {});
			const conversations = await s.harness.commit((tx) => tx.scanConversations({}, 20), context);
			assert.equal(conversations.items.length, 1);
			const reporters = await s.harness.commit((tx) => tx.scanTasks({ kind: "dwell.background-reporter" }, 20), context);
			assert.equal(reporters.items.length, 0);
			assert.match(JSON.stringify((await parent.entries({}, 100, undefined, context)).items), /own tool batch/);
			assert.deepEqual(s.reports, []);
		} finally { await s.close(); }
	});
});

test("write leases and read-only child modes still govern tools after reopening SQLite", { timeout: 15_000 }, async () => {
	let s = await setup();
	const directory = s.directory;
	try {
		const parent = await s.conversation();
		const writer = await s.child(parent, "write");
		const reader = await s.child(parent, "read");
		await until(async () => (await s.harness.getTask(writer.holder, context))?.state.status === "sleeping");
		await s.close(true);
		const steps = new Map<string, number>();
		s = await setup({ directory, responder: (transcript) => {
			const key = userText(transcript.messages);
			const step = steps.get(key) ?? 0; steps.set(key, step + 1);
			return step === 0 ? calls(write(key.includes("reader") ? "reader.txt" : key.includes("writer") ? "writer.txt" : "main.txt")) : done();
		} });
		const reopenedParent = (await s.harness.conversation(parent.id, context))!;
		const writerConversation = (await s.harness.conversation(writer.child, context))!;
		const readerConversation = (await s.harness.conversation(reader.child, context))!;
		await submit(reopenedParent, "main after restart");
		await submit(readerConversation, "reader after restart");
		await submit(writerConversation, "writer after restart");
		await missing(join(s.cwd, "main.txt")); await missing(join(s.cwd, "reader.txt"));
		assert.equal(await readFile(join(s.cwd, "writer.txt"), "utf8"), "written");
		assert.deepEqual(s.reports, []);
	} finally { await s.close(); }
});

test("canonical aliases and nested workspaces share a lease, while sibling directories remain independent", { timeout: 15_000 }, async () => {
	const steps = new Map<string, number>();
	const s = await setup({ responder: (transcript) => {
		const key = userText(transcript.messages); const step = steps.get(key) ?? 0; steps.set(key, step + 1);
		return step === 0 ? calls(write("attempt.txt")) : done();
	} });
	try {
		const nested = join(s.cwd, "nested"); const sibling = join(s.directory, "sibling"); const alias = join(s.directory, "alias");
		await mkdir(nested); await mkdir(sibling); await symlink(await realpath(s.cwd), alias, "dir");
		const parent = await s.conversation(); await s.child(parent, "write");
		for (const [label, workspace] of [["alias", alias], ["nested", nested], ["ancestor", s.directory], ["sibling", sibling]]) {
			await submit(await s.conversation(workspace), label!);
		}
		await missing(join(s.cwd, "attempt.txt")); await missing(join(nested, "attempt.txt")); await missing(join(s.directory, "attempt.txt"));
		assert.equal(await readFile(join(sibling, "attempt.txt"), "utf8"), "written");
		assert.deepEqual(s.reports, []);
	} finally { await s.close(); }
});

test("terminal writer leases release after completion, failure or stop; pending approval retains the lease", { timeout: 20_000 }, async (t) => {
	for (const ending of ["completed", "failed", "stopped", "approval"] as const) await t.test(ending, async () => {
		const steps = new Map<string, number>();
		const s = await setup({ responder: (transcript) => {
			const key = userText(transcript.messages); const step = steps.get(key) ?? 0; steps.set(key, step + 1);
			return step === 0 ? calls(write(key.includes("after-decision") ? "after-decision.txt" : "released.txt")) : done();
		} });
		try {
			const parent = await s.conversation();
			const writer = await s.child(parent, "write", Date.now() + (ending === "stopped" ? 60_000 : 30), ending === "failed");
			if (ending === "approval") setWorkspaceApprovalGetter((id) => id === writer.child);
			if (ending === "stopped") await s.harness.abortTask(writer.holder, context);
			await until(async () => (await s.harness.getTask(writer.holder, context))?.state.status === "terminal");
			await submit(parent, "parent after child terminal");
			if (ending === "approval") {
				await missing(join(s.cwd, "released.txt"));
				setWorkspaceApprovalGetter(() => false);
				await submit(parent, "after-decision");
				assert.equal(await readFile(join(s.cwd, "after-decision.txt"), "utf8"), "written");
			} else assert.equal(await readFile(join(s.cwd, "released.txt"), "utf8"), "written");
			assert.deepEqual(s.reports, []);
		} finally { setWorkspaceApprovalGetter(() => false); await s.close(); }
	});
});

test("legacy anchor-owned children receive read-only mode before their next generation", { timeout: 10_000 }, async () => {
	let step = 0;
	let s = await setup();
	try {
		const parent = await s.conversation();
		const child = await parent.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			return (await tx.createConversation({ ownership: { kind: "task", taskId: anchor } })).id;
		}, context);
		const directory = s.directory;
		await s.close(true);
		s = await setup({ directory, responder: () => step++ === 0 ? calls(write("legacy.txt")) : done() });
		await submit((await s.harness.conversation(child, context))!, "legacy child");
		await missing(join(s.cwd, "legacy.txt"));
		assert.equal((await s.harness.snapshot(WorkspaceDoc, context))?.children[String(child)]?.mode, "read");
		assert.deepEqual(s.reports, []);
	} finally { await s.close(); }
});
