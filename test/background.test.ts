// node --test "test/background.test.ts"
// 后台任务：回报送达父会话 / 锚任务 background 边界（父线 abort 不穿越）/ stop / 并发上限。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, InboxDoc, LiveDoc, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BackgroundAnchor, BACKGROUND_ANCHOR_KIND, BACKGROUND_REPORTER_KIND, BackgroundDoc, backgroundCapViolation, backgroundChildren, makeBackgroundDeliverer, makeBackgroundExtension, makeBackgroundReporter, type BackgroundDeps } from "../src/ext/background.ts";
import { makeScheduleExtension, scanLiveTasks } from "../src/ext/schedule.ts";
import { WorkspaceDoc } from "../src/workspace.ts";

const until = async (check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> => {
	for (const end = Date.now() + ms; ;) {
		if (await check()) return;
		if (Date.now() > end) throw new Error("until: timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
};

async function admissionFixture(overrides: Partial<BackgroundDeps> = {}) {
	const dir = await mkdtemp(join(tmpdir(), "dwell-bg-admission-"));
	const started: { child: number; parent: number }[] = [];
	const deps: BackgroundDeps = {
		attribute: async () => {}, onFired: () => {}, senderOf: () => "creator", forbidden: () => [],
		onStarted: (child, parent) => { started.push({ child, parent }); },
		...overrides,
	};
	const models = createModels(); models.setProvider(fauxProvider().provider);
	const registry = createRegistry();
	const extension = makeBackgroundExtension(deps); registry.install(extension);
	const context = BACKGROUND_CONTEXT;
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry }, context);
	const tool = extension.tools?.[0];
	if (tool === undefined) throw new Error("dwell.task was not registered");
	// Leave the scheduler paused so admitted Reporters remain live without timing or model calls.
	const parent = async () => {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
		const api = {
			conversationId: conversation.id,
			registry: registry.snapshot(),
			commit: <T,>(fn: (tx: never) => T | Promise<T>) => conversation.commit(fn as never, context),
			snapshot: (doc: never, id: number) => harness.snapshot(doc, id as ConversationId, context),
			conversation: (id: number) => harness.conversation(id as ConversationId, context),
		} as never;
		return {
			id: conversation.id,
			execute: (args: { action: "start" | "send"; name: string; message: string }) => tool.execute(args, api, context as never),
		};
	};
	return {
		harness, context, started, parent,
		live: () => harness.commit((tx) => scanLiveTasks(tx, { kind: BACKGROUND_REPORTER_KIND }), context),
		close: async () => { await harness.close(context); await rm(dir, { recursive: true, force: true }); },
	};
}

const toolOutput = (result: unknown): string => String((result as { output?: { text?: string }[] }).output?.[0]?.text ?? "");

test("actor-scoped background input queues behind the child's current actor without steering its run", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-bg-actor-input-"));
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	let firstStarted = false;
	const scopes: number[] = [];
	const deps: BackgroundDeps = {
		attribute: async () => {}, onFired: () => {}, onStarted: () => {}, forbidden: () => [],
		senderOf: () => "current-parent-actor",
		inputMode: (parent) => { scopes.push(parent); return "followUp"; },
	};
	const faux = fauxProvider();
	faux.setResponses([
		async () => { firstStarted = true; await held; return fauxAssistantMessage(fauxText("first actor finished")); },
		...Array.from({ length: 10 }, () => fauxAssistantMessage(fauxText("later answer"))),
	]);
	const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry(); registry.install(makeBackgroundExtension(deps));
	const context = BACKGROUND_CONTEXT;
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry }, context);
	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
		const childId = await parent.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			return (await tx.createConversation({ ownership: { kind: "task", taskId: anchor } })).id;
		}, context);
		const child = (await harness.conversation(childId, context))!;
		const first = await child.submit({ type: "input", content: "first actor's task", entry: { kind: "chat.message", data: { sender: "tg:11", via: "telegram" } } }, context);
		harness.resume();
		await until(() => firstStarted);
		const reporter = await parent.commit((tx) => tx.createTask(makeBackgroundReporter(deps), {
			name: "worker", parent: parent.id, child: child.id, message: "second actor's task", creator: "tg:22", creatorVia: "telegram", followUp: false,
		}, { ownership: { kind: "conversation" }, background: true }), context);
		await until(async () => (await harness.snapshot(InboxDoc, child.id, context))?.items.length === 1);
		const live = await harness.snapshot(LiveDoc, child.id, context);
		const queued = (await harness.snapshot(InboxDoc, child.id, context))!.items[0]!;
		assert.equal(queued.mode, "followUp");
		assert.equal((queued.entry?.data as { sender: string }).sender, "tg:22");
		assert.deepEqual(live?.run?.inputs, [first.id], "The new actor must not join the original run");
		assert.deepEqual(scopes, [parent.id]);
		release();
		const firstResult = await first.wait(context);
		const queuedResult = await (await harness.submission(queued.id, context))!.wait(context);
		assert.equal(firstResult.status, "done");
		assert.equal(queuedResult.status, "done");
		if (firstResult.status === "done" && firstResult.type === "input" && queuedResult.status === "done" && queuedResult.type === "input") assert.notEqual(firstResult.answer, queuedResult.answer);
		await until(async () => (await harness.getTask(reporter, context))?.state.status === "terminal");
		const entries = (await child.entries({}, 100, undefined, context)).items.filter((entry) => entry.kind === "chat.message");
		assert.deepEqual(entries.map((entry) => (entry.data as { sender: string }).sender).sort(), ["tg:11", "tg:22"]);
	} finally { release(); await harness.close(context); await rm(dir, { recursive: true, force: true }); }
});

