import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { PendingApproval } from "../src/ext/approval.ts";
import type { NormalizedMessage, TelegramDestination } from "../src/pipeline.ts";
import type { TelegramCallback } from "../src/telegram.ts";
import { TelegramInbox, TelegramInputWorkers, telegramApprovalData, telegramApprovalMatch } from "../src/telegram-entry.ts";

const model = { provider: "faux", modelId: "faux-1" };
const destination: TelegramDestination = { kind: "telegram", botId: "100", chatId: "-200", threadId: "9" };

test("Telegram answer deduplication binds the actual durable answer and destination across reopen", async () => {
	const t = await setup();
	try {
		const receipt = { conversationId: 42, sender: "tg:300", destination, replyTo: "tg:100:-200:1" };
		for (const id of ["first", "merged", "later"]) await t.inbox.prepare(id, receipt, async () => "same content is not the identity");
		assert.deepEqual(await Promise.all([t.inbox.claimAnswer("first", 100), t.inbox.claimAnswer("merged", 100)]), [true, false]);
		await t.reopen();
		assert.equal((await t.inbox.input("merged"))?.duplicateOf, "first");
		assert.equal((await t.inbox.input("merged"))?.output, "done");
		assert.equal(await t.inbox.claimAnswer("first", 100), true);
		assert.equal(await t.inbox.claimAnswer("later", 101), true);
		await t.inbox.prepare("different-target", { ...receipt, destination: { ...destination, threadId: "10" } }, async () => "");
		assert.equal(await t.inbox.claimAnswer("different-target", 100), true);
	} finally { await t.close(); }
});

test("Telegram preprocessing workers bound concurrency and serialize each durable route", async () => {
	const t = await setup();
	const started: string[] = [];
	const releases = new Map<string, () => void>();
	const waitFor = async (predicate: () => boolean) => {
		for (let i = 0; i < 2000; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 1)); }
		assert.fail("Worker checkpoint not reached");
	};
	try {
		for (const [id, conversationId] of [["1", 42], ["2", 42], ["3", 43], ["4", 44]] as const) {
			const raw: NormalizedMessage = { messageId: `tg:100:-200:${id}`, chatId: "tg:100:-200", chatType: "group", senderId: "tg:300", content: `Input ${id}`, rawContentType: "text", resources: [], mentions: [], mentionAll: false, mentionedBot: true, createTime: 10, platform: "telegram", destination, requestId: id };
			await t.inbox.enqueue(id, { conversationId, sender: raw.senderId, destination, replyTo: raw.messageId, requestId: id, raw });
		}
		await t.reopen();
		// Rebind the worker to the reopened database before starting it.
		const restored = new TelegramInputWorkers(t.inbox, async (id) => {
			started.push(id);
			await new Promise<void>((resolve) => releases.set(id, resolve));
			await t.inbox.admitted(id, 100 + Number(id));
		}, async (_id, _row, error) => { throw error; }, 2);
		try {
			restored.start();
			await waitFor(() => started.length === 2);
			assert.deepEqual(started, ["1", "3"]);
			releases.get("1")!();
			await waitFor(() => started.length === 3);
			assert.equal(started[2], "2", "Same-route input starts after its predecessor");
			releases.get("2")!();
			await waitFor(() => started.length === 4);
			assert.equal(started[3], "4");
		} finally {
			restored.stop();
			for (const release of releases.values()) release();
			await restored.close();
		}
	} finally { await t.close(); }
});

