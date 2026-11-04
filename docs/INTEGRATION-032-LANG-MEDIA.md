# 第 32 节后端协作：源语言、输入框与混合扫描 PDF

核实日期：2026-11-04。对应 `HANDOFF-BACKEND.md` 第 32 节「请后端配合」第 3、4、6 条。本文记录后端改动与离线合约验收；正式包的真实浏览器、真实模型和 OCR 验收另见总集成记录。

## 1. 显式源语言与语言能力

此前多数适配器已经传递 `sourceLang`，但本机 llama.cpp 的默认提示只指定目标语言，用户把短句手动设为瑞典语后模型仍自行猜源语言。本次在非 `auto` 的请求中加入 `原文语言：瑞典语。` 这样的简短提示，放在翻译模板之前，模板冒号之后仍只有完整原文。`auto` 保持原提示；快速、准确、带标签、术语和自定义提示路径均保留既有正文边界与采样。适配器版本 `llamacpp 1.0.8 → 1.0.9`，缓存随版本变化失效。

| 适配器 | 非 auto 的源语言传递 | 新增 `sv nl pl tr uk vi th id ar pt it` |
|---|---|---|
| Microsoft Azure | 请求查询参数 `from`；目标 `to` | 对应 ISO 代码；原有中文映射保持 `zh-Hans` / `zh-Hant` |
| DeepL | `source_lang` 大写基础代码；目标 `target_lang` | 对应大写代码；不能使用过时的少量语言白名单拦掉已经扩展的语言 |
| NiuTrans | JSON `from` / `to` | 对应 ISO 代码；中文保持 `zh` / `cht` |
| Tencent 存量批量接口 | `Source` / `Target`，新增有方向的 `supports` | 不支持 `sv/nl/pl/uk`，候选筛选时直接跳过；其余新增语言仍受具体方向限制 |
| llama.cpp | 默认提示明确源语言；自定义 `{{from}}` 仍可用 | 不静态拒绝用户模型可能支持的语言，实际质量取决于所部署模型 |
| OpenAI-compatible / Gemini | 用户 JSON 中的 `sourceLang` / `targetLang` | 保留指定代码；不虚构所有自定义模型都有同一语言能力 |
| Remote node | 请求 JSON 中的 `sourceLang` / `targetLang` | 适配器透传；网关提示的对应修正由总集成同步完成 |
| 浏览器内置翻译 | `BuiltinTranslatorBridge` 收到原语言对 | 由浏览器实时 availability / 语言包状态决定，不用静态表猜测 |
| Google 网页可选兜底 | URL 参数 `sl` / `tl` | 原样传递；仍为非官方、默认关闭、最低优先及严格限流 |

腾讯的限制来自项目实际使用的存量 `TextTranslateBatch`，不是新的通用模型接口。例如 `ja→ko` 可用、`ja→fr` 不可用；`en→hi` 可用而 `zh→hi` 不可用；`vi→th` 不可用。适配器也直接拒绝已知不支持的语言对，不发送请求、不消耗用户额度，错误说明语言方向并提示换服务。版本 `tencent 1.0.2 → 1.0.3`。`auto` 只能预先判断目标是否在支持集合内，实际识别到的源语言仍交由上游返回结果处理。

Core 的 `ProviderDef.supports` 候选过滤、全部候选均不支持时的可读错误由总集成实现。没有给动态 LLM、浏览器或用户自建接口加武断的静态限制。

官方核对依据：

