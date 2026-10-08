// question-panel 纯数据逻辑单元测试（jiti 加载 TS，无需 pi 运行时）
const { createJiti } = require(process.env.PI_HOME + "/node_modules/jiti");
const jiti = createJiti(__filename, {
	alias: {
		"@earendil-works/pi-tui": process.env.PI_HOME + "/node_modules/@earendil-works/pi-tui/dist/index.js",
		"@earendil-works/pi-coding-agent": process.env.PI_HOME + "/dist/index.js",
	},
});
const mod = jiti("/home/bbz/.pi/agent/extensions/question-panel.ts");

const { collectQuestions, markerOrdinalForQuestion } = mod;

// 构造假会话分支：user/assistant/toolResult 混排
function msg(entry) {
	return { type: "message", message: entry };
}
const branch = [
	msg({ role: "user", content: "第一问：这是什么？", timestamp: 1700000000000 }),
	msg({
		role: "assistant",
		content: [{ type: "text", text: "回答1" }],
		timestamp: 1700000001000,
	}),
	msg({ role: "user", content: "第二问", timestamp: 1700000002000 }),
	msg({
		role: "assistant",
		content: [{ type: "toolCall", id: "t1", name: "bash" }],
		timestamp: 1700000003000,
	}), // 带工具调用 → 无标记
	msg({ role: "toolResult", toolName: "bash", content: [], timestamp: 1700000003500 }),
	msg({
		role: "assistant",
		content: [{ type: "text", text: "工具后回答" }],
		timestamp: 1700000004000,
	}), // 无工具调用 → 有标记
	msg({ role: "user", content: [{ type: "text", text: "第三问\n第二行" }], timestamp: 1700000005000 }),
	msg({ role: "custom", customType: "x", content: "custom消息", display: true, timestamp: 1 }),
];
const ctx = { sessionManager: { getBranch: () => branch } };

let failed = 0;
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a === b) console.log("PASS", label);
	else {
		failed++;
		console.log("FAIL", label, "\n  actual:", a, "\n  expect:", b);
	}
}

// 1) 提问收集：3 条 user；custom 不算；多行取首行；数组 content 兼容
const qs = collectQuestions(ctx);
eq(
	qs.map((q) => q.summary),
	["第一问：这是什么？", "第二问", "第三问"],
	"collectQuestions 摘要",
);
eq(qs.map((q) => q.index), [0, 1, 2], "collectQuestions 序号");
eq(collectQuestions({ sessionManager: { getBranch: () => [] } }), [], "空分支");

// 2) 标记序号推算：
//    标记序列 = [user1(0), assistant纯文本(1), user2(2), assistant工具(无), toolResult(无), assistant纯文本(3), user3(4)]
eq(markerOrdinalForQuestion(ctx, 0), 0, "第1问标记序号");
eq(markerOrdinalForQuestion(ctx, 1), 2, "第2问标记序号");
eq(markerOrdinalForQuestion(ctx, 2), 4, "第3问标记序号");
eq(markerOrdinalForQuestion(ctx, 9), null, "越界返回 null");

// 3) 工厂注册
const cmds = [];
mod.default({ registerCommand: (n, d) => cmds.push([n, !!d.description, typeof d.handler]) });
eq(cmds, [["questions", true, "function"]], "命令注册");

process.exit(failed ? 1 : 0);
