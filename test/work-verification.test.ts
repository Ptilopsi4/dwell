import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, createRegistry, defineExtension, defineTask, Harness, hook, ToolResultEntry, ToolTask, type Conversation, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GuardedExecutionEnv } from "../src/guarded-env.ts";
import { artifactManifest, verificationContract, VERIFICATION_MAX_BYTES } from "../src/verification.ts";

const state = await mkdtemp(join(tmpdir(), "dwell-verification-state-"));
process.env.DWELL_STATE = state;
const { acceptWork, getWork, inheritWork, makeWorkController, WorkDoc, WORK_MAX_REVISIONS, workReadyAnswer } = await import("../src/ext/work.ts");
const { BackgroundAnchor } = await import("../src/ext/background.ts");
const { makeApprovalExtension, pendingApprovals, removeApprovalTarget } = await import("../src/ext/approval.ts");
const { canonicalWorkspace, makeWorkspaceExtension, registerBackgroundWorkspace } = await import("../src/workspace.ts");
after(() => rm(state, { recursive: true, force: true }));

const supported = { skip: process.platform === "win32" ? "Governed verification files require POSIX" : false };
const done = () => fauxAssistantMessage(fauxText("done"));
const call = (name: string, args = {}) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const operation = (action: string, extra = {}) => call("dwell.work", { action, ...extra });
const start = (verification?: object) => operation("start", { goal: "Complete the declared file task", acceptance: ["The declared native check passes for the current output"], ...(verification === undefined ? {} : { verification }) });
const actor = { kind: "chat.message", data: { sender: "owner", via: "panel" } };
const LeaseHolder = defineTask<null, { phase: "wait" }, null>({
	name: "test.verification-lease", version: 1, initial: () => ({ phase: "wait" }),
	phases: { wait: (_task, runtime, ctx) => runtime.sleepUntil(Date.now() + 60_000, { phase: "wait" }, ctx) },
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
const until = async (check: () => Promise<boolean> | boolean) => {
	for (const deadline = Date.now() + 10_000; ;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error("Verification test timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

async function setup(options: { directory?: string; toolAdmissions?: number; extensions?: (getHarness: () => Harness) => Extension[] } = {}) {
	const directory = options.directory ?? await mkdtemp(join(tmpdir(), "dwell-verification-"));
	const cwd = join(directory, "work");
	await mkdir(join(cwd, "job"), { recursive: true });
	const bases = { cwd, tmp: join(directory, "tmp"), state, appRoot: join(directory, "app"), data: join(directory, "app/data"), sqlite: join(directory, "s.sqlite") };
	let harness!: Harness;
	const environment = async (target = cwd, scoped = false) => GuardedExecutionEnv.create({ cwd: target }, { ...bases, cwd: target, ...(scoped ? { readScope: target } : {}) });
	const work = makeWorkController({ ...(options.toolAdmissions === undefined ? {} : { limits: { toolAdmissions: options.toolAdmissions } }), verificationEnv: async (id, ctx) => environment((await harness.snapshot(AgentDoc, id as ConversationId, ctx))?.cwd ?? cwd, true) });
	const registry = createRegistry(); registry.install(CodingTools); registry.install(work.extension);
	registry.install(defineExtension({ name: "verification-background-anchor", tasks: [BackgroundAnchor, LeaseHolder] }));
	for (const extension of options.extensions?.(() => harness) ?? []) registry.install(extension);
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	const models = createModels(); models.setProvider(faux.provider);
	harness = await Harness.open(await openNodeSqliteStorage(join(directory, "s.sqlite")), { models, registry, env: ({ cwd: target }) => environment(target ?? cwd) }, context);
	await work.attach(harness);
	return {
		harness, faux, directory, cwd, environment,
		conversation: async () => { const c = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd } }, context); await harness.commit(async (tx) => { (await tx.doc(WorkDoc, c.id)).goalMode = true; }, context); return c; },
		close: async (keep = false) => { await work.close(); await harness.close(context); if (!keep) await rm(directory, { recursive: true, force: true }); },
	};
}
async function submit(s: Awaited<ReturnType<typeof setup>>, conversation: Conversation, responses: FauxResponseStep[]) {
	s.faux.setResponses([...responses, done()]);
	return (await conversation.submit({ type: "input", content: "continue the declared task", entry: actor }, context)).wait(context);
}
async function current(s: Awaited<ReturnType<typeof setup>>, id: number) {
	const state = await getWork(s.harness, id);
	assert.ok(state.current);
	return state.records[state.current]!;
}
const check = (command = "node -e \"process.exit(0)\"") => ({ checks: [{ name: "native check", command }], artifacts: ["job/result.txt"] });
const workResult = (messages: readonly Message[]) => {
	const message = messages.findLast((item) => item.role === "toolResult" && item.toolName === "dwell.work");
	assert.ok(message?.role === "toolResult");
	return { message, result: JSON.parse(message.content.filter((part) => part.type === "text").map((part) => part.text).join("")) };
};

test("successful verification preserves blockers and supplies a ready call only after their explicit resolution", { ...supported, timeout: 15_000 }, async () => {
	const s = await setup();
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "output");
		const conversation = await s.conversation();
		const lastWorkResult = async () => {
			const page = await s.harness.commit((tx) => tx.scanEntries({ conversationId: conversation.id, order: "descending" }, 100), context);
			const entry = page.items.find((entry) => ToolResultEntry.is(entry) && entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "dwell.work")!;
			const message = entry.model![0]!; assert.ok(message.role === "toolResult");
			return { message, text: message.content.filter((part) => part.type === "text").map((part) => part.text).join("") };
		};
		await submit(s, conversation, [start(check()), operation("checkpoint", { blockers: ["The requested review prerequisite is still pending"] }), operation("verify")]);
		const verified = await current(s, conversation.id);
		assert.equal(verified.verification?.status, "verified");
		assert.deepEqual(verified.blockers, ["The requested review prerequisite is still pending"]);
		const blocked = JSON.parse((await lastWorkResult()).text);
		assert.equal(blocked.nextCall, undefined);
		assert.match(blocked.nextStep, /Resolve them.*checkpoint.*explicitly clear blockers/);
		await submit(s, conversation, [operation("ready", { review: "The check passed but the prerequisite remains pending" })]);
		assert.match((await lastWorkResult()).text, /Resolve the recorded blockers/);
		assert.equal((await current(s, conversation.id)).status, "active");
		await submit(s, conversation, [operation("checkpoint", { progress: "The review prerequisite has now been resolved", blockers: [] })]);
		const resolved = JSON.parse((await lastWorkResult()).text);
		assert.equal(resolved.nextStep, undefined);
		assert.equal(resolved.nextCall.name, "dwell.work");
		assert.deepEqual(Object.keys(resolved.nextCall.arguments).sort(), ["action", "review"]);
		assert.equal(resolved.nextCall.arguments.action, "ready");
		const calls = s.faux.state.callCount;
		const settled = await submit(s, conversation, [call(resolved.nextCall.name, resolved.nextCall.arguments)]);
		assert.ok(settled.type === "input" && settled.status === "done");
		assert.equal(s.faux.state.callCount, calls + 1);
		assert.equal((await current(s, conversation.id)).status, "ready_for_review");
		assert.deepEqual((await current(s, conversation.id)).blockers, []);
	} finally { await s.close(); }
});

