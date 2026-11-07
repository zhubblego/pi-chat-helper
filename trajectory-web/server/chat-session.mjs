/**
 * chat-session.mjs — 对话线程的纯函数：目录/路径、sidecar、投影映射。
 *
 * 线程 = pi session 文件；本文件不解析 pi 的完整格式，只负责：
 *   - chatDir 下的目录与安全命名；
 *   - 最新线程/turns/context 快照的读写；
 *   - 把现有 buildProjection 的轨迹投影映射成对话 UI 需要的 messages。
 */
import { createHash } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** 单个线程文件读取上限；超过由调用方返回 400，不解析。 */
export const THREAD_MAX_BYTES = 32 * 1024 * 1024;

/** 只保留 [A-Za-z0-9._-]；发生替换/过长/空/`.`/`..` 时追加 sha1 前缀，避免碰撞与逃逸。 */
export function sanitizeSegment(value) {
	const raw = String(value ?? "");
	const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
	const needsHash = !cleaned || cleaned === "." || cleaned === ".." || cleaned !== raw;
	if (!needsHash) return cleaned;
	const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
	return `${cleaned || "x"}_${hash}`;
}

/** chatDir 下某个轨迹会话的目录。 */
export function chatSessionDirs(chatDir, source, sessionId) {
	const root = join(resolve(chatDir), sanitizeSegment(source), sanitizeSegment(sessionId));
	return { root, sessionsDir: join(root, "sessions"), metaDir: join(root, "meta") };
}

/** pi session id 的合法性（与 pi 的 assertValidSessionId 一致，另加长度上限）。 */
export function isSafeThreadId(id) {
	return (
		typeof id === "string" &&
		id.length <= 128 &&
		/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)
	);
}

/** 列出 sessions 目录下的 session 文件，按 mtime 倒序；mtime 相同按文件名倒序兜底。 */
export function listThreadFiles(sessionsDir) {
	let names;
	try {
		names = readdirSync(sessionsDir);
	} catch {
		return [];
	}
	const files = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl") || name.startsWith(".")) continue;
		const file = join(sessionsDir, name);
		try {
			const stat = statSync(file);
			if (!stat.isFile()) continue;
			files.push({ file, name, mtimeMs: stat.mtimeMs, size: stat.size });
		} catch {
			/* 文件在扫描期间被删 */
		}
	}
	files.sort((a, b) => {
		if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
		if (a.name === b.name) return 0;
		return a.name < b.name ? 1 : -1;
	});
	return files;
}

/** 最新线程文件；没有返回 null。 */
export function latestThreadFile(sessionsDir) {
	return listThreadFiles(sessionsDir)[0] ?? null;
}

/** 读 pi session 文件第一行的 id；失败返回 null。 */
export function readSessionId(file) {
	try {
		if (statSync(file).size > THREAD_MAX_BYTES) return null;
		const first = readFileSync(file, "utf8").split("\n", 1)[0];
		const header = JSON.parse(first);
		return typeof header?.id === "string" ? header.id : null;
	} catch {
		return null;
	}
}

/** 读 pi session 文件里最新的 model_change；没有/坏行返回 null。 */
export function readSessionModel(file) {
	let text;
	try {
		if (statSync(file).size > THREAD_MAX_BYTES) return null;
		text = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line.includes('"model_change"')) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
				return { provider: entry.provider, id: entry.modelId };
			}
		} catch {
			/* 忽略坏行 */
		}
	}
	return null;
}

/** 按 id 找 session 文件：先按文件名后缀，再扫描前 50 个文件的 header。 */
export function findThreadFile(sessionsDir, id) {
	if (!isSafeThreadId(id)) return null;
	const files = listThreadFiles(sessionsDir);
	const direct = files.find((item) => item.name === `${id}.jsonl` || item.name.endsWith(`_${id}.jsonl`));
	if (direct) return direct;
	for (const item of files.slice(0, 50)) {
		if (readSessionId(item.file) === id) return item;
	}
	return null;
}

