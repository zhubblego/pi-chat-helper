/** state-db.mjs 的类型声明；供后续 S2–S4 的服务端/扩展接线使用。 */

export const STATE_DB_SCHEMA_VERSION: 1;
export const STATE_DB_DIRNAME: "pi-chat-helper";
export const STATE_DB_FILENAME: "state.db";
export const STATE_DB_BUSY_TIMEOUT_MS: 5_000;

export const GLOBAL_PREF_KEYS: readonly [
	"filters",
	"tools",
	"theme",
	"translate",
	"chatOpen",
	"chatWidth",
	"composerHeight",
];

export const CHAT_PROFILES: readonly ["no-tools", "read-only", "full"];
export const DEFAULT_PROFILE: "read-only";
export const SESSION_MODES: readonly ["independent", "forward"];
export const CONTEXT_KINDS: readonly ["active", "next"];
export const MAX_SESSION_CONTEXT_IDS: 5_000;

export type GlobalPrefKey = (typeof GLOBAL_PREF_KEYS)[number];
export type ChatProfile = (typeof CHAT_PROFILES)[number];
export type ChatMode = (typeof SESSION_MODES)[number];
export type ContextKind = (typeof CONTEXT_KINDS)[number];
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface StateDbOptions {
	agentDir?: string;
	stateDbPath?: string;
	chatDir?: string;
	settingsPath?: string;
	env?: Record<string, string | undefined>;
	now?: () => string;
	log?: (message: string) => void;
}

export interface StateDbCapabilities {
	ok: boolean;
	path: string;
	reason?: string;
	schemaVersion?: number;
	journalMode?: string;
	busyTimeoutMs?: number;
	agentDir?: string;
	chatDir?: string;
}

export interface GlobalPrefsResult {
	revision: number;
	global: Partial<Record<GlobalPrefKey, JsonValue>>;
}

export interface SessionUi {
	threadId: string | null;
	threadNew: boolean;
	mode: ChatMode;
	contextIds: string[];
	updatedAt: string | null;
}

export interface SessionUiPatch {
	threadId?: string | null;
	threadNew?: boolean;
	mode?: ChatMode;
	contextIds?: string[];
}

export interface ChatProject {
	profile: ChatProfile;
	projectSkills: boolean;
	updatedAt: string | null;
}

export interface ChatProjectPatch {
	profile?: ChatProfile;
	projectSkills?: boolean;
}

export interface TurnRecord {
	threadId: string;
	ordinal: number;
	[key: string]: JsonValue;
}

export interface ContextSnapshot {
	items: JsonValue[];
	[key: string]: JsonValue;
}

export interface LegacyMigrationResult {
	skipped: boolean;
	reason?: string;
	projects: number;
	turns: number;
	contexts: number;
	errors: number;
	skippedItems: number;
}

export interface StateDb {
	ok: boolean;
	path: string;
	agentDir: string;
	chatDir: string;
	settingsPath: string;
	capabilities: StateDbCapabilities;
	lastMigration: LegacyMigrationResult;
	getGlobalPrefs(): GlobalPrefsResult;
	setGlobalPrefs(patch: Partial<Record<GlobalPrefKey, JsonValue>>): GlobalPrefsResult;
	getSessionUi(source: string, sessionId: string): SessionUi;
	setSessionUi(source: string, sessionId: string, patch: SessionUiPatch): SessionUi;
	getChatProject(source: string, projectPath: string): ChatProject;
	setChatProject(source: string, projectPath: string, patch: ChatProjectPatch): ChatProject;
	readTurns(source: string, sessionId: string, threadId?: string | null): TurnRecord[];
	upsertTurn(source: string, sessionId: string, record: TurnRecord): TurnRecord & { updatedAt: string };
	readContext(source: string, sessionId: string, kind?: ContextKind): ContextSnapshot;
	writeContext(source: string, sessionId: string, kind: ContextKind, snapshot: ContextSnapshot): ContextSnapshot;
	writeContextNext(source: string, sessionId: string, snapshot: ContextSnapshot): ContextSnapshot;
	promoteContext(source: string, sessionId: string): ContextSnapshot;
	migrateLegacy(): LegacyMigrationResult;
	close(): void;
}

export function stateDbPathFor(agentDir?: string): string;
export function openStateDb(options?: StateDbOptions): StateDb;
