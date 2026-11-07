# 对话页落地清单（v2）

> 上游总览：[README.md](README.md)。接口契约：[api.md](api.md)。交互：[ui.md](ui.md)。
> 本版把对话引擎改为「受管的 pi 子进程（RPC）」；删除 `chatBackend`、自定义 JSONL、`buildHistory`、技能格式复制等旧实现项。

## 1. 文件改动总表

| 文件 | 类型 | 改动 |
|---|---|---|
| `trajectory-web/server/chat-host.mjs` | 新增 | 子进程池、RPC 协议、SSE 映射、审批桥、设置、线程列表/新建/切换路由分发 |
| `trajectory-web/server/pi-binary.mjs` | 新增 | pi 可执行文件解析与版本探测 |
| `trajectory-web/server/chat-session.mjs` | 新增 | 纯函数：pi session 投影 → 对话消息、侧车轮次、清单/delta、路径校验 |
| `trajectory-web/server/chat-settings.mjs` | 新增 | 纯函数：`settings.json` 原子读写、按项目分键、profile/projectSkills 默认与校验 |
| `trajectory-web/server/chat-pool.mjs` | 新增 | 纯函数：进程池上限、空闲 TTL、LRU 选择 |
| `trajectory-web/server/trajectory-reader.mjs` | 新增 | 子进程扩展共用：按 pi/codex 读轨迹投影与事件查找 |
| `trajectory-web/server/approval.mjs` | 新增 | 纯函数：审批 toolName 解析、摘要截断、timeout 毫秒→秒、AUTO 常量 |
| `trajectory-web/server/context-render.mjs` | 新增 | 纯函数：单条轨迹事件渲染（服务端与子进程扩展共用） |
| `trajectory-web/server/app.mjs` | 修改 | 注入 `chatDir`/`piBin`；挂 `/api/chat/*`（含 threads/resume）；POST 白名单；安全校验；静态资源；close 顺序 |
| `trajectory-web/server/main.mjs` | 修改 | `--chat-dir`、`--no-chat`、`--pi-bin`；把解析结果传给 server |
| `trajectory-web/index.ts` | 修改 | 模式 A 传 `piBin`/`chatDir`；`startInProcess` 选项；close 顺序 |
| `trajectory-web/chat-trajectory-tool.ts` | 新增 | 子进程扩展：注册 `read_trajectory` 工具（context-as-tool） |
| `trajectory-web/chat-approval.ts` | 新增 | 子进程扩展：全量档工具审批（`tool_call` + `ctx.ui.confirm`） |
| `trajectory-web/web/index.html` | 修改 | 无顶部对话头；模型 chip（带边框）/权限 chip 移入 chat-row；上下文 chips、斜杠面板、技能 chip、审批弹层 |
| `trajectory-web/web/chat.js` | 新增 | 对话 DOM、SSE、斜杠面板、模型/技能/上下文/审批/线程历史状态 |
| `trajectory-web/web/chat-lib.js` | 新增 | 纯函数：SSE 解析、面板过滤、上下文持久化、格式化 |
| `trajectory-web/web/app.js` | 修改 | 接线 `initChatPanel`；`selectMode()`；选中持久化；会话切换；Esc 链；启动 |
| `trajectory-web/web/style.css` | 修改 | 输入卡状态/chips/面板/工具卡片/审批弹层/流式光标/响应式 |
| `tsconfig.json` | 修改 | `files` 加入 `trajectory-web/chat-trajectory-tool.ts`、`trajectory-web/chat-approval.ts`（只做类型检查） |
| `tests/test-chat.cjs` | 新增 | 协议解析、路径、清单/delta、渲染、设置、线程映射 |
| `tests/test-server.cjs` | 修改 | fake child + chat 路由/SSE/审批/安全/线程列表/切换集成 |
| `tests/test-web-lib.cjs` | 修改 | `chat-lib.js` 纯函数 + 源码守卫 |
| `tests/test-extension.cjs` | 修改 | 真 `pi --mode rpc` 冒烟、两个子进程扩展、模式 A 接线 |
| `README.md` | 修改 | 对话页能力、子进程模型、工具 profile、chat 目录 |
| `ROADMAP.md` | 修改 | 实施完成并验证后补「已完成」段 |

**不新增运行时依赖。** 服务端不 import pi SDK；只 spawn `pi`。`@earendil-works/pi-coding-agent` 仍是 optional peer，只用于两个子进程扩展的类型与测试。

## 2. 后端

### 2.1 `chat-host.mjs` 职责

```js
export function createChatHost(deps) {
  // deps: {
  //   chatDir, piBin, settingsPath, log,
  //   readSessions, resolveSession, getProjection, findEvent,
  //   availableSources, sessionRoots,
  // }
  // return { handle, capabilities, close }
}
```

内部状态：

```js
const children = new Map();   // `${source}:${sessionId}` -> ChildRecord
const projectTurns = new Map(); // `${source}:${projectPath}` -> { key, startedAt }
const allow = new Map();        // `${source}:${projectPath}` -> Set<toolName>
let settings = loadSettings();  // { version, projects: {...} }
```

`ChildRecord`：

```js
{
  key, source, sessionId, projectPath,
  sessionDir, metaDir,
  cmd, args, proc, nextId,
  pending: Map<id, {resolve, reject}>,
  stderr: "",
  profile, projectSkills,
  piSessionId,      // 当前线程 id（get_state/new_session 后更新）
  currentTurn,      // { res, keepalive, approvals: Map, startedAt } | null
  lastUsedAt, state  // starting | idle | busy | dead
}
```

方法：

