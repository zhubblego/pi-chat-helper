/**
 * chat.js — 侧边对话栏：接 pi 子进程的 SSE 流式对话与基础消息 UI。
 *
 * 后端：POST /api/chat/send（text/event-stream）、POST /api/chat/stop、
 *       GET /api/chat/thread、GET /api/chat/capabilities。
 * 本阶段（T3）只做流式与消息渲染；模型/技能/上下文/审批在后续阶段接入。
 */
import {
	filterPaletteItems,
	forgetThread,
	formatChars,
	formatContextWindow,
	isCurrentTurn,
	modelLabel,
	parseSseChunk,
	parseSseData,
	readThreadId,
	rememberThread,
} from "./chat-lib.js";
import { fmtTokens } from "./lib.js";

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
const CHAT_THREAD_KEY = "tw.chatThread";
const CHAT_THREAD_NEW_KEY = "tw.chatThreadNew";
const SKILL_SCOPE_LABEL = { user: "全局技能", project: "项目技能", temporary: "临时技能", path: "路径技能" };
const SKILL_SCOPE_ORDER = { user: 0, project: 1, temporary: 2, path: 3 };
const COMMAND_ITEMS = Object.freeze([
	{ id: "model", label: "模型", hint: "选择当前线程的模型", group: "命令", search: "model 模型" },
	{ id: "skill", label: "技能", hint: "选择技能（发送时由 pi 展开）", group: "命令", search: "skill 技能" },
]);

