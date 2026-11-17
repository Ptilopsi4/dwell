import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { FEISHU_DELIVERY_CONCURRENCY, FeishuDeliveries, FeishuDeliveryDoc, type FeishuDelivery, type FeishuDeliveryAlert } from "../src/feishu-delivery.ts";
import { makeScheduleExtension, makeScheduleRunTask } from "../src/ext/schedule.ts";

const done = () => fauxAssistantMessage(fauxText("done"));
const gate = () => {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
};
async function until(check: () => boolean | Promise<boolean>) {
	for (let attempts = 0; attempts < 500; attempts++) { if (await check()) return; await delay(5); }
	throw new Error("Feishu delivery did not reach the expected state");
}
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "dwell-feishu-delivery-"));
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	faux.setResponses(Array.from({ length: 30 }, done));
	const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry();
	let harness!: Harness;
	let deliveries!: FeishuDeliveries;
	const deps = { attribute: async () => {}, onFired: async (conversationId: number, submissionId: SubmissionId, header: string) => deliveries.enqueue({ conversationId, submissionId, chatId: "oc_original", header }), getHarness: () => harness, senderOf: () => "ou_alice" };
	registry.install(makeScheduleExtension(deps));
	const sent: FeishuDelivery[] = [];
	const alerts: FeishuDeliveryAlert[] = [];
	let now = Date.now();
	const open = async (options: { deliver?: (receipt: FeishuDelivery, signal: AbortSignal) => Promise<void>; pendingLimit?: number } = {}) => {
		harness = await Harness.open(await openNodeSqliteStorage(join(directory, "state.sqlite")), { models, registry }, context);
		deliveries = new FeishuDeliveries(harness, {
			pollMs: 5, now: () => now, pendingLimit: options.pendingLimit,
			report: (_receipt, alert) => alerts.push(alert),
			deliver: options.deliver ?? (async (receipt) => { sent.push(receipt); await (await harness.submission(receipt.submissionId as SubmissionId, context))!.wait(context); }),
		});
	};
	await open();
	return {
		get harness() { return harness; }, get deliveries() { return deliveries; }, faux, sent, alerts, deps, open,
		advance: (milliseconds: number) => { now += milliseconds; },
		conversation: () => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context),
		row: async (id: number) => (await harness.snapshot(FeishuDeliveryDoc, context))?.receipts[String(id)],
		closeRuntime: async () => { await deliveries.close(); await harness.close(context); },
		close: async () => { await deliveries.close(); await harness.close(context); await rm(directory, { recursive: true, force: true }); },
	};
}
function blockedResponse(waiting: ReturnType<typeof gate>, entered: ReturnType<typeof gate>): FauxResponseStep {
	return async (_request, options) => {
		entered.release();
		await Promise.race([waiting.promise, new Promise<void>((resolve) => {
			if (options!.signal!.aborted) resolve(); else options!.signal!.addEventListener("abort", () => resolve(), { once: true });
		})]);
		return done();
	};
}

test("a queued autonomous producer completes only after its receipt persists, then recovery delivers it once", { timeout: 10_000 }, async () => {
	const s = await fixture(); const waiting = gate(); const entered = gate();
	try {
		const conversation = await s.conversation();
		s.faux.setResponses([blockedResponse(waiting, entered)]);
		s.harness.resume();
		await conversation.submit({ type: "input", content: "keep the original run busy" }, context);
		await entered.promise;
		await s.deliveries.start();
		const task = await conversation.commit((tx) => tx.createTask(makeScheduleRunTask(s.deps), { id: "schedule:queued", conversationId: conversation.id, creator: "ou_alice", instruction: "report the scheduled result", tz: "UTC", firstAt: Date.now() }, { ownership: { kind: "conversation" }, background: true }), context);
		await until(async () => (await s.harness.getTask(task, context))?.state.status === "terminal");
		const rows = Object.values((await s.harness.snapshot(FeishuDeliveryDoc, context))!.receipts);
		assert.equal(rows.length, 1); const row = rows[0]!;
		assert.equal(row.status, "pending");
		assert.equal((await (await s.harness.submission(row.submissionId as SubmissionId, context))!.status(context)).status, "queued");
		await Promise.all(Array.from({ length: 4 }, () => s.deliveries.enqueue({ ...row, chatId: "oc_wrong", header: "replacement must not redirect" })));
		assert.equal((await s.row(row.submissionId))!.chatId, "oc_original");
		assert.equal(s.sent.length, 0);
		await s.closeRuntime();
		s.faux.setResponses(Array.from({ length: 20 }, done));
		await s.open();
		await Promise.all([s.deliveries.recover(), s.deliveries.recover()]);
		assert.equal(await s.deliveries.owns(row.submissionId), true, "the existing legacy mirror must defer to this receipt before scheduling resumes");
		await s.deliveries.start(); s.harness.resume();
		await until(async () => (await s.row(row.submissionId))?.status === "done");
		assert.equal(s.sent.length, 1); assert.equal(s.sent[0]!.chatId, "oc_original");
		assert.deepEqual(s.alerts, []);
		await s.closeRuntime(); await s.open(); await s.deliveries.start(); await delay(30);
		assert.equal(s.sent.length, 1, "a completed autonomous reply cannot be replayed after restart");
	} finally { waiting.release(); await s.close(); }
});

