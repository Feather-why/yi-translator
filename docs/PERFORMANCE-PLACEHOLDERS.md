# 本地模型与占位符恢复性能

日期：2026-11-03。本文覆盖本地适配器与格式恢复，不含页面扫描、DOM 渲染、翻译队列或 GPU 并发参数的专项结果。前端与公共翻译端口保持原有行为。

## 已知开销与测量依据

原恢复流程先尝试完整带标签翻译两次；失标后，最多翻译六个短语锚点，再生成带术语参考的完整译文，最后用精确词面、词典义项或真实词映射放回格式。词组译文只用作锚点，不按源文顺序拼成正文。

此前 `work/quality-real-model.json` 的真实 GPU 小样本为五种文本各测冷 / 热两次：

| 文本 | 冷 / 热请求次数 | 冷 / 热总耗时 | 路径 |
| --- | --- | --- | --- |
| Wikipedia 首定义段 | 6 / 6 | 795 / 849 ms | 2 次失标、3 次短锚点、1 次整句 |
| 引文编号 | 1 / 1 | 279 / 279 ms | 带标签直出 |
| 嵌套与原子 | 1 / 1 | 210 / 207 ms | 带标签直出 |
| 三句段落 | 1 / 1 | 234 / 247 ms | 带标签直出 |
| 长外层格式 | 2 / 2 | 868 / 872 ms | 长文本分块 |

这组专门挑选的十次记录中，进入多锚点投影的是同一个主复现的两次运行。它不能代表真实网页的失标比例，也不能把两次请求一律解释为重试。旧记录只提供总耗时和调用文本，不能事后虚构 prompt / generation 分项。

