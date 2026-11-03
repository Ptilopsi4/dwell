// dwell harness 装配：SQLite storage + 模型 provider（zai-coding-cn 或 deepseek）+ CodingTools + dwell 系统提示。
// 全部配置来自环境变量，见 README。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { makeApprovalExtension } from "./ext/approval.ts";
import { makeWebExtension } from "./ext/web.ts";

/** 敏感 env：启动读取后即从 process.env 移除（bash 工具继承完整环境，printenv 即可窃取）。 */
const SECRET_ENV = ["ZAI_CODING_CN_API_KEY", "DEEPSEEK_API_KEY", "LARK_APP_ID", "LARK_APP_SECRET", "DWELL_ALLOW", "DWELL_ADMINS"];

export function scrubSecretEnv(): void {
	for (const name of SECRET_ENV) delete process.env[name];
}
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";

export const DATA_DIR = process.env.DWELL_DATA ?? "./data";
/** 状态文件目录（users/sessions/message-map）：独立于 data/（agent 可写域），避免模型覆写自升权限/劫持路由。 */
export const STATE_DIR = process.env.DWELL_STATE ?? "./state";
/** DWELL_PROVIDER 选择模型来源；每个 provider 的凭证 env 与默认模型。 */
const PROVIDERS = {
	"zai-coding-cn": { keyEnv: "ZAI_CODING_CN_API_KEY", defaultModel: "glm-5.3", make: zaiCodingCnProvider },
	deepseek: { keyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-v4-pro", make: deepseekProvider },
} as const;
type ProviderId = keyof typeof PROVIDERS;
const providerId = (process.env.DWELL_PROVIDER ?? "zai-coding-cn") as ProviderId;
if (!(providerId in PROVIDERS)) throw new Error(`DWELL_PROVIDER=${providerId} 不支持（可选：${Object.keys(PROVIDERS).join(" / ")}）`);
export const MODEL: { readonly provider: string; readonly modelId: string } = { provider: providerId, modelId: process.env.DWELL_MODEL ?? PROVIDERS[providerId].defaultModel };
/** 当前 provider 的凭证 env 名（smoke 判断是否走真实链路）。 */
export const MODEL_KEY_ENV = PROVIDERS[providerId].keyEnv;

const PREAMBLE = `你是 dwell，一个常驻服务器的通用助手。通过飞书对话与人交流。
- 用中文回答，技术术语保留英文
- 回答直接给结论和内容，不写客套开场白
- 单条回复保持简短（百字量级）；长内容给要点，被追问再展开
- 文件操作在你的工作目录内进行；不确定的事直说不确定
- 命令被审批策略拦截时，如实告知用户需要回复 /approve，不要尝试绕过`;

const DwellExtension = defineExtension({
	name: "dwell",
	sections: [section("preamble", () => PREAMBLE, { tag: false })],
});

function providerModels() {
	const { keyEnv, make } = PROVIDERS[providerId];
	const key = process.env[keyEnv];
	if (key === undefined || key === "") throw new Error(`${keyEnv} 未设置（DWELL_PROVIDER=${providerId} 需要该凭证）`);
	// key 预置进 credential store（优先于 env 解析），随后 process.env 可清理
	const credential = { type: "api_key" as const, key };
	const models = createModels({
		credentials: {
			read: async (id: string) => (id === providerId ? credential : undefined),
			list: async () => [],
			modify: async (_id: string, fn: (current: typeof credential | undefined) => Promise<typeof credential | undefined>) => await fn(credential),
			delete: async () => {},
		},
	});
	models.setProvider(make());
	return models;
}

export async function openDwell(models = providerModels()): Promise<Harness> {
	const context = BACKGROUND_CONTEXT;
	await mkdir(DATA_DIR, { recursive: true });
	const storage = await openNodeSqliteStorage(join(DATA_DIR, "dwell.sqlite"));

	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(DwellExtension);
	registry.install(makeApprovalExtension());
	// web 工具与主模型 provider 解耦：只要有智谱 key 就注册（计入 GLM Coding Plan 套餐）
	const webApiKey = process.env.ZAI_CODING_CN_API_KEY;
	if (webApiKey !== undefined && webApiKey !== "") registry.install(makeWebExtension(webApiKey));

	// DWELL_TOOL_PATH：设置后收窄 bash 工具 shell 的 PATH（如 /usr/bin:/bin），使 lark-cli 等服务凭证程序对模型不可见；
	// 不影响 dwell 自身的消息收发（直接 spawn，不经工具 shell）。本机开发不设。
	const env = ({ cwd }: { cwd?: string }) =>
		new NodeExecutionEnv({
			cwd: resolve(cwd ?? process.cwd()),
			...(process.env.DWELL_TOOL_PATH ? { shellEnv: { PATH: process.env.DWELL_TOOL_PATH } } : {}),
		});
	const harness = await Harness.open(storage, { models, registry, env }, context);
	harness.resume();
	return harness;
}

/** 图片理解 subagent：glm-5.3 无视觉，图片交 flash 单发单答，描述文本进主上下文（不进 checkpoint）。 */
export const VISION_MODEL_ID = process.env.DWELL_VISION_MODEL ?? "glm-5.3-flash";

export type ImageDescriber = (base64: string, mimeType: string) => Promise<string>;

/** 有 ZAI key 且 catalog 有该模型时返回描述函数；否则 null（图片降级为落盘+提示）。 */
export function makeImageDescriber(): ImageDescriber | null {
	const key = process.env.ZAI_CODING_CN_API_KEY;
	if (key === undefined || key === "") return null;
	const models = providerModels();
	const model = models.getModel("zai-coding-cn", VISION_MODEL_ID);
	if (model === undefined) return null;
	return async (base64, mimeType) => {
		const context = normalizeContext({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "详细描述这张图片：主体与场景、关键细节；如有文字全部转录；如有图表/数据给出关键数字。用中文，直接给描述，不要客套。" },
						{ type: "image", data: base64, mimeType },
					],
					timestamp: Date.now(),
				},
			],
		});
		const answer = await models.completeSimple(model, context, { maxTokens: 1024 });
		if (answer.errorMessage !== undefined) throw new Error(answer.errorMessage);
		const text = answer.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		return text.trim() !== "" ? text : "(模型未返回描述)";
	};
}
