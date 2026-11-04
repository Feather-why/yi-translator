# B2 精确翻译服务与远程节点

## 本文范围

本模块增加 OpenAI 兼容、Gemini 和自建远程节点三个真实适配器，以及一个不依赖额外 npm 运行库的 Node.js 网关。所有适配器仍通过 `ProviderContext.fetch` 请求，不改前端、不回传明文密钥，不使用非官方免 key 接口。

调度器的对冲、页面粘性、半开熔断及其验收记录由后端核心统一集成；本文件说明适配器和远程节点的配置与契约。

## 配置翻译服务

| 服务 id | 必填字段 | 可选字段 | 适用档位 |
|---|---|---|---|
| `openai-compatible` | `url`、`key`、`model` | `tokenLimitField` | accurate / combined |
| `gemini` | `key`、`model` | 无 | accurate / combined |
| `remote-node` | `url`、`token` | `model` | accurate / combined |

这些服务没有内置账号或免费额度，首次安装时因缺少必填配置而不会被调度。启用和填入服务配置后才能参与精确档。

### OpenAI 兼容接口

`url` 是包括 `/v1` 的基础地址，例如 `https://api.openai.com/v1`；适配器在后面追加 `/chat/completions`。地址不能包含用户名、密码、查询参数或 hash。`key` 单独进入后端密钥保险库，以 `Authorization: Bearer ...` 发送。

模型必须支持 Chat Completions 和 JSON 对象输出。`tokenLimitField` 默认 `max_completion_tokens`；旧版兼容服务可显式改成 `max_tokens`。不按模型名字猜测接口差异，不自动换成其他模型。

输入将每个片段编号为 `s0`、`s1`，请求 JSON 响应：

```json
{"translations":[{"id":"s0","text":"第一段译文"},{"id":"s1","text":"第二段译文"}]}
```

片段可以乱序返回，但不能漏号、重复或增加片段。适配器会按原始输入顺序归位，拒绝截断、拒答、非 JSON 和空译文。页面上下文作为输入数据，不作为系统指令。

健康检查读取 `/models`，不发计费推理。某些兼容服务没有模型列表接口；这类服务的健康检查可能失败，但用户仍可用「测试」发送实际小翻译请求核实是否可用。

适配器 1.0.1 支持高级设置的自定义提示词和采样温度。模板中的 `{{from}}`、`{{to}}`、`{{text}}`、`{{context}}` 只替换一轮；原文内同名字串不会被再次执行。自定义要求放入用户 JSON 的 `additionalInstructions`，固定 system 仍要求 JSON、原始片段编号和 XML 占位符不变。温度仅明确设置时发送，范围 0–2；不设置时保留服务端默认值。

内置 OpenAI 服务仍要求 key；创建的自定义 OpenAI 兼容实例可连接无需 key 的 Ollama/LM Studio 等服务。未填写 key 时不发送 Authorization 请求头，仍要求明确模型，并遵循相同 JSON 契约。llamacpp 1.0.2 同样支持四变量提示词与 0–2 温度（默认 0.7），自定义要求放在固定原文边界前，XML 保留要求先于它发送。高级适配器与设置集成专项 25/25 通过，包含无 key 健康检查、零温度、非法温度和模板数据不递归替换。

### Gemini

模型名称由用户填写，以项目实际可用模型为准；可写 `models/<id>` 或 `<id>`。适配器使用官方 `v1beta/models/<id>:generateContent`、`x-goog-api-key` 请求头，以及 `application/json` 输出模式。

不把历史免费档写成默认配额。每日限额错误与短期限流分别映射到 `quota` 和 `rate_limit`；截断、安全拦截及未知模型不当作成功译文。返回中思考部分不会拼入译文。

## 部署远程节点

要求 Node.js 22 或更高版本，以及一个已经启动的 llama-server。网关本身不下载模型，不安装 CUDA，不修改显卡驱动。

先在模型主机上以合适的参数运行 7B 模型，再运行网关。也可先让网关连接已部署的本机 1.8B 验证网络和协议，但这不能代替 7B 的质量或延迟验收。

### 最小启动

```powershell
# 在 项目根目录 内运行。令牌由你生成，不要提交到仓库。
$env:GATEWAY_TOKEN = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:LLAMA_URL = 'http://127.0.0.1:8081'
$env:GATEWAY_MODEL_ID = 'local'
$env:GATEWAY_ORIGINS = 'chrome-extension://你的32位扩展ID'
node gateway/server.mjs
```

示例里的扩展 ID 必须替换为扩展管理页显示的真实 ID。默认只监听 `127.0.0.1:8090`；需要供笔记本访问时显式设置 `GATEWAY_HOST` 为内网或 Tailscale 地址，不默认监听公网。令牌至少 16 字符。

在插件中配置 `remote-node`：地址填节点的 `http://...:8090`，token 填上述令牌，model 可以留空或填 `local`。

### 多模型与独立配置文件

可将配置放在已被 `.gitignore` 排除的 `gateway/config.local.json`：

```json
{
  "host":"127.0.0.1",
  "port":8090,
  "allowedOrigins":["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  "models":[
    {"id":"fast-1.8b","url":"http://127.0.0.1:8081","concurrency":2},
    {"id":"accurate-7b","url":"http://127.0.0.1:8082","concurrency":4}
  ],
  "modeModels":{"fast":"fast-1.8b","accurate":"accurate-7b"}
}
```

```powershell
$env:GATEWAY_CONFIG = 'gateway/config.local.json'
# GATEWAY_TOKEN 仍通过环境变量提供。
node gateway/server.mjs
```

