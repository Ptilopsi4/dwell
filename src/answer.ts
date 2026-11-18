import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { AssistantEntry, type EntryId, type Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_WAIT_TOOL, backgroundWaitingAnswer } from "./ext/background.ts";
import { workReadyAnswer } from "./ext/work.ts";

export const BACKGROUND_WAIT_NOTICE = "后台任务处理中，完成后会继续。";
export const WORK_READY_NOTICE = "已完成声明的验证，等待你验收。";
export const WORK_READY_UNVERIFIED_NOTICE = "工作已提交，等待你验收（未声明验证契约）。";
export const WORK_READY_NEXT_STEP = "下一步：请在面板的“工作记录与验收”中查看并确认验收；如需修改，可直接继续发送要求。";
export const workReadyNotice = (verified: boolean, summary?: string): string => [verified ? WORK_READY_NOTICE : WORK_READY_UNVERIFIED_NOTICE, ...(summary === undefined ? [] : [summary, WORK_READY_NEXT_STEP])].join("\n\n");

/** Host notices require the settled answer's own acknowledged tool result. */
export async function presentAnswer(
	store: Pick<Harness, "commit">,
	conversationId: number,
	answerEntryId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ text: string; waiting: boolean; ready: boolean }> {
	const entry = await store.commit((tx) => tx.entry(AssistantEntry, answerEntryId as EntryId), context);
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return { text: "", waiting: false, ready: false };
	const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
	const candidate = message.content.some((part) => part.type === "toolCall" && part.name === BACKGROUND_WAIT_TOOL);
	const waiting = candidate && await backgroundWaitingAnswer(store, conversationId, answerEntryId, context);
	const readyCandidate = message.content.some((part) => part.type === "toolCall" && part.name === "dwell.work" && part.arguments.action === "ready");
	const ready = readyCandidate ? await workReadyAnswer(store, conversationId, answerEntryId, context) : undefined;
	const notice = waiting ? BACKGROUND_WAIT_NOTICE : ready === undefined ? "" : workReadyNotice(ready.verified, ready.summary);
	return { text: [text, notice].filter(Boolean).join("\n\n"), waiting, ready: ready !== undefined };
}
