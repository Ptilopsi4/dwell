import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, ToolResultEntry, createRegistry, defineExtension, defineTool, Harness, type Conversation, type EntryRecord, type EntryId, type JsonObject, type Tx } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import { mainFixture, message } from "./telegram-main-fixture.ts";

const privateState = await mkdtemp(join(tmpdir(), "dwell-ready-state-"));
process.env.DWELL_STATE = privateState;
const { makeWorkController, getWork, workReadyAnswer } = await import("../src/ext/work.ts");
const { beginNewGoal } = await import("../src/new-goal.ts");
const { presentAnswer, workReadyNotice, WORK_READY_NOTICE, WORK_READY_NEXT_STEP } = await import("../src/answer.ts");
const { mirrorRestoredSubmission } = await import("../src/feishu/recovery.ts");
const { presentPanelAnswerEntry, startPanel } = await import("../src/web/server.ts");
after(() => rm(privateState, { recursive: true, force: true }));

const done = () => fauxAssistantMessage(fauxText("Continue after the rejected request."));
const call = (name: string, args = {}) => fauxAssistantMessage(fauxToolCall(name, args, { id: "ready-call" }), { stopReason: "toolUse" });
const start = (verification?: object) => call("dwell.work", { action: "start", goal: "Prepare the review output", acceptance: ["The declared output is ready for inspection"], ...(verification === undefined ? {} : { verification }) });
const ready = (evidence: number[] = [], text = "") => fauxAssistantMessage([
	...(text === "" ? [] : [fauxText(text)]), fauxToolCall("dwell.work", { action: "ready", evidence, review: "Inspect the declared output and the recorded checks" }, { id: "ready-call" }),
], { stopReason: "toolUse" });
const actor = { kind: "chat.message", data: { sender: "owner", via: "panel" } };
const expectedSummary = (verified: boolean) => [
	"目标（工作声明）：Prepare the review output",
	...(verified ? ["交付范围（声明的相对路径）：\n• result.txt", "声明检查的执行结果：\n• Native check：退出码 0"] : ["验证：未声明验证契约；已记录 1 条成功工具结果。"]),
	"评审说明（代理声明）：Inspect the declared output and the recorded checks",
].join("\n\n");

async function setup(options: { compaction?: boolean } = {}) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "dwell-ready-")));
	await writeFile(join(directory, "result.txt"), "Review output\n");
	const work = makeWorkController({ verificationEnv: async () => new NodeExecutionEnv({ cwd: directory }) });
	const registry = createRegistry(); registry.install(CodingTools); registry.install(work.extension);
	registry.install(defineExtension({ name: "ready-presentation-fixtures", tools: [
		defineTool({ name: "probe", description: "Observe the isolated output", parameters: Type.Object({}), replay: "safe", async execute() { return { output: [{ type: "text", text: "Observed the output" }] }; } }),
		defineTool({ name: "nested.ready", description: "Try a nested ready call", parameters: Type.Object({ evidence: Type.Array(Type.Integer()) }), async execute(args, api, ctx) {
			const result = await api.executeTool("dwell.work", { action: "ready", evidence: args.evidence, review: "Nested request" }, ctx);
			return { output: [{ type: "text", text: JSON.stringify(result) }] };
		} }),
	] }));
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	const models = createModels(); models.setProvider(faux.provider);
	const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "s.sqlite")), { models, registry, settings: { compaction: { enabled: options.compaction ?? true } }, env: async () => new NodeExecutionEnv({ cwd: directory }) }, context);
	await work.attach(harness);
	return {
		harness, faux, directory,
		conversation: () => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory } }, context),
		close: async () => { await work.close(); await harness.close(context); await rm(directory, { recursive: true, force: true }); },
	};
}

