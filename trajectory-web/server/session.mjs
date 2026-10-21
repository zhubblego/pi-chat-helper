/**
 * session.mjs — pi 会话 JSONL 的只读投影层（零依赖，可在无 pi 运行时的环境执行）。
 *
 * 输入：会话文件路径（~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl）
 * 输出：{ meta, questions[] } —— 按「用户提问」分组的两级轨迹数据：
 *   一级 = question（问题 1、问题 2 …，同级）；二级 = events（该回合内的事件链）
 *
 * 事件类型（kind）：
 *   user          用户提问原文
 *   thinking      思维链
 *   text          助手输出文本（回合内最后一个 text 会标 isFinal）
 *   tool          工具调用（与 toolResult 合并，含 durationMs/nested 子调用）
 *   bash          ! 直执行命令
 *   system        系统提示/工具目录变更
 *   compaction    上下文压缩
 *   branch        分支摘要
 *   model         模型切换
 *   thinking-level 思考等级切换
 *   usage         独立用量记录（如 cache_warm）
 *   context-edit  上下文编辑
 *   custom        扩展注入的自定义消息
 *
 * 事件数据分两档：buildProjection() 生成 full（完整内容）；toLight() 派生
 * light（重字段截断到 LIGHT_CAP，system.sections 只留名称与长度），轮询接口用
 * light，详情接口按 id 从 full 取原文。
 */
import { readFileSync } from "node:fs";

export const LIGHT_CAP = 2000;

// ---------------------------------------------------------------------------
// 解析与分支
// ---------------------------------------------------------------------------

/** 读取 JSONL；坏行跳过（会话文件在写入过程中可能被截到半行）。 */
export function parseSessionFile(file) {
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch (err) {
		throw new Error(`无法读取会话文件：${file}（${err.code ?? err.message}）`);
	}
	const entries = [];
	let header = null;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (obj && obj.type === "session" && header === null) {
			header = obj;
			continue;
		}
		if (obj && typeof obj === "object") entries.push(obj);
	}
	return { header, entries };
}

/**
 * 重建活动分支：pi 每次把新条目 append 到活动叶子上，所以文件最后一条带 id 的
 * 条目就是活动叶子；沿 parentId 回溯即可。无 id/parentId（v1 遗留格式）时按文件
 * 顺序返回全部条目。
 */
export function activeBranch(entries) {
	const withId = entries.filter((e) => e && typeof e.id === "string");
	if (withId.length === 0) return entries;
	const byId = new Map(withId.map((e) => [e.id, e]));
	const chain = [];
	const seen = new Set();
	let cur = withId[withId.length - 1];
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		chain.push(cur);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return chain.reverse();
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 提取 message.content 中的文本（content 可能是 string 或 parts 数组）。 */
export function extractText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const part of content) {
		if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		}
	}
	return parts.join("\n");
}

function countImages(content) {
	if (!Array.isArray(content)) return 0;
	return content.filter((p) => p && typeof p === "object" && String(p.type ?? "").includes("image")).length;
}

/** 单行预览：折叠空白 + 截断。 */
export function previewOf(text, max = 100) {
	const s = String(text ?? "").replace(/\s+/g, " ").trim();
	return s.length > max ? s.slice(0, max) + "…" : s;
}

function entryTs(entry) {
	const m = entry.message;
	if (m && typeof m.timestamp === "number" && Number.isFinite(m.timestamp)) return m.timestamp;
	const t = Date.parse(entry.timestamp ?? "");
	return Number.isFinite(t) ? t : undefined;
}

function isoOf(ts) {
	return typeof ts === "number" ? new Date(ts).toISOString() : undefined;
}

function cloneJson(v) {
	try {
		return JSON.parse(JSON.stringify(v));
	} catch {
		return String(v);
	}
}

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

function newQuestion(index, summary, ts, images) {
	return {
		index,
		summary,
		images,
		ts,
		iso: isoOf(ts),
		events: [],
		stats: { events: 0, thinking: 0, tools: 0, errors: 0, tokens: 0, cost: 0, durationMs: 0 },
	};
}

function pushEvent(question, event, msgMeta) {
	if (msgMeta) event.msg = msgMeta;
	question.events.push(event);
	const st = question.stats;
	st.events++;
	if (event.kind === "thinking") st.thinking++;
	if (event.kind === "tool" || event.kind === "bash") {
		st.tools++;
		if (event.tool && event.tool.isError) st.errors++;
	}
	if (event.kind === "error") st.errors++;
	return event;
}

