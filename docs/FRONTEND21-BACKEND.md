# 第 21 节前后端联调：后端补齐记录

日期：2026-11-03。对应 `HANDOFF-BACKEND.md` 第 21 节前端请求；本次不修改前端目录。第 13 节已先记录兼容新增 RPC，协议仍为 v2，旧 RPC 的响应结构保持兼容。

## 设置页直达与向导测试

`ui:openOptions` 现在接受 `general`、`providers`、`status`、`welcome`、`advanced`，分别打开扩展自己的 `options.html#<tab>`。省略 tab 或未知值仍走浏览器的默认设置页，不能由该参数打开任意外部 URL。共享协议中前端已增加的两个值予以保留。

新向导会在页面挂载时自动执行 `providers:test`。后端依据浏览器提供的 sender URL 判定同扩展 `#welcome` / `#welcome/...`，向 `Core.test` 传内部选项 `{prepare:false}`。这样仍实际检查模型和返回 `no_provider` 的明确中文原因，但不打开语言包准备页。此选项不改变公共 RPC 请求。

用户在服务设置页执行测试时，保留既有准备流程：语言包需要下载，则打开后端管理的可见准备页，由真实按钮点击启动下载；不支持的设备或语言对如实返回不可用。后台周期探测也不会打开准备页。欢迎页的错误行由现有前端直接显示，未增加假成功状态。

## 新增 `rules:subscriptions`

调用只允许扩展自己的管理页面。网页内容脚本、其他扩展和伪造相似 origin 均收到 `auth`，与其他 `rules:*` 管理接口一致。请求为 `void`：

```ts
const subscriptions = await rpc('rules:subscriptions', undefined);
```

响应为订阅数组，不混入本地规则或内置规则：

```json
[
  {
    "url": "https://rules.example/list.json",
    "version": "release-2026.11",
    "updatedAt": 1793721600000,
    "etag": "\"http-validator\"",
    "count": 12,
    "canRollback": true,
    "lastError": "规则更新失败，继续使用上次有效规则"
  }
]
```

该 JSON 为格式示例；测试数据和真实订阅状态以服务返回为准。

| 字段 | 语义 |
| --- | --- |
| `url: string` | 后端实际管理的订阅来源 URL |
| `version: string \| number \| null` | 有效订阅 JSON 中的 `version`；未声明有效版本时为有效规则规范化 JSON 的 `sha256:<64位十六进制>`；首次获取失败且从未有有效版本为 `null` |
| `updatedAt?: number` | 最近一次成功获取、304 确认或回滚的毫秒时间戳；失败不会覆盖 |
| `etag?: string` | HTTP 缓存验证标记，独立于规则版本；回滚时清除，下一次重新获取 |
| `lastError?: string` | 最近失败拉取的说明；失败保留上次规则、版本及更新时间，成功拉取或 304 清除 |
| `count: number` | 当前实际生效的订阅规则数量 |
| `canRollback: boolean` | 是否有上一份规则快照，可调用已有 `rules:rollback` |

`version` 使用内容或上游声明作为依据，不把 ETag 命名成规则版本。没有文档版本的数组订阅只因空白排版变化不会换版本，规则内容变化会换版本。回滚时规则和版本一起交换；重启后保留版本、错误、ETag 和上一份版本。旧存储若只有有效规则，会在读取时补出真实内容 hash，无需重新下载或清空配置。

订阅仍只接受受限 JSON 数据，既有大小、字段、样式和来源校验继续生效。`rules:list` 仍返回 `SiteRule[]`，`rules:subscribe/refresh/rollback` 的成功响应仍为 `{ok:true}`。前端现有 `ui.ruleSubscriptions` 不被后端修改；前端可在后续自主管理的改动中改用此列表接口。

## 文件

