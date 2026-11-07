// node --test "test/schedule.test.ts"
// 定时任务：时间纯函数 + 假时钟集成（触发/周期/取消/重开）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Extension, type Harness as HarnessType, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { formatLocalTime, makeScheduleExtension, makeScheduleRunTask, nextRecurrenceRunAt, parseAtTime, SCHEDULE_TASK_KIND, scanLiveTasks, validateRepeat, type ScheduleInput } from "../src/ext/schedule.ts";

const UTC = "UTC";
const MIN = 60_000;

// ── 纯函数 ──

test("parseAtTime：带 offset 的 ISO 直接解析；无 offset 按 tz 解释", () => {
	const now = Date.UTC(2026, 10, 7, 6, 0); // 2026-11-07 06:00 UTC
	assert.equal(parseAtTime("2026-11-08T09:00+08:00", UTC, now), Date.UTC(2026, 10, 8, 1, 0));
	// 上海 09:00 = UTC 01:00
	assert.equal(parseAtTime("2026-11-08 09:00", "Asia/Shanghai", now), Date.UTC(2026, 10, 8, 1, 0));
	assert.equal(parseAtTime("2026-11-08T09:00:00", "Asia/Shanghai", now), Date.UTC(2026, 10, 8, 1, 0));
});

test("parseAtTime：过去与超远拒绝，格式错误报错", () => {
	const now = Date.UTC(2026, 10, 7, 0, 0);
	assert.throws(() => parseAtTime("2026-11-07 00:00", UTC, now + 1), /past/);
	assert.throws(() => parseAtTime("2027-12-31 00:00", UTC, now), /366/);
	assert.throws(() => parseAtTime("tomorrow", UTC, now), /Invalid time/);
	assert.throws(() => parseAtTime("2026-11-08", UTC, now), /Invalid time/); // 只有日期不行：必须带时间
});

test("nextRecurrenceRunAt：分/时按固定时长推进并跳过错过的多次", () => {
	const base = 1_000_000;
	assert.equal(nextRecurrenceRunAt(base, { unit: "minute", interval: 10 }, base + 10 * MIN, UTC), base + 20 * MIN);
	// 停机错过 3 个周期：跳到下一个晚于 now 的时刻
	assert.equal(nextRecurrenceRunAt(base, { unit: "minute", interval: 10 }, base + 35 * MIN, UTC), base + 40 * MIN);
	assert.equal(nextRecurrenceRunAt(base, { unit: "hour", interval: 2 }, base + 3 * 3_600_000, UTC), base + 4 * 3_600_000);
});

test("nextRecurrenceRunAt：日/周/月按本地日历推进，月末钳制", () => {
	// 1月31日 + 1月 = 2月28日
	const jan31 = Date.UTC(2026, 0, 31);
	assert.equal(nextRecurrenceRunAt(jan31, { unit: "month", interval: 1 }, jan31, UTC), Date.UTC(2026, 1, 28));
	// 周推进
	const nov1 = Date.UTC(2026, 10, 1);
	assert.equal(nextRecurrenceRunAt(nov1, { unit: "week", interval: 1 }, nov1, UTC), Date.UTC(2026, 10, 8));
	// 日推进跨月
	const nov30 = Date.UTC(2026, 10, 30);
	assert.equal(nextRecurrenceRunAt(nov30, { unit: "day", interval: 1 }, nov30, UTC), Date.UTC(2026, 11, 1));
});

test("nextRecurrenceRunAt：weekdays 过滤跳到允许的星期（工作日）", () => {
	// 2026-11-06 周五 → 下一个工作日是周一 2026-11-09
	const fri = Date.UTC(2026, 10, 6);
	assert.equal(nextRecurrenceRunAt(fri, { unit: "day", interval: 1, weekdays: [1, 2, 3, 4, 5] }, fri, UTC), Date.UTC(2026, 10, 9));
	// 周六 → 周一
	const sat = Date.UTC(2026, 10, 7);
	assert.equal(nextRecurrenceRunAt(sat, { unit: "day", interval: 1, weekdays: [1, 2, 3, 4, 5] }, sat, UTC), Date.UTC(2026, 10, 9));
});

