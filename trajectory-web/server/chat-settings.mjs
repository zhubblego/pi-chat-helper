/**
 * chat-settings.mjs — 对话项目设置的纯函数（profile / projectSkills）。
 *
 * 存储：<chatDir>/settings.json
 *   { version: 1, projects: { "pi:/abs/project": { profile, projectSkills } } }
 * 读文件失败/结构损坏一律回退默认值；写入走 tmp+rename 原子替换。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const CHAT_PROFILES = Object.freeze(["no-tools", "read-only", "full"]);
export const DEFAULT_PROFILE = "read-only";

function defaults() {
	return { profile: DEFAULT_PROFILE, projectSkills: false };
}

function emptySettings() {
	return { version: 1, projects: {} };
}

/** 项目键：`${source}:${resolve(projectPath)}`；projectPath 缺失时保留空串。 */
export function projectKey(source, projectPath) {
	return `${source ?? "pi"}:${projectPath ? resolve(projectPath) : ""}`;
}

/** 读 settings.json；文件缺失、坏 JSON、字段非法均回退默认。 */
export function readSettings(file) {
	if (!file || !existsSync(file)) return emptySettings();
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		const rawProjects = parsed && typeof parsed === "object" && parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {};
		const projects = {};
		for (const [key, value] of Object.entries(rawProjects)) {
			if (!value || typeof value !== "object") continue;
			projects[key] = {
				profile: CHAT_PROFILES.includes(value.profile) ? value.profile : DEFAULT_PROFILE,
				projectSkills: value.projectSkills === true,
			};
		}
		return { version: 1, projects };
	} catch {
		return emptySettings();
	}
}

/** 某项目的设置；未配置时返回默认值。 */
export function projectSettings(settings, source, projectPath) {
	const key = projectKey(source, projectPath);
	const entry = settings?.projects?.[key];
	if (!entry) return defaults();
	return {
		profile: CHAT_PROFILES.includes(entry.profile) ? entry.profile : DEFAULT_PROFILE,
		projectSkills: entry.projectSkills === true,
	};
}

/** 原子写 settings.json。 */
export function writeSettings(file, settings) {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, file);
}

/**
 * 读-改-写某项目设置；patch 只接受已知字段（未知字段忽略）。
 * @returns {{profile:string, projectSkills:boolean}}
 */
export function updateProjectSettings(file, { source, projectPath, patch = {} }) {
	const settings = readSettings(file);
	const current = projectSettings(settings, source, projectPath);
	const next = {
		profile: CHAT_PROFILES.includes(patch.profile) ? patch.profile : current.profile,
		projectSkills: typeof patch.projectSkills === "boolean" ? patch.projectSkills : current.projectSkills,
	};
	settings.projects[projectKey(source, projectPath)] = next;
	writeSettings(file, settings);
	return next;
}