/** 对话栏。deps: {el,h,mdNode,getSession,autoGrowInput}（后续阶段再扩）。 */
export function initChatPanel(deps) {
	const el = deps.el;
	const h = deps.h;
	const mdNode = deps.mdNode;
	const list = el("chat-list");
	const input = el("chat-input");
	const sendBtn = el("chat-send");
	const announcer = el("chat-announcer");
	const paletteEl = el("chat-palette");
	const paletteListEl = el("chat-palette-list");
	const paletteSearchEl = el("chat-palette-search");
	const profileMenuEl = el("chat-profile-menu");
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
		profileConfirm: false,
		profileBusy: false,
		fullConfirmed: false,
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

	function readChatThreadMap() {
		try {
			const parsed = JSON.parse(localStorage.getItem(CHAT_THREAD_KEY) || "{}");
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}

	function writeChatThreadMap(map) {
		try {
			localStorage.setItem(CHAT_THREAD_KEY, JSON.stringify(map));
		} catch {
			/* 无痕模式等场景忽略 */
		}
	}

	function rememberedThreadFor(key) {
		return readThreadId(readChatThreadMap(), key);
	}

	function rememberThreadFor(key, threadId) {
		if (!threadId) return;
		writeChatThreadMap(rememberThread(readChatThreadMap(), key, threadId));
	}

	function forgetThreadFor(key) {
		writeChatThreadMap(forgetThread(readChatThreadMap(), key));
	}

	function readNewThreadMap() {
		try {
			const parsed = JSON.parse(localStorage.getItem(CHAT_THREAD_NEW_KEY) || "{}");
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}

	function writeNewThreadMap(map) {
		try {
			localStorage.setItem(CHAT_THREAD_NEW_KEY, JSON.stringify(map));
		} catch {
			/* 无痕模式等场景忽略 */
		}
	}

	function markNewThread(key, threadId) {
		if (!threadId) return;
		writeNewThreadMap({ ...readNewThreadMap(), [key]: threadId });
	}

	function clearNewThread(key) {
		const map = readNewThreadMap();
		if (!(key in map)) return;
		delete map[key];
		writeNewThreadMap(map);
	}

	function isNewThread(key, threadId) {
		return Boolean(threadId) && readNewThreadMap()[key] === threadId;
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
			if (state.threadId) params.set("thread", state.threadId);
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
		list.replaceChildren(...buildMessageNodes());
		if (stick) list.scrollTop = list.scrollHeight;
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
		const modelEl = el("chat-model");
		if (modelEl) {
			modelEl.textContent = state.model ? modelLabel(state.model) : "模型未加载";
			const provider = state.model?.provider ?? "";
			const id = state.model?.id ?? "";
			modelEl.title = id ? `${provider}/${id}` : "选择模型";
			modelEl.classList.toggle("is-reasoning", state.model?.reasoning === true);
			modelEl.classList.toggle("is-warn", Boolean(state.modelsError));
			if (state.modelsError) modelEl.title = `${modelEl.title} · ${state.modelsError}`;
		}
		const profileEl = el("chat-profile");
		if (profileEl) {
			profileEl.textContent = PROFILE_LABEL[state.profile] ?? state.profile;
			profileEl.classList.toggle("is-full", state.profile === "full");
			profileEl.title = state.profile === "full" ? "全量工具：会真实修改工作区，每次执行前审批" : "工具权限";
		}
		const newBtn = el("chat-new");
		if (newBtn) {
			newBtn.disabled = state.streaming;
			newBtn.title = state.streaming ? "回复中，先停止" : "新对话";
		}
	}

	function updateSendButton() {
		if (!sendBtn) return;
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
		const blocked = state.enabled === false || !currentSession();
		input.disabled = blocked;
		input.placeholder = state.enabled === false ? "对话不可用" : blocked ? "先在左侧选择一个会话" : "问问这条轨迹…";
	}

	function render() {
		renderHead();
		renderMessages();
		renderComposer();
		renderSkillChip();
		renderContext();
		renderProfileMenu();
		renderApproval();
		updateSendButton();
		updateA11y();
		renderPalette();
	}

	function contextIds() {
		return deps.getSelectedIds?.() ?? [];
	}

	function contextRefs(ids) {
		const list = Array.isArray(ids) ? ids : [];
		const refs = deps.getEventRefs?.(list) ?? [];
		return list.map((id) => refs.find((ref) => ref.id === id) ?? { id, kind: "unknown", label: "失效条目", preview: "", invalid: true });
	}

	/** 上下文 chips：标签/预览/打开/移除/清空/以此新开 + 轻提示。 */
	function renderContext() {
		const box = el("chat-context");
		if (!box) return;
		const ids = contextIds();
		if (!state.open || ids.length === 0) {
			box.hidden = true;
			box.replaceChildren();
			return;
		}
		box.hidden = false;
		const nodes = [h("span", { class: "chat-ctx-label", text: `上下文 ${ids.length}` })];
		for (const ref of contextRefs(ids)) {
			nodes.push(
				h(
					"span",
					{ class: `chat-ctx-chip${ref.invalid ? " is-invalid" : ""}`, title: ref.preview || ref.label },
					h(
						"button",
						{ class: "chat-ctx-main", type: "button", title: ref.preview || ref.label, onClick: () => deps.openEvent?.(ref.id) },
						h("span", { class: "chat-ctx-tag", text: ref.label }),
						ref.preview ? h("span", { class: "chat-ctx-preview", text: String(ref.preview).slice(0, 24) }) : null,
					),
					h("button", {
						class: "chat-ctx-remove",
						type: "button",
						title: "移除",
						"aria-label": `移除 ${ref.label}`,
						text: "×",
						onClick: (event) => {
							event.stopPropagation();
							setContextIds(ids.filter((id) => id !== ref.id));
						},
					}),
				),
			);
		}
		nodes.push(
			h("button", { class: "chat-ctx-clear", type: "button", text: "清空", onClick: () => setContextIds([]) }),
			h("button", { class: "chat-ctx-new", type: "button", text: "以此新开", onClick: () => void newThreadPreservingSelection() }),
			h("span", { class: "chat-ctx-hint", text: "取消勾选只影响之后的读取" }),
		);
		box.replaceChildren(...nodes);
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

	// ------------------------------------------------------------------
	// 工具权限菜单
	// ------------------------------------------------------------------

	function openProfileMenu() {
		if (state.streaming) {
			pushNotice("回复中，先停止", "warn");
			flushRender();
			return;
		}
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
			await refreshThread();
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

	function paletteItems() {
		if (!state.palette) return [];
		const query = paletteQuery();
		if (state.palette.layer === "command") return filterPaletteItems(COMMAND_ITEMS, query);
		if (state.palette.layer === "skill") return filterPaletteItems(paletteSkillItems(), query);
		return filterPaletteItems(paletteModelItems(), query);
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
			return;
		}
		paletteEl.hidden = false;
		const layer = state.palette.layer;
		const label = layer === "model" ? "选择模型" : layer === "skill" ? "选择技能" : "斜杠命令";
		paletteListEl.setAttribute("aria-label", label);
		if (paletteSearchEl) {
			const placeholder = layer === "model" ? "搜索模型…" : layer === "skill" ? "搜索技能…" : "搜索命令…";
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
		if (state.palette.error) nodes.push(h("div", { class: "chat-palette-error", text: state.palette.error }));
		if (layer === "model" && state.modelsError) nodes.push(h("div", { class: "chat-palette-error", text: `模型刷新失败：${state.modelsError}` }));
		if (layer === "skill" && state.skillsError) nodes.push(h("div", { class: "chat-palette-error", text: `技能刷新失败：${state.skillsError}` }));
		if (!items.length && !state.palette.loading) {
			const text =
				layer === "model"
					? state.models.length || state.modelsError
						? "没有匹配的模型"
						: "pi 没有可用模型，先在 models.json / 登录里配置"
					: layer === "skill"
						? state.skills.length || state.skillsError
							? "没有匹配的技能"
							: "pi 没有发现技能（检查 ~/.pi/agent/skills 或项目 .pi/skills）"
						: "没有匹配的命令";
			nodes.push(h("div", { class: "chat-palette-empty", text }));
		}
		let group = null;
		let index = 0;
		for (const item of items) {
			if (item.group !== group) {
				nodes.push(h("div", { class: "chat-palette-group", text: item.group }));
				group = item.group;
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
			const current = layer === "model" && state.model && item.provider === state.model.provider && item.id === state.model.id;
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
	}

	function openPalette(layer, { draft = null, clearOnSelect = null } = {}) {
		if (!currentSession() || state.enabled !== true) return;
		const previousDraft = draft ?? state.palette?.draft ?? input?.value ?? "";
		state.palette = {
			layer,
			index: 0,
			draft: previousDraft,
			clearOnSelect: clearOnSelect ?? state.palette?.clearOnSelect ?? false,
			loading: false,
			error: null,
			busy: false,
			confirm: null,
		};
		if (paletteSearchEl) paletteSearchEl.value = "";
		if (layer === "model" || layer === "skill") {
			if (layer === "model") void loadModels({ refresh: true });
			else {
				// 首次/切会话带 refresh=1（重新发现技能）；同一会话用服务端 60s 缓存
				const first = state.skillsKey !== currentKey();
				void loadSkills({ refresh: first });
			}
		}
		renderPalette();
		updateSendButton();
		paletteSearchEl?.focus();
	}

	function closePalette({ restore = true, clearInput = false, focus = true } = {}) {
		const draft = state.palette?.draft ?? "";
		state.palette = null;
		if (paletteSearchEl) paletteSearchEl.value = "";
		renderPalette();
		if (input) {
			if (clearInput) input.value = "";
			else if (restore) input.value = draft;
			deps.autoGrowInput?.();
			if (focus) input.focus?.();
		}
		updateSendButton();
	}

	function backToCommandLayer() {
		if (!state.palette) return;
		state.palette.layer = "command";
		state.palette.index = 0;
		state.palette.error = null;
		state.palette.loading = false;
		if (paletteSearchEl) paletteSearchEl.value = "";
		renderPalette();
		paletteSearchEl?.focus();
	}

	function paletteEscape() {
		if (!state.palette) return;
		if (state.palette.confirm) {
			state.palette.confirm = null;
			renderPalette();
			return;
		}
		if (state.palette.layer !== "command") backToCommandLayer();
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
			closePalette({ restore: true });
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
			if (item.id === "model") openPalette("model", { draft: state.palette.draft, clearOnSelect });
			else if (item.id === "skill") openPalette("skill", { draft: state.palette.draft, clearOnSelect });
			return;
		}
		if (state.palette.layer === "skill") {
			pickSkill(item);
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

	function openModelPicker() {
		if (state.streaming) {
			pushNotice("回复中，先停止", "warn");
			flushRender();
			return;
		}
		if (!currentSession()) {
			pushNotice("先在左侧选择一个会话", "warn");
			flushRender();
			return;
		}
		if (state.enabled !== true) return;
		openPalette("model", {
			draft: state.palette?.draft ?? input?.value ?? "",
			clearOnSelect: state.palette?.clearOnSelect ?? false,
		});
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
		if (state.streaming || state.palette) return;
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
				deps.autoGrowInput?.();
				pushNotice(aborted ? "已停止" : `发送失败：${err?.message ?? err}`, "error");
				turn.settled = true;
				endStreamingUi(aborted ? "已停止" : `发送失败：${err?.message ?? err}`);
				return;
			}
			finishTurn(turn, { aborted, error: aborted ? null : `连接中断：${err?.message ?? err}` });
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
			updateSendButton();
			// 面板打开时 textarea 不参与搜索；输入即视为焦点离开搜索框。
			if (state.palette) {
				closePalette({ restore: false, focus: false });
				return;
			}
			const value = input.value;
			if (/^\/[A-Za-z]*$/.test(value.trim())) {
				openPalette("command", { draft: value, clearOnSelect: true });
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
			if (state.streaming || state.palette) return;
			void send();
		});
	}
	if (sendBtn) {
		sendBtn.addEventListener("click", () => {
			if (state.palette) return;
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
				if (active && (paletteEl.contains(active) || active === el("chat-model"))) return;
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
	el("chat-model")?.addEventListener("click", () => openModelPicker());
	el("chat-new")?.addEventListener("click", () => void newThread({ preserveSelection: false }));
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
		if (inside(paletteEl) || inside(el("chat-model"))) return;
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

	render();

	return {
		setOpen(open) {
			state.open = open === true;
			if (!state.open) {
				closePalette({ restore: true, focus: false });
				closeProfileMenu();
			}
			if (state.open) void ensureLoaded();
			renderContext();
		},
		handleEscape() {
			if (state.approvals.length) {
				void respondApproval(false);
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
			state.models = [];
			state.modelsAt = 0;
			state.modelsError = null;
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
			if (state.open) void ensureLoaded();
			else render();
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
