// 控制台桥核心（T1）：注册、心跳、状态、token、/forward、清理。
// 只使用临时 agentDir，不写真实 ~/.pi/agent。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, cond ? "" : extra);
	if (!cond) failed++;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-console-bridge-"));
	let bridge = null;
	try {
		const agentDir = path.join(tmp, "agent");
		const sessionA = path.join(tmp, "session-a.jsonl");
		const sessionB = path.join(tmp, "session-b.jsonl");
		fs.writeFileSync(sessionA, '{"type":"session","id":"a"}\n');
		fs.writeFileSync(sessionB, '{"type":"session","id":"b"}\n');

		const mod = await import(
			pathToFileURL(path.join(__dirname, "..", "trajectory-web", "server", "console-bridge.mjs")).href
		);
		const {
			createConsoleBridge,
			consolesDirFor,
			canonicalSessionFile,
			consoleBridgeEnabled,
			CONSOLE_BRIDGE_DISABLE_ENV,
		} = mod;
		const consolesDir = consolesDirFor(agentDir);

		let sessionFile = sessionA;
		let sessionId = "sess-a";
		let idle = true;
		const calls = [];
		const ctx = {
			mode: "tui",
			cwd: tmp,
			isIdle: () => idle,
			sessionManager: {
				getSessionFile: () => sessionFile,
				getSessionId: () => sessionId,
				getCwd: () => tmp,
			},
		};
		const pi = {
			sendUserMessage: async (...args) => {
				calls.push(args);
				idle = false;
			},
		};

		check("默认开启", consoleBridgeEnabled({}) === true && consoleBridgeEnabled({ [CONSOLE_BRIDGE_DISABLE_ENV]: "0" }) === false);
		bridge = createConsoleBridge({ pi, getCtx: () => ctx, agentDir, heartbeatMs: 20 });
		const started = await bridge.start();
		check("TUI 启动成功", started === true && Number.isInteger(bridge.port) && bridge.port > 0, JSON.stringify({ started, port: bridge.port }));

		const regFile = bridge.registrationPath;
		check("写入注册文件", typeof regFile === "string" && fs.existsSync(regFile) && path.dirname(regFile) === consolesDir, String(regFile));
		const reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
		check(
			"注册字段完整",
			reg.protocol === 1 &&
				reg.pid === process.pid &&
				reg.sessionId === "sess-a" &&
				reg.sessionFile === canonicalSessionFile(sessionA) &&
				reg.cwd === tmp &&
				reg.port === bridge.port &&
				typeof reg.token === "string" &&
				reg.token.length === 64 &&
				reg.state === "idle" &&
				reg.interactive === true &&
				typeof reg.heartbeatAt === "string",
			JSON.stringify(reg),
		);
		if (process.platform !== "win32") {
			const dirMode = fs.statSync(consolesDir).mode & 0o777;
			const fileMode = fs.statSync(regFile).mode & 0o777;
			check("注册目录 0700 / 文件 0600", dirMode === 0o700 && fileMode === 0o600, `${dirMode.toString(8)}/${fileMode.toString(8)}`);
		} else {
			check("注册目录 0700 / 文件 0600", true);
		}

		const base = `http://127.0.0.1:${bridge.port}`;
		const post = async (body, options = {}) => {
			const headers = {
				"content-type": "application/json",
				authorization: `Bearer ${options.token ?? reg.token}`,
				...options.headers,
			};
			const res = await fetch(`${base}/forward`, {
				method: "POST",
				headers,
				body: typeof body === "string" ? body : JSON.stringify(body),
			});
			const text = await res.text();
			let json = null;
			try {
				json = JSON.parse(text);
			} catch {
				/* 非 JSON 响应保留 text */
			}
			return { res, text, json };
		};

		const unknown = await fetch(`${base}/nope`);
		check("未知路由 404", unknown.status === 404, String(unknown.status));
		const getForward = await fetch(`${base}/forward`);
		check("GET /forward 405", getForward.status === 405, String(getForward.status));
		const noAuth = await post({ sessionFile: sessionA, prompt: "x" }, { token: "" });
		check("缺少 token 401", noAuth.res.status === 401 && noAuth.json?.code === "unauthorized", noAuth.text);
		const badAuth = await post({ sessionFile: sessionA, prompt: "x" }, { token: "0".repeat(64) });
		check("错误 token 401", badAuth.res.status === 401, badAuth.text);
		const withOrigin = await post(
			{ sessionFile: sessionA, prompt: "x" },
			{ headers: { origin: "http://127.0.0.1" } },
		);
		check("带 Origin 403", withOrigin.res.status === 403 && withOrigin.json?.code === "forbidden", withOrigin.text);
		const badContent = await post(
			{ sessionFile: sessionA, prompt: "x" },
			{ headers: { "content-type": "text/plain" } },
		);
		check("非 JSON Content-Type 415", badContent.res.status === 415, badContent.text);
		const badJson = await post("{", { headers: {} });
		check("坏 JSON 400", badJson.res.status === 400, badJson.text);
		const noFile = await post({ prompt: "x" });
		check("缺 sessionFile 400", noFile.res.status === 400, noFile.text);
		const empty = await post({ sessionFile: sessionA, prompt: "   " });
		check("空 prompt 400", empty.res.status === 400 && empty.json?.code === "prompt_empty", empty.text);
		const tooLong = await post({ sessionFile: sessionA, prompt: "x".repeat(32_001) });
		check("超长 prompt 400", tooLong.res.status === 400 && tooLong.json?.code === "prompt_too_large", tooLong.text);
		const badDelivery = await post({ sessionFile: sessionA, prompt: "x", delivery: "later" });
		check("非法 delivery 400", badDelivery.res.status === 400 && badDelivery.json?.code === "bad_delivery", badDelivery.text);
		const mismatch = await post({ sessionFile: sessionB, prompt: "x" });
		check("会话不匹配 409", mismatch.res.status === 409 && mismatch.json?.code === "session_mismatch", mismatch.text);

		// 空闲：立即发送；不传 deliverAs；转发内容不做模板展开。
		idle = true;
		bridge.setState("idle");
		calls.length = 0;
		const now = await post({ sessionFile: sessionA, prompt: "  idle 问题  ", delivery: "auto" });
		check("空闲转发 200 now", now.res.status === 200 && now.json?.delivery === "now" && now.json?.state === "working", now.text);
		check("空闲调用参数", calls.length === 1 && calls[0][0] === "idle 问题" && calls[0][1]?.expandPromptTemplates === false && !calls[0][1]?.deliverAs, JSON.stringify(calls));
		check("成功响应不泄漏 token", !now.text.includes(reg.token), now.text);
		const workingReg = JSON.parse(fs.readFileSync(regFile, "utf8"));
		check("转发后注册为 working", workingReg.state === "working", workingReg.state);

		// 忙碌：auto/followUp 排队，steer 插话。
		idle = false;
		bridge.setState("working");
		calls.length = 0;
		const queued = await post({ sessionFile: sessionA, prompt: "排队问题", delivery: "auto" });
		check("忙碌 auto 返回 followUp", queued.res.status === 200 && queued.json?.delivery === "followUp", queued.text);
		check("忙碌 auto 传 deliverAs=followUp", calls[0]?.[1]?.deliverAs === "followUp", JSON.stringify(calls[0]));
		const steered = await post({ sessionFile: sessionA, prompt: "插话问题", delivery: "steer" });
		check("忙碌 steer 返回 steer", steered.res.status === 200 && steered.json?.delivery === "steer", steered.text);
		check("忙碌 steer 传 deliverAs=steer", calls[1]?.[1]?.deliverAs === "steer", JSON.stringify(calls[1]));

		// 空闲时 followUp 归一为 now。
		idle = true;
		bridge.setState("idle");
		calls.length = 0;
		const followUpIdle = await post({ sessionFile: sessionA, prompt: "空闲 followUp", delivery: "followUp" });
		check(
			"空闲 followUp 归一 now 且不传 deliverAs",
			followUpIdle.res.status === 200 && followUpIdle.json?.delivery === "now" && !calls[0]?.[1]?.deliverAs,
			followUpIdle.text,
		);

		// 心跳：注册文件的 heartbeatAt 会推进。
		idle = true;
		bridge.setState("idle");
		const hb1 = JSON.parse(fs.readFileSync(regFile, "utf8")).heartbeatAt;
		await delay(45);
		const hb2 = JSON.parse(fs.readFileSync(regFile, "utf8")).heartbeatAt;
		check("心跳推进 heartbeatAt", Date.parse(hb2) > Date.parse(hb1), `${hb1} -> ${hb2}`);

		// 会话切换：同一桥同一端口，注册改到新会话；旧文件不残留。
		const oldPort = bridge.port;
		sessionFile = sessionB;
		sessionId = "sess-b";
		idle = true;
		const switched = await bridge.start();
		const regB = JSON.parse(fs.readFileSync(bridge.registrationPath, "utf8"));
		const filesB = fs.readdirSync(consolesDir).filter((name) => name.endsWith(".json"));
		check(
			"会话切换后注册新会话",
			switched === true && bridge.port === oldPort && regB.sessionId === "sess-b" && regB.sessionFile === canonicalSessionFile(sessionB),
			JSON.stringify(regB),
		);
		check("会话切换只保留一个注册", filesB.length === 1, filesB.join(","));

		// 关闭：文件删除、端口关闭。
		const closedPath = bridge.registrationPath;
		await bridge.close();
		check("close 删除注册文件", !fs.existsSync(closedPath) && bridge.registrationPath === null, String(closedPath));
		check("close 清空 port", bridge.port === null);
		let closed = false;
		try {
			await fetch(`${base}/forward`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${reg.token}` },
				body: JSON.stringify({ sessionFile: sessionB, prompt: "x" }),
				signal: AbortSignal.timeout(500),
			});
		} catch {
			closed = true;
		}
		check("close 后端口关闭", closed);
		bridge = null;

		// 非 TUI / 未加载 / 显式关闭：不注册、不监听。
		for (const [label, mode, env] of [
			["RPC 不注册", "rpc", undefined],
			["未知 mode 不注册", undefined, undefined],
			["env=0 不注册", "tui", { ...process.env, [CONSOLE_BRIDGE_DISABLE_ENV]: "0" }],
		]) {
			const local = createConsoleBridge({
				pi,
				getCtx: () => ({ ...ctx, mode }),
				agentDir: path.join(tmp, `agent-${label}`),
				env,
				heartbeatMs: 20,
			});
			const ok = await local.start();
			check(`${label}：start=false`, ok === false && local.port === null && local.registrationPath === null, JSON.stringify({ ok, port: local.port }));
			await local.close();
		}

		// 注册写入失败时不能留下监听端口。
		const failed = createConsoleBridge({ pi, getCtx: () => ctx, agentDir: sessionA, heartbeatMs: 20 });
		const failedStart = await failed.start();
		check(
			"注册写入失败时 start=false 且不留端口",
			failedStart === false && failed.port === null && failed.registrationPath === null,
			JSON.stringify({ failedStart, port: failed.port }),
		);
		await failed.close();

		// 直接导出 helper 的边界。
		check("canonicalSessionFile 解析真实路径", canonicalSessionFile(sessionB) === fs.realpathSync(sessionB));
		check("sameSessionFile 处理空值", mod.sameSessionFile(null, sessionB) === false && mod.sameSessionFile(sessionB, sessionB) === true);
	} catch (err) {
		check("测试执行", false, err.stack);
	} finally {
		if (bridge) {
			try {
				await bridge.close();
			} catch {
				/* 已关闭 */
			}
		}
		fs.rmSync(tmp, { recursive: true, force: true });
		console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
		process.exit(failed === 0 ? 0 : 1);
	}
})();