/** 读 meta/turns.jsonl；坏行忽略，按 (ordinal, threadId) 升序。传 threadId 时只返回该线程。 */
export function readTurns(metaDir, threadId) {
	let text;
	try {
		text = readFileSync(join(metaDir, "turns.jsonl"), "utf8");
	} catch {
		return [];
	}
	const filterByThread = threadId !== undefined && threadId !== null;
	const turns = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line);
			if (!record || !Number.isInteger(Number(record.ordinal))) continue;
			if (filterByThread && record.threadId !== threadId) continue;
			turns.push(record);
		} catch {
			/* 忽略坏行 */
		}
	}
	turns.sort(
		(a, b) => Number(a.ordinal) - Number(b.ordinal) || String(a.threadId ?? "").localeCompare(String(b.threadId ?? "")),
	);
	return turns;
}

/** 追加一条轮次元数据（displayText/contextRefs/skill/profile/model）。 */
export function appendTurn(metaDir, record) {
	mkdirSync(metaDir, { recursive: true, mode: 0o700 });
	appendFileSync(join(metaDir, "turns.jsonl"), JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
}

/**
 * 写一轮元数据：以 (threadId, ordinal) 为键覆盖（后写胜），其余保留，原子替换。
 * 旧的无 threadId 记录不会被任何线程匹配，也不会被本函数删除。
 */
export function upsertTurn(metaDir, record) {
	const ordinal = Number(record?.ordinal);
	if (!Number.isInteger(ordinal)) throw new Error("ordinal 需为整数");
	const threadId = typeof record?.threadId === "string" ? record.threadId : "";
	if (!threadId) throw new Error("turn 缺少 threadId");
	const kept = readTurns(metaDir).filter(
		(item) => !(item.threadId === threadId && Number(item.ordinal) === ordinal),
	);
	kept.push({ ...record, threadId, ordinal });
	kept.sort(
		(a, b) => Number(a.ordinal) - Number(b.ordinal) || String(a.threadId ?? "").localeCompare(String(b.threadId ?? "")),
	);
	mkdirSync(metaDir, { recursive: true, mode: 0o700 });
	const file = join(metaDir, "turns.jsonl");
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, kept.map((item) => JSON.stringify(item)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, file);
}

/** 读当前生效的选中集快照；缺失/损坏返回空清单。 */
export function readContext(metaDir) {
	try {
		const parsed = JSON.parse(readFileSync(join(metaDir, "context.active.json"), "utf8"));
		if (parsed && Array.isArray(parsed.items)) return parsed;
	} catch {
		/* 忽略 */
	}
	return { items: [] };
}

/** 勾选变化先写 next；发送前 promote 成 active。 */
export function writeContextNext(metaDir, snapshot) {
	mkdirSync(metaDir, { recursive: true, mode: 0o700 });
	const next = join(metaDir, "context.next.json");
	const tmp = join(metaDir, "context.next.json.tmp");
	writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, next);
}

/** 把 next 提升为 active（原子 rename；跨设备/权限失败时退化为 copy+unlink）。 */
export function promoteContext(metaDir) {
	const next = join(metaDir, "context.next.json");
	const active = join(metaDir, "context.active.json");
	if (!existsSync(next)) return readContext(metaDir);
	try {
		renameSync(next, active);
	} catch {
		copyFileSync(next, active);
		unlinkSync(next);
	}
	return readContext(metaDir);
}

/** 去掉注入块，得到用户实际输入的问题（sidecar 缺失时的兜底）。 */
export function stripInjectedBlocks(text) {
	return String(text ?? "")
		.replace(/<trajectory_index\b[^>]*>[\s\S]*?<\/trajectory_index>/g, "")
		.replace(/<trajectory_index_delta>[\s\S]*?<\/trajectory_index_delta>/g, "")
		.trim();
}

