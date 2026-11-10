/**
 * console-registry.mjs — viewer 侧读取控制台桥注册（T2）。
 *
 * 只读 <agentDir>/pi-chat-helper/consoles/*.json：
 *   - 过滤坏 JSON / 协议不符 / 非交互 / 心跳过期；
 *   - publicConsoles() 只暴露展示字段，token/port/sessionFile/cwd 一律不出 server；
 *   - matchConsole() 按 canonical sessionFile 精确匹配，供 T3 转发使用。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	CONSOLE_BRIDGE_PROTOCOL,
	CONSOLE_HEARTBEAT_TTL_MS,
	canonicalSessionFile,
	consolesDirFor,
	sameSessionFile,
} from "./console-bridge.mjs";

export { consolesDirFor, sameSessionFile };

function stringField(value) {
	return typeof value === "string" && value ? value : null;
}

function normalizeRegistration(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	if (raw.protocol !== CONSOLE_BRIDGE_PROTOCOL) return null;
	if (raw.interactive !== true) return null;
	if (raw.state !== "idle" && raw.state !== "working") return null;
	if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null;
	if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return null;
	const sessionId = stringField(raw.sessionId);
	const sessionFile = stringField(raw.sessionFile);
	const token = stringField(raw.token);
	const heartbeatAt = stringField(raw.heartbeatAt);
	if (!sessionId || !sessionFile || !token || !heartbeatAt) return null;
	const heartbeatMs = Date.parse(heartbeatAt);
	if (!Number.isFinite(heartbeatMs)) return null;
	return {
		protocol: CONSOLE_BRIDGE_PROTOCOL,
		pid: raw.pid,
		sessionId,
		sessionFile: canonicalSessionFile(sessionFile),
		cwd: stringField(raw.cwd),
		port: raw.port,
		token,
		state: raw.state,
		interactive: true,
		startedAt: stringField(raw.startedAt),
		heartbeatAt,
		heartbeatMs,
	};
}

/**
 * 读取当前有效的控制台注册。
 * @param {{consolesDir?: string, now?: number, ttlMs?: number}} [options]
 * @returns {Array<object>} 内部记录（含 token/port/sessionFile，仅供 server 使用）
 */
export function readConsoles(options = {}) {
	const consolesDir = options.consolesDir;
	if (!consolesDir) return [];
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : CONSOLE_HEARTBEAT_TTL_MS;
	let names;
	try {
		names = readdirSync(consolesDir);
	} catch {
		return [];
	}
	const records = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		let raw;
		try {
			raw = JSON.parse(readFileSync(join(consolesDir, name), "utf8"));
		} catch {
			continue;
		}
		const record = normalizeRegistration(raw);
		if (!record) continue;
		if (now - record.heartbeatMs > ttlMs) continue;
		records.push(record);
	}
	records.sort((a, b) => b.heartbeatMs - a.heartbeatMs);
	return records;
}

/** 公开投影：绝不返回 token/port/sessionFile/cwd。 */
export function publicConsoles(records) {
	if (!Array.isArray(records)) return [];
	return records.map((record) => ({
		sessionId: record.sessionId,
		pid: record.pid,
		state: record.state,
		interactive: record.interactive === true,
		heartbeatAt: record.heartbeatAt,
		startedAt: record.startedAt,
	}));
}

/**
 * 按 sessionFile 精确匹配一座在线桥。
 * @param {Array<object>} records readConsoles 的结果
 * @param {string | null | undefined} sessionFile
 * @returns {{record: object, error?: never} | {record?: never, error: "no_console"|"ambiguous_console"}}
 */
export function matchConsole(records, sessionFile) {
	const matched = (Array.isArray(records) ? records : []).filter((record) => sameSessionFile(record.sessionFile, sessionFile));
	if (matched.length === 0) return { error: "no_console" };
	if (matched.length > 1) return { error: "ambiguous_console" };
	return { record: matched[0] };
}
