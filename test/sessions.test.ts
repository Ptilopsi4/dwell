// node --test "test/sessions.test.ts"
// allocateEmoji：群平消息线标签 emoji 的唯一分配（同 chat 域内）
import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateEmoji, LINE_EMOJI_POOL } from "../src/sessions.ts";

test("未占用优先：依次分配不重复", () => {
	const active: { id: number; emoji?: string; lastTs: number }[] = [];
	const got: string[] = [];
	for (let i = 1; i <= 5; i++) {
		const r = allocateEmoji(active);
		got.push(r.emoji);
		active.push({ id: i, emoji: r.emoji, lastTs: i });
	}
	assert.equal(new Set(got).size, 5);
});

test("已占用的 emoji 不再分配", () => {
	const r = allocateEmoji([{ id: 1, emoji: "🔵", lastTs: 1 }, { id: 2, emoji: "🟢", lastTs: 2 }]);
	assert.ok(!["🔵", "🟢"].includes(r.emoji));
});

test("池满转移最久未活跃线的 emoji", () => {
	const r = allocateEmoji([{ id: 1, emoji: "🔵", lastTs: 100 }, { id: 2, emoji: "🟢", lastTs: 50 }], ["🔵", "🟢"]);
	assert.deepEqual(r, { emoji: "🟢", stealFrom: 2 });
});

test("空线集退化用池首项", () => {
	assert.equal(allocateEmoji([]).emoji, LINE_EMOJI_POOL[0]);
});
