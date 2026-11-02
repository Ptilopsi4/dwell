// 飞书回复：文本发送（stdin 传参避免转义）与长文本分段。
import { exec } from "node:child_process";

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
