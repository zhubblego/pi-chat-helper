# ROADMAP

## 当前阶段

分支 `feat/trajectory-web`：双启动模式与 deepseek 风格复刻已完成，自动化验证全绿；已按 pi package 标准化并推送 GitHub（main 已同步）；浏览器视觉/交互与真实 pi 体验待主人确认。

## 已完成（均有自动化验证依据）

### pi package 标准化与发布（2026-10-15）

- `package.json` 对齐 pi package 规范：`pi.extensions` 清单（入口 `./index.ts`）、`pi-package` 关键字（gallery 可发现）、`type: module`、`repository/homepage/bugs`、`engines`、宿主包 `peerDependencies`（`pi-coding-agent`/`pi-tui`，`*` 区间，optional meta）、版本 0.2.0
- README 重写为标准结构：`pi install git:` 安装 → 快速上手（`/questions`、`/deepseek-trail`、`npm run dev`）→ 两功能详情 → 开发与测试 → License；删除手工 `cp -r` 部署方式
- 已推送 GitHub `zhubblego/pi-chat-helper`；后按主人要求：main 退回原位并由其自管，仓库 git 身份改 noreply 匿名邮箱，提交历史重写后 force-push 两分支，GitHub 默认分支已切至 `feat/trajectory-web`
- `package.json` 增加 `files` 裁剪 npm 发布内容（排除 tests/、ROADMAP、tsconfig、.pi/，29→17 文件）
- npm 发布前隐私审计：个人路径/邮箱/电话/密钥均零命中，LICENSE 匿名署名，上游归属完整
- npm 发布 `0.2.0`：新账号无 2FA 禁止直发，细粒度令牌为 stage-only 档 → 发布进暂存区（占位版 0.0.0-stage）→ 自动化安全审查通过后 0.2.0 上线，`latest` 标签正确

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
- **工具条**（复刻 deepseek `TrajectoryToolbar` 形态，不含时长控件）：「轮次」折叠按钮（⊟/⊞ 全部折叠/展开）+ 单个「过滤」按钮（显示 `过滤 n/5` 计数）——点击弹 deepseek 紧凑菜单卡（复刻 `Menu.module.css` + `MenuSurface`：4px 内边距、elevation-prominent；底色按主人要求由半透明磨砂改为不透明层底 `bg-layer-2`）：显示类型 5 项为勾选菜单项（尾部勾 + `menuitemcheckbox`/`aria-checked`）；勾选后菜单保持打开可连续切换，关闭仅靠点菜单外 / Esc / 切换会话；支持 ↑↓/Home/End
- **工具名子菜单**（复刻 deepseek Menu 的 `.submenu`：右侧卡片 + 10px 命中桥；长列表改**顶部锚定 + 内层 `.menu-viewport` 滚动**——deepseek 的 bottom 锚定会让长列表向上长出视口，顶部条目不显示）：「工具」行是**子菜单父行**（`menuitem` + `aria-haspopup`，无勾选标记与行上值，尾部 ▸ 按钮感提示），点击 / hover 150ms / → 打开；子菜单为「全部 / 工具名…」**多选**（`menuitemcheckbox`；勾选模型是**排除集**——默认全部勾选，「全部」= 全选开关（全勾↔全不勾），新出现的工具默认勾选），工具名取自当前会话出现过的调用（按首次出现去重）；打开菜单与数据到达时同步；←/Esc 退回，勾选后保持打开；过滤只作用于工具调用行；「过滤 n/N」计数只算四个开关
- **工具名按归属分组**（子菜单内）：`内置` / `MCP: <server>` / 各扩展包名 / `未识别`，**只渲染非空分组**（会话里没出现过的工具不产生空组）；归属来源：模式 A 用 pi 运行时精确映射（实测 `pi.getAllTools()[].sourceInfo` = `{path,source,scope,origin,baseDir}`，内置 `source:"builtin"`、npm 包 `source:"npm:<pkg>"`）；**每次请求现取**（提供者函数）并与静态扫描合并、精确优先——2026-10-15 实测 `getAllTools()` 在会话启动时（以及 4 秒后）都不含 context-mode 的 `ctx_*`（运行时按需注册，55 个工具里一个没有），快照式映射会漏掉它们；前端遇未归属名字时也会强制刷新（60s 冷却），模式 B 用 `server/tool-origins.mjs` 静态扫描安装目录（`/api/tool-origins`，缓存 5 分钟；CLI 可给 `--agent-dir/--pi-dir`）；MCP 按 `mcp__<server>__` 前缀归组；**放宽规则**：含 registerTool 的文件里同时收集形如工具名的字符串字面量，覆盖 `registerActionTool("add", "memory_add", …)` 这类帮助函数式注册；两条保护：内置短名（read/bash…）不被扩展杂项字面量覆盖、多包竞争同名按「名字分词 vs 包名」相似度择优。实测本机 14 个工具全部归类、无「未识别」分组（映射 3089 条/约 165KB，5 分钟缓存）
- **轮次折叠**：点击问题头部的 ⊟/⊞ 折叠单轮，工具条按钮折叠全部；折叠仅隐藏正文，sticky 头仍可用于导航
- **搜索**（复刻 deepseek `trajectory-search-index.ts`）：工具条搜索框（照搬其 search 规格）；会话级增量全文索引，按事件稳定 id 缓存来源数组、空格分隔 AND 匹配、大小写不敏感，切换会话重建
- **时长格式**（复刻 `trajectory-record.ts` 的 `formatDurationMillis`/`formatElapsedSeconds`）：整数毫秒 + 千分位，未知显示 `—`
- 样式复刻清单：`tokens.css` 整份 token 层、工具条/搜索/会话侧栏 CSS 均照搬 deepseek 规格；**例外（不可移植）**：Markdown 渲染与 JSON 展示自研——源码为 React 组件 + mdast/shiki/katex 依赖链
- 暗色由 `body[data-ds-dark-theme]` 承载，默认跟随系统

