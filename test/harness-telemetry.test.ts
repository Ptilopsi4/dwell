import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Harness } from "@earendil-works/pi-durable";

test("openDwell owns telemetry through close, reopen and startup failure", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-harness-telemetry-"));
	for (const name of Object.keys(process.env)) if (!["PATH", "HOME", "TMPDIR", "LANG", "TZ"].includes(name)) delete process.env[name];
	process.env.DWELL_DATA = join(directory, "data");
	process.env.DWELL_STATE = join(directory, "state");
	const nativeInterval = globalThis.setInterval;
	const nativeClear = globalThis.clearInterval;
	const timers: { callback: () => void; handle: ReturnType<typeof setInterval>; cleared: boolean }[] = [];
	globalThis.setInterval = ((callback: () => void, delay?: number, ...args: unknown[]) => {
		const handle = nativeInterval(callback, delay, ...args) as unknown as ReturnType<typeof setInterval>;
		if (delay === 30_000) timers.push({ callback, handle, cleared: false });
		return handle;
	}) as typeof setInterval;
	globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
		const timer = timers.find((item) => item.handle === handle);
		if (timer) timer.cleared = true;
		nativeClear(handle);
	}) as typeof clearInterval;
	const { openDwell, runtimeTelemetry } = await import("../src/harness.ts");
	const models = createModels();
	models.setProvider(fauxProvider().provider);
	const opened: Awaited<ReturnType<typeof openDwell>>[] = [];
	t.after(async () => {
		for (const harness of opened) { await harness.close(context).catch(() => {}); await runtimeTelemetry(harness)?.close().catch(() => {}); }
		globalThis.setInterval = nativeInterval;
		globalThis.clearInterval = nativeClear;
		for (const timer of timers) nativeClear(timer.handle);
		await rm(directory, { recursive: true, force: true });
	});
	await t.test("awaited close persists final counters and retired callbacks cannot overwrite a reopened snapshot", async () => {
		const first = await openDwell(models); opened.push(first);
		const old = runtimeTelemetry(first)!;
		old.context.metrics!.counter("pi.durable.reports").add(1, { type: "task_error" });
		await first.close(context);
		assert.equal(timers[0].cleared, true);
		const snapshotFile = join(directory, "state", "runtime-telemetry.json");
		const persisted = async () => JSON.parse(await readFile(snapshotFile, "utf8")).metrics.find((row: { name: string; attributes: { type?: string } }) => row.name === "pi.durable.reports" && row.attributes.type === "task_error")?.sum;
		assert.equal(await persisted(), 1);
		const second = await openDwell(models); opened.push(second);
		const current = runtimeTelemetry(second)!;
		current.context.metrics!.counter("pi.durable.reports").add(100, { type: "task_error" });
		await current.flush();
		timers[0].callback();
		await old.flush();
		assert.equal(await persisted(), 101);
		await second.close(context);
	});
	await t.test("awaited Harness close waits for the final telemetry flush", async () => {
		const harness = await openDwell(models); opened.push(harness);
		const telemetry = runtimeTelemetry(harness)!;
		const closeTelemetry = telemetry.close.bind(telemetry);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let began = false;
		telemetry.close = async () => { began = true; await gate; await closeTelemetry(); };
		let settled = false;
		const closing = harness.close(context).finally(() => { settled = true; });
		try {
			await harness.closed;
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(began, true);
			assert.equal(settled, false);
		} finally { release(); await closing; telemetry.close = closeTelemetry; }
	});
	await t.test("a failed session retires its telemetry without an explicit caller close", async () => {
		const sdkOpen = Harness.open;
		const failure = new Error("synthetic session failure");
		let failStorage!: () => void;
		Harness.open = async (storage, options, openContext) => {
			const harness = await sdkOpen(storage, options, openContext);
			failStorage = () => { storage.commit = async () => { throw failure; }; };
			return harness;
		};
		try {
			const harness = await openDwell(models); opened.push(harness);
			const telemetry = runtimeTelemetry(harness)!;
			const metric = telemetry.context.metrics!.counter("pi.durable.reports");
			metric.add(7, { type: "task_error" });
			const closeTelemetry = telemetry.close.bind(telemetry);
			let closedTelemetry!: Promise<void>;
			telemetry.close = () => closedTelemetry = closeTelemetry();
			failStorage();
			await assert.rejects(harness.root(context), /synthetic session failure/);
			const closed = await harness.closed;
			assert.equal(closed.reason, "failed");
			assert.ok(closedTelemetry);
			await closedTelemetry;
			assert.equal(timers.at(-1)!.cleared, true);
			const before = telemetry.snapshot().metrics.find((row) => row.name === "pi.durable.reports" && row.attributes.type === "task_error")!.sum;
			metric.add(100, { type: "task_error" });
			assert.equal(telemetry.snapshot().metrics.find((row) => row.name === "pi.durable.reports" && row.attributes.type === "task_error")!.sum, before);
		} finally { Harness.open = sdkOpen; }
	});
	await t.test("a failed SDK close still releases telemetry and preserves the original close error", async () => {
		const sdkOpen = Harness.open;
		const failure = new Error("synthetic storage close failure");
		Harness.open = async (storage, options, openContext) => {
			const closeStorage = storage.close.bind(storage);
			storage.close = async (closeContext) => { await closeStorage(closeContext); throw failure; };
			return sdkOpen(storage, options, openContext);
		};
		try {
			const harness = await openDwell(models); opened.push(harness);
			runtimeTelemetry(harness)!.flush = async () => { throw new Error("synthetic final flush failure"); };
			await assert.rejects(harness.close(context), (error) => error === failure);
			assert.equal(timers.at(-1)!.cleared, true);
		} finally { Harness.open = sdkOpen; }
	});
	await t.test("an SDK open failure releases its storage and telemetry timer", async () => {
		const sdkOpen = Harness.open;
		let storageClosed = false;
		Harness.open = async (storage) => {
			const closeStorage = storage.close.bind(storage);
			storage.close = async (closeContext) => { storageClosed = true; await closeStorage(closeContext); };
			throw new Error("synthetic open failure");
		};
		try {
			await assert.rejects(openDwell(models), /synthetic open failure/);
			assert.equal(timers.at(-1)!.cleared, true);
			assert.equal(storageClosed, true);
		} finally { Harness.open = sdkOpen; }
	});
});
