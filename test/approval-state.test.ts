// node --test "test/approval-state.test.ts"
// 审批状态持久化往返。DWELL_STATE 必须在 state.ts 求值前设置：只用动态 import，静态依赖限 node 内置（test/assert/fs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("窗口/待审/归属持久化往返，过期窗口不复活", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-aps-"));
	process.env.DWELL_STATE = dir;
	const approval = await import("../src/ext/approval.ts");

	approval.runSender.set(7, "ou_sender");
	approval.runVia.set(7, "panel");
	approval.approvals.set("7:ou_sender", Date.now() + 60_000);
	approval.approvals.set("8:ou_old", Date.now() - 1_000); // 已过期
	approval.pendingApprovals.set("7:ou_sender", { command: "rm -rf /tmp/x", match: "rm 递归强删", trigger: "ou_sender", via: "panel", cardMessageId: "om_card" });
	await approval.persistApprovals();

	// 落盘内容形状
	const saved = JSON.parse(await readFile(join(dir, "approvals.json"), "utf8")) as { windows: [string, number][]; pending: [string, unknown][]; runSender: [string, string][] };
	assert.equal(saved.windows.length, 2);
	assert.equal(saved.pending.length, 1);
	assert.deepEqual(saved.runSender, [["7", "ou_sender"]]);

	// 模拟重启：清空后从盘恢复
	approval.runSender.clear();
	approval.runVia.clear();
	approval.approvals.clear();
	approval.pendingApprovals.clear();
	await approval.loadApprovalState();
	assert.equal(approval.runSender.get(7), "ou_sender");
	assert.equal(approval.runVia.get(7), "panel");
	assert.equal(approval.approvals.has("8:ou_old"), false, "过期窗口不复活");
	assert.equal(approval.approvals.has("7:ou_sender"), true);
	assert.equal(approval.pendingApprovals.get("7:ou_sender")?.cardMessageId, "om_card");
});
