// 飞书会话历史读取（dwell.lark.read）：SDK Client 直调，显式读取优于隐式污染。
// 依赖运行时对象（channel/directory/sessions 在 main 中后于 harness 装配），用 getter 延迟绑定。
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Directory } from "../feishu/directory.ts";

/** 运行时依赖访问器：装配时变量可能尚未初始化，execute 时解引用。 */
export type LarkDeps = {
	getClient: () => { im: { v1: { message: unknown } } } | undefined;
	getDirectory: () => Directory | undefined;
	chatOf: (conversationId: number) => string | undefined;
};

/** message.list/get 返回条目的最小形状。 */
type MessageItem = {
	message_id?: string;
	msg_type?: string;
	create_time?: string;
	chat_id?: string;
	deleted?: boolean;
	body?: { content?: string };
	sender?: { id?: string; sender_type?: string };
	senderName?: string;
};

type ListParams = {
	container_id_type: string;
	container_id: string;
	sort_type?: "ByCreateTimeAsc" | "ByCreateTimeDesc";
	page_size?: number;
	start_time?: string;
	end_time?: string;
	with_sender_name?: boolean;
};

type ListResult = { code?: number; msg?: string; data?: { has_more?: boolean; items?: MessageItem[] } };

/** 卡片消息提取：elements 里 text/lark_md 段拼尽（cardkit 流式卡只带降级结构，提取不到时诚实占位）。 */
function interactiveText(parsed: unknown): string {
	const texts: string[] = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (typeof node !== "object" || node === null) return;
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if ((key === "text" || key === "content") && typeof value === "string" && value.trim() !== "") texts.push(value);
			else walk(value);
		}
	};
	walk(parsed);
	return texts.join(" ");
}

