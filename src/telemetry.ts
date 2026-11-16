import { randomUUID } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { DURABLE_TELEMETRY_SCHEMA } from "@earendil-works/pi-durable";
import type { SpanAttributes, TelemetryAttributeDefinition, TelemetryContext, TelemetryMetrics, TelemetrySchemaDefinition, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { stateFile, writeStateJson } from "./state.ts";

type Metric = { name: string; kind: "counter" | "gauge" | "histogram"; attributes: SpanAttributes; count: number; sum: number; min: number; max: number };
type Trace = { id: string; traceId: string; parentId?: string; name: string; startedAt: number; durationMs: number; failed: boolean; attributes: SpanAttributes; events: { name: string; attributes: SpanAttributes }[] };
export type RuntimeTelemetrySnapshot = { version: 1; updatedAt: number; startedAt: number; metrics: Metric[]; traces: Trace[] };
const schema: TelemetrySchemaDefinition = DURABLE_TELEMETRY_SCHEMA;
const identifier = /^[a-zA-Z0-9_.:=-]{1,120}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const own = <T>(values: Record<string, T> | undefined, key: string): T | undefined => values && Object.hasOwn(values, key) ? values[key] : undefined;
const metricKey = (row: Pick<Metric, "name" | "kind" | "attributes">): string => JSON.stringify([row.name, row.kind, Object.entries(row.attributes).sort(([a], [b]) => a.localeCompare(b))]);

function safeAttributes(attributes: unknown, definitions: Record<string, TelemetryAttributeDefinition>): SpanAttributes {
	if (!record(attributes)) return {};
	const result: SpanAttributes = {};
	for (const [key, definition] of Object.entries(definitions)) {
		const value = attributes[key];
		if (definition.sensitive) continue;
		if (definition.type === "number" && finite(value) || definition.type === "boolean" && typeof value === "boolean") result[key] = value as number | boolean;
		else if (definition.type === "string" && typeof value === "string" && (definition.values ? definition.values.includes(value) : identifier.test(value))) result[key] = value;
	}
	return result;
}

/** Bounded operational metadata; prompts, tool arguments, results and error text never enter this store. */
export class RuntimeTelemetry {
	readonly context: TelemetryContext;
	#metrics = new Map<string, Metric>();
	#traces: Trace[] = [];
	#startedAt = Date.now();
	#file: string;
	#timer?: ReturnType<typeof setInterval>;
	#flush?: Promise<void>;
	#closing?: Promise<void>;
	#closed = false;
	#started = false;
	#stopped = false;
	constructor(file = stateFile("runtime-telemetry.json")) {
		this.#file = file;
		const instrument = (name: string, kind: Metric["kind"]) => (value: number, attributes?: SpanAttributes): void => {
			const definition = own(schema.metrics, name);
			if (this.#closed || !definition || (definition.kind === "upDownCounter" ? "gauge" : definition.kind) !== kind || !finite(value)) return;
			const safe = safeAttributes(attributes, definition.attributes ?? {});
			const key = metricKey({ name, kind, attributes: safe });
			let row = this.#metrics.get(key);
			if (row === undefined) {
				if (this.#metrics.size >= 256) return;
				row = { name, kind, attributes: safe, count: 0, sum: 0, min: value, max: value };
				this.#metrics.set(key, row);
			}
			if (!finite(row.sum + value)) return;
			row.count++; row.sum += value; row.min = Math.min(row.min, value); row.max = Math.max(row.max, value);
		};
		const metrics: TelemetryMetrics = {
			counter: (name) => ({ add: instrument(name, "counter") }),
			upDownCounter: (name) => ({ add: instrument(name, "gauge") }),
			histogram: (name) => ({ record: instrument(name, "histogram") }),
		};
		const identities = new WeakMap<TelemetryContext, { traceId: string; spanId: string }>();
		const makeContext = (parent?: { traceId: string; spanId: string }): TelemetryContext => {
			const ctx: TelemetryContext = {
				metrics,
				propagation: {
					inject: (value) => { const id = identities.get(value); return id ? { dwellTrace: id.traceId, dwellSpan: id.spanId } : undefined; },
					extract: (carrier) => carrier && uuid.test(carrier.dwellTrace ?? "") && uuid.test(carrier.dwellSpan ?? "") ? makeContext({ traceId: carrier.dwellTrace, spanId: carrier.dwellSpan }) : this.context,
				},
				startSpan: async (options, callback) => {
					const definition = own(schema.spans, options.name);
					const definitions = { ...definition?.startAttributes, ...definition?.endAttributes };
					const identity = { traceId: parent?.traceId ?? randomUUID(), spanId: randomUUID() };
					const row: Trace = { id: identity.spanId, traceId: identity.traceId, ...(parent ? { parentId: parent.spanId } : {}), name: options.name, startedAt: Date.now(), durationMs: 0, failed: false, attributes: safeAttributes(options.attributes, definitions), events: [] };
					const span: TelemetrySpan = {
						...makeContext(identity), addLink: () => {},
						addEvent: (name, attributes) => { const event = own(definition?.events, name); if (event && row.events.length < 32) row.events.push({ name, attributes: safeAttributes(attributes, event.attributes) }); },
						setAttributes: (attributes) => Object.assign(row.attributes, safeAttributes(attributes, definitions)),
						setStatus: (status) => { row.failed = status.status === "error"; },
					};
					identities.set(span, identity);
					try { return await callback(span); }
					catch (error) { row.failed = true; throw error; }
					finally {
						if (definition && !this.#closed) {
							row.durationMs = Math.max(0, Date.now() - row.startedAt);
							this.#traces.push(row);
							if (this.#traces.length > 200) this.#traces.splice(0, this.#traces.length - 200);
						}
					}
				},
			};
			if (parent) identities.set(ctx, parent);
			return ctx;
		};
		this.context = makeContext();
	}
	async start(): Promise<void> {
		if (this.#started || this.#closed || this.#stopped) return;
		this.#started = true;
		try {
			if ((await stat(this.#file)).size > 4 * 1024 * 1024) throw new Error("snapshot too large");
			const saved: unknown = JSON.parse(await readFile(this.#file, "utf8"));
			if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.metrics) || !Array.isArray(saved.traces)) throw new Error("invalid snapshot");
			for (const row of saved.metrics.slice(0, 256)) {
				if (!record(row) || typeof row.name !== "string") continue;
				const definition = own(schema.metrics, row.name);
				if (!definition || definition.kind === "upDownCounter" || row.kind !== definition.kind || !finite(row.count) || !Number.isSafeInteger(row.count) || row.count < 1 || !finite(row.sum) || !finite(row.min) || !finite(row.max) || row.min > row.max) continue;
				const metric: Metric = { name: row.name, kind: definition.kind, count: row.count, sum: row.sum, min: row.min, max: row.max, attributes: safeAttributes(row.attributes, definition.attributes ?? {}) };
				this.#metrics.set(metricKey(metric), metric);
			}
			for (const row of saved.traces.slice(-200)) {
				if (!record(row) || typeof row.name !== "string" || typeof row.id !== "string" || !uuid.test(row.id) || typeof row.traceId !== "string" || !uuid.test(row.traceId) || !finite(row.startedAt) || row.startedAt < 0 || !finite(row.durationMs) || row.durationMs < 0) continue;
				const definition = own(schema.spans, row.name);
				if (!definition) continue;
				const events: Trace["events"] = [];
				for (const event of Array.isArray(row.events) ? row.events.slice(0, 32) : []) {
					if (!record(event) || typeof event.name !== "string") continue;
					const eventDefinition = own(definition.events, event.name);
					if (eventDefinition) events.push({ name: event.name, attributes: safeAttributes(event.attributes, eventDefinition.attributes) });
				}
				this.#traces.push({ id: row.id, traceId: row.traceId, name: row.name, startedAt: row.startedAt, durationMs: row.durationMs, failed: row.failed === true, attributes: safeAttributes(row.attributes, { ...definition.startAttributes, ...definition.endAttributes }), events,
					...(typeof row.parentId === "string" && uuid.test(row.parentId) ? { parentId: row.parentId } : {}) });
			}
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[dwell] 运行观测快照无法恢复，开始新记录"); }
		if (!this.#stopped) {
			this.#timer = setInterval(() => { void this.flush().catch(() => {}); }, 30_000);
			this.#timer.unref();
		}
	}
	stop(): void { this.#stopped = true; clearInterval(this.#timer); this.#timer = undefined; }
	snapshot(): RuntimeTelemetrySnapshot { return structuredClone({ version: 1, updatedAt: Date.now(), startedAt: this.#startedAt, metrics: [...this.#metrics.values()], traces: this.#traces }); }
	flush(): Promise<void> {
		if (this.#flush) return this.#flush;
		if (this.#closed) return Promise.resolve();
		const snapshot = this.snapshot();
		this.#flush = (async () => {
			// Atomic rename preserves the pre-created temporary file's private mode.
			await writeFile(`${this.#file}.tmp`, "", { mode: 0o600 });
			await chmod(`${this.#file}.tmp`, 0o600);
			await writeStateJson(this.#file, snapshot);
		})().catch(() => { console.error("[dwell] 运行观测快照保存失败"); throw new Error("运行观测快照保存失败"); }).finally(() => { this.#flush = undefined; });
		return this.#flush;
	}
	close(): Promise<void> {
		this.stop();
		return this.#closing ??= (async () => { await this.#flush?.catch(() => {}); try { if (this.#started) await this.flush(); } finally { this.#closed = true; } })();
	}
}