test("an interrupted claimed send becomes uncertain on recovery and never opens a second card", { timeout: 10_000 }, async () => {
	const s = await fixture(); const sending = gate();
	try {
		await s.closeRuntime();
		await s.open({ deliver: async (_receipt, signal) => {
			sending.release();
			await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		} });
		const conversation = await s.conversation();
		const submission = await conversation.submit({ type: "input", content: "autonomous result" }, context);
		await s.deliveries.enqueue({ conversationId: conversation.id, submissionId: submission.id, chatId: "oc_original", header: "result" });
		await s.deliveries.start(); await sending.promise;
		assert.equal((await s.row(submission.id))!.status, "sending");
		await s.closeRuntime(); await s.open();
		await Promise.all([s.deliveries.recover(), s.deliveries.recover(), s.deliveries.enqueue({ conversationId: conversation.id, submissionId: submission.id, chatId: "oc_other", header: "duplicate" })]);
		assert.equal((await s.row(submission.id))!.status, "uncertain");
		assert.deepEqual(s.alerts, ["uncertain"]);
		assert.equal(await s.deliveries.owns(submission.id), true, "legacy mirroring must not bypass an uncertain send");
		await s.deliveries.start(); await delay(30);
		assert.equal(s.sent.length, 0);
	} finally { await s.close(); }
});

test("a thirty-minute queue warning preserves pending delivery until the run becomes available", { timeout: 10_000 }, async () => {
	const s = await fixture(); const waiting = gate(); const entered = gate();
	try {
		const conversation = await s.conversation();
		s.faux.setResponses([blockedResponse(waiting, entered), done()]); s.harness.resume();
		await conversation.submit({ type: "input", content: "busy" }, context); await entered.promise;
		const submission = await conversation.submit({ type: "input", content: "queued result", whenBusy: "followUp" }, context);
		await s.deliveries.enqueue({ conversationId: conversation.id, submissionId: submission.id, chatId: "oc_original", header: "result", replyTo: "om_original", replyInThread: true });
		await s.deliveries.start(); s.advance(31 * 60_000);
		await until(() => s.alerts.includes("delayed")); await delay(20);
		assert.deepEqual(s.alerts, ["delayed"]);
		assert.equal((await s.row(submission.id))!.status, "pending");
		assert.ok((await s.row(submission.id))!.delayedAt);
		waiting.release();
		await until(async () => (await s.row(submission.id))?.status === "done");
		assert.equal(s.sent.length, 1); assert.equal(s.sent[0]!.replyTo, "om_original"); assert.equal(s.sent[0]!.replyInThread, true);
	} finally { waiting.release(); await s.close(); }
});

