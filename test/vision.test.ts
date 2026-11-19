import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelsConfig } from "../src/models.ts";

const previousProvider = process.env.DWELL_PROVIDER;
process.env.DWELL_PROVIDER = "deepseek";
const { makeImageDescriber } = await import("../src/harness.ts");
if (previousProvider === undefined) delete process.env.DWELL_PROVIDER;
else process.env.DWELL_PROVIDER = previousProvider;

const legacyConfig = (model = "glm-5.3-flash") => loadModelsConfig({ DWELL_STATE: join(tmpdir(), `dwell-vision-no-config-${randomUUID()}`), DWELL_PROVIDER: "deepseek", DWELL_VISION_MODEL: model });

function visionResponse(text = "A red test image."): Response {
	const chunks = [
		{ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	];
	return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

test("vision without a ZAI key stays disabled", () => {
	assert.equal(makeImageDescriber(legacyConfig().vision, ""), null);
	assert.equal(makeImageDescriber(legacyConfig("not-a-model").vision, ""), null);
});

test("configured vision requires image capability, independently of catalog membership", () => {
	assert.throws(() => makeImageDescriber(legacyConfig("not-a-model").vision, "test-key"), /not-a-model.*图片输入/);
	assert.throws(() => makeImageDescriber(legacyConfig("glm-5.3").vision, "test-key"), /glm-5.3.*图片输入/);
	assert.equal(typeof makeImageDescriber(legacyConfig("glm-4.6v").vision, "test-key"), "function");
});

test("DeepSeek chat uses independent ZAI vision credentials after environment removal", async (t) => {
	const config = legacyConfig();
	assert.equal(config.main.providerId, "deepseek");
	const previousKey = process.env.ZAI_CODING_CN_API_KEY;
	t.after(() => {
		if (previousKey === undefined) delete process.env.ZAI_CODING_CN_API_KEY;
		else process.env.ZAI_CODING_CN_API_KEY = previousKey;
	});
	process.env.ZAI_CODING_CN_API_KEY = "captured-vision-key";
	const describe = makeImageDescriber(config.vision, process.env.ZAI_CODING_CN_API_KEY);
	assert.ok(describe);
	delete process.env.ZAI_CODING_CN_API_KEY;
	const requests: Request[] = [];
	const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		requests.push(new Request(input, init));
		return visionResponse();
	});
	t.after(() => fetchMock.mock.restore());
	assert.equal(await describe("aW1hZ2U=", "image/png"), "A red test image.");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions");
	assert.equal(requests[0].headers.get("Authorization"), "Bearer captured-vision-key");
	const body = await requests[0].json() as { model: string; max_tokens: number; messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[] };
	assert.equal(body.model, "glm-5.3-flash");
	assert.equal(body.max_tokens, 1024);
	assert.match(body.messages[0].content[0].text ?? "", /Transcribe all visible text verbatim/);
	assert.deepEqual(body.messages[0].content[1], { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } });
});

test("each vision request gets a 60-second abort signal", async (t) => {
	const controllers: AbortController[] = [];
	const timeoutMock = mock.method(AbortSignal, "timeout", (milliseconds: number) => {
		assert.equal(milliseconds, 60_000);
		const controller = new AbortController();
		controllers.push(controller);
		return controller.signal;
	});
	t.after(() => timeoutMock.mock.restore());
	let requests = 0;
	const fetchMock = mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
		requests++;
		assert.ok(init?.signal);
		if (requests === 1) return visionResponse();
		return new Promise<Response>((_resolve, reject) => {
			init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
			controllers[1].abort(new DOMException("Vision request timed out", "TimeoutError"));
		});
	});
	t.after(() => fetchMock.mock.restore());
	const describe = makeImageDescriber(legacyConfig().vision, "test-key");
	assert.ok(describe);
	assert.equal(await describe("aW1hZ2U=", "image/png"), "A red test image.");
	await assert.rejects(describe("aW1hZ2U=", "image/png"), /abort|timed out/i);
	assert.equal(controllers.length, 2);
	assert.equal(requests, 2);
});

test("vision request cancellation aborts the provider and rejects before a completed description", async (t) => {
	const controller = new AbortController();
	let providerSignal: AbortSignal | undefined;
	let started!: () => void;
	const waiting = new Promise<void>((resolve) => { started = resolve; });
	const fetchMock = mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
		providerSignal = init!.signal!;
		started();
		return new Promise<Response>((_resolve, reject) => {
			const abort = () => reject(providerSignal!.reason);
			if (providerSignal!.aborted) abort();
			else providerSignal!.addEventListener("abort", abort, { once: true });
		});
	});
	t.after(() => fetchMock.mock.restore());
	const describe = makeImageDescriber(legacyConfig().vision, "test-key")!;
	const request = describe("aW1hZ2U=", "image/png", controller.signal);
	await waiting;
	controller.abort();
	await assert.rejects(request, /abort/i);
	assert.equal(providerSignal?.aborted, true);
	await assert.rejects(describe("aW1hZ2U=", "image/png", controller.signal), /abort/i);
	assert.equal(fetchMock.mock.callCount(), 1, "Already-cancelled vision must not create a provider request");
});

