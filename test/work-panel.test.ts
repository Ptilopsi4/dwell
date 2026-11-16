import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { WorkDoc, type WorkRecord } from "../src/ext/work.ts";
import { startPanel } from "../src/web/server.ts";

test("work acceptance requires the trusted panel route and records its operator rather than a body identity", async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	const record: WorkRecord = {
		id: "work-review", creator: "tg:300", goal: "Verify the report", acceptance: ["The report matches the fixture"], progress: "Ready for operator review", blockers: [], evidence: [], review: "Review the generated report", status: "ready_for_review", createdAt: 1, updatedAt: 1,
		limits: { modelAdmissions: 128, toolAdmissions: 512 }, availableEvidence: {}, members: {}, tasks: {},
		usage: { scope: "generation_and_tools", pricingKnown: false, modelAdmissions: 0, toolAdmissions: 0, modelResponses: 0, toolResults: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: null },
	};
	await harness.commit(async (tx) => { const doc = await tx.doc(WorkDoc, conversation.id); doc.current = record.id; doc.records[record.id] = record; }, context);
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
	const body = JSON.stringify({ id: conversation.id, workId: record.id, operator: "untrusted-body" });
	assert.equal((await fetch(base + "/api/work/accept", { method: "POST", headers: { "content-type": "text/plain" }, body })).status, 415);
	assert.equal((await fetch(base + "/api/work/accept", { method: "POST", headers: { "content-type": "application/json", origin: "https://untrusted.example" }, body })).status, 403);
	assert.equal((await harness.snapshot(WorkDoc, conversation.id, context))?.records[record.id].status, "ready_for_review");
	assert.equal((await fetch(base + "/api/work?id=invalid")).status, 400);
	assert.equal((await fetch(base + "/api/work?id=999999")).status, 404);
	const result = await fetch(base + "/api/work/accept", { method: "POST", headers: { "content-type": "application/json", origin: base }, body });
	assert.equal(result.status, 200);
	assert.equal((await result.json()).acceptedBy, "tg:700");
	const saved = await (await fetch(base + `/api/work?id=${conversation.id}`)).json();
	assert.equal(saved.records[record.id].status, "accepted");
	assert.equal(saved.records[record.id].acceptedBy, "tg:700");
	const duplicate = await fetch(base + "/api/work/accept", { method: "POST", headers: { "content-type": "application/json" }, body });
	assert.equal(duplicate.status, 409);
	assert.match((await duplicate.json()).error, /工作状态已变化，请刷新记录/);
	const missing = await fetch(base + "/api/work/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: conversation.id, workId: "missing" }) });
	assert.equal(missing.status, 409);
	assert.match((await missing.json()).error, /工作记录不存在，请刷新记录/);
});
