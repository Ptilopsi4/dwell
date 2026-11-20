import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc, configure, defineDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { WorkDoc } from "./ext/work.ts";
import { TelegramInboxDoc } from "./telegram-entry.ts";

export const NewGoalDoc = defineDoc<{
	requests: Record<string, { workId: string | null; operator: string; at: number; entryId?: number }>;
}>({ kind: "dwell.new-goal", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ requests: {} }), checkpointWhen: () => true });

/** Host controls detach a goal without resetting its budget or reassigning late continuations. */
export async function beginNewGoal(harness: Harness, input: { conversationId: number; expectedWorkId: string | null; operator: string; requestId: string }): Promise<{ changed: boolean; workId?: string; entryId?: number }> {
	if (input.operator.trim() === "" || input.requestId.trim() === "") throw new Error("操作缺少可信用户或请求 ID");
	return harness.commit(async (tx) => {
		const id = input.conversationId as ConversationId;
		const journal = await tx.doc(NewGoalDoc, id);
		const previous = journal.requests[input.requestId];
		if (previous !== undefined) {
			if (previous.operator !== input.operator || previous.workId !== input.expectedWorkId) throw new Error("该开启目标请求与原记录不一致");
			return previous.workId === null ? { changed: false } : { changed: true, workId: previous.workId, entryId: previous.entryId };
		}
		const work = await tx.doc(WorkDoc, id);
		if (work.inherited !== undefined) throw new Error("请在父会话中开启新目标");
		const live = await tx.doc(LiveDoc, id);
		const inbox = await tx.doc(InboxDoc, id);
		const telegram = await tx.doc(TelegramInboxDoc);
		if (live.run !== undefined || inbox.items.some((item) => item.mode !== "write") || Object.values(telegram.inputs).some((row) => row.conversationId === id && row.submissionId === undefined && (row.output === "pending" || row.output === "sending"))) throw new Error("当前仍在运行或有排队输入，请先等待完成或取消");
		if ((work.current ?? null) !== input.expectedWorkId) throw new Error("当前目标已变化，请刷新后重试");
		if (Object.keys(journal.requests).length >= 10_000) throw new Error("本会话的目标操作记录已满，请开启新的会话");
		if (work.current === undefined) {
			journal.requests[input.requestId] = { workId: null, operator: input.operator, at: Date.now() };
			work.goalMode = true;
			await configure(tx, id, { tools: null });
			return { changed: false };
		}
		const workId = work.current;
		const at = Date.now();
		// Preserve old run bindings so approvals and delayed reports cannot acquire the next goal.
		delete work.current;
		const entry = await tx.appendEntry(id, {
			kind: "work.new_goal", data: { sender: input.operator, workId, requestId: input.requestId },
			model: [{ role: "user", content: "The user explicitly requested a new work goal. The previous work record, budget and evidence remain unchanged. Subsequent ordinary user input can establish a fresh goal; late reports and approvals retain their original work. Conversation history is preserved.", timestamp: at }],
		});
		journal.requests[input.requestId] = { workId, operator: input.operator, at, entryId: entry.id };
		work.goalMode = true;
		await configure(tx, id, { tools: null });
		return { changed: true, workId, entryId: entry.id };
	}, BACKGROUND_CONTEXT);
}
