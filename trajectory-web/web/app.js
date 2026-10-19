/**
 * app.js — 轨迹观察页：左侧会话栏，右侧轨迹（按轮次分段，工具条过滤/折叠）。
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
	TrajectorySearchIndex,
	collectToolNames,
	eventPasses,
	eventTagLabel,
	eventToolPasses,
	fmtBytes,
	fmtClock,
	fmtCost,
	fmtRelative,
	fmtTime,
	fmtTokens,
	formatDurationMillis,
	groupSessions,
	groupToolNames,
	kindGroup,
	mcpLabel,
	presetFilters,
	renderMarkdown,
} from "./lib.js";

const LS_FILTERS = "tw.filters";
const LS_THEME = "tw.theme";
const LS_TRANSLATE = "tw.translate";
const POLL_MS = 2000;
const SESSION_LIST_EVERY = 3; // 每 3 个 tick 刷一次会话列表（约 6s）

const el = (id) => document.getElementById(id);
const main = el("main");
const mainInner = el("main-inner");
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
	searchIndex: new TrajectorySearchIndex(),
	query: "",
	menuOpen: false,
	toolExcluded: new Set(),
	toolNames: [],
	toolOrigins: {},
	toolOriginsAt: 0,
	toolOriginsLoading: false,
	toolOriginsMissAt: 0,
	submenuOpen: false,
	folded: new Set(),
	source: "pi",
	sources: [],
	sourceSel: {},
	collapsedGroupsBy: {},
	openId: null,
	openFull: null,
	openLightJson: "",
	translated: false,
	translating: false,
	settingsOpen: false,
	copyOpen: false,
	pollingSession: false,
	pollingSessions: false,
	tick: 0,
};

// ---------------------------------------------------------------------------
// 主题（deepseek token 的暗色契约：body[data-ds-dark-theme]；偏好三态 light/dark/system）
// ---------------------------------------------------------------------------

const THEMES = ["system", "light", "dark"];
const THEME_LABEL = { system: "跟随系统", light: "浅色", dark: "深色" };
let themePref = "system";

function applyTheme() {
	const dark = themePref === "dark" || (themePref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	document.body.toggleAttribute("data-ds-dark-theme", dark);
	document.documentElement.dataset.dsThemeSource = themePref;
	document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

function loadTheme() {
	try {
		const saved = localStorage.getItem(LS_THEME);
		if (THEMES.includes(saved)) themePref = saved;
	} catch {
		/* 忽略损坏的本地状态 */
	}
}

function renderThemeButton() {
	const btn = el("theme-btn");
	btn.replaceChildren(svgIcon(themePref === "system" ? "auto" : themePref));
	const title = `主题：${THEME_LABEL[themePref]}（点击切换）`;
	btn.title = title;
	btn.setAttribute("aria-label", title);
}

