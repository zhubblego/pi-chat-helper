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
 * prompt 会依次发 text_delta、agent_end；message 含 "think" 时先发 thinking_delta。
 */
const args = process.argv.slice(2);

if (args.includes("--version")) {
	process.stdout.write("1.5.0\n");
	process.exit(0);
}

const readline = require("node:readline");

let sessionSeq = 0;
let sessionId = "fake-session-1";
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

function streamPrompt(command) {
	isStreaming = true;
	const message = String(command.message ?? "");
	const thinking = message.includes("think");
	setTimeout(() => {
		if (thinking) {
			emit({
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "想一想", partial: {} },
			});
		}
	}, 5);
	setTimeout(() => {
		emit({
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好", partial: {} },
		});
	}, 10);
	setTimeout(() => {
		emit({
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "，世界", partial: {} },
		});
	}, 15);
	setTimeout(() => {
		isStreaming = false;
		emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "你好，世界" }] }],
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
			sessionId = String(command.sessionPath ?? "").split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") || sessionId;
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
