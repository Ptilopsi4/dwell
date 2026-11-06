// bash 沙箱拼装单测：wrapperScript/selfTestScript 是纯函数可跨平台验证；probeSandbox 在本机（Windows）
// 只覆盖平台短路分支——真实 bwrap 行为由服务器探针 test/probe-bwrap.ts 验证。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { probeSandbox, selfTestScript, wrapperScript } from "../src/sandbox.ts";

test("wrapperScript：exec 前缀与关键挂载参数", () => {
	const script = wrapperScript("/usr/bin/bwrap", ["/etc", "/opt/node24"]);
	assert.ok(script.startsWith("#!/bin/sh"));
	assert.ok(script.includes("exec "));
	assert.ok(script.includes("pwd -P"));
	assert.ok(script.includes("--die-with-parent"));
	assert.ok(script.includes("--unshare-pid"));
	assert.ok(script.includes("--symlink usr/bin /bin"));
	// /tmp 用 bind 不用 tmpfs：分命令攒中间文件、与文件工具互见（PLAN 挂载表）
	assert.ok(script.includes("--bind /tmp /tmp"));
	assert.ok(!script.includes("--tmpfs"));
});

test("wrapperScript：--clearenv 先于两个 --setenv（bwrap 按序应用，反序会把 PATH/HOME 一并清掉）", () => {
	const script = wrapperScript("/usr/bin/bwrap", []);
	const clearenv = script.indexOf("--clearenv");
	const path = script.indexOf("--setenv PATH");
	const home = script.indexOf("--setenv HOME");
	assert.ok(clearenv >= 0, "含 --clearenv");
	assert.ok(path > clearenv, "--setenv PATH 在 --clearenv 之后");
	assert.ok(home > clearenv, "--setenv HOME 在 --clearenv 之后");
});

test("wrapperScript：roDirs 去重且保持首次出现顺序（固定项 /etc 与 DNS 解析目录不重复拼）", () => {
	const script = wrapperScript("/usr/bin/bwrap", ["/opt/node24", "/etc", "/srv/extra", "/opt/node24", "/run/resolvconf"]);
	assert.equal(script.split("--ro-bind-try /etc").length - 1, 1, "/etc 只出现一次（固定项已含）");
	assert.equal(script.split("--ro-bind-try /run/resolvconf").length - 1, 1, "/run/resolvconf 只出现一次");
	assert.equal(script.split("--ro-bind-try /srv/extra").length - 1, 1, "列表内重复项去重");
	assert.ok(script.indexOf("--ro-bind-try /opt/node24") < script.indexOf("--ro-bind-try /srv/extra"), "保持首次出现顺序");
	assert.ok(script.indexOf("--ro-bind /usr /usr") >= 0, "/usr 固定 ro-bind");
});

test("selfTestScript：包含全部断言路径字面量", () => {
	const script = selfTestScript({ state: "/opt/dwell/state", appRoot: "/opt/dwell/app", sibling: "/data/work/.selftest-sibling", marker: "/data/work/.selftest/.marker" });
	for (const p of ["/opt/dwell/state", "/opt/dwell/app", "/data/work/.selftest-sibling", "/data/work/.selftest/.marker", "/etc/resolv.conf", "/usr/.sb-test"]) {
		assert.ok(script.includes(p), `缺断言路径 ${p}`);
	}
});

// 失败路径实跑：断言"state 目录可见"命中（/ 存在）→ exit 1。Windows 开发机没有 sh，跳过（真实失败路径在服务器探针覆盖）
test("selfTestScript：断言失败时非 0 退出", { skip: process.platform === "win32" ? "本机无 sh" : false }, () => {
	const script = selfTestScript({ state: "/", appRoot: "/x-not-exist", sibling: "/y-not-exist", marker: "/tmp/.sb-marker" });
	const r = spawnSync("sh", ["-c", script], { encoding: "utf8" });
	assert.equal(r.status, 1, `stderr: ${r.stderr}`);
	assert.match(r.stderr, /state 目录可见/);
});

test("probeSandbox：非 Linux 平台不启用", { skip: process.platform === "linux" ? "Linux 上真实探测由 probe-bwrap.ts 覆盖" : false }, async () => {
	const s = await probeSandbox({ dataDir: "./data", stateDir: "./state", appRoot: ".", forceOff: false });
	assert.equal(s.enabled, false);
	assert.ok(s.reason?.includes("非 Linux"));
});

test("probeSandbox：forceOff 关闭（平台检查在前，非 Linux 上先被平台分支短路）", async () => {
	const s = await probeSandbox({ dataDir: "./data", stateDir: "./state", appRoot: ".", forceOff: true });
	assert.equal(s.enabled, false);
	if (process.platform === "linux") assert.equal(s.reason, "DWELL_SANDBOX=off");
	else assert.ok(s.reason?.includes("非 Linux"), "平台检查在 forceOff 之前");
});
