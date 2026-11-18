import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc, LiveDoc, type ConversationId, type Harness, type SubmissionId } from "@earendil-works/pi-durable";

export type FeishuDelivery = {
	conversationId: number; submissionId: number; chatId: string; header: string;
	replyTo?: string; replyInThread?: boolean;
	status: "pending" | "sending" | "done" | "uncertain" | "failed";
	createdAt: number; updatedAt: number; delayedAt?: number;
};
type DeliveryInput = Omit<FeishuDelivery, "status" | "createdAt" | "updatedAt" | "delayedAt">;
export type FeishuDeliveryAlert = "capacity" | "delayed" | "uncertain" | "missing" | "storage" | "failed";
export const FEISHU_PENDING_LIMIT = 1000;
export const FEISHU_DELIVERY_CONCURRENCY = 4;
const TERMINAL_LIMIT = 2000;
const DELAY_ALERT_MS = 30 * 60_000;
export const FeishuDeliveryDoc = defineDoc<{ receipts: Record<string, FeishuDelivery> }>({
	kind: "dwell.feishu-deliveries", version: 1, scope: "session",
	initial: () => ({ receipts: {} }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

function trimTerminal(receipts: Record<string, FeishuDelivery>): void {
	const terminal = Object.entries(receipts).filter(([, row]) => row.status !== "pending" && row.status !== "sending").sort((a, b) => a[1].updatedAt - b[1].updatedAt);
	for (const [id] of terminal.slice(0, Math.max(0, terminal.length - TERMINAL_LIMIT))) delete receipts[id];
}

/** Only autonomous Feishu replies use this journal; ordinary input recovery keeps its existing mirror. */
export class FeishuDeliveries {
	#harness: Harness;
	#deliver: (receipt: FeishuDelivery, signal: AbortSignal) => Promise<void>;
	#report: (receipt: DeliveryInput, alert: FeishuDeliveryAlert) => void;
	#now: () => number;
	#pollMs: number;
	#pendingLimit: number;
	#controller = new AbortController();
	#active = new Map<string, Promise<void>>();
	#enqueues = new Set<Promise<void>>();
	#timer?: ReturnType<typeof setInterval>;
	#scan?: Promise<void>;
	#recovery?: Promise<void>;
	#started = false;
	#closed = false;
	constructor(harness: Harness, options: {
		deliver: (receipt: FeishuDelivery, signal: AbortSignal) => Promise<void>;
		report: (receipt: DeliveryInput, alert: FeishuDeliveryAlert) => void;
		now?: () => number; pollMs?: number; pendingLimit?: number;
	}) {
		this.#harness = harness; this.#deliver = options.deliver; this.#report = options.report;
		this.#now = options.now ?? Date.now; this.#pollMs = options.pollMs ?? 2000;
		this.#pendingLimit = options.pendingLimit ?? FEISHU_PENDING_LIMIT;
	}
	enqueue(input: DeliveryInput): Promise<void> {
		const work = this.#enqueue(input);
		this.#enqueues.add(work);
		void work.finally(() => this.#enqueues.delete(work)).catch(() => {});
		return work;
	}
	async #enqueue(input: DeliveryInput): Promise<void> {
		let alerted = false;
		for (;;) {
			this.#controller.signal.throwIfAborted();
			const saved = await this.#harness.commit(async (tx) => {
				const doc = await tx.doc(FeishuDeliveryDoc);
				if (doc.receipts[String(input.submissionId)] !== undefined) return true;
				if (Object.values(doc.receipts).filter((row) => row.status === "pending" || row.status === "sending").length >= this.#pendingLimit) return false;
				trimTerminal(doc.receipts);
				doc.receipts[String(input.submissionId)] = { ...input, status: "pending", createdAt: this.#now(), updatedAt: this.#now() };
				return true;
			}, context);
			if (saved) { this.#kick(); return; }
			// Keep the producer's announce checkpoint alive while the bounded journal is full.
			if (!alerted) { this.#report(input, "capacity"); alerted = true; }
			await delay(this.#pollMs, undefined, { signal: this.#controller.signal });
		}
	}
	async owns(submissionId: number): Promise<boolean> {
		return (await this.#harness.snapshot(FeishuDeliveryDoc, context))?.receipts[String(submissionId)] !== undefined;
	}
	/** Close the submit/announce restart gap without adopting historical or ordinary user answers. */
	async adoptActive(input: Omit<DeliveryInput, "header">): Promise<boolean> {
		if (await this.owns(input.submissionId)) return true;
		if (this.#started || this.#closed) return false;
		const submission = await (await this.#harness.submission(input.submissionId as SubmissionId, context))?.status(context);
		if (submission?.conversationId !== input.conversationId || submission.type !== "input" || submission.entry === undefined) return false;
		return this.#harness.commit(async (tx) => {
			const doc = await tx.doc(FeishuDeliveryDoc);
			if (doc.receipts[String(input.submissionId)] !== undefined) return true;
			const live = await tx.doc(LiveDoc, input.conversationId as ConversationId);
			if (live.run?.inputs[0] !== input.submissionId) return false;
			const entry = await tx.entry(submission.entry!);
			const data = entry?.data;
			if (entry?.conversationId !== input.conversationId || entry.kind !== "chat.message" || typeof data !== "object" || data === null || Array.isArray(data) || (data.via !== "schedule" && data.via !== "proc" && data.via !== "background")) return false;
			if (this.#started || this.#closed) return false;
			// Startup must not await capacity that only resume can free. This admits at most one
			// already accepted first input per active conversation; new producers still use the cap.
			trimTerminal(doc.receipts);
			doc.receipts[String(input.submissionId)] = { ...input, header: "🔄 服务重启 · 自治回报", status: "pending", createdAt: this.#now(), updatedAt: this.#now() };
			return true;
		}, context);
	}
	async recover(): Promise<void> {
		return this.#recovery ??= (async () => {
			const uncertain = await this.#harness.commit(async (tx) => {
				const doc = await tx.doc(FeishuDeliveryDoc);
				const changed: FeishuDelivery[] = [];
				for (const receipt of Object.values(doc.receipts)) if (receipt.status === "sending") {
					receipt.status = "uncertain"; receipt.updatedAt = this.#now(); changed.push({ ...receipt });
				}
				trimTerminal(doc.receipts);
				return changed;
			}, context);
			for (const receipt of uncertain) this.#report(receipt, "uncertain");
		})();
	}
	async start(): Promise<void> {
		await this.recover();
		if (this.#closed || this.#started) return;
		this.#started = true;
		this.#timer = setInterval(() => this.#kick(), this.#pollMs); this.#timer.unref();
		this.#kick();
	}

	/** 平台不可用时的降级：把 pending 回报落为 failed（无人投递也不能永久占用 pending 容量阻塞生产）。返回处理条数。 */
	async failPending(reason: string): Promise<number> {
		await this.recover();
		if (this.#closed) return 0;
		const rows = await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(FeishuDeliveryDoc);
			const changed: FeishuDelivery[] = [];
			for (const receipt of Object.values(doc.receipts)) if (receipt.status === "pending") {
				receipt.status = "failed"; receipt.updatedAt = this.#now(); changed.push({ ...receipt }); void reason;
			}
			trimTerminal(doc.receipts);
			return changed;
		}, context);
		for (const receipt of rows) this.#report(receipt, "failed");
		return rows.length;
	}
	#kick(): void {
		if (!this.#started || this.#closed || this.#scan !== undefined) return;
		this.#scan = (async () => {
			const doc = await this.#harness.snapshot(FeishuDeliveryDoc, context);
			if (this.#closed) return;
			for (const [id, receipt] of Object.entries(doc?.receipts ?? {})) {
				if (receipt.status !== "pending" || this.#active.has(id)) continue;
				let ready: boolean;
				try { ready = await this.#ready(receipt); }
				catch (error) {
					if (this.#closed) return;
					console.error("[dwell] 飞书自治投递状态读取失败:", error); this.#report(receipt, "storage"); continue;
				}
				if (!ready || this.#closed) continue;
				if (this.#active.size >= FEISHU_DELIVERY_CONCURRENCY) break;
				const work = this.#send(receipt).catch((error: unknown) => {
					if (this.#closed) return;
					console.error("[dwell] 飞书自治投递状态处理失败:", error);
					this.#report(receipt, "storage");
				}).finally(() => { this.#active.delete(id); });
				this.#active.set(id, work);
			}
		})().catch((error: unknown) => { if (!this.#closed) console.error("[dwell] 飞书自治投递扫描失败:", error); }).finally(() => { this.#scan = undefined; });
	}
	async #ready(receipt: FeishuDelivery): Promise<boolean> {
		const submission = await this.#harness.submission(receipt.submissionId as SubmissionId, context);
		const record = await submission?.status(context);
		if (this.#closed) return false;
		if (record?.status === "queued") {
			if (this.#now() - receipt.createdAt < DELAY_ALERT_MS || receipt.delayedAt !== undefined) return false;
			const alerted = await this.#harness.commit(async (tx) => {
				const current = (await tx.doc(FeishuDeliveryDoc)).receipts[String(receipt.submissionId)];
				if (current?.status !== "pending" || current.delayedAt !== undefined) return false;
				current.delayedAt = current.updatedAt = this.#now(); return true;
			}, context);
			if (alerted) this.#report(receipt, "delayed");
			return false;
		}
		if (record === undefined || record.conversationId !== receipt.conversationId || record.type !== "input" || await this.#harness.conversation(receipt.conversationId as ConversationId, context) === undefined) {
			await this.#finish(receipt, "failed"); this.#report(receipt, "missing"); return false;
		}
		return true;
	}
	async #send(receipt: FeishuDelivery): Promise<void> {
		const claimed = await this.#harness.commit(async (tx) => {
			const current = (await tx.doc(FeishuDeliveryDoc)).receipts[String(receipt.submissionId)];
			if (current?.status !== "pending") return false;
			current.status = "sending"; current.updatedAt = this.#now(); return true;
		}, context);
		// 关机竞态：尚未真正进入 #deliver 的 sending 行回滚 pending（未发出的发送可安全重试），
		// 不能等重启统一标 uncertain——那会把从未开始的回报永久吞掉
		if (!claimed) return;
		if (this.#closed) { await this.#finish(receipt, "pending"); return; }
		try {
			await this.#deliver(receipt, this.#controller.signal);
			if (!this.#closed) await this.#finish(receipt, "done");
		} catch (error) {
			if (this.#closed) return;
			console.error("[dwell] 飞书自治回报投递结果不确定:", error);
			await this.#finish(receipt, "uncertain"); this.#report(receipt, "uncertain");
		}
	}
	async #finish(receipt: FeishuDelivery, status: FeishuDelivery["status"]): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(FeishuDeliveryDoc);
			const current = doc.receipts[String(receipt.submissionId)];
			if (current !== undefined) { current.status = status; current.updatedAt = this.#now(); }
			trimTerminal(doc.receipts);
		}, context);
	}
	async close(): Promise<void> {
		this.#closed = true; this.#controller.abort();
		if (this.#timer !== undefined) clearInterval(this.#timer);
		await this.#scan;
		await Promise.allSettled(this.#enqueues);
		await Promise.allSettled(this.#active.values());
	}
}
