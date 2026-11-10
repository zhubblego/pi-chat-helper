# 控制台转发：实施计划（v1）

> 状态：T1–T2 已完成并验证；T3–T5 未实施。
> 上游：[README.md](./README.md)。接口：[api.md](./api.md)。交互：[ui.md](./ui.md)。
> 本文是逐阶段落地计划；完成一个阶段后再进入下一阶段，每阶段独立验证、独立 commit。

## 1. 目标与约束

### 1.1 目标

在现有独立对话之外，增加「转发」模式：把侧边栏输入作为普通用户消息，送进当前轨迹会话对应的、已加载 pi-chat-helper 的 pi TUI 控制台。

### 1.2 硬约束

- 不改变独立对话的现有行为、测试和存储。
- 不修改 `trajectory-web/server/chat-host.mjs` 的 child 协议；转发走独立链路。
- 控制台桥只对 `ctx.mode === "tui"` 注册；chat child、RPC、headless、`--print` 不注册。
- 不新增运行时依赖，使用 Node 内置 `http` / `fs` / `crypto`。
- 最低 pi 版本沿用 **1.5.0**。
- 测试不得写入真实 `~/.pi/agent`；桥相关测试使用临时 `agentDir`。
- 老控制台不 retrofit；页面只显示不可用，不提供终端注入。
- 第一版不镜像回答、不转发上下文、不支持远程停止/审批。

## 2. 模块与文件

| 文件 | 类型 | 改动 |
| --- | --- | --- |
| `trajectory-web/server/console-bridge.mjs` | 新增 | 控制台桥核心：注册文件、HTTP server、token、心跳、状态、`/forward`、`pi.sendUserMessage` |
| `trajectory-web/server/console-bridge.d.mts` | 新增 | 桥核心的 TypeScript 类型，供 `index.ts` 引用 |
| `trajectory-web/server/console-registry.mjs` | 新增 | viewer 侧：扫描/校验注册表、TTL、public 投影、精确 `sessionFile` 匹配 |
| `trajectory-web/server/console-forward.mjs` | 新增 | viewer 侧：调用 bridge `/forward`、Bearer token、超时、错误映射 |
| `trajectory-web/index.ts` | 修改 | `session_start` / `agent_start` / `agent_settled` / `session_shutdown` 接线桥；模式 A 传 agentDir |
| `trajectory-web/server/app.mjs` | 修改 | 注入 `agentDir` / `consolesDir`；`GET /api/chat/consoles`；`POST /api/chat/forward`；POST 白名单；错误映射 |
| `trajectory-web/server/app.d.mts` | 修改 | `consolesDir` / forward 依赖的类型 |
| `trajectory-web/server/main.mjs` | 修改 | 解析/透传 agentDir / consolesDir（默认从 agentDir 派生） |
| `trajectory-web/web/index.html` | 修改 | `#chat-mode-switch`、`#chat-console-status`、转发模式提示 |
| `trajectory-web/web/chat.js` | 修改 | 模式状态、控制台轮询、转发发送、转发记录、离线/错误态、独立模式隔离 |
| `trajectory-web/web/chat-lib.js` | 修改 | 纯函数：模式记忆、状态文案、可用性、delivery/错误映射 |
| `trajectory-web/web/app.js` | 修改 | 拉取 `/api/chat/consoles`；会话列表 console badge；把控制台状态交给 chat |
| `trajectory-web/web/style.css` | 修改 | 模式开关、状态条、console badge、转发记录、禁用态 |
| `tests/test-console.cjs` | 新增 | 注册表、TTL、public 投影、bridge server、token、forward 队列、状态、清理 |
| `tests/test-server.cjs` | 修改 | `/api/chat/consoles`、`/api/chat/forward`、错误、安全、无 token 泄漏 |
| `tests/test-web-lib.cjs` | 修改 | 模式/状态/错误纯函数与 DOM 守卫 |
| `tests/test-extension.cjs` | 修改 | 桥只在 TUI 注册；状态事件；shutdown 清理；不写真实 agentDir |
| `tests/test-chat.cjs` | 修改（仅回归） | 独立模式不受影响 |
| `tsconfig.json` | 修改 | 加入 `console-bridge.d.mts` 或桥相关类型文件 |
| `README.md` | 修改 | 对话页新增控制台转发能力、边界、老控制台限制 |
| `ROADMAP.md` | 修改 | 实施完成后补「已完成」与验证；当前阶段先登记计划 |

