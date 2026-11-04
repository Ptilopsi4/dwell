// node --test "test/mention.test.ts"
// matchMention：/allow /disallow 的 @提及参数解析（SDK 会把占位符 @_user_N 渲染成 @名字）
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchMention } from "../src/feishu/channel.ts";
import type { MentionInfo } from "../src/feishu/channel.ts";

const m = (key: string, name: string | undefined, openId?: string, isBot = false): MentionInfo => ({ key, name, openId, isBot });

test("渲染名精确匹配（SDK 已替换占位符的常态）", () => {
	assert.deepEqual(
		matchMention("@s3loy", [m("@_user_1", "dwell", "ou_bot", true), m("@_user_2", "s3loy", "ou_1")]),
		{ id: "ou_1", name: "s3loy" },
	);
});

test("渲染名前缀匹配（名字后跟补充文字）", () => {
	assert.deepEqual(matchMention("@s3loy（唐帅）", [m("@_user_2", "s3loy", "ou_1")]), { id: "ou_1", name: "s3loy" });
});

test("占位 key 精确匹配（未被替换的原始形态兜底）", () => {
	assert.deepEqual(matchMention("@_user_2", [m("@_user_2", "s3loy", "ou_1")]), { id: "ou_1", name: "s3loy" });
});

test("无匹配返回 null", () => {
	assert.equal(matchMention("@nobody", [m("@_user_2", "s3loy", "ou_1")]), null);
	assert.equal(matchMention("ou_xxx", [m("@_user_2", "s3loy", "ou_1")]), null);
});

test("bot 提及与 @_all 不作为目标", () => {
	assert.equal(matchMention("@dwell", [m("@_user_1", "dwell", "ou_bot", true)]), null);
	assert.equal(matchMention("@_all", [m("@_all", undefined)]), null);
});

test("前缀歧义返回 null（防授权给错人）", () => {
	// "@alex_x" 同时以 "@alex" 和 "@ale" 开头，无法判定指向谁
	assert.equal(matchMention("@alex_x", [m("@_user_1", "ale", "ou_1"), m("@_user_2", "alex", "ou_2")]), null);
	// 无歧义时同样的两个提及可命中
	assert.deepEqual(matchMention("@ale！", [m("@_user_1", "ale", "ou_1"), m("@_user_2", "alex", "ou_2")]), { id: "ou_1", name: "ale" });
});