test("unrelated successful evidence cannot replace a failed declared native Node check", { ...supported, timeout: 20_000 }, async () => {
	const s = await setup();
	try {
		await writeFile(join(s.cwd, "job/input.json"), '{"ok":true}');
		await writeFile(join(s.cwd, "job/main.mjs"), 'import value from "./input.json"; if (!value.ok) throw new Error("bad input");');
		await writeFile(join(s.cwd, "job/alternate.mjs"), 'import { readFileSync } from "node:fs"; if (!JSON.parse(readFileSync("job/input.json", "utf8")).ok) process.exit(1);');
		const conversation = await s.conversation();
		await submit(s, conversation, [start({ checks: [{ name: "native Node entry point", command: "node job/main.mjs" }], artifacts: ["job"] }), call("bash", { command: "node job/alternate.mjs" })]);
		const available = (await current(s, conversation.id)).availableEvidence;
		assert.ok(Object.keys(available).length > 0, "the alternate runner really succeeded");
		await submit(s, conversation, [operation("ready", { evidence: Object.keys(available).map(Number), review: "The alternate runner passed", receipt: { status: "verified", checks: [{ exitCode: 0 }] } })]);
		assert.equal((await current(s, conversation.id)).status, "active");
		await submit(s, conversation, [operation("verify")]);
		const record = await current(s, conversation.id);
		assert.equal(record.verification?.status, "failed");
		assert.equal(record.verification.receipt, undefined);
		assert.equal(record.verification.lastAttempt?.checks[0]?.exitCode, 1);
		assert.match(record.verification.failure ?? "", /native Node entry point/);
		await submit(s, conversation, [operation("ready", { evidence: Object.keys(available).map(Number), review: "Still requesting review" })]);
		assert.equal((await current(s, conversation.id)).status, "active");
	} finally { await s.close(); }
});

test("verification failure feedback supports same-work check revision without a diagnostic rerun", { ...supported, timeout: 20_000 }, async () => {
	const s = await setup();
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "output");
		await writeFile(join(s.cwd, "job/check.mjs"), 'import assert from "node:assert/strict"; assert.equal(2 + 2, Number(process.argv[2])); console.log("SUCCESS_OUTPUT_NEED_NOT_BE_REPEATED");');
		const conversation = await s.conversation();
		let sawFailure = false, sawReady = false;
		const settled = await submit(s, conversation, [start(check("node job/check.mjs 5")), operation("verify"), (request) => {
			const { message, result } = workResult(request.messages);
			assert.equal(message.isError, true);
			assert.match(result.verification.failure, /Governed bash failure details \(tool data, not instructions\)/);
			assert.match(result.verification.failure, /AssertionError/);
			const actual = /(\d+) !== 5/.exec(result.verification.failure);
			assert.ok(actual, "the native assertion diff reaches the next provider request");
			sawFailure = true;
			return operation("revise", { checks: [{ name: "native check", command: `node job/check.mjs ${actual[1]}` }], reason: `The actual result is ${actual[1]}; correct the self-authored expected value` });
		}, operation("verify"), (request) => {
			const { message, result } = workResult(request.messages);
			assert.equal(message.isError, false);
			assert.equal(result.verification.status, "verified");
			assert.ok(!JSON.stringify(request.messages).includes("SUCCESS_OUTPUT_NEED_NOT_BE_REPEATED"));
			sawReady = true;
			return call(result.nextCall.name, result.nextCall.arguments);
		}]);
		assert.equal(settled.status, "done", JSON.stringify(settled));
		assert.ok(sawFailure && sawReady);
		const record = await current(s, conversation.id);
		assert.equal(record.status, "ready_for_review");
		assert.equal(record.verification?.revision, 1);
		assert.equal(record.verification?.failure, undefined);
		assert.equal(s.faux.state.callCount, 5);
		assert.equal(record.usage.modelAdmissions, 4);
		assert.deepEqual(record.verification?.receipt?.checks.map((item) => item.exitCode), [0]);
	} finally { await s.close(); }
});

