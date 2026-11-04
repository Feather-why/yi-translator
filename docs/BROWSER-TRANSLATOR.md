# Chrome / Edge 浏览器内置翻译

核实与验收日期：2026-11-03。

## 接入范围

新增 `browser-translator` 官方适配器，默认启用，参加 `fast`、`combined`，无需 API Key，没有云端字符额度。它调用浏览器提供的本机模型，不是 Azure Translator，也不是 Google 网页翻译接口。首次语言包下载需要网络；准备完成后的译文在设备上生成。浏览器、操作系统、设备和语言对不支持时会返回 `no_provider`，由既有调度器继续使用其他服务。

官方文档列出桌面 Chrome 138+、Edge 148+ 的 Translator 支持。版本满足并不代表所有设备、语言对均可用，运行时始终以 `Translator.availability()` 为准。[Chrome 官方说明](https://developer.chrome.com/docs/ai/translator-api)、[Edge 官方说明](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/translator-api)。

该 API 只暴露在安全的 `Window` 上，不能直接在扩展 service worker 中创建。后台通过内部消息调用本扩展唯一的 offscreen 文档；不会向网页注入浏览器 API，也不会传递网站 Cookie。offscreen 与已有对齐、OCR 共用，准备页不会抢答隐藏窗口的任务。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `src/backend/providers/browser-translator.ts` | 单家适配器，元数据、健康检查与错误分类；只依赖 providers/types |
| `src/backend/browser-translator-bridge.ts` | 后台 CLD 检测、内部消息、超时和取消 |
| `src/backend/browser-translator-engine.ts` | Window 原生 API、语言规范化、会话复用与释放 |
| `src/entrypoints/offscreen/browser-translator.ts` | 注册 availability / translate / cancel 任务 |
| `src/entrypoints/offscreen/browser-translator-setup.ts` | 可见的首次模型准备页，真实点击启动下载 |
| `src/entrypoints/offscreen/main.ts` | 隐藏任务与可见准备页分流 |

`ProviderContext.builtin` 为可选内部依赖，既有适配器和测试上下文不受影响；前后端共享 RPC 协议不变。不引入运行时依赖。

## 首次启用

1. 在扩展设置中测试“浏览器内置翻译”。语言包尚未准备时，后台可打开本扩展的准备页。
2. 确认语言代码，如 `en → zh`，点击“下载并启用翻译语言包”，等待成功提示。
3. 回到设置重新测试。已准备好的语言对可以进入高速调度。

准备页地址由后台生成：

```ts
chrome.runtime.getURL('offscreen.html?translatorSetup=1&sourceLang=en&targetLang=zh')
```

下载调用在可见按钮的点击处理器中直接执行 `Translator.create()`，不会先等待 RPC 再伪造用户激活。隐藏窗口仅在 `available` 时调用 `create()`；`downloadable` / `downloading` 均快速失败。例行探测和自动翻译不会自行打开准备页或启动下载。浏览器规定首次创建可能需要用户激活，详见 [官方使用指南](https://github.com/GoogleChrome/modern-web-guidance-src/blob/main/guides/built-in-ai/translator/guide.md)。

准备页属于后端管理的 offscreen 入口。原有翻译界面、整页译文和划词前端无改动。用户取消或关闭页面会中止等待，不修改浏览器安全设置。

## 自动识别原文

整页请求通常为 `sourceLang: auto`。扩展后台优先调用浏览器自带 `chrome.i18n.detectLanguage()` 的 CLD，无需下载 AI 语言检测模型。该扩展 API 在 service worker 一侧调用；offscreen 只负责接收明确语言并翻译。[官方 i18n 文档](https://developer.chrome.com/docs/extensions/reference/api/i18n#method-detectLanguage)。

只有同时满足以下条件，才使用 CLD 的实际识别语言：

- `isReliable === true`；
- 第一语言占比至少 90%，且不是 `und`；
- 其他语言没有达到 10%；
- 返回合法语言代码，且在 1 秒内完成。

识别前移除 `<g>` / `<x>` 占位标记，避免把标记名字当语言样本。低置信、明显混语或检测超时返回 `no_provider`，交给其他翻译服务，不把 `auto` 猜成英语。CLD 不存在时可使用已就绪的原生 `LanguageDetector`，同样要求可靠结果；原生检测模型也未就绪则降级。

`availability(auto, target)` 仅提供默认 `en → target` 的准备提示和检测能力，不承诺任意源语言对可用。每次翻译都先识别真实语言，再检查真实语言对。短语可能无法得到可靠 CLD 结果，这是有意的保守降级；可用的本地模型仍负责这些请求。

准备页的 AI 自动检测按钮为可选项。此机 Edge 实测原生 `LanguageDetector` 无法准备，但 CLD 可正常工作，因而不阻塞整页自动翻译。准备提示明确区分两者。

## 限制、取消与结构

- 每次最多 2,000 字符、1 段，适配器并发 1；原生调用按输入顺序等待完成。
- availability 原生检查限时 2 秒，bridge 限时 3 秒；原生创建 / 翻译各限时 8 秒，bridge 翻译限时 12 秒。
- 取消携带内部任务 UUID 发送给 offscreen，原生会话收到同一个 AbortSignal；取消后的结果不会交付。
- 最多缓存三组语言对，淘汰和十分钟空闲释放都调用真实 `destroy()`；关闭时释放。超时、取消或 dispose 后迟到的原生会话也会销毁，不能重新写回缓存。
- `zh-CN` 归一为 `zh`，`zh-TW/HK/MO/Hant` 归一为 `zh-Hant`，保留其他合法 BCP 47 语言代码。目标为相同语言、纯数字和原子片段不必调用模型。
- 内置翻译也受现有后端占位符硬校验约束，不信任浏览器模型必然保留 `<g>` / `<x>`。结构无效、无输出、模型不支持或未准备时按调度规则降级；不会伪造成功状态。

## 测试与真实验收

针对测试：`tests/backend/browser-translator.test.mjs`、`tests/providers/browser-translator.test.mjs`，共 17 项通过。它们用明确的原生 API 测试边界验证语言规范化、未准备不下载、顺序和缓存、真实识别语言传递、低置信和混语拒绝、取消、迟到会话释放、错误分类及官方无额度元数据；这些单测不是模型译质证据。

真实浏览器脚本：`tests/backend/builtin-browser.mjs`。脚本构建实际的 production offscreen、bridge、准备页，在独立 Edge profile 中创建真实 offscreen，通过实际按钮点击下载模型，再进行实际推理。没有回放译文或伪造 `Translator`。测试框架默认会关闭 Translate 和组件下载；脚本只撤回这些测试默认禁用项，保留其他默认禁用特性，不强开实验功能、不修改用户资料夹。

实际记录在 `work/builtin-browser-result.json`，准备页截图为 `work/builtin-setup-browser.png`。2026-11-03 18:09 UTC，Edge 156.0.4314.58（最终复验为无头模式）已验证：

| 检查 | 实际结果 |
| --- | --- |
| 初始 `en → zh` | `downloadable` |
| 真实点击准备按钮 | 语言包准备成功 |
| 同源隐藏 offscreen 再检查 | `available` |
| 原生显式英文句子 | `The browser translates this sentence locally.` → `浏览器在本地翻译这句话。` |
| 原生 AI LanguageDetector | `unavailable`，按钮如实显示无法准备 |
| 真实后台 CLD | `isReliable: true`，`en: 100%` |
| 后台 bridge 的 auto 可用性 | `available`、`supportsAuto: true` |
| 后台 auto 请求 → 真实隐藏原生模型 | 成功返回下列中文段落；`realAutoTranslationVerified: true` |

自动识别测试原文：`The browser translates this sentence locally. The built-in translator runs on this computer after downloading a language pack. This paragraph is written in English to verify reliable language detection.`

真实译文：`浏览器在本地翻译此句子。下载语言包后,内置翻译器在此计算机上运行。本段是用英语编写的,以验证可靠的语言检测。`

此结果来自实际 service worker 中的 production bridge，语言由真实 CLD 识别，再由实际 offscreen 原生模型翻译。原始识别数据、译文和验证标志同时记录到上述 JSON。独立测试 profile 成功不代表用户日常 profile 已下载语言包，用户仍需在自己的扩展准备页完成首次点击。

验收分为两个浏览器层次：

| 层次 | 脚本和范围 | 记录 |
| --- | --- | --- |
| 原生与桥接 | `tests/backend/builtin-browser.mjs` 构建最小 fixture，加载 production bridge / offscreen / 准备页，验证实际下载、CLD 与模型推理 | `work/builtin-browser-result.json`，已通过 |
| 正式包完整集成 | `tests/backend/builtin-production-browser.mjs` 加载 `EXT_DIR` 指定的 0.2.2 正式包，经过 BackendCore / index / RPC / tx:translate 端口，关闭全部其他服务，自然调度 auto 两段，并校验 nested g / x 结构及网站锚点 | `work/builtin-production-browser/report.json`，2026-11-03 18:17 UTC 已通过，`passed: true` |

正式包脚本验证显式 `providers:test` 在首次使用时自动打开准备页，再真实点击下载，之后实际调用服务测试与翻译长连接。它还记录包版本、服务启停状态、隐藏原生包状态、每条端口消息、实际 provider 和准备页 / 服务设置截图。可执行：

```powershell
# 从项目根目录运行。
$env:EXT_DIR = (Resolve-Path '.output/chrome-mv3').Path
node tests/backend/builtin-production-browser.mjs
```

本次整包实际结果：首次 `providers:test` 返回语言包未准备，并自动打开真实准备页；下载后 `en → zh` 为 `available`；第二次测试成功，耗时 39 ms。所有云端、本地模型和非官方服务均关闭。两段自然调度和一个强制内置的结构回归均返回 `provider: browser-translator`、`cached: false`，各段只有一个 final、每个任务只有一个 job-done。

自然段落实测：`孩子们在窗边看书,而一只小狗则安静地睡着。明天我们将一起参观博物馆,了解科学和历史。`

链接 / 原子实测：

```xml
<g0>下载其语言包后,浏览器可以在这台计算机上翻译完整的英语句子。</g0>保持代码 <x0/> 不变,并访问 <g1><g2>官方网站</g2></g1> 了解有关该软件的更多信息。
```

嵌套父子关系、标签数量和 x 原子均通过验收；`g2` 仍实际包围“官方网站”。实际输入、全部端口消息与服务配置可在正式包报告核对。当前包及关键源码 SHA256 另保存为 `work/builtin-production-package-hashes.json`；脚本后续执行会在报告中直接记录 `sourceHashes`、`packageHashes`，可与最终部署版本对照。

完整项目合约、类型检查、构建及前端回归由最终集成流程统一执行，避免多个并行进程争用编译输出。
