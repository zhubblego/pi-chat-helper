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

/** 技能字符数展示：900 / 1.8k / 236k / 1.2M。 */
export function formatChars(n) {
	if (n === null || n === undefined || n === "") return "";
	const value = Number(n);
	if (!Number.isFinite(value) || value < 0) return "";
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) return `${Number((value / 1000).toFixed(1))}k`;
	return `${Number((value / 1_000_000).toFixed(1))}M`;
}

/** 从 tw.chatCtx 读取某会话的 id：去重，不限制条数。 */
export function normalizeContextIds(map, source, sessionId) {
	const key = `${source}:${sessionId ?? ""}`;
	const raw = map && typeof map === "object" && Array.isArray(map[key]) ? map[key] : [];
	const ids = [];
	for (const id of raw) {
		if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/** 写回某会话的 id：不改原 map；去重，不限制条数。 */
export function mergeContextIds(map, key, ids) {
	const next = { ...(map && typeof map === "object" ? map : {}) };
	const merged = [];
	for (const id of Array.isArray(ids) ? ids : []) {
		if (typeof id === "string" && id && !merged.includes(id)) merged.push(id);
	}
	next[key] = merged;
	return next;
}

/** 过滤投影里不存在的事件 id。eventsById 可为 Set/Map/普通对象。 */
export function pruneContextIds(ids, eventsById) {
	const has =
		eventsById instanceof Set || eventsById instanceof Map
			? (id) => eventsById.has(id)
			: (id) => Boolean(eventsById?.[id]);
	return (Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id && has(id));
}

/** tw.chatThread：读取某个 source:session 记住的 pi session id。 */
export function readThreadId(map, key) {
	const value = map && typeof map === "object" ? map[key] : null;
	return typeof value === "string" && value ? value : null;
}

/** tw.chatThread：写回记住的线程（不改原 map）。 */
export function rememberThread(map, key, threadId) {
	return { ...(map && typeof map === "object" ? map : {}), [key]: String(threadId) };
}

/** tw.chatThread：删除失效线程记忆（不改原 map）。 */
export function forgetThread(map, key) {
	const next = { ...(map && typeof map === "object" ? map : {}) };
	delete next[key];
	return next;
}

/**
 * trigger 锚定菜单的坐标换算（纯函数，零 DOM）。
 *
 * 菜单是 .chat-overlay-anchor 的绝对定位子元素，而 anchor 贴在卡片顶部、
 * 高度为 0；因此要把 trigger 的视口坐标换算成相对 anchor 的 bottom/left/right。
 *
 * @param {object} input
 * @param {{left:number,right:number,top:number,bottom:number}} input.anchorRect
 * @param {{left:number,right:number,top:number,bottom:number}} input.triggerRect
 * @param {number} [input.offset] 菜单底边距 trigger 顶边的距离（权限 4、模型 8）
 * @param {"left"|"right"} [input.align] 水平对齐方向
 * @param {number} [input.menuWidth] 菜单测量宽度，用于可用区 clamp
 * @param {number} [input.boundsWidth] 锚点可用宽度（anchorRect.right - anchorRect.left）
 * @param {number} [input.margin] 高度安全边距，不参与水平 clamp
 * @returns {{left:number|null,right:number|null,bottom:number,maxHeight:number}}
 */
export function computeAnchoredMenuPosition(input = {}) {
	const anchorRect = input.anchorRect ?? {};
	const triggerRect = input.triggerRect ?? {};
	const offset = Number(input.offset) || 0;
	const margin = Number.isFinite(input.margin) ? Number(input.margin) : 12;
	const menuWidth = Math.max(0, Number(input.menuWidth) || 0);
	const boundsWidth = Math.max(0, Number(input.boundsWidth) || 0);
	const bottom = Number(anchorRect.bottom) - Number(triggerRect.top) + offset;
	const maxHeight = Math.min(400, Math.max(120, Number(triggerRect.top) - offset - margin));
	const round = (value) => Math.round(value * 100) / 100;
	const maxLeft = Math.max(0, boundsWidth - menuWidth);
	const desiredLeft = (input.align === "right" ? Number(triggerRect.right) - menuWidth : Number(triggerRect.left)) - Number(anchorRect.left);
	const left = Math.min(Math.max(desiredLeft, 0), maxLeft);
	if (input.align === "right") {
		return {
			left: null,
			right: round(boundsWidth - (left + menuWidth)),
			bottom: round(bottom),
			maxHeight: round(maxHeight),
		};
	}
	return {
		left: round(left),
		right: null,
		bottom: round(bottom),
		maxHeight: round(maxHeight),
	};
}

/** 上下文摘要的 preview 最大显示宽度（终端/浏览器列宽近似）。 */
const CONTEXT_SUMMARY_WIDTH = 32;

function isWideCodePoint(cp) {
	return (
		cp >= 0x1100 &&
		(cp <= 0x115f ||
			cp === 0x2329 ||
			cp === 0x232a ||
			(cp >= 0x2e80 && cp <= 0xa4cf) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe10 && cp <= 0xfe19) ||
			(cp >= 0xfe30 && cp <= 0xfe6f) ||
			(cp >= 0xff00 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x1f300 && cp <= 0x1faff))
	);
}

function displayWidth(text) {
	let width = 0;
	for (const ch of String(text ?? "")) {
		const cp = ch.codePointAt(0);
		if (cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f)) continue;
		width += isWideCodePoint(cp) ? 2 : 1;
	}
	return width;
}

