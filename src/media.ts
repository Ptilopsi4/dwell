// 多模态入站预处理：图片→视觉模型描述（subagent），文件→落盘 cwd/uploads。主模型无视觉，上下文里只有描述/路径文本。
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { NormalizedMessage } from "./feishu/channel.ts";
import type { ImageDescriber } from "./harness.ts";

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** 图片魔数嗅探：飞书 fileKey 无扩展名。 */
export function sniffImageMime(buffer: Buffer): string | null {
	if (buffer.length < 12) return null;
	if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
	if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return null;
}

/** 资源预处理：图片→描述（describer），文件→落盘；原图统一落盘留档。下载与视觉依赖由调用方注入（主链路传 channel 与启动装配的 describer）。 */
export async function describeResources(
	msg: NormalizedMessage,
	cwd: string,
	deps: { download: (fileKey: string, type: "image" | "file") => Promise<Buffer>; describer: ImageDescriber | null },
): Promise<string> {
	const parts: string[] = [];
	let index = 0;
	for (const resource of msg.resources ?? []) {
		index++;
		const label = resource.fileName ?? resource.type;
		if (resource.type === "audio" || resource.type === "video") {
			parts.push(`[媒体${index}] ${label}：暂不支持音视频，请改发图片或文件。`);
			continue;
		}
		let buffer: Buffer;
		try {
			buffer = await deps.download(resource.fileKey, resource.type === "sticker" || resource.type === "image" ? "image" : "file");
		} catch {
			parts.push(`[资源${index}] ${label}：下载失败。`);
			continue;
		}
		const uploads = join(cwd, "uploads");
		if (resource.type === "image" || resource.type === "sticker") {
			const mime = sniffImageMime(buffer);
			const ext = mime?.split("/")[1] ?? "bin";
			const saved = `image-${index}.${ext}`;
			await mkdir(uploads, { recursive: true });
			await writeFile(join(uploads, saved), buffer);
			if (mime === null || buffer.length > IMAGE_MAX_BYTES) {
				parts.push(`[图片${index}] 已存 uploads/${saved}（无法识别或超过 10MB，未做视觉分析）。`);
				continue;
			}
			if (deps.describer === null) {
				parts.push(`[图片${index}] 已存 uploads/${saved}（当前未配置视觉模型，仅留档）。`);
				continue;
			}
			try {
				const description = await deps.describer(buffer.toString("base64"), mime);
				parts.push(`[图片${index} uploads/${saved}]\n${description}`);
			} catch (err) {
				parts.push(`[图片${index}] 已存 uploads/${saved}（视觉分析失败：${err instanceof Error ? err.message : String(err)}）。`);
			}
			continue;
		}
		// file：落盘，read 工具可直接读（无需视觉）
		const safeName = basename(resource.fileName ?? `file-${index}`).replace(/[\\/:*?"<>|]/g, "_");
		await mkdir(uploads, { recursive: true });
		await writeFile(join(uploads, safeName), buffer);
		parts.push(`[文件${index}] ${safeName}（${(buffer.length / 1024).toFixed(1)}KB）已保存到 uploads/${safeName}，可用 read 工具读取。`);
	}
	return parts.join("\n\n");
}
