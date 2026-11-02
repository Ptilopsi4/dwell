// 飞书事件消费：lark-cli event consume 子进程管理（ready marker / bounded 循环重启 / NDJSON 解析）。
import { spawn } from "node:child_process";

export interface LarkMessage {
	chat_id: string;
	chat_type: string;
	message_id: string;
	message_type: string;
	sender_id: string;
	sender_type: string;
	/** text/post 等类型已由 lark-cli 预解码为纯文本 */
	content: string;
	mentions?: unknown[];
}

/**
 * 持续消费一个 EventKey（lark-cli 一进程一 key，多 key 就多次调用）。
 * bounded --timeout 到期后退出码 0，循环重启；ready marker 之前退出视为失败，带退避重试。
 */
export function startEventLoop(
	onMessage: (m: Record<string, unknown>) => void,
	eventKey = "im.message.receive_v1",
	onStop?: (err?: Error) => void,
): void {
	void runLoop(onMessage, eventKey, onStop);
}

async function runLoop(onMessage: (m: Record<string, unknown>) => void, eventKey: string, onStop?: (err?: Error) => void): Promise<void> {
	let backoff = 1_000;
	for (;;) {
		const outcome = await consumeOnce(onMessage, eventKey);
		if (outcome === "timeout") {
			backoff = 1_000; // 正常轮换，重置退避
			continue;
		}
		// ready 前失败或异常退出：退避后重试
		console.error(`[feishu] consumer ${outcome}，${backoff / 1000}s 后重启`);
		await new Promise((r) => setTimeout(r, backoff));
		backoff = Math.min(backoff * 2, 60_000);
		if (backoff === 60_000) onStop?.(new Error(`consumer 反复失败: ${outcome}`));
	}
}

/** 一次 bounded 消费。返回 "timeout"（正常到期）或错误描述。 */
function consumeOnce(onMessage: (m: Record<string, unknown>) => void, eventKey: string): Promise<"timeout" | string> {
	return new Promise((resolve) => {
		const child = spawn(
			"lark-cli",
			["event", "consume", eventKey, "--as", "bot", "--timeout", "30m"],
			{ stdio: ["pipe", "pipe", "pipe"], shell: true },
		);
		let ready = false;
		let lastErr = "";

		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			// WARN 行（如事件丢弃）全量透传到日志，其余只在未就绪时留存
			for (const line of text.split("\n")) {
				if (line.startsWith("WARN:")) console.error(`[feishu:${eventKey}] ${line}`);
			}
			if (text.includes(`[event] ready event_key=${eventKey}`)) ready = true;
			if (!ready) lastErr += text;
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			if (!ready) return;
			for (const line of chunk.toString().split("\n")) {
				if (line.trim() === "") continue;
				try {
					onMessage(JSON.parse(line) as Record<string, unknown>);
				} catch {
					console.error(`[feishu] 无法解析事件行: ${line.slice(0, 200)}`);
				}
			}
		});
		child.on("exit", (code) => {
			if (code === 0) return resolve("timeout"); // --timeout 到期的正常退出
			resolve(ready ? `异常退出 code=${code}` : `ready 前退出 code=${code}: ${lastErr.slice(-500)}`);
		});
		child.on("error", (err) => resolve(`spawn 失败: ${err.message}`));
	});
}

