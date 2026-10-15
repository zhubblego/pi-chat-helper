# ROADMAP

## 当前阶段

分支 `feat/trajectory-web`：双启动模式与 deepseek 风格复刻已完成，自动化验证全绿；浏览器视觉/交互与真实 pi 体验待主人确认。

## 已完成（均有自动化验证依据）

### trajectory-web 数据与服务端

- 投影层 `server/session.mjs`：会话 JSONL → 活动分支（parentId 回溯）→ 按提问两级分组 → 事件链（提问/思维/工具+结果/bash/系统上下文/压缩/分支/模型/思考等级/用量/上下文编辑/自定义），工具配对、回合末输出标记、分组统计、light/full 两档、按 id 查详情
- 会话扫描 `server/sessions.mjs`：项目或全局范围；头 256KB + 尾 64KB 轻量解析（cwd/首条消息/会话名），mtime+size 缓存，live = 30s 内有写入，按最近活跃排序
- HTTP 服务 `server/app.mjs`：多会话（scope `project`/`all`）、`/api/sessions` 列表、`/api/session?id=` 按会话投影（etag 增量）、`/api/event?session=` 详情、LRU 4 缓存；`main.mjs` 为薄 CLI（`--scope/--session/--sessions-root/--port/--web`）
- 只读会话、仅监听回环地址

### 双启动模式（已确认需求）

- **模式 A（pi 插件，绑定实例）**：`/deepseek-trail start [端口]` 为**进程内**服务，范围 = 当前项目全部会话；句柄挂 `globalThis` 槽位，跨扩展 runtime 复用——换会话（`new`/`resume`/`fork`）服务存活，`quit`/`reload` 关闭；端口占用自动降级为系统分配端口并在提示里给出实际 URL；`stop` 关闭
- **模式 B（独立 web server）**：`npm run dev`（新增 `package.json`）以 `--scope all` 启动，观察全部 pi 历史与运行中会话（按项目分组、live 徽标），与 pi 生命周期无关

### UI（deepseek 风格统一）

- 复刻 deepseek `ui-theme` 样式为 `web/tokens.css`（MIT，上游提交 `571902028a`：设计平台色板 + 语义别名 + 字体/圆角/动效 + 滚动条 + 焦点环），`web/style.css` 全部组件改用 `--dsw-*` token
- 新增 deepseek 风格**会话侧边栏**：模式 B 按项目分组、live 亮点、相对时间、文件大小；点击切换会话
- 保留两级轨迹（问题 sticky 分段 + 事件行）与过滤按钮组（提问/思考/工具/输出/上下文 + 预设）；详情抽屉 Markdown/参数/结果/tokens
- 暗色由 `body[data-ds-dark-theme]` 承载，默认跟随系统

### 测试

- 9 套全绿：projection / sessions / server / web-lib / extension + question-panel 四套回归；`tsc` 零错误
- 真实环境验证：`pi -ne -e .` 加载 0 失败；`npm run dev` 起模式 B（465 会话、live 1、tokens 608 变量）

## 待确认（未验证，不能算完成）

- 浏览器实际视觉与交互：会话栏分组/live 点、token 化后的轨迹行与抽屉、暗色模式——本环境无浏览器，需主人打开页面确认
- 模式 A 真实体验：在 pi 里 `/deepseek-trail start` 后换会话（`/new`）服务是否如预期存活、`quit` 是否正确关闭
- WSL2 下 Windows 浏览器访问 `http://127.0.0.1:7717`（模式 A）与 `:7788`（模式 B）

## 待办（候选，按需）

- 轨迹时间概览条（pi 数据无 TTFT，只能近似）
- 条目搜索、长会话虚拟滚动、问题级折叠
- 会话管理入口（重命名/删除）、会话列表搜索
- 手动主题切换（当前跟随系统）

## 最近验证

2026-10-15：9 套测试全绿（含新增 sessions 扫描与重写的 server/extension）；`tsc -p tsconfig.json` 零错误；真实 pi `pi -ne -e .` 退出码 0 且零加载失败；`npm run dev` 成功启动模式 B 并返回 465 个会话、tokens.css 608 变量。
