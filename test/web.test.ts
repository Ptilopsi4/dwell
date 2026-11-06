// node --test "test/web.test.ts"
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { McpClient, parseSseFrame, unwrapToolText } from "../src/ext/web.ts";

function sse(payload: object): Response {
	const body = `id:1\nevent:message\ndata:${JSON.stringify(payload)}\n\n`;
	return new Response(body, { status: 200 });
}

test("parseSseFrame 取带 result 的 data 帧", () => {
	const frame = parseSseFrame(': keep-alive\n\ndata:{"jsonrpc":"2.0","id":3,"result":{"content":[]}}\n');
	assert.equal(frame.result?.content?.length, 0);
});

test("parseSseFrame 取 error 帧", () => {
	const frame = parseSseFrame('data:{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"boom"}}');
	assert.equal(frame.error?.code, -32000);
});

test("parseSseFrame 无 JSON-RPC 帧则抛错", () => {
	assert.throws(() => parseSseFrame("data: not json\ndata:{\"x\":1}\n"), /no JSON-RPC frame/);
});

test("unwrapToolText 解包双层 JSON（智谱实测格式）", () => {
	const data = [{ title: "t", link: "l", content: "c" }];
	// 实测：text 值是 JSON 字符串编码（内容以 \" 开头），parse 一次后仍是字符串
	const text = JSON.stringify(JSON.stringify(data));
	const out = unwrapToolText([{ type: "text", text }]);
	assert.deepEqual(out, data);
});

test("unwrapToolText 单层 JSON 也能解", () => {
	const out = unwrapToolText([{ type: "text", text: '[{"a":1}]' }]);
	assert.deepEqual(out, [{ a: 1 }]);
});

test("unwrapToolText 纯文本原样返回", () => {
	assert.equal(unwrapToolText([{ type: "text", text: "hello" }]), "hello");
	assert.equal(unwrapToolText([{ type: "text", text: 'not "json at all' }]), 'not "json at all');
});

test("unwrapToolText 缺内容抛错", () => {
	assert.throws(() => unwrapToolText(undefined), /no text content/);
});

test("McpClient 失败后重建会话并重试成功", async () => {
	const calls: string[] = [];
	let firstCall = true; // 首次 tools/call 模拟服务端会话失效（JSON-RPC error），之后放行
	const fetchMock = mock.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
		const message = JSON.parse(String(init?.body)) as { method?: string; id?: number };
		calls.push(message.method ?? "?");
		if (message.method === "initialize") {
			return new Response('data:{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200, headers: { "mcp-session-id": "sid-1" } });
		}
		if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
		if (firstCall) {
			firstCall = false;
			return sse({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "session invalid" } });
		}
		return sse({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(JSON.stringify({ title: "ok" })) }] } });
	});
	const original = globalThis.fetch;
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	try {
		const client = new McpClient("https://mcp.test/mcp", "k");
		const out = (await client.call("webReader", { url: "https://x" })) as { title: string };
		assert.equal(out.title, "ok");
		// 序列：握手 → 通知 → 失败调用 → 重新握手 → 通知 → 成功调用
		assert.deepEqual(calls, [
			"initialize",
			"notifications/initialized",
			"tools/call",
			"initialize",
			"notifications/initialized",
			"tools/call",
		]);
	} finally {
		globalThis.fetch = original;
	}
});

test("McpClient 握手成功后复用会话（单飞）", async () => {
	const initializes: number[] = [];
	const fetchMock = mock.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
		const message = JSON.parse(String(init?.body)) as { method?: string; id?: number };
		if (message.method === "initialize") {
			initializes.push(message.id ?? 0);
			return new Response('data:{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200, headers: { "mcp-session-id": "sid-2" } });
		}
		if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
		return sse({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: '"x"' }] } });
	});
	const original = globalThis.fetch;
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	try {
		const client = new McpClient("https://mcp.test/mcp", "k");
		await Promise.all([client.call("web_search_prime", { search_query: "a" }), client.call("web_search_prime", { search_query: "b" })]);
		assert.equal(initializes.length, 1); // 并发首调共享一次握手
	} finally {
		globalThis.fetch = original;
	}
});
