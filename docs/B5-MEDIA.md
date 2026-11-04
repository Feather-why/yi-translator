# B5 媒体后端：图片、字幕与 PDF

本里程碑遵循用户确认的范围：不改现有前端，提供可直接调用的后端能力、RPC、真实推理、测试。图片右键菜单、视频字幕监听/叠加、PDF 阅读器入口需要之后的前端配合；本次没有增加这些入口。

## 模块与运行位置

| 文件 | 职责 |
|---|---|
| `src/backend/media/index.ts` | 统一 `MediaService`，调用现有调度器翻译，保持逐项编号与缓存隔离 |
| `src/backend/media/input.ts` | 安全读取媒体，类型/魔数/字节数/像素数验证，取消 |
| `src/backend/media/pdf-layout.ts` | PDF 文本按行/段落分组，保留页内矩形 |
| `src/entrypoints/offscreen/media.ts` | 图片模型缓存、sandbox 通信、PDF.js 文本提取与扫描页渲染 |
| `src/entrypoints/ocr-sandbox/*` | 无扩展 API 权限的独立本地 OCR 引擎 |
| `src/shared/backend-v2.ts` | 新增 RPC 的请求与结果类型，与原有 v1 翻译端口兼容 |

OCR 与 PDF 复用唯一的 `offscreen.html`，不创建第二个 offscreen 文档。`registerMediaTasks()` 注册 `media:ocr`、`media:pdf`。`MediaService` 可以注入 `translate`、`fetch`、`offscreen`，方便合约测试；生产默认使用真实 Fetch 与 offscreen bridge，没有生产占位实现。

## 安装与本地模型

依赖已按确切版本锁定：`@paddleocr/paddleocr-js@0.4.2`、`pdfjs-dist@6.5.438`。新增依赖的理由：浏览器端需要经过实际验证的检测/识别预处理、ONNX 执行与 PDF 解析；自行实现完整图像算子、中文识别字典、PDF 解码器会增加兼容风险。

构建前执行 `node gateway/scripts/prepare-assets.mjs`（`prebuild` 已调用），复制：

- Paddle SDK 自己使用的 ONNX Runtime 的 `ort-wasm-simd-threaded.mjs/.wasm` 和 `ort-wasm-simd-threaded.jsep.mjs/.wasm` 到 `public/assets/ocr-onnx/`（SDK 默认导入支持 JSEP 的运行模块，CPU provider 仍在 WASM 中执行）。
- PDF.js 的 `pdf.worker.min.mjs`、`cmaps/`、`standard_fonts/`、`wasm/` 到 `public/assets/pdf/`。
- 对齐模型所需的其他 ONNX 运行文件由同一脚本准备。

所有 JavaScript、worker、OpenCV 和 WASM 都在扩展包内。Paddle 的默认 WebWorker 模式关闭，避免 SDK 自动采用外部 worker/CDN。首次 OCR 会从 Paddle 官方固定路径下载以下**模型数据**，写入扩展来源的 CacheStorage `translate-ppocr-v5-mobile-v1`，以后命中缓存可离线识别：

```text
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx_infer.tar
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar
```

SDK 根据模型 tar 内 `inference.yml` 验证 `model_name`，加载检测模型、识别模型及识别字典。下载及缓存读取都检查 SHA256：det `781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30`，rec `f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c`；这两个值来自本次对官方原始 tar 的实际下载。模型每个最多 64MiB，网络读取有大小和 180 秒超时限制，不接受请求传入模型 URL。清除扩展数据会清除缓存，之后需要重新下载。官方模型仓库标注 Apache-2.0；浏览器 SDK 也为 Apache-2.0。

OCR 强制 WASM CPU、单线程、SIMD，不额外占用本地翻译模型的显存。检测最长边 960，输出坐标映射回原图；识别阈值 0.35，空白图可合法返回空 blocks。模型空闲十分钟释放推理会话，下次识别从本地 CacheStorage 重新初始化。

已修复 SDK 参数继承导致的真实识别问题：它的默认管线使用 `limit_type:min`，仅覆盖边长为 960 会把矮图过度放大。当前明确使用 `textDetLimitType:'max'`。扫描 PDF 渲染明确使用 `intent:'print'`，避免 PDF.js 的 display 模式在不可见 offscreen 文档里等待不会触发的 requestAnimationFrame。

