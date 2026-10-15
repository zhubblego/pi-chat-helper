/**
 * app.mjs — 轨迹观察 HTTP 服务（零依赖；可独立运行，也可被 pi 扩展进程内启动）。
 *
 * 两种范围（scope）：
 *   project：只观察一个项目会话目录（mode A，pi 扩展进程内启动；绑定 pi 实例）
 *   all：观察全部 pi 会话历史与运行中的会话（mode B，`npm run dev` 独立启动）
 *
 * 接口：
 *   GET /                       web/index.html
 *   GET /app.js /lib.js /style.css /tokens.css
 *   GET /api/health             {ok, pid, scope, port, sessionsRoot, current}
 *   GET /api/sessions           会话列表（按最近活跃倒序，live = 30s 内有写入）
 *   GET /api/session?id=&v=     指定会话的 light 投影；etag 未变时 {changed:false}
 *   GET /api/event?session=&id= 单个事件的 full 载荷
 *
 * 只读：不写入会话文件；仅监听回环地址。
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildProjection, toLight, findEvent } from "./session.mjs";
import { listSessions, DEFAULT_SESSIONS_ROOT, LIVE_WINDOW_MS } from "./sessions.mjs";
import { scanToolOrigins } from "./tool-origins.mjs";

const STATIC = new Map([
	["/", ["index.html", "text/html; charset=utf-8"]],
	["/index.html", ["index.html", "text/html; charset=utf-8"]],
	["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
	["/lib.js", ["lib.js", "text/javascript; charset=utf-8"]],
	["/style.css", ["style.css", "text/css; charset=utf-8"]],
	["/tokens.css", ["tokens.css", "text/css; charset=utf-8"]],
]);

const MAX_CACHED_PROJECTIONS = 4;

/**
 * 启动服务。
 * @param {{
 *   scope?: "project" | "all",
 *   sessionFile?: string,
 *   sessionsRoot?: string,
 *   webDir: string,
 *   host?: string,
 *   port?: number,
 *   liveWindowMs?: number,
 *   log?: (message: string) => void,
 *   toolOrigins?: Record<string, { kind: string, label: string }>,
 *   piDir?: string,
 *   agentDir?: string,
 * }} options
 * @returns {Promise<{port:number, host:string, url:string, server:import("node:http").Server, close:() => Promise<void>}>}
 */
