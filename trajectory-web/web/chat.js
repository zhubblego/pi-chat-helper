/**
 * chat.js — 侧边对话栏：接 pi 子进程的 SSE 流式对话与基础消息 UI。
 *
 * 后端：POST /api/chat/send（text/event-stream）、POST /api/chat/stop、
 *       GET /api/chat/thread、GET /api/chat/capabilities。
 * 本阶段（T3）只做流式与消息渲染；模型/技能/上下文/审批在后续阶段接入。
 */
import {
	computeAnchoredMenuPosition,
	contextSummaryLabel,
	filterPaletteItems,
	formatChars,
	formatContextWindow,
	forwardDeliveryLabel,
	forwardFailureText,
	forwardStatusLabel,
	isCurrentTurn,
	modelLabel,
	parseSseChunk,
	parseSseData,
} from "./chat-lib.js";
import { fmtTokens } from "./lib.js";
import { getSessionPrefs, loadSessionPrefs, updateSessionPrefs } from "./session-prefs.js";

const PROMPT_MAX = 32000;
const RENDER_MIN_MS = 80;
const MODELS_TTL_MS = 5000;
const SKILL_WARN_CHARS = 32_000;
const SKILL_MAX_CHARS = 200_000;
const PROFILE_LABEL = { "no-tools": "仅对话", "read-only": "只读", full: "全量工具" };
const PROFILE_OPTIONS = Object.freeze([
	{ id: "no-tools", label: "仅对话", hint: "只读轨迹工具，不能读项目文件" },
	{ id: "read-only", label: "只读", hint: "可读项目文件（read/grep/ls），不能写、不能跑命令" },
	{ id: "full", label: "全量工具", hint: "可写文件、可跑命令；每次执行前弹审批", warn: true },
]);
const SKILL_SCOPE_LABEL = { user: "全局技能", project: "项目技能", temporary: "临时技能", path: "路径技能" };
const SKILL_SCOPE_ORDER = { user: 0, project: 1, temporary: 2, path: 3 };
const ANCHORED_PALETTE_LAYERS = new Set(["modelRoot", "model", "thinking"]);
const PROFILE_MENU_ANCHOR = Object.freeze({
	offset: 4,
	align: "left",
	minWidth: "min(144px, 100%)",
	maxWidth: "min(360px, 100%)",
});
const MODEL_MENU_ANCHOR = Object.freeze({
	offset: 8,
	align: "right",
	minWidth: "min(240px, 100%)",
	maxWidth: "min(420px, 100%)",
});
const CONTEXT_MENU_ANCHOR = Object.freeze({
	offset: 4,
	align: "left",
	minWidth: "min(260px, 100%)",
	maxWidth: "min(420px, 100%)",
	maxHeight: 360,
});
const COMMAND_ITEMS = Object.freeze([
	{ id: "new", label: "新对话", hint: "开一个新线程（旧线程可用 /resume 找回）", group: "命令", search: "new 新对话" },
	{ id: "resume", label: "历史对话", hint: "切换回旧线程", group: "命令", search: "resume 历史 对话 线程" },
	{ id: "model", label: "模型", hint: "选择当前线程的模型", group: "命令", search: "model 模型" },
	{ id: "thinking", label: "思考级别", hint: "off / low / medium / high / max", group: "命令", search: "thinking 思考 级别 level" },
	{ id: "skill", label: "技能", hint: "选择技能（发送时由 pi 展开）", group: "命令", search: "skill 技能" },
]);

