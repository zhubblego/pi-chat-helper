/**
 * trajectory-web — 轨迹观察服务（模式 A：绑定当前 pi 实例）。
 *
 * `/deepseek-trail start [端口] [--codex] [--all]`：在 pi 进程内启动本地 web 服务
 *   （默认 127.0.0.1:7717，端口被占用自动改用随机端口）：
 *   - 无选项：当前项目的全部 pi 会话（默认选中当前会话）。
 *   - `--codex`：范围不变，同时开放 Codex 轨迹源（`~/.codex/sessions`，按当前工作目录过滤）。
 *   - `--all`：观察全部 pi 历史与会话 + 宿主机上全部可用轨迹源（等价模式 B 的范围）。
 *   页面左侧会话栏可切换会话，运行中的会话自动刷新；服务随本 pi 实例退出而停止（绑定语义）。
 * `/deepseek-trail stop`：停止服务。
 *
 * 模式 B（不绑 pi、可常驻）由独立入口提供：`npm run dev`。
 *
 * 设计：
 *   - 只读会话 JSONL，不写回会话；仅监听回环地址。
 *   - 服务句柄挂在 globalThis：pi 换会话（new/resume/fork）会重建扩展 runtime，
 *     句柄要能跨 runtime 复用，服务继续存活；只在 quit/reload 时关闭避免泄漏。
 *   - 端口占用时降级为系统分配端口，并把实际 URL 提示给用户。
 *
 * 部署（本仓库是源码主本）：
 *   cp -r trajectory-web ~/.pi/agent/extensions/     # 目录即扩展（index.ts 为入口）
 * 开发时可直接加载：
 *   pi -ne -e .                                      # 仓库根聚合入口（见 ../index.ts）
 *   pi -e ./trajectory-web/index.ts
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createConsoleBridge } from "./server/console-bridge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "web");
/** pi agent 目录：尊重 PI_CODING_AGENT_DIR（与 pi 自身一致）。 */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ? resolvePath(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
/** 对话目录（pi session 文件 + sidecar）。 */
const CHAT_DIR = join(AGENT_DIR, "pi-chat-helper", "chats");

const COMMAND_NAME = "deepseek-trail";
const DEFAULT_PORT = 7717;
const USAGE = `用法：/${COMMAND_NAME} start [端口] [--codex] [--all]（默认 ${DEFAULT_PORT}）| /${COMMAND_NAME} stop`;

/** start 的参数：端口 + 范围（--all 全部历史）+ 源白名单（--codex 放开 Codex 源）。 */
interface StartOptions {
	port: number;
	scope: "project" | "all";
	sources?: string[];
}

/**
 * 解析 `start [端口] [--codex] [--all] [--port <n>]`。
 * 端口可用位置参数（向后兼容）或 --port；--all 隐含全部源，与 --codex 同时给时以 --all 为准。
 */
function parseStartOptions(args: string[]): { options?: StartOptions; error?: string } {
	let portText: string | undefined;
	let codex = false;
	let all = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--codex") {
			codex = true;
			continue;
		}
		if (arg === "--all") {
			all = true;
			continue;
		}
		if (arg === "--port" || arg.startsWith("--port=")) {
			const value = arg === "--port" ? args[++i] : arg.slice("--port=".length);
			if (!value) return { error: "--port 需要一个端口号" };
			portText = value;
			continue;
		}
		if (arg.startsWith("-")) return { error: `未知选项：${arg}` };
		if (portText !== undefined) return { error: `多余的参数：${arg}` };
		portText = arg;
	}
	let port = DEFAULT_PORT;
	if (portText !== undefined) {
		const n = Number(portText);
		if (!Number.isInteger(n) || n < 1024 || n > 65535) return { error: `端口非法：${portText}（需 1024–65535 的整数）` };
		port = n;
	}
	if (all) return { options: { port, scope: "all" } };
	return { options: { port, scope: "project", sources: codex ? ["pi", "codex"] : undefined } };
}

type Notice = (message: string, type?: "info" | "warning" | "error") => void;

