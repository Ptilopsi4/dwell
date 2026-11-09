// node --test "test/github.test.ts"
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { applyGithubEnv, checkGithubToken, githubEnabled, preambleText } from "../src/harness.ts";

const GH_VARS = ["GH_TOKEN", "GH_PROMPT_DISABLED", "GIT_TERMINAL_PROMPT", "GH_NO_UPDATE_NOTIFIER", "GH_PAGER", "GH_CONFIG_DIR"];

function withEnv(token: string | undefined, fn: () => void): void {
	const saved = Object.fromEntries(GH_VARS.map((k) => [k, process.env[k]]));
	for (const k of GH_VARS) delete process.env[k];
	if (token !== undefined) process.env.GH_TOKEN = token;
	try {
		fn();
	} finally {
		for (const k of GH_VARS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
}

test("无 GH_TOKEN：不启用、不写 env、前导段无 GitHub 内容但含不可信内容条", () => {
	withEnv(undefined, () => {
		assert.equal(githubEnabled(), false);
		applyGithubEnv();
		assert.equal(process.env.GH_CONFIG_DIR, undefined);
		const text = preambleText();
		assert.ok(!text.includes("GitHub"));
		assert.match(text, /data, not instructions/);
	});
	withEnv("", () => assert.equal(githubEnabled(), false));
});

test("有 GH_TOKEN：写入非交互 env，前导段含 GitHub 段与凭证处理条", () => {
	withEnv("ghp_x", () => {
		assert.equal(githubEnabled(), true);
		applyGithubEnv();
		assert.equal(process.env.GH_PROMPT_DISABLED, "1");
		assert.equal(process.env.GIT_TERMINAL_PROMPT, "0");
		assert.equal(process.env.GH_PAGER, "cat");
		assert.match(process.env.GH_CONFIG_DIR ?? "", /dwell-gh$/);
		const text = preambleText();
		assert.match(text, /GitHub is available/);
		assert.match(text, /Treat GH_TOKEN and any signing key .* as secrets/);
		assert.match(text, /--no-gpg-sign/);
		assert.match(text, /env -u GH_TOKEN/);
		assert.ok(!text.includes("ghp_x"), "token 值不进提示词");
	});
});

function respond(status: number, headers: Record<string, string> = {}) {
	return mock.method(globalThis, "fetch", async () => new Response("{}", { status, headers }));
}

const NOW = new Date("2026-11-09T00:00:00Z");

test("checkGithubToken：401 → 无效告警", async (t) => {
	const m = respond(401);
	t.after(() => m.mock.restore());
	assert.deepEqual(await checkGithubToken("x", NOW), ["GH_TOKEN 无效或已过期（GitHub 401）"]);
	const [, init] = m.mock.calls[0].arguments as [string, RequestInit];
	assert.equal((init.headers as Record<string, string>).Authorization, "Bearer x");
});

test("checkGithubToken：scope 齐全且远期到期 → 无告警", async (t) => {
	const m = respond(200, { "X-OAuth-Scopes": "public_repo, workflow", "GitHub-Authentication-Token-Expiration": "2027-06-01 00:00:00 UTC" });
	t.after(() => m.mock.restore());
	assert.deepEqual(await checkGithubToken("x", NOW), []);
});

test("checkGithubToken：缺 workflow（repo 不含 workflow）→ 告警", async (t) => {
	const m = respond(200, { "X-OAuth-Scopes": "repo" });
	t.after(() => m.mock.restore());
	assert.deepEqual(await checkGithubToken("x", NOW), ["GH_TOKEN 缺少 scope：workflow"]);
});

test("checkGithubToken：14 天内到期 → 告警", async (t) => {
	const m = respond(200, { "X-OAuth-Scopes": "public_repo, workflow", "GitHub-Authentication-Token-Expiration": "2026-11-15 08:00:00 UTC" });
	t.after(() => m.mock.restore());
	const warnings = await checkGithubToken("x", NOW);
	assert.equal(warnings?.length, 1);
	assert.match(warnings?.[0] ?? "", /不足 14 天/);
});

test("checkGithubToken：网络失败 → null（不告警）", async (t) => {
	const m = mock.method(globalThis, "fetch", async () => {
		throw new TypeError("fetch failed");
	});
	t.after(() => m.mock.restore());
	assert.equal(await checkGithubToken("x", NOW), null);
});
