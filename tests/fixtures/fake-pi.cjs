#!/usr/bin/env node
/**
 * fake-pi.cjs — 测试用的 pi RPC 替身。
 *
 * 用法：
 *   node fake-pi.cjs --version                  → 打印 1.5.0 后退出
 *   node fake-pi.cjs [--mode rpc] [其它参数]    → JSON line RPC 循环
 *
 * 支持：get_state / get_available_models / get_commands / set_model /
 *       new_session / switch_session / prompt / abort。
 * prompt 按关键字模拟：含 "think" 先发 thinking_delta；含 "tool" 发 tool_execution_*；
 * 含 "slow" 不自动收尾（等 abort）；含 "exit" 中途退出（code=3）；其余正常出字后 agent_end。
 */
const args = process.argv.slice(2);

if (args.includes("--version")) {
	process.stdout.write("1.5.0\n");
	process.exit(0);
}

const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

/** 从 session 文件读 header id；读不到时用文件名去时间戳前缀兑底。 */
function sessionIdFromFile(file) {
	try {
		const header = JSON.parse(fs.readFileSync(file, "utf8").split("\n", 1)[0]);
		if (typeof header?.id === "string" && header.id) return header.id;
	} catch {
		/* 文件不存在或不是合法 session */
	}
	return path.basename(file).replace(/\.jsonl$/, "").replace(/^.*_/, "");
}

let sessionSeq = 0;
let sessionId = "fake-session-1";
const sessionIdArg = args.indexOf("--session-id");
const sessionFileArg = args.indexOf("--session");
if (sessionIdArg >= 0 && args[sessionIdArg + 1]) sessionId = args[sessionIdArg + 1];
else if (sessionFileArg >= 0 && args[sessionFileArg + 1]) sessionId = sessionIdFromFile(args[sessionFileArg + 1]);
// get_state().sessionFile：`--session` 时指向真实文件（供 host 统计投影），否则给一个不存在的占位路径。
let sessionFile = sessionFileArg >= 0 && args[sessionFileArg + 1] ? args[sessionFileArg + 1] : `/tmp/fake-chat/${sessionId}.jsonl`;

/** 测试用 trace：switch_session / set_model / get_available_models 写入指定文件。 */
function trace(line) {
	const file = process.env.FAKE_PI_TRACE;
	if (!file) return;
	try {
		fs.appendFileSync(file, `${line}\n`);
	} catch {
		/* trace 失败不影响 RPC */
	}
}

trace(`spawn:${args.join(" ")}`);
trace(
	`env:${process.env.PI_CHAT_SOURCE ?? ""}|${process.env.PI_CHAT_SESSION_ID ?? ""}|${process.env.PI_CHAT_TRAJECTORY_FILE ?? ""}|${process.env.PI_CHAT_CONTEXT_FILE ?? ""}`,
);

/** 测试技能目录：FAKE_PI_SKILL_DIR 下按 name/SKILL.md 布局。 */
const skillRoot = process.env.FAKE_PI_SKILL_DIR ?? "/tmp/fake-skills";
const skillInfo = (name, scope) => {
	const baseDir = path.join(skillRoot, name);
	return { path: path.join(baseDir, "SKILL.md"), baseDir, scope, origin: "top-level", source: "local" };
};

