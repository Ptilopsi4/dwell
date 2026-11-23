import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { AssistantEntry, type EntryId, type Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_WAIT_TOOL, backgroundWaitingAnswer } from "./ext/background.ts";

export const BACKGROUND_WAIT_NOTICE = "后台任务处理中，完成后会继续。";

/** Host notices require the settled answer's own acknowledged tool result. */
export async function presentAnswer(
	store: Pick<Harness, "commit">,
	conversationId: number,
	answerEntryId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<{ text: string; waiting: boolean }> {
	const entry = await store.commit((tx) => tx.entry(AssistantEntry, answerEntryId as EntryId), context);
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return { text: "", waiting: false };
	const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
	const candidate = message.content.some((part) => part.type === "toolCall" && part.name === BACKGROUND_WAIT_TOOL);
	const waiting = candidate && await backgroundWaitingAnswer(store, conversationId, answerEntryId, context);
	const notice = waiting ? BACKGROUND_WAIT_NOTICE : "";
	return { text: [text, notice].filter(Boolean).join("\n\n"), waiting };
}