/** 对话栏。deps: {el,h,mdNode,getSession,autoGrowInput}（后续阶段再扩）。 */
export function initChatPanel(deps) {
	const el = deps.el;
	const h = deps.h;
	const mdNode = deps.mdNode;
	const list = el("chat-list");
	const input = el("chat-input");
	const addBtn = el("chat-add");
	const modelBtn = el("chat-model-label");
	const sendBtn = el("chat-send");
	const modeToggleBtn = el("chat-mode-toggle");
	const forwardDeliveryEl = el("chat-forward-delivery");
	const announcer = el("chat-announcer");
	const paletteEl = el("chat-palette");
	const paletteListEl = el("chat-palette-list");
	const paletteSearchEl = el("chat-palette-search");
	const profileMenuEl = el("chat-profile-menu");
	const contextBtn = el("chat-context");
	const contextMenuEl = el("chat-context-menu");
	const consoleStatusEl = el("chat-console-status");
	const overlayAnchorEl = paletteEl?.closest?.(".chat-overlay-anchor") ?? profileMenuEl?.closest?.(".chat-overlay-anchor") ?? null;
	const approvalEl = el("chat-approval");
	const sendIcon = sendBtn?.firstElementChild?.cloneNode(true) ?? null;
	let localSeq = 0;
	let renderTimer = 0;
	let renderRaf = 0;

	const state = {
		open: false,
		enabled: null,
		reason: "",
		sessionKey: null,
		loadedKey: null,
		thread: null,
		threadId: null,
		model: null,
		thinkingLevel: null,
		thinkingLevels: [],
		thinkingError: null,
		profile: "read-only",
		messages: [],
		loading: false,
		loadSeq: 0,
		streaming: false,
		turn: null,
		controller: null,
		status: null,
		lastRenderAt: 0,
		// 收尾/整表替换期间短暂关闭 aria-live，避免屏幕阅读器把整张表重读一遍
		a11yHold: false,
		// 模型列表与斜杠面板
		models: [],
		modelsAt: 0,
		modelsError: null,
		threads: [],
		threadsAt: 0,
		threadsError: null,
		palette: null,
		// 设置与技能
		settings: { profile: "read-only", projectSkills: false },
		settingsBusy: false,
		skills: [],
		skillsKey: null,
		skillsError: null,
		skillsDiagnostics: [],
		skill: null,
		// profile 菜单与审批
		profileMenuOpen: false,
		contextMenuOpen: false,
		profileConfirm: false,
		profileBusy: false,
		fullConfirmed: false,
		// 控制台桥状态（key = `${source}:${sessionId}`）；T2 只展示，转发在 T4
		consoles: new Map(),
		consoleLost: new Set(),
		// T4：独立 / 转发双模式；转发记录只存当前页面内存，按 session 分桶
		mode: "independent",
		drafts: { independent: "", forward: "" },
		forwardLogs: new Map(),
		forwardDelivery: "auto",
		forwardBusy: false,
		forwardSeq: 0,
		forwardConfirm: null,
		approvals: [],
		approvalChecked: false,
		approvalBusy: false,
		approvalRenderedId: null,
		approvalRemaining: 0,
		approvalTimer: 0,
		approvalStart: 0,
		newThreadIds: new Set(),
	};

	const localId = (kind) => `local-${kind}-${++localSeq}`;

	function currentSession() {
		try {
			const session = deps.getSession?.() ?? null;
			if (!session || !session.id) return null;
			return { source: session.source ?? "pi", id: session.id, projectPath: session.projectPath ?? null };
		} catch {
			return null;
		}
	}

	function sessionKeyOf(session) {
		return session ? `${session.source}:${session.id}` : "";
	}

	function currentKey() {
		return sessionKeyOf(currentSession());
	}

	function sessionForPrefs(key) {
		const index = key.indexOf(":");
		return index < 0 ? { source: key, sessionId: "" } : { source: key.slice(0, index), sessionId: key.slice(index + 1) };
	}

	function updateForPrefs(key, patch) {
		const { source, sessionId } = sessionForPrefs(key);
		if (source && sessionId) updateSessionPrefs(source, sessionId, patch);
	}

	function saveModeFor(key, mode) {
		if (!key) return;
		updateForPrefs(key, { mode });
	}

	function syncModeForSession() {
		const session = currentSession();
		state.mode = session ? getSessionPrefs(session.source, session.id).mode : "independent";
		state.forwardDelivery = "auto";
	}

	function currentConsoleInfo() {
		const session = currentSession();
		return session ? state.consoles.get(sessionKeyOf(session)) : null;
	}

	function independentBusy() {
		return state.streaming || Boolean(state.turn && !state.turn.settled);
	}

	function setMode(mode) {
		if (mode !== "independent" && mode !== "forward") return;
		if (mode === state.mode) return;
		const session = currentSession();
		if (!session) return;
		if (mode === "forward" && !currentConsoleInfo()) return;
		if (input) state.drafts[state.mode] = input.value;
		if (mode === "forward") {
			closePalette({ restore: false, clearInput: false, focus: false });
			closeProfileMenu();
			closeContextMenu({ focus: false });
		}
		state.mode = mode;
		state.forwardBusy = false;
		state.forwardSeq++;
		state.forwardConfirm = null;
		saveModeFor(sessionKeyOf(session), mode);
		if (input) {
			input.value = state.drafts[mode] ?? "";
			deps.autoGrowInput?.();
		}
		if (mode === "independent" && state.open) void ensureLoaded();
		render();
		announce(mode === "forward" ? "已切换到转发模式" : "已切换到独立模式");
		input?.focus?.();
	}

	function rememberedThreadFor(key) {
		const { source, sessionId } = sessionForPrefs(key);
		return source && sessionId ? getSessionPrefs(source, sessionId).threadId : null;
	}

	function rememberThreadFor(key, threadId) {
		if (!threadId) return;
		updateForPrefs(key, { threadId });
	}

	function forgetThreadFor(key) {
		updateForPrefs(key, { threadId: null, threadNew: false });
	}

	function markNewThread(key, threadId) {
		if (!threadId) return;
		updateForPrefs(key, { threadId, threadNew: true });
	}

	function clearNewThread(key) {
		updateForPrefs(key, { threadNew: false });
	}

	function isNewThread(key, threadId) {
		const { source, sessionId } = sessionForPrefs(key);
		if (!source || !sessionId || !threadId) return false;
		const prefs = getSessionPrefs(source, sessionId);
		return prefs.threadNew === true && prefs.threadId === threadId;
	}

	/** SSE 回调只允许写当前会话、且属于当前 turn。state.turn 防止已收尾的旧流回写。 */
	function isTurnActive(turn) {
		return state.turn === turn && isCurrentTurn(turn, sessionKeyOf(currentSession()));
	}

	// ------------------------------------------------------------------
	// 加载：capabilities / thread
	// ------------------------------------------------------------------

	async function loadCapabilities() {
		try {
			const res = await fetch("/api/chat/capabilities");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			state.enabled = data.enabled === true;
			state.reason = data.reason ?? "";
			state.profile = data.defaultProfile ?? state.profile;
		} catch (err) {
			state.enabled = false;
			state.reason = `能力探测失败：${err.message}`;
		}
		render();
	}

	async function fetchThread(session, threadId = state.threadId) {
		const params = new URLSearchParams({ source: session.source, session: session.id });
		if (threadId) params.set("thread", threadId);
		const res = await fetch(`/api/chat/thread?${params}`);
		if (!res.ok) {
			let message = `HTTP ${res.status}`;
			try {
				message = (await res.json())?.error ?? message;
			} catch {
				/* 非 JSON 错误体 */
			}
			throw new Error(message);
		}
		return await res.json();
	}

	async function loadThread({ force = false } = {}) {
		if (!state.open || state.enabled === false) return;
		const session = currentSession();
		if (!session) {
			state.sessionKey = null;
			state.loadedKey = null;
			state.thread = null;
			state.threadId = null;
			state.messages = [];
			render();
			return;
		}
		await loadSessionPrefs(session.source, session.id);
		syncModeForSession();
		const key = sessionKeyOf(session);
		if (!force && state.loadedKey === key) return;
		const seq = ++state.loadSeq;
		state.loading = true;
		state.sessionKey = key;
		const remembered = state.threadId ?? rememberedThreadFor(key);
		state.threadId = remembered ?? null;
		render();
		try {
			let data = await fetchThread(session, remembered);
			if (seq !== state.loadSeq) return;
			// 记住的线程文件真的不存在：清掉记忆并回退到最新（本次页面新建、还未落盘的线程保留）
			if (data.thread?.exists === false && remembered && !state.newThreadIds.has(remembered) && !isNewThread(key, remembered)) {
				forgetThreadFor(key);
				clearNewThread(key);
				state.threadId = null;
				data = await fetchThread(session, null);
				if (seq !== state.loadSeq) return;
			}
			state.thread = data.thread ?? null;
			state.threadId = data.thread?.id ?? null;
			if (state.threadId) rememberThreadFor(key, state.threadId);
			if (data.thread?.exists === true) clearNewThread(key);
			state.model = data.thread?.model ?? state.model;
			state.thinkingLevel = data.thread?.thinkingLevel ?? state.thinkingLevel;
			setMessages(data.thread?.messages ?? []);
			state.loadedKey = key;
		} catch (err) {
			if (seq !== state.loadSeq) return;
			setMessages([]);
			state.thread = null;
			state.loadedKey = null;
			pushNotice(`读取对话失败：${err.message}`, "error");
		} finally {
			if (seq === state.loadSeq) {
				state.loading = false;
				render();
			}
		}
	}

	async function ensureLoaded() {
		if (!state.open) return;
		const session = currentSession();
		if (session) await loadSessionPrefs(session.source, session.id);
		syncModeForSession();
		if (state.enabled === null) await loadCapabilities();
		if (state.enabled === false) return;
		await loadSettings();
		await loadThread();
	}

	/** 当前项目的 profile / projectSkills。 */
	async function loadSettings() {
		const session = currentSession();
		if (!session || state.enabled === false) return;
		try {
			const params = new URLSearchParams({ source: session.source, session: session.id });
			const res = await fetch(`/api/chat/settings?${params}`);
			if (!res.ok) return;
			const data = await res.json();
			state.settings = { profile: data.profile ?? "read-only", projectSkills: data.projectSkills === true };
			state.profile = state.settings.profile;
			renderHead();
		} catch {
			/* 读失败保留默认值 */
		}
	}

	/** 技能列表；refresh 会重启 child 重新发现（服务端 60s 缓存，refresh 绕过）。 */
	async function loadSkills({ refresh = false } = {}) {
		const session = currentSession();
		if (!session || state.enabled !== true) return null;
		const key = currentKey();
		const palette = state.palette;
		if (palette) {
			if (palette.loading) return null;
			palette.loading = true;
			palette.error = null;
			palette.confirm = null;
			renderPalette();
		}
		try {
			const params = new URLSearchParams({ source: session.source, session: session.id });
			if (refresh) params.set("refresh", "1");
			const res = await fetch(`/api/chat/skills?${params}`);
			if (!res.ok) {
				let message = `HTTP ${res.status}`;
				try {
					message = (await res.json())?.error ?? message;
				} catch {
					/* 非 JSON 错误体 */
				}
				throw new Error(message);
			}
			const data = await res.json();
			if (currentKey() !== key) return null;
			state.skills = Array.isArray(data.skills) ? data.skills : [];
			state.skillsKey = key;
			state.skillsError = typeof data.error === "string" && data.error ? data.error : null;
			state.skillsDiagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
			state.settings.projectSkills = data.projectSkills === true;
			if (palette) {
				palette.loading = false;
				palette.error = null;
			}
			renderPalette();
			return state.skills;
		} catch (err) {
			if (currentKey() !== key) return null;
			state.skillsError = err.message;
			if (palette) {
				palette.loading = false;
				palette.error = `读取技能失败：${err.message}`;
			}
			renderPalette();
			return null;
		}
	}

	/** 模型列表：5 秒缓存；打开面板时传 refresh=1（服务端走 pi 的可用性检查，失败保留 last-good）。 */
	async function loadModels({ refresh = false } = {}) {
		const session = currentSession();
		if (!session || state.enabled !== true) return;
		if (state.modelsAt && Date.now() - state.modelsAt < MODELS_TTL_MS) return;
		const key = currentKey();
		const palette = state.palette;
		if (palette) {
			if (palette.loading) return;
			palette.loading = true;
			palette.error = null;
			renderPalette();
		}
		try {
			const params = new URLSearchParams({ source: session.source, session: session.id });
			// 新对话尚未落盘：不把虚拟线程 id 当已有文件传给 models；current 由 child 状态兜底。
			if (state.threadId && !isNewThread(key, state.threadId)) params.set("thread", state.threadId);
			if (refresh) params.set("refresh", "1");
			const res = await fetch(`/api/chat/models?${params}`);
			if (!res.ok) {
				let message = `HTTP ${res.status}`;
				try {
					message = (await res.json())?.error ?? message;
				} catch {
					/* 非 JSON 错误体 */
				}
				throw new Error(message);
			}
			const data = await res.json();
			if (currentKey() !== key) return;
			state.models = Array.isArray(data.models) ? data.models : [];
			state.modelsError = typeof data.error === "string" && data.error ? data.error : null;
			state.model = data.current ?? null;
			state.modelsAt = Date.now();
			if (palette) {
				palette.loading = false;
				palette.error = null;
			}
			renderHead();
			renderPalette();
		} catch (err) {
			if (currentKey() !== key) return;
			state.modelsError = err.message;
			state.modelsAt = 0;
			if (palette) {
				palette.loading = false;
				palette.error = `读取模型失败：${err.message}`;
			}
			renderHead();
			renderPalette();
		}
	}

	/** 思考级别：打开 Thinking 层时拉取；无 child 时服务端只读 settings，不 spawn。 */
	async function loadThinking({ refresh = false } = {}) {
		const session = currentSession();
		if (!session || state.enabled !== true) return;
		const key = currentKey();
		const palette = state.palette;
		if (palette && palette.layer === "thinking") {
			if (palette.loading) return;
			palette.loading = true;
			palette.error = null;
			renderPalette();
		}
		try {
			const params = new URLSearchParams({ source: session.source, session: session.id });
			if (state.threadId && !isNewThread(key, state.threadId)) params.set("thread", state.threadId);
			if (refresh) params.set("refresh", "1");
			const res = await fetch(`/api/chat/thinking?${params}`);
			if (!res.ok) {
				let message = `HTTP ${res.status}`;
				try {
					message = (await res.json())?.error ?? message;
				} catch {
					/* 非 JSON 错误体 */
				}
				throw new Error(message);
			}
			const data = await res.json();
			if (currentKey() !== key) return;
			state.thinkingLevel = typeof data.level === "string" ? data.level : state.thinkingLevel;
			state.thinkingLevels = Array.isArray(data.levels) ? data.levels.filter((level) => typeof level === "string" && level) : [];
			state.thinkingError = null;
			if (palette) {
				palette.loading = false;
				palette.error = null;
			}
			renderHead();
			if (state.palette?.layer === "thinking") renderPalette();
		} catch (err) {
			if (currentKey() !== key) return;
			state.thinkingError = err.message;
			if (palette) {
				palette.loading = false;
				palette.error = `读取思考级别失败：${err.message}`;
			}
			renderHead();
			if (state.palette?.layer === "thinking") renderPalette();
		}
	}

	/** 历史线程列表：进入 resume 层时拉取；当前线程用于高亮。 */
	async function loadThreads() {
		const session = currentSession();
		if (!session || state.enabled !== true) return;
		const key = currentKey();
		const palette = state.palette;
		if (palette && palette.layer === "resume") {
			if (palette.loading) return;
			palette.loading = true;
			palette.error = null;
			renderPalette();
		}
		try {
			const params = new URLSearchParams({ source: session.source, session: session.id });
			const res = await fetch(`/api/chat/threads?${params}`);
			if (!res.ok) {
				let message = `HTTP ${res.status}`;
				try {
					message = (await res.json())?.error ?? message;
				} catch {
					/* 非 JSON 错误体 */
				}
				throw new Error(message);
			}
			const data = await res.json();
			if (currentKey() !== key) return;
			state.threads = Array.isArray(data.threads) ? data.threads : [];
			state.threadsAt = Date.now();
			state.threadsError = null;
			if (palette && palette.layer === "resume") {
				palette.loading = false;
				palette.error = null;
			}
			renderPalette();
		} catch (err) {
			if (currentKey() !== key) return;
			state.threadsError = err.message;
			if (palette && palette.layer === "resume") {
				palette.loading = false;
				palette.error = `读取历史对话失败：${err.message}`;
			}
			renderPalette();
		}
	}

	function formatThreadTime(value) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "";
		return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
	}

	// ------------------------------------------------------------------
	// 渲染
	// ------------------------------------------------------------------

	/** 按 id 去重（后出现的覆盖先出现的），避免乐观消息与服务端投影重复。 */
	function setMessages(messages) {
		const byId = new Map();
		for (const message of Array.isArray(messages) ? messages : []) {
			if (!message || typeof message !== "object") continue;
			const id = typeof message.id === "string" && message.id ? message.id : `${message.role}:${byId.size}`;
			byId.set(id, { ...message, id });
		}
		state.messages = [...byId.values()];
	}

	function isNearBottom() {
		if (!list) return true;
		return list.scrollHeight - list.scrollTop - list.clientHeight < 80;
	}

	function renderMessages() {
		if (!list) return;
		const stick = isNearBottom();
		if (state.mode === "forward") {
			list.replaceChildren(...buildForwardNodes());
		} else {
			list.replaceChildren(...buildMessageNodes());
		}
		if (stick) list.scrollTop = list.scrollHeight;
	}

	function currentForwardLog() {
		const key = currentKey();
		if (!key) return [];
		return state.forwardLogs.get(key) ?? [];
	}

	function appendForwardLog(entry) {
		const key = currentKey();
		if (!key) return;
		const log = state.forwardLogs.get(key) ?? [];
		log.push(entry);
		state.forwardLogs.set(key, log);
	}

	function buildForwardNodes() {
		const nodes = [h("div", { class: "chat-forward-note", text: "转发模式：回答和工具审批在控制台完成；主轨迹区会显示新事件。" })];
		if (!currentSession()) {
			nodes.push(h("div", { class: "chat-empty", text: "先在左侧选择一个会话" }));
			return nodes;
		}
		const confirm = state.forwardConfirm;
		if (confirm && confirm.key === currentKey()) {
			nodes.push(
				h(
					"div",
					{ class: "chat-forward-confirm" },
					h("div", { class: "chat-forward-confirm-text", text: "插话会改变控制台当前任务的方向，确定发送？" }),
					h(
						"div",
						{ class: "chat-forward-confirm-actions" },
						h("button", { class: "chat-forward-confirm-yes", type: "button", text: "确认插话", onClick: () => void sendForward() }),
						h(
							"button",
							{
								class: "chat-forward-confirm-no",
								type: "button",
								text: "取消",
								onClick: () => {
									state.forwardConfirm = null;
									state.forwardDelivery = "auto";
									if (forwardDeliveryEl) forwardDeliveryEl.value = "auto";
									render();
								},
							},
						),
					),
				),
			);
		}
		const log = currentForwardLog();
		if (!log.length) {
			nodes.push(
				h("div", {
					class: "chat-empty",
					text: currentConsoleInfo() ? "输入问题，转发到当前控制台。" : "未检测到可转发控制台。",
				}),
			);
			return nodes;
		}
		for (const entry of log) {
			if (entry.kind === "user") {
				nodes.push(
					h(
						"div",
						{ class: "chat-forward-user" },
						h("div", { class: "chat-forward-tag", text: "→ 控制台" }),
						h("div", { class: "chat-forward-text", text: entry.text }),
					),
				);
			} else {
				nodes.push(
					h("div", {
						class: `chat-forward-status${entry.tone === "error" ? " is-error" : ""}`,
						text: entry.text,
					}),
				);
			}
		}
		return nodes;
	}

	function buildMessageNodes() {
		if (state.enabled === null || state.loading) return skeletonNodes();
		if (state.enabled === false) return [h("div", { class: "chat-empty", text: `对话不可用：${state.reason || "未启用"}` })];
		if (!currentSession()) return [h("div", { class: "chat-empty", text: "先在左侧选择一个会话" })];
		if (state.messages.length === 0) return [h("div", { class: "chat-empty", text: "输入问题，开始和 pi 对话。" })];
		return state.messages.map(messageNode).filter(Boolean);
	}

	function skeletonNodes() {
		return [0, 1, 2].map((i) => h("div", { class: `chat-skeleton${i === 2 ? " short" : ""}`, "aria-hidden": "true" }));
	}

	function messageNode(message) {
		if (message.role === "user") {
			const wrap = h("div", { class: "chat-msg-user" }, h("div", { class: "chat-msg user", text: message.displayText ?? message.text ?? "" }));
			const meta = userMeta(message);
			if (meta) wrap.appendChild(h("div", { class: "chat-msg-meta", text: meta }));
			return wrap;
		}
		if (message.role === "assistant") return assistantNode(message);
		if (message.role === "tool") return toolNode(message);
		if (message.role === "notice") {
			return h("div", { class: `chat-notice${message.kind === "error" ? " is-error" : ""}`, text: message.text ?? "" });
		}
		return null;
	}

	function userMeta(message) {
		const parts = [];
		if (Array.isArray(message.context) && message.context.length) parts.push(`上下文 ${message.context.length}`);
		if (message.skill) {
			const name = typeof message.skill === "string" ? message.skill : message.skill.name;
			if (name) parts.push(`技能 ${name}`);
		}
		return parts.join(" · ");
	}

	function assistantNode(message) {
		const streaming = message.streaming === true;
		const node = h("div", { class: `chat-msg ai${streaming ? " is-streaming" : ""}` });
		if (message.text) node.appendChild(mdNode(String(message.text)));
		else if (streaming) node.appendChild(h("div", { class: "chat-thinking", text: state.status === "thinking" ? "思考中…" : "正在生成…" }));
		if (streaming) node.appendChild(h("span", { class: "chat-stream-cursor", "aria-hidden": "true", text: "▍" }));
		if (message.error) node.appendChild(h("div", { class: "chat-msg-error", text: `生成中断：${message.error}` }));
		else if (message.stopReason === "aborted") node.appendChild(h("div", { class: "chat-msg-error", text: "已停止" }));
		else if (!streaming && !message.text && message.open === false) node.appendChild(h("div", { class: "chat-thinking", text: "模型没有返回可见文本" }));
		const meta = assistantMeta(message);
		if (meta) node.appendChild(h("div", { class: "chat-msg-meta", text: meta }));
		return node;
	}

	function assistantMeta(message) {
		const parts = [];
		const modelName = message.model?.name || message.model?.id;
		if (modelName) parts.push(modelName);
		if (Number.isFinite(message.durationMs)) parts.push(formatDuration(message.durationMs));
		if (message.usage?.totalTokens) parts.push(`${fmtTokens(message.usage.totalTokens)} tokens`);
		return parts.join(" · ");
	}

	function formatDuration(ms) {
		if (!Number.isFinite(ms)) return "";
		return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
	}

	function toolNode(message) {
		const done = message.phase === "end";
		const head = h(
			"div",
			{ class: "chat-tool-head" },
			h("span", { class: "chat-tool-name", text: message.toolName || "tool" }),
			h("span", { class: `chat-tool-phase${message.isError ? " is-error" : ""}`, text: done ? (message.isError ? "失败" : "完成") : "调用中…" }),
		);
		const body = [];
		if (message.argsPreview) body.push(h("div", { class: "chat-tool-body", text: String(message.argsPreview) }));
		if (message.resultPreview) {
			body.push(h("div", { class: `chat-tool-body result${message.isError ? " is-error" : ""}`, text: String(message.resultPreview) }));
		}
		return h("div", { class: `chat-tool${message.isError ? " is-error" : ""}` }, head, ...body);
	}

	function renderHead() {
		const modelEl = el("chat-model-label");
		const modelNameEl = el("chat-model-name");
		const effortEl = el("chat-thinking");
		if (modelNameEl) {
			modelNameEl.textContent = state.model ? modelLabel(state.model) : state.loading ? "读取模型中…" : "默认模型";
		}
		if (effortEl) {
			effortEl.textContent = state.thinkingLevel ?? "—";
			effortEl.title = state.thinkingLevel ? `思考级别：${state.thinkingLevel}` : "思考级别";
		}
		if (modelEl) {
			const provider = state.model?.provider ?? "";
			const id = state.model?.id ?? "";
			const modelPart = id ? `${provider}/${id}` : state.loading ? "读取模型中…" : "默认模型";
			modelEl.title = state.thinkingLevel ? `${modelPart} · 思考级别：${state.thinkingLevel}` : modelPart;
			modelEl.classList.toggle("is-warn", Boolean(state.modelsError || state.thinkingError));
			if (state.modelsError) modelEl.title = `${modelEl.title} · ${state.modelsError}`;
			if (state.thinkingError) modelEl.title = `${modelEl.title} · ${state.thinkingError}`;
		}
		const profileEl = el("chat-profile");
		const profileLabelEl = el("chat-profile-label");
		if (profileLabelEl) profileLabelEl.textContent = PROFILE_LABEL[state.profile] ?? state.profile;
		if (profileEl) {
			profileEl.classList.toggle("is-full", state.profile === "full");
			profileEl.title = state.profile === "full" ? "全量工具：会真实修改工作区，每次执行前审批" : "工具权限";
		}
	}

	function updateSendButton() {
		if (!sendBtn) return;
		if (state.mode === "forward") {
			const info = currentConsoleInfo();
			const canSend =
				Boolean(info) && !state.forwardBusy && !independentBusy() && !state.palette && input?.value.trim().length > 0;
			sendBtn.disabled = !canSend;
			sendBtn.classList.remove("is-stop");
			const label = state.forwardBusy
				? "转发中…"
				: !info
					? "未检测到可转发控制台"
					: independentBusy()
						? "独立对话正在运行，先停止或等待完成"
						: "转发到控制台";
			sendBtn.title = label;
			sendBtn.setAttribute("aria-label", label);
			if (sendIcon && sendBtn.firstElementChild !== sendIcon) sendBtn.replaceChildren(sendIcon.cloneNode(true));
			return;
		}
		const canSend = state.enabled === true && !!currentSession() && !state.palette && input?.value.trim().length > 0;
		sendBtn.disabled = state.streaming ? false : !canSend;
		sendBtn.classList.toggle("is-stop", state.streaming);
		const label = state.streaming ? "停止生成" : "发送（Enter）";
		sendBtn.title = label;
		sendBtn.setAttribute("aria-label", state.streaming ? "停止生成" : "发送");
		if (state.streaming) {
			sendBtn.replaceChildren(h("span", { class: "chat-stop-glyph", "aria-hidden": "true", text: "■" }));
		} else if (sendIcon && sendBtn.firstElementChild !== sendIcon) {
			sendBtn.replaceChildren(sendIcon.cloneNode(true));
		}
	}

	function renderComposer() {
		if (!input) return;
		if (state.mode === "forward") {
			const session = currentSession();
			const info = currentConsoleInfo();
			input.disabled = !session || !info;
			input.placeholder = !session
				? "先在左侧选择一个会话"
				: !info
					? "未检测到可转发控制台"
					: info.state === "working"
						? "转发到控制台（忙碌，默认排队）…"
						: "转发到控制台…";
			return;
		}
		const blocked = state.enabled === false || !currentSession();
		input.disabled = blocked;
		input.placeholder = state.enabled === false ? "对话不可用" : blocked ? "先在左侧选择一个会话" : "问问这条轨迹…";
	}

	function render() {
		renderHead();
		renderMessages();
		renderComposer();
		renderModeControls();
		renderSkillChip();
		renderContext();
		renderConsoleStatus();
		renderProfileMenu();
		renderApproval();
		updateSendButton();
		updateA11y();
		renderPalette();
	}

	function renderModeControls() {
		const forward = state.mode === "forward";
		const info = currentConsoleInfo();
		const hasConsole = Boolean(info);
		// 单钮反转：文案/高亮显示当前模式，点击切到另一模式；独立模式下无控制台时禁用
		if (modeToggleBtn) {
			modeToggleBtn.textContent = forward ? "转发" : "独立";
			modeToggleBtn.setAttribute("data-mode", state.mode);
			modeToggleBtn.setAttribute("aria-pressed", String(forward));
			modeToggleBtn.disabled = !forward && !hasConsole;
			modeToggleBtn.title = forward
				? "转发到当前控制台：点击切回独立对话"
					: hasConsole
						? "独立对话：点击切到转发模式"
						: "当前会话没有可转发控制台";
		}
		if (addBtn) addBtn.hidden = forward;
		const profileBtn = el("chat-profile");
		if (profileBtn) profileBtn.hidden = forward;
		if (modelBtn) modelBtn.hidden = forward;
		if (forwardDeliveryEl) {
			const show = forward && info?.state === "working";
			forwardDeliveryEl.hidden = !show;
			if (state.forwardDelivery !== "auto" && state.forwardDelivery !== "steer") state.forwardDelivery = "auto";
			forwardDeliveryEl.value = state.forwardDelivery;
		}
	}

	/** 控制台状态条：独立模式只在有桥时显示；转发模式显示在线/离线/不可用。 */
	function renderConsoleStatus() {
		if (!consoleStatusEl) return;
		const session = currentSession();
		const info = session ? currentConsoleInfo() : null;
		const key = session ? sessionKeyOf(session) : "";
		const lost = key ? state.consoleLost.has(key) : false;
		const label = forwardStatusLabel(state.mode, info, lost);
		if (!state.open || !session || !label) {
			consoleStatusEl.hidden = true;
			consoleStatusEl.replaceChildren();
			consoleStatusEl.removeAttribute("title");
			return;
		}
		const tone = info ? info.state : lost ? "offline" : "unavailable";
		consoleStatusEl.hidden = false;
		consoleStatusEl.className = `chat-console-status is-${tone}`;
		consoleStatusEl.title = info
			? `${label}${info.pid ? `（PID ${info.pid}）` : ""}；回答和工具审批在控制台完成`
			: state.mode === "forward"
				? "转发模式下需要当前会话有已注册控制台"
				: label;
		consoleStatusEl.replaceChildren(
			h("span", { class: "console-status-dot", "aria-hidden": "true" }),
			h("span", { class: "console-status-label", text: label }),
			info?.pid ? h("span", { class: "console-status-pid", text: `PID ${info.pid}` }) : null,
		);
	}

	function contextIds() {
		return deps.getSelectedIds?.() ?? [];
	}

	function contextRefs(ids) {
		const list = Array.isArray(ids) ? ids : [];
		const refs = deps.getEventRefs?.(list) ?? [];
		return list.map((id) => refs.find((ref) => ref.id === id) ?? { id, kind: "unknown", label: "失效条目", preview: "", invalid: true });
	}

	/** 上下文摘要按钮 + 独立弹层；摘要永不横向溢出。 */
	function renderContext() {
		const box = el("chat-context");
		if (!box) return;
		const ids = contextIds();
		if (!state.open || state.mode === "forward" || ids.length === 0) {
			box.hidden = true;
			box.replaceChildren();
			box.setAttribute("aria-expanded", "false");
			closeContextMenu({ focus: false });
			return;
		}
		const refs = contextRefs(ids);
		const meta = contextSummaryLabel(ids, refs);
		box.hidden = false;
		box.setAttribute("aria-expanded", String(state.contextMenuOpen));
		box.setAttribute("aria-label", `上下文 ${meta.count}：${meta.summary}`);
		const children = [
			h("span", { class: "chat-context-count", text: `上下文 ${meta.count}` }),
			h("span", { class: "chat-context-sep", text: "·" }),
			h("span", { class: "chat-context-summary", text: meta.summary }),
		];
		if (meta.moreLabel) children.push(h("span", { class: "chat-context-more", text: meta.moreLabel }));
		children.push(h("span", { class: "chat-context-chevron", "aria-hidden": "true", text: "▸" }));
		box.replaceChildren(...children);
		renderContextMenu();
	}

	function contextRow(ref) {
		const label = ref.invalid ? "失效条目" : ref.label || "失效条目";
		const preview = ref.invalid ? "失效条目" : ref.preview || ref.label || "";
		return h(
			"div",
			{ class: `chat-context-row${ref.invalid ? " is-invalid" : ""}`, role: "listitem" },
			h(
				"button",
				{
					class: "chat-context-row-main",
					type: "button",
					title: preview || label,
					onClick: () => deps.openEvent?.(ref.id),
				},
				h("span", { class: "chat-context-row-tag", text: label }),
				h("span", { class: "chat-context-row-preview", text: preview }),
			),
			h("button", {
				class: "chat-context-row-remove",
				type: "button",
				title: "移除",
				"aria-label": `移除 ${label} ${preview}`,
				text: "×",
				onClick: (event) => {
					event.stopPropagation();
					const next = contextIds().filter((id) => id !== ref.id);
					setContextIds(next);
					if (next.length === 0) closeContextMenu({ focus: false });
				},
			}),
		);
	}

	function renderContextMenu() {
		if (!contextMenuEl) return;
		const ids = contextIds();
		if (!state.open || !state.contextMenuOpen || ids.length === 0) {
			state.contextMenuOpen = false;
			contextMenuEl.hidden = true;
			contextMenuEl.replaceChildren();
			contextBtn?.setAttribute("aria-expanded", "false");
			clearAnchoredMenu(contextMenuEl);
			return;
		}
		const refs = contextRefs(ids);
		const meta = contextSummaryLabel(ids, refs);
		contextMenuEl.hidden = false;
		contextMenuEl.replaceChildren(
			h(
				"div",
				{ class: "chat-context-menu-head" },
				h("span", { class: "chat-context-menu-title", text: `上下文 ${meta.count}` }),
				h("button", {
					class: "chat-context-menu-clear",
					type: "button",
					"aria-label": "清空对话上下文",
					text: "清空",
					onClick: () => {
						setContextIds([]);
						closeContextMenu({ focus: false });
					},
				}),
			),
			h("div", { class: "chat-context-menu-sep", "aria-hidden": "true" }),
			h("div", { class: "chat-context-menu-list", role: "list" }, ...refs.map(contextRow)),
			h("div", { class: "chat-context-menu-sep", "aria-hidden": "true" }),
			h(
				"div",
				{ class: "chat-context-menu-foot" },
				h("button", {
					class: "chat-context-menu-new",
					type: "button",
					text: "以此新开",
					onClick: () => {
						closeContextMenu({ focus: false });
						void newThreadPreservingSelection();
					},
				}),
			),
		);
		contextBtn?.setAttribute("aria-expanded", "true");
		positionContextMenu();
	}

	function positionContextMenu() {
		if (!state.contextMenuOpen) {
			clearAnchoredMenu(contextMenuEl);
			return;
		}
		positionAnchoredMenu(contextMenuEl, contextBtn, CONTEXT_MENU_ANCHOR);
	}

	function openContextMenu() {
		if (state.mode === "forward" || !state.open || contextIds().length === 0) return;
		if (state.palette) closePalette({ restore: true, focus: false });
		closeProfileMenu();
		state.contextMenuOpen = true;
		renderContextMenu();
		const first = contextMenuEl?.querySelector("button, [href], input, [tabindex]:not([tabindex='-1'])");
		first?.focus?.();
	}

	function closeContextMenu({ focus = true } = {}) {
		const wasOpen = state.contextMenuOpen;
		state.contextMenuOpen = false;
		renderContextMenu();
		if (focus && wasOpen && state.open && contextIds().length) contextBtn?.focus?.();
	}

	function setContextIds(ids) {
		deps.setSelectedIds?.(ids, { silent: true });
		renderContext();
		updateSendButton();
	}

	async function newThread({ preserveSelection = false } = {}) {
		if (state.streaming) {
			pushNotice("回复中，先停止", "warn");
			flushRender();
			return;
		}
		const session = currentSession();
		if (!session) return;
		const key = sessionKeyOf(session);
		try {
			const res = await fetch("/api/chat/thread", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: session.source, session: session.id }),
			});
			if (!res.ok) {
				let message = `HTTP ${res.status}`;
				try {
					message = (await res.json())?.error ?? message;
				} catch {
					/* 非 JSON 错误体 */
				}
				throw new Error(message);
			}
			const data = await res.json();
			state.thread = data.thread ?? null;
			state.threadId = data.thread?.id ?? null;
			state.model = data.thread?.model ?? state.model;
			state.skill = null;
			state.loadedKey = key;
			if (state.threadId) {
				state.newThreadIds.add(state.threadId);
				rememberThreadFor(key, state.threadId);
				markNewThread(key, state.threadId);
			}
			setMessages([]);
			clearApprovals();
			closeProfileMenu();
			if (!preserveSelection) deps.setSelectedIds?.([], { silent: true });
			render();
			pushNotice(preserveSelection ? "已新建对话（保留当前上下文选择）" : "已新建对话");
			flushRender();
		} catch (err) {
			pushNotice(`新建对话失败：${err.message}`, "error");
			flushRender();
		}
	}

	async function newThreadPreservingSelection() {
		return newThread({ preserveSelection: true });
	}

	/** 切回历史线程：服务端 switch_session 后直接渲染返回的 thread。 */
	async function resumeThread(thread) {
		if (!thread || !state.palette) return;
		if (state.streaming) {
			state.palette.error = "回复中，先停止";
			renderPalette();
			return;
		}
		const session = currentSession();
		if (!session) return;
		const key = currentKey();
		state.palette.busy = true;
		state.palette.error = null;
		renderPalette();
		try {
			const res = await fetch("/api/chat/resume", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: session.source, session: session.id, threadId: thread.id }),
			});
			if (!res.ok) {
				let message = `HTTP ${res.status}`;
				try {
					message = (await res.json())?.error ?? message;
				} catch {
					/* 非 JSON 错误体 */
				}
				throw new Error(message);
			}
			const data = await res.json();
			if (currentKey() !== key) return;
			const next = data.thread ?? null;
			const nextId = next?.id ?? thread.id;
			state.thread = next;
			state.threadId = nextId;
			state.model = next?.model ?? state.model;
			state.loadedKey = key;
			state.loadSeq++;
			if (nextId) {
				state.newThreadIds.delete(nextId);
				rememberThreadFor(key, nextId);
				clearNewThread(key);
			}
			setMessages(next?.messages ?? []);
			clearApprovals();
			closePalette({ clearInput: true });
			const lastUser = [...state.messages].reverse().find((message) => message.role === "user");
			const contextIds = Array.isArray(lastUser?.context)
				? lastUser.context.map((item) => item?.id).filter((id) => typeof id === "string" && id)
				: [];
			deps.setSelectedIds?.(contextIds, { silent: true });
			renderContext();
			render();
			pushNotice("已切换到历史对话");
			flushRender();
		} catch (err) {
			if (!state.palette) return;
			state.palette.busy = false;
			state.palette.error = `切换历史对话失败：${err.message}`;
			renderPalette();
		}
	}

	// ------------------------------------------------------------------
	// 工具权限菜单
	// ------------------------------------------------------------------

	function openProfileMenu() {
		if (state.mode === "forward") return;
		if (state.streaming) {
			pushNotice("回复中，先停止", "warn");
			flushRender();
			return;
		}
		if (state.palette) closePalette({ restore: true, focus: false });
		closeContextMenu({ focus: false });
		state.profileMenuOpen = true;
		state.profileConfirm = false;
		renderProfileMenu();
	}

	function closeProfileMenu() {
		state.profileMenuOpen = false;
		state.profileConfirm = false;
		state.profileBusy = false;
		renderProfileMenu();
	}

	function renderProfileMenu() {
		if (!profileMenuEl) return;
		const profileBtn = el("chat-profile");
		profileBtn?.setAttribute("aria-expanded", String(state.profileMenuOpen));
		if (!state.profileMenuOpen) {
			profileMenuEl.hidden = true;
			profileMenuEl.replaceChildren();
			clearAnchoredMenu(profileMenuEl);
			return;
		}
		profileMenuEl.hidden = false;
		if (state.profileConfirm) {
			profileMenuEl.replaceChildren(
				h(
					"div",
					{ class: "chat-profile-confirm" },
					h("div", { class: "chat-profile-confirm-text", text: "全量工具会真实修改工作区，每次执行前会请求确认" }),
					h(
						"div",
						{ class: "chat-profile-confirm-actions" },
						h("button", { type: "button", class: "chat-profile-confirm-yes", dataset: { profileConfirm: "yes" }, text: "确认切换" }),
						h("button", { type: "button", class: "chat-profile-confirm-no", dataset: { profileConfirm: "no" }, text: "取消" }),
					),
				),
			);
			positionProfileMenu();
			return;
		}
		const nodes = [];
		for (const option of PROFILE_OPTIONS) {
			const current = state.profile === option.id;
			nodes.push(
				h(
					"button",
					{
						class: `chat-profile-option${current ? " is-current" : ""}${option.warn ? " is-warn" : ""}`,
						type: "button",
						role: "menuitemradio",
						"aria-checked": String(current),
						dataset: { profile: option.id },
						disabled: state.profileBusy,
					},
					h("span", { class: "chat-profile-option-check", "aria-hidden": "true", text: current ? "✓" : "" }),
					h(
						"span",
						{ class: "chat-profile-option-body" },
						h("span", { class: "chat-profile-option-label", text: option.label }),
						h("span", { class: "chat-profile-option-hint", text: option.hint }),
					),
				),
			);
		}
		profileMenuEl.replaceChildren(...nodes);
		positionProfileMenu();
	}

	async function selectProfile(profile) {
		if (state.profileBusy) return;
		if (state.streaming) {
			pushNotice("回复中，先停止", "warn");
			closeProfileMenu();
			flushRender();
			return;
		}
		if (profile === state.profile) {
			closeProfileMenu();
			return;
		}
		if (profile === "full" && !state.fullConfirmed) {
			state.profileConfirm = true;
			renderProfileMenu();
			return;
		}
		await applyProfile(profile);
	}

	async function applyProfile(profile) {
		const session = currentSession();
		if (!session) return;
		state.profileBusy = true;
		state.profileConfirm = false;
		renderProfileMenu();
		try {
			const res = await fetch("/api/chat/settings", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: session.source, session: session.id, profile }),
			});
			if (!res.ok) {
				let message = `HTTP ${res.status}`;
				try {
					message = (await res.json())?.error ?? message;
				} catch {
					/* 非 JSON 错误体 */
				}
				throw new Error(message);
			}
			const data = await res.json();
			state.settings.profile = data.profile ?? profile;
			state.profile = state.settings.profile;
			if (profile === "full") state.fullConfirmed = true;
			closeProfileMenu();
			pushNotice("对话进程已重启");
			flushRender();
			try {
				await loadThread({ force: true });
			} catch (err) {
				pushNotice(`刷新对话失败：${err.message}`, "error");
				flushRender();
			}
		} catch (err) {
			state.profileBusy = false;
			renderProfileMenu();
			pushNotice(`切换工具权限失败：${err.message}`, "error");
			flushRender();
		}
	}

	// ------------------------------------------------------------------
	// 工具审批弹层（队列 + 倒计时）
	// ------------------------------------------------------------------

	function stopApprovalTimer() {
		if (state.approvalTimer) clearInterval(state.approvalTimer);
		state.approvalTimer = 0;
	}

	function clearApprovals() {
		stopApprovalTimer();
		state.approvals = [];
		state.approvalChecked = false;
		state.approvalBusy = false;
		state.approvalRemaining = 0;
		state.approvalRenderedId = null;
		renderApproval();
	}

	function enqueueApproval(data) {
		if (!data || typeof data.id !== "string" || !data.id) return;
		closeProfileMenu();
		state.approvals.push({
			id: data.id,
			toolName: typeof data.toolName === "string" ? data.toolName : null,
			title: typeof data.title === "string" && data.title ? data.title : "允许执行工具？",
			message: typeof data.message === "string" ? data.message.slice(0, 500) : "",
			timeout: Number(data.timeout) > 0 ? Number(data.timeout) : 120,
		});
		state.approvalChecked = false;
		state.approvalRenderedId = null;
		startApprovalTimer();
		renderApproval();
	}

	function startApprovalTimer() {
		stopApprovalTimer();
		const approval = state.approvals[0];
		if (!approval) return;
		state.approvalStart = Date.now();
		state.approvalRemaining = approval.timeout;
		state.approvalTimer = setInterval(() => {
			const remaining = Math.max(0, Math.ceil(approval.timeout - (Date.now() - state.approvalStart) / 1000));
			state.approvalRemaining = remaining;
			renderApproval();
			if (remaining <= 0) void respondApproval(false);
		}, 500);
		state.approvalTimer.unref?.();
	}

	async function respondApproval(confirmed) {
		const approval = state.approvals[0];
		if (!approval || state.approvalBusy) return;
		state.approvalBusy = true;
		renderApproval();
		const allowForSession = confirmed && state.approvalChecked;
		try {
			const session = currentSession();
			if (session) {
				await fetch("/api/chat/approval", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						source: session.source,
						session: session.id,
						threadId: state.threadId ?? null,
						id: approval.id,
						confirmed,
						allowForSession,
					}),
				});
			}
		} catch {
			/* 服务端会按超时/断开拒绝 */
		}
		state.approvals.shift();
		state.approvalChecked = false;
		state.approvalBusy = false;
		state.approvalRenderedId = null;
		stopApprovalTimer();
		if (state.approvals.length) startApprovalTimer();
		renderApproval();
	}

	function renderApproval() {
		if (!approvalEl) return;
		if (state.mode === "forward") {
			approvalEl.hidden = true;
			return;
		}
		const approval = state.approvals[0];
		if (!approval) {
			stopApprovalTimer();
			approvalEl.hidden = true;
			approvalEl.replaceChildren();
			return;
		}
		approvalEl.hidden = false;
		const count = state.approvals.length;
		if (state.approvalRenderedId === approval.id && approvalEl.querySelector(".chat-approval-card")) {
			const timer = approvalEl.querySelector(".chat-approval-timer");
			if (timer) timer.textContent = `⏱ ${state.approvalRemaining}s`;
			const counter = approvalEl.querySelector(".chat-approval-count");
			if (counter) counter.textContent = `1/${count}`;
			const denyBtn = approvalEl.querySelector(".chat-approval-deny");
			const allowBtn = approvalEl.querySelector(".chat-approval-allow");
			if (denyBtn) denyBtn.disabled = state.approvalBusy;
			if (allowBtn) allowBtn.disabled = state.approvalBusy;
			return;
		}
		state.approvalRenderedId = approval.id;
		const checkbox = h("input", { type: "checkbox", class: "chat-approval-check", checked: state.approvalChecked });
		checkbox.addEventListener("change", () => {
			state.approvalChecked = checkbox.checked;
		});
		const deny = h("button", { class: "chat-approval-deny", type: "button", text: "拒绝", disabled: state.approvalBusy });
		deny.addEventListener("click", () => void respondApproval(false));
		const allow = h("button", { class: "chat-approval-allow", type: "button", text: "仅本次允许", disabled: state.approvalBusy });
		allow.addEventListener("click", () => void respondApproval(true));
		approvalEl.replaceChildren(
			h(
				"div",
				{ class: "chat-approval-card", role: "document" },
				h(
					"div",
					{ class: "chat-approval-head" },
					h("span", { class: "chat-approval-title", text: approval.title }),
					h("span", { class: "chat-approval-count", text: `1/${count}` }),
					h("span", { class: "chat-approval-timer", text: `⏱ ${state.approvalRemaining}s` }),
				),
				approval.toolName ? h("div", { class: "chat-approval-tool", text: approval.toolName }) : null,
				approval.message ? h("pre", { class: "chat-approval-message", text: approval.message }) : null,
				h(
					"label",
					{ class: "chat-approval-allow-row" },
					checkbox,
					h("span", { text: `本会话允许 ${approval.toolName ?? "该工具"}` }),
				),
				h("div", { class: "chat-approval-actions" }, deny, allow),
			),
		);
	}

	/** 流式中 aria-live=off（避免逐字朗读）；收尾时短暂 hold，只让 #chat-announcer 播报最后一条。 */
	function updateA11y() {
		if (!list) return;
		list.setAttribute("aria-busy", state.streaming ? "true" : "false");
		list.setAttribute("aria-live", state.streaming || state.a11yHold ? "off" : "polite");
	}

	function announce(text) {
		if (!announcer) return;
		announcer.textContent = String(text ?? "").trim().slice(0, 500);
	}

	function scheduleRender() {
		if (renderTimer || renderRaf) return;
		const delay = Math.max(0, RENDER_MIN_MS - (Date.now() - state.lastRenderAt));
		if (delay === 0 && typeof requestAnimationFrame === "function") {
			renderRaf = requestAnimationFrame(() => {
				renderRaf = 0;
				state.lastRenderAt = Date.now();
				renderMessages();
			});
			return;
		}
		renderTimer = setTimeout(() => {
			renderTimer = 0;
			state.lastRenderAt = Date.now();
			renderMessages();
		}, delay);
	}

	function flushRender() {
		if (renderTimer) {
			clearTimeout(renderTimer);
			renderTimer = 0;
		}
		if (renderRaf) {
			if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(renderRaf);
			renderRaf = 0;
		}
		state.lastRenderAt = Date.now();
		render();
	}

	function pushNotice(text, kind = "info") {
		if (!text) return;
		state.messages.push({ id: localId("n"), role: "notice", kind, text });
		scheduleRender();
	}

	// ------------------------------------------------------------------
	// 斜杠面板：command 层 → 模型 / 技能层
	// ------------------------------------------------------------------

	function paletteQuery() {
		return String(paletteSearchEl?.value ?? "").trim();
	}

	function skillScopeLabel(scope) {
		return SKILL_SCOPE_LABEL[scope] ?? "其它技能";
	}

	function paletteModelItems() {
		return state.models
			.map((model) => ({
				kind: "model",
				provider: model.provider,
				providerName: model.providerName || model.provider,
				id: model.id,
				label: model.name || model.id,
				hint: [model.providerName || model.provider, model.reasoning ? "推理" : "", model.contextWindow ? formatContextWindow(model.contextWindow) : ""]
					.filter(Boolean)
					.join(" · "),
				group: model.providerName || model.provider || "模型",
				search: [model.name, model.id, model.provider, model.providerName].filter(Boolean).join(" "),
				model,
			}))
			.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
	}

	function paletteThinkingItems() {
		return state.thinkingLevels.map((level) => ({
			kind: "thinking",
			id: level,
			label: level,
			group: "思考级别",
			hint: level === state.thinkingLevel ? "当前" : "",
			search: level,
		}));
	}

	function paletteModelRootItems() {
		return [
			{
				kind: "modelRoot",
				id: "model",
				label: "模型",
				group: "模型 / 级别",
				hint: state.model ? modelLabel(state.model) : "—",
				search: "模型 model",
			},
			{
				kind: "modelRoot",
				id: "effort",
				label: "级别",
				group: "模型 / 级别",
				hint: state.thinkingLevel ?? "—",
				search: "级别 effort thinking",
			},
		];
	}

	function paletteItems() {
		if (!state.palette) return [];
		const query = paletteQuery();
		if (state.palette.layer === "command") return filterPaletteItems(COMMAND_ITEMS, query);
		if (state.palette.layer === "modelRoot") return filterPaletteItems(paletteModelRootItems(), query);
		if (state.palette.layer === "skill") return filterPaletteItems(paletteSkillItems(), query);
		if (state.palette.layer === "resume") return filterPaletteItems(paletteThreadItems(), query);
		if (state.palette.layer === "thinking") return filterPaletteItems(paletteThinkingItems(), query);
		return filterPaletteItems(paletteModelItems(), query);
	}

	function paletteThreadItems() {
		return state.threads.map((thread) => {
			const model = thread.model ? modelLabel(thread.model) : "模型未知";
			const text = typeof thread.firstUserText === "string" && thread.firstUserText ? thread.firstUserText : "（空对话）";
			return {
				kind: "thread",
				id: thread.id,
				label: text,
				group: "历史对话",
				hint: [formatThreadTime(thread.mtime), `${Number(thread.turns) || 0} 轮`, model].filter(Boolean).join(" · "),
				search: [text, thread.id, model].filter(Boolean).join(" "),
				thread,
			};
		});
	}

	function paletteSkillItems() {
		return state.skills
			.map((skill) => {
				const chars = Number.isFinite(skill.chars) ? skill.chars : null;
				const warning = chars !== null && chars > SKILL_WARN_CHARS;
				const disabled = chars !== null && chars > SKILL_MAX_CHARS;
				return {
					kind: "skill",
					name: skill.name,
					label: skill.name,
					scope: skill.scope ?? null,
					group: skillScopeLabel(skill.scope),
					search: [skill.name, skill.description, skill.scope, skill.source].filter(Boolean).join(" "),
					description: typeof skill.description === "string" ? skill.description : "",
					chars,
					warning,
					disabled,
					disableModelInvocation: skill.disableModelInvocation === true,
					skill,
				};
			})
			.sort(
				(a, b) =>
					(SKILL_SCOPE_ORDER[a.scope] ?? 9) - (SKILL_SCOPE_ORDER[b.scope] ?? 9) || a.label.localeCompare(b.label),
			);
	}

	function renderPalette() {
		if (!paletteEl || !paletteListEl) return;
		if (!state.palette) {
			paletteEl.hidden = true;
			paletteListEl.replaceChildren();
			clearAnchoredMenu(paletteEl);
			return;
		}
		paletteEl.hidden = false;
		const layer = state.palette.layer;
		const label =
			layer === "modelRoot"
				? "模型 / 级别"
				: layer === "model"
					? "选择模型"
					: layer === "thinking"
					? "选择思考级别"
					: layer === "skill"
						? "选择技能"
						: layer === "resume"
							? "选择历史对话"
							: "斜杠命令";
		paletteListEl.setAttribute("aria-label", label);
		if (paletteSearchEl) {
			const placeholder =
				layer === "modelRoot"
					? "搜索模型 / 级别…"
					: layer === "model"
						? "搜索模型…"
					: layer === "thinking"
						? "搜索级别…"
						: layer === "skill"
							? "搜索技能…"
							: layer === "resume"
								? "搜索历史对话…"
								: "搜索命令…";
			paletteSearchEl.placeholder = placeholder;
			paletteSearchEl.setAttribute("aria-label", placeholder);
		}
		const nodes = [];

		if (layer === "skill" && state.palette.confirm) {
			const item = state.palette.confirm;
			nodes.push(
				h(
					"div",
					{ class: "chat-palette-confirm" },
					h("div", { class: "chat-palette-confirm-text", text: `技能正文 ${formatChars(item.chars)} 字符，可能超出上下文，仍要发送？` }),
					h(
						"div",
						{ class: "chat-palette-confirm-actions" },
						h("button", { class: "chat-palette-confirm-yes", type: "button", dataset: { skillConfirm: "yes" }, text: "仍要使用" }),
						h("button", { class: "chat-palette-confirm-no", type: "button", dataset: { skillConfirm: "no" }, text: "取消" }),
					),
				),
			);
			paletteListEl.replaceChildren(...nodes);
			positionPalette();
			return;
		}

		if (layer === "skill") {
			const toggle = h(
				"button",
				{
					class: `chat-palette-switch${state.settings.projectSkills ? " is-on" : ""}`,
					type: "button",
					role: "switch",
					"aria-checked": String(state.settings.projectSkills),
					dataset: { settingsToggle: "projectSkills" },
					title: "会加载该项目的技能文件，可能包含第三方提示词",
				},
				h("span", { class: "chat-palette-switch-label", text: "使用本项目技能" }),
				h("span", { class: "chat-palette-switch-track", "aria-hidden": "true" }, h("span", { class: "chat-palette-switch-thumb" })),
			);
			if (state.settingsBusy) toggle.disabled = true;
			nodes.push(toggle);
		}

		const items = paletteItems();
		if (state.palette.index >= items.length) state.palette.index = Math.max(0, items.length - 1);
		if (layer === "model" && state.palette.loading) nodes.push(h("div", { class: "chat-palette-loading", text: "正在加载模型…" }));
		if (layer === "skill" && state.palette.loading) nodes.push(h("div", { class: "chat-palette-loading", text: "正在加载技能…" }));
		if (layer === "resume" && state.palette.loading) nodes.push(h("div", { class: "chat-palette-loading", text: "正在加载历史对话…" }));
		if (state.palette.error) nodes.push(h("div", { class: "chat-palette-error", text: state.palette.error }));
		if (layer === "model" && state.modelsError) nodes.push(h("div", { class: "chat-palette-error", text: `模型刷新失败：${state.modelsError}` }));
		if (layer === "skill" && state.skillsError) nodes.push(h("div", { class: "chat-palette-error", text: `技能刷新失败：${state.skillsError}` }));
		if (!items.length && !state.palette.loading) {
			// 模型空态只看「是否真的没有模型」：有错误时错误行单独显示，不污染空态文案。
			let text = "没有匹配的命令";
			if (layer === "modelRoot") {
				text = "没有匹配的模型 / 级别";
			} else if (layer === "model") {
				if (state.models.length) text = "没有匹配的模型";
				else if (!state.modelsError) text = "pi 没有可用模型，先在 models.json / 登录里配置";
				else text = null;
			} else if (layer === "thinking") {
				text = state.thinkingLevels.length ? "没有匹配的思考级别" : "没有可用的思考级别";
			} else if (layer === "skill") {
				text = state.skills.length || state.skillsError ? "没有匹配的技能" : "pi 没有发现技能（检查 ~/.pi/agent/skills 或项目 .pi/skills）";
			} else if (layer === "resume") {
				text = state.threads.length ? "没有匹配的历史对话" : "还没有历史对话";
			}
			if (text) nodes.push(h("div", { class: "chat-palette-empty", text }));
		}
		let group = null;
		let index = 0;
		for (const item of items) {
			if (item.group !== group && layer !== "modelRoot") {
				nodes.push(h("div", { class: "chat-palette-group", text: item.group }));
				group = item.group;
			}
			if (layer === "modelRoot") {
				nodes.push(
					h(
						"button",
						{
							class: `chat-palette-item chat-model-root-row${index === state.palette.index ? " is-active" : ""}`,
							type: "button",
							role: "menuitem",
							"aria-selected": String(index === state.palette.index),
							dataset: { paletteIndex: String(index) },
						},
						h("span", { class: "chat-model-root-label", text: item.label }),
						h("span", { class: "chat-model-root-value", text: item.hint }),
						h("span", { class: "chat-model-root-chevron", "aria-hidden": "true", text: "›" }),
					),
				);
				index++;
				continue;
			}
			if (layer === "skill") {
				const current = state.skill?.name === item.name;
				const title = item.disabled
					? `技能正文 ${formatChars(item.chars)} 字符 > 200k，请在 SKILL.md 里拆分或精简`
					: item.description || item.name;
				nodes.push(
					h(
						"button",
						{
							class: `chat-palette-item${index === state.palette.index ? " is-active" : ""}${item.disabled ? " is-disabled" : ""}`,
							type: "button",
							role: "option",
							"aria-selected": String(index === state.palette.index),
							"aria-disabled": item.disabled ? "true" : undefined,
							disabled: item.disabled,
							title,
							dataset: { paletteIndex: String(index) },
						},
						h("span", { class: "chat-palette-check", "aria-hidden": "true", text: current ? "✓" : "" }),
						h("span", { class: "chat-palette-label", text: item.label }),
						item.disableModelInvocation ? h("span", { class: "chat-palette-badge", text: "仅手动" }) : null,
						item.chars !== null ? h("span", { class: `chat-palette-hint${item.warning ? " is-warn" : ""}`, text: formatChars(item.chars) }) : null,
					),
				);
				index++;
				continue;
			}
			const current =
				layer === "resume"
					? item.id === state.threadId
					: layer === "thinking"
						? item.id === state.thinkingLevel
						: layer === "model" && state.model && item.provider === state.model.provider && item.id === state.model.id;
			nodes.push(
				h(
					"button",
					{
						class: `chat-palette-item${index === state.palette.index ? " is-active" : ""}`,
						type: "button",
						role: "option",
						"aria-selected": String(index === state.palette.index),
						dataset: { paletteIndex: String(index) },
					},
					h("span", { class: "chat-palette-check", "aria-hidden": "true", text: current ? "✓" : "" }),
					h("span", { class: "chat-palette-label", text: item.label }),
					item.hint ? h("span", { class: "chat-palette-hint", text: item.hint }) : null,
				),
			);
			index++;
		}
		paletteListEl.replaceChildren(...nodes);
		positionPalette();
	}

	function syncPaletteButtons() {
		const modelLayer = Boolean(state.palette && ["modelRoot", "model", "thinking"].includes(state.palette.layer));
		addBtn?.setAttribute("aria-expanded", String(Boolean(state.palette)));
		modelBtn?.setAttribute("aria-expanded", String(modelLayer));
	}

	function clearAnchoredMenu(menu) {
		if (!menu) return;
		menu.classList.remove("is-anchored");
		for (const prop of ["left", "right", "bottom", "width", "minWidth", "maxWidth", "maxHeight"]) {
			menu.style[prop] = "";
		}
	}

	/** 把菜单定位到 trigger：坐标换算到 .chat-overlay-anchor，避免 CSS anchor 的包含块问题。 */
	function positionAnchoredMenu(menu, trigger, { offset, align, minWidth, maxWidth, maxHeight = 400 }) {
		if (!menu || !trigger || !overlayAnchorEl) return;
		const ar = overlayAnchorEl.getBoundingClientRect();
		const tr = trigger.getBoundingClientRect();
		menu.classList.add("is-anchored");
		menu.style.left = "auto";
		menu.style.right = "auto";
		menu.style.width = "fit-content";
		menu.style.minWidth = minWidth;
		menu.style.maxWidth = maxWidth;
		const boundsWidth = ar.right - ar.left;
		const triggerLeft = tr.left - ar.left;
		const triggerRight = tr.right - ar.left;
		const availableWidth = align === "right" ? triggerRight : boundsWidth - triggerLeft;
		if ((menu.offsetWidth || 0) > availableWidth) {
			menu.style.width = `${Math.max(0, availableWidth)}px`;
		}
		const pos = computeAnchoredMenuPosition({
			anchorRect: { left: ar.left, right: ar.right, top: ar.top, bottom: ar.bottom },
			triggerRect: { left: tr.left, right: tr.right, top: tr.top, bottom: tr.bottom },
			offset,
			align,
			menuWidth: menu.offsetWidth || 0,
			boundsWidth,
		});
		if (pos.left === null) {
			menu.style.left = "auto";
			menu.style.right = `${pos.right}px`;
		} else {
			menu.style.left = `${pos.left}px`;
			menu.style.right = "auto";
		}
		menu.style.bottom = `${pos.bottom}px`;
		menu.style.maxHeight = `min(${maxHeight}px, ${pos.maxHeight}px)`;
	}

	function positionPalette() {
		if (!state.palette) return;
		if (!ANCHORED_PALETTE_LAYERS.has(state.palette.layer)) {
			clearAnchoredMenu(paletteEl);
			return;
		}
		positionAnchoredMenu(paletteEl, modelBtn, MODEL_MENU_ANCHOR);
	}

	function positionProfileMenu() {
		if (!state.profileMenuOpen) {
			clearAnchoredMenu(profileMenuEl);
			return;
		}
		positionAnchoredMenu(profileMenuEl, el("chat-profile"), PROFILE_MENU_ANCHOR);
	}

	function positionOpenMenus() {
		if (state.palette) positionPalette();
		if (state.profileMenuOpen) positionProfileMenu();
		if (state.contextMenuOpen) positionContextMenu();
	}

	function openPalette(layer, { draft = null, clearOnSelect = null, initialIndex = 0, back = null } = {}) {
		if (state.mode !== "independent" || !currentSession() || state.enabled !== true) return;
		closeProfileMenu();
		closeContextMenu({ focus: false });
		const previousDraft = draft ?? state.palette?.draft ?? input?.value ?? "";
		state.palette = {
			layer,
			back,
			index: Number.isInteger(initialIndex) ? initialIndex : 0,
			draft: previousDraft,
			clearOnSelect: clearOnSelect ?? state.palette?.clearOnSelect ?? false,
			loading: false,
			error: null,
			busy: false,
			confirm: null,
		};
		if (paletteSearchEl) paletteSearchEl.value = "";
		if (layer === "model" || layer === "thinking" || layer === "skill") {
			if (layer === "model") void loadModels({ refresh: true });
			else if (layer === "thinking") void loadThinking({ refresh: true });
			else {
				// 首次/切会话带 refresh=1（重新发现技能）；同一会话用服务端 60s 缓存
				const first = state.skillsKey !== currentKey();
				void loadSkills({ refresh: first });
			}
		} else if (layer === "resume") {
			void loadThreads();
		}
		renderPalette();
		syncPaletteButtons();
		updateSendButton();
		paletteSearchEl?.focus();
	}

	function closePalette({ restore = true, clearInput = false, focus = true } = {}) {
		const draft = state.palette?.draft ?? "";
		const returnToTrigger = Boolean(
			state.palette &&
				(state.palette.layer === "modelRoot" ||
					((state.palette.layer === "model" || state.palette.layer === "thinking") && state.palette.back === "modelRoot")),
		);
		state.palette = null;
		if (paletteSearchEl) paletteSearchEl.value = "";
		renderPalette();
		syncPaletteButtons();
		if (input) {
			if (clearInput) input.value = "";
			else if (restore) input.value = draft;
			deps.autoGrowInput?.();
			if (focus) {
				if (returnToTrigger) modelBtn?.focus?.();
				else input.focus?.();
			}
		}
		updateSendButton();
	}

	function backToParentLayer() {
		if (!state.palette) return;
		const parent = state.palette.back ?? "command";
		state.palette.layer = parent;
		state.palette.back = null;
		state.palette.index = 0;
		state.palette.error = null;
		state.palette.loading = false;
		state.palette.confirm = null;
		if (paletteSearchEl) paletteSearchEl.value = "";
		renderPalette();
		syncPaletteButtons();
		paletteSearchEl?.focus();
	}

	function paletteEscape() {
		if (!state.palette) return;
		if (state.palette.confirm) {
			state.palette.confirm = null;
			renderPalette();
			return;
		}
		if (state.palette.layer !== "command" && state.palette.layer !== "modelRoot") backToParentLayer();
		else closePalette({ restore: true });
	}

	/** 搜索框与 textarea 共用：面板打开时消费 ↑↓/Enter/Tab/Esc；返回 true 表示已处理。 */
	function handlePaletteKeydown(e) {
		if (!state.palette || e.isComposing) return false;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			movePalette(e.key === "ArrowDown" ? 1 : -1);
			return true;
		}
		if (e.key === "Tab" && e.shiftKey) {
			e.preventDefault();
			paletteEscape();
			return true;
		}
		if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			void activatePalette();
			return true;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			paletteEscape();
			return true;
		}
		return false;
	}

	function movePalette(delta) {
		if (state.palette?.confirm) return;
		const items = paletteItems();
		if (!state.palette || !items.length) return;
		state.palette.index = (state.palette.index + delta + items.length) % items.length;
		renderPalette();
	}

	async function activatePalette() {
		if (!state.palette || state.palette.busy) return;
		if (state.palette.confirm) {
			applySkill(state.palette.confirm);
			return;
		}
		const items = paletteItems();
		if (!items.length) return;
		const item = items[state.palette.index] ?? items[0];
		if (state.palette.layer === "command") {
			const clearOnSelect = state.palette.clearOnSelect === true;
			if (item.id === "new") {
				if (state.streaming) {
					state.palette.error = "回复中，先停止";
					renderPalette();
					return;
				}
				closePalette({ clearInput: true, focus: false });
				void newThread({ preserveSelection: false });
				input?.focus();
				return;
			}
			if (item.id === "resume") {
				openPalette("resume", { draft: state.palette.draft, clearOnSelect, back: "command" });
				return;
			}
			if (item.id === "model") openPalette("model", { draft: state.palette.draft, clearOnSelect, back: "command" });
			else if (item.id === "thinking") openPalette("thinking", { draft: state.palette.draft, clearOnSelect, back: "command" });
			else if (item.id === "skill") openPalette("skill", { draft: state.palette.draft, clearOnSelect, back: "command" });
			return;
		}
		if (state.palette.layer === "modelRoot") {
			const clearOnSelect = state.palette.clearOnSelect === true;
			if (item.id === "model") openPalette("model", { draft: state.palette.draft, clearOnSelect, back: "modelRoot" });
			else openPalette("thinking", { draft: state.palette.draft, clearOnSelect, back: "modelRoot" });
			return;
		}
		if (state.palette.layer === "skill") {
			pickSkill(item);
			return;
		}
		if (state.palette.layer === "resume") {
			await resumeThread(item.thread);
			return;
		}
		if (state.palette.layer === "thinking") {
			await selectThinking(item.id);
			return;
		}
		await selectModel(item.model);
	}

	function pickSkill(item) {
		if (!state.palette || !item) return;
		if (item.disabled) {
			state.palette.error = "技能正文过大，请在 SKILL.md 里拆分或精简";
			renderPalette();
			return;
		}
		if (item.warning) {
			state.palette.confirm = item;
			renderPalette();
			return;
		}
		applySkill(item);
	}

	function applySkill(item) {
		if (!item) return;
		state.skill = { name: item.name, chars: item.chars ?? null, warning: item.warning === true };
		closePalette({ clearInput: state.palette?.clearOnSelect === true });
		renderSkillChip();
		updateSendButton();
	}

	async function toggleProjectSkills() {
		if (!state.palette || state.settingsBusy) return;
		if (state.streaming) {
			pushNotice("回复中，先停止", "warn");
			flushRender();
			return;
		}
		const session = currentSession();
		if (!session) return;
		const next = !state.settings.projectSkills;
		state.settingsBusy = true;
		renderPalette();
		try {
			const res = await fetch("/api/chat/settings", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: session.source, session: session.id, profile: state.settings.profile, projectSkills: next }),
			});
			if (!res.ok) {
				let message = `HTTP ${res.status}`;
				try {
					message = (await res.json())?.error ?? message;
				} catch {
					/* 非 JSON 错误体 */
				}
				throw new Error(message);
			}
			const data = await res.json();
			state.settings = { profile: data.profile ?? state.settings.profile, projectSkills: data.projectSkills === true };
			state.profile = state.settings.profile;
			pushNotice("对话进程已重启");
			const skills = await loadSkills({ refresh: true });
			if (state.skill && Array.isArray(skills) && !skills.some((item) => item.name === state.skill.name)) {
				state.skill = null;
				renderSkillChip();
			}
			renderHead();
			flushRender();
		} catch (err) {
			if (state.palette) state.palette.error = `切换项目技能失败：${err.message}`;
			renderPalette();
		} finally {
			state.settingsBusy = false;
			renderPalette();
		}
	}

	function renderSkillChip() {
		const box = el("chat-skill");
		if (!box) return;
		if (state.mode === "forward") {
			box.hidden = true;
			box.replaceChildren();
			return;
		}
		if (!state.skill) {
			box.hidden = true;
			box.replaceChildren();
			return;
		}
		box.hidden = false;
		const remove = h("button", {
			class: "chat-skill-remove",
			type: "button",
			title: "移除技能",
			"aria-label": `移除技能 ${state.skill.name}`,
			text: "×",
		});
		remove.addEventListener("click", () => {
			state.skill = null;
			renderSkillChip();
			updateSendButton();
		});
		box.replaceChildren(
			h("span", { class: "chat-skill-label", text: `技能：${state.skill.name}${state.skill.warning ? "（较大）" : ""}` }),
			remove,
		);
	}

	async function selectModel(model) {
		if (!model || !state.palette || state.palette.busy) return;
		const session = currentSession();
		if (!session) return;
		if (state.streaming) {
			state.palette.error = "回复中，先停止";
			renderPalette();
			return;
		}
		if (state.model?.provider === model.provider && state.model?.id === model.id) {
			closePalette({ clearInput: state.palette.clearOnSelect === true });
			return;
		}
		const key = currentKey();
		state.palette.busy = true;
		state.palette.error = null;
		renderPalette();
		try {
			const res = await fetch("/api/chat/model", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					source: session.source,
					session: session.id,
					threadId: state.threadId ?? null,
					provider: model.provider,
					id: model.id,
				}),
			});
			if (!res.ok) {
				let message = `HTTP ${res.status}`;
				try {
					message = (await res.json())?.error ?? message;
				} catch {
					/* 非 JSON 错误体 */
				}
				throw new Error(message);
			}
			const data = await res.json();
			if (currentKey() !== key) return;
			state.model = data.model ?? model;
			state.modelsError = null;
			if (state.thread) state.thread.model = state.model;
			closePalette({ clearInput: state.palette?.clearOnSelect === true });
			pushNotice(`已切换到 ${modelLabel(state.model)}`);
			flushRender();
		} catch (err) {
			if (!state.palette) return;
			state.palette.busy = false;
			state.palette.error = `切换失败：${err.message}`;
			renderPalette();
		}
	}


	async function selectThinking(level) {
		if (!level || !state.palette || state.palette.busy) return;
		const session = currentSession();
		if (!session) return;
		if (state.streaming) {
			state.palette.error = "回复中，先停止";
			renderPalette();
			return;
		}
		if (level === state.thinkingLevel) {
			closePalette({ clearInput: state.palette.clearOnSelect === true });
			return;
		}
		const key = currentKey();
		state.palette.busy = true;
		state.palette.error = null;
		renderPalette();
		try {
			const res = await fetch("/api/chat/thinking", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					source: session.source,
					session: session.id,
					threadId: state.threadId ?? null,
					level,
				}),
			});
			if (!res.ok) {
				let message = `HTTP ${res.status}`;
				try {
					message = (await res.json())?.error ?? message;
				} catch {
					/* 非 JSON 错误体 */
				}
				throw new Error(message);
			}
			const data = await res.json();
			if (currentKey() !== key) return;
			state.thinkingLevel = typeof data.level === "string" ? data.level : level;
			state.thinkingLevels = Array.isArray(data.levels) ? data.levels : state.thinkingLevels;
			state.thinkingError = null;
			if (state.thread) state.thread.thinkingLevel = state.thinkingLevel;
			closePalette({ clearInput: state.palette?.clearOnSelect === true });
			pushNotice(`已切换到思考级别 ${state.thinkingLevel}`);
			flushRender();
		} catch (err) {
			if (!state.palette) return;
			state.palette.busy = false;
			state.palette.error = `切换失败：${err.message}`;
			state.thinkingError = err.message;
			renderPalette();
			renderHead();
		}
	}

	// ------------------------------------------------------------------
	// 流式
	// ------------------------------------------------------------------

	function ensureAssistant(turn) {
		for (let i = state.messages.length - 1; i >= 0; i--) {
			const message = state.messages[i];
			if (!turn.ids.has(message.id)) continue;
			if (message.role === "assistant" && message.open) return message;
			break;
		}
		const message = {
			id: localId("a"),
			role: "assistant",
			text: "",
			ts: new Date().toISOString(),
			streaming: true,
			open: true,
			model: state.model,
		};
		turn.ids.add(message.id);
		state.messages.push(message);
		return message;
	}

	function closeOpenAssistant(turn) {
		for (const message of state.messages) {
			if (!turn.ids.has(message.id)) continue;
			if (message.role === "assistant" && message.open) {
				message.open = false;
				message.streaming = false;
			}
		}
	}

	function upsertTool(turn, data) {
		closeOpenAssistant(turn);
		const id = `tool-${data.toolCallId ?? `${data.toolName ?? "tool"}-${++localSeq}`}`;
		let message = state.messages.find((item) => item.id === id);
		if (!message) {
			message = {
				id,
				role: "tool",
				ts: new Date().toISOString(),
				toolCallId: data.toolCallId ?? null,
				toolName: data.toolName ?? "tool",
				argsPreview: "",
				resultPreview: "",
				isError: false,
				phase: "start",
			};
			turn.ids.add(id);
			state.messages.push(message);
		}
		if (data.phase === "end") {
			message.phase = "end";
			message.isError = data.isError === true;
			if (data.resultPreview) message.resultPreview = String(data.resultPreview);
		} else {
			message.phase = "start";
			if (data.argsPreview) message.argsPreview = String(data.argsPreview);
		}
		state.status = "tool";
		scheduleRender();
	}

	function resetStreamState() {
		state.streaming = false;
		state.turn = null;
		state.controller = null;
		state.status = null;
	}

	/** 收尾统一入口：关闭 live 播报 → 最终渲染 → 只播报最后一条 → 恢复 aria-live=polite。 */
	function endStreamingUi(spoken) {
		state.a11yHold = true;
		resetStreamState();
		flushRender();
		announce(spoken);
		setTimeout(() => {
			state.a11yHold = false;
			updateA11y();
		}, 0);
	}

	function finishTurn(turn, outcome = {}) {
		if (!turn || turn.settled) return;
		turn.settled = true;
		clearApprovals();
		const { error = null, aborted = false, usage = null, durationMs = null, stopReason = null } = outcome;
		let lastAssistant = null;
		for (const message of state.messages) {
			if (!turn.ids.has(message.id)) continue;
			if (message.role === "assistant" && message.open) {
				message.open = false;
				message.streaming = false;
			}
			if (message.role === "assistant") lastAssistant = message;
		}
		if (lastAssistant) {
			if (usage) lastAssistant.usage = usage;
			if (Number.isFinite(durationMs)) lastAssistant.durationMs = durationMs;
			lastAssistant.stopReason = aborted ? "aborted" : (stopReason ?? lastAssistant.stopReason ?? null);
			if (error) lastAssistant.error = error;
		} else if (error) {
			pushNotice(error, "error");
		}
		const spoken = error
			? lastAssistant?.text
				? `${lastAssistant.text}\n生成中断：${error}`
				: `生成中断：${error}`
			: lastAssistant?.text || (aborted ? "已停止" : "");
		endStreamingUi(spoken);
		if (turn.metaReceived) void syncFromServer(turn);
	}

	/** done 后整表替换：服务端投影是唯一真源，拿不到时保留本地流式结果。 */
	async function syncFromServer(turn) {
		const session = currentSession();
		if (!session || sessionKeyOf(session) !== turn.key) return;
		try {
			const data = await fetchThread(session);
			if (state.streaming) return;
			const current = currentSession();
			if (!current || sessionKeyOf(current) !== turn.key) return;
			const messages = data.thread?.messages;
			if (Array.isArray(messages) && messages.length) {
				state.thread = data.thread ?? null;
				state.threadId = data.thread?.id ?? state.threadId;
				state.model = data.thread?.model ?? state.model;
				setMessages(messages);
				// 服务端最终投影整表替换：同样不触发 live 重读
				state.a11yHold = true;
				flushRender();
				setTimeout(() => {
					state.a11yHold = false;
					updateA11y();
				}, 0);
			}
		} catch {
			/* 读取失败：保留本地流式结果 */
		}
	}

	function handleSseEvent(event, turn) {
		if (!isTurnActive(turn)) return;
		const data = parseSseData(event);
		if (!data) return;
		switch (event.event) {
			case "meta": {
				turn.metaReceived = true;
				if (data.threadId) {
					state.threadId = data.threadId;
					rememberThreadFor(currentKey(), data.threadId);
				}
				if (data.model) state.model = data.model;
				if (data.profile) state.profile = data.profile;
				const user = state.messages.find((message) => turn.ids.has(message.id) && message.role === "user");
				if (user && "skill" in data) user.skill = data.skill ?? null;
				if (data.context && typeof data.context === "object") {
					const dropped = Array.isArray(data.context.dropped) ? data.context.dropped.filter((id) => typeof id === "string") : [];
					if (dropped.length) {
						const current = contextIds();
						setContextIds(current.filter((id) => !dropped.includes(id)));
					}
					if (user) {
						const included = Array.isArray(data.context.included) ? data.context.included : [];
						user.context = contextRefs(included);
					}
					renderContext();
				}
				// 发送被 pi 接受：技能 chip 清除（失败在 meta 之前，会保留）
				if (state.skill) {
					state.skill = null;
					renderSkillChip();
				}
				const assistant = ensureAssistant(turn);
				assistant.model = state.model;
				renderHead();
				scheduleRender();
				break;
			}
			case "status": {
				state.status = data.phase === "thinking" ? "thinking" : "tool";
				scheduleRender();
				break;
			}
			case "delta": {
				const text = typeof data.text === "string" ? data.text : "";
				if (!text) break;
				const assistant = ensureAssistant(turn);
				assistant.text += text;
				assistant.streaming = true;
				scheduleRender();
				break;
			}
			case "tool": {
				upsertTool(turn, data);
				break;
			}
			case "notice": {
				pushNotice(String(data.text ?? ""), data.kind === "warn" ? "warn" : data.kind === "error" ? "error" : "info");
				break;
			}
			case "approval": {
				enqueueApproval(data);
				break;
			}
			case "done": {
				finishTurn(turn, {
					stopReason: data.stopReason ?? null,
					usage: data.usage ?? null,
					durationMs: data.durationMs,
					aborted: data.stopReason === "aborted",
				});
				break;
			}
			case "error": {
				finishTurn(turn, { error: String(data.message ?? "对话出错") });
				break;
			}
			default:
				break;
		}
	}

	async function readSseStream(response, turn) {
		if (!response.body) throw new Error("响应没有可读流");
		const reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8");
		let buffer = "";
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const parsed = parseSseChunk(buffer);
			buffer = parsed.rest;
			for (const event of parsed.events) {
				if (turn.settled) return;
				if (!isTurnActive(turn)) {
					await reader.cancel().catch(() => {});
					return;
				}
				handleSseEvent(event, turn);
			}
		}
		buffer += decoder.decode();
		if (buffer.trim() && isTurnActive(turn)) {
			const parsed = parseSseChunk(`${buffer}\n\n`);
			for (const event of parsed.events) handleSseEvent(event, turn);
		}
		if (isTurnActive(turn)) finishTurn(turn, { error: "连接中断" });
	}

	async function send() {
		if (state.mode !== "independent" || state.streaming || state.palette) return;
		closeProfileMenu();
		const session = currentSession();
		if (!session || state.enabled !== true || !input) return;
		const text = input.value.trim();
		if (!text) return;
		if (text.length > PROMPT_MAX) {
			pushNotice(`消息超过 ${PROMPT_MAX} 字符`, "error");
			flushRender();
			return;
		}

		const controller = new AbortController();
		const turn = { controller, key: sessionKeyOf(session), settled: false, metaReceived: false, ids: new Set() };
		const contextSelection = contextIds();
		state.streaming = true;
		state.turn = turn;
		state.controller = controller;
		state.status = null;
		const userId = localId("u");
		const assistantId = localId("a");
		turn.ids.add(userId);
		turn.ids.add(assistantId);
		state.messages.push({
			id: userId,
			role: "user",
			displayText: text,
			ts: new Date().toISOString(),
			context: contextRefs(contextSelection),
			skill: state.skill ? { name: state.skill.name, chars: state.skill.chars, warning: state.skill.warning } : null,
		});
		state.messages.push({
			id: assistantId,
			role: "assistant",
			text: "",
			ts: new Date().toISOString(),
			streaming: true,
			open: true,
			model: state.model,
		});
		input.value = "";
		state.drafts.independent = "";
		deps.autoGrowInput?.();
		announce("");
		flushRender();
		input.focus?.();

		try {
			const response = await fetch("/api/chat/send", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "text/event-stream" },
				body: JSON.stringify({
					source: session.source,
					session: session.id,
					threadId: state.threadId ?? null,
					prompt: text,
					contextIds: contextSelection,
					skill: state.skill?.name ?? undefined,
				}),
				signal: controller.signal,
			});
			const contentType = response.headers.get("content-type") ?? "";
			// 先判 status 与 content-type：非 SSE 时是 JSON 错误，不能按流解析
			if (!response.ok || !contentType.includes("text/event-stream")) {
				let message = `HTTP ${response.status}`;
				try {
					message = (await response.json())?.error ?? message;
				} catch {
					/* 非 JSON 错误体 */
				}
				throw new Error(message);
			}
			await readSseStream(response, turn);
		} catch (err) {
			if (turn.settled) return;
			const aborted = err?.name === "AbortError";
			if (!turn.metaReceived) {
				// meta 前失败：清掉乐观消息，恢复输入内容
				state.messages = state.messages.filter((message) => !turn.ids.has(message.id));
				input.value = text;
				state.drafts.independent = text;
				deps.autoGrowInput?.();
				pushNotice(aborted ? "已停止" : `发送失败：${err?.message ?? err}`, "error");
				turn.settled = true;
				endStreamingUi(aborted ? "已停止" : `发送失败：${err?.message ?? err}`);
				return;
			}
			finishTurn(turn, { aborted, error: aborted ? null : `连接中断：${err?.message ?? err}` });
		}
	}

	async function sendForward() {
		if (state.mode !== "forward" || state.forwardBusy || !input) return;
		const session = currentSession();
		const info = currentConsoleInfo();
		if (!session) return;
		if (!info) {
			pushNotice("未检测到可转发控制台", "warn");
			flushRender();
			return;
		}
		if (independentBusy()) {
			pushNotice("独立对话正在运行，先停止或等待完成", "warn");
			flushRender();
			return;
		}
		const text = input.value.trim();
		if (!text) return;
		if (text.length > PROMPT_MAX) {
			pushNotice(`消息超过 ${PROMPT_MAX} 字符`, "error");
			flushRender();
			return;
		}
		let delivery = forwardDeliveryEl?.value === "steer" ? "steer" : "auto";
		const key = sessionKeyOf(session);
		if (
			delivery === "steer" &&
			!(state.forwardConfirm && state.forwardConfirm.key === key && state.forwardConfirm.text === text)
		) {
			state.forwardConfirm = { key, text };
			state.forwardDelivery = "steer";
			render();
			return;
		}
		state.forwardConfirm = null;
		const seq = ++state.forwardSeq;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 8000);
		state.forwardBusy = true;
		state.forwardDelivery = delivery;
		updateSendButton();
		try {
			const res = await fetch("/api/chat/forward", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: session.source, session: session.id, prompt: text, delivery }),
				signal: controller.signal,
			});
			let data = null;
			try {
				data = await res.json();
			} catch {
				/* 非 JSON 错误体 */
			}
			if (seq !== state.forwardSeq || currentKey() !== key || state.mode !== "forward") {
				state.forwardBusy = false;
				return;
			}
			if (!res.ok || data?.ok !== true) {
				const code = typeof data?.code === "string" ? data.code : `http_${res.status}`;
				if (["no_console", "console_offline", "ambiguous_console", "session_mismatch"].includes(code)) state.consoleLost.add(key);
				appendForwardLog({ kind: "status", tone: "error", text: forwardFailureText(code) });
				state.forwardBusy = false;
				render();
				return;
			}
			const actual = typeof data.delivery === "string" ? data.delivery : "auto";
			state.consoleLost.delete(key);
			const local = state.consoles.get(key);
			if (local) state.consoles.set(key, { ...local, state: "working" });
			appendForwardLog({ kind: "user", text });
			appendForwardLog({ kind: "status", tone: "ok", text: forwardDeliveryLabel(actual) });
			input.value = "";
			state.drafts.forward = "";
			deps.autoGrowInput?.();
			state.forwardDelivery = "auto";
			if (forwardDeliveryEl) forwardDeliveryEl.value = "auto";
			state.forwardBusy = false;
			render();
			announce(forwardDeliveryLabel(actual));
			input.focus?.();
		} catch (err) {
			if (seq !== state.forwardSeq || currentKey() !== key || state.mode !== "forward") {
				state.forwardBusy = false;
				return;
			}
			appendForwardLog({
				kind: "status",
				tone: "error",
				text: err?.name === "AbortError" ? "控制台响应超时" : `转发失败：${err?.message ?? err}`,
			});
			state.forwardBusy = false;
			render();
		} finally {
			clearTimeout(timer);
		}
	}

	async function stop() {
		const turn = state.turn;
		if (!turn || turn.settled) return;
		clearApprovals();
		if (sendBtn) sendBtn.disabled = true;
		const session = currentSession();
		try {
			if (session) {
				await fetch("/api/chat/stop", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ source: session.source, session: session.id, threadId: state.threadId }),
				});
			}
		} catch {
			/* 停止请求失败仍本地中断 */
		}
		turn.controller?.abort();
	}

	// ------------------------------------------------------------------
	// 事件与对外接口
	// ------------------------------------------------------------------

	if (input) {
		input.addEventListener("input", () => {
			deps.autoGrowInput?.();
			state.drafts[state.mode] = input.value;
			updateSendButton();
			// 面板打开时 textarea 不参与搜索；输入即视为焦点离开搜索框。
			if (state.palette) {
				closePalette({ restore: false, focus: false });
				return;
			}
			if (state.mode === "forward") return;
			const value = input.value;
			if (/^\/[A-Za-z]*$/.test(value.trim())) {
				const command = value.trim().slice(1).toLowerCase();
				const index = COMMAND_ITEMS.findIndex((item) => item.id === command);
				openPalette("command", { draft: value, clearOnSelect: true, initialIndex: index >= 0 ? index : 0 });
			}
		});
		input.addEventListener("focus", () => {
			if (state.palette) closePalette({ restore: true, focus: false });
		});
		input.addEventListener("keydown", (e) => {
			// IME 组合中不处理 Enter/方向键
			if (e.isComposing) return;
			if (handlePaletteKeydown(e)) return;
			// Enter 发送、Shift+Enter 换行；面板打开时 Enter 已在上面消费
			if (e.key !== "Enter" || e.shiftKey) return;
			e.preventDefault();
			if (state.mode === "forward") {
				void sendForward();
				return;
			}
			if (state.streaming || state.palette) return;
			void send();
		});
	}
	if (modeToggleBtn) modeToggleBtn.addEventListener("click", () => setMode(state.mode === "forward" ? "independent" : "forward"));
	if (forwardDeliveryEl) {
		forwardDeliveryEl.addEventListener("change", () => {
			state.forwardDelivery = forwardDeliveryEl.value === "steer" ? "steer" : "auto";
			state.forwardConfirm = null;
		});
	}
	if (addBtn) {
		addBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (state.mode === "forward") return;
			if (state.palette?.layer === "command") closePalette({ restore: true });
			else openPalette("command", { draft: input?.value ?? "", clearOnSelect: false });
		});
	}
	if (modelBtn) {
		modelBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (state.mode === "forward") return;
			if (state.streaming) {
				pushNotice("回复中，先停止", "warn");
				flushRender();
				return;
			}
			if (state.palette && ["modelRoot", "model", "thinking"].includes(state.palette.layer)) {
				closePalette({ restore: true });
			} else {
				openPalette("modelRoot", { draft: input?.value ?? "", clearOnSelect: false });
			}
		});
	}
	if (contextBtn) {
		contextBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (state.mode === "forward") return;
			if (state.contextMenuOpen) closeContextMenu({ focus: true });
			else openContextMenu();
		});
	}
	if (sendBtn) {
		sendBtn.addEventListener("click", () => {
			if (state.palette) return;
			if (state.mode === "forward") {
				if (!state.forwardBusy) void sendForward();
				return;
			}
			if (state.streaming) void stop();
			else void send();
		});
	}
	if (paletteSearchEl) {
		paletteSearchEl.addEventListener("input", () => {
			if (!state.palette) return;
			state.palette.index = 0;
			renderPalette();
		});
		paletteSearchEl.addEventListener("keydown", (e) => {
			handlePaletteKeydown(e);
		});
	}
	let palettePointerAt = 0;
	if (paletteEl) {
		paletteEl.addEventListener(
			"pointerdown",
			() => {
				palettePointerAt = Date.now();
			},
			true,
		);
		paletteEl.addEventListener("focusout", (e) => {
			if (!state.palette) return;
			if (e.relatedTarget && paletteEl.contains(e.relatedTarget)) return;
			setTimeout(() => {
				if (!state.palette) return;
				if (Date.now() - palettePointerAt < 250) return;
				const active = document.activeElement;
				if (active && paletteEl.contains(active)) return;
				closePalette({ restore: true, focus: false });
			}, 0);
		});
		paletteEl.addEventListener("click", (e) => {
			const toggle = e.target.closest?.("[data-settings-toggle]");
			if (toggle) {
				void toggleProjectSkills();
				return;
			}
			const confirm = e.target.closest?.("[data-skill-confirm]");
			if (confirm) {
				if (confirm.dataset.skillConfirm === "yes" && state.palette?.confirm) applySkill(state.palette.confirm);
				else if (state.palette) {
					state.palette.confirm = null;
					renderPalette();
				}
				return;
			}
			const row = e.target.closest?.("[data-palette-index]");
			if (!row || !state.palette) return;
			state.palette.index = Number(row.dataset.paletteIndex) || 0;
			void activatePalette();
		});
	}
	el("chat-profile")?.addEventListener("click", (e) => {
		e.stopPropagation();
		if (state.profileMenuOpen) closeProfileMenu();
		else openProfileMenu();
	});
	profileMenuEl?.addEventListener("click", (e) => {
		const confirm = e.target.closest?.("[data-profile-confirm]");
		if (confirm) {
			if (confirm.dataset.profileConfirm === "yes") {
				state.fullConfirmed = true;
				state.profileConfirm = false;
				void applyProfile("full");
			} else {
				state.profileConfirm = false;
				renderProfileMenu();
			}
			return;
		}
		const option = e.target.closest?.("[data-profile]");
		if (option) void selectProfile(option.dataset.profile);
	});
	// 点击面板外（含 textarea）关闭；模型 chip 除外，它负责切换 panel 层
	document.addEventListener("click", (e) => {
		if (!state.palette) return;
		const path = typeof e.composedPath === "function" ? e.composedPath() : [];
		const inside = (node) => node && (path.includes(node) || (typeof node.contains === "function" && node.contains(e.target)));
		if (inside(paletteEl) || inside(addBtn) || inside(modelBtn)) return;
		closePalette({ restore: true, focus: false });
	});
	// 点击权限菜单外关闭
	document.addEventListener("click", (e) => {
		if (!state.profileMenuOpen) return;
		const path = typeof e.composedPath === "function" ? e.composedPath() : [];
		const inside = (node) => node && (path.includes(node) || (typeof node.contains === "function" && node.contains(e.target)));
		if (inside(profileMenuEl) || inside(el("chat-profile"))) return;
		closeProfileMenu();
	});
	// 点击上下文弹层外关闭（不改 textarea 草稿，焦点回摘要按钮）
	document.addEventListener("click", (e) => {
		if (!state.contextMenuOpen) return;
		const path = typeof e.composedPath === "function" ? e.composedPath() : [];
		const inside = (node) => node && (path.includes(node) || (typeof node.contains === "function" && node.contains(e.target)));
		if (inside(contextMenuEl) || inside(contextBtn)) return;
		closeContextMenu({ focus: true });
	});
	window.addEventListener("resize", positionOpenMenus);
	document.addEventListener("scroll", positionOpenMenus, true);
	if (typeof ResizeObserver === "function" && overlayAnchorEl?.parentElement) {
		const resizeObserver = new ResizeObserver(positionOpenMenus);
		resizeObserver.observe(overlayAnchorEl.parentElement);
	}

	render();

	return {
			setOpen(open) {
			state.open = open === true;
			syncModeForSession();
			if (!state.open) {
				closePalette({ restore: true, focus: false });
				closeProfileMenu();
				closeContextMenu({ focus: false });
			}
			if (state.open) void ensureLoaded();
			renderContext();
			renderConsoleStatus();
			renderModeControls();
		},
		handleEscape() {
			if (state.mode === "forward") return false;
			if (state.approvals.length) {
				void respondApproval(false);
				return true;
			}
			if (state.contextMenuOpen) {
				closeContextMenu({ focus: true });
				return true;
			}
			if (state.profileMenuOpen) {
				closeProfileMenu();
				return true;
			}
			if (state.palette) {
				paletteEscape();
				return true;
			}
			if (!state.streaming) return false;
			void stop();
			return true;
		},
		onSessionChanged() {
			// 流式中切会话：先收掉旧 turn（abort 触发服务端 res.close → abort child），再清 UI；
			// 否则旧 SSE 的 delta/tool 会追加到新会话消息流里。
			if (state.streaming || state.turn) {
				const turn = state.turn;
				if (turn) {
					turn.settled = true;
					turn.controller?.abort();
				}
				resetStreamState();
			}
			closePalette({ restore: false, clearInput: true, focus: false });
			clearApprovals();
			closeProfileMenu();
			closeContextMenu({ focus: false });
			state.models = [];
			state.modelsAt = 0;
			state.modelsError = null;
			state.thinkingLevel = null;
			state.thinkingLevels = [];
			state.thinkingError = null;
			state.threads = [];
			state.threadsAt = 0;
			state.threadsError = null;
			state.settings = { profile: "read-only", projectSkills: false };
			state.settingsBusy = false;
			state.skills = [];
			state.skillsKey = null;
			state.skillsError = null;
			state.skillsDiagnostics = [];
			state.skill = null;
			state.thread = null;
			state.threadId = null;
			state.model = null;
			state.loadedKey = null;
			state.sessionKey = null;
			state.loadSeq++;
			state.loading = false;
			setMessages([]);
			state.forwardBusy = false;
			state.forwardSeq++;
			state.forwardConfirm = null;
			syncModeForSession();
			renderConsoleStatus();
			renderModeControls();
			if (state.open) void ensureLoaded();
			else render();
		},
		onConsolesChanged(consoles) {
			const next = new Map();
			for (const item of Array.isArray(consoles) ? consoles : []) {
				if (item && typeof item.sessionId === "string") next.set(`pi:${item.sessionId}`, item);
			}
			for (const key of state.consoles.keys()) {
				if (!next.has(key)) state.consoleLost.add(key);
			}
			for (const key of next.keys()) state.consoleLost.delete(key);
			state.consoles = next;
			render();
		},
		onSelectionChanged() {
			renderContext();
			updateSendButton();
		},
		onTrajectoryChanged() {
			renderContext();
		},
		refreshThread() {
			if (!state.open) return Promise.resolve();
			return loadThread({ force: true });
		},
		isOpen() {
			return state.open;
		},
		isStreaming() {
			return state.streaming;
		},
	};
}