function cycleTheme() {
	themePref = THEMES[(THEMES.indexOf(themePref) + 1) % THEMES.length];
	try {
		localStorage.setItem(LS_THEME, themePref);
	} catch {
		/* 无痕模式等场景忽略 */
	}
	applyTheme();
	renderThemeButton();
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

// 工具条图标（12×12，描边跟随字号颜色；deepseek 按钮形态：图标在左、名称在右）
const ICONS = {
	all: [
		["rect", { x: 1.5, y: 1.5, width: 3.6, height: 3.6, rx: 1 }],
		["rect", { x: 6.9, y: 1.5, width: 3.6, height: 3.6, rx: 1 }],
		["rect", { x: 1.5, y: 6.9, width: 3.6, height: 3.6, rx: 1 }],
		["rect", { x: 6.9, y: 6.9, width: 3.6, height: 3.6, rx: 1 }],
	],
	user: [
		["circle", { cx: 6, cy: 4, r: 2.2 }],
		["path", { d: "M2.2 10.8c.7-2.1 2.1-3.2 3.8-3.2s3.1 1.1 3.8 3.2" }],
	],
	thinking: [["path", { d: "M6 1.6 7.15 4.85 10.4 6 7.15 7.15 6 10.4 4.85 7.15 1.6 6 4.85 4.85z" }]],
	tools: [
		["rect", { x: 1.5, y: 2.5, width: 9, height: 7, rx: 1.5 }],
		["path", { d: "M4 5.2 5.4 6.6 4 8" }],
	],
	text: [["path", { d: "M2 3.4h8M2 6h8M2 8.6h5" }]],
	context: [
		["path", { d: "M6 1.7 1.8 4.1 6 6.5l4.2-2.4z" }],
		["path", { d: "M1.8 7.1 6 9.5l4.2-2.4" }],
	],
	check: [["path", { d: "M2.6 6.3 4.9 8.7 9.4 3.6" }]],
	light: [
		["circle", { cx: 6, cy: 6, r: 2.5 }],
		["path", { d: "M6 .8v1.5M6 9.7v1.5M.8 6h1.5M9.7 6h1.5M2.4 2.4l1.06 1.06M8.54 8.54l1.06 1.06M9.6 2.4 8.54 3.46M3.46 8.54 2.4 9.6" }],
	],
	dark: [["path", { d: "M10.4 7.4A4.7 4.7 0 1 1 4.6 1.6a3.7 3.7 0 0 0 5.8 5.8z" }]],
	auto: [
		["circle", { cx: 6, cy: 6, r: 4.4 }],
		["path", { d: "M6 1.6a4.4 4.4 0 0 0 0 8.8z", fill: "currentColor", stroke: "none" }],
	],
};

function svgIcon(name, className = "tb-icon") {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 12 12");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("class", className);
	for (const [tag, attrs] of ICONS[name] ?? []) {
		const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
		for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
		svg.appendChild(node);
	}
	return svg;
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

function loadPrefs() {
	try {
		const raw = localStorage.getItem(LS_FILTERS);
		// 工具不再是开关（走子菜单），旧存档里若被关掉要强制打开
		if (raw) state.filters = { ...presetFilters("all"), ...JSON.parse(raw), tools: true };
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

function loadTranslatePrefs() {
	try {
		const saved = JSON.parse(localStorage.getItem(LS_TRANSLATE) ?? "null");
		if (saved && typeof saved === "object") {
			if (TRANSLATE_SERVICES.some(([v]) => v === saved.service)) transPrefs.service = saved.service;
			if (TRANSLATE_LANGS.some(([v]) => v === saved.to)) transPrefs.to = saved.to;
			if (TRANSLATE_MODES.some(([v]) => v === saved.mode)) transPrefs.mode = saved.mode;
		}
	} catch {
		/* 忽略损坏的本地状态 */
	}
}

function saveTranslatePrefs() {
	try {
		localStorage.setItem(LS_TRANSLATE, JSON.stringify(transPrefs));
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
	let scopeText = "";
	if (state.scope === "all") scopeText = "全部项目";
	else if (state.scope === "project") scopeText = "本项目";
	const label = state.sources.find((s) => s.id === state.source)?.label ?? state.source;
	el("scope-badge").textContent = scopeText ? `${label} · ${scopeText}` : label;
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
		meta.totals?.durationMs ? formatDurationMillis(meta.totals.durationMs) : "",
		meta.updatedAt ? `最后更新 ${fmtTime(Date.parse(meta.updatedAt))}` : "",
	];
	el("session-meta").textContent = bits.filter(Boolean).join(" · ");
	el("session-meta").title = meta.file ?? "";
}

// ---------------------------------------------------------------------------
// 会话栏
// ---------------------------------------------------------------------------

/** 当前源的折叠分组集合（按源隔离，切源不串）。 */
function groupSet() {
	if (!state.collapsedGroupsBy[state.source]) state.collapsedGroupsBy[state.source] = new Set();
	return state.collapsedGroupsBy[state.source];
}

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
			// 分组头可点击折叠（deepseek Menu 的 ▸ 箭头语义）：目录名用链接色高亮
		const collapsed = groupSet().has(group.key);
			nodes.push(
				h(
					"button",
					{
						class: "project-head",
						type: "button",
						title: group.key,
						dataset: { group: group.key },
						"aria-expanded": String(!collapsed),
					},
					h("span", { class: "project-chev", "aria-hidden": "true", text: "▸" }),
					h("span", { class: "project-path", text: group.label }),
					h("span", { class: "project-count", text: String(group.sessions.length) }),
				),
			);
			if (!collapsed) for (const session of group.sessions) nodes.push(sessionItem(session));
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
// 工具条（deepseek 工具栏形态：轮次折叠 + 过滤菜单）
// ---------------------------------------------------------------------------

/** 过滤菜单里可开关的类型（工具走子菜单，不是开关）。 */
const TOGGLE_GROUPS = ["user", "thinking", "text", "context"];

/** 过滤菜单：显示类型勾选（照 deepseek Menu 的紧凑卡与选中语义）；工具行是带子菜单入口的行。 */
function renderFilterMenu() {
	const nodes = [h("div", { class: "menu-label", role: "presentation", text: "显示类型" })];
	for (const [group, label] of Object.entries(GROUP_LABELS)) {
		if (group === "tools") {
			// 工具行不再是开关，而是子菜单父行（照 deepseek：menuitem + aria-haspopup，hover/点击进入）
			const row = h(
				"button",
				{
					class: "menu-item",
					type: "button",
					role: "menuitem",
					"aria-haspopup": "menu",
					"aria-expanded": String(state.submenuOpen),
					dataset: { submenu: "tools" },
				},
				svgIcon(group, "menu-item-icon"),
				h("span", { class: "menu-item-label", text: label }),
				h("span", { class: "menu-chev", "aria-hidden": "true", text: "▸" }),
			);
			// 包一层容器：hover 行或子菜单都保持打开（照 deepseek 子菜单的指针桥）
			const wrap = h("div", { class: "menu-item-wrap" }, row, buildToolSubmenu());
			let hoverTimer;
			wrap.addEventListener("mouseenter", () => {
				clearTimeout(hoverTimer);
				hoverTimer = setTimeout(() => setSubmenuOpen(true), 150);
			});
			wrap.addEventListener("mouseleave", () => {
				clearTimeout(hoverTimer);
				hoverTimer = setTimeout(() => setSubmenuOpen(false), 150);
			});
			nodes.push(wrap);
			continue;
		}
		const checked = state.filters[group] !== false;
		nodes.push(
			h(
				"button",
				{ class: "menu-item", type: "button", role: "menuitemcheckbox", "aria-checked": String(checked), dataset: { group } },
				svgIcon(group, "menu-item-icon"),
				h("span", { class: "menu-item-label", text: label }),
				checked ? svgIcon("check", "menu-check") : null,
			),
		);
	}
	el("filter-menu").replaceChildren(...nodes);
}

/** 工具子菜单：全部 + 工具名（按归属分组，空分组不渲染；勾选态 = 未排除）。 */
function buildToolSubmenu() {
	const itemNodes = [submenuItem("", "全部", state.toolExcluded.size === 0)];
	for (const group of groupToolNames(state.toolNames, state.toolOrigins)) {
		itemNodes.push(h("div", { class: "menu-label", role: "presentation", text: group.label }));
		for (const name of group.names) itemNodes.push(submenuItem(name, name, !state.toolExcluded.has(name)));
	}
	// 内层视口承载滚动：卡片本体不设 overflow，保留左侧 10px 命中桥
	return h("div", { class: "menu submenu", id: "tool-submenu", role: "menu", hidden: true }, h("div", { class: "menu-viewport" }, ...itemNodes));
}

/** 拉取工具归属映射（模式 A：pi 精确映射 + 扫描合并；模式 B：静态扫描），缓存 5 分钟；force 跳过缓存。 */
const TOOL_ORIGINS_TTL_MS = 5 * 60_000;
async function ensureToolOrigins(force = false) {
	if (state.toolOriginsLoading) return;
	if (!force && state.toolOriginsAt && Date.now() - state.toolOriginsAt < TOOL_ORIGINS_TTL_MS) return;
	state.toolOriginsLoading = true;
	try {
		const res = await fetch("/api/tool-origins");
		if (res.ok) {
			const payload = await res.json();
			state.toolOrigins = payload.tools ?? {};
			state.toolOriginsAt = Date.now();
		}
	} catch {
		/* 归属不可用时全部落「未识别」 */
	} finally {
		state.toolOriginsLoading = false;
	}
}

function submenuItem(toolName, label, checked) {
	return h(
		"button",
		{ class: "menu-item", type: "button", role: "menuitemcheckbox", "aria-checked": String(checked), dataset: { tool: toolName } },
		h("span", { class: "menu-item-label", text: label }),
		checked ? svgIcon("check", "menu-check") : null,
	);
}

/** 同步工具名列表：新出现的工具（默认勾选）进子菜单，消失的工具从排除集里摘除。 */
function syncToolNames() {
	const names = collectToolNames(state.data?.questions ?? []);
	const changed = names.length !== state.toolNames.length || names.some((name, i) => name !== state.toolNames[i]);
	if (changed) {
		state.toolNames = names;
		for (const name of [...state.toolExcluded]) if (!names.includes(name)) state.toolExcluded.delete(name);
	}
	return changed;
}

function setSubmenuOpen(open, focusFirst = false) {
	const next = state.menuOpen && open;
	state.submenuOpen = next;
	const submenu = el("tool-submenu");
	if (!submenu) return;
	submenu.hidden = !next;
	el("filter-menu").querySelector('button[data-submenu="tools"]')?.setAttribute("aria-expanded", String(next));
	if (next && focusFirst) submenu.querySelector('button[role^="menuitem"]')?.focus();
}

/** 原地更新子菜单勾选态（空集时「全部」勾选）。 */
function updateSubmenuChecks() {
	const submenu = el("tool-submenu");
	if (!submenu) return;
	for (const item of submenu.querySelectorAll('button[role^="menuitem"]')) {
		const name = item.dataset.tool ?? "";
		const checked = name === "" ? state.toolExcluded.size === 0 : !state.toolExcluded.has(name);
		item.setAttribute("aria-checked", String(checked));
		const existing = item.querySelector(".menu-check");
		if (checked && !existing) item.appendChild(svgIcon("check", "menu-check"));
		else if (!checked && existing) existing.remove();
	}
}

/** 原地同步勾选态（不重建 DOM：重建会把点击目标摘出文档，导致文档级监听误判为“点外部”而关菜单）。 */
function syncFilterItems() {
	for (const group of Object.keys(GROUP_LABELS)) {
		if (group === "tools") continue; // 工具行是子菜单入口，不再是开关
		const item = el("filter-menu").querySelector(`button[data-group="${group}"]`);
		if (!item) continue;
		const checked = state.filters[group] !== false;
		item.setAttribute("aria-checked", String(checked));
		const existing = item.querySelector(".menu-check");
		if (checked && !existing) item.appendChild(svgIcon("check", "menu-check"));
		else if (!checked && existing) existing.remove();
	}
}

function updateFilterButton() {
	const groups = TOGGLE_GROUPS;
	const on = groups.filter((g) => state.filters[g] !== false).length;
	el("filter-label").textContent = on === groups.length ? "过滤" : `过滤 ${on}/${groups.length}`;
	el("filter-btn").setAttribute("aria-expanded", String(state.menuOpen));
	el("filter-btn").title = on === groups.length ? "过滤显示的类型" : `过滤显示的类型（当前显示 ${on}/${groups.length}）`;
}

function renderToolbar() {
	renderFilterMenu();
	updateFilterButton();
	updateFoldAll();
}

function setMenuOpen(open) {
	state.menuOpen = open;
	el("filter-menu").hidden = !open;
	el("filter-btn").setAttribute("aria-expanded", String(open));
	if (!open) {
		setSubmenuOpen(false);
		return;
	}
	// 每次打开时同步工具名并重建菜单：会话新出现的工具能进子菜单
	syncToolNames();
	renderFilterMenu();
	el("filter-menu").querySelector('button[role^="menuitem"]')?.focus();
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
		st.durationMs ? formatDurationMillis(st.durationMs) : "",
	]
		.filter(Boolean)
		.join(" · ");
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
		ev.msg?.durationMs !== undefined ? formatDurationMillis(ev.msg.durationMs) : "",
		ev.msg?.usage ? fmtTokens(ev.msg.usage.totalTokens) : "",
		ev.kind === "tool" && ev.tool?.durationMs !== undefined ? formatDurationMillis(ev.tool.durationMs) : "",
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
	const matches = state.searchIndex.search(state.query);
	mainInner.replaceChildren(
		...questions.map((q) => {
			const shown = (q.events ?? []).filter(
				(ev) => eventPasses(state.filters, ev.kind) && eventToolPasses(state.toolExcluded, ev) && (!matches || matches.has(ev.id)),
			);
			const body = shown.length ? shown.map(renderEvent) : h("div", { class: "ev-empty" });
			const folded = state.folded.has(q.index);
			return h(
				"section",
				{ class: `question${folded ? " folded" : ""}`, id: `q-${q.index}`, dataset: { q: String(q.index) } },
				h("header", { class: "q-head", title: folded ? "双击展开本轮" : "双击收起本轮" },
					h("button", {
						class: "q-fold",
						type: "button",
						dataset: { fold: String(q.index) },
						title: folded ? "展开本轮" : "收起本轮",
						"aria-expanded": String(!folded),
						text: folded ? "⊞" : "⊟",
					}),
					h("span", { class: "q-no", text: q.index < 0 ? "会话开始" : `第 ${q.index + 1} 轮` }),
					h("span", { class: "q-time", text: fmtTime(q.ts) || "" }),
					h("span", { class: "q-sum", title: q.summary, text: q.summary }),
					h("span", { class: "q-stats", text: qStats(q) }),
				),
				h("div", { class: "q-body" }, body),
			);
		}),
	);
	updateFoldAll();
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
	if (view.msg?.durationMs !== undefined) nodes.push(chipNode("耗时", formatDurationMillis(view.msg.durationMs)));
	if (view.msg?.usage) nodes.push(chipNode("用量", usageText(view.msg.usage)));
	if (view.msg?.stopReason) nodes.push(chipNode("结束", view.msg.stopReason));
	if (view.thinkingLevel?.level) nodes.push(chipNode("思考等级", view.thinkingLevel.level));
	if (view.modelChange) nodes.push(chipNode("切换到", `${view.modelChange.provider ?? "?"}/${view.modelChange.modelId ?? "?"}`));
	if (view.tool?.durationMs !== undefined) nodes.push(chipNode("工具耗时", formatDurationMillis(view.tool.durationMs)));
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
					n.durationMs ? ` · ${formatDurationMillis(n.durationMs)}` : "",
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
					// sys-text 标记：提示词段落可翻译（与工具参数/结果、bash 输出的 pre 区分）
					isFull && typeof s.text === "string" ? preNode(s.text, "wrap sys-text") : muted("加载全文中…"),
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

/** details 的稳定键：优先 summary 里 code 的名称（如提示词段落名），否则 summary 文本。 */
function detailKey(d) {
	return d.querySelector("summary code")?.textContent ?? d.querySelector("summary")?.textContent ?? "";
}

/** 重建抽屉内容；keepState=true 时保留滚动位置与各 <details> 展开态（轮询/全文到达不打断阅读）。 */
function renderDrawer(keepState = false) {
	const light = state.openId ? findEvent(state.openId) : null;
	if (!light) {
		drawer.hidden = true;
		return;
	}
	const full = state.openFull && state.openFull.id === light.id ? state.openFull : null;
	const view = full ?? light;
	transSeq++;
	resetTranslateUi();
	const body = el("dv-body");
	const prevScroll = keepState ? body.scrollTop : 0;
	const openKeys = keepState ? new Set([...body.querySelectorAll("details[open]")].map(detailKey)) : null;
	el("dv-kind").textContent = eventTagLabel(light);
	el("dv-kind").className = `dv-kind k-${kindGroup(light.kind)}`;
	el("dv-title").textContent = light.preview;
	el("dv-meta").replaceChildren(...drawerMetaNodes(view, light));
	body.replaceChildren(...drawerBodyNodes(view));
	if (openKeys) for (const d of body.querySelectorAll("details")) if (openKeys.has(detailKey(d))) d.open = true;
	body.scrollTop = prevScroll;
	drawer.hidden = false;
}

async function loadFull(id) {
	try {
		const params = new URLSearchParams({ id });
		if (state.selectedId) params.set("session", state.selectedId);
		params.set("source", state.source);
		const res = await fetch(`/api/event?${params}`);
		if (!res.ok) return;
		const j = await res.json();
		if (state.openId !== id || !j.event) return;
		state.openFull = j.event;
		renderDrawer(true);
	} catch {
		/* 网络失败时保持 light 展示 */
	}
}

function openDrawer(id) {
	state.openId = id;
	state.openFull = null;
	const light = findEvent(id);
	state.openLightJson = JSON.stringify(light ?? null);
	renderDrawer();
	if (light?.truncated) loadFull(id);
	writeViewHash();
}

function refreshOpen() {
	if (!state.openId) return;
	const light = findEvent(state.openId);
	if (!light) {
		state.openId = null;
		state.openFull = null;
		state.openLightJson = "";
		drawer.hidden = true;
		writeViewHash();
		return;
	}
	// 事件内容没变就完全不动 DOM：轮询期间不打断阅读（展开的段落、滚动位置、已加载全文都保留）
	const json = JSON.stringify(light);
	if (json === state.openLightJson) {
		// 全文尚未到手（如上次拉取失败）则继续尝试；成功后 renderDrawer(true) 保留展开态
		if (!state.openFull && light.truncated) loadFull(light.id);
		return;
	}
	state.openLightJson = json;
	state.openFull = null;
	renderDrawer(true);
	if (light.truncated) loadFull(light.id);
}

function closeDrawer() {
	state.openId = null;
	state.openFull = null;
	state.openLightJson = "";
	drawer.hidden = true;
	transSeq++;
	setSettingsOpen(false);
	setCopyMenuOpen(false);
	writeViewHash();
}

// ---------------------------------------------------------------------------
// 视图位置（URL hash）：#s=<会话id>&e=<事件id> —— 刷新不丢详情抽屉。
// 事件 id 仅会话内唯一，必须连同会话一起记录；用 replaceState 不产生历史记录。
// ---------------------------------------------------------------------------

function readViewHash() {
	if (!location.hash) return null;
	const params = new URLSearchParams(location.hash.slice(1));
	const a = params.get("a");
	const s = params.get("s");
	const e = params.get("e");
	if (!a && !s) return null;
	return { a: a || "pi", s, e: s ? e : null };
}

function writeViewHash() {
	const parts = [`a=${encodeURIComponent(state.source)}`];
	if (state.selectedId) parts.push(`s=${encodeURIComponent(state.selectedId)}`);
	if (state.openId && state.selectedId) parts.push(`e=${encodeURIComponent(state.openId)}`);
	const hash = state.selectedId || state.openId ? `#${parts.join("&")}` : "";
	if (location.hash !== hash) history.replaceState(null, "", hash || `${location.pathname}${location.search}`);
}

// ---------------------------------------------------------------------------
// Agent 选择栏（最左竖条）：每个按钮一个轨迹源；源由 /api/sources 列出（存在才显示）
// ---------------------------------------------------------------------------

const SOURCE_BADGE = { pi: "π", codex: "Codex" };

async function pollSources() {
	try {
		const res = await fetch("/api/sources");
		if (!res.ok) return;
		const j = await res.json();
		const sources = j.sources ?? [];
		if (JSON.stringify(sources) !== JSON.stringify(state.sources)) {
			state.sources = sources;
			renderRail();
			renderTopbar();
		}
		// hash 恢复的源或当前源失效时回落到第一个可用源
		if (sources.length && !sources.some((s) => s.id === state.source)) switchSource(sources[0].id);
	} catch {
		/* 源列表失败不打断主循环 */
	}
}

function renderRail() {
	el("agent-rail").replaceChildren(
		...state.sources.map((s) =>
			h(
				"button",
				{
					class: `rail-btn${s.id === state.source ? " active" : ""}`,
					type: "button",
					title: `${s.label}（${s.sessions} 会话）`,
					dataset: { source: s.id },
					"aria-pressed": String(s.id === state.source),
					},
				h("span", { class: `rail-badge${(SOURCE_BADGE[s.id] ?? s.label.slice(0, 1)).length > 2 ? " small" : ""}`, "aria-hidden": "true", text: SOURCE_BADGE[s.id] ?? s.label.slice(0, 1) }),
			),
		),
	);
}

/** 切换轨迹源：每源独立的选中会话与折叠状态（分桶保存/恢复），临时态清空重拉。 */
function switchSource(id) {
	if (id === state.source || !id) return;
	state.sourceSel[state.source] = state.selectedId;
	state.source = id;
	state.selectedId = state.sourceSel[id] ?? null;
	state.data = null;
	state.etag = null;
	state.sessions = [];
	state.sessionListKey = "";
	state.folded = new Set();
	state.query = "";
	el("search").value = "";
	state.toolExcluded = new Set();
	state.toolNames = [];
	state.searchIndex = new TrajectorySearchIndex();
	closeDrawer();
	renderRail();
	renderTopbar();
	renderSessions();
	pollSessions(true);
	pollSession(true);
	writeViewHash();
}

// ---------------------------------------------------------------------------
// 抽屉工具栏：翻译（/api/translate 免费通道）/ 设置（目标语言、显示方式）
// ---------------------------------------------------------------------------

const TRANSLATE_SERVICES = [
	["google", "Google"],
	["bing", "微软（Bing）"],
];
const TRANSLATE_LANGS = [
	["zh-CN", "中文（简体）"],
	["zh-TW", "中文（繁體）"],
	["en", "English"],
	["ja", "日本語"],
];
const TRANSLATE_MODES = [
	["bilingual", "双语对照"],
	["only", "仅译文"],
];
const TRANS_BLOCK = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dd, dt";
let transPrefs = { service: "bing", to: "zh-CN", mode: "bilingual" };
let transSeq = 0; // 每次翻译/重建/关闭递增，过期响应丢弃

/** 收集可翻译块：.md 内最外层文本块（容器块去重、代码占比 >1/3 跳过）＋ 提示词段落的 pre（sys-text，纯文本提示词不套代码占比规则）。 */
function translatableBlocks() {
	const blocks = [];
	for (const md of el("dv-body").querySelectorAll(".md")) {
		for (const node of md.querySelectorAll(TRANS_BLOCK)) {
			if (node.querySelector(TRANS_BLOCK)) continue;
			const text = node.textContent.trim();
			if (text.length < 2 || !/\p{L}/u.test(text)) continue;
			let codeChars = 0;
			for (const c of node.querySelectorAll("code, pre")) codeChars += c.textContent.length;
			if (codeChars * 3 > text.length) continue;
			blocks.push({ node, text });
		}
	}
	for (const pre of el("dv-body").querySelectorAll("pre.sys-text")) {
		const text = pre.textContent.trim();
		if (text.length < 2 || !/\p{L}/u.test(text)) continue;
		blocks.push({ node: pre, text });
	}
	return blocks;
}

function resetTranslateUi() {
	state.translated = false;
	state.translating = false;
	const btn = el("dv-translate");
	btn.disabled = false;
	btn.setAttribute("aria-pressed", "false");
	btn.title = "翻译正文（再次点击恢复原文）";
}

function restoreTranslation() {
	const body = el("dv-body");
	for (const t of body.querySelectorAll(".md-trans")) t.remove();
	for (const src of body.querySelectorAll(".md [hidden]")) src.hidden = false;
	resetTranslateUi();
}

/** 翻译按钮瞬时反馈：字符闪一下后恢复（不占用状态位，失败/无正文不静默）。 */
let transFlashTimer = 0;
function flashTranslate(char) {
	const btn = el("dv-translate");
	clearTimeout(transFlashTimer);
	btn.replaceChildren(h("span", { "aria-hidden": "true", text: char }));
	transFlashTimer = setTimeout(() => btn.replaceChildren(h("span", { "aria-hidden": "true", text: "译" })), 1200);
}

async function translateDrawer() {
	if (state.translating || !state.openId) return;
	if (state.translated) {
		restoreTranslation();
		return;
	}
	// 正文被截断且全文未到手时先等全文：否则全文到达重建正文区，在途翻译会被 seq 守卫丢弃（表现为点了没反应）
	const wantId = state.openId;
	const light0 = findEvent(wantId);
	if (light0?.truncated && (!state.openFull || state.openFull.id !== wantId)) await loadFull(wantId);
	if (state.openId !== wantId || !findEvent(wantId)) return;
	// 超长段（>20000 字符，如整页提示词/大文档）单独跳过：一段超限会让整批 400，全部翻译失败
	const blocks = translatableBlocks().filter((b) => b.text.length <= 20_000);
	if (blocks.length === 0) {
		el("dv-translate").title = "没有可翻译的正文（工具结果/命令输出/加密思维/超长段落不可翻）";
		flashTranslate("∅");
		return;
	}
	const seq = ++transSeq;
	state.translating = true;
	el("dv-translate").disabled = true;
	try {
		// 服务端单次限 40 段：正文 + 提示词段落可能超限，分批请求后拼接（保持顺序）
		const texts = [];
		for (let i = 0; i < blocks.length; i += 40) {
			const res = await fetch("/api/translate", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ q: blocks.slice(i, i + 40).map((b) => b.text), to: transPrefs.to, service: transPrefs.service }),
			});
			const j = await res.json().catch(() => null);
			if (!res.ok || !Array.isArray(j?.texts)) throw new Error(j?.error ?? `HTTP ${res.status}`);
			if (seq !== transSeq) return; // 已切换事件/重建，丢弃过期响应
			texts.push(...j.texts);
		}
		const only = transPrefs.mode === "only";
		blocks.forEach((b, i) => {
			const translated = h(
				"div",
				{ class: "md-trans" },
			h("span", { class: "md-trans-tag", text: "译" }),
			h("span", { class: "md-trans-text", text: String(texts[i] ?? "") }),
			);
			if (only) b.node.hidden = true;
			b.node.after(translated);
		});
		state.translated = true;
		el("dv-translate").setAttribute("aria-pressed", "true");
		flashTranslate("✓");
	} catch (err) {
		// 不再显示状态文字：错误挂悬停提示 + 按钮闪 ✕，避免静默失败
		if (seq === transSeq) {
			el("dv-translate").title = `翻译失败：${err.message}`;
			flashTranslate("✕");
		}
	} finally {
		if (seq === transSeq) {
			state.translating = false;
			el("dv-translate").disabled = false;
		}
	}
}

function renderSettingsMenu() {
	const nodes = [h("div", { class: "menu-label", role: "presentation", text: "翻译服务" })];
	for (const [value, label] of TRANSLATE_SERVICES) {
		nodes.push(
			h(
				"button",
				{ class: "menu-item", type: "button", role: "menuitemradio", "aria-checked": String(transPrefs.service === value), dataset: { service: value } },
				h("span", { class: "menu-item-label", text: label }),
				transPrefs.service === value ? svgIcon("check", "menu-check") : null,
			),
		);
	}
	nodes.push(h("div", { class: "menu-label", role: "presentation", text: "目标语言" }));
	for (const [value, label] of TRANSLATE_LANGS) {
		nodes.push(
			h(
				"button",
				{ class: "menu-item", type: "button", role: "menuitemradio", "aria-checked": String(transPrefs.to === value), dataset: { lang: value } },
				h("span", { class: "menu-item-label", text: label }),
				transPrefs.to === value ? svgIcon("check", "menu-check") : null,
			),
		);
	}
	nodes.push(h("div", { class: "menu-label", role: "presentation", text: "显示" }));
	for (const [value, label] of TRANSLATE_MODES) {
		nodes.push(
			h(
				"button",
				{ class: "menu-item", type: "button", role: "menuitemradio", "aria-checked": String(transPrefs.mode === value), dataset: { mode: value } },
				h("span", { class: "menu-item-label", text: label }),
				transPrefs.mode === value ? svgIcon("check", "menu-check") : null,
			),
		);
	}
	el("dv-settings-menu").replaceChildren(...nodes);
}

function setSettingsOpen(open) {
	state.settingsOpen = open;
	el("dv-settings-menu").hidden = !open;
	el("dv-settings").setAttribute("aria-expanded", String(open));
	if (open) renderSettingsMenu();
}

function applyTranslateSetting(patch) {
	if (patch.service) transPrefs.service = patch.service;
	if (patch.lang) transPrefs.to = patch.lang;
	if (patch.mode) transPrefs.mode = patch.mode;
	saveTranslatePrefs();
	renderSettingsMenu();
	// 已翻译时按新设置重翻：先恢复原文再立即重译
	if (state.translated) {
		restoreTranslation();
		void translateDrawer();
	}
}

// ---------------------------------------------------------------------------
// 侧边工具条：弹出/收起 + 复制正文（翻译状态下可选仅译文/全部）
// ---------------------------------------------------------------------------

const LS_SIDETOOL = "tw.sidetool";
let copyFlashTimer = 0;

function setSideOpen(open) {
	const side = el("dv-side");
	side.dataset.open = String(open);
	const toggle = el("dv-side-toggle");
	toggle.replaceChildren(h("span", { "aria-hidden": "true", text: open ? "«" : "»" }));
	toggle.title = open ? "收起工具条" : "展开工具条";
	if (!open) setCopyMenuOpen(false);
	try {
		localStorage.setItem(LS_SIDETOOL, open ? "1" : "0");
	} catch {
		/* 无痕模式等场景忽略 */
	}
}

function setCopyMenuOpen(open) {
	state.copyOpen = open;
	el("dv-copy-menu").hidden = !open;
	el("dv-copy").setAttribute("aria-expanded", String(open));
}

/** 组装复制文本：src = 原文 / trans = 仅译文 / all = 原文＋译文；无 .md 正文时退回整个详情文本。 */
function drawerCopyText(mode) {
	const blocks = translatableBlocks();
	if (blocks.length === 0) return el("dv-body").innerText;
	const parts = [];
	for (const b of blocks) {
		const transNode = b.node.nextElementSibling;
		const trans = transNode?.classList.contains("md-trans") ? (transNode.querySelector(".md-trans-text")?.textContent ?? "") : "";
		if (mode === "src") parts.push(b.text);
		else if (mode === "trans") parts.push(trans || b.text);
		else parts.push([b.text, trans].filter(Boolean).join("\n"));
	}
	return parts.join("\n\n");
}

async function copyDrawer(mode) {
	const btn = el("dv-copy");
	try {
		await navigator.clipboard.writeText(drawerCopyText(mode));
		clearTimeout(copyFlashTimer);
		btn.replaceChildren(h("span", { "aria-hidden": "true", text: "✓" }));
		copyFlashTimer = setTimeout(() => btn.replaceChildren(h("span", { "aria-hidden": "true", text: "⧉" })), 1200);
	} catch (err) {
		btn.title = `复制失败：${err.message}`;
	}
}

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------

async function pollSessions(force = false) {
	if (state.pollingSessions) return;
	state.pollingSessions = true;
	try {
		const qs = new URLSearchParams({ source: state.source });
		if (force) qs.set("t", String(Date.now()));
		const res = await fetch(`/api/sessions?${qs}`);
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
		params.set("source", state.source);
		if (state.selectedId) params.set("id", state.selectedId);
		if (!force && state.etag) params.set("v", state.etag);
		const res = await fetch(`/api/session?${params}`);
		if (res.status === 404) {
			state.selectedId = null;
			state.data = null;
			state.etag = null;
			pendingOpen = null;
			writeViewHash();
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
		state.searchIndex.update(state.data.questions);
		const namesChanged = syncToolNames();
		if (state.menuOpen && namesChanged) renderFilterMenu();
		// 出现未归属的工具名（如运行时才注册的扩展工具）时强制刷新映射；持续未识别时 60s 内不重试
		const hasUnknown = state.toolNames.some((name) => !state.toolOrigins[name] && !mcpLabel(name));
		if (hasUnknown && Date.now() - state.toolOriginsMissAt > 60_000) {
			state.toolOriginsMissAt = Date.now();
			void ensureToolOrigins(true).then(() => {
				if (state.menuOpen) renderFilterMenu();
			});
		}
		state.etag = j.etag;
		if (j.sessionId && j.sessionId !== state.selectedId) {
			state.selectedId = j.sessionId;
			renderSessions();
		}
		const keepTop = main.scrollTop;
		renderTopbar();
		renderMain();
		main.scrollTop = keepTop;
		refreshOpen();
		// 刷新恢复：首次数据就绪后重开 hash 记录的事件；事件已不在会话里则清掉失效 hash
		if (pendingOpen) {
			const id = pendingOpen;
			pendingOpen = null;
			if (findEvent(id)) openDrawer(id);
			else writeViewHash();
		}
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

el("filter-btn").addEventListener("click", (e) => {
	// 只负责打开：菜单靠点外部或 Esc 关闭，方便连续调整多项
	e.stopPropagation();
	if (state.menuOpen) return;
	setMenuOpen(true);
	// 归属映射过期/缺失时刷新，到货后重建菜单（分组表头随之更新）
	void ensureToolOrigins().then(() => {
		if (state.menuOpen) renderFilterMenu();
	});
});

el("filter-menu").addEventListener("click", (e) => {
	e.stopPropagation();
	const item = e.target.closest('button[role^="menuitem"]');
	if (!item) return;
	if (item.dataset.submenu === "tools") {
		setSubmenuOpen(true);
		item.focus();
		return;
	}
	if (item.dataset.tool !== undefined) {
		const name = item.dataset.tool;
		if (name === "") {
			// 全选开关：已全勾 → 全不勾（排除全部）；否则恢复全勾
			if (state.toolExcluded.size === 0) {
				for (const toolName of state.toolNames) state.toolExcluded.add(toolName);
			} else {
				state.toolExcluded.clear();
			}
		} else if (state.toolExcluded.has(name)) state.toolExcluded.delete(name);
		else state.toolExcluded.add(name);
		updateSubmenuChecks();
		renderMain();
		item.focus();
		return;
	}
	if (item.dataset.group) {
		const group = item.dataset.group;
		state.filters[group] = state.filters[group] === false;
		saveFilters();
		syncFilterItems();
		updateFilterButton();
		renderMain();
		item.focus();
	}
});

// 菜单键盘导航（照 deepseek Menu：上下循环 / Home / End / → 进子菜单 / ← 退回 / Escape 关闭）
el("filter-menu").addEventListener("keydown", (e) => {
	const scope = document.activeElement?.closest('[role="menu"]') ?? el("filter-menu");
	const items = [...scope.querySelectorAll('button[role^="menuitem"]')];
	if (items.length === 0) return;
	const index = items.indexOf(document.activeElement);
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		const step = e.key === "ArrowDown" ? 1 : -1;
		items[(index + step + items.length) % items.length].focus();
		return;
	}
	if (e.key === "Home" || e.key === "End") {
		e.preventDefault();
		items[e.key === "Home" ? 0 : items.length - 1].focus();
		return;
	}
	if (e.key === "ArrowRight") {
		if (scope === el("filter-menu") && document.activeElement?.dataset?.submenu === "tools") {
			e.preventDefault();
			setSubmenuOpen(true, true);
		}
		return;
	}
	if (e.key === "ArrowLeft") {
		if (scope !== el("filter-menu")) {
			e.preventDefault();
			setSubmenuOpen(false);
			el("filter-menu").querySelector('button[data-submenu="tools"]')?.focus();
		}
		return;
	}
	if (e.key === "Escape") {
		e.preventDefault();
		e.stopPropagation();
		if (scope !== el("filter-menu")) {
			setSubmenuOpen(false);
			el("filter-menu").querySelector('button[data-submenu="tools"]')?.focus();
			return;
		}
		setMenuOpen(false);
		el("filter-btn").focus();
	}
});

// 点击菜单外关闭（用 composedPath 判断：节点可能在派发过程中被替换）
document.addEventListener("click", (e) => {
	if (!state.menuOpen) return;
	const path = typeof e.composedPath === "function" ? e.composedPath() : [];
	if (path.some((node) => node instanceof Element && node.id === "filter-root")) return;
	if (e.target.closest?.("#filter-root")) return;
	setMenuOpen(false);
});

el("search").addEventListener("input", (e) => {
	state.query = e.target.value;
	renderMain();
});

el("fold-all").addEventListener("click", () => {
	const indexes = foldableQuestions();
	const allFolded = indexes.length > 0 && indexes.every((i) => state.folded.has(i));
	state.folded = new Set(allFolded ? [] : indexes);
	renderMain();
});

sessionList.addEventListener("click", (e) => {
	const head = e.target.closest(".project-head");
	if (head) {
		const key = head.dataset.group ?? "";
		const set = groupSet();
		if (set.has(key)) set.delete(key);
		else set.add(key);
		renderSessions();
		return;
	}
	const item = e.target.closest(".session-item");
	if (!item || item.dataset.id === state.selectedId) return;
	state.selectedId = item.dataset.id;
	state.data = null;
	state.etag = null;
	state.folded = new Set();
	state.query = "";
	state.toolExcluded = new Set();
	state.toolNames = [];
	state.searchIndex = new TrajectorySearchIndex();
	setMenuOpen(false);
	el("search").value = "";
	state.openId = null;
	state.openFull = null;
	drawer.hidden = true;
	writeViewHash();
	renderSessions();
	renderTopbar();
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

mainInner.addEventListener("dblclick", (e) => {
	if (e.target.closest(".q-fold")) return;
	const head = e.target.closest(".q-head");
	if (!head) return;
	const index = Number(head.parentElement?.dataset.q);
	if (Number.isNaN(index)) return;
	if (state.folded.has(index)) state.folded.delete(index);
	else state.folded.add(index);
	renderMain();
});

el("agent-rail").addEventListener("click", (e) => {
	const btn = e.target.closest(".rail-btn");
	if (btn) switchSource(btn.dataset.source);
});
el("drawer-close").addEventListener("click", closeDrawer);
el("dv-side-toggle").addEventListener("click", () => setSideOpen(el("dv-side").dataset.open !== "true"));
el("dv-translate").addEventListener("click", () => void translateDrawer());
el("dv-copy").addEventListener("click", (e) => {
	e.stopPropagation();
	// 已翻译时弹菜单选「仅译文/全部」，否则一键复制原文
	if (state.translated) setCopyMenuOpen(!state.copyOpen);
	else void copyDrawer("src");
});
el("dv-copy-menu").addEventListener("click", (e) => {
	e.stopPropagation();
	const item = e.target.closest("button[data-copy]");
	if (!item) return;
	setCopyMenuOpen(false);
	void copyDrawer(item.dataset.copy);
});
el("dv-settings").addEventListener("click", (e) => {
	e.stopPropagation();
	setSettingsOpen(!state.settingsOpen);
});
el("dv-settings-menu").addEventListener("click", (e) => {
	e.stopPropagation();
	const item = e.target.closest("button[data-service], button[data-lang], button[data-mode]");
	if (!item) return;
	if (item.dataset.service) applyTranslateSetting({ service: item.dataset.service });
	else if (item.dataset.lang) applyTranslateSetting({ lang: item.dataset.lang });
	else if (item.dataset.mode) applyTranslateSetting({ mode: item.dataset.mode });
});
el("theme-btn").addEventListener("click", cycleTheme);
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		if (state.copyOpen) {
			setCopyMenuOpen(false);
			return;
		}
		if (state.settingsOpen) {
			setSettingsOpen(false);
			return;
		}
		closeDrawer();
	}
});
// 点击侧条菜单（设置/复制）外关闭（照过滤菜单的 composedPath 判断）
document.addEventListener("click", (e) => {
	if (!state.settingsOpen && !state.copyOpen) return;
	const path = typeof e.composedPath === "function" ? e.composedPath() : [];
	const inside = (id) => path.some((node) => node instanceof Element && node.id === id) || e.target.closest?.(`#${id}`);
	if (state.settingsOpen && !inside("dv-settings-root")) setSettingsOpen(false);
	if (state.copyOpen && !inside("dv-copy-root")) setCopyMenuOpen(false);
});
// 回到前台立即同步一次（标签页隐藏期间轮询暂停；走 etag 增量，未变则开销极小）
document.addEventListener("visibilitychange", () => {
	if (document.hidden) return;
	pollSessions();
	pollSession();
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

// hash 恢复：a= 源 + s= 会话 + e= 事件；源待 /api/sources 到达后校验回落
let pendingOpen = null;
const restoredView = readViewHash();
if (restoredView) {
	state.source = restoredView.a;
	if (restoredView.s) {
		state.selectedId = restoredView.s;
		pendingOpen = restoredView.e;
	}
}

loadTheme();
applyTheme();
renderThemeButton();
loadPrefs();
loadTranslatePrefs();
try {
	if (localStorage.getItem(LS_SIDETOOL) === "0") setSideOpen(false);
} catch {
	/* 无痕模式等场景忽略 */
}
renderToolbar();
void ensureToolOrigins();
void pollSources();
pollSessions();
pollSession();
setInterval(() => {
	if (document.hidden) return;
	state.tick++;
	if (state.tick % SESSION_LIST_EVERY === 0) pollSessions();
	if (state.tick % 30 === 0) void pollSources(); // 约 60s 刷新源列表
	pollSession();
}, POLL_MS);