async function submit(s: Awaited<ReturnType<typeof setup>>, conversation: Conversation, responses: FauxResponseStep[]) {
	s.faux.setResponses(responses);
	const submission = await conversation.submit({ type: "input", content: "Prepare this work for review", entry: actor }, context);
	const settled = await submission.wait(context);
	const errors = settled.status === "done" ? [] : (await entries(s, conversation)).flatMap((entry) => {
		const result = entry.model?.[0];
		return result?.role === "toolResult" && result.isError ? [{ name: result.toolName, output: result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").slice(0, 400) }] : [];
	});
	const taskKinds = settled.status === "done" ? [] : await s.harness.commit(async (tx) => (await tx.scanTasks({}, 100)).items.map((task) => ({ kind: task.kind, status: task.state.status })), context);
	assert.ok(settled.status === "done" && settled.type === "input", JSON.stringify({ settled, errors, taskKinds }));
	return { submission, settled };
}
async function entries(s: Awaited<ReturnType<typeof setup>>, conversation: Conversation) {
	return s.harness.commit(async (tx) => (await tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 100)).items, context);
}

for (const verified of [true, false]) test(`ready presents ${verified ? "declared verification" : "unverified work"} without another model request`, { timeout: 15_000 }, async () => {
	const s = await setup();
	try {
		const conversation = await s.conversation();
		const text = verified ? "" : "The review output is available.";
		const responses: FauxResponseStep[] = verified
			? [start({ checks: [{ name: "Native check", command: 'node -e "process.exit(0)"' }], artifacts: ["result.txt"] }), call("dwell.work", { action: "verify" }), ready()]
			: [start(), call("probe"), async () => {
				const doc = await getWork(s.harness, conversation.id);
				return ready(Object.keys(doc.records[doc.current!]!.availableEvidence).map(Number), text);
			}];
		const { submission, settled } = await submit(s, conversation, responses);
		assert.equal(s.faux.state.callCount, 3, "The ready receipt must settle without a following assistant response");
		const state = await getWork(s.harness, conversation.id);
		const record = state.records[state.current!]!;
		const usage = record.usage;
		const summary = expectedSummary(verified);
		const notice = workReadyNotice(verified, summary);
		assert.deepEqual(await workReadyAnswer(s.harness, conversation.id, settled.answer), { workId: record.id, verified, summary });
		assert.deepEqual(await presentAnswer(s.harness, conversation.id, settled.answer), { text: [text, notice].filter(Boolean).join("\n\n"), waiting: false, ready: true });
		assert.match(notice, /目标（工作声明）/);
		assert.match(notice, /评审说明（代理声明）/);
		assert.ok(notice.endsWith(WORK_READY_NEXT_STEP));
		assert.doesNotMatch(notice, /node -e|process\.exit|s\.sqlite/);
		assert.ok(!notice.includes(s.directory), "Host summaries must not expose the workspace's absolute path");
		const all = await entries(s, conversation);
		const receipt = all.findLast((entry) => ToolResultEntry.is(entry))!;
		const panelEntry = await presentPanelAnswerEntry(s.harness, conversation.id, receipt);
		assert.deepEqual(panelEntry.workReady, { answerEntryId: settled.answer, workId: record.id, verified, summary, text: notice });
		const chunks: string[] = [];
		await mirrorRestoredSubmission(conversation, submission, async (chunk) => { chunks.push(chunk); }, async () => { throw new Error("Ready must not be presented as a failure"); });
		assert.equal(chunks.join("").trim(), [text, notice].filter(Boolean).join("\n\n"));
		assert.doesNotMatch(chunks.join(""), /没有产出文本|处理失败|已验收/);
		assert.equal((await getWork(s.harness, conversation.id)).records[panelEntry.workReady!.workId]!.status, "ready_for_review");
		assert.deepEqual((await getWork(s.harness, conversation.id)).records[record.id]!.usage, usage, "Presentation and recovery must not consume additional admissions");
		assert.equal(s.faux.state.callCount, 3);
	} finally { await s.close(); }
});

test("ready handoffs retain their receipt-time goal, checks and review after revision and a new goal", { timeout: 15_000 }, async () => {
	const s = await setup({ compaction: false });
	try {
		const conversation = await s.conversation();
		const { settled } = await submit(s, conversation, [start({ checks: [{ name: "Native check", command: 'node -e "process.exit(0)"' }], artifacts: ["result.txt"] }), call("dwell.work", { action: "verify" }), ready()]);
		const original = await workReadyAnswer(s.harness, conversation.id, settled.answer);
		const originalText = await presentAnswer(s.harness, conversation.id, settled.answer);
		assert.equal(original?.summary, expectedSummary(true));
		await submit(s, conversation, [call("dwell.work", { action: "revise", checks: [{ name: "Replacement check", command: 'node -e "process.exit(0)"' }], reason: "Review requested a different declared check" }), done()]);
		assert.deepEqual(await workReadyAnswer(s.harness, conversation.id, settled.answer), original);
		assert.deepEqual(await presentAnswer(s.harness, conversation.id, settled.answer), originalText);
		await beginNewGoal(s.harness, { conversationId: conversation.id, expectedWorkId: original!.workId, operator: "owner", requestId: "next-review-goal" });
		await submit(s, conversation, [call("dwell.work", { action: "start", goal: "A later goal must not replace the handoff", acceptance: ["A separate goal is recorded"] }), done()]);
		assert.notEqual((await getWork(s.harness, conversation.id)).current, original!.workId);
		assert.deepEqual(await workReadyAnswer(s.harness, conversation.id, settled.answer), original);
		assert.deepEqual(await presentAnswer(s.harness, conversation.id, settled.answer), originalText);
		assert.doesNotMatch(originalText.text, /Replacement check|A later goal/);
		assert.equal(s.faux.state.callCount, 7, "Historical presentation must not request another model response");
	} finally { await s.close(); }
});

test("ready handoffs bound long declarations and lists without copying commands or workspace paths", { timeout: 15_000 }, async () => {
	const s = await setup({ compaction: false });
	try {
		const conversation = await s.conversation();
		const artifacts = Array.from({ length: 9 }, (_, i) => `output-${i}.txt`);
		await Promise.all(artifacts.map((path) => writeFile(join(s.directory, path), "output")));
		await submit(s, conversation, [
			call("dwell.work", { action: "start", goal: "g".repeat(4000), acceptance: ["The bounded review handoff remains usable"], verification: { checks: Array.from({ length: 9 }, (_, i) => ({ name: `check-${i} ${"n".repeat(180)}`, command: 'node -e "process.exit(0)"' })), artifacts } }),
			call("dwell.work", { action: "verify" }), call("dwell.work", { action: "ready", review: "r".repeat(8000) }),
		]);
		const receipt = (await entries(s, conversation)).findLast(ToolResultEntry.is)!;
		const result = receipt.model?.[0];
		assert.ok(result?.role === "toolResult" && typeof result.details === "object" && result.details !== null && "summary" in result.details && typeof result.details.summary === "string");
		const summary = result.details.summary;
		assert.ok(summary.length < 3200);
		assert.equal(summary.match(/另 1 项/g)?.length, 2);
		assert.match(summary, /output-7\.txt/); assert.match(summary, /check-7/);
		assert.doesNotMatch(summary, /output-8|check-8|node -e|process\.exit/);
		assert.ok(!summary.includes(s.directory));
		assert.equal(s.faux.state.callCount, 3);
	} finally { await s.close(); }
});

for (const kind of ["failed", "mixed", "nested"] as const) test(`${kind} ready cannot produce a host ready presentation`, { timeout: 10_000 }, async () => {
	const s = await setup();
	try {
		const conversation = await s.conversation();
		await submit(s, conversation, [start(), call("probe"), done()]);
		const doc = await getWork(s.harness, conversation.id);
		const evidence = Object.keys(doc.records[doc.current!]!.availableEvidence).map(Number);
		const request = kind === "failed" ? call("dwell.work", { action: "ready", evidence, review: "Still blocked", blockers: ["Review prerequisite is missing"] })
			: kind === "nested" ? call("nested.ready", { evidence })
			: fauxAssistantMessage([fauxToolCall("dwell.work", { action: "ready", evidence, review: "Mixed request" }, { id: "ready-call" }), fauxToolCall("probe", {}, { id: "other-call" })], { stopReason: "toolUse" });
		await submit(s, conversation, [request, done()]);
		for (const entry of await entries(s, conversation)) {
			if (AssistantEntry.is(entry)) assert.equal((await presentAnswer(s.harness, conversation.id, entry.id)).ready, false);
			assert.equal((await presentPanelAnswerEntry(s.harness, conversation.id, entry)).workReady, undefined);
		}
	} finally { await s.close(); }
});

function receiptFixture(change: { answer?: Partial<EntryRecord>; result?: Partial<EntryRecord>; task?: object; details?: object; isError?: boolean; callId?: string; args?: JsonObject; mixed?: boolean } = {}) {
	const answer = {
		id: 12, conversationId: 1, kind: "pi.assistant", model: [fauxAssistantMessage([
			fauxToolCall("dwell.work", change.args ?? { action: "ready" }, { id: "ready-call" }), ...(change.mixed ? [fauxToolCall("probe", {}, { id: "other-call" })] : []),
		], { stopReason: "toolUse" })], ...change.answer,
	} as EntryRecord;
	const receipt = {
		id: 13, conversationId: 1, kind: "pi.tool-result", byTaskId: 22,
		model: [{ role: "toolResult", toolName: "dwell.work", toolCallId: change.callId ?? "ready-call", content: [], details: change.details ?? { workReady: true, workId: "work:1", verified: true }, isError: change.isError ?? false, timestamp: 1 }], ...change.result,
	} as EntryRecord;
	const task = { kind: "pi.tool", conversationId: 1, input: { kind: "model", assistant: 12, callId: "ready-call" }, ...change.task };
	const store = { commit: async (change: (tx: Tx) => unknown) => change({ entry: async (_token: unknown, id: EntryId) => id === answer.id ? answer : undefined, scanEntries: async () => ({ items: [receipt] }), task: async () => task } as unknown as Tx) } as Pick<Harness, "commit">;
	return { store, answer, receipt };
}

test("legacy ready receipts keep their generic notice and unrelated summaries stay hidden", async () => {
	const legacy = receiptFixture();
	assert.deepEqual(await presentAnswer(legacy.store, 1, 12), { text: WORK_READY_NOTICE, waiting: false, ready: true });
	const forged = receiptFixture({ callId: "unrelated", details: { workReady: true, workId: "work:1", verified: true, summary: "Forged handoff" } });
	assert.deepEqual(await presentAnswer(forged.store, 1, 12), { text: "", waiting: false, ready: false });
	assert.equal((await presentPanelAnswerEntry(forged.store, 1, forged.receipt)).workReady, undefined);
});

for (const [name, change] of [
	["failed result", { isError: true }],
	["wrong call", { callId: "other-call" }],
	["wrong assistant", { task: { input: { kind: "model", assistant: 11, callId: "ready-call" } } }],
	["wrong task call", { task: { input: { kind: "model", assistant: 12, callId: "other-call" } } }],
	["nested invocation", { task: { input: { kind: "nested", assistant: 12, callId: "ready-call" } } }],
	["wrong task kind", { task: { kind: "custom.task" } }],
	["wrong task conversation", { task: { conversationId: 2 } }],
	["wrong answer conversation", { answer: { conversationId: 2 } }],
	["missing receipt task", { result: { byTaskId: undefined } }],
	["missing receipt marker", { details: { workId: "work:1", verified: true } }],
	["nonboolean verification", { details: { workReady: true, workId: "work:1", verified: "true" } }],
	["status call", { args: { action: "status" } }],
	["mixed calls", { mixed: true }],
] as const) test(`unrelated ready receipt cannot present completion: ${name}`, async () => {
	const f = receiptFixture(change as Parameters<typeof receiptFixture>[0]);
	assert.deepEqual(await presentAnswer(f.store, 1, 12), { text: "", waiting: false, ready: false });
	assert.equal((await presentPanelAnswerEntry(f.store, 1, f.receipt)).workReady, undefined);
});

for (const severity of ["info", "warn", "error"] as const) test(`panel ready receipt treats ${severity} diagnostics by severity`, async () => {
	const diagnostics = [{ severity, code: severity === "warn" ? "truncated" : "fixture", message: "The diagnostic remains available" }];
	const f = receiptFixture({ result: { data: { diagnostics } } });
	const projected = await presentPanelAnswerEntry(f.store, 1, f.receipt);
	assert.deepEqual(projected.data, { diagnostics });
	assert.equal(projected.workReady?.text, severity === "error" ? undefined : WORK_READY_NOTICE);
});

for (const truncate of [false, true]) test(`ready SSE frames carry host-validated presentation with ${truncate ? "truncated" : "ordinary"} output`, { timeout: 30_000 }, async (t) => {
	// This script covers delivery; a summarizer would consume its queued tool replies.
	const s = await setup({ compaction: false }); t.after(() => s.close());
	const conversation = await s.conversation();
	const before = process.env.DWELL_PANEL_ONLY; process.env.DWELL_PANEL_ONLY = "1";
	const server = startPanel({ harness: s.harness, sessions: {} as never, users: {} as never, directory: {} as never,
		feishu: { operator: () => "owner", status: () => "off", relay: async () => {}, notice: async () => {}, notifyPanel: async () => {}, decide: async () => ({ ok: true }) },
		port: 0, describer: () => null, sandbox: () => false, saveUpload: async () => { throw new Error("Not used"); },
	});
	if (before === undefined) delete process.env.DWELL_PANEL_ONLY; else process.env.DWELL_PANEL_ONLY = before;
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	// Large checkpointed summaries take longer on constrained Linux workers.
	const response = await fetch(`http://127.0.0.1:${address.port}/api/events?conv=${conversation.id}`, { signal: AbortSignal.timeout(20_000) });
	assert.equal(response.status, 200);
	const verification = { checks: [{ name: "Native check", command: 'node -e "process.exit(0)"' }], artifacts: ["result.txt"] };
	if (truncate) verification.checks[0]!.command += `\n#${"c".repeat(6000)}`;
	const { settled } = await submit(s, conversation, [
		truncate ? call("dwell.work", { action: "start", goal: "g".repeat(4000), acceptance: Array.from({ length: 32 }, (_, i) => `${i}:`.padEnd(1000, "a")), verification }) : start(verification),
		call("dwell.work", { action: "verify" }),
		truncate ? call("dwell.work", { action: "ready", progress: "p".repeat(8000), review: "r".repeat(8000) }) : ready(),
	]);
	const receipt = (await entries(s, conversation)).findLast((entry) => ToolResultEntry.is(entry))!;
	assert.equal(s.faux.state.callCount, 3);
	assert.equal(receipt.model?.[0]?.role === "toolResult" && receipt.model[0].isError, false);
		const readyPresentation = await workReadyAnswer(s.harness, conversation.id, settled.answer);
		assert.ok(readyPresentation?.summary);
		const notice = workReadyNotice(true, readyPresentation.summary);
	if (truncate) {
		const verify = (await entries(s, conversation)).filter((entry) => ToolResultEntry.is(entry) && entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "dwell.work").at(-2)!;
		assert.ok(ToolResultEntry.is(verify) && verify.data?.diagnostics.some((diagnostic) => diagnostic.code === "truncated"));
		assert.match(JSON.stringify(verify.model?.[0]), /nextCall/);
		assert.match(JSON.stringify(verify.model?.[0]), /action\\\":\\\"ready/);
		assert.ok(ToolResultEntry.is(receipt) && receipt.data?.diagnostics.some((diagnostic) => diagnostic.severity === "warn" && diagnostic.code === "truncated"), "The real harness must truncate the successful ready output");
			assert.deepEqual(await presentAnswer(s.harness, conversation.id, settled.answer), { text: notice, waiting: false, ready: true });
			assert.ok(readyPresentation.summary.length < 3200, "The separate receipt summary survives truncation of the full work output");
	}
	const reader = response.body!.getReader(); let data = "";
	try { while (!data.includes(WORK_READY_NOTICE)) { const chunk = await reader.read(); assert.equal(chunk.done, false); data += new TextDecoder().decode(chunk.value); } }
	finally { await reader.cancel(); }
	const frames = data.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))) as { mode: string; entries: (EntryRecord & { workReady?: { answerEntryId: EntryId; text: string } })[] }[];
	assert.ok(frames.some((frame) => frame.mode === "append"), "An already open panel must receive the ready receipt in order");
	const notices = frames.flatMap((frame) => frame.entries).filter((entry) => entry.workReady !== undefined);
	assert.equal(notices.length, 1);
	assert.equal(notices[0]!.workReady!.answerEntryId, settled.answer);
		assert.equal(notices[0]!.workReady!.text, notice);
});

