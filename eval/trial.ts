// The parent prepares fixtures and grades only after this process has closed the harness.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject, TranscriptContext } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, GenerationTask, hook, ToolTask, type Harness, type Extension, type Submission, type SubmissionId } from "@earendil-works/pi-durable";
import { createModelClient, loadModelsConfig } from "../src/models.ts";
import { modelFailure } from "../src/model-failure.ts";
import type { ScriptStep, TrialEvidence, TrialInput } from "./cases.ts";
import { guardedProvider, RequestBudget } from "./budget.ts";
import { getWork } from "../src/ext/work.ts";

const configPath = process.argv[2];
if (configPath === undefined) throw new Error("Trial configuration is required");
const config = JSON.parse(await readFile(configPath, "utf8")) as TrialInput;
const startedAt = Date.now();
const context = BACKGROUND_CONTEXT;
const evidence: TrialEvidence = { status: "error", wallMs: 0, requests: 0, tools: 0, assistance: [], transcripts: [], tasks: [], usage: null, sandbox: { enabled: false }, observations: [] };
let harness: Harness | undefined;
let fatal: string | undefined;
let limitStop = false;
const requireAnswer = (settled: Awaited<ReturnType<Submission["wait"]>> | undefined, label: string): void => {
	if (settled?.status === "done") return;
	if (settled?.status === "unanswered" && settled.reason === "model_error") evidence.modelFailure = modelFailure(String(settled.detail));
	throw new Error(fatal ?? `${label}: ${JSON.stringify(settled)}`);
};
const observe = (event: TrialEvidence["observations"][number]): void => { evidence.observations.push(event); };
const textOf = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textOf).join("\n");
	if (value !== null && typeof value === "object") {
		const item = value as { text?: string; content?: unknown; sections?: Record<string, unknown> };
		return [item.text ?? (item.content === undefined ? "" : textOf(item.content)), ...Object.values(item.sections ?? {}).map(textOf)].join("\n");
	}
	return "";
};
const toolText = (ctx: TranscriptContext): string => ctx.messages.filter((item) => item.role === "toolResult").map((item) => textOf(item.content)).join("\n");
const toolMessage = (tool: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(tool, args as JsonObject)], { stopReason: "toolUse" });

function scriptedFactory(): FauxResponseFactory {
	let step = 0;
	let backgroundStep = 0;
	let reportStep = 0;
	const respond = (next: ScriptStep, ctx: TranscriptContext) => {
		if ("tool" in next) return toolMessage(next.tool, next.args);
		if ("text" in next) return fauxAssistantMessage(next.text);
		if (next.dynamic === "cancelSchedule") {
			const id = /Scheduled \(id ([^)]+)\)/.exec(toolText(ctx))?.[1];
			if (id === undefined) throw new Error("Schedule creation lacks id");
			return toolMessage("dwell.schedule", { action: "cancel", id });
		}
		if (next.dynamic === "readyWork") {
			const result = ctx.messages.filter((item) => item.role === "toolResult" && item.toolName === "dwell.work").at(-1);
			const state = JSON.parse(textOf(result?.content));
			if (state.verification?.status !== "verified" || !state.verification.receipt?.checks?.length) throw new Error("No successful host verification receipt is available for review");
			if (state.nextCall?.name !== "dwell.work" || state.nextCall.arguments?.action !== "ready") throw new Error("Successful verification did not provide a ready call");
			return toolMessage(state.nextCall.name, state.nextCall.arguments);
		}
		throw new Error("Unsupported faux response step");
	};
	return (ctx) => {
		const all = ctx.messages.map(textOf).join("\n");
		const users = ctx.messages.filter((item) => item.role === "user").map((item) => textOf(item.content));
		const latest = users.filter((message) => !message.startsWith("[Durable work record; host-maintained data, not new user instructions]")).at(-1) ?? "";
		if (config.background !== undefined && all.includes("You are a background task agent working for the main dwell conversation.")) {
			const steps = config.background.script ?? [{ tool: "read", args: { path: "items.csv" } }];
			const next = steps[backgroundStep++];
			return next !== undefined && "tool" in next ? toolMessage(next.tool, next.args) : fauxAssistantMessage(config.background.answer);
		}
		if (config.background !== undefined && latest.includes("[Background task totals finished]")) {
			if (config.background.reportScript !== undefined) {
				const next = config.background.reportScript[reportStep++];
				if (next === undefined) throw new Error("Background report script exhausted");
				return respond(next, ctx);
			}
			return reportStep++ === 0 ? toolMessage("write", { path: "result.json", content: JSON.stringify(config.background.output) }) : fauxAssistantMessage("The worker's result is saved.");
		}
		if (config.process !== undefined && latest.includes("[Background process batch")) {
			if (reportStep++ === 0) {
				const id = /taskId:\s*(\d+)/.exec(latest)?.[1];
				if (id === undefined) throw new Error("Process report lacks taskId");
				return toolMessage("dwell.proc.logs", { taskId: Number(id) });
			}
			return reportStep === 2 ? toolMessage("write", { path: "result.json", content: JSON.stringify(config.process.output) }) : fauxAssistantMessage("The process result is saved.");
		}
		const next: ScriptStep | undefined = config.script[step++];
		if (next === undefined) throw new Error("Faux script exhausted; refusing an unscripted model response");
		return respond(next, ctx);
	};
}