**不新增文件存储格式到 chatDir。** 转发不创建独立 pi 线程，不写 `turns.jsonl`；转发记录只在浏览器内存。

## 3. 控制台桥

### 3.1 模块接口

```js
// console-bridge.mjs
export function createConsoleBridge({
  pi,                 // ExtensionAPI：sendUserMessage
  getCtx,             // () => ExtensionContext，取当前 session / isIdle
  agentDir,           // <agentDir>/pi-chat-helper/consoles
  log,                // 可选
  env,                // 可选，测试注入
  now,                // 可选，测试注入
}) {
  // return {
  //   start(),          // session_start：TUI 才启动；写注册；心跳
  //   setState(state),  // agent_start / agent_settled
  //   close(),          // session_shutdown：删注册、关 server、清 timer
  //   port,             // 测试读取
  // }
}
```

- bridge 只依赖注入的 `pi` / `getCtx`，不 import pi SDK；便于用 fake 测试。
- `index.ts` 在 `session_start` 创建/更新 bridge；在 `agent_start` / `agent_settled` 调 `setState`；在 `session_shutdown` 调 `close`。
- 会话切换时旧 runtime 关闭、新 runtime 启动；每个进程同一时间只注册当前会话。
- `PI_CHAT_HELPER_CONSOLE_BRIDGE=0` 时不启动。
- `ctx.mode !== "tui"` 或没有 `sessionFile` 时不启动。

### 3.2 启动顺序

```text
extension load
→ session_start(ctx)
→ if ctx.mode === "tui" && env !== "0"
→ mkdir consoles/ 0700
→ remove own stale <pid>-*.json
→ http.createServer().listen(0, "127.0.0.1")
→ token = randomBytes(32).toString("hex")
→ write registration (0600, tmp+rename)
→ heartbeat timer 5s (unref)
```

- `listen` 失败：记录一次错误，不注册，不影响 pi。
- 端口必须随机；不要固定端口。
- token 只写入注册文件；不写日志、不返回 API。

### 3.3 状态

- 初始：`ctx.isIdle() ? "idle" : "working"`。
- `agent_start` → `working`。
- `agent_settled` → `idle`。
- 每次状态变化原子重写注册；心跳只更新 `heartbeatAt`。
- 转发接受后乐观 `working`；`sendUserMessage` 抛错时按 `ctx.isIdle()` 恢复。
- 注册字段与约束见 [api.md](./api.md) §4.1。

### 3.4 `/forward`

- 只允许 `POST`；`Authorization: Bearer`；JSON；拒绝 `Origin`；只接受 loopback。
- 校验 `sessionFile` 等于当前 `getCtx().sessionManager.getSessionFile()`；不匹配 409 `session_mismatch`。
- prompt trim 后非空、≤32,000 字符。
- `delivery`：
  - `auto`：空闲 → 立即；忙碌 → `followUp`；
  - `followUp`：空闲 → 立即；忙碌 → `followUp`；
  - `steer`：空闲 → 立即；忙碌 → `steer`。
- 调用：

```js
await pi.sendUserMessage(prompt, {
  ...(busy ? { deliverAs } : {}),
  expandPromptTemplates: false,
});
```

- 进程内串行队列：上一个 forward 完成注册状态更新后再处理下一个，避免两个请求同时看到 idle。
- 不提供 stop / abort / approval / session switch。
- 错误只返回 `{ error, code }`，不返回 token、路径、堆栈。

### 3.5 清理

