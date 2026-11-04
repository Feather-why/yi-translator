# B3：离线词典、CPU 词对齐与联动高亮后端

实施日期：2026-11-03。前端入口、内容脚本和现有 `dict:lookup` / `align:get` 请求格式不变。

## 交付范围

| 模块 | 实现 | 主要文件 |
|---|---|---|
| 离线词典 | 真实 ECDICT 高频 100,000 条唯一词，首次导入 IndexedDB | `src/backend/dict/index.ts` |
| CSV 导入 | 支持逗号、双引号转义、引号内换行的 ECDICT CSV | `src/backend/dict/csv.ts` |
| 词形还原 | 依据 exchange 的词根及过去式/复数等索引 | `src/backend/dict/index.ts` |
| 词级对齐 | 真实多语言编码器 ONNX 词向量、双向互为最佳匹配 | `src/backend/align/algorithm.ts` |
| 词组修正 | ECDICT 的完整词义约束，修正“浏览/器”等中文分词 | `src/backend/align/dictionary-links.ts` |
| 模型运行 | 唯一 offscreen 文档，默认 CPU/WASM，不占翻译 GPU | `src/entrypoints/offscreen/` |
| 预计算与缓存 | 译文到达后的预计算、LRU、在途去重、即时启发式回退 | `src/backend/align/index.ts` |

译文记忆和差评降权由核心后端接入：本模块的词对齐缓存只存原译句及区间结果，不改变用户译文。核心必须在 `noCache` 场景跳过预计算和缓存。

## 离线词典数据与许可证

数据来自 [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)，固定修订：

```text
39cfb9672c0906b63569e0453c2e6abfb9ab182a
```

上游完整 CSV 共 66,009,548 字节。本项目按照 `bnc` / `frq` 频率优先，辅以 Collins 星级排序；规范化大小写、去重后保留 100,000 个唯一词条。词库不是手写示例，也没有从在线大模型生成伪词典数据。

发布资源：

- `public/dict/ecdict-100k.json.gz`：约 5.37 MiB，解压 JSON 约 14 MiB。
- `public/dict/manifest.json`：来源修订、列顺序、实际数量、CSV 与压缩文件 SHA256。
- `public/dict/LICENSE-ECDICT.txt`：上游 MIT 许可证原文，必须随资源分发。

重新生成：

```powershell
node gateway/scripts/import-ecdict.mjs --download
```

也可以使用已下载的完整 CSV：

```powershell
node gateway/scripts/import-ecdict.mjs --csv .\work\ecdict.csv --limit 100000
```

脚本默认输出到 `public/dict/`；`--out` 可指定输出目录。为避免无意切换数据版本，下载 URL 使用固定修订，不跟随 master 自动变更。

### 存储与查询语义

词典使用独立的 IndexedDB `translate-ecdict`，不修改翻译缓存数据库：

- `words`：规范化词形为键，保存真实词典字段。
- `forms`：词形变体到词根的索引。
- `meta`：已导入词数。

首次导入是一次性准备操作，需要数秒；后端启动时可后台调用 `dictionary.ready()`，避免首次划词承担导入等待。普通查询直接通过 IndexedDB 或最近 256 次的内存结果缓存完成，不扫描完整词库。

支持 exchange 字段中的 `0`（词根）、`p`（过去式）、`d`（过去分词）、`i`（现在分词）、`3`（第三人称单数）、`s`（复数）、`r`（比较级）、`t`（最高级）。例如 `running`、`ran`、`runs` 可回到 `run`，`apples` 可回到 `apple`。结果中 `word` 是用户查询词，`lemma` 是还原后的词根，来源为 `ecdict`。

当前打包的是英汉词典；非英语源语言或非中文目标语言返回 `null`，不伪装成支持所有语言。词库外词同样返回 `null`，交由现有前端翻译流程处理。

## 词对齐模型

使用 [Xenova/multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small) 的 q8 ONNX 编码器，固定修订：

```text
761b726dd34fb83930e26aab4e9ac3899aa1fa78
```

其上游 [intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small) 采用 MIT 许可，是基于 Multilingual MiniLM 的 12 层、384 维编码器。它实际输出 `last_hidden_state`；实现显式检查维数，避免把 fill-mask 模型的词表 logits 当成词向量。

此处采用 **SimAlign 风格的编码器对齐算法加词典约束**，没有声称使用经过 awesome-align 专门微调的权重。选择较小模型是为了降低浏览器 CPU 交互延迟；单词对应只是辅助阅读，不能视作逐词金标准翻译标注。

### 推理与字符区间

1. `Intl.Segmenter` 以可见原文和译文分词，所有区间使用 JavaScript UTF-16 索引；emoji、中文、组合语言不会被换算成 UTF-8 字节位置。
2. 模型输入按官方要求添加 `query: ` 前缀；这个前缀不出现在返回区间中。
3. 用相同 tokenizer 对完整前缀编码定位子词，避免逐词单独编码时 SentencePiece 为标点添加额外词首标记。
4. 合并每个词对应的上下文子词向量，计算余弦相似度，再取双向互为最佳的词对。
5. 英汉场景用 ECDICT 的完整词义修正词组。旧词库的“浏览程序”与页面上的“浏览器”允许通过实际存在的构词后缀对应；不会在译文中插入或改写词语。

