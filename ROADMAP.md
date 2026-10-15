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
- 保留两级轨迹（问题 sticky 分段 + 事件行）；详情抽屉 Markdown/参数/结果/tokens
- **工具条**（复刻 deepseek `TrajectoryToolbar` 形态，不含时长控件）：「轮次」折叠按钮（⊟/⊞ 全部折叠/展开）+ 单个「过滤」按钮（显示 `过滤 n/5` 计数）——点击弹 deepseek 紧凑菜单卡（复刻 `Menu.module.css` + `MenuSurface`：4px 内边距、半透明底 + backdrop-filter、elevation-prominent）：显示类型 5 项为勾选菜单项（尾部勾 + `menuitemcheckbox`/`aria-checked`）；勾选后菜单保持打开可连续切换，关闭仅靠点菜单外 / Esc / 切换会话；支持 ↑↓/Home/End
- **轮次折叠**：点击问题头部的 ⊟/⊞ 折叠单轮，工具条按钮折叠全部；折叠仅隐藏正文，sticky 头仍可用于导航
- **搜索**（复刻 deepseek `trajectory-search-index.ts`）：工具条搜索框（照搬其 search 规格）；会话级增量全文索引，按事件稳定 id 缓存来源数组、空格分隔 AND 匹配、大小写不敏感，切换会话重建
- **时长格式**（复刻 `trajectory-record.ts` 的 `formatDurationMillis`/`formatElapsedSeconds`）：整数毫秒 + 千分位，未知显示 `—`
- 样式复刻清单：`tokens.css` 整份 token 层、工具条/搜索/会话侧栏 CSS 均照搬 deepseek 规格；**例外（不可移植）**：Markdown 渲染与 JSON 展示自研——源码为 React 组件 + mdast/shiki/katex 依赖链
- 暗色由 `body[data-ds-dark-theme]` 承载，默认跟随系统

### 测试

- 9 套全绿：projection / sessions / server / web-lib / extension + question-panel 四套回归；`tsc` 零错误
- 真实环境验证：`pi -ne -e .` 加载 0 失败；`npm run dev` 起模式 B（465 会话、live 1、tokens 608 变量）

## 待确认（未验证，不能算完成）

- 浏览器实际视觉与交互：会话栏分组/live 点、token 化后的轨迹行与抽屉、暗色模式——本环境无浏览器，需主人打开页面确认
- 模式 A 真实体验：在 pi 里 `/deepseek-trail start` 后换会话（`/new`）服务是否如预期存活、`quit` 是否正确关闭
- WSL2 下 Windows 浏览器访问 `http://127.0.0.1:7717`（模式 A）与 `:7788`（模式 B）

## 待办（候选，按需）

- 轨迹时间概览条（pi 数据无 TTFT，只能近似；主人已明确暂不需要时长维度）
- 长会话虚拟滚动（源码用 @tanstack/react-virtual，不可直接移植，需照逻辑自研）
- JSON 树形展示（源码 JsonTree 是 React 组件，可照其结构自研）
- 会话管理入口（重命名/删除）、会话列表搜索
- 手动主题切换（当前跟随系统）

## 最近验证

2026-10-15：9 套测试全绿；页面输出核验：轮次按钮保留、过滤按钮+菜单容器就位、旧按钮组已移除、菜单勾选语义/键盘导航/样式复刻均通过；`tsc` 零错误；真实 pi `pi -ne -e .` 零加载失败；`npm run dev` 起模式 B（465 会话）。本轮按「能搬不写」移植：过滤下拉菜单复刻 deepseek Menu（紧凑卡 + MenuSurface + menuitemcheckbox 勾选语义 + 方向键导航）。
