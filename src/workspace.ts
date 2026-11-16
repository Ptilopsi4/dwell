import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, GenerationTask, LiveDoc, ToolTask, defineDoc, defineExtension, hook, section, type ConversationId, type Cursor, type Extension, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { DEFAULT_CWD } from "./state.ts";
import { abortBeforeRequest } from "./ext/approval.ts";

export type WorkspaceMode = "read" | "write";
type ChildAccess = { parent: number; mode: WorkspaceMode; workspace: string; stopped?: boolean; stopComplete?: boolean };
type Writer = { conversationId: number; reporterId: number; workspace: string };
type MainRun = { firstInput: number; workspace: string; writable: boolean };

export const WorkspaceDoc = defineDoc<{
	children: Record<string, ChildAccess>;
	writers: Record<string, Writer>;
	mains: Record<string, MainRun>;
}>({
	kind: "dwell.workspace-access",
	version: 1,
	scope: "session",
	initial: () => ({ children: {}, writers: {}, mains: {} }),
	checkpointWhen: () => true,
});

let waitingForApproval: (conversationId: number) => boolean = () => false;

export function setWorkspaceApprovalGetter(getter: (conversationId: number) => boolean): void {
	waitingForApproval = getter;
}

const liveStatus = (status: string): boolean => ["pending", "running", "sleeping", "waiting", "completing"].includes(status);
const inside = (path: string, root: string): boolean => {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
};
export const overlappingWorkspaces = (a: string, b: string): boolean => inside(a, b) || inside(b, a);

export async function canonicalWorkspace(cwd: string): Promise<string> {
	return realpath(resolve(cwd));
}

async function reconcile(tx: Tx): Promise<void> {
	const doc = await tx.doc(WorkspaceDoc);
	for (const [id, main] of Object.entries(doc.mains)) {
		const live = await tx.doc(LiveDoc, Number(id) as ConversationId);
		if (live.run?.inputs[0] !== main.firstInput) delete doc.mains[id];
	}
	for (const [key, writer] of Object.entries(doc.writers)) {
		const access = doc.children[String(writer.conversationId)];
		if (access?.stopped === true && access.stopComplete !== true) continue;
		const reporter = await tx.task(writer.reporterId as TaskId);
		const live = await tx.doc(LiveDoc, writer.conversationId as ConversationId);
		const reporting = reporter !== undefined && "checkpoint" in reporter.state && typeof reporter.state.checkpoint === "object" && reporter.state.checkpoint !== null && "phase" in reporter.state.checkpoint && reporter.state.checkpoint.phase === "report";
		if (reporter !== undefined && liveStatus(reporter.state.status) && !reporting) continue;
		if (live.run !== undefined || (doc.children[String(writer.conversationId)]?.stopped !== true && waitingForApproval(writer.conversationId))) continue;
		delete doc.writers[key];
	}
}

export async function markBackgroundWorkspaceStopped(tx: Tx, child: number): Promise<void> {
	const doc = await tx.doc(WorkspaceDoc);
	const access = doc.children[String(child)];
	if (access !== undefined) access.stopped = true;
}

/** The caller has joined every Reporter and aborted the child before releasing its lease. */
export async function releaseStoppedWorkspace(tx: Tx, child: number): Promise<void> {
	const access = (await tx.doc(WorkspaceDoc)).children[String(child)];
	if (access !== undefined) access.stopComplete = true;
	await reconcile(tx);
}

async function mainRun(tx: Tx, conversationId: ConversationId, workspace: string): Promise<void> {
	await reconcile(tx);
	const doc = await tx.doc(WorkspaceDoc);
	if (doc.children[String(conversationId)] !== undefined) return;
	const live = await tx.doc(LiveDoc, conversationId);
	const first = live.run?.inputs[0];
	if (first === undefined || doc.mains[String(conversationId)]?.firstInput === first) return;
	const writer = Object.values(doc.writers).some((item) => overlappingWorkspaces(workspace, item.workspace));
	const main = Object.entries(doc.mains).some(([id, item]) => Number(id) !== conversationId && item.writable && overlappingWorkspaces(workspace, item.workspace));
	doc.mains[String(conversationId)] = { firstInput: first, workspace, writable: !writer && !main };
}