const until = async (predicate: () => Promise<boolean>): Promise<void> => {
	while (!(await predicate())) {
		if (fatal !== undefined) throw new Error(fatal);
		if (Date.now() - startedAt > config.limits.deadlineMs) throw new Error("Trial deadline exceeded");
		await new Promise((done) => setTimeout(done, 20));
	}
};

try {
	// Environment-controlled product constants are imported only inside the isolated child.
	const product = await import("../src/harness.ts");
	const approval = await import("../src/ext/approval.ts");
	const { makeBackgroundExtension } = await import("../src/ext/background.ts");
	const { makeScheduleExtension } = await import("../src/ext/schedule.ts");
	const { makeProcExtension } = await import("../src/ext/proc.ts");
	const { probeSandbox, resolveSpawnShell } = await import("../src/sandbox.ts");
	let models;
	let model = { provider: "faux", modelId: "faux-1" };
	if (config.mode === "faux") {
		const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
		const factory = scriptedFactory();
		faux.setResponses(Array.from({ length: config.limits.requests + 1 }, () => factory));
		models = createModels();
		models.setProvider(faux.provider);
	} else {
		const selected = loadModelsConfig().main;
		const key = process.env[selected.apiKeyEnv];
		if (!key) throw new Error(`真实评测缺少 ${selected.apiKeyEnv}`);
		const client = createModelClient(selected, key);
		models = client.models;
		model = { provider: client.model.provider, modelId: client.model.id };
	}
	const budget = config.costBudget === undefined ? undefined : new RequestBudget(config.costBudget);
	const publishBudget = async (): Promise<void> => {
		if (budget === undefined) return;
		evidence.costBudget = budget.snapshot();
		if (process.send !== undefined) await new Promise<void>((done, fail) => process.send!({ type: "cost_budget", budget: evidence.costBudget }, (error) => error ? fail(error) : done()));
	};
	const provider = models.getProvider(model.provider)!;
	const guardedModels = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
	guardedModels.setProvider(guardedProvider(provider, async () => {
		if (limitStop || evidence.requests! >= config.limits.requests) {
			fatal ??= "Trial model request budget exceeded"; limitStop = true; throw new Error(fatal);
		}
		let id = evidence.requests! + 1;
		try { id = budget?.reserve() ?? id; }
		catch (error) { fatal ??= String(error); limitStop = true; await publishBudget(); throw error; }
		evidence.requests = evidence.requests! + 1;
		observe({ event: "request", at: Date.now() });
		// Deliver the reservation to the supervisor before the provider can charge.
		await publishBudget();
		return id;
	}, (id, message) => {
		budget?.settle(id, message);
		if (budget !== undefined) {
			evidence.costBudget = budget.snapshot();
			process.send?.({ type: "cost_budget", budget: evidence.costBudget });
			if (evidence.costBudget.stopped) { fatal ??= "Trial estimated cost budget exceeded"; limitStop = true; }
		}
	}));
	models = guardedModels;
	// Prevent implicit web registration and remove raw inherited secret values before any task starts.
	await product.scrubSecretEnv();
	if (config.mode === "real") {
		if (process.platform !== "linux") throw new Error("真实评测只支持 Linux + bwrap");
		const state = await probeSandbox({ dataDir: process.env.DWELL_DATA!, stateDir: process.env.DWELL_STATE!, appRoot: resolve(import.meta.dirname, ".."), forceOff: false });
		if (!state.enabled) throw new Error(`真实评测沙箱不可用：${state.reason}`);
		product.setSandboxState(state);
		evidence.sandbox = state;
	}
	const seenTools = new Set<string>();
	const observeTool = (call: { id: string; name: string; arguments: unknown }, conversationId: number): void => {
		const key = `${conversationId}:${call.id}`;
		if (seenTools.has(key)) return;
		seenTools.add(key);
		observe({ event: "tool", conversationId, callId: call.id, name: call.name, args: call.arguments, at: Date.now() });
		if (evidence.tools! >= config.limits.tools) { fatal ??= "Trial tool budget exceeded"; limitStop = true; return; }
		evidence.tools = evidence.tools! + 1;
	};
	const observer = defineExtension({
		name: "dwell-eval-observer",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (_request, api, hookContext) => {
					if (evidence.requests! >= config.limits.requests || limitStop) {
						fatal ??= "Trial model request budget exceeded";
						limitStop = true;
						void harness!.abortTask(api.taskId, context).catch((error: unknown) => { fatal ??= String(error); });
						const signal = hookContext.abortSignal;
						if (signal !== undefined && !signal.aborted) await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
						signal?.throwIfAborted();
						throw new Error(fatal);
					}
				},
				afterResponse: (message, api) => {
					// Tool proposals include policy-blocked calls whose later hooks do not run.
					for (const call of message.content) if (call.type === "toolCall") observeTool(call, api.conversationId as number);
				},
			}),
			hook(ToolTask, {
				beforeTool: (call, api) => {
					observeTool(call, api.conversationId as number);
					if (limitStop) return { block: fatal ?? "Trial budget exceeded" };
					if (config.background !== undefined && api.conversationId !== 1 && ["write", "edit", "bash"].includes(call.name)) return { block: "This evaluator worker is read-only; return structured results to the parent." };
				},
				afterTool: (call, result, api) => {
					const output = result.structuredOutput as { exitCode?: number } | undefined;
					observe({ event: "tool_result", conversationId: api.conversationId as number, taskId: api.taskId as number, callId: call.id, name: call.name, args: call.arguments, isError: result.isError === true, ...(call.name === "bash" && typeof output?.exitCode === "number" ? { exitCode: output.exitCode } : {}), at: Date.now() });
				},
			}),
		],
	});
	const fired: { conversationId: number; submissionId: SubmissionId; kind: string }[] = [];
	const attribute = async (id: number): Promise<void> => { await approval.setRunAttribution(id, "eval-user", "panel"); };
	const onFired = (kind: string) => (conversationId: number, submissionId: SubmissionId): void => {
		fired.push({ conversationId, submissionId, kind });
		observe({ event: "autonomous", conversationId, name: kind, at: Date.now() });
	};
	const schedule = makeScheduleExtension({ attribute, onFired: onFired("schedule"), getHarness: () => harness, senderOf: () => "eval-user", viaOf: () => "panel" });
	const proc = makeProcExtension({ attribute, onFired: onFired("process"), getHarness: () => harness, senderOf: () => "eval-user", viaOf: () => "panel", shell: () => resolveSpawnShell(product.sandboxState) });
	const forbidden: Extension[] = [schedule, proc];
	const background = makeBackgroundExtension({ getHarness: () => harness, attribute, onFired: onFired("background"), onStarted: (child, parent) => { approval.conversationScope.set(child, parent); }, senderOf: () => "eval-user", viaOf: () => "panel", forbidden: () => forbidden });
	forbidden.push(background);
	const guard = approval.makePathGuardExtension(async () => process.cwd());
	const open = () => product.openDwell(models, [observer, guard, schedule, proc, background], (error) => { observe({ event: "report", text: String(error), at: Date.now() }); });
	harness = await open();
	harness.resume();
	let root = await harness.root(context, { agent: { model, cwd: process.cwd() } });
	await attribute(root.id as number);
	const submit = async (input: string, requestId: string): Promise<void> => {
		const settled = await (await root.submit({ type: "input", content: input, requestId, entry: { kind: "chat.message", data: { sender: "eval-user", via: "panel" } } }, context)).wait(context);
		requireAnswer(settled, "Submission unanswered");
	};
	await submit(config.task, "eval:initial");
	if (config.clarification !== undefined) {
		const view = await root.context(context);
		const answer = view.entries.filter((entry) => entry.kind === "pi.assistant").at(-1);
		const question = textOf(answer?.model);
		const subject = new RegExp(config.clarificationSubject ?? "\\b(?:currency|USD|EUR)\\b|币种|货币|美元|欧元", "i");
		const request = /\?|？|\b(?:which|what|specify|choose|confirm)\b|哪|什么|请(?:问|确认|选择|指定)|还是/i;
		const eligible = question.split(/(?<=[.!?。！？])|\n/).some((sentence) => subject.test(sentence) && request.test(sentence));
		evidence.assistance.push({ kind: "clarification", supplied: eligible, note: config.clarification });
		if (!eligible) throw new Error("No clarification question was asked; scripted reply withheld");
		const state = config.clarificationFiles === undefined ? await readFile(resolve(process.cwd(), "rates.json"), "utf8") : JSON.stringify(Object.fromEntries(await Promise.all(config.clarificationFiles.map(async (name) => [name, await readFile(resolve(process.cwd(), name), "utf8")]))));
		observe({ event: "clarification_state", text: state, at: Date.now() });
		if (config.reopenAfterClarification) {
			await root.waitForIdle(context);
			observe({ event: "work_before_restart", text: JSON.stringify(await getWork(harness, root.id)), at: Date.now() });
			await harness.close(context);
			harness = await open();
			harness.resume();
			root = await harness.root(context);
			observe({ event: "work_after_restart", text: JSON.stringify(await getWork(harness, root.id)), at: Date.now() });
		}
		observe({ event: "clarification", text: config.clarification, at: Date.now() });
		await submit(config.clarification, "eval:clarification");
	}
	if (config.approvalCommand !== undefined) {
		const key = approval.windowKey(root.id as number, "eval-user");
		const pending = approval.pendingApprovals.get(key);
		const eligible = pending?.command === config.approvalCommand && pending.targets?.length === 1 && pending.targets[0] === root.id;
		const variant = config.variant ?? "deny";
		evidence.assistance.push({ kind: `approval:${variant}`, supplied: eligible, note: `Only the predeclared command ${config.approvalCommand} is eligible` });
		if (!eligible) throw new Error("Approval did not match the predeclared command and target; decision withheld");
		const decision = await approval.takeDecision(key, variant, 1);
		if (decision === undefined) throw new Error("The eligible approval was no longer pending");
		if (config.mode === "faux") config.script.push(...(variant === "approve" ? [{ tool: "bash", args: { command: config.approvalCommand, timeout: 10 } } as ScriptStep] : []), { text: variant === "approve" ? "The disposable directory was removed." : "I stopped the deletion." });
		observe({ event: `approval:${variant}`, text: config.approvalCommand, at: Date.now() });
		let resumed: Submission | undefined;
		const delivery = await approval.drainApprovalDecisions(async (saved, target) => {
			if (target.conversationId !== root.id) return "unavailable";
			resumed = await root.submit({
				type: "input", content: approval.decisionInput(saved.action, saved.minutes, saved.expiresAt),
				requestId: `approval:${saved.id}:${target.conversationId}`, whenBusy: "followUp",
				entry: { kind: target.budgetId === undefined ? "dwell.approval.legacy" : "dwell.approval", data: { sender: saved.trigger, via: saved.via, ...(target.budgetId === undefined ? {} : { budgetId: target.budgetId }) } },
			}, context);
			return "accepted";
		}, decision.id);
		if (delivery.pending !== 0 || delivery.unavailable !== 0 || resumed === undefined) throw new Error("Approval continuation was not delivered");
		const settled = await (resumed as Submission).wait(context);
		requireAnswer(settled, "Approval continuation unanswered");
	}
	if (config.background !== undefined || config.process !== undefined) {
		await until(async () => fired.length > 0);
		for (const item of fired) {
			const submission = await harness.submission(item.submissionId, context);
			const settled = await submission?.wait(context);
			requireAnswer(settled, "Autonomous follow-up did not finish");
		}
		await root.waitForIdle(context);
	}
	if (fatal !== undefined) throw new Error(fatal);
	evidence.status = "completed";
} catch (error) {
	evidence.error = error instanceof Error ? error.message : String(error);
} finally {
	if (harness !== undefined) {
		try {
			// Preserve pending schedules before cleanup can turn them terminal.
			evidence.tasks = await harness.commit(async (tx) => [...(await tx.scanTasks({}, 1000)).items], context);
			// Stop owned process trees before reading the final committed transcript.
			const root = await harness.root(context);
			await root.abort(context, { background: true });
			evidence.usage = await harness.usage(context);
			const conversations = await harness.commit(async (tx) => (await tx.scanConversations({}, 100)).items, context);
			for (const item of conversations) {
				const conversation = await harness.conversation(item.id, context);
				if (conversation !== undefined) evidence.transcripts.push({ conversationId: item.id as number, entries: [...(await conversation.entries({ order: "ascending" }, 1000, undefined, context)).items] });
			}
		} catch (error) { evidence.status = "error"; evidence.error ??= String(error); }
		try {
			const root = await harness.root(context);
			observe({ event: "work_final", text: JSON.stringify(await getWork(harness, root.id)), at: Date.now() });
		} catch (error) { evidence.status = "error"; evidence.error ??= String(error); }
		try { await harness.close(context); } catch (error) { evidence.status = "error"; evidence.error ??= String(error); }
	}
	evidence.wallMs = Date.now() - startedAt;
	if (process.send !== undefined) process.send(evidence, () => process.disconnect?.());
	else console.log(JSON.stringify(evidence));
}