test("background access uses the invocation actor and revokes queued delivery without keeping its unused lease", async () => {
	let allowed = true;
	let sender = "tg:42";
	const checks: unknown[][] = [];
	const fixture = await admissionFixture({
		senderOf: () => sender,
		viaOf: () => "telegram",
		isAllowed: (creator, conversationId, via) => { checks.push([creator, conversationId, via]); return allowed && creator === "tg:42" && via === "telegram"; },
	});
	try {
		const parent = await fixture.parent();
		assert.match(toolOutput(await parent.execute({ action: "start", name: "worker", message: "queued job" })), /^Started worker\./);
		const reporter = (await fixture.live())[0]!;
		const child = (reporter.input as { child: number }).child;
		await fixture.harness.commit(async (tx) => {
			const workspace = await tx.doc(WorkspaceDoc);
			workspace.children[String(child)] = { parent: parent.id, mode: "write", workspace: "/queued-work" };
			workspace.writers["/queued-work"] = { conversationId: child, reporterId: reporter.id, workspace: "/queued-work" };
		}, fixture.context);
		allowed = false;
		assert.match(toolOutput(await parent.execute({ action: "send", name: "worker", message: "refused follow-up" })), /no longer has access/);
		assert.match(toolOutput(await parent.execute({ action: "start", name: "second", message: "refused start" })), /no longer has access/);
		sender = "admin-now";
		fixture.harness.resume();
		await until(async () => (await fixture.harness.getTask(reporter.id, fixture.context))?.state.status === "terminal");
		const conversation = await fixture.harness.conversation(child as ConversationId, fixture.context);
		assert.equal((await conversation!.entries({}, 20, undefined, fixture.context)).items.length, 0);
		assert.equal((await fixture.harness.snapshot(WorkspaceDoc, fixture.context))?.writers["/queued-work"], undefined);
		assert.equal((await fixture.harness.snapshot(BackgroundDoc, parent.id, fixture.context))?.agents.worker?.conversationId, child);
		assert.ok(checks.every(([creator, id, via]) => creator === "tg:42" && id === parent.id && via === "telegram"));
		assert.equal((await fixture.live()).length, 0);
	} finally { await fixture.close(); }
});

