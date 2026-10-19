/**
 * codex.mjs — Codex 轨迹源：扫描 ~/.codex/sessions/年/月/日/rollout-*.jsonl，
 * 把 rollout 事件流翻译成 pi 会话条目流（喂 session.mjs 的 buildProjectionFrom，
 * 投影/前端全复用）。
 *
 * 翻译映射（保留对话与工具，丢弃 UI 流与内部状态）：
 *   session_meta                              → header {type:"session", id, cwd, timestamp}
 *   response_item/message (user|assistant)    → 消息条目（developer/system 为每轮注入指令，跳过）
 *   response_item/reasoning                   → assistant thinking part（summary 有明文用明文，否则 redacted）
 *   response_item/function_call               → assistant toolCall part（arguments JSON 字符串→对象）
 *   response_item/custom_tool_call            → assistant toolCall part（input 脚本原文作 arguments）
 *   response_item/function_call_output 等     → toolResult 消息（按 call_id 与 toolCall 配对）
 *   compacted                                 → compaction 条目
 *   turn_context                              → model 变化时产 model_change（相邻相同不重复）
 *   其余（event_msg/world_state/token_usage_record/agent_message…）跳过
 *
 * 条目 id 用 rollout 自带 id（msg_/fc_/rs_…，重读稳定），parentId 顺序链接，
 * activeBranch 沿链回溯即得全量（rollout 为线性追加，无分支）。
 * 列表走「stat + 头 64KB」轻量解析（cwd + 首条用户消息），mtime+size 缓存。
 */
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LIVE_WINDOW_MS } from "./sessions.mjs";

export const DEFAULT_CODEX_ROOT = join(homedir(), ".codex", "sessions");

const HEAD_CHUNK = 64 * 1024;
const HEAD_MAX = 1024 * 1024;

/** file -> { mtimeMs, size, info }（与 sessions.mjs 同策略） */
const headCache = new Map();

/** session_index.jsonl 缓存：file -> { mtimeMs, map }（codex 的 /resume 标题来源） */
const indexCache = new Map();

export function clearCodexCache() {
	headCache.clear();
	indexCache.clear();
}

/**
 * 读 codex 会话索引（~/.codex/session_index.jsonl，即 sessions 根的上一级）：
 * id → thread_name（/resume 显示的主题，比从文件头猜首条提问更准）。按 mtime 缓存。
 */
function readSessionIndex(file) {
	let stat;
	try {
		stat = statSync(file);
	} catch {
		return new Map();
	}
	const cached = indexCache.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs) return cached.map;
	const map = new Map();
	try {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const o = JSON.parse(line);
				if (o.id && typeof o.thread_name === "string" && o.thread_name) map.set(o.id, o.thread_name);
			} catch {
				/* 坏行跳过 */
			}
		}
	} catch {
		/* 索引不可读时回退到头部解析 */
	}
	indexCache.set(file, { mtimeMs: stat.mtimeMs, map });
	return map;
}

/** `rollout-2026-07-13T09-49-15-<uuid>.jsonl` → { id, created }；不匹配返回 null。 */
export function fromRolloutName(name) {
	const m = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-fA-F-]{30,})\.jsonl$/.exec(name);
	if (!m) return null;
	const created = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
	return { id: m[5], created: Number.isFinite(created) ? created : undefined };
}

/** 注入消息前缀：codex 把 AGENTS.md / skills / 压缩历史 / agent 间通信等上下文以 user 角色注入，不算首条提问。 */
function isInjectedUserText(text) {
	return (
		text.startsWith("# AGENTS.md instructions for") ||
		text.startsWith("<user_instructions>") ||
		text.startsWith("<skills_instructions>") ||
		text.startsWith("The following is the Codex agent history") ||
		/^\[\d+\] tool \w+ call:/.test(text)
	);
}

