import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, hook, InboxDoc, LiveDoc, ToolResultEntry, ToolTask, type Conversation, type ConversationId, type JsonObject, type SubmissionId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import { BackgroundAnchor, BackgroundDoc, BackgroundStopDoc, BACKGROUND_ANCHOR_KIND, BACKGROUND_REPORTER_KIND, BACKGROUND_WAIT_TOOL, backgroundWaitingAnswer, makeBackgroundExtension, makeBackgroundReporter, type BackgroundDeps } from "../src/ext/background.ts";
import { makeWorkspaceExtension, registerBackgroundWorkspace, WorkspaceDoc } from "../src/workspace.ts";

const done = (text = "done") => fauxAssistantMessage(fauxText(text));
const calls = (...items: { name: string; args: JsonObject }[]) => fauxAssistantMessage(items.map((item, i) => fauxToolCall(item.name, item.args, { id: `call-${i}` })), { stopReason: "toolUse" });
const wait = () => calls({ name: BACKGROUND_WAIT_TOOL, args: {} });
const users = (transcript: Parameters<FauxResponseFactory>[0]) => transcript.messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).join("\n");
const gate = () => {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
};
const until = async (check: () => boolean | Promise<boolean>) => {
	for (const end = Date.now() + 5000; !await check();) {
		if (Date.now() > end) throw new Error("Background wait test timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

async function setup(responder: FauxResponseFactory, options: { workspace?: boolean; attribute?: BackgroundDeps["attribute"]; interruptWait?: boolean } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "dwell-bg-wait-"));
	const registry = createRegistry();
	let harness!: Harness;
	let background!: ReturnType<typeof makeBackgroundExtension>;
	let interruptWait = options.interruptWait === true;
	let interrupted = false;
	const fired: SubmissionId[] = [];
	const attributed: { conversationId: number; creator: string }[] = [];
	const deps: BackgroundDeps = {
		getHarness: () => harness,
		attribute: async (conversationId, creator) => { attributed.push({ conversationId, creator }); await options.attribute?.(conversationId, creator); },
		onFired: (_conversationId, submissionId) => { fired.push(submissionId); },
		onStarted: () => {}, senderOf: () => "alice", viaOf: () => "panel", forbidden: () => [background],
	};
	background = makeBackgroundExtension(deps);
	registry.install(background);
	if (options.workspace) { registry.install(CodingTools); registry.install(makeWorkspaceExtension(() => harness)); }
	registry.install(defineExtension({ name: "background-wait-fixtures", tools: [
		defineTool({ name: "nested.wait", description: "Try a nested wait", parameters: Type.Object({}), replay: "safe", async execute(_args, api, ctx) {
			const result = await api.executeTool(BACKGROUND_WAIT_TOOL, {}, ctx);
			return { output: [{ type: "text", text: JSON.stringify(result) }] };
		} }),
	], hooks: [hook(ToolTask, { afterTool: async (call, result, _api, ctx) => {
		if (call.name !== BACKGROUND_WAIT_TOOL || result.isError || !interruptWait) return undefined;
		interruptWait = false; interrupted = true;
		await new Promise<void>((_resolve, reject) => {
			ctx.abortSignal!.addEventListener("abort", () => reject(ctx.abortSignal!.reason), { once: true });
			if (ctx.abortSignal!.aborted) reject(ctx.abortSignal!.reason);
		});
		return undefined;
	} })] }));
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	faux.setResponses(Array.from({ length: 100 }, () => responder));
	const models = createModels(); models.setProvider(faux.provider);
	const open = async () => {
		harness = await Harness.open(await openNodeSqliteStorage(join(directory, "s.sqlite")), { models, registry, env: async () => new NodeExecutionEnv({ cwd: directory }) }, context);
		return harness;
	};
	await open();
	return {
		get harness() { return harness; }, directory, background, deps, fired, attributed, faux, open,
		interrupted: () => interrupted,
		conversation: () => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory } }, context),
		spawn: (parent: Conversation, name = "reader") => parent.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			(await tx.doc(BackgroundDoc, parent.id)).agents[name] = { conversationId: child.id };
			const reporter = await tx.createTask(makeBackgroundReporter(deps), { name, parent: parent.id, child: child.id, creator: "alice", creatorVia: "panel", message: `worker:${name}`, followUp: false }, { ownership: { kind: "conversation" }, background: true });
			await registerBackgroundWorkspace(tx, parent.id, child.id, "read", directory, reporter);
			return { anchor, child: child.id, reporter };
		}, context),
		close: async () => { await harness.close(context); await rm(directory, { recursive: true, force: true }); },
	};
}

