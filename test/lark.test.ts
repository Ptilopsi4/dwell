// node --test "test/lark.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLarkExtension, type LarkDeps } from "../src/ext/lark.ts";

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

function toolOf(deps: LarkDeps) {
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

test("around：get 定位后前后拼装去重（同会话）", async () => {
	const { deps, calls } = fakeDeps(
		[{ message_id: "om_1" }, { message_id: "om_2" }, { message_id: "om_3" }],
		{ message_id: "om_2", create_time: "1500", chat_id: "oc_current" },
	);
	const r = await toolOf(deps).execute({ around: "om_2", count: 10 }, api, context);
	assert.ok(calls.includes("get:om_2"));
	assert.ok(calls.some((c) => c.startsWith("list:oc_current:ByCreateTimeDesc::1500")), "前半段按时间倒序取");
	// Asc + start_time 必须显式带 end_time，否则飞书默认 end=0 报 230001（历史假修复，回归断言）
	const after = calls.find((c) => c.startsWith("list:oc_current:ByCreateTimeAsc:1500:"));
	assert.ok(after !== undefined && after.split(":")[4] !== "", "后半段必须携带 end_time");
	assert.ok(out(r as never).includes("最近消息"));
});

test("跨会话读取（chat/around 指向别的会话）仅管理员放行", async () => {
	const anchorOther = { message_id: "om_2", create_time: "1500", chat_id: "oc_other" };
	// 普通成员：chat 参数直指他群 → 拒绝
	let deps: LarkDeps = fakeDeps([], anchorOther).deps;
	let r = await toolOf(deps).execute({ chat: "oc_other" }, api, context);
	assert.match(out(r as never), /仅管理员可用/);
	// 普通成员：around 锚点落在他群 → 拒绝（list 不应发出）
	deps = fakeDeps([], anchorOther).deps;
	r = await toolOf({ ...deps, senderOf: () => "ou_member", isAdmin: () => false }).execute({ around: "om_2" }, api, context);
	assert.match(out(r as never), /仅管理员可用/);
	// 管理员：around 跨群放行
	deps = fakeDeps([{ message_id: "om_1" }], anchorOther).deps;
	r = await toolOf({ ...deps, senderOf: () => "ou_admin", isAdmin: (id: string) => id === "ou_admin" }).execute({ around: "om_2" }, api, context);
	assert.match(out(r as never), /最近消息/);
	// 无发起者信息（重启后归属缺失）：从严拒绝
	deps = fakeDeps([], anchorOther).deps;
	r = await toolOf({ ...deps, isAdmin: () => true }).execute({ chat: "oc_other" }, api, context);
	assert.match(out(r as never), /仅管理员可用/);
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

// ── dwell.lark.image：按消息 id 按需识图 ──
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);

function imageDeps(item: Item | undefined, describer: ((b64: string, mime: string) => Promise<string>) | null = async () => "一张测试图：内容 X") {
	const calls: string[] = [];
	return {
		calls,
		deps: {
			getClient: () => ({
				im: {
					v1: {
						message: {
							get: async ({ path }: { path: { message_id: string } }) => {
								calls.push(`get:${path.message_id}`);
								return { code: 0, data: { items: item !== undefined ? [item] : [] } };
							},
						},
						messageResource: {
							get: async ({ path }: { path: { message_id: string; file_key: string } }) => {
								calls.push(`res:${path.message_id}:${path.file_key}`);
								return { getReadableStream: () => (async function* () { yield PNG; })() };
							},
						},
					},
				},
			}),
			getDirectory: () => undefined,
			chatOf: () => undefined,
			getDescriber: () => describer,
		},
	};
}

function imageToolOf(deps: ReturnType<typeof imageDeps>["deps"]) {
	const tool = makeLarkExtension(deps).tools?.find((t) => t.name === "dwell.lark.image");
	if (tool === undefined) throw new Error("工具未注册");
	return tool;
}

test("image：下载图片并返回描述", async () => {
	const { deps, calls } = imageDeps({ message_id: "om_img", msg_type: "image", body: { content: JSON.stringify({ image_key: "img_v2_k" }) } });
	const r = await imageToolOf(deps).execute({ message: "om_img" }, api, context);
	assert.match(out(r as never), /一张测试图/);
	assert.ok(calls.includes("res:om_img:img_v2_k"), "走消息资源接口下载");
});

test("image：表情包/非图片/无描述器/消息不存在各给诚实提示", async () => {
	const run = async (item: Item | undefined, describer: ((b: string, m: string) => Promise<string>) | null, re: RegExp) => {
		const r = await imageToolOf(imageDeps(item, describer).deps).execute({ message: "om_x" }, api, context);
		assert.match(out(r as never), re);
	};
	await run({ message_id: "om_x", msg_type: "sticker" }, async () => "", /表情包，暂不支持/);
	await run({ message_id: "om_x", msg_type: "text" }, async () => "", /不是图片/);
	await run({ message_id: "om_img", msg_type: "image", body: { content: JSON.stringify({ image_key: "k" }) } }, null, /未配置视觉模型/);
	await run(undefined, async () => "", /不存在或 bot 无权读取/);
});