test("background approval delivery never borrows the parent's current actor or transport", async () => {
	const checks: unknown[][] = [];
	let allowed = true;
	const fixture = await admissionFixture({
		viaOf: () => "panel",
		isAllowed: (creator, id, via) => { checks.push([creator, id, via]); return allowed && creator === "creator"; },
	});
	try {
		const parent = await fixture.parent();
		await parent.execute({ action: "start", name: "worker", message: "job" });
		const child = ((await fixture.live())[0]!.input as { child: number }).child;
		const deliverer = makeBackgroundDeliverer({
			attribute: async () => {}, onFired: () => {}, onStarted: () => {}, forbidden: () => [],
			senderOf: () => "current-admin", viaOf: () => "panel",
			isAllowed: (creator, id, via) => { checks.push([creator, id, via]); return allowed && creator === "creator"; },
		}, () => fixture.harness);
		assert.equal(await deliverer.deliver(parent.id, child, "approval", { deliveryId: "denied", sender: "revoked", via: "telegram" }), false);
		assert.deepEqual(checks.at(-1), ["revoked", parent.id, "telegram"]);
		assert.equal(await deliverer.deliver(parent.id, child, "approval", { deliveryId: "legacy", sender: "creator" }), true);
		assert.deepEqual(checks.at(-1), ["creator", parent.id, undefined]);
		allowed = false;
		assert.equal(await deliverer.deliver(parent.id, child, "approval", { deliveryId: "later", sender: "creator", via: "telegram" }), false);
		assert.equal((await fixture.live()).length, 2);
		assert.equal(await deliverer.deliver(parent.id, child, "approval", { deliveryId: "legacy", sender: "creator" }), true, "An existing receipt acknowledges delivery without creating new work");
		allowed = true;
		assert.equal(await deliverer.deliver(parent.id, child, "approval", { deliveryId: "third", sender: "creator" }), true);
		await assert.rejects(deliverer.deliver(parent.id, child, "approval", { deliveryId: "capacity", sender: "creator" }), /max 3/, "Capacity remains retryable rather than becoming an unavailable delivery");
	} finally { await fixture.close(); }
});

test("background revocation before the parent submission keeps the completed child history", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-bg-revoke-report-"));
	let parentId = 0;
	let allowed = true;
	let fired = 0;
	const checks: unknown[][] = [];
	const deps: BackgroundDeps = {
		attribute: async (id) => { if (id === parentId) allowed = false; },
		onFired: () => { fired++; }, onStarted: () => {}, forbidden: () => [], senderOf: () => "new-admin",
		isAllowed: (creator, id, via) => { checks.push([creator, id, via]); return allowed && creator === "tg:42" && id === parentId && via === "telegram"; },
	};
	const faux = fauxProvider(); faux.setResponses([fauxAssistantMessage(fauxText("child completed"))]);
	const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry(); registry.install(makeBackgroundExtension(deps));
	const context = BACKGROUND_CONTEXT;
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry }, context);
	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
		parentId = parent.id;
		const { child, reporter } = await parent.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			const reporter = await tx.createTask(makeBackgroundReporter(deps), { name: "worker", parent: parent.id, child: child.id, creator: "tg:42", creatorVia: "telegram", message: "job", followUp: false }, { ownership: { kind: "conversation" }, background: true });
			return { child: child.id, reporter };
		}, context);
		harness.resume();
		await until(async () => (await harness.getTask(reporter, context))?.state.status === "terminal");
		assert.equal(fired, 0);
		assert.equal((await parent.entries({}, 50, undefined, context)).items.length, 0);
		assert.match(JSON.stringify((await (await harness.conversation(child, context))!.entries({}, 50, undefined, context)).items), /child completed/);
		assert.ok(checks.every(([creator, id, via]) => creator === "tg:42" && id === parent.id && via === "telegram"));
	} finally { await harness.close(context); await rm(dir, { recursive: true, force: true }); }
});

test("background admission: concurrent starts with one name create one child and no orphan", async () => {
	const fixture = await admissionFixture();
	try {
		const parent = await fixture.parent();
		const results = await Promise.all([
			parent.execute({ action: "start", name: "same", message: "first" }),
			parent.execute({ action: "start", name: "same", message: "second" }),
		]);
		assert.equal(results.filter((result) => toolOutput(result).startsWith("Started same.")).length, 1);
		assert.equal(results.filter((result) => toolOutput(result).includes("already exists")).length, 1);
		const roster = await fixture.harness.snapshot(BackgroundDoc, parent.id, fixture.context);
		const child = roster?.agents.same?.conversationId;
		assert.ok(child !== undefined);
		assert.deepEqual(await backgroundChildren(fixture.harness), [{ child, parent: parent.id }]);
		assert.equal((await fixture.live()).length, 1);
		const anchors = await fixture.harness.commit((tx) => tx.scanTasks({ kind: BACKGROUND_ANCHOR_KIND }, 100), fixture.context);
		assert.equal(anchors.items.length, 1);
		assert.deepEqual(fixture.started, [{ child, parent: parent.id }]);
		const workspaces = await fixture.harness.snapshot(WorkspaceDoc, fixture.context);
		assert.deepEqual(Object.keys(workspaces?.children ?? {}), [String(child)]);
	} finally { await fixture.close(); }
});

