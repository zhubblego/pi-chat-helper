// HTTP 服务：多会话列表 / 指定会话投影 / 增量轮询 / 事件详情 / 双范围 / 热更新 / 退出
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, cond ? "" : extra);
	if (!cond) failed++;
};

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "trajectory-web", "server", "main.mjs");
const WEB = path.join(ROOT, "trajectory-web", "web");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 原始 HTTP 请求：测试 Host/Origin/OPTIONS 等 fetch 不方便设置的头。 */
function rawRequest(baseUrl, { method = "GET", pathname = "/", headers = {}, body = null } = {}) {
	const target = new URL(baseUrl);
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: target.hostname,
				port: target.port,
				method,
				path: pathname,
				headers: { host: `${target.hostname}:${target.port}`, ...headers },
			},
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () =>
					resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }),
				);
			},
		);
		req.on("error", reject);
		req.end(body ?? undefined);
	});
}

/** 读完一条 SSE 流，按事件块解析成 {event,data} 数组（原始文本保留给保活断言）。 */
async function readSse(response, onEvent = null) {
	if (!response.body) throw new Error("响应没有可读流");
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	let raw = "";
	const events = [];
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		const text = decoder.decode(value, { stream: true });
		raw += text;
		buffer += text;
		let index;
		while ((index = buffer.indexOf("\n\n")) >= 0) {
			const block = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			let event = "message";
			const data = [];
			for (const line of block.split("\n")) {
				if (line.startsWith("event:")) event = line.slice(6).trim();
				else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
			}
			if (data.length) {
				const parsed = { event, data: JSON.parse(data.join("\n")) };
				events.push(parsed);
				if (onEvent) await onEvent(parsed);
			}
		}
	}
	return { events, raw };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-srv-"));
const sessionsRoot = path.join(tmp, "sessions");
const projA = path.join(sessionsRoot, "--a--");
const projB = path.join(sessionsRoot, "--b--");
fs.mkdirSync(projA, { recursive: true });
fs.mkdirSync(projB, { recursive: true });

const H = "2026-01-01T00:00:00.000Z";
const line = (o) => JSON.stringify(o);
function writeSession(dir, { id, cwd, first, mtimeMs }) {
	const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	fs.writeFileSync(
		file,
		[
			line({ type: "session", version: 3, id, timestamp: H, cwd }),
			line({ type: "message", id: "u1", parentId: null, timestamp: H, message: { role: "user", content: first, timestamp: 1000 } }),
			line({
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: H,
				message: {
					role: "assistant",
					model: "m",
					usage: { input: 1, output: 2, totalTokens: 3 },
					durationMs: 100,
					content: [{ type: "thinking", thinking: "思考" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } }],
				},
			}),
			line({ type: "message", id: "r1", parentId: "a1", timestamp: H, message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "结果" }], isError: false } }),
			line({ type: "message", id: "a2", parentId: "r1", timestamp: H, message: { role: "assistant", content: [{ type: "text", text: "答复" }] } }),
		].join("\n") + "\n",
	);
	const seconds = (mtimeMs ?? Date.now()) / 1000;
	fs.utimesSync(file, seconds, seconds);
	return file;
}

function waitForUrl(child) {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => reject(new Error("等待启动 URL 超时")), 8000);
		child.stdout.on("data", (d) => {
			buf += String(d);
			const m = /http:\/\/127\.0\.0\.1:\d+/.exec(buf);
			if (m) {
				clearTimeout(timer);
				resolve(m[0]);
			}
		});
		child.stderr.on("data", (d) => {
			buf += String(d);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`服务提前退出 code=${code}：${buf}`));
		});
	});
}

function startServer(args) {
	const child = spawn(process.execPath, [SERVER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
	return child;
}

async function stopServer(child) {
	child.kill("SIGTERM");
	const deadline = Date.now() + 4000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) return true;
		await sleep(100);
	}
	child.kill("SIGKILL");
	return false;
}

