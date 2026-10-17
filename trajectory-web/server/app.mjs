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
 *   POST /api/translate        抽屉正文翻译转发（Google 免费通道；https_proxy 环境变量出代理）
 *
 * 只读：不写入会话文件；仅监听回环地址。
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildProjection, toLight, findEvent } from "./session.mjs";
import { listSessions, DEFAULT_SESSIONS_ROOT, LIVE_WINDOW_MS } from "./sessions.mjs";
import { scanToolOrigins } from "./tool-origins.mjs";

// 翻译转发：免费通道（无 key）；目标语言白名单。Google translate_a/single 逐段，
// 微软 Edge translatetext 批量纯数组（照 sider 同源接口：from 空 = 自动检测）。
const GOOGLE_TL_URL = "https://translate.googleapis.com/translate_a/single";
const BING_TL_URL = "https://edge.microsoft.com/translate/translatetext";
const TRANSLATE_LANGS = new Set(["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru"]);
const TRANSLATE_SERVICES = new Set(["google", "bing"]);
const BING_LANG = { "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" };

/** 读请求体（上限 1MB，超出拖断）。 */
function readBody(req, limit = 1 << 20) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("请求体超过 1MB"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** 远程 POST（优先 https_proxy/HTTPS_PROXY/all_proxy 环境变量经 curl -x，否则直连），返回响应体文本。 */
async function postRemote(url, contentType, body) {
	const proxy = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.all_proxy ?? process.env.ALL_PROXY ?? "";
	if (proxy) {
		return await new Promise((resolve, reject) => {
			execFile(
				"curl",
				["-sS", "--max-time", "20", "-x", proxy, "-X", "POST", "-H", `content-type: ${contentType}`, "--data-binary", body, url],
				{ maxBuffer: 16 << 20 },
				(err, stdout) => (err ? reject(new Error(err.message)) : resolve(stdout)),
			);
		});
	}
	const res = await fetch(url, { method: "POST", headers: { "content-type": contentType }, body });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return await res.text();
}

/** Google 免费通道：单段 POST form，拼接分段译文。 */
async function googleTranslate(text, to) {
	const form = new URLSearchParams({ client: "gtx", sl: "auto", tl: to, dt: "t", q: text }).toString();
	const payload = await postRemote(GOOGLE_TL_URL, "application/x-www-form-urlencoded", form);
	let data;
	try {
		data = JSON.parse(payload);
	} catch {
		throw new Error(`翻译返回非 JSON（可能代理报错）：${payload.slice(0, 120)}`);
	}
	const out = (data?.[0] ?? []).map((seg) => (Array.isArray(seg) ? seg[0] ?? "" : "")).join("");
	if (!out) throw new Error("翻译返回为空");
	return out;
}

/** 微软 Edge 免费通道：批量纯字符串数组一次 POST（from 空 = 自动检测），保持顺序。 */
async function bingTranslate(texts, to) {
	const lang = BING_LANG[to] ?? to;
	const payload = await postRemote(`${BING_TL_URL}?from=&to=${encodeURIComponent(lang)}`, "application/json", JSON.stringify(texts));
	let data;
	try {
		data = JSON.parse(payload);
	} catch {
		throw new Error(`翻译返回非 JSON（可能代理报错）：${payload.slice(0, 120)}`);
	}
	if (!Array.isArray(data) || data.length !== texts.length || data.some((d) => !d?.translations?.[0]?.text)) {
		throw new Error("微软翻译返回格式异常");
	}
	return data.map((d) => d.translations[0].text);
}

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

	// 工具归属：模式 A 传精确映射提供者（每次请求现取，覆盖运行时才注册的工具，
	// 如 context-mode 的 ctx_* 不在会话启动时的 getAllTools 里）；
	// 精确结果与静态扫描合并（精确优先），扫描结果缓存 5 分钟。
	const ORIGINS_TTL_MS = 5 * 60_000;
	const originsProvider =
		typeof options.toolOrigins === "function" ? options.toolOrigins : options.toolOrigins ? () => options.toolOrigins : null;
	let scanCache = null;

	function getScanOrigins() {
		if (scanCache && Date.now() - Date.parse(scanCache.generatedAt) < ORIGINS_TTL_MS) return scanCache;
		scanCache = scanToolOrigins({ piDir: options.piDir, agentDir: options.agentDir });
		return scanCache;
	}

	function getToolOrigins() {
		if (!originsProvider) return getScanOrigins();
		let exact = {};
		try {
			exact = originsProvider() ?? {};
		} catch (err) {
			log(`工具归属精确映射读取失败，改用扫描结果：${err.message}`);
		}
		return { generatedAt: new Date().toISOString(), source: "pi", tools: { ...getScanOrigins().tools, ...exact } };
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

	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			const pathname = url.pathname;
			if (req.method === "POST") {
				// 只开放翻译转发；其余 POST 一律 405
				if (pathname !== "/api/translate") {
					sendJson(res, 405, { error: "method not allowed" });
				return;
				}
			} else if (req.method !== "GET" && req.method !== "HEAD") {
				sendJson(res, 405, { error: "method not allowed" });
				return;
			}

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

			if (pathname === "/api/translate") {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body || "{}");
				} catch {
					sendJson(res, 400, { error: "请求体不是合法 JSON" });
				return;
				}
				const texts = Array.isArray(payload.q) ? payload.q.map((s) => String(s ?? "")) : null;
				const to = String(payload.to ?? "");
				let service = payload.service;
				if (service === undefined) service = "bing"; // 未传时默认微软
				if (!TRANSLATE_SERVICES.has(service)) service = null;
				if (!texts || texts.length === 0 || texts.length > 40) {
					sendJson(res, 400, { error: "q 需为 1~40 段文本数组" });
					return;
				}
				if (texts.some((t) => t.length > 20_000)) {
					sendJson(res, 400, { error: "单段文本超过 20000 字符" });
					return;
				}
				if (!TRANSLATE_LANGS.has(to)) {
					sendJson(res, 400, { error: `不支持的目标语言：${to || "(空)"}` });
					return;
				}
				if (!service) {
					sendJson(res, 400, { error: `不支持的翻译服务：${payload.service ?? "(空)"}（可选 google / bing）` });
					return;
				}
				try {
					const out = service === "bing" ? await bingTranslate(texts, to) : await Promise.all(
						(function chunk(list, size) {
							const all = [];
							for (let i = 0; i < list.length; i += size) all.push(list.slice(i, i + size));
							return all;
						})(texts, 4).map((batch) => Promise.all(batch.map((t) => googleTranslate(t, to)))),
					).then((groups) => groups.flat());
					sendJson(res, 200, { texts: out });
				} catch (err) {
					sendJson(res, 502, { error: `翻译服务不可达（服务环境需可直连或配置 https_proxy）：${err.message}` });
				}
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
