// 冒烟测试：提问一句，打印答案。当前 provider 的凭证 env 已设置则走真实链路；没有则用 faux 模型验证 durable 装配（storage/工具/checkpoint）。
// 用法：node src/smoke.ts "你的问题"
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { MODEL, MODEL_KEY_ENV, openDwell } from "./harness.ts";

const prompt = process.argv[2] ?? "Introduce yourself in one sentence, then list the files in your current working directory.";

let harness;
let model = MODEL;
if (process.env[MODEL_KEY_ENV]) {
	harness = await openDwell();
} else {
	console.error(`（${MODEL_KEY_ENV} 未设置，用 faux 模型验证 durable 链路）`);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("[faux] dwell 链路正常：装配、SQLite storage、提交与等待均工作。")])]);
	const models = createModels();
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	harness = await openDwell(models);
}
const context = BACKGROUND_CONTEXT;
try {
	// openDwell 不再内部 resume（凭证擦除时序，见 index.ts main）；冒烟直接开跑
	harness.resume();
	const root = await harness.root(context, { agent: { model } });
	const submission = await root.submit({ type: "input", content: prompt, requestId: `smoke-${Date.now()}` }, context);
	const settled = await submission.wait(context);
	if (settled.status === "done" && settled.type === "input") {
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const answer = entry?.model?.[0] as AssistantMessage;
		console.log(answer.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(""));
	} else {
		console.error(`unanswered: ${settled.status === "unanswered" ? settled.reason : settled.status}`);
		process.exitCode = 1;
	}
} finally {
	await harness.close(context);
}