test("Telegram input cancellation retains the route until cleanup and preserves shutdown recovery", async () => {
	const t = await setup();
	const started: string[] = [];
	const signals = new Map<string, AbortSignal>();
	let finishCleanup!: () => void;
	const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
	let cancelled = false;
	const errors: unknown[] = [];
	const waitFor = async (predicate: () => boolean) => {
		for (let i = 0; i < 2000; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 1)); }
		assert.fail("Worker checkpoint not reached");
	};
	const workers = new TelegramInputWorkers(t.inbox, async (id, _row, signal) => {
		started.push(id);
		signals.set(id, signal);
		if (id === "second") await t.inbox.prepared(id, "prepared replacement survives shutdown");
		try {
			await new Promise<void>((_resolve, reject) => {
				const abort = () => { if (id === "first") cancelled = true; reject(signal.reason); };
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			});
		} finally { if (id === "first") await cleanup; }
	}, async (_id, _row, error) => { errors.push(error); }, 1);
	try {
		for (const id of ["first", "second"]) {
			const raw = { resources: [], content: id } as unknown as NormalizedMessage;
			await t.inbox.enqueue(id, { conversationId: 42, sender: "tg:300", destination, replyTo: id, raw });
		}
		workers.start();
		await waitFor(() => started.length === 1);
		await t.inbox.cancelInputs(["first"]);
		workers.cancel(["first"]);
		await waitFor(() => cancelled);
		assert.equal(workers.status().activeRoutes, 1);
		assert.deepEqual(started, ["first"], "Cancellation must not release the route while cleanup can still write");
		await t.inbox.prepared("first", "late cancelled content");
		const first = await t.inbox.input("first");
		assert.equal(first?.prepared, false);
		assert.equal(first?.content, "");
		assert.equal(first?.output, "failed");
		finishCleanup();
		await waitFor(() => started.length === 2);
		await waitFor(() => signals.has("second"));
		workers.cancel(["first"]);
		assert.equal(signals.get("second")?.aborted, false, "A replayed cancellation must not target later route input");
		await workers.close();
		await t.reopen();
		const second = await t.inbox.input("second");
		assert.equal(second?.output, "pending");
		assert.equal(second?.prepared, true);
		assert.equal(second?.content, "prepared replacement survives shutdown");
		for (const id of ["first", "second"]) assert.equal((await t.inbox.input(id))?.preparationAttempts, undefined);
		assert.deepEqual(errors, []);
	} finally { finishCleanup(); await workers.close(); await t.close(); }
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "dwell-telegram-entry-"));
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("local faux reply")]);
	const models = createModels();
	models.setProvider(faux.provider);
	let active: Harness;
	const open = async () => {
		active = await Harness.open(await openNodeSqliteStorage(join(directory, "dwell.sqlite")), { models, registry: createRegistry() }, context);
		active.resume();
		return active;
	};
	await open();
	return {
		faux,
		get harness() { return active; },
		get inbox() { return new TelegramInbox(active); },
		async reopen() { await active.close(context); await open(); },
		async close() { await active.close(context); await rm(directory, { recursive: true, force: true }); },
	};
}

test("prepared Telegram content, submission and reply tracking survive replay and SQLite reopen", async () => {
	const t = await setup();
	try {
		const conversation = await t.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const id = "tg-update:100:10";
		const receipt = { conversationId: conversation.id, sender: "tg:300", destination, replyTo: "tg:100:-200:1" };
		let preparations = 0;
		const first = await t.inbox.prepare(id, receipt, async () => { preparations++; return "image description from the original upload"; });
		assert.deepEqual(first, { ...receipt, content: "image description from the original upload", output: "pending" });
		const changed = { conversationId: conversation.id + 1, sender: "tg:301", destination: { ...destination, threadId: "10" }, replyTo: "tg:100:-200:2" };
		assert.deepEqual(await t.inbox.prepare(id, changed, async () => { preparations++; return "replacement content"; }), first);
		assert.equal(preparations, 1);
		const submission = await conversation.submit({ type: "input", content: first.content, requestId: id }, context);
		await t.inbox.admitted(id, submission.id);
		assert.equal((await submission.wait(context)).status, "done");
		const claimed = await t.inbox.claim(id);
		assert.equal(claimed?.submissionId, submission.id);
		assert.equal(claimed?.output, "pending");
		await t.inbox.output(id, "tracking", "tg:100:-200:50");
		const tracked = { ...first, submissionId: submission.id, messageId: "tg:100:-200:50", output: "tracking" };
		assert.deepEqual(await t.inbox.input(id), tracked);
		await t.reopen();
		assert.deepEqual(await t.inbox.prepare(id, changed, async () => { preparations++; throw new Error("replay must not download or describe again"); }), tracked);
		assert.equal(preparations, 1);
		assert.deepEqual(await t.inbox.recoverable(), [[id, tracked]]);
		assert.deepEqual(await t.inbox.claim(id), tracked);
		assert.deepEqual(await t.inbox.input(id), tracked);
		const resumed = await t.harness.submission(submission.id, context);
		assert.equal((await resumed!.wait(context)).status, "done");
		const restoredConversation = await t.harness.conversation(conversation.id, context);
		assert.equal((await restoredConversation!.submit({ type: "input", content: first.content, requestId: id }, context)).id, submission.id);
		assert.equal(t.faux.state.callCount, 1);
		await t.inbox.output(id, "done");
		assert.deepEqual(await t.inbox.input(id), { ...tracked, output: "done" });
		assert.equal(await t.inbox.claim(id), undefined);
		assert.deepEqual(await t.inbox.recoverable(), []);
	} finally { await t.close(); }
});