- [腾讯官方 SDK 4.0.1054 的 TextTranslateBatchRequest](https://github.com/TencentCloud/tencentcloud-sdk-nodejs/blob/4.0.1054/src/services/tmt/v20180321/tmt_models.ts)：源语言及有方向的目标集合。
- [Microsoft Translator 语言支持](https://learn.microsoft.com/en-us/azure/ai-services/translator/language-support)：新增代码和 Cloud Text translation 能力；其中 `pt` 默认巴西葡萄牙语。
- [DeepL 语言说明](https://support.deepl.com/hc/en-us/articles/360019925219-DeepL-Translator-languages)、[官方 OpenAPI](https://github.com/DeepLcom/openapi/blob/main/openapi.yaml)：不能沿用旧语言清单；具体语言特性与账号能力仍以上游为准。
- [小牛 JSON 翻译说明](https://niutrans.com/documents/contents/trans_json)、[小牛官方 MCP 语言目录实现](https://github.com/NiuTrans/MCP-TextTranslation)：源/目标参数与语言代码。
- [Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api)：运行时检查语言对及语言包可用性。

这些来源核对的是接口与代码映射；离线回放不等同于付费账号的实际语言质量验收。本轮没有调用外部收费翻译服务。

## 2. 输入框逐行翻译与隐私边界

现有生产路径已经满足新前端的输入任务，无需另写一套后端逻辑：

1. `kind:'selection'` 的每行保留 `l0/l1/l2` 片段 ID；完成先后与 ID 不混淆，不把多行先拼成一段再拆译文。
2. `sourceLang:'sv'` 与 `targetLang:'en'` 传到实际适配器。`stream:false` 不启用 SSE / `partial`；完整 `result` 正常返回。
3. `noCache:true` 不读写人工记忆、译文缓存，也不触发译后对齐预计算。
4. `startBackend` 根据浏览器提供的 `port.sender.url` / `sender.tab.incognito` 强制敏感或隐身任务使用 `noCache:true`。即使任务自行填写 `noCache:false`，并把 `context.url` 写成普通网站，也不能绕过这个判断。

新增测试运行实际 `startBackend → TranslatePort → BackendCore`，仅以固定返回值替换模型和无关服务：先放入一条不应读取的人工记忆，再分别提交显式 noCache、银行 sender、邮件 sender、隐身 sender 四组任务。三行的完整译文按对应 ID 返回，全部 TM/cache 访问为 0，没有 partial 或 error。该行为已有实现，本次只补合约，没有改前端或更改正常网页的缓存规则。

## 3. 混合扫描页的后端缺口与修正

新前端已经识别「文字层只有页眉、页码，正文其实是扫描图」，但发给后端的仍是普通 `pdf:translate`。旧 offscreen 仅在整页没有任何文字段落时才 OCR；因此前端判对了，后端还是只返回页眉/页码。

修正后的判断：

1. 没有文字层：沿用整页扫描 OCR。
2. 文字层含中部正文或完整隐藏文字层：保留原生文字提取，不新增渲染或 OCR。
3. 文字层全部在页面顶部/底部 12%：才渲染候选页。与前端一样检查纸张亮度下的中部墨迹率大于 1.5%，且有墨迹行的深浅变化次数中位数至少为 28。
4. 满足扫描正文条件后进行 OCR。恢复到原始 PDF 坐标，在与原生文字框重叠超过较小框 40% 时丢掉该 OCR 框，保留原生文字；其余扫描正文与原生段落一起返回，并按页面纵横坐标排序。

没有新增协议字段，未增加 `skipBoxes`，没有修改阅读器。`page.width` / `height` 与原坐标语义保持；`scanned:true` 表示本页走过 OCR，包含混合扫描情况。扫描页仍使用最长边至多 1800 像素的现有栅格上限，OCR 生命周期、缓存模型、重试和超时限制保持原配置。普通正文页不会因这次修正多做一次 OCR。

新增纯函数在 `src/backend/media/pdf-scan.ts`，生产接线在 `src/entrypoints/offscreen/media.ts`。分类仍是启发式：非常浅、倾斜、小块或稀疏扫描文字可能达不到阈值；高频纹理照片也不能保证永不误判。本轮验证了空白与粗线图表的反例，没有声称覆盖所有 PDF 类型。

## 4. 局部验收与复现

独立输出目录避免与主验收的 `tests/.compiled` 互相覆盖：

```powershell
node node_modules/typescript/lib/tsc.js -p tests/contract/tsconfig.json --outDir tests/.compiled-lang032
Set-Content -LiteralPath tests/.compiled-lang032/package.json -Value '{"type":"commonjs"}'
$env:BACKEND_BUILD_DIR = (Resolve-Path tests/.compiled-lang032).Path
node --test tests/providers/languages-032.test.mjs tests/providers/llamacpp.test.mjs tests/providers/llamacpp-fast.test.mjs tests/providers/llamacpp-stream.test.mjs tests/providers/tencent.test.mjs tests/backend/pdf-mixed-032.test.mjs tests/backend/input-selection-032.test.mjs tests/backend/ocr-offscreen-wiring.test.mjs
```

结果：**69/69，通过；0 失败、0 跳过。**

| 测试组 | 范围 |
|---|---|
| 新语言 12 项 | 10 个既有适配器 × 11 个新增语言 × 正反两个方向共 220 个参数场景；另有腾讯方向/中文映射、auto/stream:false 回归 |
| 输入框 4 项 | 真实后台接线、多行 l 编号、sv→en、非流式、显式与服务端强制敏感/隐身 noCache |
| PDF 7 项 | 原生正文、纯扫描、页眉+扫描正文、完整隐藏文字层、空白、粗线图表、40% 去重边界 |
| 既有回归 46 项 | llama.cpp 普通/快速/SSE、腾讯签名/错误/占位符、OCR 容器超时重建与故障隔离 |

后端 strict 独立编译通过。全源码 `typecheck/tsconfig.json` 在并行集成时暴露 `src/dev/mock-backend.ts` 的旧 `Record<ProviderTemplate,...>` 尚未包含新模板，已交总集成处理，本分项没有修改 mock 前端文件；最终全量类型检查结果以总集成记录为准。

媒体回放执行的是生产 offscreen 源码与真实 PDF 分组/扫描判断，替换 PDF 解码、像素和 OCR 输出作为固定夹具，不等同于真实 PaddleOCR 质量测试。总集成应继续用真实模型与新 `tests/e2e/fixtures/mixed.pdf` 做浏览器验收；新版前端媒体测试里的 `mock.pdfOcr` 和固定 OCR 段数断言只适用于假后端，真后端验收应以实际 OCR 请求和正文结果为准。

本分项没有复制用户私人 PDF、修改日常浏览器、重启生产模型或更改模型权重。显式源语言提示通过了边界、采样和流式回归；未重新进行生成质量/速度对比，因此不把该修正描述为已经量化证明的模型提速或精度提升。

## 5. 真实栅格发现的噪点修正

正式Edge读取最新mixed.pdf后曾只返回页眉和页码。捕获1224×1584实际像素：中部墨迹率2.804%，但扫描噪点让空白行也进入交替次数统计，中位数只有4。后端现在要求每行深色像素至少max(8, ceil(width×1%))才参与统计，保留28次的文字阈值；不把细噪点当成文字行，也不降低图表保护条件。新增带噪文字阳性和纯噪点阴性，PDF专项现9项，连本机RPC8项共17/17通过。最终真实OCR结果见总验收。

该修正只在后端。前端imageBodyPage同一统计方法在其他缩放下仍可能被噪点干扰，已在HANDOFF14.1交接；不声称已修复前端自动触发条件。
