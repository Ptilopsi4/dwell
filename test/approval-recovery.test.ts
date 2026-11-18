import { after, test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "dwell-approval-recovery-"));
process.env.DWELL_STATE = dir;
const approval = await import("../src/ext/approval.ts");
const { BACKGROUND_CONTEXT: context } = await import("@earendil-works/chord/context");
const { createModels } = await import("@earendil-works/pi-ai/models");
const { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
const { createRegistry, Harness, LiveDoc } = await import("@earendil-works/pi-durable");
const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
const { BackgroundAnchor, BackgroundDoc, BackgroundDeliveryDoc, makeBackgroundDeliverer, makeBackgroundExtension } = await import("../src/ext/background.ts");
import type { ApprovalDecision, ApprovalTarget } from "../src/ext/approval.ts";
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
const { CodingTools } = await import("@earendil-works/pi-durable/tools");
const workspace = await import("../src/workspace.ts");

after(() => rm(dir, { recursive: true, force: true }));

function clearMemory(): void {
	approval.approvals.clear(); approval.pendingApprovals.clear(); approval.runSender.clear(); approval.runVia.clear();
	approval.approvalDecisions.clear(); approval.conversationScope.clear(); approval.setApprovalBudgetGetter(() => undefined);
}
async function reset(): Promise<void> { clearMemory(); await approval.persistApprovals(); }
function pending(scope = 7, targets = [scope]): void {
	approval.pendingApprovals.set(`${scope}:creator`, { command: "rm -rf output", match: "rm", trigger: "creator", via: "panel", targets, targetBudgetIds: Object.fromEntries(targets.map((target) => [String(target), `budget-${target}`])) });
}
const failWrites = () => mkdir(join(dir, "approvals.json.tmp"));
const restoreWrites = () => rm(join(dir, "approvals.json.tmp"), { recursive: true, force: true });

test("failed decision save preserves the pending request and previous window", async () => {
	await reset(); pending(); approval.approvals.set("7:creator", 1234); await approval.persistApprovals();
	await failWrites();
	try {
		await assert.rejects(approval.takeDecision("7:creator", "approve", 10));
		assert.equal(approval.pendingApprovals.size, 1);
		assert.equal(approval.approvals.get("7:creator"), 1234);
		assert.equal(approval.approvalDecisions.size, 0);
	} finally { await restoreWrites(); }
	clearMemory(); await approval.loadApprovalState();
	assert.equal(approval.pendingApprovals.size, 1);
});

test("a queued old approval reference cannot approve a replacement request", async () => {
	await reset();
	await approval.setRunAttribution(7, "tg:1", "telegram");
	await approval.bashApprovalBlock("ssh old-host", 7)?.saved;
	const key = approval.windowKey(7, "tg:1");
	const old = approval.pendingApprovals.get(key)!;
	assert.ok(old.requestId);
	const revoke = approval.revokeApprovalWindows(7);
	const replacement = approval.bashApprovalBlock("ssh new-host", 7);
	const decision = approval.takeDecision(key, "approve", 10, undefined, old.requestId);
	await revoke;
	await replacement?.saved;
	assert.equal(await decision, undefined);
	assert.equal(approval.pendingApprovals.get(key)?.command, "ssh new-host");
	assert.notEqual(approval.pendingApprovals.get(key)?.requestId, old.requestId);
	assert.equal(approval.approvals.has(key), false);
	assert.equal(approval.approvalDecisions.size, 0);
});

test("replayed denial revokes only the captured requests, windows and decisions", async () => {
	await reset();
	const key = approval.windowKey(7, "tg:1");
	approval.pendingApprovals.set(key, { command: "ssh old-host", match: "ssh", trigger: "tg:1", via: "telegram", requestId: "old-request" });
	approval.approvals.set(key, 100);
	await approval.persistApprovals();
	const targets = approval.captureApprovalRevocation(7);
	await approval.revokeApprovalSnapshot(targets);
	assert.equal(approval.pendingApprovals.has(key), false);
	assert.equal(approval.approvals.has(key), false);
	approval.pendingApprovals.set(key, { command: "ssh new-host", match: "ssh", trigger: "tg:1", via: "telegram", requestId: "new-request" });
	await approval.persistApprovals();
	const newer = await approval.takeDecision(key, "approve", 10);
	approval.pendingApprovals.set(key, { command: "ssh later-host", match: "ssh", trigger: "tg:1", via: "telegram", requestId: "later-request" });
	approval.approvals.set(key, 200);
	await approval.persistApprovals();
	await approval.revokeApprovalSnapshot(targets);
	assert.equal(approval.pendingApprovals.get(key)?.requestId, "later-request");
	assert.equal(approval.approvals.get(key), 200);
	assert.equal(approval.approvalDecisions.get(newer!.id)?.deliveryTargets[0].status, "pending");
});

test("replayed pre-approval does not replace a newer window or approve a newly pending request", async () => {
	await reset();
	const key = approval.windowKey(7, "tg:1");
	await approval.grantApprovalWindow(key, 10, 100);
	assert.equal(await approval.grantApprovalWindow(key, 10, 90, { previousExpiresAt: undefined, noPending: true }), false);
	assert.equal(approval.approvals.get(key), 100);
	approval.pendingApprovals.set(key, { command: "ssh new-host", match: "ssh", trigger: "tg:1", via: "telegram", requestId: "new-request" });
	await approval.persistApprovals();
	assert.equal(await approval.grantApprovalWindow(key, 10, 200, { previousExpiresAt: 100, noPending: true }), false);
	assert.equal(approval.approvals.get(key), 100);
	assert.equal(approval.pendingApprovals.get(key)?.requestId, "new-request");
	await reset();
	await approval.setRunAttribution(7, "tg:1", "telegram");
	const queued = approval.bashApprovalBlock("ssh queued-host", 7);
	assert.equal(approval.pendingApprovals.has(key), false);
	const oldEmptyReference = approval.takeDecision(key, "approve", 10, undefined, "");
	await queued?.saved;
	assert.equal(await oldEmptyReference, undefined);
	assert.equal(approval.pendingApprovals.get(key)?.command, "ssh queued-host");
	assert.equal(approval.approvals.has(key), false);
});

test("decision journal survives reopen; duplicate decisions do not renew expiry; late card writes cannot restore pending", async () => {
	await reset(); pending();
	const previous = approval.pendingApprovals.get("7:creator")!;
	const deciding = approval.takeDecision("7:creator", "approve", 3, { chatId: "chat", messageId: "card" });
	const cardWrite = approval.setPendingApprovalCard("7:creator", previous, "late-chat", "late-card");
	const decision = (await deciding)!; await cardWrite;
	assert.equal(approval.pendingApprovals.size, 0);
	assert.equal(await approval.takeDecision("7:creator", "approve", 120), undefined);
	assert.equal(approval.approvals.get("7:creator"), decision.expiresAt);
	clearMemory(); await approval.loadApprovalState();
	const saved = approval.approvalDecisions.get(decision.id)!;
	assert.deepEqual(saved.reply, { chatId: "chat", messageId: "card" });
	assert.equal(saved.deliveryTargets[0]?.budgetId, "budget-7");
	assert.equal(saved.deliveryTargets[0]?.status, "pending");
});

test("partial target failures remain replayable; accepted and unavailable targets are not retried", async () => {
	await reset(); pending(7, [7, 8, 9]);
	const decision = (await approval.takeDecision("7:creator", "deny", 10))!;
	const attempted: number[] = [];
	const first = await approval.drainApprovalDecisions(async (_decision, target) => {
		attempted.push(target.conversationId);
		if (target.conversationId === 8) throw new Error("synthetic temporary delivery failure");
		return target.conversationId === 9 ? "unavailable" : "accepted";
	}, decision.id);
	assert.deepEqual(attempted, [7, 8, 9]); assert.deepEqual(first, { pending: 1, unavailable: 1 });
	clearMemory(); await approval.loadApprovalState(); attempted.length = 0;
	await approval.drainApprovalDecisions(async (_decision, target) => { attempted.push(target.conversationId); return "accepted"; });
	assert.deepEqual(attempted, [8]);
});

test("accepted delivery with failed JSON acknowledgement replays the same delivery identity", async () => {
	await reset(); pending(); const decision = (await approval.takeDecision("7:creator", "approve", 1))!;
	const ids = new Set<string>();
	await approval.drainApprovalDecisions(async (saved, target) => {
		ids.add(`approval:${saved.id}:${target.conversationId}`); await failWrites(); return "accepted";
	});
	assert.equal(approval.approvalDecisions.get(decision.id)?.deliveryTargets[0]?.status, "pending");
	await restoreWrites(); clearMemory(); await approval.loadApprovalState();
	await approval.drainApprovalDecisions(async (saved, target) => { ids.add(`approval:${saved.id}:${target.conversationId}`); return "accepted"; });
	assert.equal(ids.size, 1);
});

test("expired approval replay reports expiry without extending the frozen window", async () => {
	await reset(); pending(); const decision = (await approval.takeDecision("7:creator", "approve", 1))!;
	decision.expiresAt = Date.now() - 1000;
	approval.approvalDecisions.set(decision.id, decision); approval.approvals.set(decision.key, decision.expiresAt);
	await approval.persistApprovals(); clearMemory(); await approval.loadApprovalState();
	assert.equal(approval.approvals.has(decision.key), false);
	await approval.drainApprovalDecisions(async (saved) => {
		assert.equal(saved.expiresAt, decision.expiresAt);
		assert.match(approval.decisionInput(saved.action, saved.minutes, saved.expiresAt), /already expired/);
		return "accepted";
	});
	assert.equal(approval.approvals.has(decision.key), false);
});

test("card update failure and a stalled card request cannot prevent durable admission", async () => {
	for (const stall of [false, true]) {
		await reset(); pending(); const decision = (await approval.takeDecision("7:creator", "approve", 1))!;
		let updated = false; let admitted = false;
		const result = await approval.drainApprovalDecisions(async () => { admitted = true; return "accepted"; }, decision.id, async () => {
			updated = true;
			if (stall) await new Promise(() => {});
			else throw new Error("synthetic card update failure");
		});
		assert.equal(updated, true); assert.equal(admitted, true); assert.equal(result.pending, 0);
		clearMemory(); await approval.loadApprovalState();
		assert.equal(approval.approvalDecisions.get(decision.id)?.deliveryTargets[0]?.status, "accepted");
	}
});

test("attribution save failure rejects before changing the persisted or in-memory creator", async () => {
	await reset(); await approval.setRunAttribution(7, "original", "feishu"); await failWrites();
	try {
		await assert.rejects(approval.setRunAttribution(7, "wrong", "panel"));
		assert.equal(approval.runSender.get(7), "original"); assert.equal(approval.runVia.get(7), "feishu");
	} finally { await restoreWrites(); }
	clearMemory(); await approval.loadApprovalState(); assert.equal(approval.runSender.get(7), "original");
});

test("deny command revokes matching windows and pending deliveries without creating a decision or run", async () => {
	await reset(); pending(7, [7, 8]);
	const first = (await approval.takeDecision("7:creator", "approve", 10))!;
	approval.pendingApprovals.set("7:other", { command: "ssh host", match: "ssh", trigger: "other", via: "panel" });
	approval.approvals.set("7:other", Date.now() + 10000);
	await approval.persistApprovals(); await approval.revokeApprovalWindows(7, "creator");
	assert.equal(approval.approvals.has("7:other"), true);
	assert.equal(approval.pendingApprovals.has("7:other"), true);
	let calls = 0;
	await approval.drainApprovalDecisions(async () => { calls++; return "accepted"; });
	assert.equal(calls, 0); assert.equal(approval.approvalDecisions.size, 1);
	assert.ok(approval.approvalDecisions.get(first.id)?.deliveryTargets.every((target) => target.status === "unavailable"));
	await approval.revokeApprovalWindows(7);
	assert.equal(approval.pendingApprovals.size, 0); assert.equal(approval.approvals.size, 0);
});

test("pending targets capture independent original budgets before a decision is committed", async () => {
	await reset(); approval.runSender.set(7, "creator"); approval.runSender.set(8, "creator"); approval.conversationScope.set(8, 7);
	approval.setApprovalBudgetGetter(async (id) => `original-${id}`);
	await approval.bashApprovalBlock("rm -rf first", 7)?.saved;
	await approval.bashApprovalBlock("rm -rf second", 8)?.saved;
	const decision = (await approval.takeDecision("7:creator", "approve", 10))!;
	assert.deepEqual(decision.deliveryTargets.map(({ conversationId, budgetId }) => ({ conversationId, budgetId })), [
		{ conversationId: 7, budgetId: "original-7" }, { conversationId: 8, budgetId: "original-8" },
	]);
});

const backgroundDeps = { attribute: async () => {}, onFired: () => {}, onStarted: () => {}, senderOf: () => "changed-parent-sender", forbidden: () => [] };

test("stopping a writable approval waiter releases its lease without revoking other targets", { timeout: 20_000 }, async (t) => {
	for (const decided of [false, true]) await t.test(decided ? "undelivered decision" : "pending request", async () => {
		await reset();
		const cwd = await mkdtemp(join(dir, "stop-workspace-"));
		let harness: import("@earendil-works/pi-durable").Harness;
		let background: ReturnType<typeof makeBackgroundExtension>;
		let childId: number | undefined;
		const steps = new Map<string, number>();
		const faux = fauxProvider({ tokensPerSecond: 100_000 });
		faux.setResponses(Array.from({ length: 50 }, () => (transcript) => {
			const users = transcript.messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).join("\n");
			const key = users.includes("worker:stop") ? "child" : users.includes("write-after-stop") ? "write" : users.includes("stop-now") ? "stop" : "start";
			const step = steps.get(key) ?? 0; steps.set(key, step + 1);
			if (step > 0) return fauxAssistantMessage(fauxText("done"));
			const call: readonly [string, JsonObject] = key === "child" ? ["bash", { command: "rm -rf output" }] as const
				: key === "write" ? ["write", { path: "after-stop.txt", content: "writable" }] as const
				: ["dwell.task", key === "stop" ? { action: "stop", name: "worker" } : { action: "start", name: "worker", mode: "write", message: "worker:stop" }] as const;
			return fauxAssistantMessage(fauxToolCall(call[0], call[1]), { stopReason: "toolUse" });
		}));
		const models = createModels(); models.setProvider(faux.provider);
		background = makeBackgroundExtension({
			...backgroundDeps, getHarness: () => harness, viaOf: () => "panel",
			attribute: (id, sender) => approval.setRunAttribution(id, sender, "panel"),
			onStarted: (child, parent) => { childId = child; approval.conversationScope.set(child, parent); },
			forbidden: () => [background],
		});
		const registry = createRegistry(); registry.install(CodingTools); registry.install(background);
		registry.install(workspace.makeWorkspaceExtension(() => harness)); registry.install(approval.makeApprovalExtension(() => harness));
		workspace.setWorkspaceApprovalGetter((id) => [...approval.pendingApprovals.values()].some((pending) => pending.targets?.includes(id)) || [...approval.approvalDecisions.values()].some((decision) => decision.deliveryTargets.some((target) => target.conversationId === id && target.status === "pending")));
		harness = await Harness.open(await openNodeSqliteStorage(join(cwd, "s.sqlite")), { models, registry, env: async () => new NodeExecutionEnv({ cwd }) }, context);
		harness.resume();
		const until = async (check: () => Promise<boolean>) => {
			for (const end = Date.now() + 5000; !await check();) { if (Date.now() > end) throw new Error("stop test timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); }
		};
		try {
			const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd, model: { provider: "faux", modelId: "faux-1" } } }, context);
			await approval.setRunAttribution(parent.id, "creator", "panel");
			await (await parent.submit({ type: "input", content: "start", entry: { kind: "chat.message", data: { sender: "changed-parent-sender", via: "panel" } } }, context)).wait(context);
			await until(async () => childId !== undefined && approval.pendingApprovals.size === 1 && (await harness.snapshot(LiveDoc, childId as ConversationId, context))?.run === undefined);
			await until(async () => (await harness.commit((tx) => tx.scanTasks({ kind: "dwell.background-reporter" }, 100), context)).items.every((task) => task.state.status === "terminal"));
			await until(async () => (await harness.snapshot(LiveDoc, parent.id, context))?.run === undefined);
			const key = [...approval.pendingApprovals.keys()][0]!;
			const pending = approval.pendingApprovals.get(key)!;
			pending.targets!.push(parent.id, 999999); pending.targetBudgetIds = { [String(childId)]: "child-budget", [String(parent.id)]: "parent-budget", "999999": "sibling-budget" };
			await approval.persistApprovals();
			const decision = decided ? await approval.takeDecision(key, "approve", 10) : undefined;
			await (await parent.submit({ type: "input", content: "stop-now", entry: { kind: "chat.message", data: { sender: "changed-parent-sender", via: "panel" } } }, context)).wait(context);
			assert.deepEqual((await harness.snapshot(BackgroundDoc, parent.id, context))!.agents, {});
			await (await parent.submit({ type: "input", content: "write-after-stop", entry: { kind: "chat.message", data: { sender: "changed-parent-sender", via: "panel" } } }, context)).wait(context);
			assert.equal(await readFile(join(cwd, "after-stop.txt"), "utf8"), "writable");
			assert.deepEqual((await harness.snapshot(workspace.WorkspaceDoc, context))!.writers, {});
			clearMemory(); await approval.loadApprovalState();
			if (decision !== undefined) assert.deepEqual(approval.approvalDecisions.get(decision.id)!.deliveryTargets.map((target) => [target.conversationId, target.status]), [[childId, "unavailable"], [parent.id, "pending"], [999999, "pending"]]);
			else {
				assert.deepEqual(approval.pendingApprovals.get(key)!.targets, [parent.id, 999999]);
				assert.deepEqual(approval.pendingApprovals.get(key)!.targetBudgetIds, { [String(parent.id)]: "parent-budget", "999999": "sibling-budget" });
			}
		} finally { workspace.setWorkspaceApprovalGetter(() => false); await harness.close(context); }
	});
});

