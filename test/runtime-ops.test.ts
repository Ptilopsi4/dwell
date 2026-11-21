import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import { TelegramBot, TelegramError } from "../src/telegram.ts";
import { startPanel } from "../src/web/server.ts";
import { mainFixture, message, posixOnly } from "./telegram-main-fixture.ts";

type PanelOptions = Parameters<typeof startPanel>[0];

async function panelFixture(t: TestContext, trusted: boolean) {
	const names = ["DWELL_PANEL_ONLY", "DWELL_PANEL_TRUST_LOCAL", "DWELL_PANEL_HOST"] as const;
	const previous = names.map((name) => process.env[name]);
	delete process.env.DWELL_PANEL_ONLY;
	process.env.DWELL_PANEL_TRUST_LOCAL = trusted ? "1" : "0";
	process.env.DWELL_PANEL_HOST = "127.0.0.1";
	let ready = false;
	let status = "polling";
	let server: ReturnType<typeof startPanel>;
	try {
		server = startPanel({
			harness: {} as PanelOptions["harness"], sessions: {} as PanelOptions["sessions"], users: {} as PanelOptions["users"], directory: {} as PanelOptions["directory"],
			feishu: { operator: () => "tg:1", status: () => "off", relay: async () => {}, notice: async () => {}, notifyPanel: async () => {}, decide: async () => ({ ok: true }) },
			telegram: () => status, ready: () => ready,
			runtime: async () => ({ telegram: { transport: status, workers: { activeRoutes: 1, concurrency: 4, stopped: false }, inbox: { pending: 1, sending: 0, tracking: 0 } } }),
			port: 0, sandbox: () => false, describer: () => null, saveUpload: async () => { throw new Error("unused"); },
		});
	} finally {
		for (const [index, name] of names.entries()) {
			if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
		}
	}
	t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
	await once(server, "listening");
	const address = server.address();
	assert.ok(address !== null && typeof address !== "string");
	return { base: `http://127.0.0.1:${address.port}`, ready: (value: boolean) => { ready = value; }, status: (value: string) => { status = value; } };
}

test("runtime and readiness retain panel local-source trust while health remains available", async (t) => {
	const denied = await panelFixture(t, false);
	assert.equal((await fetch(`${denied.base}/healthz`)).status, 200);
	for (const path of ["/api/runtime", "/api/ready"]) assert.equal((await fetch(`${denied.base}${path}`)).status, 403);
	const trusted = await panelFixture(t, true);
	assert.equal((await fetch(`${trusted.base}/api/ready`)).status, 503);
	trusted.ready(true);
	const ready = await fetch(`${trusted.base}/api/ready`);
	assert.equal(ready.status, 200);
	assert.equal(ready.headers.get("cache-control"), "no-store");
	trusted.status("failed");
	assert.equal((await fetch(`${trusted.base}/api/ready`)).status, 503);
	const runtime = await fetch(`${trusted.base}/api/runtime`);
	assert.equal(runtime.status, 200);
	assert.equal(runtime.headers.get("cache-control"), "no-store");
	assert.deepEqual((await runtime.json()).telegram.inbox, { pending: 1, sending: 0, tracking: 0 });
});

test("terminal Telegram failure reports once and supports reentrant repeated close", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-ops-telegram-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const errors: TelegramError[] = [];
	let closing: Promise<void> | undefined;
	let bot: TelegramBot;
	bot = await TelegramBot.connect({
		token: "123:SYNTHETIC_OPS_TOKEN", stateFile: join(directory, "cursor.json"),
		onMessage: async () => {}, onCallback: async () => {}, onError: () => {},
		onFatal: (error) => { errors.push(error); closing = bot.close(); throw new Error("reporting failure"); },
		fetch: async (input) => {
			const method = String(input).split("/").at(-1);
			if (method === "getMe") return Response.json({ ok: true, result: { id: 123, username: "OpsBot" } });
			if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
			return Response.json({ ok: false, error_code: 409, description: "PRIVATE_REMOTE_DESCRIPTION" }, { status: 409 });
		},
	});
	bot.start();
	for (let i = 0; i < 100 && closing === undefined; i++) await setImmediate();
	assert.ok(closing);
	await Promise.all([closing, bot.close(), bot.close()]);
	assert.equal(bot.status(), "off");
	assert.equal(errors.length, 1);
	assert.equal(errors[0].code, 409);
	assert.doesNotMatch(errors[0].message, /PRIVATE_|SYNTHETIC_OPS_TOKEN/);
});

test("runtime reports pending raw input and graceful shutdown preserves it for restart", { ...posixOnly, timeout: 20_000 }, async (t) => {
	const f = await mainFixture(t, [], { panel: true });
	let passed = false;
	try {
		const listening = await f.until((event) => event.method === "panel.listening");
		const base = `http://127.0.0.1:${listening.body.port}`;
		await f.until((event) => event.method === "getUpdates");
		assert.equal((await fetch(`${base}/api/ready`)).status, 200);
		f.updates([message(800, "PRIVATE_RAW_INPUT", { document: { file_id: "hold-shutdown", file_name: "raw.txt" } })]);
		await f.until((event) => event.method === "media.waiting");
		await f.until((event) => event.method === "getUpdates" && event.body.offset === 801);
		const response = await fetch(`${base}/api/runtime`);
		assert.equal(response.status, 200);
		const body = await response.text();
		const runtime = JSON.parse(body);
		assert.equal(runtime.telegram.inbox.tracking, 1);
		assert.equal(runtime.telegram.workers.activeRoutes, 1);
		assert.doesNotMatch(body, /PRIVATE_RAW_INPUT|hold-shutdown|SYNTHETIC_TEST_TOKEN/);
		assert.deepEqual(await f.stop(), [0, null]);
		const row = (await f.snapshot()).inbox.inputs["tg-update:100:800"];
		assert.equal(row.prepared, false);
		// 附件占位已发出并登记：重启后恢复会复用同一条占位消息
		assert.equal(row.output, "tracking");
		assert.ok(row.messageId !== undefined);
		assert.match(row.raw!, /hold-shutdown/);
		const telemetry = JSON.parse(await readFile(join(f.directory, "state", "runtime-telemetry.json"), "utf8"));
		assert.ok(Array.isArray(telemetry.traces));
		assert.equal(f.requests("unexpected").length, 0);
		passed = true;
	} finally { await f.close(passed); }
});

