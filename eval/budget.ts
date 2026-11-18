import { lazyStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type ModelCost } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { ResolvedModelConnection } from "../src/models.ts";

export type CostBudget = { limitUsd: number; requestBoundUsd: number };
export type CostEvidence = CostBudget & { requests: number; reportedUsd: number; unreportedBoundUsd: number; accountedUsd: number; stopped: boolean };

export function requestCostBound(connection: ResolvedModelConnection): number {
	if (!connection.pricingKnown) throw new Error("Cost-limited evaluation requires known model pricing");
	const rates: ModelCost[] = [];
	const visit = (cost: ModelCost): void => { rates.push(cost); for (const tier of cost.tiers ?? []) visit(tier); };
	visit(connection.metadata.cost);
	// Cache creation may use the provider's longer retention multiplier. Charging all
	// context tokens at the highest rate also covers mixed cached/uncached requests.
	const input = Math.max(...rates.flatMap((rate) => [rate.input, rate.cacheRead, rate.cacheWrite * 2]));
	const output = Math.max(...rates.map((rate) => rate.output));
	return (connection.metadata.contextWindow * input + connection.metadata.maxTokens * output) / 1_000_000;
}

export class RequestBudget {
	readonly reservations = new Map<number, number>();
	requests = 0;
	reportedUsd = 0;
	stopped = false;
	readonly config: CostBudget;
	constructor(config: CostBudget) { this.config = config; }
	snapshot(): CostEvidence {
		const unreportedBoundUsd = [...this.reservations.values()].reduce((sum, value) => sum + value, 0);
		return { ...this.config, requests: this.requests, reportedUsd: this.reportedUsd, unreportedBoundUsd, accountedUsd: this.reportedUsd + unreportedBoundUsd, stopped: this.stopped };
	}
	reserve(): number {
		if (this.snapshot().accountedUsd + this.config.requestBoundUsd > this.config.limitUsd) {
			this.stopped = true;
			throw new Error("Trial estimated cost budget exhausted before provider dispatch");
		}
		const id = ++this.requests;
		this.reservations.set(id, this.config.requestBoundUsd);
		return id;
	}
	settle(id: number, message: AssistantMessage): void {
		if (!this.reservations.has(id)) return;
		const cost = message.usage.cost.total;
		// Failed or aborted requests can omit usage, even when a zero placeholder is
		// present. Retain their full reservation instead of assuming they were free.
		if (message.stopReason === "error" || message.stopReason === "aborted" || !(message.usage.totalTokens > 0) || !Number.isFinite(cost) || cost < 0) return;
		this.reservations.delete(id);
		this.reportedUsd += cost;
		if (this.snapshot().accountedUsd > this.config.limitUsd) this.stopped = true;
	}
}

/** Intercept provider dispatch itself: compaction and child requests count too. */
export function guardedProvider(provider: Provider, before: () => Promise<number>, after: (id: number, message: AssistantMessage) => void): Provider {
	const wrap = (model: Parameters<Provider["streamSimple"]>[0], start: () => AssistantMessageEventStream): AssistantMessageEventStream => lazyStream(model, async () => {
		const id = await before();
		const stream = start();
		let settled = false;
		const finish = (message: AssistantMessage): void => { if (!settled) { settled = true; after(id, message); } };
		return {
			async *[Symbol.asyncIterator]() {
				for await (const event of stream) {
					if (event.type === "done") finish(event.message);
					else if (event.type === "error") finish(event.error);
					yield event;
				}
			},
			result: async () => { const message = await stream.result(); finish(message); return message; },
		};
	});
	return {
		...provider,
		stream: (model, context, options) => wrap(model, () => provider.stream<Api>(model, context, { ...options, maxTokens: Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens), maxRetries: 0, deferred: false })),
		streamSimple: (model, context, options) => wrap(model, () => provider.streamSimple(model, context, { ...options, maxTokens: Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens), maxRetries: 0, deferred: false })),
	};
}
