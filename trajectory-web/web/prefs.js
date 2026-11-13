/**
 * prefs.js — 全局 UI 偏好的纯函数与旧 localStorage 迁移读取。
 *
 * S2 起服务端 `state.db` 是唯一真源；本文件只负责：
 *   - 把旧 `tw.*` 全局键规范化成 `/api/prefs` 的 canonical patch；
 *   - 把服务端返回的 global 对象裁剪到已知字段；
 *   - 迁移成功后清理旧键。
 *
 * 不包含 DOM/网络逻辑；app.js 负责 fetch 与状态应用。
 */

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

/** 旧 localStorage 键 -> canonical key；会话级 chatCtx/thread/mode 不在这里（S3 迁移）。 */
export const LEGACY_GLOBAL_KEYS = Object.freeze({
	filters: "tw.filters",
	tools: "tw.tools",
	theme: "tw.theme",
	translate: "tw.translate",
	chatOpen: "tw.chat",
	chatWidth: "tw.chatWidth",
	composerHeight: "tw.composerHeight",
});

export const THEME_VALUES = Object.freeze(["system", "light", "dark"]);
export const PERSPECTIVE_PREF_VALUES = Object.freeze(["all", "model"]);

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseObject(raw) {
	if (typeof raw !== "string" || !raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return isPlainObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** 工具排除集规范化；损坏值回退为空。 */
export function normalizeToolsPrefs(value) {
	if (!isPlainObject(value)) return { excluded: [], excludeAll: false };
	const excluded = Array.isArray(value.excluded)
		? [...new Set(value.excluded.filter((name) => typeof name === "string" && name))]
		: [];
	return { excluded, excludeAll: value.excludeAll === true };
}

/** 过滤值：保留未知类型键，但工具开关强制开启（工具改走子菜单）。 */
export function normalizeFiltersPrefs(value) {
	return { ...(isPlainObject(value) ? value : {}), tools: true };
}

/**
 * 服务端 global 对象裁剪：只输出已知字段，坏类型丢弃。
 * 不填充默认值；调用方与本地默认合并。
 */
export function normalizeGlobalPrefs(value) {
	if (!isPlainObject(value)) return {};
	const out = {};
	if (Object.prototype.hasOwnProperty.call(value, "filters")) out.filters = normalizeFiltersPrefs(value.filters);
	if (Object.prototype.hasOwnProperty.call(value, "tools")) out.tools = normalizeToolsPrefs(value.tools);
	if (THEME_VALUES.includes(value.theme)) out.theme = value.theme;
	if (PERSPECTIVE_PREF_VALUES.includes(value.perspective)) out.perspective = value.perspective;
	if (isPlainObject(value.translate)) out.translate = { ...value.translate };
	if (typeof value.chatOpen === "boolean") out.chatOpen = value.chatOpen;
	for (const key of ["chatWidth", "composerHeight"]) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
		const number = Number(value[key]);
		if (Number.isFinite(number) && number >= 0) out[key] = Math.round(number);
	}
	return out;
}

function storageOf(storage) {
	if (storage !== undefined) return storage;
	try {
		return globalThis.localStorage;
	} catch {
		return null;
	}
}

/**
 * 读取旧全局键，返回可直接 POST `/api/prefs` 的 patch。
 * 只读；不清理。值损坏的键跳过。
 */
export function readLegacyGlobalPrefs(storage) {
	const store = storageOf(storage);
	const out = {};
	if (!store) return out;
	const read = (key) => {
		try {
			return store.getItem(key);
		} catch {
			return null;
		}
	};
	for (const [key, legacyKey] of Object.entries(LEGACY_GLOBAL_KEYS)) {
		const raw = read(legacyKey);
		if (raw === null || raw === undefined) continue;
		if (key === "filters") {
			const parsed = parseObject(raw);
			if (parsed) out.filters = normalizeFiltersPrefs(parsed);
		} else if (key === "tools") {
			const parsed = parseObject(raw);
			if (parsed) out.tools = normalizeToolsPrefs(parsed);
		} else if (key === "theme") {
			if (THEME_VALUES.includes(raw)) out.theme = raw;
		} else if (key === "translate") {
			const parsed = parseObject(raw);
			if (parsed) out.translate = parsed;
		} else if (key === "chatOpen") {
			if (raw === "1" || raw === "true") out.chatOpen = true;
			else if (raw === "0" || raw === "false") out.chatOpen = false;
		} else if (key === "chatWidth" || key === "composerHeight") {
			const number = Number(raw);
			if (Number.isFinite(number) && number > 0) out[key] = Math.round(number);
		}
	}
	return out;
}

/** 迁移成功后清理旧全局键；失败静默，旧值不影响服务端真源。 */
export function clearLegacyGlobalPrefs(storage) {
	const store = storageOf(storage);
	if (!store) return;
	for (const legacyKey of Object.values(LEGACY_GLOBAL_KEYS)) {
		try {
			store.removeItem(legacyKey);
		} catch {
			/* 无痕模式等场景忽略 */
		}
	}
}
