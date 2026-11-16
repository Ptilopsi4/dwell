// Preload only in isolated acceptance tests. Model and Telegram fetches remain synthetic.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import { TelegramInbox } from "../src/telegram-entry.ts";

export type JsonRecord = Record<string, unknown>;
export type ModelReply = ({ text: string } | { tool: string; arguments: JsonRecord } | { error: string; status: number }) & { wait?: string; match?: string };
export interface MainFixtureEvent {
	kind: "telegram" | "model" | "unexpected" | "checkpoint";
	method?: string;
	body: JsonRecord;
	messageId?: number;
	generation?: number;
}

const modelReplies: ModelReply[] = JSON.parse(process.env.DWELL_TEST_REPLIES ?? "[]");
const updateBatches: unknown[][] = [];
const rejectedReplies = new Set<number>();
const deletedReplies = new Set<number>();
const released = new Set<string>();
const waitingModels = new Map<string, () => void>();
let waitingUpdates: ((updates: unknown[]) => void) | undefined;
const counterFile = process.env.DWELL_TEST_TRANSPORT_STATE;
const counters: { messageId: number; responseId: number } = counterFile !== undefined && existsSync(counterFile)
	? JSON.parse(readFileSync(counterFile, "utf8")) : { messageId: 1000, responseId: 0 };

function nextId(key: keyof typeof counters): number {
	const id = ++counters[key];
	// The fake remote service outlives a killed bot process, including its allocated IDs.
	if (counterFile !== undefined) writeFileSync(counterFile, JSON.stringify(counters));
	return id;
}

function report(event: MainFixtureEvent): void {
	if (process.connected) process.send?.(event);
}

if (process.env.DWELL_TEST_PANEL === "1") {
	const listen = Server.prototype.listen;
	Server.prototype.listen = function (...args: unknown[]) {
		if (args[0] !== Number(process.env.DWELL_PANEL_PORT) || args[1] !== "127.0.0.1") throw new Error("The panel fixture must bind only its loopback test server");
		// Ask the kernel for an exclusive port without a reserve-close-bind race.
		args[0] = 0;
		this.once("listening", () => {
			const address = this.address();
			if (address === null || typeof address === "string") throw new Error("The panel fixture needs a TCP address");
			report({ kind: "checkpoint", method: "panel.listening", body: { port: address.port, host: address.address } });
		});
		return Reflect.apply(listen, this, args);
	};
}

const output = TelegramInbox.prototype.output;
TelegramInbox.prototype.output = async function (id, state, messageId) {
	await output.call(this, id, state, messageId);
	report({ kind: "checkpoint", method: "telegram.output", body: { id, state, messageId } });
};
const admitted = TelegramInbox.prototype.admitted;
TelegramInbox.prototype.admitted = async function (id, submissionId) {
	await admitted.call(this, id, submissionId);
	report({ kind: "checkpoint", method: "telegram.admitted", body: { id, submissionId } });
};
const prepared = TelegramInbox.prototype.prepared;
TelegramInbox.prototype.prepared = async function (id, content) {
	await prepared.call(this, id, content);
	report({ kind: "checkpoint", method: "telegram.prepared", body: { id } });
};

process.on("message", (message: { kind?: string; replies?: ModelReply[]; updates?: unknown[]; messageIds?: number[]; token?: string }) => {
	if (message.kind === "models") modelReplies.push(...message.replies!);
	if (message.kind === "model-release") {
		released.add(message.token!);
		waitingModels.get(message.token!)?.();
		waitingModels.delete(message.token!);
	}
	if (message.kind === "reject-replies") for (const id of message.messageIds!) rejectedReplies.add(id);
	if (message.kind === "delete-replies") for (const id of message.messageIds!) deletedReplies.add(id);
	if (message.kind === "updates") {
		if (waitingUpdates !== undefined) {
			const resolve = waitingUpdates;
			waitingUpdates = undefined;
			resolve(message.updates!);
		} else updateBatches.push(message.updates!);
	}
});

function ok(result: unknown): Response { return Response.json({ ok: true, result }); }