test("a full journal waits in producer admission with one warning and resumes when a slot clears", { timeout: 10_000 }, async () => {
	const s = await fixture(); const waiting = gate(); const entered = gate();
	try {
		await s.closeRuntime(); await s.open({ pendingLimit: 1 });
		const conversation = await s.conversation();
		s.faux.setResponses([blockedResponse(waiting, entered), done(), done()]); s.harness.resume();
		await conversation.submit({ type: "input", content: "busy" }, context); await entered.promise;
		const first = await conversation.submit({ type: "input", content: "first", whenBusy: "followUp" }, context);
		const second = await conversation.submit({ type: "input", content: "second", whenBusy: "followUp" }, context);
		await s.deliveries.enqueue({ conversationId: conversation.id, submissionId: first.id, chatId: "oc_original", header: "first" });
		let admitted = false;
		const admission = s.deliveries.enqueue({ conversationId: conversation.id, submissionId: second.id, chatId: "oc_original", header: "second" }).then(() => { admitted = true; });
		await s.deliveries.start(); await until(() => s.alerts.includes("capacity")); await delay(20);
		assert.equal(admitted, false); assert.deepEqual(s.alerts, ["capacity"]); assert.equal(await s.row(second.id), undefined);
		waiting.release(); await admission;
		await until(async () => (await s.row(second.id))?.status === "done");
		assert.equal(s.sent.length, 2);
	} finally { waiting.release(); await s.close(); }
});

test("post-claim failures are uncertain, missing inputs fail visibly, and closing joins active work", { timeout: 5000 }, async () => {
	const s = await fixture();
	try {
		await s.closeRuntime(); await s.open({ deliver: async () => { throw new Error("synthetic transport failure"); } });
		const conversation = await s.conversation();
		const submission = await conversation.submit({ type: "input", content: "known result" }, context);
		await s.deliveries.enqueue({ conversationId: conversation.id, submissionId: submission.id, chatId: "oc_original", header: "result" });
		await s.deliveries.enqueue({ conversationId: conversation.id, submissionId: 999999, chatId: "oc_original", header: "missing" });
		await s.deliveries.start();
		await until(async () => (await s.row(submission.id))?.status === "uncertain" && (await s.row(999999))?.status === "failed");
		assert.deepEqual(s.alerts.sort(), ["missing", "uncertain"]);
		await s.deliveries.close();
		const before = await s.harness.snapshot(FeishuDeliveryDoc, context); await delay(20);
		assert.deepEqual(await s.harness.snapshot(FeishuDeliveryDoc, context), before, "a closed worker must not retain scans or mutate the journal");
	} finally { await s.close(); }
});

test("restart adopts only the active autonomous input before a delayed producer announces it", { timeout: 10_000 }, async () => {
	const s = await fixture(); const waiting = gate(); const entered = gate();
	try {
		const conversation = await s.conversation();
		s.faux.setResponses([blockedResponse(waiting, entered)]); s.harness.resume();
		const submission = await conversation.submit({ type: "input", content: "already submitted, not announced", entry: { kind: "chat.message", data: { sender: "ou_alice", via: "schedule" } } }, context);
		await entered.promise;
		assert.equal(await s.deliveries.owns(submission.id), false);
		await s.closeRuntime();
		s.faux.setResponses(Array.from({ length: 10 }, done)); await s.open();
		const input = { conversationId: conversation.id, submissionId: submission.id, chatId: "oc_original" };
		const adopted = await s.deliveries.adoptActive(input);
		assert.equal(adopted, true, "legacy mirroring must skip the adopted current autonomous input");
		await Promise.all([s.deliveries.recover(), s.deliveries.enqueue({ ...input, header: "late original producer announcement" })]);
		await s.deliveries.start(); s.harness.resume();
		await until(async () => (await s.row(submission.id))?.status === "done");
		assert.equal(s.sent.length, 1); assert.equal(s.sent[0]!.submissionId, submission.id);
		const current = (await s.harness.conversation(conversation.id, context))!;
		const user = await current.submit({ type: "input", content: "ordinary user message", entry: { kind: "chat.message", data: { sender: "ou_alice", via: "feishu" } } }, context);
		assert.equal(await s.deliveries.adoptActive({ ...input, submissionId: user.id }), false);
		await user.wait(context);
		assert.equal(await s.deliveries.adoptActive({ ...input, submissionId: submission.id + 999 }), false);
		assert.equal(await s.deliveries.owns(user.id), false);
		const historical = await current.submit({ type: "input", content: "historical autonomous answer without a receipt", entry: { kind: "chat.message", data: { sender: "ou_alice", via: "background" } } }, context);
		await historical.wait(context);
		assert.equal(await s.deliveries.adoptActive({ ...input, submissionId: historical.id }), false, "completed history is never backfilled");
	} finally { waiting.release(); await s.close(); }
});

