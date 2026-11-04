# 第 34.3 节：DeepL 套餐主机、额度与 Unicode 回归

核实日期：2026-11-04。适配器版本从 1.0.1 升至 1.0.2。本文说明 DeepL 适配器及其后端测试；已完成的 Core 账户额度同步、quotaText 和正式包验收见 [总集成记录](INTEGRATION-034-RESULTS.md)。

## 主机选择修复

之前 `translate` 和 `usage` 都固定请求 `api-free.deepl.com`，非 Free 密钥会因为主机不匹配而认证失败。现在两个方法共用同一个凭据函数：

| 清除两端空白后的密钥 | 翻译地址 | 用量地址 |
|---|---|---|
| 以 `:fx` 结尾 | `https://api-free.deepl.com/v2/translate` | `https://api-free.deepl.com/v2/usage` |
| 其他非空密钥 | `https://api.deepl.com/v2/translate` | `https://api.deepl.com/v2/usage` |

API key 只放在 `Authorization: DeepL-Auth-Key …` 请求头，不放 URL。两端空白只从凭据删除，不处理用户待翻译文本。空密钥或纯空白密钥直接返回明确的 auth 错误，不发送请求。服务名称改为“DeepL API”，字段标签改为“API 密钥”，不再暗示只支持旧 Free 套餐。

依据：[DeepL 官方认证说明](https://developers.deepl.com/docs/getting-started/auth)。该页面明确 Free 密钥以 `:fx` 结尾，Free / Pro 使用不同主机。没有根据字符上限猜套餐，也没有在认证失败后把同一密钥轮流发给多个主机。

本项目原 DeepL 适配器没有自定义地址字段，元数据也没有为它开放 endpoint；本分项没有新增代理设置。HTTP 仍通过原 `ctx.fetch` 传输，不绕过现有超时、取消、请求计时和网络限制。

## 新旧额度规则

官方核实结果：新 **API Developer** 提供总计 **1,000,000 字符**，用完不重置；存量 **API Free** 仍为每月 **500,000 字符**。API Growth 有月付和年付方案，不能把所有非 Free 密钥的 100 万字符都当作 Developer 一次性额度。[DeepL 套餐说明](https://support.deepl.com/hc/en-us/articles/360021200939-DeepL-API-plans)、[官方用量与计费说明](https://support.deepl.com/hc/en-us/articles/360020685720-Usage-count-and-billing-in-DeepL-API)

适配器继续保留 `freeQuota: 500_000 / month` 作为历史兼容默认值，新增后端元数据 `quotaText` 明确这两种套餐和账户实际额度优先。实际 `/v2/usage` 返回的 `character_count` / `character_limit` 不再被适配器替换成默认数值。两值必须是非负安全整数，**0 是合法上限**；官方无上限哨兵 `1_000_000_000_000` 也可以安全表示。字符串、小数、负数、null 或超过 JS 精确整数范围的值会被明确拒绝，不能成为错误的本地额度。

[官方 usage 文档](https://developers.deepl.com/api-reference/usage-and-quota/check-usage-and-limits) 还列出以下语义，供 Core 集成处理：

- `character_limit` 包含账户 Cost Control 的限制；Pro 响应可能另有 `api_key_character_count` / `api_key_character_limit`。
- `start_time` / `end_time` 是账户当前周期的 ISO 8601 时间，仅 Pro 响应提供。
- 没有套餐标识字段。单凭密钥后缀或 `character_limit === 1_000_000`，无法断定一次性 Developer 或付费 Growth；缺少 `end_time` 时不应虚构下月重置。
- 用量近实时，官方说明可能有几分钟延迟；它不等同于逐请求强同步计数。

Core 已以实际账户上限取代旧默认 50 万；用户明确设定的本地日/月预算另行保守限制。零上限保持耗尽状态，不能因为 `amount <= 0` 路径而被视为“无额度限制”。实现边界和验收见总集成文档。

适配器将合法且晚于当前时间的 `end_time` 转成内部可选 `quotaResetAt` 毫秒时间戳；缺失、过期、非 ISO 或非法日期不返回该字段。特别检查了 JavaScript 会自动滚动的“2 月 30 日”，避免它变成一个伪造的重置日期。不以数值或密钥后缀推断周期。

本轮仍以账户级 `character_count` / `character_limit` 为准，没有额外估算 key 级剩余额度。若更低的 API key 限制先耗尽，上游 HTTP 456 继续归类为 quota 并进入已有调度降级；不把单独 key 额度误报成账户总额度。

## Unicode 数学字母

XML 编码只转义普通文本中的 `&` / `<` / `>`，不执行 NFKC、NFKD、NFC 或大小写转换。响应 XML 的数字实体按码点解码。例如 `&#x1D441;` 恢复为 `𝑁`，不会变成普通 `N`。请求和响应测试覆盖 `𝑁 ℎ 𝐱 𝛼 𝟘`、`<gN>` 和 `<xN/>` 混排。

计费用量沿用 Unicode 码点数量，因此辅助平面数学字母不是按 UTF-16 两个码元重复计费。该检查证明适配器传输与解析不归一化文本；并不声称远端模型永远不会改变符号。缺失占位符恢复由后端公共恢复流程另行处理。

## 局部验收

独立严格编译与回归命令：

```powershell
node node_modules/typescript/lib/tsc.js -p tests/contract/tsconfig.json --outDir tests/.compiled-deepl034
Set-Content tests/.compiled-deepl034/package.json '{"type":"commonjs"}'
$env:BACKEND_BUILD_DIR = (Resolve-Path tests/.compiled-deepl034).Path
node --test tests/providers/deepl.test.mjs tests/providers/deepl-034.test.mjs tests/providers/languages-032.test.mjs
```

独立严格编译通过，局部测试 **30/30，通过，0 失败、0 跳过**。原始记录为工作区 `work/integration-034/deepl-adapter-tests.log`。

- 新增 11 项：Free / paid / 两端空白 / 非结尾 `:fx` 的双接口主机检查、空密钥、数学字母与码点费用、实际额度边界、非法 usage 数值、实际账期与非法日期。
- 既有 DeepL 7 项：嵌套 XML、实体转义、真实额度返回、456/429/403/503 分类、异常响应拒绝。两项原 Free 主机测试的合成密钥补上 `:fx` 后缀。
- 新增语言回归 12 项：各适配器显式语言传递、腾讯方向矩阵、本地 auto / 非流式行为不变。

测试使用合成密钥和固定 HTTP 响应回放，没有访问用户 DeepL 账户、消费真实字符额度或调用付费服务。正式包类型检查、完整合约、Core 额度校验和最终交付由总集成统一记录。
