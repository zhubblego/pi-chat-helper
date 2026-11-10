# SQLite 状态持久化：设计与边界（v1）

> 状态：边界已确认，方案已落盘；S1–S5 未实施。
> 日期：2026-11-10。
> 关联：[implementation.md](./implementation.md)（分阶段实施清单）。
> 上游背景：trajectory-web 的过滤、布局、对话指针等状态目前分散在浏览器 localStorage 与 JSON/JSONL 文件。

## 1. 目标

把 **pi-chat-helper 自有的持久化状态**统一收进一个 SQLite 数据库，做到：

- 同一 `agentDir` 只有一份状态；
- 不随页面 Origin / 端口变化；
- 不随切会话、切源变化；
- 浏览器 localStorage 只做一次性迁移来源，不再长期作为真源；
- pi 自己的 session / 配置格式不被破坏。

## 2. 边界

| 类别 | 内容 | 处理 |
|---|---|---|
| 插件自有、用户持久状态 | 过滤、工具排除、主题、翻译、布局、对话指针、chat 项目设置、turns、context | 进 SQLite |
| pi 外部契约 | `<chatDir>/<source>/<safeSessionId>/sessions/*.jsonl`（pi session） | 保持 JSONL，禁止迁移 |
| pi 外部配置 | `agentDir/settings.json`、`models.json`、`auth.json`、skills | 只读，不迁移 |
| 外部轨迹源 | Codex session 文件 | 只读，不迁移 |
| 运行期临时状态 | console bridge 注册文件、审批 allow-set、进程池、模型/技能/tool-origins 缓存 | 不进用户状态库；注册文件继续文件系统，其余内存 |
| 文档/构建产物 | ROADMAP.md、测试 fixture | 不参与 |

**pi session 不能搬**：迁移后 `/resume`、RPC、pi 自身都读不到。插件只改变自己 sidecar 的存储。

## 3. 当前持久化清单

### 3.1 浏览器 localStorage

| 键 | 内容 | 作用域 | 新表 |
|---|---|---|---|
| `tw.filters` | 事件类型过滤、预设 | 全局用户习惯 | `ui_pref` |
| `tw.tools` | 工具子菜单排除集、`excludeAll` | 全局用户习惯 | `ui_pref` |
| `tw.theme` | 主题偏好 | 全局 | `ui_pref`（首帧另处理） |
| `tw.translate` | 翻译服务 / 语言 / 显示方式 | 全局 | `ui_pref` |
| `tw.chat` | 侧边对话打开状态 | 全局 | `ui_pref` |
| `tw.chatWidth` | 对话栏宽度 | 全局 | `ui_pref` |
| `tw.composerHeight` | 输入区高度 | 全局 | `ui_pref` |
| `tw.chatCtx` | 每个 `source:session` 选中的轨迹事件 | 按会话 | `session_ui` |
| `tw.chatThread` | 每个 `source:session` 当前 pi 线程 | 按会话 | `session_ui` |
| `tw.chatThreadNew` | 未落盘虚拟线程标记 | 按会话 | `session_ui` |
| `tw.chatMode` | 独立 / 转发模式 | 按会话 | `session_ui` |

历史已移除的 `tw.drawerWidth`、`tw.sidetool` 不在迁移范围。

### 3.2 服务端 sidecar

| 路径 | 内容 | 新表 |
|---|---|---|
| `<chatDir>/settings.json` | 按项目的 `profile` / `projectSkills` | `chat_project` |
| `<chatDir>/<source>/<safeSessionId>/meta/turns.jsonl` | 每轮 `displayText`、`contextRefs`、skill、profile、model | `chat_turn` |
| `<chatDir>/<source>/<safeSessionId>/meta/context.active.json` | 当前对话上下文快照 | `chat_context` |
| `<chatDir>/<source>/<safeSessionId>/meta/context.next.json` | 下一轮待提升上下文 | `chat_context` |

## 4. 数据库

