/**
 * app.js — 轨迹观察页：左侧问题栏（过滤按钮组 + 问题导航），右侧整页轨迹（按问题分段）。
 * 数据来自本地服务 /api/session（light，2s 轮询增量）；条目详情按需拉 /api/event（full）。
 *
 * DOM 全部用 createElement/textContent 构建，不使用 innerHTML；
 * Markdown 由 lib.renderMarkdown 生成（先整体转义再产出自有标签），经 DOMParser
 * 解析成惰性文档后逐个移入 wrapper（appendChild 会自动收养并摘除源节点，
 * 不能用 importNode——它是克隆，源 firstChild 不消失，while 会死循环）。
 */
import {
	GROUP_LABELS,
	eventPasses,
	eventTagLabel,
	fmtClock,
	fmtCost,
	fmtDuration,
	fmtTime,
	fmtTokens,
	kindGroup,
	presetFilters,
	renderMarkdown,
} from "./lib.js";

const LS_FILTERS = "tw.filters";
const LS_COLLAPSED = "tw.filtersCollapsed";
const POLL_MS = 2000;

const el = (id) => document.getElementById(id);
const main = el("main");
const mainInner = el("main-inner");
const questionList = el("question-list");
const drawer = el("drawer");

const state = {
	data: null,
	etag: null,
	filters: presetFilters("all"),
	collapsed: false,
	activeQ: null,
	openId: null,
	openFull: null,
	polling: false,
};

// ---------------------------------------------------------------------------
// DOM 构建助手
// ---------------------------------------------------------------------------

function appendChildren(node, children) {
	for (const child of children) {
		if (child === null || child === undefined || child === false || child === true) continue;
		if (Array.isArray(child)) appendChildren(node, child);
		else if (child instanceof Node) node.appendChild(child);
		else node.appendChild(document.createTextNode(String(child)));
	}
}

function h(tag, attrs = null, ...children) {
	const node = document.createElement(tag);
	if (attrs) {
		for (const [key, value] of Object.entries(attrs)) {
			if (value === undefined || value === null || value === false) continue;
			if (key === "class") node.className = value;
			else if (key === "text") node.textContent = String(value);
			else if (key === "dataset") Object.assign(node.dataset, value);
			else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
			else if (value === true) node.setAttribute(key, "");
			else node.setAttribute(key, String(value));
		}
	}
	appendChildren(node, children);
	return node;
}

function preNode(text, extraClass = "") {
	return h("pre", { class: `code${extraClass ? ` ${extraClass}` : ""}`, text: String(text ?? "") });
}

function mdNode(text) {
	const wrapper = h("div", { class: "md" });
	const doc = new DOMParser().parseFromString(renderMarkdown(text), "text/html");
	// appendChild 会自动收养节点并从 doc.body 摘除，循环必然收敛
	while (doc.body.firstChild) wrapper.appendChild(doc.body.firstChild);
	return wrapper;
}