/** 增量消费完整行：session_meta 的 cwd/id、首条真实用户消息（跳过注入）、子 agent 的 NEW_TASK 任务名。 */
function consumeLines(chunkText, state) {
	for (const line of chunkText.split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // 坏行/半行
		}
		if (entry.type === "session_meta") {
			const p = entry.payload ?? {};
			state.cwd = p.cwd ?? state.cwd;
			if (p.id) state.id = p.id;
			if (p.thread_source) state.threadSource = p.thread_source;
			continue;
		}
		if (!state.firstMessage && entry.type === "response_item" && entry.payload?.type === "message" && entry.payload?.role === "user") {
			const text = (entry.payload.content ?? []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("").trim();
			if (text.startsWith("The following is the Codex agent history")) state.continuation = true;
			if (text && !isInjectedUserText(text)) state.firstMessage = text.slice(0, 120).replace(/\s+/g, " ");
			continue;
		}
		// 子 agent 会话没有用户提问，任务由 agent_message 注入（Message Type: NEW_TASK / Task name: /root/xxx / Sender: /root）
		if ((!state.subagentTask || !state.sender) && entry.type === "response_item" && entry.payload?.type === "agent_message") {
			const text = (entry.payload.content ?? []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
			const m = /Task name:\s*(\S+)/.exec(text);
			if (m && m[1]) state.subagentTask = m[1];
			const s = /^Sender:\s*(\S+)/m.exec(text);
			if (s && s[1]) state.sender = s[1];
		}
	}
}

/**
 * 分块读头部并增量解析：大会话的 session_meta（base_instructions）+ AGENTS.md 注入
 * 就占数十到上百 KB，固定 64KB 窗口读不到首条提问（曾导致 codex 列表全是「(空会话)」）。
 * 每块 64KB 递增、找到即停，上限 1MB；StringDecoder 处理跨块多字节字符。
 */
function parseHead(file, size, fallbackId) {
	const state = { id: fallbackId, cwd: undefined, firstMessage: "", threadSource: undefined, subagentTask: undefined, sender: undefined, continuation: false };
	const max = Math.min(size, HEAD_MAX);
	const decoder = new StringDecoder("utf8");
	let pending = "";
	let offset = 0;
	const fd = openSync(file, "r");
	try {
		while (offset < max) {
			const len = Math.min(HEAD_CHUNK, max - offset);
			const buf = Buffer.alloc(len);
			const read = readSync(fd, buf, 0, len, offset);
			if (read <= 0) break;
			offset += read;
			pending += decoder.write(buf.subarray(0, read));
			const cut = pending.lastIndexOf("\n");
			if (cut < 0) continue;
			consumeLines(pending.slice(0, cut + 1), state);
			pending = pending.slice(cut + 1);
			if (state.cwd && (state.firstMessage || state.subagentTask)) return state;
		}
		pending += decoder.end();
		if (pending.trim()) consumeLines(`${pending}\n`, state);
	} finally {
		closeSync(fd);
	}
	return state;
}

/** 读取单个 codex 会话的列表信息（带缓存）。解析失败返回 null。 */
function sessionInfoFor(file, stat, projectDir) {
	const cached = headCache.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.info;
	let info;
	try {
		const fromName = fromRolloutName(file.split("/").pop());
		if (!fromName) return null;
		const parsed = parseHead(file, stat.size, fromName.id);
		// 子 agent 会话没有用户提问，任务由 agent_message 注入（Message Type: NEW_TASK / Task name: /root/xxx）
		const firstMessage = parsed.firstMessage || (parsed.subagentTask ? `子任务 ${parsed.subagentTask}` : "") || (parsed.continuation ? "（续接会话）" : "");
		info = {
			id: parsed.id,
			file,
			dir: dirname(file),
			projectPath: parsed.cwd ?? null,
			projectDir,
			name: undefined,
			firstMessage,
			// agent 派生结构：subagent 会话自带 Task name（自己是谁）与 Sender（谁派的）
			threadSource: parsed.threadSource ?? null,
			taskName: parsed.subagentTask ?? null,
			sender: parsed.sender ?? null,
			created: fromName.created,
			modified: stat.mtimeMs,
			size: stat.size,
		};
	} catch {
		return null;
	}
	headCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
	return info;
}

/** 遍历 root/年/月/日 三层目录收集 rollout 文件（最内层是文件）。 */
function* rolloutFiles(root) {
	let years;
	try {
		years = readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const y of years) {
		if (!y.isDirectory()) continue;
		for (const m of subdirs(join(root, y.name))) {
			for (const d of subdirs(join(root, y.name, m.name))) {
				let files;
				try {
					files = readdirSync(join(root, y.name, m.name, d.name), { withFileTypes: true });
				} catch {
					continue;
				}
				for (const f of files) {
					if (f.isFile() && f.name.startsWith("rollout-") && f.name.endsWith(".jsonl")) {
						yield join(root, y.name, m.name, d.name, f.name);
					}
				}
			}
		}
	}
}

function subdirs(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
	} catch {
		return [];
	}
}

/**
 * 列出 codex 会话（按最近活跃倒序）。
 * @param {{codexRoot?: string, projectDir?: string, liveWindowMs?: number, now?: number}} options
 */