interface ServerHandle {
	port: number;
	url: string;
	close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// 模型上下文裁剪（轨迹页剪刀联动）：custom 条目 / context_edit 持久化 + context 事件过滤
// ---------------------------------------------------------------------------

/** 整轮裁剪状态的 custom 条目类型（不进 LLM 上下文，pi 负责落盘；最新一条生效）。 */
const HIDDEN_CUSTOM_TYPE = "pi-chat-helper.trajectory-hidden";

/** 单条裁剪状态的 custom 条目类型（整轮裁剪走 context_edit 通道，单条走这里）。 */
const CROPPED_CUSTOM_TYPE = "pi-chat-helper.trajectory-cropped";

/** 会话条目的最小结构（划轮/恢复/指纹计算只用这几个字段，测试可直接造对象）。 */
export interface EntryLike {
	type: string;
	id?: string;
	message?: { role?: string; content?: unknown };
	customType?: string;
	data?: { hidden?: string[]; cropped?: string[] };
}

/** 轮首 user 内容指纹：string 原样，块数组取 text 块拼接（与 context 事件 messages 对齐）。 */
export function fingerprintOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
			.join("");
	return "";
}

/** 划轮：第 qIndex 轮（0 起）的轮首 user entry id；不存在返回 null（与投影层按 user 切轮一致）。 */
export function userEntryIdOfQIndex(entries: EntryLike[], qIndex: number): string | null {
	let n = -1;
	for (const e of entries) {
		if (e.type === "message" && e.message?.role === "user") {
			n++;
			if (n === qIndex) return e.id ?? null;
		}
	}
	return null;
}

/** 从会话条目恢复整轮裁剪：取最新一条 trajectory-hidden custom 的 hidden 列表。 */
export function hiddenIdsFromEntries(entries: EntryLike[]): string[] {
	let ids: string[] | null = null;
	for (const e of entries) {
		if (e.type === "custom" && e.customType === HIDDEN_CUSTOM_TYPE && Array.isArray(e.data?.hidden)) {
			ids = e.data.hidden.filter((x): x is string => typeof x === "string");
		}
	}
	return ids ?? [];
}

/** 从会话条目恢复单条裁剪：取最新一条 trajectory-cropped custom 的 cropped 列表。 */
export function croppedIdsFromEntries(entries: EntryLike[]): string[] {
	let ids: string[] | null = null;
	for (const e of entries) {
		if (e.type === "custom" && e.customType === CROPPED_CUSTOM_TYPE && Array.isArray(e.data?.cropped)) {
			ids = e.data.cropped.filter((x): x is string => typeof x === "string");
		}
	}
	return ids ?? [];
}

/**
 * 过滤发给模型的 messages：轮首 user 指纹命中隐藏集 → 剔除整轮对话消息。
 * 只剔 user/assistant/toolResult/custom（保证 toolCall 配对自洽）；system 补丁、
 * 压缩/分支摘要等提示词状态一律保留（与轮归属无关）。无命中返回 null（零改动）。
 * 按内容指纹对齐而非引用：context 事件的 messages 由投影重建，引用不稳定。
 */
export function filterHiddenMessages<T extends { role: string; content?: unknown }>(messages: T[], hiddenFingerprints: Set<string>): T[] | null {
	if (!hiddenFingerprints.size) return null;
	const droppable = new Set(["user", "assistant", "toolResult", "custom"]);
	const out: T[] = [];
	let dropping = false;
	for (const m of messages) {
		if (m.role === "user") dropping = hiddenFingerprints.has(fingerprintOfContent(m.content));
		if (dropping && droppable.has(m.role)) continue;
		out.push(m);
	}
	return out.length === messages.length ? null : out;
}

/** 被裁剪的 toolResult 用这句占位：消息壳与 toolCallId 必须保留，否则 toolCall 变孤儿。 */
const CROPPED_PLACEHOLDER = "（该条已被裁剪）";

