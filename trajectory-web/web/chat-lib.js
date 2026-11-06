/**
 * chat-lib.js — 对话前端的纯函数层（零 DOM），供 chat.js 与测试共用。
 *
 * SSE 解析按「完整事件块」切分：块之间以空行分隔，未收完的行留在 rest 里，
 * 下一次调用拼上新 chunk 再解析。因此能正确处理跨 chunk 的半行、CRLF、
 * 多行 data: 与注释行（`: ping`）。
 */

/**
 * 解析一段 SSE 文本。
 * @param {string} buffer 上次返回的 rest + 本次新到的 chunk
 * @returns {{events: Array<{event: string, data: string}>, rest: string}}
 */
export function parseSseChunk(buffer) {
	const text = String(buffer ?? "").replace(/\r\n/g, "\n");
	const events = [];
	let rest = text;
	let index = rest.indexOf("\n\n");
	while (index >= 0) {
		const block = rest.slice(0, index);
		rest = rest.slice(index + 2);
		const event = parseBlock(block);
		if (event) events.push(event);
		index = rest.indexOf("\n\n");
	}
	return { events, rest };
}

/** 单个事件块（不含块间空行）：注释行忽略，多行 data 按 \n 拼接。 */
function parseBlock(block) {
	let name = "message";
	let hasData = false;
	const data = [];
	for (const line of block.split("\n")) {
		if (!line || line.startsWith(":")) continue;
		if (line.startsWith("event:")) {
			name = line.slice(6).trim() || "message";
			continue;
		}
		if (line.startsWith("data:")) {
			let value = line.slice(5);
			// 规范允许冒号后一个空格，去掉它
			if (value.startsWith(" ")) value = value.slice(1);
			data.push(value);
			hasData = true;
		}
		// id:/retry: 本协议不用，忽略
	}
	if (!hasData) return null;
	return { event: name, data: data.join("\n") };
}

/**
 * SSE data 字段 → JSON 对象；坏 JSON 返回 null（调用方跳过该事件）。
 * @param {{data?: string} | string} event
 */
export function parseSseData(event) {
	const raw = typeof event === "string" ? event : event?.data;
	if (typeof raw !== "string" || raw === "") return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
