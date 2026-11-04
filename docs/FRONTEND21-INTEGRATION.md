# 第 21 节前后端真实联调

验收日期：2026-11-03。正式包 `.output\chrome-mv3`，扩展 `0.2.2`、后台 `0.2.2-alignment`。本次接入和修复均在后端；保留现有前端和原始 `tests/e2e`。

## 首次安装欢迎页

`src/entrypoints/background.ts` 把安装事件交给 `src/backend/installation.ts`。仅 `details.reason === 'install'` 创建 `chrome.runtime.getURL('options.html#welcome')` 标签页。扩展更新、浏览器更新和共享模块更新仍重建菜单，但不创建欢迎页。

菜单注册和创建欢迎页独立启动，并用 `Promise.allSettled` 收拢同步异常与异步拒绝。菜单失败或尚未完成不阻断首次引导；创建页面失败也不影响菜单注册。菜单实现继续复用原有 helper，没有重复注册第二套菜单。

`tests/backend/installation.test.mjs` 五项通过：首次安装地址；非首次原因不弹页；菜单同步/异步失败；菜单尚未结束时欢迎页独立打开；地址计算/标签创建失败仍注册菜单。连同媒体菜单十三项，共十八项专项通过。真实独立 Edge 也观察到 fresh install 自动打开欢迎页；更新原因由后台单测覆盖，不冒充真实浏览器升级测试。

## 联调中修复的两个问题

### 普通重翻后无法保存人工修订

工具条“换一家”“重翻”“翻得不好”都按约定发送 `noCache:true`。旧后端把所有这样的原文全局标记为敏感十分钟，后续普通网页主动 `tm:save` 也被拒绝。现已移除这种全局封锁：`noCache` 继续让本次任务不读写缓存、译文记忆或预计算；随后用户主动保存修订可以成功。真实敏感站点/隐身来源仍由后端根据 sender 拒绝写入。

联调保持用户真实操作顺序：先换一家、重翻、差评，再编辑同一段并保存。没有通过更换原文、跳过重翻或调整测试顺序掩盖问题。

### 高级规则的域名输入不兼容

前端提示允许输入 `example.com`、`*.example.org`，旧后端只接受带协议的完整匹配模式，因此保存失败。后端只在本地规则保存入口把安全域名简写归一为 `*://host/*`；订阅 JSON 保持严格校验。UI 测试继续输入裸域名，并确认保存为 `*://frontend21.example.test/*`、实际可匹配 HTTPS 页面，随后可编辑和删除。

## 十项真实界面验收

`tests/backend/frontend21-browser.mjs` 在独立临时 Edge 中加载上述实际正式包，连接已部署的真实本机 llama.cpp 服务，**10/10 通过**。

| 验收项 | 实际证据 |
|---|---|
| 首次安装打开欢迎页 | 实际出现 `options.html#welcome`，欢迎标题正常 |
| 官方检测、推荐排序和真实试译 | 浏览器内置服务排首位并标推荐；非官方接口不自动检测/启用；手动试译最终提供方为 `llamacpp` |
| 需要密钥的服务入口 | 实际点击进入 `#providers/<id>` 详情 |
| 完成引导 | 跳转常用设置，`onboarded:true` 持久化 |
| 高级页直达和保存 | `ui:openOptions` 打开 `#advanced`；裸域规则新增/匹配/编辑/删除、词对齐配置保存、停用同步均成功 |
| 单次换引擎 | 真实本机第二实例参与一次 `accurate`、`noCache:true`、`providerHint` 任务；当前引擎显示正确，pin 状态不变，后续普通任务不携带 hint |
| 重翻与差评 | 真实端口产生重翻任务，实际 `feedback:bad` 被调用 |
| 修订保存及记忆命中 | 同段重翻后使用实际 contenteditable 输入标记，保留嵌套链接/加粗与原子代码；新页面普通任务重新翻译时命中人工标记 |
| 损坏占位符拒绝 | 实际编辑删除全部链接/代码，界面显示未写入；完全同一 payload 的补充正式 RPC 返回 `bad_input`/占位符错误，原有记忆仍可命中 |
| 无服务错误收拢与恢复入口 | 实际关闭所有服务，新原文只显示小红点，菜单出现全部重试和去设置服务；点击后真实打开欢迎页 |

普通任务命中人工记忆时，端口记录中的 `noCache`、`providerHint` 均缺省。原文不含人工标记，重新导航也没有沿用旧译文 DOM，因此新页出现标记是实际持久化记忆命中的证据。链接 href、`a strong` 嵌套和 `llama-server -ngl 99` 代码均另行断言。

真实保存的占位符示例：

```text
source: Read the <g0><g1>installation guide</g1></g0>, then run <x2/>. Keep all links and commands intact.
target: 阅读 <g0><g1>安装指南</g1></g0>，然后运行 <x2/>。请保持所有链接和命令不变。 人工校订标记20261103
```

本次观察到十二次本机 `/v1/chat/completions` 响应，全部 HTTP 200，且有真实中文输出；页面脚本异常为零。后台构建 SHA-256：`19f3e63202ecfdca362f9e69cd646b0093ab9ad69c4659cd8cdc5c08ba2fc7fb`。

## 运行和取证

先启动本机模型并生成正式包，然后运行：

```powershell
# 从项目根目录运行。
$env:BROWSER_EXECUTABLE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:EXT_DIR = (Resolve-Path '.output/chrome-mv3').Path
$env:LLAMA_URL = 'http://127.0.0.1:8081'
node tests/backend/frontend21-browser.mjs
```

`REPORT_DIR` 可指定报告目录；默认 `work/frontend21-browser`。测试只接受本机模型地址，使用自己创建并清理的临时配置，不接管日常浏览器。通过被动 RPC/端口监听记录真实输入，不响应消息、不替换提供方响应或前端实现。首次引导专项故意不使用旧测试的欢迎页隔离 helper。

实际交付位于工作区 `outputs/test-evidence/frontend21-deployed/`：

- `frontend21-browser-result.json`：完整案例、构建哈希、真实模型响应、原始任务与修订 payload。
- `welcome-real.png`：引导排序、真实可用状态及本机试译。
- `advanced-real.png`：高级页和真实保存提示。
- `toolbar-memory-real.png`：普通新页面命中人工修订且保留链接/代码。
- `error-collapsed-real.png`：真实无服务错误小红点及恢复操作。

四张截图均已人工复核。所有测试上下文和临时配置已关闭并清理。

## 结果边界

本轮独立浏览器未准备原生翻译语言包，内置行真实显示“此设备或语言对暂不支持浏览器内置翻译”，并保持关闭；这条用例验证引导正确显示失败原因，不把它算作原生翻译成功。原生翻译真实推理和语言包准备另见 `BROWSER-TRANSLATOR.md`。

引擎切换 UI 用例证明单次 hint、pin 不变及后续普通任务行为；其主引擎原本已 pin，且新任务可能命中普通缓存，所以不把这一条扩大为独立证明全部 sticky 隔离。相关调度语义由后台合约另测。

界面仅给出通用“未写入记忆”提示。报告中的占位符错误码来自同一 payload 的补充正式 RPC，不声称被动监听到了原 UI 响应。WebDAV 用例只测停用配置，不代表已完成真实远程服务、多设备同步、密钥备份导入导出或订阅网络验收。整体项目类型检查和原有前端/媒体回归结果由主验收单独记录。
