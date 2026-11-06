// chat host / RPC / capabilities（T1）
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, cond ? "" : extra);
	if (!cond) failed++;
};

const ROOT = path.join(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "fake-pi.cjs");
const WEB = path.join(ROOT, "trajectory-web", "web");
const urlOf = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-chat-"));

// 技能夹具：demo（小 + 仅手动）、big（33k）、huge（200001）。
const skillRoot = path.join(tmp, "skill-fixtures");
const skillFile = (name, content) => {
	const dir = path.join(skillRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), content);
	return dir;
};
skillFile("demo", "---\nname: demo\ndescription: demo skill\ndisable-model-invocation: true\n---\n\n# Demo\n短技能。\n");
skillFile("big", `---\nname: big\ndescription: big skill\n---\n\n${"x".repeat(33000)}`);
skillFile("huge", `---\nname: huge\ndescription: huge skill\n---\n\n${"x".repeat(200001)}`);
process.env.FAKE_PI_SKILL_DIR = skillRoot;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function postJson(url, body) {
	return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** 读完一条 SSE 流，按事件块解析成 {event,data} 数组（同时保留原始文本）。 */
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

function waitFor(checkFn, timeoutMs = 3000, label = "等待事件") {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const timer = setInterval(() => {
			if (checkFn()) {
				clearInterval(timer);
				resolve();
			} else if (Date.now() - started > timeoutMs) {
				clearInterval(timer);
				reject(new Error(`${label}超时`));
			}
		}, 10);
	});
}

/** 写一个最小 pi session 文件（header + model_change + user + tool + answer）。 */
function writePiSessionFile(file, { id, cwd, userText, assistantText = "答复", modelId = "fake-1" }) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lines = [
		{ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.100Z", provider: "fake", modelId },
		{
			type: "message",
			id: "u1",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: userText }], timestamp: 1 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				provider: "fake",
				model: "fake-1",
				api: "openai-completions",
				stopReason: "toolUse",
				usage: { input: 1, output: 2, totalTokens: 3 },
				content: [{ type: "toolCall", id: "t1", name: "read_trajectory", arguments: { ids: ["a1:p2"] } }],
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read_trajectory",
				content: [{ type: "text", text: "工具结果" }],
				isError: false,
			},
		},
		{
			type: "message",
			id: "a2",
			parentId: "r1",
			timestamp: "2026-01-01T00:00:04.000Z",
			message: {
				role: "assistant",
				provider: "fake",
				model: "fake-1",
				api: "openai-completions",
				stopReason: "stop",
				usage: { input: 3, output: 4, totalTokens: 7 },
				content: [{ type: "text", text: assistantText }],
				timestamp: 4,
			},
		},
	];
	fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

