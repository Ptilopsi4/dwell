// 飞书会话工具（dwell.lark.read/image/send）：SDK Client 直调或复用 index 的发送链路，显式优于隐式。
// 依赖运行时对象（channel/directory/sessions 在 main 中后于 harness 装配），用 getter 延迟绑定。
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Directory } from "../feishu/directory.ts";
import type { SendInput } from "../feishu/channel.ts";
import type { ImageDescriber } from "../harness.ts";
import { sniffImageMime } from "../media.ts";
import { sendPathViolation } from "./approval.ts";

/** 运行时依赖访问器：装配时变量可能尚未初始化，execute 时解引用。
 *  chatOf/senderOf/sendToChat 的实现（index 装配）内部先经 scopeOf 归并到父线——
 *  否则后台子会话的 lark 工具会把自己当成 panel 任务（无 chat）：send 谎报已交付、read 拒读、跨会话门槛误拒。 */
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
	/** 自家 app 的 app_id：app 发的消息 sender.id 即 app_id，用来区分自家回复卡与其他 bot 的卡 */
	getSelfAppId?: () => string | undefined;
	/** 发消息到会话所在 chat（复用 index 的锚点/话题规则）；返回 undefined = 当前会话没有飞书 chat（panel 任务） */
	sendToChat?: (conversationId: number, input: SendInput) => Promise<{ messageId: string } | undefined>;
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
	/** 卡片消息返回卡片实体当前内容（json_card 字段内联，流式卡正文只在实体里，发送时 JSON 是空壳）；
	 *  raw_card_content 未在官方文档枚举，openclaw 与官方 Lark 插件同款用法 */
	card_msg_content_type?: "raw_card_content";
};

type ListResult = { code?: number; msg?: string; data?: { has_more?: boolean; items?: MessageItem[] } };

/** 卡片消息提取：text/content 段拼尽（i18n_* 是原始卡 JSON 的多语言副本、summary 是会话列表预览，跳过避免重复/占位文案混入）。 */
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
			else if (key.startsWith("i18n_") || key === "summary") continue;
			else walk(value);
		}
	};
	walk(parsed);
	return texts.join(" ");
}