```text
<agentDir>/pi-chat-helper/state.db
```

- 目录 `0700`，文件 `0600`；
- `PRAGMA journal_mode=WAL`；
- `PRAGMA busy_timeout=5000`；
- `PRAGMA foreign_keys=ON`；
- 所有写入走事务；迁移和 schema 变更用 `schema_meta` 版本标记；
- 模式 A / 模式 B 共用同一个 agentDir 时共用同一个库；不同 agentDir 不共享，这是明确边界。

### 4.1 Schema

```sql
schema_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)

ui_pref(
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

session_ui(
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id TEXT,
  thread_new INTEGER NOT NULL DEFAULT 0,
  chat_mode TEXT NOT NULL DEFAULT 'independent',
  context_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, session_id)
)

chat_project(
  source TEXT NOT NULL,
  project_path TEXT NOT NULL,
  profile TEXT NOT NULL,
  project_skills INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, project_path)
)

chat_turn(
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, session_id, thread_id, ordinal)
)

chat_context(
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- active / next
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, session_id, kind)
)
```

说明：

- `ui_pref.value_json` 保存规范化后的值，不把整张 localStorage map 原样塞入。
- `session_ui.thread_new` 是 0/1；`context_ids` 只保存 id 数组，正文仍从轨迹投影读取。
- `chat_turn.payload_json` 保留现有 `turns.jsonl` 的一行结构，键仍是 `(threadId, ordinal)`。
- `chat_context` 的 `kind` 只接受 `active` / `next`。
- `schema_meta` 至少保存 `schema_version` 与 `legacy_imported`。

## 5. API

### 5.1 全局偏好

```http
GET /api/prefs
POST /api/prefs
```

`GET` 响应：

```json
{
  "revision": 3,
  "global": {
    "filters": {},
    "tools": { "excluded": [], "excludeAll": false },
    "theme": "system",
    "translate": { "service": "bing", "to": "zh-CN", "mode": "bilingual" },
    "chatOpen": false,
    "chatWidth": 440,
    "composerHeight": 0
  }
}
```

`POST` 只接受已知 key 的局部更新，服务端合并后返回最新 `global` 与 `revision`。不存在的 key 忽略或 400，按实现定；未知字段不得写入数据库。

### 5.2 按会话 UI

```http
GET  /api/prefs/session?source=pi&session=<id>
POST /api/prefs/session
```

POST body 示例：

```json
{
  "source": "pi",
  "session": "<轨迹会话 id>",
  "threadId": "pi-thread-id",
  "threadNew": false,
  "mode": "forward",
  "contextIds": ["u1:user", "a1:tool"]
}
```

所有字段都可局部更新；`mode` 只接受 `independent` / `forward`；`contextIds` 去重并限制为字符串。

### 5.3 安全

- 新增 POST 路径加入现有 POST 白名单。
- 沿用 Host/Origin 校验；POST 强制 `application/json`；请求体上限 1MB。
- 只监听回环地址；非回环监听时 chat/prefs 不可用。
- 不返回其他用户/其他 agentDir 的数据；prefs 是本地单用户状态。
- 预置 DB 路径不可由浏览器传入。

### 5.4 现有接口

`GET/POST /api/chat/settings` 路径和响应保持不变，内部从 `settings.json` 改为读写 `chat_project`。
`GET /api/chat/thread`、`/api/chat/send` 等读取 `chat_turn` / `chat_context`，不新增浏览器可见格式。

## 6. 迁移

### 6.1 JSON/JSONL → SQLite

数据库第一次创建时执行一次迁移：

1. 创建 schema，写入 `schema_version=1`。
2. 若 `legacy_imported` 未设置：
   - 读 `<chatDir>/settings.json` → `chat_project`；
   - 扫 `<chatDir>/<source>/<safeSessionId>/meta/turns.jsonl` → `chat_turn`；
   - 读 `context.active.json` / `context.next.json` → `chat_context`；
