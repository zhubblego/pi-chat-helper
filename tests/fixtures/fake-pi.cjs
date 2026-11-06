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
let isStreaming = false;
let model = {
	provider: "fake",
	id: "fake-1",
	name: "Fake One",
	api: "openai-completions",
	reasoning: true,
	contextWindow: 128000,
	maxTokens: 4096,
};

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
		thinkingLevel: "medium",
		isStreaming,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId,
		sessionFile: `/tmp/fake-chat/${sessionId}.jsonl`,
		sessionName: undefined,
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
	};
}

let timers = [];

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
		case "get_state":
			reply(command, state());
			break;
		case "get_available_models":
			reply(command, { models: [model] });
			break;
		case "get_commands":
			reply(command, {
				commands: [
					{
						name: "skill:demo",
						description: "demo skill",
						source: "skill",
						sourceInfo: { path: "/tmp/fake-skills/demo/SKILL.md", scope: "user", origin: "top-level", baseDir: "/tmp/fake-skills/demo", source: "local" },
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
		case "set_model":
			model = { ...model, provider: command.provider, id: command.modelId, name: command.modelId };
			reply(command, model);
			break;
		case "new_session":
			sessionId = `fake-session-${++sessionSeq + 1}`;
			reply(command, { cancelled: false });
			break;
		case "switch_session":
			sessionId = sessionIdFromFile(String(command.sessionPath ?? "")) || sessionId;
			reply(command, {});
			break;
		case "prompt":
			if (isStreaming) {
				fail(command, "agent is already processing");
				break;
			}
			reply(command, { disposition: "started" });
			streamPrompt(command);
			break;
		case "abort":
			clearTimers();
			isStreaming = false;
			reply(command);
			emit({ type: "agent_end", messages: [], willRetry: false });
			emit({ type: "agent_settled", aborted: true });
			break;
		case "extension_ui_response":
			// 测试里不需要额外动作；保留可观测的 stderr
			process.stderr.write(`fake-pi: approval ${command.id} => ${command.confirmed}\n`);
			break;
		default:
			fail(command, `unknown command: ${command.type}`);
			break;
	}
});

rl.on("close", () => {
	process.exit(0);
});
