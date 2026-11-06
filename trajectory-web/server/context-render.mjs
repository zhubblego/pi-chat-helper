/**
 * context-render.mjs — 轨迹上下文的纯函数渲染 / 选择 / 分页。
 *
 * 供 chat host（清单、refs）与子进程扩展 read_trajectory 共用；
 * 不依赖 DOM，与轨迹详情使用同一套事件投影（buildProjection）。
 */

/** 单条 / 单次字符上限（按 JS 字符串长度，字符）。 */
export const CONTEXT_SINGLE_LIMIT = 6000;
export const CONTEXT_TOTAL_LIMIT = 12000;

/** 每种事件 kind 的单条上限；当前统一 6000，保留按 kind 调整的入口。 */
export const perKindLimits = Object.freeze({
	user: CONTEXT_SINGLE_LIMIT,
	answer: CONTEXT_SINGLE_LIMIT,
	text: CONTEXT_SINGLE_LIMIT,
	thinking: CONTEXT_SINGLE_LIMIT,
	tool: CONTEXT_SINGLE_LIMIT,
	bash: CONTEXT_SINGLE_LIMIT,
	system: CONTEXT_SINGLE_LIMIT,
	compaction: CONTEXT_SINGLE_LIMIT,
	custom: CONTEXT_SINGLE_LIMIT,
	approval: CONTEXT_SINGLE_LIMIT,
	error: CONTEXT_SINGLE_LIMIT,
	branch: CONTEXT_SINGLE_LIMIT,
	model: CONTEXT_SINGLE_LIMIT,
	usage: CONTEXT_SINGLE_LIMIT,
	"thinking-level": CONTEXT_SINGLE_LIMIT,
	default: CONTEXT_SINGLE_LIMIT,
});

export function estimateChars(value) {
	return String(value ?? "").length;
}