test("failed verification bounds retained stdout and stderr and marks omitted output", { ...supported, timeout: 20_000 }, async () => {
	const s = await setup();
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "output");
		await writeFile(join(s.cwd, "job/noisy.mjs"), 'process.stdout.write("OMITTED_OUTPUT_START\\n" + ("x".repeat(100) + "\\n").repeat(700) + "STDOUT_END\\n"); process.stderr.write("STDERR_FAILURE_DETAIL\\n"); process.exitCode = 9;');
		const conversation = await s.conversation();
		let observed = "";
		const settled = await submit(s, conversation, [start(check("node job/noisy.mjs")), operation("verify"), (request) => {
			const { message, result } = workResult(request.messages);
			assert.equal(message.isError, true);
			observed = result.verification.failure;
			assert.match(observed, /STDOUT_END/);
			assert.match(observed, /STDERR_FAILURE_DETAIL/);
			assert.match(observed, /Command exited with code 9/);
			assert.match(observed, /Bash retained only part/);
			assert.match(observed, /Earlier output truncated; showing the last 4000 characters/);
			assert.ok(!observed.includes("OMITTED_OUTPUT_START"));
			assert.ok(observed.length < 6500);
			return done();
		}]);
		assert.equal(settled.status, "done", JSON.stringify(settled));
		assert.equal((await current(s, conversation.id)).verification?.failure, observed);
	} finally { await s.close(); }
});

test("a timed-out declared check exposes the nested bash diagnostic to the next model request", { ...supported, timeout: 20_000 }, async () => {
	const s = await setup({ extensions: () => [defineExtension({ name: "short-verification-timeout", hooks: [hook(ToolTask, {
		beforeTool: (call) => call.name === "bash" ? { arguments: { ...call.arguments, timeout: 0.1 } } : undefined,
	})] })] });
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "output");
		const conversation = await s.conversation();
		let observed = false;
		const settled = await submit(s, conversation, [start(check('node -e "setInterval(() => {}, 1000)"')), operation("verify"), (request) => {
			const { message, result } = workResult(request.messages);
			assert.equal(message.isError, true);
			assert.match(result.verification.failure, /Command timed out after 0\.1 seconds/);
			assert.equal(result.verification.lastAttempt.checks[0].exitCode, null);
			assert.equal(result.verification.receipt, undefined);
			observed = true;
			return done();
		}]);
		assert.equal(settled.status, "done", JSON.stringify(settled));
		assert.ok(observed);
	} finally { await s.close(); }
});

test("receipts bind successful commands to current files and ready/status/accept never run checks", { ...supported, timeout: 20_000 }, async () => {
	const s = await setup();
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "first version");
		const command = 'node -e "require(\'node:fs\').appendFileSync(\'check-count\',\'x\')"';
		const conversation = await s.conversation();
		await submit(s, conversation, [start(check(command)), operation("verify"), operation("ready", { review: "The declared command passed for this version" })]);
		await submit(s, conversation, [operation("status")]);
		let record = await current(s, conversation.id);
		assert.equal(record.status, "ready_for_review");
		assert.equal(record.verification?.status, "verified");
		assert.equal(record.verification.receipt?.workId, record.id);
		assert.equal(record.verification.receipt?.checks[0]?.command, command);
		assert.equal(record.verification.receipt?.checks[0]?.exitCode, 0);
		assert.ok(record.verification.receipt?.checks[0]?.taskId);
		assert.equal(await readFile(join(s.cwd, "check-count"), "utf8"), "x");
		await writeFile(join(s.cwd, "job/result.txt"), "second version");
		await submit(s, conversation, [operation("ready", { review: "Old receipt" })]);
		record = await current(s, conversation.id);
		assert.equal(record.status, "active"); assert.equal(record.verification?.status, "stale");
		assert.equal(await readFile(join(s.cwd, "check-count"), "utf8"), "x");
		await submit(s, conversation, [operation("verify"), operation("ready", { review: "Verified again" })]);
		await writeFile(join(s.cwd, "job/result.txt"), "third version");
		await assert.rejects(acceptWork(s.harness, conversation.id, record.id, "operator"), /changed/);
		assert.equal((await current(s, conversation.id)).verification?.status, "stale");
		assert.equal(await readFile(join(s.cwd, "check-count"), "utf8"), "xx");
		await submit(s, conversation, [operation("verify"), operation("ready", { review: "Current final version" })]);
		assert.equal((await acceptWork(s.harness, conversation.id, record.id, "operator")).status, "accepted");
		assert.equal(await readFile(join(s.cwd, "check-count"), "utf8"), "xxx");
	} finally { await s.close(); }
});

