// dwell harness 装配：SQLite storage + DeepSeek + CodingTools + dwell 系统提示。
// 全部配置来自环境变量，见 README。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DATA_DIR = process.env.DWELL_DATA ?? "./data";
export const MODEL = { provider: "zai-coding-cn", modelId: process.env.DWELL_MODEL ?? "glm-5.3" };

const PREAMBLE = `你是 dwell，一个常驻服务器的通用助手。通过飞书对话与人交流。
- 用中文回答，技术术语保留英文
- 回答直接给结论和内容，不写客套开场白
- 单条回复保持简短（百字量级）；长内容给要点，被追问再展开
- 文件操作在你的工作目录内进行；不确定的事直说不确定`;

const DwellExtension = defineExtension({
	name: "dwell",
	sections: [section("preamble", () => PREAMBLE, { tag: false })],
});

function zaiModels() {
	if (!process.env.ZAI_CODING_CN_API_KEY) throw new Error("ZAI_CODING_CN_API_KEY 未设置（dwell 需要智谱 Coding Plan 凭证）");
	const models = createModels();
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

	const env = ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: resolve(cwd ?? process.cwd()) });
	const harness = await Harness.open(storage, { models, registry, env }, context);
	harness.resume();
	return harness;
}