async function isolatedMain(t: TestContext, scenario: string, sandbox = "off") {
	const directory = await mkdtemp(join(tmpdir(), "dwell-ops-main-"));
	const privateRoot = join(import.meta.dirname, "../.pi");
	await mkdir(privateRoot, { recursive: true });
	const configDirectory = await mkdtemp(join(privateRoot, "ops-main-"));
	const modelsFile = join(configDirectory, "models.json");
	await writeFile(modelsFile, JSON.stringify({ main: { api: "openai-responses", baseUrl: "https://models.invalid/v1", model: "opaque-ops-model", apiKeyEnv: "DWELL_MODEL_API_KEY" }, vision: null }));
	let logs = "";
	const events: { method?: string; body?: Record<string, unknown> }[] = [];
	const child: ChildProcess = fork(fileURLToPath(new URL("../src/index.ts", import.meta.url)), [], {
		cwd: join(import.meta.dirname, ".."), execArgv: ["--import", new URL("./runtime-ops-hook.ts", import.meta.url).href],
		env: { PATH: process.env.PATH, NODE_ENV: "production", TZ: "UTC", DWELL_TZ: "UTC", DWELL_DATA: join(directory, "data"), DWELL_STATE: join(directory, "state"), DWELL_MODELS_FILE: modelsFile,
			DWELL_MODEL_API_KEY: "synthetic-ops-key", TELEGRAM_BOT_TOKEN: "100:SYNTHETIC_TEST_TOKEN", DWELL_ALLOW: "tg:200", DWELL_SANDBOX: sandbox, DWELL_TEST_OPS: scenario,
			...(scenario === "handshake-wait" ? { DWELL_TEST_PANEL: "1", DWELL_PANEL_PORT: "17788", DWELL_PANEL_HOST: "127.0.0.1", DWELL_PANEL_TRUST_LOCAL: "1", DWELL_PANEL_USER: "tg:200" } : {}) },
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	child.stdout!.on("data", (data) => { logs += data; });
	child.stderr!.on("data", (data) => { logs += data; });
	child.on("message", (event: { method?: string; body?: Record<string, unknown> }) => events.push(event));
	const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		await rm(configDirectory, { recursive: true, force: true });
		await rm(directory, { recursive: true, force: true });
	});
	async function until(method: string) {
		for (let i = 0; i < 500; i++) {
			const event = events.find((event) => event.method === method);
			if (event !== undefined) return event;
			assert.equal(child.exitCode, null, logs);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.fail(logs);
	}
	return { child, exited, events, until, logs: () => logs };
}

test("startup readiness waits for Telegram handshake and repeated signals close once", { ...posixOnly, timeout: 12_000 }, async (t) => {
	const f = await isolatedMain(t, "handshake-wait");
	await f.until("ops.handshake-waiting");
	const listening = await f.until("panel.listening");
	const base = `http://127.0.0.1:${listening.body!.port}`;
	assert.equal((await fetch(`${base}/healthz`)).status, 200);
	assert.equal((await fetch(`${base}/api/ready`)).status, 503);
	f.child.send({ kind: "ops-release" });
	await f.until("getUpdates");
	assert.equal((await fetch(`${base}/api/ready`)).status, 200);
	f.child.kill("SIGTERM");
	f.child.kill("SIGINT");
	assert.deepEqual(await f.exited, [0, null]);
	assert.equal(f.logs().split("关闭中").length - 1, 1);
});

test("fatal Telegram handshake and polling errors exit main nonzero without exposing remote error text", { timeout: 15_000 }, async (t) => {
	for (const scenario of ["handshake-fatal", "poll-fatal"]) await t.test(scenario, async (t) => {
		const f = await isolatedMain(t, scenario);
		assert.deepEqual(await f.exited, [1, null]);
		assert.equal(f.events.filter((event) => event.method === "ops.fatal-response").length, 1);
		assert.match(f.logs(), /Telegram 已停止/);
		assert.doesNotMatch(f.logs(), /SYNTHETIC_PRIVATE_DESCRIPTION|SYNTHETIC_TEST_TOKEN/);
	});
});

test("required sandbox failure prevents bot connection before resume", { skip: process.platform === "linux" ? "Linux isolation is checked by the dedicated probes" : false, timeout: 10_000 }, async (t) => {
	const f = await isolatedMain(t, "handshake-fatal", "required");
	assert.deepEqual(await f.exited, [1, null]);
	assert.match(f.logs(), /DWELL_SANDBOX=required.*拒绝启动/);
	assert.equal(f.events.some((event) => event.method === "ops.fatal-response"), false);
});

test("stalled transport close is bounded by the shutdown deadline", { ...posixOnly, timeout: 38_000 }, async (t) => {
	const f = await isolatedMain(t, "stalled-close");
	await f.until("getUpdates");
	const started = Date.now();
	f.child.kill("SIGTERM");
	assert.deepEqual(await f.exited, [1, null]);
	assert.ok(Date.now() - started >= 29_000);
	assert.match(f.logs(), /关闭超过 30 秒，强制退出/);
	assert.equal(f.events.filter((event) => event.method === "ops.close-stalled").length, 1);
});
