import { basename, resolve } from "node:path";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { sniffImageMime } from "../media.ts";
import type { ConversationDestination } from "../pipeline.ts";
import { fileGuardBases, sendPathViolation } from "./approval.ts";
import { readWorkspaceFile } from "../guarded-env.ts";

export type FileSendInput = { buffer: Buffer; fileName: string; image: boolean };

export type SendDeps = {
	destinationOf: (conversationId: number) => ConversationDestination;
	send?: (conversationId: number, input: FileSendInput) => Promise<boolean | { messageId: string } | undefined>;
};

const SEND_IMAGE_MAX = 10 * 1024 * 1024;
const SEND_FILE_MAX = 30 * 1024 * 1024;

/** The legacy Feishu name shares validation so replayed conversations keep their tool. */
export function makeFileSendTool(deps: SendDeps, name = "dwell.send", feishuOnly = false) {
	const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
	return defineTool({
		name,
		description:
			`Send a file from your working directory to the current ${feishuOnly ? "Feishu chat" : "conversation"}. Use it to deliver a report, chart, data export, or other file you produced instead of replying with a server path. Only files inside this session's working directory can be sent; path checks block .. and symlink escapes. Delivery is limited to the current conversation. Images (png/jpeg/gif/webp) up to 10MB are sent as images; larger images and other files are sent as documents up to 30MB. Empty files are rejected. In panel tasks the file is offered as a download in the panel.${feishuOnly ? " For Telegram conversations use dwell.send." : ""}`,
		parameters: Type.Object({
			path: Type.String({ description: "Path of the file to send (relative to the working directory, or absolute)" }),
		}),
		executionMode: "sequential",
		async execute(args, api, context) {
			const conversationId = api.conversationId as number;
			const destination = deps.destinationOf(conversationId);
			if (feishuOnly && destination.kind === "telegram") return text("This is a Telegram conversation. Use dwell.send to deliver files to it.", true);
			const cwd = api.env?.cwd;
			if (cwd === undefined) return text("This conversation has no working directory, so the file cannot be located.", true);
			if (destination.kind !== "panel" && deps.send === undefined) return text("The send path is not wired up, so the file cannot be sent.", true);
			// Reject escapes before touching the file, including for panel download offers.
			const violation = await sendPathViolation(args.path, cwd);
			if (violation !== undefined) return text(violation, true);
			const fileName = basename(resolve(cwd, args.path));
			try {
				const { buffer } = await readWorkspaceFile(args.path, fileGuardBases(cwd), SEND_FILE_MAX, context);
				if (buffer.length === 0) return text(`File ${fileName} is empty (0 bytes); this tool does not allow sending empty files.`, true);
				if (buffer.length > SEND_FILE_MAX) return text(`File ${fileName} exceeds the 30MB limit and cannot be sent.`, true);
				if (destination.kind === "panel") return text(`Offered as a download in the panel: ${fileName} (the user clicks download on the tool row)`);
				const image = sniffImageMime(buffer) !== null && buffer.length <= SEND_IMAGE_MAX;
				const sent = await deps.send!(conversationId, { buffer, fileName, image });
				if (sent === undefined || sent === false) return text(`${destination.kind === "telegram" ? "Telegram" : "Feishu"} is not connected; send failed.`, true);
				return text(`Sent ${image ? "image" : "file"} ${fileName} to the current chat.`);
			} catch (err) {
				const data = (err as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
				if (destination.kind === "feishu" && data?.code !== undefined) return text(`Send failed: Feishu API ${data.code}: ${data.msg ?? ""}`, true);
				return text(`Send failed: ${err instanceof Error ? err.message : String(err)}`, true);
			}
		},
	});
}

export function makeSendExtension(deps: SendDeps) {
	return defineExtension({
		name: "dwell-send",
		tools: [makeFileSendTool(deps)],
		sections: [
			section("send", () => "When the user wants a file you produced (report, chart, data export), send it with dwell.send instead of replying with a server path. The tool delivers to the current chat or offers a download for a panel task. Report delivery only when the tool confirms it.", { tag: false }),
		],
	});
}
