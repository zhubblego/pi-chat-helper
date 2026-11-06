/**
 * pi-binary.mjs — 定位并探测 pi 可执行文件。
 *
 * 解析顺序（先到先用）：
 *   1. PI_CHAT_PI_BIN 环境变量（显式覆盖）
 *   2. 模式 A 的宿主入口（process.execPath + process.argv[1]，保证与当前 pi 同版本）
 *   3. @earendil-works/pi-coding-agent/rpc-entry（SDK 可解析时）
 *   4. ~/.pi/agent/bin/pi（托管安装）
 *   5. PATH 里的 pi
 *
 * 候选只描述“怎么启动”，是否可用由 probePi() 实际执行 `--version` 判断。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

/** 支持的最低 pi 版本：--session-dir / --session-id / --no-builtin-tools / RPC 命令集。 */
export const MIN_PI_VERSION = { major: 1, minor: 5, patch: 0 };
export const MIN_PI_VERSION_TEXT = "1.5.0";

/**
 * @typedef {Object} PiCandidate
 * @property {string} cmd
 * @property {string[]} argsPrefix
 * @property {boolean} mode  是否需要在 RPC 参数前加 `--mode rpc`
 * @property {"env"|"host"|"sdk"|"managed"|"path"} kind
 * @property {string} display
 */

/** 从 `pi --version` 输出里提取版本号；失败返回 null。 */
export function parsePiVersion(text) {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		raw: match[0],
	};
}

/** version 是否 >= min。 */
export function versionAtLeast(version, min = MIN_PI_VERSION) {
	if (!version) return false;
	if (version.major !== min.major) return version.major > min.major;
	if (version.minor !== min.minor) return version.minor > min.minor;
	return version.patch >= min.patch;
}

/**
 * 返回所有候选启动方式（可能不可用）。
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   homeDir?: string,
 *   hostEntry?: string,
 *   hostExecPath?: string,
 *   importMetaUrl?: string,
 * }} [options]
 * @returns {PiCandidate[]}
 */
export function resolvePiCandidates(options = {}) {
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? homedir();
	const hostEntry = options.hostEntry;
	const hostExecPath = options.hostExecPath ?? process.execPath;
	const importMetaUrl = options.importMetaUrl ?? import.meta.url;
	/** @type {PiCandidate[]} */
	const candidates = [];
	const add = (candidate) => {
		if (!candidate.cmd) return;
		const duplicate = candidates.some(
			(item) => item.cmd === candidate.cmd && item.argsPrefix.join("\u0000") === candidate.argsPrefix.join("\u0000"),
		);
		if (!duplicate) candidates.push({ ...candidate, argsPrefix: candidate.argsPrefix ?? [] });
	};

	if (env.PI_CHAT_PI_BIN) {
		add({ cmd: env.PI_CHAT_PI_BIN, argsPrefix: [], mode: true, kind: "env", display: env.PI_CHAT_PI_BIN });
	}

	if (hostEntry && existsSync(hostEntry)) {
		// 只接受看起来像 pi 入口的脚本；避免在测试/包装器里把 --version 误执行到任意进程。
		const looksLikePiEntry =
			/(^|[\\/])(?:cli|rpc-entry)\.(?:js|cjs|mjs)$/.test(hostEntry) || /pi-coding-agent[\\/]/.test(hostEntry);
		if (looksLikePiEntry) {
			const isRpcEntry = /(^|[\\/])rpc-entry\.(?:js|cjs|mjs)$/.test(hostEntry);
			add({
				cmd: hostExecPath,
				argsPrefix: [hostEntry],
				mode: !isRpcEntry,
				kind: "host",
				display: hostEntry,
			});
		}
	}

	try {
		const require = createRequire(importMetaUrl);
		const entry = require.resolve("@earendil-works/pi-coding-agent/rpc-entry");
		if (entry) {
			add({ cmd: process.execPath, argsPrefix: [entry], mode: false, kind: "sdk", display: entry });
		}
	} catch {
		/* 未安装可解析的 SDK；继续后面的候选 */
	}

	const managed = join(homeDir, ".pi", "agent", "bin", "pi");
	if (existsSync(managed)) {
		add({ cmd: managed, argsPrefix: [], mode: true, kind: "managed", display: managed });
	}

	add({ cmd: "pi", argsPrefix: [], mode: true, kind: "path", display: "pi" });

	return candidates;
}

/** 返回第一个候选（不做可用性检查）。 */
export function resolvePi(options = {}) {
	return resolvePiCandidates(options)[0] ?? null;
}

/** 组装 RPC 启动参数：候选前缀 + 可选 --mode rpc + 调用方参数。 */
export function piRpcArgs(candidate, args = []) {
	const prefix = candidate?.argsPrefix ?? [];
	if (candidate?.mode === false) return [...prefix, ...args];
	return [...prefix, "--mode", "rpc", ...args];
}

/** 执行一个候选的 `--version`；不抛错。 */
export function probePi(candidate, options = {}) {
	const timeoutMs = options.timeoutMs ?? 5000;
	const env = options.env ?? process.env;
	const cwd = options.cwd;
	return new Promise((resolve) => {
		if (!candidate?.cmd) {
			resolve({ ok: false, error: "没有候选可执行文件" });
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		let child;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			try {
				child?.kill("SIGKILL");
			} catch {
				/* 进程可能已退出 */
			}
			finish({ ok: false, error: `--version 超时（${timeoutMs}ms）`, stderr: stderr.trim() });
		}, timeoutMs);

		try {
			child = spawn(candidate.cmd, [...candidate.argsPrefix, "--version"], {
				cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			finish({ ok: false, error: err.message });
			return;
		}

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", (err) => {
			finish({ ok: false, error: err.message });
		});
		child.once("exit", (code, signal) => {
			const version = parsePiVersion(stdout) ?? parsePiVersion(stderr);
			if (code === 0 && version) {
				finish({ ok: true, version, raw: stdout.trim() || version.raw, stderr: stderr.trim() });
				return;
			}
			finish({
				ok: false,
				error: `退出码 ${code ?? signal}`,
				stderr: (stderr.trim() || stdout.trim()).slice(0, 500),
			});
		});
	});
}

/**
 * 按顺序探测候选，返回第一个可用的。
 * @returns {Promise<{
 *   ok: boolean,
 *   pi?: PiCandidate,
 *   version?: {major:number,minor:number,patch:number,raw:string},
 *   raw?: string,
 *   error?: string,
 *   attempts: Array<{kind:string, display:string, ok:boolean, error?:string}>,
 * }>}
 */
export async function probeFirstPi(options = {}) {
	const candidates = options.candidates ?? resolvePiCandidates(options);
	const attempts = [];
	for (const candidate of candidates) {
		const result = await probePi(candidate, options);
		attempts.push({
			kind: candidate.kind,
			display: candidate.display,
			ok: result.ok,
			error: result.ok ? undefined : result.error,
		});
		if (result.ok) {
			return { ok: true, pi: candidate, version: result.version, raw: result.raw, attempts };
		}
	}
	const detail = attempts.map((item) => `${item.kind}${item.error ? `: ${item.error}` : ""}`).join("；");
	return {
		ok: false,
		error: `找不到可用的 pi 可执行文件（尝试：${detail || "无"}）`,
		attempts,
	};
}
