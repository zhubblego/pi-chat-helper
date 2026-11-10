# vendor 第三方库

均为自包含单文件、按需升级（下载后覆盖并更新本表版本）。来源 jsdelivr，license 见各文件头或下表。

| 文件 | 版本 | 体积 | license | 用途 |
| --- | --- | --- | --- | --- |
| markdown-it.min.js | 14.3.3 | 126 KB | MIT（文件头注释） | `renderMarkdown`（lib.js，页面 defer 常驻，全局 `window.markdownit`） |
| mermaid.min.js | 11（jsdelivr latest tag） | 3.6 MB | MIT | mermaid 图渲染（懒加载：出现 `.md-mermaid` 块时才注入 script，全局 `window.mermaid`，securityLevel=strict） |