test("background admission: concurrent sends share the per-conversation limit", async () => {
	const fixture = await admissionFixture();
	try {
		const parent = await fixture.parent();
		assert.match(toolOutput(await parent.execute({ action: "start", name: "worker", message: "start" })), /^Started worker\./);
		assert.match(toolOutput(await parent.execute({ action: "send", name: "worker", message: "baseline" })), /^Sent to worker\./);
		const results = await Promise.all([
			parent.execute({ action: "send", name: "worker", message: "first" }),
			parent.execute({ action: "send", name: "worker", message: "second" }),
		]);
		assert.equal(results.filter((result) => toolOutput(result).startsWith("Sent to worker.")).length, 1);
		assert.equal(results.filter((result) => toolOutput(result).includes("max 3")).length, 1);
		assert.equal((await fixture.live()).length, 3);
	} finally { await fixture.close(); }
});

test("background admission: concurrent send and start across conversations share the global limit", async () => {
	const fixture = await admissionFixture();
	try {
		const first = await fixture.parent(); const second = await fixture.parent(); const third = await fixture.parent();
		await first.execute({ action: "start", name: "worker", message: "start" });
		await first.execute({ action: "send", name: "worker", message: "second" });
		await first.execute({ action: "send", name: "worker", message: "third" });
		await second.execute({ action: "start", name: "worker", message: "start" });
		await second.execute({ action: "send", name: "worker", message: "second" });
		assert.equal((await fixture.live()).length, 5);
		const results = await Promise.all([
			second.execute({ action: "send", name: "worker", message: "last slot" }),
			third.execute({ action: "start", name: "worker", message: "last slot" }),
		]);
		assert.equal(results.filter((result) => /^(Sent to|Started) worker\./.test(toolOutput(result))).length, 1);
		assert.equal(results.filter((result) => toolOutput(result).includes("max 6")).length, 1);
		assert.equal((await fixture.live()).length, 6);
	} finally { await fixture.close(); }
});

test("backgroundCapViolation 上限判定", () => {
	assert.equal(backgroundCapViolation(2, 5), undefined);
	assert.match(backgroundCapViolation(3, 5) ?? "", /max 3/);
	assert.match(backgroundCapViolation(1, 6) ?? "", /max 6/);
});

