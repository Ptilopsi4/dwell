import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { modelFailure, terminalModelError } from "../src/model-failure.ts";
import { createModelClient, loadModelsConfig, type ModelApi } from "../src/models.ts";

test("model failures classify access, account and transient errors without exposing response text", () => {
	const cases = [
		['provider API error (403): {"code":"unsupported_country_region_territory"}', "region", false],
		['provider API error (401): {"message":"rate limit and retry this request"}', "authentication", false],
		['HTTP 403 permission denied, retry after 500 seconds', "permission", false],
		['API error (429): {"code":"insufficient_quota"}', "quota", false],
		['HTTP status 404 model_not_found', "configuration", false],
		['invalid_api_key: synthetic rejection without HTTP status', "authentication", false],
		['permission_denied: synthetic rejection without HTTP status', "permission", false],
		['model_not_found: synthetic rejection without HTTP status', "configuration", false],
		['API error (422): invalid input', "configuration", false],
		['API error (429): rate_limit_exceeded', "rate_limit", true],
		['HTTP 503 overloaded', "unavailable", true],
		['fetch failed ECONNRESET', "network", true],
		['Unrecognized failure', "unknown", false],
	] as const;
	for (const [text, kind, retryable] of cases) {
		const result = modelFailure(text + " synthetic-private-key-marker");
		assert.equal(result.kind, kind);
		assert.equal(result.retryable, retryable);
		assert.doesNotMatch(JSON.stringify(result), /synthetic-private-key-marker|retry after 500/);
		if (!retryable && kind !== "unknown") {
			const normalized = terminalModelError(fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: text }))!;
			assert.equal(modelFailure(normalized).kind, kind);
			assert.equal(isRetryableAssistantError(fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: normalized })), false);
		}
	}
});

test("Responses streamed failures without HTTP status retain their fatal category after normalization", async (t) => {
	for (const [code, kind] of [["invalid_api_key", "authentication"], ["permission_denied", "permission"], ["model_not_found", "configuration"]] as const) await t.test(code, async () => {
		const directory = await mkdtemp(join(tmpdir(), "dwell-streamed-failure-"));
		try {
			const selected = join(directory, "models.json");
			await writeFile(selected, JSON.stringify({ main: { api: "openai-responses", baseUrl: "https://synthetic.invalid/v1", model: "opaque-model", apiKeyEnv: "SYNTHETIC_MODEL_KEY" }, vision: null }));
			const { models, model } = createModelClient(loadModelsConfig({ DWELL_MODELS_FILE: selected }).main, "synthetic-private-key-marker");
			let requests = 0;
			const result = await models.completeSimple(model, { messages: [{ role: "user", content: "Synthetic streamed rejection", timestamp: 1 }] }, { maxRetries: 0, fetch: async () => {
				requests++;
				const event = { type: "response.failed", response: { id: "synthetic-failure", status: "failed", error: { code, message: "synthetic-private-key-marker; retry after 500 seconds" } } };
				return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
			} });
			assert.equal(requests, 1);
			assert.equal(result.stopReason, "error");
			assert.equal(modelFailure(result.errorMessage!).kind, kind);
			assert.equal(modelFailure(result.errorMessage!).status, undefined);
			assert.equal(isRetryableAssistantError(result), false);
			assert.doesNotMatch(result.errorMessage!, /synthetic-private-key-marker|retry after 500/);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
});

test("context compaction and transient diagnostics remain available to the SDK", () => {
	for (const text of ["API error (400): maximum context length exceeded", "API error (429): rate_limit_exceeded", "HTTP 503 overloaded", "fetch failed ECONNRESET"]) assert.equal(terminalModelError(fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: text })), undefined);
	assert.equal(modelFailure("request id contains 403500429 but no status").kind, "unknown");
});

test("normalization preserves the SDK's full context-overflow recovery contract", () => {
	for (const text of [
		"API error (400): Your input exceeds the context window of this model",
		"API error (400): input token count (90000) exceeds the maximum number of tokens allowed (80000)",
		"API error (400): Your request exceeded model token limit",
		"API error (400): Range of input length should be [1, 80000]",
	]) {
		const message = fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: text });
		assert.equal(isContextOverflow(message), true, text);
		assert.equal(terminalModelError(message), undefined, text);
	}
});

test("all three protocols fail deterministic access errors once despite retry-like provider prose", { timeout: 15_000 }, async (t) => {
	for (const api of ["openai-responses", "openai-completions", "anthropic-messages"] as ModelApi[]) await t.test(api, async () => {
		const directory = await mkdtemp(join(tmpdir(), "dwell-model-failure-"));
		const selected = join(directory, "models.json");
		await writeFile(selected, JSON.stringify({ main: { api, baseUrl: "https://synthetic.invalid/v1", model: "opaque-model", apiKeyEnv: "SYNTHETIC_MODEL_KEY" }, vision: null }));
		const connection = loadModelsConfig({ DWELL_MODELS_FILE: selected }).main;
		const { models, model } = createModelClient(connection, "synthetic-private-key-marker");
		const original = globalThis.fetch;
		let requests = 0;
		globalThis.fetch = async () => { requests++; return Response.json({ error: { type: "permission_error", code: "unsupported_country_region_territory", message: "synthetic-private-key-marker: retry after 500 seconds; temporarily unavailable" } }, { status: 403 }); };
		const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 }, stream: { maxRetries: 0, deferred: false } } }, context);
		try {
			const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id } } }, context);
			const result = await (await conversation.submit({ type: "input", content: "Synthetic access failure" }, context)).wait(context);
			assert.equal(result.status, "unanswered");
			assert.equal(requests, 1);
			if (result.status === "unanswered") {
				assert.equal(result.reason, "model_error");
				assert.doesNotMatch(String(result.detail), /synthetic-private-key-marker|retry after 500/);
				assert.equal(modelFailure(String(result.detail)).kind, "region");
			}
		} finally { globalThis.fetch = original; await harness.close(context); await rm(directory, { recursive: true, force: true }); }
	});
});