function escapeAttr(value) {
	return String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function normalizeIdList(items) {
	const ids = [];
	for (const item of Array.isArray(items) ? items : []) {
		const id = typeof item === "string" ? item : item?.id;
		if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

function eventKindLabel(kind) {
	const labels = { user: "提问", thinking: "思考", text: "过程", answer: "回答", tool: "工具", bash: "命令", system: "上下文" };
	return labels[kind] ?? String(kind ?? "事件");
}

/** 清单文本预算与详细行数；超过后降级为无 preview 的短行。 */
export const TRAJECTORY_INDEX_MAX_CHARS = 16_000;
export const TRAJECTORY_INDEX_DETAIL_LIMIT = 80;

/**
 * 生成 <trajectory_index> 清单；空选中返回 ""。preview 截断 80 字符。
 * 前 detailLimit 条带 preview，之后压成 `- [id] label`；超预算追加剩余提示。
 * @param {Array<{id:string,label?:string,kind?:string,preview?:string}>} items
 */
export function buildTrajectoryIndex(
	items,
	{ source = "pi", sessionId = "", maxChars = TRAJECTORY_INDEX_MAX_CHARS, detailLimit = TRAJECTORY_INDEX_DETAIL_LIMIT } = {},
) {
	const list = (Array.isArray(items) ? items : []).filter((item) => typeof item?.id === "string" && item.id);
	if (!list.length) return "";
	const prefix = `<trajectory_index source="${escapeAttr(source)}" session="${escapeAttr(sessionId)}" count="${list.length}">\n`;
	const suffix = "\n</trajectory_index>";
	// 摘要行和 wrapper 也占预算；先按最大剩余条数预留，避免最终超出 maxChars。
	const summaryReserve = `…还有 ${list.length} 条，用 read_trajectory list 查看`.length + 1;
	const lineBudget = Math.max(0, maxChars - prefix.length - suffix.length - summaryReserve);
	const lines = [];
	let used = 0;
	let omitted = 0;
	for (let i = 0; i < list.length; i++) {
		const item = list[i];
		const label = item.label ?? eventKindLabel(item.kind);
		const preview = i < detailLimit && item.preview ? ` · ${clip(item.preview, 80)}` : "";
		const line = `- [${item.id}] ${label}${preview}`;
		if (lines.length && used + line.length + 1 > lineBudget) {
			omitted = list.length - i;
			break;
		}
		lines.push(line);
		used += line.length + 1;
	}
	if (omitted > 0) lines.push(`…还有 ${omitted} 条，用 read_trajectory list 查看`);
	return `${prefix}${lines.join("\n")}${suffix}`;
}

/** 选中集差异：prev/next 可为 id 数组或含 id 的对象数组。 */
export function selectionDelta(prev, next) {
	const prevIds = normalizeIdList(prev);
	const nextIds = normalizeIdList(next);
	const prevSet = new Set(prevIds);
	const nextSet = new Set(nextIds);
	return {
		added: nextIds.filter((id) => !prevSet.has(id)),
		removed: prevIds.filter((id) => !nextSet.has(id)),
	};
}

/** 选中集变化的压缩块；无变化返回 ""。 */
export function buildTrajectoryDelta(delta) {
	const added = Array.isArray(delta?.added) ? delta.added : [];
	const removed = Array.isArray(delta?.removed) ? delta.removed : [];
	if (!added.length && !removed.length) return "";
	return `<trajectory_index_delta>${JSON.stringify({ added, removed })}</trajectory_index_delta>`;
}

function clip(text, max = 400) {
	const value = String(text ?? "");
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

function usageOf(msg) {
	if (!msg?.usage) return null;
	return {
		input: Number(msg.usage.input ?? 0),
		output: Number(msg.usage.output ?? 0),
		totalTokens: Number(msg.usage.totalTokens ?? 0),
	};
}

function modelOfMsg(msg) {
	if (!msg?.model) return null;
	return { provider: msg.provider ?? null, id: String(msg.model), name: String(msg.model) };
}

/**
 * 把 pi session 投影映射成对话 messages。
 * @param {{meta:object, questions:object[]}} projection
 * @param {object[]} [turns] meta/turns.jsonl 记录
 */
export function parseThreadProjection(projection, turns = []) {
	const turnByOrdinal = new Map();
	for (const turn of turns) {
		const ordinal = Number(turn?.ordinal);
		if (Number.isInteger(ordinal)) turnByOrdinal.set(ordinal, turn);
	}

	const messages = [];
	let userOrdinal = 0;
	let model = null;
	let lastAssistant = null;

	for (const question of projection?.questions ?? []) {
		for (const ev of question?.events ?? []) {
			if (ev.kind === "model" && ev.modelChange) {
				model = {
					provider: ev.modelChange.provider ?? null,
					id: ev.modelChange.modelId ?? null,
					name: ev.modelChange.modelId ?? null,
				};
				continue;
			}

			if (ev.kind === "user") {
				userOrdinal++;
				const turn = turnByOrdinal.get(userOrdinal);
				const rawText = String(ev.text ?? "");
				const displayText =
					typeof turn?.displayText === "string" && turn.displayText
						? turn.displayText
						: stripInjectedBlocks(rawText) || rawText;
				let context = [];
				if (Array.isArray(turn?.contextRefs)) context = turn.contextRefs;
				else if (Array.isArray(turn?.contextIds)) context = turn.contextIds.map((id) => ({ id }));
				messages.push({
					id: ev.id,
					role: "user",
					ts: ev.iso,
					displayText,
					context,
					skill: turn?.skill ?? null,
					images: ev.images ?? 0,
				});
				lastAssistant = null;
				continue;
			}

			if (ev.kind === "answer" || ev.kind === "text") {
				const entryId = String(ev.id ?? "").split(":")[0];
				const text = String(ev.text ?? "");
				if (lastAssistant && lastAssistant.entryId === entryId) {
					const message = lastAssistant.message;
					message.text += message.text ? `\n\n${text}` : text;
					message.usage = usageOf(ev.msg) ?? message.usage;
					message.durationMs = ev.msg?.durationMs ?? message.durationMs;
					message.stopReason = ev.msg?.stopReason ?? message.stopReason;
					continue;
				}
				const message = {
					id: ev.id,
					role: "assistant",
					ts: ev.iso,
					text,
					model: modelOfMsg(ev.msg),
					usage: usageOf(ev.msg),
					durationMs: ev.msg?.durationMs ?? null,
					stopReason: ev.msg?.stopReason ?? null,
				};
				messages.push(message);
				lastAssistant = { entryId, message };
				continue;
			}

			if (ev.kind === "tool" || ev.kind === "bash") {
				const isBash = ev.kind === "bash";
				messages.push({
					id: ev.id,
					role: "tool",
					ts: ev.iso,
					toolCallId: ev.tool?.callId ?? null,
					toolName: isBash ? "bash" : (ev.tool?.name ?? "tool"),
					argsPreview: clip(isBash ? ev.bash?.command : ev.tool?.argsText),
					resultPreview: clip(isBash ? ev.bash?.output : ev.tool?.result),
					isError: isBash
						? typeof ev.bash?.exitCode === "number" && ev.bash.exitCode !== 0
						: ev.tool?.isError === true,
					durationMs: ev.tool?.durationMs ?? null,
				});
				lastAssistant = null;
				continue;
			}

			if (ev.kind === "error") {
				messages.push({
					id: ev.id,
					role: "notice",
					kind: "error",
					ts: ev.iso,
					text: String(ev.error?.message ?? ev.preview ?? "错误"),
				});
				lastAssistant = null;
				continue;
			}

			if (ev.kind === "compaction") {
				messages.push({
					id: ev.id,
					role: "notice",
					kind: "compaction",
					ts: ev.iso,
					text: `压缩上下文：${clip(ev.compaction?.summary)}`,
				});
				lastAssistant = null;
				continue;
			}

			if (ev.kind === "branch") {
				messages.push({
					id: ev.id,
					role: "notice",
					kind: "branch",
					ts: ev.iso,
					text: `分支摘要：${clip(ev.branch?.summary)}`,
				});
				lastAssistant = null;
			}

			// thinking/system/context-edit/usage/thinking-level/approval/custom：对话 UI 不展示
		}
	}

	if (!model) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant" && message.model) {
				model = message.model;
				break;
			}
		}
	}

	const meta = projection?.meta ?? {};
	return {
		id: meta.id ?? null,
		cwd: meta.cwd ?? null,
		createdAt: meta.createdAt ?? null,
		updatedAt: meta.updatedAt ?? null,
		model,
		messages,
	};
}
