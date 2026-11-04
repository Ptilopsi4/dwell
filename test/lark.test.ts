// node --test "test/lark.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLarkExtension } from "../src/ext/lark.ts";

type Item = { message_id: string; msg_type?: string; create_time?: string; chat_id?: string; deleted?: boolean; body?: { content?: string }; sender?: { id?: string; sender_type?: string }; senderName?: string };

function fakeDeps(items: Item[], anchor?: Item) {
	const calls: string[] = [];
	return {
		calls,
		deps: {
			getClient: () => ({
				im: {
					v1: {
						message: {
							list: async ({ params }: { params: Record<string, unknown> }) => {
								calls.push(`list:${params.container_id}:${params.sort_type ?? ""}:${params.start_time ?? ""}:${params.end_time ?? ""}`);
								return { code: 0, data: { items } };
							},
							get: async ({ path }: { path: { message_id: string } }) => {
								calls.push(`get:${path.message_id}`);
								return { code: 0, data: { items: anchor !== undefined ? [anchor] : [] } };
							},
						},
					},
				},
			}),
			getDirectory: () => undefined,
			chatOf: (id: number) => (id === 42 ? "oc_current" : undefined),
		},
	};
}

function toolOf(deps: ReturnType<typeof fakeDeps>["deps"]) {
	const ext = makeLarkExtension(deps);
	const tool = ext.tools?.[0];
	if (tool === undefined) throw new Error("工具未注册");
	return tool;
}

const api = { conversationId: 42 } as never;
const context = {} as never;
const out = (r: { output?: { text?: string }[] }) => String(r.output?.[0]?.text ?? "");

test("默认读当前会话，按时间正序，带消息 id 与发送者", async () => {
	const { deps } = fakeDeps([
		{ message_id: "om_b", msg_type: "text", create_time: "2000", body: { content: JSON.stringify({ text: "第二条" }) }, sender: { id: "ou_2" }, senderName: "李四" },
		{ message_id: "om_a", msg_type: "text", create_time: "1000", body: { content: JSON.stringify({ text: "第一条" }) }, sender: { id: "ou_1" }, senderName: "张三" },
	]);
	const r = await toolOf(deps).execute({}, api, context);
	const text = out(r as never);
	assert.match(text, /最近消息（正序/);
	assert.ok(text.indexOf("张三 (om_a): 第一条") < text.indexOf("李四 (om_b): 第二条"), "正序排列");
});

test("媒体与富文本占位/截断", async () => {
	const long = "x".repeat(300);
	const { deps } = fakeDeps([
		{ message_id: "om_i", msg_type: "image", create_time: "1000" },
		{ message_id: "om_t", msg_type: "text", create_time: "2000", body: { content: JSON.stringify({ text: long }) }, senderName: "A" },
	]);
	const r = await toolOf(deps).execute({ count: 2 }, api, context);
	const text = out(r as never);
	assert.match(text, /\[图片\]/);
	assert.match(text, new RegExp(`x{200}…`)); // 单条截 200 字
});

test("around：get 定位后前后拼装去重", async () => {
	const { deps, calls } = fakeDeps(
		[{ message_id: "om_1" }, { message_id: "om_2" }, { message_id: "om_3" }],
		{ message_id: "om_2", create_time: "1500", chat_id: "oc_anchor" },
	);
	const r = await toolOf(deps).execute({ around: "om_2", count: 10 }, api, context);
	assert.ok(calls.includes("get:om_2"));
	assert.ok(calls.some((c) => c.startsWith("list:oc_anchor:ByCreateTimeDesc::1500")), "前半段按时间倒序取");
	// Asc + start_time 必须显式带 end_time，否则飞书默认 end=0 报 230001（历史假修复，回归断言）
	const after = calls.find((c) => c.startsWith("list:oc_anchor:ByCreateTimeAsc:1500:"));
	assert.ok(after !== undefined && after.split(":")[4] !== "", "后半段必须携带 end_time");
	assert.ok(out(r as never).includes("最近消息"));
});

test("panel 会话（无对应 chat）给明确提示", async () => {
	const { deps } = fakeDeps([]);
	const r = await toolOf(deps).execute({}, { conversationId: 99 } as never, context);
	assert.match(out(r as never), /panel 任务.*没有对应的飞书聊天/);
});

test("API 错误返回 isError", async () => {
	const deps = {
		getClient: () => ({
			im: { v1: { message: { list: async () => ({ code: 230002, msg: "no permission" }) } } },
		}),
		getDirectory: () => undefined,
		chatOf: () => "oc_x",
	};
	const r = await toolOf(deps as never).execute({}, api, context);
	assert.equal((r as { isError?: boolean }).isError, true);
	assert.match(out(r as never), /230002/);
});

test("卡片消息：app 发的卡（含降级文案）直接标注，用户卡提取文本", async () => {
	const { deps } = fakeDeps([
		{ message_id: "om_c1", msg_type: "interactive", create_time: "1000", body: { content: JSON.stringify({ elements: [[{ tag: "text", text: "请升级至最新版本客户端，以查看内容" }]] }) }, sender: { id: "app_1", sender_type: "app" } },
		{ message_id: "om_c2", msg_type: "interactive", create_time: "2000", body: { content: JSON.stringify({ elements: [[{ tag: "div", text: { tag: "lark_md", content: "标题：值班日报" } }]] }) }, sender: { id: "ou_9" }, senderName: "王五" },
	]);
	const r = await toolOf(deps).execute({ count: 2 }, api, context);
	const text = out(r as never);
	assert.match(text, /\[dwell 的回复卡片，正文见会话上下文\]/); // app 卡不提取（降级文案不污染）
	assert.doesNotMatch(text, /请升级至最新版本/);
	assert.match(text, /值班日报/); // 用户卡提取 lark_md
});

test("空结果提示", async () => {
	const { deps } = fakeDeps([]);
	const r = await toolOf(deps).execute({}, api, context);
	assert.match(out(r as never), /没有可读消息/);
});