- `session_shutdown`：`clearInterval`、删除自身注册、`server.close()`。
- 进程异常退出：注册文件残留由 viewer 的 TTL 过滤；下次同 PID 启动清理自己的旧文件。
- 测试使用临时目录；不删除别人的注册。

## 4. Viewer 侧

### 4.1 注册表读取

`console-registry.mjs`：

```js
export function readConsoles({ consolesDir, now = Date.now(), ttlMs = 15_000 }) { ... }
export function publicConsoles(records) { ... }  // 去掉 token/port/sessionFile
export function matchConsole(records, sessionFile) { ... }
```

- 忽略坏 JSON、`protocol !== 1`、`interactive !== true`、心跳过期。
- `publicConsoles` 只保留 `sessionId / pid / state / interactive / heartbeatAt / startedAt`。
- `matchConsole` 返回 `{ record }`、`{ error: "no_console" }` 或 `{ error: "ambiguous_console" }`。
- 路径比较用 canonical helper；POSIX `realpath`，失败回退 `resolve`；Windows 小写比较。

### 4.2 `GET /api/chat/consoles`

- 只接受 `source=pi`；Codex 返回空数组。
- 可选 `session` 过滤。
- 不返回 token/port/sessionFile。
- viewer 的 `agentDir` 必须与目标控制台一致；不一致时自然空数组，不报错。

### 4.3 `POST /api/chat/forward`

流程：

1. 现有 chat 安全 gate：启用、Host/Origin、JSON、1MB。
2. 解析 `source + session` → `sessionFile`；不存在 404。
   - 不要用 `/api/sessions.current` 作转发目标；模式 A 的 current 可能仍是服务启动时的会话。
3. 读注册表，过滤 stale/非交互。
4. 无 → 409 `no_console`；多 → 409 `ambiguous_console`；有但连接失败 → `console_offline`。
5. 调 `console-forward.mjs`，5 秒超时。
6. 把 bridge 的 409/502/504 映射为公开 code。
7. 成功返回公开 console + 实际 delivery。

`console-forward.mjs`：

```js
export async function forwardToConsole({
  record, prompt, delivery,
  timeoutMs = 5_000,
  request = http.request,
}) { ... }
```

- 只向 `record.port` / `record.token` 发请求；token 不出模块。
- 校验响应 JSON；非 2xx 映射。
- 网络错误/超时映射 `bridge_error` / `bridge_timeout`。

### 4.4 服务选项

- `app.mjs` 新增 `consolesDir`（默认 `join(agentDir, "pi-chat-helper", "consoles")`）。
- `main.mjs` / `index.ts` 透传 `agentDir`；不新增用户必须配置的参数。
- `--no-chat` 或非回环监听时：
  - `GET /api/chat/consoles` 可返回空/501；
  - `POST /api/chat/forward` 返回 501 `chat_disabled`。
- `chatHost` 不参与转发；转发不 spawn child。

## 5. 前端

### 5.1 模式状态

- `state.chatMode`: `"independent" | "forward"`。
- 按 `source:sessionId` 记忆 `localStorage["tw.chatMode"]`。
- 默认独立；没有记录时独立。
- 切换会话恢复；转发不可用时进入「不可用/离线」态，不静默发送。

### 5.2 轮询

- 复用页面 2 秒 tick 或 chat 自己的定时器，拉 `/api/chat/consoles`。
- 合并到 `state.consoles`，以 `sessionId` 索引。
- 会话列表更新 console badge；chat 更新状态条。
- 页面隐藏时不轮询（沿用 `document.hidden` 规则）。
- 请求失败不清空已有状态，标记「状态刷新失败」；下一次成功恢复。

### 5.3 转发发送

- 输入 Enter / 发送按钮触发：
  - 独立模式：`sendChat()` 原路径；
  - 转发模式：`sendForward()`。
- `sendForward`：
  - 检查模式可用、独立 turn 不活跃、草稿非空；
  - POST `/api/chat/forward`，body `{source, session, prompt, delivery}`；
  - 成功：清空草稿，追加 `forward-user` + `forward-status`；
  - 失败：保留草稿，追加 `forward-error`；按 code 显示原因。
