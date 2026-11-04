# 匿名性能统计与预热接线

2026-11-03。接口是协议 v2 的兼容扩展，已先记录在 `HANDOFF-BACKEND.md` 第 13 节；旧请求、返回和前端流程保持兼容。没有改前端源码。

## `performance:get`

仅本扩展管理页面可调用，普通内容脚本或其他扩展返回 `auth`。请求无 payload，返回标准 RPC 信封：

```js
const reply = await chrome.runtime.sendMessage({ rpc: 'performance:get' });
if (reply.ok) console.log(reply.data);
```

`data` 字段：

| 字段 | 含义 |
|---|---|
| `since`、`capturedAt` | 本次后台内存统计开始、快照生成的墙钟时间 |
| `http` | 实际提供方 `ctx.fetch` 的 HTTP 成功/失败/取消次数与完整响应体耗时 |
| `logical` | 每个逻辑 fast/accurate 调用的总耗时、成功/失败/取消、缓存是否命中 |
| `queue` | fast/final 任务从加入全局逻辑队列至真实 run 的等待，以及未开始即取消 |
| `shared` | 同段综合任务中，真实新建/复用的提供方工作数量 |
| `placeholder` | 占位符 helper 的类型、策略、结果、调用次数及阶段耗时聚合 |
| `modelTiming` | 适配器实际返回的 prompt/generation 时间和 token 数，缺失时不填 |

每行只使用固定的 providerId、tier/lane、kind、outcome、cache 等维度，含 `count`、`totalMs`、`minMs`、`maxMs`。需要均值时算 `totalMs / count`；没有声称提供精确 P50。token 行的 `totalMs/minMs/maxMs` 为零，累计 token 在 `counters.tokens`，`count` 是实际报告该字段的次数，不是段落数。

每个类别最多 128 行；超出维度合并到 `kind:'overflow'`、`outcome:'aggregated'`，该行不能再解释成某个特定服务/结果。拒绝未知枚举、非有限/负数或超限数值，providerId 只保留受限标识符，其他值归为 `other`。快照是独立副本，调用方不能改写内部数据。

## 统计口径

### HTTP 与模型时间

HTTP 在真正调用提供方的 fetch 前开始，到完整响应体读取/复制完成结束，分别计 success、failure、cancelled。包括网络、服务器内部排队、推理和传输，不称为“纯模型时间”。HTTP 2xx 但内容格式无效时，HTTP 可成功而逻辑翻译失败；非成功 HTTP、网络或 body 读取失败计 HTTP failure；调用方取消单列，超时未伴随外部取消仍计 failure。

这类 HTTP 是提供方 `ctx.fetch` 的请求，也可能包含提供方健康检查。规则订阅、同步、模型权重下载和独立预热模块的请求不在此分类中，不能把它当成整个扩展所有网络流量总计。

真实 batching 的两个逻辑片段合并成一次 HTTP 时，http 只增加一，logical 增加二；占位符重试或分块真的发了新 HTTP 才另计。不能从段落数推算请求数。

`ProviderContext.recordTiming` 只读取 `promptMs`、`generationMs`、`promptTokens`、`outputTokens` 的有限非负值，其他字段不转发。它们来自服务真实数据；服务未返回就没有该行，不填零冒充已测。模型字段和 HTTP 时间存在包含关系，不能直接相加。

### 逻辑工作、共享与排队

logical 包括初始化等待、缓存查询、选服务、排队、共享等待和提供方工作。命中缓存/记忆时标 `cache:'hit'`，实际请求成功为 miss，失败/取消为 none。该耗时不是 HTTP 耗时，更不是纯推理时间。

shared 只在同一段综合任务的私有调用表中观察已有工作：新条目记 created，实际借用已有条目记 reused。它既不建立全局内容索引，也不复用别的端口或任务。工作创建后可能在 HTTP 发出前取消，所以 created 不等于 HTTP。两档共享一次工作时逻辑调用仍各记一次，不能把 logical 次数当成模型实际执行次数。

全局逻辑队列以 `MeasuredQueue` 使用 32 个逻辑槽，并记录 fast/final 实际出队的等待。取消前尚未 run 的任务只计 `cancelled-before-start`，不计 started；它的耗时是“等到取消”，不是开始执行等待。提供方自身并发/QPS 等待不包含在这个 queue 表里，不能把队列统计当成所有后台等待。

### 占位符

placeholder 行按 helper 类型、策略和结果聚合，固定 counters 包括 sourceChars、groups、atoms、modelCalls、anchorCalls、plainCalls、leafCalls、lookupCalls、alignmentCalls、modelMs、lookupMs、alignmentMs、restoreMs。

sourceChars 仅为聚合字符计数；不存正文。modelCalls 是 helper 调用翻译回调次数，回调内部还可能分块/重试/batch，因此不是 HTTP 次数。modelMs 是 helper 回调等待总时间，仍可能包含排队/网络，不是原生推理时间。嵌套 helper 和外层 HTTP 有重叠，不应把所有阶段简单相加。