test("queued heads do not occupy bounded sending slots or starve ready replies", { timeout: 10_000 }, async () => {
	const s = await fixture(); const waiting = gate(); const entered = gate(); const sends = gate();
	let active = 0; let peak = 0;
	try {
		await s.closeRuntime(); await s.open({ deliver: async (receipt, signal) => {
			s.sent.push(receipt); active++; peak = Math.max(peak, active);
			try { await Promise.race([sends.promise, new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]); }
			finally { active--; }
		} });
		const busy = await s.conversation();
		s.faux.setResponses([blockedResponse(waiting, entered), ...Array.from({ length: 20 }, done)]); s.harness.resume();
		await busy.submit({ type: "input", content: "keep the head queued" }, context); await entered.promise;
		const head = await busy.submit({ type: "input", content: "queued head", whenBusy: "followUp" }, context);
		await s.deliveries.enqueue({ conversationId: busy.id, submissionId: head.id, chatId: "oc_original", header: "queued head" });
		const ready: number[] = [];
		for (let index = 0; index < FEISHU_DELIVERY_CONCURRENCY + 2; index++) {
			const conversation = await s.conversation();
			const submission = await conversation.submit({ type: "input", content: "ready tail" }, context);
			await submission.wait(context); ready.push(submission.id);
			await s.deliveries.enqueue({ conversationId: conversation.id, submissionId: submission.id, chatId: "oc_original", header: "ready tail" });
		}
		await s.deliveries.start(); await until(() => active === FEISHU_DELIVERY_CONCURRENCY); await delay(20);
		assert.equal(peak, FEISHU_DELIVERY_CONCURRENCY); assert.equal(s.sent.length, FEISHU_DELIVERY_CONCURRENCY);
		assert.equal((await s.row(head.id))!.status, "pending");
		assert.ok(s.sent.every((receipt) => ready.includes(receipt.submissionId)));
		sends.release();
		await until(async () => (await Promise.all(ready.map((id) => s.row(id)))).every((row) => row?.status === "done"));
		waiting.release(); await until(async () => (await s.row(head.id))?.status === "done");
		assert.equal(s.sent.length, ready.length + 1); assert.equal(peak, FEISHU_DELIVERY_CONCURRENCY);
	} finally { sends.release(); waiting.release(); await s.close(); }
});

test("shutdown cancels a capacity wait before the Harness closes", { timeout: 5000 }, async () => {
	const s = await fixture();
	try {
		await s.closeRuntime(); await s.open({ pendingLimit: 1 });
		const conversation = await s.conversation();
		await s.deliveries.enqueue({ conversationId: conversation.id, submissionId: 10001, chatId: "oc_original", header: "first" });
		const waiting = s.deliveries.enqueue({ conversationId: conversation.id, submissionId: 10002, chatId: "oc_original", header: "second" });
		const rejected = assert.rejects(waiting, { name: "AbortError" });
		await until(() => s.alerts.includes("capacity"));
		await s.deliveries.close(); await rejected;
		assert.equal(await s.row(10002), undefined);
		assert.equal((await s.row(10001))!.status, "pending");
		await s.harness.close(context); await delay(20);
	} finally { await s.close(); }
});

test("bounded terminal retention preserves every pending receipt", { timeout: 5000 }, async () => {
	const s = await fixture();
	try {
		const conversation = await s.conversation();
		await s.harness.commit(async (tx) => {
			const doc = await tx.doc(FeishuDeliveryDoc);
			for (let index = 0; index < 2005; index++) doc.receipts[String(index)] = { conversationId: conversation.id, submissionId: index, chatId: "oc_original", header: "old terminal", status: index % 2 === 0 ? "done" : "uncertain", createdAt: index, updatedAt: index };
			doc.receipts["3000"] = { conversationId: conversation.id, submissionId: 3000, chatId: "oc_original", header: "old pending", status: "pending", createdAt: 0, updatedAt: 0 };
		}, context);
		await s.deliveries.enqueue({ conversationId: conversation.id, submissionId: 3001, chatId: "oc_original", header: "new pending" });
		const rows = Object.values((await s.harness.snapshot(FeishuDeliveryDoc, context))!.receipts);
		assert.equal(rows.filter((row) => row.status === "done" || row.status === "uncertain").length, 2000);
		assert.deepEqual(rows.filter((row) => row.status === "pending").map((row) => row.submissionId).sort(), [3000, 3001]);
	} finally { await s.close(); }
});

