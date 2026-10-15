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
	const { kindGroup, eventPasses, presetFilters, eventTagLabel, formatDurationMillis, formatElapsedSeconds, fmtTokens, fmtCost, fmtTime, renderMarkdown, fmtRelative, fmtBytes, projectLabel, groupSessions, TrajectorySearchIndex, collectToolNames, eventToolPasses } = lib;

	// ---- 过滤映射 ----
	check("tool → tools 组", kindGroup("tool") === "tools" && kindGroup("bash") === "tools");
	check("thinking → thinking 组", kindGroup("thinking") === "thinking");
	check("system/compaction → context 组", kindGroup("system") === "context" && kindGroup("compaction") === "context");
	check("未知 kind 归入 context", kindGroup("what") === "context");

	const onlyThinking = presetFilters("thinking");
	check("仅思考预设：thinking 通过、其余不过", eventPasses(onlyThinking, "thinking") === true && eventPasses(onlyThinking, "tool") === false && eventPasses(onlyThinking, "text") === false && eventPasses(onlyThinking, "system") === false);
	const all = presetFilters("all");
	check("全部预设：所有组通过", ["thinking", "tool", "text", "system", "user"].every((k) => eventPasses(all, k)));

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
	check("eventToolPasses 空集时全通过", eventToolPasses(new Set(), { kind: "text" }) === true && eventToolPasses(new Set(), { kind: "tool", tool: { name: "read" } }) === true);
	check(
		"eventToolPasses 多选：命中集合的工具行通过，其它工具行与类型不受影响",
		eventToolPasses(new Set(["bash", "read"]), { kind: "tool", tool: { name: "bash" } }) === true &&
			eventToolPasses(new Set(["bash", "read"]), { kind: "tool", tool: { name: "read" } }) === true &&
			eventToolPasses(new Set(["bash", "read"]), { kind: "tool", tool: { name: "edit" } }) === false &&
			eventToolPasses(new Set(["bash"]), { kind: "text" }) === true,
	);

	check("标签：文本行统一显示为输出（最终答复仅靠绿色竖条区分）", eventTagLabel({ kind: "text", isFinal: true }) === "输出" && eventTagLabel({ kind: "text" }) === "输出");
	check("标签：出错工具", eventTagLabel({ kind: "tool", tool: { isError: true } }) === "工具✗");

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
	check("app.js 不再使用 importNode（克隆不移除源节点，会死循环）", !appSource.includes("importNode("));
	check("mdNode 直接移入节点保证循环收敛", /wrapper\.appendChild\(\s*doc\.body\.firstChild\s*\)/.test(appSource));

	console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
	process.exit(failed === 0 ? 0 : 1);
})();
