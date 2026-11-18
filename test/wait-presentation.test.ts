import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { presentPanelEntry } from "../src/web/server.ts";
import { BACKGROUND_WAIT_NOTICE, WORK_READY_NOTICE } from "../src/answer.ts";

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

const panelSource = readFileSync(new URL("../src/web/panel.html", import.meta.url), "utf8");
const appendRenderer = panelSource.slice(panelSource.indexOf("function appendEntry(entry) {"), panelSource.indexOf("/** Offer artifacts from send/write tools"));

for (const failed of [false, true]) test(`panel background abort ${failed ? "reports the failure without claiming success" : "confirms success and refreshes conversations"}`, async () => {
	const handler = panelSource.slice(panelSource.indexOf('$("stopTaskBtn").onclick ='), panelSource.indexOf("async function setArchived"));
	const button: { onclick?: (event: object) => Promise<void> } = {};
	const notices: { text: string; error: boolean }[] = [];
	let refreshed = 0;
	await runInNewContext(`${handler}\nbutton.onclick({ currentTarget: button });`, {
		button, convId: 7, $: () => button, armConfirm: (_button: unknown, action: () => Promise<void>) => action(),
		api: async (path: string, body: { conv: number }) => {
			assert.equal(path, "abort"); assert.equal(body.conv, 7);
			if (failed) throw new Error("The task could not be stopped");
		},
		toast: (text: string, error = false) => notices.push({ text, error }),
		loadConvs: async () => { refreshed++; },
	});
	assert.deepEqual(notices, [{ text: failed ? "The task could not be stopped" : "已中止当前运行", error: failed }]);
	assert.equal(refreshed, failed ? 0 : 1);
});

for (const kind of ["ready", "wait"] as const) for (const severity of ["info", "warn", "error"] as const) test(`panel ${kind} rendering keeps ${severity} diagnostics separate from successful notices`, () => {
	const status = { className: "", innerHTML: "" };
	const meta = { textContent: "" };
	const classes = new Map<string, boolean>();
	const row = {
		_readyCandidate: kind === "ready", _waitCandidate: kind === "wait", _answerEntryId: 12, open: false,
		classList: { toggle: (name: string, value: boolean) => classes.set(name, value) },
		querySelector: (selector: string) => selector === ".st" ? status : meta,
	};
	const opened: [number, string][] = [];
	type Element = { className: string; dataset: Record<string, string>; ownText: string; children: Element[]; onclick?: () => void; textContent: string; appendChild(child: Element): void };
	const element = (): Element => ({
		className: "", dataset: {}, ownText: "", children: [],
		get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(""); },
		set textContent(value: string) { this.ownText = value; },
		appendChild(child: Element) { this.children.push(child); },
	});
	const notices: ReturnType<typeof element>[] = [];
	const entry = {
		kind: "pi.tool-result", byTaskId: 22,
		data: { diagnostics: [{ severity, code: "fixture", message: "The diagnostic remains visible" }] },
		model: [{ role: "toolResult", toolName: kind === "ready" ? "dwell.work" : "dwell.task.wait", toolCallId: "call", isError: false, content: [{ type: "text", text: "Output with the diagnostic" }], details: kind === "ready" ? { workReady: true, workId: "work:1", verified: true } : { waitingForBackground: true } }],
		...(kind === "ready" ? { workReady: { answerEntryId: 12, workId: "work:1", verified: true, text: WORK_READY_NOTICE } } : {}),
	};
	runInNewContext(`${appendRenderer}\nappendEntry(entry);`, {
		entry, T: { calls: new Map([["call", row]]) }, $: () => ({ appendChild: (notice: typeof notices[number]) => notices.push(notice) }),
		document: { createElement: element }, convId: 7, openWork: (id: number, workId: string) => opened.push([id, workId]),
		contentText: (parts: { text: string }[]) => parts.map((part) => part.text).join(""), ic: () => "", addDownload: () => {},
	});
	assert.equal(classes.get("bad"), severity === "error");
	assert.equal(notices.length, severity === "error" ? 0 : 1);
	if (severity !== "error") {
		assert.equal(notices[0]!.textContent, kind === "ready" ? `${WORK_READY_NOTICE}查看工作与验收` : BACKGROUND_WAIT_NOTICE);
		if (kind === "ready") {
			const button = notices[0]!.children[0]!.children[0]!;
			button.onclick!();
			assert.deepEqual(opened, [[7, "work:1"]], "The review action must retain this ready receipt's conversation and work identity");
		}
	}
	if (severity === "warn") assert.match(meta.textContent, /1 条警告/, "Warnings remain visible on the tool row without hiding the host notice");
});
