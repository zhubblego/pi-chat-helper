# 控制台转发：设计与边界（v1）

> 状态：T1–T5 已完成并验证。
> 日期：2026-11-10。
> 关联文档：[api.md](./api.md)（接口 / 注册表 / 安全契约）、[ui.md](./ui.md)（双模式与状态）、[implementation.md](./implementation.md)（逐阶段落地计划）。
> 上游背景：[对话页 v2](../aichat/README.md)。

## 1. 目标

轨迹页正在查看某个目录下的会话，且该会话对应的 **pi coding agent TUI 控制台**正在工作。用户希望侧边对话栏除了现有的「独立对话」外，再提供「转发」模式：

- **独立模式**：保持现状。侧边栏启动自己的 `pi --mode rpc` 子进程，使用自己的线程、模型、技能、轨迹上下文和工具 profile。
- **转发模式**：侧边栏不启动 child，只把提问作为一条**用户消息**转发给该会话正在运行的控制台；由控制台自己的模型、技能、工具和审批执行。
- 页面能区分「会话文件活跃」与「控制台正在工作 / 在线空闲 / 不存在」。
- 控制台忙碌时，转发默认排队（`followUp`）；用户显式选择「插话」才用 `steer`。

最终效果：

```text
选中会话
→ 页面显示该会话的控制台状态
→ 侧边切到「转发」
→ 输入问题并发送
→ 控制台里出现用户消息
→ 控制台执行 / 排队
→ 侧边显示「已转发」；主轨迹区继续 2 秒轮询，展示控制台产生的轨迹
```

## 2. 最终结论

1. **必须增加控制台桥（console bridge）**，不能只改前端 `send` 的目标。现有对话是独立子进程，viewer 只读 session 文件，没有向运行中的 TUI 写入的通道。
2. **桥由控制台自己的 pi 扩展在加载时启用**，不依赖 `/deepseek-trail start`，也不由 viewer 远程装载。扩展加载后，交互式 TUI 在 `session_start` 自动注册。
3. **只支持启动时已经加载 pi-chat-helper 的交互式 pi TUI。** 启动早于插件加载的控制台不做 retrofit；页面只提示「未检测到可转发控制台」，不提供假的「连接」按钮，不调用终端注入。
4. **路由依据是精确的 `sessionFile`，不是 `live`。** `live` 只表示 session 文件最近 30 秒有写入，不能说明控制台 PID、忙闲或会话归属。
5. **第一版不镜像控制台回答、不转发侧边上下文、不支持远程停止或审批。** 回答和审批在控制台完成；主轨迹区会自然刷新出控制台产生的消息和事件。

## 3. 现状与缺口

| 位置 | 现状 | 缺口 |
| --- | --- | --- |
| `trajectory-web/server/chat-host.mjs` | 独立 pi RPC 子进程；线程、模型、技能、上下文、审批、进程池 | 没有「向控制台注入用户消息」的链路 |
| `trajectory-web/server/sessions.mjs` | `live = now - modified < 30_000` | 只看文件写入，不识别控制台进程或忙闲 |
| `trajectory-web/web/chat.js` | 侧边独立对话 UI | 没有独立 / 转发模式切换，也没有控制台状态 |
| `trajectory-web/index.ts` | 模式 A：扩展在 pi TUI 进程内启动 viewer；模式 B：独立 node | 没有控制台注册、心跳或转发入口 |

关键事实：

- pi 的 session 文件是会话内容落盘，viewer 不持有写入进程的 PID / 端口 / 会话锁；因此仅靠文件无法判断「哪个控制台在跑这个会话」。
- pi 没有公开的「attach 到已运行 TUI 并向它提交用户消息」接口。可行的官方能力只有扩展在自身进程里调用 `pi.sendUserMessage()`。
- 扩展在 TUI 进程内可以拿到当前 `sessionFile`、`ctx.isIdle()`，并监听 `agent_start` / `agent_settled`；这是可靠状态源。

## 4. 最终决策

