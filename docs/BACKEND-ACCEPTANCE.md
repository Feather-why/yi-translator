# B2–B5 实施、测试与交接总览

日期：2026-11-03。当前正式版本 **0.2.5**、后台 `0.2.5-semantic`，协议仍v2。最新量化复核、嵌套标签语义恢复与划词计算提速见 [QUANTIZATION-SEMANTIC-FOLLOWUP.md](QUANTIZATION-SEMANTIC-FOLLOWUP.md)。保留生产Q4，不修改前端；连续整句高亮仍待接，已原样集成另一作者的PDF更新，体验由前端/用户验收。以下历史数据保留为对应版本的实施记录。

0.2.1 / 0.2.2 的整句翻译、concerns 语义对应、浏览器内置翻译、右键媒体与首次引导联调记录见 [QUALITY-FOLLOWUP.md](QUALITY-FOLLOWUP.md)。其中测试数量和耗时对应各历史版本，不作为当前性能结论。

## 本次范围

修复整页翻译中反复出现的占位符校验失败，完成 B2 精确档与调度、B3 词典和对齐、B4 规则/同步/密钥，以及 B5 图片/字幕/PDF 后端。按用户再次确认，现有前端不改；B5 提供能力、接口和测试，不增加图片覆盖层、字幕入口或 PDF 阅读器。

`src/frontend/**`、`src/entrypoints/content.ts`、`src/entrypoints/options/**`、`src/dev/**`、`tests/e2e/**` 与部署前项目当前版本逐文件 SHA256 相同。开发期间发现项目有独立的前端更新，已原样读入工作副本作为测试基准；部署不会写入这些目录。共用协议先在 HANDOFF 第 13 节记录后升级为 v2，原有 v1 调用仍兼容。新增后端入口包括 offscreen 与隔离的 OCR sandbox。

## 文档导航

| 文档 | 内容 |
|---|---|
| [BUGFIX-PLACEHOLDERS.md](BUGFIX-PLACEHOLDERS.md) | 真实网页复现、两层根因、保留原始标签的降级与性能代价 |
| [B2-SCHEDULER.md](B2-SCHEDULER.md) | 评分、对冲、熔断、半开、页面粘性与预算 |
| [B2-REMOTE.md](B2-REMOTE.md) | 三家适配器、网关启动、鉴权、NDJSON 和接口 |
| [B3-DICT-ALIGN.md](B3-DICT-ALIGN.md) | 100,000 词词典、词形还原、真实 ONNX 对齐与实测 |
| [B4-RULES-SYNC.md](B4-RULES-SYNC.md) | 规则管理、WebDAV 合并/冲突、密钥备份与 RPC 权限 |
| [B5-MEDIA.md](B5-MEDIA.md) | OCR 模型与缓存、字幕对应、PDF 坐标、完整请求示例与限制 |
| [BACKEND-V2-API.md](BACKEND-V2-API.md) | 后续前端接入的调用方式及接口索引 |
| [PROVIDER-OPTIONS.md](PROVIDER-OPTIONS.md) | 兼容项目当前服务设置页的高级配置与自定义实例 |
| [THIRD-PARTY.md](THIRD-PARTY.md) | 新依赖必要性、来源、许可证与模型分发边界 |
| [LOCAL-MODEL.md](LOCAL-MODEL.md) | 已部署的本机 GPU 模型、一键启动/停止与排错 |

## 分阶段验证

各阶段先独立验证，再进行统一回归；下表保留专项结果，避免用总测试数代替功能验收。

| 阶段 | 已执行验证 | 结果及实际环境 |
|---|---|---|
| 占位符修复 | 核心故障回归；真实 GPU 复杂标签样例 | 加强重试、适配器主动报错、标签叶子降级、格式错误不熔断；5 组真实本地模型样例全部通过结构校验 |
| B2 | 调度专项 7 项；适配器/网关专项 20 项 | 通过；包含取消、双失败、半开唯一批次、粘性、胜者缓存和双边记账；实际网关转发至本机 GPU 两段约 208ms |
| B3 | 词典/对齐专项 13 项；真实 CPU ONNX；真实浏览器 WASM | 通过；IndexedDB 唯一词数 100,000，热查词约 1ms，浏览器单句对齐约 127ms，`apples → 苹果`；首次导入约 9.37s、首次模型准备约 13.78s 单独计入 |
| B4 | 规则/同步/归档 21 项；RPC/服务接线 8 项 | 29/29 通过；两个独立客户端经真实本机 HTTP WebDAV，覆盖 ETag 412、墓碑、字段合并、用量计数及默认不上传密钥 |
| B5 | 媒体合约 7 项；真实浏览器图片/PDF 推理和完整 v2 RPC | 通过；PP-OCRv5 CPU 冷会话约 2222ms、扫描 PDF 热识别约 331ms；三类 RPC 均调用真实本地模型，保留坐标、编号和时间；详见 B5-MEDIA.md |

补充独立审查修复：同步译文记忆导入前验证占位符，整批通过才落库；存储专项 8/8。用量同步通过串行账本合并，避免导入期间覆盖本机在途请求的计数。

## 复现命令

需要 Node.js 22+。从项目根目录执行：

```powershell
npm ci
npm run typecheck
npm run test:backend
npm run build
$env:BROWSER_EXECUTABLE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npm run test:backend:browser
npm run test:e2e
npm run test:align:real
npm run test:align:browser
npm run test:media:browser
node tests/backend/placeholders-real-model.mjs
node tests/backend/page-real-model.mjs
```

