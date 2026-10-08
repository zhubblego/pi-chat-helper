/**
 * question-panel.ts
 *
 * `/questions [宽度]` — 打开/关闭「用户提问列表」浮动面板（停靠右上角）：
 *   - 列出当前会话分支上的所有用户提问（序号 + 时间 + 摘要）
 *   - 鼠标点击条目 → transcript 滚动到该提问处；滚轮翻动列表；顶部 [ 关闭 ] 关闭
 *   - 键盘备用路径：↑↓ 选择、回车跳转、q/Esc 关闭
 *   - 宽度：默认 60%；/questions 50（列数）或 /questions 60%（百分比）调整，会话内记忆；
 *     面板打开时带参数会以新宽度重开
 *
 * 实现说明：
 *   - 面板本体走公开 API：ctx.ui.custom(overlay) + Component.handleMouse（pi-tui）。
 *   - 跳转：pi 未公开暴露 transcript 组件，这里对 TUI 内部布局对象做运行时特征检测：
 *     currentLayout → 含 scrollContentLines 的 box → ScrollView.scrollTo(row)。
 *     行定位利用 transcript 的 OSC 133;A 标记（UserMessageComponent 与无工具调用的
 *     AssistantMessageComponent 首行都会写入，与内置 previousPrompt/nextPrompt 跳转同源）。
 *     因此点击第 k 条提问时，按分支数据推算它在标记序列中的序号：
 *       user 消息 → 必产生一个标记；assistant 消息 → 仅在没有 toolCall part 时产生标记。
 *     pi 升级若改动这些内部字段/渲染规则，仅跳转失效（面板与提示降级），不影响其他功能。
 */
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	type Component,
	SizeValue,
	TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// 数据：从会话分支收集用户提问
// ---------------------------------------------------------------------------

interface QuestionItem {
	/** 分支顺序号（第几条用户提问，从 0 开始），同时是标记序号推算的输入 */
	index: number;
	/** 首行摘要 */
	summary: string;
	/** HH:MM */
	time: string;
}

/** 提取 user 消息文本（content 可能是 string 或 parts 数组）。 */
function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const part of content) {
			if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
				const t = (part as { text?: string }).text;
				if (typeof t === "string") parts.push(t);
			}
		}
		return parts.join("\n");
	}
	return "";
}

function formatTime(ts: unknown): string {
	const n = typeof ts === "number" ? ts : Number(ts);
	if (!Number.isFinite(n) || n <= 0) return "--:--";
	const d = new Date(n);
	const p = (v: number) => String(v).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (t) return t;
	}
	return "";
}

/** 工具参数摘要（单行、限宽） */
function briefArgs(v: unknown, max = 36): string {
	let s: string;
	try {
		s = typeof v === "string" ? v : (JSON.stringify(v) ?? "null");
	} catch {
		s = String(v);
	}
	s = s.replace(/\s+/g, " ").trim();
	return s ? truncateToWidth(s, max, "…") : "{}";
}

export function collectQuestions(ctx: ExtensionCommandContext): QuestionItem[] {
	const out: QuestionItem[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if ((entry as { type?: string }).type !== "message") continue;
		const msg = (entry as { message?: { role?: string; content?: unknown; timestamp?: unknown } }).message;
		if (!msg || msg.role !== "user") continue;
		const text = extractUserText(msg.content).trim();
		out.push({
			index: out.length,
			summary: text ? firstLine(text) : "[图片]",
			time: formatTime(msg.timestamp),
		});
	}
	return out;
}

/**
 * 推算「第 target 条用户提问」在 transcript OSC 133;A 标记序列中的序号（0 起）。
 * 标记产生规则（UserMessageComponent / AssistantMessageComponent）：
 *   - user 消息：每条恰好一个标记
 *   - assistant 消息：content 无 toolCall part（即纯文本回复）时一个标记
 *   - 其他 role（toolResult/custom/bashExecution/…）：不产生标记
 */
