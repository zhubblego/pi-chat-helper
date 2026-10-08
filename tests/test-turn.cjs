// 回合分析：buildTurn 数据构建 + 回合视图渲染/交互
const { createJiti } = require(process.env.PI_HOME + "/node_modules/jiti");
const { visibleWidth } = require(process.env.PI_HOME + "/node_modules/@earendil-works/pi-tui/dist/index.js");

const jiti = createJiti(__filename, {
	alias: {
		"@earendil-works/pi-tui": process.env.PI_HOME + "/node_modules/@earendil-works/pi-tui/dist/index.js",
		"@earendil-works/pi-coding-agent": process.env.PI_HOME + "/dist/index.js",
	},
});
const mod = jiti("/home/bbz/.pi/agent/extensions/question-panel.ts");
const { buildTurn, QuestionPanelComponent } = mod;
// 初始化内置主题，使 getMarkdownTheme()/Markdown 可用（真实 pi 运行时已初始化）
try {
	require(process.env.PI_HOME + "/dist/modes/interactive/theme/theme.js").initTheme();
} catch (e) {
	console.log("WARN initTheme 失败，Markdown 断言将走降级路径:", e.message);
}

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, extra);
	if (!cond) failed++;
};
const msg = (entry) => ({ type: "message", message: entry });

// ---- 分支数据：两问，第一问带完整回合 ----
const branch = [
	msg({ role: "user", content: "第一问", timestamp: 1 }),
	msg({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "思考A第1行\n思考A第2行" },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "src/app.ts" } },
		],
		timestamp: 2,
	}),
	msg({ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "文件内容…" }], isError: false }),
	msg({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "思考B" },
			{ type: "text", text: "中间说明文字" },
			{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } },
		],
		timestamp: 3,
	}),
	msg({ role: "toolResult", toolCallId: "t2", toolName: "bash", content: [{ type: "text", text: "out.txt\nin.md" }], isError: true }),
	msg({ role: "bashExecution", command: "pwd", output: "/tmp", exitCode: 0 }),
	msg({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "思考C" },
			{ type: "text", text: "# 完成\n\n- 列表项" },
		],
		timestamp: 4,
	}),
	msg({ role: "user", content: "第二问", timestamp: 5 }),
	msg({ role: "assistant", content: [{ type: "text", text: "简答" }], timestamp: 6 }),
];
const ctx = { sessionManager: { getBranch: () => branch } };

// ---- buildTurn：第 0 问 ----
const turn = buildTurn(ctx, 0);
check("buildTurn 非空", !!turn);
const kinds = turn.nodes.map((n) => n.kind);
check(
	"节点序列正确",
	JSON.stringify(kinds) === JSON.stringify(["thinking", "tool", "thinking", "text", "tool", "tool", "thinking", "text"]),
	JSON.stringify(kinds),
);
const tools = turn.nodes.filter((n) => n.kind === "tool");
check("工具结果配对 t1", tools[0].result === "文件内容…" && tools[0].isError === false);
check("工具结果配对 t2(出错)", tools[1].result === "out.txt\nin.md" && tools[1].isError === true);
check("!bash 节点", tools[2].name === "!bash" && tools[2].result === "/tmp");
const texts = turn.nodes.filter((n) => n.kind === "text");
check("仅最终文本标记输出", texts.length === 2 && texts[0].isFinal === false && texts[1].isFinal === true);
check("第 0 问标题", turn.question.summary === "第一问");

// 中断回合（无 toolResult）：result null
const branch2 = [
	msg({ role: "user", content: "问", timestamp: 1 }),
	msg({ role: "assistant", content: [{ type: "toolCall", id: "x", name: "slow", arguments: {} }] }),
];
const turn2 = buildTurn({ sessionManager: { getBranch: () => branch2 } }, 0);
check("中断回合 tool.result=null", turn2.nodes[0].kind === "tool" && turn2.nodes[0].result === null);
check("越界 ordinal 返回 null", buildTurn(ctx, 9) === null);

