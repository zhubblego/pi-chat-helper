/**
 * 模型列表纯函数：只按 models.json.providers 的键过滤，并保证当前模型可见。
 *
 * pi 的 get_available_models 会返回「有凭据的 provider」的完整目录，
 * 与用户显式写进 models.json 的 provider 集合不是同一语义。这里以显式配置为准。
 */

/** providers 为空/非法时回退全量，避免配置缺失把模型菜单变成空列表。 */
function fallbackAll(list) {
	return Array.isArray(list) ? list.slice() : [];
}

function isProviderMap(providers) {
	return Boolean(providers) && typeof providers === "object" && !Array.isArray(providers);
}

function modelNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : null;
}

/** 同一个 provider + id 只保留第一次出现，避免目录重复项挤进菜单。 */
function dedupeModels(list) {
	const seen = new Set();
	const result = [];
	for (const model of list) {
		if (!model || typeof model !== "object") continue;
		const key = `${model.provider ?? ""}\u0000${model.id ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(model);
	}
	return result;
}

/**
 * @param {Array<object>} models get_available_models 的已脱敏列表（全量）
 * @param {object} providers models.json 的 providers 对象
 * @returns {Array<object>} 只保留 provider 键精确命中的模型；空 providers 回退全量
 */
export function filterConfiguredModels(models, providers) {
	const list = fallbackAll(models);
	if (!isProviderMap(providers) || Object.keys(providers).length === 0) return fallbackAll(list);
	return dedupeModels(list.filter((model) => Object.prototype.hasOwnProperty.call(providers, model.provider)));
}

/**
 * 当前模型不在过滤结果里时补到首位；已在列表里则不动。
 * @param {Array<object>} models 已过滤的模型列表（列表项形状）
 * @param {object|null} current 当前模型（可带 providerName；缺字段用 id 兜底）
 */
export function ensureCurrentModelFirst(models, current) {
	const list = Array.isArray(models) ? models.slice() : [];
	if (!current || typeof current.provider !== "string" || !current.provider || typeof current.id !== "string" || !current.id) {
		return list;
	}
	if (list.some((model) => model && model.provider === current.provider && model.id === current.id)) return list;
	return [
		{
			provider: current.provider,
			providerName:
				typeof current.providerName === "string" && current.providerName ? current.providerName : current.provider,
			id: current.id,
			name: typeof current.name === "string" && current.name ? current.name : current.id,
			reasoning: current.reasoning === true,
			contextWindow: modelNumber(current.contextWindow),
			maxTokens: modelNumber(current.maxTokens),
		},
		...list,
	];
}
