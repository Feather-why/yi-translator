# B4：站点规则、WebDAV 同步和密钥备份

日期：2026-11-03。此里程碑增加后端能力及接口；保留现有前端目录，不提供新的规则编辑器或同步设置界面。管理员接口由后端协议 v2 暴露，旧 v1 翻译、词典、对齐和设置消息继续兼容。

## 实现内容

| 模块 | 职责 |
|---|---|
| `src/backend/rules/index.ts` | 内置、本地与订阅规则；安全校验、ETag 更新、上一版回退；内存查询 |
| `src/backend/sync/types.ts` | 按字段记录、每周期设备用量、同步数据源接口 |
| `src/backend/sync/merge.ts` | LWW 合并、删除墓碑、单调设备计数合并及 JSON 校验 |
| `src/backend/sync/chrome-store.ts` | 真实 Chrome 设置、规则、译文记忆、用量与密钥的数据适配 |
| `src/backend/sync/index.ts` | WebDAV GET/PUT、条件写、冲突重试、变更防抖、周期计划和状态 |
| `src/backend/secrets-backup.ts` | 带口令的可移植 AES-GCM 密钥归档及导入回滚 |

不增加运行时依赖；加密、HTTP、JSON 和计时全部使用浏览器内置 API。测试只使用 Node 内置测试器和本机 HTTP 服务，不接触用户网盘或真实凭据。

## 站点规则

### 查询语义

`RuleService.ready()` 先从 `chrome.storage.local['backend.rules']` 加载规则。之后 `forUrl(url)` 是同步内存查询，不发网络，不等订阅更新。顺序为：

1. 本地规则。
2. 订阅规则。
3. 随扩展分发的内置规则。

只有上一层没有任何匹配时才看下一层。同一层选去掉 `*` 后文字最长的匹配模式；同分按规则 ID 排序，避免设备或数组顺序改变结果。返回值是副本，前端不能意外更改后端规则。

内置规则为本项目原创 JSON，包含 Wikipedia 正文区和 MDN 文档正文区，不复制第三方 GPL 项目的实现，也不声称已导入 kiss-rules。

```json
{
  "id": "example.article",
  "match": ["https://example.com/articles/*"],
  "include": ["article"],
  "exclude": ["nav", "pre"],
  "display": "append",
  "style": {"font-size": "95%", "line-height": "1.6"},
  "source": "local"
}
```

### 安全和更新

- 只接受 `SiteRule` 的已知字段；未知的 `script`、事件或可执行字段直接拒绝。
- 地址匹配仅支持 HTTP(S)、`*://` 和文件模式。列表、选择器、ID 和样式均有长度/数量上限。
- `style` 只允许字体、行距、文字排版、margin 和 padding 等属性；禁止 `url()`、`expression()`、`@import`、脚本 URL、反斜杠、分号和规则括号。
- 订阅无论自称哪种 `source`，统一标记为 `subscription`，不能借 JSON 伪装为本地高优先级规则。
- HTTP 请求明确 `credentials:'omit'`、`redirect:'error'`，不携带网站 Cookie，不跟随重定向。
- 单次响应上限 2 MiB；即使服务器不提供 Content-Length，也会按流读取计数，超过后取消读取。
- 有 ETag 时发送 If-None-Match，304 仅更新检查时间。
- 新版本必须先全部解析和验证。错误、HTML 响应、无效 JSON、超限或结构变化都保留 last-good 版本，并在订阅状态中记录简短错误。
- 每次有效更新保留上一版。`rollback(url)` 交换当前与上一版，并清除 ETag，使下一次刷新重新校验服务端内容。

API：`save(rule)`、`remove(id)`、`subscribe(url)`、`unsubscribe(url)`、`refresh(url?)`、`rollback(url)`、`list()`、`exportLocal()`、`importLocal(rules)`。订阅添加或修改应由明确的管理操作触发；自动刷新在扩展启动和每日 alarm 中调用，不阻塞页面 `rules:forUrl`。