test("main Telegram delivers a ready host notice in its original topic without a follow-up model request", { timeout: 60_000 }, async (t) => {
	const f = await mainFixture(t, [
		{ tool: "dwell.work", arguments: { action: "start", goal: "Prepare the topic review output", acceptance: ["The isolated output passes its declared check"], verification: { checks: [{ name: "Native check", command: 'node -e "process.exit(0)"' }], artifacts: ["result.txt"] } } },
		{ tool: "write", arguments: { path: "result.txt", content: "Review output\n" } },
		{ tool: "dwell.work", arguments: { action: "verify" } },
		{ tool: "dwell.work", arguments: { action: "ready", review: "Inspect the output and the declared native check" } },
	]);
	let passed = false;
	try {
		await f.until((event) => event.method === "getUpdates");
		f.updates([message(302, "/ask@AcceptanceBot Prepare topic review output", { chat: { id: -300, type: "supergroup" }, message_thread_id: 9 })]);
		const ready = await f.until((event) => event.method === "editMessageText" && String(event.body.text).startsWith(`${WORK_READY_NOTICE}\n\n目标（工作声明）：`) && String(event.body.text).includes(WORK_READY_NEXT_STEP));
		assert.match(String(ready.body.text), /Prepare the topic review output/);
		assert.match(String(ready.body.text), /result\.txt/);
		assert.match(String(ready.body.text), /Native check：退出码 0/);
		assert.match(String(ready.body.text), /Inspect the output and the declared native check/);
		assert.doesNotMatch(String(ready.body.text), /process\.exit|node -e/);
		assert.match(String(ready.body.text), /dwell.work.*提交验收.*已完成/);
		await f.until((event) => event.method === "telegram.output" && event.body.id === "tg-update:100:302" && event.body.state === "done");
		assert.equal(f.requests("model").length, 4);
		const sends = f.requests("telegram", "sendMessage");
		assert.equal(sends.length, 1);
		assert.equal(sends[0]!.body.chat_id, "-300");
		assert.equal(sends[0]!.body.message_thread_id, 9);
		assert.deepEqual(sends[0]!.body.reply_parameters, { message_id: 302, allow_sending_without_reply: true });
		assert.doesNotMatch(JSON.stringify(f.requests("telegram")), /空回复|没有产出文本|处理失败|已验收/);
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});
