import type { EntryRecord, LiveState, ToolSlot } from "@earendil-works/pi-durable";

const MESSAGE_LIMIT = 4_096;
const LONG_PREVIEW_NOTE = "（内容较长，正在生成；完成后发送全文）";

function toolActivity(name: string): string {
	switch (name) {
		case "read": return "读取文件";
		case "write":
		case "edit": return "编辑文件";
		case "bash": return "执行检查";
		case "dwell.web.search": return "搜索资料";
		case "dwell.web.fetch": return "读取网页";
		case "dwell.lark.read": return "读取消息";
		case "dwell.lark.image": return "识别图片";
		case "dwell.send":
		case "dwell.lark.send": return "发送文件";
		case "dwell.task": return "处理后台任务";
		case "dwell.task.wait": return "等待后台任务";
		case "dwell.proc": return "处理后台进程";
		case "dwell.proc.logs": return "读取进程日志";
		case "dwell.schedule": return "设置定时任务";
		case "dwell.work": return "更新任务进度";
		default: return "工具处理";
	}
}

type StreamView = { docs?: Record<string, LiveState | undefined>; entries?: readonly EntryRecord[] };
type ToolTrace = { key: string; callId: string; name: string; detail: string; status: ToolSlot["status"]; callerId?: number; entry?: number; failed?: boolean; durationMs?: number };
const TRACE_LIMIT = 6;
const KNOWN_TOOLS = new Set(["read", "write", "edit", "bash", "dwell.web.search", "dwell.web.fetch", "dwell.lark.read", "dwell.lark.image", "dwell.send", "dwell.lark.send", "dwell.task", "dwell.task.wait", "dwell.proc", "dwell.proc.logs", "dwell.schedule", "dwell.work"]);

function literal(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\\/g, "\\\\").replace(/([`*_\[\]<>])/g, "\\$1");
}

/** Only presentation fields with known meanings are exposed; commands and output stay private. */
function toolDetail(name: string, args: Record<string, unknown> | undefined): string {
	if (args === undefined) return "";
	if (["read", "write", "edit", "dwell.send", "dwell.lark.send"].includes(name)) {
		const path = args.path ?? args.filePath ?? args.file_path;
		if (typeof path !== "string") return "";
		return literal(prefix(path.split(/[\\/]/).filter(Boolean).at(-1) ?? "", 64));
	}
	if (name === "dwell.web.fetch" && typeof args.url === "string") {
		try { return literal(new URL(args.url).hostname.slice(0, 64)); } catch { return ""; }
	}
	const actions: Record<string, string> = { start: "启动", stop: "停止", status: "查看状态", list: "查看列表", send: "发送", wait: "等待", checkpoint: "记录进度", verify: "验证产物", revise: "修订验证", ready: "提交验收", accept: "确认验收", cancel: "取消", create: "创建", remove: "移除" };
	return typeof args.action === "string" ? actions[args.action] ?? "" : "";
}

function traceText(rows: readonly ToolTrace[], total: number): string {
	if (rows.length === 0) return "";
	const lines = rows.map((row) => {
		const name = KNOWN_TOOLS.has(row.name) ? `\`${row.name}\`` : "其他工具";
		const status = row.status === "pending" ? "等待执行" : row.status === "running" ? "执行中" : row.failed ? "失败或中断" : row.failed === false ? "已完成" : "已结束";
		const duration = row.durationMs === undefined ? "" : ` · ${row.durationMs < 1_000 ? `${row.durationMs} 毫秒` : `${(row.durationMs / 1_000).toFixed(1)} 秒`}`;
		return `• ${name} · ${[row.detail || toolActivity(row.name), status].join(" · ")}${duration}`;
	});
	return `执行记录${total > rows.length ? `（最近 ${rows.length} 项）` : ""}\n${lines.join("\n")}`;
}

