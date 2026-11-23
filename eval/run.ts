import { fork, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadModelsConfig, modelConnectionConfig, type ResolvedModelConnection } from "../src/models.ts";
import { modelFailure, type ModelFailure } from "../src/model-failure.ts";
import { cases, gradeBehavior, gradeFiles, workspaceFiles, type TrialEvidence, type TrialInput } from "./cases.ts";
import { requestCostBound, type CostEvidence } from "./budget.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");
const safeNames = ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] as const;
export type Options = { mode: "faux" | "real"; cases: string[]; trials: number; out?: string; maxCostUsd?: number; limits: TrialInput["limits"] };

export function parseArgs(args: string[]): Options {
	const out: Options = { mode: "faux", cases: cases.map((item) => item.id), trials: 1, limits: { deadlineMs: 120_000, requests: 32, tools: 128 } };
	let explicitCases = false;
	let explicitTrials = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--real") { out.mode = "real"; continue; }
		if (!["--cases", "--trials", "--out", "--deadline-ms", "--max-requests", "--max-tools", "--max-cost-usd"].includes(arg)) throw new Error(`未知选项：${arg}`);
		const value = args[++i];
		if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 缺少值`);
		if (arg === "--out") { out.out = resolve(value); continue; }
		if (arg === "--cases") { out.cases = value.split(","); explicitCases = true; continue; }
		const count = Number(value);
		if (arg === "--max-cost-usd") { if (!Number.isFinite(count) || count <= 0) throw new Error(`${arg} 必须为有限正数`); out.maxCostUsd = count; continue; }
		if (!Number.isSafeInteger(count) || count < 1) throw new Error(`${arg} 必须为正整数`);
		if (arg === "--trials") { if (count > 20) throw new Error("--trials 最多20次"); out.trials = count; explicitTrials = true; }
		if (arg === "--deadline-ms") { if (count > 900_000) throw new Error("单次评测期限最多15分钟"); out.limits.deadlineMs = count; }
		if (arg === "--max-requests") { if (count > 100) throw new Error("单次评测最多100次模型请求"); out.limits.requests = count; }
		if (arg === "--max-tools") { if (count > 500) throw new Error("单次评测最多500次工具调用"); out.limits.tools = count; }
	}
	if (new Set(out.cases).size !== out.cases.length || out.cases.some((id) => !cases.some((item) => item.id === id))) throw new Error(`--cases 必须为不重复的已知case：${cases.map((item) => item.id).join(",")}`);
	if (out.mode === "real" && (!explicitCases || !explicitTrials || out.out === undefined)) throw new Error("真实评测必须显式设置 --real --cases ... --trials N --out /专用目录");
	return out;
}

type TrialPaths = { work: string; state: string; data: string; home: string };

export function childEnvironment(source: NodeJS.ProcessEnv, paths: TrialPaths, mode: "faux" | "real", connection?: ResolvedModelConnection): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of safeNames) if (source[name] !== undefined) env[name] = source[name];
	env.HOME = paths.home;
	env.USERPROFILE = paths.home;
	env.TMPDIR = join(paths.home, "tmp");
	env.TMP = env.TMPDIR;
	env.TEMP = env.TMPDIR;
	env.DWELL_DATA = paths.data;
	env.DWELL_STATE = paths.state;
	env.DWELL_TZ = source.DWELL_TZ ?? "UTC";
	if (mode === "real") {
		const { apiKeyEnv: keyEnv } = connection ?? loadModelsConfig(source).main;
		// A key reference must not restore executable hooks or overwrite trial isolation.
		const genericKey = keyEnv === "DWELL_MODEL_API_KEY" || keyEnv === "DWELL_VISION_API_KEY";
		if (keyEnv in env || /^(?:NODE_|LD_|DYLD_|LARK_|FEISHU_)/.test(keyEnv) || (keyEnv.startsWith("DWELL_") && !genericKey) || ["GH_TOKEN", "GITHUB_TOKEN", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"].includes(keyEnv)) throw new Error(`评测密钥引用不能使用运行环境变量 ${keyEnv}`);
		if (!source[keyEnv]) throw new Error(`真实评测缺少 ${keyEnv}`);
		env.DWELL_MODELS_FILE = join(paths.state, "models.json");
		env[keyEnv] = source[keyEnv];
	}
	return env;
}

export async function prepareTrialEnvironment(source: NodeJS.ProcessEnv, paths: TrialPaths, mode: "faux" | "real", connection?: ResolvedModelConnection): Promise<NodeJS.ProcessEnv> {
	const selected = mode === "real" ? connection ?? loadModelsConfig(source).main : undefined;
	const env = childEnvironment(source, paths, mode, selected);
	if (selected !== undefined) await writeFile(env.DWELL_MODELS_FILE!, JSON.stringify({ main: modelConnectionConfig(selected), vision: null }, null, 2), { mode: 0o600 });
	return env;
}

const under = (path: string, base: string): boolean => path === base || path.startsWith(base + sep);
export function assertRealRoot(path: string, platform = process.platform): void {
	if (platform !== "linux") throw new Error("真实评测只支持 Linux + bwrap，禁止非沙箱回退");
	if (!isAbsolute(path) || ["/tmp", "/var/tmp", "/usr", "/etc", "/run", "/proc", "/dev", dirname(dirname(process.execPath)), APP_ROOT].some((base) => under(path, base))) throw new Error("真实评测需要应用目录及沙箱公共挂载以外的专用绝对目录；/tmp 不可用");
}

function incomplete(error: string, wallMs: number): TrialEvidence {
	return { status: "error", error, wallMs, requests: null, tools: null, assistance: [], transcripts: [], tasks: [], usage: null, sandbox: { enabled: false }, observations: [] };
}

async function executeTrial(configPath: string, paths: TrialPaths, input: TrialInput, connection?: ResolvedModelConnection): Promise<{ evidence: TrialEvidence; stdout: string; stderr: string }> {
	const env = await prepareTrialEnvironment(process.env, paths, input.mode, connection);
	const child = fork(join(import.meta.dirname, "trial.ts"), [configPath], { cwd: paths.work, env, execArgv: [], detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let stdout = "";
	let stderr = "";
	let result: TrialEvidence | undefined;
	let costBudget: CostEvidence | undefined;
	let timeout = false;
	const began = Date.now();
	const cap = 256 * 1024;
	child.stdout!.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-cap); });
	child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-cap); });
	child.on("message", (message) => {
		if ((message as { type?: string }).type === "cost_budget") costBudget = (message as { budget: CostEvidence }).budget;
		else result = message as TrialEvidence;
	});
	const kill = (): void => {
		try { if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* A concurrent exit already removed the process. */ }
	};
	const deadline = setTimeout(() => { timeout = true; kill(); }, input.limits.deadlineMs);
	const exit = await new Promise<string | undefined>((done) => {
		child.once("error", (error) => done(error.message));
		child.once("close", (code, signal) => done(code === 0 ? undefined : `子进程退出 ${code ?? signal}`));
	});
	clearTimeout(deadline);
	if (timeout) result = incomplete("Trial deadline exceeded; child process was terminated", Date.now() - began);
	else if (exit !== undefined || result === undefined) result = incomplete(exit ?? "Child exited without evidence", Date.now() - began);
	if (costBudget !== undefined) { result.costBudget = costBudget; result.requests ??= costBudget.requests; }
	return { evidence: result, stdout, stderr };
}

export function estimatedCostUsd(usage: unknown, pricingKnown: boolean): number | null {
	if (!pricingKnown || usage === null || typeof usage !== "object") return null;
	const models = (usage as { models?: Record<string, { cost?: { total?: number } }> }).models;
	if (models === undefined || Object.keys(models).length === 0) return null;
	const values = Object.values(models).map((item) => item.cost?.total);
	return values.every((item) => typeof item === "number" && Number.isFinite(item)) ? values.reduce<number>((sum, item) => sum + item!, 0) : null;
}

export function modelReport(connection: ResolvedModelConnection): { provider: string; api: string; baseUrl: string; model: string; pricingKnown: boolean } {
	const url = new URL(connection.baseUrl);
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	return { provider: connection.providerId, api: connection.api, baseUrl: url.href, model: connection.model, pricingKnown: connection.pricingKnown };
}

export function gradeCode(work: string, evidence: TrialEvidence, mode: Options["mode"], assertions?: string): string[] {
	const completion = `dwell-eval-complete:${randomUUID()}`;
	const checks = assertions ?? 'import {total} from "./total.ts"; const tests=[[[{cents:125,quantity:3},{cents:99,quantity:0}],375],[[],0],[[{cents:7,quantity:2},{cents:3,quantity:4}],26]]; for(const [lines,want] of tests)if(total(lines)!==want)throw new Error("incorrect total");';
	const program = 'import {writeSync} from "node:fs"; ' + checks + '\nwriteSync(1,' + JSON.stringify(`${completion}\n`) + ');';
	const shell = mode === "real" ? evidence.sandbox.wrapperPath : undefined;
	if (mode === "real" && (!evidence.sandbox.enabled || shell === undefined)) return ["Independent code checks require the successful trial sandbox"];
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: work };
	const checked = shell === undefined
		? spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: work, env, timeout: 10_000, encoding: "utf8", maxBuffer: 64 * 1024 })
		: spawnSync(shell, ["-c", `node --input-type=module -e '${program.replaceAll("'", "'\\''")}'`], { cwd: work, env, timeout: 10_000, encoding: "utf8", maxBuffer: 64 * 1024 });
	const completed = checked.stdout?.split(/\r?\n/).includes(completion);
	return checked.status === 0 && completed ? [] : [`Independent code check failed: ${(checked.stderr || checked.error?.message || (checked.status === 0 ? "Hidden assertions did not complete" : String(checked.status))).slice(0, 1000)}`];
}

export async function run(options: Options): Promise<{ root: string; passed: boolean; results: unknown[] }> {
	if (options.mode === "real") assertRealRoot(options.out!);
	const connection = options.mode === "real" ? loadModelsConfig(process.env).main : undefined;
	const requestBoundUsd = options.maxCostUsd === undefined ? undefined : connection === undefined ? 0 : requestCostBound(connection);
	const selectedModel = connection === undefined ? { provider: "faux", api: "faux", baseUrl: null, model: "faux-1", pricingKnown: false } : modelReport(connection);
	const base = options.out ?? tmpdir();
	await mkdir(base, { recursive: true, mode: 0o700 });
	const physical = await realpath(base);
	if (options.mode === "real") assertRealRoot(physical);
	const root = await mkdtemp(join(physical, "dwell-eval-"));
	const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: APP_ROOT, encoding: "utf8" }).stdout?.trim() || null;
	const dirty = (spawnSync("git", ["status", "--porcelain"], { cwd: APP_ROOT, encoding: "utf8" }).stdout ?? "").trim().split("\n").filter(Boolean);
	const results: unknown[] = [];
	let passed = true;
	let accountedUsd = 0;
	let reportedUsd = 0;
	let unreportedBoundUsd = 0;
	let budgetStopped = false;
	let providerStopped: ModelFailure["kind"] | undefined;
	const selectedTrials = options.cases.reduce((sum, id) => sum + options.trials * (id === "approval-decision" ? 2 : 1), 0);
	const caseSummary: Record<string, { attempts: number; successes: number; assisted: number; successRate: number | null }> = Object.fromEntries(options.cases.map((id) => [id, { attempts: 0, successes: 0, assisted: 0, successRate: null }]));
	evaluation:
	for (const id of options.cases) {
		const c = cases.find((item) => item.id === id)!;
		for (let i = 1; i <= options.trials; i++) {
			const variants = id === "approval-decision" ? ["approve", "deny"] as const : [undefined];
			for (const variant of variants) {
				if (options.maxCostUsd !== undefined && accountedUsd + requestBoundUsd! > options.maxCostUsd) {
					budgetStopped = true; passed = false;
					console.log("估算费用预算已不足以预留下一次请求；停止后续评测。");
					break evaluation;
				}
				const directory = join(root, `${id}${variant === undefined ? "" : `-${variant}`}-${i}`);
				const paths = { work: join(directory, "workspace"), state: join(directory, "state"), data: join(directory, "data"), home: join(directory, "home") };
				for (const path of [...Object.values(paths), join(paths.home, "tmp")]) await mkdir(path, { recursive: true, mode: 0o700 });
				for (const [file, content] of Object.entries(c.fixtures)) { await mkdir(dirname(join(paths.work, file)), { recursive: true }); await writeFile(join(paths.work, file), content); }
				const costBudget = options.maxCostUsd === undefined ? undefined : { limitUsd: options.maxCostUsd - accountedUsd, requestBoundUsd: requestBoundUsd! };
				const input: TrialInput = { id, task: c.task, mode: options.mode, variant, clarification: c.clarification, clarificationSubject: c.clarificationSubject, clarificationFiles: c.clarificationFiles, reopenAfterClarification: c.reopenAfterClarification, approvalCommand: c.approvalCommand, script: options.mode === "faux" ? c.script : [], background: c.background, process: c.process, limits: options.limits, costBudget };
				const configPath = join(paths.state, "trial-config.json");
				await writeFile(configPath, JSON.stringify(input, null, 2));
				const manifest = { schemaVersion: 2, revision, dirty, caseId: id, caseVersion: c.version, comparabilityNote: c.comparabilityNote, fixtureHash: createHash("sha256").update(JSON.stringify(c.fixtures)).digest("hex"), mode: options.mode, purpose: options.mode === "faux" ? "evaluator_verification" : "model_task_evaluation", ...selectedModel, platform: process.platform, arch: process.arch, node: process.version, limits: options.limits, costBudget, trial: i, variant, plannedAssistance: [c.clarification === undefined ? undefined : "known clarification reply", variant === undefined ? undefined : `predeclared ${variant} decision`].filter(Boolean), startedAt: new Date().toISOString() };
				await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
				const { evidence, stdout, stderr } = await executeTrial(configPath, paths, input, connection);
				// At this point the harness is closed and the child has exited. Hidden assertions run here.
				let assertions = gradeBehavior(id, evidence, variant);
				let files: Record<string, string> = {};
				try { files = await workspaceFiles(paths.work); assertions.push(...gradeFiles(id, files, variant)); }
				catch (error) { assertions.push(String(error)); }
				if (id === "node-bugfix" || c.hiddenAssertions !== undefined) {
					const before = JSON.stringify(files);
					assertions.push(...gradeCode(paths.work, evidence, options.mode, c.hiddenAssertions));
					// Executable submissions cannot mutate fixtures or leave extra artifacts during grading.
					try {
						files = await workspaceFiles(paths.work);
						assertions.push(...gradeFiles(id, files, variant));
						if (JSON.stringify(files) !== before) assertions.push("The submitted code changed workspace files during independent grading");
					} catch (error) { assertions.push(String(error)); }
				}
				if (evidence.costBudget !== undefined) {
					accountedUsd += evidence.costBudget.accountedUsd;
					reportedUsd += evidence.costBudget.reportedUsd;
					unreportedBoundUsd += evidence.costBudget.unreportedBoundUsd;
					budgetStopped ||= evidence.costBudget.stopped;
				}
				const result = { caseId: id, caseVersion: c.version, comparabilityNote: c.comparabilityNote, variant, trial: i, mode: options.mode, purpose: manifest.purpose, passed: assertions.length === 0, assertions, wallMs: evidence.wallMs, requests: evidence.requests, tools: evidence.tools, plannedAssistance: evidence.assistance, error: evidence.error ?? null, cost: { estimatedCostUsd: estimatedCostUsd(evidence.usage, selectedModel.pricingKnown), budget: evidence.costBudget ?? null, pricingKnown: selectedModel.pricingKnown, currency: "USD", actualBill: null, note: selectedModel.pricingKnown ? "Estimate from recorded usage and configured/catalog prices; unreported requests retain a conservative bound, not an actual charge." : "Pricing is unknown; SDK zero placeholders do not establish a free price." }, artifacts: relative(root, directory) };
				await writeFile(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
				await writeFile(join(directory, "transcript.json"), JSON.stringify(evidence.transcripts, null, 2));
				await writeFile(join(directory, "tasks.json"), JSON.stringify(evidence.tasks, null, 2));
				await writeFile(join(directory, "usage.json"), JSON.stringify(evidence.usage, null, 2));
				await writeFile(join(directory, "stdout.log"), stdout);
				await writeFile(join(directory, "stderr.log"), stderr);
				await writeFile(join(directory, "workspace-snapshot.json"), JSON.stringify(files, null, 2));
				await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
				results.push(result);
				const summary = caseSummary[id]!;
				summary.attempts++;
				if (result.passed) summary.successes++;
				if (evidence.assistance.some((item) => item.supplied)) summary.assisted++;
				summary.successRate = summary.successes / summary.attempts;
				passed &&= result.passed;
				console.log(`${result.passed ? "通过" : "失败"} ${id}${variant === undefined ? "" : `/${variant}`} #${i} · ${evidence.requests ?? "未知"}次请求 ${evidence.tools ?? "未知"}次工具 · ${evidence.wallMs}ms`);
				if (options.mode === "real" && evidence.error !== undefined) {
					const failure = evidence.modelFailure ?? modelFailure(evidence.error);
					if (["region", "authentication", "permission", "quota", "configuration"].includes(failure.kind)) {
						providerStopped = failure.kind;
						passed = false;
						console.log("模型连接需要维护者处理，停止后续试验，保留已完成记录。");
						break evaluation;
					}
				}
				if (budgetStopped) { passed = false; break evaluation; }
			}
		}
	}
	await writeFile(join(root, "results.json"), JSON.stringify({ mode: options.mode, purpose: options.mode === "faux" ? "evaluator_verification" : "model_task_evaluation", passed, selectedTrials, attemptedTrials: results.length, skippedTrials: selectedTrials - results.length, providerStopped: providerStopped ?? null, caseSummary, budget: { limitUsd: options.maxCostUsd ?? null, requestBoundUsd: requestBoundUsd ?? null, accountedUsd: options.maxCostUsd === undefined ? null : accountedUsd, reportedUsd: options.maxCostUsd === undefined ? null : reportedUsd, unreportedBoundUsd: options.maxCostUsd === undefined ? null : unreportedBoundUsd, stopped: budgetStopped, actualBill: null }, results, note: options.mode === "faux" ? "Faux passes verify the evaluator and product tool wiring; they are not a model task success rate." : "Synthetic task results with declared scripted assistance; they do not establish production performance." }, null, 2));
	console.log(`评测记录：${root}`);
	if (options.mode === "faux") console.log("faux 结果仅验证评测器与工具链路，不代表模型任务成功率。");
	return { root, passed, results };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { const result = await run(parseArgs(process.argv.slice(2))); if (!result.passed) process.exitCode = 1; }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