3. 迁移成功写 `legacy_imported=1`。
4. 旧文件保留为备份，不立即删除；后续读取只走 SQLite。

坏 JSON/坏行跳过并记录日志，不阻塞其它数据。迁移必须幂等，重复启动不重复插入。

### 6.2 localStorage → SQLite

浏览器无法被服务端直接读取，采用客户端一次性导入：

1. 页面启动 `GET /api/prefs`。
2. 若服务端 `revision=0` / `legacy_imported=false`：
   - 读取当前 Origin 的旧 localStorage；
   - 规范化 `tw.filters` / `tw.tools` / `tw.theme` / `tw.translate` / `tw.chat` / `tw.chatWidth` / `tw.composerHeight`；
   - 读取 `tw.chatThread` / `tw.chatThreadNew` / `tw.chatMode` / `tw.chatCtx` 并逐 session POST；
   - 成功后服务端初始化，旧 key 可删除或保留为只读备份。
3. 若服务端已初始化：**服务端为准**，旧 localStorage 不参与状态判断。
4. 多个 Origin 有不同旧状态时，先完成导入的 Origin 获胜；不自动合并。需要时提供显式“以当前页面覆盖”操作。

### 6.3 主题首帧

`index.html` 目前在解析期读 localStorage 应用主题，避免暗色闪白。迁移后改成服务端在返回 `index.html` 时注入 `window.__TW_BOOT__ = { theme }` 的启动数据（或等价的内联 boot 脚本），页面不再依赖 localStorage 决定首帧。其它偏好可异步加载；主题必须首帧可用。

## 7. 过滤行为

- 删除 `selectSession()` / `switchSource()` 中的 `state.toolExcluded = new Set()` 和对应 `saveToolsPrefs()`。
- `tw.filters` / `tw.tools` 变为全局用户习惯，不再按 Origin 或会话隔离。
- 当前会话没出现的排除工具名**保留**，不要因为切会话就清理。
- 工具菜单的「全部」勾选态按当前会话实际出现的工具计算，不能简单用 `excluded.size === 0`，否则其它会话排除的工具会让当前菜单误显示未全选。
- `excludeAll=true` 表示新出现的工具也默认排除；用户单独勾回某工具时退出 `excludeAll`。
- 过滤状态迁移到服务端后，页面只发变更，不重写整张 map。

## 8. 非目标

- 不迁移 pi session JSONL，不改变 pi `/resume`、RPC、session 格式。
- 不迁移 Codex 数据。
- 不把 pi agentDir 的 auth/models/settings/skills 纳入插件库。
- 不持久化审批 allow-set、进程池、模型/技能/tool-origins 缓存。
- 不做多用户、鉴权、远端共享、跨 agentDir 同步。
- 不为状态存储引入远程数据库或 ORM。
- 不自动发布、不改版本号。

## 9. 验收摘要

1. 同一 agentDir、不同端口/Origin 打开 viewer，读到同一份全局过滤/工具/布局状态。
2. 刷新、切源、切会话不改变过滤勾选；工具未知名保留。
3. 旧 localStorage / settings.json / turns.jsonl / context.* 只迁移一次，重复启动不重复导入。
4. pi session 文件不被 SQLite 改写，pi `/resume` 与 RPC 仍可用。
5. 主题首帧无闪白。
6. 无第二份长期 localStorage 真源。
7. 模式 A / B 共用库；并发写不损坏数据。
8. 全量测试、`tsc`、`pi --print` 通过。

## 10. 待确认

- SQLite 实现：默认建议 `node:sqlite`，将 `package.json engines` 提升到 `>=22.19`；若必须兼容 Node 18/20，再改用 `better-sqlite3` 或 JSON fallback。
- 旧 JSON/JSONL 迁移后是否保留备份（建议保留，不删除）。
- 多 Origin 旧状态冲突是否需要页面显式“覆盖”按钮（建议需要时再加）。

实施顺序、文件清单、测试矩阵见 [implementation.md](./implementation.md)。
