// dwell harness 装配：SQLite storage + zai-coding-cn (GLM) + CodingTools + dwell 系统提示。
// 全部配置来自环境变量，见 README。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { makeApprovalExtension } from "./ext/approval.ts";

/** 敏感 env：启动读取后即从 process.env 移除（bash 工具继承完整环境，printenv 即可窃取）。 */
const SECRET_ENV = ["ZAI_CODING_CN_API_KEY", "LARK_APP_ID", "LARK_APP_SECRET", "DWELL_ALLOW", "DWELL_ADMINS"];

export function scrubSecretEnv(): void {
	for (const name of SECRET_ENV) delete process.env[name];
}
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DATA_DIR = process.env.DWELL_DATA ?? "./data";
/** 状态文件目录（users/sessions/message-map）：独立于 data/（agent 可写域），避免模型覆写自升权限/劫持路由。 */
export const STATE_DIR = process.env.DWELL_STATE ?? "./state";
export const MODEL = { provider: "zai-coding-cn", modelId: process.env.DWELL_MODEL ?? "glm-5.3" };

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

function zaiModels() {
	const key = process.env.ZAI_CODING_CN_API_KEY;
	if (key === undefined) throw new Error("ZAI_CODING_CN_API_KEY 未设置（dwell 需要智谱 Coding Plan 凭证）");
	// key 预置进 credential store（优先于 env 解析），随后 process.env 可清理
	const credential = { type: "api_key" as const, key };
	const models = createModels({
		credentials: {
			read: async (providerId: string) => (providerId === "zai-coding-cn" ? credential : undefined),
			list: async () => [],
			modify: async (_id: string, fn: (current: typeof credential | undefined) => Promise<typeof credential | undefined>) => await fn(credential),
			delete: async () => {},
		},
	});
	models.setProvider(zaiCodingCnProvider());
	return models;
}

export async function openDwell(models = zaiModels()): Promise<Harness> {
	const context = BACKGROUND_CONTEXT;
	await mkdir(DATA_DIR, { recursive: true });
	const storage = await openNodeSqliteStorage(join(DATA_DIR, "dwell.sqlite"));

	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(DwellExtension);
	registry.install(makeApprovalExtension());

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