export function markerOrdinalForQuestion(ctx: ExtensionCommandContext, target: number): number | null {
	let markerOrdinal = 0;
	let questionOrdinal = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if ((entry as { type?: string }).type !== "message") continue;
		const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
		if (!msg) continue;

		if (msg.role === "user") {
			if (questionOrdinal === target) return markerOrdinal;
			questionOrdinal++;
			markerOrdinal++;
			continue;
		}

		if (msg.role === "assistant") {
			const parts = Array.isArray(msg.content) ? msg.content : [];
			const hasToolCall = parts.some(
				(p) => p && typeof p === "object" && (p as { type?: string }).type === "toolCall",
			);
			if (!hasToolCall) markerOrdinal++;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// 数据：回合分析（一次提问到下一次提问之间的节点链）
// ---------------------------------------------------------------------------

export type TurnNode =
	| { kind: "thinking"; id: number; text: string }
	| { kind: "text"; id: number; text: string; isFinal: boolean }
	| {
				kind: "tool";
				id: number;
				name: string;
				args: unknown;
				result: string | null;
				isError: boolean;
	  };

export interface TurnData {
	question: QuestionItem;
	/** 思考→工具→…→输出 的线性节点链 */
	nodes: TurnNode[];
}

function partText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			const t = (part as { text?: string }).text;
			if (typeof t === "string") parts.push(t);
		}
	}
	return parts.join("\n");
}

/** 构建第 ordinal 条提问（0 起）的回合分析数据。找不到提问时返回 null。 */
export function buildTurn(ctx: ExtensionCommandContext, ordinal: number): TurnData | null {
	let questionOrdinal = 0;
	let question: QuestionItem | null = null;
	const nodes: TurnNode[] = [];
	const pendingTools = new Map<string, TurnNode & { kind: "tool" }>();

	for (const entry of ctx.sessionManager.getBranch()) {
		if ((entry as { type?: string }).type !== "message") continue;
		const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
		if (!msg) continue;

		// 到达下一条用户提问：回合结束
		if (msg.role === "user") {
			if (question) break;
			if (questionOrdinal === ordinal) {
				question = { index: ordinal, summary: firstLine(extractUserText(msg.content)) || "[图片]", time: "" };
		}
			questionOrdinal++;
			continue;
		}
		if (!question) continue;

		if (msg.role === "assistant") {
			const parts = Array.isArray(msg.content) ? msg.content : [];
			for (const part of parts) {
				const p = part as { type?: string };
				if (p.type === "thinking") {
					const t = (part as { thinking?: string }).thinking ?? "";
					nodes.push({ kind: "thinking", id: nodes.length, text: t });
				} else if (p.type === "toolCall") {
					const tc = part as { id?: string; name?: string; arguments?: unknown };
					const node: TurnNode & { kind: "tool" } = {
						kind: "tool",
						id: nodes.length,
						name: tc.name ?? "(unknown)",
						args: tc.arguments,
						result: null,
						isError: false,
					};
					nodes.push(node);
					if (tc.id) pendingTools.set(tc.id, node);
				} else if (p.type === "text") {
					const t = ((part as { text?: string }).text ?? "").trim();
					if (t) nodes.push({ kind: "text", id: nodes.length, text: t, isFinal: false });
				}
			}
		} else if (msg.role === "toolResult") {
			const tr = msg as { toolCallId?: string; content?: unknown; isError?: boolean };
			const node = tr.toolCallId ? pendingTools.get(tr.toolCallId) : undefined;
			if (node) {
				node.result = partText(tr.content).trim() || "(空)";
				node.isError = tr.isError === true;
				pendingTools.delete(tr.toolCallId!);
			}
		} else if (msg.role === "bashExecution") {
			const b = msg as { command?: string; output?: string; exitCode?: number };
			nodes.push({
					kind: "tool",
					id: nodes.length,
					name: "!bash",
					args: b.command ?? "",
					result: (b.output ?? "").trim() || "(空)",
					isError: b.exitCode !== undefined && b.exitCode !== 0,
			});
		}
	}

	if (!question) return null;
	// 回合内最后一个文本节点标记为「输出」
	for (let i = nodes.length - 1; i >= 0; i--) {
		if (nodes[i].kind === "text") {
				(nodes[i] as { isFinal: boolean }).isFinal = true;
				break;
			}
	}
	return { question, nodes };
}

