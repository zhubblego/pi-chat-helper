/**
 * lib.js — 前端纯函数层（无 DOM 依赖，可被 node 直接 import 做单测）：
 *   - 事件类型 → 过滤分组的映射、预设过滤组合
 *   - 时间/时长/token/费用格式化
 *   - 极简 Markdown 渲染（先整体转义，再生成自有标签；链接只放行 http/https/mailto）
 */

export const FILTER_GROUPS = {
	user: ["user"],
	thinking: ["thinking"],
	tools: ["tool", "bash"],
	text: ["text"],
	context: ["system", "compaction", "branch", "model", "thinking-level", "usage", "context-edit", "custom"],
};

export const GROUP_LABELS = {
	user: "提问",
	thinking: "思考",
	tools: "工具",
	text: "输出",
	context: "上下文",
};

export function kindGroup(kind) {
	for (const [group, kinds] of Object.entries(FILTER_GROUPS)) {
		if (kinds.includes(kind)) return group;
	}
	return "context";
}

export function eventPasses(filters, kind) {
	return filters[kindGroup(kind)] !== false;
}

/** 当前会话出现过的工具名（按首次出现顺序去重；未出现过的工具不列出）。 */
export function collectToolNames(questions) {
	const names = [];
	for (const question of questions ?? []) {
		for (const event of question.events ?? []) {
			if (event.kind !== "tool") continue;
			const name = event.tool?.name;
			if (name && !names.includes(name)) names.push(name);
		}
	}
	return names;
}

/**
 * 工具名过滤（以「未勾选」集合表示）：空集 = 全部勾选，全部通过；
 * 否则工具调用行仅放行未被排除的工具，其它类型行不受影响。
 */
export function eventToolPasses(toolExcluded, event) {
	if (!toolExcluded || toolExcluded.size === 0) return true;
	if (event.kind !== "tool") return true;
	return !toolExcluded.has(event.tool?.name);
}

/** 预设：全部 / 仅思考 / 仅工具 / 仅输出 */
export function presetFilters(name) {
	switch (name) {
		case "thinking":
			return { user: false, thinking: true, tools: false, text: false, context: false };
		case "tools":
			return { user: false, thinking: false, tools: true, text: false, context: false };
		case "text":
			return { user: false, thinking: false, tools: false, text: true, context: false };
		default:
			return { user: true, thinking: true, tools: true, text: true, context: true };
	}
}