/** A handoff cannot race an already admitted tool from the same model response. */
export async function workspaceStartViolation(tx: Tx, parent: number, workspace: string, taskId?: TaskId): Promise<string | undefined> {
	await mainRun(tx, parent as ConversationId, workspace);
	const doc = await tx.doc(WorkspaceDoc);
	if (Object.values(doc.writers).some((item) => overlappingWorkspaces(workspace, item.workspace))) return "This workspace already has a writable background task. Wait for it to finish or stop it.";
	if (Object.entries(doc.mains).some(([id, main]) => Number(id) !== parent && main.writable && overlappingWorkspaces(workspace, main.workspace))) return "Another conversation owns this workspace for its current run. Start the writable task after that run finishes.";
	const live = await tx.doc(LiveDoc, parent as ConversationId);
	if ((live.tools ?? []).some((tool) => tool.taskId !== taskId)) return "Start a writable background task in its own tool batch, after all other tools have finished.";
	if ((live.nestedTools ?? []).some((tool) => tool.taskId !== taskId)) return "Wait for the other workspace tools to finish before handing off write access.";
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanTasks({ kind: "dwell.proc-run" }, 200, cursor);
		for (const proc of page.items) {
			if (!liveStatus(proc.state.status)) continue;
			const agent = await tx.doc(AgentDoc, proc.conversationId);
			if (overlappingWorkspaces(workspace, await canonicalWorkspace(agent.cwd ?? DEFAULT_CWD))) return "Stop the managed process using this workspace before handing off write access to a background task.";
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
}

export async function registerBackgroundWorkspace(tx: Tx, parent: number, child: number, mode: WorkspaceMode, workspace: string, reporterId: TaskId): Promise<void> {
	const doc = await tx.doc(WorkspaceDoc);
	doc.children[String(child)] = { parent, mode, workspace };
	if (mode === "read") return;
	doc.writers[workspace] = { conversationId: child, reporterId, workspace };
	const main = doc.mains[String(parent)];
	if (main !== undefined) main.writable = false;
}

/** Check before creating a Reporter, while table reads are still allowed. */
export async function checkBackgroundWorkspace(tx: Tx, parent: number, child: number, taskId?: TaskId): Promise<void> {
	await reconcile(tx);
	const doc = await tx.doc(WorkspaceDoc);
	const access = doc.children[String(child)];
	if (access?.stopped === true) throw new Error("This background task has been stopped.");
	if (access?.mode !== "write") return;
	const existing = doc.writers[access.workspace];
	if (existing?.conversationId === child) return;
	const violation = await workspaceStartViolation(tx, parent, access.workspace, taskId);
	if (violation !== undefined) throw new Error(violation);
}

/** Doc-only half of the handoff, after the Reporter table write. */
export async function prepareBackgroundWorkspace(tx: Tx, parent: number, child: number, reporterId: TaskId): Promise<void> {
	const doc = await tx.doc(WorkspaceDoc);
	const access = doc.children[String(child)];
	if (access?.mode !== "write") return;
	await registerBackgroundWorkspace(tx, parent, child, "write", access.workspace, reporterId);
}

const readOnlyTools = new Set(["read", "dwell.web.search", "dwell.web.fetch", "dwell.lark.read", "dwell.lark.image", "dwell.proc.logs"]);
export const readOnlyWorkspaceTool = (name: string): boolean => readOnlyTools.has(name);

function mutatesWorkspace(name: string, args: Record<string, unknown>): boolean {
	return name === "write" || name === "edit" || name === "bash" || (name === "dwell.proc" && args.action === "start") || (name === "dwell.work" && args.action === "verify");
}

export function makeWorkspaceExtension(getHarness: () => Harness | undefined): Extension {
	return defineExtension({
		name: "dwell-workspace",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (_request, api, context) => {
					const harness = getHarness();
					if (harness === undefined) throw new Error("Workspace controller is not attached");
					if ((await harness.snapshot(WorkspaceDoc, context))?.children[String(api.conversationId)]?.stopped === true) await abortBeforeRequest(harness, api.taskId, context);
					const agent = await api.snapshot(AgentDoc, api.conversationId, context);
					const workspace = await canonicalWorkspace(agent?.cwd ?? DEFAULT_CWD);
					await harness.commit((tx) => mainRun(tx, api.conversationId, workspace), context);
				},
			}),
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					const harness = getHarness();
					if (harness === undefined) return { block: "Workspace controller is unavailable." };
					const agent = await api.snapshot(AgentDoc, api.conversationId, context);
					const workspace = await canonicalWorkspace(agent?.cwd ?? DEFAULT_CWD);
					return harness.commit(async (tx) => {
						await mainRun(tx, api.conversationId, workspace);
						const doc = await tx.doc(WorkspaceDoc);
						const access = doc.children[String(api.conversationId)];
						if (access?.stopped === true) return { block: "This background task has been stopped. Do not continue its work." };
						if (access?.mode === "read" && !readOnlyTools.has(call.name)) return { block: "This background task is read-only. Return your analysis to the main agent; only an explicitly started writable task may run shell commands or change files." };
						if (!mutatesWorkspace(call.name, call.arguments)) return undefined;
						const lease = Object.values(doc.writers).find((item) => overlappingWorkspaces(workspace, item.workspace));
						if (access?.mode === "write") return lease?.conversationId === api.conversationId ? undefined : { block: "This task does not hold the workspace write lease. Ask the main agent to send a new task after the current writer finishes." };
						const main = doc.mains[String(api.conversationId)];
						if (lease !== undefined || main?.writable !== true) return { block: "This run does not own workspace write access. Read files or wait for the writable background task; start a new run after its result arrives before making further changes." };
						return undefined;
					}, context);
				},
			}),
		],
		sections: [section("workspace", () => "Background tasks are read-only by default, including no shell access. Use mode=write only for a task that must change files or run commands. Only one task can write a workspace; hand off in a tool batch by itself. After handing off, keep the current main run read-only and wait for the result before starting a new run that changes files. Re-read affected files before editing after a background result.", { tag: false })],
	});
}

/** Older child conversations receive the safer default before any resumed work. */
export async function registerLegacyWorkspaces(harness: Harness): Promise<void> {
	const children = await harness.commit(async (tx) => {
		const found: { child: number; parent: number; cwd: string }[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanConversations({}, 200, cursor);
			for (const conv of page.items) {
				if (conv.owner === undefined) continue;
				const owner = await tx.task(conv.owner.taskId);
				if (owner?.kind !== "dwell.background-anchor") continue;
				const agent = await tx.doc(AgentDoc, conv.id);
				found.push({ child: conv.id, parent: owner.conversationId, cwd: agent.cwd ?? DEFAULT_CWD });
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return found;
	}, BACKGROUND_CONTEXT);
	for (const item of children) {
		const workspace = await canonicalWorkspace(item.cwd);
		await harness.commit(async (tx) => {
			const doc = await tx.doc(WorkspaceDoc);
			if (doc.children[String(item.child)] === undefined) doc.children[String(item.child)] = { parent: item.parent, mode: "read", workspace };
		}, BACKGROUND_CONTEXT);
	}
}
