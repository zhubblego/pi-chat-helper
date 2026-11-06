/**
 * chat-lib.js — 对话前端的纯函数层（零 DOM），供 chat.js 与测试共用。
 *
 * SSE 解析按「完整事件块」切分：块之间以空行分隔，未收完的行留在 rest 里，
 * 下一次调用拼上新 chunk 再解析。因此能正确处理跨 chunk 的半行、CRLF、
 * 多行 data: 与注释行（`: ping`）。
 */

/**
 * 解析一段 SSE 文本。
 * @param {string} buffer 上次返回的 rest + 本次新到的 chunk
 * @returns {{events: Array<{event: string, data: string}>, rest: string}}
 */
export function parseSseChunk(buffer) {
	const text = String(buffer ?? "").replace(/\r\n/g, "\n");
	const events = [];
	let rest = text;
	let index = rest.indexOf("\n\n");
	while (index >= 0) {
		const block = rest.slice(0, index);
		rest = rest.slice(index + 2);
		const event = parseBlock(block);
		if (event) events.push(event);
		index = rest.indexOf("\n\n");
	}
	return { events, rest };
}

/** 单个事件块（不含块间空行）：注释行忽略，多行 data 按 \n 拼接。 */
function parseBlock(block) {
	let name = "message";
	let hasData = false;
	const data = [];
	for (const line of block.split("\n")) {
		if (!line || line.startsWith(":")) continue;
		if (line.startsWith("event:")) {
			name = line.slice(6).trim() || "message";
			continue;
		}
		if (line.startsWith("data:")) {
			let value = line.slice(5);
			// 规范允许冒号后一个空格，去掉它
			if (value.startsWith(" ")) value = value.slice(1);
			data.push(value);
			hasData = true;
		}
		// id:/retry: 本协议不用，忽略
	}
	if (!hasData) return null;
	return { event: name, data: data.join("\n") };
}

/**
 * SSE data 字段 → JSON 对象；坏 JSON 返回 null（调用方跳过该事件）。
 * @param {{data?: string} | string} event
 */
export function parseSseData(event) {
	const raw = typeof event === "string" ? event : event?.data;
	if (typeof raw !== "string" || raw === "") return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * 会话引用：只要 selectedId 存在就返回对象。
 * 切源时 state.sessions 会先清空，此时 find 必然未命中；不能因此把当前会话当成不存在。
 * @param {{source?: string, selectedId?: string|null, sessions?: Array<object>}} input
 */
export function chatSessionRef(input = {}) {
	const selectedId = input.selectedId ?? null;
	if (!selectedId) return null;
	const found = Array.isArray(input.sessions) ? input.sessions.find((item) => item?.id === selectedId) : undefined;
	return {
		source: input.source ?? "pi",
		id: selectedId,
		name: found?.name ?? null,
		projectPath: found?.projectPath ?? null,
	};
}

/**
 * SSE 回调守卫：本 turn 未结束且仍属于当前会话时才允许写 UI。
 * 切会话后旧流可能还会到几个 chunk，必须丢弃，不能写进新会话。
 * @param {{key?: string, settled?: boolean}|null|undefined} turn
 * @param {string} currentKey
 */
export function isCurrentTurn(turn, currentKey) {
	return Boolean(turn && turn.settled !== true && currentKey && turn.key === currentKey);
}

/** 模型展示名：name 优先，缺失用 id；过长截断。 */
export function modelLabel(model, max = 40) {
	if (!model) return "";
	const label = String(model.name || model.id || "").trim();
	if (!label) return "";
	const limit = Math.max(1, Number(max) || 40);
	return label.length > limit ? `${label.slice(0, limit - 1)}…` : label;
}

/** 上下文窗口：1M / 200K / 128K / 32000（低于 100K 保留原数）。 */
export function formatContextWindow(n) {
	const value = Number(n);
	if (!Number.isFinite(value) || value <= 0) return "";
	const trim = (x) => String(Number(x.toFixed(1)));
	if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
	if (value >= 100_000) return `${trim(value / 1000)}K`;
	return String(Math.round(value));
}

/**
 * 斜杠面板过滤：多词 AND、大小写不敏感，匹配 label/hint/group/search。
 * @param {Array<{label?:string,hint?:string,group?:string,search?:string}>} items
 * @param {string} query
 */
export function filterPaletteItems(items, query) {
	const list = Array.isArray(items) ? items : [];
	const terms = String(query ?? "")
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	if (!terms.length) return list.slice();
	return list.filter((item) => {
		const hay = [item?.label, item?.hint, item?.group, item?.search]
			.filter((value) => typeof value === "string" && value)
			.join(" ")
			.toLowerCase();
		return terms.every((term) => hay.includes(term));
	});
}
