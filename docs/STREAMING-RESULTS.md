# 0.2.6 真实流式验收结果

日期：2026-11-03；后台0.2.6-stream，llama适配器1.0.7。

## 本地模型：7/7

现有 Hy-MT2-1.8B-Q4_K_M，llama.cpp b12069；隔离端口8083，单槽2048，模型各层放在GPU、q8 KV。固定seed42、关闭prompt缓存，job noCache，无E5；先极短预热。仅公开/合成文本，没有读取或发送用户论文。没有更改日常8081六槽模型。本表单位毫秒，计时由同一Node进程的真实Core+Port收包记录。

| 样例 | HTTP数 | 预览数 | 首预览 | 完整结果 | queueMs | providerMs | 请求到首字 |
|---|---:|---:|---:|---:|---:|---:|---:|
| json-plain | 1 | 0 | — | 523.6 | 34.6 | 488.0 | — |
| sse-plain | 1 | 5 | 56.4 | 462.6 | 27.2 | 434.1 | 29.0 |
| sse-links | 1 | 3 | 60.8 | 248.6 | 30.9 | 217.3 | 29.8 |
| sse-combined-once | 1 | 5 | 61.6 | 462.7 | 29.7 | 432.5 | 31.8 |
| sse-fast | 1 | 1 | 42.7 | 100.4 | 17.7 | 82.4 | 24.9 |
| sse-nested | 4 | 3 | 52.0 | 364.7 | 25.0 | 295.1 | 27.0 |
| sse-cancel | 1 | 1 | 48.8 | — | — | — | — |

- 相同提示词、seed的JSON与SSE最终译文逐字相同；所有完整结果占位符结构通过，预览为累计正文。
- 综合同服务仅一次真实HTTP、一次final；嵌套样例4次是正常的语义恢复计划，正文可预览、锚点不预览，retries为0。
- 带链接的Phonetics样例保留g0/g1/g2，并对应语言学、声波、感知。嵌套Sealand保留“海之国”在子标签内、“王朝”在外层，未把后面的Sealand并入引号。
- 取消后250ms观察期没有任何迟到结果或预览。退出后临时模型由runner关闭。

这是小样本协议和显示时机验收，不是量化对照或全页速度基准。首字更早不等于模型计算更快；不从一次JSON/SSE墙钟差推断吞吐提升。受浏览器首唤醒、CPU并发、模型冷热影响，不保证用户机器每次达到此数。

## 首轮暂存生产包：独立Edge 4/4

Edge 156.0.4314.58，全新无头配置；真实MV3 service worker，正式RPC/tx:translate端口，真实本地模型。只在测试配置开llama并禁用对齐；没有替用户日常浏览器重载。不是mock-backend构建。

| 验收 | 真实HTTP | 首预览 | 完整结果 | 关键结果 |
|---|---:|---:|---:|---|
| 带g/x综合流式 | 1 | 45.6 | 365.4 | 单final，结构校验；同时有queue/provider/firstToken |
| 同原文缓存 | 0 | — | 48.2 | providerMs=0，无HTTP，无partial |
| 非流式 | 1 | — | 330.2 | 所有请求stream:false，无partial |
| 首字后取消 | 1 | 34.9 | — | 取消后300ms无任何回包 |

流式首预览比最终结果早 **319.8ms**；实际相邻预览间隔 **80.0 / 81.6 / 82.6ms**，符合每段80ms合并。保留连接继续观察100ms，final后无partial。原始逐条消息、计时、请求类型、source和正式包SHA256见交付browser-report-stage.json。

## 自动回归和复现材料

后端全套444/444（0跳过）；新增44项；类型检查和正式构建通过。真实模型7项与浏览器4项独立于444项，不混成同一总数。最终实际本机项目验证和保护文件核对见release-audit.json。

仓库脚本：tests/providers/llamacpp-stream.test.mjs、tests/backend/stream-core-trace.test.mjs、tests/backend/stream-integration.test.mjs、tests/contract/stream-port.test.mjs、tests/backend/stream-production-browser.mjs。交付的evidence目录保留真实模型runner/probe与日志。请先运行合约编译，给runner的相对stage路径指向当前项目；临时服务会验证端口空闲，只关闭自己启动的模型。

首轮真实验证曾因测试脚本把fast模式完成阶段误认为fast而超时；实际协议为final，前4项已完成。保留real-model-initial-harness-failure.json；修测试后最终7项全过，未为测试放宽协议。


## 实际 本机项目最终生产包复核：4/4

第一次浏览器验收后，前端作者继续更新了自己的界面和共享设置。后端只读取其最新版；本机项目正式构建的background.js哈希随共享设置改变，因此重新针对 **.output\chrome-mv3** 执行同样四项真实模型验收，全部通过。未把旧包验收直接冒充新包结果。

| 验收 | HTTP数 | 首预览ms | 完整结果ms | queueMs | providerMs |
|---|---:|---:|---:|---:|---:|
| 流式g/x综合 | 1 | 50.8 | 419.0 | 9.8 | 405.1 |
| 缓存 | 0 | — | 17.2 | 16.1 | 0.0 |
| 非流式 | 1 | — | 310.3 | 7.1 | 300.1 |
| 取消 | 1 | 33.3 | — | — | — |

最终包流式首预览领先 **368.2ms**；相邻间隔81.1 / 79.5 / 83.9 / 79.9ms。该单次结果与首轮测量的差异不构成性能回退或提升结论。正式manifest和background.js的SHA256与此次浏览器实测记录一致；见browser-report.json和release-audit.json。