(async () => {
	let all = null;
	let project = null;
	try {
		const recent = Date.now();
		const old = recent - 3600_000;
		const a1 = writeSession(projA, { id: "srv-a1", cwd: "/tmp/projA", first: "第一问", mtimeMs: recent });
		const aOld = writeSession(projA, { id: "srv-a2", cwd: "/tmp/projA", first: "旧问", mtimeMs: old });
		writeSession(projB, { id: "srv-b1", cwd: "/tmp/projB", first: "B 问", mtimeMs: recent - 120_000 });

		// ---- 模式 B：全部范围 ----
		// codex 源 fixture：年/月/日三层 + rollout 文件
		const codexRoot = path.join(tmp, "codex");
		const codexDay = path.join(codexRoot, "2026", "01", "01");
		fs.mkdirSync(codexDay, { recursive: true });
		fs.writeFileSync(
			path.join(codexDay, "rollout-2026-01-01T00-00-00-019f592a-0d06-7e41-b3bc-df1f510cdbbd.jsonl"),
			[
				JSON.stringify({ timestamp: "2026-01-01T00:00:00.100Z", type: "session_meta", payload: { id: "cx-a1", cwd: "/tmp/projC" } }),
				JSON.stringify({ timestamp: "2026-01-01T00:00:00.400Z", type: "response_item", payload: { type: "message", id: "msg_u1", role: "user", content: [{ type: "input_text", text: "codex 第一问" }] } }),
				JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "response_item", payload: { type: "message", id: "msg_a1", role: "assistant", content: [{ type: "output_text", text: "codex 回答" }] } }),
			].join("\n"),
		);
		all = startServer(["--scope", "all", "--sessions-root", sessionsRoot, "--codex-root", codexRoot, "--agent-dir", path.join(tmp, "agent"), "--port", "0", "--web", WEB]);
		const base = await waitForUrl(all);

		const health = await (await fetch(`${base}/api/health`)).json();
		check("health：scope=all", health.ok === true && health.scope === "all", JSON.stringify(health));

		const listing = await (await fetch(`${base}/api/sessions`)).json();
		check("列表包含全部项目会话", listing.sessions.length === 3, String(listing.sessions.length));
		check("列表按最近活跃倒序", listing.sessions[0].id === "srv-a1", listing.sessions.map((s) => s.id).join(","));
		check("live 标记", listing.sessions.find((s) => s.id === "srv-a1").live === true && listing.sessions.find((s) => s.id === "srv-a2").live === false);
		check("项目路径与首条消息", listing.sessions[0].projectPath === "/tmp/projA" && listing.sessions[0].firstMessage === "第一问");
		check("current 指向最近会话", listing.current === "srv-a1");

		const first = await (await fetch(`${base}/api/session`)).json();
		check("默认取最近会话", first.changed === true && first.sessionId === "srv-a1" && first.meta.cwd === "/tmp/projA");
		check("问题分组", first.questions.length === 1 && first.questions[0].summary === "第一问");
		check("事件链", first.questions[0].events.map((e) => e.kind).join(",") === "user,thinking,tool,answer", first.questions[0].events.map((e) => e.kind).join(","));

		const second = await (await fetch(`${base}/api/session?id=srv-a1&v=${encodeURIComponent(first.etag)}`)).json();
		check("etag 未变 changed=false", second.changed === false);

		const other = await (await fetch(`${base}/api/session?id=srv-b1`)).json();
		check("按 id 取指定会话", other.changed === true && other.sessionId === "srv-b1" && other.meta.cwd === "/tmp/projB");

		const toolEvent = first.questions[0].events.find((e) => e.kind === "tool");
		const detail = await (await fetch(`${base}/api/event?session=srv-a1&id=${encodeURIComponent(toolEvent.id)}`)).json();
		check("事件详情（full）", detail.event.tool.name === "read" && detail.event.tool.result === "结果");
		check("未知会话 404", (await fetch(`${base}/api/session?id=nope`)).status === 404);

		// 翻译转发接口：只验参数校验（真实外呼靠手动冒烟，避免测试依赖网络）
		const trPost = (body) => fetch(`${base}/api/translate`, { method: "POST", headers: { "content-type": "application/json" }, body });
		check("translate 非法 JSON 400", (await trPost("{")).status === 400);
		check("translate 缺 q 400", (await trPost(JSON.stringify({ to: "zh-CN" }))).status === 400);
		check("translate 非法语言 400", (await trPost(JSON.stringify({ q: ["hi"], to: "xx" }))).status === 400);
		check("translate 非法服务 400", (await trPost(JSON.stringify({ q: ["hi"], to: "zh-CN", service: "deepl" }))).status === 400);
		check("translate 空数组 400", (await trPost(JSON.stringify({ q: [], to: "zh-CN" }))).status === 400);
		check("translate 超长段 400", (await trPost(JSON.stringify({ q: ["x".repeat(20001)], to: "zh-CN" }))).status === 400);
		check("未知 POST 路径 405", (await fetch(`${base}/api/nothing`, { method: "POST" })).status === 405);

		// context-edit 端点：无 handler 501（本 server 未注入 onContextEdit）
		const cePost = (body) => fetch(`${base}/api/context-edit`, { method: "POST", headers: { "content-type": "application/json" }, body });
		check("context-edit 无 handler 501", (await cePost(JSON.stringify({ qIndex: 0, hidden: true }))).status === 501);

		// 轨迹源：/api/sources 列出 + source 参数白名单
		const sources = await (await fetch(`${base}/api/sources`)).json();
		check("源列表含 pi", Array.isArray(sources.sources) && sources.sources.some((s) => s.id === "pi" && s.sessions >= 2), JSON.stringify(sources));
		check("源列表含 codex（存在才显示）", sources.sources.some((s) => s.id === "codex" && s.sessions === 1));
		check("sessions 带 source 200", (await fetch(`${base}/api/sessions?source=pi`)).status === 200);
		check("sessions 非法 source 400", (await fetch(`${base}/api/sessions?source=claude`)).status === 400);
		check("session 非法 source 400", (await fetch(`${base}/api/session?id=srv-a1&source=xx`)).status === 400);

		// codex 源：列表 + 投影 + current 不串源
		const cxList = await (await fetch(`${base}/api/sessions?source=codex`)).json();
		check("codex 列表 1 会话", cxList.sessions?.length === 1 && cxList.sessions[0].id === "cx-a1", JSON.stringify(cxList).slice(0, 140));
		check("codex current 取自身首个", cxList.current === "cx-a1");
		const cxProj = await (await fetch(`${base}/api/session?source=codex&id=cx-a1`)).json();
		const cxKinds = (cxProj.questions ?? []).flatMap((q) => q.events.map((e) => e.kind)).join(",");
		check("codex 投影 user/answer", cxProj.changed === true && cxKinds === "user,answer", cxKinds);

		for (const file of ["/", "/app.js", "/lib.js", "/style.css", "/tokens.css"]) {
			check(`静态资源 ${file}`, (await fetch(base + file)).status === 200);
		}

		const origins = await (await fetch(`${base}/api/tool-origins`)).json();
		check("工具归属接口（静态扫描）", origins.source === "scan" && origins.tools?.read?.kind === "builtin", JSON.stringify(origins).slice(0, 140));

		// 追加新条目 → 热更新
		fs.appendFileSync(a1, line({ type: "message", id: "u2", parentId: "a2", timestamp: H, message: { role: "user", content: "追问", timestamp: 2000 } }) + "\n");
		let changed = null;
		const hotDeadline = Date.now() + 4000;
		while (Date.now() < hotDeadline) {
			await sleep(150);
			const res = await (await fetch(`${base}/api/session?id=srv-a1&v=${encodeURIComponent(first.etag)}`)).json();
			if (res.changed === true) {
				changed = res;
				break;
			}
		}
		check("追加条目后 etag 变化", !!changed && changed.questions.length === 2 && changed.questions[1].summary === "追问");

		check("SIGTERM 退出", await stopServer(all));
		all = null;

		// ---- 模式 A：项目范围 ----
		project = startServer(["--scope", "project", "--session", aOld, "--port", "0", "--web", WEB]);
		const baseA = await waitForUrl(project);
		const listingA = await (await fetch(`${baseA}/api/sessions`)).json();
		check("项目范围只列本项目", listingA.scope === "project" && listingA.sessions.length === 2 && listingA.sessions.every((s) => s.projectPath === "/tmp/projA"), JSON.stringify(listingA.sessions.map((s) => s.id)));
		check("项目范围 current 指向启动会话", listingA.current === "srv-a2", String(listingA.current));
		// 模式 A 只开放 pi 源：不列 codex，显式请求也 400（UI 与 API 一致）
		const sourcesA = await (await fetch(`${baseA}/api/sources`)).json();
		check("项目范围只列 pi 源", sourcesA.sources.length === 1 && sourcesA.sources[0].id === "pi", JSON.stringify(sourcesA));
		check("项目范围 codex 源 400", (await fetch(`${baseA}/api/sessions?source=codex`)).status === 400);
		const defA = await (await fetch(`${baseA}/api/session`)).json();
		check("默认选中启动时传入的会话", defA.sessionId === "srv-a2", String(defA.sessionId));
		check("项目范围退出", await stopServer(project));
		project = null;

		// ---- 模式 A + sources 白名单：放开 codex 源，按 project-path（真实 cwd）过滤 ----
		project = startServer([
			"--scope", "project", "--session", aOld,
			"--sources", "pi,codex",
			"--project-path", "/tmp/projC",
			"--codex-root", codexRoot,
			"--port", "0", "--web", WEB,
		]);
		const baseC = await waitForUrl(project);
		const healthC = await (await fetch(`${baseC}/api/health`)).json();
		check("项目范围 + sources 放开 codex", healthC.scope === "project" && healthC.sources?.join(",") === "pi,codex", JSON.stringify(healthC.sources));
		const cxListC = await (await fetch(`${baseC}/api/sessions?source=codex`)).json();
		check("codex 按 project-path 过滤命中", cxListC.sessions?.length === 1 && cxListC.sessions[0].id === "cx-a1", JSON.stringify(cxListC).slice(0, 160));
		check("pi 源仍限本项目", (await (await fetch(`${baseC}/api/sessions?source=pi`)).json()).sessions?.length === 2);
		check("项目范围 + sources 退出", await stopServer(project));
		project = null;

		// project-path 不匹配时 codex 列表为空（证明过滤用的是 cwd 而不是会话目录）
		project = startServer([
			"--scope", "project", "--session", aOld,
			"--sources", "pi,codex",
			"--project-path", "/tmp/projZ",
			"--codex-root", codexRoot,
			"--port", "0", "--web", WEB,
		]);
		const baseZ = await waitForUrl(project);
		check("project-path 不匹配时 codex 空列表", (await (await fetch(`${baseZ}/api/sessions?source=codex`)).json()).sessions?.length === 0);
		check("project-path 不匹配退出", await stopServer(project));
		project = null;

		// ---- T3：对话 SSE（进程内，fake child） ----
		const { createTrajectoryServer } = await import(pathToFileURL(path.join(ROOT, "trajectory-web", "server", "app.mjs")).href);
		const FAKE = path.join(__dirname, "fixtures", "fake-pi.cjs");
		const chatSessions = path.join(tmp, "chat-sessions");
		const chatProject = path.join(tmp, "chat-project");
		const otherProject = path.join(tmp, "chat-project-2");
		fs.mkdirSync(chatProject, { recursive: true });
		fs.mkdirSync(otherProject, { recursive: true });
		for (const dir of [path.join(chatSessions, "--c1--"), path.join(chatSessions, "--c2--")]) fs.mkdirSync(dir, { recursive: true });
		writeSession(path.join(chatSessions, "--c1--"), { id: "cs-1", cwd: chatProject, first: "对话一" });
		writeSession(path.join(chatSessions, "--c1--"), { id: "cs-2", cwd: chatProject, first: "对话二" });
		writeSession(path.join(chatSessions, "--c2--"), { id: "cs-3", cwd: otherProject, first: "对话三" });
		writeSession(path.join(chatSessions, "--c2--"), { id: "cs-4", cwd: otherProject, first: "对话四" });
		writeSession(path.join(chatSessions, "--c2--"), { id: "cs-5", cwd: otherProject, first: "对话五" });

		// 技能夹具：demo（仅手动）/ big（33k）/ huge（200001）
		const skillRoot = path.join(tmp, "chat-skill-fixtures");
		const writeSkill = (name, content) => {
			const dir = path.join(skillRoot, name);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "SKILL.md"), content);
		};
		writeSkill("demo", "---\nname: demo\ndescription: demo skill\ndisable-model-invocation: true\n---\n\n# Demo\n短技能。\n");
		writeSkill("big", `---\nname: big\ndescription: big skill\n---\n\n${"x".repeat(33000)}`);
		writeSkill("huge", `---\nname: huge\ndescription: huge skill\n---\n\n${"x".repeat(200001)}`);
		process.env.FAKE_PI_SKILL_DIR = skillRoot;
		fs.mkdirSync(path.join(otherProject, ".pi", "skills"), { recursive: true });
		fs.mkdirSync(path.join(otherProject, ".agents", "skills"), { recursive: true });

		// 线程文件（模型 current 从文件读；不依赖 fake child 写盘）
		const chatDir = path.join(tmp, "chat-srv-dir");
		const writeModelThread = (session, id, provider, modelId) => {
			const file = path.join(chatDir, "pi", session, "sessions", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				[
					JSON.stringify({ type: "session", version: 3, id, timestamp: H, cwd: chatProject }),
					JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: H, provider, modelId }),
				].join("\n") + "\n",
			);
		};
		writeModelThread("cs-2", "thread-c2", "other", "fake-2");
		writeModelThread("cs-3", "thread-c3", "fake", "fake-1");

		// 带 1 条 user 事件的线程（用于校验 ordinal 从投影数、refresh 保留 --session）
		const writeUserThread = (session, id) => {
			const file = path.join(chatDir, "pi", session, "sessions", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				[
					JSON.stringify({ type: "session", version: 3, id, timestamp: H, cwd: otherProject }),
					JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: H, provider: "fake", modelId: "fake-1" }),
					JSON.stringify({ type: "message", id: "u1", parentId: "m1", timestamp: H, message: { role: "user", content: [{ type: "text", text: "旧问题" }], timestamp: 1 } }),
				].join("\n") + "\n",
			);
		};
		writeUserThread("cs-4", "thread-s4");
		writeUserThread("cs-4", "thread-ord");

		const chatTrace = path.join(tmp, "chat-pi-trace.log");
		const modelsFailFile = path.join(tmp, "models-fail.flag");
		const commandsFailFile = path.join(tmp, "commands-fail.flag");
		process.env.FAKE_PI_TRACE = chatTrace;
		process.env.FAKE_PI_MODELS_FAIL = modelsFailFile;
		process.env.FAKE_PI_COMMANDS_FAIL = commandsFailFile;
		fs.rmSync(modelsFailFile, { force: true });
		fs.rmSync(commandsFailFile, { force: true });

		const chatServer = await createTrajectoryServer({
			scope: "all",
			webDir: WEB,
			sessionsRoot: chatSessions,
			codexRoot: path.join(tmp, "no-codex"),
			port: 0,
			chat: true,
			chatDir,
			piBin: { cmd: process.execPath, argsPrefix: [FAKE], mode: false, display: "fake-pi" },
			chatPingMs: 25,
		});
		const chatBase = chatServer.url;
		const send = (session, prompt, extra = {}) =>
			fetch(`${chatBase}api/chat/send`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: "pi", session, prompt, ...extra }),
			});
		const postJson = (url, body) =>
			fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

		// ---- T9：Host / Origin / Content-Type / 大小 / 路径 ----
		const chatPort = new URL(chatBase).port;
		const chatOrigin = new URL(chatBase).origin;
		const securityTraceStart = fs.existsSync(chatTrace) ? fs.readFileSync(chatTrace, "utf8") : "";
		const securityTraceNow = () => (fs.existsSync(chatTrace) ? fs.readFileSync(chatTrace, "utf8") : "");
		const secCurl = await rawRequest(chatBase, { pathname: "/api/chat/capabilities" });
		check("安全：无 Origin 的 curl 200", secCurl.status === 200, String(secCurl.status));
		const secOrigin = await rawRequest(chatBase, { pathname: "/api/chat/capabilities", headers: { origin: chatOrigin } });
		check("安全：同源 Origin 200", secOrigin.status === 200, String(secOrigin.status));
		const secCrossLoopback = await rawRequest(chatBase, {
			pathname: "/api/chat/capabilities",
			headers: { origin: `http://localhost:${chatPort}` },
		});
		check("安全：localhost/127.0.0.1 互通 Origin 200", secCrossLoopback.status === 200, String(secCrossLoopback.status));
		const secBadOrigin = await rawRequest(chatBase, {
			pathname: "/api/chat/models?source=pi&session=cs-1",
			headers: { origin: `http://evil.example:${chatPort}` },
		});
		check("安全：错误 Origin 403", secBadOrigin.status === 403 && !secBadOrigin.headers["access-control-allow-origin"], String(secBadOrigin.status));
		const secNullOrigin = await rawRequest(chatBase, {
			pathname: "/api/chat/models?source=pi&session=cs-1",
			headers: { origin: "null" },
		});
		check("安全：Origin null 403", secNullOrigin.status === 403, String(secNullOrigin.status));
		const secPortMismatch = await rawRequest(chatBase, {
			pathname: "/api/chat/models?source=pi&session=cs-1",
			headers: { origin: `http://127.0.0.1:${Number(chatPort) === 65535 ? 1 : Number(chatPort) + 1}` },
		});
		check("安全：Origin 端口不一致 403", secPortMismatch.status === 403, String(secPortMismatch.status));
		const secEvilHost = await rawRequest(chatBase, {
			pathname: "/api/chat/models?source=pi&session=cs-1",
			headers: { host: "evil.example" },
		});
		check("安全：evil Host 403", secEvilHost.status === 403, String(secEvilHost.status));
		const secOptions = await rawRequest(chatBase, { method: "OPTIONS", pathname: "/api/chat/send" });
		check(
			"安全：OPTIONS 405 且无 CORS 头",
			secOptions.status === 405 && !secOptions.headers["access-control-allow-origin"] && !secOptions.headers["access-control-allow-methods"],
			String(secOptions.status),
		);
		const sendJsonBody = JSON.stringify({ source: "pi", session: "cs-1", prompt: "x" });
		const secText = await rawRequest(chatBase, {
			method: "POST",
			pathname: "/api/chat/send",
			headers: { "content-type": "text/plain" },
			body: sendJsonBody,
		});
		check("安全：text/plain 403", secText.status === 403, String(secText.status));
		const secMissingType = await rawRequest(chatBase, {
			method: "POST",
			pathname: "/api/chat/send",
			body: sendJsonBody,
		});
		check("安全：缺 Content-Type 403", secMissingType.status === 403, String(secMissingType.status));
		const secTranslateOrigin = await rawRequest(chatBase, {
			method: "POST",
			pathname: "/api/translate",
			headers: { "content-type": "application/json", origin: "http://evil.example" },
			body: "{}",
		});
		check("安全：非 chat POST 也校验 Origin", secTranslateOrigin.status === 403, String(secTranslateOrigin.status));
		const secCharset = await rawRequest(chatBase, {
			method: "POST",
			pathname: "/api/chat/stop",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({ source: "pi", session: "cs-1" }),
		});
		check("安全：application/json 带 charset 允许", secCharset.status === 200, String(secCharset.status));
		const secBig = await rawRequest(chatBase, {
			method: "POST",
			pathname: "/api/chat/send",
			headers: { "content-type": "application/json" },
			body: "x".repeat((1 << 20) + 16),
		});
		check("安全：请求体 >1MB 413", secBig.status === 413, String(secBig.status));
		const secBigTranslate = await rawRequest(chatBase, {
			method: "POST",
			pathname: "/api/translate",
			headers: { "content-type": "application/json" },
			body: "x".repeat((1 << 20) + 16),
		});
		check("安全：非 chat POST 请求体 >1MB 也 413", secBigTranslate.status === 413, String(secBigTranslate.status));
		const securityTrace = securityTraceNow().slice(securityTraceStart.length);
		check("安全：拒绝请求未 spawn chat child", !securityTrace.includes("--mode rpc"), securityTrace.slice(-400));
		const longError = await rawRequest(chatBase, {
			method: "POST",
			pathname: "/api/chat/model",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "pi", session: "cs-1", provider: "p".repeat(600), id: "x" }),
		});
		const longErrorBody = JSON.parse(longError.body);
		check(
			"安全：错误 JSON 截断 500",
			longError.status === 400 && typeof longErrorBody.error === "string" && longErrorBody.error.length <= 500,
			`${longError.status} len=${longErrorBody.error?.length}`,
		);

		// 大线程：stat 前置拒绝，不解析 32MB 文件。
		writeSession(path.join(chatSessions, "--c1--"), { id: "cs-large", cwd: chatProject, first: "大线程" });
		const largeThreadId = "thread-large";
		const largeThreadFile = path.join(chatDir, "pi", "cs-large", "sessions", `2026-01-01T00-00-00-000Z_${largeThreadId}.jsonl`);
		fs.mkdirSync(path.dirname(largeThreadFile), { recursive: true });
		fs.writeFileSync(largeThreadFile, `${JSON.stringify({ type: "session", version: 3, id: largeThreadId, timestamp: H, cwd: chatProject })}\n`);
		fs.truncateSync(largeThreadFile, 32 * 1024 * 1024 + 1);
		const largeThread = await rawRequest(chatBase, {
			pathname: `/api/chat/thread?source=pi&session=cs-large&thread=${largeThreadId}`,
		});
		check("安全：线程文件 >32MB 400", largeThread.status === 400, String(largeThread.status));
		const largeModelsBefore = securityTraceNow().length;
		const largeModels = await rawRequest(chatBase, {
			pathname: `/api/chat/models?source=pi&session=cs-large&thread=${largeThreadId}`,
		});
		check(
			"安全：大线程 models 400 且未 spawn",
			largeModels.status === 400 && !securityTraceNow().slice(largeModelsBefore).includes("--mode rpc"),
			String(largeModels.status),
		);
		const largeSendBefore = securityTraceNow().length;
		const largeSend = await rawRequest(chatBase, {
			method: "POST",
			pathname: "/api/chat/send",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "pi", session: "cs-large", threadId: largeThreadId, prompt: "x" }),
		});
		check(
			"安全：大线程 send 400 且未 spawn",
			largeSend.status === 400 && !securityTraceNow().slice(largeSendBefore).includes("--mode rpc"),
			String(largeSend.status),
		);
		const traversal = await rawRequest(chatBase, {
			pathname: "/api/chat/thread?source=pi&session=cs-large&thread=..%2Fevil",
		});
		check("安全：threadId 路径穿越 400", traversal.status === 400, String(traversal.status));

		// chatDir 位于轨迹目录下 / 非回环监听：对话禁用。
		const insideChat = await createTrajectoryServer({
			scope: "all",
			webDir: WEB,
			sessionsRoot: chatSessions,
			port: 0,
			chat: true,
			chatDir: path.join(chatSessions, "inside-chat"),
			piBin: { cmd: process.execPath, argsPrefix: [FAKE], mode: false, display: "fake-pi" },
		});
		const insideCap = await (await fetch(`${insideChat.url}api/chat/capabilities`)).json();
		check("安全：chatDir 在 sessions 下禁用", insideCap.enabled === false, JSON.stringify(insideCap).slice(0, 300));
		await insideChat.close();
		const nonLoop = await createTrajectoryServer({
			scope: "all",
			webDir: WEB,
			sessionsRoot: chatSessions,
			host: "0.0.0.0",
			port: 0,
			chat: true,
			chatDir: path.join(tmp, "nonloop-chat"),
			piBin: { cmd: process.execPath, argsPrefix: [FAKE], mode: false, display: "fake-pi" },
		});
		const nonLoopCap = await (await fetch(`http://127.0.0.1:${nonLoop.port}/api/chat/capabilities`)).json();
		check(
			"安全：非回环监听时 chat 禁用",
			nonLoopCap.enabled === false && String(nonLoopCap.reason).includes("非回环"),
			JSON.stringify(nonLoopCap).slice(0, 300),
		);
		await nonLoop.close();

		// 轨迹文件 >32MB：send 带上下文时在 spawn 前 400。
		const largeTrajSessions = path.join(tmp, "t9-large-sessions");
		const largeTrajProject = path.join(tmp, "t9-large-project");
		fs.mkdirSync(path.join(largeTrajSessions, "--x--"), { recursive: true });
		fs.mkdirSync(largeTrajProject, { recursive: true });
		writeSession(path.join(largeTrajSessions, "--x--"), { id: "t9-large-traj", cwd: largeTrajProject, first: "大轨迹" });
		const largeTrajFile = path.join(largeTrajSessions, "--x--", "2026-01-01T00-00-00-000Z_t9-large-traj.jsonl");
		fs.truncateSync(largeTrajFile, 32 * 1024 * 1024 + 1);
		const largeTrajServer = await createTrajectoryServer({
			scope: "all",
			webDir: WEB,
			sessionsRoot: largeTrajSessions,
			port: 0,
			chat: true,
			chatDir: path.join(tmp, "t9-large-chat"),
			piBin: { cmd: process.execPath, argsPrefix: [FAKE], mode: false, display: "fake-pi" },
		});
		const largeTrajTraceStart = securityTraceNow().length;
		const largeTrajSend = await fetch(`${largeTrajServer.url}api/chat/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "pi", session: "t9-large-traj", prompt: "x", contextIds: ["x"] }),
		});
		await largeTrajSend.text();
		check(
			"安全：轨迹文件 >32MB 400 且未 spawn",
			largeTrajSend.status === 400 && !securityTraceNow().slice(largeTrajTraceStart).includes("--mode rpc"),
			String(largeTrajSend.status),
		);
		await largeTrajServer.close();

		check("chat：静态 /chat.js 200", (await fetch(`${chatBase}chat.js`)).status === 200);
		check("chat：静态 /chat-lib.js 200", (await fetch(`${chatBase}chat-lib.js`)).status === 200);

		// ---- T4：模型列表 ----
		const modelsUrl = (session, extra = "") => `${chatBase}api/chat/models?source=pi&session=${session}${extra}`;
		const modelsPlain = await (await fetch(modelsUrl("cs-2"))).json();
		check(
			"models：列表 2 个且 current=child 模型",
			Array.isArray(modelsPlain.models) && modelsPlain.models.length === 2 && modelsPlain.current?.id === "fake-1",
			JSON.stringify(modelsPlain).slice(0, 300),
		);
		check(
			"models：字段白名单 + 无敏感字段",
			modelsPlain.models.every((m) => Object.keys(m).sort().join(",") === "contextWindow,id,maxTokens,name,provider,providerName,reasoning") &&
				!/sk-fake-secret|fake-header|fake-one\.invalid|apiKey|baseUrl|headers|oauth/.test(JSON.stringify(modelsPlain)),
			JSON.stringify(modelsPlain).slice(0, 500),
		);
		const modelsThread = await (await fetch(modelsUrl("cs-2", "&thread=thread-c2"))).json();
		check("models：带 thread 读文件模型", modelsThread.current?.provider === "other" && modelsThread.current?.id === "fake-2", JSON.stringify(modelsThread.current));
		const traceBeforeModels = fs.existsSync(chatTrace) ? fs.readFileSync(chatTrace, "utf8") : "";
		check("models：带 thread 不切 child", !traceBeforeModels.includes("switch_session:"), traceBeforeModels);

		// refresh=1 失败：保留 last-good + error
		fs.writeFileSync(modelsFailFile, "1");
		const refreshFail = await (await fetch(modelsUrl("cs-2", "&refresh=1"))).json();
		check(
			"models：refresh 失败保留 last-good",
			typeof refreshFail.error === "string" && refreshFail.error.length > 0 && refreshFail.models?.length === 2 && refreshFail.refreshedAt === modelsPlain.refreshedAt,
			JSON.stringify(refreshFail).slice(0, 300),
		);
		fs.rmSync(modelsFailFile, { force: true });
		const refreshOk = await (await fetch(modelsUrl("cs-2", "&refresh=1"))).json();
		check("models：refresh 恢复后 error=null", refreshOk.error === null && refreshOk.models?.length === 2, JSON.stringify(refreshOk).slice(0, 200));

		// ---- T4：切换模型 ----
		const postModel = (body) =>
			fetch(`${chatBase}api/chat/model`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: "pi", ...body }),
			});
		const okModelRes = await postModel({ session: "cs-3", provider: "other", id: "fake-2" });
		const okModel = await okModelRes.json();
		check("POST model：成功且脱敏", okModelRes.ok && okModel.ok === true && okModel.model?.id === "fake-2" && !/sk-fake-secret|apiKey|baseUrl|headers|oauth/.test(JSON.stringify(okModel)), JSON.stringify(okModel).slice(0, 300));
		const currentCs3 = await (await fetch(modelsUrl("cs-3"))).json();
		check("POST model：GET current 反映新模型", currentCs3.current?.provider === "other" && currentCs3.current?.id === "fake-2", JSON.stringify(currentCs3.current));
		check("POST model：未知模型 400", (await postModel({ session: "cs-3", provider: "fake", id: "nope" })).status === 400);
		check("POST model：缺 provider 400", (await postModel({ session: "cs-3", id: "fake-1" })).status === 400);
		check("POST model：缺 id 400", (await postModel({ session: "cs-3", provider: "fake" })).status === 400);
		check("POST model：非法 threadId 400", (await postModel({ session: "cs-3", threadId: "../x", provider: "fake", id: "fake-1" })).status === 400);
		check("POST model：线程不存在 404", (await postModel({ session: "cs-3", threadId: "no-such", provider: "fake", id: "fake-1" })).status === 404);
		const traceBeforeSwitch = fs.existsSync(chatTrace) ? fs.readFileSync(chatTrace, "utf8") : "";
		const switchModelRes = await postModel({ session: "cs-3", threadId: "thread-c3", provider: "fake", id: "fake-1" });
		check("POST model：切线程成功", switchModelRes.ok, String(switchModelRes.status));
		const traceAfterSwitch = fs.readFileSync(chatTrace, "utf8").slice(traceBeforeSwitch.length);
		const switchIdx = traceAfterSwitch.indexOf("switch_session:");
		const setIdx = traceAfterSwitch.indexOf("set_model:");
		check(
			"POST model：先 switch_session 再 set_model",
			switchIdx >= 0 && setIdx > switchIdx && /thread-c3\.jsonl/.test(traceAfterSwitch.slice(switchIdx, setIdx)),
			traceAfterSwitch,
		);
		check("POST model：GET /api/chat/model 405", (await fetch(`${chatBase}api/chat/model`)).status === 405);
		check("POST model：POST /api/chat/models 405", (await postJson(`${chatBase}api/chat/models`, { source: "pi", session: "cs-3" })).status === 405);

		// ---- T5：设置读写 ----
		const settingsUrl = (session = "cs-4") => `${chatBase}api/chat/settings?source=pi&session=${session}`;
		const settingsDefault = await (await fetch(settingsUrl())).json();
		check(
			"settings：默认 read-only + projectSkills=false",
			settingsDefault.profile === "read-only" && settingsDefault.projectSkills === false && Array.isArray(settingsDefault.approvalAllow),
			JSON.stringify(settingsDefault),
		);
		check("settings：缺 source 400", (await fetch(`${chatBase}api/chat/settings?session=cs-4`)).status === 400);
		check("settings：未知 session 404", (await fetch(`${chatBase}api/chat/settings?source=pi&session=nope`)).status === 404);
		check(
			"settings：非法 profile 400",
			(await postJson(`${chatBase}api/chat/settings`, { source: "pi", session: "cs-4", profile: "bogus" })).status === 400,
		);
		check(
			"settings：projectSkills 非布尔 400",
			(await postJson(`${chatBase}api/chat/settings`, { source: "pi", session: "cs-4", projectSkills: "yes" })).status === 400,
		);
		check("settings：无可修改字段 400", (await postJson(`${chatBase}api/chat/settings`, { source: "pi", session: "cs-4" })).status === 400);
		check("settings：POST /api/chat/skills 405", (await postJson(`${chatBase}api/chat/skills`, { source: "pi", session: "cs-4" })).status === 405);

		// ---- T5：技能列表 ----
		const skillsUrl = (session = "cs-4", extra = "") => `${chatBase}api/chat/skills?source=pi&session=${session}${extra}`;
		const skillsList = await (await fetch(skillsUrl())).json();
		const skillByName = (payload, name) => payload.skills?.find((skill) => skill.name === name);
		check(
			"skills：过滤 source=skill 并去 skill: 前缀",
			Array.isArray(skillsList.skills) && skillsList.skills.length === 3 && ["demo", "big", "huge"].every((name) => skillByName(skillsList, name)),
			JSON.stringify(skillsList).slice(0, 400),
		);
		check(
			"skills：chars 按字符数、scope/sourceInfo 映射",
			skillByName(skillsList, "big")?.chars === 33042 &&
				skillByName(skillsList, "big")?.scope === "project" &&
				skillByName(skillsList, "demo")?.scope === "user" &&
				skillByName(skillsList, "demo")?.disableModelInvocation === true &&
				skillByName(skillsList, "demo")?.filePath === path.join(skillRoot, "demo", "SKILL.md"),
			JSON.stringify(skillByName(skillsList, "big")),
		);
		check("skills：projectSkills 默认 false", skillsList.projectSkills === false && skillsList.error === null, JSON.stringify(skillsList.projectSkills));
		check("skills：未知 session 404", (await fetch(skillsUrl("nope"))).status === 404);

		// refresh 失败：保留 last-good + error
		fs.writeFileSync(commandsFailFile, "1");
		const skillsRefreshFail = await (await fetch(skillsUrl("cs-4", "&refresh=1"))).json();
		check(
			"skills：refresh 失败保留 last-good 并返回 error",
			typeof skillsRefreshFail.error === "string" && skillsRefreshFail.error.length > 0 && skillsRefreshFail.skills?.length === 3,
			JSON.stringify(skillsRefreshFail).slice(0, 300),
		);
		fs.rmSync(commandsFailFile, { force: true });

		// ---- T5：项目技能开关 → spawn --skill ----
		const traceBeforeProjectSkills = fs.existsSync(chatTrace) ? fs.readFileSync(chatTrace, "utf8") : "";
		const enableProject = await postJson(`${chatBase}api/chat/settings`, { source: "pi", session: "cs-4", projectSkills: true });
		const enableBody = await enableProject.json();
		check(
			"settings：切 projectSkills 返回 restart",
			enableProject.ok && enableBody.ok === true && enableBody.projectSkills === true && enableBody.restart === true,
			JSON.stringify(enableBody),
		);
		const settingsOn = await (await fetch(settingsUrl())).json();
		check("settings：projectSkills 持久化", settingsOn.projectSkills === true, JSON.stringify(settingsOn));
		check("settings：落盘到 chatDir/settings.json", fs.existsSync(path.join(chatDir, "settings.json")));
		const skillsOn = await (await fetch(skillsUrl("cs-4", "&refresh=1"))).json();
		const traceAfterProjectSkills = fs.readFileSync(chatTrace, "utf8").slice(traceBeforeProjectSkills.length);
		check(
			"settings：projectSkills=true 时 spawn 追加两个 --skill 目录",
			traceAfterProjectSkills.includes(`--skill ${path.join(otherProject, ".pi", "skills")}`) &&
				traceAfterProjectSkills.includes(`--skill ${path.join(otherProject, ".agents", "skills")}`),
			traceAfterProjectSkills.slice(-600),
		);
		check("skills：开关后仍能取列表", Array.isArray(skillsOn.skills) && skillsOn.projectSkills === true, JSON.stringify(skillsOn).slice(0, 200));
		await postJson(`${chatBase}api/chat/settings`, { source: "pi", session: "cs-4", projectSkills: false });

		// ---- T5：refresh=1 重启保留线程（--session） ----
		await readSse(await send("cs-4", "hi", { threadId: "thread-s4" }));
		const traceBeforeSkillRefresh = fs.readFileSync(chatTrace, "utf8");
		await (await fetch(skillsUrl("cs-4", "&refresh=1"))).json();
		const traceAfterSkillRefresh = fs.readFileSync(chatTrace, "utf8").slice(traceBeforeSkillRefresh.length);
		check(
			"skills：refresh=1 重启保留线程（--session 文件）",
			traceAfterSkillRefresh.includes("spawn:") &&
				traceAfterSkillRefresh.includes(`--session ${path.join(chatDir, "pi", "cs-4", "sessions", "2026-01-01T00-00-00-000Z_thread-s4.jsonl")}`) &&
				!traceAfterSkillRefresh.includes("--session-id thread-s4"),
			traceAfterSkillRefresh.slice(-600),
		);

		// ---- T5：settings 活动 turn 409 ----
		const slowSettingsRes = await send("cs-4", "slow");
		const slowSettingsRead = readSse(slowSettingsRes);
		await sleep(120);
		const settingsConflict = await postJson(`${chatBase}api/chat/settings`, { source: "pi", session: "cs-4", projectSkills: false });
		check("settings：活动 turn 409", settingsConflict.status === 409, String(settingsConflict.status));
		await postJson(`${chatBase}api/chat/stop`, { source: "pi", session: "cs-4" });
		await slowSettingsRead;

		// ---- T5：发送技能（前缀 / meta / turns / 直输） ----
		const traceBeforeSkillSend = fs.readFileSync(chatTrace, "utf8");
		const demoSkill = await readSse(await send("cs-4", "你好", { threadId: "thread-ord", skill: "demo" }));
		const demoMeta = demoSkill.events.find((event) => event.event === "meta")?.data ?? {};
		check(
			"send skill：meta.userOrdinal 按投影 user 数（thread 只有 1 条 user）",
			demoMeta.userOrdinal === 2,
			JSON.stringify(demoMeta),
		);
		check(
			"send skill：meta.skill 含 name/chars/warning",
			demoMeta.skill?.name === "demo" && Number.isInteger(demoMeta.skill?.chars) && demoMeta.skill.warning === false,
			JSON.stringify(demoMeta.skill),
		);
		const traceAfterSkillSend = fs.readFileSync(chatTrace, "utf8").slice(traceBeforeSkillSend.length);
		check("send skill：prompt 拼 /skill:name 前缀", traceAfterSkillSend.includes('prompt:"/skill:demo\\n\\n你好"'), traceAfterSkillSend);
		const turnLines = fs
			.readFileSync(path.join(chatDir, "pi", "cs-4", "meta", "turns.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const turn2 = turnLines.find((turn) => turn.ordinal === 2);
		check(
			"send skill：turns.jsonl 写 displayText/skill/contextRefs/profile",
			turn2?.displayText === "你好" &&
				turn2?.threadId === "thread-ord" &&
				turn2?.skill?.name === "demo" &&
				Array.isArray(turn2?.contextRefs) &&
				turn2?.profile === "read-only" &&
				turn2?.model?.id === "fake-1",
			JSON.stringify(turn2),
		);
		const bigSkill = await readSse(await send("cs-4", "你好", { threadId: "thread-ord", skill: "big" }));
		const bigMeta = bigSkill.events.find((event) => event.event === "meta")?.data ?? {};
		check("send skill：>32k 仅 warning 仍发送", bigMeta.skill?.name === "big" && bigMeta.skill?.warning === true && bigMeta.skill?.chars > 32000, JSON.stringify(bigMeta.skill));
		check(
			"send skill：>200k 400",
			(await postJson(`${chatBase}api/chat/send`, { source: "pi", session: "cs-4", threadId: "thread-ord", prompt: "hi", skill: "huge" })).status === 400,
		);
		check(
			"send skill：未知技能 400",
			(await postJson(`${chatBase}api/chat/send`, { source: "pi", session: "cs-4", threadId: "thread-ord", prompt: "hi", skill: "nope" })).status === 400,
		);
		const traceBeforeDirect = fs.readFileSync(chatTrace, "utf8");
		const directSkill = await readSse(await send("cs-4", "/skill:demo 你好", { threadId: "thread-ord" }));
		const directMeta = directSkill.events.find((event) => event.event === "meta")?.data ?? {};
		const directTrace = fs.readFileSync(chatTrace, "utf8").slice(traceBeforeDirect.length);
		check(
			"直输 /skill:demo：解析 + 原样透传（只一次前缀）",
			directMeta.skill?.name === "demo" && directTrace.includes('prompt:"/skill:demo 你好"') && (directTrace.match(/\/skill:demo/g) ?? []).length === 1,
			directTrace,
		);
		const unknownDirect = await readSse(await send("cs-4", "/skill:nope 你好", { threadId: "thread-ord" }));
		const unknownDirectMeta = unknownDirect.events.find((event) => event.event === "meta")?.data ?? {};
		check(
			"直输未知技能：pi 透传（200 + 原文）",
			unknownDirectMeta.skill?.name === "nope" && unknownDirectMeta.skill?.chars === null,
			JSON.stringify(unknownDirectMeta.skill),
		);

		// ---- T6：轨迹上下文清单 / active / delta / 工具 env ----
		const lightCs1 = await (await fetch(`${chatBase}api/session?source=pi&id=cs-1`)).json();
		const ctxIds = lightCs1.questions.flatMap((q) => (q.events ?? []).map((e) => e.id));
		const [ctxA, ctxB] = ctxIds;
		const ctxMetaDir = path.join(chatDir, "pi", "cs-1", "meta");
		const ctxActivePath = path.join(ctxMetaDir, "context.active.json");
		const traceLen = () => (fs.existsSync(chatTrace) ? fs.readFileSync(chatTrace, "utf8").length : 0);
		const traceSince = (len) => (fs.existsSync(chatTrace) ? fs.readFileSync(chatTrace, "utf8").slice(len) : "");
		const promptOf = (traceText) => {
			const line = traceText.split("\n").find((item) => item.startsWith("prompt:"));
			if (!line) return "";
			try {
				return JSON.parse(line.slice("prompt:".length));
			} catch {
				return "";
			}
		};
		const traceBeforeCtx = traceLen();
		const ctxFirst = await readSse(await send("cs-1", "先看两条", { contextIds: [ctxA, ctxB] }));
		const ctxMeta = ctxFirst.events.find((event) => event.event === "meta")?.data ?? {};
		check(
			"context：meta.context 首次清单",
			ctxMeta.context?.selected === 2 &&
				ctxMeta.context?.included?.join(",") === [ctxA, ctxB].join(",") &&
				ctxMeta.context?.dropped?.length === 0 &&
				ctxMeta.context?.added?.length === 2 &&
				ctxMeta.context?.removed?.length === 0,
			JSON.stringify(ctxMeta.context),
		);
		const traceCtx = traceSince(traceBeforeCtx);
		const firstPrompt = promptOf(traceCtx);
		check(
			"context：prompt 含完整 <trajectory_index>",
			firstPrompt.includes(`<trajectory_index source="pi" session="cs-1" count="2">`) && firstPrompt.includes(`[${ctxA}]`) && firstPrompt.includes(`[${ctxB}]`),
			firstPrompt.slice(0, 600),
		);
		const activeFirst = JSON.parse(fs.readFileSync(ctxActivePath, "utf8"));
		check(
			"context：active 快照写 source/session/items",
			activeFirst.source === "pi" && activeFirst.sessionId === "cs-1" && activeFirst.items?.length === 2,
			JSON.stringify(activeFirst).slice(0, 300),
		);
		const turnsAfterCtx = fs
			.readFileSync(path.join(ctxMetaDir, "turns.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const ctxTurn = turnsAfterCtx.filter((turn) => turn.threadId === "fake-session-1").sort((a, b) => a.ordinal - b.ordinal).at(-1);
		check(
			"context：turns.contextRefs 写入 items",
			ctxTurn?.contextRefs?.length === 2 &&
				ctxTurn.contextRefs.every((item) => item.id && item.kind && item.label !== undefined && item.preview !== undefined && Number.isInteger(item.chars)),
			JSON.stringify(ctxTurn?.contextRefs),
		);
		const sessionFileCs1 = (await (await fetch(`${chatBase}api/sessions?source=pi`)).json()).sessions.find((session) => session.id === "cs-1")?.file;
		check(
			"context：工具 env 注入 active/trajectory",
			traceCtx.includes(`env:pi|cs-1|${sessionFileCs1}|${ctxActivePath}`),
			traceCtx.slice(-800),
		);
		check(
			"context：read-only spawn 白名单含 read_trajectory",
			traceCtx.includes("--tools read,grep,ls,read_trajectory"),
			traceCtx.slice(-800),
		);

		const traceBeforeCtx2 = traceLen();
		const ctxSecond = await readSse(await send("cs-1", "只看一条", { contextIds: [ctxB, "missing-id"] }));
		const ctxMeta2 = ctxSecond.events.find((event) => event.event === "meta")?.data ?? {};
		check(
			"context：缺失 id 进 dropped、变化算 delta",
			ctxMeta2.context?.selected === 2 &&
				ctxMeta2.context?.included?.join(",") === ctxB &&
				ctxMeta2.context?.dropped?.join(",") === "missing-id" &&
				ctxMeta2.context?.removed?.join(",") === ctxA,
			JSON.stringify(ctxMeta2.context),
		);
		const secondPrompt = promptOf(traceSince(traceBeforeCtx2));
		check(
			"context：变化时发 delta + 新 index",
			secondPrompt.includes(`<trajectory_index source="pi" session="cs-1" count="1">`) &&
				secondPrompt.includes(`<trajectory_index_delta>{"added":[],"removed":["${ctxA}"]}</trajectory_index_delta>`),
			secondPrompt.slice(0, 600),
		);
		const activeSecond = JSON.parse(fs.readFileSync(ctxActivePath, "utf8"));
		check("context：active 快照更新", activeSecond.items?.length === 1 && activeSecond.items[0].id === ctxB, JSON.stringify(activeSecond).slice(0, 300));

		const traceBeforeEmpty = traceLen();
		const ctxEmpty = await readSse(await send("cs-1", "不看上下文"));
		const ctxMeta3 = ctxEmpty.events.find((event) => event.event === "meta")?.data ?? {};
		const emptyPrompt = promptOf(traceSince(traceBeforeEmpty));
		const activeEmpty = JSON.parse(fs.readFileSync(ctxActivePath, "utf8"));
		check(
			"context：空选中写空 active、无 index",
			ctxMeta3.context?.selected === 0 && ctxMeta3.context?.included?.length === 0 && activeEmpty.items?.length === 0 && !emptyPrompt.includes("<trajectory_index source"),
			JSON.stringify({ meta: ctxMeta3.context, active: activeEmpty.items, prompt: emptyPrompt.slice(0, 200) }),
		);
		const traceBeforeSkillCtx = traceLen();
		const skillCtx = await readSse(await send("cs-1", "带技能", { contextIds: [ctxA], skill: "demo" }));
		const skillCtxMeta = skillCtx.events.find((event) => event.event === "meta")?.data ?? {};
		const skillCtxPrompt = promptOf(traceSince(traceBeforeSkillCtx));
		check(
			"context：技能命令在最前、index 紧随（保证 pi 原生展开）",
			skillCtxMeta.skill?.name === "demo" && skillCtxPrompt.startsWith("/skill:demo\n\n<trajectory_index") && skillCtxPrompt.includes(`[${ctxA}]`),
			skillCtxPrompt.slice(0, 300),
		);
		check(
			"context：contextIds 非数组/非字符串 400",
			(await postJson(`${chatBase}api/chat/send`, { source: "pi", session: "cs-1", prompt: "x", contextIds: "a" })).status === 400 &&
				(await postJson(`${chatBase}api/chat/send`, { source: "pi", session: "cs-1", prompt: "x", contextIds: [1] })).status === 400,
		);
		check(
			"context：contextIds >50 400",
			(await postJson(`${chatBase}api/chat/send`, {
				source: "pi",
				session: "cs-1",
				prompt: "x",
				contextIds: Array.from({ length: 51 }, (_, i) => `id-${i}`),
			})).status === 400,
		);

		// ---- P1 回归：delta 基线按当前线程上一轮 contextRefs，不按共享 active ----
		const lightCs5 = await (await fetch(`${chatBase}api/session?source=pi&id=cs-5`)).json();
		const cs5Ids = lightCs5.questions.flatMap((q) => (q.events ?? []).map((e) => e.id));
		const [ctxC, ctxD] = cs5Ids;
		const traceBeforeA1 = traceLen();
		const firstA = await readSse(await send("cs-5", "A 首轮", { contextIds: [ctxC, ctxD] }));
		const threadA = firstA.events.find((event) => event.event === "meta")?.data?.threadId;
		check(
			"context P1：A 首轮发完整清单",
			promptOf(traceSince(traceBeforeA1)).includes(`<trajectory_index source="pi" session="cs-5" count="2">`),
		);
		const postB = await postJson(`${chatBase}api/chat/thread`, { source: "pi", session: "cs-5" });
		const threadB = (await postB.json()).thread?.id;
		check("context P1：新建线程 B", typeof threadA === "string" && typeof threadB === "string" && threadA !== threadB, JSON.stringify({ threadA, threadB }));
		const traceBeforeB1 = traceLen();
		const b1 = await readSse(await send("cs-5", "B 首轮", { threadId: threadB, contextIds: [ctxC, ctxD] }));
		const b1Meta = b1.events.find((event) => event.event === "meta")?.data ?? {};
		const b1Prompt = promptOf(traceSince(traceBeforeB1));
		check(
			"context P1：B 首轮即使 active 相同也发完整清单、无 delta",
			b1Prompt.includes(`<trajectory_index source="pi" session="cs-5" count="2">`) && !b1Prompt.includes("<trajectory_index_delta>"),
			b1Prompt.slice(0, 400),
		);
		check("context P1：B 首轮 meta added 全部", b1Meta.context?.added?.length === 2 && b1Meta.context?.removed?.length === 0, JSON.stringify(b1Meta.context));

		const traceBeforeA2 = traceLen();
		await readSse(await send("cs-5", "A 二轮", { threadId: threadA, contextIds: [ctxC, ctxD] }));
		const a2Prompt = promptOf(traceSince(traceBeforeA2));
		check("context P1：A 不改选择再发不带 index", !a2Prompt.includes("<trajectory_index"), a2Prompt.slice(0, 300));
		const traceBeforeB2 = traceLen();
		await readSse(await send("cs-5", "B 二轮", { threadId: threadB, contextIds: [ctxC, ctxD] }));
		const b2Prompt = promptOf(traceSince(traceBeforeB2));
		check("context P1：B 第二次不带 index", !b2Prompt.includes("<trajectory_index"), b2Prompt.slice(0, 300));
		const traceBeforeB3 = traceLen();
		const b3 = await readSse(await send("cs-5", "B 改选", { threadId: threadB, contextIds: [ctxD] }));
		const b3Meta = b3.events.find((event) => event.event === "meta")?.data ?? {};
		const b3Prompt = promptOf(traceSince(traceBeforeB3));
		check(
			"context P1：B 改选择后带 delta + index",
			b3Prompt.includes(`<trajectory_index source="pi" session="cs-5" count="1">`) &&
				b3Prompt.includes(`<trajectory_index_delta>{"added":[],"removed":["${ctxC}"]}</trajectory_index_delta>`) &&
				b3Meta.context?.removed?.join(",") === ctxC,
			b3Prompt.slice(0, 500),
		);

		const toolStream = await readSse(await send("cs-1", "think tool"));
		const order = toolStream.events.map((e) => e.event);
		check(
			"chat：SSE 顺序 meta→status→delta→tool→done",
			order[0] === "meta" &&
				order.indexOf("status") > 0 &&
				order.indexOf("delta") > order.indexOf("status") &&
				order.indexOf("tool") > order.indexOf("delta") &&
				order.at(-1) === "done",
			JSON.stringify(order),
		);
		check("chat：meta 的 threadId 是 pi session id", toolStream.events[0].data.threadId === "fake-session-1", JSON.stringify(toolStream.events[0]?.data));
		check("chat：done 只发一次", order.filter((e) => e === "done").length === 1, JSON.stringify(order));

		const slowRes = await send("cs-1", "slow");
		const slowRead = readSse(slowRes);
		await sleep(120);
		const sameChild = await send("cs-1", "second");
		check("chat：同 child 已有 turn 409", sameChild.status === 409, String(sameChild.status));
		const sameProject = await send("cs-2", "second");
		check("chat：同项目另一个 child 409", sameProject.status === 409, String(sameProject.status));
		const modelConflict = await postJson(`${chatBase}api/chat/model`, { source: "pi", session: "cs-1", provider: "fake", id: "fake-1" });
		check("POST model：活动 turn 409", modelConflict.status === 409, String(modelConflict.status));
		await fetch(`${chatBase}api/chat/stop`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "pi", session: "cs-1" }),
		});
		const slow = await slowRead;
		check("chat：保活注释出现（chatPingMs=25）", slow.raw.includes(": ping"), slow.raw.slice(0, 200));
		check("chat：stop 后以 done(aborted) 收尾", slow.events.at(-1)?.event === "done" && slow.events.at(-1)?.data.stopReason === "aborted", JSON.stringify(slow.events.at(-1)));
		const afterStop = await (await fetch(`${chatBase}api/chat/stop`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "pi", session: "cs-1" }),
		})).json();
		check("chat：收尾后 turn/项目锁已释放（stopped=false）", afterStop.stopped === false, JSON.stringify(afterStop));

		// 浏览器断开：取消读取 → res.close → abort；锁与 turn 必须回收
		const dropRes = await send("cs-3", "slow");
		const dropReader = dropRes.body.getReader();
		await dropReader.read();
		await dropReader.cancel().catch(() => {});
		await sleep(200);
		const afterDrop = await (await fetch(`${chatBase}api/chat/stop`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "pi", session: "cs-3" }),
		})).json();
		check("chat：客户端断开后 turn 已回收", afterDrop.stopped === false, JSON.stringify(afterDrop));

		const crash = await readSse(await send("cs-1", "exit"));
		check(
			"chat：child exit 转 error 事件",
			crash.events.some((e) => e.event === "error" && e.data.code === "child_exit"),
			JSON.stringify(crash.events.at(-1)),
		);

		// ---- T7：审批桥 / profile spawn / close 拒绝 ----
		const approvalPost = (body) => postJson(`${chatBase}api/chat/approval`, { source: "pi", session: "cs-3", ...body });
		const approvalAllowOf = async () => (await (await fetch(`${chatBase}api/chat/settings?source=pi&session=cs-3`)).json()).approvalAllow;
		const traceNow = () => (fs.existsSync(chatTrace) ? fs.readFileSync(chatTrace, "utf8") : "");

		let approvalData = null;
		const denied = await readSse(await send("cs-3", "approve"), async (event) => {
			if (event.event !== "approval") return;
			approvalData = event.data;
			const res = await approvalPost({ id: event.data.id, confirmed: false });
			check("approval：拒绝 POST ok", res.status === 200 && (await res.json()).ok === true);
		});
		check(
			"approval：SSE approval 字段",
			approvalData?.toolName === "bash" && approvalData?.title?.includes("bash") && approvalData?.message === "npm test" && approvalData?.timeout === 5,
			JSON.stringify(approvalData),
		);
		check(
			"approval：拒绝后 fake 收到 false 并结束",
			approvalData && traceNow().includes(`ui:${approvalData.id}:false`) && denied.events.some((event) => event.event === "delta" && event.data.text.includes("false")),
			JSON.stringify(denied.events.map((event) => event.event)),
		);

		approvalData = null;
		let wrongThreadOk = null;
		const allowedOnce = await readSse(await send("cs-3", "approve"), async (event) => {
			if (event.event !== "approval") return;
			approvalData = event.data;
			const wrong = await approvalPost({ id: event.data.id, confirmed: true, threadId: "wrong-thread" });
			wrongThreadOk = (await wrong.json()).ok;
			const res = await approvalPost({ id: event.data.id, confirmed: true, allowForSession: false });
			check("approval：允许本次 POST ok", res.status === 200 && (await res.json()).ok === true);
		});
		check("approval：threadId 不匹配 no-op", wrongThreadOk === false);
		check(
			"approval：允许本次后 fake 收到 true",
			Boolean(approvalData) && traceNow().includes(`ui:${approvalData.id}:true`) && allowedOnce.events.some((event) => event.event === "delta" && event.data.text.includes("true")),
			JSON.stringify(allowedOnce.events.map((event) => event.event)),
		);
		check("approval：allowForSession 非布尔 400", (await approvalPost({ id: "x", confirmed: true, allowForSession: "yes" })).status === 400);
		check("approval：仅本次不写 allow-set", (await approvalAllowOf()).length === 0, JSON.stringify(await approvalAllowOf()));

		const timeoutStream = await readSse(await send("cs-3", "approve-timeout"));
		const timeoutApproval = timeoutStream.events.find((event) => event.event === "approval")?.data;
		check(
			"approval：超时自动拒绝 + notice",
			timeoutApproval?.timeout === 1 &&
				timeoutStream.events.some((event) => event.event === "notice" && event.data.text.includes("审批超时")) &&
				timeoutStream.events.some((event) => event.event === "delta" && event.data.text.includes("false")),
			JSON.stringify(timeoutStream.events.map((event) => event.event)),
		);
		check("approval：超时 child 收到 false", Boolean(timeoutApproval) && traceNow().includes(`ui:${timeoutApproval.id}:false`));

		approvalData = null;
		const stopStream = await readSse(await send("cs-3", "approve"), async (event) => {
			if (event.event !== "approval") return;
			approvalData = event.data;
			await postJson(`${chatBase}api/chat/stop`, { source: "pi", session: "cs-3" });
		});
		check(
			"approval：stop 拒绝待审批",
			Boolean(approvalData) && traceNow().includes(`ui:${approvalData.id}:false`) && stopStream.events.at(-1)?.event === "done",
			JSON.stringify(stopStream.events.at(-1)),
		);

		approvalData = null;
		await readSse(await send("cs-3", "approve"), async (event) => {
			if (event.event !== "approval") return;
			approvalData = event.data;
			await approvalPost({ id: event.data.id, confirmed: true, allowForSession: true });
		});
		check("approval：allowForSession 写 allow-set", (await approvalAllowOf()).includes("bash"), JSON.stringify(await approvalAllowOf()));
		const traceBeforeAuto = traceNow().length;
		const autoApproved = await readSse(await send("cs-3", "approve"));
		check(
			"approval：allow-set 自动确认不再 SSE",
			!autoApproved.events.some((event) => event.event === "approval") &&
				autoApproved.events.some((event) => event.event === "delta" && event.data.text.includes("true")),
			JSON.stringify(autoApproved.events.map((event) => event.event)),
		);
		check("approval：自动确认写 child true", traceNow().slice(traceBeforeAuto).includes(":true"));

		const profileSet = (profile) => postJson(`${chatBase}api/chat/settings`, { source: "pi", session: "cs-3", profile });
		let lenProfile = traceNow().length;
		check("profile：切 full 返回 full", (await (await profileSet("full")).json()).profile === "full");
		await readSse(await send("cs-3", "hi"));
		const fullTrace = traceNow().slice(lenProfile);
		check(
			"profile：full spawn 带 approval 扩展 + 完整 tools",
			fullTrace.includes("chat-approval.ts") && fullTrace.includes("--tools read,write,edit,bash,read_trajectory"),
			fullTrace.slice(-900),
		);
		check("profile：GET settings full", (await (await fetch(`${chatBase}api/chat/settings?source=pi&session=cs-3`)).json()).profile === "full");

		lenProfile = traceNow().length;
		await profileSet("read-only");
		await readSse(await send("cs-3", "hi"));
		const readOnlyTrace = traceNow().slice(lenProfile);
		check(
			"profile：read-only 不带 approval 扩展",
			readOnlyTrace.includes("--tools read,grep,ls,read_trajectory") && !readOnlyTrace.includes("chat-approval.ts"),
			readOnlyTrace.slice(-700),
		);

		lenProfile = traceNow().length;
		await profileSet("no-tools");
		await readSse(await send("cs-3", "hi"));
		const noToolsTrace = traceNow().slice(lenProfile);
		check(
			"profile：no-tools 用 --no-builtin-tools 且不带 approval",
			noToolsTrace.includes("--no-builtin-tools") && !noToolsTrace.includes("chat-approval.ts"),
			noToolsTrace.slice(-600),
		);
		await profileSet("read-only");

		// close 时拒绝 pending：用另一个项目（cs-1，allow-set 为空）
		let closeApproval = null;
		const closeStreamPromise = readSse(await send("cs-1", "approve"), async (event) => {
			if (event.event === "approval") closeApproval = event.data;
		}).catch(() => ({ events: [] }));
		for (let i = 0; i < 100 && !closeApproval; i++) await sleep(20);
		check("approval：close 前拿到 pending", Boolean(closeApproval));
		await chatServer.close();
		await closeStreamPromise;
		await sleep(200);
		check("approval：close 拒绝待审批", Boolean(closeApproval) && traceNow().includes(`ui:${closeApproval.id}:false`), traceNow().slice(-600));

		// ---- T8：进程池 / LRU / TTL / 项目串行 / 跨会话设置 ----
		const t8Sessions = path.join(tmp, "t8-sessions");
		const t8ProjectA = path.join(tmp, "t8-project-a");
		const t8ProjectB = path.join(tmp, "t8-project-b");
		fs.mkdirSync(t8ProjectA, { recursive: true });
		fs.mkdirSync(t8ProjectB, { recursive: true });
		for (const dir of [path.join(t8Sessions, "--a--"), path.join(t8Sessions, "--b--")]) fs.mkdirSync(dir, { recursive: true });
		writeSession(path.join(t8Sessions, "--a--"), { id: "t8-a", cwd: t8ProjectA, first: "T8 A" });
		writeSession(path.join(t8Sessions, "--a--"), { id: "t8-b", cwd: t8ProjectA, first: "T8 B" });
		writeSession(path.join(t8Sessions, "--a--"), { id: "t8-d", cwd: t8ProjectA, first: "T8 D" });
		writeSession(path.join(t8Sessions, "--b--"), { id: "t8-c", cwd: t8ProjectB, first: "T8 C" });
		const t8ChatDir = path.join(tmp, "t8-chat-dir");
		const t8Server = await createTrajectoryServer({
			scope: "all",
			webDir: WEB,
			sessionsRoot: t8Sessions,
			codexRoot: path.join(tmp, "no-codex"),
			port: 0,
			chat: true,
			chatDir: t8ChatDir,
			piBin: { cmd: process.execPath, argsPrefix: [FAKE], mode: false, display: "fake-pi" },
			chatPingMs: 25,
			chatMaxChildren: 2,
			chatIdleTtlMs: 1000,
			chatSweepMs: 20,
		});
		const t8Base = t8Server.url;
		const t8Models = (session) => fetch(`${t8Base}api/chat/models?source=pi&session=${session}`);
		const t8Send = (session, prompt) =>
			fetch(`${t8Base}api/chat/send`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: "pi", session, prompt }),
			});
		const t8Post = (url, body) =>
			fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const t8SettingsPost = (session, body) => t8Post(`${t8Base}api/chat/settings`, { source: "pi", session, ...body });
		const t8SpawnLines = (id) => {
			const lines = traceNow().split("\n");
			const out = [];
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].startsWith(`env:pi|${id}|`)) out.push(lines[i - 1] ?? "");
			}
			return out;
		};
		const t8SpawnCount = (id) => t8SpawnLines(id).length;
		const t8StartSlow = async (session) => {
			let release = () => {};
			const metaSeen = new Promise((resolve) => {
				release = resolve;
			});
			const response = await t8Send(session, "slow");
			if (response.status !== 200) throw new Error(`slow ${session} HTTP ${response.status}`);
			const read = readSse(response, (event) => {
				if (event.event === "meta") release();
			});
			await metaSeen;
			return { read };
		};
		const t8Stop = async (session) => {
			await t8Post(`${t8Base}api/chat/stop`, { source: "pi", session });
		};

		// LRU：A、B idle；touch A 后建 C，应淘汰 B。
		check("pool：A 启动", (await t8Models("t8-a")).status === 200 && t8SpawnCount("t8-a") === 1);
		check("pool：B 启动", (await t8Models("t8-b")).status === 200 && t8SpawnCount("t8-b") === 1);
		await t8Models("t8-a");
		check("pool：C 启动（容量 2 时淘汰 idle）", (await t8Models("t8-c")).status === 200 && t8SpawnCount("t8-c") === 1);
		const bBeforeLru = t8SpawnCount("t8-b");
		await t8Models("t8-b");
		check("pool：touch A 后 C 淘汰 B（再访问 B 会重新 spawn）", t8SpawnCount("t8-b") === bBeforeLru + 1, `b=${bBeforeLru}->${t8SpawnCount("t8-b")}`);

		// 两个 busy（不同项目）时，第三个 child 409。
		const t8SlowA = (await t8StartSlow("t8-a")).read;
		const t8SlowC = (await t8StartSlow("t8-c")).read;
		const busyThird = await t8Models("t8-d");
		check("pool：两个 busy 时第三个 409", busyThird.status === 409, String(busyThird.status));
		await t8Stop("t8-a");
		await t8SlowA;
		await t8Stop("t8-c");
		await t8SlowC;

		// 同项目串行：A 的 turn 占用项目锁，D 在 ensureChild 之前就被拒绝，不能先 spawn/淘汰。
		const t8SlowA2 = (await t8StartSlow("t8-a")).read;
		const dBefore = t8SpawnCount("t8-d");
		const dConflict = await t8Send("t8-d", "hi");
		await dConflict.text();
		check(
			"pool：同项目串行 409 且未 spawn D",
			dConflict.status === 409 && t8SpawnCount("t8-d") === dBefore,
			`${dConflict.status} d=${dBefore}->${t8SpawnCount("t8-d")}`,
		);
		await t8Stop("t8-a");
		await t8SlowA2;

		// TTL 到期后 sweep，再次访问 B 必须重新 spawn。
		await t8Models("t8-b");
		const bBeforeSweep = t8SpawnCount("t8-b");
		await sleep(1200);
		await t8Models("t8-b");
		check("pool：TTL 到期 sweep 后 child 消失", t8SpawnCount("t8-b") === bBeforeSweep + 1, `b=${bBeforeSweep}->${t8SpawnCount("t8-b")}`);

		// 跨会话设置：同项目 idle child 立即按新参数重启。
		await t8Models("t8-a");
		await t8Models("t8-b");
		const aBeforeFull = t8SpawnCount("t8-a");
		const bBeforeFull = t8SpawnCount("t8-b");
		const fullSet = await t8SettingsPost("t8-a", { profile: "full" });
		const fullBody = await fullSet.json();
		const aFullSpawn = t8SpawnLines("t8-a").at(-1) ?? "";
		const bFullSpawn = t8SpawnLines("t8-b").at(-1) ?? "";
		check(
			"pool：settings 改 full 后同项目 idle A/B 都重启且带 approval",
			fullSet.status === 200 &&
				fullBody.profile === "full" &&
				t8SpawnCount("t8-a") === aBeforeFull + 1 &&
				t8SpawnCount("t8-b") === bBeforeFull + 1 &&
				aFullSpawn.includes("chat-approval.ts") &&
				bFullSpawn.includes("chat-approval.ts") &&
				aFullSpawn.includes("--tools read,write,edit,bash,read_trajectory"),
			JSON.stringify({ fullBody, aFullSpawn: aFullSpawn.slice(-300), bFullSpawn: bFullSpawn.slice(-300) }),
		);

		// busy 的同项目 child 不杀，标记 stale；下一次 ensureChild 用 read-only 重启。
		const aBeforeBusy = t8SpawnCount("t8-a");
		const bBeforeBusy = t8SpawnCount("t8-b");
		const t8SlowFull = (await t8StartSlow("t8-a")).read;
		const readOnlySet = await t8SettingsPost("t8-b", { profile: "read-only" });
		const readOnlyBody = await readOnlySet.json();
		const bReadSpawn = t8SpawnLines("t8-b").at(-1) ?? "";
		check(
			"pool：busy child 设置变更不杀，idle B 先重启",
			readOnlySet.status === 200 &&
				readOnlyBody.profile === "read-only" &&
				t8SpawnCount("t8-a") === aBeforeBusy &&
				t8SpawnCount("t8-b") === bBeforeBusy + 1 &&
				bReadSpawn.includes("--tools read,grep,ls,read_trajectory") &&
				!bReadSpawn.includes("chat-approval.ts"),
			JSON.stringify({ readOnlyBody, bReadSpawn: bReadSpawn.slice(-300), a: t8SpawnCount("t8-a") }),
		);
		await t8Stop("t8-a");
		await t8SlowFull;
		const aBeforeStale = t8SpawnCount("t8-a");
		await t8Models("t8-a");
		const aStaleSpawn = t8SpawnLines("t8-a").at(-1) ?? "";
		check(
			"pool：busy stale 在下次 ensureChild 用 read-only 重启",
			t8SpawnCount("t8-a") === aBeforeStale + 1 &&
				aStaleSpawn.includes("--tools read,grep,ls,read_trajectory") &&
				!aStaleSpawn.includes("chat-approval.ts"),
			JSON.stringify({ a: `${aBeforeStale}->${t8SpawnCount("t8-a")}`, aStaleSpawn: aStaleSpawn.slice(-300) }),
		);
		await t8Server.close();

		// 并发 ensure：fake child 延迟 get_state，确认 gate 下峰值也不超过 2。
		process.env.FAKE_PI_STATE_DELAY_MS = "80";
		const t8bSessions = path.join(tmp, "t8b-sessions");
		const t8bProject = path.join(tmp, "t8b-project");
		const t8bChatDir = path.join(tmp, "t8b-chat-dir");
		fs.mkdirSync(t8bProject, { recursive: true });
		fs.mkdirSync(path.join(t8bSessions, "--x--"), { recursive: true });
		for (const id of ["t8x-a", "t8x-b", "t8x-c"]) {
			writeSession(path.join(t8bSessions, "--x--"), { id, cwd: t8bProject, first: `T8X ${id}` });
		}
		const t8bServer = await createTrajectoryServer({
			scope: "all",
			webDir: WEB,
			sessionsRoot: t8bSessions,
			codexRoot: path.join(tmp, "no-codex"),
			port: 0,
			chat: true,
			chatDir: t8bChatDir,
			piBin: { cmd: process.execPath, argsPrefix: [FAKE], mode: false, display: "fake-pi" },
			chatMaxChildren: 2,
			chatIdleTtlMs: 60_000,
			chatSweepMs: 1000,
		});
		const t8bBase = t8bServer.url;
		const t8bCount = () => {
			try {
				return execFileSync("pgrep", ["-f", t8bChatDir], { encoding: "utf8" })
					.split("\n")
					.filter(Boolean).length;
			} catch {
				return 0;
			}
		};
		let t8bSettled = false;
		const t8bAll = Promise.all(
			["t8x-a", "t8x-b", "t8x-c"].map((session) =>
				fetch(`${t8bBase}api/chat/models?source=pi&session=${session}`).then(async (response) => ({
					status: response.status,
					body: await response.text(),
				})),
			),
		).finally(() => {
			t8bSettled = true;
		});
		let t8bPeak = 0;
		while (!t8bSettled) {
			t8bPeak = Math.max(t8bPeak, t8bCount());
			await sleep(10);
		}
		const t8bResults = await t8bAll;
		check(
			"pool：并发 ensure 峰值不超过 2",
			t8bPeak <= 2 && t8bResults.every((result) => result.status === 200),
			JSON.stringify({ peak: t8bPeak, statuses: t8bResults.map((result) => result.status), bodies: t8bResults.map((result) => result.body.slice(0, 300)) }),
		);
		await t8bServer.close();
		delete process.env.FAKE_PI_STATE_DELAY_MS;
		await sleep(100);
		check("pool：并发测试 close 后无 child", t8bCount() === 0, String(t8bCount()));

		delete process.env.FAKE_PI_TRACE;
		delete process.env.FAKE_PI_MODELS_FAIL;
		delete process.env.FAKE_PI_COMMANDS_FAIL;
		let residual = "";
		try {
			residual = execFileSync("pgrep", ["-f", FAKE], { encoding: "utf8" }).trim();
		} catch {
			residual = "";
		}
		check("chat：server.close 后无 fake child 残留", residual === "", residual);
	} catch (err) {
		check("测试执行", false, err.stack);
	} finally {
		if (all) all.kill("SIGKILL");
		if (project) project.kill("SIGKILL");
		fs.rmSync(tmp, { recursive: true, force: true });
		console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
		process.exit(failed === 0 ? 0 : 1);
	}
})();
