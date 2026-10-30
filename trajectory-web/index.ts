/**
 * trajectory-web — 轨迹观察服务（模式 A：绑定当前 pi 实例）。
 *
 * `/deepseek-trail start [端口] [--codex] [--all]`：在 pi 进程内启动本地 web 服务
 *   （默认 127.0.0.1:7717，端口被占用自动改用随机端口）：
 *   - 无选项：当前项目的全部 pi 会话（默认选中当前会话）。
 *   - `--codex`：范围不变，同时开放 Codex 轨迹源（`~/.codex/sessions`，按当前工作目录过滤）。
 *   - `--all`：观察全部 pi 历史与会话 + 宿主机上全部可用轨迹源（等价模式 B 的范围）。
 *   页面左侧会话栏可切换会话，运行中的会话自动刷新；服务随本 pi 实例退出而停止（绑定语义）。
 * `/deepseek-trail stop`：停止服务。
 *
 * 模式 B（不绑 pi、可常驻）由独立入口提供：`npm run dev`。
 *
 * 设计：
 *   - 只读会话 JSONL，不写回会话；仅监听回环地址。
 *   - 服务句柄挂在 globalThis：pi 换会话（new/resume/fork）会重建扩展 runtime，
 *     句柄要能跨 runtime 复用，服务继续存活；只在 quit/reload 时关闭避免泄漏。
 *   - 端口占用时降级为系统分配端口，并把实际 URL 提示给用户。
 *
 * 部署（本仓库是源码主本）：
 *   cp -r trajectory-web ~/.pi/agent/extensions/     # 目录即扩展（index.ts 为入口）
 * 开发时可直接加载：
 *   pi -ne -e .                                      # 仓库根聚合入口（见 ../index.ts）
 *   pi -e ./trajectory-web/index.ts
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "web");

const COMMAND_NAME = "deepseek-trail";
const DEFAULT_PORT = 7717;
const USAGE = `用法：/${COMMAND_NAME} start [端口] [--codex] [--all]（默认 ${DEFAULT_PORT}）| /${COMMAND_NAME} stop`;

/** start 的参数：端口 + 范围（--all 全部历史）+ 源白名单（--codex 放开 Codex 源）。 */
interface StartOptions {
	port: number;
	scope: "project" | "all";
	sources?: string[];
}

/**
 * 解析 `start [端口] [--codex] [--all] [--port <n>]`。
 * 端口可用位置参数（向后兼容）或 --port；--all 隐含全部源，与 --codex 同时给时以 --all 为准。
 */
function parseStartOptions(args: string[]): { options?: StartOptions; error?: string } {
	let portText: string | undefined;
	let codex = false;
	let all = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--codex") {
			codex = true;
			continue;
		}
		if (arg === "--all") {
			all = true;
			continue;
		}
		if (arg === "--port" || arg.startsWith("--port=")) {
			const value = arg === "--port" ? args[++i] : arg.slice("--port=".length);
			if (!value) return { error: "--port 需要一个端口号" };
			portText = value;
			continue;
		}
		if (arg.startsWith("-")) return { error: `未知选项：${arg}` };
		if (portText !== undefined) return { error: `多余的参数：${arg}` };
		portText = arg;
	}
	let port = DEFAULT_PORT;
	if (portText !== undefined) {
		const n = Number(portText);
		if (!Number.isInteger(n) || n < 1024 || n > 65535) return { error: `端口非法：${portText}（需 1024–65535 的整数）` };
		port = n;
	}
	if (all) return { options: { port, scope: "all" } };
	return { options: { port, scope: "project", sources: codex ? ["pi", "codex"] : undefined } };
}

type Notice = (message: string, type?: "info" | "warning" | "error") => void;

interface ServerHandle {
	port: number;
	url: string;
	close: () => Promise<void>;
}

interface ToolOriginEntry {
	kind: "builtin" | "mcp" | "package";
	label: string;
}

/** mcp__<server>__<tool> → “MCP: <server>”。 */
function mcpLabelOf(name: string): string | null {
	if (!name.startsWith("mcp__")) return null;
	const rest = name.slice(5);
	const index = rest.indexOf("__");
	return `MCP: ${index > 0 ? rest.slice(0, index) : rest}`;
}

/**
 * 从 pi 运行时取精确工具归属（模式 A 专用）。
 * sourceInfo 实测形状：{ path, source, scope, origin, baseDir }；内置 source:"builtin"，
 * npm 包 source:"npm:@scope/pkg"，本地扩展为文件路径 + baseDir。
 */
function toolOriginsFromPi(pi: ExtensionAPI): Record<string, ToolOriginEntry> {
	const out: Record<string, ToolOriginEntry> = {};
	for (const tool of pi.getAllTools()) {
		// SAFETY: ToolInfo 的 sourceInfo 未在安装包的 .d.ts 里导出（运行时由 pi 注入），
		// 此处按实测形状窄化读取；缺失时按内置处理。
		const info = (tool as { sourceInfo?: { source?: string; path?: string; baseDir?: string } }).sourceInfo;
		const name = typeof tool.name === "string" ? tool.name : "";
		if (!name) continue;
		const mcp = mcpLabelOf(name);
		if (mcp) {
			out[name] = { kind: "mcp", label: mcp };
			continue;
		}
		const source = info?.source ?? "";
		if (!info || source === "builtin" || (info.path ?? "").startsWith("builtin:")) {
			out[name] = { kind: "builtin", label: "内置" };
			continue;
		}
		const label = source.startsWith("npm:") ? source.slice(4) : info.baseDir ? basename(info.baseDir) : source || "扩展";
		out[name] = { kind: "package", label };
	}
	return out;
}