/** 两个模型 + 故意混入敏感字段，用于验证服务端 allowlist 裁剪。 */
const models = [
	{
		provider: "fake",
		id: "fake-1",
		name: "Fake One",
		api: "openai-completions",
		reasoning: true,
		contextWindow: 128000,
		maxTokens: 4096,
		apiKey: "sk-fake-secret-one",
		baseUrl: "https://fake-one.invalid",
		headers: { authorization: "Bearer fake-header-one" },
		oauth: { token: "fake-oauth-one" },
	},
	{
		provider: "other",
		id: "fake-2",
		name: "Fake Two",
		api: "openai-completions",
		reasoning: false,
		contextWindow: 32000,
		maxTokens: 2048,
		apiKey: "sk-fake-secret-two",
		baseUrl: "https://fake-two.invalid",
		headers: { authorization: "Bearer fake-header-two" },
	},
	{
		provider: "catalog-only",
		id: "catalog-1",
		name: "Catalog Only",
		api: "openai-completions",
		reasoning: false,
		contextWindow: 64000,
		maxTokens: 2048,
	},

];
let isStreaming = false;
let model = models[0];
const thinkingLevels = ["off", "low", "medium", "high", "max"];
let thinkingLevel = thinkingLevels.includes(process.env.FAKE_PI_THINKING_LEVEL) ? process.env.FAKE_PI_THINKING_LEVEL : "medium";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

function write(value) {
	process.stdout.write(JSON.stringify(value) + "\n");
}

function reply(command, data) {
	const response = { id: command.id, type: "response", command: command.type, success: true };
	if (data !== undefined) response.data = data;
	write(response);
}

function fail(command, error) {
	write({ id: command.id, type: "response", command: command.type, success: false, error });
}

function emit(event) {
	write(event);
}

function state() {
	return {
		model,
		thinkingLevel,
		isStreaming,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId,
		sessionFile,
		sessionName: undefined,
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
	};
}

let timers = [];
let pendingApproval = null;
let approvalSeq = 0;

function clearTimers() {
	for (const timer of timers) clearTimeout(timer);
	timers = [];
}