此前官方结构化模板、分隔符、只插回标签等真实试验仍存在丢标、复制原文或泄漏指令，不能据单次成功直接换提示。当前 1.0.4 适配器保留已验证的整句模板、采样参数与用户自定义配置。本次适配器改动仅增加实际响应计时回调，版本按仓库规则递增。模型提示与采样依据：[Hy-MT2 官方模型卡](https://huggingface.co/tencent/Hy-MT2-1.8B)。

## 无文本诊断

`src/backend/placeholder-diagnostics.ts` 导出 `PlaceholderDiagnostic` 和回调类型。每次 helper 完成、无法定位、失败或取消只发送一次记录；诊断回调异常不影响翻译。记录不含原文、译文、URL、术语或密钥。

投影入口：

```ts
translateWithProjectedPlaceholders(source, translate, {
  sourceLang, targetLang,
  strategy: 'anchored', // 默认策略；候选为 lazy
  onDiagnostic: record => collect(record),
}, signal);
```

最终安全退路入口保留原三参数调用，并可加第四参数 `{onDiagnostic}`。

| 字段 | 口径 |
| --- | --- |
| `kind` | `placeholder-projection` 或 `placeholder-leaves` |
| `strategy` | `anchored` / `lazy` / `leaves` |
| `outcome` | `success` / `unresolved` / `error` / `cancelled` |
| `sourceChars` / `groups` / `atoms` | 输入 UTF-16 长度与格式节点数 |
| `modelCalls` | helper 调翻译回调的次数；不含 Core 外层两次带标尝试，回调内部长文本分块的 HTTP 另计 |
| `anchorCalls` / `plainCalls` / `leafCalls` | 短锚点 / 完整纯文本 / 最后叶子退路的回调次数 |
| `lookupCalls` / `alignmentCalls` | 实际发起词典和对齐回调次数 |
| `totalMs` | helper 入口到完成的单调时钟耗时 |
| `modelMs` | 等待翻译回调的累计耗时，包含该回调内部的排队、传输与推理 |
| `lookupMs` / `alignmentMs` | 等待相应辅助回调的耗时，词典仍有 45 ms 单次上限 |
| `restoreMs` | 总耗时扣除上述等待后的本机解析 / 定位 / 校验及调度余量，不称为纯 CPU 时间 |

Core 聚合、诊断 RPC、队列计时及 UI 后续展示由集成层接线；helper 不增加公共端口字段，也不接触前端渲染。

## llama.cpp 实际服务计时

`ProviderContext.recordTiming?: (timing: ProviderTiming) => void` 是可选内部注入。只有真实响应存在有效 `json.timings` 时才回调：

| 回调字段 | 实际来源 |
| --- | --- |
| `phase: 'model'` | 表示服务返回的本次模型计时 |
| `promptMs` | `timings.prompt_ms` |
| `generationMs` | `timings.predicted_ms` |
| `promptTokens` | `timings.prompt_n`，本次实际评估的 prompt token 数，可能不含已缓存部分 |
| `outputTokens` | `timings.predicted_n` |

毫秒必须是有限非负数，token 数必须是非负安全整数。缺失和非法字段保持缺失；没有有效字段时不发送记录，不把 HTTP 总耗时冒充生成耗时，也不猜测服务排队。截断响应依旧报错，但可保留模型实际花费的时间。依据：[llama.cpp b12069 官方 timings 文档](https://github.com/ggml-org/llama.cpp/blob/b12069/tools/server/README.md#timings-and-context-usage)。

## 保守的少请求候选

`strategy: 'lazy'` 为可测候选，默认仍保留原 `anchored`：

1. 先翻译连贯完整正文。
2. 用已有精确词面、真实词典义项和已热真实词映射恢复原格式；证据足够即返回。
3. 只翻译尚未定位节点的短锚点，把它们放到第一遍自然译文里。此阶段不重译正文。
4. 仍无法定位才补齐原六锚点预算内的术语，并回到原有整句术语模板。无法严格恢复仍返回 `null`，由既有最终安全退路处理。

两种策略均严格校验数量、编号、父子层级和原子标记；没有比例贴链接或未经校验的 fast 译文。六个独立锚点预算不变，重复短语共用结果。候选最好只需一次完整译文，最坏可比原策略多一次完整译文；因此必须通过真实样本验证后再决定启用范围。fast 阶段直接采用叶子碎片会重现已修复的语序问题，本次没有这样提速。

## 验证

离线专项共 35/35 通过：原质量 helper、Core 质量、候选性能 helper、llama.cpp 适配器。新增覆盖已有词典 / 真映射边界只需一次完整回调、只补未定位锚点、保留术语整句退路、嵌套预算、原子和过宽伪对齐拒绝、诊断隔离及取消。单测中 API 边界数据用于验证算法和计数，不作为真实模型速度证据。

真实比较脚本 `tests/backend/placeholder-performance-real.mjs` 已准备，输出 `work/placeholder-performance-real.json`。它使用真实 8081 适配器和真实 ECDICT，保持官方采样，测试固定 seed 42；可用 `WITH_ALIGNMENT=1` 增加已缓存 E5 q8 的真实 CPU 热对齐，禁止下载缺失模型。记录每次实际 HTTP、服务计时、helper 诊断、结构校验与主复现语义断言。该脚本测适配器 / 恢复链，Core 队列和网页 DOM 另测。

真实独占 GPU 比较已完成，20 行均通过结构校验；主复现另外断言完整“一种语言→另一种语言”句义，以及三个实际标签仍包围机器翻译、转换 / 翻译、语言，不采用原来的碎片措辞。

| 主定义段条件 | anchored 实际 HTTP / 耗时 | lazy 实际 HTTP / 耗时 | helper 内部回调 |
| --- | --- | --- | --- |
| 真实 ECDICT、无词映射 | 6 / 857 ms | 5 / 711 ms | 4 → 3，锚点 3 → 2 |
| 真实 ECDICT、已热 E5 CPU 词映射 | 6 / 763 ms | 3 / 690 ms | 4 → 1，锚点 3 → 0 |

lazy 的真实正文：`机器翻译是利用计算技术将文本或语音从一种语言转换成另一种语言的过程，包括两种语言的语境、习惯表达和实际用法等细微差别。` 链接与格式由原编号严格恢复，两个条件均没有进入叶子退路。

其余四类样本（引文、嵌套原子、多句、外层格式）在两个条件、两种策略下共 16 行均只用一次带标请求，未调用恢复 helper。这些行的两策略延迟差不能归功于 lazy，尤其本轮固定 anchored 在前、lazy 在后；逐请求保存了服务 `cache_n`、精确 `sourceHash` / `promptHash`。上表是同机小样本的观察值，包含不同 prompt cache 热度，不是冷启动、P50/P95 或受控显著性结论；可靠变化首先是困难段请求数减少。

主定义段仍先花约 500 ms 做两次失败的带标生成；helper 只占总时长的一部分，因此热路径 HTTP 数减半没有让端到端耗时减半。没有为了跳过这两次而发布未经质量验证的新提示或碎片退路。

独立网页基线的结构样本没有触发结构恢复，整页瓶颈主要由 combined 重复调用专项评估；本 helper 结果不能推广为整页普遍失标比例或整页提速。helper 的兼容默认仍为 `anchored`；0.2.3 最终 Core 仅对 `kind:'local'` 显式选择 `lazy`，其他提供方保持原策略。最坏多一次完整译文的边界继续保留，后续可用匿名诊断观察实际频率。最终适配器 1.0.5 只在 1.0.4 诊断基础上把默认并发改为 6，未改提示词或采样。
