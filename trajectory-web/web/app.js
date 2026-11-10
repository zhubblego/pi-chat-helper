/**
 * app.js — 轨迹观察页：左侧会话栏，右侧轨迹（按轮次分段，工具条过滤/折叠）；
 * 点轨迹行在行下方内联展开详情面板（工具条随面板作用于当前行）；
 * 顶栏按钮开关右侧对话栏（对话栏接 pi 子进程，SSE 流式）。
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
	DERIVE_TOOL,
	GROUP_LABELS,
	TrajectorySearchIndex,
	allToolsIncluded,
	collectToolNames,
	deriveInfo,
	deriveTargets,
	deriveTaskName,
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
	highlightSegments,
	hitSnippet,
	kindGroup,
	mcpLabel,
	presetFilters,
	renderMarkdown,
	taskShort,
	toggleAllTools,
} from "./lib.js";
import { chatSessionRef, consoleStatusLabel, pruneContextIds } from "./chat-lib.js";
import { initChatPanel } from "./chat.js";
import { clearLegacyGlobalPrefs, normalizeGlobalPrefs, normalizeToolsPrefs, readLegacyGlobalPrefs } from "./prefs.js";
import { loadSessionPrefs, updateSessionPrefs } from "./session-prefs.js";

const POLL_MS = 2000;
const SESSION_LIST_EVERY = 3; // 每 3 个 tick 刷一次会话列表（约 6s）

const el = (id) => document.getElementById(id);
const main = el("main");
const mainInner = el("main-inner");
const sessionList = el("session-list");
const panel = el("ev-panel");

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
	toolExcludeAll: false,
	toolNames: [],
	toolOrigins: {},
	toolOriginsAt: 0,
	toolOriginsLoading: false,
	toolOriginsMissAt: 0,
	submenuOpen: false,
	folded: new Set(),
	// 整轮裁剪（轮序号）：模型上下文真的剔掉
	hiddenQs: new Set(),
	// 行级选中（对话/蒸馏模式下共享的上下文选择；轮头勾选态由它派生）
	selectedEvs: new Set(),
	// 当前选中集对应的 source:session 键（切会话时重载 session_ui.contextIds）
	chatCtxKey: null,
	// 单条裁剪（entry id）：模型上下文真的剔掉
	croppedEntries: new Set(),
	// 裁剪模式：只在开态时列表里才出现剪刀按钮；裁剪结果与它无关（服务端持久化）
	cropMode: false,
	// 蒸馏模式：只在开态时列表里才出现 checkbox（选中与裁剪是两套业务）
	distillMode: false,
	// 模型上下文编辑（模式 A）：是否可写 + 扩展当前会话已裁剪的轮（轮首 user entry id）
	canContextEdit: false,
	// 单条裁剪可写（模式 A 注入 onCropEntry）
	canCropEntry: false,
	hiddenUserIds: new Set(),
	deriveTargets: new Map(),
	deriveNames: new Map(),
	deriveFrom: null,
	revealEid: null,
	source: "pi",
	sources: [],
	sourceSel: {},
	collapsedGroupsBy: {},
	openId: null,
	openFull: null,
	openLightJson: "",
	// 「对话」侧栏的本地消息流已移除：由 chat.js 接管（SSE + 服务端线程）
	chatOpen: false,
	translated: false,
	translating: false,
	settingsOpen: false,
	copyOpen: false,
	pollingSession: false,
	pollingSessions: false,
	// 控制台桥状态：key = `${source}:${sessionId}`；与 live 文件活跃度分开
	consoles: new Map(),
	consolesSource: null,
	consolesKey: "",
	pollingConsoles: false,
	tick: 0,
};

// 全局偏好：S2 起服务端 /api/prefs 是唯一真源；localStorage 只由 prefs.js 一次性迁移读取。
// 会话偏好：S3 起 session-prefs.js 管理 session_ui；旧 tw.chat* 只做一次性迁移。
const GLOBAL_PREF_SAVE_MS = 120;
let globalPrefs = {
	theme: "system",
	filters: presetFilters("all"),
	tools: { excluded: [], excludeAll: false },
	translate: { service: "bing", to: "zh-CN", mode: "bilingual" },
	chatOpen: false,
	chatWidth: 0,
	composerHeight: 0,
};
let prefsRevision = 0;
let prefsAvailable = false;
let prefsSaveTimer = null;
let pendingPrefsPatch = {};

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

function renderThemeButton() {
	const btn = el("theme-btn");
	btn.replaceChildren(svgIcon(themePref === "system" ? "auto" : themePref));
	const title = `主题：${THEME_LABEL[themePref]}（点击切换）`;
	btn.title = title;
	btn.setAttribute("aria-label", title);
}

function cycleTheme() {
	themePref = THEMES[(THEMES.indexOf(themePref) + 1) % THEMES.length];
	queueGlobalPrefs({ theme: themePref });
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

/** 搜索分词（与索引查询一致）；空查询返回空数组表示不高亮。 */
function searchTerms() {
	return state.query.trim() ? state.query.trim().split(/\s+/) : [];
}

