# 控制台转发 API 与注册表契约（v1）

> 状态：方案已确认，未实施。
> 上游：[README.md](./README.md)。交互：[ui.md](./ui.md)。落地计划：[implementation.md](./implementation.md)。
> 本文定义 viewer ↔ 浏览器的公开接口、viewer ↔ console bridge 的内部接口，以及注册表文件格式。

## 1. 通用约定

### 1.1 定位参数

- `source`：轨迹源 id；转发只支持 `pi`。必须在 `/api/sources` 白名单内。
- `session`：`/api/sessions` 返回的轨迹会话 id，不是文件路径。
- 服务端使用现有 `readSessions(source)` + `resolveSession()` 解析出真实 `sessionFile`；**不接受客户端传路径**。
- 转发不使用 `/api/sessions.current` 作为路由目标：模式 A 的 `current` 是服务启动时捕获的会话，TUI 后续 `/new`、`/resume` 可能已经切换；必须使用本次请求的 `session` + 注册表精确匹配。
- 注册表按真实 `sessionFile` 匹配；请求只看 `session` id。
- `sessionFile` 比较使用 canonical path；POSIX 取 `realpath`，失败回退 `resolve`；Windows 按大小写不敏感比较。

### 1.2 错误格式

```json
{ "error": "人类可读的原因", "code": "optional_machine_code" }
```

| 状态码 | 场景 |
| --- | --- |
| 400 | 参数缺失/非法、prompt 为空或超长、delivery 非法、source 不支持 |
| 403 | Host/Origin/Content-Type 安全校验失败 |
| 404 | 轨迹会话不存在 |
| 409 | 无控制台、控制台离线、多控制台歧义、会话不匹配、独立对话正在运行 |
| 413 | 请求体超过 1MB |
| 502 | bridge 返回错误、连接失败 |
| 504 | bridge 超时 |
| 501 | chat/forward 未启用（`--no-chat`、非回环监听禁用 chat） |
| 500 | 内部错误 |

### 1.3 POST 白名单

现有 POST：

- `/api/translate`
- `/api/context-edit`
- `/api/crop-entry`
- `/api/chat/model`
- `/api/chat/thread`
- `/api/chat/settings`
- `/api/chat/send`
- `/api/chat/stop`
- `/api/chat/approval`

新增：

- `/api/chat/forward`

其余 POST 继续 405。

### 1.4 安全

- `/api/chat/forward` 是 chat POST：必须带 `Content-Type: application/json`。
- 沿用现有 Host/Origin 校验：
  - Host hostname 只允许 `127.0.0.1`、`localhost`、`[::1]`；
  - 有 Origin 时必须同源（http + 回环 + 实际端口）；
  - 无 Origin 的本地客户端允许。
- 所有校验在读取 body、访问 bridge 之前完成；失败统一 403。
- 非回环监听时 chat 自动禁用；forward 也禁用。
- `GET /api/chat/consoles` 不返回 bridge token、port、sessionFile；token 只在 viewer 进程内使用。
- 请求体上限 1MB；prompt 上限 32,000 字符。

## 2. 控制台列表

```http
GET /api/chat/consoles?source=pi[&session=<id>]
```

响应：

```json
{
  "source": "pi",
  "refreshedAt": "2026-11-10T09:00:00.000Z",
  "consoles": [
    {
      "sessionId": "20261110T090000-abc",
      "pid": 12345,
      "state": "working",
      "interactive": true,
      "heartbeatAt": "2026-11-10T09:00:04.000Z",
      "startedAt": "2026-11-10T08:59:00.000Z"
    }
  ]
}
```

规则：

- 只读取 `<agentDir>/pi-chat-helper/consoles/*.json`。
- 忽略坏 JSON、协议版本不符、`interactive !== true`、心跳超过 15 秒、PID 明显无效的条目。
- 按 `sessionId` 去重；同一会话多个有效注册时保留全部，由 forward 返回 `ambiguous_console`。
- `session` 可选过滤；不传时返回全部在线控制台，供会话列表和侧边栏合并。
- `source=codex` 返回 `{ "source": "codex", "consoles": [] }`；不提供 Codex 转发。
- 不返回 `port`、`token`、`sessionFile`、`cwd`。
- 没有注册时返回 200 + 空数组；不把 `live` 当作控制台。
- 轮询建议：页面每 2 秒刷新一次；心跳 5 秒、TTL 15 秒。