Paddle SDK 的 OpenCV 包包含动态函数生成。MV3 扩展主页面仍仅允许 `script-src 'self' 'wasm-unsafe-eval'`；仅 `ocr-sandbox.html` 的独立 opaque origin sandbox 允许 `unsafe-eval`。此页面没有 Chrome 扩展 API，也不接收任意脚本/地址：它只接受来自父扩展的 `init/predict/dispose` 消息，通过每次独立 MessageChannel 与随机请求 ID 返回。模型字节由父 offscreen 读取后传入；沙盒模型 fetch 只能取两份内存数据。

## 新增 RPC 契约

这些 RPC 使用现有 `{rpc,payload}` / `{ok,data|error}` 封装，仅扩展自己的页面可以调用管理类新增接口。以下展示 payload，完整类型以 `backend-v2.ts` 为准。

### 图片 `ocr:image`

```json
{"dataUrl":"data:image/png;base64,...","translate":true,"sourceLang":"auto","targetLang":"zh-CN","mode":"accurate","noCache":false}
```

也可用 `url` 替代 `dataUrl`，二者必须且只能提供一个。接受 PNG、JPEG、WebP，真实格式由 magic bytes 判断，最多 10MiB/1600 万像素。远程获取仅允许无账号密码的 HTTP(S)，`credentials:'omit'`、禁止重定向、30 秒超时；先检查 Content-Length，再按流累计大小。图片头可得的尺寸在解码前检查，解码后的尺寸再次检查。

结果：`{width,height,engine,model,blocks:[{text,confidence,box,translation?,error?}]}`。box 是四个 `[x,y]` 点，单位为原图像素，confidence 为 0–1。`translate:false`（默认）只识别，不调用翻译模型；翻译开启时逐块交给已有调度器，使用真实 provider。单块翻译失败保留识别结果并写 error，不丢掉其他块。

### 字幕 `subtitle:translate`

```json
{"videoId":"video-123","sourceLang":"en","targetLang":"zh-CN","segments":[{"id":"line-1","text":"Hello.","startMs":1000,"endMs":2500}],"mode":"accurate","noCache":true}
```

videoId 必填（最多 300 字符），每次最多 500 行/200,000 字符，每行最多 12,000 字符，id 必须唯一，时间不能倒置。返回 `{segments}`，id、输入顺序、startMs、endMs 一一对应，`source` 保留原文，`text` 填译文，provider 填真实出译服务。空白行原样保留；单行失败保留原文并附 error。

每八行一批并发，批次内最多 600 字符的相邻文本作为上下文摘要。不会让模型重排、合并或重新生成字幕时间。翻译请求使用 `cacheNamespace:subtitle:${videoId}`，相同文字不会跨视频误用上下文结果。

### PDF `pdf:translate`

```json
{"url":"https://example.com/document.pdf","pages":[1,2],"sourceLang":"en","targetLang":"zh-CN","mode":"accurate","noCache":false}
```

接受 URL 或 PDF data URL，最多 25MiB，以 `%PDF-` 魔数验证。最多处理 200 页；更长文档必须指定每批不超过 200 页的 pages。文件字节的 SHA256 作为 documentId 和缓存命名空间，不用文件名/URL 当唯一标识。

PDF.js 在本地 worker 提取真实文本项与 transform，转换为页面左上角为原点的坐标；按行和列间距分组，再合并相邻行，返回 `{documentId,pages,warnings}`。每页有 page/width/height/scanned；每段有 id/source/translation?/box/provider?/error?。box 为 `[xMin,yMin,xMax,yMax]`，单位为页面 scale=1 坐标。没有文本层的页渲染为不超过最长边 1800 的本地图，再复用 PP-OCRv5 识别，坐标按渲染比例还原。

当前分组为几何启发式：复杂多栏、旋转文本、表格、数学式和特殊字体可能需要前端或专门版面模型进一步处理。空白页会返回 warning。加密文档没有密码入口，会明确失败。此能力返回文本和坐标，不生成改写后的 PDF 文件。

## 取消、缓存与隐私

三类方法均支持 AbortSignal。媒体下载和翻译请求尽量取消；已经进入单线程 ONNX 算子的图片推理不能在算子中途终止，因此取消立即结束调用并丢弃随后结果，不把它加入翻译调度。不会在取消后继续翻译剩余块。

当前新增 RPC 是一次请求返回完整结果；`mode:'combined'` 在媒体服务内取精确档的最终结果。若未来需要图片/PDF 逐块流式显示和从界面取消，需要前端为这些媒体任务接入专用端口；现有前端没有这类入口。本地推理服务方法已经接收 AbortSignal，offscreen 调用最多等待五分钟以容纳首次权重下载和初始化。

