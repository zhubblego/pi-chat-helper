# pi-chat-helper

**中文** ｜ [English](README.en.md)

[pi coding agent](https://github.com/earendil-works/pi-coding-agent) 的扩展包：**在浏览器里完整回看会话轨迹**（trajectory-web），**在 TUI 里快速跳转历史提问**（question-panel）。轨迹观察不只支持 pi——`npm run dev` 起来后左侧有 **Agent 选择栏**，宿主机上有哪个 agent 的会话就亮哪个按钮（当前支持 pi 与 Codex）。

![浅色主题](screenshots/light.png)

*浅色主题：会话栏 ＋ 问题栏 ＋ 按提问分段的轨迹，工具调用与结果成对展示*

![深色主题](screenshots/dark.png)

*深色主题：跟随系统，也可手动指定*

## 安装

```bash
pi install git:github.com/zhubblego/pi-chat-helper
```

新开会话生效。`pi list` 查看已装扩展包，`pi remove git:github.com/zhubblego/pi-chat-helper` 移除。

运行环境要求 **Node >= 22.19**；SQLite 状态库使用 `node:sqlite`；S2–S5 已接入全局偏好、会话 UI、chat sidecar 与过滤/工具全局习惯。

想先试用一次、不写入配置：

```bash
pi -e git:github.com/zhubblego/pi-chat-helper
```

## 快速上手

安装后两件事开箱即用：

**１．TUI 里跳回任意历史提问**

```text
/questions
```

打开提问列表面板（浮动 overlay，停靠右上角）。单击任意条目，transcript 直接跳回那一问；双击进入该回合的分析视图（思考→工具→输出节点树）。

**２．浏览器里看会话轨迹**

```text
/deepseek-trail start
```

进程内启动 web 服务（默认 `http://127.0.0.1:7717`），浏览器里看当前项目的全部会话：左侧会话栏 + 问题栏，右侧轨迹按提问分段，条目点开有 Markdown 渲染、工具参数与结果、tokens 与耗时。`/deepseek-trail stop` 停止。

默认只开放 pi 源；加 `--codex` 同时看本机 Codex 轨迹（`.codex/sessions`，按当前工作目录过滤），加 `--all` 放开全部项目历史与全部可用轨迹源：

```text
/deepseek-trail start --codex      # 当前项目：pi + Codex
/deepseek-trail start --all        # 全部项目历史 + 全部可用源
```

也可以脱离 pi 跑独立服务，观察**全部 pi 历史**与运行中会话（按项目分组、live 徽标），以及本机 **Codex 历史**（`.codex/sessions`）：

```bash
npm run dev        # 默认 http://127.0.0.1:7788
# 等价：node trajectory-web/server/main.mjs --scope all --port 7788
```

## 近期新增（0.6.0 之后，待随下一版发布）

- **Markdown 渲染升级 markdown-it**：详情弹窗与对话消息支持 GFM 表格、删除线与任务列表（checkbox）；转义语义与 `md-code` 代码块样式不变，单换行仍成 `<br>`。
- **mermaid 图表**：```mermaid``` 代码块自动渲染为 SVG 图表（流程图/时序图等）；懒加载（首次遇到图块才拉取 mermaid.js），渲染结果进程内缓存，失败时保留源码并红边提示。
- **详情面板行锚定**：展开/收起条目详情时被点击的行锚定在原视口位置，不再上下跳动。
- **对话输入栏重排**：`+` 命令菜单移到最左；独立/转发双按钮合并为单钮（显示当前模式，点击反转），位于控制台状态条之前，无可用控制台时禁用。
- **vendor 自包含**：markdown-it 14.3.3（126KB）与 mermaid v11（3.6MB）单文件入库（`web/vendor/`），完全离线可用，无 CDN 依赖。

## trajectory-web：轨迹观察 web 服务

一整页会话轨迹：左侧会话栏 + 问题栏（含过滤按钮组），右侧轨迹按问题分段。一级是提问（问题 1、问题 2 …，同级分组），二级是该回合内的事件链（提问原文、思维链、工具调用与结果、输出文本、模型调用失败的错误、系统提示/压缩/模型切换等上下文事件）。条目点击居中弹出详情弹窗：Markdown 渲染、工具参数/结果、tokens 与耗时、子调用。

### 两种启动模式

|  | 模式 A（pi 插件） | 模式 B（独立 web server） |
|---|---|---|
| 启动 | pi 内执行 `/deepseek-trail start [端口] [--codex] [--all]` | `npm run dev`（默认 7788） |
| 范围 | 缺省当前项目的全部会话；`--all` 同模式 B（全部历史） | 全部 pi 历史 + 运行中的会话（按项目分组） |
| 轨迹源 | 缺省只开放 pi；`--codex` 加 Codex，`--all` 全部可用源 | 列出宿主机上全部可用 agent（π、Codex…） |
| 生命周期 | 绑定本 pi 实例，退出即停 | 独立常驻，与 pi 无关 |
| 实现 | 进程内 HTTP 服务 | 独立 node 进程 |

模式 A 命令：

```text
/deepseek-trail start               # 默认 127.0.0.1:7717；端口占用自动降级并提示（只 pi 源）
/deepseek-trail start --codex       # 当前项目 + Codex 源（codex 按当前工作目录过滤）
/deepseek-trail start --all         # 全部项目历史 + 全部可用轨迹源
/deepseek-trail start --port 7799   # 端口也可用 --port 指定，允许与上面两个开关任意组合
/deepseek-trail stop                # 停止服务
```

### 界面能力

- **Agent 选择栏**（最左侧竖条）：每个可用轨迹源一个徽章按钮（π、Codex），有 live 会话时按钮带提示；宿主机上没有的 agent 不显示（`/api/sources` 由服务端探测）；每个源记住自己的选中会话，URL hash（`#a=<源>&s=<会话>&e=<事件>`）让刷新后源、会话、抽屉位置全恢复。
- **会话栏**（deepseek sidebar 风格）：模式 B 按项目分组，分组头可点击折叠（目录名链接色高亮，折叠状态按源隔离）；表头「会话」整块可点，一键展开/收起全部项目分组（本项目范围无分组时置灰）；运行中的会话带 live 亮点；点击切换会话，模式 A 下会话切换（`/new`、`/resume`、`/fork`）不影响服务。
- **问题栏**：问题列表 + 可折叠过滤按钮组（提问/思考/工具/输出/上下文/错误，含「仅思考」等预设），过滤状态与工具排除由服务端 SQLite 持久化；工具排除是全局习惯，不随切会话/切源清空。
- **轨迹区**：按问题 sticky 分段；条目行带类型标签与耗时/token；错误与回合输出高亮；支持轮次折叠与全文搜索。
- **派生会话**（仅 Codex 源）：轨迹里的 `spawn_agent` 调用就是派生行——标签「派生」、预览为本次任务名，位置本身就说明「这次派生发生在哪一轮」；点击进入它派生出的子会话，子会话未落盘时该行退化为普通工具行。子会话的「提问」行展示派发记录（`Message Type` / `Task name` / `Sender`）——任务正文由 Codex 服务端加密，本地只能拿到明文头。`⟨ 主会话` 回到来源会话并定位高亮到那一行。派生行跟着工具过滤走，取消勾选 `spawn_agent` 即可隐藏。（pi 的子代理嵌在父会话内，没有独立会话可跳。）
- **详情弹窗**：点开条目居中弹出，点 ✕ 关闭（点同一行不关、点其他行切换；可拖动、右下角可拖拽放大）；内容含 Markdown 渲染、工具参数/结果、tokens/耗时、子调用；轮询时内容未变不动 DOM，变了也保留滚动位置与已展开的段落。
- **侧边工具条**（抽屉左缘，可收起）：
  - **翻译**：把正文 Markdown 段落与系统上下文的提示词段落逐段翻译（默认微软通道，可切 Google，均免 key），默认双语对照插在原文下方，再点恢复原文；代码/命令/工具输出不翻；设置里可选目标语言（中简/中繁/英/日）与「双语/仅译文」。
  - **复制**：一键复制正文；翻译状态下可选「仅复制译文」或「全部（原文＋译文）」。
  - **设置**：翻译服务、目标语言、显示方式，持久化于服务端全局偏好。
- **搜索**：会话级全文索引（空格分隔 AND，大小写不敏感），与类型/工具过滤取交集；命中词在事件预览、轮次摘要与抽屉正文（参数/结果/命令/输出/提示词段落）中高亮（浅绿底）；预览看不到词时自动展示命中字段的上下文片段（如「结果 » …」）；命中轮次自动展开，无命中轮次整轮隐藏。
- **工具过滤**：工具名子菜单多选（默认全选），工具按归属分组显示——内置 / `MCP: <server>` / 扩展包 / 未识别；归属来自 pi 运行时映射 + 静态扫描合并；「全部反选」的状态跨会话继承。
- 前端 2s 轮询（etag 增量）、会话列表约 6s 刷新、详情按需取全文；服务只读会话文件，仅监听回环地址。

### 对话页（chat）

轨迹页的对话栏可以针对当前轨迹会话直接问 pi：服务端用 `pi --mode rpc` 启动独立子进程，不污染你正在用的 TUI 会话，也不 import pi SDK。对话能力包括：

- **模型**：顶部不再有模型菜单；`/model` 列表是子进程 `get_available_models` 中 provider 属于「显式配置集」的子集，显式配置集 = `<agentDir>/models.json` 的 `providers` 键 ∪ `<agentDir>/auth.json` 中有效登录条目（只认显式配置，环境变量凭据不算；两者都不可用或为空时回退全量并带 warning），当前模型若不在配置集合仍补首位；切换走 `set_model`；当前模型+思考级别以 dsh 的单 trigger 显示（模型名 + 级别 + chevron，模型 root/model/effort 三态），权限 trigger 在 + 右侧；新对话取 pi settings.json 的 defaultProvider/defaultModel（不为显示模型 spawn），响应只保留展示字段，不含 key/baseUrl/headers。
- **技能**：`/skill` 列表来自 `get_commands`；发送时在消息最前拼 `/skill:<name>`，由 pi 原生展开；项目技能默认关闭，打开后按项目 spawn `--skill`。
- **上下文**：勾选轨迹条目后作为 `<trajectory_index>` 清单随消息发送；选中不限条数，清单前 80 条带 preview、之后压缩，超预算提示用 `read_trajectory list` 分页。模型可用只读 `read_trajectory` 工具按 id 取正文（单条 6k / 单次 12k 字符），反选只影响下一轮，不抹除已读历史。chat 模式下 chips 可删但不可新增，需进蒸馏模式勾选。
- **工具 profile**：`no-tools`（仅对话）/ `read-only`（默认，只读轨迹工具 + 读项目文件）/ `full`（可写文件、可跑命令，逐次审批）。全量档支持「本会话允许」，拒绝/超时/断连即不执行。
- **新对话 / 历史对话**：用 `/new` 新建 pi thread，用 `/resume` 打开历史线程列表并切回旧线程（复用 `switch_session`，不新建）；浏览器用服务端 `session_ui` 记住当前线程，未落盘的新线程用 `threadNew` 标记；「以此新开」保留当前上下文选择。
- **进程池**：每轨迹会话一个 child，全局最多 2 个；满时按 `lastUsedAt` 回收最久未用 idle child，15 分钟空闲回收（60 秒扫描一次）；同项目同一时间只允许一个 turn（第二个 409）。
- **安全**：仅监听回环地址；所有 POST 校验 Host/Origin，chat POST 要求 `application/json`，失败 403；请求体 >1MB 413，线程/轨迹文件 >32MB 400；不新增 CORS，OPTIONS 405。非回环监听时 chat 自动禁用，轨迹 viewer 不受影响。
- **存储**：对话线程是独立 pi session，落在 `<chatDir>/<source>/<safeSessionId>/sessions`；`chatDir` 默认 `<agentDir>/pi-chat-helper/chats`，只写这里，删除不影响轨迹历史；`/api/sessions` 与 pi `/resume` 看不到。

#### 控制台转发（独立 / 转发双模式）

侧边对话可以切到「转发」，把问题直接交给当前轨迹会话对应的、已加载 pi-chat-helper 的 pi TUI 控制台；回答和工具审批在控制台完成。

- **模式**：`独立` 使用自己的 RPC 子进程；`转发` 不 spawn child，只把问题作为用户消息送进控制台。模式按 `source:sessionId` 记忆。
- **注册**：插件在交互式 TUI 的 `session_start` 自动注册（不是等 `/deepseek-trail start`）；注册表在 `<agentDir>/pi-chat-helper/consoles/`，bridge 只监听 `127.0.0.1`。`PI_CHAT_HELPER_CONSOLE_BRIDGE=0` 可关闭。
- **状态**：会话列表和侧边分别显示控制台 `working` / `idle` / `offline` / `未检测`；与 session 文件的 `live` 分开。
- **转发**：按精确 `sessionFile` 路由；无控制台/离线/多控制台/会话不匹配拒绝。控制台空闲立即发送；忙碌默认 `followUp` 排队；选择「插话」需自定义确认。侧边只显示转发记录，不镜像控制台回答。
- **安全**：bridge 使用 Bearer token、`0600` 注册文件、仅回环；viewer 的 `/api/chat/forward` 沿用 Host/Origin/JSON、1MB 与 32k prompt 限制；token/port/sessionFile 不返回浏览器。
- **限制**：只支持启动时已加载 pi-chat-helper 的 pi TUI；更早启动的控制台不 retrofit，页面不做终端注入。转发模式不携带侧边上下文、模型、技能、profile，不远程停止/审批；转发记录和草稿只在当前页面内存，不落盘。多个控制台只拒绝转发，不提供选择器。

已知限制：对话页交互已用 headless Chromium 验证，但尚未做真实 Chrome/人工视觉验收；控制台转发只支持已加载插件的 pi TUI，且转发模式不镜像回答/不携带侧边上下文；Codex 的 `read_trajectory` 工具已支持，但 Codex send 上下文链路未做 e2e；`/resume` 只提供线程选择，不支持重命名/删除；不支持图片/语音/多模态输入。旧 pi stderr 错误仅截断、未全量脱敏；进程池内非 turn 读取没有租约，极端情况下可能被容量 LRU 关闭；pi 自身 `/resume` 看不到 chatDir（chatDir 路径隔离与列表排除已测）。

### 轨迹源

| 源 | 位置 | 投影方式 |
|---|---|---|
| pi | `~/.pi/agent/sessions/--<cwd>--/*.jsonl` | 原生解析（分支树、工具配对、用量） |
| Codex | `~/.codex/sessions/年/月/日/rollout-*.jsonl` | 翻译层：rollout 事件流转成 pi 条目流后复用同一投影（消息/思维/工具调用与结果/压缩/模型切换/思考等级（turn_context.effort）；连续上下文注入合并为一条「系统上下文」事件——base_instructions、skills、AGENTS.md、多 agent 说明等按段落名展示，可翻译；子 agent 会话的 `agent_message`（NEW_TASK / MESSAGE）投影为提问行，正文是加密的 `encrypted_content`，只保留 `Message Type` / `Task name` / `Sender` 明文头和一句「本地不可读」说明；跳过 UI 事件流与内部状态） |

列表扫描都只读文件头（pi 256KB、Codex 分块增量到 1MB 早停）并用 mtime+size 缓存；`live` = 30 秒内有写入。Codex 的 `AGENTS.md`/skills 注入消息不算首条提问。

### 对话存储

对话线程是独立的 pi session，落在 `<chatDir>/<source>/<safeSessionId>/sessions`；`chatDir` 默认 `<agentDir>/pi-chat-helper/chats`，删除它不影响轨迹历史。轮次元数据、上下文快照和项目设置存 SQLite（`chat_turn` / `chat_context` / `chat_project`），以 `(source, sessionId, threadId, ordinal)` 等键隔离；同轨迹会话的多个 pi thread 互不覆盖。旧 `turns.jsonl` / `context.*.json` / `settings.json` 首次打开时迁移，之后以 SQLite 为真源。浏览器用服务端 `session_ui` 按 `source:session` 记住当前线程；旧 `tw.chatThread` / `tw.chatThreadNew` / `tw.chatMode` / `tw.chatCtx` 首次加载时迁移。

### 界面风格

全部组件使用 deepseek 设计 token（`web/tokens.css`），复刻自 deepseek-harness 的 `ui-theme`（MIT，上游提交 `571902028a`）：设计平台色板、语义别名、字体/圆角/动效、滚动条与焦点环。暗色由 `body[data-ds-dark-theme]` 承载，默认跟随系统；顶栏主题按钮可循环切换「跟随系统 → 浅色 → 深色」（偏好持久化于服务端全局偏好，首帧由服务端注入 boot 数据防闪屏）。`tokens.css` 是生成产物，请勿手改；更新时回上游同步后重新生成。

## question-panel：TUI 提问面板

`/questions` — 提问列表面板（浮动 overlay，停靠右上角）：

- 单击条目：transcript 跳转到该提问处（复用 pi 内置的 OSC 133 标记定位机制）
- 双击条目 / `d`：进入回合分析视图（思考→工具→输出 节点树 + 详情区，输出节点 Markdown 渲染，`t` 键只看思维链）
- 宽度：`/questions 50`（列数）或 `/questions 60%`（百分比），会话内记忆
- 键盘备用路径：↑↓ 选择、回车跳转、q/Esc 关闭

## 开发与测试

```bash
git clone git:github.com/zhubblego/pi-chat-helper
cd pi-chat-helper

# 开发加载（根 index.ts 是聚合入口，注册 /questions 与 /deepseek-trail）
pi -e .
pi -ne -e .        # 只加载本仓库开发版，不叠加其它已装扩展
```

```bash
# trajectory-web（纯 node，不需要 PI_HOME）
node tests/test-projection.cjs   # 投影：分组/工具配对/统计/分支重建/light 截断
node tests/test-sessions.cjs     # 会话扫描：列表字段/项目范围/尾部会话名/live/排序
node tests/test-chat.cjs         # 对话 host：RPC/线程/SSE/上下文/审批/进程池/安全纯函数
node tests/test-console.cjs      # 控制台桥：注册/心跳/状态/token/forward/转发 client 超时
node tests/test-server.cjs       # HTTP：多会话列表/指定会话/增量/详情/双范围/热更新/对话/控制台/安全/退出
node tests/test-web-lib.cjs      # 前端纯函数：过滤映射/Markdown 转义/会话列表助手/搜索结果高亮切分
node tests/test-codex.cjs        # Codex 轨迹源：rollout 扫描/翻译映射（消息/思维/工具配对/redacted/子 agent 派发任务）/投影复用
node tests/test-tool-origins.cjs # 工具归属静态扫描：分组/保护规则/相似度竞争
node tests/test-state-db.cjs     # SQLite 状态库：schema/WAL/CRUD/旧 JSON 迁移/权限/降级

# trajectory-web 扩展命令（需要 PI_HOME 提供 jiti）
PI_HOME=<pi 安装目录> node tests/test-extension.cjs

# question-panel（无头，需要 PI_HOME）
PI_HOME=<pi 安装目录> node tests/test-question-panel.cjs
PI_HOME=<pi 安装目录> node tests/test-render.cjs
PI_HOME=<pi 安装目录> node tests/test-turn.cjs
PI_HOME=<pi 安装目录> node tests/test-headless-tui.cjs

# 类型检查（仓库无本地 typescript，用 npx 缓存路径）
# 先把 pi 安装目录的依赖链进来（node_modules 已在 .gitignore，tsc/LSP 靠它解析类型）：
#   ln -s <pi 安装目录>/node_modules node_modules
node ~/.npm/_npx/483d2954a4c5190c/node_modules/typescript/bin/tsc -p tsconfig.json
```

环境变量 `PI_HOME` 指向本机 pi 安装目录：旧布局要求 `dist/` 与 `node_modules/` 同在 `PI_HOME` 根。managed install 的 package 目录通常只有自己的 `dist/`，而 `test-turn`/`test-render`/`test-question-panel`/`test-headless-tui` 还需要 `@earendil-works/pi-tui`；可建一个临时 PI_HOME 指向两层：

```bash
mkdir -p /tmp/pi-home
ln -s <pi 安装目录>/node_modules /tmp/pi-home/node_modules
ln -s <pi 安装目录>/node_modules/@earendil-works/pi-coding-agent/dist /tmp/pi-home/dist
PI_HOME=/tmp/pi-home node tests/test-turn.cjs
```


## License

MIT。`trajectory-web/web/tokens.css` 复刻自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `ui-theme`（MIT），上游归属见 [LICENSE](LICENSE)。
