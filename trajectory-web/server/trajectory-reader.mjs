/**
 * trajectory-reader.mjs — 按源读取轨迹投影（供 read_trajectory 工具使用）。
 *
 * pi：直接解析 session JSONL；
 * codex：readCodexSession 翻译成 pi 条目流后复用 buildProjectionFrom。
 * 说明：codex 的 Guardian 审批合并只存在于 viewer 的展示路径；工具读取时忽略，
 * 不把 Guardian 条目混进对话上下文。
 */
import { buildProjection, buildProjectionFrom } from "./session.mjs";
import { readCodexSession } from "./codex.mjs";

/**
 * @param {string} source "pi" | "codex"
 * @param {string} file 轨迹会话文件绝对路径
 * @returns {{meta:object, questions:object[]}}
 */
export function readTrajectoryProjection(source, file) {
	if (source === "codex") {
		const { header, entries } = readCodexSession(file);
		return buildProjectionFrom({ header, entries, file });
	}
	return buildProjection(file);
}

/** 在投影里按事件 id 查找；找不到返回 null。 */
export function findProjectionEvent(projection, id) {
	for (const question of projection?.questions ?? []) {
		for (const event of question?.events ?? []) {
			if (event.id === id) return { event, question };
		}
	}
	return null;
}
