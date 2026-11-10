/**
 * session-prefs.js — 每个 `source:session` 的会话级 UI 状态。
 *
 * S3 起服务端 `session_ui` 是唯一真源：
 *   threadId / threadNew / mode / contextIds
 *
 * 本文件负责：
 *   - 按会话懒加载 `/api/prefs/session`；
 *   - 内存缓存 + 防抖局部 POST；
 *   - 旧 tw.chatThread / tw.chatThreadNew / tw.chatMode / tw.chatCtx 的一次性迁移。
 *
 * 不做 DOM 渲染；app.js 与 chat.js 共用同一个缓存。
 */

export const SESSION_PREF_DEFAULTS = Object.freeze({
	threadId: null,
	threadNew: false,
	mode: "independent",
	contextIds: [],
});

export const LEGACY_SESSION_KEYS = Object.freeze({
	thread: "tw.chatThread",
	threadNew: "tw.chatThreadNew",
	mode: "tw.chatMode",
	context: "tw.chatCtx",
});

const SESSION_MODES = new Set(["independent", "forward"]);
const MAX_CONTEXT_IDS = 5_000;
const SAVE_MS = 60;
const API = "/api/prefs/session";

const cache = new Map();
const inflight = new Map();
const pending = new Map();
const timers = new Map();