function preNode(text, extraClass = "", terms = []) {
	// terms 非空时命中关键词高亮（与列表行一致，词埋在长 JSON/输出里时一眼可见）
	return h(
		"pre",
		{ class: `code${extraClass ? ` ${extraClass}` : ""}` },
		...highlightNodes(String(text ?? ""), terms),
	);
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
	derive: [
		["circle", { cx: 3, cy: 2.6, r: 1.3 }],
		["circle", { cx: 9, cy: 2.6, r: 1.3 }],
		["circle", { cx: 9, cy: 9.4, r: 1.3 }],
		["path", { d: "M4.3 2.6h3.4M9 3.9v4.2" }],
	],
	text: [["path", { d: "M2 3.4h8M2 6h8M2 8.6h5" }]],
	context: [
		["path", { d: "M6 1.7 1.8 4.1 6 6.5l4.2-2.4z" }],
		["path", { d: "M1.8 7.1 6 9.5l4.2-2.4" }],
	],
	check: [["path", { d: "M2.6 6.3 4.9 8.7 9.4 3.6" }]],
	// 剪刀：两个圆环把手 + 交叉刀刃（行/轮次的隐藏按钮）
	scissors: [
		["circle", { cx: 3, cy: 9.2, r: 1.7 }],
		["circle", { cx: 9, cy: 9.2, r: 1.7 }],
		["path", { d: "M4.15 8.05 9.3 2.2M7.85 8.05 2.7 2.2" }],
	],
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

function applyFiltersPref(value) {
	const saved = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	state.filters = { ...presetFilters("all"), ...saved, tools: true };
}

function applyToolsPref(value) {
	const saved = normalizeToolsPrefs(value);
	state.toolExcluded = new Set(saved.excluded);
	state.toolExcludeAll = saved.excludeAll;
}

function applyTranslatePref(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	if (TRANSLATE_SERVICES.some(([v]) => v === value.service)) transPrefs.service = value.service;
	if (TRANSLATE_LANGS.some(([v]) => v === value.to)) transPrefs.to = value.to;
	if (TRANSLATE_MODES.some(([v]) => v === value.mode)) transPrefs.mode = value.mode;
}

function applyGlobalPrefs(global) {
	const normalized = normalizeGlobalPrefs(global);
	if (normalized.filters) applyFiltersPref(normalized.filters);
	if (normalized.tools) applyToolsPref(normalized.tools);
	if (normalized.translate) applyTranslatePref(normalized.translate);
	if (normalized.theme) themePref = normalized.theme;
	if (typeof normalized.chatOpen === "boolean") globalPrefs.chatOpen = normalized.chatOpen;
	if (normalized.chatWidth !== undefined) globalPrefs.chatWidth = normalized.chatWidth;
	if (normalized.composerHeight !== undefined) globalPrefs.composerHeight = normalized.composerHeight;
	globalPrefs = { ...globalPrefs, ...normalized };
	applyTheme();
	renderThemeButton();
}

/** 局部更新内存状态并防抖写 `/api/prefs`；服务端不可用时只保留当前页面状态。 */
function queueGlobalPrefs(patch) {
	const normalized = normalizeGlobalPrefs(patch);
	if (Object.keys(normalized).length === 0) return;
	globalPrefs = { ...globalPrefs, ...normalized };
	if (!prefsAvailable) return;
	pendingPrefsPatch = { ...pendingPrefsPatch, ...normalized };
	if (prefsSaveTimer) clearTimeout(prefsSaveTimer);
	prefsSaveTimer = setTimeout(() => {
		prefsSaveTimer = null;
		void flushGlobalPrefs();
	}, GLOBAL_PREF_SAVE_MS);
}

async function flushGlobalPrefs(keepalive = false) {
	if (prefsSaveTimer) {
		clearTimeout(prefsSaveTimer);
		prefsSaveTimer = null;
	}
	if (!prefsAvailable) {
		pendingPrefsPatch = {};
		return;
	}
	const patch = pendingPrefsPatch;
	pendingPrefsPatch = {};
	if (Object.keys(patch).length === 0) return;
	try {
		const res = await fetch("/api/prefs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ global: patch }),
			keepalive,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const saved = await res.json();
		prefsRevision = Number(saved.revision) || prefsRevision;
	} catch (err) {
		pendingPrefsPatch = { ...patch, ...pendingPrefsPatch };
		console.error(`[prefs] 偏好保存失败：${err.message}`);
	}
}

async function initGlobalPrefs() {
	let loaded = null;
	try {
		const res = await fetch("/api/prefs", { headers: { accept: "application/json" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		loaded = await res.json();
		prefsRevision = Number(loaded?.revision) || 0;
		prefsAvailable = true;
	} catch {
		loaded = null;
		prefsAvailable = false;
	}

	// 服务端 revision=0 才导入旧 Origin 的全局键；已有状态时旧值一律忽略。
	if (loaded && prefsRevision === 0) {
		const legacy = readLegacyGlobalPrefs();
		if (Object.keys(legacy).length) {
			try {
				const res = await fetch("/api/prefs", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ global: legacy }),
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const saved = await res.json();
				prefsRevision = Number(saved.revision) || 1;
				loaded = { ...loaded, global: saved.global };
				clearLegacyGlobalPrefs();
			} catch {
				prefsAvailable = false;
				loaded = { ...loaded, global: { ...(loaded.global ?? {}), ...legacy } };
			}
		}
	}
	applyGlobalPrefs(loaded?.global ?? {});
}

function saveFilters() {
	queueGlobalPrefs({ filters: state.filters });
}

function saveTranslatePrefs() {
	queueGlobalPrefs({ translate: transPrefs });
}

function saveToolsPrefs() {
	queueGlobalPrefs({ tools: { excluded: [...state.toolExcluded], excludeAll: state.toolExcludeAll } });
}

// 页面关闭时把最后一个防抖窗口内的改动带出去（服务端可用时）。
window.addEventListener("pagehide", () => {
	if (prefsSaveTimer) {
		clearTimeout(prefsSaveTimer);
		prefsSaveTimer = null;
	}
	if (prefsAvailable && Object.keys(pendingPrefsPatch).length) void flushGlobalPrefs(true);
});

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
	const consoleInfo = state.consoles.get(`${state.source}:${session.id}`);
	const consoleState = consoleInfo?.state;
	const consoleLabel = consoleStatusLabel(consoleState);
	return h(
		"button",
		{ class: `session-item${session.id === state.selectedId ? " active" : ""}`, dataset: { id: session.id }, title: session.file ?? "" },
		h(
			"span",
			{ class: "session-title" },
			session.live ? h("span", { class: "live-dot" }) : null,
			consoleState
				? h("span", {
						class: `console-badge is-${consoleState}`,
						role: "img",
						"aria-label": consoleLabel,
						title: `${consoleLabel}${consoleInfo.pid ? `（PID ${consoleInfo.pid}）` : ""}`,
					})
				: null,
			h("span", { class: "session-name", text: title }),
		),
		h("span", { class: "session-time", text: fmtRelative(session.modified) }),
		h("span", { class: "session-sub", text: sub }),
	);
}

/** 会话列表可见集：codex 源隐藏子 agent 会话与 Guardian 审批线程（固定主线）。 */
function visibleSessions() {
	if (state.source !== "codex") return state.sessions;
	return state.sessions.filter((s) => s.threadSource !== "subagent" && s.threadSource !== "guardian_review");
}

/** 当前可见的分组 key（只有 all 范围按项目分组；本项目范围是平铺列表）。 */
function groupKeys() {
	if (state.scope !== "all") return [];
	return groupSessions(visibleSessions()).map((group) => group.key);
}

/** 同步表头的分组总开关：没有项目分组（本项目范围）时置灰但仍显示标题，全部收起时显示折叠态。 */
function updateGroupsToggle() {
	const btn = el("groups-toggle");
	const keys = groupKeys();
	const hasGroups = keys.length > 0;
	btn.disabled = !hasGroups;
	const collapsedCount = keys.filter((key) => groupSet().has(key)).length;
	const expanded = !hasGroups || collapsedCount < keys.length;
	btn.setAttribute("aria-expanded", String(expanded));
	let label = "本项目范围没有项目分组";
	if (hasGroups) label = expanded ? "收起所有分组" : "展开所有分组";
	btn.title = label;
	btn.querySelector(".section-chev").textContent = expanded ? "▾" : "▸";
}

function renderSessions() {
	const sessions = visibleSessions();
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
	updateGroupsToggle();
	updateDeriveButtons();
}

// ---------------------------------------------------------------------------
// 派生行（codex）：spawn_agent 调用 ↔ 派生出的子会话
// 派生不是独立视图：它就是发生那一轮里的一行，点击进入对应子会话轨迹。
// ---------------------------------------------------------------------------

/** 当前会话的任务名（主会话为 /root）：派生行只有短名参数时用它拼完整路径。 */
function currentTaskName() {
	return state.sessions.find((s) => s.id === state.selectedId)?.taskName ?? "/root";
}

/** 当前会话所在派生树：非 codex 源或树下无任务节点时为 null。 */
function currentDeriveInfo() {
	return state.source === "codex" ? deriveInfo(state.sessions, state.selectedId) : null;
}

/** 同步「⟨ 主会话」按钮：当前不在树根（派生树某层）或刚从派生行跳过来时出现。 */
function updateDeriveButtons() {
	const info = currentDeriveInfo();
	el("back-main").hidden = !((info && info.path.length > 1) || state.deriveFrom);
}

/** 重算派生行映射：事件 id → 子会话 id、事件 id → 完整任务名（配不上的按普通工具行渲染）。
 * 返回映射是否发生变化（会话列表新增子会话时调用方据此决定要不要重绘轨迹）。 */
function syncDeriveTargets() {
	const previous = state.deriveTargets;
	const names = new Map();
	state.deriveTargets = new Map();
	state.deriveNames = names;
	if (state.source !== "codex") return previous.size > 0;
	const parent = currentTaskName();
	state.deriveTargets = deriveTargets(state.sessions, state.data?.questions, parent);
	for (const q of state.data?.questions ?? []) {
		for (const ev of q.events ?? []) {
			if (ev.kind !== "tool" || ev.tool?.name !== DERIVE_TOOL) continue;
			const name = deriveTaskName(ev, parent);
			if (name) names.set(ev.id, name);
		}
	}
	const changed = previous.size !== state.deriveTargets.size || [...state.deriveTargets].some(([id, target]) => previous.get(id) !== target);
	return changed;
}

/** 返回主会话时定位回派生那一行：滚到视野中央并短暂高亮。 */
function revealEvent(eid) {
	state.revealEid = null;
	const node = mainInner.querySelector(`[data-eid="${eid}"]`);
	if (!node) return;
	// behavior 必须显式 instant：#main 的 scroll-behavior 是 smooth，平滑滚动会被下一次轮询重绘打断（后台标签还会整个卡住）
	node.scrollIntoView({ block: "center", behavior: "instant" });
	node.classList.add("is-revealed");
	setTimeout(() => node.classList.remove("is-revealed"), 1600);
}

// ---------------------------------------------------------------------------
// 过滤面板
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 工具条（deepseek 工具栏形态：轮次折叠 + 过滤菜单）
// ---------------------------------------------------------------------------

/** 过滤菜单里可开关的类型（工具走子菜单，不是开关）。 */
const TOGGLE_GROUPS = ["user", "thinking", "text", "answer", "context", "error", "approval"];

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
	const itemNodes = [submenuItem("", "全部", allToolsIncluded(state.toolNames, state.toolExcluded))];
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
		const res = await fetch(`/api/tool-origins?source=${encodeURIComponent(state.source)}`);
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

/** 同步当前会话可见工具：不删除全局排除集里的未知工具名；excludeAll 下新工具默认排除。 */
function syncToolNames() {
	const names = collectToolNames(state.data?.questions ?? []);
	const changed = names.length !== state.toolNames.length || names.some((name, i) => name !== state.toolNames[i]);
	if (changed) state.toolNames = names;
	// 排除集是全局习惯：当前会话不存在的工具名保留，不在这里清洗。
	let exclusionChanged = false;
	if (state.toolExcludeAll) {
		for (const name of names) {
			if (!state.toolExcluded.has(name)) {
				state.toolExcluded.add(name);
				exclusionChanged = true;
			}
		}
	}
	if (exclusionChanged) saveToolsPrefs();
	return changed || exclusionChanged;
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
		const checked = name === "" ? allToolsIncluded(state.toolNames, state.toolExcluded) : !state.toolExcluded.has(name);
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
	updateCropButton();
	updateDistillButton();
}

/** 裁剪模式开关：只在开态时列表里才出现剪刀；裁剪结果本身与服务端持久化，不受开关影响。 */
function setCropMode(on) {
	state.cropMode = on;
	updateCropButton();
	renderMain();
}

/** 蒸馏模式开关：只在开态时列表里才出现 checkbox（勾选要蒸馏的条目）。 */
function setDistillMode(on) {
	state.distillMode = on;
	updateDistillButton();
	renderMain();
}

/** 仅蒸馏模式显示勾选列；chat 模式 chips 可删不可加。 */
function selectMode() {
	return state.distillMode;
}

function updateCropButton() {
	const btn = el("crop-btn");
	btn.setAttribute("aria-pressed", String(state.cropMode));
	btn.title = state.cropMode ? "退出裁剪模式（已裁剪的保持裁剪）" : "裁剪模式：把对话从模型上下文剪掉";
	// 模式态要看得出来：按钮文字变成「裁剪中」（开态配色见 CSS）
	el("crop-label").textContent = state.cropMode ? "裁剪中" : "裁剪";
}

function updateDistillButton() {
	const btn = el("distill-btn");
	btn.setAttribute("aria-pressed", String(state.distillMode));
	btn.title = state.distillMode ? `退出蒸馏模式（已勾选 ${state.selectedEvs.size} 条）` : "蒸馏模式：勾选要蒸馏的条目";
	el("distill-label").textContent = state.distillMode ? "蒸馏中" : "蒸馏";
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

/** 轮的裁剪态：投影派生（context_edit 整轮剔除）∪ 扩展裁剪集（轮首 user 事件 id 的条目前缀对齐）。 */
function roundCroppedOf(q) {
	if (q?.modelHidden === true) return true;
	if (state.hiddenQs.has(q?.index)) return true;
	const userEv = (q?.events ?? []).find((e) => e.kind === "user");
	return !!(userEv && state.hiddenUserIds.has(String(userEv.id).split(":")[0]));
}

/** 事件所属 entry id（投影事件 id 形如 <entryId>:<blockIndex>）。 */
function entryIdOf(ev) {
	return String(ev?.id ?? "").split(":")[0];
}

/** 单条是否被裁剪：整轮裁剪覆盖所有条目（含被过滤掉的），否则看条目自身。 */
function eventCropped(ev, q) {
	if (roundCroppedOf(q)) return true;
	return state.croppedEntries.has(entryIdOf(ev));
}

/** 轮头勾选态（由条目选中集派生）：all 全选中 / some 部分 / none 未选。 */
function roundSelectedState(q) {
	const ids = (q?.events ?? []).map((ev) => ev.id);
	if (!ids.length) return "none";
	const on = ids.filter((id) => state.selectedEvs.has(id)).length;
	if (on === 0) return "none";
	return on === ids.length ? "all" : "some";
}

/** 轮头 checkbox：全选/取消全选本轮所有条目（含被过滤掉、折叠中的条目）。 */
function toggleRoundSelected(index) {
	const q = (state.data?.questions ?? []).find((x) => x.index === index);
	const ids = (q?.events ?? []).map((ev) => ev.id);
	if (!ids.length) return;
	const all = ids.every((id) => state.selectedEvs.has(id));
	if (all) {
		for (const id of ids) state.selectedEvs.delete(id);
	} else if (!addSelectedIds(ids)) {
		// 超过上限：整轮不动，只提示
		renderMain();
		return;
	}
	saveChatContext();
	chat.onSelectionChanged();
	renderMain();
	updateDistillButton();
}

/**
 * 剪刀（.q-eye）：切换整轮裁剪。可写会话（模式 A 的当前 pi 会话）联动模型上下文：POST /api/context-edit
 * 成功后本地切换视觉并立即拉取（服务端已作废投影缓存）；只读场景退化为纯视觉标记。
 */
async function toggleRoundCrop(index) {
	const q = (state.data?.questions ?? []).find((x) => x.index === index);
	const target = !roundCroppedOf(q);
	if (state.canContextEdit && state.source === "pi" && index >= 0 && q) {
		try {
			const res = await fetch("/api/context-edit", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: "pi", session: state.selectedId, qIndex: index, hidden: target }),
			});
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
		} catch (err) {
			console.error("[trajectory-web] 上下文编辑失败：", err.message);
			setSync(`上下文编辑失败：${err.message}`, "warn");
			return;
		}
		if (target) state.hiddenQs.add(index);
		else state.hiddenQs.delete(index);
		renderMain();
		void pollSession(true);
		return;
	}
	// 只读路径（模式 B / 其它会话 / 起始组）：纯视觉标记，不改模型上下文
	if (target) state.hiddenQs.add(index);
	else state.hiddenQs.delete(index);
	renderMain();
}

/**
 * 行级剪刀（.ev-eye）：切换单条裁剪。可写会话联动模型上下文：POST /api/crop-entry
 * （扩展把该 entry 的内容指纹从后续发给模型的消息里剔掉）；只读场景退化为纯视觉标记。
 */
async function toggleEntryCrop(evId) {
	const ev = findEvent(evId);
	if (!ev) return;
	const id = entryIdOf(ev);
	const target = !state.croppedEntries.has(id);
	if (state.canCropEntry && state.source === "pi") {
		try {
			const res = await fetch("/api/crop-entry", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: "pi", session: state.selectedId, entryId: id, cropped: target }),
			});
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
		} catch (err) {
			console.error("[trajectory-web] 裁剪失败：", err.message);
			setSync(`裁剪失败：${err.message}`, "warn");
			return;
		}
		if (target) state.croppedEntries.add(id);
		else state.croppedEntries.delete(id);
		renderMain();
		void pollSession(true);
		return;
	}
	if (target) state.croppedEntries.add(id);
	else state.croppedEntries.delete(id);
	renderMain();
}

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