| 文件 | 本次改动 |
| --- | --- |
| `src/backend/rpc.ts` | 两个设置页目标、向导安静测试、受管理权限保护的订阅状态 RPC |
| `src/backend/rules/index.ts` | 文档版本 / 内容 hash、刷新与回滚元数据、重启保留错误、读取旧存储 |
| `src/shared/backend-v2.ts` | 兼容新增 `RuleSubscriptionInfo` / `RuleSubscriptionVersion` 和 RPC 类型 |
| `tests/backend/rpc-v2.test.mjs` | 路由、向导选项、原样错误、管理权限及旧接口兼容 |
| `tests/backend/rules.test.mjs` | 文档版本与 ETag 区分、失败 / 304 / 回滚 / 重启、内容版本和旧存储迁移 |

## 高级页本地网站简写兼容

真实高级页的新建规则输入框提示 `example.com` / `*.example.org`，并把该输入原样交给 `rules:save`。原后端只接受带协议的模式，导致用户正常保存得到 `bad_input`。修复在 `RuleService.save` 的本地人工保存入口完成，前端输入和测试继续使用真实裸域形式。

| 人工输入 | 保存后模式 |
| --- | --- |
| `frontend21.example.test` | `*://frontend21.example.test/*` |
| `*.example.org` | `*://*.example.org/*` |
| `localhost:8087` | `*://localhost:8087/*` |
| `例子.测试` | `*://xn--fsqu00a.xn--0zwm56d/*` |
| `[::1]:3001` | `*://[::1]:3001/*` |

已有 `http(s)://`、`*://`、`file://` 模式保留原样并继续经过原验证。裸域只允许合法主机、可选 1–65535 端口和开头的 `*.`；不接受凭据、空白、路径、查询、片段、反斜杠、百分号编码绕过、脚本 scheme、任意位置通配或隐式数字 IP。域名通过 URL/IDN 规范化，IP 使用明确完整形式。显式 80/443 端口会展开为两种协议各自规范化的模式，避免 URL 去掉默认端口后规则失配。

子域 `*.example.org` 按现有匹配器语义匹配子域；根域需要另加 `example.org`。本次没有改动既有协议模式的匹配语义。归一化后的规则可正常持久化，重启后继续命中。

远端订阅 JSON 和通用 `validateRule` 不经过裸域归一化，仍严格要求原带协议模式；规则导入与订阅校验没有被整体放宽。追加四项针对回归，覆盖真实 `forUrl` 查询、localhost/端口/IDN/IP、旧模式保留、危险输入无写入及远端简写拒绝，规则文件全 13/13 通过，后端合约编译通过。

## 验证与边界

本次后端范围 TypeScript 合约编译通过；两份针对测试共 19/19 通过，其中包括实际本机 HTTP 服务器的 ETag、失败保留与回滚用例。新增测试明确区分：规则 / RPC 的测试边界服务用于验证协议，浏览器向导的真实 sender URL 及 UI 行为由完整正式包联调验证。

已知完整类型检查限制：当前前端 `src/frontend/options/advanced.ts:175` 从 `chrome.storage.local` 取值赋给 `string[]`，存在本轮之前的类型错误。按用户分工要求，本轮不修改该文件；不能把后端合约编译通过表述为完整项目类型检查通过。前端入口、B5 菜单和原有 13 项前端回归由最终集成验收统一记录。

后台默认高速顺序、译文记忆占位符错误码与一次性 providerHint 的联调属于同轮其他后端工作，最终集成记录应结合相应合约测试确认。

## 普通页面重翻后主动修订

原实现曾把所有 noCache 原文加入十分钟的敏感来源锁，这会让普通页先重翻、再修改译文的正常操作被拒绝。本轮删除这层来源误锁定：noCache 翻译本身仍完全不读写自动缓存或记忆、不预计算、不进入同步；随后用户在普通网页明确提交 tm:save 是独立保存动作，可以写入人工记忆并供后续普通任务命中。敏感站点与隐身窗口仍由浏览器真实 sender 判定并拒绝保存，没有放开这些来源。相关回归检查了零隐式读写、旧缓存不变、主动保存只触发 tmPut、敏感来源继续 bad_input。