test("vision provider errors reach the caller for media degradation", async (t) => {
	const fetchMock = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { message: "Vision access denied", type: "authentication_error" } }), { status: 401, headers: { "Content-Type": "application/json" } }));
	t.after(() => fetchMock.mock.restore());
	const describe = makeImageDescriber(legacyConfig().vision, "test-key");
	assert.ok(describe);
	await assert.rejects(describe("aW1hZ2U=", "image/png"), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal(error.message, "Model authentication failed (HTTP 401)");
		assert.doesNotMatch(error.message, /Vision access denied/);
		return true;
	});
});

test("custom vision uses the shared connection and opaque model ID", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-vision-config-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "models.json");
	await writeFile(path, JSON.stringify({ main: { api: "openai-completions", baseUrl: "https://vision.example.test/v1", model: "private-image-alias", apiKeyEnv: "PRIVATE_VISION_KEY", input: ["text", "image"], cost: null } }));
	const config = loadModelsConfig({ DWELL_MODELS_FILE: path });
	let request: Request | undefined;
	const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		request = new Request(input, init);
		return visionResponse("A custom endpoint image.");
	});
	t.after(() => fetchMock.mock.restore());
	const describe = makeImageDescriber(config.vision, "custom-captured-key");
	assert.ok(describe);
	assert.equal(await describe("aW1hZ2U=", "image/png"), "A custom endpoint image.");
	assert.ok(request);
	assert.equal(request.url, "https://vision.example.test/v1/chat/completions");
	assert.equal(request.headers.get("Authorization"), "Bearer custom-captured-key");
	assert.equal((await request.json()).model, "private-image-alias");
});

test("one-shot vision on OpenCode receives a distinct session and the configured client identity", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-vision-session-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "models.json");
	await writeFile(path, JSON.stringify({ main: { api: "openai-completions", baseUrl: "https://opencode.ai/inference/go/openai/v1", model: "private-vision-alias", apiKeyEnv: "PRIVATE_VISION_KEY", input: ["text", "image"], headers: { "User-Agent": "dwell/synthetic-vision" }, cost: null } }));
	const config = loadModelsConfig({ DWELL_MODELS_FILE: path });
	const requests: Request[] = [];
	const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		requests.push(new Request(input, init));
		return visionResponse();
	});
	t.after(() => fetchMock.mock.restore());
	const describe = makeImageDescriber(config.vision, "synthetic-vision-key")!;
	assert.equal(await describe("aW1hZ2U=", "image/png"), "A red test image.");
	assert.equal(await describe("aW1hZ2U=", "image/png"), "A red test image.");
	const sessions = requests.map((request) => request.headers.get("x-opencode-session"));
	for (const session of sessions) assert.match(session!, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
	assert.notEqual(sessions[0], sessions[1]);
	assert.ok(requests.every((request) => request.headers.get("User-Agent") === "dwell/synthetic-vision"));
	assert.ok(requests.every((request) => request.url === "https://opencode.ai/inference/go/openai/v1/chat/completions"));
});

test("read-vision：read 的图片输出转视觉描述，其余工具与失败路径不动", async () => {
	const { makeReadVisionExtension } = await import("../src/harness.ts");
	const handlers = () => {
		const ext = makeReadVisionExtension(() => async () => "a blue test chart");
		const afterTool = (ext.hooks?.[0]?.handlers as { afterTool?: (call: { name: string }, result: { output?: { type: string; data?: string; mimeType?: string; text?: string }[]; isError?: boolean }, api: unknown, context: { abortSignal?: AbortSignal }) => Promise<unknown> }).afterTool;
		if (afterTool === undefined) throw new Error("afterTool 未注册");
		return afterTool;
	};
	const afterTool = handlers();
	const imageResult = { output: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] };
	const replaced = await afterTool({ name: "read" }, imageResult as never, {} as never, {}) as { output: { type: string; text: string }[] };
	assert.equal(replaced.output[0]!.type, "text");
	assert.match(replaced.output[0]!.text, /^Read image file \[image\/png\]\. Vision description:\na blue test chart$/);
	// 非 read 工具与非图片输出原样放行（undefined）
	assert.equal(await afterTool({ name: "write" }, imageResult as never, {} as never, {}), undefined);
	assert.equal(await afterTool({ name: "read" }, { output: [{ type: "text", text: "hi" }] } as never, {} as never, {}), undefined);
	// describer 缺位与视觉失败都回退占位符路径
	const absent = makeReadVisionExtension(() => null).hooks?.[0]?.handlers as { afterTool?: (call: { name: string }, result: unknown, api: unknown, context: { abortSignal?: AbortSignal }) => Promise<unknown> };
	assert.equal(await absent.afterTool!({ name: "read" }, imageResult as never, {} as never, {}), undefined);
	const failing = makeReadVisionExtension(() => async () => { throw new Error("429"); }).hooks?.[0]?.handlers as { afterTool?: (call: { name: string }, result: unknown, api: unknown, context: { abortSignal?: AbortSignal }) => Promise<unknown> };
	assert.equal(await failing.afterTool!({ name: "read" }, imageResult as never, {} as never, {}), undefined);
});
