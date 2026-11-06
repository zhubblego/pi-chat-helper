/**
 * approval.mjs — 工具审批的纯函数（host 与测试共用）。
 *
 * 扩展 `chat-approval.ts` 发 `ctx.ui.confirm("允许 <tool>？", detail, { timeout: 120000 })`；
 * RPC 把 timeout 按毫秒返回，SSE 给前端的 timeout 统一为秒。
 */

export const APPROVAL_TIMEOUT_MS = 120_000;
export const APPROVAL_MESSAGE_MAX = 500;

/** 始终放行的只读工具（与 chat-approval.ts 的 AUTO 保持一致）。 */
export const APPROVAL_AUTO_TOOLS = Object.freeze(["read_trajectory", "read", "grep", "ls", "find"]);

export function isAutoApprovedTool(toolName) {
	return APPROVAL_AUTO_TOOLS.includes(toolName);
}

/** 从 `允许 bash？` / `允许 bash?` 解析 toolName；解析不到返回 null。 */
export function parseApprovalToolName(title) {
	const match = /允许\s*([A-Za-z0-9_.:-]+)\s*[？?]/.exec(String(title ?? ""));
	return match ? match[1] : null;
}

/** 审批摘要：截断到 500 字符，保留可读性。 */
export function approvalMessageSummary(message, max = APPROVAL_MESSAGE_MAX) {
	const text = typeof message === "string" ? message : message === undefined || message === null ? "" : String(message);
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** RPC 的 timeout 是毫秒；缺省/非法回退 120s。 */
export function approvalTimeoutMs(timeout) {
	const value = Number(timeout);
	return Number.isFinite(value) && value > 0 ? value : APPROVAL_TIMEOUT_MS;
}

/** SSE 给前端的 timeout 用秒（向上取整，最小 1）。 */
export function approvalTimeoutSeconds(timeout) {
	return Math.max(1, Math.ceil(approvalTimeoutMs(timeout) / 1000));
}
