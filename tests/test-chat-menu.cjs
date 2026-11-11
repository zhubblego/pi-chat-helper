#!/usr/bin/env node
/**
 * test-chat-menu.cjs — 转发目标/方式菜单 jsdom 冒烟。
 *
 * 真实 index.html + 去 export 的 chat-lib / session-prefs / chat.js 注入，
 * 桩 deps 与 fetch，真实 DOM 事件驱动：
 *   1. 转发模式左下角出现目标/方式按钮，状态条让位；
 *   2. 目标菜单拉 /api/chat/consoles 列出候选并选择；
 *   3. 方式菜单切换排队/插话；
 *   4. forward 返回 ambiguous_console 自动弹目标菜单，选择后带 pid 重发；
 *   5. Esc 关闭菜单。
 */
const fs = require("node:fs");
const path = require("node:path");

const npxRoot = path.join(process.env.HOME ?? "", ".npm", "_npx");
let jsdomDir = null;
for (const name of fs.existsSync(npxRoot) ? fs.readdirSync(npxRoot) : []) {
	const candidate = path.join(npxRoot, name, "node_modules", "jsdom");
	if (fs.existsSync(candidate)) {
		jsdomDir = candidate;
		break;
	}
}
if (!jsdomDir) {
	console.error("找不到 jsdom（~/.npm/_npx/*/node_modules/jsdom），跳过：先 npx jsdom 缓存");
	process.exit(1);
}
const { JSDOM } = require(jsdomDir);

const webDir = path.join(__dirname, "..", "trajectory-web", "web");
const indexHtml = fs.readFileSync(path.join(webDir, "index.html"), "utf8");

function stripExports(source) {
	return source.replace(/^export\s+/gm, "");
}

function stripImportsAndExports(source) {
	return stripExports(source).replace(/^import\s+\{[\s\S]*?\}\s*from\s*"[^"]+";?\s*$/gm, "");
}

function makeH(window) {
	const document = window.document;
	return (tag, props, ...children) => {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(props ?? {})) {
			if (value === null || value === undefined || value === false) continue;
			if (key === "class") node.className = value;
			else if (key === "text") node.textContent = value;
			else if (key === "dataset") {
				for (const [name, data] of Object.entries(value)) node.dataset[name] = String(data);
			} else if (key === "onClick" || key === "onInput") node.addEventListener(key === "onClick" ? "click" : "input", value);
			else if (key === "hidden") node.hidden = value === true;
			else node.setAttribute(key, String(value));
		}
		for (const child of children.flat(2)) {
			if (child === null || child === undefined || child === false) continue;
			node.append(child?.nodeType ? child : document.createTextNode(String(child)));
		}
		return node;
	};
}

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
	if (ok) {
		passed++;
		console.log(`PASS ${name}`);
	} else {
		failed++;
		console.log(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
	}
}

