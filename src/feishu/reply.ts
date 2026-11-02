// 飞书回复：文本发送（stdin 传参避免转义）与长文本分段。
import { exec } from "node:child_process";

export interface CardUpdate {
	token: string;
	header: string;
	template: string;
	lines: string[];
}

/** 更新已发送的交互卡片（延时更新 API，token 30 分钟内最多 2 次）。 */
export function updateCard(card: CardUpdate): Promise<string> {
	return lark(["api", "POST", "/open-apis/interactive/v1/card/update", "--as", "bot", "--data", "-"],
		JSON.stringify({ token: card.token, card: simpleCard(card.header, card.template, card.lines) }));
}

/** Card 2.0 展示型卡片（无按钮）。lines 为空则只留标题。 */
export function simpleCard(header: string, template: string, lines: string[]): Record<string, unknown> {
	return {
		schema: "2.0",
		header: { title: { tag: "plain_text", content: header }, template },
		...(lines.length > 0 ? { body: { elements: [{ tag: "markdown", content: lines.join("\n") }] } } : {}),
	};
}

/** 跑一条 lark-cli 命令，stdin 传内容。失败抛错并带 stderr。 */
export function lark(args: string[], stdin?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		// lark-cli 在 Windows 是 .cmd shim，shell:true 兼容两端；args 不含用户可控内容，stdin 走管道
		const child = exec(`lark-cli ${args.join(" ")}`, { timeout: 60_000 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`lark-cli ${args[0]} 失败: ${stderr || error.message}`));
			else resolve(stdout);
		});
		if (stdin !== undefined && child.stdin) {
			child.stdin.write(stdin);
			child.stdin.end();
		}
	});
}

/** 发文本消息到 chat。idemKey 用 message_id 可使重发幂等。 */
export function sendText(chatId: string, text: string, idemKey?: string): Promise<string> {
	const args = ["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--text", "-"];
	if (idemKey !== undefined) args.push("--idempotency-key", idemKey);
	return lark(args, text);
}

/** 长文本分段：优先段落边界，其次句子，硬切兜底。 */
export function splitMessage(text: string, limit = 3800): string[] {
	if (text.length <= limit) return [text];
	const parts: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const window = rest.slice(0, limit);
		const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf("。"), window.lastIndexOf(". "));
		parts.push(rest.slice(0, cut > limit / 2 ? cut + 1 : limit));
		rest = rest.slice(cut > limit / 2 ? cut + 1 : limit);
	}
	if (rest.length > 0) parts.push(rest);
	return parts;
}
