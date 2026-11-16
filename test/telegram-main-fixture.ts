import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { TelegramInputReceipt } from "../src/telegram-entry.ts";
import type { JsonRecord, MainFixtureEvent, ModelReply } from "./telegram-main-hook.ts";

export function message(id: number, text: string, overrides: JsonRecord = {}): JsonRecord {
	return { update_id: id, message: { message_id: id, date: 10, chat: { id: 200, type: "private" },
		from: { id: 200, first_name: "Member" }, text, ...overrides } };
}

export async function mainFixture(t: TestContext, initialReplies: ModelReply[] = [], options: { panel?: boolean } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "dwell-telegram-main-"));
	// Production rejects model configuration in the system temporary directory.
	const privateRoot = resolve(import.meta.dirname, "../.pi");
	await mkdir(privateRoot, { recursive: true });
	const configDirectory = await mkdtemp(join(privateRoot, "telegram-main-"));
	const modelsFile = join(configDirectory, "models.json");
	await writeFile(modelsFile, JSON.stringify({ main: { api: "openai-responses", baseUrl: "https://models.invalid/v1", model: "opaque-acceptance-model", apiKeyEnv: "DWELL_MODEL_API_KEY", compat: { supportsAdditionalTools: true, supportsMidConvoSystemMessages: true } }, vision: null }));
	const events: MainFixtureEvent[] = [];
	const changed = new EventEmitter();
	let logs = "";
	let child: ChildProcess;
	let generation = 0;
	const running = () => child.exitCode === null && child.signalCode === null;
	const diagnostic = () => `${logs.slice(-8000)}\nFixture diagnostics: ${join(directory, "child.log")}\nObserved events: ${events.map((event) => `${event.generation}:${event.method ?? event.kind}`).join(", ")}`;
	function start(replies: ModelReply[] = []): void {
		assert.ok(child === undefined || !running(), "Stop the previous main process before restarting");
		const currentGeneration = ++generation;
		logs += `\n--- main generation ${currentGeneration} ---\n`;
		child = fork(fileURLToPath(new URL("../src/index.ts", import.meta.url)), [], {
			cwd: resolve(import.meta.dirname, ".."),
			execArgv: ["--import", new URL("./telegram-main-hook.ts", import.meta.url).href],
			// Never inherit credentials, NODE_OPTIONS, or a dotenv startup argument.
			env: { PATH: process.env.PATH, TZ: "UTC", DWELL_TZ: "UTC", DWELL_DATA: join(directory, "data"), DWELL_STATE: join(directory, "state"), DWELL_MODELS_FILE: modelsFile,
				DWELL_MODEL_API_KEY: "synthetic-acceptance-key", TELEGRAM_BOT_TOKEN: "100:SYNTHETIC_TEST_TOKEN", DWELL_ALLOW: "tg:200,tg:201", DWELL_TELEGRAM_CHATS: "-300", DWELL_SANDBOX: "off",
				DWELL_TEST_TRANSPORT_STATE: join(directory, "transport.json"), DWELL_TEST_REPLIES: JSON.stringify(replies),
				...(options.panel ? { DWELL_TEST_PANEL: "1", DWELL_PANEL_PORT: "17788", DWELL_PANEL_HOST: "127.0.0.1", DWELL_PANEL_TRUST_LOCAL: "1", DWELL_PANEL_USER: "tg:200" } : {}) },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		child.stdout!.on("data", (data) => { logs += data; });
		child.stderr!.on("data", (data) => { logs += data; });
		child.on("message", (event: MainFixtureEvent) => { events.push({ ...event, generation: currentGeneration }); changed.emit("change"); });
		child.on("exit", (code, signal) => { logs += `\nmain generation ${currentGeneration} exited: ${code}, ${signal}\n`; changed.emit("change"); });
	}
	async function until(predicate: (event: MainFixtureEvent) => boolean, after = 0): Promise<MainFixtureEvent> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 20_000);
		try {
			for (;;) {
				const found = events.slice(after).find(predicate);
				if (found !== undefined) return found;
				assert.ok(running(), diagnostic());
				await once(changed, "change", { signal: controller.signal });
			}
		} catch (error) { throw new Error(diagnostic(), { cause: error }); }
		finally { clearTimeout(timer); }
	}
	async function stop(signal: "SIGTERM" | "SIGKILL"): Promise<[number | null, NodeJS.Signals | null]> {
		if (!running()) return [child.exitCode, child.signalCode];
		const exited = once(child, "exit");
		child.kill(signal);
		const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
		try { return await exited as [number | null, NodeJS.Signals | null]; }
		finally { clearTimeout(timer); }
	}
	async function snapshot() {
		assert.ok(!running(), "Read durable state only after the main process exits");
		const storage = await openNodeSqliteStorage(join(directory, "data", "dwell.sqlite"));
		try {
			const doc = await storage.findDocument({ kind: "dwell.telegram-inbox", scope: { kind: "session" } }, "current", context);
			const inbox = doc === undefined ? { inputs: {}, commands: {} } : (await storage.document(doc.id, "current", context))!.value as { inputs: Record<string, TelegramInputReceipt>; commands: JsonRecord };
			const submissions = (await storage.scanSubmissions({}, 1000, undefined, context)).items;
			const tasks = (await storage.scanTasks({}, 1000, undefined, context)).items;
			return { inbox, submissions, tasks };
		} finally { await storage.close(context); }
	}
	async function close(passed: boolean): Promise<void> {
		const [code, signal] = await stop("SIGTERM");
		await rm(configDirectory, { recursive: true, force: true });
		if (passed && code === 0 && signal === null) {
			await rm(directory, { recursive: true, force: true });
		} else {
			await writeFile(join(directory, "child.log"), `${logs}\nEvents: ${JSON.stringify(events, null, "\t")}`);
			t.diagnostic(`Main-process diagnostics retained at ${join(directory, "child.log")}`);
		}
		if (passed) {
			assert.equal(signal, null, diagnostic());
			assert.equal(code, 0, diagnostic());
		}
	}
	start(initialReplies);
	return { directory, events, until, close, start, snapshot,
		get generation() { return generation; },
		kill: () => stop("SIGKILL"),
		stop: () => stop("SIGTERM"),
		replies: (replies: ModelReply[]) => child.send({ kind: "models", replies }),
		release: (token: string) => child.send({ kind: "model-release", token }),
		rejectReplies: (messageIds: number[]) => child.send({ kind: "reject-replies", messageIds }),
		updates: (updates: JsonRecord[]) => child.send({ kind: "updates", updates }),
		requests: (kind: MainFixtureEvent["kind"], method?: string) => events.filter((event) => event.kind === kind && (method === undefined || event.method === method)),
	};
}