export function createTrajectoryServer(options) {
	const webDir = resolve(options.webDir);
	const sessionsRoot = options.sessionsRoot ? resolve(options.sessionsRoot) : DEFAULT_SESSIONS_ROOT;
	const liveWindowMs = options.liveWindowMs ?? LIVE_WINDOW_MS;
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 7717;
	const sessionFile = options.sessionFile ? resolve(options.sessionFile) : undefined;
	const scope = options.scope ?? (sessionFile ? "project" : "all");
	if (scope === "project" && !sessionFile) throw new Error("scope=project 需要 --session <会话文件>");
	const projectDir = scope === "project" ? dirname(sessionFile) : undefined;
	const log = options.log ?? (() => {});

	// 工具归属：模式 A 传精确映射（pi sourceInfo）；否则静态扫描安装目录，缓存 5 分钟
	const ORIGINS_TTL_MS = 5 * 60_000;
	let originsCache = options.toolOrigins
		? { generatedAt: new Date().toISOString(), source: "pi", tools: options.toolOrigins }
		: null;

	function getToolOrigins() {
		if (originsCache && (originsCache.source === "pi" || Date.now() - Date.parse(originsCache.generatedAt) < ORIGINS_TTL_MS)) return originsCache;
		originsCache = scanToolOrigins({ piDir: options.piDir, agentDir: options.agentDir });
		return originsCache;
	}

	/** 投影缓存 LRU：file -> { id, etag, full, light } */
	const projections = new Map();

	function readSessions() {
		return listSessions({ projectDir, sessionsRoot, liveWindowMs });
	}

	/** 解析请求想要的会话：id > 默认会话 > 最近活跃。 */
	function resolveSession(sessions, id) {
		if (id) return sessions.find((s) => s.id === id) ?? null;
		if (sessionFile) {
			const byFile = sessions.find((s) => s.file === sessionFile);
			if (byFile) return byFile;
		}
		return sessions[0] ?? null;
	}

	function getProjection(session) {
		let etag;
		try {
			const st = statSync(session.file);
			etag = `${st.mtimeMs}-${st.size}`;
		} catch (err) {
			throw new Error(`无法读取会话文件：${session.file}（${err.code ?? err.message}）`);
		}
		const cached = projections.get(session.file);
		if (cached && cached.etag === etag) {
			projections.delete(session.file);
			projections.set(session.file, cached);
			return cached;
		}
		const full = buildProjection(session.file);
		const entry = { id: session.id, etag, full, light: toLight(full) };
		projections.delete(session.file);
		projections.set(session.file, entry);
		while (projections.size > MAX_CACHED_PROJECTIONS) {
			const oldest = projections.keys().next().value;
			projections.delete(oldest);
		}
		return entry;
	}

	function sendJson(res, status, body) {
		const data = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(data),
			"cache-control": "no-store",
		});
		res.end(data);
	}

	function sendText(res, status, text, type = "text/plain; charset=utf-8") {
		res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
		res.end(text);
	}

	const server = createServer((req, res) => {
		try {
			if (req.method !== "GET" && req.method !== "HEAD") {
				sendJson(res, 405, { error: "method not allowed" });
				return;
			}
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			const pathname = url.pathname;

			if (pathname === "/api/health") {
				sendJson(res, 200, {
					ok: true,
					pid: process.pid,
					scope,
					port: server.address()?.port,
					projectDir: projectDir ?? null,
					sessionsRoot,
					current: defaultSessionId(),
				});
				return;
			}

			if (pathname === "/api/tool-origins") {
				sendJson(res, 200, getToolOrigins());
				return;
			}

			if (pathname === "/api/sessions") {
				const sessions = readSessions();
				sendJson(res, 200, {
					scope,
					current: defaultSessionId() ?? sessions[0]?.id ?? null,
					sessions: sessions.map((s) => ({
						id: s.id,
						file: s.file,
						projectPath: s.projectPath,
						projectDir: s.projectDir,
						name: s.name,
						firstMessage: s.firstMessage,
						created: s.created,
						modified: s.modified,
						size: s.size,
						live: s.live,
					})),
				});
				return;
			}

			if (pathname === "/api/session") {
				const sessions = readSessions();
				const session = resolveSession(sessions, url.searchParams.get("id"));
				if (!session) {
					sendJson(res, 404, { error: "会话不存在（可能已被删除或列表已刷新）" });
					return;
				}
				let entry;
				try {
					entry = getProjection(session);
				} catch (err) {
					sendJson(res, 500, { error: err.message });
					return;
				}
				const want = url.searchParams.get("v");
				if (want && want === entry.etag) {
					sendJson(res, 200, { changed: false, etag: entry.etag });
					return;
				}
				sendJson(res, 200, {
					changed: true,
					etag: entry.etag,
					sessionId: session.id,
					stale: false,
					meta: entry.light.meta,
					questions: entry.light.questions,
				});
				return;
			}

			if (pathname === "/api/event") {
				const eventId = url.searchParams.get("id");
				if (!eventId) {
					sendJson(res, 400, { error: "缺少 id" });
					return;
				}
				const sessions = readSessions();
				const session = resolveSession(sessions, url.searchParams.get("session"));
				if (!session) {
					sendJson(res, 404, { error: "会话不存在" });
					return;
				}
				let entry;
				try {
					entry = getProjection(session);
				} catch (err) {
					sendJson(res, 500, { error: err.message });
					return;
				}
				const event = findEvent(entry.full, eventId);
				if (!event) {
					sendJson(res, 404, { error: "事件不存在（可能会话已变更）" });
					return;
				}
				sendJson(res, 200, { etag: entry.etag, sessionId: session.id, event });
				return;
			}

			const staticEntry = STATIC.get(pathname);
			if (staticEntry) {
				const [file, type] = staticEntry;
				const full = join(webDir, file);
				if (!existsSync(full)) {
					sendText(res, 404, `静态资源缺失：${full}`);
					return;
				}
				res.writeHead(200, {
					"content-type": type,
					"content-length": statSync(full).size,
					"cache-control": "no-store",
				});
				res.end(req.method === "HEAD" ? undefined : readFileSync(full));
				return;
			}

			sendText(res, 404, "not found");
		} catch (err) {
			log(`请求处理失败：${err.stack ?? err.message}`);
			try {
				sendJson(res, 500, { error: String(err.message ?? err) });
			} catch {
				/* 响应可能已发出 */
			}
		}
	});

	/** 默认会话 id（不触发全量列表时就近解析）。 */
	function defaultSessionId() {
		if (sessionFile) {
			const byFile = readSessions().find((s) => s.file === sessionFile);
			if (byFile) return byFile.id;
		}
		return undefined;
	}

	return new Promise((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(port, host, () => {
			const actualPort = server.address().port;
			resolvePromise({
				port: actualPort,
				host,
				url: `http://${host}:${actualPort}/`,
				server,
				close: () =>
					new Promise((done) => {
						server.closeAllConnections?.();
						server.close(() => done());
					}),
			});
		});
	});
}