/**
 * 构建完整（full）投影。所有长文本原样保留，由 toLight() 负责截断。
 * @param {string} sessionFile
 * @returns {{meta: object, questions: object[]}}
 */
export function buildProjection(sessionFile) {
	return buildProjectionFrom({ ...parseSessionFile(sessionFile), file: sessionFile });
}

/** 投影主体：吃 { header, entries, file? }（pi 原生或 codex 翻译层产出），供多源复用。 */
export function buildProjectionFrom({ header, entries, file }) {
	const branch = activeBranch(entries);

	/** @type {object[]} */
	const questions = [];
	/** 当前分组（先挂一个占位 preamble，首次遇到 user 提问时收尾） */
	let current = newQuestion(-1, "会话开始", undefined, 0);
	let hasPreamble = false;
	const pendingTools = new Map();
	/** 分支内全部 assistant 消息的用量/耗时（跨分组累计，逐条只计一次） */
	const totals = { tokens: 0, cost: 0, durationMs: 0, tools: 0, errors: 0, thinking: 0 };

	const flush = () => {
		if (current.events.length > 0) {
			if (current.index === -1) hasPreamble = true;
			questions.push(current);
		}
	};

	for (const entry of branch) {
		const ts = entryTs(entry);

		// ---- message 条目 ----
		if (entry.type === "message") {
			const msg = entry.message ?? {};
			const role = msg.role;

			if (role === "user") {
				flush();
				const text = extractText(msg.content).trim();
				const images = countImages(msg.content);
				current = newQuestion(questions.length - (hasPreamble ? 1 : 0), text || (images ? "[图片]" : "[空消息]"), ts, images);
				if (text || images) {
					pushEvent(
						current,
						{
							id: `${entry.id ?? "e"}:user`,
							kind: "user",
							ts,
							iso: isoOf(ts),
							preview: previewOf(text) || `[图片×${images}]`,
							text,
							images,
						},
					);
				}
				continue;
			}

			if (role === "assistant") {
				const usage = msg.usage;
				if (usage) {
					totals.tokens += usage.totalTokens ?? 0;
					totals.cost += usage.cost?.total ?? 0;
				}
				if (typeof msg.durationMs === "number") totals.durationMs += msg.durationMs;
				const base = {
					model: msg.model,
					provider: msg.provider,
					api: msg.api,
					stopReason: msg.stopReason,
					rawStopReason: msg.rawStopReason,
					responseId: msg.responseId,
					durationMs: msg.durationMs,
					thinkingLevel: msg.thinkingLevel,
					usage: usage ? cloneJson(usage) : undefined,
				};
				// 模型调用失败（超时/路由 404/限流/断流）：content 往往为空，错误只存在 errorMessage 里，
				// 单记一条错误事件，否则这一轮在轨迹上看不到任何失败痕迹。
				if (msg.errorMessage) {
					pushEvent(
						current,
						{
							id: `${entry.id ?? "e"}:err`,
							kind: "error",
							ts,
							iso: isoOf(ts),
							preview: `错误：${previewOf(msg.errorMessage, 80)}`,
							error: {
								message: String(msg.errorMessage),
								stopReason: msg.stopReason ?? undefined,
								provider: msg.provider,
								model: msg.model,
							},
						},
						base,
					);
				}
				const parts = Array.isArray(msg.content) ? msg.content : [];
				parts.forEach((part, i) => {
					const meta = { ...base, first: i === 0 };
					const id = `${entry.id ?? "e"}:p${i}`;
					if (part?.type === "thinking") {
						// pi 原生字段是 thinking/thinkingSignature；codex 翻译层（server/codex.mjs）输出 text，两者都兼容
						const thinkText = part.thinking ?? part.text ?? "";
						pushEvent(
							current,
							{
								id,
								kind: "thinking",
								ts,
								iso: isoOf(ts),
								preview: previewOf(thinkText) || "(空思维)",
								text: String(thinkText),
								redacted: !thinkText && !!part.thinkingSignature,
							},
							meta,
						);
					} else if (part?.type === "text") {
						pushEvent(
							current,
							{
								id,
								kind: "text",
								ts,
								iso: isoOf(ts),
								preview: previewOf(part.text),
								text: String(part.text ?? ""),
							},
							meta,
						);
					} else if (part?.type === "toolCall") {
						const ev = pushEvent(
							current,
							{
								id,
								kind: "tool",
								ts,
								iso: isoOf(ts),
								preview: `${part.name ?? "(unknown)"}${part.arguments !== undefined ? " " + previewOf(JSON.stringify(part.arguments), 80) : ""}`,
								tool: {
									name: part.name ?? "(unknown)",
									callId: part.id,
									args: part.arguments === undefined ? undefined : cloneJson(part.arguments),
									argsText: part.arguments === undefined ? "" : safeStringify(part.arguments),
									result: null,
									isError: false,
									durationMs: undefined,
									resultTs: undefined,
									nested: [],
									details: undefined,
								},
							},
							meta,
						);
						if (part.id) pendingTools.set(part.id, ev);
					}
				});
				continue;
			}

			if (role === "toolResult") {
				const ev = msg.toolCallId ? pendingTools.get(msg.toolCallId) : undefined;
				const resultText = extractText(msg.content).trim();
				if (ev && ev.tool) {
					ev.tool.result = resultText;
					ev.tool.isError = msg.isError === true;
					ev.tool.durationMs = msg.durationMs;
					ev.tool.resultTs = ts;
					ev.tool.details = msg.details === undefined ? undefined : cloneJson(msg.details);
					const nested = Array.isArray(msg.nestedCalls) ? msg.nestedCalls : [];
					ev.tool.nested = nested.map((n) => ({
						name: n?.name,
						args: n?.arguments,
						status: n?.status,
						durationMs: n?.duration,
						error: n?.error,
					}));
					pendingTools.delete(msg.toolCallId);
				} else {
					// 找不到对应调用（分支被截断等）：作为独立事件展示
					pushEvent(current, {
						id: `${entry.id ?? "e"}:result`,
						kind: "tool",
						ts,
						iso: isoOf(ts),
						preview: `${msg.toolName ?? "(unknown)"} 结果${msg.isError ? "（错误）" : ""}`,
						tool: {
							name: msg.toolName ?? "(unknown)",
							callId: msg.toolCallId,
							args: undefined,
							argsText: "",
							result: resultText,
							isError: msg.isError === true,
							durationMs: msg.durationMs,
							resultTs: ts,
							nested: [],
							details: msg.details === undefined ? undefined : cloneJson(msg.details),
						},
					});
				}
				continue;
			}

			if (role === "bashExecution") {
				pushEvent(current, {
					id: `${entry.id ?? "e"}:bash`,
					kind: "bash",
					ts,
					iso: isoOf(ts),
					preview: `! ${previewOf(msg.command, 80)}`,
					bash: {
						command: String(msg.command ?? ""),
						output: String(msg.output ?? ""),
						exitCode: msg.exitCode,
						cancelled: msg.cancelled === true,
						outputTruncated: msg.truncated === true,
						excludeFromContext: msg.excludeFromContext === true,
					},
				});
				continue;
			}

			if (role === "system") {
				const sections = msg.sections && typeof msg.sections === "object" ? msg.sections : {};
				const sectionList = Object.entries(sections)
					.filter(([, v]) => typeof v === "string")
					.map(([name, text]) => ({ name, text }));
				const added = Array.isArray(msg.toolsAdded) ? msg.toolsAdded.map((t) => t?.name).filter(Boolean) : [];
				const removed = Array.isArray(msg.toolsRemoved) ? msg.toolsRemoved.map((t) => t?.name).filter(Boolean) : [];
				const previewBits = [];
				if (sectionList.length) previewBits.push(sectionList.map((s) => s.name).join(", "));
				if (added.length) previewBits.push(`+${added.join(",")}`);
				if (removed.length) previewBits.push(`-${removed.join(",")}`);
				pushEvent(current, {
					id: `${entry.id ?? "e"}:sys`,
					kind: "system",
					ts,
					iso: isoOf(ts),
					preview: `系统上下文：${previewBits.join(" · ") || "(变更)"}`,
					system: {
						sections: sectionList,
						toolsAdded: added,
						toolsRemoved: removed,
						toolsAddedFull: Array.isArray(msg.toolsAdded) ? cloneJson(msg.toolsAdded) : [],
					},
				});
				continue;
			}

			// 其他 role（如 custom）：按上下文事件展示
			const text = extractText(msg.content);
			pushEvent(current, {
				id: `${entry.id ?? "e"}:msg`,
				kind: "custom",
				ts,
				iso: isoOf(ts),
				preview: previewOf(text) || `(${role ?? "message"})`,
				custom: { customType: msg.customType ?? role ?? "message", text },
			});
			continue;
		}

		// ---- 非 message 条目 ----
		if (entry.type === "compaction") {
			pushEvent(current, {
				id: `${entry.id ?? "e"}:compaction`,
				kind: "compaction",
				ts,
				iso: isoOf(ts),
				preview: `压缩上下文：${previewOf(entry.summary, 80)}`,
				compaction: {
					summary: String(entry.summary ?? ""),
					firstKeptEntryId: entry.firstKeptEntryId,
					tokensBefore: entry.tokensBefore,
					fromHook: entry.fromHook === true,
					usage: entry.usage ? cloneJson(entry.usage) : undefined,
				},
			});
			continue;
		}
		if (entry.type === "branch_summary") {
			pushEvent(current, {
				id: `${entry.id ?? "e"}:branch`,
				kind: "branch",
				ts,
				iso: isoOf(ts),
				preview: `分支摘要：${previewOf(entry.summary, 80)}`,
				branch: { summary: String(entry.summary ?? ""), fromId: entry.fromId, usage: entry.usage ? cloneJson(entry.usage) : undefined },
			});
			continue;
		}
		if (entry.type === "model_change") {
			pushEvent(current, {
				id: `${entry.id ?? "e"}:model`,
				kind: "model",
				ts,
				iso: isoOf(ts),
				preview: `模型 → ${entry.provider ?? "?"}/${entry.modelId ?? "?"}`,
				modelChange: { provider: entry.provider, modelId: entry.modelId },
			});
			continue;
		}
		if (entry.type === "thinking_level_change") {
			pushEvent(current, {
				id: `${entry.id ?? "e"}:thinking-level`,
				kind: "thinking-level",
				ts,
				iso: isoOf(ts),
				preview: `思考等级 → ${entry.thinkingLevel ?? "?"}`,
				thinkingLevel: { level: entry.thinkingLevel },
			});
			continue;
		}
		if (entry.type === "usage") {
			const total = entry.usage?.totalTokens ?? 0;
			pushEvent(current, {
				id: `${entry.id ?? "e"}:usage`,
				kind: "usage",
				ts,
				iso: isoOf(ts),
				preview: `用量 ${entry.kind ?? "usage"}：${total} tokens${entry.note ? " · " + previewOf(entry.note, 40) : ""}`,
				usageEntry: {
					kind: entry.kind,
					provider: entry.provider,
					model: entry.model,
					usage: entry.usage ? cloneJson(entry.usage) : undefined,
					note: entry.note,
				},
			});
			continue;
		}
		if (entry.type === "context_edit") {
			pushEvent(current, {
				id: `${entry.id ?? "e"}:ctxedit`,
				kind: "context-edit",
				ts,
				iso: isoOf(ts),
				preview: `上下文编辑 → ${entry.targetId ?? "?"}`,
				contextEdit: { targetId: entry.targetId, replacement: safeStringify(entry.replacement) },
			});
			continue;
		}
		if (entry.type === "guardian_approval") {
			const ap = entry.approval ?? {};
			const verdict = ap.verdict ?? {};
			const action = ap.action ?? {};
			const outcome = verdict.outcome ?? "?";
			const icon = outcome === "allow" ? "✓" : "✗";
			const cmd = Array.isArray(action.command) ? action.command.join(" ").slice(0, 60) : action.tool ?? "";
			pushEvent(current, {
				id: `${entry.id ?? "e"}:approval`,
				kind: "approval",
				ts,
				iso: isoOf(ts),
				preview: `审批 ${icon} ${cmd || verdict.rationale?.slice(0, 40) || ""}`,
				approval: { action, verdict },
			});
			continue;
		}
		if (entry.type === "custom_message") {
			const text = extractText(entry.content);
			pushEvent(current, {
				id: `${entry.id ?? "e"}:custom`,
				kind: "custom",
				ts,
				iso: isoOf(ts),
				preview: previewOf(text) || `(${entry.customType ?? "custom"})`,
				custom: { customType: entry.customType ?? "custom", text, display: entry.display },
			});
			continue;
		}
		// custom（扩展私有数据）、label、session_info 等不进入 LLM 上下文，跳过
	}
	flush();

	// 标记每个分组内最后一个 text 为「输出」，并把分组统计汇总
	for (const q of questions) {
		for (let i = q.events.length - 1; i >= 0; i--) {
			if (q.events[i].kind === "text") {
				q.events[i].isFinal = true;
				break;
			}
		}
		for (const ev of q.events) {
			const u = ev.msg?.usage;
			if (u && ev.msg?.first) {
				q.stats.tokens += u.totalTokens ?? 0;
				q.stats.cost += u.cost?.total ?? 0;
			}
			if (ev.msg?.first && typeof ev.msg.durationMs === "number") {
				q.stats.durationMs += ev.msg.durationMs;
			}
		}
	}

	// meta 汇总与各分组统计保持一致
	totals.tools = questions.reduce((n, q) => n + q.stats.tools, 0);
	totals.errors = questions.reduce((n, q) => n + q.stats.errors, 0);
	totals.thinking = questions.reduce((n, q) => n + q.stats.thinking, 0);

	const firstTs = branch.map(entryTs).find((t) => typeof t === "number");
	const lastTs = [...branch].reverse().map(entryTs).find((t) => typeof t === "number");
	const nameEntry = [...branch].reverse().find((e) => e.type === "session_info" && e.name);

	return {
		meta: {
			file: file ?? null,
			id: header?.id,
			cwd: header?.cwd,
			version: header?.version,
			name: nameEntry?.name,
			parentSession: header?.parentSession,
			createdAt: header?.timestamp,
			startedAt: typeof firstTs === "number" ? new Date(firstTs).toISOString() : header?.timestamp,
			updatedAt: typeof lastTs === "number" ? new Date(lastTs).toISOString() : undefined,
			entryCount: branch.length,
			questionCount: questions.filter((q) => q.index >= 0).length,
			totals,
		},
		questions,
	};
}