/**
 * 过滤发给模型的 messages：命中单条裁剪集的内容不再发给模型，且不破坏工具调用配对：
 * - user / custom：整条剔除
 * - assistant：剔掉 text/thinking 块，保留 toolCall 块（它的 toolResult 还在）；无块剩则整条剔除
 * - toolResult：保留消息壳与 toolCallId，content 换成占位文本（toolCall 必须有对应 result）
 * 无命中返回 null（零改动）。同样按内容指纹对齐（messages 由投影重建，引用不稳定）。
 */
export function filterCroppedMessages<T extends { role: string; content?: unknown }>(messages: T[], croppedFingerprints: Set<string>): T[] | null {
	if (!croppedFingerprints.size) return null;
	const out: T[] = [];
	let changed = false;
	for (const m of messages) {
		if (!croppedFingerprints.has(fingerprintOfContent(m.content))) {
			out.push(m);
			continue;
		}
		changed = true;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			// 只保留 toolCall 块（配对需要），文本/思维块全部剪掉
			const kept = (m.content as unknown[]).filter((b) => !!b && typeof b === "object" && (b as { type?: unknown }).type === "toolCall");
			if (kept.length === 0) continue; // 无工具调用：整条剔除
			out.push({ ...m, content: kept });
			continue;
		}
		if (m.role === "toolResult") {
			out.push({ ...m, content: [{ type: "text", text: CROPPED_PLACEHOLDER }] });
			continue;
		}
		// user / custom / 其它角色：整条剔除
	}
	return changed ? out : null;
}

interface ToolOriginEntry {
	kind: "builtin" | "mcp" | "package";
	label: string;
}

/** mcp__<server>__<tool> → “MCP: <server>”。 */
function mcpLabelOf(name: string): string | null {
	if (!name.startsWith("mcp__")) return null;
	const rest = name.slice(5);
	const index = rest.indexOf("__");
	return `MCP: ${index > 0 ? rest.slice(0, index) : rest}`;
}

/**
 * 从 pi 运行时取精确工具归属（模式 A 专用）。
 * sourceInfo 实测形状：{ path, source, scope, origin, baseDir }；内置 source:"builtin"，
 * npm 包 source:"npm:@scope/pkg"，本地扩展为文件路径 + baseDir。
 */
function toolOriginsFromPi(pi: ExtensionAPI): Record<string, ToolOriginEntry> {
	const out: Record<string, ToolOriginEntry> = {};
	for (const tool of pi.getAllTools()) {
		// SAFETY: ToolInfo 的 sourceInfo 未在安装包的 .d.ts 里导出（运行时由 pi 注入），
		// 此处按实测形状窄化读取；缺失时按内置处理。
		const info = (tool as { sourceInfo?: { source?: string; path?: string; baseDir?: string } }).sourceInfo;
		const name = typeof tool.name === "string" ? tool.name : "";
		if (!name) continue;
		const mcp = mcpLabelOf(name);
		if (mcp) {
			out[name] = { kind: "mcp", label: mcp };
			continue;
		}
		const source = info?.source ?? "";
		if (!info || source === "builtin" || (info.path ?? "").startsWith("builtin:")) {
			out[name] = { kind: "builtin", label: "内置" };
			continue;
		}
		const label = source.startsWith("npm:") ? source.slice(4) : info.baseDir ? basename(info.baseDir) : source || "扩展";
		out[name] = { kind: "package", label };
	}
	return out;
}

interface GlobalSlot {
	handle: ServerHandle | null;
	/** 最新 runtime（session_start 时刷新）：server 回调经它拿当前 ctx，跨会话不失效 */
	runtime: { pi: ExtensionAPI; ctx: ExtensionContext } | null;
	/** 整轮裁剪的轮（轮首 user entry id）与其内容指纹；随会话重置 */
	hiddenUserIds: Set<string>;
	hiddenFingerprints: Set<string>;
	/** 单条裁剪的 entry id 与其内容指纹；随会话重置 */
	croppedEntryIds: Set<string>;
	croppedFingerprints: Set<string>;
}

const GLOBAL_KEY = Symbol.for("pi-chat-helper.trajectory-web");

