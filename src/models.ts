import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lazyStream, type Api, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type AnthropicOptions, type Message, type Model, type ModelCost, type OpenAICompletionsOptions, type OpenAIResponsesOptions, type ProviderStreams, type TranscriptContext } from "@earendil-works/pi-ai";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { OpenAIResponsesCompatSchema, OpenAICompletionsCompatSchema, AnthropicMessagesCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import { ThinkingLevelMapSchema, ModelPromptCacheSchema, ModelInputLimitsSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { Value } from "typebox/value";

export type ModelApi = "openai-responses" | "openai-completions" | "anthropic-messages";
type Metadata = Pick<Model<Api>, "name" | "reasoning" | "input" | "contextWindow" | "maxTokens" | "compat" | "headers" | "thinkingLevelMap" | "promptCache" | "inputLimits">;
export type ModelConnectionConfig = Partial<Metadata> & {
	api: ModelApi;
	baseUrl: string;
	model: string;
	apiKeyEnv: string;
	cost?: ModelCost | null;
};
export interface ResolvedModelConnection {
	providerId: string;
	api: ModelApi;
	baseUrl: string;
	model: string;
	apiKeyEnv: string;
	metadata: Model<Api>;
	pricingKnown: boolean;
}
export interface ResolvedModelsConfig {
	source: "file" | "legacy";
	path?: string;
	main: ResolvedModelConnection;
	vision?: ResolvedModelConnection;
}

const APIS = {
	"openai-responses": openAIResponsesApi,
	"openai-completions": openAICompletionsApi,
	"anthropic-messages": anthropicMessagesApi,
};
const COMPAT_SCHEMAS = {
	"openai-responses": OpenAIResponsesCompatSchema,
	"openai-completions": OpenAICompletionsCompatSchema,
	"anthropic-messages": AnthropicMessagesCompatSchema,
};
const METADATA_SCHEMAS = { thinkingLevelMap: ThinkingLevelMapSchema, promptCache: ModelPromptCacheSchema, inputLimits: ModelInputLimitsSchema };
const LEGACY = {
	"zai-coding-cn": { api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", model: "glm-5.3", apiKeyEnv: "ZAI_CODING_CN_API_KEY" },
	deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", apiKeyEnv: "DEEPSEEK_API_KEY" },
} satisfies Record<string, ModelConnectionConfig>;
const METADATA_FIELDS = ["name", "reasoning", "input", "contextWindow", "maxTokens", "compat", "headers", "thinkingLevelMap", "promptCache", "inputLimits"] as const;
const FIELDS = new Set<string>(["api", "baseUrl", "model", "apiKeyEnv", "cost", ...METADATA_FIELDS]);
const catalog = getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider));
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const RESERVED_KEY_ENV = /^(?:GH_TOKEN|GITHUB_TOKEN|HOME|PATH|USER|SHELL|ENV|BASH_ENV|ZDOTDIR|IFS|CDPATH|LD_.*|DYLD_.*|NODE_.*|NPM_.*|npm_.*|LARK_.*|FEISHU_.*|TELEGRAM_.*|DWELL_.*)$/;

/** Loading metadata never resolves credentials; callers capture keys before scrubbing the environment. */
export function loadModelsConfig(env: NodeJS.ProcessEnv = process.env): ResolvedModelsConfig {
	const explicit = env.DWELL_MODELS_FILE !== undefined;
	if (explicit && env.DWELL_MODELS_FILE!.trim() === "") throw new Error("DWELL_MODELS_FILE must be a non-empty path");
	const path = resolve(env.DWELL_MODELS_FILE ?? resolve(env.DWELL_STATE ?? "./state", "models.json"));
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") return legacyConfig(env);
		throw new Error(`Cannot read model configuration at ${path}`, { cause: error });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		// JSON parser diagnostics can include a literal secret from an invalid file.
		throw new Error(`Invalid JSON in model configuration at ${path}`);
	}
	const config = object(parsed, "models");
	if (Object.keys(config).some((key) => key !== "main" && key !== "vision")) throw new Error("Model configuration only accepts main and vision");
	const main = connection(config.main, "dwell-main", "main");
	let vision: ResolvedModelConnection | undefined;
	if (config.vision === undefined) vision = main.metadata.input.includes("image") ? main : undefined;
	else if (config.vision !== null) {
		vision = connection(config.vision, "dwell-vision", "vision");
		if (!vision.metadata.input.includes("image")) throw new Error("vision must support image input; declare input: [\"text\", \"image\"] for a custom model");
	}
	return { source: "file", path, main, vision };
}

