import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Conversation, type ConversationView, type EntryId, type Submission, type SubmissionId, type SubmissionRecord, type Tx } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { mirrorRestoredSubmission } from "../src/feishu/recovery.ts";
import { BACKGROUND_WAIT_NOTICE } from "../src/answer.ts";
import { BACKGROUND_WAIT_TOOL } from "../src/ext/background.ts";

const context = BACKGROUND_CONTEXT;
const assistant = (text: string) => ({ kind: "pi.assistant", model: [fauxAssistantMessage(fauxText(text))] });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function fixture(options: { settled: SubmissionRecord; partial?: string; laterPartial?: string; currentFrame?: string; answer?: string; pendingOnce?: boolean; statusError?: Error; waitReceipt?: "success" | "error" | "absent" }) {
	const id = options.settled.id;
	const initial = {
		entries: [assistant("PREVIOUS RUN ANSWER")],
		docs: { "pi.live": { run: { taskId: 20, inputs: [id] }, generation: { message: fauxAssistantMessage(fauxText(options.partial ?? "")) } } },
	} as unknown as ConversationView;
	const later = {
		entries: [assistant("PREVIOUS RUN ANSWER"), assistant("LATER RUN ANSWER")],
		docs: { "pi.live": options.currentFrame !== undefined
			? { run: { taskId: 20, inputs: [id] }, generation: { message: fauxAssistantMessage(fauxText(options.currentFrame)) } }
			: options.laterPartial === undefined ? {} : { run: { taskId: 30, inputs: [99] }, generation: { message: fauxAssistantMessage(fauxText(options.laterPartial)) } } },
	} as unknown as ConversationView;
	let stopped = false;
	let statusCalls = 0;
	const watch = {
		value: initial,
		start: (listener: (view: ConversationView) => Promise<void>) => { watch.value = later; void listener(later).catch(() => {}); },
		stop: async () => { stopped = true; },
	};
	const conversation = {
		id: 1,
		watch: async () => watch,
		commit: async (change: (tx: Tx) => unknown) => change({
			entry: async (_token: unknown, entryId: EntryId) => {
				assert.equal(entryId, options.settled.answer);
				return options.waitReceipt === undefined ? assistant(options.answer ?? "") : {
					id: entryId, conversationId: 1, kind: "pi.assistant", model: [fauxAssistantMessage([
						fauxText(options.answer ?? ""), fauxToolCall(BACKGROUND_WAIT_TOOL, {}, { id: "wait-call" }),
					], { stopReason: "toolUse" })],
				};
			},
			scanEntries: async () => ({ items: options.waitReceipt === "absent" ? [] : [{
				id: 13, conversationId: 1, kind: "pi.tool-result", byTaskId: 22,
				model: [{ role: "toolResult", toolCallId: "wait-call", toolName: BACKGROUND_WAIT_TOOL, content: [], isError: options.waitReceipt === "error", details: { waitingForBackground: true }, timestamp: 1 }],
			}] }),
			task: async () => ({ kind: "pi.tool", conversationId: 1, input: { kind: "model", assistant: 12, callId: "wait-call" } }),
		} as unknown as Tx),
	} as unknown as Conversation;
	const submission = {
		id,
		status: async () => {
			statusCalls++;
			if (options.statusError !== undefined) throw options.statusError;
			return options.pendingOnce && statusCalls === 1
				? { id, conversationId: options.settled.conversationId, type: "input", status: "placed", entry: 9 as EntryId }
				: options.settled;
		},
		wait: async () => { throw new Error("Recovery presentation must not resume the scheduler before startup finishes"); },
	} as unknown as Submission;
	const chunks: string[] = [];
	return { conversation, submission, append: async (text: string) => { chunks.push(text); }, text: () => chunks.join(""), stopped: () => stopped, statusCalls: () => statusCalls };
}

const unanswered = (reason: string): SubmissionRecord => ({ id: 10 as SubmissionId, conversationId: 1 as never, type: "input", status: "unanswered", reason });
const answered = (): SubmissionRecord => ({ id: 10 as SubmissionId, conversationId: 1 as never, type: "input", status: "done", entry: 9 as EntryId, answer: 12 as EntryId });

test("restored Feishu cancellation reports this submission without repeating an older answer", async () => {
	const f = fixture({ settled: unanswered("aborted") });
	await mirrorRestoredSubmission(f.conversation, f.submission, f.append, async () => "aborted");
	assert.match(f.text(), /处理失败：aborted/);
	assert.doesNotMatch(f.text(), /PREVIOUS RUN ANSWER/);
	assert.equal(f.stopped(), true);
});

test("restored Feishu failure retains the current partial and presents the specific failure", async () => {
	const f = fixture({ settled: unanswered("failed"), partial: "Current partial.", laterPartial: "Unrelated later partial." });
	await mirrorRestoredSubmission(f.conversation, f.submission, f.append, async () => "运行预算已停止任务：执行时间达到上限");
	assert.match(f.text(), /Current partial\./);
	assert.match(f.text(), /运行预算已停止任务：执行时间达到上限/);
	assert.doesNotMatch(f.text(), /PREVIOUS|LATER|Unrelated/);
	assert.equal(f.stopped(), true);
});

