# pi-chat-helper

pi coding agent 的个人扩展集合。

- `trajectory-web/` — **轨迹观察 web 服务**（本分支）：把会话按「问题 → 轨迹条目」两级分组，在浏览器里观察完整上下文。
- `question-panel.ts` — TUI 提问列表面板（`/questions`，main 分支功能）。

## trajectory-web（轨迹观察 web 服务）

浏览器里看一整页会话轨迹：一级是提问（问题 1、问题 2 …，同级分组），二级是该回合内的事件链（提问原文、思维链、工具调用与结果、输出文本、系统提示/压缩/模型切换等上下文事件）。左侧问题栏带一组可折叠的过滤按钮（提问/思考/工具/输出/上下文，含「仅思考」等预设），点条目在右侧抽屉看完整内容（Markdown 渲染、工具参数/结果、tokens 与耗时）。

```text
/deepseek-trail start          # 启动服务（默认 127.0.0.1:7717），浏览器打开提示的 URL
/deepseek-trail start 8899     # 指定端口
/deepseek-trail stop           # 停止服务并清理运行时状态
```

- **独立后台进程**：服务 detached 起在 pi 之外，pi 退出、`/new`、重开会话都不影响页面；只读会话 JSONL，不写回、不改上下文。
- **增量刷新**：页面每 2s 轮询，会话在终端里继续推进时轨迹自动更新；重字段在列表里截断，点开详情时按需拉全文。
- **幂等与安全**：重复 `/deepseek-trail start` 只提示当前 URL；服务在观察别的会话时提示先 `/deepseek-trail stop` ；终止前用 `/proc/<pid>/cmdline` 核实进程归属，避免 pid 复用误杀。
- 运行时状态在 `~/.pi/agent/trajectory-web/`（state.json、server.log）。

### 部署与开发

源码主本在本仓库；目录即扩展（入口 `trajectory-web/index.ts`）：

```bash
# 部署（新开会话生效）
cp -r trajectory-web ~/.pi/agent/extensions/

# 开发时加载仓库开发版（根 index.ts 是聚合入口，注册 /questions、/deepseek-trail）
pi -e .
# 只加载本仓库开发版、不叠加已装扩展（避免重名命令被拆成 /name:1、/name:2）：
pi -ne -e .

# 只加载单个扩展：
pi -e ./trajectory-web     # 或 pi -e ./trajectory-web/index.ts
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
PI_HOME=/home/bbz/.nvm/versions/node/v22.19.0/lib/node_modules/@earendil-works/pi-coding-agent

# trajectory-web（纯 node，不需要 PI_HOME）
node tests/test-projection.cjs   # 投影：分组/工具配对/统计/分支重建/light 截断
node tests/test-server.cjs       # HTTP：健康/增量轮询/静态资源/详情/热更新/SIGTERM
node tests/test-web-lib.cjs      # 前端纯函数：过滤映射/Markdown 转义与渲染

# trajectory-web 扩展命令（需要 PI_HOME 提供 jiti；临时 HOME 隔离状态）
PI_HOME=$PI_HOME node tests/test-extension.cjs

# question-panel（无头，需要 PI_HOME）
node tests/test-question-panel.cjs
node tests/test-render.cjs
node tests/test-turn.cjs
node tests/test-headless-tui.cjs

# 类型检查
node ~/.npm/_npx/483d2954a4c5190c/node_modules/typescript/bin/tsc -p tsconfig.json
```

环境变量 `PI_HOME` 指向本机 pi 安装目录（含 jiti 与 pi-tui）。