| 方法 | 路由 | 说明 |
|---|---|---|
| `capabilities(refresh)` | `GET /api/chat/capabilities` | 解析 pi、版本、目录可写；不 spawn |
| `models(url)` | `GET /api/chat/models` | `get_available_models`；线程模型从 session 文件读 |
| `changeModel(body)` | `POST /api/chat/model` | `switch_session`（如需要）+ `set_model` |
| `skills(url)` | `GET /api/chat/skills` | `get_commands` 过滤 skill；`refresh=1` 重启 child |
| `thread(url)` | `GET /api/chat/thread` | 读 session 文件 → `chat-session.mjs` 投影 |
| `createThread(body)` | `POST /api/chat/thread` | `new_session` + `get_state` |
| `settingsGet(url)` / `settingsSet(body)` | `GET/POST /api/chat/settings` | 读写 settings；切档重启 child |
| `send(req,res,body)` | `POST /api/chat/send` | SSE；见 2.5 |
| `stop(body)` | `POST /api/chat/stop` | `abort` |
| `approval(body)` | `POST /api/chat/approval` | 审批回写 + allow-set |
| `close()` | 服务关闭 | abort + SIGTERM→SIGKILL 全部 child |

### 2.2 RPC 协议

- 一行一个 JSON；stdout 只处理能 `JSON.parse` 的行，其余写日志。
- 主机给每条命令分配 `id = c<seq>`；`pending` 里按 id 配对 `{type:"response"}`。
- 事件（无 `id` 或 `type !== "response"`）交给 `currentTurn` 分发；没有活动 turn 的 `extension_ui_request` 直接回复 `cancelled`。
- stderr 累积环形缓冲（8KB），用于错误提示与 `capabilities.reason`。
- 子进程 `exit`：
  - reject 所有 pending；
  - 若 `currentTurn` 存在 → 发 `error` 事件、清理 keepalive、释放锁；
  - 从 `children` 删除；`state=dead`。

用到的 RPC 命令（稳定子集）：

```text
get_state
get_available_models
set_model
get_commands
new_session
switch_session
prompt
abort
```

可选（后续）：`set_thinking_level`、`get_messages`、`compact`、`get_entries`。

### 2.3 进程池与串行

- key = `${source}:${sessionId}`（一个轨迹会话一个 child）。
- 懒启动：首次 `send/models/skills/thread(new)` 时 `ensureChild`。
- 全局上限 **2**：容量检查与 spawn 在同一条 promise 链（pool gate）上串行；超出时回收最久未用的 idle child（LRU）；没有可淘汰的则 409。
- 空闲 **15 分钟** 回收：60 秒定时扫一次，`state==="idle" && !currentTurn && now-lastUsedAt > TTL` → `close+delete`；timer `unref`，`close` 清 timer。
- `lastUsedAt` 在所有使用点更新：ensureChild 命中/启动中、send、models/skills/settings/thread、stop/approval、readChildState；LRU 按此排序。
- 同项目串行：`projectTurns` 按 `${source}:${canonicalProjectPath}` 占位；检查与占位前移到 ensureChild 之前，有活动 turn 时第二个请求 409（即使属于另一个 child）。
- 同 child 串行：`currentTurn` 非空 → 409。
- 切线程：同一 child 内 `switch_session`；切换前必须 `currentTurn === null`。
- 切项目：不同 child；受全局上限约束。
- 设置一致性：`record.settingsKey = profile:projectSkills`；ensureChild 命中时设置变了且 idle → `restartChildKeepThread`；settings POST 立即重启同项目 idle child，busy/starting 标 `settingsStale`，turn 结束后下次 ensure 重启；目标自身 busy 仍 409。
- 路径统一：`projectPath` / allow-set / settings / projectTurns 都使用 canonical 项目路径；实际 spawn 目录单独放 `record.cwd`，项目目录被删时不再漂移。

### 2.4 `pi-binary.mjs`

```js
export function resolvePi({ hostEntry, hostExecPath, env = process.env }) {
  // 返回 { cmd, argsPrefix, kind, display }
}
export async function probePi(pi, { timeoutMs = 5000 } = {}) {
  // 执行 <cmd> ...argsPrefix --version，返回 { ok, version, stderr }
}
```

解析顺序：

1. `PI_CHAT_PI_BIN`：`{ cmd: bin, argsPrefix: [] }`。
2. 模式 A 的宿主：`hostEntry` 是当前 pi 的入口脚本 → `{ cmd: hostExecPath, argsPrefix: [hostEntry] }`；若入口已是 `rpc-entry.js`，spawn 时不再传 `--mode rpc`。
3. `@earendil-works/pi-coding-agent/rpc-entry`：`createRequire(import.meta.url).resolve(...)` → `{ cmd: process.execPath, argsPrefix: [entry] }`（不传 `--mode`）。
4. `~/.pi/agent/bin/pi`：`{ cmd: bin, argsPrefix: [] }`（传 `--mode rpc`）。
5. PATH 的 `pi`：同上。

版本门槛 **1.5.0**：`probePi` 的版本低于门槛时 `capabilities.enabled=false`，reason 提示升级。

### 2.5 SSE 映射

`send` 顺序：

1. 校验 `source/session/threadId/prompt/contextIds/skill/profile`；带 contextIds 时先 stat 轨迹文件（>32MB → 400）。
2. **先占项目锁**：按 canonical `projectPath` 检查并写入 `projectTurns`；同项目已有 turn → 409。检查与占位之间不能有 `await`，否则并发请求会同时通过。
3. `ensureChild`（容量 gate；设置变化且 idle 时按需重启）；若 `currentTurn` 非空 → 409；占 child 锁。
4. 解析 context：`getProjection` → `findEvent` 逐条；写 `context.next.json`；rename `context.active.json`；算 `added/removed`。
5. 解析 skill：`get_commands` 找名字；读 `SKILL.md` 做大小守卫；拼 `/skill:<name>` 前缀。
6. 确保线程：`threadId` 为空则 `new_session`；否则若与 child 当前 session 不同则 `switch_session`。
7. 组装 user 文本：skill 前缀（最前，保证 pi 原生展开） + 可选 `<trajectory_index>`/`<trajectory_index_delta>` + prompt。
8. 写 `meta` 事件（含 `threadId/userOrdinal/model/profile/context/skill`）。
9. 写 SSE 头；启动 keepalive（15s）。
10. `prompt` 命令；订阅事件直到 `agent_end`/`error`/`res.close`。
11. `finally`：清 keepalive、清审批、释放 child/项目锁、`currentTurn=null`。