`noCache:true` 原样转给翻译调度器，遵循不读/写译文缓存、不写记忆和同步的现有规则。PDF 的命名空间为 `pdf:${SHA256}`，字幕为 `subtitle:${videoId}`，图片为 `ocr:${SHA256}`。ONNX 权重本身仍缓存，因为它们是公共模型文件，不含用户媒体。媒体图像/文件不会被写入模型缓存、日志或同步；如果用户配置云端翻译服务，被识别的文字会按已有翻译配置发送给该服务。

## 验证

```powershell
npm run typecheck
npm run test:backend
# 本地 PP-OCRv5 / 文本PDF / 扫描PDF的真实浏览器验证
$env:BROWSER_EXECUTABLE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node tests/backend/media-download-models.mjs
node tests/backend/media-browser.mjs
```

`media.test.mjs` 的七项合约测试通过：安全媒体输入、字幕逐行/分批/命名空间、重复 id/错误时间、单行错误保留、OCR 接口与 noCache、取消、PDF 内容 hash/坐标/缓存、列布局。合约测试中的注入 offscreen 仅验证边界，不冒充真实识别精度。

真实浏览器测试用本地 Canvas 生成 `HELLO LOCAL MODEL` 黑白 PNG，并构造含文本层的标准 Helvetica 小 PDF、嵌 JPEG 的扫描 PDF。检查实际 PP-OCRv5 引擎返回文本、置信度和四边形，再检查 PDF 提取和扫描页 OCR；不会调用假 OCR provider。测试输出在 `work/media-browser-result.json`（合成测试数据），测试后关闭并清理独立临时浏览器资料夹。

2026-11-03，在本机 Edge 156 的独立临时资料夹中，**真实 offscreen 文档**与生产 RPC 全部通过：

| 实测项 | 结果 |
|---|---|
| 640×160 PNG，已缓存官方权重后首次会话初始化+识别 | 2222ms；完整 `HELLO LOCAL MODEL`；confidence 0.9380；真实四边形 `[29,56]…[492,100]` |
| 含文本层的小 PDF | 提取 `Hello local PDF model`，一段，页坐标 `[35,57,311.948,85]`，`scanned:false` |
| 嵌 JPEG 的扫描 PDF | 渲染后 OCR 331ms；完整 `HELLO LOCAL MODEL`，一段，坐标还原，`scanned:true` |
| options→`subtitle:translate`→调度器→真实 8081 Hy-MT2-1.8B | 两行中文“孩子们正在读书。”“请关上门。”；原 id、顺序、时间完整对应，真实 provider `llamacpp` |
| options→`ocr:image`（translate=true）与 `pdf:translate` | 完成真实识别/提取后调用本地模型，带 `noCache:true`；PDF 译文“你好，本地PDF模型” |

测试通过真实官方权重的本地字节回放预热扩展 CacheStorage，校验和仍由生产代码检查，ONNX 在浏览器 CPU 实际执行；以上 2222ms 不含首次公网下载时间，331ms 为模型已加载后的扫描页。真实权重下载脚本保留文件大小和 SHA256。测试期间仅启用 `llamacpp`，避免其他服务影响链路归因；正式注册表中没有 Chrome 内置 Translator 适配器。

这些合成样例证明后端链路和坐标/编号契约；它们不是 OCR 全语种精度或翻译质量评测。1.8B 在脱离上下文的短句仍会产生歧义，例如本次 OCR 的 “LOCAL MODEL” 被译为“本地模特”，应依页面上下文判断；接口不会将模型输出宣称为人工校验的结果。没有改写用户浏览器的既有资料或现有前端。

部署后再次使用 `EXT_DIR=.output\chrome-mv3` 加载正式包复测：OCR 2163ms、扫描 PDF 365ms，两者完整识别 `HELLO LOCAL MODEL`，文字 PDF 一段、扫描 PDF 一段，`subtitle:translate/ocr:image/pdf:translate` 三类生产 RPC 仍全部通过并由 `llamacpp` 返回。此轮也覆盖最终内部任务权限过滤和最新原生适配器版本。

## 官方来源（2026-11-03 核实）

- [PaddleOCR.js SDK 官方说明](https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js/packages/core)
- [官方 browser 部署说明](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/inference_deployment/cross_platform/browser.en.md)
- [PP-OCRv5 mobile 检测模型与许可](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx)
- [PP-OCRv5 mobile 识别模型、字典与许可](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx)
- [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)
