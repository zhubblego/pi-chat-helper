# pi-chat-helper

pi coding agent 的个人扩展集合。

- `trajectory-web/` — 轨迹观察 web 服务（两种启动方式：pi 插件 / 独立 web server）
- `question-panel.ts` — TUI 提问列表面板（`/questions`）

## trajectory-web

浏览器里看一整页会话轨迹：左侧会话栏 + 问题栏（含过滤按钮组），右侧轨迹按问题分段。一级是提问（问题 1、问题 2 …，同级分组），二级是该回合内的事件链（提问原文、思维链、工具调用与结果、输出文本、系统提示/压缩/模型切换等上下文事件）。条目点击开详情抽屉：Markdown 渲染、工具参数/结果、tokens 与耗时、子调用。

### 两种启动方式

|  | 模式 A（pi 插件） | 模式 B（独立 web server） |
|---|---|---|
| 启动 | pi 内执行 `/deepseek-trail start [端口]` | `npm run dev`（默认 7788） |
| 范围 | 当前项目的全部会话 | 全部 pi 历史 + 运行中的会话（按项目分组） |
| 生命周期 | 绑定本 pi 实例，退出即停 | 独立常驻，与 pi 无关 |
| 实现 | 进程内 HTTP 服务 | 独立 node 进程 |

模式 A 命令：

```text
/deepseek-trail start          # 默认 127.0.0.1:7717；端口占用自动降级并提示
/deepseek-trail stop           # 停止服务
```

界面：

- **会话栏**（deepseek sidebar 风格）：模式 B 按项目分组；运行中的会话带 live 亮点；点击切换会话，模式 A 下会话切换（`/new`、`/resume`、`/fork`）不影响服务。
- **问题栏**：问题列表 + 可折叠过滤按钮组（提问/思考/工具/输出/上下文，含「仅思考」等预设），过滤状态持久化。
- **轨迹区**：按问题 sticky 分段；条目行带类型标签与耗时/token；错误与回合输出高亮。
- 前端 2s 轮询（etag 增量）、会话列表约 6s 刷新、详情按需取全文；服务只读会话 JSONL，仅监听回环地址。

### 界面风格

全部组件使用 deepseek 设计 token（`web/tokens.css`），复刻自 deepseek-harness 的 `ui-theme`（MIT，上游提交 `571902028a`）：设计平台色板、语义别名、字体/圆角/动效、滚动条与焦点环。暗色由 `body[data-ds-dark-theme]` 承载，默认跟随系统。`tokens.css` 是生成产物，请勿手改；更新时回上游同步后重新生成。

### 部署与开发

```bash
# 部署（新开会话生效）
cp -r trajectory-web ~/.pi/agent/extensions/

# 开发时加载仓库开发版（根 index.ts 是聚合入口，注册 /questions 与 /deepseek-trail）
pi -e .
pi -ne -e .        # 只加载本仓库开发版，不叠加其它已装扩展

# 模式 B：独立服务（全部历史，默认端口 7788）
npm run dev
# 等价：node trajectory-web/server/main.mjs --scope all --port 7788
# 项目范围：node trajectory-web/server/main.mjs --scope project --session <会话文件> --port 7717
```

## question-panel

`/questions` — 提问列表面板（浮动 overlay，停靠右上角）：

- 单击条目：transcript 跳转到该提问处（复用 pi 内置的 OSC 133 标记定位机制）
- 双击条目 / `d`：进入回合分析视图（思考→工具→输出 节点树 + 详情区，输出节点 Markdown 渲染，`t` 键只看思维链）
- 宽度：`/questions 50`（列数）或 `/questions 60%`（百分比），会话内记忆
- 键盘备用路径：↑↓ 选择、回车跳转、q/Esc 关闭

```bash
cp question-panel.ts ~/.pi/agent/extensions/
```

## 测试

```bash
# trajectory-web（纯 node，不需要 PI_HOME）
node tests/test-projection.cjs   # 投影：分组/工具配对/统计/分支重建/light 截断
node tests/test-sessions.cjs     # 会话扫描：列表字段/项目范围/尾部会话名/live/排序
node tests/test-server.cjs       # HTTP：多会话列表/指定会话/增量/详情/双范围/热更新/退出
node tests/test-web-lib.cjs      # 前端纯函数：过滤映射/Markdown 转义/会话列表助手

# trajectory-web 扩展命令（需要 PI_HOME 提供 jiti）
PI_HOME=<pi 安装目录> node tests/test-extension.cjs

# question-panel（无头，需要 PI_HOME）
PI_HOME=<pi 安装目录> node tests/test-question-panel.cjs
PI_HOME=<pi 安装目录> node tests/test-render.cjs
PI_HOME=<pi 安装目录> node tests/test-turn.cjs
PI_HOME=<pi 安装目录> node tests/test-headless-tui.cjs

# 类型检查（仓库无本地 typescript，用 npx 缓存路径）
node ~/.npm/_npx/483d2954a4c5190c/node_modules/typescript/bin/tsc -p tsconfig.json
```

环境变量 `PI_HOME` 指向本机 pi 安装目录（含 jiti 与 pi-tui）。
