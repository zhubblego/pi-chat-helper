// 前端纯函数层：过滤映射 / 预设 / 格式化 / Markdown 转义与渲染
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, cond ? "" : extra);
	if (!cond) failed++;
};

(async () => {
	const lib = await import(pathToFileURL(path.join(__dirname, "..", "trajectory-web", "web", "lib.js")).href);
	const { kindGroup, eventPasses, presetFilters, eventTagLabel, formatDurationMillis, formatElapsedSeconds, fmtTokens, fmtCost, fmtTime, renderMarkdown, fmtRelative, fmtBytes, projectLabel, groupSessions, buildAgentTree, deriveInfo, deriveTargets, deriveTaskName, DERIVE_TOOL, TrajectorySearchIndex, collectToolNames, eventToolPasses, groupToolNames, mcpLabel, highlightSegments, hitSnippet } = lib;

	// ---- SSE 解析（chat-lib.js） ----
	const {
		parseSseChunk,
		parseSseData,
		chatSessionRef,
		isCurrentTurn,
		modelLabel,
		consoleStatusLabel,
		readChatMode,
		writeChatMode,
		forwardStatusLabel,
		forwardDeliveryLabel,
		forwardFailureText,
		formatChars,
		formatContextWindow,
		computeAnchoredMenuPosition,
		contextSummaryLabel,
		filterPaletteItems,
		normalizeContextIds,
		mergeContextIds,
		pruneContextIds,
		readThreadId,
		rememberThread,
		forgetThread,
	} = await import(pathToFileURL(path.join(__dirname, "..", "trajectory-web", "web", "chat-lib.js")).href);
	// ---- 全局偏好迁移纯函数（prefs.js） ----
	const prefs = await import(pathToFileURL(path.join(__dirname, "..", "trajectory-web", "web", "prefs.js")).href);
	const legacyMap = new Map([
		["tw.filters", JSON.stringify({ user: false, tools: false })],
		["tw.tools", JSON.stringify({ excluded: ["bash", "bash", "", 3], excludeAll: true })],
		["tw.theme", "dark"],
		["tw.translate", JSON.stringify({ service: "google", to: "en" })],
		["tw.chat", "1"],
		["tw.chatWidth", "512"],
		["tw.composerHeight", "144"],
	]);
	const fakeStorage = {
		getItem: (key) => (legacyMap.has(key) ? legacyMap.get(key) : null),
		removeItem: (key) => legacyMap.delete(key),
	};
	const legacyPrefs = prefs.readLegacyGlobalPrefs(fakeStorage);
	check(
		"prefs：旧全局键映射与规范化",
		legacyPrefs.theme === "dark" &&
			legacyPrefs.filters?.user === false &&
			legacyPrefs.filters?.tools === true &&
			legacyPrefs.tools?.excluded?.join(",") === "bash" &&
			legacyPrefs.tools?.excludeAll === true &&
			legacyPrefs.translate?.service === "google" &&
			legacyPrefs.chatOpen === true &&
			legacyPrefs.chatWidth === 512 &&
			legacyPrefs.composerHeight === 144,
		JSON.stringify(legacyPrefs),
	);
	check(
		"prefs：服务端 global 裁剪未知字段/非法值",
		(() => {
			const out = prefs.normalizeGlobalPrefs({ theme: "neon", chatOpen: "yes", chatWidth: -1, nope: 1, tools: { excluded: ["a"], excludeAll: 1 } });
			return !("theme" in out) && !("chatOpen" in out) && !("chatWidth" in out) && !("nope" in out) && out.tools?.excluded?.join(",") === "a" && out.tools?.excludeAll === false;
		})(),
	);
	prefs.clearLegacyGlobalPrefs(fakeStorage);
	check("prefs：迁移成功后旧键清理", legacyMap.size === 0, JSON.stringify([...legacyMap.keys()]));

	// ---- 会话级偏好迁移纯函数（session-prefs.js） ----
	const sessionPrefs = await import(pathToFileURL(path.join(__dirname, "..", "trajectory-web", "web", "session-prefs.js")).href);
	const sessionMap = new Map([
		["tw.chatThread", JSON.stringify({ "pi:s1": "thread-a", "pi:s2": "thread-b" })],
		["tw.chatThreadNew", JSON.stringify({ "pi:s1": "thread-a" })],
		["tw.chatMode", JSON.stringify({ "pi:s1": "forward" })],
		["tw.chatCtx", JSON.stringify({ "pi:s1": ["u1:0", "u1:0", "a1:0"] })],
	]);
	const sessionStorage = {
		getItem: (key) => (sessionMap.has(key) ? sessionMap.get(key) : null),
		setItem: (key, value) => sessionMap.set(key, value),
		removeItem: (key) => sessionMap.delete(key),
	};
	const legacySession = sessionPrefs.readLegacySessionPrefs("pi:s1", sessionStorage);
	check(
		"session-prefs：旧 thread/new/mode/context 映射与去重",
		legacySession.threadId === "thread-a" &&
			legacySession.threadNew === true &&
			legacySession.mode === "forward" &&
			legacySession.contextIds?.join(",") === "u1:0,a1:0",
		JSON.stringify(legacySession),
	);
	check(
		"session-prefs：默认值与非法值裁剪",
		sessionPrefs.getSessionPrefs("pi", "missing").mode === "independent" &&
			(() => {
				const out = sessionPrefs.normalizeSessionPrefs({ mode: "bad", threadNew: "yes", contextIds: ["x", 1, "x"] });
				return out.mode === undefined && out.threadNew === undefined && out.contextIds?.join(",") === "x";
			})(),
	);
	sessionPrefs.clearLegacySessionPrefs("pi:s1", sessionStorage);
	const remainingThreads = JSON.parse(sessionMap.get("tw.chatThread") || "{}");
	check(
		"session-prefs：只清理当前 key，保留其它会话",
		remainingThreads["pi:s2"] === "thread-b" && !remainingThreads["pi:s1"] && !sessionMap.has("tw.chatMode") && !sessionMap.has("tw.chatCtx"),
		JSON.stringify([...sessionMap.entries()]),
	);

	prefs.clearLegacyGlobalPrefs(fakeStorage);
	check("prefs：迁移成功后旧键清理", legacyMap.size === 0, JSON.stringify([...legacyMap.keys()]));

	const sseOne = parseSseChunk('event: meta\ndata: {"a":1}\n\n');
	check("SSE：单事件", sseOne.events.length === 1 && sseOne.events[0].event === "meta" && sseOne.rest === "", JSON.stringify(sseOne));
	check("SSE：data 可 JSON 解析", parseSseData(sseOne.events[0])?.a === 1);
	const sseMulti = parseSseChunk("event: delta\ndata: a\ndata: b\n\nevent: done\ndata: {}\n\n");
	check("SSE：多行 data 与多事件", sseMulti.events.length === 2 && sseMulti.events[0].data === "a\nb" && sseMulti.events[1].event === "done", JSON.stringify(sseMulti));
	const sseCrlf = parseSseChunk('event: meta\r\ndata: {"x":1}\r\n\r\n');
	check("SSE：CRLF", sseCrlf.events.length === 1 && parseSseData(sseCrlf.events[0])?.x === 1);
	const sseSplit = parseSseChunk('event: delta\ndata: {"text":"你');
	check("SSE：跨 chunk 保留未完成事件", sseSplit.events.length === 0 && sseSplit.rest.includes("data:"), JSON.stringify(sseSplit));
	const sseJoined = parseSseChunk(`${sseSplit.rest}好"}\n\n`);
	check("SSE：拼上下一 chunk 后解析", sseJoined.events.length === 1 && parseSseData(sseJoined.events[0])?.text === "你好", JSON.stringify(sseJoined));
	const sseCrlfSplit = parseSseChunk("event: meta\r\ndata: {}\r");
	check("SSE：结尾孤立的 \\r 不被吞", sseCrlfSplit.events.length === 0 && sseCrlfSplit.rest.endsWith("\r"));
	check("SSE：跨 chunk 的 CRLF", parseSseChunk(`${sseCrlfSplit.rest}\n\r\n`).events.length === 1);
	const sseComment = parseSseChunk(": ping\n\nevent: done\ndata: {}\n\n");
	check("SSE：注释不产生事件", sseComment.events.length === 1 && sseComment.events[0].event === "done", JSON.stringify(sseComment));
	check("SSE：坏 JSON 返回 null", parseSseData({ data: "{bad" }) === null);
	check("SSE：空 data 返回 null", parseSseData({ data: "" }) === null);

	// ---- 会话引用（切源时 sessions 会先清空，不能因此把当前会话当不存在） ----
	const refRemembered = chatSessionRef({ source: "pi", selectedId: "s-1", sessions: [] });
	check(
		"会话引用：sessions 未命中仍返回选中会话",
		refRemembered?.id === "s-1" && refRemembered.source === "pi" && refRemembered.projectPath === null && refRemembered.name === null,
		JSON.stringify(refRemembered),
	);
	const refFound = chatSessionRef({ source: "codex", selectedId: "c-1", sessions: [{ id: "c-1", name: "任务", projectPath: "/tmp/p" }] });
	check("会话引用：命中时带 name/projectPath", refFound?.name === "任务" && refFound.projectPath === "/tmp/p" && refFound.source === "codex");
	check("会话引用：无 selectedId 返回 null", chatSessionRef({ source: "pi", selectedId: null, sessions: [] }) === null);

	// ---- SSE 回调守卫（切会话后旧流不能写新会话） ----
	check("turn 守卫：当前 key 且未收尾通过", isCurrentTurn({ key: "pi:s-1", settled: false }, "pi:s-1") === true);
	check(
		"turn 守卫：settled/key 不同/空 key 均拒绝",
		isCurrentTurn({ key: "pi:s-1", settled: true }, "pi:s-1") === false &&
			isCurrentTurn({ key: "pi:s-1" }, "pi:s-2") === false &&
			isCurrentTurn({ key: "pi:s-1" }, "") === false &&
			isCurrentTurn(null, "pi:s-1") === false,
	);

	// ---- 模型展示与斜杠面板过滤 ----
	check(
		"modelLabel：name 优先 / id 兜底 / 过长截断",
		modelLabel({ name: "GLM-5.3", id: "glm" }) === "GLM-5.3" &&
			modelLabel({ id: "glm-5" }) === "glm-5" &&
			modelLabel({ name: "abcdefghij", id: "x" }, 6) === "abcde…" &&
			modelLabel(null) === "",
	);
	check(
		"consoleStatusLabel：working/idle 文案，离线空串",
		consoleStatusLabel("working") === "控制台运行中" &&
			consoleStatusLabel("idle") === "控制台在线空闲" &&
			consoleStatusLabel("offline") === "" &&
			consoleStatusLabel(null) === "",
	);
	const modeMap = { "pi:a": "forward", "codex:b": "forward" };
	const modeWritten = writeChatMode(modeMap, "pi:c", "forward");
	const modeCleared = writeChatMode(modeWritten, "pi:c", "independent");
	check(
		"chat mode：读取只认 forward / 写入不修改入参 / independent 删除键",
		readChatMode(modeMap, "pi:a") === "forward" &&
			readChatMode(modeMap, "pi:none") === "independent" &&
			readChatMode({ "pi:a": "bogus" }, "pi:a") === "independent" &&
			modeMap["pi:c"] === undefined &&
			modeWritten["pi:c"] === "forward" &&
			modeCleared["pi:c"] === undefined &&
			modeCleared["pi:a"] === "forward",
	);
	check(
		"forward：状态/ delivery / 错误码文案",
		forwardStatusLabel("independent", { state: "working" }) === "控制台运行中" &&
			forwardStatusLabel("forward", null, false) === "未检测到可转发控制台" &&
			forwardStatusLabel("forward", null, true) === "控制台已离线" &&
			forwardDeliveryLabel("now").includes("开始") &&
			forwardDeliveryLabel("followUp").includes("排队") &&
			forwardDeliveryLabel("steer").includes("插话") &&
			forwardFailureText("session_mismatch").includes("其他会话") &&
			forwardFailureText("unknown") === "转发失败",
	);

	const summaryRefs = [
		{ id: "a", label: "模型", preview: "模型 → litellm" },
		{ id: "b", label: "工具", preview: "bash" },
		{ id: "c", label: "回答", preview: "" },
	];
	const summaryOne = contextSummaryLabel(["a"], summaryRefs);
	const summaryThree = contextSummaryLabel(["a", "b", "c"], summaryRefs);
	const summaryLong = contextSummaryLabel(["a"], [{ id: "a", label: "模型", preview: "中".repeat(80) }]);
	const summaryInvalid = contextSummaryLabel(["missing"], summaryRefs);
	check(
		"contextSummaryLabel：单条去重标签 / N>1 给 +K / 空 preview / 失效",
		summaryOne.count === 1 &&
			summaryOne.summary === "模型→litellm" &&
			summaryOne.moreLabel === "" &&
			summaryThree.count === 3 &&
			summaryThree.moreLabel === "+2" &&
			contextSummaryLabel(["c"], summaryRefs).summary === "回答" &&
			summaryInvalid.summary === "失效条目",
		JSON.stringify({ summaryOne, summaryThree, summaryInvalid }),
	);
	check(
		"contextSummaryLabel：preview 按显示宽度截断",
		summaryLong.summary.endsWith("…") && summaryLong.summary.length < 80,
		JSON.stringify(summaryLong),
	);
	const anchorRect = { left: 100, right: 700, top: 500, bottom: 500 };
	const leftTrigger = { left: 350, right: 430, top: 700, bottom: 728 };
	const rightTrigger = { left: 600, right: 680, top: 700, bottom: 728 };
	const leftPos = computeAnchoredMenuPosition({ anchorRect, triggerRect: leftTrigger, offset: 4, align: "left", menuWidth: 144, boundsWidth: 600 });
	const rightPos = computeAnchoredMenuPosition({ anchorRect, triggerRect: rightTrigger, offset: 8, align: "right", menuWidth: 240, boundsWidth: 600 });
	check(
		"锚定换算：左对齐严格贴 trigger / 右对齐贴 anchor 右 / 4px 与 8px",
		leftPos.left === leftTrigger.left - anchorRect.left &&
			leftPos.right === null &&
			leftPos.bottom === -196 &&
			rightPos.left === null &&
			rightPos.right === anchorRect.right - rightTrigger.right &&
			rightPos.bottom === -192,
		JSON.stringify({ leftPos, rightPos }),
	);
	const clampedLeft = computeAnchoredMenuPosition({
		anchorRect,
		triggerRect: { left: 650, right: 730, top: 700, bottom: 728 },
		offset: 4,
		align: "left",
		menuWidth: 200,
		boundsWidth: 600,
	});
	const clampedRight = computeAnchoredMenuPosition({
		anchorRect,
		triggerRect: { left: 40, right: 120, top: 700, bottom: 728 },
		offset: 8,
		align: "right",
		menuWidth: 240,
		boundsWidth: 600,
	});
	const overwide = computeAnchoredMenuPosition({
		anchorRect,
		triggerRect: { left: 200, right: 280, top: 700, bottom: 728 },
		offset: 4,
		align: "left",
		menuWidth: 700,
		boundsWidth: 600,
	});
	const lowPos = computeAnchoredMenuPosition({
		anchorRect,
		triggerRect: { left: 600, right: 680, top: 200, bottom: 228 },
		offset: 8,
		align: "right",
		menuWidth: 240,
		boundsWidth: 600,
	});
	check(
		"锚定换算：可用区 clamp（含菜单超宽）与可用高度下限",
		clampedLeft.left === 400 &&
			clampedRight.right === 360 &&
			overwide.left === 0 &&
			overwide.left >= 0 &&
			lowPos.bottom === 308 &&
			lowPos.maxHeight === 180,
		JSON.stringify({ clampedLeft, clampedRight, overwide, lowPos }),
	);
	check(
		"formatContextWindow：1M/200K/128K/32000",
		formatContextWindow(1000000) === "1M" &&
			formatContextWindow(200000) === "200K" &&
			formatContextWindow(128000) === "128K" &&
			formatContextWindow(32000) === "32000" &&
			formatContextWindow(0) === "" &&
			formatContextWindow(NaN) === "",
	);
	const paletteItems = [
		{ label: "GLM-5.3", hint: "LiteLLM · 推理 · 1M", group: "LiteLLM", search: "glm-5.3 litellm" },
		{ label: "DeepSeek V4", hint: "LiteLLM", group: "LiteLLM", search: "deepseek-v4-pro litellm" },
		{ label: "Claude Sonnet", hint: "Anthropic", group: "Anthropic", search: "claude-sonnet anthropic" },
	];
	check("filterPaletteItems：空查询返回全部", filterPaletteItems(paletteItems, "").length === 3);
	check(
		"filterPaletteItems：多词 AND + 大小写不敏感",
		filterPaletteItems(paletteItems, "LITELLM 推理").length === 1 && filterPaletteItems(paletteItems, "litellm deepseek").length === 1,
	);
	check(
		"filterPaletteItems：匹配 label/hint/group/search",
		filterPaletteItems(paletteItems, "glm").length === 1 &&
			filterPaletteItems(paletteItems, "anthropic").length === 1 &&
			filterPaletteItems(paletteItems, "claude-sonnet").length === 1,
	);
	check("filterPaletteItems：无匹配空数组", filterPaletteItems(paletteItems, "zzz").length === 0);
	const ctxMap = { "pi:s-1": ["a", "a", "b"], "codex:c-1": ["x"] };
	check(
		"normalizeContextIds：去重 + 按会话 key",
		normalizeContextIds(ctxMap, "pi", "s-1").join(",") === "a,b" && normalizeContextIds(ctxMap, "codex", "c-1").join(",") === "x" && normalizeContextIds(ctxMap, "pi", "nope").length === 0,
	);
	const manyIds = Array.from({ length: 60 }, (_, i) => `id-${i}`);
	check("normalizeContextIds：60 条不截断", normalizeContextIds({ "pi:s-1": manyIds }, "pi", "s-1").length === 60);
	const merged = mergeContextIds(ctxMap, "pi:s-2", ["m", "m", "n"]);
	check(
		"mergeContextIds：去重写回且不改原对象",
		merged["pi:s-2"].join(",") === "m,n" && merged["pi:s-1"] === ctxMap["pi:s-1"] && !("pi:s-2" in ctxMap),
	);
	check("mergeContextIds：60 条不截断", mergeContextIds({}, "k", manyIds)["k"].length === 60);
	check(
		"pruneContextIds：Set/对象两种入参",
		pruneContextIds(["a", "b", "c"], new Set(["b", "c"])).join(",") === "b,c" &&
			pruneContextIds(["a", "b"], { a: true }).join(",") === "a",
	);
	const threadMap = {};
	const rememberedThreads = rememberThread(threadMap, "pi:s-1", "thread-a");
	check(
		"thread memory：写入/读取不改原 map",
		readThreadId(rememberedThreads, "pi:s-1") === "thread-a" && readThreadId(threadMap, "pi:s-1") === null,
	);
	const forgottenThreads = forgetThread(rememberedThreads, "pi:s-1");
	check(
		"thread memory：清除后为空",
		readThreadId(forgottenThreads, "pi:s-1") === null && readThreadId(rememberedThreads, "pi:s-1") === "thread-a",
	);
	check(
		"formatChars：900 / 1.8k / 236k / 1.2M / 空值",
		formatChars(900) === "900" &&
			formatChars(1800) === "1.8k" &&
			formatChars(236000) === "236k" &&
			formatChars(1200000) === "1.2M" &&
			formatChars(null) === "" &&
			formatChars(NaN) === "",
	);

	// ---- 搜索高亮切分 ----
	check("高亮：单词命中切分", JSON.stringify(highlightSegments("hello world npm", ["npm"])) === JSON.stringify([{ text: "hello world ", hit: false }, { text: "npm", hit: true }]));
	check("高亮：大小写不敏感", highlightSegments("run NPM install", ["npm"])[1]?.hit === true);
	check("高亮：多词与多次命中", highlightSegments("a.b c a", ["a", "c"]).filter((s) => s.hit).length === 3);
	check("高亮：点号按字面量", highlightSegments("axb", ["a.b"]).every((s) => !s.hit));
	check("高亮：无命中整段", highlightSegments("hello", ["zzz"]).length === 1 && highlightSegments("hello", ["zzz"])[0].hit === false);
	check("高亮：空关键词整段", highlightSegments("hello", []).length === 1 && highlightSegments("hello", [])[0].text === "hello");
	check("高亮：空文本", highlightSegments("", ["a"]).length === 1 && highlightSegments("", ["a"])[0].text === "");

	// ---- 命中字段片段（预览看不到词时给出命中来源与上下文） ----
	const sn1 = hitSnippet({ tool: { result: "第1行超长前缀内容占位占位占位占位\nnpm install ok\n第3行" } }, ["install"]);
	check("片段：结果字段命中带标签", sn1?.label === "结果" && sn1.snippet.includes("npm install ok"), JSON.stringify(sn1));
	const sn2 = hitSnippet({ bash: { command: "git push origin main" } }, ["push"]);
	check("片段：命令字段", sn2?.label === "命令");
	check("片段：无命中返回 null", hitSnippet({ tool: { result: "abc" } }, ["zzz"]) === null);
	check("片段：空关键词返回 null", hitSnippet({ tool: { result: "abc" } }, []) === null);
	check("片段：点号字面量", hitSnippet({ tool: { result: "axb" } }, ["a.b"]) === null);
	const sn3 = hitSnippet({ tool: { result: "a".repeat(200) + "needle" } }, ["needle"]);
	check("片段：长文本窗口截断", sn3?.snippet.startsWith("…"));
	const snErr = hitSnippet({ error: { message: "Request timed out." } }, ["timed"]);
	check("片段：错误字段带标签", snErr?.label === "错误" && snErr.snippet.includes("timed out"));

	// ---- 过滤映射 ----
	check("tool → tools 组", kindGroup("tool") === "tools" && kindGroup("bash") === "tools");
	check("thinking → thinking 组", kindGroup("thinking") === "thinking");
	check("system/compaction → context 组", kindGroup("system") === "context" && kindGroup("compaction") === "context");
	check("error → error 组（独立开关）", kindGroup("error") === "error");
	check("未知 kind 归入 context", kindGroup("what") === "context");

	const onlyThinking = presetFilters("thinking");
	check("仅思考预设：thinking 通过、其余不过", eventPasses(onlyThinking, "thinking") === true && eventPasses(onlyThinking, "tool") === false && eventPasses(onlyThinking, "text") === false && eventPasses(onlyThinking, "system") === false);
	const all = presetFilters("all");
	check("全部预设：所有组通过", ["thinking", "tool", "text", "answer", "system", "user"].every((k) => eventPasses(all, k)));
	const onlyAnswer = presetFilters("answer");
	check("仅回答预设：answer 通过、过程/其余不过", eventPasses(onlyAnswer, "answer") === true && eventPasses(onlyAnswer, "text") === false && eventPasses(onlyAnswer, "tool") === false);
	check("预设不隐藏错误（仅思考/仅工具/仅回答时仍显示失败）", presetFilters("thinking").error === true && presetFilters("tools").error === true && presetFilters("answer").error === true && all.error === true);

	// ---- 工具名子菜单助手 ----
	const toolQuestions = [
		{
			index: 0,
			summary: "",
			events: [
				{ id: "t1", kind: "tool", tool: { name: "read" } },
				{ id: "t2", kind: "tool", tool: { name: "bash" } },
				{ id: "t3", kind: "text", text: "x" },
				{ id: "t4", kind: "tool", tool: { name: "read" } },
			],
		},
		{ index: 1, summary: "", events: [{ id: "t5", kind: "tool", tool: { name: "edit" } }] },
	];
	check("collectToolNames 按首次出现去重", collectToolNames(toolQuestions).join(",") === "read,bash,edit", collectToolNames(toolQuestions).join(","));
	check("eventToolPasses 空集（默认全勾选）时全通过", eventToolPasses(new Set(), { kind: "text" }) === true && eventToolPasses(new Set(), { kind: "tool", tool: { name: "read" } }) === true);
	check(
		"eventToolPasses 排除集：只挡住被排除的工具行，其它工具行与类型通过",
		eventToolPasses(new Set(["read"]), { kind: "tool", tool: { name: "read" } }) === false &&
			eventToolPasses(new Set(["read"]), { kind: "tool", tool: { name: "bash" } }) === true &&
			eventToolPasses(new Set(["read"]), { kind: "text" }) === true,
	);

	// ---- 工具归属分组 ----
	check("mcpLabel 前缀解析", mcpLabel("mcp__docs__search") === "MCP: docs" && mcpLabel("read") === null);
	const groupedTools = groupToolNames(
		["mcp__docs__search", "read", "obj_tool", "mystery_tool"],
		{ read: { kind: "builtin", label: "内置" }, obj_tool: { kind: "package", label: "fake-pkg" } },
	);
	check("分组顺序 内置→MCP→扩展→未识别", groupedTools.map((g) => g.label).join(" | ") === "内置 | MCP: docs | fake-pkg | 未识别", groupedTools.map((g) => g.label).join(" | "));
	check("分组内容", groupedTools[0].names.join(",") === "read" && groupedTools[1].names.join(",") === "mcp__docs__search" && groupedTools[3].names.join(",") === "mystery_tool");
	const onlyBuiltin = groupToolNames(["read"], { read: { kind: "builtin", label: "内置" } });
	check("空分组不渲染", onlyBuiltin.length === 1 && onlyBuiltin[0].label === "内置");

	check("标签：过程与回答分开命名", eventTagLabel({ kind: "text" }) === "过程" && eventTagLabel({ kind: "answer" }) === "回答");
	check("标签：出错工具", eventTagLabel({ kind: "tool", tool: { isError: true } }) === "工具✗");
	check("标签：错误事件", eventTagLabel({ kind: "error" }) === "错误");

	// ---- 格式化（时长格式复刻自 deepseek trajectory-record.ts） ----
	check(
		"formatDurationMillis",
		formatDurationMillis(800) === "800ms" && formatDurationMillis(1500) === "1,500ms" && formatDurationMillis(65000) === "65,000ms" && formatDurationMillis(1234567) === "1,234,567ms" && formatDurationMillis(null) === "—",
	);
	check("formatElapsedSeconds", formatElapsedSeconds(1.5) === "1,500ms" && formatElapsedSeconds(null) === "—");
	check("fmtTokens", fmtTokens(999) === "999" && fmtTokens(1500) === "1.5k" && fmtTokens(125000) === "125k" && fmtTokens(2200000) === "2.20M");
	check("fmtCost", fmtCost(0.0012) === "$0.0012" && fmtCost(1.5) === "$1.50");
	check("fmtTime", /^\d{2}:\d{2}$/.test(fmtTime(Date.now())));

	// ---- 会话列表助手 ----
	const now = Date.now();
	check("fmtRelative 刚刚", fmtRelative(now - 10_000, now) === "刚刚");
	check(
		"fmtRelative 分钟/小时/天",
		fmtRelative(now - 5 * 60_000, now) === "5 分钟前" && fmtRelative(now - 3 * 3600_000, now) === "3 小时前" && fmtRelative(now - 2 * 86400_000, now) === "2 天前",
	);
	check("fmtRelative 超过 7 天回落日期", /^\d{4}-\d{2}-\d{2}$/.test(fmtRelative(now - 30 * 86400_000, now)), fmtRelative(now - 30 * 86400_000, now));
	check("fmtBytes", fmtBytes(800) === "800B" && fmtBytes(2048) === "2.0KB" && fmtBytes(150000) === "146KB" && fmtBytes(2 * 1048576) === "2.0MB");
	check("projectLabel", projectLabel("/home/u/proj") === "proj" && projectLabel("/home/u/proj/") === "proj" && projectLabel(null) === "(未知项目)");
	const grouped = groupSessions([
		{ id: "1", projectPath: "/a", modified: 3 },
		{ id: "2", projectPath: "/b", modified: 2 },
		{ id: "3", projectPath: "/a", modified: 1 },
	]);
	check("分组保序且不同项目分开", grouped[1].sessions.map((s) => s.id).join(",") === "2");

	// ---- Agent 派生树（codex） ----
	const treeSessions = [
		{ id: "root1", projectPath: "/p", created: 100, modified: 900, name: "主会话 A", firstMessage: "", threadSource: "user" },
		{ id: "sub1", projectPath: "/p", created: 200, modified: 300, firstMessage: "子任务 /root/doc", threadSource: "subagent", taskName: "/root/doc", sender: "/root" },
		{ id: "sub2", projectPath: "/p", created: 400, modified: 500, firstMessage: "子任务 /root/review", threadSource: "subagent", taskName: "/root/review", sender: "/root/doc" },
		{ id: "sub3", projectPath: "/p", created: 600, modified: 700, firstMessage: "子任务 /root/doc", threadSource: "subagent", taskName: "/root/doc", sender: "/root" },
	];
	const tree = buildAgentTree(treeSessions);
	check("派生树：1 根 + 子任务挂载", tree.length === 1 && tree[0].sessions[0].id === "root1", JSON.stringify(tree.map((n) => n.name)));
	const rootChildren = tree[0].children;
	check("根下挂 /root/doc（同名两次合并）", rootChildren.length === 1 && rootChildren[0].name === "/root/doc" && rootChildren[0].sessions.length === 2);
	check("多层派发：sub2 挂到 /root/doc 下", rootChildren[0].children.length === 1 && rootChildren[0].children[0].name === "/root/review");
	const multiRoot = buildAgentTree([
		{ id: "r1", projectPath: "/p", created: 100, modified: 500, firstMessage: "R1" },
		{ id: "r2", projectPath: "/p", created: 1000, modified: 1500, firstMessage: "R2" },
		{ id: "s1", projectPath: "/p", created: 300, modified: 400, taskName: "/root/x", sender: "/root" },
		{ id: "s2", projectPath: "/p", created: 1200, modified: 1300, taskName: "/root/y", sender: "/root" },
	]);
	check("多根按时间归属", multiRoot.length === 2 && multiRoot[0].children[0]?.name === "/root/x" && multiRoot[1].children[0]?.name === "/root/y", JSON.stringify(multiRoot.map((n) => [n.sessions[0]?.id, n.children.map((c) => c.name)])));

	// ---- 派生信息（deriveInfo：当前会话所在树 + 面包屑链） ----
	const diRoot = deriveInfo(treeSessions, "root1");
	check("deriveInfo：选中主会话 → path=[根]，共 2 个任务节点", !!diRoot && diRoot.path.length === 1 && diRoot.path[0].sessions[0].id === "root1" && diRoot.subtaskCount === 2, JSON.stringify(diRoot?.path.map((n) => n.name)));
	check("deriveInfo：直属子任务数 = rail 徽标", diRoot?.root.children.length === 1);
	const diDeep = deriveInfo(treeSessions, "sub2");
	check("deriveInfo：深层子会话 → path=[根,doc,review]", !!diDeep && diDeep.path.map((n) => String(n.name)).join("|") === "null|/root/doc|/root/review", JSON.stringify(diDeep?.path.map((n) => n.name)));
	const diLatest = deriveInfo(treeSessions, "sub3");
	check("deriveInfo：×N 节点取最新实例（sub3 created 600 > sub1 200）", diLatest?.path[1].sessions[diLatest.path[1].sessions.length - 1].id === "sub3");
	const noiseSessions = [...treeSessions, { id: "gd1", projectPath: "/p", created: 150, modified: 800, threadSource: "guardian_review" }, { id: "old1", projectPath: "/p", created: 160, modified: 400, threadSource: "subagent", taskName: null }];
	const diNoise = deriveInfo(noiseSessions, "root1");
	check("deriveInfo：guardian/无 taskName 旧子会话不作根（不抢占子任务）", !!diNoise && diNoise.path[0].sessions[0].id === "root1" && diNoise.subtaskCount === 2);
	check("deriveInfo：无派生 → null", deriveInfo([{ id: "lonely", projectPath: "/p", created: 1, modified: 2 }], "lonely") === null && deriveInfo(treeSessions, "不存在") === null && deriveInfo(treeSessions, null) === null);

	// ---- 派生行（spawn_agent ↔ 子会话） ----
	const spawnEv = (id, ts, args, result) => ({ id, ts, kind: "tool", tool: { name: DERIVE_TOOL, argsText: args === undefined ? "" : JSON.stringify(args), result } });
	check("派生：工具名常量", DERIVE_TOOL === "spawn_agent");
	check("deriveTaskName：结果里的完整路径优先", deriveTaskName(spawnEv("e1", 1, { task_name: "child" }, JSON.stringify({ task_name: "/root/parent/child" })), "/root") === "/root/parent/child");
	check("deriveTaskName：参数短名拼到当前任务名下", deriveTaskName(spawnEv("e2", 2, { task_name: "child" }, "ok"), "/root/parent") === "/root/parent/child");
	check("deriveTaskName：主会话短名拼 /root", deriveTaskName(spawnEv("e3", 3, { task_name: "kid" }, ""), "/root") === "/root/kid");
	const truncated = `{"task_name":"cut","fork_turns":"none","message":"gAAAAAB${'x'.repeat(4000)}`;
	check("deriveTaskName：截断的 JSON 仍取到 task_name", deriveTaskName(spawnEv("e4", 4, undefined, ""), "/root") === null && deriveTaskName({ id: "e4", ts: 4, kind: "tool", tool: { name: DERIVE_TOOL, argsText: truncated } }, "/root") === "/root/cut");
	check("deriveTaskName：无 task_name → null", deriveTaskName({ id: "e5", kind: "tool", tool: { name: DERIVE_TOOL, argsText: "{}", result: "done" } }, "/root") === null);

	const subSessions = [
		{ id: "s-old", taskName: "/root/doc", created: 200 },
		{ id: "s-new", taskName: "/root/doc", created: 500 },
		{ id: "s-rev", taskName: "/root/review", created: 400 },
	];
	const spawnQuestions = [
		{
			index: 0,
			events: [
				spawnEv("sp1", 100, { task_name: "doc" }, JSON.stringify({ task_name: "/root/doc" })),
				spawnEv("sp2", 450, { task_name: "doc" }, JSON.stringify({ task_name: "/root/doc" })),
				spawnEv("sp3", 390, { task_name: "review" }, JSON.stringify({ task_name: "/root/review" })),
				spawnEv("sp4", 600, { task_name: "missing" }, JSON.stringify({ task_name: "/root/missing" })),
				{ id: "send1", ts: 700, kind: "tool", tool: { name: "send_message", argsText: JSON.stringify({ task_name: "doc" }), result: "" } },
			],
		},
	];
	const dt = deriveTargets(subSessions, spawnQuestions, "/root");
	check("deriveTargets：同名多实例从尾部倒序配对", dt.get("sp2") === "s-new" && dt.get("sp1") === "s-old", JSON.stringify([...dt]));
	check("deriveTargets：单一实例直接配对", dt.get("sp3") === "s-rev");
	check("deriveTargets：无对应子会话不产生条目", !dt.has("sp4") && dt.size === 3);
	check("deriveTargets：非 spawn_agent 工具不算派生", !dt.has("send1"));
	check("deriveTargets：无子会话时返回空映射", deriveTargets([{ id: "r", taskName: null }], spawnQuestions, "/root").size === 0);
	const overflow = deriveTargets(subSessions, [{ index: 0, events: [spawnEv("o1", 1, { task_name: "doc" }, ""), spawnEv("o2", 2, { task_name: "doc" }, ""), spawnEv("o3", 3, { task_name: "doc" }, "")] }], "/root");
	check("deriveTargets：派发次数多于实例时只配最新的几个", overflow.get("o3") === "s-new" && overflow.get("o2") === "s-old" && !overflow.has("o1"));

	// ---- 搜索索引（复刻 deepseek TrajectorySearchIndex） ----
	const questions = [
		{
			index: 0,
			summary: "读取配置",
			events: [
				{ id: "e1", kind: "tool", preview: "read config.json", tool: { name: "read", argsText: '{"path":"config.json"}', result: "ok" } },
				{ id: "e2", kind: "thinking", preview: "分析", text: "先看配置再改代码" },
			],
		},
		{ index: 1, summary: "写测试", events: [{ id: "e3", kind: "text", preview: "完成", text: "测试通过" }] },
	];
	const index = new TrajectorySearchIndex();
	check("索引 update 首次返回 true", index.update(questions) === true);
	check("索引 update 同引用返回 false", index.update(questions) === false);
	check("空查询返回 null", index.search("  ") === null);
	const m1 = index.search("CONFIG");
	check("大小写不敏感匹配", m1 instanceof Set && m1.has("e1") && !m1.has("e3"), JSON.stringify([...(m1 ?? [])]));
	const m2 = index.search("配置 代码");
	check("多词 AND 匹配同一事件", m2.size === 1 && m2.has("e2"), JSON.stringify([...m2]));
	check("无命中返回空集", index.search("不存在的词").size === 0);
	check("摘要不参与索引（命中只算事件自身内容）", !index.search("写测试").has("e3"));
	check("轮次标签不参与索引（搜 turn 不误命中）", index.search("turn").size === 0);
	const qUser = [{ index: 2, summary: "", events: [{ id: "u1", kind: "user", text: "今天天气怎么样" }] }];
	index.update(qUser);
	check("提问正文仍可搜（user 事件自身文本）", index.search("天气").has("u1"));
	index.update([{ index: 3, summary: "", events: [{ id: "x1", kind: "error", error: { message: "Request timed out." } }] }]);
	check("错误事件正文可搜", index.search("timed out").has("x1"));
	index.update(questions);
	index.update([{ ...questions[0], events: [questions[0].events[0]] }]);
	check("增量同步移除消失的事件", index.search("先看配置").size === 0);

	// ---- Markdown：转义与注入 ----
	const xss = renderMarkdown("<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>");
	check("HTML 被转义", !xss.includes("<script>") && !xss.includes("<img") && xss.includes("&lt;script&gt;"), xss);
	const badLink = renderMarkdown("[点我](javascript:alert(1))");
	check("javascript: 链接被降级", !badLink.includes("javascript:") && badLink.includes('href="#"'), badLink);
	const okLink = renderMarkdown("[文档](https://example.com/a)");
	check("http 链接保留", okLink.includes('href="https://example.com/a"'));

	// ---- Markdown：结构 ----
	const md = renderMarkdown("# 标题\n\n**粗体** 与 `code`\n\n```ts\nconst a = 1;\n```\n\n- 一\n- 二\n\n> 引用");
	check("标题", md.includes("<h1>标题</h1>"));
	check("粗体与行内代码", md.includes("<strong>粗体</strong>") && md.includes("<code>code</code>"));
	check("代码块", md.includes('<pre class="md-code"><code class="language-ts">') && md.includes("const a = 1;"));
	check("列表", md.includes("<ul><li>一</li><li>二</li></ul>"));
	check("引用", md.includes("<blockquote>") && md.includes("引用"));
	const codeOnly = renderMarkdown("```\n<b>raw</b>\n```");
	check("代码块内容也转义", !codeOnly.includes("<b>raw</b>") && codeOnly.includes("&lt;b&gt;raw&lt;/b&gt;"));

	// ---- 回归守卫：抽屉的 Markdown 桥接 ----
	// document.importNode 只做克隆，不把节点从源文档摘除；在 while (doc.body.firstChild)
	// 里用它条件永远成立，死循环冻结页面（2026-10-15 实测事故）。必须直接 appendChild。
	const appSource = fs.readFileSync(path.join(__dirname, "..", "trajectory-web", "web", "app.js"), "utf8");
	const prefsSource = fs.readFileSync(path.join(__dirname, "..", "trajectory-web", "web", "prefs.js"), "utf8");
	check("app.js 不再使用 importNode（克隆不移除源节点，会死循环）", !appSource.includes("importNode("));
	check("mdNode 直接移入节点保证循环收敛", /wrapper\.appendChild\(\s*doc\.body\.firstChild\s*\)/.test(appSource));
	check("派生行内联化：不再有独立派生视图", !appSource.includes("deriveView") && !appSource.includes("renderDeriveList"));
	check("派生行渲染走 deriveTargets 映射", appSource.includes("state.deriveTargets.get(ev.id)") && appSource.includes("openEventRow"));

	// ---- 回归守卫：全局偏好走服务端，工具排除集只做迁移/规范化 ----
	check(
		"工具排除集持久化：tw.tools 由 prefs.js 迁移 + app 写服务端",
		prefsSource.includes('tools: "tw.tools"') && prefsSource.includes("export function normalizeToolsPrefs") && appSource.includes("function saveToolsPrefs"),
	);
	check(
		"恢复时校验字段并重建 Set（损坏存档不致崩）",
		prefsSource.includes("Array.isArray(value.excluded)") && appSource.includes("new Set(saved.excluded)") && appSource.includes("normalizeToolsPrefs"),
	);
	check("初始化恢复：await initGlobalPrefs 后 renderToolbar", appSource.includes("await initGlobalPrefs();\nrenderToolbar();"));
	check("子菜单每次变更即保存（含全选/全不勾切换）", /state\.toolExcluded\.add\(name\);\n\t\tsaveToolsPrefs\(\);/.test(appSource));
	check("切会话与切源仍写入全局工具偏好（3 处调用）", appSource.split("saveToolsPrefs();").length - 1 === 3);
	check("全局 localStorage 键不再由 app.js 长期写入", ["tw.filters", "tw.tools", "tw.theme", "tw.translate", "tw.chat", "tw.chatWidth", "tw.composerHeight"].every((key) => !appSource.includes(`localStorage.setItem("${key}"`)));

	// ---- 回归守卫：会话表头的分组总开关 ----
	const indexSource = fs.readFileSync(path.join(__dirname, "..", "trajectory-web", "web", "index.html"), "utf8");
	check("主题首帧由服务端 __TW_BOOT__ 注入，不再读 tw.theme", indexSource.includes("__TW_BOOT__") && !indexSource.includes('localStorage.getItem("tw.theme")'));
	check("会话表头有分组总开关按钮", indexSource.includes('id="groups-toggle"'));
	check("分组总开关的同步态与点击都接上了", appSource.includes("function updateGroupsToggle") && appSource.includes('el("groups-toggle").addEventListener("click"'));

	// ---- 回归守卫：轮次头三控件（剪刀裁剪 / checkbox 选中 / 点击轮号折叠） ----
	check("轮次头三控件接线：剪刀裁剪、勾选选中、点击轮号折叠", appSource.includes('class: "q-eye"') && appSource.includes('class: "q-check"') && appSource.includes('no.closest(".question")'));
	check("整轮裁剪联动模型上下文：可写走 /api/context-edit，只读退化纯 UI", appSource.includes("async function toggleRoundCrop") && appSource.includes('"/api/context-edit"') && appSource.includes("function roundCroppedOf") && appSource.includes('state.canContextEdit && state.source === "pi"'));
	check("隐藏态从投影恢复（modelHidden 派生 + hiddenUserIds 对齐）", appSource.includes("j.contextEdit === true") && appSource.includes("j.hiddenUserIds") && appSource.includes('String(userEv.id).split(":")[0]'));
	const serverSource = fs.readFileSync(path.join(__dirname, "..", "trajectory-web", "server", "app.mjs"), "utf8");
	check("服务端 context-edit 端点：无 handler 501、有 handler 转发", serverSource.includes('"/api/context-edit"') && serverSource.includes("501") && serverSource.includes("options.onContextEdit({ sessionFile: session.file, qIndex, hidden })"));
	check("旧 ⊞/⊟ 折叠按钮与双击折叠已移除", !appSource.includes("q-fold") && !appSource.includes("双击收起本轮"));
	check("整轮裁剪覆盖轮内所有条目（含被过滤掉的）", appSource.includes("function eventCropped") && /function eventCropped\(ev, q\) \{[\s\S]*?roundCroppedOf\(q\)\) return true/.test(appSource) && appSource.includes("hiddenQs = new Set()") && appSource.includes("selectedEvs = new Set()"));

	// ---- 回归守卫：裁剪模式（工具栏开关 + 列表内剪刀 + 删除线） ----
	const styleSource = fs.readFileSync(path.join(__dirname, "..", "trajectory-web", "web", "style.css"), "utf8");
	check("工具栏有裁剪按钮（过滤右侧）", indexSource.includes('id="crop-btn"') && indexSource.indexOf('id="filter-root"') < indexSource.indexOf('id="crop-btn"') && indexSource.indexOf('id="crop-btn"') < indexSource.indexOf('id="search"'));
	check("裁剪模式开关接线：按钮变色（aria-pressed）+ Esc 退出 + 裁剪结果不随模式变化", appSource.includes("function setCropMode") && appSource.includes('el("crop-btn").addEventListener("click"') && appSource.includes('btn.setAttribute("aria-pressed", String(state.cropMode))') && appSource.includes("if (state.cropMode) {") && appSource.includes("setCropMode(false)"));
	check("裁剪模式有可见提示：按钮文字变「裁剪中」+ 开态警示配色", indexSource.includes('id="crop-label"') && appSource.includes('el("crop-label").textContent = state.cropMode ? "裁剪中" : "裁剪"') && !indexSource.includes("crop-hint") && !appSource.includes("crop-hint") && styleSource.includes('#crop-btn[aria-pressed="true"]'));
	check("剪刀只在裁剪模式渲染（行级 + 轮头两处；第三处是 Esc 退出）", appSource.split('svgIcon("scissors")').length - 1 === 2 && appSource.split("if (state.cropMode) {").length - 1 === 3);
	check("裁剪只杠掉不隐藏：行仍可点击看详情", appSource.includes('classes.push("is-cropped")') && !appSource.includes("ev-row-hidden") && styleSource.includes(".ev.is-cropped .ev-preview") && styleSource.includes("text-decoration: line-through"));
	check("非裁剪模式网格收一列（否则勾选/标签错位）", appSource.includes('if (!state.cropMode) classes.push("no-crop")') && styleSource.includes(".ev.no-crop"));

	// ---- 回归守卫：行级控件（每条事件行前的剪刀 + checkbox） ----
	check("事件行带行级剪刀与 checkbox", appSource.includes('class: "ev-eye"') && appSource.includes('class: "ev-check"') && appSource.includes("state.selectedEvs.has(ev.id)"));
	check("checkbox 仅在蒸馏模式渲染（行级 + 轮头）", appSource.split("if (selectMode()) {").length - 1 === 2 && appSource.includes("function selectMode()") && appSource.includes("return state.distillMode") && !appSource.includes("state.chatOpen || state.distillMode"));
	check("蒸馏按钮：裁剪右侧 + 文字变「蒸馏中」+ 开态配色", indexSource.indexOf('id="crop-btn"') < indexSource.indexOf('id="distill-btn"') && indexSource.includes('id="distill-label"') && appSource.includes("function setDistillMode") && appSource.includes('el("distill-label").textContent = state.distillMode ? "蒸馏中" : "蒸馏"') && appSource.includes('el("distill-btn").addEventListener("click"') && styleSource.includes('#distill-btn[aria-pressed="true"]'));
	check("轮头 checkbox = 全选本轮所有条目（含被过滤掉的）", appSource.includes("function toggleRoundSelected") && /function toggleRoundSelected\(index\)[\s\S]*?\(q\?\.events \?\? \[\]\)\.map\(\(ev\) => ev\.id\)/.test(appSource) && appSource.includes("toggleRoundSelected(Number(check.dataset.check))") && appSource.includes("function roundSelectedState"));
	check("轮头勾选态由条目选中集派生（all/some/none，已删除 selectedQs）", appSource.includes('return on === ids.length ? "all" : "some"') && !appSource.includes("selectedQs") && !indexSource.includes("selectedQs"));
	check("行级控件点击先于行展开（否则点剪刀会开面板）", appSource.indexOf('closest(".ev-eye")') < appSource.indexOf('closest(".ev")') && appSource.includes('closest(".ev-check")'));
	check("单条裁剪真剔模型上下文：走 /api/crop-entry，按 entry id 存", appSource.includes("async function toggleEntryCrop") && appSource.includes('\"/api/crop-entry\"') && appSource.includes("function entryIdOf") && serverSource.includes('\"/api/crop-entry\"') && serverSource.includes("options.onCropEntry({ sessionFile: session.file, entryId, cropped })"));
	check("裁剪与选中两套业务分开（croppedEntries / selectedEvs 互不影响）", appSource.includes("state.croppedEntries.has(entryIdOf(ev))") && appSource.includes("state.selectedEvs.has(ev.id)") && appSource.split("state.croppedEntries = new Set()").length - 1 === 2);
	check("行级控件复用轮次控件样式 + 行内五列网格", /\.q-eye,\n\.ev-eye \{/.test(styleSource) && /\.q-check,\n\.ev-check \{/.test(styleSource) && /grid-template-columns: 18px 13px 60px 1fr auto/.test(styleSource));
	check(
		"详情面板左缘跟随事件行预览列（默认/无剪刀/无勾选组合）",
		styleSource.includes(".ev.no-crop + .ev-panel") &&
			styleSource.includes(".ev.no-select + .ev-panel") &&
			styleSource.includes(".ev.no-crop.no-select + .ev-panel") &&
			styleSource.includes("margin-left: 80px;") &&
			styleSource.includes("margin-left: 103px;") &&
			styleSource.includes("margin-left: 108px;"),
	);
	check("轮次头不重复展示提问正文（首行 user 事件已含，q-sum 已删）", !appSource.includes("q-sum") && !styleSource.includes(".q-sum"));
	check("checkbox 选中是无底黑勾（自定义渲染，不用 accent-color 的黑底白勾）", !styleSource.includes("accent-color:") && /\.q-check,\n\.ev-check \{[^}]*appearance: none/s.test(styleSource) && /\.q-check:checked,\n\.ev-check:checked \{[^}]*background-image: url\("data:image\/svg\+xml/s.test(styleSource) && /body\[data-ds-dark-theme\] \.q-check:checked/.test(styleSource));
	check("剪刀图标（两个圆环把手 + 交叉刀刃），旧眼睛图标已移除", appSource.includes("scissors: [") && !appSource.includes('svgIcon("eye")') && !appSource.includes("\teye: ["));

	// ---- 回归守卫：详情内联面板（行下方展开，工具条随面板作用于当前行） ----
	check("详情在行下方内联展开：面板挂到对应行之后，行不在即收起", appSource.includes("function attachOpenPanel") && appSource.includes("row.after(panel)") && appSource.includes('mainInner.querySelector(`.ev[data-eid="${state.openId}"]`)'));
	check("renderMain 末尾重挂面板（replaceChildren 摘出后重挂不重建）", appSource.includes("updateFoldAll();\n\t// 打开的详情面板重新挂到对应行下方（replaceChildren 会把它摘出文档，重挂不重建，滚动/展开态保留）\n\tattachOpenPanel();"));
	check("再点同一行收起（toggle）", appSource.includes("state.openId === id") && appSource.includes("closePanel();"));
	check("面板头只剩工具条（无分类徽章/标题/关闭按钮），工具靠左", /class="ev-panel-head">\s*<div class="ev-panel-tools">\s*<button id="dv-translate"/.test(indexSource) && !indexSource.includes('id="dv-kind"') && !indexSource.includes('id="dv-title"') && !indexSource.includes('id="dv-close"') && !appSource.includes("dv-kind") && !appSource.includes("dv-title") && !appSource.includes("dv-close") && !styleSource.includes(".dv-kind"));
	check("面板头部带工具条：译/⧉/⚙，仍作用于当前展开行", /class="ev-panel-head"[\s\S]*?id="dv-translate"[\s\S]*?id="dv-copy"[\s\S]*?id="dv-settings"/.test(indexSource));
	check("翻译/复制仍以 dv-body 为正文源（工具条迁移后目标不变）", appSource.includes('el("dv-body").querySelectorAll(".md")') && appSource.includes("function panelCopyText") && appSource.includes("async function translatePanel"));
	check("展开行高亮 + 面板样式就位", appSource.includes('classes.push("is-open")') && styleSource.includes(".ev.is-open") && styleSource.includes(".ev-panel"));
	check("首点即高亮：attachOpenPanel 同步 is-open，closePanel 清除", appSource.includes('row.classList.add("is-open")') && appSource.includes('mainInner.querySelectorAll(".ev.is-open")'));
	check(
		"详情面板滚轮是滚动边界：内部滚动到顶/到底不链到外层",
		/panel\.addEventListener\(\s*"wheel"/.test(appSource) &&
			appSource.includes("event.preventDefault()") &&
			appSource.includes("body.scrollTop = Math.max") &&
			styleSource.includes("overscroll-behavior: contain"),
	);
	check("renderMain 先把面板停泊到 body（防 replaceChildren 摘出后 el(\"dv-*\") 空引用崩溃）", appSource.includes("if (panel.parentElement !== document.body) document.body.appendChild(panel);"));
	check("抽屉遗迹已移除（resize 把手/标签行/悬挂侧条/宽度持久化/旧 id）", !indexSource.includes('id="drawer-resize"') && !indexSource.includes("dv-tabs") && !indexSource.includes("dv-side") && !appSource.includes("setDrawerTab") && !appSource.includes("bindDrawerResize") && !appSource.includes("tw.drawerWidth") && !appSource.includes("tw.sidetool"));

	// ---- 回归守卫：侧边对话栏（顶栏按钮开关，主题按钮右侧） ----
	check("顶栏对话按钮在主题按钮右侧", indexSource.includes('id="chat-btn"') && indexSource.indexOf('id="theme-btn"') < indexSource.indexOf('id="chat-btn"'));
	check("对话栏独立成侧栏，顶部上下文行与关闭按钮已移除（顶部直接是消息流）", indexSource.includes('id="chat-drawer"') && !indexSource.includes("chat-ctx") && !indexSource.includes('id="chat-close"'));
	check("对话栏开关接线：按钮切换 + 开态持久化 + Esc 兕底", appSource.includes("function setChatOpen") && appSource.includes('el("chat-btn").addEventListener("click"') && prefsSource.includes('chatOpen: "tw.chat"') && appSource.includes("queueGlobalPrefs({ chatOpen: open })") && appSource.includes("if (state.chatOpen) {"));
	check("对话栏样式就位（分屏 flex 列，非 fixed 覆盖）", styleSource.includes(".chat-drawer") && styleSource.includes(".chat-context-menu") && !/\.chat-drawer\s*\{[^}]*position:\s*fixed/s.test(styleSource));
	check("对话栏支持拖拽编辑框上边调高输入区（把手 + 拖拽接线 + 高度持久化）", indexSource.includes('id="composer-resize"') && indexSource.includes('aria-orientation="horizontal"') && appSource.includes("function bindComposerResize") && appSource.includes("previewComposerHeight(start.height - (ev.clientY - start.y))") && prefsSource.includes('composerHeight: "tw.composerHeight"') && appSource.includes("queueGlobalPrefs({ composerHeight") && appSource.includes("function resetComposerHeight") && styleSource.includes(".composer-resize") && styleSource.includes('[data-composer="manual"]'));
	check("对话栏左缘拖拽调宽（把手 + 接线 + 宽度持久化）", indexSource.includes('id="chat-resize"') && indexSource.includes('aria-orientation="vertical"') && appSource.includes("function bindChatResize") && appSource.includes("previewChatWidth(start.width - (ev.clientX - start.x))") && prefsSource.includes('chatWidth: "tw.chatWidth"') && appSource.includes("queueGlobalPrefs({ chatWidth") && styleSource.includes(".chat-resize") && /\.chat-drawer \{[^}]*width: min\(var\(--tw-chat-w, 440px\), 90vw\)/s.test(styleSource));
	check("两个拖拽把手并存（左缘调宽 + 输入区上边调高）", appSource.includes("bindChatResize()") && appSource.includes("bindComposerResize()") && appSource.includes("loadChatWidth()") && appSource.includes("loadComposerHeight()") && indexSource.indexOf('id="chat-resize"') < indexSource.indexOf('id="composer-resize"'));
	check("分屏结构：chat-drawer 在 #layout 内、#main 之后，layout 随其后闭合（主区收窄不遮盖）", indexSource.indexOf('id="main"') < indexSource.indexOf('id="chat-drawer"') && /<\/main>\s*<!--[\s\S]*?-->\s*<aside id="chat-drawer"/.test(indexSource) && /<\/aside>\s*<\/div>/.test(indexSource));

	// ---- 回归守卫：对话页 UI（消息流 + 输入卡，本地消息流未接模型） ----
	check("对话页两段结构：消息流(role=log) + 输入卡", indexSource.includes('id="chat-list"') && indexSource.includes('role="log"') && indexSource.includes('id="chat-input"') && indexSource.includes('id="chat-send"'));
	const chatSource = fs.readFileSync(path.join(__dirname, "..", "trajectory-web", "web", "chat.js"), "utf8");
	check(
		"控制台状态：API / 会话 badge / 侧边状态条接线",
		appSource.includes("/api/chat/consoles?") &&
			appSource.includes("console-badge") &&
			chatSource.includes("onConsolesChanged") &&
			chatSource.includes("renderConsoleStatus") &&
			indexSource.includes('id="chat-console-status"') &&
			styleSource.includes(".console-badge") &&
			styleSource.includes(".chat-console-status"),
	);
	check(
		"T4 双模式：开关/发送/转发记录/禁用接线",
		indexSource.includes('id="chat-mode-switch"') &&
			indexSource.includes('id="chat-mode-forward"') &&
			indexSource.includes('id="chat-forward-delivery"') &&
			chatSource.includes("function setMode") &&
			chatSource.includes("function sendForward") &&
			chatSource.includes("/api/chat/forward") &&
			chatSource.includes("forwardLogs") &&
			chatSource.includes("forwardDeliveryEl") &&
			chatSource.includes("state.mode === \"forward\"") &&
			styleSource.includes(".chat-mode-switch") &&
			styleSource.includes(".chat-forward-status"),
	);
	check("对话前端接线：send/stop/SSE 解析/response.ok", chatSource.includes("/api/chat/send") && chatSource.includes("/api/chat/stop") && chatSource.includes("/api/chat/thread") && chatSource.includes("parseSseChunk") && chatSource.includes("response.ok"));
	check("流式解码必须是 TextDecoder + {stream:true}", chatSource.includes('new TextDecoder("utf-8")') && chatSource.includes("stream: true"));
	check("app.js 已移交对话：initChatPanel + 移除本地消息流", appSource.includes("initChatPanel") && !appSource.includes("state.chat.push") && !appSource.includes("function sendChat") && !appSource.includes("function renderChat") && !appSource.includes("syncChatSend"));
	check("getSession 走 chatSessionRef（切源时 sessions 未命中也保留 selectedId）", appSource.includes("chatSessionRef({") && appSource.includes("sessions: state.sessions"));
	check(
		"流式切会话：先 settled 再 abort 并清 streaming",
		/if \(state\.streaming \|\| state\.turn\) \{[\s\S]*?turn\.settled = true;[\s\S]*?turn\.controller\?\.abort\(\);[\s\S]*?resetStreamState\(\);/.test(chatSource),
	);
	check(
		"SSE 回调按当前 turn + 会话 key 守卫",
		chatSource.includes("function isTurnActive(turn)") &&
			chatSource.includes("state.turn === turn") &&
			chatSource.includes("isCurrentTurn(turn, sessionKeyOf(currentSession()))") &&
			chatSource.includes("if (!isTurnActive(turn)) return;") &&
			chatSource.includes("await reader.cancel()"),
	);
	check(
		"流式可访问性：aria-busy/live 切换 + 独立播报区只读最后一条",
		chatSource.includes('setAttribute("aria-busy"') &&
			chatSource.includes('setAttribute("aria-live"') &&
			chatSource.includes("chat-announcer") &&
			indexSource.includes('id="chat-announcer"') &&
			indexSource.includes('aria-live="polite"') &&
			styleSource.includes(".chat-sr-only"),
	);
	check(
		"模型接口接线：models/model + 脱敏展示",
		chatSource.includes("/api/chat/models?") &&
			chatSource.includes('/api/chat/model"') &&
			chatSource.includes("filterPaletteItems") &&
			chatSource.includes("formatContextWindow") &&
			chatSource.includes("modelLabel"),
	);
	const modelLabelTag = /<button id="chat-model-label"[^>]*>/.exec(indexSource)?.[0] ?? "";
	check(
		"无顶部模型/新建菜单；当前模型为 dsh select 按钮",
		modelLabelTag.includes('class="chat-model-label"') &&
			!indexSource.includes('id="chat-model"') &&
			!indexSource.includes('id="chat-new"') &&
			!indexSource.includes('id="chat-head"'),
		modelLabelTag,
	);
	const selectBlock = /\.chat-profile,\n\.chat-model-label \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	check(
		"模型/权限 trigger：dsh gap4/28px/padding 0 4 0 8/radius-sm/透明底",
		/display: inline-flex/.test(selectBlock) &&
			/gap: 4px/.test(selectBlock) &&
			/height: 28px/.test(selectBlock) &&
			/padding: 0 4px 0 8px/.test(selectBlock) &&
			/border-radius: var\(--dsw-radius-sm\)/.test(selectBlock) &&
			/background: transparent/.test(selectBlock) &&
			/color: var\(--dsw-alias-label-secondary\)/.test(selectBlock) &&
			/--dsw-alias-interactive-bg-hover/.test(styleSource) &&
			/max-width: 220px/.test(styleSource) &&
			/max-width: 360px/.test(styleSource) &&
			!selectBlock.includes("data:image/svg"),
		selectBlock,
	);
	const chatAddTag = /<button id="chat-add"[^>]*>/.exec(indexSource)?.[0] ?? "";
	check(
		"输入卡 dsh 结构：+ / 权限 / 模型 / 发送",
		chatAddTag.includes('aria-haspopup="listbox"') &&
			chatAddTag.includes('aria-expanded="false"') &&
			indexSource.indexOf('class="chat-tools"') < indexSource.indexOf('id="chat-add"') &&
			indexSource.indexOf('id="chat-add"') < indexSource.indexOf('class="chat-modes"') &&
			indexSource.indexOf('id="chat-profile"') < indexSource.indexOf('class="chat-trailing"') &&
			indexSource.indexOf('class="chat-standard-controls"') < indexSource.indexOf('id="chat-model-label"') &&
			indexSource.indexOf('id="chat-model-label"') < indexSource.indexOf('id="chat-thinking"') &&
			indexSource.indexOf('id="chat-thinking"') < indexSource.indexOf('id="chat-send"') &&
			indexSource.indexOf('class="chat-overlay-anchor"') < indexSource.indexOf('class="chat-accessory"'),
		JSON.stringify({ chatAddTag, head: indexSource.indexOf('class="chat-overlay-anchor"'), accessory: indexSource.indexOf('class="chat-accessory"') }),
	);
	check(
		"模型文案：加载中/默认模型，不出现模型未加载",
		!chatSource.includes("模型未加载") &&
			!indexSource.includes("模型未加载") &&
			chatSource.includes("读取模型中…") &&
			chatSource.includes("默认模型") &&
			indexSource.includes("读取模型中…"),
	);
	check(
		"模型切换：/model 与控件点击共用 Model 层",
		chatSource.includes('id: "model"') &&
			chatSource.includes("openPalette(\"model\"") &&
			chatSource.includes("if (modelBtn)") &&
			chatSource.includes('pushNotice("回复中，先停止"') &&
			!chatSource.includes("function openModelPicker()"),
	);

	const modelTriggerTag = /<button id="chat-model-label"[^>]*>/.exec(indexSource)?.[0] ?? "";
	check(
		"模型+级别 trigger：模型名/级别/chevron，Thinking 层 + POST",
		indexSource.includes('id="chat-model-name"') &&
			indexSource.includes('id="chat-thinking"') &&
			indexSource.includes('class="chat-trigger-chevron"') &&
			!/<button id="chat-thinking"/.test(indexSource) &&
			modelTriggerTag.includes('aria-haspopup="menu"') &&
			chatSource.includes('id: "thinking"') &&
			chatSource.includes('label: "思考级别"') &&
			chatSource.includes("paletteThinkingItems") &&
			chatSource.includes("openPalette(\"thinking\"") &&
			chatSource.includes("/api/chat/thinking") &&
			chatSource.includes("async function selectThinking") &&
			chatSource.includes('item.id === state.thinkingLevel') &&
			chatSource.includes("搜索级别…") &&
			chatSource.includes("没有匹配的思考级别"),
		JSON.stringify({ modelTriggerTag }),
	);
	check(
		"triggerEffort：caption 色 + flex-shrink 1000；chevron 为 SVG 非 data URI",
		/\.chat-model-effort \{[^}]*flex-shrink: 1000;[^}]*color: var\(--dsw-alias-label-caption\)/s.test(styleSource) &&
			indexSource.includes('class="chat-trigger-chevron"') &&
			!/background-image: url\("data:image\/svg/.test(selectBlock),
	);
	check(
		"modelRoot 三态：root 两行 → model/effort，Esc 按来源回退",
		chatSource.includes("paletteModelRootItems") &&
			chatSource.includes('openPalette("modelRoot"') &&
			chatSource.includes('back: "modelRoot"') &&
			chatSource.includes("state.palette.back") &&
			chatSource.includes("function backToParentLayer") &&
			chatSource.includes("returnToTrigger") &&
			chatSource.includes("layer !== \"command\" && state.palette.layer !== \"modelRoot\""),
	);
	check(
		"权限/模型菜单锚定 trigger：坐标换算 + fit-content + dsh 宽度",
		chatSource.includes("computeAnchoredMenuPosition") &&
			chatSource.includes("function positionAnchoredMenu") &&
			chatSource.includes("tr.top") &&
			chatSource.includes("tr.right") &&
			chatSource.includes("tr.left") &&
			chatSource.includes("menu.style.width = \"fit-content\"") &&
			chatSource.includes("min(240px, 100%)") &&
			chatSource.includes("min(144px, 100%)") &&
			chatSource.includes("min(260px, 100%)") &&
			chatSource.includes("const boundsWidth = ar.right - ar.left") &&
			chatSource.includes("const availableWidth") &&
			chatSource.includes("menu.style.width = `${Math.max(0, availableWidth)}px`") &&
			!chatSource.includes("viewportWidth") &&
			!chatSource.includes("calc(100vw - 24px)") &&
			!styleSource.includes("calc(100vw - 24px)") &&
			chatSource.includes("ANCHORED_PALETTE_LAYERS") &&
			chatSource.includes("MODEL_MENU_ANCHOR") &&
			chatSource.includes("PROFILE_MENU_ANCHOR") &&
			chatSource.includes("document.addEventListener(\"scroll\", positionOpenMenus, true)") &&
			chatSource.includes("new ResizeObserver(positionOpenMenus)") &&
			!chatSource.includes('menu.style.left = "0"') &&
			!chatSource.includes('menu.style.right = "0"') &&
			!chatSource.includes("position-anchor") &&
			!styleSource.includes("position-anchor"),
		JSON.stringify({ anchored: chatSource.includes("function positionAnchoredMenu") }),
	);

	const rowBlock = /\.chat-row \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	const groupsBlock = /\.chat-tools,\n\.chat-modes,\n\.chat-trailing \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	const addBlock = /#chat-add \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	const sendBlock = /\.chat-send \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	check(
		"输入卡行布局照抄 dsh：space-between/gap12/padding 2 8 6/container",
		/flex-wrap: wrap/.test(rowBlock) &&
			/justify-content: space-between/.test(rowBlock) &&
			/gap: 12px/.test(rowBlock) &&
			/padding: 2px 8px 6px/.test(rowBlock) &&
			/container-type: inline-size/.test(rowBlock) &&
			/display: flex/.test(groupsBlock) &&
			/margin-left: auto/.test(styleSource) &&
			/width: 28px/.test(addBlock) &&
			/height: 28px/.test(addBlock) &&
			/border-radius: 999px/.test(addBlock) &&
			/transform: translateY\(-2px\)/.test(sendBlock) &&
			/@container \(max-width: 560px\)[\s\S]*?gap: 8px/.test(styleSource),
		JSON.stringify({ rowBlock, groupsBlock, addBlock, sendBlock }),
	);

	const menuShellBlock = /\.chat-palette,\n\.chat-profile-menu,\n\.chat-context-menu \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	const paletteBaseBlock = /(?:^|\n)\.chat-palette \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	const menuItemBlock = /\.chat-palette-item \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	const menuGroupBlock = /\.chat-palette-group \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	const menuHintBlock = /\.chat-palette-hint \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	check(
		"菜单复刻 dsh：prominent 表面 / 400 高 / item 34px / 右对齐 hint",
		/border-radius: var\(--dsw-radius-lg\)/.test(menuShellBlock) &&
			/background: var\(--dsw-menu-surface-fill\)/.test(menuShellBlock) &&
			/backdrop-filter: var\(--dsw-menu-backdrop-filter\)/.test(menuShellBlock) &&
			/box-shadow: var\(--dsw-elevation-prominent\)/.test(menuShellBlock) &&
			/max-height: 400px/.test(menuShellBlock) &&
			/overflow: hidden/.test(menuShellBlock) &&
			/min-height: 34px/.test(menuItemBlock) &&
			/padding: 6px 8px/.test(menuItemBlock) &&
			/border-radius: var\(--dsw-radius-md\)/.test(menuItemBlock) &&
			/padding: 6px 8px/.test(menuGroupBlock) &&
			/text-align: right/.test(menuHintBlock),
		JSON.stringify({ menuShellBlock, menuItemBlock, menuGroupBlock, menuHintBlock }),
	);
	check(
		"Command 层菜单仍贴卡片全宽（防 / 回归）",
		/left: 0;/.test(paletteBaseBlock) &&
			/right: 0;/.test(paletteBaseBlock) &&
			/bottom: calc\(100% \+ 4px\)/.test(paletteBaseBlock) &&
			/z-index: 100/.test(paletteBaseBlock) &&
			/\.chat-palette\.is-anchored,/.test(styleSource),
		JSON.stringify({ paletteBaseBlock }),
	);

	check(
		"+ 按钮打开同一 Command 层；aria-expanded 同步；模型控件可点击",
		chatSource.includes("if (addBtn)") &&
			chatSource.includes('openPalette("command"') &&
			chatSource.includes("function syncPaletteButtons") &&
			chatSource.includes('addBtn?.setAttribute("aria-expanded"') &&
			chatSource.includes('modelBtn?.setAttribute("aria-expanded"') &&
			chatSource.includes('openPalette("model"') &&
			!chatSource.includes("openCommandMenu("),
	);
	check(
		"palette 键盘：↑↓/Enter/Tab/Esc + 面板打开时 Enter 不发送",
		chatSource.includes('e.key === "ArrowDown" || e.key === "ArrowUp"') &&
			chatSource.includes('(e.key === "Enter" || e.key === "Tab")') &&
			chatSource.includes('e.key === "Escape"') &&
			chatSource.includes("paletteEscape()") &&
			chatSource.includes("if (state.streaming || state.palette) return;"),
	);
	check(
		"palette 渲染：分组/当前项勾/空态/选中态样式",
		chatSource.includes("chat-palette-group") &&
			chatSource.includes("chat-palette-item") &&
			chatSource.includes('text: current ? "✓" : ""') &&
			chatSource.includes("没有匹配的模型") &&
			chatSource.includes("pi 没有可用模型，先在 models.json / 登录里配置") &&
			styleSource.includes(".chat-palette-item.is-active") &&
			styleSource.includes(".chat-model-effort") &&
			indexSource.includes("chat-trigger-chevron"),
	);
	const paletteSearchIndex = indexSource.indexOf('id="chat-palette-search"');
	const paletteHeadIndex = indexSource.indexOf('class="chat-palette-head"');
	const paletteListIndex = indexSource.indexOf('id="chat-palette-list"');
	const openPaletteBody = chatSource.slice(chatSource.indexOf("function openPalette"), chatSource.indexOf("function closePalette"));
	check(
		"palette 独立搜索框：顶部 head/list + 搜索查询不读 textarea",
		paletteSearchIndex > paletteHeadIndex &&
			paletteListIndex > paletteSearchIndex &&
			indexSource.includes('type="search"') &&
			indexSource.includes('placeholder="搜索命令…"') &&
			chatSource.includes("搜索模型…") &&
			chatSource.includes("搜索技能…") &&
			chatSource.includes("function paletteQuery") &&
			chatSource.includes("paletteSearchEl?.value") &&
			chatSource.includes("filterPaletteItems(paletteSkillItems(), query)") &&
			chatSource.includes("paletteSearchEl?.focus()") &&
			chatSource.includes('paletteSearchEl.value = ""') &&
			!chatSource.includes("commandQuery") &&
			!openPaletteBody.includes('input.value = ""') &&
			[" .chat-palette-head", ".chat-palette-search", ".chat-palette-list"].every((sel) => styleSource.includes(sel.trim())),
	);
	check(
		"models 虚拟线程兜底：新线程不带 thread，错误不污染空态",
		chatSource.includes("!isNewThread(key, state.threadId)") &&
			chatSource.includes("state.models.length") &&
			!chatSource.includes("state.models.length || state.modelsError") &&
			chatSource.includes('text = "没有匹配的模型"') &&
			chatSource.includes("else text = null") &&
			chatSource.includes("pi 没有可用模型，先在 models.json / 登录里配置"),
	);
	check(
		"技能面板接线：command 技能项 / skill 层 / 开关 / 大小守卫",
		chatSource.includes('id: "skill"') &&
			chatSource.includes('openPalette("skill"') &&
			chatSource.includes("function paletteSkillItems") &&
			chatSource.includes("function toggleProjectSkills") &&
			chatSource.includes("SKILL_WARN_CHARS") &&
			chatSource.includes("SKILL_MAX_CHARS") &&
			chatSource.includes('dataset: { settingsToggle: "projectSkills" }') &&
			chatSource.includes("function pickSkill") &&
			chatSource.includes("data-skill-confirm") &&
			!chatSource.includes("window.confirm") &&
			!chatSource.includes("globalThis.confirm"),
	);
	check(
		"技能设置接口接线：GET/POST settings + GET skills refresh",
		chatSource.includes("/api/chat/settings?") &&
			chatSource.includes('fetch("/api/chat/settings"') &&
			chatSource.includes("/api/chat/skills?") &&
			chatSource.includes("refresh: first") &&
			chatSource.includes('params.set("refresh", "1")'),
	);
	check(
		"技能 chip：选中/移除/发送 body.skill/meta 更新",
		indexSource.includes('id="chat-skill"') &&
			chatSource.includes("function renderSkillChip") &&
			chatSource.includes("chat-skill-remove") &&
			chatSource.includes("skill: state.skill?.name ?? undefined") &&
			chatSource.includes('"skill" in data') &&
			chatSource.includes("user.skill = data.skill ?? null"),
	);
	check(
		"技能/开关样式就位",
		[".chat-palette-switch", ".chat-palette-switch.is-on", ".chat-palette-badge", ".chat-palette-item.is-disabled", ".chat-palette-hint.is-warn", ".chat-palette-confirm", ".chat-skill-remove"].every(
			(sel) => styleSource.includes(sel),
		),
	);
	check("输入卡状态/上下文/面板/技能占位就位", ["chat-model-label", "chat-profile", "chat-context", "chat-palette", "chat-skill"].every((id) => indexSource.includes(`id="${id}"`)));
	check("权限/模型/级别在 chat-row 内，发送最后", indexSource.indexOf('class="chat-row"') < indexSource.indexOf('id="chat-profile"') && indexSource.indexOf('id="chat-profile"') < indexSource.indexOf('id="chat-model-label"') && indexSource.indexOf('id="chat-model-label"') < indexSource.indexOf('id="chat-thinking"') && indexSource.indexOf('id="chat-thinking"') < indexSource.indexOf('id="chat-send"'));
	check("对话栏消息仍走 markdown 渲染", chatSource.includes("mdNode(String(message.text))"));
	check("流式/工具/错误/空态样式就位", [".chat-model-label", ".chat-tool", ".chat-msg.ai.is-streaming", ".chat-stream-cursor", ".chat-notice", ".chat-msg-error", ".chat-empty", ".chat-skeleton"].every((sel) => styleSource.includes(sel)));
	check("输入卡与输入框圆角收敛（16px，不用 28px 的 panel 圆角）", /\.chat-card \{[^}]*border-radius: var\(--dsw-radius-lg\)/s.test(styleSource) && /\.chat-input \{[^}]*border-radius: var\(--dsw-radius-lg\)/s.test(styleSource) && !/\.chat-card \{[^}]*radius-panel/s.test(styleSource));
	check("对话页样式复刻上游：用户气泡 + 输入卡 + info 圆发送钮", styleSource.includes(".chat-msg.user") && styleSource.includes("var(--dsw-specific-bubble)") && styleSource.includes(".chat-card") && styleSource.includes("var(--dsw-specific-input-major)") && styleSource.includes(".chat-send") && styleSource.includes("var(--dsw-alias-button-info-fill)"));
	check(
		"上下文选择：session_ui.contextIds 恢复保存 / 不截断 / prune",
		appSource.includes("loadSessionPrefs") &&
			appSource.includes("updateSessionPrefs") &&
			appSource.includes("function saveChatContext()") &&
			appSource.includes("async function restoreChatContext()") &&
			appSource.includes("pruneChatContext()") &&
			appSource.includes("function addSelectedIds") &&
			appSource.includes("if (open) void restoreChatContext();") &&
			appSource.includes("saveChatContext();") &&
			!appSource.includes("CHAT_CTX_LIMIT") &&
			!appSource.includes("上下文最多选择") &&
			appSource.includes("setDistillMode") &&
			!appSource.slice(appSource.indexOf("function setDistillMode"), appSource.indexOf("function selectMode")).includes("selectedEvs"),
	);
	const contextTag = /<button id="chat-context"[^>]*>/.exec(indexSource)?.[0] ?? "";
	const contextMenuBlock = /\.chat-context-menu \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	const contextBlock = /\.chat-context \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	check(
		"上下文摘要按钮：button + aria + 单行省略 + title；旧 chips 常驻提示移除",
		contextTag.includes('aria-haspopup="dialog"') &&
			contextTag.includes('aria-expanded="false"') &&
			contextTag.includes('aria-controls="chat-context-menu"') &&
			contextTag.includes('title="取消勾选只影响之后的读取"') &&
			/display: inline-flex/.test(contextBlock) &&
			/height: 24px/.test(contextBlock) &&
			/max-width: 100%/.test(contextBlock) &&
			/min-width: 0/.test(contextBlock) &&
			/\.chat-context-summary \{[^}]*text-overflow: ellipsis/s.test(styleSource) &&
			!/overflow-x:\s*auto/.test(contextBlock) &&
			!chatSource.includes("chat-ctx-chip") &&
			!chatSource.includes("chat-ctx-hint") &&
			!styleSource.includes(".chat-ctx-hint") &&
			!styleSource.includes(".chat-ctx-chip"),
		JSON.stringify({ contextTag, contextBlock }),
	);
	check(
		"上下文弹层：dialog + dsh 菜单外观 + 260/420 宽度",
		indexSource.includes('id="chat-context-menu"') &&
			indexSource.includes('role="dialog"') &&
			/width: fit-content/.test(contextMenuBlock) &&
			/min-width:min\(260px, 100%\)/.test(contextMenuBlock) &&
			/max-width:min\(420px, 100%\)/.test(contextMenuBlock) &&
			!contextMenuBlock.includes("100vw") &&
			/border-radius: var\(--dsw-radius-lg\)/.test(styleSource) &&
			/var\(--dsw-menu-surface-fill\)/.test(styleSource) &&
			chatSource.includes("renderContextMenu") &&
			chatSource.includes("chat-context-menu-head") &&
			chatSource.includes("chat-context-menu-list") &&
			chatSource.includes("chat-context-menu-new"),
		JSON.stringify({ contextMenuBlock }),
	);
	const contextRowBlock = /\.chat-context-row \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	const contextRowMainBlock = /\.chat-context-row-main \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	const contextRemoveBlock = /\.chat-context-row-remove \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	const contextHeadBlock = /\.chat-context-menu-head,\n\.chat-context-menu-foot \{[^}]*\}/s.exec(styleSource)?.[0] ?? "";
	check(
		"上下文条目尺寸对齐项目菜单：34px / 6px 8px / 13-20 / radius-md",
		/min-height: 34px/.test(contextRowBlock) &&
			/padding: 6px 8px/.test(contextRowBlock) &&
			/border-radius: var\(--dsw-radius-md\)/.test(contextRowBlock) &&
			!/height: 30px/.test(contextRowBlock) &&
			!/padding: 0 6px/.test(contextRowBlock) &&
			/font-size: 13px/.test(contextRowMainBlock) &&
			/line-height: 20px/.test(contextRowMainBlock) &&
			/font-size: 13px/.test(contextHeadBlock) &&
			/line-height: 20px/.test(contextHeadBlock) &&
			/width: 18px/.test(contextRemoveBlock) &&
			/height: 18px/.test(contextRemoveBlock),
		JSON.stringify({ contextRowBlock, contextRowMainBlock, contextRemoveBlock, contextHeadBlock }),
	);
	check(
		"上下文锚定与交互：offset 4/left、移除到 0 关闭、清空关闭、上下文摘要纯函数",
		chatSource.includes("CONTEXT_MENU_ANCHOR") &&
			chatSource.includes("offset: 4") &&
			chatSource.includes('align: "left"') &&
			chatSource.includes("positionAnchoredMenu(contextMenuEl, contextBtn, CONTEXT_MENU_ANCHOR)") &&
			chatSource.includes("contextSummaryLabel") &&
			chatSource.includes("if (next.length === 0) closeContextMenu") &&
			chatSource.includes("setContextIds([])") &&
			indexSource.includes('id="chat-context-menu"'),
	);
	check(
		"chat 上下文接线：选中集 / send contextIds / meta.context / 以此新开",
		chatSource.includes("getSelectedIds") &&
			chatSource.includes("contextIds: contextSelection") &&
			chatSource.includes("data.context") &&
			chatSource.includes("以此新开") &&
			chatSource.includes("newThreadPreservingSelection") &&
			indexSource.includes('id="chat-context"'),
	);
	check("勾选列改名 no-select（不再用 no-distill）", styleSource.includes(".ev.no-select") && !appSource.includes("no-distill") && !styleSource.includes("no-distill"));
	check(
		"T7 输入卡状态：profile 可点击 + 审批/权限菜单占位",
		/<button id="chat-profile"[^>]*>/.test(indexSource) &&
			!/<button id="chat-profile"[^>]*disabled/.test(indexSource) &&
			!indexSource.includes('id="chat-new"') &&
			indexSource.includes('id="chat-profile-menu"') &&
			indexSource.includes('id="chat-approval"') &&
			indexSource.includes('role="dialog"'),
	);
	check(
		"T7 profile 菜单：三档/说明/full 首次确认/POST settings",
		chatSource.includes("PROFILE_OPTIONS") &&
			["no-tools", "read-only", "full"].every((profile) => chatSource.includes(`id: "${profile}"`)) &&
			chatSource.includes("全量工具会真实修改工作区") &&
			chatSource.includes("function applyProfile") &&
			chatSource.includes('fetch("/api/chat/settings"') &&
			chatSource.includes("fullConfirmed"),
	);
	check(
		"T7 审批弹层：队列/倒计时/本会话允许/POST approval/Esc",
		chatSource.includes("function enqueueApproval") &&
			chatSource.includes("function respondApproval") &&
			chatSource.includes('fetch("/api/chat/approval"') &&
			chatSource.includes("chat-approval-count") &&
			chatSource.includes("chat-approval-timer") &&
			chatSource.includes("本会话允许") &&
			chatSource.indexOf("if (state.approvals.length)") < chatSource.indexOf("if (state.profileMenuOpen)"),
	);
	check(
		"T7 线程记忆：session-prefs threadId/threadNew / 以此新开保留选择",
		chatSource.includes("loadSessionPrefs") &&
			chatSource.includes("getSessionPrefs") &&
			chatSource.includes("function rememberedThreadFor") &&
			chatSource.includes("function rememberThreadFor") &&
			chatSource.includes("function newThread({ preserveSelection = false } = {})") &&
			chatSource.includes("newThread({ preserveSelection: true })") &&
			chatSource.includes("deps.setSelectedIds?.([], { silent: true })") &&
			chatSource.includes('id: "new"') &&
			chatSource.includes('id: "resume"'),
	);
	check(
		"T7 样式：权限菜单/审批弹层/full 警示/新对话",
		[".chat-profile-menu", ".chat-approval", ".chat-approval-card", ".chat-profile.is-full", ".chat-model-label"].every((sel) => styleSource.includes(sel)),
	);

	check(
		"/new 与 /resume 命令、线程列表/切换接线",
		chatSource.includes('id: "new"') &&
			chatSource.includes('id: "resume"') &&
			chatSource.includes("function loadThreads") &&
			chatSource.includes("/api/chat/threads?") &&
			chatSource.includes("function paletteThreadItems") &&
			chatSource.includes("function resumeThread") &&
			chatSource.includes('fetch("/api/chat/resume"') &&
			chatSource.includes("还没有历史对话") &&
			chatSource.includes("item.id === state.threadId"),
	);

	const apiReturnAt = chatSource.lastIndexOf("\n\treturn {");
	const factoryBody = chatSource.slice(0, apiReturnAt);
	const apiBody = chatSource.slice(apiReturnAt);
	const apiMethods = [...apiBody.matchAll(/^\t\t([A-Za-z_$][\w$]*)\s*\(/gm)].map((match) => match[1]);
	const bareApiCalls = apiMethods.filter((name) => new RegExp(`(?<![.\\w])${name}\\s*\\(`).test(factoryBody));
	check(
		"工厂内不裸调返回 API 方法（refreshThread 类 ReferenceError）",
		apiMethods.length >= 8 && bareApiCalls.length === 0 && !factoryBody.includes("await refreshThread("),
		JSON.stringify({ apiMethods, bareApiCalls }),
	);

	console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
	process.exit(failed === 0 ? 0 : 1);
})();
