import type { Server } from "node:http";
import type { StateDb } from "./state-db.mjs";

/** 单个工具的归属（内置 / MCP / 扩展包）。 */
export interface ToolOriginEntry {
	kind: "builtin" | "mcp" | "package";
	label: string;
}

/** createTrajectoryServer 的参数（server/app.mjs 的 TypeScript 声明）。 */
export interface PiBinSpec {
	cmd: string;
	argsPrefix?: string[];
	mode?: boolean;
	display?: string;
	kind?: string;
}

export interface TrajectoryServerOptions {
	scope?: "project" | "all";
	sessionFile?: string;
	sessionsRoot?: string;
	webDir: string;
	host?: string;
	port?: number;
	liveWindowMs?: number;
	log?: (message: string) => void;
	/** 精确归属映射（模式 A：扩展从 pi.getAllTools().sourceInfo 生成）；可为提供者函数以便每次请求现取。 */
	toolOrigins?: Record<string, ToolOriginEntry> | (() => Record<string, ToolOriginEntry>);
	/** 静态扫描用的 pi 安装目录与 agent 目录（模式 B / 测试）。 */
	piDir?: string;
	agentDir?: string;
	/** 状态库路径；默认 <agentDir>/pi-chat-helper/state.db。未传 agentDir 时 S2 默认不启用状态库。 */
	stateDbPath?: string;
	/** 测试/嵌入方可注入已打开的状态库；false 强制禁用。 */
	stateDb?: StateDb | false;
	/** 对话控制面。chat=false 强制禁用；chatDir/piBin/hostEntry 任一存在则启用。 */
	chat?: boolean;
	chatDir?: string;
	/** 控制台桥注册目录；默认 <agentDir>/pi-chat-helper/consoles。 */
	consolesDir?: string;
	piBin?: PiBinSpec | string;
	hostEntry?: string;
	hostExecPath?: string;
	/** SSE 保活间隔（毫秒）；默认 15000，仅测试注入小值。 */
	chatPingMs?: number;
	/** 对话 child 全局上限；默认 2。 */
	chatMaxChildren?: number;
	/** 空闲 child 回收阈值（毫秒）；默认 900000（15 分钟）。 */
	chatIdleTtlMs?: number;
	/** 空闲扫描间隔（毫秒）；默认 60000（60 秒）。 */
	chatSweepMs?: number;
}

export interface TrajectoryServerHandle {
	port: number;
	host: string;
	url: string;
	server: Server;
	close: () => Promise<void>;
}

export function createTrajectoryServer(options: TrajectoryServerOptions): Promise<TrajectoryServerHandle>;