export function eventTagLabel(ev) {
	switch (ev.kind) {
		case "user":
			return "提问";
		case "thinking":
			return "思考";
		case "text":
			return "输出";
		case "tool":
			return ev.tool?.isError ? "工具✗" : "工具";
		case "bash":
			return "命令";
		case "system":
			return "上下文";
		case "compaction":
			return "压缩";
		case "branch":
			return "分支";
		case "model":
			return "模型";
		case "thinking-level":
			return "等级";
		case "usage":
			return "用量";
		case "context-edit":
			return "编辑";
		case "custom":
			return "自定义";
		default:
			return String(ev.kind ?? "?");
	}
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

const p2 = (n) => String(n).padStart(2, "0");

export function fmtTime(ts) {
	if (typeof ts !== "number") return "";
	const d = new Date(ts);
	return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function fmtClock(ts = Date.now()) {
	const d = new Date(ts);
	return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// 时长格式（复刻 deepseek ui-trajectory trajectory-record.ts）
// ---------------------------------------------------------------------------

/**
 * 毫秒时长：整数毫秒 + 千分位；未知返回 '—'。
 * 复刻自 deepseek-harness（MIT）ui-trajectory/src/client/trajectory-record.ts
 * 的 formatDurationMillis。
 */
export function formatDurationMillis(milliseconds) {
	if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return "—";
	return `${String(Math.round(milliseconds)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}ms`;
}

/** 秒转毫秒后走 formatDurationMillis（对应源码 formatElapsedSeconds）。 */
export function formatElapsedSeconds(seconds) {
	return formatDurationMillis(seconds === null ? null : seconds * 1000);
}

export function fmtTokens(n) {
	if (!Number.isFinite(n) || n <= 0) return "";
	if (n < 1000) return String(n);
	if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
	return `${(n / 1e6).toFixed(2)}M`;
}

export function fmtCost(n) {
	if (!Number.isFinite(n) || n <= 0) return "";
	return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// 会话列表（会话侧边栏）
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
export function fmtRelative(ts, now = Date.now()) {
	if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
	const diff = now - ts;
	if (diff < 45_000) return "刚刚";
	if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))} 分钟前`;
	if (diff < DAY) return `${Math.round(diff / HOUR)} 小时前`;
	if (diff < 7 * DAY) return `${Math.round(diff / DAY)} 天前`;
	const d = new Date(ts);
	return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 会话文件大小。 */
export function fmtBytes(n) {
	if (!Number.isFinite(n) || n <= 0) return "";
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
	return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 项目显示名：路径末段；无 cwd 的旧会话返回占位。 */
export function projectLabel(path) {
	if (!path) return "(未知项目)";
	const s = String(path).replace(/\/+$/, "");
	return s.slice(s.lastIndexOf("/") + 1) || s;
}

/** 按项目分组（all 范围用）。列表本身按最近活跃倒序，分组保持该顺序。 */
export function groupSessions(sessions) {
	const groups = new Map();
	for (const s of sessions) {
		const key = s.projectPath || s.projectDir || "";
		if (!groups.has(key)) groups.set(key, { key, label: projectLabel(key), sessions: [] });
		groups.get(key).sessions.push(s);
	}
	return [...groups.values()];
}

// ---------------------------------------------------------------------------
// 轨迹搜索索引（复刻 deepseek ui-trajectory trajectory-search-index.ts）
// ---------------------------------------------------------------------------

function sameSources(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** 一个事件的可检索字段（对应源码的 recordSources）。 */
function eventSources(question, event) {
	const tool = event.tool ?? {};
	const bash = event.bash ?? {};
	const system = event.system ?? {};
	const compaction = event.compaction ?? {};
	const custom = event.custom ?? {};
	const msg = event.msg ?? {};
	return [
		question.index < 0 ? "会话开始" : `turn ${question.index + 1}`,
		question.summary ?? "",
		event.kind,
		event.preview ?? "",
		event.text ?? "",
		tool.name ?? "",
		tool.callId ?? "",
		tool.argsText ?? "",
		tool.result ?? "",
		bash.command ?? "",
		bash.output ?? "",
		...(system.sections ?? []).map((s) => s.name),
		...(system.toolsAdded ?? []),
		compaction.summary ?? "",
		custom.customType ?? "",
		custom.text ?? "",
		msg.model ?? "",
		msg.provider ?? "",
	];
}

/**
 * 会话级增量全文索引：按事件稳定 id 缓存来源数组，仅在来源变化时重建该条文本；
 * 查询为空格分隔的 AND 匹配（大小写不敏感），空查询返回 null（表示不过滤）。
 */
export class TrajectorySearchIndex {
	constructor() {
		this.entries = new Map();
		this.layout = undefined;
	}

	/** 同步当前投影；与源码一致（layout 引用未变时返回 false）。 */
	update(questions) {
		if (this.layout === questions) return false;
		this.layout = questions;
		const seen = new Set();
		for (const question of questions ?? []) {
			for (const event of question.events ?? []) {
				if (!event.id) continue;
				const sources = eventSources(question, event);
				const previous = this.entries.get(event.id);
				const entry =
					previous && sameSources(previous.sources, sources)
						? previous
						: { sources, text: sources.join("\n").toLocaleLowerCase() };
				this.entries.set(event.id, entry);
				seen.add(event.id);
			}
		}
		for (const id of this.entries.keys()) {
			if (!seen.has(id)) this.entries.delete(id);
		}
		return true;
	}

	/** 匹配的事件 id 集合；空查询返回 null。 */
	search(query) {
		const terms = String(query ?? "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
		if (terms.length === 0) return null;
		const matches = new Set();
		for (const [id, entry] of this.entries) {
			if (terms.every((term) => entry.text.includes(term))) matches.add(id);
		}
		return matches;
	}
}

// ---------------------------------------------------------------------------
// 极简 Markdown：标题/代码块/行内代码/粗斜/删除线/链接/引用/列表/分隔线/段落
// ---------------------------------------------------------------------------

function inline(src) {
	// src 传入前已转义；行内代码先摘出，避免被后续规则改写
	const codes = [];
	let s = src.replace(/`([^`\n]+)`/g, (_, code) => {
		codes.push(code);
		return `\u0000${codes.length - 1}\u0000`;
	});
	s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
		const safe = /^(https?:|mailto:)/i.test(href) ? href : "#";
		return `<a href="${safe}" target="_blank" rel="noreferrer">${text}</a>`;
	});
	s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
	s = s.replace(/(^|[\s(（])\*([^*\n]+)\*/g, "$1<em>$2</em>");
	s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
	s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
	return s;
}

export function renderMarkdown(src) {
	const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
	const out = [];
	const para = [];
	let i = 0;
	const flushPara = () => {
		if (para.length) {
			out.push(`<p>${para.map((l) => inline(esc(l))).join("<br>")}</p>`);
			para.length = 0;
		}
	};
	while (i < lines.length) {
		const line = lines[i];
		const fence = /^```\s*([\w+#.-]*)\s*$/.exec(line);
		if (fence) {
			flushPara();
			const lang = fence[1];
			const buf = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) {
				buf.push(lines[i]);
				i++;
			}
			i++;
			out.push(`<pre class="md-code"><code${lang ? ` class="language-${esc(lang)}"` : ""}>${esc(buf.join("\n"))}</code></pre>`);
			continue;
		}
		if (/^\s*$/.test(line)) {
			flushPara();
			i++;
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flushPara();
			const level = heading[1].length;
			out.push(`<h${level}>${inline(esc(heading[2]))}</h${level}>`);
			i++;
			continue;
		}
		if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			flushPara();
			out.push("<hr>");
			i++;
			continue;
		}
		if (/^\s*>/.test(line)) {
			flushPara();
			const buf = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) {
				buf.push(lines[i].replace(/^\s*>\s?/, ""));
				i++;
			}
			out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
			continue;
		}
		if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
			flushPara();
			const ordered = /^\s*\d+\./.test(line);
			const items = [];
			while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
				items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
				i++;
			}
			const tag = ordered ? "ol" : "ul";
			out.push(`<${tag}>${items.map((it) => `<li>${inline(esc(it))}</li>`).join("")}</${tag}>`);
			continue;
		}
		para.push(line);
		i++;
	}
	flushPara();
	return out.join("\n");
}