async function waitAnswer(s: Awaited<ReturnType<typeof setup>>, parent: Conversation, content = "wait-for-worker") {
	const submission = await parent.submit({ type: "input", content, entry: { kind: "chat.message", data: { sender: "bob", via: "panel" } } }, context);
	const settled = await submission.wait(context);
	assert.equal(settled.status, "done", JSON.stringify(settled));
	assert.ok(settled.type === "input" && settled.status === "done");
	return { submission, answer: settled.answer };
}

async function results(parent: Conversation) {
	return (await parent.entries({ order: "ascending" }, 200, undefined, context)).items.filter(ToolResultEntry.is).flatMap((entry) => entry.model?.[0]?.role === "toolResult" ? [entry.model[0]] : []);
}

test("explicit wait ends its run without another provider call; the Reporter resumes a new run with its original actor", { timeout: 10_000 }, async () => {
	const childGate = gate(); let parentId: number | undefined; let childWaiting = false;
	const s = await setup((transcript) => users(transcript).includes("Background task") ? done("relayed result") : users(transcript).includes("worker:") ? done("child result") : wait(), {
		attribute: async (id) => { if (id !== parentId) { childWaiting = true; await childGate.promise; } },
	});
	try {
		const parent = await s.conversation(); parentId = parent.id;
		const child = await s.spawn(parent);
		const answer = await waitAnswer(s, parent);
		await until(() => childWaiting);
		assert.equal(s.faux.state.callCount, 1, "wait must settle without asking the model to produce a final answer");
		assert.equal(await backgroundWaitingAnswer(s.harness, parent.id, answer.answer), true);
		assert.equal((await s.harness.snapshot(LiveDoc, parent.id, context))?.run, undefined);
		assert.deepEqual((await results(parent))[0]?.details, { waitingForBackground: true });
		await parent.abort(context);
		assert.notEqual((await s.harness.getTask(child.reporter, context))?.state.status, "terminal", "/cancel must not cross the background boundary");
		childGate.release();
		await until(() => s.fired.length === 1);
		const resumed = await (await s.harness.submission(s.fired[0]!, context))!.wait(context);
		assert.ok(resumed.type === "input" && resumed.status === "done");
		assert.equal(await backgroundWaitingAnswer(s.harness, parent.id, resumed.answer), false, "a previous wait is not the new answer");
		assert.equal(s.faux.state.callCount, 3, "only wait, child, and resumed answer request the provider");
		assert.deepEqual(s.attributed, [{ conversationId: child.child, creator: "alice" }, { conversationId: parent.id, creator: "alice" }]);
		const report = (await parent.entries({}, 100, undefined, context)).items.find((entry) => entry.id === resumed.entry);
		assert.deepEqual(report?.data, { sender: "alice", via: "background", authorityVia: "panel", work: null });
	} finally { childGate.release(); await s.close(); }
});

test("wait admits an already queued report after its Reporter becomes terminal", { timeout: 10_000 }, async () => {
	const waitGate = gate(); let requested = false;
	const s = await setup(async (transcript) => {
		const text = users(transcript);
		if (text.includes("Background task")) return done("resumed");
		if (text.includes("worker:")) return done("child result");
		requested = true; await waitGate.promise; return wait();
	});
	try {
		const parent = await s.conversation();
		const input = await parent.submit({ type: "input", content: "wait-for-worker" }, context);
		s.harness.resume(); await until(() => requested);
		const child = await s.spawn(parent);
		await until(() => s.fired.length === 1);
		await until(async () => (await s.harness.getTask(child.reporter, context))?.state.status === "terminal");
		assert.equal((await (await s.harness.submission(s.fired[0]!, context))!.status(context)).status, "queued");
		assert.equal((await s.harness.snapshot(InboxDoc, parent.id, context))!.items.length, 1);
		waitGate.release();
		const settled = await input.wait(context);
		assert.ok(settled.type === "input" && settled.status === "done");
		assert.equal(await backgroundWaitingAnswer(s.harness, parent.id, settled.answer), true);
		await (await s.harness.submission(s.fired[0]!, context))!.wait(context);
		assert.equal(s.faux.state.callCount, 3);
	} finally { waitGate.release(); await s.close(); }
});

