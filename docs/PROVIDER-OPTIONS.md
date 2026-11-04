# 协议 v2：服务高级设置与多实例

实现依据是 `docs/HANDOFF-BACKEND.md` 第 17 节及已有前端协议。此次只改后端，前端文件保持已有版本。原来的提供方鉴权配置、占位符校验、标签留在本地的兜底、重试、取消、缓存和两档调度继续使用同一条执行链。

## 实现位置

| 文件 | 职责 |
|---|---|
| `src/backend/provider-options.ts` | 三种模板、能力声明、默认值、输入验证、夹限、有效适配器和配置映射 |
| `src/backend/core.ts` | 持久化、旧配置迁移、实例增删、调度、实际超时、缓存隔离、模型列表 |
| `src/backend/rpc.ts` | v1 兼容及 v2 管理 RPC 的扩展页面鉴权 |
| `src/backend/providers/openai-compatible.ts` | OpenAI 兼容的模板提示词、温度和可选 Bearer |
| `src/backend/providers/llamacpp.ts` | llama.cpp 的模板提示词和温度 |
| `src/backend/scheduler/quota.ts` | 用量串行保存及删除实例时清理计数 |
| `src/backend/secrets.ts` | 实例密钥加密持久化和串行删除 |
| `tests/backend/provider-options.test.mjs` | 配置、生效行为、真实 HTTP 模型列表、五秒超时和权限回归 |

## 对前端声明真实支持项

`providers:list` 返回 `options`、`defaults`、`editable`，以及自定义实例的 `custom/template` 和已知文档的 `docsUrl`。`options` 是用户覆盖，`defaults` 是适配器默认，实际请求使用两者合成后的结果。返回的结构与内部配置分离，密钥仍只返回 `••••`。

通用支持 `usedFor`、`weight`、`timeoutMs`、`concurrency`、`qps`、`maxChars` 和 `quota`。OpenAI 兼容、llama.cpp、remote-node 支持 `endpoint/model`；Gemini 支持 `model`。OpenAI 兼容和 llama.cpp 额外支持 `prompt/temperature`。远程节点目前没有这两个请求字段，因此没有列入 `editable`。微软、DeepL、小牛和腾讯目前使用各自既有固定端点，不声明通用 `endpoint`，避免设置保存成功而实际请求仍发原地址。

已提供通用地址和模型设置时，不再在 `ProviderInfo.auth` 重复返回同一项；账号密钥等真正鉴权字段继续显示。原 v1 调用仍可在 `config.url/model` 写入，这两个字段会迁移进通用设置并持久化，重启后继续生效。

## 输入验证和实际范围

不支持或未知的选项返回 `bad_input`。数字必须有限，再夹在下列范围；文本和额度结构也先完整验证，再写密钥和配置。

| 设置 | 范围与实际行为 |
|---|---|
| `endpoint` | 最长 2048 字符，只接受 HTTP(S)，拒绝内嵌账号、查询参数、fragment；作为适配器基础地址实际使用 |
| `model` | 最长 512 字符，进入真实请求 |
| `usedFor` | 非空的 fast/accurate/combined 集合，覆盖候选分档，状态页同步反映 |
| `weight` | 0–100，默认 50，作为延迟/成功率/额度评分的乘数；置顶仍具有最高优先级 |
| `timeoutMs` | 1,000–180,000 ms，覆盖适配器调用的默认超时，并覆盖响应体读取过程 |
| `concurrency` | 1–16，限制同一实例实际 HTTP 批次 |
| `qps` | 0.1–100，按同一实例实际 HTTP 批次限速 |
| `maxChars` | 最小 16，不超过适配器保守上限，进入批量限制；超长原文仍按既有文本叶子方案切分 |
| `quota` | 仅 `unit:'char'`、`period:'day'/'month'`，amount 为非负安全整数；当前未取得可靠 token/request 用量，因此拒绝这两种单位 |
| `prompt` | 最长 16,000 字符，可用 `{{from}}/{{to}}/{{text}}/{{context}}`，真实渲染后传模型 |
| `temperature` | 0–2；llama.cpp 默认 0.7，OpenAI 兼容默认不发送该字段，由服务器采用自己的默认值 |

提示词是翻译指令扩展；固定的片段编号、JSON 格式和 XML 占位符要求继续保留。llama.cpp 保留原文边界，避免此前已修复的“提示词被混入译文”问题再次出现。模型输出仍必须经过原有占位符校验，失败仍走加强提示重试、文本叶子兜底和换家流程。

额度设为 0 时，不显示免费额度；该实例排在其他可用免费/本地候选之后。当其他候选失败或不可用时可以回退使用，用户置顶或明确指定服务也可以使用。非零额度继续通过原账本预留、按设备计数并参与 B4 合并；没有通过把 0 伪装成“额度已耗尽”来阻止用户的付费服务。

## 保存、恢复默认和缓存

