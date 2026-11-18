import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createTelegramStreamPresenter, telegramStreamText } from "../src/telegram-stream.ts";

function frame(text = "", options: {
	inputs?: number[];
	parts?: Record<string, unknown>[];
	tools?: Record<string, unknown>[];
	entries?: Record<string, unknown>[];
	retry?: boolean;
} = {}) {
	return { entries: options.entries ?? [], docs: { "pi.live": {
		run: { inputs: options.inputs ?? [10] },
		generation: { message: { content: options.parts ?? [{ type: "text", text }] }, ...(options.retry ? { retry: { at: 1, error: "secret retry failure" } } : {}) },
		tools: options.tools ?? [],
	} } };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 300; i++) { if (predicate()) return; await setImmediate(); }
	assert.fail("condition was not reached");
}

test("only matching submission text is projected, without reasoning or tool payloads", () => {
	const value = frame("", { inputs: [9, 10], parts: [
		{ type: "thinking", thinking: "PRIVATE REASONING", text: "PRIVATE REASONING" },
		{ type: "text", text: "Visible " },
		{ type: "toolCall", name: "bash", arguments: { command: "SECRET ARGUMENT" } },
		{ type: "text", text: "answer" },
	], tools: [{ name: "bash", callId: "private", status: "running", output: "PRIVATE OUTPUT" }] });
	assert.equal(telegramStreamText(value, 10), "Visible answer");
	assert.equal(telegramStreamText(value, 11), undefined);
	assert.equal(telegramStreamText({ docs: {} }, 10), undefined);
	assert.equal(telegramStreamText({ docs: { "pi.live": {} } }, 10), undefined);
	assert.equal(telegramStreamText(frame(), 10), undefined);
	assert.equal(telegramStreamText(frame("", { tools: [{ name: "read", status: "running" }] }), 10), undefined);
	assert.equal(JSON.stringify(value).includes("PRIVATE REASONING"), true);
});

test("execution trace resolves failure and duration from receipts, retaining earlier rounds at settlement", async () => {
	const edits: string[] = [];
	const presenter = createTelegramStreamPresenter({ submissionId: 10, chatType: "p2p", intervalMs: 0, edit: async (text) => { edits.push(text); } });
	const call = { id: 20, model: [{ role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "/private/account/orders.csv", content: "SECRET CONTENT" } }] }] };
	presenter.update(frame("我先核对订单。", { entries: [call], tools: [{ callId: "read-1", name: "read", status: "running", taskId: 21 }] }));
	await until(() => edits.length === 1);
	assert.match(edits[0]!, /我先核对订单。\n\n执行记录\n• `read` · orders.csv · 执行中/);
	const result = { id: 22, model: [{ role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false, durationMs: 1250, content: [{ type: "text", text: "SECRET OUTPUT" }] }] };
	presenter.update(frame("正在验证。", { entries: [call, result], tools: [{ callId: "bash-2", name: "bash", status: "running", taskId: 25 }] }));
	await until(() => edits.length === 2);
	assert.match(edits[1]!, /orders.csv · 已完成 · 1.3 秒/);
	assert.match(edits[1]!, /`bash` · 执行检查 · 执行中/);
	const failed = { id: 26, model: [{ role: "toolResult", toolCallId: "bash-2", toolName: "bash", isError: true, content: [{ type: "text", text: "SECRET ERROR" }] }] };
	await presenter.stop();
	const summary = presenter.summary({ docs: {}, entries: [call, result, failed] });
	assert.match(summary, /orders.csv · 已完成 · 1.3 秒/);
	assert.match(summary, /`bash` · 执行检查 · 失败或中断/);
	assert.doesNotMatch(summary, /SECRET|private|account|0 毫秒/);
});

test("orphaned calls and diagnostic errors are not shown as success", async () => {
	const presenter = createTelegramStreamPresenter({ submissionId: 10, chatType: "p2p", edit: async () => {} });
	presenter.update(frame("", { tools: [
		{ callId: "orphan", name: "write", status: "done" },
		{ callId: "blocked", name: "bash", status: "done", entry: 40 },
	], entries: [{ id: 40, data: { diagnostics: [{ severity: "error", message: "PRIVATE DIAGNOSTIC" }] }, model: [{ role: "toolResult", toolCallId: "blocked", toolName: "bash", isError: false }] }] }));
	await presenter.stop();
	assert.equal((presenter.summary().match(/失败或中断/g) ?? []).length, 2);
	assert.doesNotMatch(presenter.summary(), /已完成|PRIVATE/);
});