function clip(value, max) {
	const text = String(value ?? "");
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 与 web/lib.js 的 eventTagLabel 对齐。 */
export function eventLabel(ev) {
	switch (ev?.kind) {
		case "user":
			return "提问";
		case "thinking":
			return "思考";
		case "text":
			return "过程";
		case "answer":
			return "回答";
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
		case "approval":
			return ev.approval?.verdict?.outcome === "deny" ? "审批✗" : "审批";
		case "context-edit":
			return "编辑";
		case "custom":
			return "自定义";
		case "error":
			return "错误";
		default:
			return String(ev?.kind ?? "?");
	}
}

function systemText(system) {
	if (!system) return "";
	const sections = Array.isArray(system.sections) ? system.sections : [];
	const parts = [];
	if (sections.length) {
		parts.push(
			sections
				.map((section) => `${section.label ?? section.id ?? "上下文"}：${clip(section.text ?? section.preview ?? "", 1200)}`)
				.join("\n"),
		);
	}
	if (system.toolsAdded?.length) parts.push(`新增工具：${system.toolsAdded.join(", ")}`);
	if (system.toolsRemoved?.length) parts.push(`移除工具：${system.toolsRemoved.join(", ")}`);
	return parts.join("\n") || "(上下文变更)";
}

/** 事件正文（不含类型/时间头）。 */
export function eventBody(ev) {
	switch (ev?.kind) {
		case "user":
		case "answer":
		case "text":
			return String(ev.text ?? "");
		case "thinking":
			return ev.text ? String(ev.text) : ev.redacted ? "(思维已加密/不可读)" : "(空思维)";
		case "tool": {
			const tool = ev.tool ?? {};
			const parts = [`工具：${tool.name ?? "(unknown)"}`];
			if (tool.argsText) parts.push(`参数：${tool.argsText}`);
			if (tool.result !== undefined && tool.result !== null && tool.result !== "") parts.push(`结果：${tool.result}`);
			if (tool.isError) parts.push("状态：错误");
			if (Number.isFinite(tool.durationMs)) parts.push(`耗时：${tool.durationMs}ms`);
			for (const nested of Array.isArray(tool.nested) ? tool.nested : []) {
				parts.push(`嵌套：${nested.name ?? "(tool)"}${nested.status ? ` ${nested.status}` : ""}${nested.error ? `（${nested.error}）` : ""}`);
			}
			return parts.join("\n");
		}
		case "bash": {
			const bash = ev.bash ?? {};
			const parts = [`命令：${bash.command ?? ""}`];
			if (bash.output) parts.push(`输出：${bash.output}`);
			if (Number.isFinite(bash.exitCode)) parts.push(`退出码：${bash.exitCode}`);
			if (bash.outputTruncated) parts.push("（输出已截断）");
			if (bash.cancelled) parts.push("（已取消）");
			return parts.join("\n");
		}
		case "system":
			return systemText(ev.system);
		case "compaction": {
			const compaction = ev.compaction ?? {};
			const parts = [`摘要：${compaction.summary ?? ""}`];
			if (Number.isFinite(compaction.tokensBefore)) parts.push(`压缩前 tokens：${compaction.tokensBefore}`);
			return parts.join("\n");
		}
		case "custom": {
			const custom = ev.custom ?? {};
			return [custom.customType ? `类型：${custom.customType}` : "", String(custom.text ?? "")].filter(Boolean).join("\n");
		}
		case "approval": {
			const approval = ev.approval ?? {};
			const verdict = approval.verdict ?? {};
			const parts = [`动作：${approval.action ?? "?"}`];
			if (verdict.outcome) parts.push(`结果：${verdict.outcome}`);
			if (verdict.rationale) parts.push(`理由：${verdict.rationale}`);
			if (verdict.command) parts.push(`命令：${verdict.command}`);
			return parts.join("\n");
		}
		case "error":
			return String(ev.error?.message ?? ev.preview ?? "错误");
		case "branch":
			return String(ev.branch?.summary ?? ev.preview ?? "");
		case "model":
			return ev.modelChange ? `模型 → ${ev.modelChange.provider ?? "?"}/${ev.modelChange.modelId ?? "?"}` : String(ev.preview ?? "");
		case "usage":
			return JSON.stringify(ev.usageEntry?.usage ?? {}) + (ev.usageEntry?.note ? `\n${ev.usageEntry.note}` : "");
		case "thinking-level":
			return `思考等级 → ${ev.thinkingLevel?.level ?? "?"}`;
		default:
			return String(ev?.preview ?? "");
	}
}

/**
 * 渲染单条事件：类型 · 时间 + 正文；单条超限截断。
 * @param {object} ev buildProjection 的事件
 * @param {{maxChars?:number}} [limits]
 */
export function renderContextEvent(ev, limits = {}) {
	const max = Number.isFinite(Number(limits.maxChars))
		? Number(limits.maxChars)
		: perKindLimits[ev?.kind] ?? perKindLimits.default;
	let body = eventBody(ev);
	if (body.length > max) body = `${body.slice(0, max)}\n…（单条已截断，可继续用 offset 读取其它条目）`;
	const head = [`【${eventLabel(ev)}】`, ev?.iso ? String(ev.iso) : ""].filter(Boolean).join(" · ");
	return `${head}\n${body}`.trim();
}

/** 清单/上下文引用条目：id/kind/label/preview/chars。 */
export function contextEventRef(ev) {
	const rendered = renderContextEvent(ev, { maxChars: perKindLimits[ev?.kind] ?? perKindLimits.default });
	const preview = clip(ev?.preview ?? eventBody(ev), 80);
	return {
		id: String(ev?.id ?? ""),
		kind: String(ev?.kind ?? "custom"),
		label: eventLabel(ev),
		preview,
		chars: estimateChars(rendered),
	};
}

/**
 * 在上下文集内过滤：ids 白名单 / query 子串（大小写不敏感）/ kind。
 * entries: [{id,kind,label,preview,text}]
 */
export function selectContextEntries(entries, { ids = null, query = "", kind = "" } = {}) {
	let list = Array.isArray(entries) ? entries.slice() : [];
	if (Array.isArray(ids)) {
		const wanted = new Set(ids);
		list = list.filter((entry) => wanted.has(entry.id));
	}
	if (kind) list = list.filter((entry) => entry.kind === kind);
	const q = String(query ?? "")
		.trim()
		.toLowerCase();
	if (q) {
		list = list.filter((entry) =>
			[entry.text, entry.label, entry.preview].some((value) => String(value ?? "").toLowerCase().includes(q)),
		);
	}
	return list;
}

/** 分页：offset 从 0 开始；limit 默认 3、最大 20。 */
export function paginateContextEntries(entries, { offset = 0, limit = 3 } = {}) {
	const list = Array.isArray(entries) ? entries : [];
	const start = Math.max(0, Math.floor(Number(offset) || 0));
	const size = Math.min(20, Math.max(1, Math.floor(Number(limit) || 3)));
	const page = list.slice(start, start + size);
	return {
		entries: page,
		offset: start,
		limit: size,
		total: list.length,
		nextOffset: start + page.length < list.length ? start + page.length : null,
	};
}

/**
 * 拼接本批渲染结果：单条已截断到 singleLimit；本批总量超 totalLimit 时提前停。
 * entries: [{id, rendered}]
 */
export function renderContextBatch(entries, { singleLimit = CONTEXT_SINGLE_LIMIT, totalLimit = CONTEXT_TOTAL_LIMIT, startOffset = 0 } = {}) {
	const list = Array.isArray(entries) ? entries : [];
	let text = "";
	let count = 0;
	let truncated = false;
	for (const entry of list) {
		const rendered =
			String(entry.rendered ?? "").length > singleLimit
				? `${String(entry.rendered).slice(0, singleLimit)}\n…（单条已截断）`
				: String(entry.rendered ?? "");
		const block = rendered ? `### [${entry.id}]\n${rendered}` : "";
		const next = text ? `${text}\n\n${block}` : block;
		if (next.length > totalLimit) {
			if (count === 0) {
				text = next.slice(0, totalLimit);
				count = 1;
			}
			truncated = true;
			break;
		}
		text = next;
		count++;
	}
	return {
		text,
		count,
		truncated,
		nextOffset: count < list.length ? Math.max(0, Math.floor(Number(startOffset) || 0)) + count : null,
	};
}
