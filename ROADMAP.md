# ROADMAP

## 当前阶段

分支 `feat/trajectory-web`：轨迹观察 web 服务已实现，自动化验证全绿；浏览器人工验证与部署待主人确认。

## 已完成（均有自动化验证依据）

### trajectory-web（轨迹观察 web 服务）

- 数据投影层 `trajectory-web/server/session.mjs`：会话 JSONL → 活动分支（parentId 回溯）→ 按提问两级分组 → 事件链（提问/思维/工具+结果/bash/系统上下文/压缩/分支/模型/思考等级/用量/上下文编辑/自定义），工具调用与结果配对、回合末 text 标 isFinal、分组与全局统计（tokens/cost/耗时/工具/错误）、light（截断）/full 两档与按 id 查详情
- HTTP 服务 `trajectory-web/server/main.mjs`：零依赖；静态页 + `/api/session`（mtime+size etag 增量）+ `/api/event`（full 详情）+ `/api/health`；监听后写 state 文件，SIGTERM 清理；仅回环地址、只读会话
- Web UI `trajectory-web/web/`：左侧问题栏（可折叠过滤按钮组：提问/思考/工具/输出/上下文 + 预设「全部/仅思考/仅工具/仅输出」，状态持久化）+ 右侧整页轨迹（问题 sticky 分段、条目行、错误/输出高亮）+ 详情抽屉（Markdown、工具参数/结果、tokens/耗时/模型）；2s 轮询增量，滚动位置与过滤状态保持；DOM 构建不走 innerHTML，Markdown 先转义再生成自有标签
- pi 扩展 `trajectory-web/index.ts`：单命令 `/deepseek-trail`（子命令 `start [端口]`，默认 7717，独立 detached 后台进程，幂等、跨会话检测、健康等待；`stop` 经 `/proc/<pid>/cmdline` 归属校验后 SIGTERM→SIGKILL 并清理 state；带 start/stop 参数补全）
- 测试：`tests/test-projection.cjs`、`tests/test-server.cjs`、`tests/test-web-lib.cjs`、`tests/test-extension.cjs` 四套全绿；`tsc -p tsconfig.json` 严格模式零错误；question-panel 旧四套回归全绿

### question-panel（main 分支，本分支仅保留源码）

- `/questions` 面板：提问列表、跳转、回合分析视图（思考→工具→输出）
- tests/ 四套无头测试全绿

## 待确认（未验证，不能算完成）

- 浏览器实际渲染与交互：两级分组视觉、过滤按钮组、详情抽屉 Markdown、sticky 段头、暗色模式——本环境无浏览器，需主人打开页面确认（抽屉卡死已修，见下）
- 部署链路：`cp -r trajectory-web ~/.pi/agent/extensions/` 后新开 pi 会话执行 `/deepseek-trail start` 的真实体验；WSL2 下 Windows 浏览器访问 `http://127.0.0.1:7717`
- 行为约定：compaction（压缩）目前挂在上一回合尾部显示，如希望改为下一回合开头（"进入本回合前的压缩"）需明确

## 待办（候选，按需）

- 轨迹页时间概览条（按条目时间/耗时投影；pi 数据无 TTFT，只能近似）
- 会话列表与多会话切换（当前服务只观察启动它的那个会话）
- 长会话虚拟滚动、条目搜索、问题级折叠
- 请求级上下文快照（每次 LLM 调用实际看到的完整消息列表）
- 严格主从布局（左问题、右只显示选中问题的轨迹）

## 最近验证

2026-10-15：抽屉 Markdown 桥接 `importNode` 死循环（点击提问/思考/输出等条目冻死页面）已修为直接 `appendChild`；`test-web-lib.cjs` 增加两条源码级回归守卫；扩展集成测试改随机空闲端口，不再与运行中的 7717 服务撞车；四套测试全绿；`tsc -p tsconfig.json` 零错误；已确认运行中服务端出的 app.js 无 `importNode`。