/** 跨扩展 runtime 复用的全局槽位（session 切换会重建 runtime）。 */
function slot(): GlobalSlot {
	// SAFETY: globalThis 的类型声明里没有这个 symbol 键；这里只在同一进程内按约定
	// 读写本扩展自己的槽位，值的形状由本函数构造（GlobalSlot），不存在外部来源。
	const g = globalThis as unknown as Record<symbol, unknown>;
	if (!g[GLOBAL_KEY])
		g[GLOBAL_KEY] = {
			handle: null,
			runtime: null,
			hiddenUserIds: new Set(),
			hiddenFingerprints: new Set(),
			croppedEntryIds: new Set(),
			croppedFingerprints: new Set(),
		};
	return g[GLOBAL_KEY] as GlobalSlot;
}

async function closeSlot(): Promise<void> {
	const existing = slot().handle;
	if (!existing) return;
	slot().handle = null;
	await existing.close();
}

/** 全量重建裁剪集的内容指纹（context 事件按指纹过滤 messages；集合小，重建即可）。 */
function syncFingerprints(s: GlobalSlot, ctx: ExtensionContext): void {
	s.hiddenFingerprints.clear();
	for (const id of s.hiddenUserIds) {
		// SAFETY: getEntry 返回真实会话条目，字段是 EntryLike 的运行时超集。
		const entry = ctx.sessionManager.getEntry(id) as EntryLike | undefined;
		const fp = entry?.message ? fingerprintOfContent(entry.message.content) : "";
		if (fp) s.hiddenFingerprints.add(fp);
	}
	s.croppedFingerprints.clear();
	for (const id of s.croppedEntryIds) {
		const entry = ctx.sessionManager.getEntry(id) as EntryLike | undefined;
		const fp = entry?.message ? fingerprintOfContent(entry.message.content) : "";
		if (fp) s.croppedFingerprints.add(fp);
	}
}

/** 进程内启动；端口占用时降级为系统分配端口（port 0）。 */
async function startInProcess(
	options: StartOptions,
	sessionFile: string,
	projectPath: string | undefined,
	toolOrigins: () => Record<string, ToolOriginEntry>,
	hooks: {
		onContextEdit: (req: { sessionFile: string; qIndex: number; hidden: boolean }) => Promise<void>;
		getContextHidden: () => { sessionFile: string; ids: string[] } | null;
		onCropEntry: (req: { sessionFile: string; entryId: string; cropped: boolean }) => Promise<void>;
		getCropState: () => { sessionFile: string; ids: string[] } | null;
	},
): Promise<ServerHandle> {
	const { createTrajectoryServer } = await import("./server/app.mjs");
	const base = {
		scope: options.scope,
		sessionFile,
		projectPath,
		sources: options.sources,
		webDir: WEB_DIR,
		host: "127.0.0.1",
		toolOrigins,
		agentDir: AGENT_DIR,
		// 对话：子进程 pi；默认目录在 agentDir 下，避免落入 sessions
		chat: true,
		chatDir: CHAT_DIR,
		hostEntry: process.argv[1],
		hostExecPath: process.execPath,
		onContextEdit: hooks.onContextEdit,
		getContextHidden: hooks.getContextHidden,
		onCropEntry: hooks.onCropEntry,
		getCropState: hooks.getCropState,
	};
	const port = options.port;
	try {
		return await createTrajectoryServer({ ...base, port });
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE" && port !== 0) {
			return await createTrajectoryServer({ ...base, port: 0 });
		}
		throw err;
	}
}