## WebDAV 同步

### 开启之前

同步默认关闭，默认构造和普通页面翻译不会联系任何网盘。用户提供 WebDAV 专用目录后，服务在目录中使用 `translate-state-v1.json`。也可直接提供以 `.json` 结尾的文件地址。

远程地址要求 HTTPS；本机测试允许 `http://127.0.0.1`、`localhost`、`[::1]`。不接受地址内嵌用户名、口令、查询参数或片段。服务器需支持 GET、PUT、强 ETag、If-Match 和 If-None-Match；目录应事先存在，后端不会递归创建任意远端目录。

用户名、密码和可选的密钥同步口令通过 `SecretVault` 保存到独立的 `sync` 项，不进入 `settings.ui`、`settings.core` 或普通同步 JSON。修改 origin 时不沿用旧用户名或密码；进行中的旧请求也会中止，避免凭据被带到新站点。所有 WebDAV 请求禁止重定向、禁止 Cookie，单次超时 20 秒。

### 数据和冲突

```json
{
  "version": 1,
  "fields": {
    "settings.ui:/mode": {"value":"fast","updatedAt":1793700000000,"deviceId":"device-a"},
    "rule:removed-rule": {"deleted":true,"updatedAt":1793700000001,"deviceId":"device-b"}
  },
  "usage": {
    "microsoft": {"1796083200000":{"device-a":1000,"device-b":2000}}
  }
}
```

设置按叶子字段拆分；数组作为一个字段。`rule:<id>` 保存每条本地规则，`tm:<hash>` 保存用户译文记忆。字段比较 updatedAt，较新者胜；同毫秒按 deviceId，再按固定序列值决胜，使交换合并方向仍得到同一结果。删除以墓碑传播，不会因另一台设备仍持有旧条目而复活。

用量按「服务 → resetAt 周期 → 设备」保存。相同设备计数取 max，合并后不同设备求和；重复同步不会把同一次请求多算。周期键是原有额度账本的 resetAt 毫秒值，旧月/旧日记录不会加入当前周期。元数据保留最新 400 个周期，防止多年日计数无界增长。

`ChromeSyncStore` 映射实际存储：

- `settings.ui`、`settings.core`：逐叶字段。
- `backend.rules.local`：每条本地规则，订阅副本不作为本地规则同步。
- 译文记忆：通过真实 `BackendStorage` 的 TM 导入/导出适配器；自动译文缓存不进入同步。
- `backend.usage`：兼容现有 `{used, resetAt, devices}`；导入只恢复最新未过期周期。
- `backend.sync.document`：本机合并元数据，包含墓碑和历史周期，不包含明文密钥。

导入前再次捕获当前本机数据，保留网络请求期间发生的新本地修改。`noCache` 内容原本不进入缓存或译文记忆，因此没有进入同步的入口。

生产接线使用 `onUsageImported(counters)` 把合并后的 `{used, resetAt, devices}` 交给核心额度账本。账本同时合并当前内存中尚未落盘的设备计数，并通过同一持久化队列保存；同步存储随后只写自己的元数据，不再直接写 `backend.usage`，避免在途翻译计数和同步导入相互覆盖。没有注入该回调的独立存储仍保留直接写入路径，便于其他嵌入场景使用。

### 条件写和重试

1. 导出本机数据并 GET 远端文件。
2. 404 表示首次创建，以 If-None-Match: `*` 写入。
3. 已有文件必须提供强 ETag，以 If-Match 写入；没有 ETag 或只有弱 ETag 时拒绝覆盖。
4. PUT 遇到 412 或 409，重新 GET、重新合并后重试，总计最多三次。
5. 远端写入成功才导入本机并更新 lastSyncAt；网络、鉴权、口令或冲突失败均保留本机数据，状态页可见 lastError。

单个同步 JSON 上限 8 MiB，同样采用流式读取上限。非 JSON、错误记录、不可移植值、危险对象键、负数或非整数用量均拒绝。一个 HTTP 失败不会静默变成成功同步。

