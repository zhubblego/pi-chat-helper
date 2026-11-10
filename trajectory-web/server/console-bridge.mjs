/**
 * console-bridge.mjs — pi TUI 控制台桥（控制台转发 v1 T1）。
 *
 * 职责：
 *   - 只在交互式 TUI（ctx.mode === "tui"）启动；
 *   - 在 <agentDir>/pi-chat-helper/consoles/ 写 0600 注册文件；
 *   - 监听 127.0.0.1 随机端口，提供带 token 的 POST /forward；
 *   - 把转发正文交给 pi.sendUserMessage，由当前控制台执行；
 *   - 用 agent_start / agent_settled 维护 working / idle，用心跳报告存活。
 *
 * 本模块不 import pi SDK：pi 与 ctx 都由扩展注入，测试可直接传 fake。
 * 默认开启；PI_CHAT_HELPER_CONSOLE_BRIDGE=0 关闭。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";

export const CONSOLE_BRIDGE_PROTOCOL = 1;
export const CONSOLE_BRIDGE_DISABLE_ENV = "PI_CHAT_HELPER_CONSOLE_BRIDGE";
export const CONSOLE_PROMPT_MAX_CHARS = 32_000;
export const CONSOLE_HEARTBEAT_MS = 5_000;
export const CONSOLE_HEARTBEAT_TTL_MS = 15_000;
const MAX_BODY_BYTES = 1 << 20;

/** <agentDir>/pi-chat-helper/consoles */
export function consolesDirFor(agentDir) {
	return join(resolve(agentDir), "pi-chat-helper", "consoles");
}

/** 默认开启；显式设为 "0" 才关闭。 */
export function consoleBridgeEnabled(env = process.env) {
	return env?.[CONSOLE_BRIDGE_DISABLE_ENV] !== "0";
}

/** 规范化会话文件：优先 realpath；失败回退 resolve。Windows 比较时另做小写化。 */
export function canonicalSessionFile(file) {
	const abs = resolve(file);
	try {
		return realpathSync.native(abs);
	} catch {
		try {
			return realpathSync(abs);
		} catch {
			return abs;
		}
	}
}

/** 两个 sessionFile 是否指向同一会话（Windows 大小写不敏感）。 */
export function sameSessionFile(a, b) {
	if (!a || !b) return false;
	const ca = canonicalSessionFile(a);
	const cb = canonicalSessionFile(b);
	return process.platform === "win32" ? ca.toLowerCase() === cb.toLowerCase() : ca === cb;
}

