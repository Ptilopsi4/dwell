import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, type Conversation, type HarnessOptions, type JsonObject } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

test("member file scope follows conversation IDs through child environments and SQLite reopen", { skip: process.platform === "win32" ? "POSIX file boundary; Windows fails closed" : false, timeout: 25_000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-member-files-"));
	for (const name of Object.keys(process.env)) if (!["PATH", "HOME", "TMPDIR", "LANG", "TZ"].includes(name)) delete process.env[name];
	process.env.DWELL_DATA = join(directory, "data");
	process.env.DWELL_STATE = join(directory, "state");
	const { openDwell } = await import("../src/harness.ts");
	const { GuardedExecutionEnv } = await import("../src/guarded-env.ts");
	const { BackgroundAnchor } = await import("../src/ext/background.ts");
	const cwd = join(directory, "data/work/member"), sibling = join(directory, "data/work/sibling");
	await mkdir(cwd, { recursive: true }); await mkdir(sibling, { recursive: true });
	await writeFile(join(cwd, "own.txt"), "own workspace");
	await writeFile(join(sibling, "secret.txt"), "other workspace");
	await symlink(join(sibling, "secret.txt"), join(cwd, "outside-file"));
	await symlink(sibling, join(cwd, "outside-directory"));
	const faux = fauxProvider({ tokensPerSecond: 100_000 });
	const models = createModels(); models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const roots = new Set<number>(), parents = new Map<number, number>(), requested: number[] = [];
	const reports: string[] = [];
	let harness: Harness | undefined;
	let factory: NonNullable<HarnessOptions["env"]>;
	const restrictFiles = (id: number) => { requested.push(id); return roots.has(parents.get(id) ?? id); };
	const open = async () => {
		const sdkOpen = Harness.open;
		Harness.open = async (storage, options, openContext) => {
			factory = options.env!;
			return sdkOpen(storage, options, openContext);
		};
		try { harness = await openDwell(models, [], (error) => reports.push(String(error)), undefined, restrictFiles); }
		finally { Harness.open = sdkOpen; }
		harness.resume();
		return harness;
	};
	t.after(async () => { await harness?.close(context); await rm(directory, { recursive: true, force: true }); });
	let active = await open();
	const member = await active.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd } }, context);
	roots.add(member.id);
	const strict = await active.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd: sibling } }, context);
	const environment = async (conversation: Conversation) => {
		const env = await factory!({ conversationId: conversation.id, cwd: (await conversation.agent(context)).cwd, read: active }, context);
		assert.ok(env instanceof GuardedExecutionEnv);
		return env;
	};
	const tool = async (conversation: Conversation, name: string, args: JsonObject) => {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("done")),
		]);
		const result = await (await conversation.submit({ type: "input", content: `${name} ${JSON.stringify(args)}`, entry: { kind: "chat.message", data: { sender: "tg:11", via: "telegram" } } }, context)).wait(context);
		assert.equal(result.status, "done", JSON.stringify(result));
		const messages = (await conversation.context(context)).messages;
		const response = messages.filter((message) => message.role === "toolResult").at(-1);
		assert.ok(response?.role === "toolResult", "The faux model must execute a real tool");
		return response;
	};
	await t.test("ordinary read, directory listing, write and edit stay inside the member workspace", async () => {
		const env = await environment(member);
		try {
			const api = { env } as never;
			assert.deepEqual((await createReadTool().execute({ path: "own.txt" }, api, context as never)).output, [{ type: "text", text: "own workspace" }]);
			assert.ok(getOrThrow(await env.listDir(".", context)).some((entry) => entry.name === "own.txt"));
			await createWriteTool().execute({ path: "nested/result.txt", content: "created" }, api, context as never);
			await createEditTool().execute({ path: "nested/result.txt", edits: [{ oldText: "created", newText: "edited" }] }, api, context as never);
			assert.equal(await readFile(join(cwd, "nested/result.txt"), "utf8"), "edited");
			for (const path of ["../sibling/secret.txt", join(sibling, "secret.txt"), "/etc/hosts", "outside-file", "outside-directory/secret.txt"]) {
				await assert.rejects(createReadTool().execute({ path }, api, context as never), /limited to/);
			}
			for (const path of ["..", sibling, "/etc", "outside-directory"]) {
				const result = await env.listDir(path, context);
				assert.ok(!result.ok && result.error.code === "permission_denied", path);
			}
			await assert.rejects(createWriteTool().execute({ path: join(sibling, "blocked.txt"), content: "blocked" }, api, context as never), /limited to/);
		} finally { await env.cleanup(context); }
		assert.equal((await tool(member, "read", { path: "own.txt" })).isError, false);
		const denied = await tool(member, "read", { path: "/etc/hosts" });
		assert.equal(denied.isError, true);
		assert.match(JSON.stringify(denied.content), /limited to/);
	});
	await t.test("existing strict environments retain ordinary system reads", async () => {
		const env = await environment(strict);
		try {
			assert.equal(getOrThrow(await env.readTextFile("/etc/hosts", context)), await readFile("/etc/hosts", "utf8"));
			assert.ok(getOrThrow(await env.listDir("/etc", context)).length > 0);
		} finally { await env.cleanup(context); }
		assert.equal((await tool(strict, "read", { path: "/etc/hosts" })).isError, false);
	});
	const childId = await member.commit(async (tx) => {
		const anchor = await tx.createTask(BackgroundAnchor, null, { ownership: { kind: "conversation" }, background: true });
		return (await tx.createConversation({ ownership: { kind: "task", taskId: anchor } })).id;
	}, context);
	parents.set(childId, member.id);
	let child = (await active.conversation(childId, context))!;
	await child.configure({ model, cwd }, context);
	await t.test("a background child uses its own ID and the parent scope callback", async () => {
		assert.equal((await tool(child, "read", { path: "own.txt" })).isError, false);
		assert.equal((await tool(child, "read", { path: join(sibling, "secret.txt") })).isError, true);
		assert.ok(requested.includes(childId));
	});
	await active.close(context);
	requested.length = 0;
	active = await open();
	child = (await active.conversation(childId, context))!;
	await t.test("reopened conversations bind restrictions before task execution", async () => {
		assert.equal((await tool(child, "read", { path: "own.txt" })).isError, false);
		const denied = await tool(child, "read", { path: "../sibling/secret.txt" });
		assert.equal(denied.isError, true);
		assert.match(JSON.stringify(denied.content), /limited to/);
		assert.ok(requested.includes(childId));
		assert.equal((await tool((await active.conversation(strict.id, context))!, "read", { path: "/etc/hosts" })).isError, false);
	});
	assert.deepEqual(reports, []);
});
