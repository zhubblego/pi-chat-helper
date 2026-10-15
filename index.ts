/**
 * 仓库根的开发聚合入口。
 *
 * 背景：pi 对 `pi -e <目录>` 只认两种入口——目录里的 `package.json`
 * 带 `pi.extensions` 清单，或目录根的 `index.ts`/`index.js`；都没有就会
 * 把目录当模块 import，报 `Cannot find module`。本文件补上后者，让
 * `pi -e .` 直接加载本仓库所有扩展的开发版：
 *   - question-panel.ts    TUI 提问面板（/questions）
 *   - trajectory-web/      轨迹观察 web 服务（/start、/stop）
 *
 * 建议纯开发加载用 `pi -ne -e .`：不加载其它已装扩展，避免与
 * `~/.pi/agent/extensions/` 里已部署的同名扩展重复注册（pi 会把重名命令
 * 拆成 `/name:1`、`/name:2`）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import questionPanel from "./question-panel";
import trajectoryWeb from "./trajectory-web";

export default function (pi: ExtensionAPI): void {
	questionPanel(pi);
	trajectoryWeb(pi);
}
