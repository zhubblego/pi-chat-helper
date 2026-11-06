/**
 * chat-pool.mjs — 对话子进程池的纯函数与默认参数。
 *
 * 只处理「谁该被回收」和「是否空闲过期」，不碰进程、文件或 HTTP。
 */

/** 全局 child 上限。 */
export const MAX_CHILDREN = 2;
/** 空闲多久后回收（15 分钟）。 */
export const IDLE_TTL_MS = 15 * 60_000;
/** 空闲扫描间隔（60 秒）。 */
export const SWEEP_MS = 60_000;

/**
 * 从记录里选最久未用的 idle child；排除当前 key、活动 turn、非 idle。
 * @param {Iterable<object>} records
 * @param {string} currentKey
 * @returns {object|null}
 */
export function selectLruIdle(records, currentKey) {
	let victim = null;
	for (const record of records) {
		if (!record || record.key === currentKey) continue;
		if (record.state !== "idle" || record.currentTurn) continue;
		if (!victim || (record.lastUsedAt ?? 0) < (victim.lastUsedAt ?? 0)) victim = record;
	}
	return victim;
}

/**
 * 是否已超过空闲 TTL。
 * @param {object} record
 * @param {number} now
 * @param {number} ttlMs
 */
export function isIdleExpired(record, now, ttlMs) {
	if (!record || record.state !== "idle" || record.currentTurn) return false;
	return now - (record.lastUsedAt ?? 0) > ttlMs;
}
