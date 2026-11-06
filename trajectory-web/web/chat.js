/**
 * chat.js — 侧边对话栏：接 pi 子进程的 SSE 流式对话与基础消息 UI。
 *
 * 后端：POST /api/chat/send（text/event-stream）、POST /api/chat/stop、
 *       GET /api/chat/thread、GET /api/chat/capabilities。
 * 本阶段（T3）只做流式与消息渲染；模型/技能/上下文/审批在后续阶段接入。
 */
import { parseSseChunk, parseSseData } from "./chat-lib.js";
import { fmtTokens } from "./lib.js";

const PROMPT_MAX = 32000;
const RENDER_MIN_MS = 80;
const PROFILE_LABEL = { "no-tools": "仅轨迹工具", "read-only": "只读", full: "全量工具" };

/** 对话栏。deps: {el,h,mdNode,getSession,autoGrowInput}（后续阶段再扩）。 */
export function initChatPanel(deps) {
	const el = deps.el;
	const h = deps.h;
	const mdNode = deps.mdNode;
	const list = el("chat-list");
	const input = el("chat-input");
	const sendBtn = el("chat-send");
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

	async function fetchThread(session) {
		const params = new URLSearchParams({ source: session.source, session: session.id });
		if (state.threadId) params.set("thread", state.threadId);
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
		render();
		try {
			const data = await fetchThread(session);
			if (seq !== state.loadSeq) return;
			state.thread = data.thread ?? null;
			state.threadId = data.thread?.id ?? null;
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
		await loadThread();
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
		if (message.skill) parts.push(`技能 ${message.skill}`);
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
		if (modelEl) modelEl.textContent = state.model?.name || state.model?.id || "模型未加载";
		const profileEl = el("chat-profile");
		if (profileEl) profileEl.textContent = PROFILE_LABEL[state.profile] ?? state.profile;
	}

	function updateSendButton() {
		if (!sendBtn) return;
		const canSend = state.enabled === true && !!currentSession() && input?.value.trim().length > 0;
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
		updateSendButton();
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

	function finishTurn(turn, outcome = {}) {
		if (!turn || turn.settled) return;
		turn.settled = true;
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
		resetStreamState();
		flushRender();
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
				flushRender();
			}
		} catch {
			/* 读取失败：保留本地流式结果 */
		}
	}

	function handleSseEvent(event, turn) {
		const data = parseSseData(event);
		if (!data) return;
		switch (event.event) {
			case "meta": {
				turn.metaReceived = true;
				if (data.threadId) state.threadId = data.threadId;
				if (data.model) state.model = data.model;
				if (data.profile) state.profile = data.profile;
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
				handleSseEvent(event, turn);
			}
		}
		buffer += decoder.decode();
		if (buffer.trim() && !turn.settled) {
			const parsed = parseSseChunk(`${buffer}\n\n`);
			for (const event of parsed.events) handleSseEvent(event, turn);
		}
		if (!turn.settled) finishTurn(turn, { error: "连接中断" });
	}

	async function send() {
		if (state.streaming) return;
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
		state.streaming = true;
		state.turn = turn;
		state.controller = controller;
		state.status = null;
		const userId = localId("u");
		const assistantId = localId("a");
		turn.ids.add(userId);
		turn.ids.add(assistantId);
		state.messages.push({ id: userId, role: "user", displayText: text, ts: new Date().toISOString() });
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
				resetStreamState();
				flushRender();
				return;
			}
			finishTurn(turn, { aborted, error: aborted ? null : `连接中断：${err?.message ?? err}` });
		}
	}

	async function stop() {
		const turn = state.turn;
		if (!turn || turn.settled) return;
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
		});
		input.addEventListener("keydown", (e) => {
			// Enter 发送、Shift+Enter 换行；输入法组合中不误发
			if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
			e.preventDefault();
			if (state.streaming) return;
			void send();
		});
	}
	if (sendBtn) {
		sendBtn.addEventListener("click", () => {
			if (state.streaming) void stop();
			else void send();
		});
	}

	render();

	return {
		setOpen(open) {
			state.open = open === true;
			if (state.open) void ensureLoaded();
		},
		handleEscape() {
			if (!state.streaming) return false;
			void stop();
			return true;
		},
		onSessionChanged() {
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
			// 上下文勾选（T6）才需要发请求；当前阶段只影响蒸馏列表
		},
		onTrajectoryChanged() {
			// 轨迹轮询不驱动对话刷新；线程在打开/发送结束时读取
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
