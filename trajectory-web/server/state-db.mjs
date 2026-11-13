/**
 * state-db.mjs — pi-chat-helper 自有持久化状态的 SQLite 实现。
 *
 * 数据库：<agentDir>/pi-chat-helper/state.db
 * 边界：
 *   - 本文件只负责插件自有状态（prefs / session UI / chat project / turns / context）；
 *   - pi session JSONL、Codex、pi agentDir 的 auth/models/settings/skills 不在这里；
 *   - console 注册、审批 allow-set、进程池、缓存仍是运行期状态，不持久化。
 *
 * 迁移：
 *   - 首次打开时从 settings.json、meta/turns.jsonl、meta/context.*.json 导入；
 *   - 旧文件保留为备份，legacy_imported 标记保证幂等；
 *   - 浏览器 localStorage 的迁移由页面在 S2 通过 API 完成，不属于本模块。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STATE_DB_SCHEMA_VERSION = 1;
export const STATE_DB_DIRNAME = "pi-chat-helper";
export const STATE_DB_FILENAME = "state.db";

/** 全局 UI 偏好的 canonical key（浏览器 tw.* 在 S2 映射到这些 key）。 */
export const GLOBAL_PREF_KEYS = Object.freeze([
	"filters",
	"tools",
	"theme",
	"translate",
	"perspective",
	"chatOpen",
	"chatWidth",
	"composerHeight",
]);