export function listCodexSessions(options = {}) {
	const now = options.now ?? Date.now();
	const liveWindowMs = options.liveWindowMs ?? LIVE_WINDOW_MS;
	const root = options.codexRoot ?? DEFAULT_CODEX_ROOT;
	// /resume 标题：codex 把主题写在 sessions 同级的 session_index.jsonl，优先于头部猜测
	const index = readSessionIndex(join(dirname(root), "session_index.jsonl"));
	const sessions = [];
	for (const file of rolloutFiles(root)) {
		try {
			const stat = statSync(file);
			if (!stat.isFile()) continue;
			const info = sessionInfoFor(file, stat, options.projectDir ?? null);
			if (!info) continue;
			const threadName = index.get(info.id);
			sessions.push(threadName ? { ...info, name: threadName } : info);
		} catch {
			/* 单个文件不可读不影响列表 */
		}
	}
	if (options.projectDir) {
		// 项目范围：按 cwd 前缀过滤（projectDir 是 pi 的会话目录概念，这里用路径匹配）
		const keep = sessions.filter((s) => s.projectPath && (s.projectPath === options.projectDir || options.projectDir.startsWith(`${s.projectPath}/`) || s.projectPath.startsWith(`${options.projectDir}/`)));
		sessions.length = 0;
		sessions.push(...keep);
	}
	sessions.sort((a, b) => b.modified - a.modified);
	for (const s of sessions) s.live = now - s.modified < liveWindowMs;
	return sessions;
}

// ---------------------------------------------------------------------------
// 翻译层：rollout 事件流 → pi 会话条目流
// ---------------------------------------------------------------------------

/** content 数组（input_text/output_text）拼纯文本。 */
function textOfParts(parts) {
	if (typeof parts === "string") return parts;
	if (!Array.isArray(parts)) return "";
	return parts.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
}

/**
 * 读 codex 会话并翻译为 pi 条目流。
 * @returns {{header: object|null, entries: object[]}}
 */
/** 从注入内容推 section 名（system 事件的提示词段落名）。 */
function injectSectionName(text) {
	if (text.startsWith("# AGENTS.md instructions for")) return "AGENTS.md";
	if (text.startsWith("The following is the Codex agent history")) return "codex_history";
	if (text.startsWith("You are `")) return "agent_role";
	const m = /^<([a-z_]+)>/.exec(text);
	if (m) return m[1];
	return "developer";
}

