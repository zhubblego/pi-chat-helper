/**
 * trajectory-web — 轨迹观察服务（模式 A：绑定当前 pi 实例）。
 *
 * `/deepseek-trail start [端口]`：在 pi 进程内启动本地 web 服务（默认 127.0.0.1:7717，
 *   端口被占用自动改用随机端口），观察**当前项目的全部会话**——默认选中当前会话，
 *   页面左侧会话栏可切换项目内其它会话，运行中的会话自动刷新。
 *   服务随本 pi 实例退出而停止（绑定语义）。
 * `/deepseek-trail stop`：停止服务。
 *
 * 模式 B（观察全部 pi 历史与运行中的会话）由独立入口提供：`npm run dev`。
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "web");

const COMMAND_NAME = "deepseek-trail";
const DEFAULT_PORT = 7717;
const USAGE = `用法：/${COMMAND_NAME} start [端口]（默认 ${DEFAULT_PORT}）| /${COMMAND_NAME} stop`;

type Notice = (message: string, type?: "info" | "warning" | "error") => void;

interface ServerHandle {
	port: number;
	url: string;
	close: () => Promise<void>;
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
async function startInProcess(port: number, sessionFile: string): Promise<ServerHandle> {
	const { createTrajectoryServer } = await import("./server/app.mjs");
	const base = { scope: "project" as const, sessionFile, webDir: WEB_DIR, host: "127.0.0.1" };
	try {
		return await createTrajectoryServer({ ...base, port });
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE" && port !== 0) {
			return await createTrajectoryServer({ ...base, port: 0 });
		}
		throw err;
	}
}

async function runStart(portArg: string | undefined, ctx: ExtensionCommandContext, notify: Notice): Promise<void> {
	let port = DEFAULT_PORT;
	if (portArg) {
		const n = Number(portArg);
		if (!Number.isInteger(n) || n < 1024 || n > 65535) {
			notify(`端口非法：${portArg}（需 1024–65535 的整数）`, "warning");
			return;
		}
		port = n;
	}

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

	try {
		const handle = await startInProcess(port, sessionFile);
		slot().handle = handle;
		const note = handle.port === port ? "" : `（端口 ${port} 被占用，改用 ${handle.port}）`;
		notify(`轨迹服务已启动：${handle.url}${note}\n范围：当前项目的全部会话；随本 pi 实例退出而停止`);
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
		description: `轨迹观察服务（绑定本 pi 实例，观察本项目全部会话）：start [端口] 启动（默认 ${DEFAULT_PORT}），stop 停止`,
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "start", label: "start", description: "启动轨迹观察 web 服务（当前项目全部会话）" },
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
				await runStart(rest[0], ctx, notify);
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