function isLoopbackRequest(req) {
	const address = req.socket?.remoteAddress;
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isJsonContentType(value) {
	return typeof value === "string" && value.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function readBody(req, limit = MAX_BODY_BYTES) {
	return new Promise((resolveBody, reject) => {
		let size = 0;
		let rejected = false;
		const chunks = [];
		const fail = (message, status) => {
			if (rejected) return;
			rejected = true;
			const error = new Error(message);
			error.status = status;
			reject(error);
		};
		req.on("data", (chunk) => {
			if (rejected) return;
			size += chunk.length;
			if (size > limit) {
				fail("请求体超过 1MB", 413);
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!rejected) resolveBody(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", (err) => {
			if (!rejected) reject(err);
		});
	});
}

function sendJson(res, status, body) {
	if (res.writableEnded || res.destroyed) return;
	try {
		const data = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(data),
			"cache-control": "no-store",
		});
		res.end(data);
	} catch {
		/* 客户端提前断开不影响桥 */
	}
}

function isIdleOf(ctx) {
	try {
		return typeof ctx?.isIdle === "function" ? ctx.isIdle() !== false : true;
	} catch {
		return true;
	}
}

function sessionIdOf(ctx, sessionFile) {
	const fn = ctx?.sessionManager?.getSessionId;
	if (typeof fn === "function") {
		try {
			const value = fn.call(ctx.sessionManager);
			if (typeof value === "string" && value) return value;
		} catch {
			/* 旧版本/测试替身缺 getSessionId 时回退文件名 */
		}
	}
	return basename(sessionFile).replace(/\.jsonl$/, "");
}

function cwdOf(ctx) {
	if (typeof ctx?.cwd === "string" && ctx.cwd) return ctx.cwd;
	const fn = ctx?.sessionManager?.getCwd;
	if (typeof fn === "function") {
		try {
			const value = fn.call(ctx.sessionManager);
			if (typeof value === "string" && value) return value;
		} catch {
			/* 忽略 */
		}
	}
	return null;
}

/**
 * 创建一座桥。调用方在 session_start 调 start，在 agent_start / agent_settled 调 setState，
 * 在 session_shutdown 调 close。
 *
 * @param {{
 *   pi: { sendUserMessage: (content: string, options?: object) => Promise<unknown> },
 *   getCtx: () => object | null | undefined,
 *   agentDir: string,
 *   log?: (message: string) => void,
 *   env?: Record<string, string | undefined>,
 *   heartbeatMs?: number,
 * }} options
 */
export function createConsoleBridge(options) {
	const log = options.log ?? (() => {});
	const env = options.env ?? process.env;
	const heartbeatMs =
		Number.isFinite(options.heartbeatMs) && options.heartbeatMs > 0 ? options.heartbeatMs : CONSOLE_HEARTBEAT_MS;
	const dir = consolesDirFor(options.agentDir);
	const pid = process.pid;
	const nonce = randomBytes(8).toString("hex");

	let server = null;
	let port = null;
	let token = null;
	let registrationPath = null;
	let current = null; // { sessionId, sessionFile, cwd, startedAt }
	let state = "idle";
	let optimisticBusy = false;
	let heartbeatTimer = null;
	/** 串行处理 forward：避免两个请求同时看到 idle 并同时 send。 */
	let chain = Promise.resolve();

	function writeRegistration() {
		if (!server || !port || !token || !current) return false;
		const file = join(dir, `${pid}-${nonce}.json`);
		const registration = {
			protocol: CONSOLE_BRIDGE_PROTOCOL,
			pid,
			nonce,
			sessionId: current.sessionId,
			sessionFile: current.sessionFile,
			cwd: current.cwd,
			port,
			token,
			state,
			interactive: true,
			startedAt: current.startedAt,
			heartbeatAt: new Date().toISOString(),
		};
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			try {
				chmodSync(dir, 0o700);
			} catch {
				/* 目录权限在部分平台不可 chmod；注册文件仍尽量收紧 */
			}
			const tmp = `${file}.${pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(registration), { encoding: "utf8", mode: 0o600 });
			try {
				chmodSync(tmp, 0o600);
			} catch {
				/* 非 POSIX 平台忽略 */
			}
			renameSync(tmp, file);
			registrationPath = file;
			return true;
		} catch (err) {
			log(`[console-bridge] 注册表写入失败：${err.message}`);
			return false;
		}
	}

	/** 清理本桥自己遗留的注册（会话切换或上次异常退出）；不碰同进程其它桥。 */
	function cleanupOwnRegistrations(except = null) {
		try {
			for (const name of readdirSync(dir)) {
				if (!name.startsWith(`${pid}-${nonce}`) || !name.endsWith(".json")) continue;
				const file = join(dir, name);
				if (except && file === except) continue;
				try {
					unlinkSync(file);
				} catch {
					/* 单个文件失败不影响启动 */
				}
			}
		} catch {
			/* 目录尚不存在 */
		}
	}

	function startHeartbeat() {
		if (heartbeatTimer) return;
		heartbeatTimer = setInterval(() => {
			if (!server || !current) return;
			writeRegistration();
		}, heartbeatMs);
		heartbeatTimer.unref?.();
	}

	async function startServer() {
		if (server) return true;
		const nextToken = randomBytes(32).toString("hex");
		const nextServer = createServer((req, res) => {
			void handleRequest(req, res);
		});
		try {
			await new Promise((resolveListen, rejectListen) => {
				const onError = (err) => {
					nextServer.off("listening", onListening);
					rejectListen(err);
				};
				const onListening = () => {
					nextServer.off("error", onError);
					resolveListen();
				};
				nextServer.once("error", onError);
				nextServer.once("listening", onListening);
				nextServer.listen(0, "127.0.0.1");
			});
		} catch (err) {
			try {
				nextServer.close();
			} catch {
				/* ignore */
			}
			log(`[console-bridge] 启动失败：${err.message}`);
			return false;
		}
		const address = nextServer.address();
		if (!address || typeof address !== "object") {
			try {
				nextServer.close();
			} catch {
				/* ignore */
			}
			return false;
		}
		nextServer.unref?.();
		nextServer.on("error", (err) => log(`[console-bridge] server 错误：${err.message}`));
		server = nextServer;
		port = address.port;
		token = nextToken;
		return true;
	}

	function updateState(nextState, { clearOptimistic = true } = {}) {
		if (nextState !== "idle" && nextState !== "working") return;
		state = nextState;
		if (clearOptimistic) optimisticBusy = false;
		writeRegistration();
	}

	function authOk(header) {
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (!match || !token) return false;
		const given = Buffer.from(match[1]);
		const expected = Buffer.from(token);
		return given.length === expected.length && timingSafeEqual(given, expected);
	}

	function enqueue(fn) {
		const run = chain.then(fn, fn);
		chain = run.catch(() => {});
		return run;
	}

	async function handleForward(res, payload) {
		if (!current) return sendJson(res, 503, { error: "控制台桥未就绪", code: "bridge_unavailable" });
		// 排队到执行时再检查一次：等待期间控制台可能已切换会话。
		if (!sameSessionFile(payload.sessionFile, current.sessionFile)) {
			return sendJson(res, 409, { error: "控制台已切换到其他会话", code: "session_mismatch" });
		}
		const ctx = options.getCtx();
		if (!ctx || !server) return sendJson(res, 503, { error: "控制台桥未就绪", code: "bridge_unavailable" });
		const currentFile = ctx.sessionManager?.getSessionFile?.();
		if (!currentFile || !sameSessionFile(currentFile, current.sessionFile)) {
			return sendJson(res, 409, { error: "控制台已切换到其他会话", code: "session_mismatch" });
		}
		const requested = payload.delivery;
		const busy = optimisticBusy || !isIdleOf(ctx);
		let delivery = "now";
		if (busy) delivery = requested === "steer" ? "steer" : "followUp";

		// 先乐观置 working：第二个请求即使还没收到 agent_start，也会按忙碌排队。
		optimisticBusy = true;
		updateState("working", { clearOptimistic: false });
		const sendOptions = { expandPromptTemplates: false };
		if (delivery !== "now") sendOptions.deliverAs = delivery;
		try {
			await options.pi.sendUserMessage(payload.prompt, sendOptions);
			return sendJson(res, 200, { ok: true, delivery, state: "working" });
		} catch (err) {
			optimisticBusy = false;
			updateState(isIdleOf(options.getCtx()) ? "idle" : "working");
			log(`[console-bridge] 转发失败：${err.message}`);
			return sendJson(res, 502, { error: "控制台发送失败", code: "bridge_error" });
		}
	}

	async function handleRequest(req, res) {
		const pathname = (req.url ?? "/").split("?", 1)[0] || "/";
		if (pathname !== "/forward") return sendJson(res, 404, { error: "未知接口", code: "not_found" });
		if (req.method !== "POST") {
			res.setHeader("allow", "POST");
			return sendJson(res, 405, { error: "只接受 POST", code: "method_not_allowed" });
		}
		if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: "只允许回环连接", code: "forbidden" });
		// 浏览器请求会带 Origin；桥只供 viewer 服务端调用。
		if (req.headers.origin !== undefined) return sendJson(res, 403, { error: "不接受浏览器 Origin", code: "forbidden" });
		if (!authOk(req.headers.authorization)) return sendJson(res, 401, { error: "token 无效", code: "unauthorized" });
		if (!isJsonContentType(req.headers["content-type"])) {
			return sendJson(res, 415, { error: "Content-Type 必须为 application/json", code: "unsupported_media_type" });
		}

		let raw;
		try {
			raw = await readBody(req);
		} catch (err) {
			return sendJson(res, err.status ?? 400, { error: err.message, code: err.status === 413 ? "body_too_large" : "bad_request" });
		}
		let payload;
		try {
			payload = JSON.parse(raw);
		} catch {
			return sendJson(res, 400, { error: "请求体不是 JSON", code: "bad_request" });
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return sendJson(res, 400, { error: "请求体必须是对象", code: "bad_request" });
		}
		const sessionFile = typeof payload.sessionFile === "string" ? payload.sessionFile : "";
		if (!sessionFile) return sendJson(res, 400, { error: "缺少 sessionFile", code: "bad_request" });
		const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
		if (!prompt) return sendJson(res, 400, { error: "prompt 不能为空", code: "prompt_empty" });
		if (prompt.length > CONSOLE_PROMPT_MAX_CHARS) {
			return sendJson(res, 400, {
				error: `prompt 超过 ${CONSOLE_PROMPT_MAX_CHARS} 字符`,
				code: "prompt_too_large",
			});
		}
		const delivery = payload.delivery ?? "auto";
		if (delivery !== "auto" && delivery !== "followUp" && delivery !== "steer") {
			return sendJson(res, 400, { error: "delivery 非法", code: "bad_delivery" });
		}
		const requestPayload = { sessionFile, prompt, delivery };
		return enqueue(() => handleForward(res, requestPayload));
	}

	async function start() {
		const ctx = options.getCtx();
		if (!ctx || ctx.mode !== "tui" || !consoleBridgeEnabled(env)) {
			await close();
			return false;
		}
		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		if (!sessionFile) {
			await close();
			return false;
		}
		const canonical = canonicalSessionFile(sessionFile);
		const running = await startServer();
		if (!running) return false;
		const sameSession = current?.sessionFile === canonical;
		if (!sameSession) {
			cleanupOwnRegistrations();
			registrationPath = null;
		}
		current = {
			sessionId: sessionIdOf(ctx, canonical),
			sessionFile: canonical,
			cwd: cwdOf(ctx),
			startedAt: sameSession ? current.startedAt : new Date().toISOString(),
		};
		state = isIdleOf(ctx) ? "idle" : "working";
		optimisticBusy = state === "working";
		if (!writeRegistration()) {
			await close();
			return false;
		}
		startHeartbeat();
		return true;
	}

	async function close() {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
		if (registrationPath) {
			try {
				unlinkSync(registrationPath);
			} catch {
				/* 已被清理 */
			}
			registrationPath = null;
		}
		const active = server;
		server = null;
		port = null;
		token = null;
		current = null;
		state = "idle";
		optimisticBusy = false;
		if (active) {
			await new Promise((resolveClose) => {
				let settled = false;
				let timer = null;
				const done = () => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					resolveClose();
				};
				try {
					active.close(done);
					active.closeAllConnections?.();
					timer = setTimeout(done, 1000);
					timer.unref?.();
				} catch {
					done();
				}
			});
		}
	}

	return {
		start,
		close,
		/** 由 agent_start / agent_settled 驱动；会清除 forward 的乐观忙碌标记。 */
		setState(nextState) {
			updateState(nextState);
		},
		get port() {
			return port;
		},
		get registrationPath() {
			return registrationPath;
		},
	};
}
