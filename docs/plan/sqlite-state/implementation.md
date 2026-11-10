# SQLite 状态持久化：实施计划（v1）

> 状态：方案已确认边界；S1–S4 已完成并验证；S5 未开始。
> 上游：[README.md](./README.md)。本文给出逐文件改动、阶段验收、测试矩阵和迁移/回滚边界。
> 原则：先让 SQLite 成为插件自有状态的唯一真源，再删除 localStorage/JSON 的长期写入；pi session 格式不动。

## 1. 硬约束

- 一个 `agentDir` 一个数据库：`<agentDir>/pi-chat-helper/state.db`。
- 模式 A / 模式 B 共用同一 DB；不同 agentDir 不共享。
- 不迁移 pi session JSONL、Codex、pi agentDir 的 auth/models/settings/skills。
- 不持久化审批 allow-set、进程池、模型/技能/tool-origins 缓存。
- 迁移幂等；旧文件保留备份；不重复导入。
- 旧 localStorage 只做一次性导入来源；导入完成后服务端为唯一真源。
- 过滤状态是全局用户习惯：跨 Origin、跨会话保持；切会话/切源不清空。
- 新 DB 失败不能影响轨迹 viewer 的只读功能；聊天/偏好按能力降级并显示原因。
- 不自动发布、不改版本号。

## 2. 依赖与运行环境

使用 `node:sqlite`（已确认）：

- `package.json engines` 从 `>=18` 提升到 `>=22.19`（与 pi 1.5 的 Node 要求一致）。
- `DatabaseSync` 打开 DB；WAL、`busy_timeout`、事务。
- 接受 Node 对 `node:sqlite` 的 ExperimentalWarning；不通过隐藏警告来规避。
- 若必须兼容 Node 18/20，切换 `better-sqlite3` 或 JSON fallback，需要单独立项；本计划不把 fallback 作为主路径。

## 3. 文件改动总表

| 文件 | 类型 | 改动 |
| --- | --- | --- |
| `trajectory-web/server/state-db.mjs` | 新增 | 打开 DB、schema、schema_meta、WAL、事务、CRUD、JSON/JSONL 迁移、损坏保护 |
| `trajectory-web/server/state-db.d.mts` | 新增 | 服务端/扩展侧类型声明 |
| `trajectory-web/server/app.mjs` | 修改 | 打开 DB、注入 stateDb、挂 `/api/prefs*`、POST 白名单、HTML 主题 boot 注入 |
| `trajectory-web/server/main.mjs` | 修改 | `--state-db`（可选）/agentDir 派生；把 DB 传给 server |
| `trajectory-web/index.ts` | 修改 | 模式 A 打开/复用 DB；传入 server；关闭时释放 |
| `trajectory-web/server/chat-settings.mjs` | 保留 | 旧文件读写保留为无 stateDb 的兼容回退；生产走 `chat_project` |
| `trajectory-web/server/chat-session.mjs` | 保留 | 旧 turns/context 文件函数保留为兼容/迁移；生产走 `chat_turn`/`chat_context` |
| `trajectory-web/server/chat-host.mjs` | 修改 | 注入 stateDb；settings/turns/context 优先走 DB；无 DB 时旧文件回退 |
| `trajectory-web/chat-trajectory-tool.ts` | 修改 | `PI_CHAT_STATE_DB` 优先读 `chat_context.active`；旧 context 文件回退 |
| `trajectory-web/web/index.html` | 修改 | 移除 localStorage 主题首帧；注入 `window.__TW_BOOT__` 占位；prefs 初始化钩子 |
| `trajectory-web/web/prefs.js` | 新增 | 旧全局键迁移、规范化、清理；不碰 DOM/网络 |
| `trajectory-web/web/session-prefs.js` | 新增 | 会话级懒加载/缓存/防抖 POST；旧会话键迁移清理 |
| `trajectory-web/web/app.js` | 修改 | 读 prefs API、迁移 localStorage、过滤/工具/布局/翻译/主题改用服务端 |
| `trajectory-web/web/chat.js` | 修改 | thread/threadNew/mode 改走 session_ui；不再长期写 localStorage |
| `package.json` | 修改 | `engines >=22.19`（如确认） |
| `tests/test-state-db.cjs` | 新增 | schema/WAL/CRUD/事务/迁移/损坏/并发读 |
| `tests/test-server.cjs` | 修改 | prefs API 安全、session、chat settings/turns/context、HTML boot |
| `tests/test-web-lib.cjs` | 修改 | prefs.js / session-prefs.js 迁移纯函数、无 localStorage 长期写入守卫 |
| `tests/test-chat.cjs` | 修改 | chat sidecar 读写回归、DB 失败降级 |
| `README.md` | 修改 | 状态存储、过滤行为、Node 要求、迁移说明 |
| `docs/plan/sqlite-state/*` | 修改 | 实施完成状态与验证回写 |
| `ROADMAP.md` | 修改 | 完成后登记；docs 阶段先登记计划 |