## 3. 转发请求

```http
POST /api/chat/forward
Content-Type: application/json
```

请求：

```json
{
  "source": "pi",
  "session": "20261110T090000-abc",
  "prompt": "帮我看一下刚才那个失败",
  "delivery": "auto"
}
```

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `source` | 是 | 只接受 `pi` |
| `session` | 是 | 轨迹会话 id |
| `prompt` | 是 | trim 后不能为空；最长 32,000 字符 |
| `delivery` | 否 | `auto`（默认）/ `followUp` / `steer` |

成功响应：

```json
{
  "ok": true,
  "console": {
    "sessionId": "20261110T090000-abc",
    "pid": 12345,
    "state": "working"
  },
  "delivery": "followUp",
  "acceptedAt": "2026-11-10T09:00:05.000Z"
}
```

`delivery` 是实际生效的方式：`now` / `followUp` / `steer`。控制台空闲时，`followUp` 和 `steer` 都归一为 `now`。

### 3.1 服务端流程

1. 校验 chat 启用、安全 gate、JSON、请求体大小。
2. 解析 `source + session` → 真实 `sessionFile`；不存在 404。
3. 读注册表；过滤 stale / 非交互条目。
4. 没有条目 → 409 `no_console`；多项 → 409 `ambiguous_console`。
5. 通过注册表里的 `port + token` 调 bridge `POST /forward`，超时 5 秒。
6. 把 bridge 的 `session_mismatch` / `bridge_error` 映射成公开错误。
7. 返回 `console` 公开字段，绝不回传 token。

### 3.2 错误码

| code | 状态 | 说明 |
| --- | --- | --- |
| `bad_request` | 400 | 字段缺失/格式错误 |
| `prompt_empty` | 400 | trim 后为空 |
| `prompt_too_large` | 400 | 超过 32,000 字符 |
| `bad_delivery` | 400 | 不是 auto/followUp/steer |
| `unsupported_source` | 400 | 非 pi |
| `session_not_found` | 404 | 轨迹会话不存在 |
| `no_console` | 409 | 当前会话没有已注册控制台 |
| `console_offline` | 409 | 注册存在但心跳/连接已失效 |
| `ambiguous_console` | 409 | 同一会话多个控制台 |
| `session_mismatch` | 409 | 控制台已切到别的会话 |
| `bridge_timeout` | 504 | bridge 5 秒未响应 |
| `bridge_error` | 502 | bridge 返回错误或连接失败 |
| `chat_disabled` | 501 | 非回环 / `--no-chat` |

页面必须按 code 区分「未加载插件」「离线」「切走了」「多控制台」，不要统一成「发送失败」。

## 4. Console bridge 内部接口

bridge 只在 `ctx.mode === "tui"` 的进程里启动，绑定 `127.0.0.1` 随机端口。

### 4.1 注册表文件

位置：

```text
<agentDir>/pi-chat-helper/consoles/<pid>-<nonce>.json
```

权限：

- 目录 `0700`；
- 文件 `0600`；
- 原子写：临时文件 + rename。

内容：

```json
{
  "protocol": 1,
  "pid": 12345,
  "nonce": "8f3c…",
  "sessionId": "20261110T090000-abc",
  "sessionFile": "/home/user/.pi/agent/sessions/--…--/20261110T090000-abc.jsonl",
  "cwd": "/home/user/project",
  "port": 54321,
  "token": "64-hex…",
  "state": "working",
  "interactive": true,
  "startedAt": "2026-11-10T08:59:00.000Z",
  "heartbeatAt": "2026-11-10T09:00:04.000Z"
}
```

约束：

