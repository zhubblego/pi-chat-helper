// 工具归属静态扫描：目录/单文件扩展、npm 包（字符串式与对象式注册）、scope 包、嵌套跳过、内置兜底
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let failed = 0;
const check = (label, cond, extra = "") => {
	console.log(cond ? "PASS" : "FAIL", label, cond ? "" : extra);
	if (!cond) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-origins-"));
const agentDir = path.join(tmp, "agent");
// 目录扩展（index.ts 入口，字符串式注册）
fs.mkdirSync(path.join(agentDir, "extensions", "my-ext"), { recursive: true });
fs.writeFileSync(path.join(agentDir, "extensions", "my-ext", "index.ts"), 'pi.registerTool("foo_tool", {});\n');
// 单文件扩展
fs.writeFileSync(path.join(agentDir, "extensions", "loose.ts"), 'pi.registerTool("bar_tool", {});\n');
// npm 包（对象式注册 + package.json 名）
const pkgDir = path.join(agentDir, "npm", "node_modules", "fake-pkg");
fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "fake-pkg" }));
fs.writeFileSync(path.join(pkgDir, "dist", "index.js"), 'pi.registerTool({ name: "obj_tool", description: "x" });\n');
// 嵌套 node_modules 必须跳过
fs.mkdirSync(path.join(pkgDir, "node_modules", "nested"), { recursive: true });
fs.writeFileSync(path.join(pkgDir, "node_modules", "nested", "evil.js"), 'pi.registerTool("nested_tool", {});\n');
// scope 包
const scoped = path.join(agentDir, "npm", "node_modules", "@scope", "scoped-pkg");
fs.mkdirSync(path.join(scoped, "src"), { recursive: true });
fs.writeFileSync(path.join(scoped, "package.json"), JSON.stringify({ name: "@scope/scoped-pkg" }));
fs.writeFileSync(path.join(scoped, "src", "index.ts"), 'pi.registerTool("scoped_tool", {});\n');

(async () => {
	const mod = await import(pathToFileURL(path.join(__dirname, "..", "trajectory-web", "server", "tool-origins.mjs")).href);
	const { scanToolOrigins, builtinToolNames, BUILTIN_FALLBACK } = mod;

	const scan = scanToolOrigins({ agentDir });
	check("内置兜底存在", scan.tools.read?.kind === "builtin" && scan.tools.bash?.label === "内置");
	check("无 piDir 时用兜底列表", builtinToolNames(undefined).join(",") === BUILTIN_FALLBACK.join(","));
	check("目录扩展（字符串式注册）", scan.tools.foo_tool?.kind === "package" && scan.tools.foo_tool.label === "my-ext", JSON.stringify(scan.tools.foo_tool));
	check("单文件扩展", scan.tools.bar_tool?.label === "loose.ts");
	check("npm 包（对象式注册 + package.json 名）", scan.tools.obj_tool?.label === "fake-pkg", JSON.stringify(scan.tools.obj_tool));
	check("scope 包", scan.tools.scoped_tool?.label === "@scope/scoped-pkg");
	check("嵌套 node_modules 被跳过", scan.tools.nested_tool === undefined);

	if (process.env.PI_HOME) {
		const names = builtinToolNames(process.env.PI_HOME);
		check("从 pi 安装目录读到内置工具名", names.includes("bash") && names.includes("read") && names.length >= 8, names.join(","));
	}

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
	process.exit(failed === 0 ? 0 : 1);
})();
