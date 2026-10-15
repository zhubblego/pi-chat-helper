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
	const { kindGroup, eventPasses, presetFilters, eventTagLabel, fmtDuration, fmtTokens, fmtCost, fmtTime, renderMarkdown } = lib;

	// ---- 过滤映射 ----
	check("tool → tools 组", kindGroup("tool") === "tools" && kindGroup("bash") === "tools");
	check("thinking → thinking 组", kindGroup("thinking") === "thinking");
	check("system/compaction → context 组", kindGroup("system") === "context" && kindGroup("compaction") === "context");
	check("未知 kind 归入 context", kindGroup("what") === "context");

	const onlyThinking = presetFilters("thinking");
	check("仅思考预设：thinking 通过、其余不过", eventPasses(onlyThinking, "thinking") === true && eventPasses(onlyThinking, "tool") === false && eventPasses(onlyThinking, "text") === false && eventPasses(onlyThinking, "system") === false);
	const all = presetFilters("all");
	check("全部预设：所有组通过", ["thinking", "tool", "text", "system", "user"].every((k) => eventPasses(all, k)));

	check("标签：末段文本标记为输出", eventTagLabel({ kind: "text", isFinal: true }) === "输出" && eventTagLabel({ kind: "text" }) === "文本");
	check("标签：出错工具", eventTagLabel({ kind: "tool", tool: { isError: true } }) === "工具✗");

	// ---- 格式化 ----
	check("fmtDuration", fmtDuration(800) === "800ms" && fmtDuration(1500) === "1.5s" && fmtDuration(65000) === "1m05s");
	check("fmtTokens", fmtTokens(999) === "999" && fmtTokens(1500) === "1.5k" && fmtTokens(125000) === "125k" && fmtTokens(2200000) === "2.20M");
	check("fmtCost", fmtCost(0.0012) === "$0.0012" && fmtCost(1.5) === "$1.50");
	check("fmtTime", /^\d{2}:\d{2}$/.test(fmtTime(Date.now())));

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
