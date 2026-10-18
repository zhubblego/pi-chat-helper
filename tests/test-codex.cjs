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
const day = path.join(tmp, "2026", "01", "01");
fs.mkdirSync(day, { recursive: true });
const UUID = "019f592a-0d06-7e41-b3bc-df1f510cdbbd";
const file = path.join(day, `rollout-2026-01-01T00-00-00-${UUID}.jsonl`);
const H = (o) => JSON.stringify(o);
fs.writeFileSync(
	file,
	[
		H({ timestamp: "2026-01-01T00:00:00.100Z", type: "session_meta", payload: { id: UUID, cwd: "/tmp/proj", originator: "codex-tui" } }),
		H({ timestamp: "2026-01-01T00:00:00.200Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
		H({ timestamp: "2026-01-01T00:00:00.300Z", type: "response_item", payload: { type: "message", id: "msg_dev", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>" }] } }),
		H({ timestamp: "2026-01-01T00:00:00.400Z", type: "response_item", payload: { type: "message", id: "msg_u1", role: "user", content: [{ type: "input_text", text: "跑一下测试" }] } }),
		H({ timestamp: "2026-01-01T00:00:01.000Z", type: "response_item", payload: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "先看测试" }], encrypted_content: "gAAA" } }),
		H({ timestamp: "2026-01-01T00:00:02.000Z", type: "response_item", payload: { type: "function_call", id: "fc_1", name: "wait", arguments: '{"cell_id":"84"}', call_id: "call_1" } }),
		H({ timestamp: "2026-01-01T00:00:03.000Z", type: "response_item", payload: { type: "function_call_output", id: "fco_1", call_id: "call_1", output: [{ type: "input_text", text: "done" }] } }),
		H({ timestamp: "2026-01-01T00:00:04.000Z", type: "response_item", payload: { type: "message", id: "msg_a1", role: "assistant", content: [{ type: "output_text", text: "测试通过" }] } }),
		"{坏行跳过",
		H({ timestamp: "2026-01-01T00:00:05.000Z", type: "compacted", payload: { message: "" } }),
		H({ timestamp: "2026-01-01T00:00:06.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
		H({ timestamp: "2026-01-01T00:00:07.000Z", type: "event_msg", payload: { type: "token_count" } }),
	].join("\n"),
);

(async () => {
	const codex = await import(path.join(ROOT, "trajectory-web", "server", "codex.mjs"));
	const session = await import(path.join(ROOT, "trajectory-web", "server", "session.mjs"));

	// ---- 列表扫描 ----
	const list = codex.listCodexSessions({ codexRoot: tmp, now: Date.now() + 10_000 });
	check("列表 1 会话", list.length === 1);
	check("id 取自文件名", list[0]?.id === UUID);
	check("cwd 解析自 session_meta", list[0]?.projectPath === "/tmp/proj");
	check("首条用户消息", (list[0]?.firstMessage ?? "").includes("跑一下测试"));
	check("live（新鲜 mtime）", list[0]?.live === true);
	const empty = path.join(tmp, "empty-root");
	fs.mkdirSync(empty);
	check("空目录 0 会话", codex.listCodexSessions({ codexRoot: empty }).length === 0);

	// ---- 翻译层 ----
	const { header, entries } = codex.readCodexSession(file);
	check("header id/cwd", header?.id === UUID && header?.cwd === "/tmp/proj");
	check("developer 注入指令跳过", !entries.some((e) => e.id === "msg_dev"));
	check("event_msg 跳过 + model 不重复：共 7 条", entries.length === 7, String(entries.length));
	check("parentId 顺序链", entries.every((e, i) => (i === 0 ? e.parentId === null : e.parentId === entries[i - 1].id)));
	const byId = new Map(entries.map((e) => [e.id, e]));
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
	check("meta.cwd 透传", proj.meta?.cwd === "/tmp/proj");

	console.log(failed ? "1 FAILED" : "ALL PASS");
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("测试执行 Error:", err.message);
	process.exit(1);
});
