import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { TelegramInbox } from "../src/telegram-entry.ts";

const done = () => fauxAssistantMessage(fauxText("done"));

test("autonomous Telegram senders survive queuing behind another actor and reopening", { timeout: 10_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-telegram-sender-"));
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	let entered!: () => void;
	const running = new Promise<void>((resolve) => { entered = resolve; });
	faux.setResponses([async (_request, options) => {
		entered();
		await new Promise<void>((resolve) => {
			if (options!.signal!.aborted) resolve();
			else options!.signal!.addEventListener("abort", () => resolve(), { once: true });
		});
		return done();
	}]);
	const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry();
	const open = () => openNodeSqliteStorage(join(directory, "state.sqlite")).then((storage) => Harness.open(storage, { models, registry }, context));
	let harness = await open();
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
		harness.resume();
		const busy = await conversation.submit({ type: "input", content: "Bob is still working", entry: { kind: "chat.message", data: { sender: "tg:bob", via: "telegram" } } }, context);
		await running;
		const inbox = new TelegramInbox(harness);
		assert.equal(await inbox.submissionSender(conversation.id, busy.id), "tg:bob");
		const queued = [];
		for (const source of ["schedule", "proc", "background", "dwell.approval", "dwell.approval.legacy"]) {
			const submission = await conversation.submit({
				type: "input", content: `Alice's ${source} result`, whenBusy: "followUp",
				entry: { kind: source.startsWith("dwell.") ? source : "chat.message", data: { sender: "tg:alice", via: source, authorityVia: "telegram" } },
			}, context);
			assert.equal((await submission.status(context)).status, "queued");
			assert.equal(await inbox.submissionSender(conversation.id, submission.id), "tg:alice");
			queued.push(submission.id);
		}
		const receiptId = `tg-reply:100:${queued[0]}`;
		const destination = { kind: "telegram" as const, botId: "100", chatId: "-300", threadId: "9" };
		await inbox.prepare(receiptId, { conversationId: conversation.id, submissionId: queued[0], sender: "tg:bob", destination, replyTo: "tg:100:-300:7" }, async () => "");
		const allowed = new Set(["tg:alice"]);
		assert.equal(allowed.has((await inbox.input(receiptId))!.sender), false, "Bob has been revoked before recovery");
		await harness.close(context);
		faux.setResponses(Array.from({ length: 20 }, done));
		harness = await open();
		const restored = new TelegramInbox(harness);
		const callsBeforeRecovery = faux.state.callCount;
		const sender = await restored.reconcileSender(receiptId);
		assert.equal(sender, "tg:alice");
		assert.equal(allowed.has(sender!), true, "recovery admits Alice's existing result despite the old erroneous Bob receipt");
		assert.equal((await restored.input(receiptId))!.sender, "tg:alice");
		assert.deepEqual((await restored.input(receiptId))!.destination, destination, "repairing the actor cannot redirect delivery");
		assert.equal(faux.state.callCount, callsBeforeRecovery, "reconciling existing output does not resubmit input or call the model");
		for (const id of queued) assert.equal(await restored.submissionSender(conversation.id, id), "tg:alice", "queued metadata survives before scheduling resumes");
		harness.resume();
		for (const id of queued) {
			assert.equal((await (await harness.submission(id, context))!.wait(context)).status, "done");
			assert.equal(await restored.submissionSender(conversation.id, id), "tg:alice", "transcript metadata retains the same actor after the queue drains");
		}
	} finally { await harness.close(context); await rm(directory, { recursive: true, force: true }); }
});

test("Telegram sender lookup rejects foreign, passive, missing and unattributed submissions", { timeout: 5000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-telegram-sender-boundary-"));
	const faux = fauxProvider({ tokensPerSecond: 100_000 }); faux.setResponses(Array.from({ length: 10 }, done));
	const models = createModels(); models.setProvider(faux.provider);
	const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "state.sqlite")), { models, registry: createRegistry() }, context);
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
		const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const inbox = new TelegramInbox(harness);
		const attributed = await conversation.submit({ type: "input", content: "attributed", entry: { kind: "chat.message", data: { sender: "tg:alice" } } }, context);
		assert.equal(await inbox.submissionSender(other.id, attributed.id), undefined);
		assert.equal(await inbox.submissionSender(conversation.id, 999999), undefined);
		const passive = await conversation.submit({ type: "write", entry: { kind: "chat.message", data: { sender: "tg:alice" } } }, context);
		assert.equal(await inbox.submissionSender(conversation.id, passive.id), undefined);
		for (const entry of [undefined, { kind: "chat.message", data: { sender: "" } }, { kind: "untrusted", data: { sender: "tg:alice" } }]) {
			const submission = await conversation.submit({ type: "input", content: "unattributed", whenBusy: "followUp", ...(entry === undefined ? {} : { entry }) }, context);
			assert.equal(await inbox.submissionSender(conversation.id, submission.id), undefined);
		}
	} finally { await harness.close(context); await rm(directory, { recursive: true, force: true }); }
});
