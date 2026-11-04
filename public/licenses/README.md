# 第三方许可证归档

本目录随扩展一起分发，保存 B3—B5 新增后端运行库、PDF 资源、词典及模型的上游许可和通知原文。详细说明见项目 `docs/THIRD-PARTY.md`。

`sources.json` 记录每份文本的真实下载地址或 npm 包内路径、固定源码修订、npm 包版本/完整性值、文本字节数和 SHA-256。版权文字来自原文件，没有补写或改写版权人。`clipper-COPYRIGHT-HEADER.txt` 仅提取包中连续的文件头注释，提取范围已记录。

扩展执行的 JavaScript、ONNX Runtime/WebAssembly、OpenCV 和 PDF worker 来自本机扩展包。远程获取的 E5 ONNX/JSON 和 PaddleOCR 模型归档属于模型数据；它们不是动态加载的远程 JavaScript/WASM。E5 下载固定 Hugging Face 修订，PaddleOCR 另在运行时核验固定 SHA-256。模型数据通常缓存在浏览器内，并未作为整个权重文件放入本许可证目录。

E5 上游模型卡明确声明 MIT；所用 ONNX 转换仓库没有独立 LICENSE。保留 `e5-upstream-MODEL-CARD.md`、`e5-converted-MODEL-CARD.md` 和官方 E5 源码仓库的 `e5-code-unilm-LICENSE`，分别说明模型声明、转换来源及代码许可，未将代码 LICENSE 冒充另行取得的权重许可。

ORT 两版 `ThirdPartyNotices.txt` 是上游完整聚合通知，包含可能未编入本扩展的可选组件，保持原文。PDF.js 的字体、CMap、WASM 各自通知也单独保留，不能用 PDF.js 自身 Apache-2.0 文件替代。历史 Stanford JSBN 原网址本次访问超时，`clipper-jsbn-LICENSE` 来自维护中的 jsbn npm 仓库固定历史修订；该镜像来源已在清单中明确区分。

升级依赖、模型或词典时，必须同步更新对应许可、来源修订和散列。此归档针对本次后端新增组件，不自称整个开发工具链的 SPDX SBOM。
