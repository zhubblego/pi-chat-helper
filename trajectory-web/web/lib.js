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
			return ev.isFinal ? "输出" : "文本";
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

export function fmtDuration(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
	const m = Math.floor(s / 60);
	return `${m}m${p2(Math.round(s - m * 60))}s`;
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