test("集成：报告送达父会话；锚任务 background；父线 abort 不影响子会话；stop 不回报", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-bg-"));
	const fired: { conversationId: number; header: string }[] = [];
	const started: { child: number; parent: number }[] = [];
	const deps: BackgroundDeps = {
		attribute: async () => {},
		onFired: (conversationId, _submissionId, header) => { fired.push({ conversationId, header }); },
		onStarted: (child, parent) => started.push({ child, parent }),
		senderOf: () => "ou_test",
		forbidden: () => [],
	};
	const Reporter = makeBackgroundReporter(deps);
	const faux = fauxProvider({ tokensPerSecond: 20 });
	faux.setResponses(Array.from({ length: 60 }, () => fauxAssistantMessage([fauxText("done: 3")])));
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const context = BACKGROUND_CONTEXT;
	const registry = createRegistry();
	registry.install(makeBackgroundExtension(deps));
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry }, context);
	harness.resume();

	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const parentId = parent.id as number;

		// 模拟工具的 start commit：锚 + 子会话 + Reporter
		const spawn = async (name: string, message: string): Promise<{ anchor: TaskId; child: ConversationId; reporter: TaskId }> => {
			const ids = await parent.commit(async (tx) => {
				const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
				const reporter = await tx.createTask(Reporter, { name, parent: parentId, child: child.id as number, message, creator: "ou_test", followUp: false }, { ownership: { kind: "conversation" }, background: true });
				return { anchor, child: child.id, reporter };
			}, context);
			started.push({ child: ids.child as number, parent: parentId });
			return ids;
		};

		const first = await spawn("web", "count to three");
		// Reporter 终结 = 回报已提交到父会话
		await until(async () => (await harness.getTask(first.reporter, context))?.state.status === "terminal");
		const page = await parent.entries({}, 10, undefined, context);
		const report = page.items.find((e) => JSON.stringify(e.model ?? []).includes("Background task web finished"));
		assert.ok(report !== undefined, "父会话应收到回报");

		// 锚任务 background=true：父线普通 abort 不穿越
		const anchorRecord = await harness.getTask(first.anchor, context);
		assert.equal(anchorRecord?.kind, BACKGROUND_ANCHOR_KIND);
		assert.equal(anchorRecord?.background, true);
		const childRecord = await harness.commit((tx) => tx.conversation(first.child), context);
		assert.ok(childRecord?.owner !== undefined);
		await parent.abort(context);
		// 子会话仍然活着：能继续接受输入并完成
		const childConv = await harness.conversation(first.child, context);
		assert.ok(childConv !== undefined);
		const settled = await (await childConv.submit({ type: "input", content: "again", requestId: "child-again" }, context)).wait(context);
		assert.equal(settled.status, "done");

		// stop：abort 子会话当前工作，Reporter 以 aborted 收场，不再回报
		const second = await spawn("web2", "slow job");
		await until(async () => (await harness.getTask(second.reporter, context))?.state.status === "terminal");
		const firedBefore = fired.length;
		const third = await spawn("web3", "another slow job");
		const thirdConv = await harness.conversation(third.child, context);
		// 等子会话的 run 真正起来（LiveDoc.run 出现）再 abort，不赌时机
		await until(async () => (await harness.snapshot(LiveDoc, third.child as ConversationId, context))?.run !== undefined);
		await thirdConv!.abort(context);
		await until(async () => (await harness.getTask(third.reporter, context))?.state.status === "terminal");
		const page3 = await parent.entries({}, 10, undefined, context);
		assert.ok(!page3.items.some((e) => JSON.stringify(e.model ?? []).includes("Background task web3")), "stop 后不应有 web3 回报");
		assert.equal(fired.length, firedBefore); // web3 被 stop，没有新的开卡回调
	} finally {
		await harness.close(context).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	}
});

test("集成：deliverer 审批续跑——输入经 Reporter 投回子会话，结果 followUp 回父线", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-bg-deliver-"));
	const fired: { conversationId: number; header: string }[] = [];
	const deps: BackgroundDeps = {
		attribute: async () => {},
		onFired: (conversationId, _submissionId, header) => { fired.push({ conversationId, header }); },
		onStarted: () => {},
		senderOf: () => "ou_test",
		forbidden: () => [],
	};
	const Reporter = makeBackgroundReporter(deps);
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage([fauxText("answer body 42")])));
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const context = BACKGROUND_CONTEXT;
	const registry = createRegistry();
	registry.install(makeBackgroundExtension(deps));
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry }, context);
	harness.resume();
	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const parentId = parent.id as number;
		const ids = await parent.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			// 名册：真实路径由 dwell.task start 写入；审批续跑 nameOf 依赖它
			const doc = await tx.doc(BackgroundDoc, parent.id);
			doc.agents["web"] = { conversationId: child.id as number };
			await tx.createTask(Reporter, { name: "web", parent: parentId, child: child.id as number, message: "first job", creator: "ou_test", followUp: false }, { ownership: { kind: "conversation" }, background: true });
			return child.id as number;
		}, context);
		// 首轮跑完（roster 仍在：stop 才删）
		await until(async () => {
			const page = await parent.entries({}, 20, undefined, context);
			return page.items.some((e) => JSON.stringify(e.model ?? []).includes("Background task web finished"));
		});

		const deliverer = makeBackgroundDeliverer(deps, () => harness);
		assert.equal(await deliverer.nameOf(parentId, ids), "web");
		assert.equal(await deliverer.nameOf(parentId, 999999), undefined);
		assert.equal(await deliverer.deliver(parentId, 999999, "resume"), false, "无名册的子会话投递失败");
		// 审批续跑：输入经 Reporter 投回子会话，子会话的答案再次 followUp 回父线（新报告）
		assert.equal(await deliverer.deliver(parentId, ids, "[decision] approved"), true);
		await until(async () => {
			const page = await parent.entries({}, 20, undefined, context);
			const reports = page.items.filter((e) => JSON.stringify(e.model ?? []).includes("Background task web finished"));
			return reports.length >= 2;
		});
		const page = await parent.entries({}, 20, undefined, context);
		const latest = page.items.filter((e) => JSON.stringify(e.model ?? []).includes("Background task web finished"))[0];
		assert.match(JSON.stringify(latest?.model ?? []), /answer body 42/, "第二次报告携带子会话答案");
	} finally {
		await harness.close(context).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	}
});