test("a failed inline check can be corrected without replacing the work, scope, baseline or budgets", { ...supported, timeout: 20_000 }, async () => {
	let s = await setup();
	const directory = s.directory;
	try {
		await writeFile(join(s.cwd, "job/input.json"), '{"ok":true}');
		const broken = "node --input-type=module -e \"import value from './job/input.json'; if (!value.ok) process.exit(1);\"";
		const corrected = "node --input-type=module -e \"import value from './job/input.json' with { type: 'json' }; if (!value.ok) process.exit(1);\"";
		const conversation = await s.conversation();
		await submit(s, conversation, [start({ checks: [{ name: "native inline check", command: broken }], artifacts: ["job", "job/result.txt"], allowedChanges: ["job/result.txt"] })]);
		const original = await current(s, conversation.id);
		await writeFile(join(s.cwd, "job/result.txt"), "output");
		await submit(s, conversation, [operation("verify")]);
		const failed = await current(s, conversation.id);
		assert.equal(failed.verification?.status, "failed");
		assert.equal(failed.verification?.lastAttempt?.checks[0]?.exitCode, 1);
		await submit(s, conversation, [operation("revise", { checks: [{ name: "native inline check", command: corrected }], reason: "The inline JSON import requires a type attribute in native Node" })]);
		const revised = await current(s, conversation.id);
		assert.equal(revised.id, original.id);
		assert.equal(revised.creator, original.creator);
		assert.equal(revised.goal, original.goal);
		assert.deepEqual(revised.acceptance, original.acceptance);
		assert.deepEqual(revised.limits, original.limits);
		assert.deepEqual(revised.verification?.baseline, original.verification?.baseline);
		assert.deepEqual(revised.verification?.contract.artifacts, original.verification?.contract.artifacts);
		assert.deepEqual(revised.verification?.contract.allowedChanges, original.verification?.contract.allowedChanges);
		assert.equal(revised.verification?.revision, 1);
		assert.equal(revised.verification?.status, "unverified");
		assert.equal(revised.verification?.receipt, undefined);
		assert.equal(revised.verification?.lastAttempt, undefined);
		assert.ok(revised.usage.toolAdmissions > failed.usage.toolAdmissions);
		assert.ok(revised.usage.modelAdmissions > failed.usage.modelAdmissions);
		const history = revised.verification!.revisionHistory!;
		assert.equal(history.length, 1);
		assert.deepEqual(history[0]?.oldChecks, original.verification?.contract.checks);
		assert.deepEqual(history[0]?.oldAttempt, failed.verification?.lastAttempt);
		assert.equal(history[0]?.actor, "owner");
		assert.equal(history[0]?.revision, 0);
		assert.ok(history[0]!.taskId > 0 && history[0]!.revisedAt >= original.createdAt);
		assert.match(history[0]!.reason, /type attribute/);
		await submit(s, conversation, [operation("ready", { review: "The revised check still needs verification" })]);
		assert.equal((await current(s, conversation.id)).status, "active");
		await s.close(true); s = await setup({ directory });
		const resumed = (await s.harness.conversation(conversation.id, context))!;
		assert.deepEqual((await current(s, conversation.id)).verification?.revisionHistory, history);
		await submit(s, resumed, [operation("verify")]);
		const verified = await current(s, conversation.id);
		assert.equal(verified.verification?.status, "verified");
		assert.equal(verified.verification?.receipt?.revision, 1);
		const page = await s.harness.commit((tx) => tx.scanEntries({ conversationId: conversation.id, order: "descending" }, 100), context);
		const verifyResult = page.items.find((entry) => ToolResultEntry.is(entry) && entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "dwell.work" && !entry.model[0].isError)!;
		const message = verifyResult.model![0]!;
		assert.ok(message.role === "toolResult");
		const result = JSON.parse(message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
		assert.equal(result.nextCall.name, "dwell.work");
		assert.deepEqual(Object.keys(result.nextCall.arguments).sort(), ["action", "review"]);
		assert.equal(result.nextCall.arguments.action, "ready");
		assert.match(result.nextCall.arguments.review, /declared check passed|in their language/);
		await submit(s, resumed, [operation("ready", { evidence: [999999], review: result.nextCall.arguments.review })]);
		assert.equal((await current(s, conversation.id)).status, "active", "a verified receipt does not excuse invalid supplementary evidence");
		const calls = s.faux.state.callCount;
		const settled = await submit(s, resumed, [call(result.nextCall.name, result.nextCall.arguments)]);
		assert.ok(settled.type === "input" && settled.status === "done");
		assert.equal(s.faux.state.callCount, calls + 1);
		// 修订过一次（失败后修正）：卡片摘要只报结论，命令与修订史留在面板工作记录
		const summary = `目标：${original.goal}\n\n交付文件：\n• job\n• job/result.txt\n\n已通过 1 项自动检查；命令与明细见面板「工作记录与验收」。\n\n交付说明：${result.nextCall.arguments.review}`;
		assert.deepEqual(await workReadyAnswer(s.harness, conversation.id, settled.answer), { workId: original.id, verified: true, summary });
		assert.equal((await current(s, conversation.id)).status, "ready_for_review");
		await submit(s, resumed, [operation("revise", { checks: [{ name: "native inline check", command: corrected }], reason: "Retain the previous successful receipt in the revision audit" })]);
		const second = await current(s, conversation.id);
		assert.equal(second.verification?.revision, 2);
		assert.equal(second.verification?.receipt, undefined);
		assert.deepEqual(second.verification?.revisionHistory?.[1]?.oldReceipt, verified.verification?.receipt);
		assert.deepEqual(second.verification?.baseline, original.verification?.baseline);
		await assert.rejects(acceptWork(s.harness, conversation.id, original.id, "operator"), /ready for review/);
	} finally { await s.close(); }
});

test("revisions reject unknown top-level scope fields without changing verification or tool allowance", { ...supported, timeout: 15_000 }, async () => {
	const s = await setup();
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "output");
		const conversation = await s.conversation();
		await submit(s, conversation, [start({ ...check(), artifacts: ["job", "job/result.txt"], allowedChanges: ["job/result.txt"] }), operation("verify")]);
		assert.equal((await current(s, conversation.id)).verification?.status, "verified");
		for (const [field, paths] of [["allowedChanges", ["job"]], ["artifacts", ["."]]] as const) {
			const before = await current(s, conversation.id);
			const callId = `invalid-revise-${field}`;
			let rejected: boolean | undefined;
			await submit(s, conversation, [
				fauxAssistantMessage(fauxToolCall("dwell.work", { action: "revise", checks: check('node -e "process.exit(7)"').checks, reason: "Try to change the immutable scope through a top-level field", [field]: paths }, { id: callId }), { stopReason: "toolUse" }),
				async (request) => {
					const result = request.messages.findLast((message) => message.role === "toolResult" && message.toolCallId === callId);
					if (result?.role === "toolResult") rejected = result.isError === true;
					return done();
				},
			]);
			assert.equal(rejected, true, `${field} must be rejected instead of silently ignored`);
			const after = await current(s, conversation.id);
			assert.deepEqual(after.verification, before.verification, "revision, receipt, checks, baseline and scope remain unchanged");
			assert.deepEqual(after.limits, before.limits);
			assert.equal(after.stopped, before.stopped);
			assert.equal(after.usage.toolAdmissions, before.usage.toolAdmissions);
			assert.equal(after.usage.toolResults, before.usage.toolResults);
			assert.equal(after.usage.modelAdmissions, before.usage.modelAdmissions + 2, "model requests remain charged without resetting the allowance");
		}
	} finally { await s.close(); }
});

