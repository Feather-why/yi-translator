# 0.2.8 服务与网关优化

本轮只修改后端和自建网关，不改前端、模型权重或生产服务参数。性能复现与专项测试使用本机模拟接口，不访问日常浏览器或生产模型。

## 内置翻译移除无关的检测等待

原实现对每个明确语言对仍并行调用 `LanguageDetector.availability()`；检测器迟迟不返回时，即使 Translator 已准备且会话已缓存，每段也会等满两秒。0.2.7 的纯 CPU 复现为明确语言两段约 2014 / 2003 ms，无检测器时约 4 / 0 ms；这是故障条件的模拟延迟，不代表正常原生模型普遍慢两秒。

现在明确语言只检查 Translator。后台 CLD 已识别的语言同样走明确语言路径；真正 `auto` 请求仍检查真实检测器、置信度和语言对，不猜英语，不自动下载。每段仍重新核实 Translator 的可用性，没有引入正负结果 TTL，因此下载完成可立即使用，缓存会话也不会绕过语言包失效检查。

准备页继续直接检查 / 准备原生模型；`availability('auto', ...)` 仍查询自动检测能力。明确语言查询不再承诺同步返回已检查的检测器状态。

新增 `tests/backend/browser-translator-performance.test.mjs`：覆盖未响应检测器不阻塞首次 / 缓存会话、明确语言查询、真正 auto 及单次检测、下载完成 / 语言对失效、检测不可靠、明确语言及 auto 取消。旧的会话回收、桥接 CLD、取消和未准备状态回归继续保留。

依据：[Chrome Translator 官方文档](https://developer.chrome.com/docs/ai/translator-api) 将语言检测列为源语言未知时的独立能力。

## 占位符重试只交给一层

远程适配器现在发送可选的节点 JSON 字段 `placeholderRetry:'caller'`，由既有 Core 负责首次失标后的严格重试和最终恢复。网关对这种请求每段只生成一次，结构不合法仍返回 `placeholder`，绝不绕过标签校验。网关缺省或显式 `placeholderRetry:'gateway'` 保留原来的最多两次生成，因此旧直接客户端无需改变；旧网关忽略新字段时仍可处理新适配器，只是不能减少重复重试。未知字段值在推理前返回 `bad_input`。

本次网关版本为 0.2.1，remote-node 适配器为 1.0.2；没有修改前端共享 RPC。0.2.7 的纯模拟 Core→remote→gateway 失标例先完整生成四次，再翻两个安全叶子，共六次上游调用；新契约预期只保留两次整段加两个叶子。它是固定格式故障的调用数变化，不是一般网页提速比例，最终叶子退路的自然程度也没有新保证。

新增 `gateway-retry.test.mjs` 使用真实网关 handler、实际适配器 / Core 与内存存储，所有上游在进程内回放，不监听端口。覆盖旧客户端兼容、caller 单次生成、严格要求、非法责任值、适配器请求字段、完整恢复及取消。

## 网关分开在线与已加载状态

原网关把所有模型 `loaded:false` 等同节点 `ok:false`。当 llama.cpp 正常休眠、`/health` 仍正常时，这会让远程适配器与 Core 把可接任务的节点当成基础设施失败，连续探测可打开故障冷却。

现在 `health.ok` 表示至少一个上游健康且能接受任务；`models[].loaded` 仍反映查询到的驻留状态。因此正常休眠返回 `ok:true`、对应 `loaded:false`，不会假称权重已加载。健康检查只查询原有 `/health` 和 `/props`，不调用 `/slots` 或生成任务。坏健康状态、连接 / 解析异常仍按原保守路径离线；不提供 `/props` 的旧上游保留既有健康检查兼容方式。没有新增缓存 TTL 或隐藏下载。

remote-node 现有 `ok → node.online` 与 `models[].loaded` 映射已能保留两种状态，无需再次改适配器或共享协议。新增 `gateway-health.test.mjs` 覆盖休眠 / 已加载 / 离线、坏响应、旧上游、多模型、状态刷新和实际 Core 连续三次探测不误开冷却。

依据：[llama.cpp b12069 官方休眠说明](https://github.com/ggml-org/llama.cpp/blob/b12069/tools/server/README.md#sleeping-on-idle)：新任务可重新加载休眠模型，`/health` 与 `/props` 不触发加载，也不刷新闲置计时。

## 验证记录

内置翻译专项已完成：独立目录 strict 合约编译通过；新增七项与原有十三项合计 **20/20 通过**。原有测试只在临时工作目录改写构建位置后执行，未改测试本身的行为。使用 `BACKEND_BUILD_DIR=work/provider-028-build` 的绝对路径运行新增专项，最终由集成任务统一编译与全套验证。

重试去重专项已完成：独立 strict 编译通过；新增六项与原有远程适配器五项合计 **11/11 通过**。实际 Core / remote / gateway 的模拟集成断言完整段请求四次降为两次，总回调六次降为四次，最终结构仍合法。

休眠语义专项已完成：新增七项与重试六项、原远程适配器五项合计 **18/18 通过**。连续三次实际 Core 探测模拟休眠节点，保持 `online:true`、`loaded:false`、`circuit:'closed'`，没有生成请求、故障或冷却。原网关 HTTP 集成 **6/6 通过**，包含鉴权、CORS、NDJSON交付顺序、旧客户端重试、输入限制、断开取消和模块路由；仅连接临时本机模拟接口。

本模块三项共覆盖 **44 个不同测试用例**；各阶段重跑的用例不重复算新增数量。最终独立 strict 合约编译通过，没有新增运行时依赖。源码差异另行复核过：内置入口只限制无关检测；重试字段只有两种明确值且旧缺省不变；网关响应未增加共享字段，只分开聚合在线状态与每个模型的加载状态。未修改生产模型、采样、GPU槽数或前端，最终完整项目测试与构建由发布任务统一执行。

项目正式编译后可运行以下聚焦回归（独立构建时新增测试接受绝对路径 `BACKEND_BUILD_DIR`）：

```powershell
node --test tests/backend/browser-translator-performance.test.mjs tests/backend/browser-translator.test.mjs tests/backend/gateway-retry.test.mjs tests/backend/gateway-health.test.mjs tests/backend/gateway.test.mjs tests/providers/remote-node.test.mjs
```