/** 单条内容提取：文本直出，富文本拼段，媒体占位；卡片按发送者分流；单条截 200 字。 */
function messageText(item: MessageItem, selfAppId: string | undefined, readOwn: boolean): string {
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
		// 自家回复卡默认占位：正文通常就在会话上下文里，且群聊里自家卡密度高，全提取徒增 token；
		// ownCards 显式要求时提取（compact 后正文不在上下文/用户问卡里写了什么）。
		// app 消息的 sender.id 即 app_id，以此区分其他 bot 的卡（一律提取）；
		// selfAppId 未知时保守视为自家卡
		const own = item.sender?.sender_type === "app" && (selfAppId === undefined || item.sender.id === selfAppId);
		if (own && !readOwn) {
			text = "[dwell reply card; pass ownCards: true to read its text]";
		} else {
			// 流式卡的消息体只有 card_id 引用，正文内联在 json_card 字符串里（卡片实体当前状态），展开后再提取
			let card = parsed;
			if (card !== null && typeof card === "object" && typeof (card as { json_card?: unknown }).json_card === "string") {
				try {
					card = JSON.parse((card as { json_card: string }).json_card);
				} catch {
					/* 解析失败保留原结构，提取不到则占位 */
				}
			}
			text = interactiveText(card);
			if (text === "") text = own ? "[dwell reply card; content not readable]" : item.sender?.sender_type === "app" ? "[card from another bot; content not readable]" : "[card message, content not readable]";
		}
	} else {
		const kinds: Record<string, string> = { image: "[image]", file: "[file]", audio: "[voice]", media: "[video]", sticker: "[sticker]", share_chat: "[group card]", share_user: "[contact card]", system: "[system message]" };
		text = kinds[item.msg_type ?? ""] ?? `[${item.msg_type ?? "unknown type"}]`;
	}
	text = text.replace(/\s+/g, " ").trim();
	// 卡片是结构化内容（PR/审批/报表），200 字必截断且无展开入口，放宽；text/post 维持 200 防长文刷屏
	const limit = item.msg_type === "interactive" ? 1000 : 200;
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function formatTime(createTime: string | undefined): string {
	const ms = Number(createTime ?? 0);
	if (!Number.isFinite(ms) || ms <= 0) return "??:??";
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 格式化一批消息（按时间正序传入）。 */
async function formatItems(items: MessageItem[], chatName: string | undefined, directory: Directory | undefined, selfAppId: string | undefined, readOwn: boolean): Promise<string> {
	// app 发送者的 id 是 app_id（cli_ 开头），不进用户名查询
	const senderIds = items.filter((i) => i.sender?.sender_type !== "app").map((i) => i.sender?.id).filter((id): id is string => id !== undefined);
	const names = directory !== undefined && senderIds.length > 0 ? await directory.userNames(senderIds) : {};
	const lines = items.map((item) => {
		const senderId = item.sender?.id ?? "";
		const name = item.senderName || (senderId in names ? names[senderId] : undefined) || (senderId === "" ? "?" : senderId.slice(-6));
		return `[${formatTime(item.create_time)}] ${name} (${item.message_id ?? "?"}): ${messageText(item, selfAppId, readOwn)}`;
	});
	return `Recent messages in ${chatName ?? "this chat"} (oldest first; the id in parentheses works as \`around\` or as input to dwell.lark.image):\n${lines.join("\n")}`;
}

/** 拉取一页消息（list 只取第一页，page_size 上限 50）。 */
async function listMessages(deps: LarkDeps, params: ListParams): Promise<MessageItem[]> {
	const client = deps.getClient();
	if (client === undefined) throw new Error("Feishu channel is not ready");
	const message = client.im.v1.message as {
		list: (payload: { params: ListParams }) => Promise<ListResult>;
		get: (payload: { params?: { with_sender_name?: boolean }; path: { message_id: string } }) => Promise<{ code?: number; msg?: string; data?: { items?: MessageItem[] } }>;
	};
	try {
		const result = await message.list({ params: { card_msg_content_type: "raw_card_content", ...params } });
		if (result.code !== undefined && result.code !== 0) throw new Error(`Feishu API ${result.code}: ${result.msg ?? ""}`);
		return result.data?.items ?? [];
	} catch (err) {
		// axios 外壳只报 HTTP 状态，飞书真实 code/msg 在 response.data 里
		const data = (err as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
		if (data?.code !== undefined) throw new Error(`Feishu API ${data.code}: ${data.msg ?? ""}`);
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
			"Read Feishu chat history (the current chat by default). Use it when the user refers to something said earlier that is not in your context, to review a group chat, or to look at other task threads. Returns messages oldest first, with sender and message id. To expand the context around one message, call without arguments to get the list, then pass the returned om_ id as `around` (ids appear only in this tool's output; users cannot see them). Card messages from other bots are returned with their extracted text; dwell's own reply cards show only a placeholder (normally their content is in your context) unless you pass ownCards: true, e.g. after compaction or when the user asks what an earlier card said. Reading chats other than the current one (chat/around pointing elsewhere) is admin-only.",
		parameters: Type.Object({
			count: Type.Optional(Type.Number({ description: "Number of messages to read (default 20, max 50)" })),
			around: Type.Optional(Type.String({ description: "Message id (starts with om_): read half before and half after it; take it from this tool's previous output" })),
			chat: Type.Optional(Type.String({ description: "Chat id (starts with oc_): read another chat (the bot must be a member). Defaults to the current chat" })),
			sinceHours: Type.Optional(Type.Number({ description: "Only read messages from the last N hours (use with chat)" })),
			ownCards: Type.Optional(Type.Boolean({ description: "Also extract dwell's own reply cards instead of a placeholder. Use it when earlier card content is no longer in your context (after compaction) or the user asks what a card said" })),
		}),
		replay: "safe",
		executionMode: "sequential",
		async execute(args, api) {
			const count = Math.min(Math.max(Math.trunc(args.count ?? 20), 1), 50);
			const current = deps.chatOf(api.conversationId as number);
			// 跨会话读取门槛：bot 在内的任意会话都能列消息，但非本人所在的会话等于越权窥探，仅管理员放行
			let chatId = args.chat;
			if (chatId !== undefined && chatId !== current && crossChatDenied(deps, api.conversationId as number)) {
				return { output: [{ type: "text", text: "Reading chats other than the current one is admin-only." }] };
			}
			if (chatId === undefined) {
				if (current === undefined) {
					// panel 会话无对应 chat：让模型转告用户该能力限飞书会话
					return { output: [{ type: "text", text: "This conversation (a panel task) has no Feishu chat, so there is no history to read." }] };
				}
				chatId = current;
			}
			const directory = deps.getDirectory();
			let nameChat: string = chatId;
			try {
				let items: MessageItem[];
				if (args.around !== undefined) {
					const client = deps.getClient();
					if (client === undefined) throw new Error("Feishu channel is not ready");
					const message = client.im.v1.message as {
						list: (payload: { params: ListParams }) => Promise<ListResult>;
						get: (payload: { params?: { with_sender_name?: boolean }; path: { message_id: string } }) => Promise<{ code?: number; msg?: string; data?: { items?: MessageItem[] } }>;
					};
					const got = await message.get({ params: { with_sender_name: true }, path: { message_id: args.around } });
					const anchor = got.data?.items?.[0];
					if (anchor === undefined) throw new Error(`Message ${args.around} does not exist or the bot cannot read it`);
					const targetChat: string = anchor.chat_id ?? chatId; // 锚点消息所在会话优先（chatId 已收窄非空）
					if (targetChat !== current && crossChatDenied(deps, api.conversationId as number)) {
						return { output: [{ type: "text", text: "Reading chats other than the current one is admin-only." }] };
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
				if (items.length === 0) return { output: [{ type: "text", text: "No readable messages in this chat (none in the time range, or the bot lacks permission)." }] };
				const chatName = directory !== undefined ? await directory.chatName(nameChat) : undefined;
				return { output: [{ type: "text", text: await formatItems(items, chatName, directory, deps.getSelfAppId?.(), args.ownCards === true) }] };
			} catch (err) {
				return { output: [{ type: "text", text: `Read failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
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
			"Understand the content of a Feishu image message. Input a message id (starts with om_, from dwell.lark.read output); the tool downloads the image and returns a description (subject, transcribed text, chart data). Typical case: the user asks what something is or how to solve it, but the image is not in your context. Call dwell.lark.read first, find the message id of the [image] placeholder, then call this tool. Only image messages are supported; stickers are not.",
		parameters: Type.Object({
			message: Type.String({ description: "Image message id (starts with om_), from dwell.lark.read output" }),
		}),
		replay: "safe",
		executionMode: "sequential",
		async execute(args, api) {
			const client = deps.getClient();
			if (client === undefined) return text("Feishu channel is not ready", true);
			const describer = deps.getDescriber?.() ?? null;
			if (describer === null) return text("No vision model is configured (ZAI_CODING_CN_API_KEY is required), so the image cannot be recognized.", true);
			try {
				const message = client.im.v1.message as {
					get: (payload: { params?: { with_sender_name?: boolean }; path: { message_id: string } }) => Promise<{ code?: number; msg?: string; data?: { items?: MessageItem[] } }>;
				};
				const got = await message.get({ path: { message_id: args.message } });
				const item = got.data?.items?.[0];
				if (item === undefined) return text(`Message ${args.message} does not exist or the bot cannot read it`, true);
				// 跨会话识图门槛：消息所在会话不是当前会话时仅管理员放行（与 dwell.lark.read 同一门槛，防拿别的群/私聊的消息 id 窥探图片）
				const current = deps.chatOf(api.conversationId as number);
				if ((item.chat_id ?? current) !== current && crossChatDenied(deps, api.conversationId as number)) {
					return text("Viewing images from chats other than the current one is admin-only.", true);
				}
				if (item.msg_type === "sticker") return text("This is a sticker, which cannot be recognized; ask the user to send it as an image message.", true);
				if (item.msg_type !== "image") return text(`This message is not an image (type ${item.msg_type ?? "?"}), so it cannot be recognized.`, true);
				const imageKey = (JSON.parse(item.body?.content ?? "{}") as { image_key?: string }).image_key;
				if (imageKey === undefined) return text("The message content has no image_key, so the image cannot be downloaded.", true);
				const resource = client.im.v1.messageResource as {
					get: (payload: { path: { message_id: string; file_key: string }; params: { type: "image" } }) => Promise<{ getReadableStream: () => AsyncIterable<Uint8Array | Buffer> }>;
				};
				const response = await resource.get({ path: { message_id: args.message, file_key: imageKey }, params: { type: "image" } });
				const chunks: Buffer[] = [];
				for await (const chunk of response.getReadableStream()) chunks.push(Buffer.from(chunk));
				const buffer = Buffer.concat(chunks);
				const mime = sniffImageMime(buffer);
				if (mime === null) return text("Unrecognized image format (not png/jpeg/gif/webp).", true);
				if (buffer.length > 10 * 1024 * 1024) return text("The image is larger than 10MB and cannot be recognized.", true);
				const description = await describer(buffer.toString("base64"), mime);
				return text(`Content of image ${args.message}:\n${description}`);
			} catch (err) {
				const data = (err as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
				if (data?.code !== undefined) return text(`Download failed: Feishu API ${data.code}: ${data.msg ?? ""}`, true);
				return text(`Download failed: ${err instanceof Error ? err.message : String(err)}`, true);
			}
		},
	});
}

// 飞书上传接口限额：图片 10MB、文件 30MB、不允许空文件
const SEND_IMAGE_MAX = 10 * 1024 * 1024;
const SEND_FILE_MAX = 30 * 1024 * 1024;

/** dwell.lark.send：把会话 cwd 内的文件/图片发回当前会话的飞书聊天（agent 生成物交给用户的唯一出口）。 */
function makeSendTool(deps: LarkDeps) {
	const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
	return defineTool({
		name: "dwell.lark.send",
		description:
			"Send a file from your working directory to the current Feishu chat. Typical case: the user wants a report, chart, data export, or anything else you saved to disk. Limits: only files inside this session's working directory (path checks block .. and symlink escapes); only to the current chat, never to other chats or outside contacts; images (png/jpeg/gif/webp) up to 10MB, other files up to 30MB, no empty files. In panel tasks the file is offered as a download in the panel. When the user wants a file you produced, send it with this tool instead of replying with a server path.",
		parameters: Type.Object({
			path: Type.String({ description: "Path of the file to send (relative to the working directory, or absolute)" }),
		}),
		executionMode: "sequential",
		async execute(args, api) {
			const cwd = api.env?.cwd;
			if (cwd === undefined) return text("This conversation has no working directory, so the file cannot be located.", true);
			const send = deps.sendToChat;
			if (send === undefined) return text("The send path is not wired up, so the file cannot be sent.", true);
			// panel 任务（无对应 chat）不发飞书，文件由 panel 工具行下载；与飞书发送共用同一套校验
			const panelTask = deps.chatOf(api.conversationId as number) === undefined;
			// 路径治理先于 stat：越界路径一律同一拒绝，不暴露 cwd 外文件是否存在
			const violation = await sendPathViolation(args.path, cwd);
			if (violation !== undefined) return text(violation, true);
			const fileName = basename(resolve(cwd, args.path));
			try {
				// 读判定过的真实路径而非字面路径，缩小「判定后换软链」的窗口
				const target = await realpath(resolve(cwd, args.path));
				const st = await stat(target);
				if (!st.isFile()) return text(`Not a regular file: ${args.path}`, true);
				if (st.size === 0) return text(`File ${fileName} is empty (0 bytes); Feishu does not allow sending empty files.`, true);
				if (st.size > SEND_FILE_MAX) return text(`File ${fileName} exceeds the 30MB limit (${(st.size / 1024 / 1024).toFixed(1)}MB) and cannot be sent.`, true);
				if (panelTask) return text(`Offered as a download in the panel: ${fileName} (the user clicks download on the tool row)`);
				const buffer = await readFile(target);
				const isImage = sniffImageMime(buffer) !== null && buffer.length <= SEND_IMAGE_MAX;
				const input: SendInput = isImage
					? { image: { source: buffer } }
					: { file: { source: buffer, fileName } };
				const sent = await send(api.conversationId as number, input);
				if (sent === undefined) return text("Feishu is not connected; send failed.", true);
				return text(`Sent ${isImage ? "image" : "file"} ${fileName} to the current chat.`);
			} catch (err) {
				// axios 外壳只报 HTTP 状态，飞书真实 code/msg 在 response.data 里
				const data = (err as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
				if (data?.code !== undefined) return text(`Send failed: Feishu API ${data.code}: ${data.msg ?? ""}`, true);
				return text(`Send failed: ${err instanceof Error ? err.message : String(err)}`, true);
			}
		},
	});
}

/** 装配：deps 为运行时访问器（channel/directory/sessions 后于 harness 初始化）。 */
export function makeLarkExtension(deps: LarkDeps) {
	return defineExtension({
		name: "dwell-lark",
		tools: [makeReadTool(deps), makeImageTool(deps), makeSendTool(deps)],
		sections: [
			section(
				"lark",
				() => "When the user refers to earlier Feishu messages (\"above\", \"before\", \"what we discussed yesterday\") that are missing from your context, read the chat history with dwell.lark.read (the 20 most recent messages of the current chat by default; the output carries message ids you can pass as `around` to expand the context). [image] placeholders in the history can be expanded: when the user asks about an image that is not in your context, pass that message id to dwell.lark.image to get a description. When the user wants a file you produced (report, chart, data export), send it with dwell.lark.send instead of replying with a server path.",
				{ tag: false },
			),
		],
	});
}
