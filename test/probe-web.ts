// 一次性真链路探针：node test/probe-web.ts（不进 npm test 套件）
import { readFileSync } from "node:fs";
import { makeWebExtension } from "../src/ext/web.ts";

const env = readFileSync(".env", "utf8");
const key = /^ZAI_CODING_CN_API_KEY=(.+)$/m.exec(env)?.[1]?.trim();
if (key === undefined) throw new Error("未找到 ZAI_CODING_CN_API_KEY");

const ext = makeWebExtension(key);
const tools = ext.tools ?? [];
const api = {} as never; // execute 未使用 api/context
const context = {} as never;

const search = tools.find((tool) => tool.name === "dwell.web.search");
const fetchTool = tools.find((tool) => tool.name === "dwell.web.fetch");
if (search === undefined || fetchTool === undefined) throw new Error("工具未注册");

console.log("=== dwell.web.search ===");
const s = await search.execute({ query: "pi-durable npm 最新版本", recency: "oneMonth" }, api, context);
console.log("isError:", s.isError ?? false, "| details:", JSON.stringify(s.details));
console.log(String((s.output as { text: string }[])[0]?.text).slice(0, 400));

console.log("\n=== dwell.web.fetch ===");
const f = await fetchTool.execute({ url: "https://www.npmjs.com/package/@earendil-works/pi-durable" }, api, context);
console.log("isError:", f.isError ?? false, "| details:", JSON.stringify(f.details));
console.log(String((f.output as { text: string }[])[0]?.text).slice(0, 300));
