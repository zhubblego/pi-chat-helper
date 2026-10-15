// 无头真渲染验证：伪造终端跑 TuiAltScreen 全链路，验证 findTranscript/jumpToMarker
const path = require("node:path");
const PI_TUI = process.env.PI_HOME + "/node_modules/@earendil-works/pi-tui";
const { TuiAltScreen, ScrollView, Container } = require(PI_TUI + "/dist/index.js");
const { getScrollViewBox } = require(PI_TUI + "/dist/layout.js");
const { createJiti } = require(process.env.PI_HOME + "/node_modules/jiti");

const jiti = createJiti(__filename, {
	alias: {
		"@earendil-works/pi-tui": PI_TUI + "/dist/index.js",
		"@earendil-works/pi-coding-agent": process.env.PI_HOME + "/dist/index.js",
	},
});
const mod = jiti(path.join(__dirname, "..", "question-panel.ts"));
const { findTranscript, jumpToMarker } = mod;

// ---- 伪终端：收集输出，尺寸 100x30 ----
const writes = [];
const fakeTerminal = {
	columns: 100,
	rows: 30,
	write: (s) => writes.push(s),
	start: (_onInput, _onResize) => {},
	stop: () => {},
	hideCursor: () => {},
	showCursor: () => {},
	setTitle: () => {},
};

// ---- 构造 transcript：标记组件与普通组件混排 ----
const mk = (lines) => ({
	render: () => [...lines],
	invalidate: () => {},
});
const MARK_A = "\x1b]133;A\x07";
const doc = new Container();
doc.addChild(mk([MARK_A + "第1条用户提问", "内容行"]));
doc.addChild(mk([MARK_A + "assistant 纯文本回答"]));
doc.addChild(mk(["tool 调用块（无标记）"]));
doc.addChild(mk([MARK_A + "assistant 工具后纯文本回答"]));
for (let i = 1; i <= 40; i++) doc.addChild(mk([`填充行 ${i}`])); // 保证可滚动
doc.addChild(mk([MARK_A + "第2条用户提问"]));

const tui = new TuiAltScreen(fakeTerminal);
tui.setLayoutRoot(new ScrollView(doc, { follow: "none" }));
tui.start();
tui.renderNow(true);

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, extra);
	if (!cond) failed++;
};

// 1) currentLayout 存在且有 root
const layout = tui.currentLayout;
check("currentLayout 存在", !!layout);
check("frame.root 存在", !!layout?.root);

// 2) findTranscript 找到带标记的 scroll box
const found = findTranscript(tui);
check("findTranscript 命中", !!found, found ? "" : "（返回 null）");
check("内容行包含标记", !!found && found.lines.some((l) => /^\x1b\]133;A/.test(l ?? "")));

// 3) 官方 getScrollViewBox 交叉验证同一个 scroll view
if (found) {
	const box = getScrollViewBox(layout, found.scrollView);
	check("与官方 getScrollViewBox 一致", !!box && box.scrollContentLines === found.lines);
	const markers = found.lines.map((l, i) => (/^\x1b\]133;A/.test(l ?? "") ? i : -1)).filter((i) => i >= 0);
	console.log("  标记行：", JSON.stringify(markers));
	check("标记数 = 4", markers.length === 4, `实际 ${markers.length}`);
}

// 4) 跳转：第 0 个标记 → scrollTop = markerRow - 1；再跳第 2 个
if (found) {
	const ok0 = jumpToMarker(tui, 0);
	const markers0 = found.lines.map((l, i) => (/^\x1b\]133;A/.test(l ?? "") ? i : -1)).filter((i) => i >= 0);
	check("跳转第0个标记成功", ok0);
	check("scrollTop = row-1", found.scrollView.scrollTop === Math.max(0, markers0[0] - 1), `实际 ${found.scrollView.scrollTop}，期望 ${Math.max(0, markers0[0] - 1)}`);

	const ok3 = jumpToMarker(tui, 3);
	const contentH = found.lines.length;
	const viewportH = found.scrollView.viewportHeight;
	const clamped3 = Math.min(Math.max(0, markers0[3] - 1), Math.max(0, contentH - viewportH));
	check("跳转第3个标记成功", ok3);
	check("scrollTop 钳制后到位", found.scrollView.scrollTop === clamped3, `实际 ${found.scrollView.scrollTop}，期望 ${clamped3}（目标行在末尾被钳制属正常）`);

	check("越界 ordinal 返回 false", jumpToMarker(tui, 99) === false);
}

tui.stop({ preserveScreen: true });
process.exit(failed ? 1 : 0);