async function runStart(rawArgs: string[], ctx: ExtensionCommandContext, pi: ExtensionAPI, notify: Notice): Promise<void> {
	const parsed = parseStartOptions(rawArgs);
	if (parsed.error) {
		notify(`${parsed.error}；${USAGE}`, "warning");
		return;
	}
	// parseStartOptions 保证 options 与 error 二选一
	const options = parsed.options as StartOptions;

	const existing = slot().handle;
	if (existing) {
		notify(`轨迹服务已在运行：${existing.url}`);
		return;
	}

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		notify("当前会话没有落盘文件，无法观察轨迹（内存会话不支持）", "error");
		return;
	}

	// codex 源按真实工作目录过滤；老版本 pi 或测试替身可能缺 getCwd，缺失时退回不过滤。
	const getCwd = (ctx.sessionManager as { getCwd?: () => string }).getCwd;
	const projectPath = options.scope === "project" && typeof getCwd === "function" ? getCwd.call(ctx.sessionManager) : undefined;

	// 隐藏轮回调：经 slot().runtime 动态取最新会话的 ctx（服务跨 runtime 存活，闭包里的 ctx 会失效）。
	// 实现是 custom 条目持久化（pi 落盘，重启可恢复）+ context 事件过滤（下次提问生效）。
	const hooks = {
		onContextEdit: async ({ sessionFile: file, qIndex, hidden }: { sessionFile: string; qIndex: number; hidden: boolean }) => {
			const rt = slot().runtime;
			if (!rt) throw new Error("扩展 runtime 未就绪");
			const current = rt.ctx.sessionManager.getSessionFile();
			if (!current || resolvePath(current) !== resolvePath(file)) throw new Error("只能编辑当前 pi 会话（其它会话只读）");
			// SAFETY: getBranch() 返回真实会话条目，字段是 EntryLike 的运行时超集（type/id/message 同名同义）。
			const userId = userEntryIdOfQIndex(rt.ctx.sessionManager.getBranch() as unknown as EntryLike[], qIndex);
			if (!userId) throw new Error(`轮次 ${qIndex} 不存在（或轮首条目缺 id）`);
			const s = slot();
			if (hidden) s.hiddenUserIds.add(userId);
			else s.hiddenUserIds.delete(userId);
			syncFingerprints(s, rt.ctx);
			rt.pi.appendEntry(HIDDEN_CUSTOM_TYPE, { hidden: [...s.hiddenUserIds] });
		},
		getContextHidden: (): { sessionFile: string; ids: string[] } | null => {
			const rt = slot().runtime;
			const current = rt?.ctx.sessionManager.getSessionFile();
			return current ? { sessionFile: current, ids: [...slot().hiddenUserIds] } : null;
		},
		// 单条裁剪回调：与整轮裁剪同一套校验（只能改当前 pi 会话），状态存自己的 custom 条目。
		onCropEntry: async ({ sessionFile: file, entryId, cropped }: { sessionFile: string; entryId: string; cropped: boolean }) => {
			const rt = slot().runtime;
			if (!rt) throw new Error("扩展 runtime 未就绪");
			const current = rt.ctx.sessionManager.getSessionFile();
			if (!current || resolvePath(current) !== resolvePath(file)) throw new Error("只能裁剪当前 pi 会话（其它会话只读）");
			// 只能裁当前分支上的条目（getEntry 对不存在/不在分支上的 id 返回 undefined）
			if (!rt.ctx.sessionManager.getEntry(entryId)) throw new Error(`条目 ${entryId} 不存在（可能已切分支）`);
			const s = slot();
			if (cropped) s.croppedEntryIds.add(entryId);
			else s.croppedEntryIds.delete(entryId);
			syncFingerprints(s, rt.ctx);
			rt.pi.appendEntry(CROPPED_CUSTOM_TYPE, { cropped: [...s.croppedEntryIds] });
		},
		getCropState: (): { sessionFile: string; ids: string[] } | null => {
			const rt = slot().runtime;
			const current = rt?.ctx.sessionManager.getSessionFile();
			return current ? { sessionFile: current, ids: [...slot().croppedEntryIds] } : null;
		},
	};

	try {
		const handle = await startInProcess(options, sessionFile, projectPath, () => toolOriginsFromPi(pi), hooks);
		slot().handle = handle;
		const note = handle.port === options.port ? "" : `（端口 ${options.port} 被占用，改用 ${handle.port}）`;
		const scopeText = options.scope === "all" ? "全部项目历史 + 全部可用轨迹源" : "当前项目的全部会话";
		const sourceText = options.sources?.length ? `（轨迹源：${options.sources.join(" + ")}）` : "";
		notify(`轨迹服务已启动：${handle.url}${note}\n范围：${scopeText}${sourceText}；随本 pi 实例退出而停止`);
	} catch (err) {
		notify(`轨迹服务启动失败：${(err as Error).message}`, "error");
	}
}