function updates(signal: AbortSignal): Promise<Response> {
	const batch = updateBatches.shift();
	if (batch !== undefined) return Promise.resolve(ok(batch));
	return new Promise((resolve, reject) => {
		const abort = () => { waitingUpdates = undefined; reject(new Error("Fixture poll aborted")); };
		waitingUpdates = (batch) => { signal.removeEventListener("abort", abort); resolve(ok(batch)); };
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

function modelResponse(reply: ModelReply): Response {
	if ("error" in reply) return new Response(reply.error, { status: reply.status, headers: { "content-type": "application/json" } });
	const id = `fixture-${nextId("responseId")}`;
	const item = "text" in reply
		? { type: "message", id: `msg-${id}`, role: "assistant", content: [{ type: "output_text", text: reply.text, annotations: [] }], status: "completed" }
		: { type: "function_call", id: `fc-${id}`, call_id: `call-${id}`, name: reply.tool, arguments: JSON.stringify(reply.arguments), status: "completed" };
	const events: JsonRecord[] = [
		{ type: "response.created", response: { id, status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, ...("text" in reply ? { content: [] } : { arguments: "" }), status: "in_progress" } },
	];
	if ("text" in reply) {
		const part = { type: "output_text", text: reply.text, annotations: [] };
		events.push(
			{ type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { ...part, text: "" } },
			{ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: reply.text },
			{ type: "response.output_text.done", output_index: 0, item_id: item.id, content_index: 0, text: reply.text },
			{ type: "response.content_part.done", output_index: 0, item_id: item.id, content_index: 0, part },
		);
	} else events.push({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: JSON.stringify(reply.arguments) });
	events.push(
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
	);
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

globalThis.fetch = async (input, init) => {
	const request = new Request(input, init);
	// Retain the source signal while pending, as native fetch does across garbage collection.
	const signal = init?.signal ?? request.signal;
	const url = new URL(request.url);
	if (url.origin === "https://api.telegram.org" && url.pathname.startsWith("/file/bot100:SYNTHETIC_TEST_TOKEN/files/")) {
		report({ kind: "checkpoint", method: "media.downloaded", body: { file: url.pathname.split("/").at(-1) } });
		return new Response("Synthetic attachment content.");
	}
	const body = await request.json() as JsonRecord;
	if (url.href === "https://models.invalid/v1/responses") {
		report({ kind: "model", body });
		const index = modelReplies.findIndex((reply) => reply.match === undefined || JSON.stringify(body.input).includes(reply.match));
		const reply = index < 0 ? undefined : modelReplies.splice(index, 1)[0];
		if (reply === undefined) throw new Error("Unexpected additional model request");
		if (reply.wait !== undefined && !released.has(reply.wait)) {
			const token = reply.wait;
			await new Promise<void>((resolve) => {
				waitingModels.set(token, resolve);
				report({ kind: "checkpoint", method: "model.waiting", body: { token } });
			});
		}
		return modelResponse(reply);
	}
	if (url.origin === "https://api.telegram.org" && /^\/bot100:SYNTHETIC_TEST_TOKEN\/[a-zA-Z]+$/.test(url.pathname)) {
		const method = url.pathname.split("/").at(-1)!;
		if (["getMe", "getWebhookInfo", "getUpdates", "getFile", "sendMessage", "editMessageText", "answerCallbackQuery"].includes(method)) {
			const reply = body.reply_parameters as { message_id?: number; allow_sending_without_reply?: boolean } | undefined;
			const replyTo = reply?.message_id;
			if (method === "sendMessage" && replyTo !== undefined && (rejectedReplies.has(replyTo) || deletedReplies.has(replyTo) && !reply?.allow_sending_without_reply)) {
				report({ kind: "telegram", method, body });
				return Response.json({ ok: false, error_code: 400, description: "Bad Request: message to be replied not found" }, { status: 400 });
			}
			const sent = method === "sendMessage" ? nextId("messageId") : undefined;
			report({ kind: "telegram", method, body, ...(sent === undefined ? {} : { messageId: sent }) });
			switch (method) {
				case "getMe": return ok({ id: 100, is_bot: true, username: "AcceptanceBot", first_name: "Acceptance" });
				case "getWebhookInfo": return ok({ url: "" });
				case "getUpdates": return updates(signal);
				case "getFile": {
					const token = `file:${body.file_id}`;
					if (String(body.file_id).startsWith("hold-") && !released.has(token)) {
						await new Promise<void>((resolve, reject) => {
							const abort = () => { waitingModels.delete(token); reject(new Error("Fixture download aborted")); };
							waitingModels.set(token, () => { signal.removeEventListener("abort", abort); resolve(); });
							if (signal.aborted) abort();
							else signal.addEventListener("abort", abort, { once: true });
							report({ kind: "checkpoint", method: "media.waiting", body: { token } });
						});
					}
					return ok({ file_path: `files/${body.file_id}`, file_size: 29 });
				}
				case "sendMessage": return ok({ message_id: sent });
				default: return ok(true);
			}
		}
	}
	// Neither raw Telegram URLs nor headers enter diagnostics; both can contain credentials.
	report({ kind: "unexpected", body: { host: url.hostname } });
	throw new Error(`Unhandled fixture request to ${url.hostname}`);
};
