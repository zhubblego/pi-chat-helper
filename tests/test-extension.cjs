// pi 扩展 /deepseek-trail start|stop（模式 A：进程内服务，绑定 pi 实例）
// 覆盖：注册与补全 / 项目范围 / 幂等 / 端口降级 / 换会话存活 / quit 关闭 / 停服
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, cond ? "" : extra);
	if (!cond) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-ext-"));
// 把 HOME 指向临时目录：codex 源根目录（~/.codex/sessions）落在可控的 fixture 里，
// 不依赖、也不污染宿主机真实 codex 历史。必须在加载扩展（app.mjs 算 DEFAULT_CODEX_ROOT）前设置。
process.env.HOME = tmp;
const codexDay = path.join(tmp, ".codex", "sessions", "2026", "01", "01");
fs.mkdirSync(codexDay, { recursive: true });
fs.writeFileSync(
	path.join(codexDay, "rollout-2026-01-01T00-00-00-019f592a-0d06-7e41-b3bc-df1f510cdbbd.jsonl"),
	[
		JSON.stringify({ timestamp: "2026-01-01T00:00:00.100Z", type: "session_meta", payload: { id: "cx-ext-1", cwd: tmp } }),
		JSON.stringify({ timestamp: "2026-01-01T00:00:00.400Z", type: "response_item", payload: { type: "message", id: "msg_u1", role: "user", content: [{ type: "input_text", text: "codex 第一问" }] } }),
	].join("\n"),
);
const sessionFile = path.join(tmp, "2026-01-01T00-00-00-000Z_ext-1.jsonl");
const line = (o) => JSON.stringify(o);

// 真 pi 技能夹具：全局（agentDir/skills）与项目（cwd/.pi/skills）
const globalSkillDir = path.join(tmp, ".pi", "agent", "skills", "global-demo");
fs.mkdirSync(globalSkillDir, { recursive: true });
fs.writeFileSync(path.join(globalSkillDir, "SKILL.md"), "---\nname: global-demo\ndescription: 全局演示技能\n---\n\n# Global Demo\n");
const projectSkillDir = path.join(tmp, ".pi", "skills", "project-demo");
fs.mkdirSync(projectSkillDir, { recursive: true });
fs.writeFileSync(path.join(projectSkillDir, "SKILL.md"), "---\nname: project-demo\ndescription: 项目演示技能\n---\n\n# Project Demo\n");

// 会话条目（fake sessionManager 与文件内容一致；assistant 使轮 0 有完整可隐藏内容）
const fakeEntries = [
	{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "测试", timestamp: 1000 } },
	{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "完成" }], stopReason: "stop", timestamp: 2000 } },
];
fs.writeFileSync(
	sessionFile,
	[
		line({ type: "session", version: 3, id: "ext-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmp }),
		...fakeEntries.map(line),
	].join("\n") + "\n",
);

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const port = srv.address().port;
			srv.close(() => resolve(port));
		});
	});
}

