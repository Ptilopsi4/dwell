import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, type Conversation, type ConversationView, type LiveState, type Submission, type SubmissionRecord } from "@earendil-works/pi-durable";

/** Keep restart presentation independent from channel startup and its credentials. */
export async function mirrorRestoredSubmission(
	conversation: Conversation,
	submission: Submission,
	append: (text: string) => Promise<void>,
	failureReason: (settled: SubmissionRecord) => Promise<string>,
): Promise<void> {
	const watch = await conversation.watch(BACKGROUND_CONTEXT);
	let cursor = "";
	const frame = async (value: ConversationView): Promise<void> => {
		const live = value.docs["pi.live"] as LiveState | undefined;
		if (!live?.run?.inputs.includes(submission.id)) return;
		const text = (live.generation?.message?.content ?? []).flatMap((part) => part.type === "text" ? [part.text] : []).join("");
		if (text === "") return;
		if (text.startsWith(cursor) && text.length > cursor.length) await append(text.slice(cursor.length));
		else if (!text.startsWith(cursor)) await append(`\n\n${text}`);
		cursor = text;
	};
	let frameWork = Promise.resolve();
	let stopped = false;
	try {
		await frame(watch.value);
		watch.start((value) => { frameWork = frame(value); return frameWork; });
		// Submission.wait() resumes scheduling; startup still has other reply watchers to attach.
		const deadline = Date.now() + 20 * 60_000;
		let settled = await submission.status(BACKGROUND_CONTEXT);
		while (settled.status !== "done" && settled.status !== "unanswered") {
			if (Date.now() >= deadline) throw new Error("等待恢复任务完成超时");
			await new Promise((resolve) => setTimeout(resolve, 400));
			settled = await submission.status(BACKGROUND_CONTEXT);
		}
		await watch.stop();
		stopped = true;
		// stop() prevents future callbacks but leaves the active append owned by this caller.
		await frameWork;
		let final = "";
		if (settled.status === "done" && settled.type === "input") {
			const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
			const message = entry?.model?.[0];
			final = message?.role === "assistant" ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") : "";
		} else final = `处理失败：${await failureReason(settled)}`;
		if (final.startsWith(cursor) && final.length > cursor.length) await append(final.slice(cursor.length));
		else if (final !== "" && !final.startsWith(cursor)) await append(`\n\n${final}`);
		else if (final === "" && cursor === "") await append("（本次运行没有产出文本：可能被中止，可重发）");
	} finally {
		if (!stopped) await watch.stop();
		await frameWork;
	}
}
