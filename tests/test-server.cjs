// HTTP 服务：健康检查 / 增量轮询 / 静态资源 / 事件详情 / 热更新 / SIGTERM 清理状态
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-srv-"));
const sessionFile = path.join(tmp, "s.jsonl");
const stateFile = path.join(tmp, "state.json");
const logFile = path.join(tmp, "server.log");

const H = "2026-01-01T00:00:00.000Z";
const msg = (id, parentId, ts, message) => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date(ts).toISOString(),
	message: { ...message, timestamp: ts },
});

function writeFixture() {
	fs.writeFileSync(
		sessionFile,
		[
			{ type: "session", version: 3, id: "srv-1", timestamp: H, cwd: tmp },
			msg("u1", null, 1000, { role: "user", content: "测试提问" }),
			msg("a1", "u1", 2000, {
				role: "assistant",
				model: "m",
				usage: { input: 1, output: 2, totalTokens: 3 },
				durationMs: 100,
				content: [{ type: "thinking", thinking: "思考" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } }],
			}),
			msg("r1", "a1", 3000, {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				content: [{ type: "text", text: "结果" }],
				isError: false,
			}),
			msg("a2", "r1", 4000, { role: "assistant", content: [{ type: "text", text: "答复" }] }),
		]
			.map((l) => JSON.stringify(l))
			.join("\n") + "\n",
	);
}
writeFixture();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
	let child = null;
	try {
		child = spawn(process.execPath, [SERVER, "--session", sessionFile, "--port", "0", "--state", stateFile, "--web", WEB, "--log", logFile], {
			stdio: "ignore",
		});

		// 等 state 文件出现
		let state = null;
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			await sleep(120);
			if (fs.existsSync(stateFile)) {
				state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
				break;
			}
		}
		check("state 文件写出", !!state && state.pid === child.pid && state.port > 0, JSON.stringify(state));
		if (!state) throw new Error("服务未就绪");

		const base = `http://127.0.0.1:${state.port}`;

		const health = await (await fetch(`${base}/api/health`)).json();
		check("健康检查", health.ok === true && health.pid === child.pid && health.session === sessionFile);

		const first = await (await fetch(`${base}/api/session`)).json();
		check("首次投影 changed=true", first.changed === true && typeof first.etag === "string");
		check("问题分组", first.questions.length === 1 && first.questions[0].index === 0 && first.questions[0].summary === "测试提问");
		check("事件链", first.questions[0].events.map((e) => e.kind).join(",") === "user,thinking,tool,text", first.questions[0].events.map((e) => e.kind).join(","));

		const second = await (await fetch(`${base}/api/session?v=${encodeURIComponent(first.etag)}`)).json();
		check("etag 未变时 changed=false", second.changed === false && !("questions" in second));

		const toolEvent = first.questions[0].events.find((e) => e.kind === "tool");
		const detail = await (await fetch(`${base}/api/event?id=${encodeURIComponent(toolEvent.id)}`)).json();
		check("事件详情返回 full 载荷", detail.event.tool.name === "read" && detail.event.tool.result === "结果");
		const missing = await fetch(`${base}/api/event?id=nope`);
		check("未知事件 404", missing.status === 404);

		const index = await fetch(`${base}/`);
		const indexText = await index.text();
		check("首页返回 HTML", index.status === 200 && indexText.includes("轨迹观察"), String(index.status));
		for (const file of ["/app.js", "/lib.js", "/style.css"]) {
			const res = await fetch(base + file);
			check(`静态资源 ${file}`, res.status === 200);
		}
		const notFound = await fetch(`${base}/../etc/passwd`);
		check("路径穿越被拒", notFound.status === 404, String(notFound.status));

		// 追加新条目 → 热更新
		fs.appendFileSync(sessionFile, JSON.stringify(msg("u2", "a2", 5000, { role: "user", content: "追问" })) + "\n");
		let changed = null;
		const hotDeadline = Date.now() + 4000;
		while (Date.now() < hotDeadline) {
			await sleep(150);
			const res = await (await fetch(`${base}/api/session?v=${encodeURIComponent(first.etag)}`)).json();
			if (res.changed === true) {
				changed = res;
				break;
			}
		}
		check("追加条目后 etag 变化", !!changed && changed.questions.length === 2 && changed.questions[1].summary === "追问", JSON.stringify(changed?.questions?.map((q) => q.summary)));

		// SIGTERM：进程退出且 state 文件被清理
		child.kill("SIGTERM");
		const exitDeadline = Date.now() + 4000;
		let exited = false;
		while (Date.now() < exitDeadline) {
			await sleep(120);
			if (child.exitCode !== null) {
				exited = true;
				break;
			}
		}
		check("SIGTERM 后退出", exited);
		check("退出时清理 state 文件", !fs.existsSync(stateFile));
	} catch (err) {
		check("测试执行", false, err.stack);
	} finally {
		if (child && child.exitCode === null) child.kill("SIGKILL");
		fs.rmSync(tmp, { recursive: true, force: true });
		console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
		process.exit(failed === 0 ? 0 : 1);
	}
})();
