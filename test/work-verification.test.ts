import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, createRegistry, defineExtension, defineTask, Harness, ToolResultEntry, type Conversation, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GuardedExecutionEnv } from "../src/guarded-env.ts";
import { artifactManifest, verificationContract, VERIFICATION_MAX_BYTES } from "../src/verification.ts";

const state = await mkdtemp(join(tmpdir(), "dwell-verification-state-"));
process.env.DWELL_STATE = state;
const { acceptWork, getWork, inheritWork, makeWorkController } = await import("../src/ext/work.ts");
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
		conversation: () => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd } }, context),
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

test("receipts bind successful commands to current files and ready/status/accept never run checks", { ...supported, timeout: 20_000 }, async () => {
	const s = await setup();
	try {
		await writeFile(join(s.cwd, "job/result.txt"), "first version");
		const command = 'node -e "require(\'node:fs\').appendFileSync(\'check-count\',\'x\')"';
		const conversation = await s.conversation();
		await submit(s, conversation, [start(check(command)), operation("verify"), operation("ready", { review: "The declared command passed for this version" }), operation("status")]);
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
			await submit(s, conversation, [start(check("rm -rf job")), operation("verify")]);
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
		await submit(s, conversation, [operation("ready", { evidence: Object.keys(record.availableEvidence).map(Number), review: "Legacy successful evidence" }), operation("status")]);
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
import { makeWorkController } from ${JSON.stringify(crashModule)};
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
