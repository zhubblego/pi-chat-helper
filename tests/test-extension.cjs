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
		const { createJiti } = require(path.join(process.env.PI_HOME, "node_modules", "jiti"));
		const jiti = createJiti(__filename, {
			alias: {
				"@earendil-works/pi-coding-agent": path.join(process.env.PI_HOME, "dist", "index.js"),
				"@earendil-works/pi-tui": path.join(process.env.PI_HOME, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
			},
		});

		const commands = {};
		const shutdownHandlers = [];
		const mod = jiti(path.join(__dirname, "..", "trajectory-web", "index.ts"));
		mod.default({
			registerCommand: (name, def) => (commands[name] = def),
			on: (event, handler) => {
				if (event === "session_shutdown") shutdownHandlers.push(handler);
				return () => {};
			},
		});
		trail = commands["deepseek-trail"];
		check("注册单一命令 /deepseek-trail", typeof trail?.handler === "function" && typeof trail?.getArgumentCompletions === "function");
		check("不再注册裸 /start 与 /stop", !commands.start && !commands.stop);
		check("子命令补全 start/stop", trail.getArgumentCompletions("")?.map((c) => c.value).join(",") === "start,stop");
		check("注册了 session_shutdown 处理", shutdownHandlers.length > 0);

		// ---- 仓库根聚合入口（pi -e . 依赖） ----
		const aggregateCommands = {};
		const aggregate = jiti(path.join(__dirname, "..", "index.ts"));
		aggregate.default({ registerCommand: (name, def) => (aggregateCommands[name] = def), on: () => () => {} });
		check(
			"根 index.ts 聚合注册 /questions 与 /deepseek-trail",
			["questions", "deepseek-trail"].every((n) => typeof aggregateCommands[n]?.handler === "function"),
			Object.keys(aggregateCommands).join(","),
		);

		const notices = [];
		const ctx = {
			hasUI: true,
			ui: { notify: (message, type) => notices.push({ message, type }) },
			sessionManager: { getSessionFile: () => sessionFile },
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