test("a known autonomous submission is recoverable from the first receipt commit", async () => {
	const t = await setup();
	try {
		const conversation = await t.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const submission = await conversation.submit({ type: "input", content: "autonomous result", requestId: "background-report:1" }, context);
		const id = `tg-reply:100:${submission.id}`;
		const receipt = { conversationId: conversation.id, sender: "tg:300", destination, replyTo: "tg:100:-200:1", submissionId: submission.id };
		await t.inbox.prepare(id, receipt, async () => "");
		await t.reopen();
		const [[restoredId, restored]] = await t.inbox.recoverable();
		assert.equal(restoredId, id);
		assert.equal(restored.submissionId, submission.id);
		assert.equal(restored.output, "pending");
		const resumed = await t.harness.submission(restored.submissionId!, context);
		assert.equal((await resumed!.wait(context)).status, "done");
		assert.equal((await t.inbox.claim(id))?.submissionId, submission.id);
	} finally { await t.close(); }
});

test("an ambiguous Telegram send is persisted and cannot be claimed again after restart", async () => {
	const t = await setup();
	try {
		const conversation = await t.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const id = "tg-update:100:20";
		const first = await t.inbox.prepare(id, { conversationId: conversation.id, sender: "tg:300", destination, replyTo: "tg:100:-200:2" }, async () => "hello");
		assert.equal(await t.inbox.claim("missing-update"), undefined);
		assert.deepEqual(await Promise.all([t.inbox.claim(id), t.inbox.claim(id)]), [first, undefined]);
		const sending = { ...first, output: "sending" };
		assert.deepEqual(await t.inbox.input(id), sending);
		assert.equal(await t.inbox.claim(id), undefined);
		await t.reopen();
		assert.deepEqual(await t.inbox.recoverable(), [[id, sending]]);
		assert.equal(await t.inbox.claim(id), undefined);
		assert.deepEqual(await t.inbox.prepare(id, { ...first, sender: "tg:301" }, async () => { throw new Error("ambiguous sends must retain their prepared input"); }), sending);
		await t.inbox.output(id, "uncertain");
		await t.reopen();
		assert.equal((await t.inbox.input(id))?.output, "uncertain");
		assert.equal(await t.inbox.claim(id), undefined);
		assert.deepEqual(await t.inbox.recoverable(), []);
	} finally { await t.close(); }
});

test("failed Telegram preparation leaves no receipt and a later delivery can prepare the input", async () => {
	const t = await setup();
	try {
		const receipt = { conversationId: 42, sender: "tg:300", destination, replyTo: "tg:100:-200:3" };
		await assert.rejects(t.inbox.prepare("tg-update:100:30", receipt, async () => { throw new Error("download unavailable"); }), /download unavailable/);
		assert.equal(await t.inbox.input("tg-update:100:30"), undefined);
		assert.deepEqual(await t.inbox.recoverable(), []);
		await t.reopen();
		assert.equal((await t.inbox.prepare("tg-update:100:30", receipt, async () => "recovered file content")).content, "recovered file content");
	} finally { await t.close(); }
});

test("finished and failed Telegram receipts remain terminal after SQLite reopen", async () => {
	const t = await setup();
	try {
		const receipt = { conversationId: 42, sender: "tg:300", destination, replyTo: "tg:100:-200:4" };
		const pending = await t.inbox.prepare("still-pending", receipt, async () => "pending input");
		for (const state of ["done", "failed"] as const) {
			await t.inbox.prepare(state, receipt, async () => `${state} input`);
			await t.inbox.admitted(state, state === "done" ? 100 : 101);
			await t.inbox.output(state, state, `tg:100:-200:${state === "done" ? 80 : 81}`);
		}
		await t.reopen();
		assert.deepEqual(await t.inbox.recoverable(), [["still-pending", pending]]);
		for (const state of ["done", "failed"] as const) {
			const restored = await t.inbox.input(state);
			assert.equal(restored?.output, state);
			assert.equal(restored?.submissionId, state === "done" ? 100 : 101);
			assert.equal(restored?.messageId, `tg:100:-200:${state === "done" ? 80 : 81}`);
			assert.equal(await t.inbox.claim(state), undefined);
			assert.deepEqual(await t.inbox.prepare(state, { ...receipt, conversationId: 99 }, async () => { throw new Error("terminal receipts must not prepare again"); }), restored);
		}
	} finally { await t.close(); }
});