test("execution trace stays bounded and escapes metadata without exposing tool payloads", async () => {
	const edits: string[] = [];
	const presenter = createTelegramStreamPresenter({ submissionId: 10, chatType: "p2p", intervalMs: 0, edit: async (text) => { edits.push(text); } });
	for (let i = 0; i < 50; i++) presenter.update(frame("😀".repeat(3_000), { tools: [{ callId: `call-${i}`, name: "read", status: "running" }], parts: [
		{ type: "thinking", thinking: "PRIVATE REASONING" }, { type: "text", text: "😀".repeat(3_000) },
		{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: "/secret/[report]*.txt", output: "PRIVATE OUTPUT" } },
	] }));
	await until(() => edits.length > 0);
	await presenter.stop();
	const summary = presenter.summary();
	assert.equal((summary.match(/•/g) ?? []).length, 6);
	assert.match(summary, /最近 6 项/);
	assert.ok(edits.every((body) => body.length <= 4096 && Buffer.from(body).toString() === body));
	assert.doesNotMatch(edits.join(""), /PRIVATE|secret/);
	assert.match(summary, /\\\[report\\\]\\\*\.txt/);
});

test("provider call IDs reused in later rounds retain distinct receipt identities", async () => {
	const presenter = createTelegramStreamPresenter({ submissionId: 10, chatType: "p2p", edit: async () => {} });
	const caller = (id: number) => ({ id, model: [{ role: "assistant", content: [{ type: "toolCall", id: "same", name: "read", arguments: { path: `file-${id}.txt` } }] }] });
	const result = (id: number, isError: boolean) => ({ id, model: [{ role: "toolResult", toolCallId: "same", toolName: "read", isError, durationMs: id }] });
	presenter.update(frame("", { entries: [caller(20), result(22, false)], tools: [{ callId: "same", name: "read", status: "done", entry: 22 }] }));
	presenter.update(frame("", { entries: [caller(20), result(22, false), caller(30), result(32, true)], tools: [{ callId: "same", name: "read", status: "done", entry: 32 }] }));
	await presenter.stop();
	assert.match(presenter.summary(), /file-20.txt · 已完成 · 22 毫秒/);
	assert.match(presenter.summary(), /file-30.txt · 失败或中断 · 32 毫秒/);
});

test("late subscriptions and settled recovery backfill only the bounded input-to-answer transcript", async () => {
	const presenter = createTelegramStreamPresenter({ submissionId: 10, inputEntryId: 50, chatType: "p2p", edit: async () => {} });
	const caller = (id: number, path: string) => ({ id, model: [{ role: "assistant", content: [{ type: "toolCall", id: "reused", name: "read", arguments: { path } }] }] });
	const result = (id: number, isError: boolean) => ({ id, model: [{ role: "toolResult", toolCallId: "reused", toolName: "read", isError }] });
	const entries = [caller(40, "previous.txt"), result(41, true), { id: 50 }, caller(51, "first.txt"), result(52, false), caller(53, "second.txt"), result(54, true), { id: 55 }, caller(60, "next-run.txt"), result(61, false)];
	await presenter.stop();
	const summary = presenter.summary({ docs: {}, entries }, 55);
	assert.match(summary, /first.txt · 已完成/);
	assert.match(summary, /second.txt · 失败或中断/);
	assert.doesNotMatch(summary, /previous|next-run/);
	const active = createTelegramStreamPresenter({ submissionId: 10, inputEntryId: 50, chatType: "p2p", edit: async () => {} });
	active.update(frame("", { entries: entries.slice(0, 8), tools: [] }));
	await active.stop();
	assert.match(active.summary(), /first.txt · 已完成/);
	const compacted = createTelegramStreamPresenter({ submissionId: 10, inputEntryId: 50, chatType: "p2p", edit: async () => {} });
	compacted.update(frame("", { entries: entries.slice(3, 8), tools: [] }));
	await compacted.stop();
	assert.equal(compacted.summary(), "");
});