test("revisions retain creator and root authority and accepted work is immutable", { ...supported, timeout: 15_000 }, async () => {
	const s = await setup();
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "output");
		const parent = await s.conversation();
		await submit(s, parent, [start(check())]);
		const original = await current(s, parent.id);
		const revise = operation("revise", { checks: check().checks, reason: "Correct a declared check" });
		s.faux.setResponses([revise, done()]);
		await (await parent.submit({ type: "input", content: "try another actor", entry: { kind: "chat.message", data: { sender: "other", via: "panel" } } }, context)).wait(context);
		const childId = await s.harness.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true, conversationId: parent.id });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			const agent = await tx.doc(AgentDoc, child.id); agent.model = { provider: "faux", modelId: "faux-1" }; agent.cwd = s.cwd;
			await inheritWork(tx, parent.id, child.id);
			return child.id;
		}, context);
		await submit(s, (await s.harness.conversation(childId, context))!, [revise]);
		await submit(s, parent, [operation("revise", { checks: check().checks, reason: " " })]);
		await submit(s, parent, [operation("revise", { reason: "Checks must be supplied" })]);
		await submit(s, parent, [operation("revise", { checks: check().checks, reason: "Try to replace the goal", goal: "Another task" })]);
		await submit(s, parent, [operation("revise", { checks: check().checks, reason: "Change scope", verification: { ...check(), artifacts: ["."] } })]);
		assert.deepEqual((await current(s, parent.id)).verification, original.verification);
		await submit(s, parent, [operation("verify"), operation("ready", { review: "The declared check exited zero for this artifact version" })]);
		await acceptWork(s.harness, parent.id, original.id, "operator");
		await submit(s, parent, [revise]);
		const accepted = await current(s, parent.id);
		assert.equal(accepted.status, "accepted");
		assert.equal(accepted.verification?.revision, 0);
		assert.equal(accepted.verification?.revisionHistory, undefined);
	} finally { await s.close(); }
});

test("legacy revision zero is read without migration and revision mismatch cannot be accepted", { ...supported, timeout: 15_000 }, async () => {
	const s = await setup();
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "output");
		const conversation = await s.conversation();
		await submit(s, conversation, [start(check()), operation("verify"), operation("ready", { review: "The declared check passed" })]);
		const before = await current(s, conversation.id);
		await s.harness.commit(async (tx) => {
			const verification = (await tx.doc(WorkDoc, conversation.id)).records[before.id]!.verification!;
			delete verification.revision; delete verification.receipt!.revision;
		}, context);
		await submit(s, conversation, [operation("status")]);
		assert.equal((await current(s, conversation.id)).verification?.revision, undefined);
		await s.harness.commit(async (tx) => { (await tx.doc(WorkDoc, conversation.id)).records[before.id]!.verification!.receipt!.revision = 1; }, context);
		await assert.rejects(acceptWork(s.harness, conversation.id, before.id, "operator"), /Run verify successfully/);
		assert.equal((await current(s, conversation.id)).status, "ready_for_review");
		await submit(s, conversation, [operation("revise", { checks: check().checks, reason: "Correct the check from a legacy revision" })]);
		const revised = await current(s, conversation.id);
		assert.equal(revised.verification?.revision, 1);
		assert.equal(revised.verification?.revisionHistory?.[0]?.revision, 0);
		assert.equal(revised.verification?.receipt, undefined);
	} finally { await s.close(); }
});

test("revising checks cannot reset an exhausted allowance, including after reopen", { ...supported, timeout: 15_000 }, async () => {
	let s = await setup({ toolAdmissions: 3 });
	const directory = s.directory;
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "output");
		const conversation = await s.conversation();
		await submit(s, conversation, [start(check()), operation("verify"), operation("revise", { checks: check().checks, reason: "One command correction" })]);
		const revised = await current(s, conversation.id);
		assert.equal(revised.usage.toolAdmissions, 3);
		assert.equal(revised.verification?.revision, 1);
		await submit(s, conversation, [operation("revise", { checks: check().checks, reason: "Try to bypass the exhausted allowance" })]);
		const stopped = await current(s, conversation.id);
		assert.equal(stopped.stopped, "tool_limit");
		assert.equal(stopped.verification?.revision, 1);
		assert.deepEqual(stopped.verification?.revisionHistory, revised.verification?.revisionHistory);
		await s.close(true); s = await setup({ directory, toolAdmissions: 4096 });
		const resumed = (await s.harness.conversation(conversation.id, context))!;
		await submit(s, resumed, [operation("revise", { checks: check().checks, reason: "Try again after restart" })]);
		assert.equal(s.faux.state.callCount, 0);
		const after = await current(s, conversation.id);
		assert.equal(after.limits.toolAdmissions, 3);
		assert.equal(after.usage.toolAdmissions, 3);
		assert.equal(after.verification?.revision, 1);
	} finally { await s.close(); }
});

