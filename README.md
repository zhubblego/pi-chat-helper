# pi-chat-helper

pi coding agent 的个人扩展集合。当前包含 `question-panel.ts`（提问列表面板）。

## question-panel

`/questions` — 提问列表面板（浮动 overlay，停靠右上角）：

- 单击条目：transcript 跳转到该提问处（复用 pi 内置的 OSC 133 标记定位机制）
- 双击条目 / `d`：进入回合分析视图（思考→工具→输出 节点树 + 详情区，输出节点 Markdown 渲染，`t` 键只看思维链）
- 宽度：`/questions 50`（列数）或 `/questions 60%`（百分比），会话内记忆
- 键盘备用路径：↑↓ 选择、回车跳转、q/Esc 关闭

## 部署与开发

生效位置在 pi 用户扩展目录；本仓库是源码主本：

```bash
# 改动后部署（新开会话生效）
cp question-panel.ts ~/.pi/agent/extensions/

# 开发时直接加载指定文件
pi --extension ./question-panel.ts
```

## 测试

无需 pi 运行时，全部无头执行：

```bash
PI_HOME=/home/bbz/.nvm/versions/node/v22.19.0/lib/node_modules/@earendil-works/pi-coding-agent

# 单元：提问收集 / 标记序号推算
node tests/test-question-panel.cjs

# 面板渲染断言（边框/宽度/命中区域）
node tests/test-render.cjs

# 回合分析：buildTurn 数据 + 回合视图交互
node tests/test-turn.cjs

# 无头真渲染：假终端跑 TuiAltScreen，验证 transcript 定位与跳转
node tests/test-headless-tui.cjs

# 类型检查（需 tsconfig，tsc 在 typescript 包里）
npx tsc -p tsconfig.json
```

环境变量 `PI_HOME` 指向本机 pi 安装目录（含 jiti 与 pi-tui）。
