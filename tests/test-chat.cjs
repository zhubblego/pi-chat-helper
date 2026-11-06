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
function writePiSessionFile(file, { id, cwd, userText, assistantText = "答复" }) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lines = [
		{ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.100Z", provider: "fake", modelId: "fake-1" },
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
	const { RpcChild, createChatHost, checkChatDir, isPathInside, resolveAgentDir } = await import(urlOf("trajectory-web/server/chat-host.mjs"));
	const chatSession = await import(urlOf("trajectory-web/server/chat-session.mjs"));
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
	});
	fs.mkdirSync(path.join(chatHttpDir, "pi", "chat-sess-1", "meta"), { recursive: true });
	fs.writeFileSync(
		path.join(chatHttpDir, "pi", "chat-sess-1", "meta", "turns.jsonl"),
		JSON.stringify({ ordinal: 1, displayText: "问题 A", contextRefs: [{ id: "a1:p2", kind: "tool", label: "工具", preview: "bash" }] }) + "\n",
	);

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
	check("HTTP：未实现的 chat 路由 501", (await fetch(`${handle.url}api/chat/models`)).status === 501);

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

	await handle.close();

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