进程池与设置一致性（T8）：

- 全局上限 2；`ensureChild` 的容量检查与 spawn 走同一条 `poolChain`，避免并发超限；满时淘汰最久未用的 idle child（无 `currentTurn`、非当前 key），没有可淘汰的 → 409。
- 空闲 TTL 15 分钟，60 秒扫一次；`lastUsedAt` 在 ensure/send/models/skills/settings/thread/stop/approval/readChildState 更新；`close` 清 timer、children、projectTurns、starting。
- `record.settingsKey = profile:projectSkills`；ensureChild 命中时设置变了且无 turn → `restartChildKeepThread`；settings POST 立即重启同项目 idle child，busy/starting 标 `settingsStale`，turn 结束后下一次 ensure 重启；目标自身 busy 仍 409。
- `projectPath` / allow-set / settings / projectTurns 统一使用 canonical 项目路径；实际 spawn 目录单独放 `record.cwd`。

事件映射：

| RPC 事件 | SSE |
|---|---|
| `message_update` + `assistantMessageEvent.type === "text_delta"` | `delta {text}` |
| `message_update` + `thinking_delta`（首次） | `status {phase:"thinking"}` |
| `tool_execution_start` | `tool {phase:"start", toolCallId, toolName, argsPreview}` |
| `tool_execution_end` | `tool {phase:"end", toolCallId, toolName, isError, resultPreview}` |
| `extension_ui_request` + `method === "confirm"` | `approval {id, toolName?, title, message, timeout}` |
| `extension_ui_request` + 其它 method | 忽略（`notify` 可转 `notice`） |
| `agent_end` | `done {stopReason, usage, durationMs}` |
| child exit / RPC error | `error {message, code}` |

- `res.on("close")`：若未结束 → `abort`；所有 pending 审批回写 `confirmed:false`（拒绝），无活动 turn 的请求回 `cancelled`；清理。
- 写入 `meta` 之后再失败，只能发 `error` 事件，不能再回 JSON。
- `meta` 之前失败（400/409/501/502）走 JSON。

### 2.6 审批桥

1. 子进程扩展 `chat-approval.ts` 在 `tool_call` 里调用 `ctx.ui.confirm(...)`（timeout 120_000 ms）。
2. RPC 模式把请求变成 `{type:"extension_ui_request", id, method:"confirm", title, message, timeout}`；`timeout` 为毫秒。
3. host：
   - 从 `title` 正则 `允许 <tool>？`/`允许 <tool>?` 解析 `toolName`；解析不到时仍可「仅本次允许」，但不写 allow-set。
   - 若当前项目 allow-set（键 `source:projectPath`，值 `Set<toolName>`，仅内存）含该工具 → 直接回 `confirmed:true`，不发前端；
   - 否则发 SSE `approval`（`timeout` 为秒：RPC 毫秒向上取整），把 `{id, toolName, timer}` 放进 `currentTurn.approvals`；
   - 120 秒未响应（或扩展自身的 120s 超时）→ 回 `confirmed:false`（拒绝）并发 `notice`；扩展与 host 双计时都只会拒绝，不会误执行。
4. `POST /api/chat/approval`：
   - 找到 pending 的 `id` → 回写 `{type:"extension_ui_response", id, confirmed}`；
   - `allowForSession:true` **仅在 `confirmed:true` 且解析到 `toolName`** 时，把工具名加入当前项目 allow-set（内存，不落盘）；
   - 未知 id / 无活动 turn / `threadId` 不匹配 → `{ok:false}`，200。
5. 清理：浏览器断开、stop、close、child exit 时，所有 pending 回 `confirmed:false`（拒绝）并清定时器；无活动 turn 的 `extension_ui_request` 直接回 `cancelled`；`chat-approval.ts` 的 confirm 返回 false → `{block:true}`。

### 2.7 `app.mjs` 接线

- options 增加：

```js
/**
 * @param {{
 *   chatDir?: string,
 *   piBin?: { cmd: string, argsPrefix: string[] },
 *   noChat?: boolean,
 *   ...existing
 * }} options
 */
```

- 启动：

```js
const chat = options.noChat ? null : createChatHost({
  chatDir: resolve(options.chatDir ?? join(resolveAgentDir(), "pi-chat-helper", "chats")),
  piBin: options.piBin ?? resolvePi({ hostEntry: process.argv[1], hostExecPath: process.execPath }),
  settingsPath: join(chatDir, "settings.json"),
  readSessions, resolveSession, getProjection, findEvent,
  availableSources, sessionRoots: [sessionsRoot, codexRoot],
  log,
});
```

- 路由：`/api/chat/` 前缀（以及所有 POST）先做 Host/Origin 校验，chat POST 再加 Content-Type；通过后才读 body、`chat.handle(...)`；未启用时 capabilities 返回 disabled，其余 501。
- POST 白名单加入 `CHAT_POSTS`。
- 静态资源加 `/chat.js`、`/chat-lib.js`。
- `close`：

```js
close: async () => {
  await chat?.close();          // 先杀 child，再关 HTTP
  server.closeAllConnections?.();
  await new Promise(done => server.close(done));
}
```