function streamPrompt(command) {
	clearTimers();
	isStreaming = true;
	const message = String(command.message ?? "");
	const thinking = message.includes("think");
	const withTool = message.includes("tool");
	const approve = message.includes("approve");
	const slow = message.includes("slow");
	const crash = message.includes("exit");
	const later = (fn, ms) => timers.push(setTimeout(fn, ms));
	if (thinking) {
		later(() => {
			emit({
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "想一想", partial: {} },
			});
		}, 5);
	}
	later(() => {
		emit({
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好", partial: {} },
		});
	}, 10);
	later(() => {
		emit({
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "，世界", partial: {} },
		});
	}, 15);
	if (withTool) {
		later(() => {
			emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "README.md" } });
		}, 17);
		later(() => {
			emit({
				type: "tool_execution_end",
				toolCallId: "call_1",
				toolName: "read",
				result: { content: [{ type: "text", text: "# README" }] },
				isError: false,
				durationMs: 4,
			});
		}, 19);
	}
	if (crash) {
		later(() => process.exit(3), 25);
		return;
	}
	if (approve) {
		later(() => {
			const id = `ui-${++approvalSeq}`;
			const timeout = message.includes("approve-timeout") ? 120 : Number(process.env.FAKE_PI_CONFIRM_TIMEOUT ?? 5000);
			pendingApproval = {
				id,
				resolve: (confirmed) => {
					pendingApproval = null;
					trace(`ui:${id}:${confirmed}`);
					isStreaming = false;
					emit({
						type: "message_update",
						usage,
						assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `审批结果：${confirmed}`, partial: {} },
					});
					emit({
						type: "agent_end",
						messages: [
							{
								role: "assistant",
								content: [{ type: "text", text: `审批结果：${confirmed}` }],
								stopReason: "stop",
								durationMs: 5,
								usage: { input: 10, output: 5, totalTokens: 15 },
							},
						],
						willRetry: false,
					});
				},
			};
			emit({
				type: "extension_ui_request",
				id,
				method: "confirm",
				title: "允许 bash？",
				message: "npm test",
				timeout,
			});
		}, 17);
		return;
	}
	if (slow) return;
	later(() => {
		clearTimers();
		isStreaming = false;
		emit({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "你好，世界" }],
					stopReason: "stop",
					durationMs: 123,
					usage: { input: 10, output: 5, totalTokens: 15 },
				},
			],
			willRetry: false,
		});
	}, 20);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
	const text = line.trim();
	if (!text) return;
	let command;
	try {
		command = JSON.parse(text);
	} catch {
		process.stderr.write(`fake-pi: 非 JSON 输入：${text.slice(0, 120)}\n`);
		return;
	}
	switch (command.type) {
		case "get_state": {
			const delay = Number(process.env.FAKE_PI_STATE_DELAY_MS ?? 0);
			if (delay > 0) setTimeout(() => reply(command, state()), delay);
			else reply(command, state());
			break;
		}
		case "get_available_thinking_levels":
			trace("get_available_thinking_levels");
			reply(command, { levels: thinkingLevels });
			break;
		case "set_thinking_level": {
			const level = typeof command.level === "string" ? command.level : "";
			if (!thinkingLevels.includes(level)) {
				fail(command, `invalid thinking level: ${level}`);
				break;
			}
			thinkingLevel = level;
			trace(`set_thinking_level:${level}`);
			reply(command, { level });
			break;
		}
		case "get_available_models":
			trace("get_available_models");
			if (process.env.FAKE_PI_MODELS_FAIL && fs.existsSync(process.env.FAKE_PI_MODELS_FAIL)) {
				fail(command, "models refresh failed");
				break;
			}
			reply(command, { models });
			break;
		case "get_commands":
			if (process.env.FAKE_PI_COMMANDS_FAIL && fs.existsSync(process.env.FAKE_PI_COMMANDS_FAIL)) {
				fail(command, "commands failed");
				break;
			}
			reply(command, {
				commands: [
					{
						name: "skill:demo",
						description: "demo skill",
						source: "skill",
						sourceInfo: skillInfo("demo", "user"),
					},
					{
						name: "skill:big",
						description: "big skill",
						source: "skill",
						sourceInfo: skillInfo("big", "project"),
					},
					{
						name: "skill:huge",
						description: "huge skill",
						source: "skill",
						sourceInfo: skillInfo("huge", "project"),
					},
					{
						name: "hello",
						description: "prompt template",
						source: "prompt",
						sourceInfo: { path: "/tmp/fake-prompts/hello.md", scope: "user", origin: "top-level", source: "local" },
					},
				],
			});
			break;
		case "set_model": {
			const next = models.find((item) => item.provider === command.provider && item.id === command.modelId);
			model = next ? { ...next } : { ...model, provider: command.provider, id: command.modelId, name: command.modelId };
			trace(`set_model:${command.provider}/${command.modelId}`);
			reply(command, model);
			break;
		}
		case "new_session":
			sessionId = `fake-session-${++sessionSeq + 1}`;
			sessionFile = `/tmp/fake-chat/${sessionId}.jsonl`;
			reply(command, { cancelled: false });
			break;
		case "switch_session":
			sessionId = sessionIdFromFile(String(command.sessionPath ?? "")) || sessionId;
			sessionFile = typeof command.sessionPath === "string" && command.sessionPath ? command.sessionPath : sessionFile;
			trace(`switch_session:${command.sessionPath}`);
			reply(command, {});
			break;
		case "prompt":
			if (isStreaming) {
				fail(command, "agent is already processing");
				break;
			}
			trace(`prompt:${JSON.stringify(String(command.message ?? ""))}`);
			reply(command, { disposition: "started" });
			streamPrompt(command);
			break;
		case "abort":
			clearTimers();
			isStreaming = false;
			pendingApproval = null;
			reply(command);
			emit({ type: "agent_end", messages: [], willRetry: false });
			emit({ type: "agent_settled", aborted: true });
			break;
		case "extension_ui_response":
			trace(`ui:${command.id}:${command.confirmed}`);
			if (pendingApproval?.id === command.id) pendingApproval.resolve(command.confirmed === true);
			break;
		default:
			fail(command, `unknown command: ${command.type}`);
			break;
	}
});

rl.on("close", () => {
	process.exit(0);
});
