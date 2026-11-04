# 本地模型按需唤醒

## 能力与当前入口

`src/backend/model-warmup.ts` 提供独立的 `ModelWarmup`，供后台 `models:warmup` RPC 接线。后台收到明确请求后才检查或唤醒已启用的本机 llama.cpp 服务；没有定时保活、自动全站预热或自动启动模型进程。当前前端不作修改，悬浮球 hover 触发由前端后续接入，不能将本次交付描述为“现在悬停就能预热”。

此处“预热”指让服务器从睡眠状态加载模型，并确认已退出睡眠。不会提交翻译、网页正文、空白翻译任务或任何模型提示词，不保证真实翻译首 token 延迟为零。模型加载后会占用正常的模型显存，之后仍由服务器原有闲置睡眠规则卸载；模块不会持续占用生成槽或维持 GPU 推理。

## 固定版本核实

本机执行 `llama-server.exe --version` 得到 `0.8.0-dev / build 12069 / commit e6192de0a`；仅执行帮助和版本查询，没有访问现用 8081 的睡眠接口。帮助确认 `--slots` 默认开放、默认有空运行 warmup，并支持 `--sleep-idle-seconds`。

固定 b12069 的文档明确指出 `/health`、`/props` 等状态接口不会唤醒或刷新闲置计时，故不能以健康检查成功冒充已唤醒。[官方固定版本说明](https://github.com/ggml-org/llama.cpp/blob/b12069/tools/server/README.md#sleeping-on-idle)

该版本 `/slots` 经由 `create_response()` 等待服务器退出 sleep，然后提交槽位查询任务，不提交生成任务。源码同时说明其响应可能包含模型槽状态，因此本模块在拿到响应头后立即取消 body，不解析、保存或记录槽位内容。[固定版本的槽位处理](https://github.com/ggml-org/llama.cpp/blob/b12069/tools/server/server-context.cpp#L5286-L5323)、[退出睡眠的响应路径](https://github.com/ggml-org/llama.cpp/blob/b12069/tools/server/server-context.cpp#L4803-L4813)

## 请求顺序和真实结果

1. `GET /props`，只提取 `is_sleeping` 与 `endpoint_slots` 两个布尔值。
2. 已醒时返回 `ready`，不调用 `/slots`，因此不会靠反复状态查询延长模型驻留。
3. 正在睡眠且槽位接口开放时，`GET /slots`；仅检查 HTTP 状态，立即取消响应 body。
4. 再次 `GET /props`，只有明确 `is_sleeping:false` 才返回 `warmed`。

没有 sleep 字段、槽位接口未开放或其他服务器实现，返回 `unsupported`，不擅自换用 completion、chat、embedding 或下载接口补救。HTTP 失败、超时或最后仍睡眠，返回 `failed`，不假造成功。

## 接口及接线约定

```ts
new ModelWarmup({
  provider: async (providerId?: string) => eligibleProviderOrUndefined,
  fetch,              // 可选，便于测试及复用后台网络入口
  now: Date.now,      // 可选，只用于限流及耗时记录
  timeoutMs: 15_000,  // 默认15秒，最大30秒
});

await service.warmup({ providerId, reason: 'hover' | 'manual' }, signal);
service.dispose();
```

配置 getter 返回 `{id, kind, adapter, enabled, configured, paused?, endpoint, apiKey?}`。调用方从后台保存的配置和 Vault 读取；密钥只在内存用于本机请求。网页不能提交地址、密钥、提示或待翻译内容。如果指定编号，getter 返回另一编号会被拒绝，不能回退唤醒别家。

模块再次验证 `kind:'local'`、`adapter:'llamacpp'`、已启用、配置完整且未暂停。地址仅允许 HTTP(S) 的 `localhost`、IPv6 `::1` 或 IPv4 127/8 回环地址；禁止 URL 凭据、查询串、片段和任何重定向。`/v1` 后缀会去掉后使用原服务根路径。云服务、远程节点、内网地址及本机 OpenAI 兼容的其他实现均不借此入口唤醒。

返回字段：

| 字段 | 含义 |
| --- | --- |
| `status` | `ready / warmed / cooldown / ineligible / unsupported / failed` |
| `provider` | 实际对应的后台服务编号；没有可选目标时可缺省 |
| `elapsedMs` | 实际唤醒检查工作的耗时，可缺省，不是生成延迟 |
| `retryAfterMs` | 冷却状态的剩余等待时间 |
| `error` | 脱敏的错误码和短原因，不包含响应原文、URL、路径或密钥 |

格式错误抛出 `ProviderError(bad_input)`；调用方取消抛出 `AbortError`。权限判断由 RPC 层在 getter 前执行：`manual` 只接受本扩展管理页面；`hover` 只接受本扩展、有真实标签页的非敏感且非隐身来源。模块本身不信任或解析网页 sender。授权入口及 capability 由 RPC 接线说明记录，不能用模块测试代替权限测试。

## 并发、限流、取消与数据范围

- 同一服务地址和凭据的并发请求合并为一次检查/唤醒，别名请求分别返回各自服务编号。
- 同一目标最小间隔 120 秒，失败和已发送后的取消也计入，避免鼠标来回触发故障重试。
- 全局桶最多两枚 token，每 120 秒恢复一枚；检查已醒目标同样消耗，防止通过轮换目标刷请求。
- 状态表最多 32 条，不保存原始密钥或任何响应 body；凭据仅以摘要区分，配置变更不会借用旧鉴权失败。
- 一个消费者取消不影响另一个；全部退出后中止真实请求。配置读取、响应头等待与 body 读取均有取消/超时保护；网络实现忽略 abort 时调用方仍按时结束。
- 冷却和 token 桶只存在于当前后台实例，service worker 重启后重建；没有新增持久存储。不会读取或写入译文缓存、TM 或同步资料。
- `/props` 响应按流读取并限制为 128 KiB，丢弃无关字段；`/slots` 的 body 始终不读。所有请求禁 Cookie、禁重定向、禁 HTTP 缓存。

## 验证记录

`tests/backend/model-warmup.test.mjs` 的 16 项离线回归通过，使用固定响应和可控流，覆盖：真实唤醒顺序、槽位 body 不读、权限配置边界、地址规范化、并发合并、单方/全部取消、忽略 abort 和卡住 body 的超时、120 秒间隔、全局桶、状态上限、凭据变更、旧接口/未开放接口、错误脱敏，以及迟到配置和 dispose。合约 TypeScript 严格检查通过。

独立临时服务器已完成真实 sleep→wake 验收：本机 b12069 / e6192de0a、Hy-MT2-1.8B Q4_K_M，在独立 `127.0.0.1:8082` 以 `--sleep-idle-seconds 3 / -np 1 / -c 512` 运行。先确认 `is_sleeping:true`，模块仅发 `/props → /slots → /props`，三次均为 GET 且无 body；随后确认 `is_sleeping:false`，返回 `warmed`。槽位 body 的读取次数为 0、取消次数为 1。

该次总耗时 743.9ms，其中 `/slots` 等待约 737.3ms。它是系统文件缓存已存在时的一次睡眠后重载样本，使用的临时并发数和上下文也不同于正式调优参数，不能推广为冷启动或真实翻译 P50。服务日志实际记录进入、退出睡眠；验收完成立即核对并关闭本任务创建的 PID 20224，确认 8082 无监听，没有操作现用 8081 的睡眠。

原始证据保存在 `work/model-warmup-real/result.json` 和 `work/model-warmup-real/server.err.log`。最终模块 16 项离线回归、性能统计/接线及原 RPC 相关合计 35/35 通过，模块与真实接线均经过合约 TypeScript 严格检查。
