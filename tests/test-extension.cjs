// pi 扩展 /deepseek-trail start|stop（模式 A：进程内服务，绑定 pi 实例）
// 覆盖：注册与补全 / 项目范围 / 幂等 / 端口降级 / 换会话存活 / quit 关闭 / 停服
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, cond ? "" : extra);
	if (!cond) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-ext-"));
// 把 HOME 指向临时目录：codex 源根目录（~/.codex/sessions）落在可控的 fixture 里，
// 不依赖、也不污染宿主机真实 codex 历史。必须在加载扩展（app.mjs 算 DEFAULT_CODEX_ROOT）前设置。
process.env.HOME = tmp;
const codexDay = path.join(tmp, ".codex", "sessions", "2026", "01", "01");
fs.mkdirSync(codexDay, { recursive: true });
fs.writeFileSync(
	path.join(codexDay, "rollout-2026-01-01T00-00-00-019f592a-0d06-7e41-b3bc-df1f510cdbbd.jsonl"),
	[
		JSON.stringify({ timestamp: "2026-01-01T00:00:00.100Z", type: "session_meta", payload: { id: "cx-ext-1", cwd: tmp } }),
		JSON.stringify({ timestamp: "2026-01-01T00:00:00.400Z", type: "response_item", payload: { type: "message", id: "msg_u1", role: "user", content: [{ type: "input_text", text: "codex 第一问" }] } }),
	].join("\n"),
);
const sessionFile = path.join(tmp, "2026-01-01T00-00-00-000Z_ext-1.jsonl");
const line = (o) => JSON.stringify(o);
fs.writeFileSync(
	sessionFile,
	[
		line({ type: "session", version: 3, id: "ext-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmp }),
		line({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "测试", timestamp: 1000 } }),
	].join("\n") + "\n",
);

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = srv.address().port;
			srv.close(() => resolve(port));
		});
	});
}