async function runStop(notify: Notice): Promise<void> {
	if (!slot().handle) {
		notify("轨迹服务未在运行");
		return;
	}
	await closeSlot();
	notify("轨迹服务已停止");
}

export default function (pi: ExtensionAPI) {
	const consoleBridge = createConsoleBridge({
		pi,
		getCtx: () => slot().runtime?.ctx,
		agentDir: AGENT_DIR,
		log: (message) => process.stderr.write(`${message}\n`),
	});

	pi.registerCommand(COMMAND_NAME, {
		description: `轨迹观察服务（绑定本 pi 实例）：start [端口] [--codex] [--all] 启动（默认 ${DEFAULT_PORT}），stop 停止`,
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "start", label: "start", description: "启动轨迹观察 web 服务（当前项目的 pi 会话）" },
				{ value: "start --codex", label: "start --codex", description: "当前项目 + Codex 轨迹源" },
				{ value: "start --all", label: "start --all", description: "全部项目历史 + 全部可用轨迹源" },
				{ value: "stop", label: "stop", description: "停止服务" },
			];
			const p = (prefix ?? "").trim();
			return p ? items.filter((item) => item.value.startsWith(p)) : items;
		},
		handler: async (args, ctx) => {
			const notify: Notice = (message, type = "info") => {
				if (ctx.hasUI) ctx.ui.notify(message, type);
				else console.error(`[trajectory-web] ${message}`);
			};
			const [subcommand, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			if (subcommand === "start") {
				await runStart(rest, ctx, pi, notify);
				return;
			}
			if (subcommand === "stop") {
				await runStop(notify);
				return;
			}
			notify(subcommand ? `未知子命令：${subcommand}；${USAGE}` : USAGE, subcommand ? "warning" : "info");
		},
	});

	// 会话切换（new/resume/fork）会重建扩展 runtime 但不该停服务；
	// 退出与 reload 时关闭，避免端口/句柄泄漏（reload 后新代码重新 start）。
	pi.on("session_shutdown", async (event) => {
		await consoleBridge.close();
		if (event.reason === "quit" || event.reason === "reload") await closeSlot();
	});

	pi.on("agent_start", () => consoleBridge.setState("working"));
	pi.on("agent_settled", () => consoleBridge.setState("idle"));

	// 每个新 runtime 都刷新槽位里的当前引用（server 回调经它拿最新 ctx，跨会话不失效），
	// 并从 custom 条目恢复裁剪状态（pi 落盘过，重启/换会话后仍生效）。
	pi.on("session_start", async (_event, ctx) => {
		const s = slot();
		s.runtime = { pi, ctx };
		// SAFETY: getEntries() 返回真实会话条目，字段是 EntryLike 的运行时超集（type/id/customType/data 同名同义）。
		const entries = ctx.sessionManager.getEntries() as unknown as EntryLike[];
		s.hiddenUserIds = new Set(hiddenIdsFromEntries(entries));
		s.croppedEntryIds = new Set(croppedIdsFromEntries(entries));
		syncFingerprints(s, ctx);
		await consoleBridge.start();
	});

	// 模型上下文的裁剪点：每次 LLM 调用前，先按整轮裁剪剔轮，再按单条裁剪剔内容。
	// 无裁剪时零开销直通；返回 undefined 表示不改 messages。
	pi.on("context", (event) => {
		const s = slot();
		const rounds = filterHiddenMessages(event.messages, s.hiddenFingerprints);
		const base = rounds ?? event.messages;
		const cropped = filterCroppedMessages(base, s.croppedFingerprints);
		if (!rounds && !cropped) return undefined;
		return { messages: cropped ?? base };
	});
}
