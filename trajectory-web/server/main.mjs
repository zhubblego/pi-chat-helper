#!/usr/bin/env node
/**
 * main.mjs — 轨迹观察服务的独立启动入口（模式 B：观察全部 pi 历史与运行中的会话）。
 *
 * 常用：
 *   npm run dev                                   # 全局范围，默认端口 7788
 *   node trajectory-web/server/main.mjs --scope project --session <会话文件>
 *
 * 参数：
 *   --scope all|project    默认 all；project 范围需 --session
 *   --session <file>       all 范围下作为默认选中会话
 *   --sessions-root <dir>  会话根目录，默认 ~/.pi/agent/sessions
 *   --port <n>             默认 7788；0 = 随机端口
 *   --host <addr>          默认 127.0.0.1
 *   --web <dir>            静态资源目录，默认 ../web
 *   --agent-dir <dir>      pi agent 目录（工具归属静态扫描），默认 ~/.pi/agent
 *   --pi-dir <dir>         pi 安装目录（扫描内置工具名）
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTrajectoryServer } from "./app.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const out = {
		scope: "all",
		session: undefined,
		sessionsRoot: undefined,
		port: 7788,
		host: "127.0.0.1",
		web: join(HERE, "..", "web"),
		agentDir: undefined,
		piDir: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => argv[++i];
		switch (arg) {
			case "--scope":
				out.scope = next();
				break;
			case "--session":
				out.session = next();
				break;
			case "--sessions-root":
				out.sessionsRoot = next();
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
			case "--agent-dir":
				out.agentDir = next();
				break;
			case "--pi-dir":
				out.piDir = next();
				break;
			default:
				break;
		}
	}
	if (out.scope !== "all" && out.scope !== "project") {
		throw new Error(`非法 --scope：${out.scope}（可选 all、project）`);
	}
	if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) {
		throw new Error(`非法端口：${out.port}`);
	}
	out.web = resolve(out.web);
	if (out.session) out.session = resolve(out.session);
	return out;
}

let options;
try {
	options = parseArgs(process.argv.slice(2));
} catch (err) {
	process.stderr.write(`${err.message}\n`);
	process.exit(2);
}

createTrajectoryServer({
	scope: options.scope,
	sessionFile: options.session,
	sessionsRoot: options.sessionsRoot,
	webDir: options.web,
	host: options.host,
	port: options.port,
	agentDir: options.agentDir,
	piDir: options.piDir,
	log: (message) => process.stderr.write(`${message}\n`),
})
	.then((handle) => {
		process.stdout.write(`轨迹观察服务已启动：${handle.url}（范围：${options.scope}）\n`);
		const shutdown = () => {
			handle.close().then(() => process.exit(0));
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	})
	.catch((err) => {
		process.stderr.write(`轨迹观察服务启动失败：${err.message}\n`);
		process.exit(1);
	});