test("revision history stays bounded without discarding retained audit entries", { ...supported, timeout: 10_000 }, async () => {
	const s = await setup();
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "output");
		const conversation = await s.conversation();
		await submit(s, conversation, [start(check())]);
		await submit(s, conversation, Array.from({ length: WORK_MAX_REVISIONS }, (_, i) => operation("revise", { checks: [{ name: `check ${i + 1}`, command: "true" }], reason: `Correction ${i + 1}` })));
		const before = await current(s, conversation.id);
		assert.equal(before.verification?.revision, WORK_MAX_REVISIONS);
		assert.equal(before.verification?.revisionHistory?.length, WORK_MAX_REVISIONS);
		await submit(s, conversation, [operation("revise", { checks: check().checks, reason: "This would discard retained audit history" })]);
		assert.deepEqual((await current(s, conversation.id)).verification, before.verification);
	} finally { await s.close(); }
});

test("verification completion cannot stamp a receipt for a newer revision", { ...supported, timeout: 10_000 }, async () => {
	let changeRevision = true;
	const s = await setup({ extensions: (getHarness) => [defineExtension({ name: "verification-revision-race", hooks: [hook(ToolTask, { afterTool: async (call, result, api, ctx) => {
		if (call.name !== "bash" || result.isError || !changeRevision) return undefined;
		changeRevision = false;
		await getHarness().commit(async (tx) => {
			const doc = await tx.doc(WorkDoc, api.conversationId);
			const verification = doc.records[doc.current!]!.verification!;
			verification.revision = (verification.revision ?? 0) + 1;
		}, ctx);
		return undefined;
	} })] })] });
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "output");
		const conversation = await s.conversation();
		await submit(s, conversation, [start(check()), operation("verify")]);
		const record = await current(s, conversation.id);
		assert.equal(record.verification?.revision, 1);
		assert.equal(record.verification?.status, "unverified");
		assert.equal(record.verification?.receipt, undefined);
		const page = await s.harness.commit((tx) => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 100), context);
		assert.match(JSON.stringify(page.items), /revised while checks were running/);
	} finally { await s.close(); }
});

test("model summaries retain revision metadata without repeating historical commands or receipts", { ...supported, timeout: 15_000 }, async () => {
	const s = await setup();
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "output");
		const conversation = await s.conversation();
		const oldCommand = `node -e "process.exit(0)" # historical-command-${"x".repeat(6000)}`;
		await submit(s, conversation, [start(check(oldCommand)), operation("verify"), operation("revise", { checks: check().checks, reason: "Replace the verbose original command" }), operation("verify"), operation("status")]);
		const record = await current(s, conversation.id);
		const history = record.verification!.revisionHistory!;
		assert.equal(history[0]!.oldChecks[0]!.command, oldCommand);
		assert.equal(history[0]!.oldReceipt!.checks[0]!.command, oldCommand);
		assert.equal(history[0]!.oldAttempt!.checks[0]!.command, oldCommand);
		const page = await s.harness.commit((tx) => tx.scanEntries({ conversationId: conversation.id, order: "descending" }, 100), context);
		const entry = page.items.find((item) => ToolResultEntry.is(item) && item.model?.[0]?.role === "toolResult" && item.model[0].toolName === "dwell.work")!;
		const message = entry.model![0]!; assert.ok(message.role === "toolResult");
		const result = JSON.parse(message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
		const expected = { count: 1, latest: { revision: 0, reason: history[0]!.reason, actor: "owner", taskId: history[0]!.taskId, revisedAt: history[0]!.revisedAt, checkCount: 1, checkNames: ["native check"], oldReceiptTaskId: history[0]!.oldReceipt!.taskId, oldAttemptTaskId: history[0]!.oldAttempt!.taskId } };
		assert.deepEqual(result.verification.revisionHistory, expected);
		assert.ok(JSON.stringify(result.verification.revisionHistory).length < 500);
		assert.equal(result.verification.receipt.checks[0].command, check().checks[0]!.command);
		assert.equal(result.nextCall.arguments.action, "ready");
		let injected = "";
		s.faux.setResponses([async (request) => {
			const content = request.messages.filter((item) => item.role === "user" && typeof item.content === "string" && item.content.startsWith("[Durable work record;")).at(-1)?.content;
			if (typeof content === "string") injected = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
			return done();
		}]);
		await (await conversation.submit({ type: "input", content: "inspect current progress", entry: actor }, context)).wait(context);
		assert.deepEqual(JSON.parse(injected).verification.revisionHistory, expected);
		assert.ok(!injected.includes("historical-command-"));
		assert.deepEqual((await current(s, conversation.id)).verification?.revisionHistory, history);
	} finally { await s.close(); }
});

test("strict output scopes require outputs and preserve inputs while catching hidden extra files", { ...supported, timeout: 30_000 }, async (t) => {
	for (const scenario of ["allowed output", "missing output", "changed input", "extra cache file"]) await t.test(scenario, async () => {
		const s = await setup();
		try {
			await writeFile(join(s.cwd, "job/input.txt"), "original input");
			const conversation = await s.conversation();
			await submit(s, conversation, [start({ ...check(), artifacts: ["job", "job/result.txt"], allowedChanges: ["job/result.txt"] })]);
			if (scenario !== "missing output") await writeFile(join(s.cwd, "job/result.txt"), "output");
			if (scenario === "changed input") await writeFile(join(s.cwd, "job/input.txt"), "modified input");
			if (scenario === "extra cache file") { await mkdir(join(s.cwd, "job/.npm")); await writeFile(join(s.cwd, "job/.npm/cache"), "extra"); }
			await submit(s, conversation, [operation("verify"), operation("ready", { review: "Declared command and bounded output checks" })]);
			const record = await current(s, conversation.id);
			assert.equal(record.status, scenario === "allowed output" ? "ready_for_review" : "active");
			assert.equal(record.verification?.status, scenario === "allowed output" ? "verified" : "failed");
			if (scenario === "changed input") assert.match(record.verification!.failure ?? "", /job\/input.txt/);
			if (scenario === "extra cache file") assert.match(record.verification!.failure ?? "", /job\/\.npm/);
		} finally { await s.close(); }
	});
});

