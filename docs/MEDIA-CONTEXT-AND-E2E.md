# 图片/PDF 右键菜单与真实后端媒体验收

核实日期：2026-11-03。此轮只接后台入口，不修改前端或 `tests/e2e/media.mjs`。

## 后台入口

`src/entrypoints/background.ts` 在扩展安装、更新和重载时调用 `installTranslationMenus`，先清理本扩展旧菜单，再注册原有划词/整页入口和以下三项原生定义：

| ID | 显示名称 | 上下文 | 动作 |
|---|---|---|---|
| `tx-image` | 翻译这张图片 | 图片 | 向来源标签页的精确 `frameId` 发送 `{cmd:'translate-image',srcUrl}` |
| `tx-pdf-link` | 用双栏阅读器打开 | PDF 链接 | 新标签页打开扩展 `pdf.html?url=编码后的源地址` |
| `tx-pdf-page` | 用双栏阅读器打开 | `.pdf` 页面，或两个 arXiv PDF 路由候选页 | 优先使用 PDF frame 地址，否则使用原始页面/标签页地址；无后缀 arXiv 候选先验证文件头 |

PDF 链接与页面分开定义，是因为 Chrome 的 `targetUrlPatterns` 约束链接/图片目标，`documentUrlPatterns` 约束页面或框架。把两者放在同一项中，会使普通 HTML 页面上的 PDF 链接受页面过滤限制。[Chrome contextMenus 文档](https://developer.chrome.com/docs/extensions/reference/api/contextMenus)

匹配模式分别列出 `.pdf` 的八种大小写组合，允许查询参数和片段。菜单匹配只控制显示；点击后仍解析 URL，以解码后的 pathname 是否以 `.pdf` 结尾为准，拒绝 `.pdfx` 和仅查询参数包含 `.pdf` 的地址。Chrome 的模式规则见[匹配模式文档](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)。

页面菜单另外仅增加 `arxiv.org/pdf/*` 与 `export.arxiv.org/pdf/*` 两个 HTTP(S) 候选模式，覆盖现代编号与旧分类编号，例如 `/pdf/2501.12345`、`/pdf/hep-th/9901001`。链接菜单仍要求 `.pdf` 路径后缀，不把所有 `/pdf/` 链接或 HTML 页面作为入口。候选域名严格匹配，拒绝伪子域、带用户名/密码的 URL 和空路径。

用户点击无后缀候选页后，后台最多发起一次 GET：`Range: bytes=0-4`、`credentials:'omit'`、`redirect:'error'`、`cache:'no-store'`，整个取响应/读文件头流程受 5000ms Abort 约束。使用响应流跨 chunk 比较前五字节 `%PDF-`，识别或拒绝后立即取消流并中止请求；即使服务器忽略 Range 返回 200，也不调用 `arrayBuffer()` 下载整份论文。HTML 响应、错误状态、过短响应、网络/重定向拒绝或超时都不打开阅读器，不回退探测其他来源。

`src/backend/context-menu.ts` 单独承担这些规则，便于独立测试：

- PDF 仅接受无用户名/密码的 HTTP(S) 地址，完整保留合法查询参数、片段和原地址编码。非法 PDF 链接不回退打开当前页。
- 图片接受 HTTP(S)、`data:image/*`、具有 HTTP(S) 来源和资源路径的 blob URL，拒绝脚本、HTML data、内部页面、无效地址和凭证 URL。
- 图片必须有合法标签页 ID 和非负整数 frame ID。发送失败时不广播到其他 frame；不记录可能含令牌的资源地址。
- 不修改权限或前端。HTTP(S) PDF 的右键入口不代替阅读器已有的本地文件选择器。

## 独立后台测试

`tests/backend/context-menu.test.mjs` 最终十三项通过。原七项覆盖菜单注册/清理顺序；精确框架与顶层默认值；blob/data 图片；非法输入与失效接收者；PDF 路径/编码/大小写；阅读器地址编码与非法链接拒绝；PDF iframe/浏览器内置查看器回退。

新增六项覆盖：两个 arXiv 候选的跨 chunk 文件头识别与完整地址编码；HTML/错误 HTTP/短响应拒绝；忽略 Range 时只读首 chunk 即取消；取响应及读流两阶段的五秒 Abort；未知路由/伪域名/凭据/无后缀链接不发网络；重定向或网络失败只尝试一次且不回退探测。未增加浏览器权限，后台入口继续使用原有 fetch 能力。

全量后端合约会编译并运行此文件；类型检查也已通过。最终整体验收由主任务另行记录。

## 原始媒体测试接真实后端

直接 `node tests/e2e/media.mjs` 不注入假后端，但全新浏览器配置尚未配置本地提供方。新增 `tests/backend/run-media-e2e.mjs` 负责启动独立临时浏览器、通过正式 RPC 配置真实本机模型，然后导入原始测试原封不动执行。包装器不替换 OCR、PDF 解析、翻译 RPC、模型响应或 DOM 结果。

运行示例（先启动真实 llama-server，再构建正式包）：

```powershell
npm run build
$env:BROWSER_EXECUTABLE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:LLAMA_URL = 'http://127.0.0.1:8081'
node tests/backend/run-media-e2e.mjs
```

可选：`EXT_DIR` 指向另一个正式解压包，`REPORT_DIR` 设置报告目录，`OCR_MODEL_CACHE` 指向两个官方 tar 权重所在目录，`LLAMA_API_KEY` 只用于确有鉴权的本机服务。包装器仅接受本机模型地址；只启用 llama.cpp，避免远程翻译回退。对齐模块在独立媒体配置中关闭，本测试不覆盖词对齐。

权重缓存只回放固定官方字节，并在使用前验证 SHA-256；实际推理仍由生产 PaddleOCR/WASM 执行。没有缓存时走生产首次下载。两个官方模型哈希：

| 权重 | SHA-256 |
|---|---|
| `PP-OCRv5_mobile_det_onnx_infer.tar` | `781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30` |
| `PP-OCRv5_mobile_rec_onnx_infer.tar` | `f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c` |

浏览器使用系统“减少动态效果”设置，避免在显字动画中截到随机过渡字符；不修改前端动画实现。临时浏览器配置在关闭后清理，不接触日常浏览器。

## 2026-11-03 实测结果

正式扩展版本 `0.2.2`，后台 ping `0.2.2-alignment`。原始前端测试 SHA-256 为 `05eb0b93f4a54ff91938f74e494be49ff184a0379370e53aaecc91ebeb138539`，测试前后相同。

| 原始验收项 | 结果 |
|---|---|
| 鼠标移至大图出现翻译按钮 | 通过 |
| 点击显示真实译文覆盖层，页面高度不变、覆盖矩形与图片一致 | 通过 |
| 再点切回原图 | 通过 |
| PDF 原页与译文页均渲染 | 通过 |
| 双栏 paper.pdf 的参考文献条目和希腊字母公式不进入翻译段落 | 通过 |
| 悬停译文时原文对应位置高亮 | 通过 |
| 无页面脚本异常 | 通过 |

额外证据：图片 2 个段落、论文 8 个段落全部为 final；论文左右各 1 页；悬停联动范围 1 个。单独调用正式 `ocr:image` 得到引擎 `paddleocr-js/0.4.2:wasm-cpu`、模型 `PP-OCRv5_mobile_det+PP-OCRv5_mobile_rec`，返回 2 个真实 OCR 框。浏览器观察到 11 次真实本机 `/v1/chat/completions` 成功响应，均为 HTTP 200、finish_reason=stop，并包含真实中文输出。图片例句为“快速、私密且免费”；论文标题为“浏览器中的本地优先翻译”。

报告默认写入 `work/media-e2e-real/media-e2e-real-result.json`，截图为同目录 `image-overlay.png` 与 `paper-reader.png`。截图已人工复核：覆盖层和双栏原布局正确，公式与参考条目仍可见。

## 证据边界

这七项验证图片与 PDF 的现有前端在真实后端上可工作；右键菜单的选择、校验和发送另由十三项后台测试覆盖，不把自动调用监听器冒充原生菜单人工点击。未在此轮测真实 YouTube 页面、扫描论文全文或任意语言 OCR。

Chrome 的 `tabs.Tab` 和右键点击信息没有文档 MIME 字段，现有前端也未向后台报告任意 PDF 页的类型，因此不能在不扩权限、不改前端的条件下泛化所有无扩展名地址。当前页面菜单只保证 HTTP(S) `.pdf` 路径，以及上述两个经过文件头验证的 arXiv 候选路由；任意 `/export?id=…`、未知站点的无后缀 PDF 不声称支持。候选路由可能先显示菜单但点击后发现 HTML 而拒绝；不会让所有 HTML 页面都出现这个入口。

图片夹具第一行靠右截断，OCR 得到 `LOCAL FIRST TRANSLATIO`，本地模型原样保留该大写片段；不能声称所有图片文本都已完整、准确翻译。论文为单页合成双栏夹具，中文密排仍沿用现有前端布局，本次不改其排版。结果证明真实链路与这些样本的行为，不等同于所有图片/PDF 的识别质量保证，也不是性能基准。
