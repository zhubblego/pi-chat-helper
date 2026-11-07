/**
 * 模型列表纯函数：按 models.json.providers ∪ auth.json 有效条目的 provider 过滤，
 * 并保证当前模型可见。
 *
 * pi 的 get_available_models 会返回「有凭据的 provider」的完整目录；
 * 环境变量凭据（如 ANTHROPIC_AUTH_TOKEN）不算显式配置，这里不纳入候选。
 */

/** 复制全量列表；是否回退全量由服务端根据配置可用性判断。 */
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

function nonEmpty(value) {
	if (typeof value === "string") return value.trim().length > 0;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.some(nonEmpty);
	if (value && typeof value === "object") return Object.values(value).some(nonEmpty);
	return false;
}

/** auth.json 条目：至少有一个非 type 的非空值；只有 type / key 为空的残条不算。 */
function hasAuthValue(entry) {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return nonEmpty(entry);
	return Object.entries(entry).some(([key, value]) => key !== "type" && nonEmpty(value));
}

/**
 * 显式配置集 = models.json.providers 的键 ∪ auth.json 顶层有效条目。
 * @param {object|null} modelsJson
 * @param {object|null} authJson
 * @returns {Set<string>}
 */
export function configuredProviders(modelsJson, authJson) {
	const set = new Set();
	const providers = modelsJson && typeof modelsJson === "object" && !Array.isArray(modelsJson) ? modelsJson.providers : null;
	if (isProviderMap(providers)) {
		for (const provider of Object.keys(providers)) set.add(provider);
	}
	if (authJson && typeof authJson === "object" && !Array.isArray(authJson)) {
		for (const [provider, entry] of Object.entries(authJson)) {
			if (hasAuthValue(entry)) set.add(provider);
		}
	}
	return set;
}

/**
 * @param {Array<object>} models get_available_models 的已脱敏列表（全量）
 * @param {Set<string>|object} providers 显式配置 provider 集合（也兼容 providers 对象）
 * @returns {Array<object>} 只保留 provider 精确命中的模型；空集合返回空列表（回退由调用方判断）
 */
export function filterConfiguredModels(models, providers) {
	const list = fallbackAll(models);
	const set =
		providers instanceof Set
			? providers
			: isProviderMap(providers)
				? new Set(Object.keys(providers))
				: new Set();
	if (set.size === 0) return [];
	return dedupeModels(list.filter((model) => set.has(model.provider)));
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
