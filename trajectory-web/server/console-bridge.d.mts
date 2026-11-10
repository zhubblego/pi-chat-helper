import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CONSOLE_BRIDGE_PROTOCOL: 1;
export const CONSOLE_BRIDGE_DISABLE_ENV: "PI_CHAT_HELPER_CONSOLE_BRIDGE";
export const CONSOLE_PROMPT_MAX_CHARS: 32_000;
export const CONSOLE_HEARTBEAT_MS: 5_000;
export const CONSOLE_HEARTBEAT_TTL_MS: 15_000;

export interface ConsoleBridgeOptions {
	/** 扩展 API；桥只使用 sendUserMessage。 */
	pi: Pick<ExtensionAPI, "sendUserMessage">;
	/** 当前扩展上下文；session 切换后由调用方返回最新 ctx。 */
	getCtx: () => ExtensionContext | null | undefined;
	/** pi agent 目录，注册文件写到 <agentDir>/pi-chat-helper/consoles/。 */
	agentDir: string;
	log?: (message: string) => void;
	env?: Record<string, string | undefined>;
	/** 测试注入；默认 5000ms。 */
	heartbeatMs?: number;
}

export interface ConsoleBridge {
	/** 仅 ctx.mode === "tui" 且未禁用时启动；成功返回 true。 */
	start: () => Promise<boolean>;
	close: () => Promise<void>;
	/** agent_start / agent_settled 驱动；会清除 forward 的乐观忙碌标记。 */
	setState: (state: "idle" | "working") => void;
	readonly port: number | null;
	readonly registrationPath: string | null;
}

export function consolesDirFor(agentDir: string): string;
export function consoleBridgeEnabled(env?: Record<string, string | undefined>): boolean;
export function canonicalSessionFile(file: string): string;
export function sameSessionFile(a: string | null | undefined, b: string | null | undefined): boolean;
export function createConsoleBridge(options: ConsoleBridgeOptions): ConsoleBridge;