### 2.8 `main.mjs` / `index.ts`

`main.mjs`：

```text
--chat-dir <dir>   对话目录，默认 <agentDir>/pi-chat-helper/chats
--no-chat          禁用对话（不创建 chat host）
--pi-bin <path>    指定 pi 可执行文件
```

- 不能顶层 import pi SDK；`resolvePi` 是纯 node 实现，可直接用。
- SIGINT/SIGTERM 走现有 `handle.close()`，顺序由 `app.mjs` 保证。

`trajectory-web/index.ts`：

- `startInProcess` 的 `base` 增加 `chatDir`、`piBin`。
- `agentDir` 解析：`process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")`。
- `piBin`：优先宿主入口（`process.argv[1]` + `process.execPath`），失败回退 `resolvePi()`。
- `closeSlot` 不变，`handle.close()` 现在会先等 chat host。

### 2.9 存储与纯函数

`chat-session.mjs` 导出（供服务端与测试）：

```text
sanitizeSegment(name)
chatDirFor(chatDir, source, sessionId)
sessionsDirFor(...) / metaDirFor(...)
threadPath(...) / latestThreadFile(...)     // mtime + 文件名兜底
readTurns(metaDir, threadId) / upsertTurn(metaDir, rec)
appendTurn(metaDir, rec)                    // 仅兼容，不参与新写入
readContext(metaDir) / writeContextNext(metaDir, snap) / promoteContext(metaDir)
parseThreadProjection(full, turns)          // pi 投影 -> 对话 messages
buildTrajectoryIndex(items)                 // <trajectory_index>
selectionDelta(prev, next)                 // added/removed
isPathInside(parent, child)
```

`context-render.mjs` 导出：

```text
renderContextEvent(ev, limits)
estimateChars(text)
perKindLimits
```

- 服务端用它做 `read_trajectory` 的同一套渲染（扩展也 import 它）。
- 不再有 `buildHistory`、`wrapSkill`、`parseThreadJsonl`。

## 3. 子进程扩展

### 3.1 `chat-trajectory-tool.ts`

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox"; // 或 pi 暴露的 schema 工具
import { renderContextEvent, perKindLimits } from "./server/context-render.mjs";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_trajectory",
    label: "读取轨迹",
    description: "读取当前选中的轨迹条目。先 list 看清单，再 read 取正文。只读。",
    promptSnippet: "read_trajectory: 读取用户当前选中的轨迹条目",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("read")]),
      ids: Type.Optional(Type.Array(Type.String())),
      query: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(toolCallId, params) {
      // 1. 读 PI_CHAT_CONTEXT_FILE（context.active.json）
      // 2. list: 返回 id/kind/label/preview/chars
      // 3. read: 白名单校验 -> 读 PI_CHAT_TRAJECTORY_FILE -> buildProjection -> findEvent -> renderContextEvent
      // 4. 截断与分页
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
```

环境变量（spawn 时设置）：

```text
PI_CHAT_CONTEXT_FILE=<meta>/context.active.json
PI_CHAT_TRAJECTORY_FILE=<轨迹 session 文件绝对路径>
PI_CHAT_SOURCE=pi
PI_CHAT_SESSION_ID=ext-1
```

约束：

- 只读；不写任何文件。
- 只允许读 `context.active.json` 里的 id；不在清单里 → 逐条提示。
- `PI_CHAT_TRAJECTORY_FILE` 必须与 `context.active.json` 的 `source/sessionId` 一致；不一致直接报错。
- 单条 6k / 单次 12k 字符；`offset` 继续。
- 渲染复用 `context-render.mjs`，保证与轨迹详情一致。

### 3.2 `chat-approval.ts`

```ts
const AUTO = new Set(["read_trajectory", "read", "grep", "ls", "find"]);

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (AUTO.has(event.toolName)) return;
    const detail = describeToolCall(event); // bash: command; write/edit: path
    const ok = await ctx.ui.confirm(
      `允许 ${event.toolName}？`,
      detail,
      { timeout: 120_000 },
    );
    if (!ok) return { block: true, reason: "用户拒绝了本次工具调用" };
  });
}
```

- 只在 `full` profile 加载；`read-only`/`no-tools` 不加载。
- `ctx.ui.confirm` 的 `timeout` 与 RPC `extension_ui_request.timeout` 单位是**毫秒**（`120_000` = 120s）；host 转成 SSE `approval.timeout` 的秒。
- `ctx.ui.confirm` 在 RPC 模式转成 `extension_ui_request`；host 负责转发与「本会话允许」。
- 超时/取消/断连一律视为拒绝。
- `describeToolCall` 只取命令/path 的可读摘要，不把整个文件内容塞进弹层。

### 3.3 spawn 参数矩阵

所有 profile 共用：

```text
--mode rpc
--session-dir <chatDir>/<source>/<safeSessionId>/sessions
--session-id <threadId>            # 新会话；已有线程用 --session <file>
--no-extensions                    # 只允许显式 -e
--no-context-files                 # 不加载 AGENTS.md/CLAUDE.md
--system-prompt <SYSTEM_PROMPT>
-na                                # 不信任项目本地资源
-e <chat-trajectory-tool.ts>
[--provider <p> --model <id>]
[--thinking <level>]
[--skill <project skill dir> ...]  # projectSkills=true 时
```

profile 差异：

| profile | 工具参数 | 额外扩展 | 行为 |
|---|---|---|---|
| `no-tools` | `--no-builtin-tools` | 无 | 只有 `read_trajectory` |
| `read-only` | `--tools read,grep,ls,read_trajectory` | 无 | 只读工具 + `read_trajectory`（默认） |
| `full` | `--tools read,write,edit,bash,read_trajectory` | `-e chat-approval.ts` | 全量工具，写/命令逐次审批 |

注意：

- 用 `--no-builtin-tools` 而不是 `--no-tools`：后者会把扩展注册的 `read_trajectory` 也关掉。
- `--tools` 是**白名单**，pi 1.5 实测会过滤未列出的扩展工具；read-only/full 必须显式把 `read_trajectory` 写进 `--tools`，否则真子进程里工具不可见。
- `-na` 与 `--skill` 可以共存：显式 CLI 技能路径以 `temporary` scope 加载，不受项目信任影响。
- 项目技能目录候选：`<projectPath>/.pi/skills`、`<projectPath>/.agents/skills`（存在才传）。

## 4. 前端

### 4.1 `index.html`

在 `#chat-drawer` 内新增/调整（保持现有 ID 不变）：

