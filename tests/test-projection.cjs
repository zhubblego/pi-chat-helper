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
			{ type: "text", text: "先看文件" },
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
	// 轮间 system 补丁（紧贴下一问前落盘，仅 1ms 之差）：应划归下一轮开头而非本轮末尾
	msg("sysp1", "cp1", 6999, { role: "system", content: "", sections: { skills: "<skills>新技能清单</skills>" } }),
	msg("u2", "sysp1", 7000, { role: "user", content: "第二问" }),
	msg("a3", "u2", 8000, {
		role: "assistant",
		content: [{ type: "text", text: "很长的输出".repeat(600) }],
	}),
	// 末尾孤儿补丁（下一问尚未落盘）：按时间顺序归最后一轮末尾，不丢事件
	msg("sysp2", "a3", 9000, { role: "system", content: "", sections: { tools: "<tools>…</tools>" }, toolsAdded: [{ name: "newtool" }] }),
	// context_edit：先整轮剔除第 2 轮（u2/a3 → null），聚合显示；再部分恢复 u2 → 不算整轮隐藏
	{ type: "context_edit", id: "ce1", parentId: "sysp2", timestamp: H, targetId: "u2", replacement: null },
	{ type: "context_edit", id: "ce2", parentId: "ce1", timestamp: H, targetId: "a3", replacement: null },
	{ type: "context_edit", id: "ce3", parentId: "ce2", timestamp: H, targetId: "u2", replacement: { content: "第二问（恢复）" } },
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
	check("坏行被跳过（entryCount=15）", proj.meta.entryCount === 15, String(proj.meta.entryCount));

	const pre = proj.questions[0];
	check("起始分组事件 = 模型+系统", pre.events.map((e) => e.kind).join(",") === "model,system", pre.events.map((e) => e.kind).join(","));

	const q0 = proj.questions[1];
	check(
		"问题1 事件链（含回合尾部的压缩边界）",
		q0.events.map((e) => e.kind).join(",") === "user,thinking,text,tool,thinking,answer,bash,compaction",
		q0.events.map((e) => e.kind).join(","),
	);
	const tool = q0.events.find((e) => e.kind === "tool");
	check("工具参数与结果配对", tool.tool.name === "read" && tool.tool.argsText.includes("a.ts") && tool.tool.result === "文件内容" && tool.tool.isError === false);
	check("工具耗时来自 toolResult.durationMs", tool.tool.durationMs === 30);
	check(
		"过程/回答按 stopReason 区分（toolUse→text，stop→answer，无 isFinal）",
		q0.events.find((e) => e.kind === "text").text === "先看文件" &&
			q0.events.find((e) => e.kind === "answer").text === "# 结果\n\n完成" &&
			q0.events.every((e) => e.isFinal === undefined),
	);
	check(
		"问题1 统计",
		q0.stats.events === 8 && q0.stats.thinking === 2 && q0.stats.tools === 2 && q0.stats.errors === 0 && q0.stats.tokens === 43 && q0.stats.cost === 0.001 && q0.stats.durationMs === 2000,
		JSON.stringify(q0.stats),
	);
	check("问题1 摘要", q0.summary === "第一问：帮我看看", q0.summary);

		const q1 = proj.questions[2];
check(
		"问题2 事件链（轮间补丁归本轮开头、末尾孤儿与聚合编辑归本轮末尾）",
		q1.events.map((e) => e.kind).join(",") === "system,user,answer,system,context-edit",
		q1.events.map((e) => e.kind).join(","),
);
check("轮间补丁在提问行之前且内容正确", q1.events[0].id === "sysp1:sys" && q1.events[0].system.sections[0].name === "skills");
check("末尾孤儿补丁留在本轮末尾（toolsAdded 解析）", q1.events.some((e) => e.id === "sysp2:sys" && e.system.toolsAdded.join(",") === "newtool"));
check("连续 context_edit 聚合为一条（×3，含恢复项）", q1.events.at(-1).kind === "context-edit" && q1.events.at(-1).contextEdit.edits.length === 3 && q1.events.at(-1).preview === "上下文编辑 ×3");
check("部分剔除不算整轮隐藏（u2 已恢复、a3 仍剔除）", q1.modelHidden !== true);
check("问题 1 未被编辑，不标隐藏", q0.modelHidden !== true);

