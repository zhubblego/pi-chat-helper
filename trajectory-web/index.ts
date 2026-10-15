/**
 * trajectory-web — 把当前 pi 会话的轨迹以 web 页面形式观察。
 *
 * `/start [端口]`：启动独立的本地 web 服务（默认 127.0.0.1:7717），浏览器打开
 *   提示的 URL 即可看到按「问题 → 轨迹条目」两级分组的完整会话轨迹。
 *   服务是 detached 后台进程：pi 退出、重开会话都不影响，浏览器页面可一直挂着看。
 * `/stop`：停止服务并清理运行时状态。
 *
 * 设计：
 *   - 服务只读会话 JSONL（~/.pi/agent/sessions/...），不依赖 pi 运行时，也不写回会话。
 *   - 运行时状态（state.json / server.log）放在 ~/.pi/agent/trajectory-web/。
 *   - 幂等：已在运行时再次 /start 只提示当前 URL；观察的是别的会话时提示先 /stop。
 *   - 终止前用 /proc/<pid>/cmdline 核实目标进程确实是本服务，避免 pid 复用误杀。
 *
 * 部署（本仓库是源码主本）：
 *   cp -r trajectory-web ~/.pi/agent/extensions/     # 目录即扩展（index.ts 为入口）
 * 开发时可直接加载：
 *   pi --extension ./trajectory-web/index.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(HERE, "server", "main.mjs");
const WEB_DIR = join(HERE, "web");

const STATE_DIR = join(homedir(), ".pi", "agent", "trajectory-web");
const STATE_FILE = join(STATE_DIR, "state.json");
const LOG_FILE = join(STATE_DIR, "server.log");

const DEFAULT_PORT = 7717;
const START_TIMEOUT_MS = 5000;

interface ServiceState {
	pid: number;
	port: number;
	host: string;
	session: string;
	startedAt: string;
	url: string;
}

interface Health {
	ok?: boolean;
	pid?: number;
	port?: number;
	session?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readState(): ServiceState | null {
	try {
		const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as ServiceState;
		return raw && typeof raw.pid === "number" && typeof raw.port === "number" ? raw : null;
	} catch {
		return null;
	}
}

function clearState(): void {
	try {
		if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
	} catch {
		/* 状态文件清理失败不阻塞主流程 */
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** 用 /proc/<pid>/cmdline 核实进程归属；非 Linux 平台无 /proc，退化为"可终止"。 */
function isOurServer(pid: number): boolean {
	try {
		const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
		return cmdline.includes("trajectory-web") && cmdline.includes("main.mjs");
	} catch {
		return process.platform !== "linux";
	}
}

async function healthOf(port: number, timeoutMs = 800): Promise<Health | null> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return null;
		const health = (await res.json()) as Health;
		return health?.ok ? health : null;
	} catch {
		return null;
	}
}

async function stopPid(pid: number): Promise<void> {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	for (let i = 0; i < 20; i++) {
		await sleep(100);
		if (!isAlive(pid)) return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* 已退出 */
	}
	await sleep(150);
}

function logTail(lines = 6): string {
	try {
		const all = readFileSync(LOG_FILE, "utf8").trimEnd().split("\n");
		return all.slice(-lines).join("\n");
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("start", {
		description: "启动轨迹观察 web 服务（/start [端口]，默认 7717；独立后台进程，pi 退出后仍在）",
		handler: async (args, ctx) => {
			const notify = (msg: string, type: "info" | "warning" | "error" = "info"): void => {
				if (ctx.hasUI) ctx.ui.notify(msg, type);
				else console.error(`[trajectory-web] ${msg}`);
			};

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				notify("当前会话没有落盘文件，无法观察轨迹（内存会话不支持）", "error");
				return;
			}

			const arg = (args ?? "").trim();
			let port = DEFAULT_PORT;
			if (arg) {
				const n = Number(arg);
				if (!Number.isInteger(n) || n < 1024 || n > 65535) {
					notify(`端口非法：${arg}（需 1024–65535 的整数）`, "warning");
					return;
				}
				port = n;
			}

			// 已有服务：健康且属实时做幂等提示；残留（进程死亡/不健康/非本服务）则清理
			const existing = readState();
			if (existing) {
				if (isAlive(existing.pid) && isOurServer(existing.pid)) {
					const health = await healthOf(existing.port);
					if (health) {
						if (health.session === sessionFile) {
							notify(`轨迹服务已在运行：${existing.url}`);
						} else {
							notify(
								`已有轨迹服务在观察另一个会话：${existing.url}；如需切换到本会话，请先 /stop 再 /start`,
								"warning",
							);
						}
						return;
					}
					await stopPid(existing.pid);
				}
				clearState();
			}

			mkdirSync(STATE_DIR, { recursive: true });
			try {
				if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
			} catch {
				/* 交给服务端覆盖写 */
			}

			const child = spawn(
				process.execPath,
				[
					SERVER_ENTRY,
					"--session",
					sessionFile,
					"--port",
					String(port),
					"--host",
					"127.0.0.1",
					"--web",
					WEB_DIR,
					"--state",
					STATE_FILE,
					"--log",
					LOG_FILE,
				],
				{ detached: true, stdio: "ignore", cwd: HERE },
			);
			child.unref();

			const deadline = Date.now() + START_TIMEOUT_MS;
			while (Date.now() < deadline) {
				await sleep(120);
				const st = readState();
				if (!st) continue;
				const health = await healthOf(st.port, 500);
				if (health && health.pid === st.pid) {
					notify(`轨迹服务已启动：${st.url}`);
					return;
				}
			}
			notify(`轨迹服务启动超时；日志：${LOG_FILE}${logTail() ? `\n${logTail()}` : ""}`, "error");
		},
	});

	pi.registerCommand("stop", {
		description: "停止轨迹观察 web 服务并清理运行时状态",
		handler: async (_args, ctx) => {
			const notify = (msg: string, type: "info" | "warning" | "error" = "info"): void => {
				if (ctx.hasUI) ctx.ui.notify(msg, type);
				else console.error(`[trajectory-web] ${msg}`);
			};

			const st = readState();
			if (!st) {
				notify("轨迹服务未在运行");
				return;
			}
			if (!isAlive(st.pid)) {
				clearState();
				notify("轨迹服务未在运行（已清理残留状态文件）");
				return;
			}
			if (!isOurServer(st.pid)) {
				clearState();
				notify(`状态文件指向的进程（pid ${st.pid}）不是轨迹服务，已清理状态文件，未终止该进程`, "warning");
				return;
			}
			await stopPid(st.pid);
			clearState();
			notify("轨迹服务已停止");
		},
	});
}