```html
<aside id="chat-drawer" class="chat-drawer" hidden>
  <div id="chat-resize" ...></div>

  <div id="chat-list" class="chat-list" role="log" aria-live="polite" aria-label="对话消息"></div>

  <div class="chat-composer">
    <div id="composer-resize" ...></div>
    <div id="chat-context" class="chat-context" hidden></div>
    <div id="chat-palette" class="chat-palette" hidden></div>
    <div id="chat-profile-menu" class="chat-profile-menu" role="menu" hidden></div>
    <div class="chat-card">
      <div id="chat-skill" class="chat-skill" hidden></div>
      <textarea id="chat-input" ...></textarea>
      <div class="chat-row">
        <span id="chat-model-label" class="chat-model-label"></span>
        <button id="chat-profile" class="chat-profile" type="button" title="工具权限"></button>
        <button id="chat-send" ...></button>
      </div>
    </div>
  </div>

  <div id="chat-approval" class="chat-approval" hidden role="dialog" aria-modal="true">
    <!-- 标题 / 命令 / 允许本次 / 本会话允许 / 拒绝 -->
  </div>
</aside>
```

- `#chat-send` 保留现有 SVG；流式中由 JS 替换图标/aria，不新增 `#chat-stop`。
- `#chat-palette` 放在 `.chat-card` 之前、`.chat-composer` 内，绝对定位在输入卡上方。
- `#chat-approval` 覆盖抽屉内容，不阻塞主轨迹区。
- `#chat-context` 内部由 JS 渲染 chips、`清空`、`以此新开` 三个部分；不在静态 HTML 里写死按钮。

### 4.2 `web/chat-lib.js`

纯函数，零 DOM，供 `chat.js` 与测试共用：

| 函数 | 作用 |
|---|---|
| `chatCtxKey(source, sessionId)` | `"pi:ext-1"` |
| `parseSseChunk(buffer)` | 返回 `{events:[{event,data}], rest}`；处理 `\r\n`、多行 `data:`、注释 `: ping` |
| `parseSseData(ev)` | `JSON.parse`，失败返回 `null` |
| `filterPaletteItems(items, query)` | 多词 AND、大小写不敏感、匹配 `label/hint/group` |
| `formatContextWindow(n)` | `1M`/`200K`/`128K`/`32000` |
| `modelLabel(model)` | `name` 优先，缺失用 `id`；过长截断 |
| `normalizeContextIds(map, source, sessionId)` | 去重、不限制条数 |
| `mergeContextIds(map, key, ids)` | 写回并返回新 map；不改原对象 |
| `pruneContextIds(ids, eventsById)` | 过滤投影里不存在的事件 id |
| `eventRef(ev)` | `{id,kind,label,preview,chars}` |
| `estimateChars(text)` | 字符数；用于 chips |
| `formatToolArgs(name, argsPreview)` | 工具卡片标题 |
| `approvalSummary(toolName, message)` | 弹层正文截断 |

SSE 解析器必须处理跨 chunk 的半行：`rest` 保留到下一次调用；`data:` 多行按 `\n` 拼接；空行触发事件。

### 4.3 `web/chat.js`

导出：

```js
export function initChatPanel(deps) { ... }
```

`deps`：

```js
{
  el, h, mdNode,
  getSession: () => ({source, id, name, projectPath}) | null,
  getSelectedIds: () => string[],
  setSelectedIds: (ids, {silent} = {}) => void,
  getEventRefs: (ids) => [{id,kind,label,preview}],
  openEvent: (id) => void,
  autoGrowInput: () => void,
  onSelectModeChange: () => void,
  setStatus: (text, kind) => void,
}
```

返回：

```js
{
  setOpen(open),
  handleEscape(),
  onSessionChanged(),
  onSelectionChanged(),
  onTrajectoryChanged(),
  refreshThread(),
  isOpen(),
  isStreaming(),
}
```

内部状态：

```js
{
  open: false,
  enabled: null,
  thread: null,
  threadId: null,
  threadMap: {},
  models: [], skills: [],
  skillsCacheKey: null,
  model: null, skill: null,
  profile: "read-only",
  projectSkills: false,
  palette: null,
  streaming: false,
  abort: null,
  pendingText: "",
  renderQueued: false,
  loadedKey: null,
  approvals: [],            // 当前待审批请求
  allow: new Set(),         // 仅展示用；真正 allow-set 在服务端
}
```

关键函数：

