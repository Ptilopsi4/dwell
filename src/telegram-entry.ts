import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson } from "@earendil-works/chord";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { NormalizedMessage, TelegramDestination } from "./pipeline.ts";
import { sameDestination } from "./pipeline.ts";
import type { ApprovalRevocation, PendingApproval, RunVia } from "./ext/approval.ts";
import type { TelegramCallback } from "./telegram.ts";

export type TelegramInputReceipt = {
	conversationId: number;
	sender: string;
	authorityVia?: RunVia;
	destination: TelegramDestination;
	replyTo: string;
	content: string;
	raw?: string;
	prepared?: boolean;
	preparationAttempts?: number;
	retryAt?: number;
	answerId?: number;
	duplicateOf?: string;
	requestId?: string;
	submissionId?: number;
	messageId?: string;
	output: "pending" | "sending" | "tracking" | "done" | "uncertain" | "failed";
};
export type TelegramCommandReceipt = {
	conversationId: number;
	command: string;
	createdAt: number;
	cancelTaskId?: number;
	cancelInputIds?: string[];
	approvalRequestId?: string;
	windowExpiresAt?: number;
	denial?: ApprovalRevocation;
	newGoalWorkId?: string | null;
	done: boolean;
};
export const TelegramInboxDoc = defineDoc<{
	inputs: Record<string, TelegramInputReceipt>;
	commands: Record<string, TelegramCommandReceipt>;
}>({
	kind: "dwell.telegram-inbox", version: 1, scope: "session",
	initial: () => ({ inputs: {}, commands: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

/** The journal binds redeliveries to their original content and control targets. */
export class TelegramInbox {
	#harness: Harness;
	constructor(harness: Harness) { this.#harness = harness; }
	async input(id: string): Promise<TelegramInputReceipt | undefined> {
		return (await this.#harness.snapshot(TelegramInboxDoc, BACKGROUND_CONTEXT))?.inputs[id];
	}
	async enqueue(id: string, receipt: Omit<TelegramInputReceipt, "content" | "output" | "raw"> & { raw: NormalizedMessage }): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(TelegramInboxDoc);
			doc.inputs[id] ??= { ...receipt, raw: JSON.stringify(receipt.raw), content: "", prepared: false, output: "pending" };
		}, BACKGROUND_CONTEXT);
	}
	async prepared(id: string, content: string): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const row = (await tx.doc(TelegramInboxDoc)).inputs[id];
			row.content = content;
			row.prepared = true;
		}, BACKGROUND_CONTEXT);
	}
	async preparationFailed(id: string): Promise<boolean> {
		return this.#harness.commit(async (tx) => {
			const row = (await tx.doc(TelegramInboxDoc)).inputs[id];
			if (row.output !== "pending") return false;
			row.preparationAttempts = (row.preparationAttempts ?? 0) + 1;
			row.retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** (row.preparationAttempts - 1));
			if (row.preparationAttempts >= 3) row.output = "failed";
			return row.output === "failed";
		}, BACKGROUND_CONTEXT);
	}
	async pendingInputs(): Promise<[string, TelegramInputReceipt][]> {
		return (await this.recoverable()).filter(([, row]) => row.raw !== undefined && row.submissionId === undefined && row.output === "pending");
	}
	async cancelInputs(ids: string[]): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(TelegramInboxDoc);
			for (const id of ids) {
				const row = doc.inputs[id];
				if (row !== undefined && row.submissionId === undefined && row.output === "pending") row.output = "failed";
			}
		}, BACKGROUND_CONTEXT);
	}
	/** Deduplicate the durable answer identity, never the submission's queued status or text. */
	async claimAnswer(id: string, answerId: number): Promise<boolean> {
		return this.#harness.commit(async (tx) => {
			const doc = await tx.doc(TelegramInboxDoc);
			const row = doc.inputs[id];
			const duplicate = Object.entries(doc.inputs).find(([key, other]) => key !== id && other.duplicateOf === undefined
				&& other.conversationId === row.conversationId && other.answerId === answerId && sameDestination(other.destination, row.destination));
			row.answerId = answerId;
			if (duplicate !== undefined) { row.duplicateOf = duplicate[0]; row.output = "done"; return false; }
			return true;
		}, BACKGROUND_CONTEXT);
	}
	async prepare(id: string, receipt: Omit<TelegramInputReceipt, "content" | "output">, content: () => Promise<string>): Promise<TelegramInputReceipt> {
		const previous = await this.input(id);
		if (previous !== undefined) return previous;
		const prepared = await content();
		return this.#harness.commit(async (tx) => {
			const doc = await tx.doc(TelegramInboxDoc);
			return copyJson(doc.inputs[id] ??= { ...receipt, content: prepared, output: "pending" }) as TelegramInputReceipt;
		}, BACKGROUND_CONTEXT);
	}
	async admitted(id: string, submissionId: number): Promise<void> {
		await this.#harness.commit(async (tx) => { (await tx.doc(TelegramInboxDoc)).inputs[id].submissionId = submissionId; }, BACKGROUND_CONTEXT);
	}
	async output(id: string, state: TelegramInputReceipt["output"], messageId?: string): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(TelegramInboxDoc);
			const row = doc.inputs[id];
			row.output = state;
			if (messageId !== undefined) row.messageId = messageId;
			let excess = Object.keys(doc.inputs).length - 10_000;
			for (const key of Object.keys(doc.inputs)) {
				if (excess <= 0) break;
				if (key !== id && ["done", "failed", "uncertain"].includes(doc.inputs[key].output)) { delete doc.inputs[key]; excess--; }
			}
		}, BACKGROUND_CONTEXT);
	}
	async claim(id: string): Promise<TelegramInputReceipt | undefined> {
		return this.#harness.commit(async (tx) => {
			const row = (await tx.doc(TelegramInboxDoc)).inputs[id];
			if (row === undefined || (row.output !== "pending" && row.output !== "tracking")) return undefined;
			const snapshot = copyJson(row) as TelegramInputReceipt;
			row.output = row.messageId === undefined ? "sending" : "tracking";
			return snapshot;
		}, BACKGROUND_CONTEXT);
	}
	async recoverable(): Promise<[string, TelegramInputReceipt][]> {
		const doc = await this.#harness.snapshot(TelegramInboxDoc, BACKGROUND_CONTEXT);
		return Object.entries(doc?.inputs ?? {}).filter(([, row]) => !["done", "uncertain", "failed"].includes(row.output));
	}
	async command(id: string): Promise<TelegramCommandReceipt | undefined> {
		return (await this.#harness.snapshot(TelegramInboxDoc, BACKGROUND_CONTEXT))?.commands[id];
	}
	async beginCommand(id: string, receipt: Omit<TelegramCommandReceipt, "createdAt" | "done">): Promise<TelegramCommandReceipt> {
		return this.#harness.commit(async (tx) => {
			const doc = await tx.doc(TelegramInboxDoc);
			return copyJson(doc.commands[id] ??= { ...receipt, createdAt: Date.now(), done: false }) as TelegramCommandReceipt;
		}, BACKGROUND_CONTEXT);
	}
	async finishCommand(id: string): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(TelegramInboxDoc);
			doc.commands[id].done = true;
			let excess = Object.keys(doc.commands).length - 10_000;
			for (const key of Object.keys(doc.commands)) {
				if (excess <= 0) break;
				if (key !== id && doc.commands[key].done) { delete doc.commands[key]; excess--; }
			}
		}, BACKGROUND_CONTEXT);
	}
}

