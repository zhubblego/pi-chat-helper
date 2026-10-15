#!/usr/bin/env node
/**
 * main.mjs — 轨迹观察 web 服务（零依赖）。
 *
 * 由 pi 扩展 `/deepseek-trail start` 以独立后台进程方式拉起，也可以手动运行：
 *   node server/main.mjs --session <file> --port 7717
 *
 * 参数：
 *   --session <file>   必填，pi 会话 JSONL 路径（只读）
 *   --port <n>         默认 7717；0 表示随机端口（测试用）
 *   --host <addr>      默认 127.0.0.1（仅本机）
 *   --web <dir>        静态资源目录，默认 ../web
 *   --state <file>     监听成功后写入的运行时状态文件（pid/port/session/url）
 *   --log <file>       错误日志文件（后台进程无终端，排障用）
 *
 * 接口：
 *   GET /                 web/index.html
 *   GET /app.js /lib.js /style.css
 *   GET /api/health       {ok,pid,port,session,startedAt,etag}
 *   GET /api/session?v=   etag 未变时 {changed:false}，否则 {changed:true,etag,...light}
 *   GET /api/event?id=    单个事件的完整（full）载荷
 *
 * 只读：不写入会话文件；仅监听回环地址。
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProjection, toLight, findEvent } from "./session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const out = {
		session: undefined,
		port: 7717,
		host: "127.0.0.1",
		web: join(HERE, "..", "web"),
		state: undefined,
		log: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => argv[++i];
		switch (arg) {
			case "--session":
				out.session = next();
				break;
			case "--port":
				out.port = Number(next());
				break;
			case "--host":
				out.host = next();
				break;
			case "--web":
				out.web = next();
				break;
			case "--state":
				out.state = next();
				break;
			case "--log":
				out.log = next();
				break;
			default:
				break;
		}
	}
	if (!out.session) {
		process.stderr.write("缺少 --session <会话文件>\n");
		process.exit(2);
	}
	if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) {
		process.stderr.write(`非法端口：${out.port}\n`);
		process.exit(2);
	}
	out.session = resolve(out.session);
	out.web = resolve(out.web);
	return out;
}

const args = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();

function logLine(message) {
	const line = `[${new Date().toISOString()}] ${message}\n`;
	if (args.log) {
		try {
			mkdirSync(dirname(args.log), { recursive: true });
			appendFileSync(args.log, line);
		} catch {
			/* 日志失败不影响服务 */
		}
	}
}

// ---------------------------------------------------------------------------
// 会话投影缓存（按 mtime+size 失效）
// ---------------------------------------------------------------------------

let cache = null; // { etag, full, light }

function currentEtag() {
	const st = statSync(args.session);
	return `${st.mtimeMs}-${st.size}`;
}

function getCache() {
	let etag;
	try {
		etag = currentEtag();
	} catch (err) {
		if (cache) return { ...cache, stale: true };
		throw err;
	}
	if (cache && cache.etag === etag) return cache;
	const full = buildProjection(args.session);
	const next = { etag, full, light: toLight(full) };
	cache = next;
	return next;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const STATIC = new Map([
	["/", ["index.html", "text/html; charset=utf-8"]],
	["/index.html", ["index.html", "text/html; charset=utf-8"]],
	["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
	["/lib.js", ["lib.js", "text/javascript; charset=utf-8"]],
	["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

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
				port: server.address()?.port,
				session: args.session,
				startedAt,
				etag: cache?.etag,
			});
			return;
		}

		if (pathname === "/api/session") {
			let entry;
			try {
				entry = getCache();
			} catch (err) {
				sendJson(res, 500, { error: `会话读取失败：${err.message}` });
				return;
			}
			const want = url.searchParams.get("v");
			if (want && want === entry.etag && !entry.stale) {
				sendJson(res, 200, { changed: false, etag: entry.etag });
				return;
			}
			sendJson(res, 200, {
				changed: true,
				etag: entry.etag,
				stale: entry.stale === true,
				meta: entry.light.meta,
				questions: entry.light.questions,
			});
			return;
		}

		if (pathname === "/api/event") {
			const id = url.searchParams.get("id");
			if (!id) {
				sendJson(res, 400, { error: "缺少 id" });
				return;
			}
			let entry;
			try {
				entry = getCache();
			} catch (err) {
				sendJson(res, 500, { error: `会话读取失败：${err.message}` });
				return;
			}
			const event = findEvent(entry.full, id);
			if (!event) {
				sendJson(res, 404, { error: "事件不存在（可能会话已变更）" });
				return;
			}
			sendJson(res, 200, { etag: entry.etag, event });
			return;
		}

		const staticEntry = STATIC.get(pathname);
		if (staticEntry) {
			const [file, type] = staticEntry;
			const full = join(args.web, file);
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
		logLine(`请求处理失败：${err.stack ?? err.message}`);
		try {
			sendJson(res, 500, { error: String(err.message ?? err) });
		} catch {
			/* 响应可能已发出 */
		}
	}
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

function writeState() {
	if (!args.state) return;
	const state = {
		pid: process.pid,
		port: server.address().port,
		host: args.host,
		session: args.session,
		startedAt,
		url: `http://${args.host}:${server.address().port}/`,
	};
	mkdirSync(dirname(args.state), { recursive: true });
	const tmp = `${args.state}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(state, null, 2));
	renameSync(tmp, args.state);
}

function cleanupState() {
	if (!args.state) return;
	try {
		const state = JSON.parse(readFileSync(args.state, "utf8"));
		if (state.pid === process.pid) unlinkSync(args.state);
	} catch {
		/* 状态文件已不存在或损坏 */
	}
}

let shuttingDown = false;
function shutdown(signal) {
	if (shuttingDown) return;
	shuttingDown = true;
	logLine(`收到 ${signal}，退出`);
	cleanupState();
	server.close(() => process.exit(0));
	// 兜底：连接未关干净时强制退出
	setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.on("error", (err) => {
	logLine(`监听失败：${err.code ?? ""} ${err.message}`);
	process.stderr.write(`轨迹服务启动失败：${err.message}\n`);
	process.exit(1);
});

server.listen(args.port, args.host, () => {
	writeState();
	logLine(`已启动：${args.host}:${server.address().port}（会话 ${args.session}）`);
});
