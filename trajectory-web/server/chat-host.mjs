/**
 * chat-host.mjs — 对话控制面。
 *
 * 职责：
 *   - 解析/探测 pi 可执行文件，返回 capabilities；
 *   - 提供可复用的 RpcChild（JSON line over stdio）；
 *   - 线程读取/新建（T2）与 send/stop 的 SSE 流（T3）；
 *   - 关闭时回收所有子进程。
 *
 * 本文件不 import pi SDK；子进程用 CLI 启动。
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildProjection } from "./session.mjs";
import { buildSystemPrompt } from "./chat-prompt.mjs";
import {
	CHAT_PROFILES,
	DEFAULT_PROFILE,
	projectSettings,
	readSettings,
	updateProjectSettings,
} from "./chat-settings.mjs";
import {
	chatSessionDirs,
	findThreadFile,
	isSafeThreadId,
	latestThreadFile,
	parseThreadProjection,
	readSessionId,
	readSessionModel,
	readTurns,
	upsertTurn,
} from "./chat-session.mjs";
import { MIN_PI_VERSION_TEXT, parsePiVersion, piRpcArgs, probeFirstPi, probePi, versionAtLeast } from "./pi-binary.mjs";

const CAP_TTL_MS = 30_000;
const STDERR_LIMIT = 8 * 1024;
const PROMPT_MAX_CHARS = 32_000;
const SSE_PING_MS = 15_000;
const PREVIEW_CHARS = 400;
const SKILLS_TTL_MS = 60_000;
const SKILL_WARN_CHARS = 32_000;
const SKILL_MAX_CHARS = 200_000;

export { CHAT_PROFILES, DEFAULT_PROFILE };

const SSE_HEADERS = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache, no-store",
	connection: "keep-alive",
	"x-accel-buffering": "no",
};

/** agentDir：尊重 PI_CODING_AGENT_DIR，否则 ~/.pi/agent。 */
export function resolveAgentDir(env = process.env) {
	const fromEnv = env.PI_CODING_AGENT_DIR;
	return fromEnv ? resolve(fromEnv) : join(homedir(), ".pi", "agent");
}

/** child 是否位于 parent 内（含相等）。用相对路径判断，避免 `/a/bc` 误判为 `/a/b` 的子路径。 */
export function isPathInside(parent, child) {
	const base = resolve(parent);
	const target = resolve(child);
	const rel = relative(base, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 校验 chatDir：不在轨迹目录内、可创建、可写。
 * @returns {{ok:boolean, dir:string, reason?:string}}
 */
export function checkChatDir(chatDir, sessionRoots = []) {
	const dir = resolve(chatDir);
	for (const root of sessionRoots) {
		if (!root) continue;
		if (isPathInside(resolve(root), dir)) {
			return { ok: false, dir, reason: `chatDir 不能位于轨迹会话目录内：${dir}` };
		}
	}
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		accessSync(dir, constants.W_OK | constants.X_OK);
	} catch (err) {
		return { ok: false, dir, reason: `chatDir 不可写：${err.message}` };
	}
	return { ok: true, dir };
}

/**
 * 一个 pi RPC 子进程。JSON lines over stdio：
 *   - 主机写 `{id,type,...}` 到 stdin；
 *   - 子进程回 `{id,type:"response",command,...}` 或事件 `{type:"message_update",...}`。
 */
export class RpcChild {
	/**
	 * @param {{
	 *   pi: {cmd:string,argsPrefix?:string[],mode?:boolean,display?:string},
	 *   args?: string[],
	 *   cwd?: string,
	 *   env?: NodeJS.ProcessEnv,
	 *   log?: (message:string)=>void,
	 *   name?: string,
	 * }} options
	 */
	constructor(options) {
		this.pi = options.pi;
		this.args = options.args ?? [];
		this.cwd = options.cwd;
		this.env = options.env ?? process.env;
		this.log = options.log ?? (() => {});
		this.name = options.name ?? "pi-rpc";
		this.proc = null;
		this.buf = "";
		this.stderr = "";
		this.seq = 0;
		this.pending = new Map();
		this.listeners = new Set();
		this.exited = false;
		this.exitInfo = null;
	}

	/** 启动子进程；返回 this 便于链式调用。 */
	start() {
		if (this.proc) return this;
		const args = piRpcArgs(this.pi, this.args);
		this.log(`[chat] spawn ${this.pi.cmd} ${args.join(" ")}`);
		this.proc = spawn(this.pi.cmd, args, {
			cwd: this.cwd,
			env: this.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc.stdout?.setEncoding("utf8");
		this.proc.stderr?.setEncoding("utf8");
		this.proc.stdout?.on("data", (chunk) => this._onData(chunk));
		this.proc.stderr?.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
		});
		this.proc.once("error", (err) => {
			this._emit({ type: "child_error", message: err.message });
			this._rejectAll(err);
			this.exited = true;
		});
		this.proc.once("exit", (code, signal) => {
			this.exited = true;
			this.exitInfo = { code, signal };
			this._rejectAll(new Error(`pi 子进程已退出（code=${code ?? "null"} signal=${signal ?? "null"}）`));
			this._emit({ type: "child_exit", code, signal, stderr: this.stderr });
		});
		return this;
	}

	/** 订阅事件；返回取消函数。 */
	onEvent(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * 发送一条 RPC 命令，等待对应 response。
	 * @param {Record<string, unknown> & {type:string}} command
	 * @param {{timeoutMs?:number}} [options]
	 */
	send(command, options = {}) {
		if (!this.proc || this.exited) {
			return Promise.reject(new Error(`pi 子进程不可用${this.exitInfo ? `（code=${this.exitInfo.code}）` : ""}`));
		}
		const timeoutMs = options.timeoutMs ?? 30_000;
		const id = `c${++this.seq}`;
		const payload = { ...command, id };
		return new Promise((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				rejectPromise(new Error(`RPC 超时：${command.type}（${timeoutMs}ms）`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, type: command.type });
			try {
				this.proc.stdin.write(JSON.stringify(payload) + "\n");
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				rejectPromise(err);
			}
		});
	}

	/** 关闭子进程：SIGTERM → 等待 → SIGKILL。 */
	async close(options = {}) {
		const graceMs = options.graceMs ?? 1000;
		if (!this.proc || this.exited) return;
		const proc = this.proc;
		const done = new Promise((resolvePromise) => {
			if (this.exited) resolvePromise();
			else proc.once("exit", () => resolvePromise());
		});
		try {
			proc.kill("SIGTERM");
		} catch {
			/* 已退出 */
		}
		const timer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* 已退出 */
			}
		}, graceMs);
		await done;
		clearTimeout(timer);
	}

	_onData(chunk) {
		this.buf += chunk;
		let index = this.buf.indexOf("\n");
		while (index >= 0) {
			const line = this.buf.slice(0, index).replace(/\r$/, "");
			this.buf = this.buf.slice(index + 1);
			index = this.buf.indexOf("\n");
			if (!line.trim()) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				this.log(`[chat] 忽略非 JSON stdout：${line.slice(0, 200)}`);
				continue;
			}
			if (message?.type === "response" && message.id && this.pending.has(message.id)) {
				const pending = this.pending.get(message.id);
				this.pending.delete(message.id);
				clearTimeout(pending.timer);
				if (message.success === false) {
					pending.reject(new Error(message.error || `RPC 命令失败：${pending.type}`));
				} else {
					pending.resolve(message);
				}
				continue;
			}
			this._emit(message);
		}
	}

	_emit(event) {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (err) {
				this.log(`[chat] 事件处理失败：${err.message}`);
			}
		}
	}

	_rejectAll(error) {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
	}
}