例如 `browser` 能连到中文的“浏览/器”两个相邻分词，`page` 能连到“页/面”。前端可把这些区间合并成词组高亮。

单次模型计算最多约 254 个内容子词；过长句子回退到启发式，而不是返回越界区间。模型没有准备好、下载失败或超过交互预算时，立即返回相同数字/拉丁词等可验证链接，或空 `links`。

### 模型生命周期与 MV3

- 重型运行库和模型均位于 offscreen 文档；页面和 service worker 不执行矩阵计算。
- 默认 `device:'wasm'`、一个 CPU 线程，不与本地翻译模型争抢 GPU 显存。
- 需要扩展 CSP 中的 `'wasm-unsafe-eval'`；执行的 JavaScript 和 WASM 必须随扩展打包到本地 `assets/onnx/`。
- 远程只下载固定修订的 JSON、tokenizer 和 ONNX **数据**，不下载可执行 JavaScript。
- 权重由浏览器 Cache API 缓存；首次准备可能需要十几秒，界面先使用启发式，不等待下载完成。
- 计算结束后闲置 10 分钟释放模型会话；后续请求可重新初始化。

推理库为 `@huggingface/transformers@3.8.1`。模型文件不作为前端运行代码；模型转换仓库和上游许可证说明应随发行文档保留。Transformers.js 与 ONNX Runtime 的打包许可证也需随发行包分发。

## 后端集成 API

```typescript
const dictionary = new Dictionary();
void dictionary.ready();
const alignment = new AlignmentService({ dictionary });

await dictionary.lookup('running', 'en', 'zh-CN');
await alignment.get(pairs);
void alignment.precompute(pair);
```

`AlignmentService.get(pairs, options)` 的内部选项：

- `noCache:true`：不读、不写词对齐缓存。
- `localOnly:true`：即使配置远程节点，也不能把这些句子发往远程；用于敏感页面和隐身。
- `waitForModel:true`：用于明确的准备/验收流程，等待真实结果；普通页面交互不要使用。

正常 `get` 首次会立即返回启发式并后台预计算。模型已准备好时，现算预算为 280ms，超时则先回退，后台完成的结果供后续查询使用。缓存键包含两端文本和语言，不依赖临时 `id`；同句不同 `id` 的请求会返回各自正确的 `id`。

可通过 `configure({enabled,remoteUrl,token})` 配置远程对齐节点；请求使用 `/v1/align`、Bearer、`credentials:'omit'` 和超时。返回的 token 区间、链接下标、数量都校验，非法结果不进入缓存。配置中的 token 仅在内存中使用，由上层密钥模块负责加密保存。

offscreen 通信入口为：

```text
{target:'tx-offscreen', task:'align:init', payload:{}}
{target:'tx-offscreen', task:'align:get', payload:{pairs}}
```

`main.ts` 导出的 `offscreenTasks` 注册表供 OCR/PDF 共用同一个文档，不创建第二份 offscreen 页面。

## 测试与实测结果

自动回归：

```powershell
npm run test:backend
```

B3 新增 13 项，覆盖：完整词库数量、CSV 引号/换行、exchange、查询隔离、UTF-16/emoji、向量匹配、词组约束、首次回退、缓存命中、在途去重与各自 id、敏感页面本地限制、`noCache`、远程鉴权和错误区间。

真实模型验收（首次需要下载固定权重）：

```powershell
node tests/backend/align-real-model.mjs
```

该脚本用 CPU ONNX 会话和真实词库验证 `I/like/apples → 我/喜欢/苹果`、`browser → 浏览器`、`mat → 垫子`。本机三对短句约 23ms、13ms、11ms；权重已缓存时模型加载约 540ms。报告位于 `work/b3-real-model.json`。

真实浏览器离线存储及 WASM 验收：

```powershell
$env:BROWSER_EXECUTABLE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node tests/backend/offscreen-browser.mjs
```

此脚本使用独立临时 Edge 资料夹，构建并执行真实 offscreen 源码。权重请求可由已下载的官方固定权重字节回放，**推理本身仍由浏览器 WASM 实际执行**；不会用模拟向量冒充 ONNX。

第一次实测：词典导入 9.4 秒，`running → run` 的真实 IndexedDB 查询 7.8ms；模型初始化约 15.5 秒，已加载模型单句对齐 115ms，匹配正确。增强测试还核对 IndexedDB 实际唯一词数。报告位于 `work/b3-offscreen-browser.json`。首次导入/下载时间与后续交互性能分开记录。

最终增强实测（规范化后唯一词库及官方 `query:` 前缀）：IndexedDB 实际存储 100,000 词，首次导入 9.37 秒、查询 1ms，模型初始化 13.78 秒，WASM 单句对齐 127ms；`apples → 苹果` 正确。

这些是本机小样本，不等同于所有语言、任意长度和设备都能达到同样速度。模型失效时会明确回退，不把启发式结果记录为真实模型成功。
