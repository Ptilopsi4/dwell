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
import { createRegistry, Harness, LiveDoc, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BackgroundAnchor, BACKGROUND_ANCHOR_KIND, BackgroundDoc, backgroundCapViolation, backgroundChildren, makeBackgroundDeliverer, makeBackgroundExtension, makeBackgroundReporter, type BackgroundDeps } from "../src/ext/background.ts";
import { makeScheduleExtension } from "../src/ext/schedule.ts";

const until = async (check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> => {
	for (const end = Date.now() + ms; ;) {
		if (await check()) return;
		if (Date.now() > end) throw new Error("until: timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
};

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
		onFired: (conversationId, _submissionId, header) => fired.push({ conversationId, header }),
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
		onFired: (conversationId, _submissionId, header) => fired.push({ conversationId, header }),
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
		onFired: (conversationId, _submissionId, header) => fired.push({ conversationId, header }),
		onStarted: () => {},
		senderOf: () => "ou_test",
		forbidden: () => [],
	};
	const scheduleDeps = { attribute: async () => {}, onFired: () => {}, getHarness: () => undefined, senderOf: () => "ou_test" };
	const scheduleExt = makeScheduleExtension(scheduleDeps);
	const bgExt = makeBackgroundExtension(deps);
	// forbidden 闭包在调用时解引用（此时 bgExt 已初始化）
	const toolDeps: BackgroundDeps = { ...deps, forbidden: () => [scheduleExt, bgExt] };
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
		onFired: () => order.push("fired"),
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
		assert.deepEqual(order, ["attribute:start", "attribute:done", "fired"], "登记完成后才 submit 回报并开卡");

		await harness.close(context);
		harness = await open();
		assert.deepEqual(await backgroundChildren(harness), [{ child, parent: parent.id as number }]);
	} finally {
		await harness.close(context).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	}
});
