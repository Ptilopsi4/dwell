import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cases, gradeBehavior, gradeFiles, gradeVerifiedArtifacts, type TrialEvidence } from "../eval/cases.ts";
import { assertRealRoot, childEnvironment, estimatedCostUsd, modelReport, parseArgs, prepareTrialEnvironment, run } from "../eval/run.ts";
import { createModelClient, loadModelsConfig } from "../src/models.ts";
import { RequestBudget, guardedProvider, requestCostBound } from "../eval/budget.ts";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

const evidence = (): TrialEvidence => ({ status: "completed", wallMs: 1, requests: 1, tools: 1, assistance: [], transcripts: [], tasks: [], usage: null, sandbox: { enabled: false }, observations: [] });

test("eval: wrong amounts, missing items and extra files fail final-state grading", () => {
	const c = cases.find((item) => item.id === "csv-reconciliation")!;
	const good = { ...c.fixtures, "result.json": JSON.stringify(c.expected) };
	assert.deepEqual(gradeFiles(c.id, good), []);
	assert.ok(gradeFiles(c.id, { ...good, "result.json": JSON.stringify({ ...c.expected as object, paidCents: 3749 }) }).length > 0);
	assert.ok(gradeFiles(c.id, { ...good, "result.json": JSON.stringify({ ...c.expected as object, unpaid: [] }) }).length > 0);
	assert.ok(gradeFiles(c.id, { ...good, "extra.txt": "unrequested" }).length > 0);
	assert.ok(gradeFiles(c.id, { ...good, "invoices.csv": "tampered" }).length > 0);
});

test("eval: approval denial preserves target and rejects retry attempts", () => {
	const c = cases.find((item) => item.id === "approval-decision")!;
	assert.deepEqual(gradeFiles(c.id, c.fixtures, "deny"), []);
	assert.ok(gradeFiles(c.id, { "keep.txt": c.fixtures["keep.txt"] }, "deny").length > 0);
	assert.deepEqual(gradeFiles(c.id, { "keep.txt": c.fixtures["keep.txt"] }, "approve"), []);
	assert.ok(gradeFiles(c.id, { "keep.txt": c.fixtures["keep.txt"], "scratch/": "" }, "approve").length > 0);
	const run = evidence();
	run.assistance = [{ kind: "approval:deny", supplied: true, note: "scripted" }];
	run.observations = [{ event: "tool", name: "bash", args: { command: "rm -rf scratch" }, at: 1 }];
	assert.deepEqual(gradeBehavior(c.id, run, "deny"), []);
	run.observations.push({ event: "tool", name: "bash", args: { command: "rm -rf scratch" }, at: 2 });
	assert.ok(gradeBehavior(c.id, run, "deny").length > 0);
});

test("eval: clarification grading catches edits before scripted assistance", () => {
	const run = evidence();
	run.observations = [{ event: "tool", name: "write", at: 1 }, { event: "clarification", at: 2 }];
	assert.ok(gradeBehavior("clarification", run).length > 0);
	run.observations.reverse();
	run.observations.push({ event: "clarification_state", text: cases.find((item) => item.id === "clarification")!.fixtures["rates.json"], at: 1 });
	assert.deepEqual(gradeBehavior("clarification", run), []);
	run.observations[1].name = "bash";
	assert.deepEqual(gradeBehavior("clarification", run), []);
	run.observations[2].text = '{"USD":80,"EUR":120}';
	assert.ok(gradeBehavior("clarification", run).length > 0);
});

