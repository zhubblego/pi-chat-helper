// HTTP 服务：多会话列表 / 指定会话投影 / 增量轮询 / 事件详情 / 双范围 / 热更新 / 退出
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

/** 读完一条 SSE 流，按事件块解析成 {event,data} 数组（原始文本保留给保活断言）。 */
async function readSse(response) {
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
			if (data.length) events.push({ event, data: JSON.parse(data.join("\n")) });
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

		await chatServer.close();
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