- `sessionFile` 为 canonical 绝对路径。
- `token` 32 字节随机值的 hex；不写日志、不返回浏览器。
- `state` 只允许 `idle` / `working`。
- `protocol` 不匹配的条目不参与路由。
- 每次状态变化或心跳都原子重写；不追加 JSONL。

### 4.2 生命周期

| 触发 | 行为 |
| --- | --- |
| 扩展加载 + `session_start`（TUI） | 启动 HTTP server（若未启动）、生成 token、写注册、启动心跳 |
| `agent_start` | `state=working`，重写注册 |
| `agent_settled` | `state=idle`，重写注册 |
| 每 5 秒 | 更新 `heartbeatAt` |
| `session_shutdown` | 删除注册、关闭 server、清 timer |
| 会话切换 | 旧注册删除；新 `session_start` 写新注册 |
| bridge 启动失败 | 记录一次错误，不注册；不影响 pi |
| `PI_CHAT_HELPER_CONSOLE_BRIDGE=0` | 不启动、不注册 |

桥使用进程内串行队列处理 forward，避免「两个请求都看到 idle，同时 send」的竞态。

### 4.3 `POST /forward`

```http
POST /forward
Authorization: Bearer <token>
Content-Type: application/json
```

请求：

```json
{
  "sessionFile": "/abs/path/session.jsonl",
  "prompt": "…",
  "delivery": "auto"
}
```

成功：

```json
{ "ok": true, "delivery": "followUp", "state": "working" }
```

规则：

- 只接受 loopback 连接；拒绝带 `Origin` 的请求；token 必须匹配；JSON、1MB、32k 限制。
- `sessionFile` 必须等于当前会话；否则 409 `session_mismatch`。
- 空闲：
  - `auto` / `followUp` / `steer` → 立即 `pi.sendUserMessage(prompt)`，返回 `now`。
- 忙碌（`ctx.isIdle() === false`）：
  - `auto` / `followUp` → `pi.sendUserMessage(prompt, { deliverAs: "followUp" })`；
  - `steer` → `pi.sendUserMessage(prompt, { deliverAs: "steer" })`。
- 一律 `expandPromptTemplates: false`；转发内容按普通用户消息处理。
- 接受前乐观置 `working`；`sendUserMessage` 抛错则按 `ctx.isIdle()` 恢复并返回 bridge 错误。
- 不提供 stop / abort / approval 接口。
- bridge 不写侧边会话；消息由 pi 自己落盘到当前控制台 session。

### 4.4 认证

- `Authorization` 缺失/错误：401。
- 非 JSON：415。
- 超过 1MB：413。
- 非 loopback / 有 Origin：403。
- bridge 错误正文只返回简短 code/message；不返回内部路径、token、堆栈。

## 5. 状态与展示契约

| 数据 | 来源 | 用途 |
| --- | --- | --- |
| `live` | session 文件 mtime < 30s | 轨迹列表的「文件活跃」点，保持现状 |
| `console.state` | bridge 注册 + 心跳 | 侧边控制台状态；转发可用性 |
| `console.pid` | 注册表 | 状态展示；不用于安全决策 |
| `heartbeatAt` | 注册表 | TTL / 离线判断 |

UI 不应把 `live` 当成 `console.state`，也不应在没有注册时显示「控制台正在工作」。

## 6. 兼容性

- 最低 pi 版本沿用现有 **1.5.0**：需要 `pi.sendUserMessage`、`agent_start` / `agent_settled`、`ctx.mode`、`ctx.isIdle()`。
- 模式 A / B 使用同一套注册表；模式 A 的 viewer 在 pi 进程内，模式 B 在独立 node。
- viewer 的 `agentDir` 必须与目标控制台一致（尊重 `PI_CODING_AGENT_DIR`）；不一致时看不到注册。
- 不支持多用户、跨主机、跨容器、WSL↔Windows 不同文件系统。
- 未加载 pi-chat-helper 的旧控制台没有任何注册；API 只返回 `no_console`，不提供页面注入。
