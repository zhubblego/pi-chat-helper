/**
 * tool-origins.mjs — 工具归属映射（内置 / MCP / 扩展包 / 未识别）。
 *
 * 两个来源：
 *   1) 精确：模式 A 下 pi 扩展用 `pi.getAllTools()` 的 `sourceInfo` 生成后传入
 *      （sourceInfo 实测形状：{ path, source, scope, origin, baseDir }，
 *       内置为 source:"builtin"，npm 包为 source:"npm:@scope/pkg"）。
 *   2) 扫描：模式 B（独立进程）静态扫描安装目录得到，进程内缓存。
 * MCP 工具（mcp__<server>__<tool>）的前缀归组由前端统一处理，两模式一致。
 *
 * 局限（扫描路径）：名字由变量拼接、或字面量只出现在注释/文档里的工具扫不到，
 * 会落「未识别」；模式 A（pi 插件）传的是 getAllTools().sourceInfo 精确映射，无此问题。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

/** 扫不到 pi 安装目录时的内置工具兜底（当前 pi 的 core/tools）。 */
export const BUILTIN_FALLBACK = ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"];

const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_DEPTH = 6;

/** 从 pi 安装目录读内置工具名；不可用时返回兜底列表。 */
export function builtinToolNames(piDir) {
	const fallback = () => [...BUILTIN_FALLBACK];
	if (!piDir) return fallback();
	const dir = join(piDir, "dist", "core", "tools");
	if (!existsSync(dir)) return fallback();
	const names = new Set();
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".js")) continue;
			const text = readFileSync(join(dir, file), "utf8");
			for (const match of text.matchAll(/^\s*name:\s*"([a-z][a-z0-9_]*)",?\s*$/gm)) names.add(match[1]);
		}
	} catch {
		return fallback();
	}
	return names.size > 0 ? [...names] : fallback();
}

function packageLabel(dir) {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		if (typeof pkg.name === "string" && pkg.name) return pkg.name;
	} catch {
		/* 无 package.json 时退回目录名 */
	}
	return basename(dir);
}

/** 单个源码文件里的工具注册名（字符串式 registerTool("x") 与对象式 name: "x"）。 */
function scanFile(file, label, out) {
	let text;
	try {
		const stat = statSync(file);
		if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return;
		text = readFileSync(file, "utf8");
	} catch {
		return;
	}
	if (!text.includes("registerTool")) return;
	for (const match of text.matchAll(/registerTool\(\s*["']([A-Za-z_][\w-]*)["']/g)) out.set(match[1], label);
	for (const match of text.matchAll(/name:\s*["']([A-Za-z_][\w-]*)["']/g)) {
		if (!out.has(match[1])) out.set(match[1], label);
	}
}

function scanTree(dir, label, out, depth = 0) {
	if (depth > MAX_SCAN_DEPTH) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			scanTree(full, label, out, depth + 1);
			continue;
		}
		if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) scanFile(full, label, out);
	}
}

/**
 * 静态扫描安装目录，产出 `{ [toolName]: { kind, label } }`。
 * 覆盖：`<agentDir>/extensions/`（单文件与目录扩展）、`<agentDir>/npm/node_modules/`（含 scope 包）。
 */
export function scanToolOrigins(options = {}) {
	const agentDir = options.agentDir ?? join(homedir(), ".pi", "agent");
	const tools = {};
	for (const name of builtinToolNames(options.piDir)) tools[name] = { kind: "builtin", label: "内置" };
	const packages = new Map();

	const extensionsDir = join(agentDir, "extensions");
	if (existsSync(extensionsDir)) {
		for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
			const full = join(extensionsDir, entry.name);
			if (entry.isDirectory()) {
				if (existsSync(join(full, "index.ts")) || existsSync(join(full, "index.js"))) scanTree(full, entry.name, packages);
			} else if (/\.(ts|js)$/.test(entry.name)) {
				scanFile(full, entry.name, packages);
			}
		}
	}

	const npmDir = join(agentDir, "npm", "node_modules");
	if (existsSync(npmDir)) {
		for (const entry of readdirSync(npmDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith("@")) {
				const scopeDir = join(npmDir, entry.name);
				for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
					if (!sub.isDirectory()) continue;
					const full = join(scopeDir, sub.name);
					scanTree(full, packageLabel(full), packages);
				}
			} else {
				const full = join(npmDir, entry.name);
				scanTree(full, packageLabel(full), packages);
			}
		}
	}

	for (const [name, label] of packages) tools[name] = { kind: "package", label };
	return { generatedAt: new Date().toISOString(), source: "scan", tools };
}
