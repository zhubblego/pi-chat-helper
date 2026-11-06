/** context-render.mjs 的类型声明（供 chat-trajectory-tool.ts 使用）。 */

export const CONTEXT_SINGLE_LIMIT: number;
export const CONTEXT_TOTAL_LIMIT: number;

export interface ContextItem {
	id: string;
	kind: string;
	label: string;
	preview: string;
	chars: number;
}

export interface ContextEntry extends ContextItem {
	text?: string;
	rendered?: string;
	valid?: boolean;
}

export const perKindLimits: Readonly<Record<string, number>>;

export function estimateChars(value: unknown): number;
export function eventLabel(ev: Record<string, unknown>): string;
export function eventBody(ev: Record<string, unknown>): string;
export function renderContextEvent(ev: Record<string, unknown>, limits?: { maxChars?: number }): string;
export function contextEventRef(ev: Record<string, unknown>): ContextItem;
export function selectContextEntries(
	entries: ContextEntry[],
	options?: { ids?: string[] | null; query?: string; kind?: string },
): ContextEntry[];
export function paginateContextEntries(
	entries: ContextEntry[],
	options?: { offset?: number; limit?: number },
): { entries: ContextEntry[]; offset: number; limit: number; total: number; nextOffset: number | null };
export function renderContextBatch(
	entries: Array<{ id: string; rendered?: string }>,
	options?: { singleLimit?: number; totalLimit?: number; startOffset?: number },
): { text: string; count: number; truncated: boolean; nextOffset: number | null };
