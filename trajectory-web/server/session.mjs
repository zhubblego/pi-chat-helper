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
 *   text          助手中间输出（stopReason=toolUse：工具调用前的叙述/计划）
 *   answer        轮次最终回答（stopReason=stop/aborted/error/length 等终止值）
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
 *
 * 模型上下文联动：轮级暴露 editableIds（可编辑条目）与 modelHidden（整轮被最新 context_edit
 * 剔除）；扩展侧用 custom 条目存隐藏状态 + context 事件过滤 messages（见 index.ts），
 * server 经 /api/context-edit 转发（见 app.mjs）。
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
		// 轮内可被 context_edit 编辑的条目 id（user/assistant/toolResult/custom_message），
		// 用于派生 modelHidden 与 /api/context-edit 的轮校验
		editableIds: [],
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

	/** system 消息 → 上下文事件（延迟归属时也走同一段解析，见 pendingSystem）。 */
	const pushSystemEvent = (target, entry, ts) => {
		const msg = entry.message ?? {};
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
		pushEvent(target, {
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
	};

	// 紧贴下一条提问的 system 补丁（skills/tools 段变更，落盘时间仅比提问早 1ms）语义上是
	//「为下一轮请求生效的上下文」：延迟归属到下一轮开头；若后续出现其它事件条目或文件结束
	// 都没有新提问，则按时间顺序归上一轮末尾。首问前的完整快照（起始组）不延迟。
	const pendingSystem = [];
	const drainPendingSystem = () => {
		for (const { entry, ts } of pendingSystem.splice(0)) pushSystemEvent(current, entry, ts);
	};
	// 连续的 context_edit 条目聚合为一条「上下文编辑」事件（隐藏/恢复一轮会连发 N 条，逐条显示太吵）
	let pendingCtxEdits = [];
	const drainCtxEdits = () => {
		if (!pendingCtxEdits.length) return;
		const first = pendingCtxEdits[0];
		const items = pendingCtxEdits.splice(0).map((e) => ({ targetId: e.targetId, replacement: safeStringify(e.replacement) }));
		const single = items.length === 1;
		pushEvent(current, {
			id: `${first.id ?? "e"}:ctxedit`,
			kind: "context-edit",
			ts: first.ts,
			iso: isoOf(first.ts),
			preview: single ? `上下文编辑 → ${first.targetId ?? "?"}` : `上下文编辑 ×${items.length}`,
			contextEdit: single ? { targetId: first.targetId, replacement: items[0].replacement, edits: items } : { edits: items },
		});
	};
	// context_edit 终态（同 targetId 最新编辑胜出，重放语义）：用于派生轮级模型可见性
	const editsByTarget = new Map();
	const rendersEvent = (entry) =>
		!(entry.type === "custom" || entry.type === "label" || entry.type === "session_info" || entry.type === "context_edit") &&
			!(entry.type === "message" && entry.message?.role === "system");

	for (const entry of branch) {
		const ts = entryTs(entry);
		// 当前条目会渲染成事件时，先消化挂起的 system 补丁与聚合编辑（它们在时间上位于本条目之前，归上一轮末尾）；
		// user 提问例外——由 user 分支开新轮后再消化，使补丁挂到下一轮开头
		const isUserMsg = entry.type === "message" && entry.message?.role === "user";
		if ((pendingSystem.length || pendingCtxEdits.length) && rendersEvent(entry) && !isUserMsg) {
			drainPendingSystem();
			drainCtxEdits();
		}

		// ---- message 条目 ----
		if (entry.type === "message") {
			const msg = entry.message ?? {};
			const role = msg.role;
			if (entry.id && (role === "assistant" || role === "toolResult")) current.editableIds.push(entry.id);

			if (role === "user") {
				drainCtxEdits();
				flush();
				const text = extractText(msg.content).trim();
				const images = countImages(msg.content);
				current = newQuestion(questions.length - (hasPreamble ? 1 : 0), text || (images ? "[图片]" : "[空消息]"), ts, images);
				if (entry.id) current.editableIds.push(entry.id);
				// 挂起的 system 补丁成为本轮开头的上下文事件（先于提问行显示）
				drainPendingSystem();
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
				// 轮次终点判定用协议显式字段：toolUse=中间过程，其余（stop/aborted/error/length…）=最终回答。
				// 缺 stopReason 时按回答处理（codex 翻译层已补齐；pi 全量审计 38k 条无缺失）。
				const isAnswer = msg.stopReason !== "toolUse";
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
								kind: isAnswer ? "answer" : "text",
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
				// 起始组（首问前的完整快照）直接进当前分组；轮间补丁延迟归属，见 pendingSystem 注释
				if (current.index === -1) pushSystemEvent(current, entry, ts);
				else pendingSystem.push({ entry, ts });
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
			editsByTarget.set(entry.targetId, entry.replacement);
			pendingCtxEdits.push({ id: entry.id, ts, targetId: entry.targetId, replacement: entry.replacement });
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
			if (entry.id) current.editableIds.push(entry.id);
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
	// 文件尾仍挂起的补丁/聚合编辑（下一问尚未落盘）：按时间顺序归最后一轮末尾，live 轮询下不丢事件
	drainPendingSystem();
	drainCtxEdits();

	// 模型视角的轮可见性：轮内可编辑条目全部被最新 context_edit 剔除（replacement=null）时标记；
	// 部分剔除（外部手动编辑）不算隐藏，避免误标。可编辑角色与 pi SessionManager 的
	// appendContextEdit 校验一致：user/assistant/toolResult/custom_message
	for (const q of questions) {
		if (!q.editableIds?.length) continue;
		q.modelHidden = q.editableIds.every((id) => editsByTarget.has(id) && editsByTarget.get(id) === null);
	}

	// 模型视角边界（对齐 pi buildContextEntries 语义）：分支内最后一条 compaction 之后重建上下文，
	// 其 firstKeptEntryId 之前的条目不再进入模型（只剩摘要）；保留区里的 system 消息同样不进。
	// firstKeptEntryId 缺失或不在链上时，compaction 之前全部视为已摘要（Codex 翻译层的 compacted 即此形态）。
	// 无 compaction 的会话不打标记（事件缺 inContext 字段＝全量在上下文）。
	const lastCompaction = branch.findLast((e) => e.type === "compaction");
	if (lastCompaction) {
		const compIdx = branch.lastIndexOf(lastCompaction);
		const firstKeptId = typeof lastCompaction.firstKeptEntryId === "string" ? lastCompaction.firstKeptEntryId : null;
		const inCtxById = new Map();
		let keptStarted = false;
		branch.forEach((entry, i) => {
			let inCtx = true;
			if (i > compIdx) inCtx = true;
			else if (entry === lastCompaction) inCtx = true;
			else {
				if (firstKeptId && entry.id === firstKeptId) keptStarted = true;
				inCtx = keptStarted && !(entry.type === "message" && entry.message?.role === "system");
			}
			if (entry.id) inCtxById.set(entry.id, inCtx);
		});
		for (const q of questions) {
			for (const ev of q.events) {
				const entryId = ev.id.includes(":") ? ev.id.slice(0, ev.id.indexOf(":")) : ev.id;
				const inCtx = inCtxById.get(entryId);
				if (inCtx === false) ev.inContext = false;
			}
		}
	}

	// 分组统计汇总（过程/回答已按 stopReason 在事件生成时区分，无需位置标注）
	for (const q of questions) {
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
		case "text":
		case "answer": {
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
			// 单条：顶层 replacement 摘要截断；聚合（多条）：edits 内已是短摘要字符串，无需截断
			if (typeof ev.contextEdit.replacement === "string") {
				const c = cap(ev.contextEdit.replacement);
				out.contextEdit = { ...ev.contextEdit, replacement: c.text };
				out.truncated = c.truncated;
			}
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