async function openHarness(file: string) {
	const models = createModels(); const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("finished")])));
	models.setProvider(faux.provider);
	const registry = createRegistry(); registry.install(makeBackgroundExtension(backgroundDeps));
	return Harness.open(await openNodeSqliteStorage(file), { models, registry }, context);
}

test("Reporter receipt is atomic with creation and checked before stopped roster; new delivery cannot revive a stopped child", async () => {
	const harness = await openHarness(join(dir, "receipt.sqlite"));
	try {
		const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
		const child = await parent.commit(async (tx) => {
			const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			(await tx.doc(BackgroundDoc, parent.id)).agents.worker = { conversationId: child.id as number };
			return child.id;
		}, context);
		const deliverer = makeBackgroundDeliverer(backgroundDeps, () => harness);
		const options = { deliveryId: "stable-delivery", sender: "original-creator", budgetId: "original-budget" };
		assert.equal(await deliverer.deliver(parent.id, child, "continue", options), true);
		await parent.commit(async (tx) => { delete (await tx.doc(BackgroundDoc, parent.id)).agents.worker; }, context);
		assert.equal(await deliverer.deliver(parent.id, child, "continue", options), true);
		assert.equal(await deliverer.deliver(parent.id, child, "continue", { ...options, deliveryId: "new-delivery" }), false);
		const receipts = await harness.snapshot(BackgroundDeliveryDoc, parent.id, context);
		assert.deepEqual(Object.keys(receipts?.receipts ?? {}), ["stable-delivery"]);
		const reporter = await harness.getTask(receipts!.receipts["stable-delivery"] as import("@earendil-works/pi-durable").TaskId, context);
		assert.equal((reporter?.input as { creator: string }).creator, "original-creator");
	} finally { await harness.close(context); }
});