| # | 决策 | 理由 / 边界 |
| --- | --- | --- |
| 1 | 新增 console bridge，自动注册 | 控制台加载插件即可被发现；不需要用户为每个 console 手动开开关 |
| 2 | 只在 `ctx.mode === "tui"` 注册 | 排除 chat child、RPC、headless、`--print`；避免递归和测试污染 |
| 3 | 每个 TUI 进程一个桥，注册当前会话 | 一个进程同一时间只有一个当前会话；会话切换时注销旧会话、注册新会话 |
| 4 | bridge 用回环 HTTP + token | 跨平台；只绑定 `127.0.0.1`；token 只存在 0600 注册文件，不返回浏览器 |
| 5 | viewer 代理转发，不让浏览器直连桥 | token 不进浏览器；沿用现有 Host/Origin/JSON 安全 gate |
| 6 | `sessionFile` 精确匹配 | 不做 cwd 猜测，不自动切换控制台会话；同一会话多个控制台直接拒绝 |
| 7 | 忙碌默认 `followUp` 排队 | 转发不应默认打断正在执行的任务；`steer` 是显式动作并二次确认 |
| 8 | 转发正文按普通用户消息发送 | `expandPromptTemplates:false`；不远程执行 `/command`；不附带侧边轨迹上下文 |
| 9 | 转发模式禁用独立模式的模型 / 技能 / profile / 上下文 / 停止 | 这些设置属于控制台；侧边不能假装控制它们 |
| 10 | 第一版不镜像回答 | 主轨迹区已经 2 秒轮询同一 session；避免侧边和主区两套重复渲染 |
| 11 | 老控制台不 retrofit | 无插件代码就无法可靠注入；终端注入不进入核心能力 |
| 12 | 模式按 `source:sessionId` 记忆 | 与现有 `tw.chatThread` / `tw.chatCtx` 的按会话记忆一致 |

## 5. 架构

### 5.1 进程与链路

```text
浏览器（轨迹页 + 侧边栏）
│
├─ 独立模式
│   └─ POST /api/chat/send → chat host → pi RPC child（现有）
│
└─ 转发模式
    └─ POST /api/chat/forward
        → viewer：读取 console registry
        → 精确匹配 sessionFile
        → POST 桥 /forward（Bearer token）
        → 控制台扩展：pi.sendUserMessage(prompt)
        → 控制台执行；主轨迹区轮询 session 文件
```

### 5.2 模式 A

```text
pi TUI 进程
├─ 主 AgentSession
├─ pi-chat-helper 扩展
│   ├─ console bridge（127.0.0.1:随机端口 + token）
│   └─ viewer HTTP 服务（/deepseek-trail start，可选）
└─ session 文件
```

- bridge 与 viewer 生命周期解耦：先启动 bridge，后启动 viewer 也能发现；viewer 退出不影响控制台。
- viewer 仍由 `/deepseek-trail start` 启动；bridge 在扩展加载后自动注册。

### 5.3 模式 B

```text
独立 node viewer（npm run dev）
└─ 读取 <agentDir>/pi-chat-helper/consoles/*.json
    └─ 找到其他已加载插件的 pi TUI 控制台
```

- 目标控制台必须在启动时加载了 pi-chat-helper；否则没有注册，转发不可用。
- viewer 与目标控制台必须同一用户、同一 `agentDir`、同一主机命名空间。

## 6. 控制台注册与状态

### 6.1 注册时机

- `session_start`：若 `ctx.mode === "tui"`，启动/更新 bridge，写入当前会话注册。
- 初始状态取 `ctx.isIdle()`：`true` → `idle`，`false` → `working`。
- `agent_start` → `working`。
- `agent_settled` → `idle`。
- `session_shutdown`：删除注册并关闭 bridge。
- 会话切换（`/new`、`/resume`、`/fork`）：旧会话注册注销；新会话注册。
- 心跳每 5 秒；viewer 以 15 秒 TTL 判定在线。
- 桥启动失败只记录日志，不阻断 pi；页面显示不可用。

### 6.2 状态含义

| 状态 | 来源 | 含义 |
| --- | --- | --- |
| `working` | `agent_start` / `ctx.isIdle() === false` | 控制台正在处理 agent run；转发默认排队 |
| `idle` | `agent_settled` / `ctx.isIdle() === true` | 在线且可立即开始新 turn |
| `offline` | viewer 找不到有效注册 / 心跳过期 | 没有可转发的控制台 |
| `live` | session 文件 mtime < 30s | 仅文件活跃，不是控制台状态 |

页面必须把 `live` 和 `console.state` 分开显示。一个文件可能 `live` 但没有 bridge；一个控制台可能 `working` 但超过 30 秒没有写文件。