test("工具层：start 建子会话并去掉后台/定时扩展；send 过成本闸；stop 删名册", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-bg-tool-"));
	const fired: { conversationId: number; header: string }[] = [];
	const deps: BackgroundDeps = {
		attribute: async () => {},
		onFired: (conversationId, _submissionId, header) => { fired.push({ conversationId, header }); },
		onStarted: () => {},
		senderOf: () => "ou_test",
		forbidden: () => [],
	};
	const scheduleDeps = { attribute: async () => {}, onFired: () => {}, getHarness: () => undefined, senderOf: () => "ou_test" };
	const scheduleExt = makeScheduleExtension(scheduleDeps);
	const bgExt = makeBackgroundExtension(deps);
	// forbidden 闭包在调用时解引用（此时 bgExt 已初始化）
	const toolDeps: BackgroundDeps = { ...deps, getHarness: () => harness, forbidden: () => [scheduleExt, bgExt] };
	const bgToolExt = makeBackgroundExtension(toolDeps);
	// 慢速 faux：子会话答案耗时长，reporter 停留在 live（成本闸计数依赖）
	const faux = fauxProvider({ tokensPerSecond: 5 });
	faux.setResponses(Array.from({ length: 40 }, () => fauxAssistantMessage([fauxText("slow answer")])));
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const context = BACKGROUND_CONTEXT;
	const registry = createRegistry();
	registry.install(bgToolExt);
	registry.install(scheduleExt);
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry }, context);
	harness.resume();
	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const parentId = parent.id as number;
		const tool = bgToolExt.tools?.[0];
		if (tool === undefined) throw new Error("dwell.task 未注册");
		// 假 api：把工具用到的四个入口接到真 harness（与 ToolExecutionApi 同形）
		const api = {
			conversationId: parentId,
			registry: registry.snapshot(),
			commit: <T,>(fn: (tx: never) => T | Promise<T>) => parent.commit(fn as never, context),
			snapshot: (doc: never, id: number) => harness.snapshot(doc, id as ConversationId, context),
			conversation: (id: number) => harness.conversation(id as ConversationId, context),
		} as never;
		const out = (r: unknown) => String((r as { output?: { text?: string }[] }).output?.[0]?.text ?? "");
		// 工具内部会把 context 转发给 conversation.abort 等会话 API（需真 Context，不像 lark 工具只当透传）
		const ctx = context as never;

		const started = await tool.execute({ action: "start", name: "w", message: "long job" }, api, ctx);
		assert.match(out(started), /^Started w\./);
		// 子会话 agent：后台/定时扩展已移除（防递归派生），cwd/模型沿用父会话
		const doc = await harness.snapshot(BackgroundDoc, parentId as ConversationId, context);
		const childId = doc?.agents["w"]?.conversationId as number;
		assert.ok(childId !== undefined, "名册应有 w");
		const childAgent = await (await harness.conversation(childId as ConversationId, context))!.agent(context);
		const names = childAgent.extensions.map((e) => e.name);
		assert.ok(!names.includes("dwell-background"), "子会话不应有 dwell.task");
		assert.ok(!names.includes("dwell-schedule"), "子会话不应有 dwell.schedule");

		// 成本闸：start 建 reporter#1，两次 send 各建 #2/#3（子会话慢，全 live）→ 第三次 send 拒绝
		assert.match(out(await tool.execute({ action: "send", name: "w", message: "m1" }, api, ctx)), /^Sent to w\./);
		assert.match(out(await tool.execute({ action: "send", name: "w", message: "m2" }, api, ctx)), /^Sent to w\./);
		const capped = await tool.execute({ action: "send", name: "w", message: "m3" }, api, ctx);
		assert.match(out(capped), /max 3/);

		// stop：删名册、abort 子会话；status 无任务
		assert.match(out(await tool.execute({ action: "stop", name: "w" }, api, ctx)), /^Stopped w\./);
		assert.match(out(await tool.execute({ action: "status" }, api, ctx)), /No background tasks/);
	} finally {
		await harness.close(context).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	}
});