test("validateRepeat：间隔下限、weekdays 限制与去重排序", () => {
	assert.throws(() => validateRepeat({ unit: "minute", interval: 5 }, UTC), /at least 10 minutes/);
	assert.throws(() => validateRepeat({ unit: "day", interval: 1, weekdays: [1, 7, 9] }, UTC), /0 \(Sunday\) to 6/);
	assert.throws(() => validateRepeat({ unit: "week", interval: 1, weekdays: [1] }, UTC), /unit 'day' and interval 1/);
	assert.deepEqual(validateRepeat({ unit: "day", interval: 1, weekdays: [5, 1, 1] }, UTC), { unit: "day", interval: 1, weekdays: [1, 5] });
	assert.equal(validateRepeat(undefined, UTC), undefined);
});

test("formatLocalTime 按时区输出", () => {
	assert.equal(formatLocalTime(Date.UTC(2026, 10, 8, 1, 5), "Asia/Shanghai"), "2026-11-08 09:05");
	assert.equal(formatLocalTime(Date.UTC(2026, 10, 8, 1, 5), UTC), "2026-11-08 01:05");
});

// ── 假时钟集成 ──

/** 手动时钟：登记非 background 定时器，advance 推进并触发到期回调。 */
class FakeClock {
	now = 1_700_000_000_000;
	private timers: { at: number; cb: () => void }[] = [];
	readonly options = {
		now: () => this.now,
		setTimer: (cb: () => void, delayMs: number, opts: { readonly background: boolean }) => {
			if (opts.background) return undefined;
			const entry = { at: this.now + Math.max(0, delayMs), cb, disarm: false };
			this.timers.push(entry);
			return () => { entry.disarm = true; this.timers = this.timers.filter((t) => t !== entry); };
		},
	};
	async advance(ms: number): Promise<void> {
		const target = this.now + ms;
		for (;;) {
			const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
			if (due === undefined) break;
			this.timers = this.timers.filter((t) => t !== due);
			this.now = Math.max(this.now, due.at);
			due.cb();
			await new Promise((r) => setImmediate(r));
		}
		this.now = target;
		await new Promise((r) => setImmediate(r));
	}
}

