// node --test "test/lark.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLarkExtension } from "../src/ext/lark.ts";

type Item = { message_id: string; msg_type?: string; create_time?: string; chat_id?: string; deleted?: boolean; body?: { content?: string }; sender?: { id?: string }; senderName?: string };

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
	assert.ok(calls.some((c) => c.startsWith("list:oc_anchor:ByCreateTimeAsc:1500:")), "后半段按时间正序取");
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

test("空结果提示", async () => {
	const { deps } = fakeDeps([]);
	const r = await toolOf(deps).execute({}, api, context);
	assert.match(out(r as never), /没有可读消息/);
});
