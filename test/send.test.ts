import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFileSendTool, makeSendExtension, type FileSendInput, type SendDeps } from "../src/ext/send.ts";
import { makeLarkExtension } from "../src/ext/lark.ts";
import type { ConversationDestination } from "../src/pipeline.ts";

const context = {} as never;
const api = (cwd: string) => ({ conversationId: 42, env: { cwd } }) as never;
const out = (r: { output?: { text?: string }[] }) => String(r.output?.[0]?.text ?? "");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);
const telegram: ConversationDestination = { kind: "telegram", botId: "bot_1", chatId: "-123", threadId: "7" };

async function tempCwd(t: TestContext): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "dwell-send-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

function sendDeps(destination: ConversationDestination = telegram, result: boolean | { messageId: string } | undefined = { messageId: "sent_1" }) {
	const inputs: { id: number; input: FileSendInput }[] = [];
	const deps: SendDeps = {
		destinationOf: () => destination,
		send: async (id, input) => {
			inputs.push({ id, input });
			return result;
		},
	};
	return { deps, inputs };
}

test("dwell.send delivers Telegram files through the current conversation sender", async (t) => {
	const cwd = await tempCwd(t);
	await writeFile(join(cwd, "report.md"), "# Report");
	const { deps, inputs } = sendDeps();
	const extension = makeSendExtension(deps);
	const tool = extension.tools?.find((tool) => tool.name === "dwell.send");
	assert.ok(tool);
	const r = await tool.execute({ path: "report.md" }, api(cwd), context);
	assert.match(out(r as never), /Sent file report\.md to the current chat/);
	assert.doesNotMatch(out(r as never), /panel/);
	assert.deepEqual(inputs, [{ id: 42, input: { buffer: Buffer.from("# Report"), fileName: "report.md", image: false } }]);
});

test("image detection uses file contents and sends larger images as documents", async (t) => {
	const cwd = await tempCwd(t);
	await writeFile(join(cwd, "chart.bin"), PNG);
	await writeFile(join(cwd, "text.png"), "This is text.");
	const { deps, inputs } = sendDeps();
	const tool = makeFileSendTool(deps);
	await tool.execute({ path: "chart.bin" }, api(cwd), context);
	await tool.execute({ path: "text.png" }, api(cwd), context);
	const handle = await open(join(cwd, "chart.bin"), "r+");
	try {
		await handle.truncate(10 * 1024 * 1024);
		await tool.execute({ path: "chart.bin" }, api(cwd), context);
		await handle.truncate(10 * 1024 * 1024 + 1);
		await tool.execute({ path: "chart.bin" }, api(cwd), context);
	} finally {
		await handle.close();
	}
	assert.deepEqual(inputs.map(({ input }) => input.image), [true, false, true, false]);
});

test("panel offers a validated download without invoking or requiring a chat sender", async (t) => {
	const cwd = await tempCwd(t);
	await writeFile(join(cwd, "report.txt"), "report");
	const { deps, inputs } = sendDeps({ kind: "panel" });
	let r = await makeFileSendTool(deps).execute({ path: "report.txt" }, api(cwd), context);
	assert.match(out(r as never), /Offered as a download in the panel: report\.txt/);
	assert.doesNotMatch(out(r as never), /Sent /);
	assert.equal(inputs.length, 0);
	r = await makeFileSendTool({ destinationOf: () => ({ kind: "panel" }) }).execute({ path: "report.txt" }, api(cwd), context);
	assert.match(out(r as never), /Offered as a download/);
});

test("unconfirmed Telegram delivery never claims success or offers a panel download", async (t) => {
	const cwd = await tempCwd(t);
	await writeFile(join(cwd, "report.txt"), "report");
	for (const result of [false, undefined]) {
		const { deps } = sendDeps();
		deps.send = async () => result;
		const r = await makeFileSendTool(deps).execute({ path: "report.txt" }, api(cwd), context);
		assert.equal((r as { isError?: boolean }).isError, true);
		assert.match(out(r as never), /Telegram.*send failed/);
		assert.doesNotMatch(out(r as never), /Sent |panel/);
	}
	const r = await makeFileSendTool({ destinationOf: () => telegram }).execute({ path: "report.txt" }, api(cwd), context);
	assert.equal((r as { isError?: boolean }).isError, true);
	assert.match(out(r as never), /send path is not wired up/);
});

