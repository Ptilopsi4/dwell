// 消息管线判定：从 index.ts 抽出的无副作用判定（准入/空内容/降级路由/命令识别），副作用与顺序留在 index.ts。
import type { NormalizedMessage } from "./feishu/channel.ts";

/** 命令表精确匹配首个空白分隔词：未知斜杠文本（如路径「/usr/bin 下有什么」）当普通输入交模型，不回「未知命令」。 */
export const KNOWN_COMMANDS = new Set(["/help", "/whoami", "/new", "/status", "/cancel", "/approve", "/deny", "/allow", "/disallow"]);

/** 群聊准入：话题内与回复已锚定消息视为显式指向（免 @），平消息仍需 @bot；非群聊不限。 */
export function groupAdmits(msg: NormalizedMessage, isAnchored: (messageId: string) => boolean): boolean {
	if (msg.chatType !== "group" || msg.mentionedBot) return true;
	if (msg.threadId !== undefined) return true;
	return msg.replyToMessageId !== undefined && isAnchored(msg.replyToMessageId);
}

/** 空消息（无资源且空文本）的处理：非 text 类型要回提示文案，text 静默丢弃；有内容返回 null 继续处理。 */
export function emptyReply(msg: NormalizedMessage): "ignore" | "unsupported" | null {
	if ((msg.resources?.length ?? 0) > 0 || msg.content.trim() !== "") return null;
	return msg.rawContentType !== "text" ? "unsupported" : "ignore";
}

/** 降级路由形态：thread 线自身不降级，direct/group 在 replyTo 未命中时由调用方显式提示。 */
export type FallbackRoute =
	| { kind: "direct"; degraded: boolean }
	| { kind: "thread"; threadId: string; degraded: boolean }
	| { kind: "group"; degraded: boolean };

/** replyTo 未命中后的路由判定：私聊 chat 级 / 话题 per-thread / 群平消息 per-sender。 */
export function fallbackRoute(msg: NormalizedMessage): FallbackRoute {
	const degraded = msg.replyToMessageId !== undefined;
	if (msg.chatType === "p2p") return { kind: "direct", degraded };
	if (msg.threadId !== undefined) return { kind: "thread", threadId: msg.threadId, degraded: false };
	return { kind: "group", degraded };
}

/** 消息动作判定：命令优先于媒体——带资源的命令文本仍走命令（与原判定顺序一致）。 */
export function messageAction(content: string, hasResources: boolean): "command" | "media" | "input" {
	if (KNOWN_COMMANDS.has(content.split(/\s+/)[0] ?? "")) return "command";
	if (hasResources) return "media";
	return "input";
}