for (const name of ["dwell.work", "dwell.task.wait"]) test(`cold recovery includes the ${name} receipt after its terminal assistant`, async () => {
	const presenter = createTelegramStreamPresenter({ submissionId: 10, inputEntryId: 50, chatType: "p2p", edit: async () => {} });
	await presenter.stop();
	const summary = presenter.summary({ docs: {}, entries: [
		{ id: 50 },
		{ id: 51, model: [{ role: "assistant", content: [{ type: "toolCall", id: "terminal", name, arguments: name === "dwell.work" ? { action: "ready" } : {} }] }] },
		{ id: 52, model: [{ role: "user", content: "Queued input during the tool round" }] },
		{ id: 53, model: [{ role: "toolResult", toolCallId: "terminal", toolName: name, isError: false, durationMs: 125 }] },
		{ id: 54, model: [{ role: "assistant", content: [{ type: "toolCall", id: "terminal", name, arguments: { action: "status" } }] }] },
		{ id: 55, model: [{ role: "toolResult", toolCallId: "terminal", toolName: name, isError: true, durationMs: 999 }] },
	] }, 51);
	assert.equal((summary.match(/•/g) ?? []).length, 1);
	assert.match(summary, /已完成 · 125 毫秒/);
	assert.doesNotMatch(summary, /失败|999|查看状态/);
});

for (const reuseCall of [false, true]) test(`cold recovery cannot borrow a receipt after a later assistant ${reuseCall ? "reuses the call ID" : "without tools"}`, async () => {
	const presenter = createTelegramStreamPresenter({ submissionId: 10, inputEntryId: 50, chatType: "p2p", edit: async () => {} });
	await presenter.stop();
	const summary = presenter.summary({ docs: {}, entries: [
		{ id: 50 },
		{ id: 51, model: [{ role: "assistant", content: [{ type: "toolCall", id: "same", name: "read", arguments: { path: "missing-receipt.txt" } }] }] },
		{ id: 52, model: [{ role: "assistant", content: reuseCall
			? [{ type: "toolCall", id: "same", name: "read", arguments: { path: "next-run.txt" } }]
			: [{ type: "text", text: "A later answer without tool calls" }] }] },
		{ id: 53, model: [{ role: "toolResult", toolCallId: "same", toolName: "read", isError: false, durationMs: 999 }] },
	] }, 51);
	assert.match(summary, /missing-receipt.txt · 已结束/);
	assert.doesNotMatch(summary, /已完成|毫秒|next-run/);
});

test("cold recovery resolves parallel receipts and diagnostic failures within their own assistant round", async () => {
	const presenter = createTelegramStreamPresenter({ submissionId: 10, inputEntryId: 50, chatType: "p2p", edit: async () => {} });
	await presenter.stop();
	const summary = presenter.summary({ docs: {}, entries: [
		{ id: 50 },
		{ id: 51, model: [{ role: "assistant", content: [
			{ type: "toolCall", id: "first", name: "read", arguments: { path: "first.txt" } },
			{ type: "toolCall", id: "second", name: "read", arguments: { path: "second.txt" } },
		] }] },
		{ id: 52, data: { diagnostics: [{ severity: "error", message: "PRIVATE DIAGNOSTIC" }] }, model: [{ role: "toolResult", toolCallId: "second", toolName: "read", isError: false, durationMs: 20 }] },
		{ id: 53, model: [{ role: "toolResult", toolCallId: "first", toolName: "read", isError: false, durationMs: 10 }] },
	] }, 51);
	assert.match(summary, /first.txt · 已完成 · 10 毫秒/);
	assert.match(summary, /second.txt · 失败或中断 · 20 毫秒/);
	assert.doesNotMatch(summary, /PRIVATE/);
});

test("a truncated caller requires an explicit live receipt entry instead of guessing from a reused call ID", async () => {
	const presenter = createTelegramStreamPresenter({ submissionId: 10, inputEntryId: 50, chatType: "p2p", edit: async () => {} });
	const result = { id: 49, model: [{ role: "toolResult", toolCallId: "same", toolName: "read", isError: false, durationMs: 999 }] };
	presenter.update(frame("", { entries: [result], tools: [{ callId: "same", name: "read", status: "running", taskId: 60 }] }));
	assert.match(presenter.summary(), /执行中/);
	assert.doesNotMatch(presenter.summary(), /已完成|毫秒/);
	presenter.update(frame("", { entries: [result, { ...result, id: 61, model: [{ ...result.model[0], durationMs: 125 }] }], tools: [{ callId: "same", name: "read", status: "done", taskId: 60, entry: 61 }] }));
	await presenter.stop();
	assert.match(presenter.summary(), /已完成 · 125 毫秒/);
	assert.doesNotMatch(presenter.summary(), /999/);
});