// IPC announces the exact committed boundary. The parent kills the process only after that announcement.
test("real process termination: reopen after decision, self admission, and Reporter creation", async (t) => {
	const fixture = join(dir, "crash-fixture.mjs");
	const approvalUrl = new URL("../src/ext/approval.ts", import.meta.url).href;
	const backgroundUrl = new URL("../src/ext/background.ts", import.meta.url).href;
	const durableUrl = import.meta.resolve("@earendil-works/pi-durable");
	const storageUrl = import.meta.resolve("@earendil-works/pi-durable/storage/sqlite/node");
	const contextUrl = import.meta.resolve("@earendil-works/chord/context");
	const modelsUrl = import.meta.resolve("@earendil-works/pi-ai/models");
	const fauxUrl = import.meta.resolve("@earendil-works/pi-ai/providers/faux");
	await writeFile(fixture, `
import * as approval from ${JSON.stringify(approvalUrl)};
import { BackgroundAnchor, BackgroundDoc, makeBackgroundDeliverer, makeBackgroundExtension } from ${JSON.stringify(backgroundUrl)};
import { createRegistry, Harness } from ${JSON.stringify(durableUrl)};
import { openNodeSqliteStorage } from ${JSON.stringify(storageUrl)};
import { BACKGROUND_CONTEXT as context } from ${JSON.stringify(contextUrl)};
import { createModels } from ${JSON.stringify(modelsUrl)};
import { fauxProvider, fauxAssistantMessage, fauxText } from ${JSON.stringify(fauxUrl)};
const mode = process.argv[2];
const models = createModels(); const faux = fauxProvider();
faux.setResponses(Array.from({length:20}, () => fauxAssistantMessage([fauxText("finished")]))); models.setProvider(faux.provider);
const deps = { attribute: async () => {}, onFired: () => {}, onStarted: () => {}, senderOf: () => "creator", forbidden: () => [] };
const registry = createRegistry(); registry.install(makeBackgroundExtension(deps));
const harness = await Harness.open(await openNodeSqliteStorage(process.argv[3]), {models, registry}, context);
const parent = await harness.createConversation({ownership:{kind:"ownerless"},agent:{model:{provider:"faux",modelId:"faux-1"}}},context);
let child;
if(mode === "reporter") child = await parent.commit(async tx => {
 const anchor = await tx.createTask(BackgroundAnchor,null,{ownership:{kind:"conversation"},background:true});
 const child = await tx.createConversation({ownership:{kind:"task",taskId:anchor}});
 (await tx.doc(BackgroundDoc,parent.id)).agents.worker={conversationId:child.id}; return child.id;
}, context);
approval.pendingApprovals.set(parent.id+":creator",{command:"rm -rf output",match:"rm",trigger:"creator",via:"panel",targets:[child??parent.id],targetBudgetIds:{[child??parent.id]:"frozen-budget"}});
await approval.persistApprovals();
const decision = await approval.takeDecision(parent.id+":creator","approve",10);
const metadata = {parent:parent.id,child,decisionId:decision.id};
const boundary = async () => {process.send(metadata); await new Promise(() => {});};
if(mode === "decision") await boundary();
else await approval.drainApprovalDecisions(async (decision,target) => {
 const requestId="approval:"+decision.id+":"+target.conversationId;
 if(mode === "self") await parent.submit({type:"input",content:approval.decisionInput(decision.action,decision.minutes,decision.expiresAt),requestId,entry:{kind:"dwell.approval",data:{budgetId:target.budgetId}}},context);
 else await makeBackgroundDeliverer(deps,()=>harness).deliver(parent.id,child,"continue",{deliveryId:requestId,sender:decision.trigger,budgetId:target.budgetId});
 await boundary(); return "accepted";
});
`);
	for (const mode of ["decision", "self", "reporter"]) await t.test(mode, async () => {
		await reset();
		const file = join(dir, `${mode}.sqlite`);
		const child = fork(fixture, [mode, file], { env: { ...process.env, DWELL_STATE: dir }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
		let stderr = ""; child.stderr?.on("data", (data) => { stderr += data.toString(); });
		const metadata = await new Promise<{ parent: number; child?: number; decisionId: string }>((resolve, reject) => {
			const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`crash fixture timeout: ${stderr}`)); }, 15000);
			child.once("message", (message) => { clearTimeout(timeout); resolve(message as { parent: number; child?: number; decisionId: string }); });
			child.once("exit", (code, signal) => { clearTimeout(timeout); reject(new Error(`fixture exited before boundary ${code}/${signal}: ${stderr}`)); });
		});
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL"); await exited;
		clearMemory(); await approval.loadApprovalState();
		assert.equal(approval.approvalDecisions.get(metadata.decisionId)?.deliveryTargets[0]?.status, "pending");
		const harness = await openHarness(file);
		try {
			const deliverer = makeBackgroundDeliverer(backgroundDeps, () => harness);
			const deliver = async (decision: ApprovalDecision, target: ApprovalTarget): Promise<"accepted" | "unavailable"> => {
				const requestId = `approval:${decision.id}:${target.conversationId}`;
				if (metadata.child !== undefined) return await deliverer.deliver(decision.scope, metadata.child, "continue", { deliveryId: requestId, sender: decision.trigger, budgetId: target.budgetId }) ? "accepted" : "unavailable";
				const conversation = await harness.conversation(metadata.parent as ConversationId, context);
				await conversation!.submit({ type: "input", content: approval.decisionInput(decision.action, decision.minutes, decision.expiresAt), requestId, entry: { kind: "dwell.approval", data: { budgetId: target.budgetId! } } }, context);
				return "accepted";
			};
			assert.deepEqual(await approval.drainApprovalDecisions(deliver), { pending: 0, unavailable: 0 });
			harness.resume();
			const conversation = await harness.conversation((metadata.child ?? metadata.parent) as ConversationId, context);
			for (const end = Date.now() + 10000; ;) {
				const entries = await conversation!.entries({}, 100, undefined, context);
				const inputs = entries.items.filter((entry) => entry.kind === "dwell.approval");
				if (inputs.length > 0) {
					assert.equal(inputs.length, 1, "replay admits exactly one continuation input");
					assert.equal((inputs[0]?.data as { budgetId: string }).budgetId, "frozen-budget");
					break;
				}
				if (Date.now() > end) throw new Error("continuation was not delivered");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			if (metadata.child !== undefined) assert.equal(Object.keys((await harness.snapshot(BackgroundDeliveryDoc, metadata.parent as ConversationId, context))!.receipts).length, 1);
		} finally { await harness.close(context); }
	});
});
