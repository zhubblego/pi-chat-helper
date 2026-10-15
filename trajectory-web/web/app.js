/**
 * app.js — 轨迹观察页：左侧会话栏 + 问题栏（含过滤按钮组），右侧整页轨迹（按问题分段）。
 *
 * 数据：
 *   - /api/sessions  会话列表（mode A 本项目；mode B 全部项目，按项目分组）
 *   - /api/session   选中会话的 light 投影（2s 轮询 + etag 增量）
 *   - /api/event     条目详情（full，按需拉取）
 *
 * DOM 全部用 createElement/textContent 构建，不使用 innerHTML；
 * Markdown 由 lib.renderMarkdown 生成（先整体转义再产出自有标签），经 DOMParser
 * 解析后逐个移入 wrapper（appendChild 自动收养并摘除源节点，循环必然收敛）。
 */
import {
	GROUP_LABELS,
	eventPasses,
	eventTagLabel,
	fmtBytes,
	fmtClock,
	fmtCost,
	fmtDuration,
	fmtRelative,
	fmtTime,
	fmtTokens,
	groupSessions,
	kindGroup,
	presetFilters,
	renderMarkdown,
} from "./lib.js";

const LS_FILTERS = "tw.filters";
const POLL_MS = 2000;
const SESSION_LIST_EVERY = 3; // 每 3 个 tick 刷一次会话列表（约 6s）

const el = (id) => document.getElementById(id);
const main = el("main");
const mainInner = el("main-inner");
const questionList = el("question-list");
const sessionList = el("session-list");
const drawer = el("drawer");

const state = {
	scope: null,
	sessions: [],
	sessionListKey: "",
	selectedId: null,
	data: null,
	etag: null,
	filters: presetFilters("all"),
	folded: new Set(),
	activeQ: null,
	openId: null,
	openFull: null,
	pollingSession: false,
	pollingSessions: false,
	tick: 0,
};

// ---------------------------------------------------------------------------
// 主题（deepseek token 的暗色契约：body[data-ds-dark-theme]）
// ---------------------------------------------------------------------------

function applyTheme() {
	const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	document.body.toggleAttribute("data-ds-dark-theme", dark);
	document.documentElement.dataset.dsThemeSource = "system";
}

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
}

function saveFilters() {
	try {
		localStorage.setItem(LS_FILTERS, JSON.stringify(state.filters));
	} catch {
		/* 无痕模式等场景忽略 */
	}
}

// ---------------------------------------------------------------------------
// 顶部
// ---------------------------------------------------------------------------

function setSync(text, kind) {
	el("sync").textContent = text;
	el("sync-dot").className = `dot ${kind ?? ""}`;
}