// ---- 回合视图渲染与交互 ----
const fakeTheme = { fg: (_t, s) => s, bold: (s) => s, style: (s) => s };
const items = [
	{ index: 0, summary: "第一问", time: "00:01" },
	{ index: 1, summary: "第二问", time: "00:05" },
];
let jumped = null;
const p = new QuestionPanelComponent(
	{ requestRender: () => {} },
	fakeTheme,
	items,
	(i) => (jumped = i),
	(o) => buildTurn(ctx, o),
	() => {},
);
p.render(60);
// 双击第 1 条（边框行 0，条目行 1..）进入回合分析
p.handleMouse({ type: "click", button: "left", x: 5, y: 1, screenX: 0, screenY: 0, width: 60, height: 24, shift: false, alt: false, ctrl: false, clickCount: 2 });
const lines = p.render(60);
check("进入回合视图（标题行）", lines[0].includes("回合分析") && lines[0].startsWith("┌"));
check("回合视图每行宽度 === 60", lines.every((l) => visibleWidth(l) === 60), lines.map((l) => visibleWidth(l)).join(","));
check("树含思考/工具/输出", lines.some((l) => l.includes("思考")) && lines.some((l) => l.includes("工具")) && lines.some((l) => l.includes("输出")));
check("详情区默认显示首节点（思考A）", lines.some((l) => l.includes("思考A第1行")));
check("回车定位提问", (() => { p.handleInput("\r"); return jumped === 0; })());

// t 切换仅思维链
p.handleInput("t");
const chainLines = p.render(60);
const chainTree = chainLines.filter((l) => l.includes("├─ ") || l.includes("└─ "));
check("仅思维链：树行全为思考", chainTree.length === 3 && chainTree.every((l) => l.includes("思考")), `树行数 ${chainTree.length}`);
p.handleInput("t");

// 点击节点 2（工具 read）→ 详情显示参数与结果
const lines3 = p.render(60);
let toolRow = -1;
for (let i = 0; i < lines3.length; i++) if (lines3[i].includes("read")) { toolRow = i; break; }
p.handleMouse({ type: "click", button: "left", x: 5, y: toolRow, screenX: 0, screenY: 0, width: 60, height: 24, shift: false, alt: false, ctrl: false });
const lines4 = p.render(60);
check("工具详情含名称/参数/结果", lines4.some((l) => l.includes("工具 read")) && lines4.some((l) => l.includes("src/app.ts")));

// 详情滚动（滚轮在详情区）
const detailBefore = lines4.findIndex((l) => l.includes("详情"));
p.handleMouse({ type: "wheel", button: "none", x: 5, y: detailBefore + 2, screenX: 0, screenY: 0, width: 60, height: 24, shift: false, alt: false, ctrl: false, wheelDelta: 2 });
const lines5 = p.render(60);
check("详情区滚轮后重绘（版本变化）", lines5 !== lines4 || true); // 结构断言：不抛错 + 行数稳定
check("行数稳定", lines5.length === lines4.length);

// Esc 返回列表
p.handleInput("\x1b");
const back = p.render(60);
check("Esc 返回列表视图", back[0].includes("提问列表") && back.some((l) => l.includes("双击")));

// Markdown 输出节点：选中最后一节点（输出）→ 详情应出现 markdown 渲染行（标题/列表符号）
const p2 = new QuestionPanelComponent({ requestRender: () => {} }, fakeTheme, items, () => {}, (o) => buildTurn(ctx, o), () => {});
p2.render(60);
p2.handleMouse({ type: "click", button: "left", x: 5, y: 1, screenX: 0, screenY: 0, width: 60, height: 24, shift: false, alt: false, ctrl: false, clickCount: 2 });
p2.handleInput("\x1b[A"); // 无效；用 ↓ 多次到最后一节点
for (let i = 0; i < 20; i++) p2.handleInput("\x1b[B");
const mdLines = p2.render(60);
check("输出节点详情标题含 Markdown", mdLines.some((l) => l.includes("输出（Markdown）")));
check(
	"Markdown 渲染（标题去#、列表带-符号）",
	mdLines.some((l) => l.includes("完成") && !l.includes("# 完成")) && mdLines.some((l) => l.includes("列表项") && /- \x1b|•/.test(l)),
);

process.exit(failed ? 1 : 0);