(async () => {
	let trail = null;
	try {
		if (!process.env.PI_HOME) throw new Error("需要 PI_HOME 环境变量");
		const PI_HOME = process.env.PI_HOME;
		/** 依赖位置：旧布局（dist 与 node_modules 同在 PI_HOME 根）或 managed install（包在 node_modules/@earendil-works 下）。 */
		const firstExisting = (candidates, what) => {
			for (const p of candidates) if (fs.existsSync(p)) return p;
			throw new Error(`PI_HOME 下找不到 ${what}（试过：${candidates.join(" / ")}）`);
		};
		const jitiDir = firstExisting([path.join(PI_HOME, "node_modules", "jiti"), path.join(PI_HOME, "..", "..", "jiti")], "jiti");
		const agentEntry = firstExisting(
			[path.join(PI_HOME, "dist", "index.js"), path.join(PI_HOME, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")],
			"pi-coding-agent/dist/index.js",
		);
		const tuiEntry = firstExisting(
			[
				path.join(PI_HOME, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
				path.join(PI_HOME, "..", "..", "@earendil-works", "pi-tui", "dist", "index.js"),
			],
			"pi-tui/dist/index.js",
		);
		const { createJiti } = require(jitiDir);
		const jiti = createJiti(__filename, { alias: { "@earendil-works/pi-coding-agent": agentEntry, "@earendil-works/pi-tui": tuiEntry } });

		const commands = {};
		const shutdownHandlers = [];
		const mod = jiti(path.join(__dirname, "..", "trajectory-web", "index.ts"));
		mod.default({
			registerCommand: (name, def) => (commands[name] = def),
			on: (event, handler) => {
				if (event === "session_shutdown") shutdownHandlers.push(handler);
				return () => {};
			},
			// 模式 A 的精确归属来源（真实形状：sourceInfo.source = builtin / npm:<pkg>）；
			// 第 2 次调用起多一个 late_tool，用于验证「每次请求现取」而非启动快照
			getAllTools: (() => {
				let calls = 0;
				const base = [
					{ name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
					{ name: "memory_search", sourceInfo: { path: "/tmp/pi-hermes-memory/dist/index.ts", source: "npm:pi-hermes-memory" } },
					{ name: "local_tool", sourceInfo: { path: "/tmp/my-ext/index.ts", source: "file:/tmp/my-ext/index.ts", baseDir: "/tmp/my-ext" } },
					{ name: "mcp__docs__search", sourceInfo: { path: "/tmp/mcp/index.ts", source: "npm:@scope/mcp" } },
				];
				return () => {
					calls++;
					return calls === 1 ? base : [...base, { name: "late_tool", sourceInfo: { path: "/tmp/late/index.ts", source: "npm:late-pkg" } }];
				};
			})(),
		});
		trail = commands["deepseek-trail"];
		check("注册单一命令 /deepseek-trail", typeof trail?.handler === "function" && typeof trail?.getArgumentCompletions === "function");
		check("不再注册裸 /start 与 /stop", !commands.start && !commands.stop);
		check("子命令补全含 start / --codex / --all / stop", trail.getArgumentCompletions("")?.map((c) => c.value).join(",") === "start,start --codex,start --all,stop");
		check("补全按前缀过滤", trail.getArgumentCompletions("start --")?.map((c) => c.value).join(",") === "start --codex,start --all");
		check("注册了 session_shutdown 处理", shutdownHandlers.length > 0);

		// ---- 仓库根聚合入口（pi -e . 依赖） ----
		const aggregateCommands = {};
		const aggregate = jiti(path.join(__dirname, "..", "index.ts"));
		aggregate.default({ registerCommand: (name, def) => (aggregateCommands[name] = def), on: () => () => {}, getAllTools: () => [] });
		check(
			"根 index.ts 聚合注册 /questions 与 /deepseek-trail",
			["questions", "deepseek-trail"].every((n) => typeof aggregateCommands[n]?.handler === "function"),
			Object.keys(aggregateCommands).join(","),
		);

		const notices = [];
		const ctx = {
			hasUI: true,
			ui: { notify: (message, type) => notices.push({ message, type }) },
			sessionManager: { getSessionFile: () => sessionFile, getCwd: () => tmp },
		};
		const lastNotice = () => notices[notices.length - 1];

		// ---- 用法 ----
		await trail.handler("", ctx);
		check("空参数提示用法", lastNotice().type === "info" && /用法：\/deepseek-trail start/.test(lastNotice().message), lastNotice().message);
		await trail.handler("bogus", ctx);
		check("未知子命令提示用法", lastNotice().type === "warning" && /未知子命令/.test(lastNotice().message), lastNotice().message);

		// ---- 启动（进程内，项目范围） ----
		const port = await freePort();
		await trail.handler(`start ${port}`, ctx);
		const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(lastNotice().message);
		check("start 提示 URL", !!m && Number(m[1]) === port, lastNotice().message);
		const url = m?.[0] ?? null;
		const health = await (await fetch(`${url}api/health`)).json();
		check("服务真实可访问且为项目范围", health.ok === true && health.scope === "project");
		const listing = await (await fetch(`${url}api/sessions`)).json();
		check("会话列表只含本项目", listing.sessions.length === 1 && listing.sessions[0].id === "ext-1", JSON.stringify(listing.sessions.map((s) => s.id)));
		const def = await (await fetch(`${url}api/session`)).json();
		check("默认会话 = 当前 pi 会话", def.sessionId === "ext-1", String(def.sessionId));

		// ---- 精确工具归属（模式 A：来自 pi.getAllTools().sourceInfo） ----
		const origins = await (await fetch(`${url}api/tool-origins`)).json();
		check(
			"工具归属来自 pi（内置 / npm 包 / 本地扩展 / MCP）",
			origins.source === "pi" &&
				origins.tools.read?.label === "内置" &&
				origins.tools.memory_search?.label === "pi-hermes-memory" &&
				origins.tools.local_tool?.label === "my-ext" &&
				origins.tools.mcp__docs__search?.label === "MCP: docs",
			JSON.stringify(origins.tools).slice(0, 220),
		);
		check("模式 A 精确映射与静态扫描合并", origins.source === "pi" && Object.keys(origins.tools).length > 4, String(Object.keys(origins.tools).length));
		const originsLater = await (await fetch(`${url}api/tool-origins`)).json();
		check("每次请求现取：运行时才注册的工具能进映射", originsLater.tools.late_tool?.label === "late-pkg", JSON.stringify(originsLater.tools.late_tool));

		// ---- 幂等 ----
		await trail.handler(`start ${port}`, ctx);
		check("重复 start 只提示已在运行", /已在运行/.test(lastNotice().message) && lastNotice().message.includes(url), lastNotice().message);

		// ---- 停止 ----
		await trail.handler("stop", ctx);
		check("stop 提示已停止", /已停止/.test(lastNotice().message), lastNotice().message);
		let stopped = false;
		try {
			await fetch(`${url}api/health`, { signal: AbortSignal.timeout(800) });
		} catch {
			stopped = true;
		}
		check("stop 后端口关闭", stopped);

		// ---- 端口被占用时降级 ----
		const busy = await new Promise((resolve, reject) => {
			const srv = net.createServer();
			srv.once("error", reject);
			srv.listen(0, "127.0.0.1", () => resolve(srv));
		});
		const busyPort = busy.address().port;
		await trail.handler(`start ${busyPort}`, ctx);
		const m2 = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(lastNotice().message);
		check("端口占用时降级并提示", !!m2 && Number(m2[1]) !== busyPort && /被占用/.test(lastNotice().message), lastNotice().message);
		const url2 = m2?.[0] ?? null;
		await new Promise((r) => busy.close(r));

		// ---- 换会话（new/resume/fork）不停服务；quit 停 ----
		for (const handler of shutdownHandlers) await handler({ type: "session_shutdown", reason: "new" });
		check("换会话（new）后服务仍在", (await (await fetch(`${url2}api/health`)).json()).ok === true);

		// ---- 非法端口 ----
		await trail.handler("start 22", ctx);
		check("非法端口被拒", lastNotice().type === "warning" && /端口非法/.test(lastNotice().message));

		for (const handler of shutdownHandlers) await handler({ type: "session_shutdown", reason: "quit" });
		let closed = false;
		try {
			await fetch(`${url2}api/health`, { signal: AbortSignal.timeout(800) });
		} catch {
			closed = true;
		}
		check("quit 后服务关闭", closed);

		// ---- 参数解析：--codex / --all / --port / 非法选项 ----
		const codexPort = await freePort();
		await trail.handler(`start --codex ${codexPort}`, ctx);
		const m3 = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(lastNotice().message);
		check("--codex 启动并提示源", !!m3 && Number(m3[1]) === codexPort && /pi \+ codex/.test(lastNotice().message), lastNotice().message);
		const url3 = m3?.[0] ?? null;
		const health3 = await (await fetch(`${url3}api/health`)).json();
		check("--codex 仍为项目范围", health3.scope === "project");
		check("--codex 开放 pi + codex 源", health3.sources?.join(",") === "pi,codex", JSON.stringify(health3.sources));
		const cxSources = await (await fetch(`${url3}api/sources`)).json();
		check("--codex 源列表含 codex", cxSources.sources.map((s) => s.id).join(",") === "pi,codex", JSON.stringify(cxSources));
		// codex 项目过滤用真实 cwd（fixture cwd = tmp），不是 pi 的会话目录
		const cxList = await (await fetch(`${url3}api/sessions?source=codex`)).json();
		check("--codex 按当前工作目录过滤", cxList.sessions?.length === 1 && cxList.sessions[0].id === "cx-ext-1", JSON.stringify(cxList).slice(0, 160));
		// 显式请求 pi 源仍正常（白名单不串源）
		check("--codex 同时保留 pi 源", (await (await fetch(`${url3}api/sessions?source=pi`)).json()).sessions?.length === 1);
		const cxProj = await (await fetch(`${url3}api/session?source=codex&id=cx-ext-1`)).json();
		check("--codex 投影可读", cxProj.changed === true && cxProj.questions?.[0]?.events?.some((e) => e.kind === "user"), JSON.stringify(cxProj).slice(0, 160));

		await trail.handler("stop", ctx);
		const allPort = await freePort();
		await trail.handler(`start --port ${allPort} --all`, ctx);
		const m4 = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(lastNotice().message);
		check("--port 与 --all 组合生效", !!m4 && Number(m4[1]) === allPort && /全部项目历史/.test(lastNotice().message), lastNotice().message);
		const url4 = m4?.[0] ?? null;
		const health4 = await (await fetch(`${url4}api/health`)).json();
		check("--all 为全部范围", health4.scope === "all");
		check("--all 开放全部可用源", health4.sources?.join(",") === "pi,codex", JSON.stringify(health4.sources));
		await trail.handler("stop", ctx);

		await trail.handler("start --bogus", ctx);
		check("未知选项被拒", lastNotice().type === "warning" && /未知选项：--bogus/.test(lastNotice().message), lastNotice().message);
		await trail.handler("start 2000 3000", ctx);
		check("多余位置参数被拒", lastNotice().type === "warning" && /多余的参数/.test(lastNotice().message), lastNotice().message);
		await trail.handler("start --port", ctx);
		check("--port 缺值被拒", lastNotice().type === "warning" && /需要一个端口号/.test(lastNotice().message), lastNotice().message);

		await trail.handler("stop", ctx);
		check("重复 stop 提示未在运行", /未在运行/.test(lastNotice().message), lastNotice().message);
	} catch (err) {
		check("测试执行", false, err.stack);
	} finally {
		if (trail) {
			try {
				await trail.handler("stop", { hasUI: true, ui: { notify: () => {} }, sessionManager: { getSessionFile: () => sessionFile } });
			} catch {
				/* 已停止 */
			}
		}
		fs.rmSync(tmp, { recursive: true, force: true });
		console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
		process.exit(failed === 0 ? 0 : 1);
	}
})();
