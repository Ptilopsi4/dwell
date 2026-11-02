// 飞书连接：官方 SDK Channel 模块（单 WebSocket 收事件+卡片回调，自动重连，消息归一化）。
// 凭证走环境变量，不依赖 ~/.lark-cli。
import { createLarkChannel, LoggerLevel, type CardActionEvent, type LarkChannel, type NormalizedMessage } from "@larksuiteoapi/node-sdk";

export function connectChannel(handlers: {
	onMessage: (msg: NormalizedMessage) => void;
	onCardAction: (evt: CardActionEvent) => void;
}): Promise<LarkChannel> {
	const appId = process.env.LARK_APP_ID;
	const appSecret = process.env.LARK_APP_SECRET;
	if (appId === undefined || appSecret === undefined) {
		throw new Error("LARK_APP_ID / LARK_APP_SECRET 未设置");
	}
	const channel = createLarkChannel({
		appId,
		appSecret,
		loggerLevel: LoggerLevel.warn,
		policy: { requireMention: true, dmMode: "open" },
	});
	channel.on("message", handlers.onMessage);
	channel.on("cardAction", handlers.onCardAction);
	channel.on("error", (err: unknown) => console.error("[feishu] channel error:", err));
	return channel.connect().then(() => channel);
}

export type { CardActionEvent, LarkChannel, NormalizedMessage };
