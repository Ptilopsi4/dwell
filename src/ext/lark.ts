// 飞书会话历史读取（dwell.lark.read）：SDK Client 直调，显式读取优于隐式污染。
// 依赖运行时对象（channel/directory/sessions 在 main 中后于 harness 装配），用 getter 延迟绑定。
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Directory } from "../feishu/directory.ts";
import type { ImageDescriber } from "../harness.ts";
import { sniffImageMime } from "../media.ts";

/** 运行时依赖访问器：装配时变量可能尚未初始化，execute 时解引用。 */
export type LarkDeps = {
	getClient: () => { im: { v1: { message: unknown; messageResource?: unknown } } } | undefined;
	getDirectory: () => Directory | undefined;
	chatOf: (conversationId: number) => string | undefined;
	/** 视觉描述器（harness 装配；无 ZAI key 时为 null，工具诚实提示） */
	getDescriber?: () => ImageDescriber | null;
	/** 当前 run 发起者是否管理员：跨会话读取（chat/around 指向别的会话）仅管理员放行 */
	isAdmin?: (openId: string) => boolean;
	/** 当前 run 发起者（审批归属同源；缺失视为非管理员） */
	senderOf?: (conversationId: number) => string | undefined;
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
	return `${chatName ?? "会话"} 最近消息（正序，括号内为消息 id，可用于 around 定位或 dwell.lark.image 识图）：\n${lines.join("\n")}`;
}