/** 文本→节点数组：命中片段包 mark（搜索高亮）；无关键词时原样文本。 */
function highlightNodes(text, terms) {
	if (!terms.length) return [String(text ?? "")];
	return highlightSegments(text, terms).map((s) => (s.hit ? h("mark", { class: "ev-hit", text: s.text }) : s.text));
}

function renderEvent(ev, terms = [], cropped = false) {
	const label = eventTagLabel(ev);
	const classes = ["ev", `k-${kindGroup(ev.kind)}`, `k-${ev.kind}`];
	// 裁剪只改样式（删除线），行仍可点击看详情
	if (cropped) classes.push("is-cropped");
	// 非裁剪模式不渲染行级剪刀，网格少一列（见 .ev.no-crop）
	if (!state.cropMode) classes.push("no-crop");
	// 非蒸馏模式不渲染 checkbox，网格同样少一列（见 .ev.no-select）
	if (!selectMode()) classes.push("no-select");
	if (ev.id === state.openId) classes.push("is-open");
	const deriveName = state.deriveNames.get(ev.id);
	const deriveTarget = state.deriveTargets.get(ev.id);
	if (deriveName) classes.push("k-derive");
	if (deriveTarget) classes.push("is-derive-target");
	if (ev.tool?.isError) classes.push("is-error");
	const meta = [
		fmtTime(ev.ts),
		ev.msg?.durationMs !== undefined ? formatDurationMillis(ev.msg.durationMs) : "",
		ev.msg?.usage ? fmtTokens(ev.msg.usage.totalTokens) : "",
		ev.kind === "tool" && ev.tool?.durationMs !== undefined ? formatDurationMillis(ev.tool.durationMs) : "",
	]
		.filter(Boolean)
		.join(" · ");
	let preview;
	if (deriveName) {
		// 派生行不展示 JSON 参数（message 是密文）：直接给任务名，能跳的再加箭头
		preview = [h("span", { class: "ev-derive-name", text: `${DERIVE_TOOL} ${taskShort(deriveName)}${deriveTarget ? " →" : ""}` })];
	} else {
		// 搜索激活时预览里高亮命中关键词；预览无命中时展示命中字段的上下文片段（如「结果 » …」）
		preview = highlightNodes(ev.preview, terms);
		if (terms.length && !preview.some((node) => node instanceof Node)) {
			const sn = hitSnippet(ev, terms);
			if (sn) preview = [h("span", { class: "ev-hit-src", text: `${sn.label}» ` }), ...highlightNodes(sn.snippet, terms)];
		}
	}
	const dataset = { eid: ev.id };
	if (deriveTarget) dataset.derive = deriveTarget;
	// 行级控件：剪刀（仅裁剪模式）与 checkbox（仅蒸馏选择模式）
	const controls = [];
	if (state.cropMode) {
		controls.push(
			h(
				"button",
				{
					class: "ev-eye",
					type: "button",
					dataset: { eev: ev.id },
					title: cropped ? `取消裁剪这条${label}` : `裁剪这条${label}（后续对话模型看不到）`,
					"aria-label": cropped ? `取消裁剪这条${label}` : `裁剪这条${label}`,
					"aria-pressed": String(cropped),
				},
				svgIcon("scissors"),
			),
		);
	}
	if (selectMode()) {
		controls.push(
			h("input", {
				class: "ev-check",
				type: "checkbox",
				dataset: { echeck: ev.id },
				title: `选中这条${label}`,
				"aria-label": `选中这条${label}`,
				checked: state.selectedEvs.has(ev.id),
			}),
		);
	}
	return h(
		"article",
		{
			class: classes.join(" "),
			dataset,
			tabindex: "0",
			title: deriveTarget ? `进入派生会话 ${taskShort(deriveName ?? "")}` : ev.preview,
		},
		...controls,
		h("span", { class: "ev-tag", text: deriveName ? "派生" : label }),
		h("span", { class: "ev-preview" }, preview),
		h("span", { class: "ev-meta", text: meta }),
	);
}

