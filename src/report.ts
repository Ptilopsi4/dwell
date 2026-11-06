// 运行告警：pi-durable onReport 装配——不传时任务 faulted、扩展 hook 抛错、Session 失败等被静默丢弃。
// 日志每条必记（journald 可查）；管理员私聊按 type|extension|task.kind或callback 节流，窗口内同键只发第一条，
// 被抑制条数并入下一条。session_failed 不节流：Session 已死进程即僵尸，由 index 侧通知后退出交进程管理器拉起。
import type { ReportInfo } from "@earendil-works/pi-durable";

/** 错误信息：Error 取 message，其余 String()；截 300 字防刷屏。 */
function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** 告警 markdown：首行类型（有 reason 附上），其余字段按存在与否列出。 */
export function formatReport(error: unknown, info: ReportInfo, nameOf: (conversationId: number) => string | undefined): string {
	const reason = "reason" in info ? ` · ${info.reason}` : "";
	const lines = [`**dwell 告警** · ${info.type}${reason}`];
	const task = "task" in info ? info.task : undefined;
	if (task !== undefined) lines.push(`- 任务：${task.kind} #${task.id}`);
	const conversationId = task?.conversationId ?? ("conversationId" in info ? info.conversationId : undefined);
	if (conversationId !== undefined) lines.push(`- 会话：${nameOf(conversationId) ?? `#${conversationId}`}`);
	if ("extension" in info && info.extension !== undefined) lines.push(`- 扩展：${info.extension}`);
	if (info.type === "host_error") lines.push(`- host 回调：${info.callback}`);
	lines.push(`- 错误：${errorText(error)}`);
	return lines.join("\n");
}

export interface ReporterOptions {
	/** 私发管理员文本（飞书未连接时由实现方空操作，日志已记）。 */
	notify: (text: string) => void | Promise<void>;
	/** session_failed 专道：接收方负责善后（尽力通知后退出进程）。 */
	onSessionFailed: (text: string) => void | Promise<void>;
	nameOf: (conversationId: number) => string | undefined;
	/** 节流时钟（测试注入）。 */
	now?: () => number;
	/** 节流窗口，默认 10 分钟。 */
	windowMs?: number;
}

/** 节流键：type + extension + task.kind 或 host callback（reason 不参与——同类故障不该因原因措辞不同而刷屏）。 */
function throttleKey(info: ReportInfo): string {
	const parts: string[] = [info.type];
	if ("extension" in info && info.extension !== undefined) parts.push(info.extension);
	if ("callback" in info) parts.push(info.callback);
	if ("task" in info && info.task !== undefined) parts.push(info.task.kind);
	return parts.join("|");
}

/** pi-durable 会丢弃 onReport 自身的抛错：notify/onSessionFailed 的同步抛错与 reject 都在此收口，只记日志。 */
async function attempt(action: () => void | Promise<void>): Promise<void> {
	try {
		await action();
	} catch (err) {
		console.error("[dwell] 告警发送失败:", err);
	}
}

export function makeReporter({ notify, onSessionFailed, nameOf, now = Date.now, windowMs = 10 * 60_000 }: ReporterOptions): (error: unknown, info: ReportInfo) => void {
	const lastSent = new Map<string, number>();
	const suppressed = new Map<string, number>();
	return (error, info) => {
		const text = formatReport(error, info, nameOf);
		// 日志带全字段（task/会话/extension），原始 error 单列保留堆栈
		console.error("[dwell] report", text.replace(/\n- /g, " | "), error);
		if (info.type === "session_failed") {
			void attempt(() => onSessionFailed(text));
			return;
		}
		const key = throttleKey(info);
		const at = now();
		const last = lastSent.get(key);
		if (last !== undefined && at - last < windowMs) {
			suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
			return;
		}
		lastSent.set(key, at);
		const held = suppressed.get(key) ?? 0;
		suppressed.delete(key);
		void attempt(() => notify(held > 0 ? `${text}\n（此前同类 ${held} 次已抑制）` : text));
	};
}
