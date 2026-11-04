# PDF 数学字母回归：前端交接（2026-11-04）

> 历史记录更新：本页发现已由前端第 41 节修复，第 42 节在本机 PDF.js 6.5.438 重新验收，页面 29/29、媒体 12/12 通过。当前同版本新版 ZIP 的校验值见 [repack-041-checksums.json](repack-041-checksums.json)。以下保留原始审查证据。


## 结果

当前 本机项目 `pdfjs-dist 6.5.438` + 最新前端在正式包 0.2.11 和独立界面测试包中都能复现，不能归因于假后端或 rolldown 独立构建。界面测试页面 29/29 通过；媒体 11/12 通过，其中论文排版这一个大用例在数学变量断言处失败，该用例中排在这一断言之后的拖动等检查未执行。

`tests/e2e/media.mjs:204` 期待第 8 页正文为数学斜体 `𝑁`（U+1D441），实际送往翻译端口之前的版面结果已是普通 `N`：

> Here, N is the prediction horizon length and the vector x is the latest state estimate.

## 根因与证据

- `src/frontend/pdf/layout.ts:127` 的 `fontName()` 读取 `page.commonObjs.get(id).name`，没有名字就返回空串。
- `layout.ts:160–162` 用名字匹配数学字体、粗体、斜体；没有读取当前 PDF.js 字体对象现成的 `bold` / `italic` 属性。
- 实际对象中 `N` / `x` 字体的 `name` 缺失，`loadedName` 是不含斜体信息的 `Times`，但 `italic:true`、`bold:false` 明确存在。普通正文也叫 `Times`，`italic:false`。
- `symbolItems()` 因此没有将 N/x 认作不同于正文的单独斜体变量，`simpleSymbol()` 也没有进入 Unicode 数学字母转换。
- 当前 `reader.ts:256` 调用 `getDocument()` 没有要求额外字体属性；读取内部字体名称的兼容假设需要修正。仅将 `name` 替换成 `loadedName` 不足以解决此样例。

进行了同一页面上的隔离实验：只在临时浏览器内给缺失名称的字体对象按其真实 `italic` / `bold` 属性临时补一个名称，再重新执行原封不动的 `extractLayout()`，结果立即变为：

> Here, 𝑁 is the prediction horizon length and the vector 𝑥 is the latest state estimate.

两个构建的结果一致。实验没有改 PDF、前端源码、测试断言或正式产物。此实验只是定位根因，不是已部署的修复。

## 前端建议

1. 在读取字体时使用实际 `bold` / `italic` 布尔属性，并保留对旧版字体名的兼容回退。不要只依赖不稳定的 `name` 或缺少样式的 `loadedName`。
2. 单独核对数学字体名（CMMI / CMSY / STIX 等）的获取方式。可评估 `fontExtraProperties` 或其他可用元数据，但要核对内存代价以及正常 PDF 的字体对象。此次实验只验证斜体变量根因，没有宣称所有数学字体都已覆盖。
3. 保留原有 `𝑁` 断言，不降低到接受普通 N；补充粗体变量、数学字体、普通斜体词、正文数学字母的回归，防止把普通斜体单词转换成变量。
4. 修复后运行 `npm run test:ui` 的完整媒体用例，并对真实论文复核公式 / 字体 / 表格；后端不需要改协议或归一化文本。

后端看到的只是普通 N，无法可靠推断其原本是数学变量。不要在后端无差别替换大写字母或补猜数学符号；这会影响姓名和正常正文。

## 复现证据

工作区 `work/release039-agent/inspect-pdf-fonts.mjs`：用独立临时 Edge，单栏原文模式打开 `tests/e2e/fixtures/thesis-mini.pdf`，读取第 8 页字体和布局，再做临时对象 A/B 实验。只读，不启动模型，不访问付费服务。

- `review-039/pdf-fonts-ui-test.json`
- `review-039/pdf-fonts-chrome-mv3.json`
- 完整测试日志 `work/release039/ui-test.log`

Windows 上浏览器测试必须使用允许启动独立浏览器的运行环境；受限运行环境下曾在启动阶段挂住，已中止，后续两次实际 Edge 验证均正常退出并清理临时资料夹。
