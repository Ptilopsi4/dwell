// node --test test/ 下运行：npx tsx 不可用，直接 node --test（type stripping）
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMessage } from "../src/feishu/reply.ts";

test("短文本不分段", () => {
	assert.deepEqual(splitMessage("hello"), ["hello"]);
	assert.deepEqual(splitMessage("x".repeat(3800)), ["x".repeat(3800)]);
});

test("超长文本按段落边界切", () => {
	const para = "第一段内容。\n\n";
	const text = para.repeat(600); // 4800 字符
	const parts = splitMessage(text);
	assert.ok(parts.length >= 2);
	assert.ok(parts.every((p) => p.length <= 3800));
	assert.equal(parts.join(""), text);
});

test("无边界时硬切", () => {
	const text = "a".repeat(5000);
	const parts = splitMessage(text);
	assert.equal(parts.length, 2);
	assert.equal(parts[0].length, 3800);
	assert.equal(parts.join(""), text);
});

test("按句号优先切分且内容无损", () => {
	const sentence = "这是一句话。";
	const text = sentence.repeat(900); // 4500 字符，无换行
	const parts = splitMessage(text);
	assert.ok(parts.length >= 2);
	assert.ok(parts.every((p) => p.length <= 3800));
	assert.equal(parts.join(""), text);
});