(async () => {
	let trail = null;
	try {
		if (!process.env.PI_HOME) throw new Error("需要 PI_HOME 环境变量");
		const PI_HOME = process.env.PI_HOME;
		/** 依赖位置：旧布局（dist 与 node_modules 同在 PI_HOME 根）或 managed install（包在 node_modules/@earendil-works 下）。 */
		const firstExisting = (candidates, what) => {
			for (const p of candidates) if (fs.existsSync(p)) return p;
			throw new Error(`PI_HOME 下找不到 ${what}（试过：${candidates.join(" / ")}）`);
		};
		const jitiDir = firstExisting([path.join(PI_HOME, "node_modules", "jiti"), path.join(PI_HOME, "..", "..", "jiti")], "jiti");
		const agentEntry = firstExisting(
			[path.join(PI_HOME, "dist", "index.js"), path.join(PI_HOME, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")],
			"pi-coding-agent/dist/index.js",
		);
		const tuiEntry = firstExisting(
			[
				path.join(PI_HOME, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
				path.join(PI_HOME, "..", "..", "@earendil-works", "pi-tui", "dist", "index.js"),
			],
			"pi-tui/dist/index.js",
		);
		const { createJiti } = require(jitiDir);
		const jiti = createJiti(__filename, { alias: { "@earendil-works/pi-coding-agent": agentEntry, "@earendil-works/pi-tui": tuiEntry } });

		const commands = {};
		const shutdownHandlers = [];
		const handlers = {};
		const appendedEntries = [];
		const fakePi = {
			registerCommand: (name, def) => (commands[name] = def),
			on: (event, handler) => {
				(handlers[event] ??= []).push(handler);
				if (event === "session_shutdown") shutdownHandlers.push(handler);
				return () => {};
			},
			appendEntry: (customType, data) => appendedEntries.push({ customType, data }),
			// 模式 A 的精确归属来源（真实形状：sourceInfo.source = builtin / npm:<pkg>）；
			// 第 2 次调用起多一个 late_tool，用于验证「每次请求现取」而非启动快照
			getAllTools: (() => {
				let calls = 0;
				const base = [
					{ name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
					{ name: "memory_search", sourceInfo: { path: "/tmp/pi-hermes-memory/dist/index.ts", source: "npm:pi-hermes-memory" } },
					{ name: "local_tool", sourceInfo: { path: "/tmp/my-ext/index.ts", source: "file:/tmp/my-ext/index.ts", baseDir: "/tmp/my-ext" } },
					{ name: "mcp__docs__search", sourceInfo: { path: "/tmp/mcp/index.ts", source: "npm:@scope/mcp" } },
				];
				return () => {
					calls++;
					return calls === 1 ? base : [...base, { name: "late_tool", sourceInfo: { path: "/tmp/late/index.ts", source: "npm:late-pkg" } }];
				};
			})(),
		};
		const mod = jiti(path.join(__dirname, "..", "trajectory-web", "index.ts"));
		mod.default(fakePi);
		trail = commands["deepseek-trail"];
		check("注册单一命令 /deepseek-trail", typeof trail?.handler === "function" && typeof trail?.getArgumentCompletions === "function");
		check("不再注册裸 /start 与 /stop", !commands.start && !commands.stop);
		check("子命令补全含 start / --codex / --all / stop", trail.getArgumentCompletions("")?.map((c) => c.value).join(",") === "start,start --codex,start --all,stop");
		check("补全按前缀过滤", trail.getArgumentCompletions("start --")?.map((c) => c.value).join(",") === "start --codex,start --all");
		check("注册了 session_shutdown 处理", shutdownHandlers.length > 0);

		// ---- 仓库根聚合入口（pi -e . 依赖） ----
		const aggregateCommands = {};
		const aggregate = jiti(path.join(__dirname, "..", "index.ts"));
		aggregate.default({ registerCommand: (name, def) => (aggregateCommands[name] = def), on: () => () => {}, getAllTools: () => [] });
		check(
			"根 index.ts 聚合注册 /questions 与 /deepseek-trail",
			["questions", "deepseek-trail"].every((n) => typeof aggregateCommands[n]?.handler === "function"),
			Object.keys(aggregateCommands).join(","),
		);

		const notices = [];
		const ctx = {
			hasUI: true,
			ui: { notify: (message, type) => notices.push({ message, type }) },
			sessionManager: {
				getSessionFile: () => sessionFile,
				getCwd: () => tmp,
				getEntries: () => fakeEntries,
				getBranch: () => fakeEntries,
				getEntry: (id) => fakeEntries.find((e) => e.id === id),
			},
		};
		const lastNotice = () => notices[notices.length - 1];

		// ---- 用法 ----
		await trail.handler("", ctx);
		check("空参数提示用法", lastNotice().type === "info" && /用法：\/deepseek-trail start/.test(lastNotice().message), lastNotice().message);
		await trail.handler("bogus", ctx);
		check("未知子命令提示用法", lastNotice().type === "warning" && /未知子命令/.test(lastNotice().message), lastNotice().message);

		// ---- 启动（进程内，项目范围） ----
		const port = await freePort();
		await trail.handler(`start ${port}`, ctx);
		const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(lastNotice().message);
		check("start 提示 URL", !!m && Number(m[1]) === port, lastNotice().message);
		const url = m?.[0] ?? null;
		const health = await (await fetch(`${url}api/health`)).json();
		check("服务真实可访问且为项目范围", health.ok === true && health.scope === "project");
		const listing = await (await fetch(`${url}api/sessions`)).json();
		check("会话列表只含本项目", listing.sessions.length === 1 && listing.sessions[0].id === "ext-1", JSON.stringify(listing.sessions.map((s) => s.id)));
		const def = await (await fetch(`${url}api/session`)).json();
		check("默认会话 = 当前 pi 会话", def.sessionId === "ext-1", String(def.sessionId));

		// ---- T4：真 pi 模型列表（进程内 chat host） ----
		const chatCap = await (await fetch(`${url}api/chat/capabilities`)).json();
		check("模式 A 对话 enabled（PATH pi 1.5.0）", chatCap.enabled === true, JSON.stringify(chatCap).slice(0, 300));
		if (chatCap.enabled) {
			const modelsRes = await (await fetch(`${url}api/chat/models?source=pi&session=ext-1`)).json();
			check("真 pi 模型列表非空", Array.isArray(modelsRes.models) && modelsRes.models.length > 0, JSON.stringify(modelsRes).slice(0, 300));
			check(
				"真 pi 模型列表无密钥字段",
				!/"apiKey"|"baseUrl"|"headers"|"oauth"|api_key|authorization/i.test(JSON.stringify(modelsRes)),
				JSON.stringify(modelsRes).slice(0, 300),
			);
			check(
				"真 pi current 有 provider/id",
				typeof modelsRes.current?.provider === "string" && typeof modelsRes.current?.id === "string",
				JSON.stringify(modelsRes.current),
			);
		} else {
			check("真 pi 模型列表非空", false, chatCap.reason);
			check("真 pi 模型列表无密钥字段", false, chatCap.reason);
			check("真 pi current 有 provider/id", false, chatCap.reason);
		}

		// ---- T5：真 pi 技能列表 + 项目技能开关 ----
		if (chatCap.enabled) {
			const skillsBefore = await (await fetch(`${url}api/chat/skills?source=pi&session=ext-1`)).json();
			check(
				"真 pi 技能列表非空（全局）",
				Array.isArray(skillsBefore.skills) && skillsBefore.skills.some((skill) => skill.name === "global-demo"),
				JSON.stringify(skillsBefore).slice(0, 400),
			);
			check(
				"真 pi 默认不加载项目技能",
				skillsBefore.projectSkills === false && !skillsBefore.skills.some((skill) => skill.name === "project-demo"),
				JSON.stringify(skillsBefore.skills?.map((skill) => skill.name)),
			);
			const toggleOn = await (
				await fetch(`${url}api/chat/settings`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ source: "pi", session: "ext-1", projectSkills: true }),
				})
			).json();
			check("真 pi 项目技能开关写入成功", toggleOn.ok === true && toggleOn.projectSkills === true, JSON.stringify(toggleOn));
			const skillsAfter = await (await fetch(`${url}api/chat/skills?source=pi&session=ext-1&refresh=1`)).json();
			check(
				"真 pi 开关后出现项目技能",
				skillsAfter.projectSkills === true && skillsAfter.skills.some((skill) => skill.name === "project-demo"),
				JSON.stringify(skillsAfter.skills?.map((skill) => skill.name)),
			);
			await fetch(`${url}api/chat/settings`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: "pi", session: "ext-1", projectSkills: false }),
			});
		}

		// ---- T6：read_trajectory 扩展（jiti 加载 + fake pi API） ----
		const toolTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-tool-"));
		const toolSession = path.join(toolTmp, "tool-trajectory.jsonl");
		const toolTime = "2026-01-01T00:00:00.000Z";
		fs.writeFileSync(
			toolSession,
			[
				{ type: "session", version: 3, id: "ext-tool", timestamp: toolTime, cwd: tmp },
				{ type: "message", id: "u1", parentId: null, timestamp: toolTime, message: { role: "user", content: [{ type: "text", text: `第一问 ${"a".repeat(40)}` }], timestamp: 1 } },
				{ type: "message", id: "a1", parentId: "u1", timestamp: toolTime, message: { role: "assistant", content: [{ type: "text", text: `${"x".repeat(6900)}NEEDLE-END${"x".repeat(41)}` }], timestamp: 2 } },
				{ type: "message", id: "a2", parentId: "a1", timestamp: toolTime, message: { role: "assistant", content: [{ type: "text", text: "y".repeat(5000) }], timestamp: 3 } },
				{ type: "message", id: "a3", parentId: "a2", timestamp: toolTime, message: { role: "assistant", content: [{ type: "text", text: "z".repeat(5000) }], timestamp: 4 } },
			]
				.map((line) => JSON.stringify(line))
				.join("\n") + "\n",
		);
		const { buildProjection: buildToolProjection } = await import(
			pathToFileURL(path.join(__dirname, "..", "trajectory-web", "server", "session.mjs")).href
		);
		const toolEvents = buildToolProjection(toolSession).questions.flatMap((q) => q.events ?? []);
		const toolActivePath = path.join(toolTmp, "tool-active.json");
		const toolActive = {
			source: "pi",
			sessionId: "ext-tool",
			updatedAt: toolTime,
			items: toolEvents.map((ev) => ({ id: ev.id, kind: ev.kind, label: ev.kind, preview: ev.preview ?? "", chars: 100 })),
		};
		fs.writeFileSync(toolActivePath, JSON.stringify(toolActive));
		const toolMod = jiti(path.join(__dirname, "..", "trajectory-web", "chat-trajectory-tool.ts"));
		const toolRegistry = {};
		toolMod.default({ registerTool: (definition) => (toolRegistry[definition.name] = definition) });
		const readTool = toolRegistry.read_trajectory;
		check("read_trajectory 已注册", readTool?.name === "read_trajectory" && typeof readTool?.execute === "function");

		process.env.PI_CHAT_CONTEXT_FILE = toolActivePath;
		process.env.PI_CHAT_TRAJECTORY_FILE = toolSession;
		process.env.PI_CHAT_SOURCE = "pi";
		process.env.PI_CHAT_SESSION_ID = "ext-tool";
		const toolText = (result) => result?.content?.[0]?.text ?? "";
		const toolRun = (params) => readTool.execute("call", params);

		const listResult = await toolRun({ action: "list" });
		check(
			"read_trajectory list：返回选中清单",
			toolText(listResult).includes("当前选中") && toolActive.items.every((item) => toolText(listResult).includes(item.id)) && listResult.details?.selected === toolEvents.length,
			toolText(listResult).slice(0, 300),
		);
		const answerIds = toolEvents.filter((ev) => ev.kind === "answer" || ev.kind === "text").map((ev) => ev.id);
		const userEvent = toolEvents.find((ev) => ev.kind === "user");
		const singleLarge = await toolRun({ action: "read", ids: [answerIds[0]] });
		check(
			"read_trajectory read：单条 6k 截断",
			toolText(singleLarge).includes("截断") && toolText(singleLarge).length < 7000 && !toolText(singleLarge).includes("x".repeat(6100)),
			`len=${toolText(singleLarge).length}`,
		);
		const batchLarge = await toolRun({ action: "read", ids: answerIds.slice(0, 3), limit: 3 });
		check(
			"read_trajectory read：单次 12k 截断 + nextOffset",
			batchLarge.details?.truncated === true && batchLarge.details?.nextOffset === 2 && toolText(batchLarge).length <= 12200,
			JSON.stringify({ details: batchLarge.details, len: toolText(batchLarge).length }),
		);
		const queryResult = await toolRun({ action: "read", query: "第一问" });
		check("read_trajectory read：query 命中 user", queryResult.details?.page?.includes(userEvent.id), JSON.stringify(queryResult.details));
		const deepQuery = await toolRun({ action: "read", query: "needle-end" });
		check("read_trajectory read：query 匹配 6k 之后正文", deepQuery.details?.page?.includes(answerIds[0]), JSON.stringify(deepQuery.details));
		const kindResult = await toolRun({ action: "read", kind: "user" });
		check("read_trajectory read：kind 过滤", kindResult.details?.matched === 1 && kindResult.details?.page?.[0] === userEvent.id, JSON.stringify(kindResult.details));
		const pageResult = await toolRun({ action: "read", offset: 1, limit: 1 });
		check("read_trajectory read：offset/limit", pageResult.details?.page?.length === 1 && pageResult.details.page[0] !== userEvent.id, JSON.stringify(pageResult.details));
		const outsideResult = await toolRun({ action: "read", ids: ["not-in-set"] });
		check("read_trajectory read：白名单外提示", toolText(outsideResult).includes("不在当前选中集"), toolText(outsideResult).slice(0, 200));
		fs.writeFileSync(toolActivePath, JSON.stringify({ ...toolActive, sessionId: "other" }));
		let mismatchRejected = false;
		try {
			await toolRun({ action: "list" });
		} catch (err) {
			mismatchRejected = /不一致/.test(err.message);
		}
		check("read_trajectory：source/session mismatch 拒绝", mismatchRejected);
		fs.writeFileSync(toolActivePath, JSON.stringify(toolActive));
		delete process.env.PI_CHAT_CONTEXT_FILE;
		delete process.env.PI_CHAT_TRAJECTORY_FILE;
		delete process.env.PI_CHAT_SOURCE;
		delete process.env.PI_CHAT_SESSION_ID;

		// ---- 精确工具归属（模式 A：来自 pi.getAllTools().sourceInfo） ----
		const origins = await (await fetch(`${url}api/tool-origins`)).json();
		check(
			"工具归属来自 pi（内置 / npm 包 / 本地扩展 / MCP）",
			origins.source === "pi" &&
				origins.tools.read?.label === "内置" &&
				origins.tools.memory_search?.label === "pi-hermes-memory" &&
				origins.tools.local_tool?.label === "my-ext" &&
				origins.tools.mcp__docs__search?.label === "MCP: docs",
			JSON.stringify(origins.tools).slice(0, 220),
		);
		check("模式 A 精确映射与静态扫描合并", origins.source === "pi" && Object.keys(origins.tools).length > 4, String(Object.keys(origins.tools).length));
		const originsLater = await (await fetch(`${url}api/tool-origins`)).json();
		check("每次请求现取：运行时才注册的工具能进映射", originsLater.tools.late_tool?.label === "late-pkg", JSON.stringify(originsLater.tools.late_tool));

		// ---- 纯函数：划轮 / 指纹 / 恢复 / 过滤 ----
		check("fingerprintOfContent：string 原样、块数组拼 text", mod.fingerprintOfContent("测试") === "测试" && mod.fingerprintOfContent([{ type: "text", text: "a" }, { type: "image" }]) === "a");
		check("userEntryIdOfQIndex：按 user 切轮、越界 null", mod.userEntryIdOfQIndex(fakeEntries, 0) === "u1" && mod.userEntryIdOfQIndex(fakeEntries, 5) === null);
		check("hiddenIdsFromEntries：最新 custom 生效", JSON.stringify(mod.hiddenIdsFromEntries([
			{ type: "custom", customType: "pi-chat-helper.trajectory-hidden", data: { hidden: ["x"] } },
			{ type: "custom", customType: "pi-chat-helper.trajectory-hidden", data: { hidden: [] } },
		])) === "[]" && mod.hiddenIdsFromEntries([]).length === 0);
		const filtered = mod.filterHiddenMessages(
			[
				{ role: "system", content: "" },
				{ role: "user", content: "隐藏我" },
				{ role: "assistant", content: [{ type: "text", text: "答" }] },
				{ role: "user", content: "留下" },
			],
			new Set(["隐藏我"]),
		);
		check("filterHiddenMessages：隐藏轮整轮剔除、system 保留", filtered?.length === 2 && filtered[0].role === "system" && filtered[1].content === "留下");
		check("filterHiddenMessages：空隐藏集返回 null（零改动）", mod.filterHiddenMessages([{ role: "user", content: "x" }], new Set()) === null);
		check("croppedIdsFromEntries：最新 custom 生效", JSON.stringify(mod.croppedIdsFromEntries([
			{ type: "custom", customType: "pi-chat-helper.trajectory-cropped", data: { cropped: ["a", "b"] } },
			{ type: "custom", customType: "pi-chat-helper.trajectory-cropped", data: { cropped: ["b"] } },
		])) === '["b"]' && mod.croppedIdsFromEntries([]).length === 0);
		// 单条裁剪：user/文本消息整条剔除；带 toolCall 的只留 toolCall；toolResult 保留壳与 toolCallId（配对不能断）
		const cropMsgs = [
			{ role: "system", content: "" },
			{ role: "user", content: "裁我" },
			{ role: "assistant", content: [{ type: "text", text: "裁答" }] },
			{ role: "assistant", content: [{ type: "text", text: "裁工具" }, { type: "toolCall", id: "tc1", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "裁结果" }] },
			{ role: "user", content: "保留" },
		];
		const cropFiltered = mod.filterCroppedMessages(cropMsgs, new Set(["裁我", "裁答", "裁工具", "裁结果"]));
		check(
			"filterCroppedMessages：user/纯文本消息整条剔除，system 保留",
			cropFiltered?.length === 4 && cropFiltered[0].role === "system" && !cropFiltered.some((m) => m.content === "裁我" || m.content === "裁答"),
			JSON.stringify(cropFiltered?.map((m) => m.role)),
		);
		check(
			"filterCroppedMessages：带 toolCall 的 assistant 只留 toolCall 块（配对不断）",
			cropFiltered?.[1]?.role === "assistant" && cropFiltered[1].content.length === 1 && cropFiltered[1].content[0].type === "toolCall" && cropFiltered[1].content[0].id === "tc1",
			JSON.stringify(cropFiltered?.[1]?.content),
		);
		check(
			"filterCroppedMessages：toolResult 保留壳与 toolCallId，内容换占位",
			cropFiltered?.[2]?.role === "toolResult" && cropFiltered[2].toolCallId === "tc1" && cropFiltered[2].content.length === 1 && /已被裁剪/.test(cropFiltered[2].content[0].text),
			JSON.stringify(cropFiltered?.[2]),
		);
		check("filterCroppedMessages：无命中返回 null（零改动）", mod.filterCroppedMessages(cropMsgs, new Set(["不存在"])) === null && mod.filterCroppedMessages(cropMsgs, new Set()) === null);

		// ---- 模型上下文隐藏（模式 A）：端点 → custom 持久化 → context 过滤 ----
		for (const h of handlers.session_start ?? []) await h({}, ctx);
		const cePost = (body) => fetch(`${url}api/context-edit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		check("context-edit 隐藏第 0 轮成功", (await (await cePost({ qIndex: 0, hidden: true })).json()).ok === true);
		check("隐藏状态持久化为 custom 条目", appendedEntries.at(-1)?.customType === "pi-chat-helper.trajectory-hidden" && appendedEntries.at(-1).data.hidden.includes("u1"));
		const projH = await (await fetch(`${url}api/session`)).json();
		check("投影带回 contextEdit 与 hiddenUserIds", projH.contextEdit === true && projH.hiddenUserIds.includes("u1"), JSON.stringify(projH.hiddenUserIds));
		const ctxFiltered = handlers.context?.[0]?.({ messages: [
			{ role: "system", content: "" },
			{ role: "user", content: "测试" },
			{ role: "assistant", content: [{ type: "text", text: "完成" }] },
		] });
		check("context 事件过滤隐藏轮（仅剩 system）", ctxFiltered?.messages?.length === 1 && ctxFiltered.messages[0].role === "system", JSON.stringify(ctxFiltered?.messages?.map((m) => m.role)));
		check("context-edit 解除隐藏成功", (await (await cePost({ qIndex: 0, hidden: false })).json()).ok === true);
		check("解除后 context 不再过滤", handlers.context?.[0]?.({ messages: [{ role: "user", content: "测试" }] }) === undefined);
		check("context-edit 未知会话 404", (await cePost({ session: "nope", qIndex: 0, hidden: true })).status === 404);

		// ---- 单条裁剪（模式 A）：端点 → custom 持久化 → context 剔除内容 -------
		const cropPost = (body) => fetch(`${url}api/crop-entry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		check("crop-entry 裁剪 assistant 条目成功", (await (await cropPost({ entryId: "a1", cropped: true })).json()).ok === true);
		check("单条裁剪持久化为 custom 条目", appendedEntries.at(-1)?.customType === "pi-chat-helper.trajectory-cropped" && appendedEntries.at(-1).data.cropped.includes("a1"));
		const projC = await (await fetch(`${url}api/session`)).json();
		check("投影带回 cropEdit 与 croppedEntryIds", projC.cropEdit === true && projC.croppedEntryIds.includes("a1"), JSON.stringify(projC.croppedEntryIds));
		const cropCtx = handlers.context?.[0]?.({ messages: [
			{ role: "system", content: "" },
			{ role: "user", content: "测试" },
			{ role: "assistant", content: [{ type: "text", text: "完成" }] },
		] });
		check("context 事件剔掉被裁剪条目的内容", cropCtx?.messages?.length === 2 && cropCtx.messages.every((m) => m.role !== "assistant"), JSON.stringify(cropCtx?.messages?.map((m) => m.role)));
		check("crop-entry 取消裁剪成功", (await (await cropPost({ entryId: "a1", cropped: false })).json()).ok === true);
		check("取消后 context 不再裁剪", handlers.context?.[0]?.({ messages: [{ role: "assistant", content: [{ type: "text", text: "完成" }] }] }) === undefined);
		check("crop-entry 未知条目 400", (await cropPost({ entryId: "nope", cropped: true })).status === 400);
		check("crop-entry 未知会话 404", (await cropPost({ session: "nope", entryId: "a1", cropped: true })).status === 404);

		// ---- 幂等 ----
		await trail.handler(`start ${port}`, ctx);
		check("重复 start 只提示已在运行", /已在运行/.test(lastNotice().message) && lastNotice().message.includes(url), lastNotice().message);

		// ---- 停止 ----
		await trail.handler("stop", ctx);
		check("stop 提示已停止", /已停止/.test(lastNotice().message), lastNotice().message);
		let stopped = false;
		try {
			await fetch(`${url}api/health`, { signal: AbortSignal.timeout(800) });
		} catch {
			stopped = true;
		}
		check("stop 后端口关闭", stopped);

		// ---- 端口被占用时降级 ----
		const busy = await new Promise((resolve, reject) => {
			const srv = net.createServer();
			srv.once("error", reject);
			srv.listen(0, "127.0.0.1", () => resolve(srv));
		});
		const busyPort = busy.address().port;
		await trail.handler(`start ${busyPort}`, ctx);
		const m2 = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(lastNotice().message);
		check("端口占用时降级并提示", !!m2 && Number(m2[1]) !== busyPort && /被占用/.test(lastNotice().message), lastNotice().message);
		const url2 = m2?.[0] ?? null;
		await new Promise((r) => busy.close(r));

		// ---- 换会话（new/resume/fork）不停服务；quit 停 ----
		for (const handler of shutdownHandlers) await handler({ type: "session_shutdown", reason: "new" });
		check("换会话（new）后服务仍在", (await (await fetch(`${url2}api/health`)).json()).ok === true);

		// ---- 非法端口 ----
		await trail.handler("start 22", ctx);
		check("非法端口被拒", lastNotice().type === "warning" && /端口非法/.test(lastNotice().message));

		for (const handler of shutdownHandlers) await handler({ type: "session_shutdown", reason: "quit" });
		let closed = false;
		try {
			await fetch(`${url2}api/health`, { signal: AbortSignal.timeout(800) });
		} catch {
			closed = true;
		}
		check("quit 后服务关闭", closed);

		// ---- 参数解析：--codex / --all / --port / 非法选项 ----
		const codexPort = await freePort();
		await trail.handler(`start --codex ${codexPort}`, ctx);
		const m3 = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(lastNotice().message);
		check("--codex 启动并提示源", !!m3 && Number(m3[1]) === codexPort && /pi \+ codex/.test(lastNotice().message), lastNotice().message);
		const url3 = m3?.[0] ?? null;
		const health3 = await (await fetch(`${url3}api/health`)).json();
		check("--codex 仍为项目范围", health3.scope === "project");
		check("--codex 开放 pi + codex 源", health3.sources?.join(",") === "pi,codex", JSON.stringify(health3.sources));
		const cxSources = await (await fetch(`${url3}api/sources`)).json();
		check("--codex 源列表含 codex", cxSources.sources.map((s) => s.id).join(",") === "pi,codex", JSON.stringify(cxSources));
		// codex 项目过滤用真实 cwd（fixture cwd = tmp），不是 pi 的会话目录
		const cxList = await (await fetch(`${url3}api/sessions?source=codex`)).json();
		check("--codex 按当前工作目录过滤", cxList.sessions?.length === 1 && cxList.sessions[0].id === "cx-ext-1", JSON.stringify(cxList).slice(0, 160));
		// 显式请求 pi 源仍正常（白名单不串源）
		check("--codex 同时保留 pi 源", (await (await fetch(`${url3}api/sessions?source=pi`)).json()).sessions?.length === 1);
		const cxProj = await (await fetch(`${url3}api/session?source=codex&id=cx-ext-1`)).json();
		check("--codex 投影可读", cxProj.changed === true && cxProj.questions?.[0]?.events?.some((e) => e.kind === "user"), JSON.stringify(cxProj).slice(0, 160));
		// codex 的 read_trajectory（Guardian 忽略；本 fixture 无 Guardian）
		const cxUser = cxProj.questions.flatMap((q) => q.events ?? []).find((ev) => ev.kind === "user");
		const codexToolFile = path.join(codexDay, fs.readdirSync(codexDay)[0]);
		fs.writeFileSync(toolActivePath, JSON.stringify({ source: "codex", sessionId: "cx-ext-1", updatedAt: toolTime, items: [{ id: cxUser.id, kind: "user", label: "提问", preview: cxUser.preview ?? "", chars: 10 }] }));
		process.env.PI_CHAT_CONTEXT_FILE = toolActivePath;
		process.env.PI_CHAT_TRAJECTORY_FILE = codexToolFile;
		process.env.PI_CHAT_SOURCE = "codex";
		process.env.PI_CHAT_SESSION_ID = "cx-ext-1";
		const codexRead = await readTool.execute("call", { action: "read" });
		check("read_trajectory：codex 投影可读", toolText(codexRead).includes("codex 第一问"), toolText(codexRead).slice(0, 300));
		delete process.env.PI_CHAT_CONTEXT_FILE;
		delete process.env.PI_CHAT_TRAJECTORY_FILE;
		delete process.env.PI_CHAT_SOURCE;
		delete process.env.PI_CHAT_SESSION_ID;
		fs.rmSync(toolTmp, { recursive: true, force: true });

		await trail.handler("stop", ctx);
		const allPort = await freePort();
		await trail.handler(`start --port ${allPort} --all`, ctx);
		const m4 = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(lastNotice().message);
		check("--port 与 --all 组合生效", !!m4 && Number(m4[1]) === allPort && /全部项目历史/.test(lastNotice().message), lastNotice().message);
		const url4 = m4?.[0] ?? null;
		const health4 = await (await fetch(`${url4}api/health`)).json();
		check("--all 为全部范围", health4.scope === "all");
		check("--all 开放全部可用源", health4.sources?.join(",") === "pi,codex", JSON.stringify(health4.sources));
		await trail.handler("stop", ctx);

		await trail.handler("start --bogus", ctx);
		check("未知选项被拒", lastNotice().type === "warning" && /未知选项：--bogus/.test(lastNotice().message), lastNotice().message);
		await trail.handler("start 2000 3000", ctx);
		check("多余位置参数被拒", lastNotice().type === "warning" && /多余的参数/.test(lastNotice().message), lastNotice().message);
		await trail.handler("start --port", ctx);
		check("--port 缺值被拒", lastNotice().type === "warning" && /需要一个端口号/.test(lastNotice().message), lastNotice().message);

		await trail.handler("stop", ctx);
		check("重复 stop 提示未在运行", /未在运行/.test(lastNotice().message), lastNotice().message);
	} catch (err) {
		check("测试执行", false, err.stack);
	} finally {
		if (trail) {
			try {
				await trail.handler("stop", { hasUI: true, ui: { notify: () => {} }, sessionManager: { getSessionFile: () => sessionFile } });
			} catch {
				/* 已停止 */
			}
		}
		fs.rmSync(tmp, { recursive: true, force: true });
		console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
		process.exit(failed === 0 ? 0 : 1);
	}
})();