test("control receipts freeze the original conversation, cancel task and approval request across replay", async (ctx) => {
	const t = await setup();
	let now = 1_800_000_000_000;
	ctx.mock.method(Date, "now", () => now);
	try {
		assert.equal(await t.inbox.command("missing-command"), undefined);
		const cancel = await t.inbox.beginCommand("tg-update:100:40", { conversationId: 42, command: "/cancel", cancelTaskId: 500 });
		const approve = await t.inbox.beginCommand("tg-update:100:41", { conversationId: 43, command: "/approve", approvalRequestId: "request-original" });
		assert.equal(cancel.createdAt, now);
		assert.equal(approve.createdAt, now);
		assert.equal(cancel.done, false);
		now += 60_000;
		assert.deepEqual(await t.inbox.beginCommand("tg-update:100:40", { conversationId: 99, command: "/cancel", cancelTaskId: 501 }), cancel);
		assert.deepEqual(await t.inbox.beginCommand("tg-update:100:41", { conversationId: 100, command: "/deny", approvalRequestId: "request-replacement" }), approve);
		await t.reopen();
		assert.deepEqual(await t.inbox.command("tg-update:100:40"), cancel);
		assert.deepEqual(await t.inbox.command("tg-update:100:41"), approve);
		assert.deepEqual(await t.inbox.beginCommand("tg-update:100:40", { conversationId: 99, command: "/cancel", cancelTaskId: 502 }), cancel);
		assert.deepEqual(await t.inbox.beginCommand("tg-update:100:41", { conversationId: 100, command: "/approve", approvalRequestId: "request-newest" }), approve);
		await t.inbox.finishCommand("tg-update:100:40");
		await t.inbox.finishCommand("tg-update:100:41");
		await t.reopen();
		now += 60_000;
		assert.deepEqual(await t.inbox.beginCommand("tg-update:100:40", { conversationId: 101, command: "/cancel", cancelTaskId: 503 }), { ...cancel, done: true });
		assert.deepEqual(await t.inbox.beginCommand("tg-update:100:41", { conversationId: 102, command: "/deny", approvalRequestId: "request-after-completion" }), { ...approve, done: true });
	} finally { ctx.mock.restoreAll(); await t.close(); }
});

const approvalNow = 1_800_000_000_000;
const approvalId = "2d2419ae-e30c-4a2d-a324-1f3032d01091";
const approvalKey = "42:tg:300";
const approvalFixture = () => {
	const pending: PendingApproval = {
		command: "rm -rf generated", match: "recursive removal", trigger: "tg:300", via: "telegram",
		requestId: approvalId, createdAt: approvalNow - 60_000,
		cardMessageId: "tg:100:-200:70", cardDestination: destination,
	};
	const callback: TelegramCallback = {
		id: "callback-1", senderId: "tg:300", destination,
		messageId: pending.cardMessageId!, data: telegramApprovalData(approvalId, "approve"),
	};
	const permissions = {
		allowed: (sender: string) => new Set(["tg:300", "tg:301", "tg:302", "tg:900"]).has(sender),
		admin: (sender: string) => sender === "tg:900",
		owner: (scope: number) => scope === 42 ? "tg:302" : undefined,
		chatAllowed: (dest: TelegramDestination) => dest.chatId === "-200",
	};
	return { pending, callback, permissions, entries: new Map([[approvalKey, pending]]) };
};