function legacyConfig(env: NodeJS.ProcessEnv): ResolvedModelsConfig {
	const id = env.DWELL_PROVIDER ?? "zai-coding-cn";
	if (!Object.hasOwn(LEGACY, id)) throw new Error("DWELL_PROVIDER must be zai-coding-cn or deepseek when models.json is absent");
	const defaults = LEGACY[id as keyof typeof LEGACY];
	const main = connection({ ...defaults, model: env.DWELL_MODEL ?? defaults.model }, id, "main");
	const vision = connection({ ...LEGACY["zai-coding-cn"], model: env.DWELL_VISION_MODEL ?? "glm-5.3-flash" }, "zai-coding-cn", "vision");
	return { source: "legacy", main, vision };
}

function object(value: unknown, field: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
	return value as Record<string, unknown>;
}

function nonempty(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${field} must be a non-empty string without surrounding whitespace or control characters`);
	return value;
}

function positive(value: unknown, field: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${field} must be a positive safe integer`);
}

function connection(value: unknown, providerId: string, label: string): ResolvedModelConnection {
	const raw = object(value, label);
	if (Object.keys(raw).some((key) => !FIELDS.has(key))) throw new Error(`${label} contains an unsupported field`);
	const api = nonempty(raw.api, `${label}.api`);
	if (!Object.hasOwn(APIS, api)) throw new Error(`${label}.api must be openai-responses, openai-completions, or anthropic-messages`);
	const baseUrl = nonempty(raw.baseUrl, `${label}.baseUrl`);
	let url: URL;
	try { url = new URL(baseUrl); } catch { throw new Error(`${label}.baseUrl must be an absolute HTTP(S) URL`); }
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${label}.baseUrl must be HTTP(S) without credentials, query, or fragment`);
	const model = nonempty(raw.model, `${label}.model`);
	const apiKeyEnv = nonempty(raw.apiKeyEnv, `${label}.apiKeyEnv`);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error(`${label}.apiKeyEnv must name an environment variable`);
	if (RESERVED_KEY_ENV.test(apiKeyEnv) && apiKeyEnv !== "DWELL_MODEL_API_KEY" && apiKeyEnv !== "DWELL_VISION_API_KEY") throw new Error(`${label}.apiKeyEnv must not reuse execution, channel, or application configuration variables`);
	// Metadata is reused only for an exact endpoint, protocol, and model match.
	const known = catalog.find((entry) => entry.api === api && entry.id === model && entry.baseUrl.replace(/\/$/, "") === baseUrl.replace(/\/$/, ""));
	if (raw.name !== undefined) nonempty(raw.name, `${label}.name`);
	if (raw.reasoning !== undefined && typeof raw.reasoning !== "boolean") throw new Error(`${label}.reasoning must be boolean`);
	if (raw.input !== undefined && (!Array.isArray(raw.input) || raw.input.length === 0 || raw.input.some((input) => input !== "text" && input !== "image") || new Set(raw.input).size !== raw.input.length)) throw new Error(`${label}.input must list text and/or image without duplicates`);
	for (const key of ["contextWindow", "maxTokens"] as const) if (raw[key] !== undefined) positive(raw[key], `${label}.${key}`);
	if (raw.compat !== undefined && !Value.Check(COMPAT_SCHEMAS[api as ModelApi], raw.compat)) throw new Error(`${label}.compat must match the ${api} schema`);
	for (const [key, schema] of Object.entries(METADATA_SCHEMAS)) {
		if (raw[key] !== undefined && !Value.Check(schema, raw[key])) throw new Error(`${label}.${key} must match the model metadata schema`);
	}
	if (raw.headers !== undefined) {
		for (const [name, header] of Object.entries(object(raw.headers, `${label}.headers`))) {
			if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof header !== "string" || /[\r\n\0]/.test(header)) throw new Error(`${label}.headers must contain valid HTTP header names and string values`);
			if (/^(authorization|proxy-authorization|x-api-key|api-key|cookie)$/i.test(name)) throw new Error(`${label}.headers cannot contain credentials; use apiKeyEnv`);
		}
	}
	const cost = raw.cost === null ? undefined : raw.cost === undefined ? known?.cost : validateCost(raw.cost, `${label}.cost`);
	const metadata: Model<Api> = {
		...known,
		id: model, name: known?.name ?? model, api, provider: providerId, baseUrl,
		reasoning: known?.reasoning ?? false,
		input: known?.input ?? ["text"],
		contextWindow: known?.contextWindow ?? 32768,
		maxTokens: known?.maxTokens ?? 4096,
		cost: cost ?? { ...ZERO_COST },
	};
	for (const key of METADATA_FIELDS) if (raw[key] !== undefined) Object.assign(metadata, { [key]: raw[key] });
	if (metadata.maxTokens > metadata.contextWindow) throw new Error(`${label}.maxTokens cannot exceed contextWindow`);
	return { providerId, api: api as ModelApi, baseUrl, model, apiKeyEnv, metadata, pricingKnown: cost !== undefined };
}

function validateCost(value: unknown, field: string): ModelCost {
	const cost = object(value, field);
	for (const key of Object.keys(ZERO_COST)) if (typeof cost[key] !== "number" || !Number.isFinite(cost[key]) || (cost[key] as number) < 0) throw new Error(`${field} must provide nonnegative input, output, cacheRead, and cacheWrite rates`);
	if (Object.keys(cost).some((key) => !Object.hasOwn(ZERO_COST, key) && key !== "tiers")) throw new Error(`${field} contains an unsupported field`);
	if (cost.tiers !== undefined) {
		if (!Array.isArray(cost.tiers)) throw new Error(`${field}.tiers must be an array`);
		for (const value of cost.tiers) {
			const { inputTokensAbove, ...rates } = object(value, `${field}.tiers`);
			positive(inputTokensAbove, `${field}.tiers.inputTokensAbove`);
			validateCost(rates, `${field}.tiers`);
		}
	}
	return cost as ModelCost;
}

export function configuredSecretEnv(config: ResolvedModelsConfig): string[] {
	return [...new Set([config.main.apiKeyEnv, ...(config.vision ? [config.vision.apiKeyEnv] : [])])];
}

/** Round trips resolved metadata without turning the SDK's zero-price placeholder into a known rate. */
export function modelConnectionConfig(connection: ResolvedModelConnection): ModelConnectionConfig {
	const result: ModelConnectionConfig = { api: connection.api, baseUrl: connection.baseUrl, model: connection.model, apiKeyEnv: connection.apiKeyEnv, cost: connection.pricingKnown ? connection.metadata.cost : null };
	for (const key of METADATA_FIELDS) if (connection.metadata[key] !== undefined) Object.assign(result, { [key]: connection.metadata[key] });
	return structuredClone(result);
}

const WIRE_TOOL_PREFIX = "dwtool_";

// Keep durable names unchanged; transports require short ASCII function names.
function wireToolName(name: string): string {
	if (/^[a-zA-Z0-9_-]{1,64}$/.test(name) && !name.startsWith(WIRE_TOOL_PREFIX)) return name;
	const encoded = WIRE_TOOL_PREFIX + Buffer.from(name, "utf8").toString("base64url");
	if (encoded.length > 64) throw new Error("Tool name exceeds the protocol's 64-character limit after encoding");
	return encoded;
}

function internalToolName(name: string): string {
	if (!name.startsWith(WIRE_TOOL_PREFIX) || name.length > 64) return name;
	const encoded = name.slice(WIRE_TOOL_PREFIX.length);
	if (!/^[a-zA-Z0-9_-]+$/.test(encoded)) return name;
	const decoded = Buffer.from(encoded, "base64url").toString("utf8");
	return Buffer.from(decoded, "utf8").toString("base64url") === encoded && wireToolName(decoded) === name ? decoded : name;
}

function mapAssistantTools(message: AssistantMessage, map: (name: string) => string): AssistantMessage {
	return { ...message, content: message.content.map((part) => part.type === "toolCall" ? { ...part, name: map(part.name) } : part) };
}

function wireToolContext(context: TranscriptContext): TranscriptContext {
	const messages = context.messages.map((message): Message => {
		if (message.role === "system") return {
			...message,
			toolsAdded: message.toolsAdded?.map((tool) => ({ ...tool, name: wireToolName(tool.name) })),
			toolsRemoved: message.toolsRemoved?.map((tool) => ({ ...tool, name: wireToolName(tool.name) })),
		};
		if (message.role === "assistant") return mapAssistantTools(message, wireToolName);
		if (message.role === "toolResult") return { ...message, toolName: wireToolName(message.toolName) };
		return message;
	});
	return { ...context, messages };
}

function wireAllowedTool(tool: Record<string, unknown>): Record<string, unknown> {
	if ((tool.type === "function" || tool.type === "custom") && typeof tool.name === "string") return { ...tool, name: wireToolName(tool.name) };
	const fn = tool.function;
	if (tool.type === "function" && typeof fn === "object" && fn !== null && "name" in fn && typeof fn.name === "string") return { ...tool, function: { ...fn, name: wireToolName(fn.name) } };
	return tool;
}

function wireToolOptions(options: OpenAIResponsesOptions | OpenAICompletionsOptions | AnthropicOptions | undefined) {
	const choice = options?.toolChoice;
	if (typeof choice !== "object" || choice === null) return options;
	if (choice.type === "function" && "function" in choice) return { ...options, toolChoice: { ...choice, function: { ...choice.function, name: wireToolName(choice.function.name) } } };
	if ((choice.type === "function" || choice.type === "custom" || choice.type === "tool") && "name" in choice) return { ...options, toolChoice: { ...choice, name: wireToolName(choice.name) } };
	if (choice.type === "allowed_tools" && "tools" in choice) return { ...options, toolChoice: { ...choice, tools: choice.tools.map(wireAllowedTool) } };
	if (choice.type === "allowed_tools" && "allowed_tools" in choice) return { ...options, toolChoice: { ...choice, allowed_tools: { ...choice.allowed_tools, tools: choice.allowed_tools.tools.map(wireAllowedTool) } } };
	return options;
}

function internalToolStream(source: AssistantMessageEventStream, model: Model<Api>): AssistantMessageEventStream {
	return lazyStream(model, async () => ({
		async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
			for await (const event of source) {
				if ("partial" in event) {
					const partial = mapAssistantTools(event.partial, internalToolName);
					yield event.type === "toolcall_end" ? { ...event, partial, toolCall: { ...event.toolCall, name: internalToolName(event.toolCall.name) } } : { ...event, partial };
				} else if (event.type === "done") yield { ...event, message: mapAssistantTools(event.message, internalToolName) };
				else yield { ...event, error: mapAssistantTools(event.error, internalToolName) };
			}
		},
		result: async () => mapAssistantTools(await source.result(), internalToolName),
	}));
}

function protocolTools(api: ProviderStreams): ProviderStreams {
	return {
		stream: (model, context, options) => internalToolStream(api.stream(model, wireToolContext(context), wireToolOptions(options)), model),
		streamSimple: (model, context, options) => internalToolStream(api.streamSimple(model, wireToolContext(context), options), model),
	};
}

/** The auth closure owns the captured credential and never consults process.env. */
export function createModelClient(connection: ResolvedModelConnection, apiKey: string): { models: Models; model: Model<Api> } {
	if (typeof apiKey !== "string" || apiKey.trim() === "") throw new Error(`${connection.apiKeyEnv} is required for the configured model`);
	const model = structuredClone(connection.metadata);
	const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
	models.setProvider(createProvider({
		id: connection.providerId,
		baseUrl: connection.baseUrl,
		auth: { apiKey: { name: connection.apiKeyEnv, resolve: async () => ({ auth: { apiKey }, source: connection.apiKeyEnv }) } },
		models: [model],
		api: protocolTools(APIS[connection.api]()),
	}));
	return { models, model };
}
