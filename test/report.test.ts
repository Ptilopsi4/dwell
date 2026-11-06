// node --test "test/report.test.ts"
// 运行告警：formatReport 字段与截断；节流窗口与抑制计数（注入时钟）；session_failed 旁路；notify 失败不抛；环形缓冲（模块级，测试间共享，断言用相对关系）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationId, ReportInfo, ReportTask } from "@earendil-works/pi-durable";
import { formatReport, makeReporter, recentReports } from "../src/report.ts";

const task = { id: 7, kind: "pi.generation", conversationId: 5 } as ReportTask;

test("formatReport：全字段（reason/task/会话名/extension/错误）", () => {
	const info: ReportInfo = { type: "task_faulted", task, reason: "threw", extension: "dwell" };
	const text = formatReport(new Error("boom"), info, (id) => (id === 5 ? "测试群" : undefined));
	assert.match(text, /\*\*dwell 告警\*\* · task_faulted · threw/);
	assert.match(text, /- 任务：pi\.generation #7/);
	assert.match(text, /- 会话：测试群/);
	assert.match(text, /- 扩展：dwell/);
	assert.match(text, /- 错误：boom/);
});

test("formatReport：会话查不到用 #id；非 Error 取 String()；超 300 字截断加 …", () => {
	const text = formatReport("x".repeat(400), { type: "extension_error", conversationId: 9 as ConversationId, task: undefined }, () => undefined);
	assert.match(text, /\*\*dwell 告警\*\* · extension_error/);
	assert.match(text, /- 会话：#9/);
	assert.ok(text.includes(`- 错误：${"x".repeat(300)}…`));
	assert.ok(!text.includes("x".repeat(301)));
});

test("formatReport：host_error 列 callback；task_outdated 的 reason 附在首行", () => {
	const host = formatReport(new Error("e"), { type: "host_error", callback: "env", task }, () => undefined);
	assert.match(host, /- host 回调：env/);
	assert.match(host, /- 任务：pi\.generation #7/);
	const outdated = formatReport(new Error("e"), { type: "task_outdated", task, reason: "missing_task" }, () => undefined);
	assert.match(outdated, /\*\*dwell 告警\*\* · task_outdated · missing_task/);
});

test("formatReport：session_failed 无 task 行", () => {
	const text = formatReport(new Error("storage reset"), { type: "session_failed" }, () => undefined);
	assert.equal(text, "**dwell 告警** · session_failed\n- 错误：storage reset");
});

test("节流：窗口内同键只发第一条；窗口后放行带抑制计数，随后清零", () => {
	let t = 0;
	const sent: string[] = [];
	const onReport = makeReporter({
		notify: (text) => { sent.push(text); },
		onSessionFailed: () => {},
		nameOf: () => undefined,
		now: () => t,
	});
	const report = () => onReport(new Error("e"), { type: "task_faulted", task, reason: "threw" });
	report();
	report();
	report();
	assert.equal(sent.length, 1); // 窗口内后两条被抑制
	t = 10 * 60_000; // 恰好到窗口边界（差值不小于 windowMs 即放行）
	report();
	assert.equal(sent.length, 2);
	assert.match(sent[1]!, /（此前同类 2 次已抑制）$/);
	t = 20 * 60_000;
	report();
	assert.equal(sent.length, 3);
	assert.doesNotMatch(sent[2]!, /已抑制/); // 计数已清零
});

test("节流：不同键（type / task.kind）互不影响", () => {
	const sent: string[] = [];
	const onReport = makeReporter({
		notify: (text) => { sent.push(text); },
		onSessionFailed: () => {},
		nameOf: () => undefined,
		now: () => 0,
	});
	onReport(new Error("e"), { type: "task_faulted", task, reason: "threw" });
	onReport(new Error("e"), { type: "task_faulted", task: { ...task, kind: "pi.tool" }, reason: "threw" });
	onReport(new Error("e"), { type: "listener_error" });
	assert.equal(sent.length, 3);
});

test("session_failed 绕过节流直达 onSessionFailed", () => {
	const failed: string[] = [];
	const sent: string[] = [];
	const onReport = makeReporter({
		notify: (text) => { sent.push(text); },
		onSessionFailed: (text) => { failed.push(text); },
		nameOf: () => undefined,
		now: () => 0,
	});
	onReport(new Error("s1"), { type: "session_failed" });
	onReport(new Error("s2"), { type: "session_failed" });
	assert.equal(failed.length, 2);
	assert.equal(sent.length, 0);
	assert.match(failed[0]!, /session_failed/);
	assert.match(failed[0]!, /s1/);
});

test("环形缓冲：被节流抑制与 session_failed 的条目也记录，新的在前（模块级缓冲，用前后长度差断言）", () => {
	let t = 1000;
	const sent: string[] = [];
	const failed: string[] = [];
	const before = recentReports().length;
	const onReport = makeReporter({
		notify: (text) => { sent.push(text); },
		onSessionFailed: (text) => { failed.push(text); },
		nameOf: () => undefined,
		now: () => t,
	});
	onReport(new Error("first"), { type: "task_faulted", task, reason: "threw" });
	onReport(new Error("suppressed"), { type: "task_faulted", task, reason: "threw" }); // 窗口内被抑制，不私聊
	t += 5;
	onReport(new Error("failed"), { type: "session_failed" }); // 旁路节流直达 onSessionFailed
	const recs = recentReports();
	assert.equal(recs.length, before + 3);
	assert.equal(recs[0]!.type, "session_failed"); // 新的在前
	assert.equal(recs[0]!.ts, 1005); // ts 用注入的 now()
	assert.match(recs[0]!.text, /failed/);
	assert.match(recs[1]!.text, /suppressed/); // 被抑制的也记录
	assert.match(recs[2]!.text, /first/);
	assert.equal(sent.length, 1); // 私聊仍只发第一条
	assert.equal(failed.length, 1);
});

test("环形缓冲：上限 50 条，写 60 条后长度仍 50 且首条为最后写入", () => {
	const onReport = makeReporter({
		notify: () => {},
		onSessionFailed: () => {},
		nameOf: () => undefined,
		now: () => 0,
	});
	for (let i = 0; i < 60; i++) onReport(new Error(`e${i}`), { type: "extension_error", extension: `x${i}` });
	const recs = recentReports();
	assert.equal(recs.length, 50);
	assert.match(recs[0]!.text, /e59/); // 新的在前：首条是最后写入的那条
	assert.match(recs[49]!.text, /e10/); // e0–e9 已被丢
});

test("notify / onSessionFailed 同步抛错与 reject 都不让 onReport 抛", async () => {
	const syncThrow = makeReporter({ notify: () => { throw new Error("boom"); }, onSessionFailed: () => {}, nameOf: () => undefined });
	assert.doesNotThrow(() => syncThrow(new Error("e"), { type: "listener_error" }));
	const reject = makeReporter({ notify: () => Promise.reject(new Error("reject")), onSessionFailed: () => {}, nameOf: () => undefined });
	assert.doesNotThrow(() => reject(new Error("e"), { type: "listener_error" }));
	const failThrow = makeReporter({ notify: () => {}, onSessionFailed: () => { throw new Error("boom"); }, nameOf: () => undefined });
	assert.doesNotThrow(() => failThrow(new Error("e"), { type: "session_failed" }));
	await new Promise((r) => setTimeout(r, 10)); // 等异步收口跑完（无 unhandled rejection 即通过）
});
