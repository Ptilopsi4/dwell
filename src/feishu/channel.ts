// 飞书连接：官方 SDK Channel 模块（单 WebSocket 收事件+卡片回调，自动重连，消息归一化）。
// 凭证走环境变量，不依赖 ~/.lark-cli。
import { createLarkChannel, LoggerLevel, type CardActionEvent, type LarkChannel, type MarkdownStreamController, type NormalizedMessage } from "@larksuiteoapi/node-sdk";

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
		// 群聊 mention 门禁由 dwell 自管（话题内/回复锚点消息不需要 @）：SDK 层放开
		policy: { requireMention: false, dmMode: "open" },
	});
	channel.on("message", handlers.onMessage);
	channel.on("cardAction", handlers.onCardAction);
	channel.on("error", (err: unknown) => console.error("[feishu] channel error:", err));
	return channel.connect().then(() => channel);
}

export type { CardActionEvent, LarkChannel, MarkdownStreamController, NormalizedMessage };

/** 下载用户消息内的资源（图/文件）。走 im/v1/messages/:id/resources/:key（消息资源接口）——
 *  Channel 自带的 downloadResource 走 im/v1/images/:image_key，仅适用于应用自己上传的图，
 *  对用户发送的图片/文件报 234001（实测 2026-11-04）。表情包资源此接口也不支持（官方文档），失败由调用方降级。 */
export async function downloadMessageResource(channel: LarkChannel, messageId: string, fileKey: string, type: "image" | "file"): Promise<Buffer> {
	const response = await channel.rawClient.im.v1.messageResource.get({
		path: { message_id: messageId, file_key: fileKey },
		params: { type },
	});
	const chunks: Buffer[] = [];
	for await (const chunk of response.getReadableStream()) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}
