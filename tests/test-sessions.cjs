// 会话扫描：列表字段 / 项目范围 / 尾部会话名 / live 判定 / 排序 / 坏文件容错
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, cond ? "" : extra);
	if (!cond) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-scan-"));
const root = path.join(tmp, "sessions");
const projA = path.join(root, "--home-user-projA--");
const projB = path.join(root, "--home-user-projB--");
fs.mkdirSync(projA, { recursive: true });
fs.mkdirSync(projB, { recursive: true });

const H = "2026-01-01T00:00:00.000Z";
const line = (o) => JSON.stringify(o);

function writeSession(dir, { id, cwd, first, name, mtimeMs, filler = 0 }) {
	const lines = [
		line({ type: "session", version: 3, id, timestamp: H, cwd }),
		line({ type: "message", id: "u1", parentId: null, timestamp: H, message: { role: "user", content: first, timestamp: 1000 } }),
	];
	for (let i = 0; i < filler; i++) {
		lines.push(
			line({
				type: "message",
				id: `f${i}`,
				parentId: "u1",
				timestamp: H,
				message: { role: "assistant", content: [{ type: "text", text: "填充内容".repeat(16) }], timestamp: 2000 + i },
			}),
		);
	}
	// 会话名写在文件尾部（模拟 pi 后追加 session_info）
	if (name) lines.push(line({ type: "session_info", id: "n1", parentId: "u1", timestamp: H, name }));
	const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	fs.writeFileSync(file, lines.join("\n") + "\n");
	const seconds = (mtimeMs ?? Date.now()) / 1000;
	fs.utimesSync(file, seconds, seconds);
	return file;
}

(async () => {
	const mod = await import(pathToFileURL(path.join(__dirname, "..", "trajectory-web", "server", "sessions.mjs")).href);
	const { listSessions, clearSessionCache } = mod;

	const recent = Date.now();
	const old = recent - 10 * 60_000;
	const a1 = writeSession(projA, { id: "sess-a1", cwd: "/home/user/projA", first: "提问 A", name: "命名会话", mtimeMs: recent, filler: 3000 });
	writeSession(projA, { id: "sess-a2", cwd: "/home/user/projA", first: "旧提问", mtimeMs: old });
	writeSession(projB, { id: "sess-b1", cwd: "/home/user/projB", first: "提问 B", mtimeMs: recent - 60_000 });
	const deadFile = path.join(projB, "dead.jsonl");
	fs.writeFileSync(deadFile, "这不是 JSON\n");
	const deadSeconds = (old - 60_000) / 1000;
	fs.utimesSync(deadFile, deadSeconds, deadSeconds);

	const list = listSessions({ sessionsRoot: root });
	check("扫到全部会话（含坏文件兜底）", list.length === 4, `got ${list.length}: ${list.map((s) => s.id).join(",")}`);
	check("按最近活跃倒序", list[0].id === "sess-a1", list.map((s) => s.id).join(","));

	const sA1 = list.find((s) => s.id === "sess-a1");
	check("cwd / 首条消息 / 项目目录", sA1.cwd === undefined && sA1.projectPath === "/home/user/projA" && sA1.firstMessage === "提问 A" && sA1.projectDir === projA, JSON.stringify({ p: sA1.projectPath, f: sA1.firstMessage }));
	check("文件尾部的会话名被读到（超过头 256KB）", sA1.name === "命名会话", String(sA1.name));
	check("大文件确实超过头部读取窗口", fs.statSync(a1).size > 256 * 1024, String(fs.statSync(a1).size));
	check("live 判定", sA1.live === true && list.find((s) => s.id === "sess-a2").live === false);
	check("created 来自 header", sA1.created === H, String(sA1.created));
	check("坏文件兜底 id 来自文件名", list.find((s) => s.id === "dead") !== undefined);

	clearSessionCache();
	const list2 = listSessions({ sessionsRoot: root });
	check("清缓存后重扫结果一致", JSON.stringify(list2.map((s) => s.id)) === JSON.stringify(list.map((s) => s.id)));

	const projectOnly = listSessions({ projectDir: projA });
	check("项目范围只扫本项目", projectOnly.length === 2 && projectOnly.every((s) => s.projectDir === projA), projectOnly.map((s) => s.id).join(","));

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
	process.exit(failed === 0 ? 0 : 1);
})();