- `delivery`：
  - 控制台 `working` 时显示选择器；默认 `auto`（服务端归一到 followUp）；
  - 选择「插话」时传 `steer`，二次确认。
- 发送中禁用发送按钮，避免重复提交；本地 requestId 防止旧响应覆盖新会话。

### 5.4 渲染

- `renderMessages()` 按 mode 分派：
  - 独立：现有 `state.messages` / 工具卡片 / 审批；
  - 转发：`state.forwardLog`（内存），不渲染 AI 回答/工具/审批。
- 转发记录条目见 [ui.md](./ui.md) §5。
- 顶部/状态条显示模式说明；空态文案区分独立与转发。
- 独立控件在转发模式隐藏或禁用：`+`、profile、模型/级别、技能、上下文 chips、`/new`、`/resume`、停止按钮。
- `/` 在转发模式不打开命令面板，按普通字符发送。
- 控制台状态条 `aria-live="polite"`；状态变化只播报一次。

### 5.5 会话列表

- `app.js` 拉取消控制台列表。
- `sessionItem` 保留 `live-dot`，新增 `console-badge`：
  - working：运行中；
  - idle：在线；
  - 无：不显示。
- 两个徽标独立 `title`；不能用 `live` 代替 console。

### 5.6 失败态

| 场景 | UI |
| --- | --- |
| `no_console` | 未检测到可转发控制台；说明插件/重启/`/reload` |
| `console_offline` | 控制台已离线；保留草稿；切回独立 |
| `ambiguous_console` | 检测到多个控制台；禁用 |
| `session_mismatch` | 控制台在别的会话；禁用 |
| `bridge_timeout` | 控制台无响应；保留草稿 |
| `bridge_error` | 转发失败；控制台详情见服务端错误 |
| `chat_disabled` | 转发不可用；不显示输入 |
| 独立 turn 活跃 | 禁用发送；提示先停止 |

## 6. 测试计划

### 6.1 单元 / 集成

- `tests/test-console.cjs`：
  - 注册文件校验、坏 JSON、protocol、TTL、PID、public 投影不含 token/port/path；
  - canonical sessionFile 匹配；
  - 多注册歧义；
  - bridge server：token、Origin、JSON、body 限制、session mismatch、auto/followUp/steer、串行队列、状态恢复、close 清理；
  - fake `pi.sendUserMessage` 参数断言（`expandPromptTemplates:false`、`deliverAs`）。
- `tests/test-server.cjs`：
  - `/api/chat/consoles` 过滤/空/Codex/安全；
  - `/api/chat/forward` 成功、无控制台、离线、多控制台、会话不匹配、prompt、delivery、安全、1MB、token 不泄漏；
  - 独立 chat 路由回归。
- `tests/test-web-lib.cjs`：
  - 模式记忆、状态文案、可用性、delivery/错误映射；
  - 转发模式不渲染 AI/审批；`/` 不打开命令面板；
  - 禁用态/aria 守卫。
- `tests/test-extension.cjs`：
  - 桥仅在 `ctx.mode === "tui"` 启动；
  - `session_start` 注册、`agent_start`/`agent_settled` 更新、`session_shutdown` 清理；
  - 临时 agentDir，不写真实目录；
  - 默认关闭 env 的行为。
- `tests/test-chat.cjs`：
  - 独立模式全量回归；转发路由不影响 child 池。

### 6.2 浏览器

- 更新 `trajectory-web/web/preview-mock.js`：
  - 新增 `GET /api/chat/consoles`；
  - 新增 `POST /api/chat/forward`，支持 idle / working / offline / no console / ambiguous / mismatch；
  - 可切换控制台状态，便于手动验证。
- Playwright（无头 Chromium）验证：
  - 模式切换、状态条、console badge；
  - 转发空闲/排队/插话/失败/离线；
  - 独立模式回退、输入保留、刷新恢复；
  - 无 pageerror；console 无错误。