- `loadCapabilities()`：`GET /api/chat/capabilities`；禁用时渲染禁用态。
- `loadSettings()`：`GET /api/chat/settings`；读 profile/projectSkills。
- `loadSkills()`：`GET /api/chat/skills`；`skillsCacheKey !== loadedKey` 或空列表时带 `refresh=1`。
- `loadThread()`：从 `threadMap[loadedKey]` 取线程 id；有则显式 `thread`，没有则省略；`exists:false` 时清记忆并重试最新。
- `newThread({ preserveSelection = false } = {})`：`POST /api/chat/thread`；更新 `threadId/threadMap/localStorage`；清空消息、技能；`preserveSelection=false` 时清空上下文选择（`setSelectedIds([], {silent:false})`），`true` 时保留（用于 chips 栏的「以此新开」）；模型/profile 保留。
- `send()`：
  - 校验 session/输入/enabled/streaming；
  - 捕获 `key` 与 `controller`；所有 SSE 回调校验 `state.loadedKey === key && state.abort === controller`；
  - 乐观渲染 user 气泡；
  - `fetch("/api/chat/send", {method:"POST", body, signal})`；
  - **先判 `response.ok` 与 `content-type`**；非 SSE 时读 JSON 错误并显示；
  - `response.body.getReader()` + `TextDecoder("utf-8")`，必须 `{stream:true}`；
  - `meta`：创建 assistant 占位；更新 `threadId/threadMap`；同步 `context.dropped` 到选中集；
  - `status`：显示「思考中…」/「正在调用工具…」；
  - `delta`：累加 `pendingText`，rAF + 80ms 批量 `mdNode`；
  - `tool`：增/更新工具卡片；
  - `approval`：显示弹层；响应 `POST /api/chat/approval`；
  - `done`：最终渲染、meta 行、按钮恢复；**整表替换**消息列表（去重），不要 append；
  - `error`：错误气泡、恢复按钮。
- `stop()`：用当前线程的 `source/session/threadId` 发 `POST /api/chat/stop`，再 `abort?.abort()`。
- `changeProfile(profile)` / `toggleProjectSkills()`：`POST /api/chat/settings`；成功后提示「对话进程已重启」并 `refreshThread()`。
- `renderMessages()` / `renderMessage(m)` / `renderToolCard(m)` / `renderApproval()`。

渲染节流：`requestAnimationFrame` + 80ms 最小间隔；`done` 强制最终渲染。

### 4.4 `app.js` 修改点

1. **import**：`import { initChatPanel } from "./chat.js";`；文件头注释改为「对话栏接 pi 子进程」。
2. **删除**：`state.chat`、`chatMsgNode`、`renderChat`、`syncChatSend`、`sendChat`、`chat-input`/`chat-send` 的事件监听。
   - 保留 `CHAT_INPUT_MAX_H` 与 `autoGrowChatInput`，通过 `deps.autoGrowInput()` 复用。
3. **保留**：`setChatOpen`、`loadChatWidth`、`bindChatResize`、`loadComposerHeight`、`bindComposerResize`。
4. **新增**：
   ```js
   const CHAT_CTX_KEY = "tw.chatCtx";
   function selectMode() { return state.chatOpen || state.distillMode; }
   function loadChatCtxMap() { ... }
   function saveChatContext() { ... }
   function restoreChatContext() { ... }
   function currentChatKey() { return `${state.source}:${state.selectedId ?? ""}`; }
   ```
5. **`renderEvent`**：`if (!state.cropMode) classes.push("no-crop");` 不变；`if (!selectMode()) classes.push("no-select");`；`if (selectMode())` 渲染 `.ev-check`。
6. **`renderMain`**：`if (selectMode())` 渲染 `.q-check`；`indeterminate` 逻辑不变。
7. **勾选事件**：行级 checkbox、`toggleRoundSelected` 末尾调用 `chat.onSelectionChanged()` 和 `saveChatContext()`。
8. **`selectSession` / `switchSource`**：开头 `saveChatContext()`；重置 `state.selectedEvs`；在 source/id 更新后 `restoreChatContext()`；末尾 `chat.onSessionChanged()`。
9. **轮询**：
   - `pollSessions` 首次把 `selectedId` 从 null 设为默认会话后，调用 `chat.onSessionChanged()`；
   - `pollSession` 数据更新后 `chat.onTrajectoryChanged()`；
   - 首次数据到达后 `restoreChatContext()` + 剪掉投影里不存在的 id；
   - 会话 404：`selectedId=null`、清空 `selectedEvs`、`chat.onSessionChanged()`。
10. **Esc 链**：`if (chat.handleEscape()) return;` 放在最前；其余不变。
11. **`setChatOpen`**：更新 `state.chatOpen`/`hidden`/`aria-pressed`/`tw.chat`；打开先 `restoreChatContext()`，关闭先 `saveChatContext()`；再 `chat.setOpen(open)`；由 `onSelectModeChange` 统一触发一次 `renderMain()`。
12. **启动**：
    ```js
    const chat = initChatPanel({ ...deps });
    loadChatWidth(); bindChatResize(); loadComposerHeight(); bindComposerResize();
    if (localStorage.getItem(LS_CHAT) === "1") setChatOpen(true);
    ```
    删除 `renderChat()`。
13. **依赖**：`openEvent` 用现有 `openPanel`；`setStatus` 用现有 `setSync`。

### 4.5 `style.css`

- 输入卡状态：`.chat-model-label`（当前模型 chip，带 1px 中性边框）、`.chat-profile`（权限 chip，开态用警示色）。
- 上下文 chips：`.chat-context`、`.chat-ctx-chip`、`.chat-ctx-label`、`.chat-ctx-preview`、`.chat-ctx-remove`、`.chat-ctx-clear`、`.chat-ctx-new`（以此新开）。
- 斜杠面板：`.chat-palette`、`.chat-palette-group`、`.chat-palette-item`（`[aria-selected="true"]` 用 hover 底色 + 左侧勾）。
- 技能 chip：`.chat-skill`。
- 工具卡片：`.chat-tool`、`.chat-tool-head`、`.chat-tool-body`（复用 `.ev` 的 token；工具名/参数/结果/错误色）。
- 审批弹层：`.chat-approval`（绝对定位覆盖抽屉，半透明遮罩）、`.chat-approval-card`、`.chat-approval-actions`；允许/本会话允许/拒绝三态。
- 消息：`.chat-msg.user`、`.chat-msg.ai`、`.chat-msg-meta`、`.chat-stream-cursor`、`.chat-notice`、`.chat-msg-error`。
- 勾选列：`.ev.no-select` / `.ev.no-crop.no-select` 替换 `.no-distill`；测试守卫同步。
- 响应式：`@media (max-width: 900px)` 下模型/ profile chip 收窄，面板次文本隐藏。
- 暗色：全部走 token；审批弹层用 `--dsw-alias-bg-layer-1` + 遮罩 `rgba(0,0,0,.32)`。