function muted(text) {
	return h("div", { class: "muted", text });
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

function loadPrefs() {
	try {
		const raw = localStorage.getItem(LS_FILTERS);
		if (raw) state.filters = { ...presetFilters("all"), ...JSON.parse(raw) };
	} catch {
		/* 忽略损坏的本地状态 */
	}
	state.collapsed = localStorage.getItem(LS_COLLAPSED) === "1";
}

function saveFilters() {
	try {
		localStorage.setItem(LS_FILTERS, JSON.stringify(state.filters));
	} catch {
		/* 无痕模式等场景忽略 */
	}
}

// ---------------------------------------------------------------------------
// 顶部与过滤面板
// ---------------------------------------------------------------------------

function setSync(text, kind) {
	el("sync").textContent = text;
	el("sync-dot").className = `dot ${kind ?? ""}`;
}

function basename(p) {
	const s = String(p ?? "");
	return s.slice(s.lastIndexOf("/") + 1) || s;
}

function renderTopbar() {
	const meta = state.data?.meta;
	if (!meta) return;
	const bits = [
		meta.name || basename(meta.cwd) || basename(meta.file),
		`${meta.questionCount} 问`,
		`${meta.entryCount} 条目`,
		meta.totals?.tools ? `${meta.totals.tools} 工具` : "",
		fmtTokens(meta.totals?.tokens) ? `${fmtTokens(meta.totals.tokens)} tok` : "",
		fmtDuration(meta.totals?.durationMs) ? fmtDuration(meta.totals.durationMs) : "",
		meta.updatedAt ? `最后更新 ${fmtTime(Date.parse(meta.updatedAt))}` : "",
	];
	el("session-meta").textContent = bits.filter(Boolean).join(" · ");
	el("session-meta").title = meta.file ?? "";
}

function renderChips() {
	el("chips").replaceChildren(
		...Object.entries(GROUP_LABELS).map(([group, label]) =>
			h("label", { class: "chip" }, h("input", { type: "checkbox", dataset: { group }, checked: state.filters[group] !== false }), ` ${label}`),
		),
	);
}

function applyFilterUI() {
	el("filter-body").hidden = state.collapsed;
	el("filter-head").setAttribute("aria-expanded", String(!state.collapsed));
	el("filter-chev").textContent = state.collapsed ? "▸" : "▾";
	for (const btn of el("presets").querySelectorAll(".preset")) {
		const preset = presetFilters(btn.dataset.preset);
		btn.classList.toggle("active", Object.keys(preset).every((k) => preset[k] === (state.filters[k] !== false)));
	}
}

// ---------------------------------------------------------------------------
// 左侧问题导航
// ---------------------------------------------------------------------------

function qStats(q) {
	const st = q.stats ?? {};
	return [
		`${st.events ?? 0} 事件`,
		st.tools ? `${st.tools} 工具` : "",
		st.errors ? `${st.errors} 错误` : "",
		fmtTokens(st.tokens),
		fmtDuration(st.durationMs),
	]
		.filter(Boolean)
		.join(" · ");
}

function renderSidebar() {
	const questions = state.data?.questions ?? [];
	questionList.replaceChildren(
		...questions.map((q) =>
			h(
				"button",
				{ class: "q-link", dataset: { q: String(q.index) }, title: q.summary || "" },
				h("span", { class: "q-no", text: q.index < 0 ? "起" : String(q.index + 1) }),
				h("span", { class: "q-time", text: fmtTime(q.ts) || "" }),
				h("span", { class: "q-sum", text: q.summary || "" }),
				h("span", { class: "q-mini", text: qStats(q) }),
			),
		),
	);
}

// ---------------------------------------------------------------------------
// 右侧轨迹
// ---------------------------------------------------------------------------

function renderEvent(ev) {
	const classes = ["ev", `k-${kindGroup(ev.kind)}`, `k-${ev.kind}`];
	if (ev.tool?.isError) classes.push("is-error");
	if (ev.isFinal) classes.push("is-final");
	const meta = [
		fmtTime(ev.ts),
		ev.msg?.durationMs !== undefined ? fmtDuration(ev.msg.durationMs) : "",
		ev.msg?.usage ? fmtTokens(ev.msg.usage.totalTokens) : "",
		ev.kind === "tool" && ev.tool?.durationMs !== undefined ? fmtDuration(ev.tool.durationMs) : "",
	]
		.filter(Boolean)
		.join(" · ");
	return h(
		"article",
		{ class: classes.join(" "), dataset: { eid: ev.id }, tabindex: "0", title: ev.preview },
		h("span", { class: "ev-tag", text: eventTagLabel(ev) }),
		h("span", { class: "ev-preview", text: ev.preview }),
		h("span", { class: "ev-meta", text: meta }),
	);
}

function renderMain() {
	const questions = state.data?.questions ?? [];
	if (questions.length === 0) {
		mainInner.replaceChildren(h("div", { class: "empty", text: "当前会话还没有提问" }));
		return;
	}
	mainInner.replaceChildren(
		...questions.map((q) => {
			const shown = (q.events ?? []).filter((ev) => eventPasses(state.filters, ev.kind));
			const body = shown.length ? shown.map(renderEvent) : muted("（当前过滤下无条目）");
			return h(
				"section",
				{ class: "question", id: `q-${q.index}`, dataset: { q: String(q.index) } },
				h(
					"header",
					{ class: "q-head" },
					h("span", { class: "q-no", text: q.index < 0 ? "会话开始" : `问题 ${q.index + 1}` }),
					h("span", { class: "q-time", text: fmtTime(q.ts) || "" }),
					h("span", { class: "q-sum", title: q.summary, text: q.summary }),
					h("span", { class: "q-stats", text: qStats(q) }),
				),
				h("div", { class: "q-body" }, body),
			);
		}),
	);
	updateActiveQuestion();
}

function updateActiveQuestion() {
	const top = main.getBoundingClientRect().top + 60;
	let active = null;
	for (const sec of mainInner.querySelectorAll(".question")) {
		if (sec.getBoundingClientRect().top <= top) active = sec.dataset.q;
		else break;
	}
	if (active !== state.activeQ) {
		state.activeQ = active;
		for (const link of questionList.querySelectorAll(".q-link")) {
			link.classList.toggle("active", link.dataset.q === active);
		}
	}
}

// ---------------------------------------------------------------------------
// 详情抽屉
// ---------------------------------------------------------------------------

function findEvent(id) {
	for (const q of state.data?.questions ?? []) {
		for (const ev of q.events ?? []) {
			if (ev.id === id) return ev;
		}
	}
	return null;
}

function chipNode(label, value, cls) {
	return h(
		"span",
		{ class: `chip${cls ? ` ${cls}` : ""}` },
		label,
		value ? h("b", { text: value }) : null,
	);
}

function usageText(u) {
	if (!u) return "";
	const bits = [];
	if (u.input) bits.push(`in ${fmtTokens(u.input)}`);
	if (u.output) bits.push(`out ${fmtTokens(u.output)}`);
	if (u.cacheRead) bits.push(`cache读 ${fmtTokens(u.cacheRead)}`);
	if (u.cacheWrite) bits.push(`cache写 ${fmtTokens(u.cacheWrite)}`);
	if (u.reasoning) bits.push(`思维 ${fmtTokens(u.reasoning)}`);
	if (u.totalTokens) bits.push(`合计 ${fmtTokens(u.totalTokens)}`);
	if (u.cost?.total) bits.push(fmtCost(u.cost.total));
	return bits.join(" · ");
}

function drawerMetaNodes(view, light) {
	const nodes = [];
	if (view.iso) nodes.push(chipNode("时间", new Date(view.iso).toLocaleString()));
	if (view.msg?.model) nodes.push(chipNode("模型", [view.msg.provider, view.msg.model].filter(Boolean).join("/")));
	if (view.msg?.durationMs !== undefined) nodes.push(chipNode("耗时", fmtDuration(view.msg.durationMs)));
	if (view.msg?.usage) nodes.push(chipNode("用量", usageText(view.msg.usage)));
	if (view.msg?.stopReason) nodes.push(chipNode("结束", view.msg.stopReason));
	if (view.thinkingLevel?.level) nodes.push(chipNode("思考等级", view.thinkingLevel.level));
	if (view.modelChange) nodes.push(chipNode("切换到", `${view.modelChange.provider ?? "?"}/${view.modelChange.modelId ?? "?"}`));
	if (view.tool?.durationMs !== undefined) nodes.push(chipNode("工具耗时", fmtDuration(view.tool.durationMs)));
	if (view.compaction?.tokensBefore) nodes.push(chipNode("压缩前", fmtTokens(view.compaction.tokensBefore)));
	if (view.tool?.isError) nodes.push(chipNode("出错", "", "err"));
	if (light?.truncated && (!state.openFull || state.openFull.id !== view.id)) nodes.push(chipNode("加载全文中…", "", "loading"));
	return nodes;
}

function nestedListNode(tool) {
	const nested = tool.nested ?? [];
	if (!nested.length) return [];
	return [
		h("h4", { text: `子调用（${nested.length}）` }),
		h(
			"ul",
			{ class: "nested" },
			...nested.map((n) =>
				h(
					"li",
					null,
					h("code", { text: String(n.name ?? "?") }),
					n.status ? ` · ${n.status}` : "",
					n.durationMs ? ` · ${fmtDuration(n.durationMs)}` : "",
					n.error ? h("span", { class: "err", text: ` · ${typeof n.error === "string" ? n.error : JSON.stringify(n.error)}` }) : "",
				),
			),
		),
	];
}

function toolBody(view) {
	const t = view.tool ?? {};
	const isFull = state.openFull && state.openFull.id === view.id;
	return [
		h("div", { class: "kv" }, h("span", { text: "工具" }), h("b", { text: String(t.name ?? "") })),
		h("h4", { text: "参数" }),
		preNode(t.argsText ?? "", "wrap"),
		h("h4", { text: `结果${t.isError ? "（出错）" : ""}` }),
		t.result ? preNode(t.result, "wrap") : muted("（未返回）"),
		...nestedListNode(t),
	]
		.filter(Boolean)
		.concat(
			isFull && t.details !== undefined
				? [h("details", null, h("summary", { text: "结构化细节" }), preNode(JSON.stringify(t.details, null, 2), "wrap"))]
				: [],
		);
}

function bashBody(view) {
	const b = view.bash ?? {};
	const flags = [b.cancelled ? "已取消" : "", b.excludeFromContext ? "不进上下文" : ""].filter(Boolean).join(" · ");
	return [
		h("div", { class: "kv" }, h("span", { text: "命令" })),
		preNode(b.command ?? "", "wrap"),
		h("div", { class: "kv" }, h("span", { text: "退出码" }), h("b", { text: String(b.exitCode ?? "?") }), flags ? ` · ${flags}` : ""),
		h("h4", { text: "输出" }),
		b.output ? preNode(b.output, "wrap") : muted("（空）"),
	];
}

function systemBody(view) {
	const isFull = state.openFull && state.openFull.id === view.id;
	const sys = view.system ?? {};
	const nodes = [];
	const sections = sys.sections ?? [];
	if (sections.length) {
		nodes.push(h("h4", { text: "提示词段落" }));
		for (const s of sections) {
			nodes.push(
				h(
					"details",
					null,
					h("summary", null, h("code", { text: String(s.name) }), isFull ? "" : ` · ${s.chars ?? 0} 字符`),
					isFull && typeof s.text === "string" ? preNode(s.text, "wrap") : muted("加载全文中…"),
				),
			);
		}
	}
	if (sys.toolsAdded?.length) {
		nodes.push(h("h4", { text: "工具新增" }));
		nodes.push(h("div", { class: "chips" }, ...sys.toolsAdded.map((n) => h("code", { text: `+${n}` }))));
	}
	if (sys.toolsRemoved?.length) {
		nodes.push(h("h4", { text: "工具移除" }));
		nodes.push(h("div", { class: "chips" }, ...sys.toolsRemoved.map((n) => h("code", { text: `-${n}` }))));
	}
	return nodes;
}

function drawerBodyNodes(view) {
	switch (view.kind) {
		case "thinking":
			return view.redacted && !view.text ? [muted("（加密思维，无明文可展示）")] : [mdNode(view.text)];
		case "text":
			return [...(view.isFinal ? [h("div", { class: "badge-final", text: "回合输出" })] : []), mdNode(view.text)];
		case "user":
			return [...(view.images ? [muted(`含 ${view.images} 张图片`)] : []), mdNode(view.text)];
		case "tool":
			return toolBody(view);
		case "bash":
			return bashBody(view);
		case "system":
			return systemBody(view);
		case "compaction":
			return [
				mdNode(view.compaction?.summary ?? ""),
				h("div", { class: "kv" }, h("span", { text: "压缩前 tokens" }), h("b", { text: fmtTokens(view.compaction?.tokensBefore) || "?" })),
			];
		case "branch":
			return [mdNode(view.branch?.summary ?? "")];
		case "custom":
			return [
				...(view.custom?.customType ? [h("div", { class: "kv" }, h("span", { text: "类型" }), h("b", { text: String(view.custom.customType) }))] : []),
				mdNode(view.custom?.text ?? ""),
			];
		case "usage":
			return [
				h("div", { class: "kv" }, h("span", { text: "类别" }), h("b", { text: String(view.usageEntry?.kind ?? "") })),
				h(
					"div",
					{ class: "kv" },
					h("span", { text: "模型" }),
					h("b", { text: [view.usageEntry?.provider, view.usageEntry?.model].filter(Boolean).join("/") }),
				),
				...(view.usageEntry?.usage ? [preNode(JSON.stringify(view.usageEntry.usage, null, 2), "wrap")] : []),
			];
		case "context-edit":
			return [
				h("div", { class: "kv" }, h("span", { text: "目标条目" }), h("b", { text: String(view.contextEdit?.targetId ?? "") })),
				preNode(view.contextEdit?.replacement ?? "", "wrap"),
			];
		default:
			return [preNode(JSON.stringify(view, null, 2), "wrap")];
	}
}

function renderDrawer() {
	const light = state.openId ? findEvent(state.openId) : null;
	if (!light) {
		drawer.hidden = true;
		return;
	}
	const full = state.openFull && state.openFull.id === light.id ? state.openFull : null;
	const view = full ?? light;
	el("dv-kind").textContent = eventTagLabel(light);
	el("dv-kind").className = `dv-kind k-${kindGroup(light.kind)}`;
	el("dv-title").textContent = light.preview;
	el("dv-meta").replaceChildren(...drawerMetaNodes(view, light));
	el("dv-body").replaceChildren(...drawerBodyNodes(view));
	el("dv-body").scrollTop = 0;
	drawer.hidden = false;
}

async function loadFull(id) {
	try {
		const res = await fetch(`/api/event?id=${encodeURIComponent(id)}`);
		if (!res.ok) return;
		const j = await res.json();
		if (state.openId !== id || !j.event) return;
		state.openFull = j.event;
		renderDrawer();
	} catch {
		/* 网络失败时保持 light 展示 */
	}
}

function openDrawer(id) {
	state.openId = id;
	state.openFull = null;
	renderDrawer();
	const light = findEvent(id);
	if (light?.truncated) loadFull(id);
}

function refreshOpen() {
	if (!state.openId) return;
	const light = findEvent(state.openId);
	if (!light) {
		state.openId = null;
		state.openFull = null;
		drawer.hidden = true;
		return;
	}
	state.openFull = null;
	renderDrawer();
	if (light.truncated) loadFull(light.id);
}

function closeDrawer() {
	state.openId = null;
	state.openFull = null;
	drawer.hidden = true;
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

el("filter-head").addEventListener("click", () => {
	state.collapsed = !state.collapsed;
	try {
		localStorage.setItem(LS_COLLAPSED, state.collapsed ? "1" : "0");
	} catch {
		/* 忽略 */
	}
	applyFilterUI();
});

el("presets").addEventListener("click", (e) => {
	const btn = e.target.closest(".preset");
	if (!btn) return;
	state.filters = presetFilters(btn.dataset.preset);
	saveFilters();
	renderChips();
	applyFilterUI();
	renderMain();
});

el("chips").addEventListener("change", (e) => {
	const input = e.target.closest("input[data-group]");
	if (!input) return;
	state.filters[input.dataset.group] = input.checked;
	saveFilters();
	applyFilterUI();
	renderMain();
});

mainInner.addEventListener("click", (e) => {
	const row = e.target.closest(".ev");
	if (row) openDrawer(row.dataset.eid);
});

mainInner.addEventListener("keydown", (e) => {
	if (e.key !== "Enter" && e.key !== " ") return;
	const row = e.target.closest(".ev");
	if (row) {
		e.preventDefault();
		openDrawer(row.dataset.eid);
	}
});

questionList.addEventListener("click", (e) => {
	const link = e.target.closest(".q-link");
	if (!link) return;
	document.getElementById(`q-${link.dataset.q}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
});

el("drawer-close").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") closeDrawer();
});
el("refresh").addEventListener("click", () => poll(true));
main.addEventListener("scroll", updateActiveQuestion, { passive: true });

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------

async function poll(force = false) {
	if (state.polling) return;
	state.polling = true;
	try {
		const qs = !force && state.etag ? `?v=${encodeURIComponent(state.etag)}` : "";
		const res = await fetch(`/api/session${qs}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const j = await res.json();
		if (j.changed === false) {
			setSync(`已同步 ${fmtClock()}`, "ok");
			return;
		}
		state.data = { meta: j.meta, questions: j.questions };
		state.etag = j.etag;
		const keepTop = main.scrollTop;
		renderTopbar();
		renderSidebar();
		renderMain();
		main.scrollTop = keepTop;
		refreshOpen();
		setSync((j.stale ? "会话暂不可读，显示缓存 " : "已同步 ") + fmtClock(), j.stale ? "warn" : "ok");
	} catch (err) {
		setSync(`同步失败：${err.message}`, "err");
	} finally {
		state.polling = false;
	}
}

loadPrefs();
renderChips();
applyFilterUI();
poll();
setInterval(() => {
	if (!document.hidden) poll();
}, POLL_MS);