test("legacy Feishu tool rejects a Telegram destination without falling back to panel", async (t) => {
	const cwd = await tempCwd(t);
	await writeFile(join(cwd, "report.txt"), "report");
	let sent = false;
	const extension = makeLarkExtension({
		getClient: () => undefined,
		getDirectory: () => undefined,
		chatOf: () => undefined,
		destinationOf: () => telegram,
		sendToChat: async () => { sent = true; return { messageId: "om_wrong" }; },
	});
	const tool = extension.tools?.find((tool) => tool.name === "dwell.lark.send");
	assert.ok(tool);
	const r = await tool.execute({ path: "report.txt" }, api(cwd), context);
	assert.equal((r as { isError?: boolean }).isError, true);
	assert.match(out(r as never), /Telegram conversation.*Use dwell\.send/);
	assert.doesNotMatch(out(r as never), /Offered as a download|Sent /);
	assert.equal(sent, false);
});

test("path checks reject traversal, sibling prefixes and symlink escapes before delivery", async (t) => {
	const root = await tempCwd(t);
	const cwd = join(root, "work");
	const sibling = join(root, "work-other");
	await mkdir(cwd);
	await mkdir(sibling);
	await writeFile(join(sibling, "secret.txt"), "outside");
	await symlink(sibling, join(cwd, "outside"), "dir");
	for (const destination of [telegram, { kind: "panel" } as const]) {
		const { deps, inputs } = sendDeps(destination);
		const tool = makeFileSendTool(deps);
		for (const path of ["../work-other/secret.txt", join(sibling, "secret.txt"), "outside/secret.txt", "../missing.txt"]) {
			const r = await tool.execute({ path }, api(cwd), context);
			assert.equal((r as { isError?: boolean }).isError, true);
			assert.match(out(r as never), /denied:/);
		}
		assert.equal(inputs.length, 0);
	}
});

test("a symlinked workspace and links staying inside that workspace can send files", async (t) => {
	const root = await tempCwd(t);
	const cwd = join(root, "actual");
	await mkdir(cwd);
	await writeFile(join(cwd, "report.txt"), "report");
	await symlink(cwd, join(root, "workspace"), "dir");
	await symlink(join(cwd, "report.txt"), join(cwd, "alias.txt"));
	const { deps, inputs } = sendDeps();
	const r = await makeFileSendTool(deps).execute({ path: "alias.txt" }, api(join(root, "workspace")), context);
	assert.match(out(r as never), /Sent file alias\.txt/);
	assert.equal(inputs[0]?.input.buffer.toString(), "report");
});

test("missing files, directories, empty files and oversized files never reach transport", async (t) => {
	const cwd = await tempCwd(t);
	await mkdir(join(cwd, "directory"));
	await writeFile(join(cwd, "empty.txt"), "");
	const handle = await open(join(cwd, "large.bin"), "w");
	await handle.truncate(30 * 1024 * 1024 + 1);
	await handle.close();
	const { deps, inputs } = sendDeps();
	const tool = makeFileSendTool(deps);
	for (const [path, pattern] of [["missing.txt", /Send failed:/], ["directory", /Not a regular file/], ["empty.txt", /empty \(0 bytes\)/], ["large.bin", /exceeds the 30MB limit/]] as const) {
		const r = await tool.execute({ path }, api(cwd), context);
		assert.equal((r as { isError?: boolean }).isError, true);
		assert.match(out(r as never), pattern);
	}
	assert.equal(inputs.length, 0);
});

test("transport errors remain failures and preserve Feishu API error details", async (t) => {
	const cwd = await tempCwd(t);
	await writeFile(join(cwd, "report.txt"), "report");
	for (const destination of [telegram, { kind: "feishu", chatId: "oc_current" } as const]) {
		const { deps } = sendDeps(destination);
		deps.send = async () => { throw new Error("delivery is uncertain"); };
		let r = await makeFileSendTool(deps).execute({ path: "report.txt" }, api(cwd), context);
		assert.equal((r as { isError?: boolean }).isError, true);
		assert.match(out(r as never), /Send failed: delivery is uncertain/);
		assert.doesNotMatch(out(r as never), /Sent |panel/);
		if (destination.kind === "feishu") {
			deps.send = async () => { throw { response: { data: { code: 230002, msg: "no permission" } } }; };
			r = await makeFileSendTool(deps).execute({ path: "report.txt" }, api(cwd), context);
			assert.match(out(r as never), /Send failed: Feishu API 230002: no permission/);
		}
	}
});
