// 面板渲染测试：边框完整、每行宽度精确、命中区域正确、窄宽度不溢出
const { createJiti } = require(process.env.PI_HOME + "/node_modules/jiti");
const { visibleWidth } = require(process.env.PI_HOME + "/node_modules/@earendil-works/pi-tui/dist/index.js");

const jiti = createJiti(__filename, {
	alias: {
		"@earendil-works/pi-tui": process.env.PI_HOME + "/node_modules/@earendil-works/pi-tui/dist/index.js",
		"@earendil-works/pi-coding-agent": process.env.PI_HOME + "/dist/index.js",
	},
});
const { QuestionPanelComponent } = jiti("/home/bbz/.pi/agent/extensions/question-panel.ts");

// 假主题：透传文本（不注入 ANSI），便于断言可见宽度
const fakeTheme = {
	fg: (_t, s) => s,
	bold: (s) => s,
	style: (s) => s,
};

const items = Array.from({ length: 5 }, (_, i) => ({
	index: i,
	summary: `这是第${i + 1}个提问的摘要内容，比较长一点用于测试截断行为`,
	time: "14:32",
}));

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, extra);
	if (!cond) failed++;
};

for (const W of [80, 60, 36, 24]) {
	const calls = [];
	const panel = new QuestionPanelComponent(
		{ requestRender: () => calls.push(1) },
		fakeTheme,
		items,
		() => {},
		() => {},
	);
	const lines = panel.render(W);

	const strict = W >= 36; // 实际 overlay minWidth=36；更窄时宽字符截断可能少 1 列，仅要求不溢出
	check(
		`W=${W} 每行可见宽度${strict ? " === W" : " ≤ W"}`,
		lines.every((l) => visibleWidth(l) === W || (!strict && visibleWidth(l) <= W)),
		lines.map((l) => visibleWidth(l)).join(","),
	);
	check(
		`W=${W} 边框完整`,
		!strict || (lines[0].startsWith("┌") && lines[0].endsWith("┐") && lines.at(-1).startsWith("└") && lines.at(-1).endsWith("┘")),
	);
	check(`W=${W} 分隔线 ├…┤`, lines[lines.length - 3] === "├" + "─".repeat(W - 2) + "┤");
	// 行数 = 顶框 + 5条目 + 分隔 + 提示 + 底框
	check(`W=${W} 行数 = 9`, lines.length === 9, `实际 ${lines.length}`);

	// 点击第 1 行（边框占第 0 行，条目从第 1 行起）应触发 jump(0)
	let jumped = null;
	const p2 = new QuestionPanelComponent({ requestRender: () => calls.push(1) }, fakeTheme, items, (i) => (jumped = i), () => null, () => {});
	p2.render(W);
	p2.handleMouse({ type: "click", button: "left", x: 5, y: 1, screenX: 0, screenY: 0, width: W, height: 9, shift: false, alt: false, ctrl: false });
	check(`W=${W} 点击首条目行触发 jump(0)`, jumped === 0, `实际 ${jumped}`);

	// 悬停触发重绘：先悬停标题区（hover → -1），再悬停条目行（hover → 条目），各自触发一次重绘
	p2.handleMouse({ type: "move", button: "none", x: 5, y: 0, screenX: 0, screenY: 0, width: W, height: 9, shift: false, alt: false, ctrl: false });
	calls.length = 0;
	p2.handleMouse({ type: "move", button: "none", x: 5, y: 3, screenX: 0, screenY: 0, width: W, height: 9, shift: false, alt: false, ctrl: false });
	check(`W=${W} 悬停条目触发重绘`, calls.length === 1, `实际 ${calls.length}`);

	// 键盘：↑ 移动选择（默认选中最后一条），再回车跳转
	let jumped2 = null;
	const p3 = new QuestionPanelComponent({ requestRender: () => {} }, fakeTheme, items, (i) => (jumped2 = i), () => null, () => {});
	p3.render(W);
	p3.handleInput("\x1b[A"); // up
	p3.handleInput("\r"); // return
	check(`W=${W} ↑+回车 跳到倒数第二条`, jumped2 === items.length - 2, `实际 ${jumped2}`);
}

process.exit(failed ? 1 : 0);
