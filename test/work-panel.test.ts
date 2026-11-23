import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { WorkDoc } from "../src/ext/work.ts";
import { startPanel } from "../src/web/server.ts";

test("work panel goal requests establish the record directly and the sheet serves the fire-and-forget shape", async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	const before = process.env.DWELL_PANEL_ONLY;
	process.env.DWELL_PANEL_ONLY = "1";
	const server = startPanel({
		harness, sessions: {} as never, users: {} as never, directory: {} as never,
		feishu: { operator: () => "tg:700", status: () => "off", relay: async () => {}, notice: async () => {}, notifyPanel: async () => {}, decide: async () => ({ ok: true }) },
		port: 0, describer: () => null, sandbox: () => false, saveUpload: async () => { throw new Error("Not used by this test"); },
	});
	if (before === undefined) delete process.env.DWELL_PANEL_ONLY; else process.env.DWELL_PANEL_ONLY = before;
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const post = (path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json", origin: base }) =>
		fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
	// 描述必填：缺失、空白与超长目标都被拒绝
	for (const invalid of [
		{ id: conversation.id, workId: null, requestId: "panel-goal" },
		{ id: conversation.id, workId: null, requestId: "panel-goal", goal: "   " },
		{ id: conversation.id, workId: null, requestId: "panel-goal", goal: "x".repeat(4001) },
	]) assert.equal((await post("/api/work/goal", invalid)).status, 400);
	assert.equal(await harness.snapshot(WorkDoc, conversation.id, context), undefined, "rejected requests must not create a work record");
	assert.equal((await post("/api/work/accept", { id: conversation.id, workId: "work", operator: "untrusted-body" }, { "content-type": "text/plain" })).status, 415);
	// 验收路由已删：请求落入未知路径
	const accept = await post("/api/work/accept", { id: conversation.id, workId: "work", operator: "untrusted-body" });
	assert.equal(accept.status, 404);
	assert.deepEqual(await accept.json(), { error: "not found" });
	assert.equal((await fetch(`${base}/api/work?id=invalid`)).status, 400);
	assert.equal((await fetch(`${base}/api/work?id=999999`)).status, 404);

	const response = await post("/api/work/goal", { id: conversation.id, workId: null, requestId: "panel-goal", goal: "Ship the panel report" });
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.equal(result.changed, false);
	assert.ok(result.created);
	const saved = await (await fetch(`${base}/api/work?id=${conversation.id}`)).json();
	assert.equal(saved.current, result.created);
	const record = saved.records[result.created];
	assert.equal(record.goal, "Ship the panel report");
	assert.equal(record.creator, "tg:700", "the sheet exposes the configured operator as the record creator");
	assert.equal(record.status, "active");
	assert.equal(record.progress, "");
	assert.deepEqual(record.blockers, []);
	assert.equal(record.usage.pricingKnown, false);
	assert.equal(record.usage.cost, null);
});