test("a retained trace row cannot borrow a later receipt after its caller leaves the history window", async () => {
	const presenter = createTelegramStreamPresenter({ submissionId: 10, inputEntryId: 50, chatType: "p2p", edit: async () => {} });
	const caller = { id: 51, model: [{ role: "assistant", content: [{ type: "toolCall", id: "same", name: "read", arguments: { path: "original.txt" } }] }] };
	presenter.update(frame("", { entries: [{ id: 50 }, caller], tools: [{ callId: "same", name: "read", status: "running", taskId: 60 }] }));
	await presenter.stop();
	const summary = presenter.summary({ docs: {}, entries: [
		{ id: 50 }, caller,
		{ id: 100, model: [{ role: "assistant", content: [{ type: "toolCall", id: "same", name: "read", arguments: { path: "later.txt" } }] }] },
		...Array.from({ length: 511 }, (_, i) => ({ id: 101 + i })),
		{ id: 612, model: [{ role: "toolResult", toolCallId: "same", toolName: "read", isError: false, durationMs: 999 }] },
	] }, 51);
	assert.match(summary, /original.txt · 失败或中断/);
	assert.doesNotMatch(summary, /已完成|毫秒|later.txt/);
});

test("tool rounds retain only their caller's public action text after the generation partial clears", async () => {
	const edits: string[] = [];
	const presenter = createTelegramStreamPresenter({ submissionId: 10, inputEntryId: 50, chatType: "p2p", intervalMs: 0, edit: async (text) => { edits.push(text); } });
	const entries = [{ id: 50 }, { id: 51, model: [{ role: "assistant", content: [
		{ type: "thinking", thinking: "PRIVATE THOUGHT" }, { type: "text", text: "我先读取订单，再运行断言。" },
		{ type: "toolCall", id: "read-note", name: "read", arguments: { path: "orders.csv" } },
	] }] }];
	const value = frame("", { entries, tools: [{ callId: "read-note", name: "read", status: "running" }] });
	delete (value.docs["pi.live"] as { generation?: unknown }).generation;
	presenter.update(value);
	await until(() => edits.length === 1);
	assert.match(edits[0]!, /^我先读取订单，再运行断言。\n\n执行记录/);
	assert.doesNotMatch(edits[0]!, /PRIVATE/);
	await presenter.stop();
});

test("a long partial keeps a bounded preview and a complete surrogate boundary", () => {
	const plain = "x".repeat(4_096);
	assert.equal(telegramStreamText(frame(plain), 10), plain);
	const long = telegramStreamText(frame("x".repeat(4_097)), 10)!;
	assert.equal(long.length, 4_096);
	const noteAt = long.indexOf("\n\n（内容较长");
	assert.ok(noteAt > 0);
	const boundary = telegramStreamText(frame("x".repeat(noteAt - 1) + "😀" + "z".repeat(4_096)), 10)!;
	assert.equal(boundary.slice(0, boundary.indexOf("\n\n（内容较长")), "x".repeat(noteAt - 1));
	assert.equal(Buffer.from(boundary).toString(), boundary);
	const splitParts = telegramStreamText(frame("", { parts: [
		{ type: "text", text: "a".repeat(4_095) }, { type: "text", text: "😀" },
	] }), 10)!;
	assert.equal(Buffer.from(splitParts).toString(), splitParts);
});

test("partial replacement and retry clear obsolete text rather than accumulating it", async () => {
	const edits: string[] = [];
	const presenter = createTelegramStreamPresenter({ submissionId: 10, chatType: "p2p", intervalMs: 0,
		edit: async (text) => { edits.push(text); } });
	presenter.update(frame("Obsolete partial"));
	await until(() => edits.length === 1);
	presenter.update(frame("", { retry: true }));
	await until(() => edits.length === 2);
	presenter.update(frame("Replacement"));
	await until(() => edits.length === 3);
	await presenter.stop();
	assert.deepEqual(edits, ["Obsolete partial", "正在重试回复……", "Replacement"]);
});

test("frequent frames keep one active edit and only the latest pending snapshot", async () => {
	const gates = [deferred(), deferred()];
	const edits: string[] = [];
	let concurrent = 0;
	let maximum = 0;
	const presenter = createTelegramStreamPresenter({ submissionId: 10, chatType: "group", intervalMs: 0,
		edit: async (text) => {
			const index = edits.length;
			edits.push(text);
			maximum = Math.max(maximum, ++concurrent);
			await gates[index]!.promise;
			concurrent--;
		} });
	presenter.update(frame("First"));
	await until(() => edits.length === 1);
	for (let i = 0; i < 1_000; i++) presenter.update(frame(`New ${i}`));
	presenter.update(frame("Unrelated", { inputs: [99] }));
	assert.deepEqual(edits, ["First"]);
	gates[0]!.resolve();
	await until(() => edits.length === 2);
	assert.deepEqual(edits, ["First", "New 999"]);
	const stop = presenter.stop();
	gates[1]!.resolve();
	assert.deepEqual(await stop, { editFailed: false });
	assert.equal(maximum, 1);
});