function safeStringify(v) {
	if (v === undefined) return "";
	try {
		return typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? String(v);
	} catch {
		return String(v);
	}
}

// ---------------------------------------------------------------------------
// light 视图与事件查找
// ---------------------------------------------------------------------------

function cap(text) {
	const s = String(text ?? "");
	return { text: s.length > LIGHT_CAP ? s.slice(0, LIGHT_CAP) : s, truncated: s.length > LIGHT_CAP };
}

/** 对一个 full 事件做 light 化：只截断重字段，不动结构。 */
export function lightEvent(ev) {
	const out = { ...ev };
	switch (ev.kind) {
		case "thinking":
		case "text": {
			const c = cap(ev.text);
			out.text = c.text;
			out.truncated = c.truncated;
			break;
		}
		case "user": {
			const c = cap(ev.text);
			out.text = c.text;
			out.truncated = c.truncated;
			break;
		}
		case "tool": {
			const t = { ...ev.tool };
			const a = cap(t.argsText);
			const r = cap(t.result);
			t.argsText = a.text;
			t.result = r.text;
			t.args = undefined; // 结构化参数留给详情接口
			out.tool = t;
			out.truncated = a.truncated || r.truncated;
			break;
		}
		case "bash": {
			const b = { ...ev.bash };
			const c = cap(b.output);
			b.output = c.text;
			out.bash = b;
			out.truncated = c.truncated;
			break;
		}
		case "system": {
			const s = ev.system;
			out.system = {
				sections: s.sections.map((sec) => ({ name: sec.name, chars: sec.text.length })),
				toolsAdded: s.toolsAdded,
				toolsRemoved: s.toolsRemoved,
			};
			out.truncated = s.sections.length > 0;
			break;
		}
		case "compaction": {
			const c = cap(ev.compaction.summary);
			out.compaction = { ...ev.compaction, summary: c.text };
			out.truncated = c.truncated;
			break;
		}
		case "branch": {
			const c = cap(ev.branch.summary);
			out.branch = { ...ev.branch, summary: c.text };
			out.truncated = c.truncated;
			break;
		}
		case "custom": {
			const c = cap(ev.custom.text);
			out.custom = { ...ev.custom, text: c.text };
			out.truncated = c.truncated;
			break;
		}
		case "error": {
			const c = cap(ev.error.message);
			out.error = { ...ev.error, message: c.text };
			out.truncated = c.truncated;
			break;
		}
		case "context-edit": {
			const c = cap(ev.contextEdit.replacement);
			out.contextEdit = { ...ev.contextEdit, replacement: c.text };
			out.truncated = c.truncated;
			break;
		}
		default:
			break;
	}
	return out;
}

/** full 投影 → 轮询用 light 投影。 */
export function toLight(projection) {
	return {
		meta: projection.meta,
		questions: projection.questions.map((q) => ({
			...q,
			events: q.events.map(lightEvent),
		})),
	};
}

/** 按事件 id 在 full 投影中查找。 */
export function findEvent(projection, id) {
	for (const q of projection.questions) {
		for (const ev of q.events) {
			if (ev.id === id) return ev;
		}
	}
	return null;
}