/** 拉取一页消息（list 只取第一页，page_size 上限 50）。 */
async function listMessages(deps: LarkDeps, params: ListParams): Promise<MessageItem[]> {
	const client = deps.getClient();
	if (client === undefined) throw new Error("飞书通道未就绪");
	const message = client.im.v1.message as {
		list: (payload: { params: ListParams }) => Promise<ListResult>;
		get: (payload: { params?: { with_sender_name?: boolean }; path: { message_id: string } }) => Promise<{ code?: number; msg?: string; data?: { items?: MessageItem[] } }>;
	};
	try {
		const result = await message.list({ params });
		if (result.code !== undefined && result.code !== 0) throw new Error(`飞书 API ${result.code}: ${result.msg ?? ""}`);
		return result.data?.items ?? [];
	} catch (err) {
		// axios 外壳只报 HTTP 状态，飞书真实 code/msg 在 response.data 里
		const data = (err as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
		if (data?.code !== undefined) throw new Error(`飞书 API ${data.code}: ${data.msg ?? ""}`);
		throw err;
	}
}

/** 消息所在会话与当前会话不一致 → 跨会话读取/识图门槛：仅管理员触发的 run 放行（缺失发起者信息视为拒绝）。 */
function crossChatDenied(deps: LarkDeps, conversationId: number): boolean {
	const sender = deps.senderOf?.(conversationId) ?? "";
	return sender === "" || deps.isAdmin?.(sender) !== true;
}

/** dwell.lark.read：读当前会话/指定消息上下文/指定会话的飞书历史。 */
function makeReadTool(deps: LarkDeps) {
	return defineTool({
		name: "dwell.lark.read",
		description:
			"读飞书聊天记录（当前会话默认）。场景：用户说「上面那个问题/之前聊的」但上下文里没有时；回顾群聊；了解其他任务线。返回按时间正序的消息（含发送者与消息 id）。需要展开某条消息的前后文时：先用无参数调用拿到列表，再用返回的 om_ id 作 around 定位（id 仅存在于本工具的返回中，用户侧不可见）。卡片消息（bot 回复）只显示占位，正文在会话上下文里，看前后的用户消息即可。读当前会话之外的其他会话（chat/around 指向别处）仅管理员可用。",
		parameters: Type.Object({
			count: Type.Optional(Type.Number({ description: "读取条数（默认 20，上限 50）" })),
			around: Type.Optional(Type.String({ description: "消息 id（om_ 开头）：读该消息前后各一半；取自本工具上一次返回" })),
			chat: Type.Optional(Type.String({ description: "会话 id（oc_ 开头）：读其他会话（bot 需在该会话内）。默认当前会话" })),
			sinceHours: Type.Optional(Type.Number({ description: "只读最近 N 小时内的消息（与 chat 搭配）" })),
		}),
		replay: "safe",
		executionMode: "sequential",
		async execute(args, api) {
			const count = Math.min(Math.max(Math.trunc(args.count ?? 20), 1), 50);
			const current = deps.chatOf(api.conversationId as number);
			// 跨会话读取门槛：bot 在内的任意会话都能列消息，但非本人所在的会话等于越权窥探，仅管理员放行
			let chatId = args.chat;
			if (chatId !== undefined && chatId !== current && crossChatDenied(deps, api.conversationId as number)) {
				return { output: [{ type: "text", text: "无权读取当前会话之外的聊天记录（仅管理员可用）。" }] };
			}
			if (chatId === undefined) {
				if (current === undefined) {
					// panel 会话无对应 chat：让模型转告用户该能力限飞书会话
					return { output: [{ type: "text", text: "当前会话（panel 任务）没有对应的飞书聊天，无法读取记录。" }] };
				}
				chatId = current;
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
					if (targetChat !== current && crossChatDenied(deps, api.conversationId as number)) {
						return { output: [{ type: "text", text: "无权读取当前会话之外的聊天记录（仅管理员可用）。" }] };
					}
					nameChat = targetChat;
					const half = Math.ceil(count / 2);
					const center = anchor.create_time ?? "0";
					const before = await listMessages(deps, { container_id_type: "chat", container_id: targetChat, sort_type: "ByCreateTimeDesc", page_size: half, end_time: center, with_sender_name: true });
					const after = await listMessages(deps, { container_id_type: "chat", container_id: targetChat, sort_type: "ByCreateTimeAsc", page_size: half, start_time: center, end_time: String(Date.now()), with_sender_name: true });
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

/** dwell.lark.image：按消息 id 拉取图片描述（下载 + 视觉模型单发单答）。群发图不 @ 不进上下文，模型在此按需回看。 */
function makeImageTool(deps: LarkDeps) {
	const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
	return defineTool({
		name: "dwell.lark.image",
		description:
			"看懂某条飞书图片消息的内容。输入消息 id（om_ 开头，取自 dwell.lark.read 返回）：下载图片并返回内容描述（主体、文字转录、图表数据）。典型场景：用户问「这是什么/这题怎么写」但上下文里没有图——先 dwell.lark.read 拿历史，找到 [图片] 占位的消息 id，再调本工具。仅支持图片消息，表情包不支持。",
		parameters: Type.Object({
			message: Type.String({ description: "图片消息 id（om_ 开头），取自 dwell.lark.read 的返回" }),
		}),
		replay: "safe",
		executionMode: "sequential",
		async execute(args, api) {
			const client = deps.getClient();
			if (client === undefined) return text("飞书通道未就绪", true);
			const describer = deps.getDescriber?.() ?? null;
			if (describer === null) return text("未配置视觉模型（需要 ZAI_CODING_CN_API_KEY），无法识别图片。", true);
			try {
				const message = client.im.v1.message as {
					get: (payload: { params?: { with_sender_name?: boolean }; path: { message_id: string } }) => Promise<{ code?: number; msg?: string; data?: { items?: MessageItem[] } }>;
				};
				const got = await message.get({ path: { message_id: args.message } });
				const item = got.data?.items?.[0];
				if (item === undefined) return text(`消息 ${args.message} 不存在或 bot 无权读取`, true);
				// 跨会话识图门槛：消息所在会话不是当前会话时仅管理员放行（与 dwell.lark.read 同一门槛，防拿别的群/私聊的消息 id 窥探图片）
				const current = deps.chatOf(api.conversationId as number);
				if ((item.chat_id ?? current) !== current && crossChatDenied(deps, api.conversationId as number)) {
					return text("无权查看当前会话之外的图片（仅管理员可用）。", true);
				}
				if (item.msg_type === "sticker") return text("这是表情包，暂不支持识别；请让用户改发图片消息。", true);
				if (item.msg_type !== "image") return text(`该消息不是图片（类型 ${item.msg_type ?? "?"}），无法识图。`, true);
				const imageKey = (JSON.parse(item.body?.content ?? "{}") as { image_key?: string }).image_key;
				if (imageKey === undefined) return text("消息内容缺少 image_key，无法下载。", true);
				const resource = client.im.v1.messageResource as {
					get: (payload: { path: { message_id: string; file_key: string }; params: { type: "image" } }) => Promise<{ getReadableStream: () => AsyncIterable<Uint8Array | Buffer> }>;
				};
				const response = await resource.get({ path: { message_id: args.message, file_key: imageKey }, params: { type: "image" } });
				const chunks: Buffer[] = [];
				for await (const chunk of response.getReadableStream()) chunks.push(Buffer.from(chunk));
				const buffer = Buffer.concat(chunks);
				const mime = sniffImageMime(buffer);
				if (mime === null) return text("图片格式无法识别（非 png/jpeg/gif/webp）。", true);
				if (buffer.length > 10 * 1024 * 1024) return text("图片超过 10MB，无法识别。", true);
				const description = await describer(buffer.toString("base64"), mime);
				return text(`图片 ${args.message} 的内容：\n${description}`);
			} catch (err) {
				const data = (err as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
				if (data?.code !== undefined) return text(`下载失败：飞书 API ${data.code}: ${data.msg ?? ""}`, true);
				return text(`下载失败：${err instanceof Error ? err.message : String(err)}`, true);
			}
		},
	});
}

/** 装配：deps 为运行时访问器（channel/directory/sessions 后于 harness 初始化）。 */
export function makeLarkExtension(deps: LarkDeps) {
	return defineExtension({
		name: "dwell-lark",
		tools: [makeReadTool(deps), makeImageTool(deps)],
		sections: [
			section(
				"lark",
				() => "用户提到「上面/之前/昨天聊的」等飞书历史内容而上下文缺失时，用 dwell.lark.read 读聊天记录（默认当前会话最近 20 条，返回自带消息 id，可作 around 参数二次展开前后文）。历史里的 [图片] 占位可展开：用户问及图中内容而上下文没有图时，把该条消息 id 传给 dwell.lark.image 获取图片描述。",
				{ tag: false },
			),
		],
	});
}
