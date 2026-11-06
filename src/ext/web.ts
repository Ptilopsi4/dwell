// Web 能力：智谱 GLM Coding Plan Remote MCP 封装为 dwell.web.search / dwell.web.fetch（只读，replay safe）。
// 协议：streamable HTTP JSON-RPC——initialize 握手（响应头取 Mcp-Session-Id）→ notifications/initialized（202 无 body）→ tools/call。
// 响应为 SSE 帧，result.content[0].text 还包着一层 JSON 字符串，需再 parse 一次。key 由调用方装配时注入（不依赖 process.env 存续）。
import { defineExtension, defineTool, section, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";

const SEARCH_ENDPOINT = "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";
const READER_ENDPOINT = "https://open.bigmodel.cn/api/mcp/web_reader/mcp";
const CALL_TIMEOUT_MS = 60_000;

/** 请求失败（网络/HTTP/协议错误/JSON-RPC error）。 */
class McpError extends Error {
	readonly code?: number;
	constructor(message: string, code?: number) {
		super(message);
		this.code = code;
	}
}

/** JSON-RPC 响应帧（SSE data 行）的形状。 */
type McpFrame = { result?: { content?: { type: string; text?: string }[] }; error?: { code?: number; message?: string } };

/** SSE body → JSON-RPC 响应对象。取第一个能 parse 且带 result/error 的 data 帧。 */
export function parseSseFrame(body: string): McpFrame {
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload === "") continue;
		try {
			const parsed = JSON.parse(payload);
			if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) return parsed;
		} catch {
			// 跳过非 JSON 帧（如注释行）
		}
	}
	throw new McpError("MCP response contains no JSON-RPC frame");
}

/** content[0].text 实测包了两层：传输层 text 值是 JSON 字符串编码，parse 一次后往往还是字符串，需再 parse。 */
export function unwrapToolText(content: { type: string; text?: string }[] | undefined): unknown {
	let value: unknown = content?.find((part) => part.type === "text")?.text;
	if (value === undefined) throw new McpError("MCP response has no text content");
	for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
		try {
			value = JSON.parse(value);
		} catch {
			break; // 纯文本，到此为止
		}
	}
	return value;
}

/** 单 endpoint 懒会话：并发首调共享一次握手；调用失败即作废会话重建重试一次（工具只读幂等）。 */
export class McpClient {
	private nextId = 1;
	private ready: Promise<string> | null = null;
	private readonly endpoint: string;
	private readonly apiKey: string;

	constructor(endpoint: string, apiKey: string) {
		this.endpoint = endpoint;
		this.apiKey = apiKey;
	}

	async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
		try {
			return await this.request(tool, args);
		} catch {
			this.ready = null; // 会话失效（过期/服务端重启）或其他瞬时失败：重建后重试一次
			return await this.request(tool, args);
		}
	}

	private async request(tool: string, args: Record<string, unknown>): Promise<unknown> {
		const sessionId = await (this.ready ??= this.handshake());
		const body = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name: tool, arguments: args } }, sessionId);
		if (body.error !== undefined) throw new McpError(body.error.message ?? "MCP call failed", body.error.code);
		const frame: McpFrame = body;
		return unwrapToolText(frame.result?.content);
	}

	private async handshake(): Promise<string> {
		const init = await this.post(
			{
				jsonrpc: "2.0",
				id: this.nextId++,
				method: "initialize",
				params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "dwell", version: "0.1.0" } },
			},
			null,
		);
		if (init.error !== undefined) throw new McpError(init.error.message ?? "MCP handshake failed", init.error.code);
		const sessionId = init.sessionId;
		if (sessionId === undefined) throw new McpError("MCP handshake response is missing Mcp-Session-Id");
		await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId, true);
		return sessionId;
	}

	/** notification=true：202 通知，无 JSON-RPC body。 */
	private async post(message: object, sessionId: string | null, notification = false): Promise<McpFrame & { sessionId?: string }> {
		let response: Response;
		try {
			response = await fetch(this.endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					...(sessionId !== null ? { "Mcp-Session-Id": sessionId } : {}),
				},
				body: JSON.stringify(message),
				signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
			});
		} catch (err) {
			throw new McpError(err instanceof Error ? err.message : "network request failed");
		}
		if (!response.ok) throw new McpError(`HTTP ${response.status}`);
		if (notification || response.body === null) return {};
		return { sessionId: response.headers.get("mcp-session-id") ?? undefined, ...parseSseFrame(await response.text()) };
	}
}

const RECENCY = ["oneDay", "oneWeek", "oneMonth", "oneYear"] as const;
type SearchDetails = { query: string; count: number; error: boolean };
type FetchDetails = { url: string; title: string; bytes: number; error: boolean; empty: boolean };

