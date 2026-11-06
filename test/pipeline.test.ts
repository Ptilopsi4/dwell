// node --test "test/pipeline.test.ts"
// 消息管线判定表：groupAdmits / emptyReply / fallbackRoute / messageAction（无副作用判定，行为与 index.ts 抽取前一致）
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupAdmits, emptyReply, fallbackRoute, messageAction } from "../src/pipeline.ts";
import type { NormalizedMessage } from "../src/feishu/channel.ts";

const msg = (partial: Partial<NormalizedMessage>): NormalizedMessage =>
	({
		messageId: "om_1",
		chatId: "oc_1",
		chatType: "p2p",
		senderId: "ou_1",
		content: "",
		rawContentType: "text",
		resources: [],
		mentions: [],
		mentionAll: false,
		mentionedBot: false,
		createTime: 0,
		...partial,
	}) as NormalizedMessage;

const anchored = (hits: string[]) => (messageId: string) => hits.includes(messageId);

test("groupAdmits：私聊不受 mention 门限制", () => {
	assert.equal(groupAdmits(msg({ chatType: "p2p" }), anchored([])), true);
});

test("groupAdmits：群聊已 @bot 放行", () => {
	assert.equal(groupAdmits(msg({ chatType: "group", mentionedBot: true }), anchored([])), true);
});

test("groupAdmits：群未 @ 但在话题内放行", () => {
	assert.equal(groupAdmits(msg({ chatType: "group", threadId: "om_root" }), anchored([])), true);
});

test("groupAdmits：群未 @ 回复已锚定消息放行", () => {
	assert.equal(groupAdmits(msg({ chatType: "group", replyToMessageId: "om_a" }), anchored(["om_a"])), true);
});

test("groupAdmits：群未 @ 回复未锚定消息拒绝", () => {
	assert.equal(groupAdmits(msg({ chatType: "group", replyToMessageId: "om_a" }), anchored([])), false);
});

test("groupAdmits：群未 @ 平消息拒绝", () => {
	assert.equal(groupAdmits(msg({ chatType: "group" }), anchored([])), false);
});

test("emptyReply：有资源继续处理", () => {
	assert.equal(emptyReply(msg({ resources: [{ type: "image", fileKey: "img_v2_1" }] })), null);
});

test("emptyReply：纯空白 text 静默丢弃", () => {
	assert.equal(emptyReply(msg({ content: "  \n\t " })), "ignore");
});

test("emptyReply：空内容 post/其他类型回不支持提示", () => {
	assert.equal(emptyReply(msg({ rawContentType: "post", content: "" })), "unsupported");
	assert.equal(emptyReply(msg({ rawContentType: "audio", content: "" })), "unsupported");
});

test("emptyReply：有文本继续处理", () => {
	assert.equal(emptyReply(msg({ content: " hi " })), null);
});

test("fallbackRoute：p2p 路由 direct，replyTo 未命中才 degraded", () => {
	assert.deepEqual(fallbackRoute(msg({ chatType: "p2p" })), { kind: "direct", degraded: false });
	assert.deepEqual(fallbackRoute(msg({ chatType: "p2p", replyToMessageId: "om_a" })), { kind: "direct", degraded: true });
});

test("fallbackRoute：话题路由 thread，即使带 replyTo 也不 degraded", () => {
	assert.deepEqual(fallbackRoute(msg({ chatType: "group", threadId: "om_t" })), { kind: "thread", threadId: "om_t", degraded: false });
	assert.deepEqual(fallbackRoute(msg({ chatType: "group", threadId: "om_t", replyToMessageId: "om_a" })), { kind: "thread", threadId: "om_t", degraded: false });
});

test("fallbackRoute：群平消息路由 group，replyTo 未命中才 degraded", () => {
	assert.deepEqual(fallbackRoute(msg({ chatType: "group" })), { kind: "group", degraded: false });
	assert.deepEqual(fallbackRoute(msg({ chatType: "group", replyToMessageId: "om_a" })), { kind: "group", degraded: true });
});

test("messageAction：已知命令（含带参数）→ command", () => {
	assert.equal(messageAction("/help", false), "command");
	assert.equal(messageAction("/approve 30", false), "command");
});

test("messageAction：未知斜杠文本（路径）当普通输入", () => {
	assert.equal(messageAction("/usr/bin 下有什么", false), "input");
	assert.equal(messageAction("/helpx", false), "input");
});

test("messageAction：有资源 + 普通文本 → media", () => {
	assert.equal(messageAction("看这张图", true), "media");
});

test("messageAction：命令优先于媒体（带资源的命令仍走命令）", () => {
	assert.equal(messageAction("/new", true), "command");
});
