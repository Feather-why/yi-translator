# 第 32 节：LibreTranslate 与自定义 HTTP 模板

2026-11-04。两种模板由 `providers:templates` 列出，通过现有 `providers:add` 创建独立实例；默认停用，没有自动添加公共镜像，也没有新运行时依赖。前端和设置页没有修改。

## LibreTranslate

实现 `src/backend/providers/libretranslate.ts`，版本 `1.0.0`。克隆实例保留约定的默认地址 `http://127.0.0.1:5000`，也可以改成自己部署的 HTTP(S) 地址。密钥可选并沿用 Vault 加密；没有声明免费字符额度。

一次 POST `<基础地址>/translate`，发送 `q` 数组、`source`、`target`、`format:'text'`，有密钥才发送 `api_key`。服务必须返回数量一致的 `translatedText` 数组。明确指定的源语言照常传送，简体中文映射 `zh`、繁体映射 `zt`；其余 BCP-47 代码取小写语言部分，例如 `sv-SE → sv`、`pt-BR → pt`。本机实例实际可翻的语言仍取决于安装的模型；400 返回明确的请求/语言对提示，供 Core 换服务。

保留整段原文上下文，不在适配器里预先按链接拆成短语。返回的 `<gN>`、`<xN/>` 数量、闭合和父子关系必须匹配；失标交给 Core 现有的统一重试/恢复流程。`health` 只 GET `/languages`，不发翻译请求。默认每批最多 16 段、6000 字符、2 并发、2 QPS；可通过现有高级设置降低限制或按自建服务能力调整。

