// node --test "test/panel.test.ts"
// panel 请求准入：POST Content-Type / Origin 同源 / Host 白名单（防 CSRF 与 DNS rebinding）；/api/file 判定与下载响应头。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkPanelRequest, downloadHeaders, healthOf, hostNameOf, ingestUpload, isLocalSource, localAddresses, resolveDownload } from "../src/web/server.ts";

const HOSTS = new Set(["localhost", "10.0.0.5"]);

const ok = (req: Parameters<typeof checkPanelRequest>[0]): boolean => {
	try {
		checkPanelRequest(req, HOSTS);
		return true;
	} catch {
		return false;
	}
};

test("hostNameOf：去端口与 IPv6 方括号", () => {
	assert.equal(hostNameOf("10.0.0.5:7788"), "10.0.0.5");
	assert.equal(hostNameOf("[::1]:7788"), "::1");
	assert.equal("Evil.COM:80".toLowerCase(), "evil.com:80");
	assert.equal(hostNameOf("Example.com"), "example.com");
});

test("合法请求放行：IP 直连 / 配置名 / 同源 POST", () => {
	assert.equal(ok({ method: "GET", host: "10.0.0.5:7788" }), true);
	assert.equal(ok({ method: "GET", host: "[::1]:7788" }), true);
	assert.equal(ok({ method: "GET", host: "localhost:7788" }), true);
	assert.equal(ok({ method: "POST", host: "10.0.0.5:7788", origin: "http://10.0.0.5:7788", contentType: "application/json" }), true);
	assert.equal(ok({ method: "GET", host: "10.0.0.5:7788", origin: "http://10.0.0.5:7788" }), true); // GET 带 Origin（导航回退）同源放行
});

test("CSRF：跨站 Origin 拒绝，text/plain POST 拒绝", () => {
	// 攻击页从 evil.com 借 pt 浏览器向内网 panel 发 POST（text/plain 免预检）
	assert.equal(ok({ method: "POST", host: "10.0.0.5:7788", origin: "https://evil.com", contentType: "text/plain" }), false);
	assert.equal(ok({ method: "POST", host: "10.0.0.5:7788", contentType: "text/plain" }), false); // 无 Origin 但 CT 不对
	assert.equal(ok({ method: "POST", host: "10.0.0.5:7788", origin: "null", contentType: "application/json" }), false); // 沙箱 iframe
	assert.equal(ok({ method: "POST", host: "localhost:7788", origin: "http://localhost:7788", contentType: "application/json; charset=utf-8" }), true); // charset 后缀放行
});

test("DNS rebinding：非 IP 非配置域名拒绝（含 SSE 读通道）", () => {
	assert.equal(ok({ method: "GET", host: "evil.com" }), false);
	assert.equal(ok({ method: "GET", host: "panel.dwell.example" }), false);
	assert.equal(ok({ method: "GET" }), false); // 无 Host
});

test("healthOf：feishu failed → 503 ok=false，其余（含 off/reconnecting）200 ok=true；sandbox 只透出状态不影响 ok", () => {
	assert.deepEqual(healthOf("failed", 42, true), { code: 503, body: { ok: false, uptimeSec: 42, feishu: "failed", sandbox: true } });
	assert.deepEqual(healthOf("connected", 42, false), { code: 200, body: { ok: true, uptimeSec: 42, feishu: "connected", sandbox: false } });
	assert.deepEqual(healthOf("reconnecting", 7, true), { code: 200, body: { ok: true, uptimeSec: 7, feishu: "reconnecting", sandbox: true } });
	assert.deepEqual(healthOf("off", 0, false), { code: 200, body: { ok: true, uptimeSec: 0, feishu: "off", sandbox: false } });
});

// ── 本机来源拒绝：bash 与 panel 同机，本机源地址 = agent 自己发的请求 ──

test("isLocalSource：回环、接口地址（含映射/scope 形态）、缺失地址均算本机；peer 地址放行", () => {
	const local = new Set(["10.8.0.1", "fe80::1"]);
	for (const a of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1", "10.8.0.1", "::ffff:10.8.0.1", "fe80::1%wg0", "FE80::1", undefined, ""]) {
		assert.equal(isLocalSource(a, local), true, `应算本机：${a}`);
	}
	for (const a of ["10.8.0.2", "::ffff:10.8.0.2", "10.0.0.5", "fe80::2%wg0"]) {
		assert.equal(isLocalSource(a, local), false, `应放行：${a}`);
	}
});

test("localAddresses：含本机回环接口地址", () => {
	const addrs = localAddresses();
	assert.ok(addrs.has("127.0.0.1") || addrs.has("::1"), [...addrs].join(","));
});

// ── GET /api/file：会话 cwd 内文件下载 ──

async function tempCwd(t: import("node:test").TestContext): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "dwell-panel-file-"));
	t.after(async () => {
		await rm(cwd, { recursive: true, force: true });
	});
	return cwd;
}

