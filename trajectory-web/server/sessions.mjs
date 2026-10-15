/**
 * sessions.mjs — pi 会话目录的扫描与列表（只读，零依赖）。
 *
 * 两种范围：
 *   project：只扫一个项目会话目录（会话文件所在的 `sessions/--<cwd>--/`）
 *   all：扫会话根目录下的所有项目目录
 *
 * 列表走"stat + 读文件头 64KB"的轻量策略（id/cwd/名称/首条用户消息/创建时间），
 * 每个文件按 mtime+size 缓存解析结果；live 判定 = 最近 30 秒内有写入。
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { extractText, previewOf } from "./session.mjs";

export const DEFAULT_SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
export const LIVE_WINDOW_MS = 30_000;

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
/** file -> { mtimeMs, size, info } */
const headCache = new Map();

/**
 * 读文件头尾：头 256KB 覆盖系统提示 + 首条用户消息；尾 64KB 扫后追加的
 * session_info（改名）。写入中截到的半行由逐行 try/catch 兼容。
 */
function readChunks(file, size) {
	const fd = openSync(file, "r");
	try {
		const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
		const n = readSync(fd, head, 0, head.length, 0);
		let tail = "";
		if (size > HEAD_BYTES) {
			const buf = Buffer.alloc(TAIL_BYTES);
			const tn = readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
			tail = buf.subarray(0, tn).toString("utf8");
		}
		return { head: head.subarray(0, n).toString("utf8"), tail };
	} finally {
		closeSync(fd);
	}
}

/** 从文件名解析 `2026-10-15T03-07-36-377Z_<id>.jsonl`（旧格式没有 header 时兜底）。 */
function fromFileName(file) {
	const name = file.slice(file.lastIndexOf("/") + 1);
	const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_(.+)\.jsonl$/.exec(name);
	if (!m) return { id: name.replace(/\.jsonl$/, ""), created: undefined };
	const [, date, hh, mm, ss, ms] = m;
	return { id: m[6], created: `${date}T${hh}:${mm}:${ss}.${ms}Z` };
}

function parseHead(text, file) {
	const fallback = fromFileName(file);
	let id = fallback.id;
	let cwd;
	let created = fallback.created;
	let name;
	let firstMessage = "";
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "session") {
			if (typeof entry.id === "string") id = entry.id;
			if (typeof entry.cwd === "string") cwd = entry.cwd;
			if (typeof entry.timestamp === "string") created = entry.timestamp;
			continue;
		}
		if (entry.type === "session_info" && typeof entry.name === "string") {
			name = entry.name;
			continue;
		}
		if (entry.type === "message" && entry.message?.role === "user" && !firstMessage) {
			firstMessage = previewOf(extractText(entry.message.content), 120);
		}
	}
	return { id, cwd, created, name, firstMessage };
}

/** 尾部块只扫会话名（改名会 append 到文件尾）。 */
function parseTail(text) {
	let name;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
		} catch {
			/* 尾部首行可能是半行 */
		}
	}
	return name;
}

/** 读取单个会话的列表信息（带缓存）。解析失败时返回 null。 */
function sessionInfoFor(file, stat, projectDir) {
	const cached = headCache.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.info;
	let info;
	try {
		const { head, tail } = readChunks(file, stat.size);
		const parsed = parseHead(head, file);
		info = {
			id: parsed.id,
			file,
			dir: dirname(file),
			projectPath: parsed.cwd ?? null,
			projectDir,
			name: tail ? (parseTail(tail) ?? parsed.name) : parsed.name,
			firstMessage: parsed.firstMessage,
			created: parsed.created,
			modified: stat.mtimeMs,
			size: stat.size,
		};
	} catch {
		return null;
	}
	headCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
	return info;
}

function listDir(dirName, projectDir) {
	const out = [];
	let names;
	try {
		names = readdirSync(dirName);
	} catch {
		return out;
	}
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const file = join(dirName, name);
		try {
			const stat = statSync(file);
			if (!stat.isFile()) continue;
			const info = sessionInfoFor(file, stat, projectDir);
			if (info) out.push(info);
		} catch {
			/* 单个文件不可读不影响列表 */
		}
	}
	return out;
}

/**
 * 列出会话（按最近活跃倒序）。
 * @param {{projectDir?: string, sessionsRoot?: string, liveWindowMs?: number, now?: number}} options
 */
export function listSessions(options = {}) {
	const now = options.now ?? Date.now();
	const liveWindowMs = options.liveWindowMs ?? LIVE_WINDOW_MS;
	const sessions = [];
	if (options.projectDir) {
		sessions.push(...listDir(options.projectDir, options.projectDir));
	} else {
		const root = options.sessionsRoot ?? DEFAULT_SESSIONS_ROOT;
		let dirs;
		try {
			dirs = readdirSync(root, { withFileTypes: true });
		} catch {
			dirs = [];
		}
		for (const dirent of dirs) {
			if (!dirent.isDirectory()) continue;
			sessions.push(...listDir(join(root, dirent.name), join(root, dirent.name)));
		}
	}
	sessions.sort((a, b) => b.modified - a.modified);
	for (const s of sessions) s.live = now - s.modified < liveWindowMs;
	return sessions;
}

/** 在列表里按 id 查会话；找不到（列表过期）返回 null。 */
export function findSession(sessions, id) {
	return sessions.find((s) => s.id === id) ?? null;
}

/** 清空按文件的信息缓存（测试用）。 */
export function clearSessionCache() {
	headCache.clear();
}
