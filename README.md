# pi-chat-helper

**中文** ｜ [English](README.en.md)

[pi coding agent](https://github.com/earendil-works/pi-coding-agent) 扩展包：**在浏览器里完整回看会话轨迹**（trajectory-web），**在 TUI 里快速跳转历史提问**（question-panel）。轨迹观察不只支持 pi——宿主机上有哪个 agent 的会话，左侧 Agent 选择栏就亮哪个按钮（当前支持 pi 与 Codex）。

![浅色主题](screenshots/light.png)

*浅色主题：会话栏 ＋ 问题栏 ＋ 按提问分段的轨迹，工具调用与结果成对展示*

![深色主题](screenshots/dark.png)

*深色主题：详情弹窗——Markdown 表格与 mermaid 图表渲染，主题跟随系统也可手动指定*

## 主要功能

### 轨迹回看 · trajectory-web

- **按提问分段的完整轨迹**：左侧会话栏（模式 B 按项目分组，运行中会话带 live 徽标）＋问题栏，右侧轨迹按提问分段——提问原文、思维链、工具调用与结果、输出、错误、系统上下文事件成链展示；错误与回合输出高亮，轮次可折叠；前端每 2 秒增量刷新。
- **详情弹窗**：点击任意条目居中弹出，Markdown 渲染（markdown-it：GFM 表格、任务列表、删除线），```mermaid``` 代码块自动渲染为 SVG 图表（懒加载、失败保留源码）；工具参数/结果、tokens 与耗时、子调用一应俱全；弹窗可拖动、右下角可拖拽放大。
- **多 agent 源**：pi 原生解析（分支树、工具配对、用量统计）＋ Codex 翻译层（消息、思维、工具配对、压缩、模型切换、思考等级）；Agent 选择栏自动亮出宿主机上全部可用源，URL hash 记住源/会话/详情位置，刷新后全部恢复。
- **派生会话跳转**（Codex 源）：轨迹里的 `spawn_agent` 调用就是派生行，点击进入它派生出的子会话，`⟨ 主会话` 回到来源会话并定位高亮；pi 的子代理嵌在父会话内，无需跳转。
- **搜索与过滤**：会话级全文索引（空格 AND、大小写不敏感、命中高亮、无命中的轮次自动隐藏）；问题栏过滤按钮组（提问/思考/工具/输出/上下文/错误）＋工具名多选过滤（按内置 / `MCP:` / 扩展包分组）。
- **翻译与复制**：正文 Markdown 段落与系统提示词逐段翻译（微软 / Google 双通道，免 key），双语对照或仅译文，目标语言中简/中繁/英/日四选；一键复制原文或译文。
- **习惯持久化**：过滤状态、工具排除、主题、翻译偏好由服务端 SQLite 持久化，跨会话、跨源继承。
- **深浅双主题**：deepseek 风格设计 token，跟随系统或手动切换，首帧由服务端注入防闪屏。

### 对话页 · chat

在浏览器里针对任意轨迹会话直接问 pi——不污染你正在用的 TUI 会话：

- **独立 RPC 子进程**：服务端用 `pi --mode rpc` 启动子进程应答；`/new` 新建线程、`/resume` 切回历史线程；每个轨迹会话一个子进程，全局最多 2 个，空闲 15 分钟自动回收。
- **上下文即工具**：勾选轨迹条目作为 `<trajectory_index>` 清单随消息发送，模型通过只读 `read_trajectory` 工具按 id 取正文（单条 6k / 单次 12k 字符）；pi 与 Codex 源都支持。
- **模型与技能**：`/model` 列出显式配置集内的可用模型并可切换（当前模型＋思考级别单按钮显示）；`/skill` 复用 pi 原生命令展开，项目技能可选开启。
- **工具三档 profile**：`no-tools`（仅对话）/ `read-only`（默认，只读轨迹工具＋读项目文件）/ `full`（可写文件、可跑命令，逐次审批）。
- **控制台转发**：切换「转发」把提问直接送进已加载本插件的 pi TUI 控制台，回答与工具审批都在控制台完成；控制台空闲立即发送、忙碌默认排队（可选插话）、多控制台弹候选选择；「独立 / 转发」单钮切换。
- **线程独立落盘**：对话线程是独立的 pi session（`<agentDir>/pi-chat-helper/chats`），pi 自身 `/resume` 看不到；删除它不影响轨迹历史。
- **安全默认**：只监听回环地址，POST 校验 Host/Origin；非回环监听时对话自动禁用（轨迹回看不受影响）。

### TUI 提问面板 · question-panel

`/questions` 打开浮动面板（停靠右上角）：单击条目，transcript 直接跳回那一问；双击 / `d` 进入回合分析视图（思考→工具→输出节点树，`t` 键只看思维链）；`/questions 50`（列数）或 `/questions 60%`（百分比）调宽度；↑↓ 选择、回车跳转、q / Esc 关闭。

## 安装

```bash
pi install git:github.com/zhubblego/pi-chat-helper
# 或已发布到 npm：
pi install npm:pi-chat-helper
```

新开会话生效。`pi list` 查看已装扩展包，`pi remove git:github.com/zhubblego/pi-chat-helper` 移除。

运行环境要求 **Node >= 22.19**（状态库使用 `node:sqlite`）。

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

**２．浏览器里看会话轨迹**

```text
/deepseek-trail start               # 默认 127.0.0.1:7717，当前项目全部会话（端口占用自动降级并提示）
/deepseek-trail start --codex       # 当前项目：pi + Codex（codex 按当前工作目录过滤）
/deepseek-trail start --all         # 全部项目历史 + 全部可用轨迹源
/deepseek-trail start --port 7799   # 端口可与上面两个开关任意组合
/deepseek-trail stop                # 停止服务
```

也可以脱离 pi 跑独立服务，观察**全部 pi 历史**与运行中会话（按项目分组、live 徽标），以及本机 **Codex 历史**：

```bash
npm run dev        # 默认 http://127.0.0.1:7788
# 等价：node trajectory-web/server/main.mjs --scope all --port 7788
```

## 两种启动模式

|  | 模式 A（pi 插件） | 模式 B（独立 web server） |
|---|---|---|
| 启动 | pi 内执行 `/deepseek-trail start [端口] [--codex] [--all]` | `npm run dev`（默认 7788） |
| 范围 | 缺省当前项目的全部会话；`--all` 同模式 B（全部历史） | 全部 pi 历史 + 运行中的会话（按项目分组） |
| 轨迹源 | 缺省只开放 pi；`--codex` 加 Codex，`--all` 全部可用源 | 列出宿主机上全部可用 agent（pi、Codex…） |
| 生命周期 | 绑定本 pi 实例，退出即停 | 独立常驻，与 pi 无关 |
| 实现 | 进程内 HTTP 服务 | 独立 node 进程 |

## 轨迹源

| 源 | 位置 | 投影方式 |
|---|---|---|
| pi | `~/.pi/agent/sessions/--<cwd>--/*.jsonl` | 原生解析（分支树、工具配对、用量） |
| Codex | `~/.codex/sessions/年/月/日/rollout-*.jsonl` | 翻译层：rollout 事件流转成 pi 条目流后复用同一投影（消息、思维、工具配对、压缩、模型切换、思考等级）；连续上下文注入合并为一条「系统上下文」事件；跳过 UI 事件流与内部状态 |

列表扫描只读文件头（pi 256KB、Codex 分块增量早停）并用 mtime+size 缓存；`live` = 30 秒内有写入。服务只读会话文件，仅监听回环地址。

## 已知限制

- 对话页交互已用 headless Chromium 自动化验证，尚未做真实 Chrome 人工视觉验收。
- 控制台转发只支持启动时已加载 pi-chat-helper 的 pi TUI（旧控制台不 retrofit）；转发模式不镜像控制台回答，不携带侧边上下文、模型、技能、profile。
- Codex 的 `read_trajectory` 工具已支持，但 Codex send 上下文链路未做 e2e。
- `/resume` 只提供线程选择，不支持重命名/删除；不支持图片/语音/多模态输入。

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

MIT。`trajectory-web/web/tokens.css` 复刻自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `ui-theme`（MIT，上游提交 `571902028a`），上游归属见 [LICENSE](LICENSE)；它是生成产物，请勿手改。