test("an invalid task wait action directs the model to the separate replay-safe tool and recovers", { timeout: 10_000 }, async () => {
	const childGate = gate(); let parentId: number | undefined; let step = 0;
	const s = await setup((transcript) => {
		const input = users(transcript);
		if (input.includes("Background task")) return done("relayed result");
		if (input.includes("worker:")) return done("child result");
		if (step++ === 0) return calls({ name: "dwell.task", args: { action: "wait" } });
		const invalid = transcript.messages.filter((item) => item.role === "toolResult").at(-1)!;
		assert.equal(invalid.role, "toolResult");
		if (invalid.role === "toolResult") {
			assert.equal(invalid.isError, true);
			assert.match(JSON.stringify(invalid.content), /dwell\.task\.wait/);
			assert.match(JSON.stringify(invalid.content), /arguments/);
			assert.match(JSON.stringify(invalid.content), /alone/);
		}
		return wait();
	}, { attribute: async (id) => { if (id !== parentId) await childGate.promise; } });
	try {
		const parent = await s.conversation(); parentId = parent.id; await s.spawn(parent);
		const answer = await waitAnswer(s, parent);
		assert.equal(s.faux.state.callCount, 2, "only the invalid call and corrected wait request the model before yielding");
		assert.equal(await backgroundWaitingAnswer(s.harness, parent.id, answer.answer), true);
		const definition = s.background.tools!.find((item) => item.name === "dwell.task")!;
		assert.doesNotMatch(JSON.stringify(definition.parameters), /"const":"wait"/);
		assert.equal(s.background.tools!.find((item) => item.name === BACKGROUND_WAIT_TOOL)!.replay, "safe");
		childGate.release(); await until(() => s.fired.length === 1);
		const resumed = await (await s.harness.submission(s.fired[0]!, context))!.wait(context);
		assert.equal(resumed.status, "done");
	} finally { childGate.release(); await s.close(); }
});

for (const mode of ["mixed", "nested"] as const) test(`wait rejects ${mode} calls without claiming waiting state`, { timeout: 10_000 }, async () => {
	const childGate = gate(); let parentId: number | undefined; let step = 0;
	const s = await setup(() => step++ === 0 ? mode === "mixed" ? calls({ name: BACKGROUND_WAIT_TOOL, args: {} }, { name: "dwell.task", args: { action: "status" } }) : calls({ name: "nested.wait", args: {} }) : done(), {
		attribute: async (id) => { if (id !== parentId) await childGate.promise; },
	});
	try {
		const parent = await s.conversation(); parentId = parent.id; await s.spawn(parent);
		const answer = await waitAnswer(s, parent);
		assert.equal(await backgroundWaitingAnswer(s.harness, parent.id, answer.answer), false);
		const outputs = await results(parent);
		if (mode === "mixed") {
			assert.equal(outputs[0]?.isError, true);
			assert.equal(outputs[0]?.details, undefined);
			assert.match(JSON.stringify(outputs), /alone/);
		} else assert.match(JSON.stringify(outputs), /directly, not from another tool/);
		assert.equal(s.faux.state.callCount, 2);
	} finally { childGate.release(); await s.close(); }
});

for (const mode of ["absent", "idle", "stopped", "foreign"] as const) test(`wait rejects ${mode} background work`, { timeout: 10_000 }, async () => {
	const childGate = gate(); let step = 0;
	const s = await setup(() => step++ === 0 ? wait() : done(), { attribute: async () => childGate.promise });
	try {
		const parent = await s.conversation();
		if (mode !== "absent") {
			const owner = mode === "foreign" ? await s.conversation() : parent;
			const child = await s.spawn(owner);
			if (mode === "idle") await s.harness.abortTask(child.reporter, context);
			if (mode === "stopped") await owner.commit(async (tx) => { (await tx.doc(BackgroundStopDoc, owner.id)).children[String(child.child)] = true; }, context);
		}
		const answer = await waitAnswer(s, parent);
		assert.equal(await backgroundWaitingAnswer(s.harness, parent.id, answer.answer), false);
		const result = (await results(parent))[0]!;
		assert.equal(result.isError, true); assert.equal(result.details, undefined);
		assert.match(JSON.stringify(result), /No pending background result/);
		assert.equal(s.faux.state.callCount, 2);
	} finally { childGate.release(); await s.close(); }
});

