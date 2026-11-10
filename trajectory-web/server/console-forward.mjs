/**
 * console-forward.mjs — viewer 侧调用 console bridge 的客户端（T3）。
 *
 * 只允许 server 进程使用：token/port 永远不出现在 API 响应或浏览器。
 * bridge 的 /forward 契约见 docs/plan/console-forward/api.md §4.3。
 */
import { request as httpRequest } from "node:http";

export const CONSOLE_FORWARD_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1 << 20;
const OFFLINE_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"EPIPE",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
]);

function errorText(status, data) {
	if (data && typeof data.error === "string" && data.error) return data.error.slice(0, 300);
	return `bridge HTTP ${status}`;
}

/**
 * 调用一座控制台的 /forward。
 *
 * @param {{
 *   record: {port:number, token:string, sessionFile:string, sessionId?:string, pid?:number},
 *   prompt: string,
 *   delivery?: "auto" | "followUp" | "steer",
 *   timeoutMs?: number,
 *   request?: typeof httpRequest,
 * }} options
 * @returns {Promise<
 *   {ok:true, status:number, delivery:string, state:string} |
 *   {ok:false, kind:"offline"|"timeout"|"mismatch"|"bridge", status:number, code:string, error:string}
 * >}
 */
export function forwardToConsole(options) {
	const record = options.record;
	const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : CONSOLE_FORWARD_TIMEOUT_MS;
	if (!record || !Number.isInteger(record.port) || record.port < 1 || typeof record.token !== "string" || !record.token) {
		return Promise.resolve({ ok: false, kind: "offline", status: 409, code: "console_offline", error: "控制台注册不完整" });
	}
	const body = JSON.stringify({
		sessionFile: record.sessionFile,
		prompt: options.prompt,
		delivery: options.delivery ?? "auto",
	});
	const request = options.request ?? httpRequest;

	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		let req;
		try {
			req = request(
				{
					host: "127.0.0.1",
					port: record.port,
					path: "/forward",
					method: "POST",
					headers: {
						"content-type": "application/json",
						"content-length": Buffer.byteLength(body),
						authorization: `Bearer ${record.token}`,
					},
					timeout: timeoutMs,
				},
				(res) => {
					const status = res.statusCode ?? 0;
					const chunks = [];
					let size = 0;
					res.on("data", (chunk) => {
						size += chunk.length;
						if (size > MAX_RESPONSE_BYTES) {
							req.destroy();
							finish({ ok: false, kind: "bridge", status: 502, code: "bridge_error", error: "控制台响应过大" });
							return;
						}
						chunks.push(chunk);
					});
					res.on("error", () => {
						finish({ ok: false, kind: "bridge", status: 502, code: "bridge_error", error: "控制台响应中断" });
					});
					res.on("end", () => {
						if (settled) return;
						const text = Buffer.concat(chunks).toString("utf8");
						let data = null;
						try {
							data = JSON.parse(text);
						} catch {
							/* 非 JSON 走 bridge_error */
						}
						if (status >= 200 && status < 300 && data?.ok === true) {
							finish({
								ok: true,
								status,
								delivery: typeof data.delivery === "string" ? data.delivery : "auto",
								state: data.state === "idle" ? "idle" : "working",
							});
							return;
						}
						if (status === 409 && data?.code === "session_mismatch") {
							finish({
								ok: false,
								kind: "mismatch",
								status: 409,
								code: "session_mismatch",
								error: errorText(status, data),
							});
							return;
						}
						finish({
							ok: false,
							kind: "bridge",
							status: 502,
							code: typeof data?.code === "string" ? data.code : "bridge_error",
							error: errorText(status, data),
						});
					});
				},
			);
		} catch (err) {
			finish({ ok: false, kind: "bridge", status: 502, code: "bridge_error", error: String(err?.message ?? err).slice(0, 300) });
			return;
		}

		req.on("timeout", () => {
			timedOut = true;
			req.destroy();
		});
		req.on("error", (err) => {
			if (settled) return;
			if (timedOut) {
				finish({ ok: false, kind: "timeout", status: 504, code: "bridge_timeout", error: "控制台响应超时" });
				return;
			}
			if (OFFLINE_CODES.has(err?.code)) {
				finish({ ok: false, kind: "offline", status: 409, code: "console_offline", error: "控制台已离线" });
				return;
			}
			finish({ ok: false, kind: "bridge", status: 502, code: "bridge_error", error: String(err?.message ?? err).slice(0, 300) });
		});
		try {
			req.end(body);
		} catch (err) {
			finish({ ok: false, kind: "bridge", status: 502, code: "bridge_error", error: String(err?.message ?? err).slice(0, 300) });
		}
	});
}