function clip(value, max = PREVIEW_CHARS) {
	const text = String(value ?? "");
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 工具参数摘要：JSON 一行 + 截断，避免把大参数整体塞进 SSE。 */
function argsPreviewOf(args) {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return clip(args, 300);
	try {
		return clip(JSON.stringify(args), 300);
	} catch {
		return clip(String(args), 300);
	}
}

/** 工具结果摘要：优先取文本 content，其余类型退化为 JSON。 */
function resultPreviewOf(result) {
	if (result === undefined || result === null) return "";
	if (typeof result === "string") return clip(result);
	if (typeof result.output === "string") return clip(result.output);
	if (Array.isArray(result.content)) {
		const text = result.content
			.filter((item) => item?.type === "text")
			.map((item) => String(item.text ?? ""))
			.join("\n");
		if (text) return clip(text);
	}
	try {
		return clip(JSON.stringify(result));
	} catch {
		return "";
	}
}

/** done 事件：stopReason/usage/durationMs 取本次 run 的最后一条 assistant。 */
function lastAssistantMeta(messages) {
	const list = Array.isArray(messages) ? messages : [];
	for (let i = list.length - 1; i >= 0; i--) {
		const msg = list[i];
		if (msg?.role !== "assistant") continue;
		const usage = msg.usage
			? {
					input: Number(msg.usage.input ?? 0),
					output: Number(msg.usage.output ?? 0),
					totalTokens: Number(msg.usage.totalTokens ?? 0),
				}
			: null;
		return {
			stopReason: msg.stopReason ?? null,
			usage,
			durationMs: Number.isFinite(msg.durationMs) ? msg.durationMs : null,
		};
	}
	return { stopReason: null, usage: null, durationMs: null };
}

function errorText(err) {
	return clip(err?.message ?? String(err), 500);
}

const PROVIDER_NAMES = Object.freeze({
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google",
	"google-vertex": "Google Vertex",
	"google-gemini-cli": "Google Gemini",
	deepseek: "DeepSeek",
	litellm: "LiteLLM",
	openrouter: "OpenRouter",
	groq: "Groq",
	mistral: "Mistral",
	xai: "xAI",
	ollama: "Ollama",
	azure: "Azure OpenAI",
	"github-copilot": "GitHub Copilot",
	zai: "Z.AI",
	moonshot: "Moonshot",
	alibaba: "Alibaba",
});

/** provider 展示名：未收录的自定义 provider 原样返回。 */
export function providerNameOf(provider) {
	if (!provider) return null;
	return PROVIDER_NAMES[provider] ?? provider;
}

function modelNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * 模型白名单：只输出展示字段。apiKey/baseUrl/headers/oauth 等一律不落地。
 * @param {object} model pi 返回的完整 Model 对象
 */
export function sanitizeModel(model) {
	if (!model || typeof model !== "object") return null;
	const provider = typeof model.provider === "string" && model.provider ? model.provider : null;
	const id = typeof model.id === "string" && model.id ? model.id : null;
	if (!provider || !id) return null;
	return {
		provider,
		providerName: providerNameOf(provider),
		id,
		name: typeof model.name === "string" && model.name ? model.name : id,
		reasoning: model.reasoning === true,
		contextWindow: modelNumber(model.contextWindow),
		maxTokens: modelNumber(model.maxTokens),
	};
}

/** current 响应体：不带 providerName，字段与 api.md §3.1 一致；缺失字段用列表补全。 */
function currentModelOf(model, models = []) {
	const safe = sanitizeModel(model);
	if (!safe) return null;
	const listed = models.find((item) => item.provider === safe.provider && item.id === safe.id);
	const current = {
		provider: safe.provider,
		id: safe.id,
		name: listed?.name ?? safe.name,
		reasoning: safe.reasoning || listed?.reasoning === true,
		contextWindow: safe.contextWindow ?? listed?.contextWindow ?? null,
		maxTokens: safe.maxTokens ?? listed?.maxTokens ?? null,
	};
	return current;
}

function disabledCapabilities(chatDir, reason) {
	return {
		enabled: false,
		backend: "pi-rpc",
		piVersion: null,
		piBin: null,
		chatDir,
		profiles: [...CHAT_PROFILES],
		defaultProfile: DEFAULT_PROFILE,
		features: {
			models: false,
			skills: false,
			context: false,
			tools: false,
			approval: false,
			streaming: false,
		},
		reason,
	};
}

/**
 * 创建对话控制面。
 * @param {{
 *   chatDir?: string,
 *   agentDir?: string,
 *   pi?: {cmd:string,argsPrefix?:string[],mode?:boolean,display?:string},
 *   piVersion?: string,
 *   env?: NodeJS.ProcessEnv,
 *   homeDir?: string,
 *   hostEntry?: string,
 *   hostExecPath?: string,
 *   probeTimeoutMs?: number,
 *   sessionRoots?: string[],
 *   settingsPath?: string,
 *   readSessions?: (source: string) => object[],
 *   resolveSession?: (sessions: object[], id: string) => object | null,
 *   availableSources?: () => Array<{id: string, label: string}>,
 *   ssePingMs?: number,
 *   log?: (message:string)=>void,
 * }} [deps]
 */
export function createChatHost(deps = {}) {
	const env = deps.env ?? process.env;
	const log = deps.log ?? (() => {});
	const chatDir = resolve(deps.chatDir ?? join(deps.agentDir ?? resolveAgentDir(env), "pi-chat-helper", "chats"));
	const settingsPath = resolve(deps.settingsPath ?? join(chatDir, "settings.json"));
	const sessionRoots = (deps.sessionRoots ?? []).filter(Boolean).map((root) => resolve(root));
	/** @type {Map<string, object>} */
	const children = new Map();
	/** 同项目串行：key = `${source}:${projectPath}`，值 = 活动 turn。 */
	const projectTurns = new Map();
	/** 启动中的 child（同 key 并发请求复用同一次 spawn）。 */
	const starting = new Map();
	const ssePingMs = deps.ssePingMs ?? SSE_PING_MS;
	let resolvedPi = deps.pi ?? null;
	let capCache = null;
	// 模型列表缓存（host 级）：pi 的可用模型由全局 auth/models 配置决定，与轨迹会话无关；
	// refresh=1 失败时回退到这里保留的 last-good。
	let modelsCache = null;
	// 技能列表缓存（按 source:sessionId，60s；refresh=1 绕过并重启 child）。
	const skillsCache = new Map();

	function remember(value) {
		capCache = { at: Date.now(), value };
		return value;
	}

	function probeOptions() {
		return {
			env,
			homeDir: deps.homeDir,
			hostEntry: deps.hostEntry,
			hostExecPath: deps.hostExecPath,
			timeoutMs: deps.probeTimeoutMs,
		};
	}

	async function capabilities(refresh = false) {
		if (!refresh && capCache && Date.now() - capCache.at < CAP_TTL_MS) return capCache.value;

		const dirCheck = checkChatDir(chatDir, sessionRoots);
		if (!dirCheck.ok) {
			log(`[chat] ${dirCheck.reason}`);
			return remember(disabledCapabilities(dirCheck.dir, dirCheck.reason));
		}

		let pi = deps.pi ?? null;
		let version = deps.piVersion ? parsePiVersion(deps.piVersion) : null;
		let raw = version?.raw ?? deps.piVersion ?? null;

		if (!version) {
			if (pi) {
				const probed = await probePi(pi, probeOptions());
				if (!probed.ok) {
					return remember(disabledCapabilities(dirCheck.dir, `pi 不可用：${probed.error}`));
				}
				version = probed.version;
				raw = probed.raw;
			} else {
				const probed = await probeFirstPi(probeOptions());
				if (!probed.ok) return remember(disabledCapabilities(dirCheck.dir, probed.error));
				pi = probed.pi;
				version = probed.version;
				raw = probed.raw;
			}
		}

		if (!versionAtLeast(version)) {
			return remember(
				disabledCapabilities(
					dirCheck.dir,
					`pi 版本过低：${version?.raw ?? raw ?? "unknown"}（需要 >= ${MIN_PI_VERSION_TEXT}）`,
				),
			);
		}

		resolvedPi = pi;
		const value = {
			enabled: true,
			backend: "pi-rpc",
			piVersion: version.raw,
			piBin: pi?.display ?? pi?.cmd ?? null,
			chatDir: dirCheck.dir,
			profiles: [...CHAT_PROFILES],
			defaultProfile: DEFAULT_PROFILE,
			features: {
				models: true,
				skills: true,
				context: true,
				tools: true,
				approval: true,
				streaming: true,
			},
			reason: null,
		};
		return remember(value);
	}

	function httpError(status, message) {
		const error = new Error(message);
		error.status = status;
		return error;
	}

	function resolveTarget(source, sessionId) {
		if (typeof deps.readSessions !== "function" || typeof deps.resolveSession !== "function") {
			throw httpError(501, "对话缺少会话解析依赖");
		}
		if (!source) throw httpError(400, "缺少 source");
		const sources = typeof deps.availableSources === "function" ? deps.availableSources() : null;
		if (sources && !sources.some((item) => item.id === source)) {
			throw httpError(400, `不支持的轨迹源：${source}`);
		}
		if (!sessionId) throw httpError(400, "缺少 session");
		const sessions = deps.readSessions(source);
		const session = deps.resolveSession(sessions, sessionId);
		if (!session) throw httpError(404, "会话不存在（可能已被删除或列表已刷新）");
		return { source, sessionId: session.id, session };
	}

	function profileArgs(profile) {
		if (profile === "no-tools") return ["--no-builtin-tools"];
		if (profile === "full") return ["--tools", "read,write,edit,bash"];
		return ["--tools", "read,grep,ls"];
	}

	function spawnArgs({ sessionsDir, profile, threadFile, threadId, projectSkills = false, projectPath = null }) {
		const args = [
			"--session-dir",
			sessionsDir,
			"--no-extensions",
			"--no-context-files",
			"--system-prompt",
			buildSystemPrompt({ hasTrajectoryTool: false }),
			...profileArgs(profile),
			"-na",
		];
		if (projectSkills && projectPath) {
			for (const dir of [join(projectPath, ".pi", "skills"), join(projectPath, ".agents", "skills")]) {
				if (existsSync(dir)) args.push("--skill", dir);
			}
		}
		if (threadFile) args.push("--session", threadFile);
		else if (threadId) args.push("--session-id", threadId);
		return args;
	}

	async function requirePi() {
		const cap = await capabilities();
		if (!cap.enabled) throw httpError(501, cap.reason ?? "对话未启用");
		if (!resolvedPi) throw httpError(501, "pi 可执行文件未解析");
		return resolvedPi;
	}

	function modelOfState(model) {
		if (!model) return null;
		return { provider: model.provider ?? null, id: model.id ?? null, name: model.name ?? model.id ?? null };
	}

	/** 设置键使用的项目路径：优先会话自带的 projectPath/cwd，其次是 child 的 cwd 兑底。 */
	function targetProjectPath(target, record) {
		return target?.session?.projectPath ?? target?.session?.cwd ?? record?.projectPath ?? null;
	}

	function projectOf(target, record) {
		return projectSettings(readSettings(settingsPath), target.source, targetProjectPath(target, record));
	}

	/** get_commands 里的技能（去 skill: 前缀，sourceInfo 平坦化）。 */
	async function getSkillCommands(record) {
		const response = await record.child.send({ type: "get_commands" }, { timeoutMs: 20_000 });
		const commands = Array.isArray(response.data?.commands) ? response.data.commands : [];
		return commands
			.filter((command) => command?.source === "skill" && typeof command.name === "string")
			.map((command) => {
				const info = command.sourceInfo ?? {};
				const filePath = typeof info.path === "string" && info.path ? info.path : null;
				return {
					name: command.name.replace(/^skill:/, ""),
					description: typeof command.description === "string" ? command.description : "",
					filePath,
					baseDir: typeof info.baseDir === "string" && info.baseDir ? info.baseDir : filePath ? dirname(filePath) : null,
					scope: typeof info.scope === "string" ? info.scope : null,
					origin: typeof info.origin === "string" ? info.origin : null,
					source: typeof info.source === "string" ? info.source : null,
				};
			});
	}

	/** 读技能文件：chars=字符数（不是字节），顺带解析 disable-model-invocation。 */
	function readSkillFile(filePath) {
		if (!filePath) return { chars: null, disableModelInvocation: false, error: "技能没有文件路径" };
		try {
			const text = readFileSync(filePath, "utf8");
			const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
			return {
				chars: text.length,
				disableModelInvocation: /^disable-model-invocation:\s*(?:true|"true"|'true')\s*$/m.test(frontmatter),
				error: null,
			};
		} catch (err) {
			return { chars: null, disableModelInvocation: false, error: err.message };
		}
	}

	/** 技能列表载荷：字符数、仅手动、读失败诊断。 */
	async function buildSkillsPayload(record, target) {
		const project = projectOf(target, record);
		const commands = await getSkillCommands(record);
		const diagnostics = [];
		const skills = commands.map((command) => {
			const file = readSkillFile(command.filePath);
			if (file.error) {
				diagnostics.push({ type: "warning", message: `技能 ${command.name}：${file.error}`, path: command.filePath });
			}
			return {
				name: command.name,
				description: command.description,
				filePath: command.filePath,
				baseDir: command.baseDir,
				scope: command.scope,
				origin: command.origin,
				source: command.source,
				disableModelInvocation: file.disableModelInvocation,
				chars: file.chars,
			};
		});
		return {
			cwd: record.projectPath ?? targetProjectPath(target, record),
			projectSkills: project.projectSkills,
			skills,
			diagnostics,
			error: null,
		};
	}

	/** 当前会话用户轮数（按投影 user 事件），+1 得到本轮 ordinal；文件不存在则 1。 */
	function countUserOrdinal(record) {
		const file = record.sessionFile && existsSync(record.sessionFile) ? record.sessionFile : null;
		if (!file) return 1;
		try {
			const projection = buildProjection(file);
			const mapped = parseThreadProjection(projection, []);
			return mapped.messages.filter((message) => message.role === "user").length + 1;
		} catch {
			// 文件正在写/损坏：退到同线程 turns 的最大 ordinal + 1，避免重复覆盖
			const threadId = record.piSessionId ?? (record.sessionFile ? readSessionId(record.sessionFile) : null);
			const turns = threadId ? readTurns(record.metaDir, threadId) : [];
			return Math.max(0, ...turns.map((turn) => Number(turn.ordinal) || 0)) + 1;
		}
	}

	function virtualThread(source, sessionId, id, warnings = []) {
		return {
			thread: {
				id: id ?? null,
				exists: false,
				source,
				sessionId,
				sessionFile: null,
				cwd: null,
				createdAt: null,
				updatedAt: null,
				model: null,
				profile: DEFAULT_PROFILE,
				messages: [],
			},
			pending: false,
			warnings,
		};
	}

	function threadPayload({ source, sessionId, fileRecord, target, record, profile }) {
		let projection;
		try {
			projection = buildProjection(fileRecord.file);
		} catch (err) {
			throw httpError(500, `线程文件解析失败：${err.message}`);
		}
		const dirs = chatSessionDirs(chatDir, source, sessionId);
		// 先确定线程 id，再只取该线程的 turns；旧的无 threadId 记录不参与映射。
		const id = readSessionId(fileRecord.file) ?? projection.meta?.id ?? null;
		const turns = id ? readTurns(dirs.metaDir, id) : [];
		const mapped = parseThreadProjection(projection, turns);
		const pending = Boolean(record?.currentTurn) && (!id || record.piSessionId === id);
		return {
			thread: {
				id,
				exists: true,
				source,
				sessionId,
				sessionFile: fileRecord.file,
				cwd: mapped.cwd ?? target.session.projectPath ?? target.session.cwd ?? null,
				createdAt: mapped.createdAt ?? null,
				updatedAt: mapped.updatedAt ?? null,
				model: mapped.model,
				profile,
				messages: mapped.messages,
			},
			pending,
			warnings: [],
		};
	}

	async function ensureChild(source, sessionId, options = {}) {
		const key = `${source}:${sessionId}`;
		// 先看启动中的 promise：否则并发请求会拿到 state="starting"、piSessionId 为 null 的半成品
		const inflight = starting.get(key);
		if (inflight) return inflight;
		const existing = children.get(key);
		if (existing && existing.state !== "dead") return existing;
		const promise = spawnChild(key, source, sessionId, options);
		starting.set(key, promise);
		try {
			return await promise;
		} finally {
			starting.delete(key);
		}
	}

	async function spawnChild(key, source, sessionId, options = {}) {
		const target = options.target ?? resolveTarget(source, sessionId);
		const pi = await requirePi();
		const dirs = chatSessionDirs(chatDir, source, sessionId);
		mkdirSync(dirs.sessionsDir, { recursive: true, mode: 0o700 });
		mkdirSync(dirs.metaDir, { recursive: true, mode: 0o700 });

		const project = projectOf(target, null);
		const profile = project.profile;
		const projectPath = targetProjectPath(target, null);
		const sessionCwd = target.session.projectPath ?? target.session.cwd ?? null;
		// 历史会话的项目目录可能已被删除；不存在时退回服务进程 cwd，避免 spawn 报误导性的 ENOENT。
		const cwd = sessionCwd && existsSync(sessionCwd) ? sessionCwd : process.cwd();
		let threadFile = null;
		if (options.threadId) {
			if (!isSafeThreadId(options.threadId)) throw httpError(400, "非法线程 id");
			threadFile = findThreadFile(dirs.sessionsDir, options.threadId)?.file ?? null;
		}
		const args = spawnArgs({
			sessionsDir: dirs.sessionsDir,
			profile,
			threadFile,
			threadId: options.threadId && !threadFile ? options.threadId : null,
			projectSkills: project.projectSkills,
			projectPath,
		});
		const record = {
			key,
			source,
			sessionId,
			projectPath: cwd,
			sessionsDir: dirs.sessionsDir,
			metaDir: dirs.metaDir,
			profile,
			projectSkills: project.projectSkills,
			child: null,
			state: "starting",
			piSessionId: null,
			sessionFile: null,
			currentTurn: null,
			lastUsedAt: Date.now(),
		};
		const child = new RpcChild({ pi, args, cwd: record.projectPath, env, log, name: key });
		record.child = child;
		children.set(key, record);
		child.onEvent((event) => {
			if (event.type !== "child_exit") return;
			record.state = "dead";
			if (children.get(key) === record) children.delete(key);
		});
		child.start();
		try {
			const state = await child.send({ type: "get_state" }, { timeoutMs: 15_000 });
			record.piSessionId = state.data?.sessionId ?? null;
			record.sessionFile = state.data?.sessionFile ?? null;
			record.state = "idle";
			return record;
		} catch (err) {
			record.state = "dead";
			children.delete(key);
			await child.close({ graceMs: 500 });
			throw httpError(502, `pi 子进程启动失败：${err.message}`);
		}
	}

	/** 关掉现有 child，下次 ensureChild 用新的 spawn 参数（--session-id）重建。 */
	async function restartChild(record) {
		if (record.currentTurn) throw httpError(409, "回复中，先停止再切换线程");
		if (children.get(record.key) === record) children.delete(record.key);
		record.state = "dead";
		await record.child.close({ graceMs: 800 });
	}

	/** 重启 child 并保留当前线程（文件存在走 --session，不存在走 --session-id）。 */
	async function restartChildKeepThread(record) {
		const threadId = record.piSessionId ?? null;
		await restartChild(record);
		return await ensureChild(record.source, record.sessionId, { threadId: threadId ?? undefined });
	}

	/** 让 child 切到指定线程（文件必须已存在）；返回最新 get_state。 */
	async function switchThread(record, file) {
		const switched = await record.child.send({ type: "switch_session", sessionPath: file.file }, { timeoutMs: 20_000 });
		if (switched.data?.cancelled) throw httpError(409, "切换到线程被取消");
		return await readChildState(record);
	}

	async function readChildState(record) {
		const state = await record.child.send({ type: "get_state" }, { timeoutMs: 15_000 });
		record.piSessionId = state.data?.sessionId ?? record.piSessionId;
		record.sessionFile = state.data?.sessionFile ?? null;
		record.lastUsedAt = Date.now();
		return state;
	}

	async function handleGetSettings(url, res, sendJson) {
		const cap = await capabilities();
		if (!cap.enabled) throw httpError(501, cap.reason ?? "对话未启用");
		const target = resolveTarget(url.searchParams.get("source"), url.searchParams.get("session"));
		const record = children.get(`${target.source}:${target.sessionId}`) ?? null;
		const project = projectOf(target, record);
		sendJson(res, 200, { profile: project.profile, projectSkills: project.projectSkills, approvalAllow: [] });
	}

	async function handlePostSettings(rawBody, res, sendJson) {
		let payload;
		try {
			payload = JSON.parse(rawBody || "{}");
		} catch {
			throw httpError(400, "请求体不是合法 JSON");
		}
		const target = resolveTarget(payload.source, payload.session);
		const patch = {};
		if (payload.profile !== undefined) {
			if (!CHAT_PROFILES.includes(payload.profile)) throw httpError(400, `非法 profile：${payload.profile}`);
			patch.profile = payload.profile;
		}
		if (payload.projectSkills !== undefined) {
			if (typeof payload.projectSkills !== "boolean") throw httpError(400, "projectSkills 需为布尔值");
			patch.projectSkills = payload.projectSkills;
		}
		if (Object.keys(patch).length === 0) throw httpError(400, "没有可修改的设置");

		const cap = await capabilities();
		if (!cap.enabled) throw httpError(501, cap.reason ?? "对话未启用");

		const key = `${target.source}:${target.sessionId}`;
		const record = children.get(key) ?? null;
		if (record?.currentTurn) throw httpError(409, "回复中，先停止再修改设置");
		const next = updateProjectSettings(settingsPath, {
			source: target.source,
			projectPath: targetProjectPath(target, record),
			patch,
		});
		skillsCache.delete(key);
		if (record) await restartChild(record);
		sendJson(res, 200, { ok: true, profile: next.profile, projectSkills: next.projectSkills, restart: true });
	}

	async function handleGetSkills(url, res, sendJson) {
		const cap = await capabilities();
		if (!cap.enabled) throw httpError(501, cap.reason ?? "对话未启用");
		const target = resolveTarget(url.searchParams.get("source"), url.searchParams.get("session"));
		const refresh = url.searchParams.get("refresh") === "1";
		const key = `${target.source}:${target.sessionId}`;
		let record = children.get(key) ?? null;
		if (refresh) {
			if (record?.currentTurn) throw httpError(409, "回复中，先停止再刷新技能");
			// 已有 child 才重启；首次打开直接按当前设置 spawn，避免白起一次
			if (record && record.state !== "dead") record = await restartChildKeepThread(record);
			// 不先删缓存：refresh 失败时要返回 last-good
		}
		if (!record || record.state === "dead") {
			record = await ensureChild(target.source, target.sessionId, { target });
		}
		let project = projectOf(target, record);

		if (!refresh && record.projectSkills !== project.projectSkills && !record.currentTurn) {
			// 同项目其它会话改了开关：本会话查询时应用新 spawn 参数
			record = await restartChildKeepThread(record);
			project = projectOf(target, record);
			skillsCache.delete(key);
		}

		const cached = skillsCache.get(key);
		if (!refresh && cached && Date.now() - cached.at < SKILLS_TTL_MS && cached.payload.projectSkills === project.projectSkills) {
			sendJson(res, 200, cached.payload);
			return;
		}
		try {
			const payload = await buildSkillsPayload(record, target);
			skillsCache.set(key, { at: Date.now(), payload });
			sendJson(res, 200, payload);
		} catch (err) {
			if (cached?.payload) {
				sendJson(res, 200, { ...cached.payload, error: errorText(err) });
				return;
			}
			sendJson(res, 200, {
				cwd: record.projectPath ?? targetProjectPath(target, record),
				projectSkills: project.projectSkills,
				skills: [],
				diagnostics: [],
				error: errorText(err),
			});
		}
	}

	/** 解析本轮技能：body.skill 或 prompt 开头的 /skill:name；返回发送文本与 meta.skill。 */
	async function resolveSkillForSend(record, selectedSkill, prompt) {
		const promptMatch = /^\/skill:([^\s]+)/.exec(prompt);
		let name = promptMatch ? promptMatch[1] : "";
		const fromPrompt = Boolean(promptMatch);
		if (!name && typeof selectedSkill === "string" && selectedSkill.trim()) {
			name = selectedSkill.trim().replace(/^\/?skill:/, "");
		}
		if (!name) return { userText: prompt, skill: null, displayText: prompt };

		let commands;
		try {
			commands = await getSkillCommands(record);
		} catch (err) {
			if (fromPrompt) return { userText: prompt, skill: { name, chars: null, warning: false }, displayText: prompt };
			throw httpError(502, `读取技能列表失败：${err.message}`);
		}
		const found = commands.find((command) => command.name === name);
		if (!found) {
			// 直输不存在的技能：按 pi 行为原样透传
			if (fromPrompt) return { userText: prompt, skill: { name, chars: null, warning: false }, displayText: prompt };
			throw httpError(400, `技能不存在：${name}`);
		}
		const file = readSkillFile(found.filePath);
		if (file.chars !== null && file.chars > SKILL_MAX_CHARS) {
			throw httpError(400, "技能正文过大，请在 SKILL.md 里拆分或精简");
		}
		const skill = { name: found.name, chars: file.chars, warning: file.chars !== null && file.chars > SKILL_WARN_CHARS };
		return { userText: fromPrompt ? prompt : `/skill:${found.name}\n\n${prompt}`, skill, displayText: prompt };
	}

	function writeSse(res, event, data) {
		if (res.writableEnded || res.destroyed) return false;
		try {
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			return true;
		} catch {
			return false;
		}
	}

	async function handleSend(_req, res, rawBody) {
		let payload;
		try {
			payload = JSON.parse(rawBody || "{}");
		} catch {
			throw httpError(400, "请求体不是合法 JSON");
		}

		const target = resolveTarget(payload.source, payload.session);
		const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
		if (!prompt) throw httpError(400, "prompt 不能为空");
		if (prompt.length > PROMPT_MAX_CHARS) throw httpError(400, `prompt 超过 ${PROMPT_MAX_CHARS} 字符`);
		if (payload.skill !== undefined && payload.skill !== null && typeof payload.skill !== "string") {
			throw httpError(400, "skill 需为字符串");
		}
		const requestedThread = payload.threadId ?? null;
		if (requestedThread !== null && !isSafeThreadId(requestedThread)) throw httpError(400, "非法线程 id");

		const cap = await capabilities();
		if (!cap.enabled) throw httpError(501, cap.reason ?? "对话未启用");

		const dirs = chatSessionDirs(chatDir, target.source, target.sessionId);
		// 未指定线程时沿用该轨迹会话最新的 pi session；都没有则由 pi 新建。
		const desiredThreadId =
			requestedThread ?? readSessionId(latestThreadFile(dirs.sessionsDir)?.file ?? "") ?? null;

		let record = await ensureChild(target.source, target.sessionId, { target, threadId: desiredThreadId ?? undefined });

		// 指定线程但文件不存在：已有 child 停在其他 session 时无法 switch，重启后用 --session-id 新建。
		if (desiredThreadId && record.piSessionId !== desiredThreadId && !findThreadFile(dirs.sessionsDir, desiredThreadId)) {
			await restartChild(record);
			record = await ensureChild(target.source, target.sessionId, { target, threadId: desiredThreadId });
		}

		const projectKey = `${target.source}:${record.projectPath ?? ""}`;
		// 同步占锁：检查与占位之间不能有 await，否则并发请求会同时通过。
		if (record.currentTurn) throw httpError(409, "该对话正在生成回复，先停止再发送");
		if (projectTurns.has(projectKey)) throw httpError(409, "本项目还有对话在生成，请稍后再试");

		/** @type {{record:object, projectKey:string, aborted:boolean, finished:boolean, ping:any}} */
		const turn = {
			record,
			projectKey,
			aborted: false,
			finished: false,
			ping: null,
		};
		record.currentTurn = turn;
		projectTurns.set(projectKey, turn);

		let headersSent = false;
		let offEvent = () => {};
		let onClose = () => {};
		try {
			// 线程已存在但与 child 当前 session 不同：先切会话（此时已占锁，不会与别的 turn 交叉）。
			if (desiredThreadId && record.piSessionId !== desiredThreadId) {
				const file = findThreadFile(dirs.sessionsDir, desiredThreadId);
				if (!file) throw httpError(404, `线程 ${desiredThreadId} 不存在`);
				await switchThread(record, file);
			}
			const state = await readChildState(record);

			// 技能：body.skill 拼 /skill: 前缀；直输 /skill:name 原样透传并做大小守卫。
			const resolved = await resolveSkillForSend(record, payload.skill, prompt);
			const userOrdinal = countUserOrdinal(record);
			// 先写 sidecar 再 prompt：显示文本/技能/模型由它保存；写失败只记日志，不阻断对话。
			try {
				upsertTurn(record.metaDir, {
					threadId: record.piSessionId,
					ordinal: userOrdinal,
					displayText: resolved.displayText,
					contextRefs: [],
					skill: resolved.skill,
					profile: record.profile,
					model: modelOfState(state.data?.model),
				});
			} catch (err) {
				log(`[chat] turns 写入失败：${err.message}`);
			}

			res.writeHead(200, SSE_HEADERS);
			headersSent = true;
			writeSse(res, "meta", {
				threadId: record.piSessionId,
				userOrdinal,
				model: modelOfState(state.data?.model),
				profile: record.profile,
				skill: resolved.skill,
			});

			turn.ping = setInterval(() => {
				if (res.writableEnded || res.destroyed) return;
				try {
					res.write(": ping\n\n");
				} catch {
					/* 连接已断，close 回收 */
				}
			}, ssePingMs);
			turn.ping.unref?.();

			let settle = () => {};
			const finished = new Promise((resolvePromise) => {
				settle = resolvePromise;
			});
			let doneSent = false;
			let thinkingSent = false;

			const finish = (event, data) => {
				if (doneSent) return;
				doneSent = true;
				writeSse(res, event, data);
				settle();
			};

			offEvent = record.child.onEvent((event) => {
				if (turn.finished || doneSent) return;
				switch (event.type) {
					case "message_update": {
						const update = event.assistantMessageEvent;
						if (update?.type === "text_delta") {
							writeSse(res, "delta", { text: String(update.delta ?? "") });
						} else if (update?.type === "thinking_delta" && !thinkingSent) {
							thinkingSent = true;
							writeSse(res, "status", { phase: "thinking" });
						}
						break;
					}
					case "tool_execution_start":
						writeSse(res, "tool", {
							phase: "start",
							toolCallId: event.toolCallId ?? null,
							toolName: event.toolName ?? "tool",
							argsPreview: argsPreviewOf(event.args),
						});
						break;
					case "tool_execution_end":
						writeSse(res, "tool", {
							phase: "end",
							toolCallId: event.toolCallId ?? null,
							toolName: event.toolName ?? "tool",
							isError: event.isError === true,
							resultPreview: resultPreviewOf(event.result),
						});
						break;
					case "agent_end": {
						const last = lastAssistantMeta(event.messages);
						finish("done", {
							stopReason: turn.aborted ? "aborted" : last.stopReason,
							usage: last.usage,
							durationMs: last.durationMs,
						});
						break;
					}
					case "child_error":
						finish("error", { message: errorText(event.message ?? "pi 子进程启动失败"), code: "child_error" });
						break;
					case "child_exit":
						finish("error", {
							message: `pi 子进程已退出（code=${event.code ?? "null"}）${event.stderr ? `：${clip(event.stderr, 300)}` : ""}`,
							code: "child_exit",
						});
						break;
					// agent_settled：done 已由 agent_end 发出，忽略避免重复收尾
					// extension_ui_request：审批留到 T7，当前 profile 不会触发
					default:
						break;
				}
			});

			onClose = () => {
				if (turn.finished) return;
				turn.aborted = true;
				record.child.send({ type: "abort" }, { timeoutMs: 10_000 }).catch(() => {});
				settle();
			};
			res.on("close", onClose);

			const accepted = await record.child.send({ type: "prompt", message: resolved.userText }, { timeoutMs: 30_000 });
			if (accepted.data?.disposition === "handled") {
				// 扩展命令/输入处理器消费了 prompt：不会再有 agent_end，直接收尾。
				finish("done", { stopReason: "stop", usage: null, durationMs: null });
			}
			await finished;
		} catch (err) {
			if (!headersSent) throw err;
			writeSse(res, "error", { message: errorText(err), code: err.status ? "request" : "rpc_error" });
		} finally {
			turn.finished = true;
			if (turn.ping) clearInterval(turn.ping);
			offEvent();
			res.off("close", onClose);
			if (record.currentTurn === turn) record.currentTurn = null;
			if (projectTurns.get(projectKey) === turn) projectTurns.delete(projectKey);
			// meta 之前失败走 JSON（外层 sendJson），这里不能提前 end 响应
			if (headersSent && !res.writableEnded) {
				try {
					res.end();
				} catch {
					/* 连接已断 */
				}
			}
		}
	}

	async function handleStop(rawBody, res, sendJson) {
		let payload;
		try {
			payload = JSON.parse(rawBody || "{}");
		} catch {
			throw httpError(400, "请求体不是合法 JSON");
		}
		const target = resolveTarget(payload.source, payload.session);
		const record = children.get(`${target.source}:${target.sessionId}`) ?? null;
		const turn = record?.currentTurn ?? null;
		if (!turn) {
			sendJson(res, 200, { ok: true, stopped: false });
			return;
		}
		turn.aborted = true;
		try {
			await record.child.send({ type: "abort" }, { timeoutMs: 10_000 });
		} catch {
			/* child 已退出：SSE 侧会收到 child_exit */
		}
		sendJson(res, 200, { ok: true, stopped: true });
	}

	async function handleGetThread(url, res, sendJson) {
		const cap = await capabilities();
		if (!cap.enabled) throw httpError(501, cap.reason ?? "对话未启用");
		const target = resolveTarget(url.searchParams.get("source"), url.searchParams.get("session"));
		const dirs = chatSessionDirs(chatDir, target.source, target.sessionId);
		const requested = url.searchParams.get("thread");
		if (requested !== null && !isSafeThreadId(requested)) throw httpError(400, "非法线程 id");

		const key = `${target.source}:${target.sessionId}`;
		const record = children.get(key) ?? null;
		const fileRecord = requested ? findThreadFile(dirs.sessionsDir, requested) : latestThreadFile(dirs.sessionsDir);
		let threadId = requested ?? null;
		if (!requested && fileRecord) threadId = readSessionId(fileRecord.file) ?? null;
		if (!requested && !fileRecord) threadId = record?.piSessionId ?? null;

		if (!fileRecord) {
			const warnings = requested ? [`线程 ${requested} 的文件不存在；发送第一条消息时会新建。`] : [];
			sendJson(res, 200, virtualThread(target.source, target.sessionId, threadId, warnings));
			return;
		}
		sendJson(
			res,
			200,
			threadPayload({
				source: target.source,
				sessionId: target.sessionId,
				fileRecord,
				target,
				record,
				profile: record?.profile ?? projectOf(target, record).profile,
			}),
		);
	}

	async function handlePostThread(rawBody, res, sendJson) {
		let payload;
		try {
			payload = JSON.parse(rawBody || "{}");
		} catch {
			throw httpError(400, "请求体不是合法 JSON");
		}
		const target = resolveTarget(payload.source, payload.session);
		const record = await ensureChild(target.source, target.sessionId, { target });
		if (record.currentTurn) throw httpError(409, "回复中，先停止再新建对话");
		const created = await record.child.send({ type: "new_session" }, { timeoutMs: 15_000 });
		if (created.data?.cancelled) throw httpError(409, "新建会话被取消");
		const state = await record.child.send({ type: "get_state" }, { timeoutMs: 15_000 });
		record.piSessionId = state.data?.sessionId ?? record.piSessionId;
		record.sessionFile = state.data?.sessionFile ?? null;
		record.lastUsedAt = Date.now();
		sendJson(res, 200, {
			thread: {
				id: record.piSessionId,
				exists: false,
				source: target.source,
				sessionId: target.sessionId,
				sessionFile: record.sessionFile,
				cwd: target.session.projectPath ?? target.session.cwd ?? record.projectPath ?? null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				model: modelOfState(state.data?.model),
				profile: record.profile,
				messages: [],
			},
			pending: false,
			warnings: [],
		});
	}

	async function fetchModelList(record) {
		const response = await record.child.send({ type: "get_available_models" }, { timeoutMs: 20_000 });
		const raw = Array.isArray(response.data?.models) ? response.data.models : [];
		const models = [];
		for (const item of raw) {
			const safe = sanitizeModel(item);
			if (safe) models.push(safe);
		}
		return models;
	}

	async function handleGetModels(url, res, sendJson) {
		const cap = await capabilities();
		if (!cap.enabled) throw httpError(501, cap.reason ?? "对话未启用");
		const target = resolveTarget(url.searchParams.get("source"), url.searchParams.get("session"));
		const requestedThread = url.searchParams.get("thread");
		if (requestedThread !== null && !isSafeThreadId(requestedThread)) throw httpError(400, "非法线程 id");

		const dirs = chatSessionDirs(chatDir, target.source, target.sessionId);
		const record = await ensureChild(target.source, target.sessionId, { target });
		const refresh = url.searchParams.get("refresh") === "1";
		let error = null;

		if (refresh || !modelsCache) {
			try {
				const models = await fetchModelList(record);
				modelsCache = { models, refreshedAt: new Date().toISOString() };
			} catch (err) {
				error = errorText(err);
			}
		}
		const models = modelsCache?.models ?? [];

		// current：带 thread 读该线程文件的最新 model 条目，不切 child；否则用 child 当前模型，
		// child 没有模型时回退到最新 session 文件。
		let current = null;
		if (requestedThread !== null) {
			const file = findThreadFile(dirs.sessionsDir, requestedThread);
			if (!file) throw httpError(404, `线程 ${requestedThread} 不存在`);
			const stored = readSessionModel(file.file);
			current = stored ? currentModelOf({ provider: stored.provider, id: stored.id }, models) : null;
		} else {
			let state = null;
			try {
				state = await readChildState(record);
			} catch {
				state = null;
			}
			if (state?.data?.model) {
				current = currentModelOf(state.data.model, models);
			} else {
				const latest = latestThreadFile(dirs.sessionsDir);
				const stored = latest ? readSessionModel(latest.file) : null;
				current = stored ? currentModelOf({ provider: stored.provider, id: stored.id }, models) : null;
			}
		}

		sendJson(res, 200, { current, models, refreshedAt: modelsCache?.refreshedAt ?? null, error });
	}

	async function handlePostModel(rawBody, res, sendJson) {
		let payload;
		try {
			payload = JSON.parse(rawBody || "{}");
		} catch {
			throw httpError(400, "请求体不是合法 JSON");
		}
		const target = resolveTarget(payload.source, payload.session);
		const requestedThread = payload.threadId ?? null;
		if (requestedThread !== null && !isSafeThreadId(requestedThread)) throw httpError(400, "非法线程 id");
		const provider = typeof payload.provider === "string" ? payload.provider : "";
		const id = typeof payload.id === "string" ? payload.id : "";
		if (!provider) throw httpError(400, "缺少 provider");
		if (!id) throw httpError(400, "缺少 id");

		const cap = await capabilities();
		if (!cap.enabled) throw httpError(501, cap.reason ?? "对话未启用");

		const dirs = chatSessionDirs(chatDir, target.source, target.sessionId);
		let threadFile = null;
		if (requestedThread !== null) {
			threadFile = findThreadFile(dirs.sessionsDir, requestedThread);
			if (!threadFile) throw httpError(404, `线程 ${requestedThread} 不存在`);
		}

		const record = await ensureChild(target.source, target.sessionId, {
			target,
			threadId: threadFile ? requestedThread : undefined,
		});
		if (record.currentTurn) throw httpError(409, "回复中，先停止再切换模型");
		if (requestedThread !== null && record.piSessionId !== requestedThread) {
			await switchThread(record, threadFile);
		}

		// 只接受 get_available_models 里真实存在的模型（provider + id 精确匹配）
		const models = await fetchModelList(record);
		const matched = models.find((item) => item.provider === provider && item.id === id);
		if (!matched) throw httpError(400, `模型不存在：${provider}/${id}`);

		const response = await record.child.send({ type: "set_model", provider, modelId: id }, { timeoutMs: 20_000 });
		record.lastUsedAt = Date.now();
		sendJson(res, 200, {
			ok: true,
			threadId: record.piSessionId,
			model: sanitizeModel(response.data) ?? matched,
		});
	}

	/**
	 * 路由分发；返回 true 表示已处理。
	 * @param {import("node:http").IncomingMessage} req
	 * @param {import("node:http").ServerResponse} res
	 * @param {URL} url
	 * @param {unknown} body
	 * @param {(res:import("node:http").ServerResponse,status:number,body:unknown)=>void} sendJson
	 */
	async function handle(req, res, url, body, sendJson) {
		try {
			if (url.pathname === "/api/chat/capabilities") {
				if (req.method !== "GET") {
					sendJson(res, 405, { error: "method not allowed" });
					return true;
				}
				const value = await capabilities(url.searchParams.get("refresh") === "1");
				sendJson(res, 200, value);
				return true;
			}
			if (url.pathname === "/api/chat/thread") {
				if (req.method === "GET") {
					await handleGetThread(url, res, sendJson);
					return true;
				}
				if (req.method === "POST") {
					await handlePostThread(body, res, sendJson);
					return true;
				}
				sendJson(res, 405, { error: "method not allowed" });
				return true;
			}
			if (url.pathname === "/api/chat/settings") {
				if (req.method === "GET") {
					await handleGetSettings(url, res, sendJson);
					return true;
				}
				if (req.method === "POST") {
					await handlePostSettings(body, res, sendJson);
					return true;
				}
				sendJson(res, 405, { error: "method not allowed" });
				return true;
			}
			if (url.pathname === "/api/chat/skills") {
				if (req.method !== "GET") {
					sendJson(res, 405, { error: "method not allowed" });
					return true;
				}
				await handleGetSkills(url, res, sendJson);
				return true;
			}
			if (url.pathname === "/api/chat/models") {
				if (req.method !== "GET") {
					sendJson(res, 405, { error: "method not allowed" });
					return true;
				}
				await handleGetModels(url, res, sendJson);
				return true;
			}
			if (url.pathname === "/api/chat/model") {
				if (req.method !== "POST") {
					sendJson(res, 405, { error: "method not allowed" });
					return true;
				}
				await handlePostModel(body, res, sendJson);
				return true;
			}
			if (url.pathname === "/api/chat/send") {
				if (req.method !== "POST") {
					sendJson(res, 405, { error: "method not allowed" });
					return true;
				}
				await handleSend(req, res, body);
				return true;
			}
			if (url.pathname === "/api/chat/stop") {
				if (req.method !== "POST") {
					sendJson(res, 405, { error: "method not allowed" });
					return true;
				}
				await handleStop(body, res, sendJson);
				return true;
			}
			return false;
		} catch (err) {
			sendJson(res, err.status ?? 500, { error: err.message });
			return true;
		}
	}

	async function close() {
		// 先 abort 活动 turn（让 pi 把 partial 写回 session），再杀进程。
		await Promise.allSettled(
			[...children.values()]
				.filter((record) => record.currentTurn)
				.map((record) => record.child?.send({ type: "abort" }, { timeoutMs: 2000 })),
		);
		await Promise.allSettled([...children.values()].map((record) => record.child?.close()));
		children.clear();
		projectTurns.clear();
	}

	return {
		chatDir,
		capabilities,
		handle,
		close,
		// 供后续阶段与测试使用
		children,
		RpcChild,
	};
}
