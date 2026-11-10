// state-db.mjs：schema / WAL / CRUD / 迁移 / 权限 / 不可用降级（S1）
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, cond ? "" : extra);
	if (!cond) failed++;
};
const throws = (fn, code = null) => {
	try {
		fn();
		return false;
	} catch (err) {
		return code ? err.code === code : true;
	}
};

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-state-"));
const now = () => "2026-11-10T00:00:00.000Z";

function sessionDir(chatDir, source, session) {
	const dir = path.join(chatDir, source, session, "meta");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}
function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}
function writeLines(file, lines) {
	fs.writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
}

(async () => {
	const stateDb = await import(pathToFileURL(path.join(ROOT, "trajectory-web", "server", "state-db.mjs")).href);

	// ---- 打开 / schema / 文件权限 ----
	const agentDir = path.join(tmp, "agent-main");
	const chatDir = path.join(agentDir, "pi-chat-helper", "chats");
	fs.mkdirSync(chatDir, { recursive: true });
	let state = stateDb.openStateDb({ agentDir, chatDir, now });
	check("打开：capabilities.ok", state.ok === true && state.capabilities.ok === true, JSON.stringify(state.capabilities));
	check("打开：WAL", state.capabilities.journalMode === "wal", JSON.stringify(state.capabilities));
	check("打开：schema 版本", state.capabilities.schemaVersion === 1);
	check("打开：默认路径在 agentDir 下", state.path === path.join(agentDir, "pi-chat-helper", "state.db"), state.path);
	if (process.platform !== "win32") {
		check("权限：state.db 0600", (fs.statSync(state.path).mode & 0o777) === 0o600, fs.statSync(state.path).mode.toString(8));
		check(
			"权限：pi-chat-helper 目录 0700",
			(fs.statSync(path.dirname(state.path)).mode & 0o777) === 0o700,
			fs.statSync(path.dirname(state.path)).mode.toString(8),
		);
	}
	check("迁移：无旧文件也完成标记", state.lastMigration.skipped === false && state.lastMigration.projects === 0);

	// ---- 全局偏好 / revision / 重开持久化 ----
	check("prefs：初始 revision 0", state.getGlobalPrefs().revision === 0 && Object.keys(state.getGlobalPrefs().global).length === 0);
	const wrote = state.setGlobalPrefs({
		theme: "dark",
		filters: { tools: true },
		tools: { excluded: ["bash"], excludeAll: false },
		chatWidth: 440,
	});
	check(
		"prefs：写入并返回 revision",
		wrote.revision === 1 && wrote.global.theme === "dark" && wrote.global.chatWidth === 440,
		JSON.stringify(wrote),
	);
	check("prefs：未知 key 拒绝", throws(() => state.setGlobalPrefs({ nope: true })));
	check("prefs：不可序列化值拒绝", throws(() => state.setGlobalPrefs({ theme: 1n })));
	state.close();
	state = stateDb.openStateDb({ agentDir, chatDir, now });
	check("prefs：重开后持久", state.getGlobalPrefs().global.theme === "dark" && state.getGlobalPrefs().revision === 1);
	check("prefs：再次写入 revision 递增", state.setGlobalPrefs({ theme: "light" }).revision === 2);

	// ---- session UI ----
	const defaultSession = state.getSessionUi("pi", "sess-a");
	check(
		"session：默认值",
		defaultSession.threadId === null &&
			defaultSession.threadNew === false &&
			defaultSession.mode === "independent" &&
			defaultSession.contextIds.length === 0,
		JSON.stringify(defaultSession),
	);
	const sessionWritten = state.setSessionUi("pi", "sess-a", {
		threadId: "thread-1",
		threadNew: true,
		mode: "forward",
		contextIds: ["u1:0", "a1:0", "u1:0"],
	});
	check(
		"session：写入 / contextIds 去重",
		sessionWritten.threadId === "thread-1" &&
			sessionWritten.threadNew === true &&
			sessionWritten.mode === "forward" &&
			sessionWritten.contextIds.join(",") === "u1:0,a1:0",
		JSON.stringify(sessionWritten),
	);
	check("session：未知字段拒绝", throws(() => state.setSessionUi("pi", "sess-a", { bogus: true })));
	check("session：非法 mode 拒绝", throws(() => state.setSessionUi("pi", "sess-a", { mode: "bad" })));
	state.setSessionUi("pi", "sess-a", { threadId: null, threadNew: false });
	const sessionMerged = state.getSessionUi("pi", "sess-a");
	check(
		"session：局部更新保留其它字段",
		sessionMerged.threadId === null && sessionMerged.threadNew === false && sessionMerged.mode === "forward",
		JSON.stringify(sessionMerged),
	);
	check("session：不同会话隔离", state.getSessionUi("pi", "sess-b").mode === "independent");

	// ---- chat project ----
	const projectDefault = state.getChatProject("pi", path.join(tmp, "project-a"));
	check("project：默认 read-only/false", projectDefault.profile === "read-only" && projectDefault.projectSkills === false);
	const projectWritten = state.setChatProject("pi", path.join(tmp, "project-a"), { profile: "full", projectSkills: true });
	check(
		"project：写入 profile/projectSkills",
		projectWritten.profile === "full" && projectWritten.projectSkills === true,
		JSON.stringify(projectWritten),
	);
	check(
		"project：按 source/project 隔离",
		state.getChatProject("pi", path.join(tmp, "project-b")).profile === "read-only",
	);
	check("project：非法字段拒绝", throws(() => state.setChatProject("pi", path.join(tmp, "project-a"), { nope: 1 })));
	check("project：非法 profile 归一为默认", state.setChatProject("pi", path.join(tmp, "project-a"), { profile: "bogus" }).profile === "read-only");

	// ---- turns ----
	state.upsertTurn("pi", "sess-a", { threadId: "t1", ordinal: 2, displayText: "二" });
	state.upsertTurn("pi", "sess-a", { threadId: "t1", ordinal: 1, displayText: "旧" });
	state.upsertTurn("pi", "sess-a", { threadId: "t1", ordinal: 1, displayText: "新" });
	state.upsertTurn("pi", "sess-a", { threadId: "t2", ordinal: 1, displayText: "另一线程" });
	const t1 = state.readTurns("pi", "sess-a", "t1");
	check(
		"turns：按 ordinal 排序 + 同键覆盖",
		t1.length === 2 && t1[0].ordinal === 1 && t1[0].displayText === "新" && t1[1].ordinal === 2,
		JSON.stringify(t1),
	);
	check("turns：不同线程不覆盖", state.readTurns("pi", "sess-a", "t2").length === 1);
	check("turns：不传 thread 返回全部", state.readTurns("pi", "sess-a").length === 3);
	check("turns：非整数 ordinal 拒绝", throws(() => state.upsertTurn("pi", "sess-a", { threadId: "t1", ordinal: 1.5 })));
	check("turns：缺 threadId 拒绝", throws(() => state.upsertTurn("pi", "sess-a", { ordinal: 1 })));
	check("turns：不同会话隔离", state.readTurns("pi", "sess-b").length === 0);

	// ---- context ----
	state.writeContext("pi", "sess-a", "active", { source: "pi", sessionId: "sess-a", items: [{ id: "a" }] });
	state.writeContextNext("pi", "sess-a", { source: "pi", sessionId: "sess-a", items: [{ id: "b" }] });
	check("context：active/next 分别可读", state.readContext("pi", "sess-a", "active").items[0].id === "a" && state.readContext("pi", "sess-a", "next").items[0].id === "b");
	const promoted = state.promoteContext("pi", "sess-a");
	check("context：promote 后 active=next", promoted.items[0].id === "b", JSON.stringify(promoted));
	check("context：promote 后 next 清空", state.readContext("pi", "sess-a", "next").items.length === 0);
	check("context：无 active 返回空清单", state.readContext("pi", "sess-b").items.length === 0);
	check("context：非法 kind 拒绝", throws(() => state.readContext("pi", "sess-a", "bad")));
	check("context：非法 snapshot 拒绝", throws(() => state.writeContext("pi", "sess-a", "active", { noItems: true })));

	// ---- 两个连接共享同一库 ----
	const second = stateDb.openStateDb({ agentDir, chatDir, now });
	state.setGlobalPrefs({ theme: "shared" });
	check("多连接：第二个连接读到新值", second.getGlobalPrefs().global.theme === "shared");
	second.close();

	// 真正跨进程：持久的 WAL 写入应被另一个 node 进程看到。
	const childScript = `
		import { openStateDb } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "trajectory-web", "server", "state-db.mjs")).href)};
		const s = openStateDb({ agentDir: ${JSON.stringify(agentDir)}, chatDir: ${JSON.stringify(chatDir)} });
		s.setGlobalPrefs({ theme: "child" });
		s.close();
	`;
	execFileSync(process.execPath, ["--input-type=module", "-e", childScript], { stdio: "pipe" });
	check("多进程：父进程读到子进程写入", state.getGlobalPrefs().global.theme === "child");

	// ---- 旧 JSON/JSONL 迁移 ----
	const legacyAgent = path.join(tmp, "agent-legacy");
	const legacyChat = path.join(legacyAgent, "pi-chat-helper", "chats");
	writeJson(path.join(legacyChat, "settings.json"), {
		version: 1,
		projects: {
			"pi:/proj/one": { profile: "full", projectSkills: true },
			"pi:/proj/bad": { profile: "bogus", projectSkills: "yes" },
		},
	});
	const legacyMeta = sessionDir(legacyChat, "pi", "legacy-dir");
	const legacyNoctxMeta = sessionDir(legacyChat, "pi", "legacy-noctx");
	writeLines(path.join(legacyNoctxMeta, "turns.jsonl"), [{ threadId: "noctx-t", ordinal: 1, displayText: "无 context" }]);
	writeLines(path.join(legacyMeta, "turns.jsonl"), [
		{ threadId: "lt1", ordinal: 1, displayText: "old" },
		{ threadId: "lt1", ordinal: 2, displayText: "two" },
		{ threadId: "lt1", ordinal: 1, displayText: "new" },
		"{bad-json",
		{ ordinal: 3, displayText: "no-thread" },
	]);
	writeJson(path.join(legacyMeta, "context.active.json"), {
		source: "pi",
		sessionId: "sess-legacy",
		items: [{ id: "legacy-a" }],
	});
	writeJson(path.join(legacyMeta, "context.next.json"), {
		source: "pi",
		sessionId: "sess-legacy",
		items: [{ id: "legacy-b" }],
	});

	const legacy = stateDb.openStateDb({ agentDir: legacyAgent, chatDir: legacyChat, now });
	check("迁移：打开成功", legacy.ok === true, JSON.stringify(legacy.capabilities));
	check("迁移：settings 项目导入", legacy.getChatProject("pi", "/proj/one").profile === "full" && legacy.getChatProject("pi", "/proj/one").projectSkills === true);
	check("迁移：非法 profile 归一", legacy.getChatProject("pi", "/proj/bad").profile === "read-only");
	const legacyTurns = legacy.readTurns("pi", "sess-legacy", "lt1");
	check(
		"迁移：turns 去重 / 排序 / 无 threadId 跳过",
		legacyTurns.length === 2 && legacyTurns[0].displayText === "new" && legacyTurns[1].ordinal === 2,
		JSON.stringify(legacyTurns),
	);
	check("迁移：context active/next 导入", legacy.readContext("pi", "sess-legacy", "active").items[0].id === "legacy-a" && legacy.readContext("pi", "sess-legacy", "next").items[0].id === "legacy-b");
	check("迁移：无 context 时 turns 用目录 sessionId", legacy.readTurns("pi", "legacy-noctx", "noctx-t").length === 1);
	check("迁移：旧文件保留", fs.existsSync(path.join(legacyChat, "settings.json")) && fs.existsSync(path.join(legacyMeta, "turns.jsonl")));
	check("迁移：迁移标记", legacy.lastMigration.skipped === false && legacy.lastMigration.projects === 2, JSON.stringify(legacy.lastMigration));
	legacy.close();
	const legacyAgain = stateDb.openStateDb({ agentDir: legacyAgent, chatDir: legacyChat, now });
	check("迁移：重复打开不重复导入", legacyAgain.lastMigration.skipped === true && legacyAgain.readTurns("pi", "sess-legacy", "lt1").length === 2);
	// 删除旧文件后仍应从 DB 读到，证明 sidecar 已是真源。
	fs.rmSync(path.join(legacyChat, "settings.json"));
	fs.rmSync(path.join(legacyMeta, "turns.jsonl"));
	fs.rmSync(path.join(legacyMeta, "context.active.json"));
	fs.rmSync(path.join(legacyMeta, "context.next.json"));
	legacyAgain.close();
	const legacyAfterDelete = stateDb.openStateDb({ agentDir: legacyAgent, chatDir: legacyChat, now });
	check(
		"迁移：旧文件删除后 DB 仍可用",
		legacyAfterDelete.readTurns("pi", "sess-legacy", "lt1").length === 2 &&
			legacyAfterDelete.getChatProject("pi", "/proj/one").profile === "full",
	);
	legacyAfterDelete.close();

	// ---- 损坏路径：返回不可用而不是抛到调用方 ----
	const badPath = path.join(tmp, "not-a-db");
	fs.mkdirSync(badPath);
	const bad = stateDb.openStateDb({ agentDir, chatDir, stateDbPath: badPath, now });
	check("不可用：capabilities.ok=false", bad.ok === false && bad.capabilities.ok === false, JSON.stringify(bad.capabilities));
	check("不可用：reason 可展示", typeof bad.capabilities.reason === "string" && bad.capabilities.reason.length > 0);
	check("不可用：读取抛 state_db_unavailable", throws(() => bad.getGlobalPrefs(), "state_db_unavailable"));
	check("不可用：migrateLegacy 跳过", bad.migrateLegacy().skipped === true);
	bad.close();

	state.close();
	check("close：重复调用安全", (() => {
		state.close();
		return true;
	})());

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
	process.exitCode = failed ? 1 : 0;
})().catch((err) => {
	console.error("测试异常：", err);
	process.exit(1);
});
