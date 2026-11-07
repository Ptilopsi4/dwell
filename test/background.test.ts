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
import { createRegistry, Harness, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BackgroundAnchor, BACKGROUND_ANCHOR_KIND, backgroundCapViolation, makeBackgroundExtension, makeBackgroundReporter, type BackgroundDeps } from "../src/ext/background.ts";

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
		attribute: () => {},
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
		// 子会话 run 向在流式输出（~350ms）时 abort，Reporter 以 aborted 收场不回报
		await new Promise((r) => setTimeout(r, 80));
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
