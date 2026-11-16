import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { presentPanelEntry } from "../src/web/server.ts";

for (const [detail, expected] of [
	['HTTP 401 {"message":"private-provider-body; credential=secret"}', "模型连接认证失败"],
	['HTTP 403 {"message":"private-provider-body; credential=secret"}', "模型服务拒绝访问"],
	['unrecognized private-provider-body; credential=secret', "模型请求未完成"],
] as const) test(`panel presents stored model failures as ${expected} without exposing provider diagnostics`, () => {
	const entry: EntryRecord = {
		id: 1 as EntryId, conversationId: 2 as ConversationId, kind: "pi.assistant",
		model: [fauxAssistantMessage(fauxText("Current partial answer."), { stopReason: "error", errorMessage: detail })],
	};
	const presented = presentPanelEntry(entry);
	const message = presented.model?.[0];
	assert.ok(message?.role === "assistant");
	assert.match(message.errorMessage ?? "", new RegExp(expected));
	assert.deepEqual(message.content, entry.model?.[0].content, "Current assistant output must remain visible");
	assert.doesNotMatch(JSON.stringify(presented), /private-provider-body|credential=secret/);
	const original = entry.model?.[0];
	assert.ok(original?.role === "assistant");
	assert.equal(original.errorMessage, detail, "Presentation must retain the original diagnostic in durable storage");
});
