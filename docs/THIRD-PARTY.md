# 后端第三方运行库、模型及数据许可归档

归档日期：2026-11-03。范围：B3—B5 新增的词典、词对齐、OCR 和 PDF 后端组件。原文位于 `public/licenses/`，构建时随 WXT 的 `public/` 资源复制到扩展根目录的 `licenses/`。本文件记录实际采用的版本与来源，不替代上游许可条款。

## 1. 运行库与通知

| 组件 | 实际版本/固定源码修订 | 上游许可 | 随包保留的原文 |
| --- | --- | --- | --- |
| Hugging Face Transformers.js | npm `@huggingface/transformers@3.8.1`；`2ec882e739e4cb461f8d440d4d7394cbf5372429` | Apache-2.0 | `transformers-LICENSE` |
| ONNX Runtime Web，词对齐 | npm `1.22.0-dev.20250409-89f8206ba4`；完整修订 `89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0` | MIT；附上游聚合通知 | `onnxruntime-web-LICENSE`、`onnxruntime-web-ThirdPartyNotices.txt` |
| ONNX Runtime Web，PaddleOCR 依赖 | npm `1.31.1`；官方 `v1.31.1` 对应 `6af1a932e2286d5c58166085d24c68783033edee` | MIT；附上游聚合通知 | `ocr-onnxruntime-web-LICENSE`、`ocr-onnxruntime-web-ThirdPartyNotices.txt` |
| PaddleOCR JavaScript SDK | npm `@paddleocr/paddleocr-js@0.4.2`；`e5046169b225bcdfbe25d45b4e809ff0f1a69c2c` | Apache-2.0 | `paddleocr-LICENSE`，从官方源码取回，npm 包没有附该文件 |
| OpenCV.js 包 | npm `@techstark/opencv-js@4.10.0-release.1`；`6a539c08d2ca78dc544dc6fee670af38740c4237` | Apache-2.0 | `opencv-js-LICENSE` |
| OpenCV 上游 | `4.10.0`；`71d3237a093b60a27601c20e9ee6c3e52154e8b1` | Apache-2.0 | `opencv-upstream-LICENSE` |
| PDF.js | npm `pdfjs-dist@6.5.438`；`0a4153349dc473ba950fc17941c5ca7eda43c1de` | Apache-2.0；字体/编解码器等有单独许可 | `pdfjs-LICENSE` 及下文资源通知 |
| Clipper，OCR 多边形处理 | npm `clipper-lib@6.4.2`；`97a4d5e79671973b457c13432d8e8c4107f8a51d` | Boost Software License 1.0；内嵌 JSBN 另保留其声明 | `clipper-BOOST-LICENSE.txt`、`clipper-COPYRIGHT-HEADER.txt`、`clipper-jsbn-LICENSE` |
| YAML 解析，PaddleOCR 依赖 | npm `js-yaml@4.3.2`；`79ca68d90f333fbe6d9e42827527e62636200191` | MIT | `js-yaml-LICENSE` |
| Hugging Face Jinja，Transformers 依赖 | 本机锁定安装 `@huggingface/jinja@0.5.11`，实际 npm 来源见清单 | MIT | `huggingface-jinja-LICENSE` |

Transformers 使用浏览器预构建入口。其 Node 分支的 `onnxruntime-node`、`sharp` 不作为扩展执行入口；本表不将本机测试工具链等同于浏览器发行包。Jinja 是本机锁文件解析出的依赖版本；上游预构建 Transformers 文件可能已经内嵌构建时的依赖，归档同时保留了本机依赖声明。

ORT 的 npm 包没有可供复制的根 LICENSE/ThirdPartyNotices 文件，因此本次从 Microsoft 官方仓库固定源码修订补齐。两份聚合通知保持完整，未推断哪些可选模块编译进 WASM，也未删改上游版权文字。PaddleOCR、OpenCV、OpenCV.js 的固定修订根目录 `NOTICE` 经请求返回 404；没有据此生成假 NOTICE。

## 2. PDF 字体、CMap 和 WASM

`prepare-assets.mjs` 复制 PDF.js 的 `cmaps/`、`standard_fonts/`、`wasm/` 原目录。这些目录内的上游许可继续保留，并在 `public/licenses/` 另存一份，便于分发核对。

| 资源目录 | 单独保留的原文 |
| --- | --- |
| `cmaps/` | `pdfjs-cmaps-LICENSE` |
| `standard_fonts/` | `pdfjs-standard_fonts-LICENSE_FOXIT`、`pdfjs-standard_fonts-LICENSE_LIBERATION` |
| `wasm/` | `pdfjs-wasm-LICENSE_JBIG2`、`LICENSE_OPENJPEG`、`LICENSE_PDFJS_JBIG2`、`LICENSE_PDFJS_OPENJPEG`、`LICENSE_PDFJS_QCMS`、`LICENSE_PDFJS_QUICKJS`、`LICENSE_QCMS`、`LICENSE_QUICKJS`，均带 `pdfjs-wasm-` 文件名前缀 |

这些资源包含各自的作者声明、MIT/BSD 等条款以及 Liberation 字体许可。以文件原文为准，不以 PDF.js 自身 Apache-2.0 概括全部资源。

## 3. 词对齐模型

扩展使用 [Xenova/multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78) 的 q8 ONNX 转换，固定修订为 `761b726dd34fb83930e26aab4e9ac3899aa1fa78`。转换仓库模型卡明确指向 [intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small)。