### 6.3 真实端到端

1. `PI_CODING_AGENT_DIR=<temp>` 启动一个带扩展的 pi TUI；确认注册文件出现。
2. 启动模式 B viewer；确认页面显示 working/idle，且 `live` 独立。
3. 空闲转发：控制台出现用户消息并开始执行；侧边显示已发送。
4. 忙碌转发：默认排队；插话需确认；两种都能进入控制台。
5. 控制台 `/new`/`/resume`：注册切到新会话；旧会话转发禁用。
6. 控制台退出：注册消失；页面离线。
7. 未加载插件的旧 TUI：无注册；页面只显示不可用。
8. 关闭 `PI_CHAT_HELPER_CONSOLE_BRIDGE=0`：不注册；页面不可用。
9. 检查 `~/.pi/agent` 未被测试写入；kill 后无残留 HTTP server。

### 6.4 回归

```bash
node tests/test-console.cjs
node tests/test-server.cjs
node tests/test-chat.cjs
node tests/test-web-lib.cjs
PI_HOME="$HOME/.pi/agent/install/releases/1.5.0" node tests/test-extension.cjs
# 其余既有套件按当前 README 命令
node ~/.npm/_npx/483d2954a4c5190c/node_modules/typescript/bin/tsc -p tsconfig.json
pi -ne -e . --print
```

## 7. 阶段计划

### T0 设计文档与计划（本阶段，已完成）

- `docs/plan/console-forward/README.md`
- `api.md`
- `ui.md`
- `implementation.md`
- ROADMAP 当前阶段登记。

验收：文档落盘、交叉链接有效、方案边界与最终讨论一致。

### T1 控制台桥核心（已完成）

- 新增 `console-bridge.mjs` / `.d.mts`。
- 注册表写入、token、HTTP、心跳、状态、`/forward`、清理。
- `index.ts` 接线 `session_start` / `agent_start` / `agent_settled` / `session_shutdown`。
- 默认开启 + `PI_CHAT_HELPER_CONSOLE_BRIDGE=0`。
- 测试：bridge 单元 + fake pi；临时 agentDir。

退出标准：

- TUI 启动产生注册文件；RPC/headless 不产生；
- 状态变化正确；shutdown 删除；
- 其他 pi 功能不回归。

验证：

- `tests/test-console.cjs` 38 PASS：注册/心跳/状态/token/forward/清理/非 TUI/写入失败回滚。
- `tests/test-extension.cjs` 91 PASS：TUI `session_start` 自动注册、agent 事件、换会话注销。
- 全量 13 套 892 PASS；`tsc` 0；`pi -ne -e . --print` 0。
- T1 测试只写临时 agentDir；真实 `~/.pi/agent/pi-chat-helper/consoles` 未产生。

### T2 发现与状态（已完成）

- 新增 `console-registry.mjs`。
- `app.mjs` 派生 `consolesDir`；`main.mjs` 继续传 `agentDir`；`GET /api/chat/consoles`。
- `app.js` 轮询并渲染 console badge；`chat.js` 状态条占位（暂不转发）。
- 测试：注册表、API、安全、无 token。
- 浏览器：working/idle badge 与侧边状态；无控制台时隐藏。

退出标准：

- 页面不把 `live` 当控制台；
- 后启动 viewer 能发现已注册控制台；
- 没有注册时状态条隐藏；显式「未检测到可转发控制台」留到 T4 的转发模式。

验证：

- `tests/test-console.cjs` 43 PASS（含 T2 registry）：TTL、public 投影、canonical 匹配、歧义/空。
- `tests/test-server.cjs` 213 PASS（新增 6 条）与 `tests/test-web-lib.cjs` 225 PASS（新增 2 条）。
- headless Chromium：会话 badge working/idle、对话状态条 working/idle、无 JS error。
- 全量 13 套 905 PASS，0 FAIL；`tsc` 0；`pi -ne -e . --print` 0。

### T3 转发链路