test("a full journal cannot block adopting an already active input before startup resumes", { timeout: 10_000 }, async () => {
	const s = await fixture(); const waiting = gate(); const entered = gate();
	try {
		await s.closeRuntime(); await s.open({ pendingLimit: 1 });
		const conversation = await s.conversation();
		s.faux.setResponses([blockedResponse(waiting, entered)]); s.harness.resume();
		const active = await conversation.submit({ type: "input", content: "active autonomous input without its announcement", entry: { kind: "chat.message", data: { sender: "ou_alice", via: "schedule" } } }, context);
		await entered.promise;
		const queued = await conversation.submit({ type: "input", content: "queued follow-up with a receipt", whenBusy: "followUp", entry: { kind: "chat.message", data: { sender: "ou_alice", via: "background" } } }, context);
		await s.deliveries.enqueue({ conversationId: conversation.id, submissionId: queued.id, chatId: "oc_original", header: "queued result" });
		await s.closeRuntime();
		s.faux.setResponses(Array.from({ length: 10 }, done)); await s.open({ pendingLimit: 1 });
		await s.deliveries.recover();
		const callsBeforeAdoption = s.faux.state.callCount;
		let adopted: boolean | undefined;
		const adoption = s.deliveries.adoptActive({ conversationId: conversation.id, submissionId: active.id, chatId: "oc_original" }).then((value) => { adopted = value; });
		void adoption.catch(() => {});
		await until(() => adopted !== undefined);
		assert.equal(adopted, true);
		assert.equal(s.faux.state.callCount, callsBeforeAdoption, "startup adoption must not resume model execution to create capacity");
		assert.equal((await s.row(queued.id))!.status, "pending");
		assert.equal((await s.row(active.id))!.status, "pending");
		await s.deliveries.enqueue({ conversationId: conversation.id, submissionId: active.id, chatId: "oc_other", header: "late announcement" });
		await s.deliveries.start(); s.harness.resume();
		await until(async () => (await s.row(active.id))?.status === "done" && (await s.row(queued.id))?.status === "done");
		assert.deepEqual(s.sent.map((row) => row.submissionId).sort(), [active.id, queued.id].sort());
		assert.ok(s.sent.every((row) => row.chatId === "oc_original"));
	} finally { waiting.release(); await s.close(); }
});

test("startup adoption rejects ordinary, untrusted and historical inputs before the worker starts", { timeout: 5000 }, async () => {
	const s = await fixture();
	try {
		for (const entry of [
			{ kind: "chat.message", data: { sender: "ou_alice", via: "feishu" } },
			{ kind: "untrusted", data: { sender: "ou_alice", via: "schedule" } },
		]) {
			const conversation = await s.conversation();
			const submission = await conversation.submit({ type: "input", content: "current input", entry }, context);
			assert.equal(await s.deliveries.adoptActive({ conversationId: conversation.id, submissionId: submission.id, chatId: "oc_original" }), false);
			await submission.wait(context);
		}
		const conversation = await s.conversation();
		const historical = await conversation.submit({ type: "input", content: "completed autonomous input", entry: { kind: "chat.message", data: { sender: "ou_alice", via: "proc" } } }, context);
		await historical.wait(context);
		assert.equal(await s.deliveries.adoptActive({ conversationId: conversation.id, submissionId: historical.id, chatId: "oc_original" }), false);
		assert.deepEqual((await s.harness.snapshot(FeishuDeliveryDoc, context))?.receipts ?? {}, {});
	} finally { await s.close(); }
});

test("startup recovery capacity cannot be used as ordinary admission after the worker starts", { timeout: 5000 }, async () => {
	const s = await fixture();
	try {
		await s.deliveries.start();
		const conversation = await s.conversation();
		const submission = await conversation.submit({ type: "input", content: "new active autonomous input", entry: { kind: "chat.message", data: { sender: "ou_alice", via: "schedule" } } }, context);
		assert.equal(await s.deliveries.adoptActive({ conversationId: conversation.id, submissionId: submission.id, chatId: "oc_original" }), false);
		assert.equal(await s.deliveries.owns(submission.id), false);
		assert.equal(s.faux.state.callCount, 0);
	} finally { await s.close(); }
});
