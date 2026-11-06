// dwell harness 装配：SQLite storage + 模型 provider（zai-coding-cn 或 deepseek）+ CodingTools + dwell 系统提示。
// 全部配置来自环境变量，见 README。
import { mkdir, open as openFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRegistry, defineExtension, Harness, section, type Extension, type ReportInfo, type TaskGraph } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { makeApprovalExtension } from "./ext/approval.ts";
import { makeWebExtension } from "./ext/web.ts";
import { DATA_DIR } from "./state.ts";

/** 敏感 env：启动读取后即从 process.env 移除（bash 工具继承完整环境，printenv 即可窃取）。 */
const SECRET_ENV = ["ZAI_CODING_CN_API_KEY", "DEEPSEEK_API_KEY", "LARK_APP_ID", "LARK_APP_SECRET", "DWELL_ALLOW", "DWELL_ADMINS"];

export async function scrubSecretEnv(): Promise<void> {
	const values: string[] = [];
	for (const name of SECRET_ENV) {
		const value = process.env[name];
		if (value !== undefined && value !== "") values.push(value);
		delete process.env[name];
	}
	if (process.platform !== "linux" || values.length === 0) return;
	try {
		await wipeEnvironValues(values);
	} catch (err) {
		throw new Error(`密钥擦除失败，拒绝继续启动：${err instanceof Error ? err.message : String(err)}`);
	}
}

/** 在 /proc/self/environ 的原始块中定位 SECRET_ENV 条目，把值区覆写为 0，再自检密钥值不复存在（fail closed）。
 *  /proc/self/mem 按虚拟地址寻址，environ 文件内的偏移不能直接当地址用——环境块的基地址是
 *  /proc/self/stat 的 env_start（第 50 字段），偏移须加上它（实测：不加会写进未映射低地址报 EIO，启动必败）。 */
async function wipeEnvironValues(values: string[]): Promise<void> {
	const environ = await readFile("/proc/self/environ");
	const spans: { start: number; end: number }[] = [];
	for (let i = 0; i < environ.length; ) {
		const zero = environ.indexOf(0, i);
		const entryEnd = zero === -1 ? environ.length : zero;
		const entry = environ.subarray(i, entryEnd);
		const eq = entry.indexOf(61); // '='
		if (eq > 0 && SECRET_ENV.includes(entry.subarray(0, eq).toString("latin1"))) {
			spans.push({ start: i + eq + 1, end: i + entry.length }); // 值区，不含结尾 NUL
		}
		if (zero === -1) break;
		i = zero + 1;
	}
	if (spans.length === 0) return;
	// comm 字段（第 2 字段）可含空格与括号，取最后一个 ')' 之后切分；剩余字段从第 3 字段（state）起数：fields[0]=第 3 字段 → env_start（第 50）= fields[47]
	const stat = (await readFile("/proc/self/stat", "utf8")).trim();
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
	const envStart = Number(fields[47]);
	if (!Number.isFinite(envStart) || envStart <= 0) throw new Error("无法从 /proc/self/stat 解析 env_start");
	const handle = await openFile("/proc/self/mem", "r+");
	try {
		const zeros = Buffer.alloc(128, 0);
		for (const span of spans) {
			for (let p = span.start; p < span.end; p += zeros.length) {
				const length = Math.min(zeros.length, span.end - p);
				await handle.write(zeros, 0, length, envStart + p);
			}
		}
	} finally {
		await handle.close();
	}
	const after = (await readFile("/proc/self/environ")).toString("latin1");
	for (const value of values) {
		if (after.includes(value)) throw new Error("自检失败：密钥值仍可从 /proc/self/environ 读出");
	}
}

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

export async function openDwell(models = providerModels(), extraExtensions: Extension[] = [], onReport?: (error: unknown, info: ReportInfo) => void): Promise<Harness> {
	const context = BACKGROUND_CONTEXT;
	await mkdir(DATA_DIR, { recursive: true });
	const storage = await openNodeSqliteStorage(join(DATA_DIR, "dwell.sqlite"));

	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(DwellExtension);
	registry.install(makeApprovalExtension());
	for (const extension of extraExtensions) registry.install(extension);
	// web 工具与主模型 provider 解耦：只要有智谱 key 就注册（计入 GLM Coding Plan 套餐）
	const webApiKey = process.env.ZAI_CODING_CN_API_KEY;
	if (webApiKey !== undefined && webApiKey !== "") registry.install(makeWebExtension(webApiKey));

	// DWELL_TOOL_PATH：设置后收窄 bash 工具 shell 的 PATH（如 /usr/bin:/bin），让模型看不到服务器上带凭证的程序；
	// dwell 自身的飞书收发走进程内 SDK，不受影响。本机开发不设。
	const env = ({ cwd }: { cwd?: string }) =>
		new NodeExecutionEnv({
			cwd: resolve(cwd ?? process.cwd()),
			...(process.env.DWELL_TOOL_PATH ? { shellEnv: { PATH: process.env.DWELL_TOOL_PATH } } : {}),
		});
	const harness = await Harness.open(storage, { models, registry, env, onReport }, context);
	// 不在这里 resume：调用方先把凭证读进闭包并 await scrubSecretEnv() 后再 resume，续跑任务的 bash 才读不到密钥
	return harness;
}

/** taskGraph 中有活跃前台任务的会话集合。节点状态在 state.status（不是 status——两个已上线修复曾因读错字段静默失效），用官方类型防再错。
 *  跳过 background 任务：会话自持的自动 compaction 默认 background，长对话压缩期间不该算「忙」——
 *  否则 run 归属不更新（审批记到上一个发送者头上）、重启还会误挂镜像卡。 */
export function busyConversations(graph: TaskGraph | undefined): Set<number> {
	const live = new Set(["pending", "running", "waiting", "sleeping", "completing"]);
	const busy = new Set<number>();
	for (const task of Object.values(graph?.tasks ?? {})) {
		if (task.background) continue;
		if (live.has(task.state.status)) busy.add(task.conversationId as number);
	}
	return busy;
}

/** 有活跃 run 的会话集合：pi.live.run 只由前台 pi.generation 任务持有（RUN_TASK_KINDS），重启重挂镜像卡只认它。 */
export function runConversations(graph: TaskGraph | undefined): Set<number> {
	const live = new Set(["pending", "running", "waiting", "sleeping", "completing"]);
	const running = new Set<number>();
	for (const task of Object.values(graph?.tasks ?? {})) {
		if (task.background || task.kind !== "pi.generation") continue;
		if (live.has(task.state.status)) running.add(task.conversationId as number);
	}
	return running;
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