/** SQLite owns the backlog; only a bounded number of routes hold in-memory workers. */
export class TelegramInputWorkers {
	#active = new Map<number, Promise<void>>();
	#timer?: ReturnType<typeof setTimeout>;
	#scanning = false;
	#stopped = true;
	#controller = new AbortController();
	#inbox: TelegramInbox;
	#process: (id: string, row: TelegramInputReceipt, signal: AbortSignal) => Promise<void>;
	#onError: (id: string, row: TelegramInputReceipt, error: unknown, terminal: boolean) => Promise<void>;
	#concurrency: number;
	constructor(inbox: TelegramInbox, process: (id: string, row: TelegramInputReceipt, signal: AbortSignal) => Promise<void>,
		onError: (id: string, row: TelegramInputReceipt, error: unknown, terminal: boolean) => Promise<void>, concurrency = 4) {
		this.#inbox = inbox; this.#process = process; this.#onError = onError; this.#concurrency = concurrency;
	}
	start(): void { this.#stopped = false; this.wake(); }
	status(): { activeRoutes: number; concurrency: number; stopped: boolean } {
		return { activeRoutes: this.#active.size, concurrency: this.#concurrency, stopped: this.#stopped };
	}
	wake(): void {
		if (this.#stopped || this.#timer !== undefined) return;
		this.#timer = setTimeout(() => { this.#timer = undefined; void this.#pump(); }, 0);
	}
	stop(): void { this.#stopped = true; this.#controller.abort(); if (this.#timer !== undefined) clearTimeout(this.#timer); this.#timer = undefined; }
	async close(): Promise<void> { this.stop(); await Promise.allSettled(this.#active.values()); }
	async #pump(): Promise<void> {
		if (this.#stopped || this.#scanning) return;
		this.#scanning = true;
		try {
			const routes = new Set<number>();
			for (const [id, row] of await this.#inbox.pendingInputs()) {
				if (this.#stopped || this.#active.size >= this.#concurrency) break;
				if (routes.has(row.conversationId)) continue;
				routes.add(row.conversationId);
				if (this.#active.has(row.conversationId) || (row.retryAt ?? 0) > Date.now()) continue;
				const task = this.#process(id, row, this.#controller.signal).catch(async (error: unknown) => {
					if (this.#stopped) return;
					const terminal = await this.#inbox.preparationFailed(id);
					await this.#onError(id, row, error, terminal);
				}).finally(() => { this.#active.delete(row.conversationId); this.wake(); });
				this.#active.set(row.conversationId, task);
				void task.catch((error: unknown) => console.error("[dwell] Telegram 输入恢复失败:", error));
			}
		} catch (error) { console.error("[dwell] Telegram 输入队列读取失败:", error); }
		finally {
			this.#scanning = false;
			if (!this.#stopped && this.#timer === undefined) this.#timer = setTimeout(() => { this.#timer = undefined; void this.#pump(); }, 1000);
		}
	}
}

export function telegramApprovalData(requestId: string, action: "approve" | "deny", minutes = 10): string {
	return `a:${requestId}:${action === "deny" ? "d" : minutes === 30 ? "30" : "10"}`;
}

/** The button is a reference; authority comes from persisted actor, destination and request identity. */
export function telegramApprovalMatch(
	callback: TelegramCallback,
	pending: ReadonlyMap<string, PendingApproval>,
	permissions: { allowed: (sender: string) => boolean; admin: (sender: string) => boolean; owner: (scope: number) => string | undefined; chatAllowed: (destination: TelegramDestination) => boolean },
	now = Date.now(),
): { key: string; action: "approve" | "deny"; minutes: number } | undefined {
	const parsed = /^a:([a-zA-Z0-9-]+):(10|30|d)$/.exec(callback.data);
	if (parsed === null || !permissions.allowed(callback.senderId) || !permissions.chatAllowed(callback.destination)) return undefined;
	for (const [key, value] of pending) {
		if (value.requestId !== parsed[1] || value.cardMessageId !== callback.messageId || value.cardDestination?.kind !== "telegram") continue;
		if (!sameDestination(value.cardDestination, callback.destination)) return undefined;
		if (value.createdAt === undefined || now - value.createdAt > 24 * 3600_000 || now < value.createdAt) return undefined;
		const scope = Number(key.split(":")[0]);
		if (callback.senderId !== value.trigger && callback.senderId !== permissions.owner(scope) && !permissions.admin(callback.senderId)) return undefined;
		return { key, action: parsed[2] === "d" ? "deny" : "approve", minutes: parsed[2] === "30" ? 30 : 10 };
	}
	return undefined;
}