export function sessionPrefsKey(source, sessionId) {
	return `${source}:${sessionId}`;
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaults() {
	return { ...SESSION_PREF_DEFAULTS, contextIds: [] };
}

/** 只保留已知字段；contextIds 去重、字符串、上限与 state-db 一致。 */
export function normalizeSessionPrefs(value) {
	if (!isPlainObject(value)) return {};
	const out = {};
	if (Object.prototype.hasOwnProperty.call(value, "threadId")) {
		if (value.threadId === null || typeof value.threadId === "string") out.threadId = value.threadId || null;
	}
	if (typeof value.threadNew === "boolean") out.threadNew = value.threadNew;
	if (SESSION_MODES.has(value.mode)) out.mode = value.mode;
	if (Array.isArray(value.contextIds)) {
		const ids = [];
		const seen = new Set();
		for (const id of value.contextIds) {
			if (typeof id !== "string" || !id || seen.has(id)) continue;
			seen.add(id);
			ids.push(id);
			if (ids.length > MAX_CONTEXT_IDS) break;
		}
		out.contextIds = ids;
	}
	if (typeof value.updatedAt === "string") out.updatedAt = value.updatedAt;
	return out;
}

function publicPrefs(entry) {
	if (!entry) return defaults();
	const { loaded: _loaded, dirty: _dirty, available: _available, ...prefs } = entry;
	return { ...defaults(), ...prefs };
}

function parseKey(key) {
	const index = key.indexOf(":");
	return index < 0 ? { source: key, sessionId: "" } : { source: key.slice(0, index), sessionId: key.slice(index + 1) };
}

function storageOf(storage) {
	if (storage !== undefined) return storage;
	try {
		return globalThis.localStorage;
	} catch {
		return null;
	}
}

function readMap(store, key) {
	if (!store) return null;
	try {
		const raw = store.getItem(key);
		const parsed = raw ? JSON.parse(raw) : null;
		return isPlainObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** 读取旧会话 map 中当前 key 的值；只读。 */
export function readLegacySessionPrefs(key, storage) {
	const store = storageOf(storage);
	const out = {};
	if (!store) return out;
	const threadMap = readMap(store, LEGACY_SESSION_KEYS.thread);
	const newMap = readMap(store, LEGACY_SESSION_KEYS.threadNew);
	const modeMap = readMap(store, LEGACY_SESSION_KEYS.mode);
	const contextMap = readMap(store, LEGACY_SESSION_KEYS.context);
	if (typeof threadMap?.[key] === "string" && threadMap[key]) out.threadId = threadMap[key];
	if (newMap && key in newMap) {
		out.threadNew = true;
		if (!out.threadId && typeof newMap[key] === "string" && newMap[key]) out.threadId = newMap[key];
	}
	if (SESSION_MODES.has(modeMap?.[key])) out.mode = modeMap[key];
	if (Array.isArray(contextMap?.[key])) {
		const normalized = normalizeSessionPrefs({ contextIds: contextMap[key] });
		if (normalized.contextIds?.length) out.contextIds = normalized.contextIds;
	}
	return out;
}

/** 迁移成功后只删除当前 key，保留其它会话的旧 map。 */
export function clearLegacySessionPrefs(key, storage) {
	const store = storageOf(storage);
	if (!store) return;
	for (const legacyKey of Object.values(LEGACY_SESSION_KEYS)) {
		const map = readMap(store, legacyKey);
		if (!map || !(key in map)) continue;
		delete map[key];
		try {
			if (Object.keys(map).length) store.setItem(legacyKey, JSON.stringify(map));
			else store.removeItem(legacyKey);
		} catch {
			/* 无痕模式等场景忽略 */
		}
	}
}

/** 同步读缓存；未加载时返回默认值（chat 首次绘制用）。 */
export function getSessionPrefs(source, sessionId) {
	const key = sessionPrefsKey(source, sessionId);
	return publicPrefs(cache.get(key));
}

async function postSessionPrefs(source, sessionId, patch, keepalive = false) {
	const res = await fetch(API, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source, session: sessionId, ...patch }),
		keepalive,
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return normalizeSessionPrefs(await res.json());
}

/**
 * 懒加载一个会话的 session_ui；服务端无行时尝试把旧 localStorage 一次性导入。
 * API 不可用时回退旧 localStorage（不清理），保证页面仍可读。
 */
export async function loadSessionPrefs(source, sessionId) {
	const key = sessionPrefsKey(source, sessionId);
	if (cache.has(key) && cache.get(key).loaded) return getSessionPrefs(source, sessionId);
	if (inflight.has(key)) return inflight.get(key);
	const promise = (async () => {
		let remote = null;
		let available = false;
		try {
			const res = await fetch(`${API}?source=${encodeURIComponent(source)}&session=${encodeURIComponent(sessionId)}`);
			if (res.ok) {
				remote = normalizeSessionPrefs(await res.json());
				available = true;
			}
		} catch {
			available = false;
		}

		const existing = cache.get(key);
		if (existing?.loaded && existing.dirty) return publicPrefs(existing);

		// 本地在加载完成前已有修改：以服务端为底、只覆盖真正 patch 过的字段，避免默认 null 冲掉服务端 thread。
		if (existing?.dirty && !existing.loaded) {
			const base = available
				? { ...defaults(), ...(remote ?? {}) }
				: { ...defaults(), ...readLegacySessionPrefs(key) };
			const merged = { ...base, ...(pending.get(key) ?? {}) };
			cache.set(key, { ...merged, loaded: true, dirty: true, available });
			return publicPrefs(cache.get(key));
		}

		// 服务端已有行（updatedAt 非空）：旧 localStorage 一律忽略。
		if (available && remote?.updatedAt) {
			cache.set(key, { ...remote, loaded: true, dirty: false, available });
			return publicPrefs(cache.get(key));
		}

		const legacy = readLegacySessionPrefs(key);
		if (available && Object.keys(legacy).length) {
			try {
				const saved = await postSessionPrefs(source, sessionId, legacy);
				cache.set(key, { ...saved, loaded: true, dirty: false, available });
				clearLegacySessionPrefs(key);
				return publicPrefs(cache.get(key));
			} catch {
				// 导入失败：用旧值服务当前页面，服务端仍为空，下次加载可再试。
			}
		}

		const value = available ? { ...defaults(), ...(remote ?? {}), ...legacy } : { ...defaults(), ...legacy };
		cache.set(key, { ...value, loaded: true, dirty: false, available });
		return publicPrefs(cache.get(key));
	})();
	inflight.set(key, promise);
	try {
		return await promise;
	} finally {
		inflight.delete(key);
	}
}

async function flushKey(key, keepalive = false) {
	if (timers.has(key)) {
		clearTimeout(timers.get(key));
		timers.delete(key);
	}
	const patch = pending.get(key);
	pending.delete(key);
	if (!patch || Object.keys(patch).length === 0) return;
	const { source, sessionId } = parseKey(key);
	try {
		await postSessionPrefs(source, sessionId, patch, keepalive);
		const entry = cache.get(key);
		if (entry) entry.dirty = pending.has(key);
	} catch {
		pending.set(key, { ...patch, ...(pending.get(key) ?? {}) });
		const entry = cache.get(key);
		if (entry) entry.dirty = true;
	}
}

/** 局部更新内存缓存并防抖 POST；服务端不可用时仅当前页面生效。 */
export function updateSessionPrefs(source, sessionId, patch) {
	const key = sessionPrefsKey(source, sessionId);
	const existing = cache.get(key);
	const current = getSessionPrefs(source, sessionId);
	const normalized = normalizeSessionPrefs({ ...current, ...patch });
	cache.set(key, { ...normalized, loaded: existing?.loaded === true, dirty: true });
	pending.set(key, { ...(pending.get(key) ?? {}), ...patch });
	if (timers.has(key)) clearTimeout(timers.get(key));
	timers.set(
		key,
		setTimeout(() => {
			timers.delete(key);
			void flushKey(key);
		}, SAVE_MS),
	);
	return normalized;
}

/** 页面关闭时把防抖窗口内的 patch 带出去。 */
export async function flushSessionPrefs(keepalive = false) {
	await Promise.all([...pending.keys()].map((key) => flushKey(key, keepalive)));
}

if (typeof window !== "undefined") {
	window.addEventListener("pagehide", () => {
		if (pending.size) void flushSessionPrefs(true);
	});
}
