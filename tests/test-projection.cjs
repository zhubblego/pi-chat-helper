// 轨迹投影层：分组 / 工具配对 / 统计 / 分支重建 / light 截断 / 坏行容错
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, cond ? "" : extra);
	if (!cond) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-proj-"));
const writeSession = (name, lines) => {
	const file = path.join(tmp, name);
	fs.writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
	return file;
};
const H = "2026-01-01T00:00:00.000Z";
const msg = (id, parentId, ts, message) => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date(ts).toISOString(),
	message: { ...message, timestamp: ts },
});

const mainFile = writeSession("main.jsonl", [
	{ type: "session", version: 3, id: "sess-1", timestamp: H, cwd: "/tmp/proj" },
	{ type: "model_change", id: "mc1", parentId: null, timestamp: H, provider: "prov", modelId: "model-x" },
	msg("sys1", "mc1", 1000, {
		role: "system",
		content: "",
		sections: { preamble: "P".repeat(5000), cwd: "<cwd>/tmp/proj</cwd>" },
		toolsAdded: [{ name: "read" }, { name: "bash" }],
	}),
	msg("u1", "sys1", 2000, { role: "user", content: "第一问：帮我看看" }),
	msg("a1", "u1", 3000, {
		role: "assistant",
		model: "model-x",
		provider: "prov",
		usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } },
		durationMs: 1200,
		stopReason: "toolUse",
		content: [
			{ type: "thinking", thinking: "想A\n第二行", thinkingSignature: "sig" },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
		],
	}),
	msg("r1", "a1", 4000, {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "read",
		content: [{ type: "text", text: "文件内容" }],
		isError: false,
		durationMs: 30,
	}),
	msg("a2", "r1", 5000, {
		role: "assistant",
		model: "model-x",
		provider: "prov",
		usage: { input: 20, output: 8, totalTokens: 28 },
		durationMs: 800,
		stopReason: "stop",
		content: [
			{ type: "thinking", thinking: "想B" },
			{ type: "text", text: "# 结果\n\n完成" },
		],
	}),
	msg("b1", "a2", 6000, { role: "bashExecution", command: "ls", output: "x.txt", exitCode: 0 }),
	{ type: "compaction", id: "cp1", parentId: "b1", timestamp: H, summary: "压缩摘要", firstKeptEntryId: "u2", tokensBefore: 12345 },
	msg("u2", "cp1", 7000, { role: "user", content: "第二问" }),
	msg("a3", "u2", 8000, {
		role: "assistant",
		content: [{ type: "text", text: "很长的输出".repeat(600) }],
	}),
	"{坏行，不是合法 JSON}",
]);

const branchFile = writeSession("branch.jsonl", [
	{ type: "session", version: 3, id: "sess-2", timestamp: H, cwd: "/tmp/proj" },
	msg("u1", null, 1000, { role: "user", content: "问" }),
	msg("a1", "u1", 2000, { role: "assistant", content: [{ type: "text", text: "主回答" }] }),
	msg("forkA", "a1", 3000, { role: "assistant", content: [{ type: "text", text: "被放弃的分支" }] }),
	msg("a2b", "a1", 4000, { role: "assistant", content: [{ type: "text", text: "活动分支回答" }] }),
]);

(async () => {
	const mod = await import(pathToFileURL(path.join(__dirname, "..", "trajectory-web", "server", "session.mjs")).href);
	const { buildProjection, toLight, findEvent, activeBranch, LIGHT_CAP } = mod;

	// ---- 主 fixture ----
	const proj = buildProjection(mainFile);
	check("问题数 = 起始 + 2", proj.questions.length === 3, `got ${proj.questions.length}`);
	check("一级分组序号 -1/0/1", proj.questions.map((q) => q.index).join(",") === "-1,0,1", proj.questions.map((q) => q.index).join(","));
	check("meta.questionCount = 2", proj.meta.questionCount === 2);
	check("坏行被跳过（entryCount=10）", proj.meta.entryCount === 10, String(proj.meta.entryCount));

	const pre = proj.questions[0];
	check("起始分组事件 = 模型+系统", pre.events.map((e) => e.kind).join(",") === "model,system", pre.events.map((e) => e.kind).join(","));

	const q0 = proj.questions[1];
	check(
		"问题1 事件链（含回合尾部的压缩边界）",
		q0.events.map((e) => e.kind).join(",") === "user,thinking,tool,thinking,text,bash,compaction",
		q0.events.map((e) => e.kind).join(","),
	);
	const tool = q0.events.find((e) => e.kind === "tool");
	check("工具参数与结果配对", tool.tool.name === "read" && tool.tool.argsText.includes("a.ts") && tool.tool.result === "文件内容" && tool.tool.isError === false);
	check("工具耗时来自 toolResult.durationMs", tool.tool.durationMs === 30);
	check("问题1 最后一个 text 标 isFinal", q0.events.filter((e) => e.kind === "text").every((e) => e.isFinal === true));
	check(
		"问题1 统计",
		q0.stats.events === 7 && q0.stats.thinking === 2 && q0.stats.tools === 2 && q0.stats.errors === 0 && q0.stats.tokens === 43 && q0.stats.cost === 0.001 && q0.stats.durationMs === 2000,
		JSON.stringify(q0.stats),
	);
	check("问题1 摘要", q0.summary === "第一问：帮我看看", q0.summary);

	const q1 = proj.questions[2];
	check("问题2 事件链", q1.events.map((e) => e.kind).join(",") === "user,text", q1.events.map((e) => e.kind).join(","));

	// ---- light / full ----
	const light = toLight(proj);
	const lightSys = light.questions[0].events.find((e) => e.kind === "system");
	check("light 系统事件只留段落名与长度", Array.isArray(lightSys.system.sections) && lightSys.system.sections[0].name === "preamble" && lightSys.system.sections[0].chars === 5000 && lightSys.system.sections[0].text === undefined);
	const fullSys = findEvent(proj, lightSys.id);
	check("full 系统事件保留段落正文", fullSys.system.sections[0].text.length === 5000);
	const lightText = light.questions[2].events.find((e) => e.kind === "text");
	check("light 超长文本截断", lightText.truncated === true && lightText.text.length === LIGHT_CAP, `len=${lightText.text.length}`);
	const fullText = findEvent(proj, lightText.id);
	check("full 超长文本完整", fullText.text.length === 5 * 600 && fullText.text.length > LIGHT_CAP, `len=${fullText.text.length}`);
	check("findEvent 命中 part id", findEvent(proj, "a2:p0") !== null);
	check("findEvent 未命中返回 null", findEvent(proj, "nope") === null);

	// ---- 分支重建 ----
	const projBranch = buildProjection(branchFile);
	const texts = projBranch.questions.flatMap((q) => q.events.filter((e) => e.kind === "text").map((e) => e.text));
	check("活动分支取最后叶子", texts.includes("活动分支回答") && !texts.includes("被放弃的分支"), JSON.stringify(texts));
	const entries = mod.parseSessionFile(branchFile).entries;
	check("activeBranch 沿 parentId 回溯", activeBranch(entries).map((e) => e.id).join(",") === "u1,a1,a2b", activeBranch(entries).map((e) => e.id).join(","));

	// ---- 无 id 的遗留格式按文件顺序 ----
	const legacyEntries = [{ type: "message", message: { role: "user", content: "旧" } }];
	check("无 id 时按文件顺序返回", activeBranch(legacyEntries).length === 1);

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
	process.exit(failed === 0 ? 0 : 1);
})();