/** 单条内容提取：文本直出，富文本拼段，媒体/卡片给占位；单条截 200 字。 */
function messageText(item: MessageItem): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(item.body?.content ?? "");
	} catch {
		parsed = undefined;
	}
	let text = "";
	if (item.msg_type === "text") text = typeof parsed === "object" && parsed !== null ? String((parsed as { text?: string }).text ?? "") : String(parsed ?? "");
	else if (item.msg_type === "post") text = JSON.stringify(parsed).match(/"text":"[^"]*"/g)?.map((s) => s.slice(8, -1)).join(" ") ?? "";
	else if (item.msg_type === "interactive") {
		// bot 自己的卡（流式回复/审批）不走提取：cardkit 降级文案会污染内容，且正文就在会话上下文里
		if (item.sender?.sender_type === "app") text = "[dwell 的回复卡片，正文见会话上下文]";
		else {
			text = interactiveText(parsed);
			if (text === "") text = "[卡片消息，内容不可读]";
		}
	} else {
		const kinds: Record<string, string> = { image: "[图片]", file: "[文件]", audio: "[语音]", media: "[视频]", sticker: "[表情]", share_chat: "[群名片]", share_user: "[名片]", system: "[系统消息]" };
		text = kinds[item.msg_type ?? ""] ?? `[${item.msg_type ?? "未知类型"}]`;
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function formatTime(createTime: string | undefined): string {
	const ms = Number(createTime ?? 0);
	if (!Number.isFinite(ms) || ms <= 0) return "??:??";
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 格式化一批消息（按时间正序传入）。 */
async function formatItems(items: MessageItem[], chatName: string | undefined, directory: Directory | undefined): Promise<string> {
	const senderIds = items.map((i) => i.sender?.id).filter((id): id is string => id !== undefined && !id.startsWith("app"));
	const names = directory !== undefined && senderIds.length > 0 ? await directory.userNames(senderIds) : {};
	const lines = items.map((item) => {
		const senderId = item.sender?.id ?? "";
		const name = item.senderName || (senderId in names ? names[senderId] : undefined) || (senderId === "" ? "?" : senderId.slice(-6));
		return `[${formatTime(item.create_time)}] ${name} (${item.message_id ?? "?"}): ${messageText(item)}`;
	});
	return `${chatName ?? "会话"} 最近消息（正序，括号内为消息 id，可用于 around 定位）：\n${lines.join("\n")}`;
}

/** 拉取一页消息（list 只取第一页，page_size 上限 50）。 */
async function listMessages(deps: LarkDeps, params: ListParams): Promise<MessageItem[]> {
	const client = deps.getClient();
	if (client === undefined) throw new Error("飞书通道未就绪");
	const message = client.im.v1.message as {
		list: (payload: { params: ListParams }) => Promise<ListResult>;
		get: (payload: { params?: { with_sender_name?: boolean }; path: { message_id: string } }) => Promise<{ code?: number; msg?: string; data?: { items?: MessageItem[] } }>;
	};
	const result = await message.list({ params });
	if (result.code !== undefined && result.code !== 0) throw new Error(`飞书 API ${result.code}: ${result.msg ?? ""}`);
	return result.data?.items ?? [];
}

/** dwell.lark.read：读当前会话/指定消息上下文/指定会话的飞书历史。 */
function makeReadTool(deps: LarkDeps) {
	return defineTool({
		name: "dwell.lark.read",
		description:
			"读飞书聊天记录（当前会话默认）。场景：用户说「上面那个问题/之前聊的」但上下文里没有时；回顾群聊；了解其他任务线。返回按时间正序的消息（含发送者与消息 id）。around 参数用返回的 om_ 开头消息 id 定位某条消息的前后文。",
		parameters: Type.Object({
			count: Type.Optional(Type.Number({ description: "读取条数（默认 20，上限 50）" })),
			around: Type.Optional(Type.String({ description: "消息 id（om_ 开头）：读该消息前后各一半" })),
			chat: Type.Optional(Type.String({ description: "会话 id（oc_ 开头）：读其他会话（bot 需在该会话内）。默认当前会话" })),
			sinceHours: Type.Optional(Type.Number({ description: "只读最近 N 小时内的消息（与 chat 搭配）" })),
		}),
		replay: "safe",
		executionMode: "sequential",
		async execute(args, api) {
			const count = Math.min(Math.max(Math.trunc(args.count ?? 20), 1), 50);
			let chatId = args.chat ?? deps.chatOf(api.conversationId as number);
			if (chatId === undefined) {
				// panel 会话无对应 chat：让模型转告用户该能力限飞书会话
				return { output: [{ type: "text", text: "当前会话（panel 任务）没有对应的飞书聊天，无法读取记录。" }] };
			}
			const directory = deps.getDirectory();
			let nameChat: string = chatId;
			try {
				let items: MessageItem[];
				if (args.around !== undefined) {
					const client = deps.getClient();
					if (client === undefined) throw new Error("飞书通道未就绪");
					const message = client.im.v1.message as {
						list: (payload: { params: ListParams }) => Promise<ListResult>;
						get: (payload: { params?: { with_sender_name?: boolean }; path: { message_id: string } }) => Promise<{ code?: number; msg?: string; data?: { items?: MessageItem[] } }>;
					};
					const got = await message.get({ params: { with_sender_name: true }, path: { message_id: args.around } });
					const anchor = got.data?.items?.[0];
					if (anchor === undefined) throw new Error(`消息 ${args.around} 不存在或 bot 无权读取`);
					const targetChat: string = anchor.chat_id ?? chatId; // 锚点消息所在会话优先（chatId 已收窄非空）
					nameChat = targetChat;
					const half = Math.ceil(count / 2);
					const center = anchor.create_time ?? "0";
					const before = await listMessages(deps, { container_id_type: "chat", container_id: targetChat, sort_type: "ByCreateTimeDesc", page_size: half, end_time: center, with_sender_name: true });
					const after = await listMessages(deps, { container_id_type: "chat", container_id: targetChat, sort_type: "ByCreateTimeAsc", page_size: half, start_time: center, with_sender_name: true });
					const seen = new Set<string>();
					items = [...before, ...after].filter((item) => {
						const id = item.message_id ?? "";
						if (id === "" || seen.has(id) || item.deleted === true) return false;
						seen.add(id);
						return true;
					}).sort((a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0));
				} else {
					const start = args.sinceHours !== undefined ? String(Date.now() - args.sinceHours * 3_600_000) : undefined;
					const raw = await listMessages(deps, {
						container_id_type: "chat",
						container_id: chatId,
						sort_type: "ByCreateTimeDesc",
						page_size: count,
						with_sender_name: true,
						...(start !== undefined ? { start_time: start } : {}),
					});
					items = raw.filter((item) => item.deleted !== true).reverse();
				}
				if (items.length === 0) return { output: [{ type: "text", text: "该会话没有可读消息（时间范围内为空或 bot 无权限）。" }] };
				const chatName = directory !== undefined ? await directory.chatName(nameChat) : undefined;
				return { output: [{ type: "text", text: await formatItems(items, chatName, directory) }] };
			} catch (err) {
				return { output: [{ type: "text", text: `读取失败：${err instanceof Error ? err.message : String(err)}` }], isError: true };
			}
		},
	});
}

/** 装配：deps 为运行时访问器（channel/directory/sessions 后于 harness 初始化）。 */
export function makeLarkExtension(deps: LarkDeps) {
	return defineExtension({
		name: "dwell-lark",
		tools: [makeReadTool(deps)],
		sections: [
			section(
				"lark",
				() => "用户提到「上面/之前/昨天聊的」等飞书历史内容而上下文缺失时，用 dwell.lark.read 读聊天记录（默认当前会话最近 20 条）。",
				{ tag: false },
			),
		],
	});
}
