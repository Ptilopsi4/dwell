import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc, configure, defineDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { createWorkRecord, WorkDoc } from "./ext/work.ts";
import { TelegramInboxDoc } from "./telegram-entry.ts";

export const NewGoalDoc = defineDoc<{
	requests: Record<string, { workId: string | null; created?: string; operator: string; at: number; entryId?: number }>;
}>({ kind: "dwell.new-goal", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ requests: {} }), checkpointWhen: () => true });

/** /goal 一发即忘：单次 commit 内解绑旧目标并直接建立新记录；host 控制，不经模型回显。 */
export async function beginNewGoal(harness: Harness, input: { conversationId: number; expectedWorkId: string | null; operator: string; requestId: string; goal: string }): Promise<{ changed: boolean; workId?: string; created?: string; entryId?: number }> {
	if (input.operator.trim() === "" || input.requestId.trim() === "") throw new Error("操作缺少可信用户或请求 ID");
	if (!input.goal.trim()) throw new Error("缺少目标描述，用法：/goal <目标描述>");
	return harness.commit(async (tx) => {
		const id = input.conversationId as ConversationId;
		const journal = await tx.doc(NewGoalDoc, id);
		const previous = journal.requests[input.requestId];
		if (previous !== undefined) {
			if (previous.operator !== input.operator || previous.workId !== input.expectedWorkId) throw new Error("该开启目标请求与原记录不一致");
			return previous.created === undefined ? { changed: false } : { changed: previous.workId !== null, workId: previous.workId ?? undefined, created: previous.created, ...(previous.entryId === undefined ? {} : { entryId: previous.entryId }) };
		}
		const work = await tx.doc(WorkDoc, id);
		if (work.inherited !== undefined) throw new Error("请在父会话中开启新目标");
		const live = await tx.doc(LiveDoc, id);
		const inbox = await tx.doc(InboxDoc, id);
		const telegram = await tx.doc(TelegramInboxDoc);
		if (live.run !== undefined || inbox.items.some((item) => item.mode !== "write") || Object.values(telegram.inputs).some((row) => row.conversationId === id && row.submissionId === undefined && (row.output === "pending" || row.output === "sending"))) throw new Error("当前仍在运行或有排队输入，请先等待完成或取消");
		if ((work.current ?? null) !== input.expectedWorkId) throw new Error("当前目标已变化，请刷新后重试");
		if (Object.keys(journal.requests).length >= 10_000) throw new Error("本会话的目标操作记录已满，请开启新的会话");
		const at = Date.now();
		const previousId = work.current;
		let entryId: number | undefined;
		if (previousId !== undefined) {
			const record = work.records[previousId];
			if (record !== undefined && record.status === "active") { record.status = "superseded"; record.updatedAt = at; }
			// Preserve old run bindings so approvals and delayed reports cannot acquire the next goal.
			delete work.current;
			entryId = (await tx.appendEntry(id, {
				kind: "work.new_goal", data: { sender: input.operator, workId: previousId, requestId: input.requestId },
				model: [{ role: "user", content: "The user launched a new work goal with /goal. The previous objective and its instructions are superseded and no longer current: do not continue working toward them or treat earlier goal text as active. The previous work record and budget remain unchanged as history; late reports and approvals retain their original work. Conversation history is preserved.", timestamp: at }],
			})).id;
		}
		const created = await createWorkRecord(tx, id, input.goal, input.operator);
		// 新会话默认隐藏 dwell.work；建立记录后恢复默认工具面（幂等）
		await configure(tx, id, { tools: null });
		journal.requests[input.requestId] = { workId: previousId ?? null, created, operator: input.operator, at, ...(entryId === undefined ? {} : { entryId }) };
		return { changed: previousId !== undefined, ...(previousId === undefined ? {} : { workId: previousId }), created, ...(entryId === undefined ? {} : { entryId }) };
	}, BACKGROUND_CONTEXT);
}