async function main() {
	const consoles = [
		{ sessionId: "s1", pid: 1728, state: "idle", startedAt: "2026-11-12T09:00:00.000Z", heartbeatAt: new Date().toISOString() },
		{ sessionId: "s1", pid: 4201, state: "working", startedAt: "2026-11-12T10:30:00.000Z", heartbeatAt: new Date().toISOString() },
	];
	const forwardCalls = [];
	let forwardCount = 0;

	const dom = new JSDOM(indexHtml, {
		url: "http://localhost:7788/",
		pretendToBeVisual: true,
		runScripts: "outside-only",
		beforeParse(window) {
			window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
			window.ResizeObserver = class {
				observe() {}
				unobserve() {}
				disconnect() {}
			};
			window.HTMLElement.prototype.scrollIntoView = () => {};
			window.fmtTokens = () => "0";
			window.fetch = async (url, init = {}) => {
				const target = String(url);
				const json = async (body) => ({ ok: (body?._status ?? 200) < 400, status: body?._status ?? 200, json: async () => body, text: async () => JSON.stringify(body) });
				if (target.startsWith("/api/chat/forward")) {
					forwardCount++;
					const body = JSON.parse(String(init.body ?? "{}"));
					forwardCalls.push(body);
					if (forwardCount === 1) {
						return json({ ok: false, error: "检测到多个控制台", code: "ambiguous_console", consoles });
					}
					return json({ ok: true, delivery: "now", console: { sessionId: "s1", pid: body.pid, state: "working" } });
				}
				if (target.startsWith("/api/chat/consoles")) return json({ consoles });
				if (target.startsWith("/api/prefs/session")) return json({ prefs: {} });
				if (target.startsWith("/api/chat/capabilities")) return json({ enabled: true });
				if (target.startsWith("/api/chat/thread")) return json({ enabled: true, messages: [] });
				return json({ ok: true });
			};
		},
	});
	const { window } = dom;
	const document = window.document;
	await new Promise((resolve) => {
		if (document.readyState === "complete") resolve();
		else window.addEventListener("load", resolve);
	});

	window.eval(stripImportsAndExports(fs.readFileSync(path.join(webDir, "chat-lib.js"), "utf8")));
	window.eval(stripImportsAndExports(fs.readFileSync(path.join(webDir, "session-prefs.js"), "utf8")));
	window.eval(stripImportsAndExports(fs.readFileSync(path.join(webDir, "chat.js"), "utf8")));

	const h = makeH(window);
	const panel = window.initChatPanel({
		el: (id) => document.getElementById(id),
		h,
		mdNode: () => null,
		getSession: () => ({ source: "pi", id: "s1" }),
		getSelectedIds: () => [],
		getEventRefs: () => [],
		setSelectedIds: () => {},
		openEvent: () => {},
		autoGrowInput: () => {},
	});

	const targetBtn = document.getElementById("chat-forward-target");
	const targetLabel = document.getElementById("chat-forward-target-label");
	const targetMenu = document.getElementById("chat-forward-target-menu");
	const deliveryBtn = document.getElementById("chat-forward-delivery");
	const deliveryLabel = document.getElementById("chat-forward-delivery-label");
	const deliveryMenu = document.getElementById("chat-forward-delivery-menu");
	const statusEl = document.getElementById("chat-console-status");
	const input = document.getElementById("chat-input");
	const sendBtn = document.getElementById("chat-send");

	panel.setOpen(true);
	panel.onConsolesChanged(consoles);
	await new Promise((resolve) => setTimeout(resolve, 20));
	check("状态条已删：元素不存在，转发前后均无侧边状态条", statusEl === null, String(statusEl));
	check("转发前隐藏：目标/方式按钮 hidden", targetBtn.hidden && deliveryBtn.hidden, "");

	targetBtn.closest(".chat-row") && document.getElementById("chat-mode-toggle").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 20));
	check("转发模式：左下角两按钮显示", !targetBtn.hidden && !deliveryBtn.hidden, "");
	check("初始文案：目标「自动」，方式「排队」", targetLabel.textContent === "自动" && deliveryLabel.textContent === "排队", `${targetLabel.textContent}/${deliveryLabel.textContent}`);

	targetBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 20));
	check(
		"目标菜单打开：自动 + 两个 PID 共 3 项，控制台项带状态点",
		!targetMenu.hidden &&
			targetMenu.querySelectorAll("[data-forward-target]").length === 3 &&
			targetMenu.querySelector('[data-forward-target="1728"] .console-status-dot.is-idle') !== null &&
			targetMenu.querySelector('[data-forward-target="4201"] .console-status-dot.is-working') !== null &&
			targetMenu.querySelector('[data-forward-target="auto"] .console-status-dot') === null,
		targetMenu.outerHTML.slice(0, 300),
	);
	const pidItem = targetMenu.querySelector('[data-forward-target="4201"]');
	pidItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 20));
	check("选中 PID 后：按钮文字固定 PID 4201，菜单关闭", targetLabel.textContent === "PID 4201" && targetMenu.hidden, targetLabel.textContent);

	deliveryBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 20));
	check("方式菜单两项：排队/插话", !deliveryMenu.hidden && deliveryMenu.querySelectorAll("[data-forward-delivery]").length === 2, "");
	deliveryMenu.querySelector('[data-forward-delivery="steer"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 20));
	check("方式切换插话：按钮文字变，菜单关闭", deliveryLabel.textContent === "插话" && deliveryMenu.hidden, deliveryLabel.textContent);
	deliveryBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 20));
	deliveryMenu.querySelector('[data-forward-delivery="auto"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 20));
	check("方式切回排队：按钮文字复位", deliveryLabel.textContent === "排队", deliveryLabel.textContent);

	// ambiguous：发送后自动弹目标菜单，选择后带 pid 重发
	input.value = "你好控制台";
	input.dispatchEvent(new window.Event("input", { bubbles: true }));
	sendBtn.disabled = false;
	sendBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 40));
	check("ambiguous 自动弹目标菜单（含提示与候选）", !targetMenu.hidden && targetMenu.textContent.includes("多个控制台") && targetMenu.querySelectorAll("[data-forward-target]").length === 3, targetMenu.textContent.slice(0, 80));
	targetMenu.querySelector('[data-forward-target="1728"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 60));
	check("选择候选后带 pid 重发且成功", forwardCalls.length === 2 && forwardCalls[1].pid === 1728, JSON.stringify(forwardCalls));
	check("成功后按钮目标更新为 PID 1728", targetLabel.textContent === "PID 1728", targetLabel.textContent);
	check("转发记录出现用户消息", document.getElementById("chat-list").textContent.includes("你好控制台"), "");

	// Esc 关菜单
	targetBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 20));
	const escHandled = panel.handleEscape();
	await new Promise((resolve) => setTimeout(resolve, 20));
	check("Esc 关闭目标菜单", escHandled === true && targetMenu.hidden, "");

	console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