function renderMain() {
	updateDeriveButtons();
	// 面板先停泊到 body：replaceChildren 会把它摘出文档，而 el("dv-*") 依赖
	// getElementById（文档内可见）；停在文档外时后续 renderPanel/resetTranslateUi 会空引用崩溃
	if (panel.parentElement !== document.body) document.body.appendChild(panel);
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
	const terms = state.query.trim() ? state.query.trim().split(/\s+/) : [];
	mainInner.replaceChildren(
		...questions
			.map((q) => {
			const shown = (q.events ?? []).filter(
			(ev) => eventPasses(state.filters, ev.kind) && eventToolPasses(state.toolExcluded, ev) && (!matches || matches.has(ev.id)),
			);
			// 搜索激活时：无命中的轮次整轮隐藏（过滤 ∩ 搜索，不再渲染空框）
			if (matches && shown.length === 0) return null;
			const roundLabel = q.index < 0 ? "会话开始" : `第 ${q.index + 1} 轮`;
			// 裁剪只改样式（删除线），轮次与条目仍可展开/点开看详情
			const roundCropped = roundCroppedOf(q);
			const body = shown.length ? shown.map((ev) => renderEvent(ev, terms, eventCropped(ev, q))) : h("div", { class: "ev-empty" });
			// 搜索激活时命中轮次强制展开（否则只显示轮次头看不到命中内容）；清空搜索恢复原折叠状态
			const folded = matches ? false : state.folded.has(q.index);
			// 轮头勾选态由本轮条目的选中情况派生：全选中=all、部分=some、无=none
			const roundSel = roundSelectedState(q);
			const headerControls = [];
			if (state.cropMode) {
				headerControls.push(
					h(
						"button",
						{
							class: "q-eye",
							type: "button",
							dataset: { eye: String(q.index) },
							title: roundCropped ? `取消裁剪${roundLabel}（整轮）` : `裁剪${roundLabel}（整轮，后续对话模型看不到）`,
							"aria-label": roundCropped ? `取消裁剪${roundLabel}` : `裁剪${roundLabel}`,
							"aria-pressed": String(roundCropped),
						},
						svgIcon("scissors"),
					),
				);
			}
			if (selectMode()) {
				headerControls.push(
					h("input", {
						class: "q-check",
						type: "checkbox",
						dataset: { check: String(q.index) },
						title: roundSel === "all" ? `取消全选${roundLabel}` : `全选${roundLabel}的所有条目`,
						"aria-label": `全选${roundLabel}的所有条目`,
						checked: roundSel === "all",
					}),
				);
			}
			return h(
				"section",
				{ class: `question${folded ? " folded" : ""}${roundCropped ? " is-cropped" : ""}`, id: `q-${q.index}`, dataset: { q: String(q.index) } },
				h(
					"header",
					{ class: "q-head" },
					...headerControls,
					h("span", { class: "q-caret", text: folded ? "▸" : "▾", "aria-hidden": "true" }),
					h("span", { class: "q-no", text: roundLabel, title: folded ? "点击展开本轮" : "点击收起本轮", role: "button", tabindex: 0 }),
					h("span", { class: "q-time", text: fmtTime(q.ts) || "" }),
					h("span", { class: "q-stats", text: qStats(q) }),
			),
				h("div", { class: "q-body" }, body),
			);
		})
			.filter(Boolean),
	);
	if (matches && mainInner.children.length === 0) {
		mainInner.replaceChildren(h("div", { class: "empty", text: "没有匹配的轨迹（搜索与过滤无交集）" }));
	}
	// 轮头 checkbox 的部分选中态只能靠 DOM 属性设置（HTML 没有 indeterminate 属性）
	for (const input of mainInner.querySelectorAll(".q-check")) {
		const q = questions.find((x) => String(x.index) === input.dataset.check);
		if (q) input.indeterminate = roundSelectedState(q) === "some";
	}
	updateFoldAll();
	// 打开的详情面板重新挂到对应行下方（replaceChildren 会把它摘出文档，重挂不重建，滚动/展开态保留）
	attachOpenPanel();
}

// ---------------------------------------------------------------------------
// 详情内联面板：点轨迹行在行下方展开；行不在（被过滤/折叠/隐藏）时收起
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

function panelMetaNodes(view, light) {
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
	const terms = searchTerms();
	const nodes = [
		h("div", { class: "kv" }, h("span", { text: "工具" }), h("b", { text: String(t.name ?? "") })),
		h("h4", { text: "参数" }),
		preNode(t.argsText ?? "", "wrap", terms),
		h("h4", { text: `结果${t.isError ? "（出错）" : ""}` }),
		t.result ? preNode(t.result, "wrap", terms) : muted("（未返回）"),
		...nestedListNode(t),
	];
	if (isFull && t.details !== undefined) {
		nodes.push(h("details", null, h("summary", { text: "结构化细节" }), preNode(JSON.stringify(t.details, null, 2), "wrap")));
	}
	return nodes;
}