test("an interrupted wait replays safely after restart without another model request or duplicate child/report", { timeout: 10_000 }, async () => {
	const childGate = gate(); let parentId: number | undefined;
	const s = await setup((transcript) => users(transcript).includes("Background task") ? done("resumed") : users(transcript).includes("worker:") ? done("child result") : wait(), {
		interruptWait: true, attribute: async (id) => { if (id !== parentId) await childGate.promise; },
	});
	try {
		const parent = await s.conversation(); parentId = parent.id; const child = await s.spawn(parent);
		const input = await parent.submit({ type: "input", content: "wait-for-worker" }, context);
		s.harness.resume(); await until(s.interrupted);
		assert.equal(s.faux.state.callCount, 1);
		await s.harness.close(context);
		await s.open();
		const recovered = await (await s.harness.submission(input.id, context))!.wait(context);
		assert.ok(recovered.type === "input" && recovered.status === "done");
		assert.equal(await backgroundWaitingAnswer(s.harness, parent.id, recovered.answer), true);
		assert.equal(s.faux.state.callCount, 1, "safe wait replay must not repeat the model request");
		childGate.release(); await until(() => s.fired.length === 1);
		await (await s.harness.submission(s.fired[0]!, context))!.wait(context);
		const tasks = await s.harness.commit((tx) => tx.scanTasks({ conversationId: parent.id }, 100), context);
		assert.equal(tasks.items.filter((task) => task.kind === BACKGROUND_ANCHOR_KIND).length, 1);
		assert.equal(tasks.items.filter((task) => task.kind === BACKGROUND_REPORTER_KIND).length, 1);
		assert.equal((await s.harness.snapshot(BackgroundDoc, parent.id, context))?.agents.reader?.conversationId, child.child);
		assert.equal(s.faux.state.callCount, 3);
		const restoredParent = (await s.harness.conversation(parent.id, context))!;
		assert.equal((await results(restoredParent)).filter((result) => result.toolName === BACKGROUND_WAIT_TOOL).length, 1);
	} finally { childGate.release(); await s.close(); }
});

test("waiting after a writable handoff permits the resumed run to acquire workspace access", { timeout: 10_000 }, async () => {
	const childGate = gate(); let parentId: number | undefined; let parentStep = 0; let childStep = 0; let resumedStep = 0;
	const s = await setup((transcript) => {
		const text = users(transcript);
		if (text.includes("worker:writer")) return childStep++ === 0 ? calls({ name: "write", args: { path: "child.txt", content: "child change" } }) : done("child wrote its file");
		if (text.includes("Background task")) return resumedStep++ === 0 ? calls({ name: "write", args: { path: "parent.txt", content: "parent change" } }) : done();
		return parentStep++ === 0 ? calls({ name: "dwell.task", args: { action: "start", name: "writer", mode: "write", message: "worker:writer" } }) : wait();
	}, { workspace: true, attribute: async (id) => { if (id !== parentId) await childGate.promise; } });
	try {
		const parent = await s.conversation(); parentId = parent.id;
		const answer = await waitAnswer(s, parent);
		assert.equal(await backgroundWaitingAnswer(s.harness, parent.id, answer.answer), true);
		assert.equal((await s.harness.snapshot(WorkspaceDoc, context))?.mains[String(parent.id)]?.writable, false);
		childGate.release(); await until(() => s.fired.length === 1);
		await (await s.harness.submission(s.fired[0]!, context))!.wait(context);
		assert.equal(await readFile(join(s.directory, "child.txt"), "utf8"), "child change");
		assert.equal(await readFile(join(s.directory, "parent.txt"), "utf8"), "parent change");
		const result = (await results(parent)).find((result) => result.toolName === "write");
		assert.equal(result?.isError, false);
		assert.equal(s.background.tools?.find((tool) => tool.name === "dwell.task")?.replay, "unsafe");
		assert.equal(s.background.tools?.find((tool) => tool.name === BACKGROUND_WAIT_TOOL)?.replay, "safe");
	} finally { childGate.release(); await s.close(); }
});