### 测试

- 9 套全绿：projection / sessions / server / web-lib / extension + question-panel 四套回归；`tsc` 零错误
- 真实环境验证：`pi -ne -e .` 加载 0 失败；`npm run dev` 起模式 B（465 会话、live 1、tokens 608 变量）

### README 截图（2026-10-16）

- 合成演示会话（虚构 landing-page 项目：响应式修复＋跑测试＋换品牌蓝三问，含思维链/工具配对/模型切换/tokens）用专用 sessions-root 服务，不涉真实会话；用 code-miner 项目的 playwright 1.60（本机已装 chromium-1223，npx 最新版要求 1248 不匹配）无头截亮/暗两张 1680×1050
- DOM 断言验证：会话名/项目/问题/工具调用/模型切换/tokens 均渲染，暗色仅在 color-scheme=dark 时挂 data-ds-dark-theme，零 JS 报错
- 截图入库 docs/screenshots/，README 用 GitHub raw 绝对地址引用；jsDelivr 本机不可达故未用作图源

- 0.2.1 发布：含截图 README 进入 npm 包页（0.2.0 包页为纯文字版）；版本号随发布升位

## 待确认（未验证，不能算完成）

- ~~浏览器实际视觉与交互~~：2026-10-16 主人目检亮/暗两张截图确认通过（会话栏/轨迹行/暗色）
- 模式 A 真实体验：在 pi 里 `/deepseek-trail start` 后换会话（`/new`）服务是否如预期存活、`quit` 是否正确关闭
- WSL2 下 Windows 浏览器访问 `http://127.0.0.1:7717`（模式 A）与 `:7788`（模式 B）

## 待办（候选，按需）

- 轨迹时间概览条（pi 数据无 TTFT，只能近似；主人已明确暂不需要时长维度）
- 长会话虚拟滚动（源码用 @tanstack/react-virtual，不可直接移植，需照逻辑自研）
- JSON 树形展示（源码 JsonTree 是 React 组件，可照其结构自研）
- 会话管理入口（重命名/删除）、会话列表搜索
- 手动主题切换（当前跟随系统）

## 最近验证

2026-10-16（晚）：0.2.1 经自动审查后上线，`npm view` 确认 latest 指向 0.2.1，npm 包页 README 开始携带截图；小红书首篇笔记文案已交付主人待发。

2026-10-16（截图）：无头截图两张（1680×1050 亮/暗），两主题 DOM 断言全过、零 JS 报错，已随 README 推送 GitHub（6a025ea）；演示服务已停止、端口已释放。截图主观美观度待主人目检。

2026-10-16：npm 端到端——`npm view pi-chat-helper` 确认 0.2.0 上线且 `latest` 指向正确；`pi -e npm:pi-chat-helper --no-session -p` 从 npm 实装加载成功，模型正常应答，无本包相关警告（既有的两条 Warning 来自 @georgedong32/pi-review 与 pi-slopchop 的依赖声明问题，与包无关，反证本包 peerDependencies 配置正确）。

2026-10-15（晚）：package 标准化——`pi -ne -e . --no-session -p "只回复ok"` 通过新 `pi.extensions` 清单加载两个扩展无报错、模型正常应答；两分支已推 GitHub 并经 `git ls-remote` 核对在线。

2026-10-15：10 套测试全绿（新增 test-tool-origins.cjs：目录/单文件扩展、对象式与帮助函数式注册、scope 包、嵌套跳过、内置兜底与保护、相似度竞争；test-extension 补「精确与扫描合并」「每次请求现取（late_tool）」断言）；`tsc` 零错误；真实会话端到端核验：14 个工具全部归类（内置 bash/read/write/edit、@tintinweb/pi-tasks、context-mode、pi-hermes-memory 含 memory_add/replace/skill_manage、pi-lens），无「未识别」分组；期间两个真因：①「重启未生效」是旧进程占住 7717/7788（旧代码、接口 404）；②模式 A 快照漏掉运行时才注册的 ctx_*（已改为每次请求现取 + 扫描合并）。7788 现为 PID 1144967。