function createToolTrace(submissionId: number, inputEntryId?: number) {
	const rows: ToolTrace[] = [];
	let total = 0;
	let publicNote = "";
	let noteCaller: number | undefined;
	const rememberNote = (caller: EntryRecord | undefined): void => {
		if (caller === undefined || caller.id === noteCaller) return;
		noteCaller = caller.id;
		publicNote = prefix(caller.model?.flatMap((message) => message.role === "assistant"
			? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("") ?? "", 600);
	};
	return {
		update(value: unknown, answerEntryId?: number): void {
			const view = value as StreamView;
			const live = view.docs?.["pi.live"];
			const matching = live?.run?.inputs.some((id) => id === submissionId);
			const entries = (view.entries ?? []).slice(-512);
			const start = entries.findIndex((entry) => entry.id === inputEntryId);
			const end = answerEntryId === undefined ? entries.length : entries.findIndex((entry) => entry.id === answerEntryId) + 1;
			if (start >= 0 && end > start && (matching || answerEntryId !== undefined)) {
				const calls = entries.slice(start + 1, end).flatMap((entry) => entry.model?.flatMap((message) => message.role === "assistant"
					? message.content.flatMap((part) => part.type === "toolCall" ? [{ callerId: entry.id as number, call: part }] : []) : []) ?? []).slice(-32);
				for (const { callerId, call } of calls) {
					rememberNote(entries.find((entry) => entry.id === callerId));
					const key = `${callerId}:${call.id}`;
					if (rows.some((row) => row.key === key)) continue;
					rows.push({ key, callerId, callId: call.id, name: call.name, detail: toolDetail(call.name, call.arguments), status: "done" }); total++;
					if (rows.length > 32) rows.shift();
				}
			}
			if (matching && live !== undefined) for (const slot of (live.tools ?? []).slice(-32)) {
				let caller: EntryRecord | undefined;
				let args: { type: string; arguments?: Record<string, unknown> } | undefined;
				for (let i = entries.length - 1; i >= Math.max(0, entries.length - 256); i--) {
					args = entries[i]!.model?.flatMap((message) => message.role === "assistant" ? message.content : []).find((part) => part.type === "toolCall" && part.id === slot.callId && part.name === slot.name);
					if (args !== undefined) { caller = entries[i]; break; }
				}
				const key = `${caller?.id ?? slot.taskId ?? "live"}:${slot.callId}`;
				rememberNote(caller);
				let row = rows.find((item) => item.key === key);
				if (row === undefined) {
					row = { key, callId: slot.callId, name: slot.name, detail: "", status: slot.status, callerId: caller?.id };
					rows.push(row); total++;
					// The live round may have more than the visible tail; retain a bounded lookup window.
					if (rows.length > 32) rows.shift();
				}
				row.status = slot.status;
				row.entry = slot.entry as number | undefined;
				if (slot.status === "done" && slot.entry === undefined) row.failed = true;
				args ??= live.generation?.message?.content.find((part) => part.type === "toolCall" && part.id === slot.callId && part.name === slot.name);
				if (args?.type === "toolCall") row.detail = toolDetail(slot.name, args.arguments);
			}
			// Results survive pi.live's cleared tool round and the terminal frame with no run.
			for (const row of rows) {
				if (row.status === "done" && row.entry === undefined && row.failed === true) continue;
				const callerId = entries.find((entry) => entry.id === row.callerId)?.id;
				// If the caller has left the bounded history, only an explicit result entry can identify its receipt.
				// A terminal answer can be the caller itself; its receipts precede the next assistant, not the answer boundary.
				const nextAssistant = callerId === undefined ? undefined : entries.find((entry) => entry.id > callerId && entry.model?.some((message) => message.role === "assistant"))?.id;
				const entry = row.entry !== undefined ? entries.find((entry) => entry.id === row.entry)
					: callerId === undefined ? undefined
					: entries.find((entry) => entry.id > callerId && (nextAssistant === undefined || entry.id < nextAssistant) && entry.model?.some((message) => message.role === "toolResult" && message.toolCallId === row.callId && message.toolName === row.name));
				const result = entry?.model?.find((message) => message.role === "toolResult" && message.toolCallId === row.callId && message.toolName === row.name);
				if (result?.role !== "toolResult") continue;
				row.entry = entry!.id;
				row.status = "done";
				const diagnostics = (entry?.data as { diagnostics?: { severity?: string }[] } | undefined)?.diagnostics;
				row.failed = result.isError || diagnostics?.some((item) => item.severity === "error") === true;
				row.durationMs = result.durationMs !== undefined && Number.isFinite(result.durationMs) && result.durationMs >= 0 ? Math.round(result.durationMs) : undefined;
			}
		},
		text(): string { return traceText(rows.slice(-TRACE_LIMIT), total); },
		note(): string { return publicNote; },
		finish(): void { for (const row of rows) if (row.status !== "done") { row.status = "done"; row.failed = true; } },
	};
}

function prefix(text: string, length: number): string {
	const end = Math.max(0, length);
	const last = text.charCodeAt(end - 1);
	const next = text.charCodeAt(end);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end);
}