test("resolveDownload：cwd 内文件 200（real/name/size）", async (t) => {
	const cwd = await tempCwd(t);
	await writeFile(join(cwd, "a.txt"), "hello");
	// 期望值走 realpath：macOS 的 /var 是 /private/var 软链
	assert.deepEqual(await resolveDownload(cwd, "a.txt"), { status: 200, real: await realpath(join(cwd, "a.txt")), size: 5, name: "a.txt" });
});

test("resolveDownload：无 cwd 404 / 空 path 400 / 越界 403 / 目录与不存在 404", async (t) => {
	const cwd = await tempCwd(t);
	await mkdir(join(cwd, "sub"));
	assert.deepEqual(await resolveDownload(undefined, "a.txt"), { status: 404, error: "该会话没有工作目录" });
	assert.deepEqual(await resolveDownload(cwd, ""), { status: 400, error: "path required" });
	assert.deepEqual(await resolveDownload(cwd, "../x.txt"), { status: 403, error: "只能下载本会话工作目录内的文件" });
	assert.deepEqual(await resolveDownload(cwd, "sub"), { status: 404, error: "不是普通文件" });
	assert.deepEqual(await resolveDownload(cwd, "nope.txt"), { status: 404, error: "文件不存在" });
});

test("downloadHeaders：attachment + nosniff + no-store，非 ASCII 文件名 RFC 5987 回退", () => {
	const plain = downloadHeaders("report.md", 12);
	assert.equal(plain["content-type"], "application/octet-stream");
	assert.equal(plain["content-length"], "12");
	assert.equal(plain["content-disposition"], 'attachment; filename="report.md"; filename*=UTF-8\'\'report.md');
	assert.equal(plain["x-content-type-options"], "nosniff");
	assert.equal(plain["cache-control"], "no-store");
	// ASCII 回退：非 [\w.-] 字符一律换成 _，原名走 filename*（UTF-8 + 百分号编码）
	assert.equal(downloadHeaders("值班日报.md", 1)["content-disposition"], `attachment; filename="____.md"; filename*=UTF-8''${encodeURIComponent("值班日报.md")}`);
});

// ── POST /api/upload 判定：panel 上传图片/文件 ──

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("ingestUpload：无工作目录 404", async () => {
	assert.deepEqual(await ingestUpload(undefined, "a.png", "aGk=", null), { status: 404, error: "该会话没有工作目录" });
});

test("ingestUpload：缺 name/data 400、空数据 400、超 10MB 413", async (t) => {
	const cwd = await tempCwd(t);
	assert.equal((await ingestUpload(cwd, "", "aGk=", null)).status, 400);
	assert.equal((await ingestUpload(cwd, undefined, "aGk=", null)).status, 400);
	assert.equal((await ingestUpload(cwd, "a.png", undefined, null)).status, 400);
	assert.equal((await ingestUpload(cwd, "a.png", 42, null)).status, 400);
	assert.equal((await ingestUpload(cwd, "a.png", "", null)).status, 400);
	assert.equal((await ingestUpload(cwd, "big.bin", Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"), null)).status, 413);
});

test("ingestUpload：PNG 魔数 → kind image，part 含描述（注入 describer）", async (t) => {
	const cwd = await tempCwd(t);
	const seen: string[] = [];
	const result = await ingestUpload(cwd, "shot.png", PNG_BYTES.toString("base64"), async (base64, mime) => {
		seen.push(`${mime}:${base64}`);
		return "一张绿色按钮截图";
	});
	assert.equal(result.status, 200);
	if (result.status !== 200) return;
	assert.equal(result.kind, "image");
	assert.equal(result.size, PNG_BYTES.length);
	assert.match(result.path, /^uploads\/[0-9a-f]{8}-shot\.png$/);
	assert.equal(result.part, `[图片1 ${result.path}]\n一张绿色按钮截图`);
	assert.deepEqual(seen, [`image/png:${PNG_BYTES.toString("base64")}`]);
	// 落盘文件确实存在且内容一致
	const files = await readdir(join(cwd, "uploads"));
	assert.equal(files.length, 1);
	assert.ok(PNG_BYTES.equals(await readFile(join(cwd, "uploads", files[0]), null)));
});

test("ingestUpload：文本 → kind file，文件落在 cwd/uploads", async (t) => {
	const cwd = await tempCwd(t);
	const result = await ingestUpload(cwd, "notes.txt", Buffer.from("hello dwell").toString("base64"), null);
	assert.equal(result.status, 200);
	if (result.status !== 200) return;
	assert.equal(result.kind, "file");
	assert.equal(result.size, 11);
	assert.match(result.path, /^uploads\/[0-9a-f]{8}-notes\.txt$/);
	assert.match(result.part, /^\[文件1\] [0-9a-f]{8}-notes\.txt（0\.0KB）已保存到 uploads\/[0-9a-f]{8}-notes\.txt，可用 read 工具读取。$/);
	assert.equal(await readFile(join(cwd, "uploads", result.path.slice("uploads/".length)), "utf8"), "hello dwell");
});