本轮只把本地 provider 的投影策略接为 `lazy`：先完整语境译文，缺乏证据时再补锚点；其他提供方保持 anchored。严格结构校验与安全降级保留，未改采样参数。离线回归分别验证 local 先请求整句、builtin 仍先锚点，最终嵌套标签结果正确，诊断回调抛错不破坏译文。

## 隐私与生命周期

collector 只有内存、有界聚合，不接 chrome.storage、IndexedDB、缓存、译文记忆或同步。没有原文、译文、URL、jobId、术语、密钥、响应内容或原始错误消息。即使 noCache/敏感任务也只汇总这类匿名计数，不创建内容记录。

后台 service worker 重启后重新计数。`performance:get` 只是读取，不触发保存、同步或模型加载。旧的 `perf:report`/`backend.perf` 与前端 `ui.perfLog` 是已有首屏统计机制，此接口不复用或改变它们的存储规则。

Core 的 onPerformance、占位符回调、提供方 recordTiming 和队列回调均隔离异常；意外 getter 或统计接收器抛错不会改变请求结果、占位符校验或取消语义。

## `models:warmup` 与第 23 节别名

```js
await chrome.runtime.sendMessage({
  rpc: 'models:warmup',
  payload: { reason: 'manual', providerId: 'llamacpp' }
});
```

manual 仅管理页；hover 仅本扩展、真实标签页、非敏感/隐身来源。`providerId` 可省略。只从后端已保存的 local/llamacpp 配置、启用/暂停状态和 Vault 读取候选，不接受调用方地址或密钥，未知编号不唤醒默认另一家。暂停/停用候选不读取 Vault。模块还会独立检查本机 HTTP(S) 地址、重定向、超时、目标限频和并发合并。

结果 `status` 为 ready、warmed、cooldown、ineligible、unsupported 或 failed，可带 provider、elapsedMs、retryAfterMs 或脱敏 error。具体无提示词 GET 唤醒、120 秒保护与真实 sleep 验收见 [PERFORMANCE-WARMUP.md](PERFORMANCE-WARMUP.md)。

当前第 23 节前端调用的兼容别名：

```js
await chrome.runtime.sendMessage({ rpc: 'providers:warm', payload: { mode: 'combined' } });
```

mode 可选且只接受 fast/accurate/combined，作为兼容提示，不允许调用方扩大唤醒范围。别名严格按 hover 来源保护转入同一个 ModelWarmup，返回 `{ok:true}` 表示请求已受理，不表示模型已准备完成；需要精确状态时使用 models:warmup。没有用 health 代替唤醒，没有自动 offscreen 下载内置语言包或对齐模型。

## 第 23 节暂未接的字段

已保留实际前端扩展后的 protocol 超集，旧最终结果正常交付。此次不生成 partial，不提供 result.timing；stream 请求仍安全收到最终结果，前端按其已有兼容逻辑退回“后台”整体时间。

匿名全局统计不能直接填成某段 result.timing。当前 SegmentTiming.queueMs 的约定还包括缓存和提供方/批次等待，仅逻辑队列时钟不足；providerMs 要正确对应实际批量/共享工作，firstTokenMs 更不能从整包响应猜测。后续应为逻辑调用传临时 trace，由 batcher/combined 将真实请求时刻与重试传播至消费者，再返回可选 timing；不把原文/jobId加入匿名 collector。本轮未为赶进度改写冻结的综合模式算法或伪造拆分。

## 验证

- 新增性能与 index 接线测试共九项：有界/脱敏/快照隔离、batch 两逻辑一 HTTP、真实共享计数、缓存命中、fetch/body 失败、HTTP 取消、异常回调隔离、local lazy/builtin anchored、队列未开始取消、管理读取和预热权限、实际 index 敏感工厂/共享队列/Vault 候选等组合覆盖。
- 最终 warmup 十六项和原 RPC 十项一并通过；匿名统计接线阶段完整后端 strict 编译与 **355/355** 通过，主任务冻结其余隐私修复后为 **357/357**。
- 旧 quality-core 的预先术语请求形态断言已按 local lazy 更新；自然译文、标签结构和不使用碎片拼正文的断言完整保留。
- 保留旧前端作控制时 stage 的类型检查只剩之前的 `advanced.ts:175`；前端负责人在第 21.1 节修复后，主任务已确认实际 E 完整类型检查和 357/357 后端通过。
- 本轮离线统计/接线验收不调用真实模型、不占 GPU。实际性能比较仍以 [PERFORMANCE-VALIDATION.md](PERFORMANCE-VALIDATION.md) 同一 fixture 的真实浏览器数据为准，不用统计接口存在本身宣称提速。
- 最终集成真实浏览器另读 performance:get，确有 149 次真实 prompt/generation 字段，HTTP 为 150 成功（含一次健康检查）与六次取消，shared 和一次 lazy 恢复计数也有返回；没有以 HTTP 时间替代模型时间。
- 额外真实 hover smoke 验证 alias 一次、无正文 GET props 一次、无 completion/job，重复 hover 被前端抑制；同目标补充管理调用返回 cooldown。性能基准本身用 Enter、alias 数零，不声称受益于 hover。详细边界、报告与脚本见性能测量文档。
