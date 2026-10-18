// HTTP 服务：多会话列表 / 指定会话投影 / 增量轮询 / 事件详情 / 双范围 / 热更新 / 退出
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, cond ? "" : extra);
	if (!cond) failed++;
};

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "trajectory-web", "server", "main.mjs");
const WEB = path.join(ROOT, "trajectory-web", "web");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-srv-"));
const sessionsRoot = path.join(tmp, "sessions");
const projA = path.join(sessionsRoot, "--a--");
const projB = path.join(sessionsRoot, "--b--");
fs.mkdirSync(projA, { recursive: true });
fs.mkdirSync(projB, { recursive: true });

const H = "2026-01-01T00:00:00.000Z";
const line = (o) => JSON.stringify(o);
function writeSession(dir, { id, cwd, first, mtimeMs }) {
	const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	fs.writeFileSync(
		file,
		[
			line({ type: "session", version: 3, id, timestamp: H, cwd }),
			line({ type: "message", id: "u1", parentId: null, timestamp: H, message: { role: "user", content: first, timestamp: 1000 } }),
			line({
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: H,
				message: {
					role: "assistant",
					model: "m",
					usage: { input: 1, output: 2, totalTokens: 3 },
					durationMs: 100,
					content: [{ type: "thinking", thinking: "思考" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } }],
				},
			}),
			line({ type: "message", id: "r1", parentId: "a1", timestamp: H, message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "结果" }], isError: false } }),
			line({ type: "message", id: "a2", parentId: "r1", timestamp: H, message: { role: "assistant", content: [{ type: "text", text: "答复" }] } }),
		].join("\n") + "\n",
	);
	const seconds = (mtimeMs ?? Date.now()) / 1000;
	fs.utimesSync(file, seconds, seconds);
	return file;
}

function waitForUrl(child) {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => reject(new Error("等待启动 URL 超时")), 8000);
		child.stdout.on("data", (d) => {
			buf += String(d);
			const m = /http:\/\/127\.0\.0\.1:\d+/.exec(buf);
			if (m) {
				clearTimeout(timer);
				resolve(m[0]);
			}
		});
		child.stderr.on("data", (d) => {
			buf += String(d);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`服务提前退出 code=${code}：${buf}`));
		});
	});
}

function startServer(args) {
	const child = spawn(process.execPath, [SERVER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
	return child;
}

async function stopServer(child) {
	child.kill("SIGTERM");
	const deadline = Date.now() + 4000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) return true;
		await sleep(100);
	}
	child.kill("SIGKILL");
	return false;
}