test("Telegram approval buttons bind the opaque request to the actual authorized sender", () => {
	const { pending, callback, permissions, entries } = approvalFixture();
	for (const [action, minutes] of [["approve", 10], ["approve", 30], ["deny", 10]] as const) {
		const data = telegramApprovalData(approvalId, action, minutes);
		assert.ok(Buffer.byteLength(data) <= 64);
		assert.deepEqual(telegramApprovalMatch({ ...callback, data }, entries, permissions, approvalNow), { key: approvalKey, action, minutes });
	}
	assert.equal(telegramApprovalMatch({ ...callback, senderId: "tg:301" }, entries, permissions, approvalNow), undefined, "a permitted group member does not inherit another sender's approval");
	assert.deepEqual(telegramApprovalMatch({ ...callback, senderId: "tg:301" }, new Map([[approvalKey, { ...pending, trigger: "tg:301" }]]), permissions, approvalNow), { key: approvalKey, action: "approve", minutes: 10 }, "the persisted actor can approve a request from their own run in a shared conversation");
	for (const senderId of ["tg:302", "tg:900"]) {
		assert.deepEqual(telegramApprovalMatch({ ...callback, senderId }, entries, permissions, approvalNow), { key: approvalKey, action: "approve", minutes: 10 });
	}
	assert.equal(telegramApprovalMatch({ ...callback, senderId: "tg:999" }, entries, { ...permissions, admin: () => true }, approvalNow), undefined, "administrator authority does not bypass sender admission");
	const unrelated = { ...pending, requestId: "other-request", cardMessageId: "tg:100:-200:71" };
	const withAnotherRequest = new Map([["43:tg:300", unrelated], [approvalKey, pending]]);
	assert.equal(telegramApprovalMatch({ ...callback, data: telegramApprovalData("other-request", "approve") }, withAnotherRequest, permissions, approvalNow), undefined);
	assert.equal(telegramApprovalMatch({ ...callback, data: telegramApprovalData("42", "approve") }, entries, permissions, approvalNow), undefined, "the scope is not an approval request identifier");
});

test("Telegram approvals require the admitted group and exact bot, chat, topic and card message", () => {
	const { pending, callback, permissions, entries } = approvalFixture();
	assert.equal(telegramApprovalMatch(callback, entries, { ...permissions, chatAllowed: () => false }, approvalNow), undefined);
	for (const changedDestination of [
		{ ...destination, botId: "101" },
		{ ...destination, chatId: "-201" },
		{ ...destination, threadId: "10" },
		{ kind: "telegram" as const, botId: destination.botId, chatId: destination.chatId },
	]) {
		assert.equal(telegramApprovalMatch({ ...callback, destination: changedDestination }, entries, { ...permissions, chatAllowed: () => true }, approvalNow), undefined);
	}
	assert.equal(telegramApprovalMatch({ ...callback, messageId: "tg:100:-200:71" }, entries, permissions, approvalNow), undefined);
	for (const cardDestination of [undefined, { kind: "feishu" as const, chatId: "oc_chat" }]) {
		assert.equal(telegramApprovalMatch(callback, new Map([[approvalKey, { ...pending, cardDestination }]]), permissions, approvalNow), undefined);
	}
	assert.equal(telegramApprovalMatch(callback, new Map([[approvalKey, { ...pending, cardMessageId: undefined }]]), permissions, approvalNow), undefined);
});

test("malformed, stale and future Telegram approval references cannot decide a pending request", () => {
	const { pending, callback, permissions, entries } = approvalFixture();
	for (const data of [
		"", `a:${approvalId}`, `a:${approvalId}:60`, `a:${approvalId}:approve`,
		`a:${approvalId}:10:extra`, `a:${approvalId}:10\n`, ` a:${approvalId}:10`,
		`a:${approvalId}:d `, "a:../../request:10", `approve:${approvalId}:10`,
	]) assert.equal(telegramApprovalMatch({ ...callback, data }, entries, permissions, approvalNow), undefined, JSON.stringify(data));
	for (const createdAt of [undefined, approvalNow - 24 * 3600_000 - 1, approvalNow + 1]) {
		assert.equal(telegramApprovalMatch(callback, new Map([[approvalKey, { ...pending, createdAt }]]), permissions, approvalNow), undefined);
	}
	assert.deepEqual(telegramApprovalMatch(callback, new Map([[approvalKey, { ...pending, createdAt: approvalNow - 24 * 3600_000 + 1 }]]), permissions, approvalNow), { key: approvalKey, action: "approve", minutes: 10 });
	assert.equal(telegramApprovalMatch(callback, new Map([[approvalKey, { ...pending, requestId: undefined }]]), permissions, approvalNow), undefined);
	assert.equal(telegramApprovalMatch(callback, new Map(), permissions, approvalNow), undefined);
});