`test:backend` 自带 strict/noUncheckedIndexedAccess 编译。浏览器测试使用独立临时资料目录，不读取用户的浏览记录或账户；原有前端测试文件不改。`test:e2e` 单独构建带明确 pseudo 服务的测试包；正式构建不注册 pseudo。

真实对齐和 OCR 首次需要获取固定模型数据；测试可以回放已经下载的同一官方权重原始字节，但始终执行真实 ONNX/WASM 推理。`placeholders-real-model.mjs`、`page-real-model.mjs` 和媒体完整翻译实测需要 `127.0.0.1:8081` 上的真实 llama-server。实际网页测试访问公开 Wikipedia、在三个滚动位置检查译文/错误、链接来源和精确 DOM 还原，不把懒加载的整页翻译说成瞬间处理了未滚动区域。原始性能数据和报告放在项目 `work/`，不能拿合成 HTTP 回放延迟宣称真实服务性能。

## 部署与浏览器更新

本机 Hy-MT2-1.8B Q4_K_M 继续使用 `runtime/` 中已有权重和 CUDA llama.cpp，只监听回环地址。运行 `gateway/scripts/start-local.cmd` 启动，`stop-local.cmd` 停止；不配置开机启动。

正式产物是 `.output/chrome-mv3`。浏览器已加载解压缩插件时，重新构建后还需在扩展管理页点“重新加载”，并刷新目标网页，使内容脚本也更新。只重建文件不会自动替换浏览器已运行的旧后台。

词典与 ONNX/PDF 本地执行文件使扩展明显变大；不把权重当远程代码加载。OCR/词对齐权重第一次下载后缓存；清除扩展数据会要求重新准备。主扩展不开放 `unsafe-eval`，OCR SDK 的动态函数仅在无扩展 API 权限的独立 sandbox 中执行。

## 验收边界

1. 没有用户云 API key、独立远程 7B 设备或用户 WebDAV 凭据，不宣称这些真实账户、跨机器链路或“7B 首段 <1.5s”已经验收。本机网关和两客户端 HTTP 验证的是实现及协议。
2. 对齐、OCR 和本机翻译性能是当前笔记本上的小样本；长句可能触发标签叶子降级，增加请求数。首次词典导入/模型下载不计入热查询目标。
3. B5 是后端完成范围。PDF 返回段落与坐标，不输出保留版式的新 PDF；BabelDOC 远程整本重排是可选后续集成。未添加 YouTube 请求监听、图片绘制层或 PDF 双栏界面。
4. Chrome 内置 Translator 未作为可用服务宣称；未配置云端时依靠已部署的本地模型。

## 最终统一回归记录

- 全量后端严格编译与自动测试：205/205 通过，无跳过；已在 `项目根目录` 实际项目安装后再次通过。
- 项目当前前端浏览器测试：11/11 通过；前端/内容入口/设置入口/开发假后端/原有端到端测试共 23 个保护文件部署前 SHA256 一致，部署过程不写入这些文件。
- 实际项目类型检查通过；依赖从本机缓存离线安装，安装时 npm 报告 0 个已知漏洞。
- 高级设置兼容新增 9 项回归，原生适配器新增 5 项，密钥删除新增 1 项。新选项实际进入地址、模型、提示词、温度、并发、超时、预算和缓存版本；未支持的高级项不通过 editable 暴露。
- 正式构建通过，未压缩扩展约 182.04 MB，包含本地执行库、ECDICT 和 `licenses/sources.json`；正式包不注册 pseudo。
- 正式包浏览器后端集成通过：实际 RPC/端口、5 次本机 HTTP 回放、1 次健康检查、嵌套占位符、缓存/noCache、加密密钥与重启持久化。
- 正式包连接真实本机 Hy-MT2，在公开 Wikipedia Machine translation 页面三个滚动位置验收：87/87、87/87、97/97 段 final，pending=0、error=0；首段约 1135ms，链接目标与原网页相同，还原后首段 innerHTML 完全相同，页面脚本错误为 0。
- 上述首段为一次独立浏览器实测，不能推导 P50；1135ms 高于原 B1 本地首段 800ms 的目标，本文不将这个性能目标记为达成。网页按视口懒加载，本次验证三个位置，未宣称已翻译尚未滚动的整篇区域。
- 实际网页截图与 JSON 由 `page-real-model.mjs` 生成；默认位于项目 `work/whole-page-real-model.*`，本次交付另附测试证据副本。部署后正式媒体复测通过：真实 offscreen OCR 2163ms、扫描 PDF 365ms，文字完整；三类正式 RPC 继续连接本地模型，全部断言通过。
- 用户已确认日常 Edge 的扩展重新加载。随后在该 Edge 中另开同一公开问题页面，按现有快速/双语设置复测：首屏 88/88、向下约两屏 99/99 段 final，pending=0、error=0；首段译文链接保持原地址，还原后首段 HTML/链接完全一致且译文元素为 0；页面控制台警告/错误为空。最后留在首屏双语状态，88/88 完成。此轮采用正常缓存策略，不作为无缓存或冷启动基准；与前面的独立 Edge 历史结果分开记录。交付证据为 `actual-edge-result.json` 和 `actual-edge-translation.jpg`。