## 5. 测试

### 5.1 `tests/test-chat.cjs`

纯 Node，导入 `chat-session.mjs` / `context-render.mjs`：

- `sanitizeSegment`：`../etc/passwd` 不逃逸；合法值原样；替换后追加 8 位 hash 且稳定。
- 路径：`sessionsDirFor` / `metaDirFor` / `threadPath` 都在 chatDir 内；`isPathInside` 前缀相似不误判。
- `buildTrajectoryIndex`：条目格式、preview 80 字截断、空选中。
- `selectionDelta`：added/removed/无变化。
- `renderContextEvent`：user/answer/text/thinking/tool/bash/system/compaction/custom/approval 的标签与内容；单条截断。
- `parseThreadProjection`：user/assistant/tool/notice 映射；`displayText` 优先 sidecar，缺失时剥离标签；thinking 默认不进消息。
- `readTurns/upsertTurn`：坏行忽略；`readTurns(metaDir, threadId)` 按线程过滤；`upsertTurn` 以 `(threadId, ordinal)` 为键覆盖；`appendTurn` 仅兼容旧调用。
- `readContext/writeContextNext/promoteContext`：原子提升、损坏 JSON 回退空。
- `latestThreadFile`：mtime 相同时按文件名兜底。
- `settings`：默认值、非法 profile 拒绝、按项目分键。

### 5.2 `tests/test-server.cjs`

新增 `describe` 段（不替换现有 spawn 测试）：

- fake child：一个 node 脚本，读 stdin JSON lines，按命令回 `response`，并按时序发 `message_update/tool_execution_*/extension_ui_request/agent_end`。
- `createTrajectoryServer({ ..., chatDir, piBin: { cmd: process.execPath, argsPrefix: [fakeChild] } })`。
- 断言：
  1. `capabilities` → `enabled:true`, `backend:"pi-rpc"`, `chatDir`。
  2. 未启用 / `--no-chat` → `enabled:false`，其它 chat 路由 501。
  3. `models` → 脱敏后的列表；无 `apiKey/baseUrl/headers`。
  4. `skills` → demo-skill；`chars` 正确；`refresh=1` 触发重启。
  5. `thread` 初始 `exists:false`；`POST thread` 后存在；`GET thread` 不带 thread 取最新。
  6. `send` → 200 + `text/event-stream`；包含 `meta/delta/tool/done`；`thinking_delta` 只触发一次 `status`。
  7. `approval` 事件 → `POST /api/chat/approval` → fake child 收到 `extension_ui_response`；`allowForSession` 后第二次不再弹。
  8. 无效 context id → `meta.context.dropped`；仍 200。
  9. 同 child 第二次 send → 409；同项目另一个 child → 409；stop 后恢复。
  10. `settings` 切 profile → `restart:true`，fake child 被杀并重启。
  11. 安全：错误 Origin / evil Host / Origin null / Origin 端口不符 → 403；chat POST 非 JSON 或缺 Content-Type → 403；OPTIONS → 405；无 `Access-Control-Allow-*`；拒绝时 fake child trace 无 `--mode rpc` spawn。
  12. 大小：请求体 >1MB → 413；线程文件 >32MB → GET thread/models 与 send/model 在 spawn 前 400；轨迹文件 >32MB 且带 contextIds → spawn 前 400；错误 JSON ≤500。
  13. `chatDir` 位于 `sessionsRoot` 下 → `enabled:false`；非回环监听且 chat 启用 → `enabled:false` + reason。
  14. `server.close()` 后无 child 残留。
  15. 静态 `/chat.js`、`/chat-lib.js` 200。
  16. 虚拟线程（thread 文件未落盘）：GET models 200 + `threadMissing`；POST model 当前虚拟线程 200、不 404/不 switch。
  17. 线程列表：字段/首条用户/轮数/模型；`/api/chat/resume` 切回旧线程 200、活动 turn 409、未知线程 404。

### 5.3 `tests/test-web-lib.cjs`

- `chat-lib.js`：`parseSseChunk`（单/多事件、跨 chunk、`\r\n`、多行 `data:`、注释、坏 JSON）、`filterPaletteItems`、`formatContextWindow`、`chatCtxKey/normalize/merge`、`pruneContextIds`、`eventRef`。
- 源码守卫：
  - checkbox 在 `selectMode()` 时渲染；`no-select` 存在，`no-distill` 不再被新代码使用；
  - `index.html` 含 `chat-model-label`、`chat-profile`、`chat-context`、`chat-palette`、`chat-skill`、`chat-approval`；
  - `app.js` 含 `initChatPanel`、`selectMode()`、`CHAT_CTX_KEY`，不再含 `state.chat.push` / `function sendChat`；
  - `chat.js` 含 `/api/chat/send`、`/api/chat/approval`、`parseSseChunk`、`TextDecoder`、`stream:true`；
  - `style.css` 含 `.chat-model-label`、`.chat-tool`、`.chat-approval`、`.chat-msg.ai.is-streaming`。

### 5.4 `tests/test-extension.cjs`

