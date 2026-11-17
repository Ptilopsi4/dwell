import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { createModelClient, loadModelsConfig, type ModelApi } from "../src/models.ts";

const toolName = "dwell.test";
const arguments_ = { query: "runtime fixture", limit: 2 };
const toolOutput = "Recorded runtime fixture (2).";
const answer = "The runtime fixture was recorded.";
type JsonRecord = Record<string, unknown>;

function sse(events: JsonRecord[]): Response {
	const body = events.map((event) => `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function toolResponse(api: ModelApi, name: string): Response {
	const args = JSON.stringify(arguments_);
	if (api === "openai-completions") return sse([
		{ id: "chat-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: args } }] }, finish_reason: null }] },
		{ id: "chat-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
	]);
	if (api === "openai-responses") {
		const item = { type: "function_call", id: "fc-1", call_id: "call_1", name, arguments: args, status: "completed" };
		return sse([
			{ type: "response.created", response: { id: "resp-tool", status: "in_progress", output: [] } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
			{ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: args },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: "resp-tool", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
		]);
	}
	return sse([
		{ type: "message_start", message: { id: "msg-tool", type: "message", role: "assistant", content: [], model: "opaque-runtime-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name, input: {} } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 2 } },
		{ type: "message_stop" },
	]);
}

function textResponse(api: ModelApi): Response {
	if (api === "openai-completions") return sse([
		{ id: "chat-text", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] },
		{ id: "chat-text", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
	]);
	if (api === "openai-responses") {
		const part = { type: "output_text", text: answer, annotations: [] };
		const item = { type: "message", id: "msg-text", role: "assistant", content: [part], status: "completed" };
		return sse([
			{ type: "response.created", response: { id: "resp-text", status: "in_progress", output: [] } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
			{ type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { ...part, text: "" } },
			{ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: answer },
			{ type: "response.output_text.done", output_index: 0, item_id: item.id, content_index: 0, text: answer },
			{ type: "response.content_part.done", output_index: 0, item_id: item.id, content_index: 0, part },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: "resp-text", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
		]);
	}
	return sse([
		{ type: "message_start", message: { id: "msg-text", type: "message", role: "assistant", content: [], model: "opaque-runtime-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	]);
}

function definition(api: ModelApi, body: JsonRecord): JsonRecord {
	const tools = api === "openai-responses"
		? (body.input as JsonRecord[]).find((item) => item.type === "additional_tools")!.tools as JsonRecord[]
		: body.tools as JsonRecord[];
	assert.equal(tools.length, 1);
	return api === "openai-completions" ? tools[0].function as JsonRecord : tools[0];
}

function checkToolResult(api: ModelApi, body: JsonRecord, wireName: string): void {
	if (api === "openai-responses") {
		const input = body.input as JsonRecord[];
		const call = input.find((item) => item.type === "function_call")!;
		assert.equal(call.name, wireName);
		assert.deepEqual(JSON.parse(call.arguments as string), arguments_);
		const result = input.find((item) => item.type === "function_call_output")!;
		assert.equal(result.call_id, call.call_id);
		assert.equal(result.output, toolOutput);
		return;
	}
	const messages = body.messages as JsonRecord[];
	if (api === "openai-completions") {
		const assistant = messages.find((message) => message.role === "assistant")!;
		const [call] = assistant.tool_calls as { id: string; function: { name: string; arguments: string } }[];
		assert.equal(call.function.name, wireName);
		assert.deepEqual(JSON.parse(call.function.arguments), arguments_);
		const result = messages.find((message) => message.role === "tool")!;
		assert.equal(result.tool_call_id, call.id);
		assert.equal(result.content, toolOutput);
		return;
	}
	const assistant = messages.find((message) => message.role === "assistant")!;
	const call = (assistant.content as JsonRecord[]).find((block) => block.type === "tool_use")!;
	assert.equal(call.name, wireName);
	assert.deepEqual(call.input, arguments_);
	const result = messages.filter((message) => message.role === "user").flatMap((message) => Array.isArray(message.content) ? message.content as JsonRecord[] : []).find((block) => block.type === "tool_result")!;
	assert.equal(result.tool_use_id, call.id);
	assert.notEqual(result.is_error, true);
	assert.equal(result.content, toolOutput);
}

for (const api of ["openai-responses", "openai-completions", "anthropic-messages"] as const) {
	test(`${api}: Harness executes dotted tools and persists the full model round trip`, { timeout: 10_000 }, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "dwell-protocol-runtime-"));
		const configPath = join(directory, "models.json");
		const databasePath = join(directory, "dwell.sqlite");
		const markerPath = join(directory, "executed.json");
		let harness: Harness | undefined;
		try {
			await writeFile(configPath, JSON.stringify({ main: { api, baseUrl: "https://runtime.invalid/proxy", model: "opaque-runtime-model", apiKeyEnv: "DWELL_MODEL_API_KEY", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, ...(api === "openai-responses" ? { compat: { supportsAdditionalTools: true, supportsMidConvoSystemMessages: true } } : {}) }, vision: null }));
			const env: NodeJS.ProcessEnv = { DWELL_MODELS_FILE: configPath, DWELL_MODEL_API_KEY: "synthetic-runtime-key" };
			const config = loadModelsConfig(env);
			const requests: { request: Request; body: JsonRecord }[] = [];
			let wireName = "";
			const fakeFetch: typeof fetch = async (input, init) => {
				const request = new Request(input, init);
				const body = await request.json() as JsonRecord;
				requests.push({ request, body });
				assert.ok(requests.length <= 2, "The run must finish after one tool round");
				if (requests.length === 1) {
					wireName = definition(api, body).name as string;
					return toolResponse(api, wireName);
				}
				return textResponse(api);
			};
			const fetchMock = t.mock.method(globalThis, "fetch", fakeFetch);
			t.after(() => fetchMock.mock.restore());
			const { models } = createModelClient(config.main, env.DWELL_MODEL_API_KEY!);
			delete env.DWELL_MODEL_API_KEY;
			const executions: typeof arguments_[] = [];
			const registry = createRegistry();
			registry.install(defineExtension({ name: "test-protocol-runtime", tools: [defineTool({
				name: toolName, description: "Record a local fixture", parameters: Type.Object({ query: Type.String(), limit: Type.Integer() }),
				async execute(args, api) {
					assert.ok(api.env instanceof NodeExecutionEnv);
					executions.push(args);
					await writeFile(markerPath, JSON.stringify(args));
					return { output: [{ type: "text", text: toolOutput }] };
				},
			})] }));
			const reports: string[] = [];
			const open = () => openNodeSqliteStorage(databasePath).then((storage) => Harness.open(storage, {
				models, registry, env: async () => new NodeExecutionEnv({ cwd: directory }),
				settings: { stream: { maxRetries: 0, deferred: false, timeoutMs: 3000 }, retry: { enabled: false }, compaction: { enabled: false } },
				onReport: (error) => reports.push(String(error)),
			}, context));
			harness = await open();
			const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: config.main.providerId, modelId: config.main.model }, cwd: directory } }, context);
			const receipt = await (await conversation.submit({ type: "input", content: "Record the runtime fixture with the test tool, then confirm." }, context)).wait(context);
			assert.equal(receipt.status, "done", JSON.stringify({ receipt, reports }));
			await conversation.waitForIdle(context);
			assert.equal(requests.length, 2);
			assert.match(wireName, /^[a-zA-Z0-9_-]{1,64}$/);
			assert.notEqual(wireName, toolName);
			for (const { request, body } of requests) {
				assert.equal(request.url, `https://runtime.invalid/proxy/${api === "openai-responses" ? "responses" : api === "openai-completions" ? "chat/completions" : "v1/messages?beta=true"}`);
				assert.equal(request.headers.get(api === "anthropic-messages" ? "x-api-key" : "authorization"), api === "anthropic-messages" ? "synthetic-runtime-key" : "Bearer synthetic-runtime-key");
				assert.equal(body.model, config.main.model);
				assert.equal(body.stream, true);
				const tool = definition(api, body);
				assert.equal(tool.name, wireName);
				const schema = tool[api === "anthropic-messages" ? "input_schema" : "parameters"] as JsonRecord;
				assert.equal(schema.type, "object");
				assert.deepEqual(schema.required, ["query", "limit"]);
				const properties = schema.properties as Record<string, JsonRecord>;
				assert.equal(properties.query.type, "string");
				assert.equal(properties.limit.type, "integer");
			}
			checkToolResult(api, requests[1].body, wireName);
			assert.deepEqual(executions, [arguments_]);
			assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), arguments_);
			const before = await conversation.context(context);
			const assistants = before.messages.filter((message) => message.role === "assistant");
			assert.equal(assistants.length, 2);
			assert.equal(assistants[0].stopReason, "toolUse");
			const call = assistants[0].content.find((part) => part.type === "toolCall")!;
			assert.equal(call.name, toolName);
			assert.deepEqual(call.arguments, arguments_);
			const result = before.messages.find((message) => message.role === "toolResult")!;
			assert.equal(result.toolName, toolName);
			assert.equal(result.toolCallId, call.id);
			assert.equal(result.isError, false);
			assert.deepEqual(result.content, [{ type: "text", text: toolOutput }]);
			assert.deepEqual(assistants.map((message) => message.errorMessage), [undefined, undefined]);
			assert.equal(assistants[1].stopReason, "stop");
			assert.deepEqual(assistants[1].content.map((part) => part.type === "text" ? { type: part.type, text: part.text } : part), [{ type: "text", text: answer }]);
			assert.equal(JSON.stringify(before.entries).includes(wireName), false);
			assert.deepEqual(assistants.map((message) => [message.usage.input, message.usage.output, message.usage.totalTokens]), [[10, 2, 12], [20, 5, 25]]);
			const usage = await harness.usage(context);
			const total = usage.models[`${config.main.providerId}/${config.main.model}`];
			assert.equal(total.input, 30);
			assert.equal(total.output, 7);
			assert.equal(total.totalTokens, 37);
			assert.ok(total.cost.total > 0);
			await harness.close(context);
			harness = await open();
			const restored = await harness.conversation(conversation.id, context);
			assert.ok(restored);
			assert.deepEqual(await restored.context(context), before);
			assert.deepEqual(await harness.usage(context), usage);
			assert.equal(executions.length, 1);
			assert.equal(requests.length, 2);
			assert.deepEqual(reports, []);
		} finally {
			await harness?.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	});
}
