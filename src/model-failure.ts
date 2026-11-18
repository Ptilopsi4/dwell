import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";

export type ModelFailure = {
	kind: "region" | "authentication" | "permission" | "quota" | "configuration" | "rate_limit" | "unavailable" | "network" | "unknown";
	retryable: boolean;
	status?: number;
	diagnostic: string;
	message: string;
};

/** Classify transport facts, never provider prose that may contain request data or credentials. */
export function modelFailure(detail: string): ModelFailure {
	const text = detail.slice(0, 16_384);
	const match = /(?:API error\s*\(|\bHTTP(?:\s+status)?\s*[:=]?\s*|\bstatus(?:Code)?["'\s:=]+|^\s*)([45]\d\d)\b/i.exec(text);
	const status = match === null ? undefined : Number(match[1]);
	const row = (kind: ModelFailure["kind"], retryable: boolean, diagnostic: string, message: string): ModelFailure => ({ kind, retryable, ...(status === undefined ? {} : { status }), diagnostic: `${diagnostic}${status === undefined ? "" : ` (HTTP ${status})`}`, message });
	if (/\bunsupported_country_region_territory\b|\b(?:region|country)[_ -](?:not[_ -]supported|restricted)\b/i.test(text)) return row("region", false, "Model access denied: unsupported_country_region_territory", "模型服务拒绝了当前地区的请求。已保留工作进度，请维护者检查该连接的可用范围后再继续。");
	if (status === 401 || /\b(?:invalid_api_key|authentication_error|invalid_authentication)\b/i.test(text) || /^Model authentication failed$/.test(text)) return row("authentication", false, "Model authentication failed", "模型连接认证失败。已保留工作进度，请维护者检查凭证后再继续。");
	if (/\b(?:insufficient_quota|billing_hard_limit_reached|quota_exceeded|credit_balance_too_low)\b|\bbilling quota exceeded\b/i.test(text)) return row("quota", false, "Model billing quota exceeded", "模型账户额度不足。已保留工作进度，请维护者检查额度后再继续。");
	if (status === 403 || /\bpermission_error\b|\bpermission_denied\b/i.test(text) || /^Model access denied$/.test(text)) return row("permission", false, "Model access denied", "模型服务拒绝访问。已保留工作进度，请维护者检查连接权限后再继续。");
	if ([400, 404, 422].includes(status ?? 0) || /\b(?:model_not_found|invalid_model|unsupported_model)\b/i.test(text) || /^Model request configuration rejected$/.test(text)) return row("configuration", false, "Model request configuration rejected", "模型或请求配置不被服务接受。已保留工作进度，请维护者检查模型名称、协议和配置后再继续。");
	if (status === 429 || /\brate[_ -]?limit(?:ed)?\b|\btoo many requests\b/i.test(text)) return row("rate_limit", true, "Model rate limit reached", "模型服务限流，暂时未能完成请求。已保留工作进度，可稍后在原任务线继续。");
	if (status !== undefined && status >= 500) return row("unavailable", true, "Model service temporarily unavailable", "模型服务暂时不可用。已保留工作进度，可稍后在原任务线继续。");
	if (/\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)\b|fetch failed|network error|timed? out|socket hang up/i.test(text)) return row("network", true, "Model network request failed", "模型连接中断或超时。已保留工作进度，可稍后在原任务线继续。");
	return row("unknown", false, "Model request failed", "模型请求未完成。已保留工作进度，可在原任务线继续；若仍失败，请维护者检查模型连接。");
}

/** Keep deterministic access errors out of the SDK's text-based transient retry classifier. */
export function terminalModelError(message: AssistantMessage): string | undefined {
	// Preserve the pinned SDK's complete overflow classifier and its automatic compaction path.
	if (isContextOverflow(message)) return undefined;
	const failure = modelFailure(message.errorMessage ?? "");
	return ["region", "authentication", "permission", "quota", "configuration"].includes(failure.kind) ? failure.diagnostic : undefined;
}