interface GlobalSlot {
	handle: ServerHandle | null;
}

const GLOBAL_KEY = Symbol.for("pi-chat-helper.trajectory-web");

/** 跨扩展 runtime 复用的全局槽位（session 切换会重建 runtime）。 */
function slot(): GlobalSlot {
	// SAFETY: globalThis 的类型声明里没有这个 symbol 键；这里只在同一进程内按约定
	// 读写本扩展自己的槽位，值的形状由本函数构造（GlobalSlot），不存在外部来源。
	const g = globalThis as unknown as Record<symbol, unknown>;
	if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { handle: null };
	return g[GLOBAL_KEY] as GlobalSlot;
}

async function closeSlot(): Promise<void> {
	const existing = slot().handle;
	if (!existing) return;
	slot().handle = null;
	await existing.close();
}

/** 进程内启动；端口占用时降级为系统分配端口（port 0）。 */
async function startInProcess(
	options: StartOptions,
	sessionFile: string,
	projectPath: string | undefined,
	toolOrigins: () => Record<string, ToolOriginEntry>,
): Promise<ServerHandle> {
	const { createTrajectoryServer } = await import("./server/app.mjs");
	const base = {
		scope: options.scope,
		sessionFile,
		projectPath,
		sources: options.sources,
		webDir: WEB_DIR,
		host: "127.0.0.1",
		toolOrigins,
	};
	const port = options.port;
	try {
		return await createTrajectoryServer({ ...base, port });
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE" && port !== 0) {
			return await createTrajectoryServer({ ...base, port: 0 });
		}
		throw err;
	}
}

async function runStart(rawArgs: string[], ctx: ExtensionCommandContext, pi: ExtensionAPI, notify: Notice): Promise<void> {
	const parsed = parseStartOptions(rawArgs);
	if (parsed.error) {
		notify(`${parsed.error}；${USAGE}`, "warning");
		return;
	}
	// parseStartOptions 保证 options 与 error 二选一
	const options = parsed.options as StartOptions;

	const existing = slot().handle;
	if (existing) {
		notify(`轨迹服务已在运行：${existing.url}`);
		return;
	}

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		notify("当前会话没有落盘文件，无法观察轨迹（内存会话不支持）", "error");
		return;
	}

	// codex 源按真实工作目录过滤；老版本 pi 或测试替身可能缺 getCwd，缺失时退回不过滤。
	const getCwd = (ctx.sessionManager as { getCwd?: () => string }).getCwd;
	const projectPath = options.scope === "project" && typeof getCwd === "function" ? getCwd.call(ctx.sessionManager) : undefined;

	try {
		const handle = await startInProcess(options, sessionFile, projectPath, () => toolOriginsFromPi(pi));
		slot().handle = handle;
		const note = handle.port === options.port ? "" : `（端口 ${options.port} 被占用，改用 ${handle.port}）`;
		const scopeText = options.scope === "all" ? "全部项目历史 + 全部可用轨迹源" : "当前项目的全部会话";
		const sourceText = options.sources?.length ? `（轨迹源：${options.sources.join(" + ")}）` : "";
		notify(`轨迹服务已启动：${handle.url}${note}\n范围：${scopeText}${sourceText}；随本 pi 实例退出而停止`);
	} catch (err) {
		notify(`轨迹服务启动失败：${(err as Error).message}`, "error");
	}
}

async function runStop(notify: Notice): Promise<void> {
	if (!slot().handle) {
		notify("轨迹服务未在运行");
		return;
	}
	await closeSlot();
	notify("轨迹服务已停止");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description: `轨迹观察服务（绑定本 pi 实例）：start [端口] [--codex] [--all] 启动（默认 ${DEFAULT_PORT}），stop 停止`,
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "start", label: "start", description: "启动轨迹观察 web 服务（当前项目的 pi 会话）" },
				{ value: "start --codex", label: "start --codex", description: "当前项目 + Codex 轨迹源" },
				{ value: "start --all", label: "start --all", description: "全部项目历史 + 全部可用轨迹源" },
				{ value: "stop", label: "stop", description: "停止服务" },
			];
			const p = (prefix ?? "").trim();
			return p ? items.filter((item) => item.value.startsWith(p)) : items;
		},
		handler: async (args, ctx) => {
			const notify: Notice = (message, type = "info") => {
				if (ctx.hasUI) ctx.ui.notify(message, type);
				else console.error(`[trajectory-web] ${message}`);
			};
			const [subcommand, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			if (subcommand === "start") {
				await runStart(rest, ctx, pi, notify);
				return;
			}
			if (subcommand === "stop") {
				await runStop(notify);
				return;
			}
			notify(subcommand ? `未知子命令：${subcommand}；${USAGE}` : USAGE, subcommand ? "warning" : "info");
		},
	});

	// 会话切换（new/resume/fork）会重建扩展 runtime 但不该停服务；
	// 退出与 reload 时关闭，避免端口/句柄泄漏（reload 后新代码重新 start）。
	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit" || event.reason === "reload") await closeSlot();
	});
}