function bashBody(view) {
	const b = view.bash ?? {};
	const terms = searchTerms();
	const flags = [b.cancelled ? "已取消" : "", b.excludeFromContext ? "不进上下文" : ""].filter(Boolean).join(" · ");
	return [
		h("div", { class: "kv" }, h("span", { text: "命令" })),
		preNode(b.command ?? "", "wrap", terms),
		h("div", { class: "kv" }, h("span", { text: "退出码" }), h("b", { text: String(b.exitCode ?? "?") }), flags ? ` · ${flags}` : ""),
		h("h4", { text: "输出" }),
		b.output ? preNode(b.output, "wrap", terms) : muted("（空）"),
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
					isFull && typeof s.text === "string" ? preNode(s.text, "wrap sys-text", searchTerms()) : muted("加载全文中…"),
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

function panelBodyNodes(view) {
	switch (view.kind) {
		case "thinking":
			return view.redacted && !view.text ? [muted("（加密思维，无明文可展示）")] : [mdNode(view.text)];
		case "text":
		case "answer":
			return [mdNode(view.text)];
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
		case "error":
			return [
				...(view.error?.stopReason ? [h("div", { class: "kv" }, h("span", { text: "结束原因" }), h("b", { text: String(view.error.stopReason) }))] : []),
				...(view.error?.model ? [h("div", { class: "kv" }, h("span", { text: "模型" }), h("b", { text: [view.error.provider, view.error.model].filter(Boolean).join("/") }))] : []),
				preNode(view.error?.message ?? "", "wrap"),
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
		case "approval": {
			const ap = view.approval ?? {};
			const verdict = ap.verdict ?? {};
			const action = ap.action ?? {};
			const cmd = Array.isArray(action.command) ? action.command.join(" ") : "";
			return [
				h(
					"div",
					{ class: "kv" },
					h("span", { text: "判定" }),
					h("b", { text: `${verdict.outcome === "allow" ? "✓ 放行" : verdict.outcome === "deny" ? "✗ 拒绝" : verdict.outcome ?? "?"} · 风险 ${verdict.risk_level ?? "?"}` }),
				),
				...(cmd ? [h("div", { class: "kv" }, h("span", { text: "命令" })), preNode(cmd, "wrap")] : []),
				...(action.justification ? [h("div", { class: "kv" }, h("span", { text: "理由" }), h("b", { text: String(action.justification) }))] : []),
				...(verdict.rationale ? [h("h4", { text: "审批依据" }), mdNode(verdict.rationale)] : []),
			];
		}
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

/** 重建面板内容；keepState=true 时保留滚动位置与各 <details> 展开态（轮询/全文到达不打断阅读）。 */
function renderPanel(keepState = false) {
	const light = state.openId ? findEvent(state.openId) : null;
	if (!light) return;
	const full = state.openFull && state.openFull.id === light.id ? state.openFull : null;
	const view = full ?? light;
	transSeq++;
	resetTranslateUi();
	const body = el("dv-body");
	const prevScroll = keepState ? body.scrollTop : 0;
	const openKeys = keepState ? new Set([...body.querySelectorAll("details[open]")].map(detailKey)) : null;
	el("dv-meta").replaceChildren(...panelMetaNodes(view, light));
	body.replaceChildren(...panelBodyNodes(view));
	if (openKeys) for (const d of body.querySelectorAll("details")) if (openKeys.has(detailKey(d))) d.open = true;
	body.scrollTop = prevScroll;
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
		renderPanel(true);
	} catch {
		/* 网络失败时保持 light 展示 */
	}
}

/** 展开轨迹行详情（再点同一行收起）；面板挂在行下方，行不可见时不展开。 */
function openPanel(id) {
	if (state.openId === id) {
		closePanel();
		return;
	}
	const anchor = rowAnchor(id);
	state.openId = id;
	state.openFull = null;
	const light = findEvent(id);
	state.openLightJson = JSON.stringify(light ?? null);
	renderPanel();
	// 行不可见（被过滤/折叠）时 attachOpenPanel 已收尾，不再拉全文/写 hash
	if (!attachOpenPanel()) return;
	if (anchor) {
		// 锚定行：面板插在行下方会把行推出原位，补偿滚动让它停在点击时的视口位置，
		// 展开/收起都不跳动；行不在视口（chat 引用跳转等）时走 scrollIntoView 定位
		restoreAnchor(anchor);
	} else {
		// behavior 必须显式 instant：#main 的 scroll-behavior 是 smooth（同 revealEvent）
		panel.scrollIntoView({ block: "nearest", behavior: "instant" });
	}
	if (light?.truncated) loadFull(id);
	writeViewHash();
}

/** 把打开的详情面板挂到对应轨迹行下方；行不在（被过滤/折叠/隐藏轮）时收起面板。返回是否挂载成功。 */
function attachOpenPanel() {
	if (!state.openId) return false;
	const row = mainInner.querySelector(`.ev[data-eid="${state.openId}"]`);
	if (!row) {
		closePanel();
		return false;
	}
	// 首次点行不会重绘轨迹：高亮在这里同步（renderEvent 里按 state 补一致）
	for (const open of mainInner.querySelectorAll(".ev.is-open")) open.classList.remove("is-open");
	row.classList.add("is-open");
	row.after(panel);
	panel.hidden = false;
	return true;
}

function refreshOpen() {
	if (!state.openId) return;
	const light = findEvent(state.openId);
	if (!light) {
		closePanel();
		return;
	}
	// 事件内容没变就完全不动 DOM：轮询期间不打断阅读（展开的段落、滚动位置、已加载全文都保留）
	const json = JSON.stringify(light);
	if (json === state.openLightJson) {
		// 全文尚未到手（如上次拉取失败）则继续尝试；成功后 renderPanel(true) 保留展开态
		if (!state.openFull && light.truncated) loadFull(light.id);
		return;
	}
	state.openLightJson = json;
	state.openFull = null;
	renderPanel(true);
	if (light.truncated) loadFull(light.id);
}

/** 详情面板插拔时的行锚点：行在视口内才需要稳定（行在视口外的跳转定位交给 scrollIntoView）。 */
function rowAnchor(id) {
	const row = id ? mainInner.querySelector(`.ev[data-eid="${id}"]`) : null;
	if (!row) return null;
	const rowRect = row.getBoundingClientRect();
	const mainRect = main.getBoundingClientRect();
	if (rowRect.bottom <= mainRect.top || rowRect.top >= mainRect.bottom) return null;
	return { row, top: rowRect.top };
}

/** 把锚定的行滚回快照时的视口位置：面板插拔改变了行上方内容高度时补偿滚动。
 *  scrollTo 显式 instant：#main 的 scroll-behavior 是 smooth，scrollTop 赋值也会被平滑化。 */
function restoreAnchor(anchor) {
	const delta = anchor.row.getBoundingClientRect().top - anchor.top;
	if (delta) main.scrollTo({ top: main.scrollTop + delta, behavior: "instant" });
}

function closePanel() {
	// 收起同样锚定行：面板摘除后内容塌缩会把行带走，补偿滚动让它停在原位
	const anchor = rowAnchor(state.openId);
	state.openId = null;
	state.openFull = null;
	state.openLightJson = "";
	panel.hidden = true;
	for (const open of mainInner.querySelectorAll(".ev.is-open")) open.classList.remove("is-open");
	transSeq++;
	setSettingsOpen(false);
	setCopyMenuOpen(false);
	restoreAnchor(anchor);
	writeViewHash();
}

// ---------------------------------------------------------------------------
// 侧边对话栏（顶栏对话按钮开关，位于主题按钮右侧）：消息流与流式渲染由 chat.js
// 接管（/api/chat/*），本文件只负责开关、宽度/高度拖拽与依赖注入。
// ---------------------------------------------------------------------------

const CHAT_INPUT_MAX_H = 132; // 与 CSS .chat-input max-height 同步（约 6 行封顶后内部滚动）

function currentChatKey() {
	return `${state.source}:${state.selectedId ?? ""}`;
}

/** 把当前选中集写回 session_ui.contextIds。 */
function saveChatContext() {
	if (!state.selectedId) return;
	updateSessionPrefs(state.source, state.selectedId, { contextIds: [...state.selectedEvs] });
}

/** 剪掉投影里已不存在的事件 id；返回是否有变化。 */
function pruneChatContext() {
	if (!state.data) return false;
	const valid = new Set();
	for (const q of state.data.questions ?? []) for (const ev of q.events ?? []) valid.add(ev.id);
	const kept = pruneContextIds([...state.selectedEvs], valid);
	const changed = kept.length !== state.selectedEvs.size;
	if (changed) {
		state.selectedEvs = new Set(kept);
		saveChatContext();
	}
	return changed;
}

/** 从 session_ui.contextIds 恢复当前 source:session 的选中集（有投影时顺带 prune）。 */
async function restoreChatContext() {
	const key = currentChatKey();
	const source = state.source;
	const sessionId = state.selectedId;
	if (!sessionId) {
		state.selectedEvs = new Set();
		state.chatCtxKey = key;
		return;
	}
	const prefs = await loadSessionPrefs(source, sessionId);
	if (currentChatKey() !== key) return;
	state.selectedEvs = new Set(prefs.contextIds ?? []);
	state.chatCtxKey = key;
	pruneChatContext();
	renderMain();
	chat?.onSelectionChanged?.();
}

function addSelectedIds(ids) {
	for (const id of [...new Set(ids)]) state.selectedEvs.add(id);
	return true;
}

function autoGrowChatInput() {
	// 手动拖过高度时交给 CSS 撑满，不再按内容改 height（否则会把拖拽结果覆盖掉）
	if (el("chat-drawer").dataset.composer === "manual") return;
	const input = el("chat-input");
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, CHAT_INPUT_MAX_H)}px`;
}

// ---------------------------------------------------------------------------
// 侧边对话栏开关：顶栏对话按钮（主题按钮右侧）驱动，开态写服务端全局偏好
// ---------------------------------------------------------------------------

function setChatOpen(open) {
	if (open) void restoreChatContext();
	else saveChatContext();
	state.chatOpen = open;
	el("chat-drawer").hidden = !open;
	const btn = el("chat-btn");
	btn.setAttribute("aria-pressed", String(open));
	const label = open ? "收起侧边对话" : "打开侧边对话";
	btn.title = label;
	btn.setAttribute("aria-label", label);
	queueGlobalPrefs({ chatOpen: open });
	chat.setOpen(open);
	renderMain();
	updateDistillButton();
}

// ---------------------------------------------------------------------------
// 对话栏宽度：左缘拖拽（260px ~ 90vw），双击恢复默认，宽度写服务端全局偏好
// ---------------------------------------------------------------------------

const CHAT_DEFAULT_W = 440;
const CHAT_MIN_W = 260;

function chatMaxWidth() {
	return Math.min(Math.round(window.innerWidth * 0.9), 1100);
}

function clampChatWidth(width) {
	return Math.min(Math.max(Math.round(width), CHAT_MIN_W), chatMaxWidth());
}

/** 只改当前宽度（拖动过程用，不写存储）。 */
function previewChatWidth(width) {
	el("chat-drawer").style.setProperty("--tw-chat-w", `${clampChatWidth(width)}px`);
}

/** 落定宽度并写服务端全局偏好。 */
function commitChatWidth(width) {
	previewChatWidth(width);
	queueGlobalPrefs({ chatWidth: clampChatWidth(width) });
}

function loadChatWidth() {
	const saved = Number(globalPrefs.chatWidth) || 0;
	if (saved > 0) previewChatWidth(saved);
}

function bindChatResize() {
	const handle = el("chat-resize");
	if (!handle) return;
	handle.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		e.preventDefault();
		const drawerEl = el("chat-drawer");
		const start = { x: e.clientX, width: drawerEl.getBoundingClientRect().width };
		handle.classList.add("dragging");
		try {
			handle.setPointerCapture(e.pointerId);
		} catch {
			/* 合成事件/环境不支持捕获时靠 window 监听兑底 */
		}
		// 左缘：指针往左拉 = 变宽
		const onMove = (ev) => previewChatWidth(start.width - (ev.clientX - start.x));
		const onEnd = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onEnd);
			window.removeEventListener("pointercancel", onEnd);
			handle.classList.remove("dragging");
			commitChatWidth(drawerEl.getBoundingClientRect().width);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onEnd);
		window.addEventListener("pointercancel", onEnd);
	});
	handle.addEventListener("dblclick", () => commitChatWidth(CHAT_DEFAULT_W));
	handle.addEventListener("keydown", (e) => {
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		e.preventDefault();
		const step = e.shiftKey ? 64 : 16;
		commitChatWidth(el("chat-drawer").getBoundingClientRect().width + (e.key === "ArrowLeft" ? step : -step));
	});
	// 窗口变窄时把超宽的对话栏收回可视范围（不写回存储，复原窗口后保留原偏好）
	window.addEventListener("resize", () => {
		const drawerEl = el("chat-drawer");
		if (drawerEl.getBoundingClientRect().width > chatMaxWidth()) previewChatWidth(chatMaxWidth());
	});
}

// ---------------------------------------------------------------------------
// 输入区高度：拖拽编辑框上边（96px ~ 70vh），双击恢复自适应，高度写服务端全局偏好
// ---------------------------------------------------------------------------

const COMPOSER_MIN_H = 96;

function composerMaxHeight() {
	return Math.min(Math.round(window.innerHeight * 0.7), 600);
}

function clampComposerHeight(height) {
	return Math.min(Math.max(Math.round(height), COMPOSER_MIN_H), composerMaxHeight());
}

/** 当前输入区高度（未手动调过时为 0，表示按内容自适应）。 */
function composerHeight() {
	return Number.parseFloat(el("chat-drawer").style.getPropertyValue("--tw-composer-h")) || 0;
}

/** 只改当前高度（拖动过程用，不写存储）；手动态下 textarea 撑满输入区。 */
function previewComposerHeight(height) {
	const drawerEl = el("chat-drawer");
	drawerEl.dataset.composer = "manual";
	drawerEl.style.setProperty("--tw-composer-h", `${clampComposerHeight(height)}px`);
}

/** 落定高度并写服务端全局偏好。 */
function commitComposerHeight(height) {
	previewComposerHeight(height);
	queueGlobalPrefs({ composerHeight: clampComposerHeight(height) });
}

/** 恢复自适应：清掉手动高度（textarea 重新按内容 + 132px 上限增长）。 */
function resetComposerHeight() {
	const drawerEl = el("chat-drawer");
	delete drawerEl.dataset.composer;
	drawerEl.style.removeProperty("--tw-composer-h");
	el("chat-input").style.height = "";
	autoGrowChatInput();
	queueGlobalPrefs({ composerHeight: 0 });
}

function loadComposerHeight() {
	const saved = Number(globalPrefs.composerHeight) || 0;
	if (saved > 0) previewComposerHeight(saved);
}

function bindComposerResize() {
	const handle = el("composer-resize");
	if (!handle) return;
	handle.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		e.preventDefault();
		const composer = handle.parentElement;
		const start = { y: e.clientY, height: composer.getBoundingClientRect().height };
		handle.classList.add("dragging");
		try {
			handle.setPointerCapture(e.pointerId);
		} catch {
			/* 合成事件/环境不支持捕获时靠 window 监听兑底 */
		}
		// 上边：指针往上拉 = 变高
		const onMove = (ev) => previewComposerHeight(start.height - (ev.clientY - start.y));
		const onEnd = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onEnd);
			window.removeEventListener("pointercancel", onEnd);
			handle.classList.remove("dragging");
			commitComposerHeight(composer.getBoundingClientRect().height);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onEnd);
		window.addEventListener("pointercancel", onEnd);
	});
	handle.addEventListener("dblclick", () => resetComposerHeight());
	handle.addEventListener("keydown", (e) => {
		if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
		e.preventDefault();
		const step = e.shiftKey ? 64 : 16;
		const base = composerHeight() || handle.parentElement.getBoundingClientRect().height;
		commitComposerHeight(base + (e.key === "ArrowUp" ? step : -step));
	});
	// 窗口变矮时把过高的输入区收回可视范围（不写回存储，复原后保留原偏好）
	window.addEventListener("resize", () => {
		if (composerHeight() > composerMaxHeight()) previewComposerHeight(composerMaxHeight());
	});
}

// ---------------------------------------------------------------------------
// 视图位置（URL hash）：#s=<会话id>&e=<事件id> —— 刷新不丢展开的详情。
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
		updateAgentTreeBtn();
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
	saveChatContext();
	state.sourceSel[state.source] = state.selectedId;
	state.source = id;
	state.selectedId = state.sourceSel[id] ?? null;
	state.data = null;
	state.etag = null;
	state.sessions = [];
	state.sessionListKey = "";
	state.consoles = new Map();
	state.consolesSource = null;
	state.consolesKey = "";
	state.folded = new Set();
	state.hiddenQs = new Set();
	state.selectedEvs = new Set();
	state.chatCtxKey = null;
	state.croppedEntries = new Set();
	state.canContextEdit = false;
	state.canCropEntry = false;
	state.hiddenUserIds = new Set();
	state.query = "";
	el("search").value = "";
	state.toolNames = [];
	state.searchIndex = new TrajectorySearchIndex();
	closePanel();
	restoreChatContext();
	renderRail();
	renderTopbar();
	renderSessions();
	chat.onConsolesChanged?.([]);
	chat.onSessionChanged();
	pollSessions(true);
	pollSession(true);
	writeViewHash();
}

// ---------------------------------------------------------------------------
// Agent 派生结构（codex）：当前项目的主会话 → 子任务树，点击节点进入轨迹
// ---------------------------------------------------------------------------

/** 工具条「派生」按钮只对 codex 源显示（pi 的子代理嵌在父会话内，无独立会话）。 */
// 派生树视图已移除（改为会话栏主线/全部过滤 + 子任务徽章）

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

async function translatePanel() {
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
		void translatePanel();
	}
}

// ---------------------------------------------------------------------------
// 面板工具条（随详情面板迁移到头部）：复制正文（翻译状态下可选仅译文/全部）
// ---------------------------------------------------------------------------

let copyFlashTimer = 0;

function setCopyMenuOpen(open) {
	state.copyOpen = open;
	el("dv-copy-menu").hidden = !open;
	el("dv-copy").setAttribute("aria-expanded", String(open));
}

/** 组装复制文本：src = 原文 / trans = 仅译文 / all = 原文＋译文；无 .md 正文时退回整个详情文本。 */
function panelCopyText(mode) {
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

async function copyPanel(mode) {
	const btn = el("dv-copy");
	try {
		await navigator.clipboard.writeText(panelCopyText(mode));
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

async function pollConsoles() {
	if (state.pollingConsoles) return;
	state.pollingConsoles = true;
	const requestedSource = state.source;
	try {
		const qs = new URLSearchParams({ source: requestedSource, t: String(Date.now()) });
		const res = await fetch(`/api/chat/consoles?${qs}`);
		if (requestedSource !== state.source) return;
		if (!res.ok) {
			// chat 未启用/非回环：清掉旧状态，避免把别的源的控制台显示在当前源。
			if (state.consolesSource !== requestedSource || state.consoles.size) {
				state.consoles = new Map();
				state.consolesSource = requestedSource;
				state.consolesKey = "";
				renderSessions();
				chat.onConsolesChanged?.([]);
			}
			return;
		}
		const data = await res.json();
		if (requestedSource !== state.source) return;
		const next = new Map();
		for (const item of Array.isArray(data.consoles) ? data.consoles : []) {
			if (!item || typeof item.sessionId !== "string") continue;
			next.set(`${requestedSource}:${item.sessionId}`, item);
		}
		const key = JSON.stringify(
			[...next.entries()]
				.map(([sessionKey, item]) => [sessionKey, item.state ?? null, item.pid ?? null])
				.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		);
		if (key === state.consolesKey && state.consolesSource === requestedSource) return;
		state.consoles = next;
		state.consolesSource = requestedSource;
		state.consolesKey = key;
		renderSessions();
		chat.onConsolesChanged?.(Array.isArray(data.consoles) ? data.consoles : []);
	} catch {
		/* 网络失败保留旧状态；下一轮重试 */
	} finally {
		state.pollingConsoles = false;
	}
}

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
			// 子会话新增/消失会改变派生行能不能跳：变了才重绘，避免轮询把轨迹 DOM 反复重建
			const deriveChanged = syncDeriveTargets();
			renderSessions();
			renderTopbar();
			if (deriveChanged && state.data) renderMain();
		}
		if (!state.selectedId && (j.current || j.sessions?.[0])) {
			state.selectedId = j.current ?? j.sessions[0].id;
			renderSessions();
			restoreChatContext();
			chat.onSessionChanged();
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
			state.selectedEvs = new Set();
			state.chatCtxKey = null;
			saveChatContext();
			pendingOpen = null;
			writeViewHash();
			renderMain();
			chat.onSessionChanged();
			setSync("会话已消失，刷新列表", "warn");
			pollSessions(true);
			return;
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const j = await res.json();
		if (j.changed === false) {
			setSync(`已同步 ${fmtClock()}`, "ok");
			if (state.revealEid) revealEvent(state.revealEid);
			return;
		}
		state.data = { meta: j.meta, questions: j.questions };
		// 首次投影/切换会话后恢复 session_ui.contextIds 并剪掉失效 id
		if (state.chatCtxKey !== currentChatKey()) restoreChatContext();
		else pruneChatContext();
		chat.onTrajectoryChanged();
		state.canContextEdit = j.contextEdit === true;
		state.canCropEntry = j.cropEdit === true;
		state.croppedEntries = new Set(Array.isArray(j.croppedEntryIds) ? j.croppedEntryIds : []);
		state.hiddenUserIds = new Set(Array.isArray(j.hiddenUserIds) ? j.hiddenUserIds : []);
		state.searchIndex.update(state.data.questions);
		syncDeriveTargets();
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
		if (state.revealEid) revealEvent(state.revealEid);
		refreshOpen();
		// 刷新恢复：首次数据就绪后重开 hash 记录的事件；事件已不在会话里则清掉失效 hash
		if (pendingOpen) {
			const id = pendingOpen;
			pendingOpen = null;
			if (findEvent(id)) openPanel(id);
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
	// 点开/点关切换；菜单项点击不关菜单，方便连续调整多项
	e.stopPropagation();
	if (state.menuOpen) {
		setMenuOpen(false);
		return;
	}
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
			// 全选开关：只看当前会话可见工具；未知排除名保留，excludeAll 控制新工具。
			const next = toggleAllTools(state.toolNames, state.toolExcluded, state.toolExcludeAll);
			state.toolExcluded = next.excluded;
			state.toolExcludeAll = next.excludeAll;
		} else if (state.toolExcluded.has(name)) {
			state.toolExcluded.delete(name);
			state.toolExcludeAll = false; // 单独勾回某个工具即退出「全部反选」模式
		} else state.toolExcluded.add(name);
		saveToolsPrefs();
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

el("groups-toggle").addEventListener("click", () => {
	const keys = groupKeys();
	if (keys.length === 0) return;
	const set = groupSet();
	const allCollapsed = keys.every((key) => set.has(key));
	set.clear();
	if (!allCollapsed) for (const key of keys) set.add(key);
	renderSessions();
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
	if (!item) return;
	selectSession(item.dataset.id);
});

/** 切换选中会话（列表点击 / 派生行跳转共用）：重置临时态并拉新数据。from 记录从哪条派生行跳来。 */
function selectSession(id, from = null) {
	if (!id || id === state.selectedId) return;
	saveChatContext();
	state.selectedId = id;
	state.deriveFrom = from;
	state.revealEid = null;
	state.data = null;
	state.etag = null;
	state.folded = new Set();
	state.hiddenQs = new Set();
	state.selectedEvs = new Set();
	state.chatCtxKey = null;
	state.croppedEntries = new Set();
	state.canContextEdit = false;
	state.canCropEntry = false;
	state.hiddenUserIds = new Set();
	state.query = "";
	state.toolNames = [];
	state.deriveTargets = new Map();
	state.deriveNames = new Map();
	state.searchIndex = new TrajectorySearchIndex();
	setMenuOpen(false);
	el("search").value = "";
	closePanel();
	restoreChatContext();
	renderSessions();
	renderTopbar();
	renderMain();
	main.scrollTop = 0;
	chat.onSessionChanged();
	pollSession(true);
}

/** 点事件行：派生行跳到它派生出的子会话，其余在行下方展开详情（再点收起）。 */
/** 点事件行：派生行跳到它派生出的子会话，其余在行下方展开详情（再点收起）。 */
function openEventRow(row) {
	const target = row.dataset.derive;
	if (target) {
		selectSession(target, { id: state.selectedId, eid: row.dataset.eid });
		return;
	}
	openPanel(row.dataset.eid);
}

mainInner.addEventListener("click", (e) => {
	// 行级控件先于轮次/行本身处理（否则点剪刀会被当成展开面板）
	const evEye = e.target.closest(".ev-eye");
	if (evEye) {
		void toggleEntryCrop(evEye.dataset.eev);
		return;
	}
	const evCheck = e.target.closest(".ev-check");
	if (evCheck) {
		// 阻止原生勾选，统一从 state 渲染（同轮次头复选框）
		e.preventDefault();
		const id = evCheck.dataset.echeck;
		if (state.selectedEvs.has(id)) {
			state.selectedEvs.delete(id);
		} else if (!addSelectedIds([id])) {
			renderMain();
			return;
		}
		saveChatContext();
		chat.onSelectionChanged();
		renderMain();
		updateDistillButton();
		return;
	}
	const eye = e.target.closest(".q-eye");
	if (eye) {
		void toggleRoundCrop(Number(eye.dataset.eye));
		return;
	}
	const check = e.target.closest(".q-check");
	if (check) {
		// 阻止原生勾选，统一从 state 渲染（单一数据源，避免重渲染丢勾选态）
		e.preventDefault();
		toggleRoundSelected(Number(check.dataset.check));
		return;
	}
	const no = e.target.closest(".q-no");
	if (no) {
		const index = Number(no.closest(".question")?.dataset.q);
		if (Number.isNaN(index)) return;
		if (state.folded.has(index)) state.folded.delete(index);
		else state.folded.add(index);
		renderMain();
		return;
	}
	const row = e.target.closest(".ev");
	if (row) openEventRow(row);
});

mainInner.addEventListener("keydown", (e) => {
	if (e.key !== "Enter" && e.key !== " ") return;
	// 行级剪刀/复选框是原生控件，键盘交互交给它们自己（不在此展开面板）
	if (e.target.closest?.(".ev-eye, .ev-check")) return;
	const no = e.target.closest?.(".q-no");
	if (no) {
		e.preventDefault();
		no.click();
		return;
	}
	const row = e.target.closest(".ev");
	if (!row) return;
	e.preventDefault();
	openEventRow(row);
});

el("agent-rail").addEventListener("click", (e) => {
	const btn = e.target.closest(".rail-btn");
	if (btn) switchSource(btn.dataset.source);
});
el("chat-btn").addEventListener("click", () => setChatOpen(!state.chatOpen));
el("crop-btn").addEventListener("click", () => setCropMode(!state.cropMode));
el("distill-btn").addEventListener("click", () => setDistillMode(!state.distillMode));
el("dv-translate").addEventListener("click", () => void translatePanel());
el("dv-copy").addEventListener("click", (e) => {
	e.stopPropagation();
	// 已翻译时弹菜单选「仅译文/全部」，否则一键复制原文
	if (state.translated) setCopyMenuOpen(!state.copyOpen);
	else void copyPanel("src");
});
el("dv-copy-menu").addEventListener("click", (e) => {
	e.stopPropagation();
	const item = e.target.closest("button[data-copy]");
	if (!item) return;
	setCopyMenuOpen(false);
	void copyPanel(item.dataset.copy);
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
// 详情面板是滚动边界：鼠标在面板内时滚轮只滚 .dv-body，到顶/到底也不把滚动链交给 #main。
panel.addEventListener(
	"wheel",
	(event) => {
		if (event.ctrlKey) return; // 保留 Ctrl+滚轮缩放
		event.preventDefault();
		event.stopPropagation();
		const body = el("dv-body");
		if (!body || !body.contains(event.target)) return;
		let unit = 1;
		if (event.deltaMode === 1) unit = 16;
		else if (event.deltaMode === 2) unit = body.clientHeight;
		const delta = event.deltaY * unit;
		if (!delta) return;
		body.scrollTop = Math.max(0, Math.min(body.scrollHeight - body.clientHeight, body.scrollTop + delta));
	},
	{ passive: false },
);
el("theme-btn").addEventListener("click", cycleTheme);
el("back-main").addEventListener("click", () => {
	// 从派生行跳过来时，回原会话并定位回那一行；否则回派生树根（主会话最新实例）
	const from = state.deriveFrom;
	if (from && from.id && from.id !== state.selectedId) {
		selectSession(from.id);
		state.revealEid = from.eid;
		return;
	}
	const info = currentDeriveInfo();
	const root = info?.root.sessions[info.root.sessions.length - 1];
	if (root && root.id !== state.selectedId) selectSession(root.id);
	else {
		updateDeriveButtons();
		renderMain();
	}
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		// 对话栏优先：流式中 Esc = 停止生成，否则交给原有抽屉/面板链
		if (chat.handleEscape()) return;
		if (state.copyOpen) {
			setCopyMenuOpen(false);
			return;
		}
		if (state.settingsOpen) {
			setSettingsOpen(false);
			return;
		}
		if (state.openId) {
			closePanel();
			return;
		}
		if (state.chatOpen) {
			setChatOpen(false);
			return;
		}
		if (state.cropMode) {
			setCropMode(false);
			return;
		}
		if (state.distillMode) setDistillMode(false);
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
	pollConsoles();
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

await initGlobalPrefs();
renderToolbar();
// 对话栏：消息流与 SSE 由 chat.js 接管；本文件只提供 DOM 助手、当前会话与输入框自增高
const chat = initChatPanel({
	el,
	h,
	mdNode,
	getSession: () =>
		chatSessionRef({
			source: state.source,
			selectedId: state.selectedId,
			sessions: state.sessions,
		}),
	getSelectedIds: () => [...state.selectedEvs],
	setSelectedIds: (ids, { silent = false } = {}) => {
		const unique = [];
		for (const id of Array.isArray(ids) ? ids : []) {
			if (typeof id === "string" && id && !unique.includes(id)) unique.push(id);
		}
		state.selectedEvs = new Set(unique);
		saveChatContext();
		renderMain();
		updateDistillButton();
		if (!silent) chat.onSelectionChanged();
	},
	getEventRefs: (ids) =>
		(Array.isArray(ids) ? ids : []).map((id) => {
			const ev = findEvent(id);
			return ev
				? { id, kind: ev.kind, label: eventTagLabel(ev), preview: ev.preview ?? "" }
				: { id, kind: "unknown", label: "失效条目", preview: "", invalid: true };
		}),
	openEvent: (id) => openPanel(id),
	autoGrowInput: autoGrowChatInput,
});
loadChatWidth();
bindChatResize();
loadComposerHeight();
bindComposerResize();
if (globalPrefs.chatOpen) setChatOpen(true);
void ensureToolOrigins();
void pollSources();
pollSessions();
pollSession();
pollConsoles();
setInterval(() => {
	if (document.hidden) return;
	state.tick++;
	if (state.tick % SESSION_LIST_EVERY === 0) pollSessions();
	if (state.tick % 30 === 0) void pollSources(); // 约 60s 刷新源列表
	pollSession();
	pollConsoles();
}, POLL_MS);