上游模型卡在固定修订 `614241f622f53c4eeff9890bdc4f31cfecc418b3` 明确声明 `license: mit`，本次完整保留为 `e5-upstream-MODEL-CARD.md`。转换模型卡保留为 `e5-converted-MODEL-CARD.md`。两个模型仓库在所核实修订没有单独 LICENSE，转换模型卡也没有独立许可字段；本项目没有补写模型版权人或声称转换者另行授予了未公布的许可。

E5 官方源码位于 Microsoft unilm 项目，该仓库 MIT 原文在修订 `31c5b904ca1bf2afb4c234a6675c683a4e5fc7cd` 保留为 `e5-code-unilm-LICENSE`。这是官方源码许可证，与上游权重的模型卡 MIT 声明分别记录，不能将前者当作转换仓库原本存在的 LICENSE。

实际模型数据下载地址形式如下，所有文件使用同一固定修订：

```text
https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/config.json
https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/tokenizer.json
https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/tokenizer_config.json
https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/onnx/model_quantized.onnx
```

`sources.json.modelArtifacts` 记录本次真实验证缓存的字节数和 SHA-256；量化 ONNX 为 118,308,185 字节。这些 SHA-256 用于来源记录，当前 Transformers.js 运行时依赖固定修订下载，并未额外实现逐文件 SHA-256 校验。真实模型的推理与浏览器验证结果见 `B3-DICT-ALIGN.md`，本次许可证归档没有再次运行大模型。

## 4. OCR 模型

PaddleOCR SDK 和上游 PaddleOCR 项目声明 Apache-2.0，保留官方源码的 `paddleocr-LICENSE`。本项目使用官方发布的 PP-OCRv5 mobile ONNX 模型，未伪造单独模型版权或生成归档中不存在的 LICENSE。

模型下载基础地址固定为：

```text
https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/
```

| 模型文件 | 运行时要求的 SHA-256 |
| --- | --- |
| `PP-OCRv5_mobile_det_onnx_infer.tar` | `781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30` |
| `PP-OCRv5_mobile_rec_onnx_infer.tar` | `f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c` |

`offscreen/media.ts` 下载后和读取缓存后均核验散列。服务商的模型 URL 没有 Git 修订参数；固定散列承担实际内容版本约束。清单保存完整下载 URL，不将 SDK 的源码提交号写成这些模型归档的构建提交号。

## 5. ECDICT 离线数据

原始数据来自 [skywind3000/ECDICT 的固定修订](https://github.com/skywind3000/ECDICT/tree/39cfb9672c0906b63569e0453c2e6abfb9ab182a)，使用该仓库 MIT 许可，原文同时保留在 `public/dict/LICENSE-ECDICT.txt` 和 `public/licenses/ecdict-LICENSE`。

扩展中的 100,000 条高频词典是从官方 CSV 筛选、归一化及去重后的派生数据。完整导入脚本支持重新生成，数据来源和原始 CSV/派生 gzip 散列在 `public/dict/manifest.json`。没有将测试词条或手写样例冒充完整 ECDICT。

## 6. 远程模型数据与本地执行文件

浏览器执行的应用 JavaScript、Transformers.js、PaddleOCR/OpenCV.js、ONNX Runtime 的 MJS/WASM，以及 PDF.js worker 来自扩展本机包。词对齐 offscreen 只下载固定修订的 ONNX 权重、分词器及配置 JSON；OCR 只下载固定 SHA-256 的模型归档。解析模型、张量计算和文本处理由本机打包代码完成。模型文件是数据，不等于远程 JavaScript/WASM。

许可证目录未包含 E5 或 PaddleOCR 的整个权重文件；权重由能力首次初始化时按上述地址获取并缓存。许可证目录、ECDICT 数据及运行代码随扩展分发。实际构建的本地运行资源路径及权限限制以 `wxt.config.ts` 和 `gateway/scripts/prepare-assets.mjs` 为准。

## 7. 可复核清单与更新方法

`public/licenses/sources.json` 包含 29 份上游原文条目、9 个 npm 包的官方 registry 元数据，以及 6 个模型数据文件的来源记录。每份原文含字节数、SHA-256；npm 元数据含精确版本、tarball URL、integrity 和能取得的 gitHead。需要完整 URL 或机器读取时使用该清单，避免只依赖文档中的显示名称。

本次归档校验逐一检查文件存在、非空、字节数和散列与清单一致，另检查 MIT/Apache/Boost 等标志以及两个模型卡的来源声明。未改动许可证原文，也未再次运行推理。历史 Stanford JSBN 原始许可地址访问超时；`clipper-jsbn-LICENSE` 取自 jsbn npm 维护仓库 `andyperlitch/jsbn` 的 `57257b2763b4179e20196fca6714cb5dbc20806d` 历史修订，明确记为镜像。Clipper 包原始文件头的 Tom Wu 引用另原样保存，未拿 npm 的简写字段替代其额外保留通知条件。

升级时按以下顺序处理：

1. 确认 `package-lock.json` 的实际解析版本及嵌套依赖，尤其两版 ORT 不能混用许可来源。
2. 优先复制 npm 包原有 LICENSE/NOTICE；包内缺少时，从对应官方仓库固定版本/源码修订取回，并记录实际 URL。
3. 对权重分别核实模型卡许可声明、转换关系、固定修订/散列。不要将代码仓库提交或许可文件冒充不存在的模型声明。
4. 保留字体、CMap、WASM 编解码器等子资源自身通知；不要只保留顶层项目 LICENSE。
5. 重算归档文件散列，更新清单与本文版本表，构建后检查扩展中的 `licenses/` 和资源目录中的许可文件。

本归档针对本次新增后端组件，不是开发工具链所有依赖的完整 SPDX SBOM，也不声称上游聚合通知中的所有可选组件都在当前浏览器发行包内启用。