不新增前端运行时依赖；不新增 ORM。

## 4. S1：SQLite 核心与迁移

### 4.1 模块职责

`state-db.mjs` 暴露：

```js
export function openStateDb({ agentDir, stateDbPath, now, log } = {})
// return {
//   path,
//   getGlobalPrefs(),
//   setGlobalPrefs(patch),
//   getSessionUi(source, sessionId),
//   setSessionUi(source, sessionId, patch),
//   getChatProject(source, projectPath),
//   setChatProject(source, projectPath, patch),
//   readTurns(source, sessionId, threadId),
//   upsertTurn(source, sessionId, record),
//   readContext(source, sessionId, kind),
//   writeContext(source, sessionId, kind, snapshot),
//   migrateLegacy(),
//   close(),
//   capabilities,
// }
```

内部：

- `ensureSchema()`：创建表、索引、`schema_meta`。
- `transaction(fn)`：失败回滚。
- `readJson/writeJson` 校验；坏值回退默认并记日志。
- `migrateLegacy()`：读旧 settings/turns/context；`legacy_imported` 幂等标记。
- `close()`：关闭 DB；服务关闭顺序在 HTTP/chat 之后。

### 4.2 数据库初始化

1. 解析 `agentDir`（尊重 `PI_CODING_AGENT_DIR`）。
2. `mkdirSync(<agentDir>/pi-chat-helper, 0700)`；`chmod 0700` 尽力。
3. 打开 `state.db`；`chmod 0600`。
4. `PRAGMA journal_mode=WAL`、`busy_timeout=5000`、`foreign_keys=ON`。
5. `ensureSchema()`；写 `schema_version=1`。
6. `migrateLegacy()`；写 `legacy_imported=1`。
7. 任一步失败：返回 `capabilities={ok:false, reason}`；不抛出到轨迹服务启动路径。

### 4.3 迁移规则

- `settings.json` → `chat_project`：
  - 只导入模板里合法的 `profile` / `projectSkills`；未知字段忽略。
  - 项目键保持 `source:resolve(projectPath)`。
- `turns.jsonl` → `chat_turn`：
  - 逐行解析，坏行跳过；
  - `(source, sessionId, threadId, ordinal)` 唯一；重复使用 UPSERT；
  - payload 原样保存已知字段。
- `context.active.json` / `context.next.json` → `chat_context`：
  - `kind=active|next`；坏 JSON 跳过；
  - `context.next` 保留后续 promote 语义。
- 旧文件不删除；若 DB 已有 `legacy_imported=1`，不重复扫描。
- 迁移返回 `{skipped, projects, turns, contexts, errors, skippedItems}` 统计；错误写日志，不包含正文。

### 4.4 S1 验收

**状态：已完成（2026-11-10，代码提交 `78b1783`）。**

- 临时 agentDir 打开 DB，schema 正确，文件 `0600`；目录 `0700`。
- 两个连接/跨进程写同一 DB，不损坏；WAL 可读。
- CRUD 幂等；坏 JSON 不阻塞；重复迁移不重复插入。
- pi session 文件未被写入。
- 现有测试不依赖真实 `~/.pi/agent`。
- 旧 `settings.json`/`turns.jsonl`/`context.*` 可完整导入。
- 验证：`tests/test-state-db.cjs` 52 PASS；全量 15 套 976 PASS、0 FAIL；`tsc` 0；`pi -ne -e . --print` 0。

## 5. S2：全局偏好 API 与首帧主题

### 5.1 API

```text
GET  /api/prefs
POST /api/prefs
GET  /api/prefs/session?source=&session=
POST /api/prefs/session
```

- `GET /api/prefs` 返回 `{revision, global}`；不返回 session 表全量。
- `POST /api/prefs` 接受已知 key 的 patch，服务端合并；未知/非法值 400。
- session API 局部更新 `threadId/threadNew/mode/contextIds`。
- POST 加入 `app.mjs` POST 白名单；Host/Origin/JSON/1MB 门禁。
- DB 不可用时返回 501/503，并带可操作 reason；轨迹 API 不受影响。

字段白名单：

```text
filters, tools, theme, translate, chatOpen, chatWidth, composerHeight
threadId, threadNew, mode, contextIds
```