### 调度和重启

`SyncService` 提供 `ready()`、`configure(config)`、`run()`、`notifyChange()`、`status()` 和 `dispose()`。

- 启用后每 10 分钟运行；本地变化后最多等待 30 秒合并一次上传。
- nextRunAt 持久化到 `backend.sync`。service worker 重建时恢复同一个到期计划，过期立即补跑。
- 构造选项 `schedule(whenMs | undefined)` 对接 `chrome.alarms`，而不是依赖 service worker 永远存活；收到 alarm 调用 `run()`。
- 变更监听仅关注设置、规则、译文记忆和额度，不监听 `backend.sync.*` 自身元数据，避免同步循环。
- run 期间再次发生本地变化会在成功后安排 30 秒补同步。
- 同时请求多次 run 共用同一个在途任务；关闭、切换地址或 dispose 会取消在途请求。

## 密钥默认留在本机

默认导出数据源不会读取/导出服务密钥，WebDAV 文件不含 `secrets`。若远端已有其他设备留下的加密包，未开启密钥同步的设备只原样保留该不透明包，不解密、不覆盖它。

用户明确设置 `syncSecrets:true` 时，必须提供至少 8 个字符的口令。密钥按字段保留 LWW 版本，先加密再上传；仅更新具体服务的凭据，WebDAV 自己的 `sync` 凭据永远不随同步上传。导入后通过 `onSecretsImported(ids)` 通知核心刷新内存中的已解密凭据，避免等待 service worker 重启。

可移植归档也可独立使用：

```ts
const archive = await exportVault(vault, passphrase, providerIds);
const importedIds = await importVault(vault, archive, passphrase);
```

格式为 version 1、PBKDF2-SHA256 600,000 次、16 字节随机 salt、AES-256-GCM、12 字节随机 IV，并绑定固定 AAD。每次导出都会产生不同盐和 IV。导入先验证版本、派生次数范围、认证标签、JSON 和全部字段，口令错误不会写入任何服务；保存中途失败会尝试恢复已写服务的旧值。口令不存入归档。

这是带口令的便携备份，与本机 SecretVault 的不可导出设备 CryptoKey 分开。不要把本机设备密钥导出或放进 WebDAV。

## 业务服务与 RPC 集成

`src/backend/services.ts` 的 `BackendServices(core)` 为生产入口创建真实 `Dictionary`、`AlignmentService`、`RuleService`、`ChromeSyncStore` 和 `SyncService`。译文记忆适配器直接使用核心的 `BackendStorage.exportEntries/importEntries`，密钥使用同一个 `SecretVault`，不另建演示存储。词典初始化失败时仍可查询规则、管理提供方并查看失败状态。多媒体能力由启动入口注入 `MediaService`，本轮不增加前端入口。

旧版 RPC 继续兼容：`dict:lookup` 接本地 ECDICT；前端既有 `lang:auto` 的英文字形会识别为 `en`，因此不需要修改划词代码。`align:get` 接真实词对齐，敏感页面和隐私窗口强制 `noCache/localOnly`。`rules:forUrl` 只等待本机规则初始化，不等待订阅网络。`tm:save` 成功后显式通知同步，补足 IndexedDB 写入不会触发 `chrome.storage.onChanged` 的情况。

新增协议 v2 管理接口如下：

| 接口 | 行为 |
|---|---|
| `backend:capabilities` | 返回真实词典、词对齐、多媒体和同步状态；本地对齐模型名称为 `Xenova/multilingual-e5-small` |
| `dict:import` | 导入本地 CSV，限制输入 20 MiB |
| `align:configure` | 保存非敏感设置，远程 token 单独写入 vault 的 `align` 项；掩码保留原值、空字符串清除，跨 origin 不沿用原 token |
| `rules:list/save/remove/subscribe/refresh/rollback` | 管理本地规则和订阅，失败返回可见错误并保留有效版本 |
| `sync:configure/run` | 明确开启或关闭同步、手动执行；网络失败进入状态并返回错误 |
| `secrets:export/import` | 外层归档为 JSON 字符串；只允许已注册提供方和 `align`，导入后刷新核心内存凭据 |