test("集成：回报前 await 归属登记；重开后 backgroundChildren 重建子→父映射", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-bg-attr-"));
	const order: string[] = [];
	const deps: BackgroundDeps = {
		// 登记延迟 resolve：回报的 submit 必须排在登记完成之后
		attribute: async () => {
			order.push("attribute:start");
			await new Promise((r) => setTimeout(r, 30));
			order.push("attribute:done");
		},
		onFired: () => { order.push("fired"); },
		onStarted: () => {},
		senderOf: () => "ou_test",
		forbidden: () => [],
	};
	const Reporter = makeBackgroundReporter(deps);
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("ok")])));
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const context = BACKGROUND_CONTEXT;
	const open = async () => {
		const registry = createRegistry();
		registry.install(makeBackgroundExtension(deps));
		const h = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry }, context);
		h.resume();
		return h;
	};
	let harness = await open();
	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		// 普通会话（非锚持有）不应出现在映射里
		await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const { child, reporter } = await parent.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			const r = await tx.createTask(Reporter, { name: "w", parent: parent.id as number, child: c.id as number, message: "job", creator: "ou_test", followUp: false }, { ownership: { kind: "conversation" }, background: true });
			return { child: c.id as number, reporter: r };
		}, context);
		await until(async () => (await harness.getTask(reporter, context))?.state.status === "terminal");
		assert.deepEqual(order, ["attribute:start", "attribute:done", "attribute:start", "attribute:done", "fired"], "子线投递与父线回报均等待归属登记完成");

		await harness.close(context);
		harness = await open();
		assert.deepEqual(await backgroundChildren(harness), [{ child, parent: parent.id as number }]);
	} finally {
		await harness.close(context).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	}
});

test("a Reporter waits for the host presentation receipt and retries it after reopening without duplicating input", { timeout: 15_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-bg-presentation-"));
	let attempts = 0; let receiptSaved = false;
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const deps: BackgroundDeps = {
		attribute: async () => {}, onStarted: () => {}, senderOf: () => "creator", forbidden: () => [],
		onFired: async () => { if (++attempts === 1) await pending; receiptSaved = true; },
	};
	const models = createModels(); const faux = fauxProvider({ tokensPerSecond: 100_000 });
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(fauxText("done")))); models.setProvider(faux.provider);
	const registry = createRegistry(); registry.install(makeBackgroundExtension(deps));
	const context = BACKGROUND_CONTEXT;
	const open = () => openNodeSqliteStorage(join(dir, "s.sqlite")).then((storage) => Harness.open(storage, { models, registry }, context));
	let harness = await open(); harness.resume();
	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
		const reporter = await parent.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			return tx.createTask(makeBackgroundReporter(deps), { parent: parent.id, child: child.id, name: "worker", message: "work", creator: "creator", followUp: false }, { ownership: { kind: "conversation" }, background: true });
		}, context);
		await until(() => attempts === 1);
		const task = await harness.getTask(reporter, context);
		assert.notEqual(task?.state.status, "terminal", "host presentation must be durable before the Reporter becomes terminal");
		assert.equal(receiptSaved, false);
		await harness.close(context);
		harness = await open(); harness.resume();
		await until(async () => (await harness.getTask(reporter, context))?.state.status === "terminal");
		assert.equal(attempts, 2); assert.equal(receiptSaved, true);
		const reopened = (await harness.conversation(parent.id, context))!;
		const entries = (await reopened.entries({}, 100, undefined, context)).items;
		assert.equal(entries.filter((entry) => JSON.stringify(entry.model ?? []).includes("Background task worker finished")).length, 1);
	} finally { release(); await harness.close(context); await rm(dir, { recursive: true, force: true }); }
});
