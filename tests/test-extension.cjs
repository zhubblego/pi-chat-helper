// pi 扩展 /deepseek-trail start|stop：真实 spawn 后台服务、幂等、跨会话检测、停止清理
// 依赖 PI_HOME 指向本机 pi 安装目录（提供 jiti）
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, cond ? "" : extra);
	if (!cond) failed++;
};

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tw-ext-"));
process.env.HOME = tmpHome; // 隔离运行时状态目录（os.homedir() 优先读 $HOME）

const sessionFile = path.join(tmpHome, "session-a.jsonl");
const sessionFileB = path.join(tmpHome, "session-b.jsonl");
const fixture = (id) =>
	JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpHome }) +
	"\n" +
	JSON.stringify({
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: "测试", timestamp: 1000 },
	}) +
	"\n";
fs.writeFileSync(sessionFile, fixture("a"));
fs.writeFileSync(sessionFileB, fixture("b"));

const STATE_FILE = path.join(tmpHome, ".pi", "agent", "trajectory-web", "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
	let commands = {};
	let pid = null;
	try {
		if (!process.env.PI_HOME) throw new Error("需要 PI_HOME 环境变量");
		const { createJiti } = require(path.join(process.env.PI_HOME, "node_modules", "jiti"));
		const jiti = createJiti(__filename, {
			alias: {
				"@earendil-works/pi-coding-agent": path.join(process.env.PI_HOME, "dist", "index.js"),
				"@earendil-works/pi-tui": path.join(process.env.PI_HOME, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
			},
		});
		const mod = jiti(path.join(__dirname, "..", "trajectory-web", "index.ts"));
		mod.default({ registerCommand: (name, def) => (commands[name] = def) });
		const trail = commands["deepseek-trail"];
		check("注册单一命令 /deepseek-trail", typeof trail?.handler === "function" && typeof trail?.getArgumentCompletions === "function");
		check("不再注册裸 /start 与 /stop", !commands.start && !commands.stop);
		check("子命令补全 start/stop", trail.getArgumentCompletions("")?.map((c) => c.value).join(",") === "start,stop");

		// ---- 仓库根聚合入口（pi -e . 依赖） ----
		const aggregateCommands = {};
		const aggregate = jiti(path.join(__dirname, "..", "index.ts"));
		aggregate.default({ registerCommand: (name, def) => (aggregateCommands[name] = def) });
		check(
			"根 index.ts 聚合注册 /questions 与 /deepseek-trail",
			["questions", "deepseek-trail"].every((n) => typeof aggregateCommands[n]?.handler === "function"),
			Object.keys(aggregateCommands).join(","),
		);

		const notices = [];
		const ctxFor = (session) => ({
			hasUI: true,
			ui: { notify: (message, type) => notices.push({ message, type }) },
			sessionManager: { getSessionFile: () => session },
		});
		const lastNotice = () => notices[notices.length - 1];

		// ---- 子命令解析 ----
		await trail.handler("", ctxFor(sessionFile));
		check("空参数提示用法", lastNotice().type === "info" && /用法：\/deepseek-trail start/.test(lastNotice().message), lastNotice().message);
		await trail.handler("bogus", ctxFor(sessionFile));
		check("未知子命令提示用法", lastNotice().type === "warning" && /未知子命令/.test(lastNotice().message), lastNotice().message);

		// ---- start ----
		await trail.handler("start", ctxFor(sessionFile));
		const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
		pid = state.pid;
		check("start 提示 URL", /已启动：http:\/\/127\.0\.0\.1:\d+\//.test(lastNotice().message), lastNotice().message);
		check("state 指向当前会话", state.session === sessionFile && state.port > 0);
		const health = await (await fetch(`http://127.0.0.1:${state.port}/api/health`)).json();
		check("服务真实可访问", health.ok === true && health.pid === state.pid);

		// ---- 幂等 ----
		await trail.handler("start", ctxFor(sessionFile));
		check("重复 start 只提示已在运行", /已在运行/.test(lastNotice().message), lastNotice().message);
		const state2 = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
		check("重复 start 不新起进程", state2.pid === state.pid);

		// ---- 非法端口 ----
		await trail.handler("start 22", ctxFor(sessionFile));
		check("非法端口被拒", lastNotice().type === "warning" && /端口非法/.test(lastNotice().message));

		// ---- 另一会话 ----
		await trail.handler("start", ctxFor(sessionFileB));
		check("观察其它会话时给出提示", lastNotice().type === "warning" && /另一个会话/.test(lastNotice().message), lastNotice().message);

		// ---- stop ----
		await trail.handler("stop", ctxFor(sessionFile));
		check("stop 提示已停止", /已停止/.test(lastNotice().message), lastNotice().message);
		check("state 文件被清理", !fs.existsSync(STATE_FILE));
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		check("服务进程已退出", !alive);
		pid = null;

		// ---- 重复 stop ----
		await trail.handler("stop", ctxFor(sessionFile));
		check("重复 stop 提示未在运行", /未在运行/.test(lastNotice().message), lastNotice().message);

		// ---- stop 清理已死进程的残留状态 ----
		fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
		fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: 999999, port: 1, host: "127.0.0.1", session: sessionFile, startedAt: "", url: "" }));
		await trail.handler("stop", ctxFor(sessionFile));
		check("残留状态被清理", !fs.existsSync(STATE_FILE) && /已清理残留状态文件/.test(lastNotice().message), lastNotice().message);
	} catch (err) {
		check("测试执行", false, err.stack);
	} finally {
		if (pid) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* 已退出 */
			}
		}
		fs.rmSync(tmpHome, { recursive: true, force: true });
		console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
		process.exit(failed === 0 ? 0 : 1);
	}
})();