官方依据：[翻译接口](https://docs.libretranslate.com/api/operations/translate/)、[语言列表](https://docs.libretranslate.com/api/operations/languages/)。本轮没有安装 LibreTranslate 服务或实际语言模型；验证使用固定合约回放。

## 自定义 HTTP

实现 `src/backend/providers/custom-http.ts`，版本 `1.0.0`，只发送 POST JSON。必须由用户填完整接口地址；地址不允许 URL 用户名/密码、查询参数或片段。凭据放请求头或请求体，不能放地址中。`headers` 和 `body` 都是多行字段，**整段加密保存**，读取配置只显示 `••••`；再次保存时保留掩码代表不修改。请求体也加密，是因为一些 API 会把静态 `api_key` 放在 JSON 中。

字段：

| 字段 | 语义 |
|---|---|
| `url` / 高级设置 `endpoint` | 完整 POST 地址，必填；允许先保存未填写的草稿 |
| `headers` | JSON 对象，值只能是字符串；留空时只设置 JSON Content-Type |
| `body` | JSON 模板；先解析为数据，再递归替换值，最后 JSON.stringify |
| `resultPath` | 返回值的固定 JSON 路径，默认 `translatedText` |
| `batch` | `single` 一段一个请求；`array` 一次发送数组 |

单段模式默认模板（请求体留空即可使用）：

```json
{"q":"{{text}}","source":"{{from}}","target":"{{to}}"}
```

数组模式默认模板：

```json
{"q":"{{texts}}","source":"{{from}}","target":"{{to}}"}
```

`{{text}}`、`{{from}}`、`{{to}}` 可以用于 JSON 字符串值的一部分；`{{texts}}` 必须是完整字符串值，实际替换成数组，不是数组的字符串表示。数组模式禁止 `{{text}}`，避免多段被错误合成一个字符串。原文里的引号、反斜杠、换行和 `{{to}}` 等字串只是数据，不会进行第二次模板解释。字段名不替换，模板必须含一个原文变量。

返回路径支持 `data.translations[*].text`、`choices[0].message.content`、`$[0]["translation-text"]`、根 `$`。只读取自有 JSON 属性，支持固定数组下标和 `[*]` 展开；不支持筛选表达式、函数、脚本、递归下降或原型属性。返回结果必须是与请求逐一对应的字符串或字符串数组；不会把对象隐式转为字符串，也不会吞掉多余项。占位符保持与 LibreTranslate 相同的严格检查。

`single` 的实际批次上限是 1；`array` 是 16。一次 adapter 调用只发一个 HTTP，请求数不靠在 adapter 内循环伪装成一批。模式变更会更新真实批量上限，并隔离旧缓存。默认 6000 字符、2 并发、2 QPS。

安全约束：

- 请求不携带浏览器 Cookie，重定向拒绝。请求头不允许 Cookie、Host、Origin、Content-Length、`Sec-*`、`Proxy-*` 等浏览器保留字段，不允许换行或大小写重复字段。
- 请求体最多 64KB、24 层、2000 个节点；请求头最多 32KB；返回路径最多 512 字符、32 层。路径展开有数量上限。
- headers/body 的配置错误与上游错误都使用固定说明，不把模板、密钥或上游任意错误文本带回日志或界面。
- `validateProviderConfig` 在 Vault 和普通配置写入之前执行，非法 JSON 不能覆盖原来可用的配置。
- Core 将有效 body/headers/resultPath/batch 纳入 SHA-256 缓存指纹；公开适配器版本不会包含秘密原文或弱指纹。运行中保存配置也通过版本/最终发送检查隔离旧批次。
- 加密密钥导入后的 `refreshStoredState` 同样校验合并后的 custom-http 配置。请求地址、headers、body、返回路径或批量模式实际变化时，立即更新有效配置代号；未发送的旧队列拒绝继续发送，已发送的旧请求允许正常完成并仍归入旧缓存版本。仅刷新其他服务密钥或内容未变时，不取消本服务的等待任务。
- 普通同步和配置列表没有明文 headers/body；这两个字段和其他密钥一样，只通过现有加密备份/明确开启的加密密钥同步机制传输。

这里的声明式模板是本项目定义的 JSON 数据协议，并非支持完整 JSONPath 或任意代码执行。JSON 基础规范见 [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)。

## 前后端接线

`provider-options.ts` 注册两模板，导出 `providerTemplates()` 与 `validateProviderConfig()`。两模板只提供有效的 endpoint 等高级选项，没有 model/prompt/temperature 选项，也不访问 `/models`。既有 OpenAI、llama.cpp、remote-node 模板仍保留原行为。

`effectiveProvider` 增加可选配置参数，只用于 `custom-http` 的批量上限。Core 已传入合并配置，并接入保存前校验、缓存指纹、运行中配置修订和模型列表拒绝。共享 `ProviderTemplate` 扩展与 RPC 注册由主流程完成；`ExtraProviderTemplate` 保持兼容别名。

独立复核曾复现密钥导入遗漏配置换代的问题：A 模板的任务等待并发槽时导入 B 模板，旧任务以 B 发送却记录 A 的缓存版本；重新导入 A 后会误命中 B 译文。修正位于 `Core.refreshStoredState`，没有更改 Vault 格式或其他模板的刷新规则。无效导入配置按既有密钥刷新失败语义标记该服务未配置，阻止调用，其他服务继续刷新；重新导入有效内容或重新保存后可恢复。该检查不回滚已经写入 Vault 的归档，用户需要修复无效归档或重新保存配置。

## 验证

本模块新增及修复回归 **26/26** 测试通过：

- `tests/providers/extra-templates-032.test.mjs` 16 项：真实请求结构、语言映射、完整句子、失标/层级、错误分类、路径白名单、JSON 注入与只替换一次、密钥字段元数据、single/array 请求次数、默认值及批量能力。
- `tests/backend/extra-templates-core-032.test.mjs` 10 项：实际 Core 创建/重启/删除、模板 RPC、双字段 Vault 加密及掩码、非法配置不落盘、配置变化使旧缓存失效、真实批量从两请求切换成一请求、机翻模板拒绝模型查询；另有 headers/body 分别经真实加密 `secrets:import` RPC 换代的两项回归、未变配置队列与其他服务密钥刷新的回归、无效模板导入后阻止调用及恢复的回归。

最初 22 项专项之外，还复跑了既有 `tests/backend/provider-options.test.mjs` 的 9 项高级设置回归，三种旧模板的创建、密钥、模型查询、选项、超时、并发和权限校验均通过，当时合计 **31/31**。为避免并行任务争用产物，旧测试仅在临时副本中把 import 指向独立编译目录，原测试文件未改；运行记录为 `work/providers-032-regression/result.log`。随后上述导入换代修复增加 4 项，并在最新独立编译目录 `tests/.compiled-lang032` 重跑全部 26 项新模板专项，结果 26/26，0 失败、0 跳过。

严格 TypeScript 编译通过。均使用合成公开文字和占位密钥，不访问真实云账户或公共翻译镜像，不宣称实测 LibreTranslate 译文质量。

```powershell
node node_modules/typescript/lib/tsc.js -p tests/contract/tsconfig.json --outDir tests/.compiled-providers032
# 独立输出目录内的 package.json 为 {"type":"commonjs"}
$env:BACKEND_BUILD_DIR = '<项目>/tests/.compiled-providers032'
node --test tests/providers/extra-templates-032.test.mjs tests/backend/extra-templates-core-032.test.mjs
```

整包类型检查、全部旧回归和真实浏览器验收由主流程统一记录。
