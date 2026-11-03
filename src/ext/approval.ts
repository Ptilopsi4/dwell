// 危险命令审批（简版 Mandate）：bash 危险模式默认 block，审批窗口内放行。
// 窗口键 = (conversationId, sender)：谁触发谁申请，互不搭车。
import { defineExtension, hook, ToolTask, type Conversation } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/** conversationId → 当前 run 的发起者（submit 前设置，run 归属判定用）。 */
export const runSender = new Map<number, string>();

/** 审批窗口：(conversationId, sender) → 到期时间戳。 */
export const approvals = new Map<string, number>();

/** 待审批上下文：key 同审批窗口，卡片点击后更新形态 / 校验归属用。 */
export const pendingApprovals = new Map<string, { command: string; match: string; trigger: string; conversationOwner?: string }>();

export let onApprovalNeeded: ((conversationId: number, sender: string, command: string, match: string) => void) | null = null;

export function setApprovalCallback(fn: (conversationId: number, sender: string, command: string, match: string) => void): void {
	onApprovalNeeded = fn;
}

const DANGEROUS: RegExp[] = [
	/\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\b/i,
	/\bssh\b|\bscp\b|\brsync\b.*(-e\s*ssh|@)/,
	/curl[^|]*\s(-[a-z]*d\b|--data|--form\b|-F\b|-T\b|--upload)|curl[^|]*-X\s*POST/,
	/wget[^|]*--post/,
	/npm\s+install\s+-g|apt(-get)?\s+install|pip3?\s+install/,
	/\bdocker\b|\bsystemctl\b|\bcrontab\b/,
];

/** 状态文件名兑底：路径已移出 agent 可写域，此检查防 cwd 相对猜测（减速带非硬墙）。 */
const STATE_FILES = /users\.json|sessions\.json|message-map\.json|(\/|\.)state\//;

/** 返回命中的敏感片段（如 "rm -rf"），未命中返回 null。 */
export function dangerMatch(command: string): string | null {
	for (const pattern of DANGEROUS) {
		const m = pattern.exec(command);
		if (m !== null) return m[0];
	}
	return null;
}

export function windowKey(conversationId: number, sender: string): string {
	return `${conversationId}:${sender}`;
}

export function windowOpen(conversationId: number, sender: string): boolean {
	const key = windowKey(conversationId, sender);
	const expiry = approvals.get(key);
	if (expiry === undefined) return false;
	if (expiry < Date.now()) {
		approvals.delete(key);
		return false;
	}
	return true;
}

/** 面板/卡片共用的审批决策：开/关窗口并唤醒（或通知）模型。 */
export async function approvalDecision(
	conversation: Conversation,
	key: string,
	action: "approve" | "deny",
	minutes: number,
): Promise<{ ok: boolean; error?: string }> {
	if (!pendingApprovals.has(key)) return { ok: false, error: "该请求已失效" };
	if (action === "approve") {
		pendingApprovals.delete(key);
		approvals.set(key, Date.now() + minutes * 60_000);
		const s = await conversation.submit({
			type: "input",
			content: `用户已批准危险命令窗口（${minutes} 分钟）。请继续之前的任务，重试被拦截的命令。`,
			whenBusy: "steer",
			requestId: `decision-${key}-${Date.now()}`,
		}, BACKGROUND_CONTEXT);
		void s.wait(BACKGROUND_CONTEXT).catch(() => {});
	} else {
		pendingApprovals.delete(key);
		approvals.delete(key);
		const s = await conversation.submit({
			type: "input",
			content: "用户拒绝了危险命令。请停止该操作并改用其他方案，或询问用户意图。",
			whenBusy: "steer",
			requestId: `decision-${key}-${Date.now()}`,
		}, BACKGROUND_CONTEXT);
		void s.wait(BACKGROUND_CONTEXT).catch(() => {});
	}
	return { ok: true };
}

/** 挂到 registry 的 extension；只管 bash，其余工具放行。 */
export function makeApprovalExtension() {
	return defineExtension({
		name: "dwell-approval",
		hooks: [
			hook(ToolTask, {
				beforeTool: (call, api) => {
					if (call.name !== "bash") return undefined;
					const command = (call.arguments as { command?: string }).command ?? "";
					if (STATE_FILES.test(command)) {
						return { block: "不允许访问服务状态文件。" };
					}
					// sudo 在本环境永不可能成功（NoNewPrivileges + dwell 无 sudo 组），直接说明，不走审批
					if (/\bsudo\b/.test(command)) {
						return { block: "dwell 用户无 sudo 权限（服务以非 root 运行），此命令无法执行。向用户说明并改用不需要提权的方案。" };
					}
					const match = dangerMatch(command);
					if (match === null) return undefined;
					const convId = api.conversationId as number;
					const sender = runSender.get(convId) ?? "";
					if (windowOpen(convId, sender)) return undefined;
					pendingApprovals.set(windowKey(convId, sender), { command, match, trigger: sender });
					onApprovalNeeded?.(convId, sender, command, match);
					return { block: `该命令被审批策略拦截（${match}）。请明确告诉用户：等待审批卡片按钮或回复 /approve 批准（默认 10 分钟窗口）。批准后继续原任务；不要尝试其他方式绕过。` };
				},
			}),
		],
	});
}