export const CHAT_PROFILES = Object.freeze(["no-tools", "read-only", "full"]);
export const DEFAULT_PROFILE = "read-only";
export const SESSION_MODES = Object.freeze(["independent", "forward"]);
export const CONTEXT_KINDS = Object.freeze(["active", "next"]);
export const MAX_SESSION_CONTEXT_IDS = 5_000;
export const STATE_DB_BUSY_TIMEOUT_MS = 5_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ui_pref (
	key TEXT PRIMARY KEY,
	value_json TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_ui (
	source TEXT NOT NULL,
	session_id TEXT NOT NULL,
	thread_id TEXT,
	thread_new INTEGER NOT NULL DEFAULT 0,
	chat_mode TEXT NOT NULL DEFAULT 'independent',
	context_ids_json TEXT NOT NULL DEFAULT '[]',
	updated_at TEXT NOT NULL,
	PRIMARY KEY (source, session_id)
);

CREATE TABLE IF NOT EXISTS chat_project (
	source TEXT NOT NULL,
	project_path TEXT NOT NULL,
	profile TEXT NOT NULL,
	project_skills INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (source, project_path)
);

CREATE TABLE IF NOT EXISTS chat_turn (
	source TEXT NOT NULL,
	session_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	ordinal INTEGER NOT NULL,
	payload_json TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (source, session_id, thread_id, ordinal)
);

CREATE TABLE IF NOT EXISTS chat_context (
	source TEXT NOT NULL,
	session_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (source, session_id, kind)
);
`;

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

function normalizeSource(value) {
	if (!isNonEmptyString(value)) throw new TypeError("source 需为非空字符串");
	return value;
}

function normalizeSessionId(value) {
	if (!isNonEmptyString(value)) throw new TypeError("sessionId 需为非空字符串");
	return value;
}

function normalizeThreadId(value) {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string") throw new TypeError("threadId 需为字符串或 null");
	if (value.length > 256) throw new TypeError("threadId 过长");
	return value;
}

function normalizeProjectPath(value) {
	if (value === undefined || value === null || value === "") return "";
	if (typeof value !== "string") throw new TypeError("projectPath 需为字符串");
	return resolve(value);
}

function normalizeMode(value) {
	if (!SESSION_MODES.includes(value)) throw new TypeError(`chat_mode 非法：${value}`);
	return value;
}

function normalizeKind(value) {
	if (!CONTEXT_KINDS.includes(value)) throw new TypeError(`context kind 非法：${value}`);
	return value;
}

function normalizeContextIds(value) {
	if (!Array.isArray(value)) throw new TypeError("contextIds 需为数组");
	const ids = [];
	const seen = new Set();
	for (const item of value) {
		if (typeof item !== "string" || !item) throw new TypeError("contextIds 需为非空字符串");
		if (seen.has(item)) continue;
		seen.add(item);
		ids.push(item);
		if (ids.length > MAX_SESSION_CONTEXT_IDS) throw new TypeError("contextIds 数量过多");
	}
	return ids;
}

function normalizeProfile(value) {
	return CHAT_PROFILES.includes(value) ? value : DEFAULT_PROFILE;
}

function jsonText(value, label) {
	let text;
	try {
		text = JSON.stringify(value);
	} catch {
		throw new TypeError(`${label} 不可序列化`);
	}
	if (text === undefined) throw new TypeError(`${label} 不可序列化`);
	return text;
}

function parseJson(text, fallback = null) {
	try {
		return JSON.parse(text);
	} catch {
		return fallback;
	}
}

function currentIso(now) {
	const value = now();
	if (typeof value !== "string" || !value) throw new TypeError("now() 需返回 ISO 字符串");
	return value;
}

function metaGet(db, key) {
	const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key);
	return row?.value ?? null;
}

function metaSet(db, key, value) {
	db.prepare(
		"INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(key, String(value));
}

function readRevision(db) {
	const value = Number(metaGet(db, "prefs_revision") ?? 0);
	return Number.isInteger(value) && value >= 0 ? value : 0;
}

function bumpRevision(db) {
	const next = readRevision(db) + 1;
	metaSet(db, "prefs_revision", String(next));
	return next;
}

function ensureSchema(db) {
	db.exec(SCHEMA_SQL);
	const existing = metaGet(db, "schema_version");
	if (existing === null) {
		metaSet(db, "schema_version", String(STATE_DB_SCHEMA_VERSION));
	} else {
		const version = Number(existing);
		if (!Number.isInteger(version) || version < 1) throw new Error(`state.db schema_version 非法：${existing}`);
		if (version > STATE_DB_SCHEMA_VERSION) {
			throw new Error(`state.db schema 版本过新：${version}（当前支持 ${STATE_DB_SCHEMA_VERSION}）`);
		}
		// S1 只有 v1；后续版本在这里按顺序迁移。
	}
	if (metaGet(db, "prefs_revision") === null) metaSet(db, "prefs_revision", "0");
}

function resolveDefaultAgentDir(env = process.env) {
	const fromEnv = env?.PI_CODING_AGENT_DIR;
	return fromEnv ? resolve(fromEnv) : join(homedir(), ".pi", "agent");
}

/** 默认数据库路径；仅暴露路径计算，不创建文件。 */
export function stateDbPathFor(agentDir = resolveDefaultAgentDir()) {
	return join(resolve(agentDir), STATE_DB_DIRNAME, STATE_DB_FILENAME);
}

/** 运行时不可用时的稳定对象：调用方先看 capabilities.ok，再决定是否降级。 */
function unavailableState({ path, agentDir, chatDir, settingsPath, reason, log }) {
	const message = `状态库不可用：${reason}`;
	const fail = () => {
		const error = new Error(message);
		error.code = "state_db_unavailable";
		return error;
	};
	const migration = { skipped: true, reason, projects: 0, turns: 0, contexts: 0, errors: 0, skippedItems: 0 };
	log(`[state-db] ${message}`);
	return {
		ok: false,
		path,
		agentDir,
		chatDir,
		settingsPath,
		capabilities: { ok: false, path, reason: String(reason).slice(0, 500) },
		lastMigration: migration,
		getGlobalPrefs: () => {
			throw fail();
		},
		setGlobalPrefs: () => {
			throw fail();
		},
		getSessionUi: () => {
			throw fail();
		},
		setSessionUi: () => {
			throw fail();
		},
		getChatProject: () => {
			throw fail();
		},
		setChatProject: () => {
			throw fail();
		},
		readTurns: () => {
			throw fail();
		},
		upsertTurn: () => {
			throw fail();
		},
		readContext: () => {
			throw fail();
		},
		writeContext: () => {
			throw fail();
		},
		writeContextNext: () => {
			throw fail();
		},
		promoteContext: () => {
			throw fail();
		},
		migrateLegacy: () => migration,
		close: () => {},
	};
}

function listDirectories(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function legacySessionId(metaDir, sessionName) {
	for (const kind of CONTEXT_KINDS) {
		try {
			const parsed = JSON.parse(readFileSync(join(metaDir, `context.${kind}.json`), "utf8"));
			if (typeof parsed?.sessionId === "string" && parsed.sessionId) return parsed.sessionId;
		} catch {
			/* 继续找 */
		}
	}
	// 目录名是 chatSessionDirs 的 sanitizeSegment(sessionId)；context 缺失时以它为准。
	return sessionName || null;
}

/**
 * 创建/打开状态库。
 *
 * 失败不会抛出到调用方；返回 capabilities.ok=false 的稳定对象。
 * S2/S3 在接线时先检查 capabilities，再决定是否启用 prefs/chat 状态。
 *
 * @param {{
 *   agentDir?: string,
 *   stateDbPath?: string,
 *   chatDir?: string,
 *   settingsPath?: string,
 *   env?: Record<string,string|undefined>,
 *   now?: () => string,
 *   log?: (message:string)=>void,
 * }} [options]
 */
export function openStateDb(options = {}) {
	const env = options.env ?? process.env;
	const agentDir = resolve(options.agentDir ?? resolveDefaultAgentDir(env));
	const path = options.stateDbPath === ":memory:" ? ":memory:" : resolve(options.stateDbPath ?? stateDbPathFor(agentDir));
	const chatDir = resolve(options.chatDir ?? join(agentDir, STATE_DB_DIRNAME, "chats"));
	const settingsPath = resolve(options.settingsPath ?? join(chatDir, "settings.json"));
	const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
	const log = typeof options.log === "function" ? options.log : () => {};
	let db = null;

	try {
		if (path !== ":memory:") {
			const parent = dirname(path);
			mkdirSync(parent, { recursive: true, mode: 0o700 });
			try {
				chmodSync(parent, 0o700);
			} catch {
				/* Windows / 非 POSIX 文件系统不强制 */
			}
		}
		db = new DatabaseSync(path);
		if (path !== ":memory:") {
			try {
				chmodSync(path, 0o600);
			} catch {
				/* 权限不可设时仍可工作，测试只在 POSIX 断言 */
			}
		}
		db.exec(`PRAGMA busy_timeout = ${STATE_DB_BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON;`);
		db.exec("PRAGMA journal_mode = WAL;");
		const journalMode = String(db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "").toLowerCase();
		ensureSchema(db);

		const state = createStateApi({ db, path, agentDir, chatDir, settingsPath, now, log });
		const lastMigration = state.migrateLegacy();
		const capabilities = {
			ok: true,
			path,
			schemaVersion: STATE_DB_SCHEMA_VERSION,
			journalMode,
			busyTimeoutMs: STATE_DB_BUSY_TIMEOUT_MS,
			agentDir,
			chatDir,
		};
		return {
			ok: true,
			path,
			agentDir,
			chatDir,
			settingsPath,
			capabilities,
			lastMigration,
			...state,
		};
	} catch (err) {
		try {
			db?.close();
		} catch {
			/* 已关闭/未建立 */
		}
		return unavailableState({
			path,
			agentDir,
			chatDir,
			settingsPath,
			reason: err?.message ?? String(err),
			log,
		});
	}
}

function createStateApi({ db, path, agentDir, chatDir, settingsPath, now, log }) {
	let closed = false;

	function assertOpen() {
		if (closed) {
			const error = new Error("state.db 已关闭");
			error.code = "state_db_closed";
			throw error;
		}
	}

	function transaction(fn) {
		assertOpen();
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			db.exec("COMMIT");
			return result;
		} catch (err) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* 保留原始错误 */
			}
			throw err;
		}
	}

	function getGlobalPrefs() {
		assertOpen();
		const global = {};
		for (const row of db.prepare("SELECT key, value_json FROM ui_pref ORDER BY key").all()) {
			global[row.key] = parseJson(row.value_json, null);
		}
		return { revision: readRevision(db), global };
	}

	function setGlobalPrefs(patch) {
		assertOpen();
		if (!isPlainObject(patch)) throw new TypeError("prefs patch 需为对象");
		const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
		for (const [key] of entries) {
			if (!GLOBAL_PREF_KEYS.includes(key)) throw new TypeError(`未知的全局偏好：${key}`);
		}
		if (!entries.length) return getGlobalPrefs();
		const encoded = entries.map(([key, value]) => [key, jsonText(value, `偏好 ${key}`)]);
		const timestamp = currentIso(now);
		return transaction(() => {
			const stmt = db.prepare(
				"INSERT INTO ui_pref (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
			);
			for (const [key, valueJson] of encoded) stmt.run(key, valueJson, timestamp);
			bumpRevision(db);
			return getGlobalPrefs();
		});
	}

	function getSessionUi(source, sessionId) {
		assertOpen();
		const src = normalizeSource(source);
		const sid = normalizeSessionId(sessionId);
		const row = db.prepare("SELECT * FROM session_ui WHERE source = ? AND session_id = ?").get(src, sid);
		if (!row) {
			return { threadId: null, threadNew: false, mode: "independent", contextIds: [], updatedAt: null };
		}
		return {
			threadId: row.thread_id ?? null,
			threadNew: row.thread_new === 1,
			mode: SESSION_MODES.includes(row.chat_mode) ? row.chat_mode : "independent",
			contextIds: Array.isArray(parseJson(row.context_ids_json, [])) ? parseJson(row.context_ids_json, []) : [],
			updatedAt: row.updated_at ?? null,
		};
	}

	function setSessionUi(source, sessionId, patch) {
		assertOpen();
		const src = normalizeSource(source);
		const sid = normalizeSessionId(sessionId);
		if (!isPlainObject(patch)) throw new TypeError("session UI patch 需为对象");
		const allowed = ["threadId", "threadNew", "mode", "contextIds"];
		for (const key of Object.keys(patch)) {
			if (!allowed.includes(key)) throw new TypeError(`未知的 session UI 字段：${key}`);
		}
		const current = getSessionUi(src, sid);
		const next = { ...current };
		if (Object.prototype.hasOwnProperty.call(patch, "threadId")) next.threadId = normalizeThreadId(patch.threadId);
		if (Object.prototype.hasOwnProperty.call(patch, "threadNew")) {
			if (typeof patch.threadNew !== "boolean") throw new TypeError("threadNew 需为布尔值");
			next.threadNew = patch.threadNew;
		}
		if (Object.prototype.hasOwnProperty.call(patch, "mode")) next.mode = normalizeMode(patch.mode);
		if (Object.prototype.hasOwnProperty.call(patch, "contextIds")) next.contextIds = normalizeContextIds(patch.contextIds);
		const timestamp = currentIso(now);
		transaction(() => {
			db.prepare(
				`INSERT INTO session_ui
					(source, session_id, thread_id, thread_new, chat_mode, context_ids_json, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(source, session_id) DO UPDATE SET
						thread_id = excluded.thread_id,
						thread_new = excluded.thread_new,
						chat_mode = excluded.chat_mode,
						context_ids_json = excluded.context_ids_json,
						updated_at = excluded.updated_at`,
			).run(
				src,
				sid,
				next.threadId,
				next.threadNew ? 1 : 0,
				next.mode,
				JSON.stringify(next.contextIds),
				timestamp,
			);
		});
		return { ...next, updatedAt: timestamp };
	}

	function getChatProject(source, projectPath) {
		assertOpen();
		const src = normalizeSource(source);
		const project = normalizeProjectPath(projectPath);
		const row = db.prepare("SELECT * FROM chat_project WHERE source = ? AND project_path = ?").get(src, project);
		if (!row) return { profile: DEFAULT_PROFILE, projectSkills: false, updatedAt: null };
		return {
			profile: normalizeProfile(row.profile),
			projectSkills: row.project_skills === 1,
			updatedAt: row.updated_at ?? null,
		};
	}

	function setChatProject(source, projectPath, patch) {
		assertOpen();
		const src = normalizeSource(source);
		const project = normalizeProjectPath(projectPath);
		if (!isPlainObject(patch)) throw new TypeError("chat project patch 需为对象");
		const allowed = ["profile", "projectSkills"];
		for (const key of Object.keys(patch)) {
			if (!allowed.includes(key)) throw new TypeError(`未知的 chat project 字段：${key}`);
		}
		const current = getChatProject(src, project);
		const next = { ...current };
		if (Object.prototype.hasOwnProperty.call(patch, "profile")) next.profile = normalizeProfile(patch.profile);
		if (Object.prototype.hasOwnProperty.call(patch, "projectSkills")) {
			if (typeof patch.projectSkills !== "boolean") throw new TypeError("projectSkills 需为布尔值");
			next.projectSkills = patch.projectSkills;
		}
		const timestamp = currentIso(now);
		transaction(() => {
			db.prepare(
				`INSERT INTO chat_project (source, project_path, profile, project_skills, updated_at)
					VALUES (?, ?, ?, ?, ?)
					ON CONFLICT(source, project_path) DO UPDATE SET
						profile = excluded.profile,
						project_skills = excluded.project_skills,
						updated_at = excluded.updated_at`,
			).run(src, project, next.profile, next.projectSkills ? 1 : 0, timestamp);
		});
		return { ...next, updatedAt: timestamp };
	}

	function normalizeTurnRecord(record) {
		if (!isPlainObject(record)) throw new TypeError("turn 需为对象");
		const threadId = typeof record.threadId === "string" ? record.threadId : "";
		if (!threadId) throw new TypeError("turn 缺少 threadId");
		const ordinal = Number(record.ordinal);
		if (!Number.isInteger(ordinal)) throw new TypeError("turn ordinal 需为整数");
		const payload = { ...record, threadId, ordinal };
		return { threadId, ordinal, payloadJson: jsonText(payload, "turn payload") };
	}

	function readTurns(source, sessionId, threadId) {
		assertOpen();
		const src = normalizeSource(source);
		const sid = normalizeSessionId(sessionId);
		const filterThread = threadId !== undefined && threadId !== null;
		const params = [src, sid];
		let sql = "SELECT thread_id, ordinal, payload_json FROM chat_turn WHERE source = ? AND session_id = ?";
		if (filterThread) {
			sql += " AND thread_id = ?";
			params.push(String(threadId));
		}
		sql += " ORDER BY ordinal ASC, thread_id ASC";
		const turns = [];
		for (const row of db.prepare(sql).all(...params)) {
			const parsed = parseJson(row.payload_json, null);
			if (!isPlainObject(parsed)) continue;
			turns.push({ ...parsed, threadId: row.thread_id, ordinal: Number(row.ordinal) });
		}
		return turns;
	}

	function upsertTurn(source, sessionId, record) {
		assertOpen();
		const src = normalizeSource(source);
		const sid = normalizeSessionId(sessionId);
		const normalized = normalizeTurnRecord(record);
		const timestamp = currentIso(now);
		transaction(() => {
			db.prepare(
				`INSERT INTO chat_turn (source, session_id, thread_id, ordinal, payload_json, updated_at)
					VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT(source, session_id, thread_id, ordinal) DO UPDATE SET
						payload_json = excluded.payload_json,
						updated_at = excluded.updated_at`,
			).run(src, sid, normalized.threadId, normalized.ordinal, normalized.payloadJson, timestamp);
		});
		return { ...parseJson(normalized.payloadJson, {}), updatedAt: timestamp };
	}

	function readContext(source, sessionId, kind = "active") {
		assertOpen();
		const src = normalizeSource(source);
		const sid = normalizeSessionId(sessionId);
		const contextKind = normalizeKind(kind);
		const row = db.prepare("SELECT payload_json FROM chat_context WHERE source = ? AND session_id = ? AND kind = ?").get(
			src,
			sid,
			contextKind,
		);
		if (!row) return { items: [] };
		const parsed = parseJson(row.payload_json, null);
		return isPlainObject(parsed) && Array.isArray(parsed.items) ? parsed : { items: [] };
	}

	function writeContext(source, sessionId, kind, snapshot) {
		assertOpen();
		const src = normalizeSource(source);
		const sid = normalizeSessionId(sessionId);
		const contextKind = normalizeKind(kind);
		if (!isPlainObject(snapshot) || !Array.isArray(snapshot.items)) {
			throw new TypeError("context snapshot 需为对象且包含 items 数组");
		}
		const payloadJson = jsonText(snapshot, "context snapshot");
		const timestamp = currentIso(now);
		transaction(() => {
			db.prepare(
				`INSERT INTO chat_context (source, session_id, kind, payload_json, updated_at)
					VALUES (?, ?, ?, ?, ?)
					ON CONFLICT(source, session_id, kind) DO UPDATE SET
						payload_json = excluded.payload_json,
						updated_at = excluded.updated_at`,
			).run(src, sid, contextKind, payloadJson, timestamp);
		});
		return snapshot;
	}

	function writeContextNext(source, sessionId, snapshot) {
		return writeContext(source, sessionId, "next", snapshot);
	}

	function promoteContext(source, sessionId) {
		assertOpen();
		const src = normalizeSource(source);
		const sid = normalizeSessionId(sessionId);
		return transaction(() => {
			const row = db.prepare("SELECT payload_json FROM chat_context WHERE source = ? AND session_id = ? AND kind = 'next'").get(
				src,
				sid,
			);
			if (!row) return readContext(src, sid, "active");
			const parsed = parseJson(row.payload_json, null);
			if (isPlainObject(parsed) && Array.isArray(parsed.items)) {
				const timestamp = currentIso(now);
				db.prepare(
					`INSERT INTO chat_context (source, session_id, kind, payload_json, updated_at)
						VALUES (?, ?, 'active', ?, ?)
						ON CONFLICT(source, session_id, kind) DO UPDATE SET
							payload_json = excluded.payload_json,
							updated_at = excluded.updated_at`,
				).run(src, sid, row.payload_json, timestamp);
			}
			db.prepare("DELETE FROM chat_context WHERE source = ? AND session_id = ? AND kind = 'next'").run(src, sid);
			return readContext(src, sid, "active");
		});
	}

	function upsertChatProjectRow(source, projectPath, profile, projectSkills, timestamp) {
		db.prepare(
			`INSERT INTO chat_project (source, project_path, profile, project_skills, updated_at)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(source, project_path) DO UPDATE SET
					profile = excluded.profile,
					project_skills = excluded.project_skills,
					updated_at = excluded.updated_at`,
		).run(source, projectPath, normalizeProfile(profile), projectSkills ? 1 : 0, timestamp);
	}

	function importLegacySettings(stats, timestamp) {
		if (!existsSync(settingsPath)) return;
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
		} catch (err) {
			stats.errors++;
			log(`[state-db] settings 迁移跳过：${err.message}`);
			return;
		}
		if (!isPlainObject(parsed?.projects)) {
			stats.errors++;
			log("[state-db] settings 迁移跳过：projects 结构不符");
			return;
		}
		for (const [key, value] of Object.entries(parsed.projects)) {
			if (!isPlainObject(value)) {
				stats.skippedItems++;
				continue;
			}
			const separator = key.indexOf(":");
			const source = separator >= 0 ? key.slice(0, separator) || "pi" : "pi";
			const projectPath = separator >= 0 ? key.slice(separator + 1) : key;
			try {
				upsertChatProjectRow(source, normalizeProjectPath(projectPath), value.profile, value.projectSkills === true, timestamp);
				stats.projects++;
			} catch (err) {
				stats.skippedItems++;
				log(`[state-db] 项目设置迁移跳过：${err.message}`);
			}
		}
	}

	function importLegacyTurns(metaDir, source, sessionId, stats, timestamp) {
		const file = join(metaDir, "turns.jsonl");
		if (!existsSync(file)) return;
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch (err) {
			stats.errors++;
			log(`[state-db] turns 迁移跳过：${err.message}`);
			return;
		}
		const stmt = db.prepare(
			`INSERT INTO chat_turn (source, session_id, thread_id, ordinal, payload_json, updated_at)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(source, session_id, thread_id, ordinal) DO UPDATE SET
					payload_json = excluded.payload_json,
					updated_at = excluded.updated_at`,
		);
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				stats.skippedItems++;
				continue;
			}
			if (!isPlainObject(record)) {
				stats.skippedItems++;
				continue;
			}
			try {
				const normalized = normalizeTurnRecord(record);
				stmt.run(source, sessionId, normalized.threadId, normalized.ordinal, normalized.payloadJson, timestamp);
				stats.turns++;
			} catch {
				// 旧的无 threadId 记录 / 坏 ordinal：保持与旧 readTurns 一致，不参与映射。
				stats.skippedItems++;
			}
		}
	}

	function importLegacyContext(metaDir, source, sessionId, stats, timestamp) {
		const stmt = db.prepare(
			`INSERT INTO chat_context (source, session_id, kind, payload_json, updated_at)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(source, session_id, kind) DO UPDATE SET
					payload_json = excluded.payload_json,
					updated_at = excluded.updated_at`,
		);
		for (const kind of CONTEXT_KINDS) {
			const file = join(metaDir, `context.${kind}.json`);
			if (!existsSync(file)) continue;
			let parsed;
			try {
				parsed = JSON.parse(readFileSync(file, "utf8"));
			} catch (err) {
				stats.errors++;
				log(`[state-db] context 迁移跳过：${err.message}`);
				continue;
			}
			if (!isPlainObject(parsed) || !Array.isArray(parsed.items)) {
				stats.skippedItems++;
				continue;
			}
			stmt.run(source, sessionId, kind, JSON.stringify(parsed), timestamp);
			stats.contexts++;
		}
	}

	function importLegacyChatDirs(stats, timestamp) {
		if (!existsSync(chatDir)) return;
		for (const sourceName of listDirectories(chatDir)) {
			const sourceDir = join(chatDir, sourceName);
			for (const sessionName of listDirectories(sourceDir)) {
				const metaDir = join(sourceDir, sessionName, "meta");
				const hasTurns = existsSync(join(metaDir, "turns.jsonl"));
				const hasContext = CONTEXT_KINDS.some((kind) => existsSync(join(metaDir, `context.${kind}.json`)));
				if (!hasTurns && !hasContext) continue;
				const sessionId = legacySessionId(metaDir, sessionName);
				if (!sessionId) {
					stats.skippedItems++;
					continue;
				}
				importLegacyTurns(metaDir, sourceName, sessionId, stats, timestamp);
				importLegacyContext(metaDir, sourceName, sessionId, stats, timestamp);
			}
		}
	}

	function migrateLegacy() {
		assertOpen();
		if (metaGet(db, "legacy_imported") === "1") {
			return { skipped: true, reason: "already_imported", projects: 0, turns: 0, contexts: 0, errors: 0, skippedItems: 0 };
		}
		return transaction(() => {
			if (metaGet(db, "legacy_imported") === "1") {
				return { skipped: true, reason: "already_imported", projects: 0, turns: 0, contexts: 0, errors: 0, skippedItems: 0 };
			}
			const stats = { skipped: false, projects: 0, turns: 0, contexts: 0, errors: 0, skippedItems: 0 };
			const timestamp = currentIso(now);
			importLegacySettings(stats, timestamp);
			importLegacyChatDirs(stats, timestamp);
			metaSet(db, "legacy_imported", "1");
			return stats;
		});
	}

	function close() {
		if (closed) return;
		closed = true;
		try {
			db.close();
		} catch (err) {
			log(`[state-db] 关闭失败：${err.message}`);
		}
	}

	return {
		path,
		agentDir,
		chatDir,
		settingsPath,
		getGlobalPrefs,
		setGlobalPrefs,
		getSessionUi,
		setSessionUi,
		getChatProject,
		setChatProject,
		readTurns,
		upsertTurn,
		readContext,
		writeContext,
		writeContextNext,
		promoteContext,
		migrateLegacy,
		close,
	};
}