管理接口要求 `sender.id === chrome.runtime.id`，且 `sender.url` 必须位于 `chrome.runtime.getURL('')` 的扩展 origin。选项页即使有 `sender.tab` 仍可管理；普通网页内容脚本即使来自本扩展也不能执行这些管理操作。鉴权在读取请求字段之前完成。多媒体 RPC 允许本扩展的内容脚本调用，敏感来源强制 `noCache`。处理器表不继承对象原型，未知的 `constructor`、`__proto__` 等名称不会进入业务代码。

启动入口通过 `chrome.alarms` 恢复同步计划，定期刷新订阅，并监听设置、规则和用量变化；同步自身的配置、密钥时钟及文档元数据不触发新的同步。导入造成的业务数据变化可能安排一次 30 秒补同步，后续没有新差异就恢复 10 分钟周期，不形成无限循环。

## 验收测试

在项目根目录：

```powershell
npm run test:backend
```

编译后也可单独运行 B4：

```powershell
node --test tests/backend/rules.test.mjs tests/backend/sync.test.mjs tests/backend/secrets-backup.test.mjs
node --test tests/backend/rpc-v2.test.mjs tests/backend/services.test.mjs
```

本次 B4 独立验收 **21/21 通过**，RPC 与真实服务集成 **8/8 通过**，合计 **29/29 通过**，并通过 TypeScript strict + noUncheckedIndexedAccess 编译：

| 分组 | 覆盖 |
|---|---|
| 规则 6 项 | 来源优先级/具体度、纯本地查询、脚本和样式拒绝、ETag 304、last-good、回滚、真实 HTTP、不带 Cookie、响应流上限、坏订阅隔离、内置正文规则、热查询小于 30ms |
| 密钥归档 3 项 | 真实 PBKDF2/AES-GCM、随机 salt/IV、跨实例解密、错误口令/损坏数据不写、字段和参数上限、保存失败回滚 |
| 同步 12 项 | 本机 HTTP WebDAV 两设备设置和用量收敛、412 重试、三次上限、缺少强 ETag 不覆盖、默认密钥不上传、显式密钥密文上传和解密、30 秒/10 分钟计划恢复、origin 切换取消与认证隔离、TM 墓碑、网络期间本地修改、历史周期隔离和裁剪、账本回调保留尚未落盘计数 |
| RPC 7 项 | v1 兼容、`auto` 英文词典、敏感来源对齐和媒体约束、管理接口拒绝内容脚本、真实加密归档导入白名单、TM/规则变更通知、标准信封和监听器注销、原型名称拒绝 |
| 服务集成 1 项 | 真实 BackendCore、vault、词典与默认业务服务接线；`running` 还原为 `run`、内置正文规则、TM 导出、对齐 token 加密与掩码/清除/跨 origin 隔离、能力状态 |

测试内的账号、口令和 key 均为一次性合成值，服务只监听本机。真实用户网盘账号没有提供，因此没有声称已连接坚果云、Nextcloud 或第二台物理电脑；两台独立存储客户端通过真实 HTTP 验证协议和数据合并。最终全项目验收由主流程统一执行。

## 资料和边界

- [RFC 4918：WebDAV](https://www.rfc-editor.org/rfc/rfc4918)
- [RFC 9110：If-Match 与条件请求](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match)
- [WebCrypto PBKDF2 派生密钥](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey)

同步账户应专用于本扩展，目录应已有写入权限。弱 ETag 或不支持条件 PUT 的服务器会明确失败，不进行无保护的最后写入覆盖。设备时间应基本一致；同设备本地修改时间会单调递增。规则目前只保留一个可回退有效版本，不包含第三方规则仓库历史，也未复制第三方 GPL 代码。
