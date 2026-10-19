// codex 轨迹源：列表扫描 + rollout→pi 条目翻译 + 投影层复用
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, cond ? "" : extra);
	if (!cond) failed++;
};

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-codex-"));
// codexRoot 模拟 ~/.codex/sessions；session_index.jsonl 在其上一级（模拟 ~/.codex）
const codexRoot = path.join(tmp, "sessions");
const day = path.join(codexRoot, "2026", "01", "01");
fs.mkdirSync(day, { recursive: true });
const UUID = "019f592a-0d06-7e41-b3bc-df1f510cdbbd";
const file = path.join(day, `rollout-2026-01-01T00-00-00-${UUID}.jsonl`);
const H = (o) => JSON.stringify(o);
fs.writeFileSync(path.join(tmp, "session_index.jsonl"), `${H({ id: UUID, thread_name: "确认视图提示词", updated_at: "2026-01-01T00:00:05Z" })}\n`);
fs.writeFileSync(
	file,
	[
		H({ timestamp: "2026-01-01T00:00:00.100Z", type: "session_meta", payload: { id: UUID, cwd: "/tmp/proj", originator: "codex-tui", base_instructions: { text: "你是 Codex，一个编码代理。" } } }),
		H({ timestamp: "2026-01-01T00:00:00.300Z", type: "response_item", payload: { type: "message", id: "msg_dev", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>\n## Skills" }] } }),
		H({ timestamp: "2026-01-01T00:00:00.350Z", type: "response_item", payload: { type: "message", id: "msg_ag", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /tmp/proj\n\n<INSTRUCTIONS>" }] } }),
		H({ timestamp: "2026-01-01T00:00:00.400Z", type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "max" } }),
		H({ timestamp: "2026-01-01T00:00:00.400Z", type: "response_item", payload: { type: "message", id: "msg_u1", role: "user", content: [{ type: "input_text", text: "跑一下测试" }] } }),
		H({ timestamp: "2026-01-01T00:00:01.000Z", type: "response_item", payload: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "先看测试" }], encrypted_content: "gAAA" } }),
		H({ timestamp: "2026-01-01T00:00:02.000Z", type: "response_item", payload: { type: "function_call", id: "fc_1", name: "wait", arguments: '{"cell_id":"84"}', call_id: "call_1" } }),
		H({ timestamp: "2026-01-01T00:00:03.000Z", type: "response_item", payload: { type: "function_call_output", id: "fco_1", call_id: "call_1", output: [{ type: "input_text", text: "done" }] } }),
		H({ timestamp: "2026-01-01T00:00:04.000Z", type: "response_item", payload: { type: "message", id: "msg_a1", role: "assistant", content: [{ type: "output_text", text: "测试通过" }] } }),
		"{坏行跳过",
		H({ timestamp: "2026-01-01T00:00:05.000Z", type: "compacted", payload: { message: "" } }),
		H({ timestamp: "2026-01-01T00:00:06.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "max" } }),
		H({ timestamp: "2026-01-01T00:00:07.000Z", type: "event_msg", payload: { type: "token_count" } }),
	].join("\n"),
);

(async () => {
	const codex = await import(path.join(ROOT, "trajectory-web", "server", "codex.mjs"));
	const session = await import(path.join(ROOT, "trajectory-web", "server", "session.mjs"));

	// ---- 列表扫描 ----
	const list = codex.listCodexSessions({ codexRoot, now: Date.now() + 10_000 });
	check("列表 1 会话", list.length === 1);
	check("id 取自文件名", list[0]?.id === UUID);
	check("cwd 解析自 session_meta", list[0]?.projectPath === "/tmp/proj");
	check("首条用户消息", (list[0]?.firstMessage ?? "").includes("跑一下测试"));
	check("session_index 的 thread_name 作标题", list[0]?.name === "确认视图提示词", String(list[0]?.name));
	check("live（新鲜 mtime）", list[0]?.live === true);
	const empty = path.join(codexRoot, "empty-root");
	fs.mkdirSync(empty);
	check("空目录 0 会话", codex.listCodexSessions({ codexRoot: empty }).length === 0);

	// ---- 翻译层 ----
	const { header, entries } = codex.readCodexSession(file);
	check("header id/cwd", header?.id === UUID && header?.cwd === "/tmp/proj");
	check("event_msg 跳过 + model/effort 不重复：共 9 条", entries.length === 9, String(entries.length));
	check("parentId 顺序链", entries.every((e, i) => (i === 0 ? e.parentId === null : e.parentId === entries[i - 1].id)));
	const byId = new Map(entries.map((e) => [e.id, e]));
	const merged = byId.get("cx-sys-base")?.message;
	check("连续上下文注入合并为一条 system 条目", merged?.role === "system" && Object.keys(merged.sections).join(",") === "base_instructions,skills_instructions,AGENTS.md", Object.keys(merged?.sections ?? {}).join(","));
	check("base_instructions 段落", merged.sections.base_instructions === "你是 Codex，一个编码代理。");
	check("developer 注入段落（skills_instructions）", merged.sections.skills_instructions?.startsWith("<skills_instructions>"));
	check("user 角色的 AGENTS.md 注入段落", merged.sections["AGENTS.md"]?.startsWith("# AGENTS.md"));
	check("turn_context.effort → thinking_level_change（重复值不再发）", byId.get("cx-level-2")?.thinkingLevel === "max" && entries.filter((e) => e.type === "thinking_level_change").length === 1, JSON.stringify(entries.filter((e) => e.type === "thinking_level_change")));
	check("user 翻译", byId.get("msg_u1")?.message?.content?.[0]?.text === "跑一下测试");
	check("reasoning→thinking 明文", byId.get("rs_1")?.message?.content?.[0]?.type === "thinking" && byId.get("rs_1").message.content[0].text === "先看测试");
	const callPart = byId.get("fc_1")?.message?.content?.[0];
	check("function_call→toolCall（arguments 解析为对象）", callPart?.type === "toolCall" && callPart.name === "wait" && callPart.id === "call_1" && callPart.arguments?.cell_id === "84");
	const outMsg = byId.get("fco_1")?.message;
	check("output→toolResult（call_id 配对）", outMsg?.role === "toolResult" && outMsg?.toolCallId === "call_1" && outMsg?.content?.[0]?.text === "done");

	// 加密 reasoning（summary 空）→ redacted
	const encFile = path.join(day, `rollout-2026-01-02T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl`);
	fs.writeFileSync(encFile, [
		H({ timestamp: "2026-01-02T00:00:00.100Z", type: "session_meta", payload: { id: "enc-1", cwd: "/tmp/x" } }),
		H({ timestamp: "2026-01-02T00:00:00.200Z", type: "response_item", payload: { type: "message", id: "msg_u", role: "user", content: [{ type: "input_text", text: "问" }] } }),
		H({ timestamp: "2026-01-02T00:00:00.300Z", type: "response_item", payload: { type: "reasoning", id: "rs_enc", summary: [], encrypted_content: "gAAA" } }),
	].join("\n"));
	const enc = codex.readCodexSession(encFile);
	const encThink = enc.entries.find((e) => e.id === "rs_enc")?.message?.content?.[0];
	check("加密 reasoning→redacted", encThink?.type === "thinking" && encThink.redacted === true);

	// ---- 投影复用 ----
	const proj = session.buildProjectionFrom({ header, entries });
	const asked = proj.questions.filter((q) => q.index >= 0);
	check("1 个提问组", asked.length === 1);
	const kinds = asked[0].events.map((e) => e.kind).join(",");
	check("事件链 user,thinking,tool,text,compaction", kinds === "user,thinking,tool,text,compaction", kinds);
	const tool = asked[0].events.find((e) => e.kind === "tool");
	check("工具配对结果", tool?.tool?.name === "wait" && tool.tool.result === "done" && tool.tool.args?.cell_id === "84");
	check("model_change 在 preamble", proj.questions.some((q) => q.index === -1 && q.events.some((e) => e.kind === "model" && e.modelChange?.modelId === "gpt-5.6-sol")));
	check("思考等级在 preamble（thinking-level → max）", proj.questions.some((q) => q.index === -1 && q.events.some((e) => e.kind === "thinking-level" && e.thinkingLevel?.level === "max" && e.preview === "思考等级 → max")));
	check("meta.cwd 透传", proj.meta?.cwd === "/tmp/proj");
	const preamble = proj.questions.find((q) => q.index === -1);
	const sysEvents = (preamble?.events ?? []).filter((e) => e.kind === "system");
	check("连续注入合并为单个 system 事件（多段落）", sysEvents.length === 1, String(sysEvents.length));
	const sectionNames = sysEvents.flatMap((e) => e.system.sections.map((s) => s.name)).join(",");
	check("system 事件含提示词段落名/正文", sectionNames === "base_instructions,skills_instructions,AGENTS.md" && sysEvents.every((e) => e.system.sections.every((s) => s.name && s.text?.length > 0)), sectionNames);
	const light = session.toLight(proj);
	const lightSys = (light.questions.find((q) => q.index === -1)?.events ?? []).filter((e) => e.kind === "system");
	const lightNames = lightSys.flatMap((e) => e.system.sections.map((s) => s.name)).join(",");
	check(
		"light 档 system sections 只留 name/chars",
		lightSys.length === 1 && lightNames === "base_instructions,skills_instructions,AGENTS.md" && lightSys.every((e) => e.system.sections.every((s) => s.name && s.chars > 0 && s.text === undefined)),
		lightNames,
	);

	console.log(failed ? "1 FAILED" : "ALL PASS");
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("测试执行 Error:", err.message);
	process.exit(1);
});