function truncateDisplay(text, maxWidth) {
	if (displayWidth(text) <= maxWidth) return text;
	const limit = Math.max(0, maxWidth - 1);
	let width = 0;
	let out = "";
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		const w = cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f) ? 0 : isWideCodePoint(cp) ? 2 : 1;
		if (width + w > limit) break;
		out += ch;
		width += w;
	}
	return `${out}…`;
}

/** 控制台状态文案；未知/离线返回空串。 */
export function consoleStatusLabel(state) {
	if (state === "working") return "控制台运行中";
	if (state === "idle") return "控制台在线空闲";
	return "";
}

/** 对话模式：只认 forward，其余一律 independent。 */
export function readChatMode(map, key) {
	const value = map && typeof map === "object" && !Array.isArray(map) ? map[key] : null;
	return value === "forward" ? "forward" : "independent";
}

/** 写入/删除模式偏好，返回新 map；不修改入参。 */
export function writeChatMode(map, key, mode) {
	const next = map && typeof map === "object" && !Array.isArray(map) ? { ...map } : {};
	if (!key) return next;
	if (mode === "forward") next[key] = "forward";
	else delete next[key];
	return next;
}

/** 转发状态条文案：转发生效后无控制台也要给出明确不可用态。 */
export function forwardStatusLabel(mode, info, lost = false) {
	if (mode !== "forward") return consoleStatusLabel(info?.state);
	if (info) return consoleStatusLabel(info.state);
	return lost ? "控制台已离线" : "未检测到可转发控制台";
}

/** 桥实际接受的 delivery → 转发记录文案。 */
export function forwardDeliveryLabel(delivery) {
	if (delivery === "now") return "已发送，控制台开始执行";
	if (delivery === "followUp") return "已排队，控制台完成当前任务后处理";
	if (delivery === "steer") return "已插话，控制台会在当前工具结果后处理";
	return "已转发";
}

/** /api/chat/forward 错误码 → 用户可读文案。 */
export function forwardFailureText(code) {
	const messages = {
		no_console: "未检测到可转发控制台",
		console_offline: "控制台已离线",
		ambiguous_console: "检测到多个控制台，无法确定目标",
		session_mismatch: "控制台已切换到其他会话",
		bridge_timeout: "控制台响应超时",
		bridge_error: "控制台发送失败",
		chat_disabled: "转发不可用",
		forbidden: "请求被拒绝",
		prompt_empty: "问题不能为空",
		prompt_too_large: "问题太长",
		bad_delivery: "转发方式非法",
		unsupported_source: "只支持 pi 控制台",
	};
	return messages[code] ?? "转发失败";
}

/** preview 已带标签前缀时剥掉，避免摘要出现「模型模型 → litellm」。 */
function stripPreviewLabel(label, preview) {
	if (!label || !preview.startsWith(label)) return preview;
	const rest = preview.slice(label.length);
	if (!rest) return "";
	if (/^[\s→:：·-]/.test(rest)) return rest.replace(/^[\s→:：·-]+/, "").trim();
	return preview;
}

/**
 * 上下文摘要按钮文案：首个条目标签+preview，N>1 时给 +K。
 * @param {string[]} ids
 * @param {Array<{id:string,label?:string,preview?:string,invalid?:boolean}>} refs
 * @returns {{count:number, summary:string, moreLabel:string}}
 */
export function contextSummaryLabel(ids, refs) {
	const list = Array.isArray(ids) ? ids : [];
	const count = list.length;
	if (count === 0) return { count: 0, summary: "", moreLabel: "" };
	const byId = new Map((Array.isArray(refs) ? refs : []).map((ref) => [ref?.id, ref]));
	const first = byId.get(list[0]);
	const invalid = first?.invalid === true || !first;
	const label = invalid ? "失效条目" : String(first.label || "失效条目").trim();
	const preview = invalid ? "" : String(first.preview ?? "").trim();
	const stripped = preview ? truncateDisplay(stripPreviewLabel(label, preview), CONTEXT_SUMMARY_WIDTH) : "";
	return {
		count,
		summary: stripped ? `${label}→${stripped}` : label,
		moreLabel: count > 1 ? `+${count - 1}` : "",
	};
}