- 新增 `console-forward.mjs`。
- `POST /api/chat/forward`；精确 sessionFile；错误映射；5 秒超时。
- 桥 `/forward` 的 auto/followUp/steer 与串行队列。
- 测试：fake bridge 成功/失败/离线/歧义/mismatch/超时；token 不泄漏。

退出标准：

- 空闲转发进入控制台；
- 忙碌默认排队；steer 需显式；
- 会话不匹配/多控制台拒绝。

### T4 侧边双模式

- `index.html` 模式开关/状态条/提示。
- `chat.js` 模式、转发记录、发送、离线、禁用控件、独立隔离。
- `chat-lib.js` 纯函数；`style.css`。
- `preview-mock.js` + Playwright。
- 测试：test-web-lib + 浏览器。

退出标准：

- 独立模式不回归；
- 转发忙闲/错误/离线性清楚；
- `/` 不在转发模式打开命令面板；
- 刷新、切会话、断连不丢草稿。

### T5 安全、文档与验收

- 完整安全复核：loopback、Host/Origin、JSON、1MB、32k、token、0600、无日志泄漏。
- 真实 TUI + viewer 端到端（本文件 6.3）。
- 更新 README / `docs/plan/aichat` 交叉引用（如需）/ ROADMAP 已完成。
- 全量测试 + tsc + pi 冒烟 + 浏览器。
- 明确残留风险；不自动发版、不改版本号。

## 8. 验收清单

- [ ] TUI 加载插件后自动注册；viewer 后启动可发现。
- [ ] chat child、RPC、headless 不注册。
- [ ] `live` 与 console `working`/`idle`/`offline` 分离。
- [ ] `agent_start` / `agent_settled` / 心跳 / shutdown 状态正确。
- [ ] 精确 `sessionFile`；无控制台/离线/多控制台/会话不匹配均拒绝。
- [ ] 空闲立即；忙碌默认 followUp；steer 二次确认。
- [ ] 转发不执行 `/command`，不带侧边上下文，不显示侧边审批。
- [ ] 老控制台无假连接；只给重启/`/reload` 说明。
- [ ] 独立模式消息/模型/技能/profile/上下文/审批/线程历史不回归。
- [ ] 模式 A / B 均可用；token 不出现在 API/浏览器/日志。
- [ ] 测试不写真实 `agentDir`；全量测试、tsc、pi 冒烟、浏览器通过。

## 9. 风险与已知限制

| 风险 | 处理 |
| --- | --- |
| 默认开启 bridge 增加本地端口 | 仅 loopback + token + 0600；`PI_CHAT_HELPER_CONSOLE_BRIDGE=0` 关闭 |
| 老控制台无法转发 | 明确不支持；页面提示重启/空闲 `/reload`；不做终端注入 |
| 忙碌判断/状态竞争 | `agent_start` / `agent_settled`；bridge 串行队列；接受后乐观 working |
| 心跳被同步工具阻塞 | TTL 15 秒；页面离线态；不做假在线 |
| 同一会话多控制台 | `ambiguous_console` 拒绝；不自动选 |
| 独立 child 与控制台并发 | 独立 turn 活跃时禁用转发发送；独立模式显示并发警告 |
| 侧边没有回答镜像 | 明确说明；主轨迹区轮询展示控制台新事件；后续版本再考虑镜像 |
| agentDir / 用户 / 容器不一致 | 不发现控制台；文档说明同用户同 agentDir |
| 侧边上下文/模型/技能不生效 | 转发模式禁用并说明；需要这些能力用独立模式 |
| 测试污染真实目录 | `ctx.mode` 限制 + 临时 `agentDir` + 显式断言 |

## 10. 完成定义

- T1–T5 全部通过；每阶段独立 commit。
- README、api、ui、implementation、ROADMAP 与实现一致；文档与代码冲突时以 pi 1.5 实测行为为准并回写文档。
- 独立模式既有测试全绿；新增测试覆盖桥、API、UI、真实 TUI。
- 不发布、不改版本号；发布前再单独确认发布授权。