上游 llama-server 若启用 API key，可通过该模型配置的 `apiKey` 提供；单模型环境变量方式也支持 `LLAMA_API_KEY`。配置文件不能进入仓库。网关不会把这些字段放进 health 或 metrics。

## 网关协议

所有业务接口都要求 `Authorization: Bearer <token>`；日志不打印令牌、原文、译文或完整请求体。

### `GET /v1/health`

检查上游 `/health` 和可用时的 `/props`，返回真实加载状态：

```json
{"ok":true,"version":"0.2.0","models":[{"id":"accurate-7b","loaded":true}],"queue":0}
```

有真实 token 计时后才附加 `tokensPerSec`。未取得模型进程专用显存时不输出 `vramMB`，不拿整张显卡总占用冒充模型显存。上游处于睡眠时模型 `loaded:false`，请求翻译后会由 llama-server 自动唤醒。

### `POST /v1/translate`

```json
{"segments":[{"id":"s1","text":"Read <g0>the guide</g0> <x0/>."}],"sourceLang":"en","targetLang":"zh-CN","model":"accurate-7b"}
```

可选 `context:{url,title,summary}`、`mode`、`strictPlaceholders`。每批 1–64 个唯一 id，单片段最多 12,000 字符，整批最多 64,000 字符；实际模型上下文仍须足够，短上下文模型可能更早拒绝长输入。

响应为 `application/x-ndjson`。每段结束立即发送一行，完成顺序可以不同于输入：

```text
{"id":"s1","text":"阅读<g0>指南</g0><x0/>。"}
{"done":true,"model":"accurate-7b"}
```

失败片段发送 `{id,error:{code,message,retryable}}`，仍在最后发送 done。每个片段先验证占位符的数量、配对和父子关系；失败加强提示重试一次，仍失败返回 `placeholder`。网关不会偷偷删除占位符或把未验证输出作为成功。

上游并发按每个模型的队列限制。客户端断开时取消在途上游 fetch 并丢弃尚未出队的片段。网关不自动切换未知上游模型。

扩展的 `remote-node` 适配器严格校验 NDJSON：未知/重复 id、缺号、缺 done、done 后额外数据、非 JSON、过大行/总响应均失败；UTF-8 可以跨任意网络块分割。服务错误文本被替换为静态中文说明，避免把远程任意字符串写入状态页。

扩展适配器 1.0.1 将 `maxSegments` 设为 1：当前公共适配器接口返回一个 Promise 数组，因此每个扩展片段单独请求，保障翻好一段立即交付。网关仍支持外部客户端一次提交 64 段并通过 NDJSON 逐段交付，不改变网关的批量协议。

### `GET /v1/metrics`

返回当前排队数、活跃请求、完成/失败/取消计数，以及每模型近 200 个真实请求的延迟中位数和真实输出 token 速度。只存数值，不保存原文或译文。

### B3 / B5 模块路由

`POST /v1/align`、`POST /v1/ocr`、`POST /v1/pdf` 可通过配置的 `alignUrl` / `ocrUrl` / `pdfUrl` 转给显式上游模块，也可在嵌入式 `createGateway` 时传入 `handlers`。模块没有配置时明确返回 HTTP 501 / `no_provider`；不会生成假 OCR、假对齐或假 PDF 结果。

## CORS 与边界

- token 始终必需，不能靠 CORS 代替鉴权。
- CORS 只允许列出的完整来源；禁止 `*`，未知来源 HTTP 403。
- 预检只允许 GET、POST、OPTIONS 和 Authorization / Content-Type。
- 不使用请求中的任意 URL 作为上游，模型路由只来自启动配置，防止公开代理。
- 上游请求不发送 Cookie、不跟随重定向，设超时；网关不打开任何文件操作或远程代码执行接口。

## 测试与本次结果

```powershell
npm run test:backend
# 或单独运行 B2 测试（先运行后端编译入口）
node --test tests/providers/openai-compatible.test.mjs tests/providers/gemini.test.mjs tests/providers/remote-node.test.mjs tests/backend/gateway.test.mjs
# 可选真实本机模型烟测，默认连接127.0.0.1:8081
node tests/backend/gateway-real.mjs
```

2026-11-03 结果：

- B2 适配器回放与本机 HTTP 集成 20/20 通过。
- 覆盖 JSON 编号归位、截断/拒答、鉴权、每日额度/短期限流、NDJSON 任意 UTF-8 分块、重复和缺失编号、过大行、流式先完成先返回、取消、队列、CORS、真实 health 与模块路由。
- 真实 `remote-node → 临时网关 → 本机 Hy-MT2-1.8B CUDA` 链路通过，两条合成英文（其中一条嵌套 g/x）总耗时约 208ms；输出中文正确，标签完整，没有提示词污染。临时网关已关闭。
- 没有调用真实 OpenAI/Gemini 账号；回放测试不代表账号权限、费用或云端性能已验证。
- 没有提供远程 7B 主机，因此 combined 在 7B 上首段 final <1.5 秒尚需在真实主机上测量，不能用本机 1.8B 的结果代替。

## 官方协议来源

- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [OpenAI JSON 输出](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat)
- [Gemini generateContent](https://ai.google.dev/api/generate-content)
- [Gemini 结构化输出](https://ai.google.dev/gemini-api/docs/structured-output)
- [llama.cpp 固定版本服务文档](https://github.com/ggml-org/llama.cpp/blob/b12069/tools/server/README.md)