// ---------------------------------------------------------------------------
// 跳转：运行时特征检测 pi 内部布局（失败优雅降级）
// ---------------------------------------------------------------------------

/** 用户/纯文本 assistant 消息首行的标记（OSC 133;A）。 */
const OSC133_A = /^\x1b\]133;A/;

interface ScrollViewLike {
	scrollTo(row: number, opts?: { disableFollow?: boolean }): void;
}
interface LayoutBoxLike {
	scrollView?: unknown;
	scrollContentLines?: readonly string[];
	children?: LayoutBoxLike[];
}
interface TuiInternals {
	requestRender?: () => void;
	/** 渲染帧：{ root: 根盒, lines, primaryScrollView? }（getScrollViewBox 同源结构） */
	currentLayout?: ({ primaryScrollView?: unknown; root?: LayoutBoxLike } & LayoutBoxLike) | undefined;
}

/** 在布局树里找到 transcript 的滚动视图与全部内容行。 */
export function findTranscript(tui: TUI): { scrollView: ScrollViewLike; lines: readonly string[] } | null {
	// SAFETY: tui 是 pi 传入的 TuiAltScreen 实例，currentLayout 属性在运行时存在且未被混淆；
	// 此处仅读取布局数据，不触内部方法，字段缺失时逐层判空返回 null。
	const internals = tui as unknown as TuiInternals;
	const layout = internals.currentLayout;
	// 渲染帧形状：{ root: 根盒, lines, primaryScrollView? }，盒子树挂在 root 上
	const rootBox: LayoutBoxLike | undefined = layout?.root ?? layout;
	if (!rootBox) return null;

	const boxes: LayoutBoxLike[] = [];
	const visit = (box: LayoutBoxLike): void => {
		boxes.push(box);
		for (const child of box.children ?? []) visit(child);
	};
	visit(rootBox);

	// transcript = 滚动内容里带 OSC 133;A 标记的 scroll box
	for (const box of boxes) {
		const lines = box.scrollContentLines;
		if (!Array.isArray(lines) || lines.length === 0) continue;
		if (!lines.some((line) => OSC133_A.test(line ?? ""))) continue;

		const scrollView = (box.scrollView ?? layout?.primaryScrollView) as ScrollViewLike | undefined;
		if (!scrollView || typeof scrollView.scrollTo !== "function") return null;
		return { scrollView, lines };
	}
	return null;
}