(async () => {
	let all = null;
	let project = null;
	try {
		const recent = Date.now();
		const old = recent - 3600_000;
		const a1 = writeSession(projA, { id: "srv-a1", cwd: "/tmp/projA", first: "第一问", mtimeMs: recent });
		const aOld = writeSession(projA, { id: "srv-a2", cwd: "/tmp/projA", first: "旧问", mtimeMs: old });
		writeSession(projB, { id: "srv-b1", cwd: "/tmp/projB", first: "B 问", mtimeMs: recent - 120_000 });

		// ---- 模式 B：全部范围 ----
		// codex 源 fixture：年/月/日三层 + rollout 文件
		const codexRoot = path.join(tmp, "codex");
		const codexDay = path.join(codexRoot, "2026", "01", "01");
		fs.mkdirSync(codexDay, { recursive: true });
		fs.writeFileSync(
			path.join(codexDay, "rollout-2026-01-01T00-00-00-019f592a-0d06-7e41-b3bc-df1f510cdbbd.jsonl"),
			[
				JSON.stringify({ timestamp: "2026-01-01T00:00:00.100Z", type: "session_meta", payload: { id: "cx-a1", cwd: "/tmp/projC" } }),
				JSON.stringify({ timestamp: "2026-01-01T00:00:00.400Z", type: "response_item", payload: { type: "message", id: "msg_u1", role: "user", content: [{ type: "input_text", text: "codex 第一问" }] } }),
				JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "response_item", payload: { type: "message", id: "msg_a1", role: "assistant", content: [{ type: "output_text", text: "codex 回答" }] } }),
			].join("\n"),
		);
		all = startServer(["--scope", "all", "--sessions-root", sessionsRoot, "--codex-root", codexRoot, "--agent-dir", path.join(tmp, "agent"), "--port", "0", "--web", WEB]);
		const base = await waitForUrl(all);

		const health = await (await fetch(`${base}/api/health`)).json();
		check("health：scope=all", health.ok === true && health.scope === "all", JSON.stringify(health));

		const listing = await (await fetch(`${base}/api/sessions`)).json();
		check("列表包含全部项目会话", listing.sessions.length === 3, String(listing.sessions.length));
		check("列表按最近活跃倒序", listing.sessions[0].id === "srv-a1", listing.sessions.map((s) => s.id).join(","));
		check("live 标记", listing.sessions.find((s) => s.id === "srv-a1").live === true && listing.sessions.find((s) => s.id === "srv-a2").live === false);
		check("项目路径与首条消息", listing.sessions[0].projectPath === "/tmp/projA" && listing.sessions[0].firstMessage === "第一问");
		check("current 指向最近会话", listing.current === "srv-a1");

		const first = await (await fetch(`${base}/api/session`)).json();
		check("默认取最近会话", first.changed === true && first.sessionId === "srv-a1" && first.meta.cwd === "/tmp/projA");
		check("问题分组", first.questions.length === 1 && first.questions[0].summary === "第一问");
		check("事件链", first.questions[0].events.map((e) => e.kind).join(",") === "user,thinking,tool,text", first.questions[0].events.map((e) => e.kind).join(","));

		const second = await (await fetch(`${base}/api/session?id=srv-a1&v=${encodeURIComponent(first.etag)}`)).json();
		check("etag 未变 changed=false", second.changed === false);

		const other = await (await fetch(`${base}/api/session?id=srv-b1`)).json();
		check("按 id 取指定会话", other.changed === true && other.sessionId === "srv-b1" && other.meta.cwd === "/tmp/projB");

		const toolEvent = first.questions[0].events.find((e) => e.kind === "tool");
		const detail = await (await fetch(`${base}/api/event?session=srv-a1&id=${encodeURIComponent(toolEvent.id)}`)).json();
		check("事件详情（full）", detail.event.tool.name === "read" && detail.event.tool.result === "结果");
		check("未知会话 404", (await fetch(`${base}/api/session?id=nope`)).status === 404);

		// 翻译转发接口：只验参数校验（真实外呼靠手动冒烟，避免测试依赖网络）
		const trPost = (body) => fetch(`${base}/api/translate`, { method: "POST", headers: { "content-type": "application/json" }, body });
		check("translate 非法 JSON 400", (await trPost("{")).status === 400);
		check("translate 缺 q 400", (await trPost(JSON.stringify({ to: "zh-CN" }))).status === 400);
		check("translate 非法语言 400", (await trPost(JSON.stringify({ q: ["hi"], to: "xx" }))).status === 400);
		check("translate 非法服务 400", (await trPost(JSON.stringify({ q: ["hi"], to: "zh-CN", service: "deepl" }))).status === 400);
		check("translate 空数组 400", (await trPost(JSON.stringify({ q: [], to: "zh-CN" }))).status === 400);
		check("translate 超长段 400", (await trPost(JSON.stringify({ q: ["x".repeat(20001)], to: "zh-CN" }))).status === 400);
		check("未知 POST 路径 405", (await fetch(`${base}/api/nothing`, { method: "POST" })).status === 405);

		// 轨迹源：/api/sources 列出 + source 参数白名单
		const sources = await (await fetch(`${base}/api/sources`)).json();
		check("源列表含 pi", Array.isArray(sources.sources) && sources.sources.some((s) => s.id === "pi" && s.sessions >= 2), JSON.stringify(sources));
		check("源列表含 codex（存在才显示）", sources.sources.some((s) => s.id === "codex" && s.sessions === 1));
		check("sessions 带 source 200", (await fetch(`${base}/api/sessions?source=pi`)).status === 200);
		check("sessions 非法 source 400", (await fetch(`${base}/api/sessions?source=claude`)).status === 400);
		check("session 非法 source 400", (await fetch(`${base}/api/session?id=srv-a1&source=xx`)).status === 400);

		// codex 源：列表 + 投影 + current 不串源
		const cxList = await (await fetch(`${base}/api/sessions?source=codex`)).json();
		check("codex 列表 1 会话", cxList.sessions?.length === 1 && cxList.sessions[0].id === "cx-a1", JSON.stringify(cxList).slice(0, 140));
		check("codex current 取自身首个", cxList.current === "cx-a1");
		const cxProj = await (await fetch(`${base}/api/session?source=codex&id=cx-a1`)).json();
		const cxKinds = (cxProj.questions ?? []).flatMap((q) => q.events.map((e) => e.kind)).join(",");
		check("codex 投影 user/text", cxProj.changed === true && cxKinds === "user,text", cxKinds);

		for (const file of ["/", "/app.js", "/lib.js", "/style.css", "/tokens.css"]) {
			check(`静态资源 ${file}`, (await fetch(base + file)).status === 200);
		}

		const origins = await (await fetch(`${base}/api/tool-origins`)).json();
		check("工具归属接口（静态扫描）", origins.source === "scan" && origins.tools?.read?.kind === "builtin", JSON.stringify(origins).slice(0, 140));

		// 追加新条目 → 热更新
		fs.appendFileSync(a1, line({ type: "message", id: "u2", parentId: "a2", timestamp: H, message: { role: "user", content: "追问", timestamp: 2000 } }) + "\n");
		let changed = null;
		const hotDeadline = Date.now() + 4000;
		while (Date.now() < hotDeadline) {
			await sleep(150);
			const res = await (await fetch(`${base}/api/session?id=srv-a1&v=${encodeURIComponent(first.etag)}`)).json();
			if (res.changed === true) {
				changed = res;
				break;
			}
		}
		check("追加条目后 etag 变化", !!changed && changed.questions.length === 2 && changed.questions[1].summary === "追问");

		check("SIGTERM 退出", await stopServer(all));
		all = null;

		// ---- 模式 A：项目范围 ----
		project = startServer(["--scope", "project", "--session", aOld, "--port", "0", "--web", WEB]);
		const baseA = await waitForUrl(project);
		const listingA = await (await fetch(`${baseA}/api/sessions`)).json();
		check("项目范围只列本项目", listingA.scope === "project" && listingA.sessions.length === 2 && listingA.sessions.every((s) => s.projectPath === "/tmp/projA"), JSON.stringify(listingA.sessions.map((s) => s.id)));
		check("项目范围 current 指向启动会话", listingA.current === "srv-a2", String(listingA.current));
		const defA = await (await fetch(`${baseA}/api/session`)).json();
		check("默认选中启动时传入的会话", defA.sessionId === "srv-a2", String(defA.sessionId));
		check("项目范围退出", await stopServer(project));
		project = null;
	} catch (err) {
		check("测试执行", false, err.stack);
	} finally {
		if (all) all.kill("SIGKILL");
		if (project) project.kill("SIGKILL");
		fs.rmSync(tmp, { recursive: true, force: true });
		console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
		process.exit(failed === 0 ? 0 : 1);
	}
})();
