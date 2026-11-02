// 危险命令审批（简版 Mandate）：bash 危险模式默认 block，用户 -approve 开启会话级时间窗后放行。
// 时间窗即授权范围——批准一次，窗口内该会话不再逐条问（借 dsh-superagent Mandate 思想）。
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

/** conversationId → 审批窗口到期时间戳（ms）。进程内存即可：重启丢窗口，最坏是重新批一次。 */
export const approvals = new Map<number, number>();

/** 审批请求回调（index.ts 注册：转发到飞书提醒用户）。 */
export let onApprovalNeeded: ((conversationId: number, command: string, reason: string) => void) | null = null;

export function setApprovalCallback(fn: (conversationId: number, command: string, reason: string) => void): void {
	onApprovalNeeded = fn;
}

const DANGEROUS: [RegExp, string][] = [
	[/\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\b/i, "递归强删"],
	[/\bssh\b|\bscp\b|\brsync\b.*-e.*ssh/, "远程访问"],
	[/curl[^|]*\s(-d\b|--data|--form\b|-F\b|-T\b|--upload)|curl[^|]*-X\s*POST/, "数据外发"],
	[/wget[^|]*--post/, "数据外发"],
	[/npm\s+install\s+-g|apt(-get)?\s+install|pip3?\s+install/, "安装软件"],
	[/\bdocker\b|\b systemctl\b|\bcrontab\b/, "系统操作"],
];

export function dangerReason(command: string): string | null {
	for (const [pattern, reason] of DANGEROUS) {
		if (pattern.test(command)) return reason;
	}
	return null;
}

export function windowOpen(conversationId: number): boolean {
	const expiry = approvals.get(conversationId);
	if (expiry === undefined) return false;
	if (expiry < Date.now()) {
		approvals.delete(conversationId);
		return false;
	}
	return true;
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
					// sudo 在本环境永不可能成功（NoNewPrivileges + dwell 无 sudo 组），直接说明，不走审批
					if (/\bsudo\b/.test(command)) {
						return { block: "dwell 用户无 sudo 权限（服务以 no-new-privileges 运行），此命令无法执行。向用户说明并改用不需要提权的方案。" };
					}
					const reason = dangerReason(command);
					if (reason === null) return undefined;
					if (windowOpen(api.conversationId)) return undefined;
					// 放行与否由窗口决定；通知走回调，不阻塞 hook
					onApprovalNeeded?.(api.conversationId, command, reason);
					return { block: `该命令被审批策略拦截（${reason}）。请明确告诉用户：回复 /approve 批准（默认 10 分钟窗口）或 /deny 拒绝。批准后继续原任务；不要尝试其他方式绕过。` };
				},
			}),
		],
	});
}
