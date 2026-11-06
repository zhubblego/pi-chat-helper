/** trajectory-reader.mjs 的类型声明。 */

export function readTrajectoryProjection(source: string, file: string): { meta: Record<string, unknown>; questions: unknown[] };
export function findProjectionEvent(
	projection: { questions?: unknown[] },
	id: string,
): { event: Record<string, unknown>; question: Record<string, unknown> } | null;
