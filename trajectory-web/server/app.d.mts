import type { Server } from "node:http";

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
}

export interface TrajectoryServerHandle {
	port: number;
	host: string;
	url: string;
	server: Server;
	close: () => Promise<void>;
}

export function createTrajectoryServer(options: TrajectoryServerOptions): Promise<TrajectoryServerHandle>;