export function readCodexSession(file) {
	const out = [];
	let header = null;
	let lastId = null;
	let lastModel;
	let lastEffort;
	let baseEmitted = false;
	// 连续的上下文注入合并为一条 system 条目（sections 多段落），与 pi 的 system_context 形态一致
	let pendingSystem = null;
	const link = (entry) => {
		entry.parentId = lastId;
		lastId = entry.id;
		return entry;
	};
	const flushSystem = () => {
		if (!pendingSystem) return;
		const { id, timestamp, sections } = pendingSystem;
		pendingSystem = null;
		out.push(link({ type: "message", id, timestamp, message: { role: "system", sections, toolsAdded: [], toolsRemoved: [] } }));
	};
	const addSection = (id, timestamp, name, text) => {
		if (!pendingSystem) pendingSystem = { id, timestamp, sections: {} };
		pendingSystem.sections[name] = text;
	};
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			continue; // 半行/坏行跳过
		}
		const ts = o.timestamp;
		const p = o.payload ?? {};
		if (o.type === "session_meta") {
			if (!header) header = { type: "session", id: p.id ?? p.session_id, timestamp: ts, cwd: p.cwd };
			// 系统提示词全文 → 并入会话开头的上下文批次（只取首次）
			const base = typeof p.base_instructions === "string" ? p.base_instructions : p.base_instructions?.text;
			if (!baseEmitted && typeof base === "string" && base) {
				baseEmitted = true;
				addSection("cx-sys-base", ts, "base_instructions", base);
			}
			continue;
		}
		if (o.type === "turn_context") {
			const model = typeof p.model === "string" ? p.model : "";
			if (model && model !== lastModel) {
				lastModel = model;
				flushSystem();
				out.push(link({ type: "model_change", id: `cx-model-${out.length}`, timestamp: ts, provider: p.model_provider ?? "openai", modelId: model }));
			}
			// 思考等级（effort）→ pi 的 thinking_level_change（会话开始组里的「思考等级」事件）
			const effort = typeof p.effort === "string" ? p.effort : "";
			if (effort && effort !== lastEffort) {
				lastEffort = effort;
				flushSystem();
				out.push(link({ type: "thinking_level_change", id: `cx-level-${out.length}`, timestamp: ts, thinkingLevel: effort }));
			}
			continue;
		}
		if (o.type === "compacted") {
			flushSystem();
			out.push(link({ type: "compaction", id: `cx-comp-${out.length}`, timestamp: ts, compaction: { summary: "（Codex 会话已压缩）" } }));
			continue;
		}
		if (o.type !== "response_item") continue;
		if (p.type === "message") {
			const text = textOfParts(p.content);
			// developer 注入（skills/多 agent/中断说明）与 user 角色的上下文注入（AGENTS.md 等）
			// → system 事件（提示词段落），不再冒充提问/被丢弃
			if (p.role === "developer" || (p.role === "user" && isInjectedUserText(text.trim()))) {
				if (text.trim()) addSection(p.id ?? `cx-sys-${out.length}`, ts, injectSectionName(text.trim()), text);
				continue;
			}
			if (p.role !== "user" && p.role !== "assistant") continue;
			flushSystem();
			out.push(
				link({
					type: "message",
					id: p.id ?? `cx-msg-${out.length}`,
					timestamp: ts,
					message: { role: p.role, content: [{ type: "text", text }] },
				}),
			);
			continue;
		}
		if (p.type === "reasoning") {
			let summary = "";
			if (Array.isArray(p.summary)) {
				summary = p.summary.map((s) => (typeof s?.text === "string" ? s.text : "")).filter(Boolean).join("\n");
			}
			flushSystem();
			out.push(
				link({
					type: "message",
					id: p.id ?? `cx-rs-${out.length}`,
					timestamp: ts,
					message: { role: "assistant", content: [{ type: "thinking", text: summary, redacted: !summary }] },
				}),
			);
			continue;
		}
		if (p.type === "function_call" || p.type === "custom_tool_call") {
			let args;
			if (typeof p.arguments === "string") {
				try {
					args = JSON.parse(p.arguments);
				} catch {
					args = p.arguments;
				}
			} else if (p.input !== undefined) args = p.input;
			flushSystem();
			out.push(
				link({
					type: "message",
					id: p.id ?? `cx-call-${out.length}`,
					timestamp: ts,
					message: { role: "assistant", content: [{ type: "toolCall", id: p.call_id, name: p.name ?? "(unknown)", arguments: args }] },
				}),
			);
			continue;
		}
		if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
			const text = typeof p.output === "string" ? p.output : textOfParts(p.output);
			flushSystem();
			out.push(
				link({
					type: "message",
					id: p.id ?? `cx-out-${out.length}`,
					timestamp: ts,
					message: { role: "toolResult", toolCallId: p.call_id, content: [{ type: "text", text }] },
				}),
			);
			continue;
		}
		// 其余 response_item（agent_message 等）跳过
	}
	flushSystem();
	return { header, entries: out };
}

/**
 * 读 Guardian 审批会话：提取每条审批的 Planned action JSON（被评估的工具调用）
 * 与判定 JSON（risk_level/outcome/rationale），转为 pi 条目流里的 guardian_approval 条目。
 * 按时间序返回，供主会话投影合并注入。
 */
export function readGuardianApproval(file) {
	const entries = [];
	let cwd = undefined;
	let pendingAction = null;
	const push = () => {
		if (!pendingAction) return;
		entries.push(pendingAction);
		pendingAction = null;
	};
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		const p = o.payload ?? {};
		if (o.type === "session_meta") {
			cwd = p.cwd ?? cwd;
			continue;
		}
		if (o.type !== "response_item") continue;
		if (p.type === "message" && p.role === "user") {
			const text = (p.content ?? []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
			// Planned action JSON：提取被审批的工具调用详情
			const m = /Planned action JSON:\s*\n(\{[\s\S]*?\n\})/.exec(text);
			if (m) {
				try {
					const action = JSON.parse(m[1]);
					pendingAction = {
						type: "guardian_approval",
						id: `gr-${entries.length}`,
						timestamp: o.timestamp,
						approval: { action },
					};
				} catch {
					/* Planned action JSON 解析失败跳过 */
				}
			}
			continue;
		}
		if (p.type === "message" && p.role === "assistant" && pendingAction) {
			const text = (p.content ?? []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("").trim();
			try {
				const verdict = JSON.parse(text);
				if (typeof verdict.outcome === "string") {
					pendingAction.approval.verdict = verdict;
					push();
				}
			} catch {
				/* 非 JSON 判定跳过 */
			}
			continue;
		}
	}
	return { cwd, entries };
}