> S2 落地 global 端点；S3 已落地 session 端点与字段。

`mode` 只允许 `independent|forward`；`contextIds` 去重、字符串、总数上限沿用现有策略；`tools.excluded` 只接受字符串数组。

### 5.2 前端启动

1. `GET /api/prefs` 在首次渲染前发起；已拿到则应用。
2. 服务端 `revision=0` 且本地旧 key 存在：调用客户端迁移函数，顺序 POST；成功后清理旧 key（或保留只读备份）。
3. 服务端已初始化：忽略旧 localStorage；不读 `tw.filters`/`tw.tools` 等作为状态。
4. 修改过滤/主题/布局/翻译/chat 开关：局部 POST，不做全量覆盖。
5. 失败：保留最后一次服务端值，提示“偏好保存失败”，不回退到 localStorage 真源。

### 5.3 主题首帧

- `index.html` 移除 localStorage 读取。
- 服务端服务 `index.html` 时注入：

```html
<script>window.__TW_BOOT__ = {"theme":"dark"};</script>
```

- 位置在首屏样式/顶栏之前；JSON 必须转义 `<`/`</script>`。
- DB 不可用时 boot 为 `system`，不阻断页面。
- 其他偏好异步加载；主题首帧不闪白。

### 5.4 S2 验收

**状态：已完成（2026-11-10，代码提交 `a3f687e`）。**

- 同一 agentDir 两个不同端口打开：主题、过滤、布局一致。
- 刷新/换 Origin 不再出现“全部回全选”。
- 首次导入只发生一次；服务端已有数据时旧 localStorage 被忽略。
- 主题首帧 dark 无浅色闪烁。
- prefs API 安全测试通过；DB 故障时 viewer 仍可读轨迹。
- 验证：test-server 237、test-web-lib 235、test-state-db 52；全量 15 套 993 PASS、0 FAIL；`tsc` 0；`pi` 0；两端口/跨 Origin 浏览器验证通过。

## 6. S3：按会话 UI 状态

### 6.1 前端替换

- `tw.chatThread` → `session_ui.thread_id`。
- `tw.chatThreadNew` → `session_ui.thread_new`。
- `tw.chatMode` → `session_ui.chat_mode`。
- `tw.chatCtx` → `session_ui.context_ids_json`。
- 页面启动/切会话按 `source:sessionId` 读取 session prefs；修改局部 POST。
- 移除 `localStorage` 读写；迁移函数只在首次导入时读取旧 map。

### 6.2 chat host 接入

- `threadPayload`、`send`、`resume`、`newThread` 的 thread/context 读取优先使用 DB session UI；pi session 文件仍是线程真源。
- 模式（独立/转发）读取 DB；不再依赖浏览器 localStorage。
- `context.next` 的 promote 仍写 `chat_context`。
- 无 DB 或行缺失：按现有默认（最新线程/空 context/independent）回退，不写入旧 JSON。

### 6.3 S3 验收

**状态：已完成（2026-11-10，代码提交 `6871078`）。**

- 切会话后 thread/context/mode 恢复正确；刷新后同一结果。
- 两个 Origin 打开同一会话看到同一 thread/context/mode。
- 新建未落盘虚拟线程标记不丢；首条落盘后清除。
- 旧 `tw.chatThread`/`tw.chatCtx`/`tw.chatMode` 迁移一次。
- 验证：test-server 247、test-web-lib 239、test-state-db 52；全量 15 套 1007 PASS、0 FAIL；`tsc` 0；`pi` 0；浏览器旧键迁移/线程加载/旧键清理通过。
- 聊天流式/审批/线程历史不回归。

## 7. S4：Chat sidecar 迁入 SQLite

- `chat-settings.mjs` 的 `readSettings/writeSettings/updateProjectSettings` 改为 DB；文件路径参数保留为迁移提示。
- `chat-session.mjs` 的 `readTurns/appendTurn/upsertTurn/readContext/writeContextNext/promoteContext` 改为 DB；保留旧文件读取仅用于 `legacy_imported`。
- `chat-host.mjs` 只依赖 stateDb；所有 `turns.jsonl`/`context.*` 路径引用删除。
- 旧文件迁移后保留；`legacy_imported=1` 后不再读取。
- `GET /api/chat/thread` 的 messages 不变；只是 sidecar 来源变化。
- `profile`/`projectSkills` API 路径不变。

### S4 验收

**状态：已完成（2026-11-10，代码提交 `e02c13c`）。**

