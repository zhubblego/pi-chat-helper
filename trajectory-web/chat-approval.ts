/**
 * chat-approval.ts — 子进程扩展：full profile 下的工具审批。
 *
 * 只读/轨迹工具直接放行；其余工具每次通过 RPC 的 extension_ui 请求用户确认。
 * 拒绝时返回 { block:true }，工具不会执行。本扩展不做全局允许（allow-set 在 host 内存）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AUTO = new Set(["read_trajectory", "read", "grep", "ls", "find"]);
const DETAIL_MAX = 500;

function clip(value: unknown, max = DETAIL_MAX): string {
	const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 只取命令/path 的可读摘要，不把整个文件内容塞进弹层。 */
function describeToolCall(event: { toolName?: string; input?: Record<string, unknown> }): string {
	const input = event.input ?? {};
	const name = event.toolName ?? "tool";
	if (name === "bash" || name === "powershell") return clip(input.command);
	const path = input.path ?? input.file_path ?? input.filePath;
	if (path !== undefined) return clip(path);
	try {
		return clip(JSON.stringify(input));
	} catch {
		return clip(String(input));
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName ?? "tool";
		if (AUTO.has(toolName)) return;
		const detail = describeToolCall(event);
		const ok = await ctx.ui.confirm(`允许 ${toolName}？`, detail, { timeout: 120000 });
		if (!ok) return { block: true, reason: "用户拒绝了本次工具调用" };
	});
}