`providers:save` 新增可选 `options/name`。提供 `options` 时整份替换：省略某项即恢复适配器默认。省略整个 `options` 则保留当前通用设置，兼容 v1 的仅账号保存。`name` 仅对自定义服务生效，限制 1–80 个可见字符。秘密字段为 `••••` 时保留原值，空字符串才清除。

旧的 `config.url/model` 只在迁移或 v1 显式提交时进入通用设置；保存 v2 的空 `options:{}` 后，不会在下次启动又从旧配置“复活”。自定义服务无默认地址，因此恢复默认后需要重新填写地址；内置服务恢复其声明的默认地址。

缓存版本包含适配器版本、选项指纹以及模型、提示词、基础地址和温度的 SHA-256。换模型、换提示词或切换节点后不能命中旧模型的缓存。请求开始前固定缓存版本，避免保存设置与在途翻译竞态把旧模型译文标记为新版本。批处理也按选项指纹隔离，不能把两组配置合到同一个 HTTP 批次。

## 三种自定义服务

`providers:add {template,name}` 支持 `openai-compatible`、`llamacpp`、`remote-node`，使用同一个真实适配器克隆独立实例。实例 id 为 `custom-<随机 UUID>`，默认停用且没有默认地址，不会在添加后自行调用某个公共服务。配置、密钥、额度、并发和熔断状态均按唯一 id 隔离。实例定义和非秘密设置保存在 `backend.providers`，密钥经 SecretVault 单独加密，service worker 重建后恢复。

自定义 OpenAI 兼容实例允许不填 key，适合本机 Ollama/LM Studio；没有 key 就不发送 Authorization。内置官方 OpenAI 实例仍由 `auth.required` 要求 key。远程 gateway 的 token 要求保持不变。

`providers:remove {id}` 只允许删除自定义实例。删除清理配置、密钥密文、当前用量、状态节点和页面粘性记录，之后不再进入候选或缓存命中。正在实际执行 HTTP 请求的实例会返回可重试错误，等待完成后再删；已排队尚未执行的旧请求在出队时发现服务删除，会返回 `no_provider`。内置服务返回 `bad_input`。

## 模型列表与凭据隔离

`providers:models {id,endpoint?,config?}` 使用表单中尚未保存的地址和凭据，整个操作最多五秒，包括回退和响应体读取：

- OpenAI 兼容、llama.cpp：`GET /v1/models`，自动兼容已经带 `/v1` 的基础地址。
- OpenAI 兼容的标准列表不支持时：同一个 origin 回退 `GET /api/tags`，识别 Ollama 的 `name/model`。
- 远程 gateway：`GET /v1/health`，读取 `models[].id`。

模型 id 去重并排序；响应最多 2 MiB，Content-Length 前检加流式累计，无长度头时也有上限。全部请求 `credentials:'omit'`，禁止重定向。当前保存的秘密或 `••••` 掩码只在目标 origin 与已保存 origin 相同时恢复；切换 origin 后，必须显式填写新的 key/token 才会发送。查询本身不保存表单，不改变当前翻译服务。

## 权限与同步边界

`providers:save/add/remove/models` 都要求本扩展页面：`sender.id` 等于扩展 id，且 `sender.url` 位于扩展 origin；拥有 `sender.tab` 的选项页仍可管理。内容脚本不能调用这些管理操作，鉴权先于请求字段解析。未知模板、保留对象键和恶意 URL 不创建实例。

密钥便携备份和用户明确开启的 B4 密钥同步使用动态实例白名单，包含本机现有的自定义实例。未知归档 id 不会创建或授权一个新服务，也不会导入它的秘密。当前 B4 仍同步原有设置、规则、译文记忆和计数；`backend.providers` 的实例定义尚不跨设备自动创建。因此在另一台设备恢复自定义实例密钥前，需要具有对应的受信实例配置；不能把密钥归档当作自动安装服务的声明文件。

## 验收

```powershell
npm run test:backend
node --test tests/backend/provider-options.test.mjs
```

专项 **9/9 通过**：真实能力声明与夹限；地址/模型实际请求、整份替换、掩码及缓存隔离；v1 迁移和恢复默认后的重启；三模板与独立密钥/删除；分档、权重和零额度回退；真实并发/QPS/片段限制与超时；本机 HTTP 模型列表、Ollama 回退、五秒期限与 origin 隔离；管理权限；动态同步白名单拒绝未知实例。

2026-11-03 最终运行 `test:backend` 对应入口 `node tests/contract/run.mjs`，TypeScript strict + noUncheckedIndexedAccess 编译及全部 **205/205 测试通过**。同轮增加的 5 项原生适配器回归覆盖 OpenAI/llama.cpp 四变量、温度零、错误温度拒绝、XML/JSON 硬约束和无 key 的自建兼容接口。

本机 HTTP 验收用合成账号和 key，不使用用户云端凭据。不将本机回放视为云端套餐、模型质量或真实远程主机性能验收。浏览器和真实本地模型验收另见本次交付总报告。