- 旧 turns/context/settings 迁移后，`GET /api/chat/thread` 显示内容不变。
- 发送/审批/新线程/切换线程写 DB，不再写旧文件。
- DB 损坏/不可用时 chat 降级，轨迹页仍可用。
- 兼容旧测试中的临时 chatDir 迁移。
- 验证：test-server 247、test-web-lib 239、test-state-db 53、test-extension 92；全量 15 套 1009 PASS、0 FAIL；`tsc` 0；`pi` 0；read_trajectory 的 DB active 测试通过。

## 8. S5：过滤行为、清理与端到端

### 8.1 过滤/工具语义

- 删除 `selectSession()` / `switchSource()` 中清空 `state.toolExcluded` 与 `saveToolsPrefs()`。
- 工具排除集全局保存；当前会话不存在的工具名保留。
- `「全部」` 勾选态按当前会话可见工具集合计算：
  - `allCurrent` = 当前工具全部未排除；
  - `excludeAll` 仍表示新工具默认排除；
  - 别名/幽灵工具不改变可见集合。
- 全局类型过滤、工具排除、主题、翻译、布局、chat open/width/height 均从服务端读取。
- 旧 localStorage 只保留迁移入口；不再有长期 `setItem` 真源。

### 8.2 端到端

- 两个不同端口的 viewer 指向同一 agentDir：
  - 在一个端口取消过滤/排除工具；
  - 另一个端口刷新后一致；
  - 切源、切会话后仍一致。
- 浏览器关闭重开、服务重启后一致。
- 主题首帧 dark 截图/计算样式检查。
- 旧 localStorage 状态一次性迁移；服务端已有状态时旧值不覆盖。
- pi session 仍可 `/resume`（chatDir 隔离不变）。
- DB 故障模拟：轨迹页可用，prefs/chat 显示降级原因。

### 8.3 S5 验收

- 上述端到端全过。
- 全量现有测试 + 新 state-db/prefs 测试通过。
- `tsc`、`pi -ne -e . --print` 通过。
- README/plan/ROADMAP 记录真实验证；不发布、不改版本号。

## 9. 测试矩阵

| 层 | 覆盖 |
| --- | --- |
| `test-state-db.cjs` | schema/版本、WAL、CRUD、事务回滚、损坏 DB、迁移幂等、旧文件导入、文件权限 |
| `test-server.cjs` | prefs GET/POST、session、白名单、Host/Origin/JSON/1MB、DB 故障、boot HTML 注入、chat settings/turns/context |
| `test-web-lib.cjs` | localStorage 迁移纯函数、未知字段拒绝、工具「全部」语义、无 localStorage 长期写入守卫、无切会话工具重置 |
| `test-chat.cjs` | 线程/context/settings sidecar 回归、DB 失败降级 |
| `test-extension.cjs` | 模式 A DB 生命周期、关闭释放、不写真实 agentDir |
| Playwright | 两端口同 DB、刷新/切会话/切源、主题首帧、迁移冲突、离线/DB 故障 |
| 回归 | 13 套现有测试、tsc、pi 冒烟 |

## 10. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| `node:sqlite` 实验特性 | Node 22.19 固定；测试覆盖；若不可接受，切 better-sqlite3（另立项） |
| 多进程同时写 | WAL + busy_timeout + 短事务；写入串行化；不长时间持锁 |
| DB 损坏 | 保留旧 JSON/JSONL 备份；`state.db` 可重建；迁移标记避免重复 |
| localStorage 多 Origin 冲突 | 首次导入者获胜；服务端初始化后旧值忽略；必要时提供显式覆盖 |
| 主题首帧闪白 | 服务端 boot 注入；不依赖 localStorage |
| 工具排除全局化后「全部」误判 | 以当前会话可见工具计算；保留未知排除名 |
| 旧 JSON 文件残留 | 迁移后保留备份，不立即删除；后续读取只走 DB |
| mode A/B 关闭顺序 | 先停 HTTP/chat，再关 DB；DB close 幂等 |
| 模式 A 宿主退出 | DB 关闭；未落盘写入使用短事务，避免半写 |
| Node 18/20 用户 | engines 提升会明确拒绝；不静默 fallback 到 JSON |

## 11. 完成定义

- S1–S5 全部通过；每阶段独立 commit。
- SQLite 是插件自有状态的唯一长期真源；localStorage 仅迁移入口。
- 切会话/切源/刷新/换 Origin 不再改变过滤勾选；未知工具排除名保留。
- pi session JSONL、Codex、pi agentDir 配置保持原格式。
- 全量测试、tsc、pi 冒烟、两端口浏览器验证通过。
- 文档与实现一致；不自动发布、不改版本号。