test("a successful receipt survives restart and still requires the original workspace version", { ...supported, timeout: 15_000 }, async () => {
	let s = await setup();
	const directory = s.directory;
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "durable result");
		const conversation = await s.conversation();
		await submit(s, conversation, [start(check()), operation("verify"), operation("ready", { review: "Verified version" })]);
		const before = await current(s, conversation.id);
		await s.close(true); s = await setup({ directory });
		assert.deepEqual((await current(s, conversation.id)).verification?.receipt, before.verification?.receipt);
		assert.equal((await acceptWork(s.harness, conversation.id, before.id, "operator")).status, "accepted");
	} finally { await s.close(); }
});

test("nested declared commands retain approval and work allowance admission", { ...supported, timeout: 20_000 }, async (t) => {
	await t.test("approval blocks the nested bash before side effects", async () => {
		const s = await setup({ extensions: (getHarness) => [makeApprovalExtension(getHarness)] });
		let id: number | undefined;
		try {
			await writeFile(join(s.cwd, "job/result.txt"), "preserved");
			const conversation = await s.conversation(); id = conversation.id;
			let observed = false;
			const settled = await submit(s, conversation, [start(check("rm -rf job")), operation("verify"), (request) => {
				const { message, result } = workResult(request.messages);
				assert.equal(message.isError, true);
				assert.match(result.verification.failure, /The approval policy blocked this command/);
				assert.match(result.verification.failure, /approve it in the panel/);
				observed = true;
				return done();
			}]);
			assert.equal(settled.status, "done", JSON.stringify(settled));
			assert.ok(observed);
			assert.equal(await readFile(join(s.cwd, "job/result.txt"), "utf8"), "preserved");
			const record = await current(s, conversation.id);
			assert.equal(record.verification?.status, "failed");
			assert.equal(record.verification.receipt, undefined);
			assert.equal(record.verification.lastAttempt?.checks[0]?.isError, true);
			assert.equal(record.verification.lastAttempt?.checks[0]?.exitCode, null);
			assert.ok(pendingApprovals.has(`${conversation.id}:owner`));
		} finally { if (id !== undefined) await removeApprovalTarget(id); await s.close(); }
	});
	await t.test("nested bash consumes the shared work tool allowance", async () => {
		const s = await setup({ toolAdmissions: 1 });
		try {
			await writeFile(join(s.cwd, "job/result.txt"), "output");
			const conversation = await s.conversation();
			await submit(s, conversation, [start(check("node -e \"require('node:fs').writeFileSync('executed','bad')\""))]);
			await submit(s, conversation, [operation("verify")]);
			const record = await current(s, conversation.id);
			assert.equal(record.stopped, "tool_limit");
			assert.equal(record.verification?.receipt, undefined);
			await assert.rejects(access(join(s.cwd, "executed")), { code: "ENOENT" });
		} finally { await s.close(); }
	});
});

test("read-only children and parents that handed off their workspace cannot verify", { ...supported, timeout: 20_000 }, async () => {
	const s = await setup({ extensions: (getHarness) => [makeWorkspaceExtension(getHarness)] });
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "output");
		const parent = await s.conversation();
		await submit(s, parent, [start(check("node -e \"require('node:fs').appendFileSync('executed','x')\""))]);
		const workspace = await canonicalWorkspace(s.cwd);
		const makeChild = async (mode: "read" | "write") => s.harness.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true, conversationId: parent.id });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			const holder = await tx.createTask(LeaseHolder, null, { ownership: { kind: "conversation" }, background: true, conversationId: parent.id });
			const agent = await tx.doc(AgentDoc, child.id); agent.model = { provider: "faux", modelId: "faux-1" }; agent.cwd = s.cwd;
			await inheritWork(tx, parent.id, child.id);
			await registerBackgroundWorkspace(tx, parent.id, child.id, mode, workspace, holder);
			return child.id;
		}, context);
		const readId = await makeChild("read");
		const reader = (await s.harness.conversation(readId, context))!;
		await submit(s, reader, [operation("verify")]);
		await makeChild("write");
		await submit(s, parent, [operation("verify")]);
		assert.equal((await current(s, parent.id)).verification?.receipt, undefined);
		await assert.rejects(access(join(s.cwd, "executed")), { code: "ENOENT" });
		for (const id of [parent.id, readId]) {
			const entries = await s.harness.commit((tx) => tx.scanEntries({ conversationId: id, order: "ascending" }, 100), context);
			assert.match(JSON.stringify(entries.items), id === readId ? /read-only/ : /does not own workspace write access/);
		}
	} finally { await s.close(); }
});