(async () => {
	const { parsePiVersion, versionAtLeast, resolvePiCandidates, piRpcArgs, probeFirstPi } = await import(urlOf("trajectory-web/server/pi-binary.mjs"));
	const { RpcChild, createChatHost, checkChatDir, isPathInside, resolveAgentDir, sanitizeModel, providerNameOf } = await import(urlOf("trajectory-web/server/chat-host.mjs"));
	const chatSession = await import(urlOf("trajectory-web/server/chat-session.mjs"));
	const chatSettings = await import(urlOf("trajectory-web/server/chat-settings.mjs"));
	const { buildProjection } = await import(urlOf("trajectory-web/server/session.mjs"));

	// ---- 版本解析 ----
	check("parsePiVersion：纯版本号", (() => {
		const v = parsePiVersion("1.5.0");
		return v && v.major === 1 && v.minor === 5 && v.patch === 0 && v.raw === "1.5.0";
	})());
	check("parsePiVersion：带前缀", parsePiVersion("pi 1.5.0\n")?.raw === "1.5.0");
	check("parsePiVersion：无法解析返回 null", parsePiVersion("unknown") === null);
	check("versionAtLeast：1.5.0 通过", versionAtLeast(parsePiVersion("1.5.0")) === true);
	check("versionAtLeast：1.4.9 拒绝", versionAtLeast(parsePiVersion("1.4.9")) === false);
	check("versionAtLeast：2.0.0 通过", versionAtLeast(parsePiVersion("2.0.0")) === true);

	// ---- 候选解析 ----
	const home = path.join(tmp, "home");
	fs.mkdirSync(path.join(home, ".pi", "agent", "bin"), { recursive: true });
	fs.writeFileSync(path.join(home, ".pi", "agent", "bin", "pi"), "#!/bin/sh\n");
	const envCandidates = resolvePiCandidates({ env: { PI_CHAT_PI_BIN: "/x/pi" }, homeDir: home });
	check("候选：环境变量优先", envCandidates[0].kind === "env" && envCandidates[0].cmd === "/x/pi");
	check("候选：托管安装被识别", envCandidates.some((c) => c.kind === "managed"));
	const hostEntry = path.join(tmp, "cli.js");
	fs.writeFileSync(hostEntry, "// entry\n");
	const hostCandidates = resolvePiCandidates({ env: {}, homeDir: home, hostEntry, hostExecPath: "/usr/bin/node" });
	const hostCandidate = hostCandidates.find((c) => c.kind === "host");
	check("候选：宿主入口", hostCandidate && hostCandidate.argsPrefix[0] === hostEntry && hostCandidate.mode === true);
	const rpcEntry = path.join(tmp, "rpc-entry.js");
	fs.writeFileSync(rpcEntry, "// rpc entry\n");
	const rpcCandidates = resolvePiCandidates({ env: {}, homeDir: home, hostEntry: rpcEntry, hostExecPath: "/usr/bin/node" });
	check("候选：rpc-entry 不重复加 --mode", rpcCandidates.find((c) => c.kind === "host")?.mode === false);
	const nonPiEntry = path.join(tmp, "test-runner.cjs");
	fs.writeFileSync(nonPiEntry, "// not pi\n");
	const guarded = resolvePiCandidates({ env: {}, homeDir: home, hostEntry: nonPiEntry, hostExecPath: "/usr/bin/node" });
	check("候选：非 pi 入口不被当作宿主", !guarded.some((c) => c.kind === "host"));
	check(
		"参数：mode=true 自动加 --mode rpc",
		piRpcArgs({ argsPrefix: ["x"], mode: true }, ["--no-tools"]).join(" ") === "x --mode rpc --no-tools",
	);
	check("参数：mode=false 原样", piRpcArgs({ argsPrefix: ["x"], mode: false }, ["--no-tools"]).join(" ") === "x --no-tools");

	// ---- 路径 ----
	check("isPathInside：子路径", isPathInside("/a/b", "/a/b/c") === true);
	check("isPathInside：前缀相似不误判", isPathInside("/a/b", "/a/bc") === false);
	const insideRoot = path.join(tmp, "sessions");
	const checkInside = checkChatDir(path.join(insideRoot, "chats"), [insideRoot]);
	check("chatDir：位于 sessions 下被拒绝", checkInside.ok === false && checkInside.reason.includes("轨迹"));
	const checkOk = checkChatDir(path.join(tmp, "chat-ok"), []);
	check("chatDir：正常目录可创建", checkOk.ok === true && fs.existsSync(checkOk.dir));
	check("resolveAgentDir：尊重环境变量", resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/x-agent" }) === path.resolve("/tmp/x-agent"));

	// ---- chat-session 纯函数 ----
	const sanitized = chatSession.sanitizeSegment("../etc/passwd");
	check("sanitizeSegment：无路径分隔符", !sanitized.includes("/") && !sanitized.includes("\\") && sanitized !== "..", sanitized);
	check("sanitizeSegment：合法值原样", chatSession.sanitizeSegment("ext-1") === "ext-1");
	check("sanitizeSegment：稳定", chatSession.sanitizeSegment("a/b") === chatSession.sanitizeSegment("a/b"));
	check("sanitizeSegment：.. 不保留", chatSession.sanitizeSegment("..") !== "..");
	const dirsA = chatSession.chatSessionDirs(path.join(tmp, "chat-unit"), "pi", "ext-1");
	check(
		"chatSessionDirs：sessions/meta",
		dirsA.sessionsDir.endsWith(path.join("pi", "ext-1", "sessions")) && dirsA.metaDir.endsWith(path.join("pi", "ext-1", "meta")),
	);
	check(
		"isSafeThreadId：合法/非法",
		chatSession.isSafeThreadId("thread-a") &&
			!chatSession.isSafeThreadId("..") &&
			!chatSession.isSafeThreadId(".a") &&
			!chatSession.isSafeThreadId("a."),
	);

	const sessionsUnit = path.join(tmp, "unit-sessions");
	fs.mkdirSync(sessionsUnit, { recursive: true });
	fs.writeFileSync(path.join(sessionsUnit, "a.jsonl"), "{}\n");
	fs.writeFileSync(path.join(sessionsUnit, "b.jsonl"), "{}\n");
	const nowSec = Date.now() / 1000;
	fs.utimesSync(path.join(sessionsUnit, "a.jsonl"), nowSec - 5, nowSec - 5);
	fs.utimesSync(path.join(sessionsUnit, "b.jsonl"), nowSec, nowSec);
	check("latestThreadFile：取 mtime 最新", chatSession.latestThreadFile(sessionsUnit)?.name === "b.jsonl");
	fs.utimesSync(path.join(sessionsUnit, "a.jsonl"), nowSec, nowSec);
	check("latestThreadFile：mtime 相同按文件名倒序", chatSession.latestThreadFile(sessionsUnit)?.name === "b.jsonl");

	const metaUnit = path.join(tmp, "unit-meta");
	chatSession.appendTurn(metaUnit, { ordinal: 2, displayText: "二" });
	chatSession.appendTurn(metaUnit, { ordinal: 1, displayText: "一" });
	fs.appendFileSync(path.join(metaUnit, "turns.jsonl"), "not-json\n");
	check("turns：排序 + 忽略坏行", chatSession.readTurns(metaUnit).map((t) => t.ordinal).join(",") === "1,2");

	chatSession.writeContextNext(metaUnit, { items: [{ id: "a1:p2" }] });
	const activeContext = chatSession.promoteContext(metaUnit);
	check("context：next 提升为 active", activeContext.items?.[0]?.id === "a1:p2");
	check(
		"stripInjectedBlocks：去掉 index/delta",
		chatSession.stripInjectedBlocks(
			"<trajectory_index>x</trajectory_index><trajectory_index_delta>y</trajectory_index_delta>\n问题",
		) === "问题",
	);

	// ---- 模型白名单 / session 模型 ----
	const rawModel = {
		provider: "fake",
		id: "fake-1",
		name: "Fake One",
		reasoning: true,
		contextWindow: 128000,
		maxTokens: 4096,
		apiKey: "sk-secret",
		baseUrl: "https://secret.invalid",
		headers: { authorization: "Bearer secret" },
		oauth: { token: "x" },
		api: "openai-completions",
	};
	const safeModel = sanitizeModel(rawModel);
	check(
		"sanitizeModel：字段白名单",
		Object.keys(safeModel).sort().join(",") === "contextWindow,id,maxTokens,name,provider,providerName,reasoning",
		JSON.stringify(safeModel),
	);
	check(
		"sanitizeModel：不含密钥/URL/headers",
		!/sk-secret|secret\.invalid|apiKey|baseUrl|headers|oauth|Bearer/.test(JSON.stringify(safeModel)),
		JSON.stringify(safeModel),
	);
	check(
		"sanitizeModel：缺 provider/id 返回 null",
		sanitizeModel({ id: "x" }) === null && sanitizeModel({ provider: "p" }) === null && sanitizeModel(null) === null,
	);
	check("providerNameOf：已知映射 + 自定义原值", providerNameOf("litellm") === "LiteLLM" && providerNameOf("my-provider") === "my-provider");
	const sessionModelFile = path.join(tmp, "session-models.jsonl");
	fs.writeFileSync(
		sessionModelFile,
		[
			JSON.stringify({ type: "session", version: 3, id: "s-model", timestamp: "2026-01-01T00:00:00.000Z" }),
			JSON.stringify({ type: "model_change", id: "m1", provider: "fake", modelId: "fake-1" }),
			JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "x" } }),
			JSON.stringify({ type: "model_change", id: "m2", provider: "other", modelId: "fake-2" }),
		].join("\n") + "\n",
	);
	check(
		"readSessionModel：取最后一条 model_change",
		chatSession.readSessionModel(sessionModelFile)?.provider === "other" && chatSession.readSessionModel(sessionModelFile)?.id === "fake-2",
	);
	check("readSessionModel：缺失文件返回 null", chatSession.readSessionModel(path.join(tmp, "no-session.jsonl")) === null);

	// ---- 设置：默认值 / 损坏回退 / 按项目分键 / 原子写 ----
	const settingsFile = path.join(tmp, "settings-unit.json");
	const defaults = chatSettings.projectSettings(chatSettings.readSettings(settingsFile), "pi", "/tmp/proj");
	check("settings：文件缺失时默认 read-only/false", defaults.profile === "read-only" && defaults.projectSkills === false, JSON.stringify(defaults));
	fs.writeFileSync(settingsFile, "{not-json");
	const corrupt = chatSettings.projectSettings(chatSettings.readSettings(settingsFile), "pi", "/tmp/proj");
	check("settings：损坏 JSON 回退默认", corrupt.profile === "read-only" && corrupt.projectSkills === false);
	chatSettings.updateProjectSettings(settingsFile, { source: "pi", projectPath: "/tmp/proj", patch: { profile: "full", projectSkills: true } });
	const saved = chatSettings.projectSettings(chatSettings.readSettings(settingsFile), "pi", "/tmp/proj");
	check("settings：按项目键写入并读回", saved.profile === "full" && saved.projectSkills === true, JSON.stringify(saved));
	chatSettings.updateProjectSettings(settingsFile, { source: "pi", projectPath: "/tmp/proj", patch: { projectSkills: false } });
	const merged = chatSettings.projectSettings(chatSettings.readSettings(settingsFile), "pi", "/tmp/proj");
	check("settings：patch 未提供的字段保留", merged.profile === "full" && merged.projectSkills === false, JSON.stringify(merged));
	check("settings：非法 profile 读回时归一", chatSettings.readSettings((() => {
		const bad = path.join(tmp, "settings-bad-profile.json");
		fs.writeFileSync(bad, JSON.stringify({ version: 1, projects: { "pi:/tmp/proj": { profile: "bogus", projectSkills: "yes" } } }));
		return bad;
	})()).projects["pi:/tmp/proj"].profile === "read-only");

	// ---- turns：同 ordinal 覆盖（后写胜） ----
	const upsertDir = path.join(tmp, "turns-upsert");
	chatSession.appendTurn(upsertDir, { ordinal: 1, displayText: "旧" });
	chatSession.upsertTurn(upsertDir, { ordinal: 1, displayText: "新" });
	chatSession.upsertTurn(upsertDir, { ordinal: 2, displayText: "二" });
	const upserted = chatSession.readTurns(upsertDir);
	check(
		"upsertTurn：同 ordinal 覆盖且保持排序",
		upserted.length === 2 && upserted[0].displayText === "新" && upserted[1].ordinal === 2,
		JSON.stringify(upserted),
	);

	const projFile = path.join(tmp, "proj-chat", "2026-01-01T00-00-00-000Z_thread-a.jsonl");
	writePiSessionFile(projFile, {
		id: "thread-a",
		cwd: "/tmp/projA",
		userText: "<trajectory_index>x</trajectory_index>\n问题 A",
	});
	const projection = buildProjection(projFile);
	const mappedThread = chatSession.parseThreadProjection(projection, [
		{ ordinal: 1, displayText: "问题 A", contextRefs: [{ id: "a1:p2", kind: "tool", label: "工具", preview: "bash" }] },
	]);
	check(
		"投影：user displayText/context 来自 turns",
		mappedThread.messages[0]?.role === "user" &&
			mappedThread.messages[0].displayText === "问题 A" &&
			mappedThread.messages[0].context.length === 1,
	);
	check(
		"投影：tool + assistant",
		mappedThread.messages.some((m) => m.role === "tool" && m.toolName === "read_trajectory") &&
			mappedThread.messages.some((m) => m.role === "assistant" && m.text === "答复"),
	);
	check("投影：model 从 model_change", mappedThread.model?.provider === "fake" && mappedThread.model?.id === "fake-1");
	check(
		"投影：无 turns 时剥离注入块",
		chatSession.parseThreadProjection(projection, []).messages[0]?.displayText === "问题 A",
	);

	// ---- RpcChild（fake pi） ----
	const fakePi = { cmd: process.execPath, argsPrefix: [FIXTURE], mode: false, display: "fake-pi" };
	const child = new RpcChild({ pi: fakePi, args: [], cwd: tmp, log: () => {} }).start();
	const state = await child.send({ type: "get_state" });
	check("RPC：get_state 返回 sessionId", typeof state.data?.sessionId === "string", JSON.stringify(state));
	const models = await child.send({ type: "get_available_models" });
	check("RPC：get_available_models", models.data?.models?.[0]?.id === "fake-1", JSON.stringify(models));
	const commands = await child.send({ type: "get_commands" });
	check(
		"RPC：get_commands 含 skill",
		commands.data?.commands?.some((c) => c.source === "skill" && c.name === "skill:demo"),
		JSON.stringify(commands),
	);
	const events = [];
	child.onEvent((event) => events.push(event));
	await child.send({ type: "prompt", message: "hi" });
	await waitFor(() => events.some((event) => event.type === "agent_end"), 2000, "agent_end");
	const deltas = events
		.filter((event) => event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta")
		.map((event) => event.assistantMessageEvent.delta);
	check("RPC：prompt 收到 text_delta", deltas.join("") === "你好，世界", deltas.join(""));
	let unknownFailed = false;
	try {
		await child.send({ type: "nope" });
	} catch {
		unknownFailed = true;
	}
	check("RPC：unknown command 被拒绝", unknownFailed);
	await child.close();
	check("RPC：close 后进程退出", child.exited === true);

	// ---- capabilities ----
	const host = createChatHost({ chatDir: path.join(tmp, "chat-cap"), pi: fakePi, piVersion: "1.5.0", sessionRoots: [], log: () => {} });
	const cap = await host.capabilities();
	check("capabilities：enabled", cap.enabled === true && cap.backend === "pi-rpc", JSON.stringify(cap));
	check("capabilities：版本与路径", cap.piVersion === "1.5.0" && cap.profiles.includes("read-only") && cap.chatDir.endsWith("chat-cap"));
	const capRefresh = await host.capabilities(true);
	check("capabilities：refresh 仍 enabled", capRefresh.enabled === true);
	const disabledLow = await createChatHost({ chatDir: path.join(tmp, "chat-low"), pi: fakePi, piVersion: "1.4.0", sessionRoots: [] }).capabilities();
	check("capabilities：低版本禁用", disabledLow.enabled === false && disabledLow.reason.includes("版本过低"));
	const disabledInside = await createChatHost({
		chatDir: path.join(tmp, "sessions", "chats"),
		pi: fakePi,
		piVersion: "1.5.0",
		sessionRoots: [path.join(tmp, "sessions")],
	}).capabilities();
	check("capabilities：chatDir 在 sessions 下禁用", disabledInside.enabled === false && disabledInside.reason.includes("轨迹"));
	const calls = [];
	await host.handle({ method: "GET" }, {}, new URL("http://x/api/chat/capabilities"), null, (_res, status, body) => calls.push({ status, body }));
	check("capabilities：handle 返回 200", calls[0]?.status === 200 && calls[0].body.enabled === true);
	await host.close();

	// ---- 与 HTTP 服务集成 ----
	const { createTrajectoryServer } = await import(urlOf("trajectory-web/server/app.mjs"));
	const sessionsRoot = path.join(tmp, "sessions-http");
	const codexRoot = path.join(tmp, "codex-http");
	fs.mkdirSync(sessionsRoot, { recursive: true });
	fs.mkdirSync(codexRoot, { recursive: true });

	// 轨迹会话 fixture（让 resolveSession 能找到）
	writePiSessionFile(path.join(sessionsRoot, "--projA--", "2026-01-01T00-00-00-000Z_chat-sess-1.jsonl"), {
		id: "chat-sess-1",
		cwd: "/tmp/projA",
		userText: "轨迹问题",
		assistantText: "轨迹回答",
	});
	// 对话线程 fixture（chatDir 下）
	const chatHttpDir = path.join(tmp, "chat-http");
	writePiSessionFile(path.join(chatHttpDir, "pi", "chat-sess-1", "sessions", "2026-01-01T00-00-00-000Z_thread-a.jsonl"), {
		id: "thread-a",
		cwd: "/tmp/projA",
		userText: "<trajectory_index>x</trajectory_index>\n问题 A",
		assistantText: "答复 A",
		modelId: "fake-thread",
	});
	fs.mkdirSync(path.join(chatHttpDir, "pi", "chat-sess-1", "meta"), { recursive: true });
	fs.writeFileSync(
		path.join(chatHttpDir, "pi", "chat-sess-1", "meta", "turns.jsonl"),
		JSON.stringify({ ordinal: 1, displayText: "问题 A", contextRefs: [{ id: "a1:p2", kind: "tool", label: "工具", preview: "bash" }] }) + "\n",
	);

	const traceFile = path.join(tmp, "pi-trace.log");
	process.env.FAKE_PI_TRACE = traceFile;
	const handle = await createTrajectoryServer({
		scope: "all",
		webDir: WEB,
		sessionsRoot,
		codexRoot,
		port: 0,
		chat: true,
		chatDir: chatHttpDir,
		piBin: fakePi,
	});
	const capHttp = await (await fetch(`${handle.url}api/chat/capabilities`)).json();
	check("HTTP：capabilities 200 且 enabled", capHttp.enabled === true && capHttp.piVersion === "1.5.0", JSON.stringify(capHttp));
	const health = await (await fetch(`${handle.url}api/health`)).json();
	check("HTTP：轨迹 health 不受影响", health.ok === true && health.scope === "all");
	check("HTTP：未实现的 chat 路由 501", (await fetch(`${handle.url}api/chat/approval?source=pi&session=chat-sess-1`)).status === 501);

	const threadUrl = (thread) =>
		`${handle.url}api/chat/thread?source=pi&session=chat-sess-1${thread ? `&thread=${encodeURIComponent(thread)}` : ""}`;
	const threadLatest = await (await fetch(threadUrl())).json();
	check(
		"HTTP：GET thread 取最新",
		threadLatest.thread?.id === "thread-a" && threadLatest.thread.exists === true,
		JSON.stringify(threadLatest).slice(0, 300),
	);
	check(
		"HTTP：thread 消息映射",
		threadLatest.thread.messages.map((m) => m.role).join(",") === "user,tool,assistant",
		JSON.stringify(threadLatest.thread.messages.map((m) => m.role)),
	);
	check(
		"HTTP：displayText/context 来自 turns",
		threadLatest.thread.messages[0].displayText === "问题 A" && threadLatest.thread.messages[0].context.length === 1,
	);
	const threadExplicit = await (await fetch(threadUrl("thread-a"))).json();
	check("HTTP：GET thread 按 id", threadExplicit.thread?.id === "thread-a" && threadExplicit.thread.exists === true);
	const threadMissing = await (await fetch(threadUrl("missing-1"))).json();
	check(
		"HTTP：不存在的 thread 返回 exists=false + warnings",
		threadMissing.thread?.exists === false && threadMissing.warnings.length === 1,
		JSON.stringify(threadMissing).slice(0, 200),
	);
	check("HTTP：非法 thread 400", (await fetch(threadUrl("../x"))).status === 400);
	check("HTTP：缺 source 400", (await fetch(`${handle.url}api/chat/thread?session=chat-sess-1`)).status === 400);
	check("HTTP：未知 session 404", (await fetch(`${handle.url}api/chat/thread?source=pi&session=nope`)).status === 404);

	const postThread = await fetch(`${handle.url}api/chat/thread`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source: "pi", session: "chat-sess-1" }),
	});
	const postThreadBody = await postThread.json();
	check(
		"HTTP：POST thread 返回 pi session id",
		postThread.ok && typeof postThreadBody.thread?.id === "string" && postThreadBody.thread.exists === false,
		JSON.stringify(postThreadBody).slice(0, 300),
	);
	const afterPost = await (await fetch(threadUrl(postThreadBody.thread.id))).json();
	check("HTTP：新线程文件未生成时 exists=false", afterPost.thread?.exists === false && afterPost.thread.id === postThreadBody.thread.id);
	check(
		"HTTP：POST thread 非法 JSON 400",
		(
			await fetch(`${handle.url}api/chat/thread`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			})
		).status === 400,
	);

	const listingPi = await (await fetch(`${handle.url}api/sessions?source=pi`)).json();
	check(
		"HTTP：/api/sessions 不含 chat 文件",
		listingPi.sessions.length === 1 && !listingPi.sessions.some((item) => item.id === "thread-a"),
		JSON.stringify(listingPi.sessions.map((item) => item.id)),
	);

	// ---- T4：模型列表 ----
	const modelsUrl = (extra = "") => `${handle.url}api/chat/models?source=pi&session=chat-sess-1${extra}`;
	const modelsPlain = await (await fetch(modelsUrl())).json();
	check(
		"HTTP models：两个模型且 current=child 当前模型",
		Array.isArray(modelsPlain.models) && modelsPlain.models.length === 2 && modelsPlain.current?.id === "fake-1",
		JSON.stringify(modelsPlain).slice(0, 300),
	);
	check("HTTP models：refreshedAt 有值", typeof modelsPlain.refreshedAt === "string" && modelsPlain.refreshedAt.length > 0, String(modelsPlain.refreshedAt));
	check(
		"HTTP models：字段白名单",
		modelsPlain.models.every((m) => Object.keys(m).sort().join(",") === "contextWindow,id,maxTokens,name,provider,providerName,reasoning"),
		JSON.stringify(modelsPlain.models[0]),
	);
	check(
		"HTTP models：无敏感字段",
		!/sk-fake-secret|fake-header|fake-one\.invalid|fake-two\.invalid|fake-oauth|apiKey|baseUrl|headers|oauth/.test(JSON.stringify(modelsPlain)),
		JSON.stringify(modelsPlain).slice(0, 500),
	);
	const modelsThread = await (await fetch(modelsUrl("&thread=thread-a"))).json();
	check(
		"HTTP models：带 thread 读文件里的模型",
		modelsThread.current?.provider === "fake" && modelsThread.current?.id === "fake-thread",
		JSON.stringify(modelsThread.current),
	);
	check("HTTP models：带 thread 不切 child", (await (await fetch(modelsUrl())).json()).current?.id === "fake-1");
	const traceAfterThreadModels = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "";
	check("HTTP models：带 thread 不触发 switch_session", !traceAfterThreadModels.includes("switch_session:"), traceAfterThreadModels);
	check("HTTP models：thread 非法 400", (await fetch(modelsUrl("&thread=../x"))).status === 400);
	check(
		"HTTP models：thread 不存在 404",
		(await fetch(`${handle.url}api/chat/models?source=pi&session=chat-sess-1&thread=nope`)).status === 404,
	);
	check("HTTP models：未知 session 404", (await fetch(`${handle.url}api/chat/models?source=pi&session=nope`)).status === 404);
	check("HTTP models：GET /api/chat/model 405", (await fetch(`${handle.url}api/chat/model`)).status === 405);
	check("HTTP models：POST /api/chat/models 405", (await postJson(`${handle.url}api/chat/models`, { source: "pi", session: "chat-sess-1" })).status === 405);

	// ---- T3：send/stop（fake child 的 SSE 集成） ----
	const chatBody = (prompt, extra = {}) => ({ source: "pi", session: "chat-sess-1", prompt, ...extra });
	const send = (prompt, extra = {}) =>
		fetch(`${handle.url}api/chat/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(chatBody(prompt, extra)),
		});

	const firstRes = await send("hi");
	check("send：200", firstRes.status === 200, String(firstRes.status));
	check("send：text/event-stream; charset=utf-8", (firstRes.headers.get("content-type") ?? "").startsWith("text/event-stream"));
	const first = await readSse(firstRes);
	check(
		"SSE：meta 首事件（切到最新线程）",
		first.events[0]?.event === "meta" && first.events[0].data.threadId === "thread-a",
		JSON.stringify(first.events[0]),
	);
	check("SSE：meta 含 model/profile", first.events[0].data.model?.id === "fake-1" && first.events[0].data.profile === "read-only", JSON.stringify(first.events[0].data));
	check(
		"SSE：delta 拼接",
		first.events.filter((e) => e.event === "delta").map((e) => e.data.text).join("") === "你好，世界",
		JSON.stringify(first.events),
	);
	const doneEvents = first.events.filter((e) => e.event === "done");
	check(
		"SSE：done 唯一，usage/duration/stopReason 来自最后 assistant",
		doneEvents.length === 1 &&
			first.events.at(-1).event === "done" &&
			doneEvents[0].data.usage?.totalTokens === 15 &&
			doneEvents[0].data.durationMs === 123 &&
			doneEvents[0].data.stopReason === "stop",
		JSON.stringify(first.events.at(-1)),
	);

	const think = await readSse(await send("think"));
	const statuses = think.events.filter((e) => e.event === "status");
	check("SSE：首个 thinking_delta 只发一次 status", statuses.length === 1 && statuses[0].data.phase === "thinking", JSON.stringify(statuses));
	check(
		"SSE：status 在 delta 之前",
		think.events.findIndex((e) => e.event === "status") < think.events.findIndex((e) => e.event === "delta"),
	);

	const tool = await readSse(await send("tool"));
	const toolEvents = tool.events.filter((e) => e.event === "tool");
	check(
		"SSE：tool start/end 映射",
		toolEvents.length === 2 &&
			toolEvents[0].data.phase === "start" &&
			toolEvents[0].data.toolCallId === "call_1" &&
			toolEvents[0].data.toolName === "read" &&
			toolEvents[0].data.argsPreview.includes("README") &&
			toolEvents[1].data.phase === "end" &&
			toolEvents[1].data.resultPreview.includes("# README") &&
			toolEvents[1].data.isError === false,
		JSON.stringify(toolEvents),
	);

	const statusOf = async (body) => (await postJson(`${handle.url}api/chat/send`, body)).status;
	check("send：空 prompt 400", (await statusOf(chatBody("   "))) === 400);
	check("send：prompt 超长 400", (await statusOf(chatBody("x".repeat(32001)))) === 400);
	check("send：非法 threadId 400", (await statusOf(chatBody("hi", { threadId: "../x" }))) === 400);
	check("send：未知 session 404", (await statusOf({ source: "pi", session: "nope", prompt: "hi" })) === 404);
	check("send：缺 source 400", (await statusOf({ session: "chat-sess-1", prompt: "hi" })) === 400);

	const slowRes = await send("slow");
	const slowRead = readSse(slowRes);
	await sleep(150);
	const conflict = await postJson(`${handle.url}api/chat/send`, chatBody("second"));
	check("send：同 child 已有 turn 时 409", conflict.status === 409, String(conflict.status));
	const stopRes = await postJson(`${handle.url}api/chat/stop`, { source: "pi", session: "chat-sess-1", threadId: "thread-a" });
	const stopBody = await stopRes.json();
	check("stop：{ok,stopped:true}", stopRes.status === 200 && stopBody.ok === true && stopBody.stopped === true, JSON.stringify(stopBody));
	const slow = await slowRead;
	check(
		"stop 后 done stopReason=aborted",
		slow.events.some((e) => e.event === "done" && e.data.stopReason === "aborted"),
		JSON.stringify(slow.events.at(-1)),
	);
	const idleStop = await (await postJson(`${handle.url}api/chat/stop`, { source: "pi", session: "chat-sess-1" })).json();
	check("stop：无活动 turn 时 stopped=false", idleStop.ok === true && idleStop.stopped === false, JSON.stringify(idleStop));

	const fresh = await readSse(await send("hi", { threadId: "missing-1" }));
	check(
		"send：不存在的 threadId 用 --session-id 新建",
		fresh.events[0]?.data.threadId === "missing-1",
		JSON.stringify(fresh.events[0]),
	);
	const back = await readSse(await send("hi", { threadId: "thread-a" }));
	check("send：已有线程先 switch_session", back.events[0]?.data.threadId === "thread-a", JSON.stringify(back.events[0]));

	// ---- T4：切换模型（先 switch_session 再 set_model） ----
	const threadBFile = path.join(chatHttpDir, "pi", "chat-sess-1", "sessions", "2026-01-01T00-00-00-000Z_thread-b.jsonl");
	writePiSessionFile(threadBFile, { id: "thread-b", cwd: "/tmp/projA", userText: "问题 B", modelId: "fake-thread-b" });
	const traceBeforeSwitch = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "";
	const switchedModel = await postJson(`${handle.url}api/chat/model`, {
		source: "pi",
		session: "chat-sess-1",
		threadId: "thread-b",
		provider: "other",
		id: "fake-2",
	});
	const switchedBody = await switchedModel.json();
	check(
		"POST model：200 + 脱敏返回",
		switchedModel.ok && switchedBody.ok === true && switchedBody.model?.id === "fake-2" && !/sk-fake|baseUrl|headers|apiKey/.test(JSON.stringify(switchedBody)),
		JSON.stringify(switchedBody).slice(0, 300),
	);
	const traceAfterSwitch = fs.readFileSync(traceFile, "utf8").slice(traceBeforeSwitch.length);
	const switchIdx = traceAfterSwitch.indexOf("switch_session:");
	const setIdx = traceAfterSwitch.indexOf("set_model:");
	check(
		"POST model：先 switch_session 再 set_model",
		switchIdx >= 0 && setIdx > switchIdx && /thread-b\.jsonl/.test(traceAfterSwitch.slice(switchIdx, setIdx)),
		traceAfterSwitch,
	);
	check("POST model：threadId 返回目标线程", switchedBody.threadId === "thread-b", String(switchedBody.threadId));
	const afterModel = await (await fetch(modelsUrl())).json();
	check("POST model：GET current 反映新模型", afterModel.current?.provider === "other" && afterModel.current?.id === "fake-2", JSON.stringify(afterModel.current));
	const modelPost = (body) => postJson(`${handle.url}api/chat/model`, { source: "pi", session: "chat-sess-1", ...body });
	check("POST model：未知模型 400", (await modelPost({ provider: "fake", id: "nope" })).status === 400);
	check("POST model：缺 provider 400", (await modelPost({ id: "fake-1" })).status === 400);
	check("POST model：缺 id 400", (await modelPost({ provider: "fake" })).status === 400);
	check("POST model：非法 threadId 400", (await modelPost({ threadId: "../x", provider: "fake", id: "fake-1" })).status === 400);
	check("POST model：线程不存在 404", (await modelPost({ threadId: "no-such", provider: "fake", id: "fake-1" })).status === 404);
	const slowModelRes = await send("slow");
	const slowModelRead = readSse(slowModelRes);
	await sleep(120);
	const conflictModel = await modelPost({ threadId: "thread-b", provider: "fake", id: "fake-1" });
	check("POST model：活动 turn 409", conflictModel.status === 409, String(conflictModel.status));
	await postJson(`${handle.url}api/chat/stop`, { source: "pi", session: "chat-sess-1" });
	await slowModelRead;

	// ---- T5：技能选择 / 大小守卫 / 直输 / ordinal / turns ----
	const skillMetaDir = path.join(chatHttpDir, "pi", "chat-sess-1", "meta");
	chatSession.upsertTurn(skillMetaDir, { ordinal: 5, displayText: "占位" });
	const traceBeforeSkill = fs.readFileSync(traceFile, "utf8");
	const bigSkill = await readSse(await send("hi", { threadId: "thread-b", skill: "big" }));
	const bigMeta = bigSkill.events.find((e) => e.event === "meta")?.data ?? {};
	check(
		"send skill：meta.userOrdinal 按投影 user 数（旧线程无 turns）",
		bigMeta.userOrdinal === 2,
		JSON.stringify(bigMeta),
	);
	check(
		"send skill：>32k 仅 warning 不拒绝",
		bigMeta.skill?.name === "big" && bigMeta.skill?.warning === true && bigMeta.skill?.chars > 32000,
		JSON.stringify(bigMeta.skill),
	);
	const traceAfterBig = fs.readFileSync(traceFile, "utf8").slice(traceBeforeSkill.length);
	check("send skill：prompt 拼 /skill:name 前缀", traceAfterBig.includes('prompt:"/skill:big\\n\\nhi"'), traceAfterBig);
	const bigTurn = chatSession.readTurns(skillMetaDir).find((turn) => turn.ordinal === 2);
	check(
		"send skill：upsertTurn 写 displayText/skill/contextRefs",
		bigTurn?.displayText === "hi" && bigTurn?.skill?.name === "big" && Array.isArray(bigTurn?.contextRefs) && bigTurn?.profile === "read-only",
		JSON.stringify(bigTurn),
	);
	const hugeRes = await postJson(`${handle.url}api/chat/send`, { source: "pi", session: "chat-sess-1", threadId: "thread-b", prompt: "hi", skill: "huge" });
	check("send skill：>200k 拒绝 400", hugeRes.status === 400, String(hugeRes.status));
	const unknownRes = await postJson(`${handle.url}api/chat/send`, { source: "pi", session: "chat-sess-1", threadId: "thread-b", prompt: "hi", skill: "nope" });
	check("send skill：未知技能 400", unknownRes.status === 400, String(unknownRes.status));

	const traceBeforeDirect = fs.readFileSync(traceFile, "utf8");
	const directSkill = await readSse(await send("/skill:demo 你好", { threadId: "thread-b" }));
	const directMeta = directSkill.events.find((e) => e.event === "meta")?.data ?? {};
	check(
		"直输 /skill: 解析并透传（不重复加前缀）",
		directMeta.skill?.name === "demo" && directMeta.skill?.chars > 0,
		JSON.stringify(directMeta.skill),
	);
	const directTrace = fs.readFileSync(traceFile, "utf8").slice(traceBeforeDirect.length);
	check(
		"直输 /skill: 原样发送且只出现一次前缀",
		directTrace.includes('prompt:"/skill:demo 你好"') && (directTrace.match(/\/skill:demo/g) ?? []).length === 1,
		directTrace,
	);
	const traceBeforeUnknownDirect = fs.readFileSync(traceFile, "utf8");
	const unknownDirect = await readSse(await send("/skill:nope 你好", { threadId: "thread-b" }));
	const unknownMeta = unknownDirect.events.find((e) => e.event === "meta")?.data ?? {};
	const unknownTrace = fs.readFileSync(traceFile, "utf8").slice(traceBeforeUnknownDirect.length);
	check(
		"直输未知技能：pi 行为透传（200 + 原文）",
		unknownMeta.skill?.name === "nope" && unknownMeta.skill?.chars === null && unknownTrace.includes('prompt:"/skill:nope 你好"'),
		JSON.stringify(unknownMeta.skill),
	);

	const crash = await readSse(await send("exit"));
	check(
		"send：child exit 中途退出 → error 事件",
		crash.events.some((e) => e.event === "error" && e.data.code === "child_exit"),
		JSON.stringify(crash.events.at(-1)),
	);

	await handle.close();
	delete process.env.FAKE_PI_TRACE;

	const noChat = await createTrajectoryServer({
		scope: "all",
		webDir: WEB,
		sessionsRoot,
		codexRoot,
		port: 0,
	});
	const noChatCap = await (await fetch(`${noChat.url}api/chat/capabilities`)).json();
	check("HTTP：未启用 chat 时 capabilities disabled", noChatCap.enabled === false && typeof noChatCap.reason === "string");
	check("HTTP：未启用 chat 时其它路由 501", (await fetch(`${noChat.url}api/chat/models`)).status === 501);
	await noChat.close();

	// ---- 真 pi RPC 冒烟（可选） ----
	if (process.env.PI_CHAT_SKIP_REAL === "1") {
		console.log("SKIP 真 pi 冒烟（PI_CHAT_SKIP_REAL=1）");
	} else {
		const probed = await probeFirstPi({ env: process.env, homeDir: os.homedir() });
		if (!probed.ok) {
			console.log("SKIP 真 pi 冒烟：未找到 pi");
		} else {
			const real = new RpcChild({
				pi: probed.pi,
				args: [
					"--no-tools",
					"--no-extensions",
					"--no-context-files",
					"--no-skills",
					"--session-dir",
					path.join(tmp, "real-pi"),
					"--session-id",
					"smoke",
				],
				cwd: tmp,
				log: () => {},
			}).start();
			try {
				const realState = await real.send({ type: "get_state" }, { timeoutMs: 20000 });
				check(`真 pi：${probed.version.raw} get_state`, typeof realState.data?.sessionId === "string", JSON.stringify(realState).slice(0, 300));
			} catch (err) {
				check("真 pi：get_state", false, err.message);
			} finally {
				await real.close({ graceMs: 2000 });
			}
		}
	}

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
	process.exitCode = failed ? 1 : 0;
})().catch((err) => {
	console.error("测试异常：", err);
	process.exit(1);
});