test("duplicate snapshots are skipped while a return to earlier text remains valid", async () => {
	const gate = deferred();
	const edits: string[] = [];
	const presenter = createTelegramStreamPresenter({ submissionId: 10, chatType: "p2p", intervalMs: 0,
		edit: async (text) => { edits.push(text); if (text === "Second") await gate.promise; } });
	presenter.update(frame("First"));
	await until(() => edits.length === 1);
	await setImmediate();
	presenter.update(frame("First"));
	await setImmediate();
	assert.equal(edits.length, 1);
	presenter.update(frame("Second"));
	await until(() => edits.length === 2);
	presenter.update(frame("First"));
	gate.resolve();
	await until(() => edits.length === 3);
	await presenter.stop();
	assert.deepEqual(edits, ["First", "Second", "First"]);
});

test("stop drops pending work and joins in-flight edits before final delivery", async () => {
	const gate = deferred();
	const edits: string[] = [];
	const presenter = createTelegramStreamPresenter({ submissionId: 10, chatType: "p2p", intervalMs: 0,
		edit: async (text) => { await gate.promise; edits.push(text); } });
	presenter.update(frame("Current"));
	await setImmediate();
	presenter.update(frame("Pending"));
	let stopped = false;
	const stop = presenter.stop().then(() => { stopped = true; edits.push("Final"); });
	presenter.update(frame("Too late"));
	await setImmediate();
	assert.equal(stopped, false);
	gate.resolve();
	await stop;
	await setImmediate();
	assert.deepEqual(edits, ["Current", "Final"]);
	assert.deepEqual(await presenter.stop(), { editFailed: false });
});

test("the chosen cadence coalesces timer-pending updates and stop cancels the timer", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const edits: string[] = [];
	const presenter = createTelegramStreamPresenter({ submissionId: 10, chatType: "p2p", intervalMs: 50,
		edit: async (text) => { edits.push(text); } });
	presenter.update(frame("First"));
	await setImmediate();
	presenter.update(frame("Intermediate"));
	presenter.update(frame("Latest"));
	t.mock.timers.tick(49);
	await setImmediate();
	assert.deepEqual(edits, ["First"]);
	t.mock.timers.tick(1);
	await setImmediate();
	assert.deepEqual(edits, ["First", "Latest"]);
	presenter.update(frame("Discarded"));
	await presenter.stop();
	t.mock.timers.tick(1_000);
	await setImmediate();
	assert.deepEqual(edits, ["First", "Latest"]);
});

for (const [chatType, interval] of [["p2p", 1_000], ["group", 3_000]] as const) {
	test(`${chatType} partials use their default ${interval} ms cadence`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
		const edits: string[] = [];
		const presenter = createTelegramStreamPresenter({ submissionId: 10, chatType,
			edit: async (text) => { edits.push(text); } });
		presenter.update(frame("First"));
		await setImmediate();
		presenter.update(frame("Next"));
		t.mock.timers.tick(interval - 1);
		await setImmediate();
		assert.equal(edits.length, 1);
		t.mock.timers.tick(1);
		await setImmediate();
		assert.deepEqual(edits, ["First", "Next"]);
		await presenter.stop();
	});
}

for (const throwsSynchronously of [false, true]) {
	test(`a ${throwsSynchronously ? "synchronous" : "rejected"} edit failure disables partials without leaking errors or retry loops`, async () => {
		let attempts = 0;
		const reports: unknown[][] = [];
		const presenter = createTelegramStreamPresenter({ submissionId: 10, chatType: "p2p", intervalMs: 0,
			edit: () => {
				attempts++;
				if (throwsSynchronously) throw new Error("secret token-bearing URL");
				return Promise.reject(new Error("secret token-bearing URL"));
			},
			onEditError: (...args: unknown[]) => { reports.push(args); throw new Error("reporter failure"); },
		});
		presenter.update(frame("First"));
		presenter.update(frame("Pending"));
		await until(() => reports.length === 1);
		for (let i = 0; i < 100; i++) presenter.update(frame(`Later ${i}`));
		assert.deepEqual(await presenter.stop(), { editFailed: true });
		assert.equal(attempts, 1);
		assert.deepEqual(reports, [[]]);
	});
}