/** 真实时间轮询，直到条件满足或超时（scheduler 是异步的，timer 触发后要给事件循环时间）。 */
const until = async (check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> => {
	for (const end = Date.now() + ms; ;) {
		if (await check()) return;
		if (Date.now() > end) throw new Error("until: timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
};

const lastUserText = async (harness: HarnessType, conversationId: number): Promise<string> => {
	const conv = await harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
	assert.ok(conv !== undefined);
	const page = await conv.entries({}, 50, undefined, BACKGROUND_CONTEXT);
	const users = page.items.filter((e) => (e.model?.[0] as { role?: string } | undefined)?.role === "user"); // 输入 entry（kind chat.message）携带 user model
	return JSON.stringify(users[0]?.model ?? []);
};

test("集成：单次触发提交输入并结束；周期任务续睡；取消不再触发；重开后 sleeping 仍触发", async () => {	const dir = await mkdtemp(join(tmpdir(), "dwell-sched-"));
	const fired: { conversationId: number; header: string; submissionId: SubmissionId }[] = [];
	const clock = new FakeClock();
	const deps = {
		attribute: () => {},
		onFired: (conversationId: number, submissionId: SubmissionId, header: string) => fired.push({ conversationId, header, submissionId }),
		getHarness: () => undefined,
		senderOf: () => "ou_test",
		// 白名单检查：ou_banned 已被移出 → 其 schedule 触发时终止
		isAllowed: (id: string) => id !== "ou_banned",
	};
	const ScheduleRun = makeScheduleRunTask(deps);
	const ext: Extension = makeScheduleExtension(deps);
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 60 }, () => fauxAssistantMessage([fauxText("ack")])));
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const context = BACKGROUND_CONTEXT;

	const open = async () => {
		const registry = createRegistry();
		registry.install(ext);
		const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "s.sqlite")), { models, registry, ...clock.options }, context);
		harness.resume();
		return harness;
	};
	let harness = await open();
	const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
	const convId = conv.id as number;

	const create = (input: Omit<ScheduleInput, "conversationId" | "creator" | "tz">) =>
		conv.commit((tx) => tx.createTask(ScheduleRun, { ...input, conversationId: convId, creator: "ou_test", tz: UTC } as ScheduleInput, { ownership: { kind: "conversation" }, background: true }), context);
	try {
		// 单次
		const once = await create({ id: "schedule:once", instruction: "say hi", firstAt: clock.now + 5 * MIN });
		await clock.advance(6 * MIN);
		await until(() => fired.length === 1);
		const sub = await harness.submission(fired[0].submissionId, context);
		assert.ok(sub !== undefined);
		const settled = await sub.wait(context);
		assert.equal(settled.status, "done");
		assert.match(await lastUserText(harness, convId), /say hi/);
		await until(async () => (await harness.getTask(once, context))?.state.status === "terminal");

		// 周期：5 分钟后首触发，每 10 分钟一次
		await create({ id: "schedule:loop", instruction: "tick", firstAt: clock.now + 5 * MIN, repeat: { unit: "minute", interval: 10 } });
		await clock.advance(6 * MIN);
		await until(() => fired.length === 2);
		assert.match(fired[1].header, /tick/);
		await clock.advance(10 * MIN);
		await until(() => fired.length === 3);
		// 两次触发的 requestId 不同（n 递增），内容都进了会话
		assert.match(await lastUserText(harness, convId), /tick/);

		// 取消：abort 后推进不再触发；terminal 记录不进 scanLiveTasks（status 过滤在 SQL 层生效）
		const before = fired.length;
		const live = await harness.commit((tx) => scanLiveTasks(tx, { conversationId: conv.id, kind: SCHEDULE_TASK_KIND }), context);
		const loop = live.find((t) => (t.input as ScheduleInput).id === "schedule:loop");
		assert.ok(loop !== undefined);
		await harness.abortTask(loop.id, context);
		await until(async () => (await harness.getTask(loop.id, context))?.state.status === "terminal");
		const afterAbort = await harness.commit((tx) => scanLiveTasks(tx, { conversationId: conv.id, kind: SCHEDULE_TASK_KIND }), context);
		assert.ok(!afterAbort.some((t) => (t.input as ScheduleInput).id === "schedule:loop"), "terminal 记录不应出现在活跃扫描里");
		await clock.advance(30 * MIN);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(fired.length, before);

		// 重开：新建 sleeping 的任务在 close/reopen 后照常触发；创建者已被移出白名单的任务触发时终止
		const banned = await conv.commit((tx) => tx.createTask(ScheduleRun, { id: "schedule:banned", instruction: "ghost", firstAt: clock.now + 1 * MIN, conversationId: convId, creator: "ou_banned", tz: UTC } as ScheduleInput, { ownership: { kind: "conversation" }, background: true }), context);
		const after = await create({ id: "schedule:restart", instruction: "reborn", firstAt: clock.now + 20 * MIN });
		assert.ok(after !== undefined);
		await clock.advance(6 * MIN);
		await until(async () => (await harness.getTask(banned, context))?.state.status === "terminal");
		assert.ok(!fired.some((f) => f.header.includes("ghost")), "被移出白名单的创建者不应触发");
		await harness.close(context);
		harness = await open();
		await clock.advance(20 * MIN);
		await until(() => fired.some((f) => f.header.includes("reborn")));
	} finally {
		await harness.close(context).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	}
});