/** 滚动到标记序列中第 ordinal 个标记行。返回是否成功。 */
export function jumpToMarker(tui: TUI, ordinal: number): boolean {
	const found = findTranscript(tui);
	if (!found) return false;

	let seen = -1;
	for (let row = 0; row < found.lines.length; row++) {
		if (!OSC133_A.test(found.lines[row] ?? "")) continue;
		seen++;
		if (seen === ordinal) {
			// 目标行上方留一行上下文
			found.scrollView.scrollTo(Math.max(0, row - 1), { disableFollow: true });
			// SAFETY: 仅调用公开的 requestRender（可选属性，不存在则跳过）
			(tui as unknown as TuiInternals).requestRender?.();
			return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// 面板组件
// ---------------------------------------------------------------------------

const MAX_VISIBLE_ROWS = 18;
/** 回合分析：树可视行数 / 详情区行数 */
const TREE_VISIBLE_ROWS = 8;
const DETAIL_ROWS = 10;

export class QuestionPanelComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly items: QuestionItem[];
	private readonly jump: (index: number) => void;
	private readonly onClose: () => void;

	private readonly turnLoader: (ordinal: number) => TurnData | null;

	private selected = 0;
	/** 鼠标悬停的条目序号；-1 表示悬停在关闭按钮上；null 表示无 */
	private hover: number | null = null;
	/** 列表滚动偏移（条目数） */
	private offset = 0;
	private version = 0;

	// 回合分析视图状态
	private view: "list" | "turn" = "list";
	private turn: TurnData | null = null;
	/** 仅显示思维链 */
	private chainOnly = false;
	/** 选中节点在 visibleNodes 中的序号 */
	private nodeSel = 0;
	private treeOffset = 0;
	private detailOffset = 0;
	private hoverNode: number | null = null;

	// render 时记录的命中区域
	private itemYs: number[] = [];
	private closeStart = 0;
	private closeEnd = 0;
	private nodeYs: number[] = [];
	private backStart = 0;
	private backEnd = 0;
	/** 详情内容行范围（含端点） */
	private detailTop = -1;
	private detailBottom = -1;
	/** Markdown 组件缓存（输出节点详情） */
	private mdCache: { key: string; theme: unknown; md: Markdown } | null = null;

	// 渲染缓存
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private cachedVersion = -1;

	constructor(
		tui: TUI,
		theme: Theme,
		items: QuestionItem[],
		jump: (index: number) => void,
		turnLoader: (ordinal: number) => TurnData | null,
		onClose: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.items = items;
		this.jump = jump;
		this.turnLoader = turnLoader;
		this.onClose = onClose;
		this.selected = items.length - 1;
		this.itemYs = new Array(items.length).fill(-1);
	}

	close(): void {
		this.onClose();
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.mdCache = null;
	}

	private bump(): void {
		this.version++;
		this.tui.requestRender();
	}

	private visibleCount(): number {
		return Math.min(this.items.length, MAX_VISIBLE_ROWS);
	}

	private maxOffset(): number {
		return Math.max(0, this.items.length - this.visibleCount());
	}

	private ensureSelectedVisible(): void {
		if (this.selected < this.offset) this.offset = this.selected;
		const last = this.offset + this.visibleCount() - 1;
		if (this.selected > last) this.offset = this.selected - this.visibleCount() + 1;
	}

	private jumpTo(index: number): void {
		this.selected = index;
		this.jump(index);
	}

	/** 当前树视图可见节点（chainOnly 时仅思考） */
	private visibleNodes(): TurnNode[] {
		if (!this.turn) return [];
		return this.chainOnly ? this.turn.nodes.filter((n) => n.kind === "thinking") : this.turn.nodes;
	}

	private ensureNodeVisible(): void {
		const total = this.visibleNodes().length;
		const view = Math.min(total, TREE_VISIBLE_ROWS);
		if (this.nodeSel < this.treeOffset) this.treeOffset = this.nodeSel;
		if (this.nodeSel > this.treeOffset + view - 1) this.treeOffset = this.nodeSel - view + 1;
		this.treeOffset = Math.max(0, Math.min(Math.max(0, total - view), this.treeOffset));
	}

	private selectNode(pos: number): void {
		const total = this.visibleNodes().length;
		if (total === 0) return;
		this.nodeSel = Math.max(0, Math.min(total - 1, pos));
		this.detailOffset = 0;
		this.ensureNodeVisible();
		this.bump();
	}

	/** 列表双击/d：进入该提问的回合分析 */
	private enterTurn(index: number): void {
		const turn = this.turnLoader(this.items[index]!.index);
		if (!turn) return;
		this.selected = index;
		this.turn = turn;
		this.view = "turn";
		this.chainOnly = false;
		this.nodeSel = 0;
		this.treeOffset = 0;
		this.detailOffset = 0;
		this.hoverNode = null;
		this.bump();
	}

	private backToList(): void {
		this.view = "list";
		this.turn = null;
		this.mdCache = null;
		this.bump();
	}

	handleInput(data: string): boolean {
		if (data === "q" || data === "Q") {
			this.close();
			return true;
		}

		if (this.view === "turn") {
			if (matchesKey(data, "escape") || matchesKey(data, "left")) {
				this.backToList();
				return true;
			}
			if (matchesKey(data, "up")) {
				this.selectNode(this.nodeSel - 1);
				return true;
			}
			if (matchesKey(data, "down")) {
				this.selectNode(this.nodeSel + 1);
				return true;
			}
			if (data === "t" || data === "T") {
				this.chainOnly = !this.chainOnly;
				this.nodeSel = 0;
				this.treeOffset = 0;
				this.detailOffset = 0;
				this.bump();
				return true;
			}
			if (matchesKey(data, "return")) {
				// 回车：定位到该提问在 transcript 的位置
				this.jump(this.turn!.question.index);
				return true;
			}
			return true;
		}

		// 列表视图
		if (matchesKey(data, "escape")) {
			this.close();
			return true;
		}
		if (matchesKey(data, "up")) {
			if (this.selected > 0) {
				this.selected--;
				this.ensureSelectedVisible();
				this.bump();
			}
			return true;
		}
		if (matchesKey(data, "down")) {
			if (this.selected < this.items.length - 1) {
				this.selected++;
				this.ensureSelectedVisible();
				this.bump();
			}
			return true;
		}
		if (matchesKey(data, "return") || data === " ") {
			this.jumpTo(this.selected);
			return true;
		}
		if (data === "d" || data === "D" || matchesKey(data, "right")) {
			this.enterTurn(this.selected);
			return true;
		}
		return true;
	}

	private inBack(event: TuiMouseEvent): boolean {
		return event.y === 0 && event.x >= this.backStart && event.x < this.backEnd;
	}

	private inClose(event: TuiMouseEvent): boolean {
		return event.y === 0 && event.x >= this.closeStart && event.x < this.closeEnd;
	}

	private nodeAt(y: number): number {
		for (let i = 0; i < this.nodeYs.length; i++) {
			if (this.nodeYs[i] === y) return i;
		}
		return -1;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") {
			if (this.view === "turn") {
				const next = this.inBack(event)
					? -2
					: this.inClose(event)
						? -1
						: this.nodeAt(event.y);
				if (next !== this.hoverNode) {
					this.hoverNode = next;
					this.bump();
				}
				return { handled: true, render: false };
			}
			const next = this.inClose(event) ? -1 : this.itemAt(event.y);
			if (next !== this.hover) {
				this.hover = next;
				this.bump();
			}
			return { handled: true, render: false };
		}

		if (event.type === "wheel") {
			// wheelDelta 为负 = 向上滚
			const step = Math.max(-3, Math.min(3, event.wheelDelta ?? -1));
			if (this.view === "turn") {
				if (event.y >= this.detailTop && event.y <= this.detailBottom) {
					// 详情区滚动（逐行）
					this.detailOffset = Math.max(0, this.detailOffset + step);
					this.bump();
				} else {
					const total = this.visibleNodes().length;
					const view = Math.min(total, TREE_VISIBLE_ROWS);
					const next = Math.max(0, Math.min(Math.max(0, total - view), this.treeOffset + step));
					if (next !== this.treeOffset) {
							this.treeOffset = next;
						this.bump();
					}
				}
				return { handled: true, render: true };
			}
			const next = Math.max(0, Math.min(this.maxOffset(), this.offset + step));
			if (next !== this.offset) {
				this.offset = next;
				this.bump();
			}
			return { handled: true, render: true };
		}

		if (event.type === "click" && event.button === "left") {
			if (this.inClose(event)) {
				this.close();
				return { handled: true };
			}
			if (this.view === "turn") {
				if (this.inBack(event)) {
					this.backToList();
					return { handled: true };
				}
				const pos = this.nodeAt(event.y);
				if (pos >= 0) this.selectNode(pos);
				return { handled: true, render: false };
			}
			const idx = this.itemAt(event.y);
			if (idx >= 0) {
				// 双击进入回合分析；单击跳转定位
				if (event.clickCount === 2) this.enterTurn(idx);
				else this.jumpTo(idx);
			}
			return { handled: true, render: false };
		}

		return { handled: true, render: false };
	}

	/** y 行对应的条目序号；不在条目行上返回 -1。 */
	private itemAt(y: number): number {
		for (let i = 0; i < this.itemYs.length; i++) {
			if (this.itemYs[i] === y) return i;
		}
		return -1;
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedVersion === this.version) {
			return this.cachedLines;
		}
		const lines = this.view === "turn" ? this.renderTurn(width) : this.renderList(width);
		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = this.version;
		return lines;
	}

	private renderList(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		this.itemYs = new Array(this.items.length).fill(-1);

		const innerW = Math.max(10, width - 2);
		// 内容行：│ + 填充到 innerW + │
		const boxLine = (body: string): string => {
			const padded = body + " ".repeat(Math.max(0, innerW - visibleWidth(body)));
			return "│" + truncateToWidth(padded, innerW, "") + "│";
		};

		// 顶边框：┌─ 提问列表（N）─── [ 关闭 ]──┐
		const closeLabel = " [ 关闭 ] ";
		const titleSeg = "─" + theme.fg("accent", theme.bold(` 提问列表（${this.items.length}）`)) + "─";
		const fill = Math.max(0, width - 2 - visibleWidth(titleSeg) - (visibleWidth(closeLabel) + 2));
		const closeStyled =
			this.hover === -1
				? theme.style(closeLabel, { fg: "accent", bold: true })
				: theme.fg("muted", closeLabel);
		const top =
			"┌" + titleSeg + theme.fg("dim", "─".repeat(fill)) + "─" + closeStyled + "─" + "┐";
		lines.push(truncateToWidth(top, width, ""));
		// 极窄宽度下关闭按钮可能被截断：命中区域随之收敛，避免越界
		this.closeStart = Math.min(this.closeStart, Math.max(0, width - visibleWidth(closeLabel)));
		this.closeEnd = Math.min(this.closeStart + visibleWidth(closeLabel), width);

		// 条目行
		const count = this.visibleCount();
		for (let row = 0; row < count; row++) {
			const idx = this.offset + row;
			if (idx >= this.items.length) break;
			const item = this.items[idx]!;
			const active = this.hover === idx || (this.hover === null && this.selected === idx);
			const marker = active ? "> " : "  ";
			const num = String(idx + 1).padStart(2, " ");
			const body = truncateToWidth(`${marker}${num} ${item.time}  ${item.summary}`, innerW, "…");
			lines.push(boxLine(active ? theme.style(body, { fg: "accent", bold: true }) : body));
			this.itemYs[idx] = lines.length - 1;
		}

		// 分隔线 + 底部提示 + 底边框
		lines.push("├" + "─".repeat(innerW) + "┤");
		const range =
			this.maxOffset() > 0
				? `（${this.offset + 1}-${Math.min(this.items.length, this.offset + count)}/${this.items.length}）`
				: "";
		const hint = ` 回车/点击 跳转 · 双击/d 分析 · ↑↓ 选择 · 滚轮 翻动${range} · q/Esc 关闭 `;
		lines.push(boxLine(theme.fg("dim", truncateToWidth(hint, innerW, "…"))));
		lines.push("└" + "─".repeat(innerW) + "┘");

		return lines;
	}

	// -----------------------------------------------------------------------
	// 回合分析视图
	// -----------------------------------------------------------------------

	private renderTurn(width: number): string[] {
		const theme = this.theme;
		const turn = this.turn!;
		const lines: string[] = [];
		const innerW = Math.max(10, width - 2);
		const boxLine = (body: string): string => {
			const padded = body + " ".repeat(Math.max(0, innerW - visibleWidth(body)));
			return "│" + truncateToWidth(padded, innerW, "") + "│";
		};

		// 顶边框：┌─ 回合分析 · 第N问 ── [ 返回 ]─[ 关闭 ]─┐
		const backLabel = " [ 返回 ] ";
		const closeLabel = " [ 关闭 ] ";
		const titleSeg =
			"─" + theme.fg("accent", theme.bold(` 回合分析 · 第${turn.question.index + 1}问 `)) + "─";
		const fill = Math.max(
				0,
				width - 2 - visibleWidth(titleSeg) - (visibleWidth(backLabel) + 1) - (visibleWidth(closeLabel) + 1),
		);
		const btn = (label: string, active: boolean): string =>
			active ? theme.style(label, { fg: "accent", bold: true }) : theme.fg("muted", label);
		const top =
			"┌" +
			titleSeg +
			theme.fg("dim", "─".repeat(fill)) +
			"─" +
			btn(backLabel, this.hoverNode === -2) +
			"─" +
			btn(closeLabel, this.hoverNode === -1) +
			"┐";
		lines.push(truncateToWidth(top, width, ""));
		let col = 1 + visibleWidth(titleSeg) + fill + 1;
		this.backStart = col;
		this.backEnd = Math.min(col + visibleWidth(backLabel), width);
		col = this.backEnd + 1;
		this.closeStart = Math.min(col, Math.max(0, width - visibleWidth(closeLabel)));
		this.closeEnd = Math.min(this.closeStart + visibleWidth(closeLabel), width);

		// 提问行
		lines.push(boxLine(theme.fg("dim", truncateToWidth(` 问  ${turn.question.summary}`, innerW, "…"))));

		// 节点树
		const nodes = this.visibleNodes();
		this.nodeYs = new Array(nodes.length).fill(-1);
		const view = Math.min(nodes.length, TREE_VISIBLE_ROWS);
		for (let row = 0; row < view; row++) {
			const pos = this.treeOffset + row;
			if (pos >= nodes.length) break;
			const node = nodes[pos]!;
			const connector = pos === nodes.length - 1 ? "└─" : "├─";
			const active = this.hoverNode === pos || (this.hoverNode === null && this.nodeSel === pos);
			let label: string;
			let summary: string;
			switch (node.kind) {
				case "thinking":
					label = "思考";
					summary = firstLine(node.text) || "(空)";
					break;
				case "text":
					label = node.isFinal ? "输出" : "文本";
					summary = firstLine(node.text);
					break;
				case "tool": {
					label = "工具";
					const status =
						node.result === null ? "·无结果" : node.isError ? "·出错" : `·${node.result.split("\n").length}行`;
					summary = `${node.name} ${briefArgs(node.args)} ${status}`;
					break;
				}
			}
			const head = `${connector} ${label} `;
			const body = head + truncateToWidth(summary, Math.max(4, innerW - visibleWidth(head) - 1), "…");
			lines.push(boxLine(active ? theme.style(body, { fg: "accent", bold: true }) : body));
			this.nodeYs[pos] = lines.length - 1;
		}

		// 详情标题（含树滚动范围与思维链标记）
		lines.push("├" + "─".repeat(innerW) + "┤");
		const selNode = nodes[this.nodeSel];
		const kindLabel = selNode
			? selNode.kind === "thinking"
				? "思考"
				: selNode.kind === "tool"
					? `工具 ${selNode.name}`
					: selNode.isFinal
						? "输出（Markdown）"
						: "文本"
			: "（无节点）";
		const treeRange =
			nodes.length > view
				? ` ${this.treeOffset + 1}-${Math.min(nodes.length, this.treeOffset + view)}/${nodes.length}`
				: "";
		const detailTitle = ` 详情 · ${kindLabel}${treeRange}${this.chainOnly ? " · 仅思维链" : ""} `;
		lines.push(
			"├" +
				theme.fg("dim", detailTitle) +
				theme.fg("dim", "─".repeat(Math.max(0, innerW - visibleWidth(detailTitle)))) +
				"┤",
		);

		// 详情内容
		const dw = Math.max(8, innerW - 2);
		const detail = selNode ? this.detailLines(selNode, dw) : ["(无节点)"];
		this.detailTop = lines.length;
		for (let r = 0; r < DETAIL_ROWS; r++) {
			const idx = this.detailOffset + r;
			const text = idx < detail.length ? detail[idx]! : "";
			lines.push(boxLine(" " + text));
		}
		this.detailBottom = lines.length - 1;

		// 底部提示 + 底边框
		lines.push("├" + "─".repeat(innerW) + "┤");
		const hint = ` ↑↓ 节点 · 回车 定位提问 · t 仅思维链(${this.chainOnly ? "开" : "关"}) · ←/Esc 返回 · 滚轮 滚动 · q 关闭 `;
		lines.push(boxLine(theme.fg("dim", truncateToWidth(hint, innerW, "…"))));
		lines.push("└" + "─".repeat(innerW) + "┘");

		return lines;
	}

	/** 节点详情行（已按宽度 wrap，可直接进详情区） */
	private detailLines(node: TurnNode, dw: number): string[] {
		const theme = this.theme;
		const wrap = (text: string): string[] => {
			const out: string[] = [];
			for (const line of text.split("\n")) {
				const wrapped = wrapTextWithAnsi(line, dw);
				out.push(...(wrapped.length > 0 ? wrapped : [""]));
			}
			return out.length > 0 ? out : ["(空)"];
		};

		if (node.kind === "thinking") return wrap(node.text);

		if (node.kind === "text") {
			if (!node.isFinal) return wrap(node.text);
			// 最终输出：Markdown 渲染（按节点+宽度缓存，主题变化时重建；
			// 主题未初始化等异常时退回纯文本 wrap）
			try {
				const mdTheme = getMarkdownTheme();
				const key = `${node.id}:${dw}`;
				if (!this.mdCache || this.mdCache.key !== key || this.mdCache.theme !== mdTheme) {
					this.mdCache = { key, theme: mdTheme, md: new Markdown(node.text, 0, 0, mdTheme) };
				}
				return this.mdCache.md.render(dw);
			} catch {
				return wrap(node.text);
			}
		}

		// 工具节点：名称 + 参数 + 结果
		const head: string[] = [
			theme.fg("accent", `工具 ${node.name}`) + (node.isError ? "  " + theme.fg("error", "出错") : ""),
			"",
			theme.fg("dim", "参数:"),
		];
		let argsLines: string[];
		try {
			const s = typeof node.args === "string" ? node.args : (JSON.stringify(node.args, null, 2) ?? String(node.args));
			argsLines = wrap(s);
		} catch {
			argsLines = wrap(String(node.args));
		}
		const resHead =
			node.result === null
				? ["", theme.fg("dim", "结果: (未返回)")]
				: ["", theme.fg("dim", `结果${node.isError ? "(出错)" : ""}:`)];
		const resLines = node.result === null ? [] : wrap(node.result);
		return [...head, ...argsLines, ...resHead, ...resLines];
	}
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// 面板打开期间非空；此时 /questions 充当「关闭」
	let closePanel: (() => void) | null = null;
	// 面板宽度：列数或百分比字符串；/questions 50 、 /questions 60% 可调（会话内记忆）
	let panelWidth: SizeValue = "60%";

	/** 解析宽度参数；null 表示未提供或非法（非法时已 notify） */
	function parseWidthArg(args: string, notify: (msg: string, type: "warning") => void): SizeValue | null | false {
		const t = args.trim();
		if (!t) return null;
		const m = /^(\d{1,3})(%?)$/.exec(t);
		if (!m) {
			notify("宽度参数非法；用法：/questions 50（列）或 /questions 60%（百分比）", "warning");
			return false;
		}
		const n = Number(m[1]);
		if (m[2]) {
			if (n < 20 || n > 100) {
				notify("百分比宽度需在 20–100 之间", "warning");
				return false;
			}
			return `${n}%` as SizeValue;
		}
		if (n < 30 || n > 500) {
			notify("列宽度需在 30–500 之间", "warning");
			return false;
		}
		return n;
	}

	pi.registerCommand("questions", {
		description:
			"打开/关闭提问列表面板（单击跳转、双击进入回合分析；/questions 50 或 /questions 60% 调整宽度）",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("question-panel 需要交互式（tui）模式", "error");
				return;
			}

			const parsed = parseWidthArg(args ?? "", (msg) => ctx.ui.notify(msg, "warning"));
			if (parsed === false) return;
			if (parsed !== null) panelWidth = parsed;

			if (closePanel) {
				closePanel();
				if (parsed === null) return; // 无参数：纯关闭；带参数：换宽度重开
			}

			const questions = collectQuestions(ctx);
			if (questions.length === 0) {
				ctx.ui.notify("当前会话还没有用户提问", "info");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const panel = new QuestionPanelComponent(
						tui,
						theme,
						questions,
						(index) => {
							const ordinal = markerOrdinalForQuestion(ctx, questions[index]!.index);
							if (ordinal === null || !jumpToMarker(tui, ordinal)) {
								ctx.ui.notify("跳转失败：无法定位 transcript（pi 内部结构可能已变化）", "warning");
							}
						},
						(ordinal) => buildTurn(ctx, ordinal),
						() => {
							closePanel = null;
							done(undefined);
						},
					);
					closePanel = () => panel.close();
					return panel;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-right",
						margin: 1,
						width: panelWidth,
						minWidth: 36,
						maxHeight: "70%",
					},
				},
			);
		},
	});
}
