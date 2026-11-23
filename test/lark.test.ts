// node --test "test/lark.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeLarkExtension, type LarkDeps } from "../src/ext/lark.ts";
import { downloadMessageResource, type LarkChannel, type SendInput } from "../src/feishu/channel.ts";

type Item = { message_id: string; msg_type?: string; create_time?: string; chat_id?: string; deleted?: boolean; body?: { content?: string }; sender?: { id?: string; sender_type?: string }; senderName?: string };

function fakeDeps(items: Item[], anchor?: Item) {
	const calls: string[] = [];
	const listParams: Record<string, unknown>[] = [];
	return {
		calls,
		listParams,
		deps: {
			getClient: () => ({
				im: {
					v1: {
						message: {
							list: async ({ params }: { params: Record<string, unknown> }) => {
								calls.push(`list:${params.container_id}:${params.sort_type ?? ""}:${params.start_time ?? ""}:${params.end_time ?? ""}`);
								listParams.push(params);
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
	const { deps, listParams } = fakeDeps([
		{ message_id: "om_b", msg_type: "text", create_time: "2000", body: { content: JSON.stringify({ text: "第二条" }) }, sender: { id: "ou_2" }, senderName: "李四" },
		{ message_id: "om_a", msg_type: "text", create_time: "1000", body: { content: JSON.stringify({ text: "第一条" }) }, sender: { id: "ou_1" }, senderName: "张三" },
	]);
	const r = await toolOf(deps).execute({}, api, context);
	const text = out(r as never);
	assert.match(text, /Recent messages in .*\(oldest first/);
	assert.ok(text.indexOf("张三 (om_a): 第一条") < text.indexOf("李四 (om_b): 第二条"), "正序排列");
	assert.equal(listParams[0]?.card_msg_content_type, "raw_card_content", "list 请求卡片实体当前内容");
});

test("媒体与富文本占位/截断", async () => {
	const long = "x".repeat(300);
	const cardLong = { schema: "2.0", body: { elements: [{ tag: "markdown", content: "y".repeat(300) }] } };
	const { deps } = fakeDeps([
		{ message_id: "om_i", msg_type: "image", create_time: "1000" },
		{ message_id: "om_t", msg_type: "text", create_time: "2000", body: { content: JSON.stringify({ text: long }) }, senderName: "A" },
		{ message_id: "om_k", msg_type: "interactive", create_time: "3000", body: { content: JSON.stringify(cardLong) }, sender: { id: "cli_other", sender_type: "app" }, senderName: "B" },
	]);
	const r = await toolOf({ ...deps, getSelfAppId: () => "app_self" }).execute({ count: 3 }, api, context);
	const text = out(r as never);
	assert.match(text, /\[image\]/);
	assert.match(text, new RegExp(`x{200}…`)); // text 单条截 200 字
	assert.match(text, new RegExp(`y{300}`)); // 卡片截断上限 1000，300 字不截
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
	assert.ok(out(r as never).includes("Recent messages"));
});

test("跨会话读取（chat/around 指向别的会话）仅管理员放行", async () => {
	const anchorOther = { message_id: "om_2", create_time: "1500", chat_id: "oc_other" };
	// 普通成员：chat 参数直指他群 → 拒绝
	let deps: LarkDeps = fakeDeps([], anchorOther).deps;
	let r = await toolOf(deps).execute({ chat: "oc_other" }, api, context);
	assert.match(out(r as never), /admin-only/);
	// 普通成员：around 锚点落在他群 → 拒绝（list 不应发出）
	deps = fakeDeps([], anchorOther).deps;
	r = await toolOf({ ...deps, senderOf: () => "ou_member", isAdmin: () => false }).execute({ around: "om_2" }, api, context);
	assert.match(out(r as never), /admin-only/);
	// 管理员：around 跨群放行
	deps = fakeDeps([{ message_id: "om_1" }], anchorOther).deps;
	r = await toolOf({ ...deps, senderOf: () => "ou_admin", isAdmin: (id: string) => id === "ou_admin" }).execute({ around: "om_2" }, api, context);
	assert.match(out(r as never), /Recent messages/);
	// 无发起者信息（重启后归属缺失）：从严拒绝
	deps = fakeDeps([], anchorOther).deps;
	r = await toolOf({ ...deps, isAdmin: () => true }).execute({ chat: "oc_other" }, api, context);
	assert.match(out(r as never), /admin-only/);
});

test("panel 会话（无对应 chat）给明确提示", async () => {
	const { deps } = fakeDeps([]);
	const r = await toolOf(deps).execute({}, { conversationId: 99 } as never, context);
	assert.match(out(r as never), /panel task.*no Feishu chat/);
});

test("Telegram conversations cannot read Feishu history even as an administrator", async () => {
	let clientAccesses = 0;
	const deps: LarkDeps = {
		getClient: () => { clientAccesses++; throw new Error("must not access Feishu"); },
		getDirectory: () => undefined,
		chatOf: () => undefined,
		destinationOf: () => ({ kind: "telegram", botId: "1", chatId: "2" }),
		senderOf: () => "tg:123",
		isAdmin: () => true,
	};
	for (const args of [{}, { chat: "oc_other" }, { around: "om_other" }]) {
		const r = await toolOf(deps).execute(args, api, context);
		assert.equal((r as { isError?: boolean }).isError, true);
		assert.match(out(r as never), /Feishu chat history is unavailable in Telegram/);
	}
	assert.equal(clientAccesses, 0);
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

test("卡片消息：自家卡默认占位可指引展开，其他 bot 卡提取正文（i18n/summary 不混入）", async () => {
	const streamCard = { schema: "2.0", config: { summary: { content: "[Generating...]" } }, body: { elements: [{ tag: "markdown", element_id: "stream_md", content: "值班日报：一切正常" }, { tag: "button", text: { text: "查看详情" } }] }, i18n_body: { elements: [{ tag: "markdown", content: "值班日报：一切正常" }] } };
	const botCard = { schema: "2.0", body: { elements: [{ tag: "markdown", content: { text: "外 bot 卡正文" } }] } };
	const { deps } = fakeDeps([
		// 自家流式卡：消息体只有 card_id 引用，正文内联在 json_card 字符串（卡片实体当前状态）
		{ message_id: "om_self", msg_type: "interactive", create_time: "1000", body: { content: JSON.stringify({ type: "card", data: { card_id: "ctm_x" }, json_card: JSON.stringify(streamCard) }) }, sender: { id: "app_self", sender_type: "app" } },
		{ message_id: "om_bot", msg_type: "interactive", create_time: "2000", body: { content: JSON.stringify(botCard) }, sender: { id: "cli_other", sender_type: "app" }, senderName: "日报机器人" },
		{ message_id: "om_user", msg_type: "interactive", create_time: "3000", body: { content: JSON.stringify({ elements: [[{ tag: "div", text: { tag: "lark_md", content: "标题：值班日报" } }]] }) }, sender: { id: "ou_9" }, senderName: "王五" },
	]);
	const own = { ...deps, getSelfAppId: () => "app_self" };
	let r = await toolOf(own).execute({ count: 3 }, api, context);
	let text = out(r as never);
	assert.match(text, /om_self.*\[dwell reply card; pass ownCards: true to read its text\]/); // 默认占位，不误读不胀 token
	assert.doesNotMatch(text, /一切正常/);
	assert.match(text, /日报机器人 \(om_bot\): 外 bot 卡正文/); // 其他 bot 卡照旧提取
	assert.match(text, /王五.*值班日报/); // 用户卡照旧提取
	// ownCards: true → 自家流式卡提取 json_card 正文（含按钮文字），summary 占位与 i18n 副本不混入
	r = await toolOf(own).execute({ count: 3, ownCards: true }, api, context);
	text = out(r as never);
	assert.match(text, /om_self.*值班日报：一切正常 查看详情/);
	assert.doesNotMatch(text, /Generating/);
	assert.equal(text.match(/一切正常/g)?.length, 1, "i18n 副本不重复拼入");
});

test("别家 bot 的卡提取不到正文时诚实占位；selfAppId 缺失时 app 卡保守占位", async () => {
	const { deps } = fakeDeps([
		{ message_id: "om_x", msg_type: "interactive", create_time: "1000", body: { content: JSON.stringify({ schema: "2.0", config: {} }) }, sender: { id: "cli_other", sender_type: "app" }, senderName: "某 bot" },
		{ message_id: "om_y", msg_type: "interactive", create_time: "2000", body: { content: JSON.stringify({ type: "card", data: { card_id: "ctm_y" } }) }, sender: { id: "app_self", sender_type: "app" } },
		// json_card 非法 JSON：catch 后保留原结构，提取为空 → 同缺失路径诚实占位
		{ message_id: "om_z", msg_type: "interactive", create_time: "3000", body: { content: JSON.stringify({ json_card: "{not json" }) }, sender: { id: "cli_other", sender_type: "app" }, senderName: "某 bot" },
	]);
	let r = await toolOf({ ...deps, getSelfAppId: () => "app_self" }).execute({ count: 3 }, api, context);
	assert.equal(out(r as never).match(/\[card from another bot; content not readable\]/g)?.length, 2);
	// ownCards 下自家卡提取不到也诚实占位（消息体只剩 card_id 引用、json_card 缺失时）
	r = await toolOf({ ...deps, getSelfAppId: () => "app_self" }).execute({ count: 3, ownCards: true }, api, context);
	assert.match(out(r as never), /\[dwell reply card; content not readable\]/);
	// selfAppId 拿不到（异常装配）：app 卡无法区分归属，保守占位
	r = await toolOf(deps).execute({ count: 3 }, api, context);
	assert.match(out(r as never), /\[dwell reply card; pass ownCards/);
});

test("空结果提示", async () => {
	const { deps } = fakeDeps([]);
	const r = await toolOf(deps).execute({}, api, context);
	assert.match(out(r as never), /No readable messages/);
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

test("image：超过 10MB 的图在流式读取阶段即拒绝，不整图缓冲也不调用视觉", async () => {
	const { deps } = imageDeps({ message_id: "om_big", msg_type: "image", body: { content: JSON.stringify({ image_key: "img_big" }) } });
	let described = 0;
	const base = deps.getClient()!;
	const client = { ...base, im: { ...base.im, v1: { ...base.im.v1, messageResource: { get: async () => ({ getReadableStream: () => (async function* () { for (let i = 0; i < 12; i++) yield Buffer.alloc(1024 * 1024, 0x89); })() }) } } } } as unknown as typeof base;
	const r = await imageToolOf({ ...deps, getClient: () => client, getDescriber: () => async () => { described++; return "x"; } }).execute({ message: "om_big" }, api, context);
	assert.match(out(r as never), /larger than 10MB/);
	assert.equal(described, 0);
});

test("downloadMessageResource：流式计数超过上限即停止读取并抛错，未超限完整返回", async () => {
	const chunk = Buffer.alloc(1024 * 1024, 1);
	let pulled = 0;
	const stream = (count: number) => ({ getReadableStream: () => (async function* () { for (let i = 0; i < count; i++) { pulled++; yield chunk; } })() });
	const channel = (count: number) => ({ rawClient: { im: { v1: { messageResource: { get: async () => stream(count) } } } } }) as unknown as LarkChannel;
	await assert.rejects(downloadMessageResource(channel(30), "om_1", "file_1", "file", 5 * 1024 * 1024), /超过 5MB 上限/);
	assert.ok(pulled <= 6, `reading must stop at the cap, pulled ${pulled}`);
	assert.equal((await downloadMessageResource(channel(2), "om_1", "file_1", "file", 5 * 1024 * 1024)).length, 2 * 1024 * 1024);
});

test("image：表情包/非图片/无描述器/消息不存在各给诚实提示", async () => {
	const run = async (item: Item | undefined, describer: ((b: string, m: string) => Promise<string>) | null, re: RegExp) => {
		const r = await imageToolOf(imageDeps(item, describer).deps).execute({ message: "om_x" }, api, context);
		assert.match(out(r as never), re);
	};
	await run({ message_id: "om_x", msg_type: "sticker" }, async () => "", /sticker, which cannot be recognized/);
	await run({ message_id: "om_x", msg_type: "text" }, async () => "", /not an image/);
	await run({ message_id: "om_img", msg_type: "image", body: { content: JSON.stringify({ image_key: "k" }) } }, null, /No vision model is configured/);
	await run(undefined, async () => "", /does not exist or the bot cannot read it/);
});

test("Telegram conversations cannot look up Feishu images even as an administrator", async () => {
	let clientAccesses = 0;
	const extension = makeLarkExtension({
		getClient: () => { clientAccesses++; throw new Error("must not access Feishu"); },
		getDirectory: () => undefined,
		chatOf: () => undefined,
		destinationOf: () => ({ kind: "telegram", botId: "1", chatId: "2" }),
		senderOf: () => "tg:123",
		isAdmin: () => true,
	});
	const tool = extension.tools?.find((tool) => tool.name === "dwell.lark.image");
	assert.ok(tool);
	const r = await tool.execute({ message: "om_other" }, api, context);
	assert.equal((r as { isError?: boolean }).isError, true);
	assert.match(out(r as never), /Feishu image lookup applies to Feishu messages only/);
	assert.equal(clientAccesses, 0);
});