- fake `ctx` 增加 `cwd`、`model`、`scopedModels`（如仍被 viewer 使用）。
- 启动 `/deepseek-trail start` 后：
  - `capabilities` → `enabled:true`，`piVersion` 有值；
  - `models` → 真 pi 的模型列表（或 fake child）；
  - `skills` → 至少包含 demo 技能；
  - `send` → SSE；chat 文件落在临时 HOME 下，不在 `sessions`；
  - 关闭后无 child 残留。
- 两个子进程扩展：
  - `chat-trajectory-tool.ts` 能被 jiti 加载；`read_trajectory` 注册；
  - `chat-approval.ts` 的 `tool_call` 返回 `{block:true}` 时工具不执行。

### 5.5 手工/冒烟

- `node tests/test-chat.cjs`、`test-server.cjs`、`test-web-lib.cjs`。
- `PI_HOME=~/.pi/agent/install/releases/1.5.0 node tests/test-extension.cjs`。
- `tsc -p tsconfig.json`（沿用 README 的 tsc 路径）。
- `pi -ne -e .` 退出码 0。
- `npm run dev`：
  - `curl /api/chat/capabilities` → enabled；
  - `curl /api/chat/models` → 真实列表；
  - 首页 200 且含 `chat-profile`/`chat-approval`；
  - 无进程残留（`pgrep -f "mode rpc"`）。
- 真浏览器：三档 profile、审批、工具卡片、切项目/线程、重启恢复。CDP 不可用时注明「未做浏览器实测」。
- T10 现状：全套测试通过；浏览器仍未实测（CDP 不可用）；chips/勾选/50 上限/审批/权限菜单主要靠纯函数 + 源码守卫；`tw.chatThread` + `tw.chatThreadNew` 已实现；工具与 host 均已加 32MB 守卫；codex send 上下文未 e2e，留后续。

## 6. 提交拆分

1. `docs: 对话页方案改为 pi 子进程架构（v2）`
2. `feat: chat host 骨架与 pi 子进程 RPC 协议`
3. `feat: 对话线程按 pi session 存储与读取`
4. `feat: 对话 SSE 流式与前端消息列表`
5. `feat: 模型列表与斜杠切换（走 pi RPC）`
6. `feat: 技能列表、原生展开与项目技能开关`
7. `feat: 轨迹上下文清单与 read_trajectory 工具`
8. `feat: 三档工具 profile 与审批桥`
9. `feat: 进程池、空闲回收与双模式启动接线`
10. `fix: chat 接口的 Origin/Host/路径/大小校验`
11. `test: chat host/线程/上下文/审批的自动化与冒烟`
12. `docs: README 与 ROADMAP 更新`

## 7. 回滚

- 功能是加法：`--no-chat` 或找不到 pi 时对话禁用；现有轨迹 API/前端不受影响。
- 前端回滚：删除 `chat.js`/`chat-lib.js` 的 import 与 `index.html` 新元素，恢复 `app.js` 的本地消息流；`style.css` 新规则可保留。
- 服务端回滚：移除 `/api/chat/*` 路由与 POST 白名单项；`chat-host.mjs` 可保留但不再引用。
- 数据回滚：chatDir 独立，删掉不影响轨迹（删除操作按项目红线需先确认）。
- 无数据库/schema 变更；无现有会话文件改写。

## 8. 验收清单

- [x] R1：`/model` 列表与 pi 一致；切换后刷新/重启保持；响应无密钥。（fake child + 真 pi models；浏览器 chip 未实测）
- [x] R2：`/skill` 列表与 pi 一致；发送前缀/项目技能开关/大小守卫生效；超大技能拦截。（原生 `<skill>` 展开由 pi 保证，壳侧验证前缀）
- [x] R3：对话文件只落 chatDir；`/api/sessions`/轨迹列表看不到；chatDir 在 sessions 下时禁用。（未直接跑 pi `/resume`；路径隔离已验证）
- [x] R4：勾选 → 清单 → 模型调用 `read_trajectory` → 回答引用；增删下一轮生效；反选不抹历史（文档已声明）。（T6 真 pi 冒烟）
- [x] R5：真子进程可调工具、可恢复会话；工具调用以 SSE tool 事件可见。（抽屉浏览器渲染未实测）
- [x] R6：三档 profile 可切；默认只读；全量档 bash/write/edit 逐次审批；拒绝不执行。（T7 真 pi bash deny/allow）
- [x] R7：默认只加载全局技能；项目技能打开后才出现。（fake child spawn 参数 + 列表）
- [x] R8：每轨迹会话 1 child；全局 2；空闲 15 分钟回收；同项目并发 409；关闭无残留。（T8 fake child + 真 pi 3 会话冒烟）
- [x] R9：`/deepseek-trail start` / `npm run dev` 启动不变；首条消息懒启动；A/B 都可用。（test-extension 模式 A + 模式 B dev 冒烟）
- [x] R10：Host/Origin/JSON content-type/路径/大小校验全过；禁用态不报错。（T9 安全用例）
- [ ] 浏览器实测：三档 profile、审批弹层、工具卡片、切项目/线程、重启恢复。CDP 不可用，未做。
- [ ] Codex send 上下文 e2e：工具层 list/read 已测，send 未做，留后续。
- [x] 全套测试：test-chat 168、test-server 192、test-web-lib 198、test-extension 88、test-codex 38、test-projection 33、test-sessions 10、test-turn 21、test-tool-origins 10（带 PI_HOME 时 11）、test-render 28、test-question-panel 8、test-headless-tui 11；合计 805 个断言（按 `^PASS` 计数，不含各文件末尾 `ALL PASS` 汇总；带 PI_HOME 时 806）；`tsc` 0；`pi -ne -e .` 0；模式 B dev 冒烟正常 send/done，无 rpc 残留；ROADMAP 只写已验证内容。