test("restored Feishu success completes its own partial and ignores a later run", async () => {
	const f = fixture({ settled: answered(), partial: "Current", laterPartial: "Unrelated later partial.", answer: "Current answer." });
	await mirrorRestoredSubmission(f.conversation, f.submission, f.append, async () => { throw new Error("Success must not request a failure reason"); });
	assert.equal(f.text(), "Current answer.");
	assert.equal(f.stopped(), true);
	assert.ok(f.statusCalls() > 0);
});

test("restored Feishu empty success does not fall back to historical assistant text", async () => {
	const f = fixture({ settled: answered(), answer: "" });
	await mirrorRestoredSubmission(f.conversation, f.submission, f.append, async () => "unused");
	assert.match(f.text(), /本次运行没有产出文本/);
	assert.doesNotMatch(f.text(), /PREVIOUS|LATER/);
});

for (const answer of ["", "I will wait for the result."]) test(`restored Feishu presents a validated wait with ${answer === "" ? "no text" : "its assistant text"}`, async () => {
	const f = fixture({ settled: answered(), answer, waitReceipt: "success" });
	await mirrorRestoredSubmission(f.conversation, f.submission, f.append, async () => { throw new Error("A wait must not request a failure reason"); });
	assert.equal(f.text().trim(), [answer, BACKGROUND_WAIT_NOTICE].filter(Boolean).join("\n\n"));
	assert.doesNotMatch(f.text(), /PREVIOUS|LATER|没有产出文本|处理失败/);
});

for (const waitReceipt of ["error", "absent"] as const) test(`restored Feishu does not infer waiting from a call with an ${waitReceipt} receipt`, async () => {
	const f = fixture({ settled: answered(), waitReceipt });
	await mirrorRestoredSubmission(f.conversation, f.submission, f.append, async () => "unused");
	assert.match(f.text(), /本次运行没有产出文本/);
	assert.ok(!f.text().includes(BACKGROUND_WAIT_NOTICE));
});

test("restored Feishu waits for its submission to settle without starting the scheduler", async () => {
	const f = fixture({ settled: unanswered("aborted"), pendingOnce: true, laterPartial: "Unrelated later partial." });
	await mirrorRestoredSubmission(f.conversation, f.submission, f.append, async () => "aborted");
	assert.equal(f.statusCalls(), 2);
	assert.match(f.text(), /处理失败：aborted/);
	assert.doesNotMatch(f.text(), /PREVIOUS|LATER|Unrelated/);
	assert.equal(f.stopped(), true);
});

test("restored Feishu drains an in-flight frame before completing the answer", async () => {
	const f = fixture({ settled: answered(), currentFrame: "Current", answer: "Current answer." });
	const entered = deferred();
	const release = deferred();
	const chunks: string[] = [];
	let finished = false;
	const mirrored = mirrorRestoredSubmission(f.conversation, f.submission, async (text) => {
		chunks.push(text);
		if (text === "Current") { entered.resolve(); await release.promise; }
	}, async () => "unused").then(() => { finished = true; });
	try {
		await entered.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(finished, false, "Stopping the watch must not return before its active append finishes");
	} finally {
		release.resolve();
		await mirrored;
	}
	assert.equal(chunks.join(""), "Current answer.");
	assert.equal(f.stopped(), true);
});

test("restored Feishu drains its active frame when status lookup fails", async () => {
	const failure = new Error("submission storage unavailable");
	const f = fixture({ settled: answered(), currentFrame: "Current", statusError: failure });
	const entered = deferred();
	const release = deferred();
	let finished = false;
	const mirrored = mirrorRestoredSubmission(f.conversation, f.submission, async () => {
		entered.resolve();
		await release.promise;
	}, async () => "unused").then(() => { finished = true; return undefined; }, (error: unknown) => { finished = true; return error; });
	try {
		await entered.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(finished, false);
	} finally { release.resolve(); }
	assert.equal(await mirrored, failure);
	assert.equal(f.stopped(), true);
});

test("restored Feishu rendering reacquires the exact durable answer after newer submissions finish", async () => {
	const faux = fauxProvider();
	faux.setResponses(["Previous answer.", "Restored answer.", "Later answer."].map((text) => fauxAssistantMessage(fauxText(text))));
	const models = createModels(); models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
		let target: Submission | undefined;
		for (const content of ["previous", "restored", "later"]) {
			const submission = await conversation.submit({ type: "input", content }, context);
			await submission.wait(context);
			if (content === "restored") target = submission;
		}
		const reacquired = await harness.submission(target!.id, context);
		assert.ok(reacquired);
		const chunks: string[] = [];
		await mirrorRestoredSubmission(conversation, reacquired, async (text) => { chunks.push(text); }, async () => "unexpected failure");
		assert.equal(chunks.join(""), "Restored answer.");
	} finally { await harness.close(context); }
});
