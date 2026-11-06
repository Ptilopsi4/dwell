// node --test "test/panel.test.ts"
// panel 请求准入：POST Content-Type / Origin 同源 / Host 白名单（防 CSRF 与 DNS rebinding）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPanelRequest, healthOf, hostNameOf } from "../src/web/server.ts";

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