/** Project one matching live snapshot; model reasoning and tool payloads never enter this body. */
export function telegramStreamText(value: unknown, submissionId: number): string | undefined {
	const live = (value as { docs?: Record<string, LiveState | undefined> }).docs?.["pi.live"];
	if (!live?.run?.inputs.some((id) => id === submissionId)) return undefined;
	// Keep only enough text to decide whether a bounded preview is needed.
	let text = "";
	for (const part of live.generation?.message?.content ?? []) {
		if (part.type !== "text") continue;
		text += part.text.slice(0, MESSAGE_LIMIT + 1 - text.length);
		if (text.length > MESSAGE_LIMIT) break;
	}
	if (text.trim() === "") return live.generation?.retry ? "正在重试回复……" : undefined;
	if (text.length <= MESSAGE_LIMIT) return text;
	const tail = `\n\n${LONG_PREVIEW_NOTE}`;
	return prefix(text, MESSAGE_LIMIT - tail.length) + tail;
}

export interface TelegramStreamOptions {
	submissionId: number;
	inputEntryId?: number;
	chatType: "p2p" | "group";
	edit: (text: string) => Promise<void>;
	onEditError?: () => void;
	intervalMs?: number;
}

/** Owns partial edits only. Stop and join it before delivering the settled answer. */
export function createTelegramStreamPresenter(options: TelegramStreamOptions): {
	update: (value: unknown) => void;
	summary: (latestValue?: unknown, answerEntryId?: number) => string;
	stop: () => Promise<{ editFailed: boolean }>;
} {
	const interval = Math.max(0, options.intervalMs ?? (options.chatType === "group" ? 3_000 : 1_000));
	let stopped = false;
	let editFailed = false;
	let pending: string | undefined;
	let published: string | undefined;
	let active: Promise<void> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastEditAt = -Infinity;
	const trace = createToolTrace(options.submissionId, options.inputEntryId);
	const schedule = (): void => {
		if (stopped || editFailed || active !== undefined || timer !== undefined || pending === undefined) return;
		if (pending === published) { pending = undefined; return; }
		const delay = interval - (Date.now() - lastEditAt);
		if (delay > 0) {
			timer = setTimeout(() => { timer = undefined; schedule(); }, delay);
			return;
		}
		const body = pending;
		pending = undefined;
		lastEditAt = Date.now();
		active = Promise.resolve().then(() => options.edit(body)).then(() => {
			published = body;
		}, () => {
			// The transport already retries rate limits. Stop partial traffic after its bounded failure.
			editFailed = true;
			pending = undefined;
			try { options.onEditError?.(); } catch { /* Reporting must not block the model or final delivery. */ }
		}).finally(() => { active = undefined; schedule(); });
	};
	return {
		update(value) {
			if (stopped || editFailed) return;
			trace.update(value);
			const live = (value as StreamView).docs?.["pi.live"];
			if (!live?.run?.inputs.some((id) => id === options.submissionId)) return;
			const text = telegramStreamText(value, options.submissionId) || trace.note();
			const history = trace.text();
			const body = text && history ? `${prefix(text, MESSAGE_LIMIT - history.length - 2)}\n\n${history}` : text || history || undefined;
			if (body === undefined) return;
			pending = body;
			schedule();
		},
		summary(latestValue, answerEntryId) {
			if (latestValue !== undefined) trace.update(latestValue, answerEntryId);
			if (stopped) trace.finish();
			return trace.text();
		},
		async stop() {
			stopped = true;
			pending = undefined;
			if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
			await active;
			return { editFailed };
		},
	};
}