function makeTools(apiKey: string): ToolRegistration[] {
	const search = new McpClient(SEARCH_ENDPOINT, apiKey);
	const reader = new McpClient(READER_ENDPOINT, apiKey);

	const searchTool = defineTool({
		name: "dwell.web.search",
		description:
			"Web search (Zhipu engine); returns a list of sources with summaries. Use it for time-sensitive information (versions, news, prices), fact checks, and research in unfamiliar areas. Cite source URLs in your answer. If a query returns nothing, try other keywords before falling back to dwell.web.fetch.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query (works best at 70 characters or fewer)" }),
			recency: Type.Optional(Type.Union(RECENCY.map((value) => Type.Literal(value)), { description: "Time range: oneDay/oneWeek/oneMonth/oneYear" })),
			location: Type.Optional(Type.Union([Type.Literal("cn"), Type.Literal("us")], { description: "Preferred result region, default cn" })),
			contentSize: Type.Optional(Type.Union([Type.Literal("medium"), Type.Literal("high")], { description: "Summary length: medium is 400-600 characters (default), high is about 2500" })),
			domain: Type.Optional(Type.String({ description: "Restrict to a domain, e.g. docs.example.com" })),
		}),
		replay: "safe",
		async execute(args) {
			let results: unknown;
			try {
				results = await search.call("web_search_prime", {
					search_query: args.query,
					...(args.recency !== undefined ? { search_recency_filter: args.recency } : {}),
					...(args.location !== undefined ? { location: args.location } : {}),
					...(args.contentSize !== undefined ? { content_size: args.contentSize } : {}),
					...(args.domain !== undefined ? { search_domain_filter: args.domain } : {}),
				});
			} catch (err) {
				const details: SearchDetails = { query: args.query, count: 0, error: true };
				return { output: [{ type: "text", text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true, details };
			}
			if (!Array.isArray(results) || results.length === 0) {
				const details: SearchDetails = { query: args.query, count: 0, error: false };
				return { output: [{ type: "text", text: `No results for "${args.query}"; try different keywords.` }], details };
			}
			const lines = results.map((item, index) => {
				const r = item as { title?: string; link?: string; content?: string };
				return `${index + 1}. ${r.title ?? "(untitled)"}\n   ${r.link ?? ""}\n   ${r.content ?? ""}`;
			});
			const details: SearchDetails = { query: args.query, count: results.length, error: false };
			return { output: [{ type: "text", text: lines.join("\n\n") }], details };
		},
	});

	const fetchTool = defineTool({
		name: "dwell.web.fetch",
		description: "Read the main text of a web page URL (fetched server-side and converted to markdown). Use it to read search results closely or links the user sends.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to read (http/https)" }),
			format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("text")], { description: "Output format, default markdown" })),
		}),
		replay: "safe",
		outputLimits: { retain: "head", maxBytes: 48 * 1024 },
		async execute(args) {
			let page: unknown;
			try {
				page = await reader.call("webReader", {
					url: args.url,
					retain_images: false, // 省上下文，正文里的图片链接默认丢弃
					...(args.format !== undefined ? { return_format: args.format } : {}),
				});
			} catch (err) {
				const details: FetchDetails = { url: args.url, title: "", bytes: 0, error: true, empty: false };
				return { output: [{ type: "text", text: `Read failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true, details };
			}
			const p = page as { title?: string; description?: string; url?: string; content?: string };
			if (typeof p.content !== "string" || p.content === "") {
				const details: FetchDetails = { url: args.url, title: "", bytes: 0, error: false, empty: true };
				return { output: [{ type: "text", text: "This URL has no readable main text (it may be an interactive page or a binary); try dwell.web.search with a site restriction." }], details };
			}
			const head = `# ${p.title ?? p.url ?? args.url}\n${p.url ?? args.url}\n\n`;
			const details: FetchDetails = { url: args.url, title: p.title ?? "", bytes: p.content.length, error: false, empty: false };
			return { output: [{ type: "text", text: head + p.content }], details };
		},
	});

	return [searchTool, fetchTool];
}

/** key 由 harness 装配时传入（与 DWELL_PROVIDER 解耦：主模型切 deepseek 时 web 工具仍可用）。 */
export function makeWebExtension(apiKey: string) {
	return defineExtension({
		name: "dwell-web",
		tools: makeTools(apiKey),
		sections: [
			section(
				"web",
				() => "You can go online: dwell.web.search searches the web and dwell.web.fetch reads a page's main text. Check time-sensitive or uncertain facts before answering, and cite source URLs. When the user sends a link, read the original with fetch.",
				{ tag: false },
			),
		],
	});
}