test("eval: faux never inherits keys, GitHub, Feishu, Node hooks or DWELL settings", () => {
	const source = { PATH: "/usr/bin:/bin", HOME: "/real-home", NODE_OPTIONS: "--import bad.ts", GH_TOKEN: "github", LARK_APP_SECRET: "feishu", ZAI_CODING_CN_API_KEY: "zai", DEEPSEEK_API_KEY: "deepseek", OPENAI_API_KEY: "openai", DWELL_PROVIDER: "deepseek", DWELL_MODEL: "custom", DWELL_STATE: "/production", DWELL_MODELS_FILE: "/missing/invalid-host-models.json" };
	const paths = { work: "/eval/work", state: "/eval/state", data: "/eval/data", home: "/eval/home" };
	const faux = childEnvironment(source, paths, "faux");
	for (const name of ["NODE_OPTIONS", "GH_TOKEN", "LARK_APP_SECRET", "ZAI_CODING_CN_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "DWELL_PROVIDER", "DWELL_MODEL", "DWELL_MODELS_FILE"]) assert.equal(faux[name], undefined);
	assert.equal(faux.HOME, paths.home);
	assert.equal(faux.DWELL_STATE, paths.state);
	const real = childEnvironment({ ...source, DWELL_MODELS_FILE: undefined }, paths, "real");
	assert.equal(real.DEEPSEEK_API_KEY, "deepseek");
	assert.equal(real.ZAI_CODING_CN_API_KEY, undefined);
	assert.equal(real.GH_TOKEN, undefined);
	assert.equal(real.LARK_APP_SECRET, undefined);
});

test("eval: a custom connection is copied completely while only its key reference enters the child environment", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-eval-model-config-"));
	try {
		const hostFile = join(directory, "host-models.json");
		const paths = { work: join(directory, "work"), state: join(directory, "state"), data: join(directory, "data"), home: join(directory, "home") };
		await mkdir(paths.state);
		const main = { api: "openai-completions", baseUrl: "https://models.example.invalid/v9", model: "tenant-new-model-2099", apiKeyEnv: "CUSTOM_MODEL_KEY", input: ["text", "image"], reasoning: true, contextWindow: 50000, maxTokens: 3000, headers: { "X-Region": "test" }, compat: { supportsDeveloperRole: false } };
		await writeFile(hostFile, JSON.stringify({ main, vision: { ...main, model: "other-vision", apiKeyEnv: "VISION_MODEL_KEY" } }));
		const source = { PATH: "/usr/bin:/bin", DWELL_MODELS_FILE: hostFile, CUSTOM_MODEL_KEY: "custom-fixture-secret", VISION_MODEL_KEY: "vision-fixture-secret", OPENAI_API_KEY: "other-fixture-secret", GH_TOKEN: "github", LARK_APP_SECRET: "feishu", NODE_OPTIONS: "--import bad.ts" };
		const selected = loadModelsConfig(source).main;
		assert.equal(selected.model, main.model);
		assert.equal(selected.pricingKnown, false);
		const child = await prepareTrialEnvironment(source, paths, "real", selected);
		assert.equal(child.CUSTOM_MODEL_KEY, source.CUSTOM_MODEL_KEY);
		assert.equal(child.DWELL_MODELS_FILE, join(paths.state, "models.json"));
		for (const name of ["VISION_MODEL_KEY", "OPENAI_API_KEY", "GH_TOKEN", "LARK_APP_SECRET", "NODE_OPTIONS"]) assert.equal(child[name], undefined, name);
		const copied = await readFile(child.DWELL_MODELS_FILE!, "utf8");
		for (const value of [source.CUSTOM_MODEL_KEY, source.VISION_MODEL_KEY, source.OPENAI_API_KEY, hostFile]) assert.equal(copied.includes(value), false);
		assert.equal(JSON.parse(copied).vision, null);
		const reloaded = loadModelsConfig(child);
		assert.equal(reloaded.vision, undefined);
		assert.deepEqual(reloaded.main.metadata, selected.metadata);
		assert.equal(reloaded.main.pricingKnown, false);
		const client = createModelClient(reloaded.main, child.CUSTOM_MODEL_KEY!);
		assert.equal(client.model.id, main.model);
		assert.equal(client.model.baseUrl, main.baseUrl);
		assert.deepEqual(client.models.getModel(reloaded.main.providerId, main.model), client.model);
		assert.equal(childEnvironment({ DWELL_MODEL_API_KEY: "generic-fixture-secret" }, paths, "real", { ...selected, apiKeyEnv: "DWELL_MODEL_API_KEY" }).DWELL_MODEL_API_KEY, "generic-fixture-secret");
		assert.throws(() => childEnvironment({ NODE_OPTIONS: "fixture" }, paths, "real", { ...selected, apiKeyEnv: "NODE_OPTIONS" }), /运行环境变量/);
		assert.throws(() => childEnvironment({ DWELL_MODELS_FILE: hostFile }, paths, "real", { ...selected, apiKeyEnv: "DWELL_MODELS_FILE" }), /运行环境变量/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("eval: the faux CLI completes with an invalid host model configuration and no credentials", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-eval-faux-isolation-"));
	try {
		const cli = spawnSync(process.execPath, [join(import.meta.dirname, "../eval/run.ts"), "--cases", "csv-reconciliation", "--out", directory], {
			env: { PATH: process.env.PATH, DWELL_MODELS_FILE: join(directory, "missing-host-models.json"), DWELL_PROVIDER: "invalid-host-provider", DWELL_MODEL: "invalid-host-model" },
			encoding: "utf8", timeout: 15_000,
		});
		assert.equal(cli.status, 0, cli.stderr || cli.stdout);
		const root = /评测记录：(.+)/.exec(cli.stdout)?.[1]?.trim();
		assert.ok(root);
		const manifest = JSON.parse(await readFile(join(root, "csv-reconciliation-1", "manifest.json"), "utf8"));
		const result = JSON.parse(await readFile(join(root, "csv-reconciliation-1", "result.json"), "utf8"));
		assert.equal(manifest.provider, "faux");
		assert.equal(manifest.model, "faux-1");
		assert.equal(manifest.baseUrl, null);
		assert.equal(result.cost.estimatedCostUsd, null);
		assert.equal(result.cost.pricingKnown, false);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("eval: reports sanitize endpoints and unknown pricing never becomes a zero-cost estimate", () => {
	const selected = loadModelsConfig({ DWELL_STATE: "/missing-eval-test-state", DWELL_PROVIDER: "deepseek" }).main;
	assert.deepEqual(modelReport({ ...selected, baseUrl: "https://user:password@example.invalid/v1?token=secret#private" }), { provider: selected.providerId, api: selected.api, baseUrl: "https://example.invalid/v1", model: selected.model, pricingKnown: selected.pricingKnown });
	const usage = { models: { custom: { cost: { total: 0 } } } };
	assert.equal(estimatedCostUsd(usage, false), null);
	assert.equal(estimatedCostUsd(usage, true), 0);
	assert.equal(estimatedCostUsd({ models: { a: { cost: { total: 1.5 } }, b: { cost: { total: 2 } } } }, true), 3.5);
	assert.equal(estimatedCostUsd({ models: { a: {} } }, true), null);
});

test("eval: verification guidance versions the revised scenarios and explicit Node check", () => {
	const revised = ["invoice-workflow-repair", "ledger-reconciliation", "policy-clarification", "release-background-audit"];
	for (const c of cases) {
		assert.equal(c.version, revised.includes(c.id) ? 2 : c.id === "node-bugfix" ? 2 : 1, c.id);
		assert.equal(c.comparabilityNote === undefined, !revised.includes(c.id) && c.id !== "node-bugfix", c.id);
		if (c.id === "node-bugfix") {
			assert.match(c.comparabilityNote!, /not directly comparable/);
			const probe = c.script.find((step) => "tool" in step && step.tool === "bash")!;
			assert.ok("tool" in probe && c.task.includes(probe.args.command as string));
		}
		if (!revised.includes(c.id)) continue;
		assert.match(c.comparabilityNote!, /not directly comparable/);
		const first = c.script[0]!;
		assert.ok("tool" in first && first.tool === "dwell.work" && first.args.action === "start");
		assert.ok(first.args.verification);
		assert.ok(c.task.includes("native Node"));
	}
});

test("eval: real requires explicit bounded selection and isolated Linux storage", () => {
	assert.equal(parseArgs([]).mode, "faux");
	assert.equal(parseArgs([]).cases.length, 14);
	assert.throws(() => parseArgs(["--real"]), /显式/);
	assert.throws(() => parseArgs(["--cases", "unknown"]), /已知case/);
	assert.throws(() => parseArgs(["--trials", "0"]), /正整数/);
	assert.throws(() => parseArgs(["--trials", "999"]), /最多20/);
	assert.throws(() => assertRealRoot("/eval-results", "darwin"), /Linux/);
	assert.throws(() => assertRealRoot("/tmp/eval", "linux"), /专用/);
	assert.throws(() => assertRealRoot("/usr/eval", "linux"), /专用/);
	const real = parseArgs(["--real", "--cases", "csv-reconciliation,node-bugfix", "--trials", "1", "--out", "/eval-results"]);
	assert.equal(real.trials, 1);
});

test("eval: cost reservations include unresolved failures and concurrent requests before dispatch", () => {
	const budget = new RequestBudget({ limitUsd: 0.5, requestBoundUsd: 0.2 });
	const first = budget.reserve();
	const second = budget.reserve();
	assert.throws(() => budget.reserve(), /before provider dispatch/);
	assert.equal(budget.snapshot().accountedUsd, 0.4);
	const failed = fauxAssistantMessage("failed", { stopReason: "error" });
	budget.settle(first, failed);
	assert.equal(budget.snapshot().unreportedBoundUsd, 0.4);
	const success = fauxAssistantMessage("ok");
	success.usage = { ...success.usage, totalTokens: 100, cost: { ...success.usage.cost, total: 0.03 } };
	budget.settle(second, success);
	budget.settle(second, success);
	assert.equal(budget.snapshot().reportedUsd, 0.03);
	assert.equal(budget.snapshot().unreportedBoundUsd, 0.2);
	assert.equal(budget.snapshot().accountedUsd, 0.23);
});

test("eval: cost ceiling requires real rates and reserves worst-case model limits and tiers", () => {
	const selected = loadModelsConfig({ DWELL_STATE: "/missing-eval-budget-state", DWELL_PROVIDER: "deepseek" }).main;
	assert.throws(() => requestCostBound({ ...selected, pricingKnown: false }), /known model pricing/);
	assert.equal(requestCostBound({ ...selected, pricingKnown: true, metadata: { ...selected.metadata, contextWindow: 10000, maxTokens: 2000, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, tiers: [{ inputTokensAbove: 1000, input: 3, output: 4, cacheRead: 2, cacheWrite: 4 }] } } }), 0.088);
	assert.equal(parseArgs(["--max-cost-usd", "0.25"]).maxCostUsd, 0.25);
	for (const invalid of ["0", "-1", "NaN", "Infinity"]) assert.throws(() => parseArgs(["--max-cost-usd", invalid]), /有限正数/);
});

test("eval: provider boundary blocks an unaffordable request and disables hidden SDK retries", async () => {
	const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
	faux.setResponses([fauxAssistantMessage("ok")]);
	let dispatches = 0;
	const provider = { ...faux.provider, streamSimple: (...args: Parameters<typeof faux.provider.streamSimple>) => { dispatches++; assert.equal(args[2]?.maxRetries, 0); return faux.provider.streamSimple(...args); } };
	const budget = new RequestBudget({ limitUsd: 0.3, requestBoundUsd: 0.2 });
	const guarded = guardedProvider(provider, async () => budget.reserve(), (id, message) => budget.settle(id, { ...message, stopReason: "error" }));
	const model = provider.getModels()[0]!;
	await guarded.streamSimple(model, normalizeContext({ messages: [] }), { maxRetries: 9 }).result();
	const refused = await guarded.streamSimple(model, normalizeContext({ messages: [] })).result();
	assert.equal(refused.stopReason, "error");
	assert.equal(dispatches, 1);
	assert.equal(budget.snapshot().requests, 1);
});

test("eval: realistic scenarios verify unseen behavior and reject fixture changes or extra files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-eval-scenarios-"));
	const ids = ["invoice-workflow-repair", "ledger-reconciliation", "policy-clarification", "release-background-audit"];
	try {
		const result = await run({ mode: "faux", cases: ids, trials: 1, out: directory, maxCostUsd: 1, limits: { deadlineMs: 20_000, requests: 32, tools: 64 } });
		assert.equal(result.passed, true, JSON.stringify(result.results));
		for (const id of ids) {
			const c = cases.find((item) => item.id === id)!;
			const files = JSON.parse(await readFile(join(result.root, `${id}-1`, "workspace-snapshot.json"), "utf8"));
			const observed = JSON.parse(await readFile(join(result.root, `${id}-1`, "evidence.json"), "utf8")) as TrialEvidence;
			const manifest = JSON.parse(await readFile(join(result.root, `${id}-1`, "manifest.json"), "utf8"));
			const outcome = JSON.parse(await readFile(join(result.root, `${id}-1`, "result.json"), "utf8"));
			assert.equal(manifest.caseVersion, 2);
			assert.equal(outcome.caseVersion, 2);
			assert.equal(manifest.comparabilityNote, c.comparabilityNote);
			assert.equal(outcome.comparabilityNote, c.comparabilityNote);
			assert.deepEqual(gradeFiles(id, files), []);
			const cwd = join(result.root, `${id}-1`, "workspace");
			assert.deepEqual(gradeVerifiedArtifacts(id, observed, files, cwd), []);
			assert.ok(gradeVerifiedArtifacts(id, observed, { ...files, "extra.txt": "unrequested" }, cwd).some((error) => error.includes("does not match")));
			const forged = structuredClone(observed);
			const finalObservation = forged.observations.find((item) => item.event === "work_final")!;
			const finalWork = JSON.parse(finalObservation.text!);
			const record = finalWork.records[finalWork.current];
			assert.equal(record.verification.status, "verified");
			assert.equal(record.status, "ready_for_review");
			assert.ok(record.verification.receipt.checks.every((check: { exitCode: number; taskId: number }) => check.exitCode === 0 && check.taskId > 0));
			record.verification.receipt.checks[0].taskId = 999999;
			finalObservation.text = JSON.stringify(finalWork);
			assert.ok(gradeBehavior(id, forged).some((error) => error.includes("matching successful nested bash")));
			assert.ok(gradeFiles(id, { ...files, "extra.txt": "unrequested" }).length > 0);
			const fixture = Object.keys(c.fixtures).find((name) => !c.mutable?.includes(name))!;
			assert.ok(gradeFiles(id, { ...files, [fixture]: "tampered" }).length > 0);
			if (id === "policy-clarification") {
				const final = observed.observations.find((item) => item.event === "work_final")!;
				const saved = JSON.parse(final.text!);
				assert.equal(saved.records[saved.current].creator, "eval-user");
				assert.equal(saved.records[saved.current].status, "ready_for_review");
				saved.records[saved.current].blockers = ["Unresolved policy question"];
				final.text = JSON.stringify(saved);
				assert.ok(gradeBehavior(id, observed).some((error) => error.includes("resolved blockers")));
				saved.records[saved.current].blockers = [];
				saved.records[saved.current].goal = "A replacement goal";
				final.text = JSON.stringify(saved);
				assert.ok(gradeBehavior(id, observed).some((error) => error.includes("replaced its durable goal")));
			}
			if (id === "release-background-audit") {
				const noWait = structuredClone(observed);
				noWait.observations = noWait.observations.filter((item) => item.name !== "dwell.task.wait");
				assert.ok(gradeBehavior(id, noWait).some((error) => error.includes("explicitly yield")));
				const polling = structuredClone(observed);
				polling.observations.push({ event: "tool", conversationId: 1, name: "dwell.task", args: { action: "status" }, at: 100 });
				assert.ok(gradeBehavior(id, polling).some((error) => error.includes("polled task status")));
				observed.observations = observed.observations.filter((item) => item.conversationId === 1 || item.name !== "read");
				assert.ok(gradeBehavior(id, observed).some((error) => error.includes("worker did not read")));
			}
		}
		const summary = JSON.parse(await readFile(join(result.root, "results.json"), "utf8"));
		assert.equal(summary.attemptedTrials, 4);
		assert.equal(summary.caseSummary["policy-clarification"].assisted, 1);
		assert.equal(summary.budget.actualBill, null);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("eval: invoice repair requires the failing acceptance result before an edit", () => {
	const observed = evidence();
	observed.observations = [
		{ event: "tool_result", name: "bash", args: { command: "node acceptance.ts" }, isError: true, at: 1 },
		{ event: "tool", name: "write", args: { path: "money.ts" }, at: 2 },
		{ event: "tool_result", name: "bash", args: { command: "node acceptance.ts" }, isError: false, at: 3 },
	];
	assert.equal(gradeBehavior("invoice-workflow-repair", observed).some((error) => error.includes("initial")), false);
	[observed.observations[0], observed.observations[1]] = [observed.observations[1]!, observed.observations[0]!];
	assert.ok(gradeBehavior("invoice-workflow-repair", observed).some((error) => error.includes("before editing")));
});

test("eval: schedule grader reads pre-cleanup state, so cleanup cannot hide a missed cancel", () => {
	const run = evidence();
	run.observations = ["create", "cancel", "list"].map((action) => ({ event: "tool", name: "dwell.schedule", args: { action }, at: 1 }));
	run.tasks = [{ kind: "dwell.schedule-run", state: { status: "sleeping" } }];
	assert.ok(gradeBehavior("schedule-cancel", run).length > 0);
	run.tasks = [{ kind: "dwell.schedule-run", state: { status: "terminal" } }];
	assert.deepEqual(gradeBehavior("schedule-cancel", run), []);
});

test("eval: request exhaustion aborts before a second provider call and preserves evidence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-eval-test-"));
	try {
		const result = await run({ mode: "faux", cases: ["csv-reconciliation"], trials: 1, out: directory, limits: { deadlineMs: 15_000, requests: 1, tools: 10 } });
		assert.equal(result.passed, false);
		const record = JSON.parse(await readFile(join(result.root, "csv-reconciliation-1", "evidence.json"), "utf8")) as TrialEvidence;
		assert.equal(record.requests, 1);
		assert.equal(record.observations.filter((item) => item.event === "request").length, 1);
		assert.match(record.error ?? "", /request budget exceeded/);
		assert.ok(record.transcripts.length > 0);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("eval: successful exit cannot bypass unfinished hidden Node assertions", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-eval-code-test-"));
	const c = cases.find((item) => item.id === "node-bugfix")!;
	const original = c.script;
	try {
		const options = { mode: "faux" as const, cases: [c.id], trials: 1, out: directory, limits: { deadlineMs: 15_000, requests: 10, tools: 10 } };
		assert.equal((await run(options)).passed, true);
		c.script = original.map((step) => "tool" in step && step.tool === "write"
			? { ...step, args: { ...step.args, content: "export const total = () => -999; process.exit(0);\n" } }
			: step);
		const result = await run(options);
		const trial = join(result.root, "node-bugfix-1");
		const record = JSON.parse(await readFile(join(trial, "evidence.json"), "utf8")) as TrialEvidence;
		const graded = JSON.parse(await readFile(join(trial, "result.json"), "utf8")) as { assertions: string[] };
		assert.equal(record.status, "completed");
		assert.equal(result.passed, false);
		assert.ok(graded.assertions.some((item) => item.includes("Hidden assertions did not complete")));
	} finally {
		c.script = original;
		await rm(directory, { recursive: true, force: true });
	}
});

test("eval: node bugfix requires a successful executed Node check associated with its proposal", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-eval-node-verification-"));
	const c = cases.find((item) => item.id === "node-bugfix")!;
	const original = c.script;
	try {
		const options = { mode: "faux" as const, cases: [c.id], trials: 1, out: directory, limits: { deadlineMs: 15_000, requests: 10, tools: 10 } };
		const good = await run(options);
		assert.equal(good.passed, true);
		const observed = JSON.parse(await readFile(join(good.root, `${c.id}-1`, "evidence.json"), "utf8")) as TrialEvidence;
		const result = observed.observations.find((item) => item.event === "tool_result" && item.name === "bash")!;
		for (const change of [
			(run: TrialEvidence) => { run.observations = run.observations.filter((item) => item.event !== "tool_result" || item.name !== "bash"); },
			(run: TrialEvidence) => { run.observations.find((item) => item.event === "tool_result" && item.name === "bash")!.taskId = 999999; },
			(run: TrialEvidence) => { run.observations.find((item) => item.event === "tool_result" && item.name === "bash")!.args = { command: "true" }; },
			(run: TrialEvidence) => { run.observations.find((item) => item.event === "tool_result" && item.name === "bash")!.conversationId = 99; },
			(run: TrialEvidence) => { run.tasks = []; },
			(run: TrialEvidence) => { run.observations.find((item) => item.event === "tool_result" && item.name === "bash")!.callId = "unrelated-call"; },
			(run: TrialEvidence) => { run.observations.find((item) => item.event === "tool_result" && item.name === "bash")!.exitCode = 17; },
			(run: TrialEvidence) => { delete run.observations.find((item) => item.event === "tool_result" && item.name === "bash")!.exitCode; },
			(run: TrialEvidence) => { run.observations.find((item) => item.event === "tool_result" && item.name === "bash")!.isError = true; },
			(run: TrialEvidence) => {
				const check = run.observations.filter((item) => item.name === "bash");
				run.observations = [...check, ...run.observations.filter((item) => item.name !== "bash")];
			},
		]) {
			const edited = structuredClone(observed); change(edited);
			assert.ok(gradeBehavior(c.id, edited).some((error) => error.includes("Node")));
		}
		assert.ok(result.taskId);
		for (const command of ["exit 17", "true", "echo node", "echo 'node -e total.ts'", "node -e 'console.log(42)'", "true || node -e 'import {total} from \"./total.ts\"; total([])'"]) {
			c.script = original.map((step) => "tool" in step && step.tool === "bash" ? { ...step, args: { command, timeout: 10 } } : step);
			const failed = await run(options);
			assert.equal(failed.passed, false, command);
			const graded = JSON.parse(await readFile(join(failed.root, `${c.id}-1`, "result.json"), "utf8")) as { assertions: string[] };
			assert.ok(graded.assertions.some((error) => error.includes("Node")), command);
		}
	} finally { c.script = original; await rm(directory, { recursive: true, force: true }); }
});

test("eval: only questions about the currency receive the planned clarification", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dwell-eval-clarification-test-"));
	const c = cases.find((item) => item.id === "clarification")!;
	const original = c.script;
	try {
		for (const [question, eligible] of [
			["What is your name?", false],
			["The EUR rate is 70. What is your name?", false],
			["Which currency should I change, USD or EUR?", true],
			["请确认需要修改的币种。", true],
		] as const) {
			c.script = [original[0]!, { text: question }, ...original.slice(2)];
			const result = await run({ mode: "faux", cases: [c.id], trials: 1, out: directory, limits: { deadlineMs: 15_000, requests: 10, tools: 10 } });
			const trial = join(result.root, "clarification-1");
			const record = JSON.parse(await readFile(join(trial, "evidence.json"), "utf8")) as TrialEvidence;
			assert.equal(result.passed, eligible, question);
			assert.equal(record.assistance.find((item) => item.kind === "clarification")?.supplied, eligible, question);
			if (!eligible) {
				assert.match(record.error ?? "", /scripted reply withheld/);
				assert.equal(await readFile(join(trial, "workspace", "rates.json"), "utf8"), c.fixtures["rates.json"]);
			}
		}
	} finally {
		c.script = original;
		await rm(directory, { recursive: true, force: true });
	}
});