// ---- 模型视角边界（最后一条 compaction → inContext 标记） ----
check("起始分组事件标记已摘要（compaction 之前）", pre.events.every((e) => e.inContext === false));
check(
	"问题1 压缩边界前事件全部标记已摘要",
	q0.events.filter((e) => e.kind !== "compaction").every((e) => e.inContext === false),
	JSON.stringify(q0.events.map((e) => [e.kind, e.inContext])),
);
check("压缩事件本身仍在上下文（不打 false 标记）", q0.events.find((e) => e.kind === "compaction").inContext === undefined);
check("压缩后条目不标记（含 system 补丁与聚合编辑）", q1.events.every((e) => e.inContext === undefined), JSON.stringify(q1.events.map((e) => [e.kind, e.inContext])));

	// ---- light / full ----
	const light = toLight(proj);
	const lightSys = light.questions[0].events.find((e) => e.kind === "system");
	check("light 系统事件只留段落名与长度", Array.isArray(lightSys.system.sections) && lightSys.system.sections[0].name === "preamble" && lightSys.system.sections[0].chars === 5000 && lightSys.system.sections[0].text === undefined);
	const fullSys = findEvent(proj, lightSys.id);
	check("full 系统事件保留段落正文", fullSys.system.sections[0].text.length === 5000);
	const lightText = light.questions[2].events.find((e) => e.kind === "answer");
	check("light 超长文本截断", lightText.truncated === true && lightText.text.length === LIGHT_CAP, `len=${lightText.text.length}`);
	const fullText = findEvent(proj, lightText.id);
	check("full 超长文本完整", fullText.text.length === 5 * 600 && fullText.text.length > LIGHT_CAP, `len=${fullText.text.length}`);
	check("findEvent 命中 part id", findEvent(proj, "a2:p0") !== null);
	check("findEvent 未命中返回 null", findEvent(proj, "nope") === null);

	// ---- 分支重建 ----
	const projBranch = buildProjection(branchFile);
	const texts = projBranch.questions.flatMap((q) => q.events.filter((e) => e.kind === "answer").map((e) => e.text));
	check("活动分支取最后叶子", texts.includes("活动分支回答") && !texts.includes("被放弃的分支"), JSON.stringify(texts));
	check("无 compaction 会话不打任何 inContext 标记", projBranch.questions.every((q) => q.events.every((e) => e.inContext === undefined)));
	const entries = mod.parseSessionFile(branchFile).entries;
	check("activeBranch 沿 parentId 回溯", activeBranch(entries).map((e) => e.id).join(",") === "u1,a1,a2b", activeBranch(entries).map((e) => e.id).join(","));

	// ---- 模型调用失败：errorMessage → 错误事件 ----
	const errFile = writeSession("err.jsonl", [
		{ type: "session", version: 3, id: "sess-3", timestamp: H, cwd: "/tmp/proj" },
		msg("u1", null, 1000, { role: "user", content: "问题" }),
		msg("e1", "u1", 2000, { role: "assistant", model: "glm-5.1", provider: "prov", stopReason: "error", errorMessage: "Request timed out.", content: [] }),
		msg("e2", "e1", 3000, { role: "assistant", model: "m2", provider: "prov", stopReason: "error", errorMessage: "404 no active route found", content: [{ type: "thinking", thinking: "半截思考" }] }),
	]);
	const errProj = buildProjection(errFile);
	const errQ = errProj.questions[0];
	check("errorMessage → 错误事件（content 为空也不丢）", errQ.events.map((e) => e.kind).join(",") === "user,error,error,thinking", errQ.events.map((e) => e.kind).join(","));
	const errEv = errQ.events.find((e) => e.kind === "error");
	check("错误事件内容与摘要", errEv.error.message === "Request timed out." && errEv.preview === "错误：Request timed out." && errEv.error.stopReason === "error", JSON.stringify(errEv.preview));
	check("错误事件带模型信息", errEv.error.model === "glm-5.1" && errEv.msg.model === "glm-5.1");
	check("错误计入轮次统计", errQ.stats.errors === 2 && errQ.stats.events === 4, JSON.stringify(errQ.stats));
	const errLight = toLight(errProj).questions[0].events.find((e) => e.kind === "error");
	check("light 投影保留错误正文", errLight.error.message === "Request timed out." && errLight.truncated === false);

	// 整轮剔除后恢复验证：在 ce3 之后把 a3 也恢复 → 两轮都不隐藏
	const projHidden = buildProjection(mainFile);
	check("主 fixture 部分恢复后无整轮隐藏", projHidden.questions.every((x) => x.modelHidden !== true));

	// ---- 整轮全部剔除 → modelHidden = true ----
	const hiddenFile = writeSession("hidden.jsonl", [
		{ type: "session", version: 3, id: "sess-h", timestamp: H, cwd: "/tmp/proj" },
		msg("hu1", null, 1000, { role: "user", content: "问" }),
		msg("ha1", "hu1", 2000, { role: "assistant", content: [{ type: "text", text: "答" }], stopReason: "stop" }),
		msg("hu2", "ha1", 3000, { role: "user", content: "问 2" }),
		msg("ha2", "hu2", 4000, { role: "assistant", content: [{ type: "text", text: "答 2" }], stopReason: "stop" }),
		{ type: "context_edit", id: "hce1", parentId: "ha2", timestamp: H, targetId: "hu1", replacement: null },
		{ type: "context_edit", id: "hce2", parentId: "hce1", timestamp: H, targetId: "ha1", replacement: null },
	]);
	const hiddenProj = buildProjection(hiddenFile);
	const hq0 = hiddenProj.questions.find((x) => x.index === 0);
	const hq1 = hiddenProj.questions.find((x) => x.index === 1);
	check("整轮全部剔除 → modelHidden=true（未编辑轮不受影响）", hq0.modelHidden === true && hq1.modelHidden !== true && hq0.editableIds.join(",") === "hu1,ha1");

	// ---- 无 id 的遗留格式按文件顺序 ----
	const legacyEntries = [{ type: "message", message: { role: "user", content: "旧" } }];
	check("无 id 时按文件顺序返回", activeBranch(legacyEntries).length === 1);

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
	process.exit(failed === 0 ? 0 : 1);
})();
