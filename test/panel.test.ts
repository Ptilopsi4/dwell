// node --test "test/panel.test.ts"
// panel 请求准入：POST Content-Type / Origin 同源 / Host 白名单（防 CSRF 与 DNS rebinding）；/api/file 判定与下载响应头。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkPanelRequest, downloadHeaders, healthOf, hostNameOf, resolveDownload } from "../src/web/server.ts";

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

test("healthOf：feishu failed → 503 ok=false，其余（含 off/reconnecting）200 ok=true", () => {
	assert.deepEqual(healthOf("failed", 42), { code: 503, body: { ok: false, uptimeSec: 42, feishu: "failed" } });
	assert.deepEqual(healthOf("connected", 42), { code: 200, body: { ok: true, uptimeSec: 42, feishu: "connected" } });
	assert.deepEqual(healthOf("reconnecting", 7), { code: 200, body: { ok: true, uptimeSec: 7, feishu: "reconnecting" } });
	assert.deepEqual(healthOf("off", 0), { code: 200, body: { ok: true, uptimeSec: 0, feishu: "off" } });
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