### 6.3 注册文件

位置：

```text
<agentDir>/pi-chat-helper/consoles/<pid>-<nonce>.json
```

权限：目录 `0700`，文件 `0600`。字段与 API 见 [api.md](./api.md)。

## 7. 转发语义

- 目标：当前选中的轨迹会话对应的、已注册的、`interactive:true` 的控制台。
- 匹配：服务端把 `source + session` 解析成真实 `sessionFile`，与注册表精确比较；不接受客户端传文件路径。
- 没有注册：`no_console`，页面提示未检测到可转发控制台。
- 注册过期 / 桥不可达：`console_offline`。
- 同一会话多个注册：`ambiguous_console`，拒绝转发。
- 控制台已切到别的会话：`session_mismatch`，不自动切回。
- 控制台空闲：立即提交。
- 控制台忙碌：
  - `auto`（默认）→ `followUp` 排队；
  - 用户显式选 `steer` → 插话，二次确认；
  - 两种都在控制台的正常 agent 生命周期里处理。
- 正文：trim 后发送；空 → 400；超过 32k 字符 → 400；`expandPromptTemplates:false`。
- 不附带侧边选中的轨迹上下文；控制台已有自己的会话历史。需要轨迹上下文时使用独立模式。
- 不接受「自动切换控制台会话」「远程停止控制台」「远程审批」。
- 独立对话有活动 turn 时，前端禁用转发发送，先停止独立对话，避免两个 agent 同时修改工作区。

## 8. 双模式 UI（摘要）

- 输入区增加 `[独立] [转发]` 模式切换。
- 默认独立；转发仅在当前会话有精确匹配的在线控制台时可点。
- 转发模式显示控制台状态、PID、忙碌提示和转发记录。
- 转发模式隐藏/禁用模型、思考级别、技能、profile、上下文 chips、`/new`、`/resume`、停止按钮。
- 忙碌时显示「排队（推荐）/ 插话」；插话需确认。
- 控制台离线时保留输入、禁用发送，提供「切回独立」。
- 不显示侧边审批；审批在控制台。
- 老控制台：只显示「未检测到可转发控制台（可能未加载 pi-chat-helper）」和重启 / 空闲时 `/reload` 的说明；不做页面注入。

详细交互见 [ui.md](./ui.md)。

## 9. 安全

- bridge 只绑定 `127.0.0.1`，只接受 `POST /forward`。
- 注册文件 0600，token 随机生成；token 不写入日志、不返回浏览器。
- bridge 要求 `Authorization: Bearer <token>`、JSON Content-Type、请求体上限；拒绝带 `Origin` 的浏览器请求。
- viewer 的 `/api/chat/forward` 沿用现有 chat POST 的 Host/Origin/JSON 校验；非回环监听时禁用 chat，也禁用转发。
- 默认开启 bridge；`PI_CHAT_HELPER_CONSOLE_BRIDGE=0` 可关闭。
- 转发只是提交用户消息；不执行远程命令，不做 shell 插值。

## 10. 非目标

- 不支持未加载 pi-chat-helper 的旧控制台；不提供页面连接 / 终端注入。
- 不支持 Codex、RPC child、headless / `--print` 进程转发。
- 不转发侧边轨迹上下文、模型、技能、工具 profile。
- 不在侧边镜像控制台完整回答、工具卡片或审批。
- 不远程停止、远程审批、自动切换控制台会话。
- 不做多用户、远程访问、跨主机 / 跨容器。
- 不做同一会话多个控制台的选择器；直接拒绝歧义。

## 11. 验收摘要

1. 加载插件的 TUI 启动后自动注册；viewer 后启动也能发现。
2. chat child / RPC / headless 不注册。
3. 页面能区分 `live` 与 `working` / `idle` / `offline`。
4. `agent_start` / `agent_settled` 驱动忙闲；心跳过期变离线。
5. 精确会话转发；空闲立即、忙碌默认排队、插话需确认。
6. 无控制台、离线、多控制台、会话不匹配均拒绝且提示明确。
7. 老控制台只显示不可用，不提供假连接。
8. 独立模式功能不回归；token 不出现在浏览器响应；模式 A/B 都可用。

实施顺序、文件与测试见 [implementation.md](./implementation.md)。
