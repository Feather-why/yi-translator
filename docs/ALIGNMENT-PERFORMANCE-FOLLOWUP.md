# 对齐精度保护与性能复测

本轮只修改 `src/backend/align/index.ts` 和实际路径 `src/backend/align/local-pairs.ts`，并补充对齐测试。没有修改前端、核心翻译器或标签恢复 helper，也没有使用 GPU/生产翻译模型进行本轮对齐测量。

## 已修复的问题

普通结果缓存过去只区分文本和语言，没有区分实际本机/远程来源。先请求远程再要求 `localOnly` 时会读到远程结果；反向顺序也可能错误跳过远程请求。现在普通、严格投影和在途任务均区分实际来源。没有远程配置时，普通预计算与 `localOnly` 请求都属于本机，可以合并为一份实际任务；敏感请求的 `noCache` 仍跳过结果缓存和在途合并。

词典未准备时生成的未精修结果，过去在词典就绪后仍可能一直命中。现在缓存键区分词典是否就绪，避免将旧阶段的结果当成已精修结果。配置更新会清除在途合并键，并用 generation 拒绝旧节点/旧初始化的迟到结果；dispose 后迟到的初始化也不能重标模型 ready 或继续推理。

成功获得真实结果时，不再同时提前跑备用词典链。备用链只在模型禁用、失败或有界等待结束后运行。保留原来的 5 秒真实结果等待预算；超时后的词典备用链最多另等 45ms。正常与严格结果仍保留原有的边界过滤和独立快照，没有为减少一次过滤而假定复杂引用的消歧必定幂等。

## 相同窗口的单请求复用

`alignSentencePair` 对完全相同的文本和语言只在本次调用内复用 E5 向量。结果仍按每次窗口的原始 UTF-16 偏移还原，不合并词、不改变词级 links，也不按位置增加对应。最多保留 64 个窗口、2048 个词向量；函数结束即释放该表。不同请求、页面和 `noCache` 调用之间不会复用正文向量。

这种优化对重复句特别有效；普通页面没有重复窗口时，E5 编码次数不变，不能将下面的重复句收益推广到所有首次选择。

## 真实 CPU 测量

测量实际运行固定 q8 `Xenova/multilingual-e5-small`，使用已经下载的固定修订权重以及本机 ECDICT。前后各自加载模型，以下首次请求耗时均不包含权重加载；每例随后做 10 次缓存命中及一次允许缓存的严格投影。没有在线下载、假模型或 GPU 翻译。五例的完整 `srcTokens / tgtTokens / links / spans` 已逐项 deepEqual，前后完全相同。

| 样例 | 首次请求前→后 | E5 编码次数前→后 | 词典调用前→后 |
| --- | --- | --- | --- |
| Phonetics/concerns 整段 | 198.8→175.4ms | 12→12 | 122→61 |
| Sealand 引用 | 19.3→16.9ms | 2→2 | 28→14 |
| Babylon 缺句末标点 | 24.0→20.2ms | 2→2 | 40→20 |
| 嵌套链接对应的可见纯文本 | 20.0→17.3ms | 4→4 | 30→15 |
| 相同句重复 40 次 | 287.8→21.5ms | 80→2 | 10→5 |

重复选择缓存命中的 P50 约为 0.026–0.347ms，原来就很快；严格投影缓存命中约为 0.028–0.394ms。它们不含浏览器消息往返、Range 绘制、模型首次下载或网页渲染，也不是整页端到端 P50。首次耗时是单次小样本，可能受 CPU/JIT 和系统调度影响；确定的工作量变化是词典调用减半、重复窗口由 80 次编码降到 2 次。

## 精度与前端边界

本轮没有改变引号、完整句子、concerns 或已有链接的语义判断，而是避免来源/词典阶段不匹配的缓存，并减少重复工作。真实 Phonetics、Sealand、Babylon 和嵌套链接可见文本的所有对齐结果与基线一致。`spans` 仍由后端返回，现有前端尚不消费；整句连续强高亮及页面内旧 Promise 的失效，仍须按 `SELECTION-FOLLOWUP.md` 交给前端处理。

策略版本从 `2026-11-selection-boundaries-v1` 升到 `2026-11-selection-boundaries-v2`，避免复用旧缓存身份。没有新增持久化正文或词向量缓存，固定权重缓存可继续保留。

## 回归与复现

新增 8 项聚焦回归先在冻结的旧 build 上全部失败，修复后全部通过。连同原对齐测试共 39/39 通过，合约 TypeScript 严格编译通过。覆盖真实结果不跑多余备用链、两个缓存来源顺序、严格投影来源、词典就绪变化、单请求复用与跨请求隔离、实际本机在途合并、配置更新及 dispose 的迟到初始化。

```powershell
node node_modules/typescript/lib/tsc.js -p tests/contract/tsconfig.json
node --test tests/backend/align.test.mjs tests/backend/align-sentences.test.mjs tests/backend/align-selection.test.mjs tests/backend/align-performance.test.mjs
node tests/backend/align-performance-real-model.mjs
```

前后原始数据为 `work/align-performance-before.json` 与 `work/align-performance-after.json`。冻结的旧对齐编译文件位于 `work/align-performance-baseline/`，可在本轮工作副本中通过以下环境变量复跑基线；它们只用于实验，不部署到扩展。

```powershell
$env:ALIGN_PERFORMANCE_BUILD='work/align-performance-baseline'
$env:ALIGN_PERFORMANCE_LABEL='before'
node tests/backend/align-performance-real-model.mjs
```

跑新版前需移除这两个环境变量，使用当前 `tests/.compiled/backend/align`。比较脚本应对每例完整结果做深度相等检查，不能只比较耗时后声称精度未变。
