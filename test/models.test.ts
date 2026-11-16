import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type, type Context } from "@earendil-works/pi-ai";
import { configuredSecretEnv, createModelClient, loadModelsConfig, modelConnectionConfig, type ModelApi } from "../src/models.ts";

const MAIN = { api: "openai-completions", baseUrl: "https://gateway.example/v1", model: "tenant/private/model:2026", apiKeyEnv: "DWELL_MODEL_API_KEY" };

function directory(t: TestContext): string {
	const path = mkdtempSync(join(tmpdir(), "dwell-models-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

function configFile(t: TestContext, config: unknown): string {
	const path = join(directory(t), "models.json");
	writeFileSync(path, JSON.stringify(config));
	return path;
}

function load(t: TestContext, config: unknown) {
	return loadModelsConfig({ DWELL_MODELS_FILE: configFile(t, config) });
}

test("custom model IDs are opaque and use conservative metadata without a catalog membership gate", (t) => {
	const config = load(t, { main: MAIN });
	assert.equal(config.source, "file");
	assert.equal(config.main.providerId, "dwell-main");
	assert.equal(config.main.model, MAIN.model);
	assert.deepEqual(config.main.metadata.input, ["text"]);
	assert.equal(config.main.metadata.reasoning, false);
	assert.equal(config.main.metadata.contextWindow, 32768);
	assert.equal(config.main.metadata.maxTokens, 4096);
	assert.equal(config.main.pricingKnown, false);
	assert.equal(config.vision, undefined);
});

test("known metadata is supplemented only for an exact model, endpoint, and API match", (t) => {
	const main = { ...MAIN, api: "openai-responses", baseUrl: "https://api.openai.com/v1", model: "gpt-6-luna" };
	const official = load(t, { main });
	assert.deepEqual(official.main.metadata.input, ["text", "image"]);
	assert.equal(official.main.pricingKnown, true);
	assert.equal(official.vision, official.main);
	const proxy = load(t, { main: { ...main, baseUrl: "https://gateway.example/v1" } });
	assert.deepEqual(proxy.main.metadata.input, ["text"]);
	assert.equal(proxy.main.pricingKnown, false);
	const otherApi = load(t, { main: { ...main, api: "openai-completions" } });
	assert.equal(otherApi.main.pricingKnown, false);
});

test("vision defaults to an image-capable main connection, can be disabled, or uses an explicit connection", (t) => {
	const main = { ...MAIN, input: ["text", "image"] };
	const reuse = load(t, { main });
	assert.equal(reuse.vision, reuse.main);
	assert.deepEqual(configuredSecretEnv(reuse), [MAIN.apiKeyEnv]);
	assert.equal(load(t, { main, vision: null }).vision, undefined);
	const explicit = load(t, { main: MAIN, vision: { ...MAIN, model: "vision/arbitrary", input: ["image"], apiKeyEnv: "DWELL_VISION_API_KEY" } });
	assert.equal(explicit.vision?.providerId, "dwell-vision");
	assert.equal(explicit.vision?.model, "vision/arbitrary");
	assert.deepEqual(configuredSecretEnv(explicit), [MAIN.apiKeyEnv, "DWELL_VISION_API_KEY"]);
	assert.throws(() => load(t, { main: MAIN, vision: MAIN }), /vision must support image/);
});

test("legacy environment configuration retains provider IDs and the independent ZAI vision connection", (t) => {
	const env = { DWELL_STATE: directory(t) };
	const defaults = loadModelsConfig(env);
	assert.equal(defaults.source, "legacy");
	assert.equal(defaults.main.providerId, "zai-coding-cn");
	assert.equal(defaults.main.model, "glm-5.3");
	assert.equal(defaults.vision?.model, "glm-5.3-flash");
	assert.equal(defaults.vision?.metadata.input.includes("image"), true);
	const deepseek = loadModelsConfig({ ...env, DWELL_PROVIDER: "deepseek", DWELL_MODEL: "custom-deepseek", DWELL_VISION_MODEL: "custom-vision" });
	assert.equal(deepseek.main.providerId, "deepseek");
	assert.equal(deepseek.main.model, "custom-deepseek");
	assert.equal(deepseek.main.apiKeyEnv, "DEEPSEEK_API_KEY");
	assert.equal(deepseek.vision?.providerId, "zai-coding-cn");
	assert.equal(deepseek.vision?.model, "custom-vision");
	assert.throws(() => loadModelsConfig({ ...env, DWELL_PROVIDER: "openai" }), /DWELL_PROVIDER/);
});

test("the default state models.json takes precedence over legacy environment selections", (t) => {
	const state = directory(t);
	writeFileSync(join(state, "models.json"), JSON.stringify({ main: MAIN, vision: null }));
	const selected = loadModelsConfig({ DWELL_STATE: state, DWELL_PROVIDER: "invalid", DWELL_MODEL: "ignored" });
	assert.equal(selected.main.model, MAIN.model);
	assert.equal(selected.path, resolve(state, "models.json"));
});

test("explicit missing, malformed, or unreadable configuration fails without falling back or echoing file contents", (t) => {
	const path = join(directory(t), "missing.json");
	assert.throws(() => loadModelsConfig({ DWELL_MODELS_FILE: path }), /Cannot read/);
	assert.throws(() => loadModelsConfig({ DWELL_MODELS_FILE: "" }), /non-empty path/);
	writeFileSync(path, '{"secret":"literal-not-for-diagnostics",');
	assert.throws(() => loadModelsConfig({ DWELL_MODELS_FILE: path }), (error: unknown) => error instanceof Error && /Invalid JSON/.test(error.message) && !error.message.includes("literal-not-for-diagnostics"));
	const state = directory(t);
	mkdirSync(join(state, "models.json"));
	assert.throws(() => loadModelsConfig({ DWELL_STATE: state }), /Cannot read/);
});

for (const [name, replacement] of [
	["unsupported protocol", { api: "not-an-api" }],
	["provider prototype key as protocol", { api: "toString" }],
	["missing model", { model: undefined }],
	["empty model", { model: "" }],
	["executable key reference", { apiKeyEnv: "!echo secret" }],
	["reserved passthrough key", { apiKeyEnv: "GH_TOKEN" }],
	["execution control as key", { apiKeyEnv: "NODE_OPTIONS" }],
	["loader control as key", { apiKeyEnv: "DYLD_INSERT_LIBRARIES" }],
	["process path as key", { apiKeyEnv: "PATH" }],
	["configuration selector as key", { apiKeyEnv: "DWELL_MODELS_FILE" }],
	["channel credential as key", { apiKeyEnv: "LARK_APP_SECRET" }],
	["Telegram credential as model key", { apiKeyEnv: "TELEGRAM_BOT_TOKEN" }],
	["literal API key", { apiKey: "not-for-diagnostics" }],
	["executable config field", { command: "echo no" }],
	["relative endpoint", { baseUrl: "/v1" }],
	["non HTTP endpoint", { baseUrl: "file:///tmp/model" }],
	["endpoint userinfo", { baseUrl: "https://user:secret@gateway.example/v1" }],
	["endpoint query", { baseUrl: "https://gateway.example/v1?api_key=secret" }],
	["endpoint fragment", { baseUrl: "https://gateway.example/v1#secret" }],
	["invalid input", { input: ["audio"] }],
	["duplicate input", { input: ["text", "text"] }],
	["nonboolean reasoning", { reasoning: "false" }],
	["invalid context window", { contextWindow: 0 }],
	["fractional output limit", { maxTokens: 0.5 }],
	["output exceeds context", { contextWindow: 100, maxTokens: 101 }],
	["nonobject compatibility", { compat: [] }],
	["invalid Anthropic fallback models", { api: "anthropic-messages", compat: { allowedFallbackModels: "wrong-type" } }],
	["invalid Anthropic compatibility flag", { api: "anthropic-messages", compat: { supportsStrictTools: "true" } }],
	["invalid Responses compatibility flag", { api: "openai-responses", compat: { supportsStrictMode: "true" } }],
	["invalid Completions token limit field", { compat: { maxTokensField: "output_tokens" } }],
	["invalid thinking level mapping", { thinkingLevelMap: { high: 42 } }],
	["invalid prompt cache lifetime type", { promptCache: { short: "300" } }],
	["nonpositive prompt cache lifetime", { promptCache: { short: 0 } }],
	["invalid request byte limit", { inputLimits: { maxRequestBytes: "1024" } }],
	["invalid nested image count limit", { inputLimits: { images: { maxPerRequest: "two" } } }],
	["invalid nested image resize quality", { inputLimits: { images: { resize: { jpegQuality: 101 } } } }],
	["invalid prices", { cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	["incomplete prices", { cost: { input: 1 } }],
	["header injection", { headers: { "X-Note": "bad\r\nAuthorization: secret" } }],
	["inline credential header", { headers: { Authorization: "Bearer secret" } }],
] as const) {
	test(`invalid model configuration fails at startup: ${name}`, (t) => {
		assert.throws(() => load(t, { main: { ...MAIN, ...replacement } }));
	});
}

test("invalid fallback metadata fails during startup before any HTTP request and omits configured values", async (t) => {
	let requests = 0;
	const fakeFetch: typeof fetch = async () => {
		requests++;
		throw new Error("Unexpected HTTP request");
	};
	await assert.rejects(async () => {
		const config = load(t, { main: { ...MAIN, api: "anthropic-messages", compat: { allowedFallbackModels: "secret-not-for-diagnostics" } } });
		const { models, model } = createModelClient(config.main, "synthetic-key");
		await models.completeSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: 1 }] }, { fetch: fakeFetch });
	}, (error: unknown) => error instanceof Error && /main\.compat.*schema/.test(error.message) && !error.message.includes("secret-not-for-diagnostics"));
	assert.equal(requests, 0);
});

test("resolved connection serialization preserves capabilities, endpoint, compatibility, and unknown pricing", (t) => {
	const first = load(t, { main: { ...MAIN, reasoning: true, input: ["text", "image"], thinkingLevelMap: { high: "high", max: null }, inputLimits: { images: { maxPerRequest: 2 } }, compat: { maxTokensField: "max_tokens" } } });
	const serialized = modelConnectionConfig(first.main);
	assert.equal(serialized.cost, null);
	assert.equal("providerId" in serialized, false);
	assert.equal("metadata" in serialized, false);
	const roundtrip = load(t, { main: serialized, vision: null });
	assert.deepEqual(roundtrip.main, first.main);
	serialized.input!.pop();
	assert.deepEqual(first.main.metadata.input, ["text", "image"]);
	const known = load(t, { main: { ...MAIN, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
	assert.equal(known.main.pricingKnown, true);
});

test("all flat templates are complete loadable configurations with no literal credentials", (t) => {
	const names = readdirSync(resolve("templates")).filter((name) => name.startsWith("models.") && name.endsWith(".json"));
	assert.equal(names.length, 5);
	for (const name of names) {
		const raw = JSON.parse(readFileSync(resolve("templates", name), "utf8"));
		const config = load(t, raw);
		assert.ok(config.main.model);
		assert.ok(raw.main.input && raw.main.reasoning !== undefined && raw.main.contextWindow && raw.main.maxTokens);
		assert.equal(typeof raw.main.apiKeyEnv, "string");
		assert.equal(raw.main.apiKey, undefined);
		const roundtrip = load(t, { main: modelConnectionConfig(config.main), ...(raw.vision === undefined ? {} : { vision: config.vision ? modelConnectionConfig(config.vision) : null }) });
		assert.deepEqual(roundtrip.main, config.main);
		assert.deepEqual(roundtrip.vision, config.vision);
	}
});

test("valid optional metadata for each protocol survives configuration serialization", (t) => {
	const compatibility = {
		"openai-responses": { supportsStrictMode: true, supportsMaxOutputTokens: false },
		"openai-completions": { maxTokensField: "max_tokens", chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled", omitWhenOff: true } } },
		"anthropic-messages": { allowedFallbackModels: [{ provider: "custom-upstream", model: "custom-fallback", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } }], forceAdaptiveThinking: true },
	};
	for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
		const metadata = { compat: compatibility[api], thinkingLevelMap: { off: null, high: "custom-high" }, promptCache: { short: 300, long: 3600 }, inputLimits: { maxRequestBytes: 1048576, images: { maxPerMessage: 2, maxPerRequest: 5, resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 1048576, jpegQuality: 80 } } } };
		const first = load(t, { main: { ...MAIN, api, ...metadata } });
		const roundtrip = load(t, { main: modelConnectionConfig(first.main), vision: null });
		assert.deepEqual(roundtrip.main, first.main);
		for (const key of ["compat", "thinkingLevelMap", "promptCache", "inputLimits"] as const) assert.deepEqual(roundtrip.main.metadata[key], metadata[key]);
	}
});

function streamFixture(api: ModelApi, name = "lookup", interrupted = false): Response {
	let events: object[];
	if (api === "openai-completions") events = [
		{ id: "chat-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: '{"query":"test"}' } }] }, finish_reason: null }] },
		{ id: "chat-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
	];
	else if (api === "openai-responses") events = [
		{ type: "response.created", response: { id: "resp-1", status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc-1", call_id: "call_1", name, arguments: "", status: "in_progress" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc-1", delta: '{"query":"test"}' },
		{ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc-1", call_id: "call_1", name, arguments: '{"query":"test"}', status: "completed" } },
		{ type: "response.completed", response: { id: "resp-1", status: "completed", output: [{ type: "function_call", id: "fc-1", call_id: "call_1", name, arguments: '{"query":"test"}', status: "completed" }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
	];
	else events = [
		{ type: "message_start", message: { id: "msg-1", type: "message", role: "assistant", content: [], model: "test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name, input: {} } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"test"}' } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 2 } },
		{ type: "message_stop" },
	];
	if (interrupted) events = api === "openai-completions"
		? [...events.slice(0, 1), { error: { type: "server_error", message: "Synthetic stream interruption" } }]
		: [...events.slice(0, 3), api === "anthropic-messages" ? { type: "error", error: { type: "api_error", message: "Synthetic stream interruption" } } : { type: "error", code: "server_error", message: "Synthetic stream interruption" }];
	const body = events.map((event) => `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
	test(`${api}: custom URL/model, captured key, and tool schemas reach the protocol adapter`, async (t) => {
		const env: NodeJS.ProcessEnv = { DWELL_MODEL_API_KEY: "synthetic-captured-key" };
		const config = load(t, { main: { ...MAIN, api, baseUrl: "http://127.0.0.1:12345/proxy", headers: { "X-Dwell-Test": "metadata" } }, vision: null });
		const { models, model } = createModelClient(config.main, env[MAIN.apiKeyEnv]!);
		delete env[MAIN.apiKeyEnv];
		const requests: Request[] = [];
		const bodies: Record<string, unknown>[] = [];
		const fakeFetch: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			bodies.push(JSON.parse(await request.text()));
			return streamFixture(api);
		};
		const context: Context = { systemPrompt: "Use lookup.", messages: [{ role: "user", content: "Find test", timestamp: 1 }], tools: [{ name: "lookup", description: "Look up a string", parameters: Type.Object({ query: Type.String() }) }] };
		const result = await models.completeSimple(model, context, { fetch: fakeFetch, maxTokens: 64, maxRetries: 0, signal: AbortSignal.timeout(5000) });
		assert.equal(result.errorMessage, undefined);
		assert.equal(requests.length, 1);
		const request = requests[0];
		assert.equal(request.url, `http://127.0.0.1:12345/proxy/${api === "openai-completions" ? "chat/completions" : api === "openai-responses" ? "responses" : "v1/messages?beta=true"}`);
		assert.equal(request.headers.get(api === "anthropic-messages" ? "x-api-key" : "authorization"), api === "anthropic-messages" ? "synthetic-captured-key" : "Bearer synthetic-captured-key");
		assert.equal(request.headers.get("X-Dwell-Test"), "metadata");
		assert.equal(bodies[0].model, MAIN.model);
		const tool = (bodies[0].tools as Record<string, unknown>[])[0];
		const definition = api === "openai-completions" ? tool.function as Record<string, unknown> : tool;
		assert.equal(definition.name, "lookup");
		const parameters = definition[api === "anthropic-messages" ? "input_schema" : "parameters"] as Record<string, unknown>;
		assert.equal(parameters.type, "object");
		assert.ok((parameters.properties as Record<string, unknown>).query);
		assert.equal(result.stopReason, "toolUse");
		assert.equal(result.usage.input, 10);
		assert.equal(result.usage.output, 2);
		assert.equal(result.usage.totalTokens, 12);
		const call = result.content.find((part) => part.type === "toolCall");
		assert.equal(call?.name, "lookup");
		assert.deepEqual(call?.arguments, { query: "test" });
	});
}

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
	test(`${api}: dotted tool names survive streaming and replay without leaking wire aliases into runtime identity`, async (t) => {
		const config = load(t, { main: { ...MAIN, api }, vision: null });
		const { models, model } = createModelClient(config.main, "synthetic-key");
		const names = ["dwell.proc.logs", "dwell_proc_logs", "dwtool_ZHdlbGwucHJvYy5sb2dz", "读取.日志"];
		const context: Context = { messages: [{ role: "user", content: "Read logs", timestamp: 1 }], tools: names.map((name) => ({ name, description: "Read task output", parameters: Type.Object({ query: Type.String() }) })) };
		let requests = 0;
		let wireNames: string[] = [];
		const fakeFetch: typeof fetch = async (input, init) => {
			const body = JSON.parse(await new Request(input, init).text());
			const definitions = body.tools as Record<string, unknown>[];
			const currentNames = definitions.map((tool) => String((api === "openai-completions" ? tool.function as Record<string, unknown> : tool).name));
			assert.ok(currentNames.every((name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name)));
			assert.equal(new Set(currentNames).size, names.length);
			if (requests === 0) wireNames = currentNames;
			else {
				assert.deepEqual(currentNames, wireNames);
				const history = JSON.stringify(api === "openai-responses" ? body.input : body.messages);
				assert.ok(history.includes(JSON.stringify(wireNames[0])));
				assert.equal(history.includes(JSON.stringify(names[0])), false);
			}
			return streamFixture(api, wireNames[requests++]);
		};
		const before = structuredClone(context);
		const stream = models.streamSimple(model, context, { fetch: fakeFetch, maxRetries: 0 });
		let streamedCalls = 0;
		for await (const event of stream) {
			const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
			for (const part of message.content) if (part.type === "toolCall") { assert.equal(part.name, names[0]); streamedCalls++; }
			if (event.type === "toolcall_end") assert.equal(event.toolCall.name, names[0]);
		}
		assert.ok(streamedCalls > 0);
		const result = await stream.result();
		assert.equal(result.errorMessage, undefined);
		const call = result.content.find((part) => part.type === "toolCall")!;
		assert.equal(call.name, names[0]);
		assert.deepEqual(context, before);
		context.messages.push(result, { role: "toolResult", toolName: names[0], toolCallId: call.id, content: [{ type: "text", text: "Complete" }], isError: false, timestamp: 2 });
		const replay = await models.complete(model, context, { fetch: fakeFetch, maxRetries: 0 });
		assert.equal(replay.errorMessage, undefined);
		assert.equal(replay.content.find((part) => part.type === "toolCall")?.name, names[1]);
		for (const expected of names.slice(2)) {
			const next = await models.completeSimple(model, context, { fetch: fakeFetch, maxRetries: 0 });
			assert.equal(next.content.find((part) => part.type === "toolCall")?.name, expected);
		}
		assert.equal(requests, names.length);
	});
}

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
	test(`${api}: image input, system instructions and removed tool declarations reach the correct wire format`, async (t) => {
		const config = load(t, { main: { ...MAIN, api, input: ["text", "image"] }, vision: null });
		const { models, model } = createModelClient(config.main, "synthetic-key");
		const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1cAAAAASUVORK5CYII=";
		const tool = (name: string) => ({ name, description: "Read output", parameters: Type.Object({ query: Type.String() }) });
		const context: Context = { messages: [
			{ role: "system", content: "System fixture", toolsAdded: [tool("dwell.retired"), tool("dwell.current")], timestamp: 1 },
			{ role: "user", content: "Continue", timestamp: 2 },
			{ role: "system", content: "Updated instructions", toolsRemoved: [{ name: "dwell.retired" }], timestamp: 3 },
			{ role: "user", content: [{ type: "text", text: "Describe this" }, { type: "image", data: image, mimeType: "image/png" }], timestamp: 4 },
		] };
		const before = structuredClone(context);
		const result = await models.completeSimple(model, context, { maxRetries: 0, fetch: async (input, init) => {
			const body = JSON.parse(await new Request(input, init).text());
			const serialized = JSON.stringify(body);
			assert.ok(serialized.includes("System fixture"));
			assert.ok(serialized.includes("Updated instructions"));
			assert.ok(serialized.includes(image));
			assert.equal(serialized.includes('"dwell.retired"'), false);
			assert.equal(serialized.includes('"dwell.current"'), false);
			const wireName = "dwtool_" + Buffer.from("dwell.current").toString("base64url");
			const names = (body.tools as Record<string, unknown>[]).map((tool) => String((api === "openai-completions" ? tool.function as Record<string, unknown> : tool).name));
			assert.deepEqual(names, [wireName]);
			if (api === "anthropic-messages") assert.ok(serialized.includes('"type":"base64"'));
			else assert.ok(serialized.includes("data:image/png;base64,"));
			return streamFixture(api, wireName);
		} });
		assert.equal(result.errorMessage, undefined);
		assert.equal(result.content.find((part) => part.type === "toolCall")?.name, "dwell.current");
		assert.deepEqual(context, before);
	});

	test(`${api}: forced tool choices use the same encoded name as their declaration`, async (t) => {
		const config = load(t, { main: { ...MAIN, api }, vision: null });
		const { models, model } = createModelClient(config.main, "synthetic-key");
		const choice = api === "openai-completions" ? { type: "function" as const, function: { name: "dwell.proc.logs" } } : { type: api === "anthropic-messages" ? "tool" as const : "function" as const, name: "dwell.proc.logs" };
		const context: Context = { messages: [], tools: [{ name: "dwell.proc.logs", description: "Read logs", parameters: Type.Object({ query: Type.String() }) }] };
		const result = await models.complete(model, context, { toolChoice: choice, maxRetries: 0, fetch: async (input, init) => {
			const body = JSON.parse(await new Request(input, init).text());
			const definition = api === "openai-completions" ? body.tools[0].function : body.tools[0];
			assert.equal(api === "openai-completions" ? body.tool_choice.function.name : body.tool_choice.name, definition.name);
			assert.match(definition.name, /^[a-zA-Z0-9_-]{1,64}$/);
			return streamFixture(api, definition.name);
		} });
		assert.equal(result.errorMessage, undefined);
		assert.equal(result.content.find((part) => part.type === "toolCall")?.name, "dwell.proc.logs");
		assert.equal(api === "openai-completions" ? choice.function?.name : choice.name, "dwell.proc.logs");
	});

	test(`${api}: HTTP failures and caller cancellation terminate without an implicit retry`, async (t) => {
		const config = load(t, { main: { ...MAIN, api }, vision: null });
		const { models, model } = createModelClient(config.main, "synthetic-key");
		const context: Context = { messages: [{ role: "user", content: "Test", timestamp: 1 }] };
		let requests = 0;
		const failed = await models.completeSimple(model, context, { maxRetries: 0, fetch: async () => {
			requests++;
			return Response.json(api === "anthropic-messages" ? { type: "error", error: { type: "invalid_request_error", message: "Synthetic rejection" } } : { error: { type: "invalid_request_error", message: "Synthetic rejection" } }, { status: 400 });
		} });
		assert.equal(failed.stopReason, "error");
		assert.equal(failed.errorMessage, "Model request configuration rejected (HTTP 400)");
		assert.doesNotMatch(failed.errorMessage ?? "", /Synthetic rejection/);
		assert.equal(requests, 1);
		const controller = new AbortController();
		let admitted!: () => void;
		const entered = new Promise<void>((done) => { admitted = done; });
		const cancelled = models.completeSimple(model, context, { maxRetries: 0, signal: controller.signal, fetch: async (_input, init) => {
			requests++;
			assert.ok(init?.signal);
			admitted();
			return await new Promise<Response>((_done, reject) => { init.signal!.addEventListener("abort", () => reject(new DOMException("Synthetic cancellation", "AbortError")), { once: true }); });
		} });
		await entered;
		controller.abort();
		assert.equal((await cancelled).stopReason, "aborted");
		assert.equal(requests, 2);
	});

	test(`${api}: an interrupted tool stream preserves internal names in partial and error records`, async (t) => {
		const config = load(t, { main: { ...MAIN, api }, vision: null });
		const { models, model } = createModelClient(config.main, "synthetic-key");
		const stream = models.streamSimple(model, { messages: [], tools: [{ name: "dwell.proc.logs", description: "Read logs", parameters: Type.Object({ query: Type.String() }) }] }, { maxRetries: 0, fetch: async (input, init) => {
			const body = JSON.parse(await new Request(input, init).text());
			return streamFixture(api, (api === "openai-completions" ? body.tools[0].function : body.tools[0]).name, true);
		} });
		let errors = 0;
		for await (const event of stream) {
			if (event.type === "error") {
				errors++;
				assert.equal(event.error.content.find((part) => part.type === "toolCall")?.name, "dwell.proc.logs");
			}
		}
		const result = await stream.result();
		assert.equal(errors, 1);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /Synthetic stream interruption/);
		assert.equal(result.content.find((part) => part.type === "toolCall")?.name, "dwell.proc.logs");
	});
}

for (const api of ["openai-completions", "openai-responses"] as const) {
	test(`${api}: allowed tool choices keep name encoding consistent`, async (t) => {
		const config = load(t, { main: { ...MAIN, api }, vision: null });
		const { models, model } = createModelClient(config.main, "synthetic-key");
		const set = { mode: "required" as const, tools: [api === "openai-completions" ? { type: "function", function: { name: "dwell.proc.logs" } } : { type: "function", name: "dwell.proc.logs" }] };
		const choice = api === "openai-completions" ? { type: "allowed_tools" as const, allowed_tools: set } : { type: "allowed_tools" as const, ...set };
		const result = await models.complete(model, { messages: [], tools: [{ name: "dwell.proc.logs", description: "Read logs", parameters: Type.Object({ query: Type.String() }) }] }, { toolChoice: choice, maxRetries: 0, fetch: async (input, init) => {
			const body = JSON.parse(await new Request(input, init).text());
			const name = (api === "openai-completions" ? body.tools[0].function : body.tools[0]).name;
			assert.equal(api === "openai-completions" ? body.tool_choice.allowed_tools.tools[0].function.name : body.tool_choice.tools[0].name, name);
			return streamFixture(api, name);
		} });
		assert.equal(result.errorMessage, undefined);
		assert.equal(result.content.find((part) => part.type === "toolCall")?.name, "dwell.proc.logs");
	});
}

test("tool names that exceed the wire limit fail before HTTP rather than being truncated", async (t) => {
	const config = load(t, { main: MAIN });
	const { models, model } = createModelClient(config.main, "synthetic-key");
	let requests = 0;
	const result = await models.completeSimple(model, { messages: [], tools: [{ name: "dwell." + "x".repeat(100), description: "Long name", parameters: Type.Object({}) }] }, { fetch: async () => { requests++; throw new Error("Unexpected HTTP"); } });
	assert.match(result.errorMessage ?? "", /64-character limit/);
	assert.equal(requests, 0);
});

test("noncanonical wire names do not disguise an ordinary runtime tool", async (t) => {
	const config = load(t, { main: MAIN });
	const { models, model } = createModelClient(config.main, "synthetic-key");
	const result = await models.completeSimple(model, { messages: [], tools: [{ name: "bash", description: "Run a command", parameters: Type.Object({}) }] }, { fetch: async () => streamFixture("openai-completions", "dwtool_YmFzaA") });
	assert.equal(result.content.find((part) => part.type === "toolCall")?.name, "dwtool_YmFzaA");
});

test("client creation requires the selected credential and never accepts a missing key silently", (t) => {
	const config = load(t, { main: MAIN });
	assert.throws(() => createModelClient(config.main, ""), /DWELL_MODEL_API_KEY is required/);
});