function renderTopbar() {
	el("scope-badge").textContent = state.scope === "all" ? "全部项目" : state.scope === "project" ? "本项目" : "";
	const meta = state.data?.meta;
	if (!meta) {
		el("session-meta").textContent = "选择一个会话查看轨迹";
		el("session-meta").title = "";
		return;
	}
	const bits = [
		meta.name || meta.cwd || meta.file,
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

// ---------------------------------------------------------------------------
// 会话栏
// ---------------------------------------------------------------------------

function sessionItem(session) {
	const title = session.name || session.firstMessage || "(空会话)";
	const sub = [`#${String(session.id).slice(0, 8)}`, fmtBytes(session.size)].filter(Boolean).join(" · ");
	return h(
		"button",
		{ class: `session-item${session.id === state.selectedId ? " active" : ""}`, dataset: { id: session.id }, title: session.file ?? "" },
		h(
			"span",
			{ class: "session-title" },
			session.live ? h("span", { class: "live-dot" }) : null,
			h("span", { class: "session-name", text: title }),
		),
		h("span", { class: "session-time", text: fmtRelative(session.modified) }),
		h("span", { class: "session-sub", text: sub }),
	);
}

function renderSessions() {
	const sessions = state.sessions;
	el("session-count").textContent = sessions.length ? String(sessions.length) : "";
	const nodes = [];
	if (state.scope === "all") {
		for (const group of groupSessions(sessions)) {
			nodes.push(
				h(
					"div",
					{ class: "project-head", title: group.key },
					h("span", { class: "project-path", text: group.label }),
					h("span", { text: String(group.sessions.length) }),
				),
			);
			for (const session of group.sessions) nodes.push(sessionItem(session));
		}
	} else {
		for (const session of sessions) nodes.push(sessionItem(session));
	}
	sessionList.replaceChildren(...nodes);
}

// ---------------------------------------------------------------------------
// 过滤面板
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 工具条（deepseek 工具栏形态：预设 + 过滤开关 + 轮次折叠）
// ---------------------------------------------------------------------------

const PRESETS = [
	["all", "全部"],
	["thinking", "仅思考"],
	["tools", "仅工具"],
	["text", "仅输出"],
];

function presetActive(name) {
	const preset = presetFilters(name);
	return Object.keys(preset).every((k) => preset[k] === (state.filters[k] !== false));
}

function renderToolbar() {
	el("presets").replaceChildren(
		...PRESETS.map(([key, label]) =>
			h("button", { class: "tb-btn", type: "button", dataset: { preset: key }, "aria-pressed": String(presetActive(key)), text: label }),
		),
	);
	el("filters").replaceChildren(
		...Object.entries(GROUP_LABELS).map(([group, label]) =>
			h("button", { class: "tb-btn", type: "button", dataset: { group }, "aria-pressed": String(state.filters[group] !== false), text: label }),
		),
	);
	updateFoldAll();
}

function updateFilterButtons() {
	for (const btn of el("presets").querySelectorAll("button")) {
		btn.setAttribute("aria-pressed", String(presetActive(btn.dataset.preset)));
	}
	for (const btn of el("filters").querySelectorAll("button")) {
		btn.setAttribute("aria-pressed", String(state.filters[btn.dataset.group] !== false));
	}
}

/** 当前会话可折叠的轮次序号（问题分组，含「会话开始」）。 */
function foldableQuestions() {
	return (state.data?.questions ?? []).map((q) => q.index);
}

function updateFoldAll() {
	const indexes = foldableQuestions();
	const allFolded = indexes.length > 0 && indexes.every((i) => state.folded.has(i));
	el("fold-all").setAttribute("aria-pressed", String(allFolded));
	el("fold-all").title = allFolded ? "展开所有轮次" : "收起所有轮次";
	el("fold-icon").textContent = allFolded ? "⊞" : "⊟";
}

// ---------------------------------------------------------------------------
// 问题导航
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
// 轨迹主区
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
	if (!state.selectedId) {
		mainInner.replaceChildren(h("div", { class: "empty", text: "左侧选择一个会话查看轨迹" }));
		return;
	}
	const questions = state.data?.questions ?? [];
	if (questions.length === 0) {
		mainInner.replaceChildren(h("div", { class: "empty", text: "该会话还没有提问（或正在加载）" }));
		return;
	}
	mainInner.replaceChildren(
		...questions.map((q) => {
			const shown = (q.events ?? []).filter((ev) => eventPasses(state.filters, ev.kind));
			const body = shown.length ? shown.map(renderEvent) : muted("（当前过滤下无条目）");
			const folded = state.folded.has(q.index);
			return h(
				"section",
				{ class: `question${folded ? " folded" : ""}`, id: `q-${q.index}`, dataset: { q: String(q.index) } },
				h(
					"header",
					{ class: "q-head" },
					h("button", {
						class: "q-fold",
						type: "button",
						dataset: { fold: String(q.index) },
						title: folded ? "展开本轮" : "收起本轮",
						"aria-expanded": String(!folded),
						text: folded ? "⊞" : "⊟",
					}),
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
	updateFoldAll();
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
	return h("span", { class: `chip${cls ? ` ${cls}` : ""}` }, label, value ? h("b", { text: value }) : null);
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
	const nodes = [
		h("div", { class: "kv" }, h("span", { text: "工具" }), h("b", { text: String(t.name ?? "") })),
		h("h4", { text: "参数" }),
		preNode(t.argsText ?? "", "wrap"),
		h("h4", { text: `结果${t.isError ? "（出错）" : ""}` }),
		t.result ? preNode(t.result, "wrap") : muted("（未返回）"),
		...nestedListNode(t),
	];
	if (isFull && t.details !== undefined) {
		nodes.push(h("details", null, h("summary", { text: "结构化细节" }), preNode(JSON.stringify(t.details, null, 2), "wrap")));
	}
	return nodes;
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
		const params = new URLSearchParams({ id });
		if (state.selectedId) params.set("session", state.selectedId);
		const res = await fetch(`/api/event?${params}`);
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
// 轮询
// ---------------------------------------------------------------------------

async function pollSessions(force = false) {
	if (state.pollingSessions) return;
	state.pollingSessions = true;
	try {
		const res = await fetch(`/api/sessions${force ? `?t=${Date.now()}` : ""}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const j = await res.json();
		state.scope = j.scope;
		const key = JSON.stringify(j.sessions);
		if (key !== state.sessionListKey) {
			state.sessionListKey = key;
			state.sessions = j.sessions ?? [];
			renderSessions();
			renderTopbar();
		}
		if (!state.selectedId && (j.current || j.sessions?.[0])) {
			state.selectedId = j.current ?? j.sessions[0].id;
			renderSessions();
		}
	} catch {
		/* 列表失败不打断主循环 */
	} finally {
		state.pollingSessions = false;
	}
}

async function pollSession(force = false) {
	if (state.pollingSession) return;
	state.pollingSession = true;
	try {
		const params = new URLSearchParams();
		if (state.selectedId) params.set("id", state.selectedId);
		if (!force && state.etag) params.set("v", state.etag);
		const res = await fetch(`/api/session?${params}`);
		if (res.status === 404) {
			state.selectedId = null;
			state.data = null;
			state.etag = null;
			renderMain();
			setSync("会话已消失，刷新列表", "warn");
			pollSessions(true);
			return;
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const j = await res.json();
		if (j.changed === false) {
			setSync(`已同步 ${fmtClock()}`, "ok");
			return;
		}
		state.data = { meta: j.meta, questions: j.questions };
		state.etag = j.etag;
		if (j.sessionId && j.sessionId !== state.selectedId) {
			state.selectedId = j.sessionId;
			renderSessions();
		}
		const keepTop = main.scrollTop;
		renderTopbar();
		renderSidebar();
		renderMain();
		main.scrollTop = keepTop;
		refreshOpen();
		setSync(`已同步 ${fmtClock()}`, "ok");
	} catch (err) {
		setSync(`同步失败：${err.message}`, "err");
	} finally {
		state.pollingSession = false;
	}
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

el("presets").addEventListener("click", (e) => {
	const btn = e.target.closest("button[data-preset]");
	if (!btn) return;
	state.filters = presetFilters(btn.dataset.preset);
	saveFilters();
	updateFilterButtons();
	renderMain();
});

el("filters").addEventListener("click", (e) => {
	const btn = e.target.closest("button[data-group]");
	if (!btn) return;
	const group = btn.dataset.group;
	state.filters[group] = state.filters[group] === false;
	saveFilters();
	updateFilterButtons();
	renderMain();
});

el("fold-all").addEventListener("click", () => {
	const indexes = foldableQuestions();
	const allFolded = indexes.length > 0 && indexes.every((i) => state.folded.has(i));
	state.folded = new Set(allFolded ? [] : indexes);
	renderMain();
});

sessionList.addEventListener("click", (e) => {
	const item = e.target.closest(".session-item");
	if (!item || item.dataset.id === state.selectedId) return;
	state.selectedId = item.dataset.id;
	state.data = null;
	state.etag = null;
	state.folded = new Set();
	state.openId = null;
	state.openFull = null;
	drawer.hidden = true;
	renderSessions();
	renderTopbar();
	renderSidebar();
	renderMain();
	main.scrollTop = 0;
	pollSession(true);
});

mainInner.addEventListener("click", (e) => {
	const fold = e.target.closest(".q-fold");
	if (fold) {
		const index = Number(fold.dataset.fold);
		if (state.folded.has(index)) state.folded.delete(index);
		else state.folded.add(index);
		renderMain();
		return;
	}
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
el("refresh").addEventListener("click", () => {
	pollSessions(true);
	pollSession(true);
});
main.addEventListener("scroll", updateActiveQuestion, { passive: true });
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

applyTheme();
loadPrefs();
renderToolbar();
pollSessions();
pollSession();
setInterval(() => {
	if (document.hidden) return;
	state.tick++;
	if (state.tick % SESSION_LIST_EVERY === 0) pollSessions();
	pollSession();
}, POLL_MS);