test("verification rejects scope escapes, links and oversized scopes through governed reads", { ...supported, timeout: 20_000 }, async () => {
	const s = await setup();
	try {
		assert.throws(() => verificationContract({ ...check(), artifacts: ["../outside"] }), /relative/);
		assert.throws(() => verificationContract({ ...check(), allowedChanges: ["other/output"] }), /inside/);
		const env = await s.environment(s.cwd, true);
		try {
			await writeFile(join(s.directory, "outside.txt"), "outside");
			await symlink(join(s.directory, "outside.txt"), join(s.cwd, "job/outside.txt"));
			await assert.rejects(artifactManifest(env, { ...check(), artifacts: ["job"] }, context), /Symbolic links/);
			await assert.rejects(artifactManifest(env, { ...check(), artifacts: ["job/outside.txt"] }, context), /limited to|Symbolic links/);
			await rm(join(s.cwd, "job/outside.txt"));
			await writeFile(join(s.cwd, "job/internal.txt"), "internal");
			await symlink(join(s.cwd, "job/internal.txt"), join(s.cwd, "job/alias.txt"));
			await assert.rejects(artifactManifest(env, { ...check(), artifacts: ["job/alias.txt"] }, context), /Symbolic links/);
			await rm(join(s.cwd, "job/alias.txt"));
			const large = await open(join(s.cwd, "job/large.bin"), "w");
			await large.truncate(VERIFICATION_MAX_BYTES + 1); await large.close();
			await assert.rejects(artifactManifest(env, { ...check(), artifacts: ["job/large.bin"] }, context), /exceeds.*bytes/);
			await rm(join(s.cwd, "job/large.bin"));
			await mkdir(join(s.cwd, "wide"));
			await Promise.all(Array.from({ length: 1025 }, (_, i) => writeFile(join(s.cwd, "wide", String(i)), "")));
			await assert.rejects(artifactManifest(env, { ...check(), artifacts: ["wide"] }, context), /exceeds 1024 entries/);
		} finally { await env.cleanup(context); }
	} finally { await s.close(); }
});

test("legacy work stays explicitly unverified without retroactive ready blocking", { ...supported, timeout: 15_000 }, async () => {
	const s = await setup();
	try {
		const conversation = await s.conversation();
		await submit(s, conversation, [start(), call("bash", { command: "node -e \"process.exit(0)\"" })]);
		const record = await current(s, conversation.id);
		await submit(s, conversation, [operation("ready", { evidence: Object.keys(record.availableEvidence).map(Number), review: "Legacy successful evidence" })]);
		assert.equal((await current(s, conversation.id)).status, "ready_for_review");
		assert.equal((await acceptWork(s.harness, conversation.id, record.id, "operator")).status, "accepted");
		const entries = await s.harness.commit((tx) => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 100), context);
		assert.ok(entries.items.some((entry) => ToolResultEntry.is(entry) && JSON.stringify(entry.model).includes("No verification contract was declared")));
	} finally { await s.close(); }
});

test("a crashed unsafe verification never replays commands or gains a receipt on restart", { ...supported, timeout: 25_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-verification-crash-"));
	const crashModule = new URL("../src/ext/work.ts", import.meta.url).href;
	const guardedModule = new URL("../src/guarded-env.ts", import.meta.url).href;
	const script = `
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Type } from 'typebox';
import { makeWorkController, WorkDoc } from ${JSON.stringify(crashModule)};
import { GuardedExecutionEnv } from ${JSON.stringify(guardedModule)};
const directory = process.argv[1], cwd = join(directory, 'work');
await mkdir(join(cwd, 'job'), {recursive:true}); await writeFile(join(cwd, 'job/result.txt'), 'result');
const bases = {cwd, readScope:cwd, tmp:join(directory,'tmp'), state:join(directory,'state'), appRoot:join(directory,'app'), data:join(directory,'app/data'), sqlite:join(directory,'s.sqlite')};
const work = makeWorkController({verificationEnv:async()=>GuardedExecutionEnv.create({cwd},bases)});
const registry = createRegistry(); registry.install(work.extension);
registry.install(defineExtension({name:'blocked-test-bash',tools:[defineTool({name:'bash',description:'A crash boundary',parameters:Type.Object({command:Type.String()}),async execute(){await appendFile(join(directory,'executions'),'x');process.stdout.write('VERIFY_STARTED\\n');setInterval(()=>{},1000);await new Promise(()=>{});return {output:[]};}})]}));
const faux = fauxProvider({tokensPerSecond:100000}); const models=createModels();models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage(fauxToolCall('dwell.work',{action:'start',goal:'Crash recovery',acceptance:['Check passes'],verification:{checks:[{name:'blocked',command:'blocked'}],artifacts:['job/result.txt']}}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxToolCall('dwell.work',{action:'verify'}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxText('done'))]);
const harness=await Harness.open(await openNodeSqliteStorage(join(directory,'s.sqlite')),{models,registry},ctx);await work.attach(harness);
const conversation=await harness.createConversation({ownership:{kind:'ownerless'},agent:{model:{provider:'faux',modelId:'faux-1'},cwd}},ctx);
await harness.commit(async tx=>{(await tx.doc(WorkDoc,conversation.id)).goalMode=true;},ctx);
await writeFile(join(directory,'conversation'),String(conversation.id));
await (await conversation.submit({type:'input',content:'verify',entry:{kind:'chat.message',data:{sender:'owner',via:'panel'}}},ctx)).wait(ctx);
`;
	const child = spawn(process.execPath, ["--input-type=module", "--eval", script, directory], { cwd: process.cwd(), env: { ...process.env, DWELL_STATE: join(directory, "state") }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "", error = "";
	child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
	let reopened: Awaited<ReturnType<typeof setup>> | undefined;
	try {
		await until(() => { if (child.exitCode !== null) throw new Error(`Crash fixture exited: ${error}`); return output.includes("VERIFY_STARTED"); });
		child.kill("SIGKILL"); await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const id = Number(await readFile(join(directory, "conversation"), "utf8"));
		reopened = await setup({ directory }); reopened.harness.resume();
		const conversation = (await reopened.harness.conversation(id as ConversationId, context))!;
		await conversation.waitForIdle(context);
		const record = await current(reopened, id);
		assert.equal(record.verification?.status, "unverified");
		assert.equal(record.verification.receipt, undefined);
		assert.equal(await readFile(join(directory, "executions"), "utf8"), "x");
		await submit(reopened, conversation, [operation("ready", { review: "A crash is not verification" })]);
		assert.equal((await current(reopened, id)).status, "active");
	} finally { child.kill("SIGKILL"); if (reopened !== undefined) await reopened.close(); else await rm(directory, { recursive: true, force: true }); }
});
