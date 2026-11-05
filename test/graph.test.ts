// node --test "test/graph.test.ts"
// busyConversations：taskGraph 节点状态在 state.status（回归：曾按 t.status 读，恒 undefined 致 busy 恒空）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { busyConversations } from "../src/harness.ts";
import type { TaskGraph } from "@earendil-works/pi-durable";

const node = (conversationId: number, status: string): unknown => ({ id: "1", kind: "tool", conversationId, background: false, abortRequested: false, state: { status, phase: "x" }, conversations: [] });

test("活跃状态聚合到会话集合（state.status，不是 status）", () => {
	const graph = {
		tasks: {
			"1": node(11, "running") as never,
			"2": node(12, "sleeping") as never,
			"3": node(13, "completing") as never,
			"4": node(14, "done") as never,
		},
	} as TaskGraph;
	const busy = busyConversations(graph);
	assert.deepEqual([...busy].sort(), [11, 12, 13]);
});

test("同一会话多节点只计一次；pending/waiting 也算活跃", () => {
	const graph = {
		tasks: {
			"1": node(21, "pending") as never,
			"2": node(21, "waiting") as never,
			"3": node(22, "faulted") as never,
		},
	} as TaskGraph;
	assert.deepEqual([...busyConversations(graph)], [21]);
});

test("空图/undefined 安全返回空集合", () => {
	assert.equal(busyConversations(undefined).size, 0);
	assert.equal(busyConversations({ tasks: {} } as TaskGraph).size, 0);
});
