import type { Server } from "node:http";

/** 单个工具的归属（内置 / MCP / 扩展包）。 */
export interface ToolOriginEntry {
	kind: "builtin" | "mcp" | "package";
	label: string;
}

/** createTrajectoryServer 的参数（server/app.mjs 的 TypeScript 声明）。 */
export interface TrajectoryServerOptions {
	scope?: "project" | "all";
	sessionFile?: string;
	sessionsRoot?: string;
	webDir: string;
	host?: string;
	port?: number;
	liveWindowMs?: number;
	log?: (message: string) => void;
	/** 精确归属映射（模式 A：扩展从 pi.getAllTools().sourceInfo 生成）。 */
	toolOrigins?: Record<string, ToolOriginEntry>;
	/** 静态扫描用的 pi 安装目录与 agent 目录（模式 B / 测试）。 */
	piDir?: string;
	agentDir?: string;
}

export interface TrajectoryServerHandle {
	port: number;
	host: string;
	url: string;
	server: Server;
	close: () => Promise<void>;
}

export function createTrajectoryServer(options: TrajectoryServerOptions): Promise<TrajectoryServerHandle>;
