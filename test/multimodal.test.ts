// node --test "test/multimodal.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeResources, sniffImageMime } from "../src/media.ts";
import type { NormalizedMessage } from "../src/feishu/channel.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

function msgOf(resources: { type: "image" | "file" | "audio" | "sticker"; fileKey: string; fileName?: string }[]): NormalizedMessage {
	return { resources, content: "", rawContentType: "image" } as unknown as NormalizedMessage;
}

test("sniffImageMime 识别四种图片格式与未知数据", () => {
	assert.equal(sniffImageMime(PNG), "image/png");
	assert.equal(sniffImageMime(JPEG), "image/jpeg");
	assert.equal(sniffImageMime(Buffer.from("GIF89a00000000")), "image/gif");
	assert.equal(sniffImageMime(Buffer.from("RIFF0000WEBPVP8 ")), "image/webp");
	assert.equal(sniffImageMime(Buffer.from("not an image")), null);
	assert.equal(sniffImageMime(Buffer.from([1, 2])), null); // 过短
});

test("图片经 describer 生成描述并落盘留档", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-mm-"));
	const seen: { mime: string; data: string }[] = [];
	const out = await describeResources(msgOf([{ type: "image", fileKey: "k1" }]), dir, {
		download: async () => PNG,
		describer: async (base64, mime) => {
			seen.push({ mime, data: base64 });
			return "一张红色测试图";
		},
	});
	assert.deepEqual(seen, [{ mime: "image/png", data: PNG.toString("base64") }]);
	assert.match(out, /^\[图片1 uploads\/image-1\.png\]\n一张红色测试图$/);
	assert.deepEqual(await readdir(join(dir, "uploads")), ["image-1.png"]);
	assert.ok(PNG.equals(await readFile(join(dir, "uploads", "image-1.png"), null)));
});

test("无 describer 时图片降级留档提示", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-mm-"));
	const out = await describeResources(msgOf([{ type: "image", fileKey: "k1" }]), dir, {
		download: async () => JPEG,
		describer: null,
	});
	assert.match(out, /\[图片1\] 已存 uploads\/image-1\.jpeg（当前未配置视觉模型，仅留档）。/);
});

test("非图片魔数留档但不做视觉分析", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-mm-"));
	let called = false;
	const out = await describeResources(msgOf([{ type: "image", fileKey: "k1" }]), dir, {
		download: async () => Buffer.from("PDF-1.7 fake"),
		describer: async () => {
			called = true;
			return "不应被调用";
		},
	});
	assert.equal(called, false);
	assert.match(out, /无法识别或超过 10MB，未做视觉分析/);
});

test("文件落盘 sanitize 文件名并提示 read 路径", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-mm-"));
	const out = await describeResources(msgOf([{ type: "file", fileKey: "k2", fileName: "..\\evil:/name.txt" }]), dir, {
		download: async () => Buffer.from("hello"),
		describer: null,
	});
	assert.match(out, /\[文件1\] name\.txt（0\.0KB）已保存到 uploads\/name\.txt，可用 read 工具读取。/);
	assert.deepEqual(await readdir(join(dir, "uploads")), ["name.txt"]);
});

test("音视频与下载失败的降级提示", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dwell-mm-"));
	const out = await describeResources(
		msgOf([
			{ type: "audio", fileKey: "k3", fileName: "voice.opus" },
			{ type: "image", fileKey: "k4" },
		]),
		dir,
		{
			download: async () => {
				throw new Error("boom");
			},
			describer: null,
		},
	);
	assert.match(out, /\[媒体1\] voice\.opus：暂不支持音视频/);
	assert.match(out, /\[资源2\] image：下载失败。/);
});
