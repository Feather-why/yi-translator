# Phonetics 日常页面错位回归

2026-11-03，正式包 `0.2.2`，后台 `0.2.2-alignment`。本文件记录独立浏览器验收；不修改前端、用户日常浏览器或原有前端测试。

## 用户复现与边界

用户在 [Wikipedia Phonetics](https://en.wikipedia.org/wiki/Phonetics) 的首段选中 `concerns`，旧版对应到译文逗号。测试夹具 `tests/backend/fixtures/phonetics-daily.json` 来自同一天日常 Edge 的真实 DOM：保留整段六句、加粗、九个链接和引文，只去掉旧扩展追加的译文节点。夹具包含来源和 CC BY-SA 4.0 归属；不是为通过测试而缩写的短句。

本回归在本机页面重放该完整来源 DOM，通过正式整页翻译取得真实本地模型译文，再使用真实 DOM Selection 和 `CSS.highlights.get('tx-link')` 读取高亮范围。源段落和真实译文均保存在报告中，所有链接和还原后的 HTML 也作严格比较。

## 发现的首次请求问题

第一轮真实浏览器复测中，模型能力状态已经 `ready:true`，但该段的语义对齐仍未算完。旧逻辑仅给这种请求 280ms，返回不含 `concerns` 的快速结果；现有前端会缓存首次 Promise，随后即使模型算完，也一直只有整段浅底色。仅禁止“词对应标点”不能彻底解决这个症状。

最终后端把任何未缓存段落的前台请求等待预算统一为 5000ms；缓存命中仍立即返回。字词不再用位置补边，标点不能代替词义。具体算法及后台专项测试由对齐文档记录。

回归脚本已严格要求首次 `concerns` 产生非空、精确的“研究”强范围；没有强范围不能算通过。早期允许空范围的探索报告只用于定位问题，不作为最终验收结果。

## 最终八项真实验收

`tests/backend/phonetics-browser.mjs` 的最终 stage 正式构建结果：**8/8 通过**。

| 项目 | 强高亮结果 | 本次选区等待 |
|---|---|---:|
| 首次未缓存段落的 concerns | 仅“研究” | 351ms |
| 热 concerns 正向 | 仅“研究” | 10ms |
| 热“研究”反向 | 仅 concerns | 6ms |
| 第一整句正向 | 所有范围均在目标第一句，包含“研究” | 5ms |
| 第一整句反向 | 所有范围均在来源第一句，包含 concerns | 5ms |
| acoustic 正向 | 仅“声学” | 4ms |
| auditory 正向 | 仅“听觉” | 3ms |
| “声学”反向 | 仅 acoustic | 4ms |

另外，九个原始链接全部保留；原段 HTML 精确还原；无页面脚本异常。捕获两次真实本机 `/v1/chat/completions` 成功响应；正式生产 RPC 的对齐结果和固定修订权重哈希一并记录。首次选词前 `ready:true`，翻译前一次观察为 `ready:false`，覆盖了上述“模型已就绪、该段尚未缓存”的实际失败路径。

真实 E5 权重来自生产固定修订 `761b726dd34fb83930e26aab4e9ac3899aa1fa78`；回放权重数据以节约重复下载，推理由扩展自身 CPU WASM 执行。测试未调用 `align:init` 预先热推理，也未伪造向量、RPC、模型译文或高亮 DOM。其他提供方全部关闭，仅使用已部署的本机 llama.cpp 服务。

## 复跑及报告

```powershell
npm run build
$env:BROWSER_EXECUTABLE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:LLAMA_URL = 'http://127.0.0.1:8081'
node tests/backend/phonetics-browser.mjs
```

`EXT_DIR` 可指向实际部署包，`REPORT_DIR` 设置报告目录，`ALIGN_MODEL_CACHE` 指向上述固定修订四个权重/JSON 文件所在目录。默认报告为 `work/phonetics-browser/phonetics-browser-result.json`。浏览器使用独立临时配置，关闭后清理；系统减少动态效果仅用于避免显字动画干扰截图。

本次 stage 最终报告保存在工作区交付目录 `outputs/test-evidence/phonetics-stage-final/`。包括 `cold-concerns.png`、`concerns-highlight.png`、`research-highlight.png`、`first-sentence-forward.png`、`acoustic-highlight.png` 和完整 JSON。已人工复查首次 concerns、声学截图。

## 不应扩大解释的地方

这些耗时是本机单次样本，权重已经缓存，不代表首次网络下载、全冷启动、P50 或所有语言性能。`modelReadyAfterPageStartMs` 只是监测开始后的就绪观察时间，不是完整模型初始化时长。

整段浅黄色底纹由现有前端固定绘制，仍然保留；本次保证的是 `tx-link` 强高亮的这些真实句/词范围。首句允许本句标点作为独立高亮范围，不要求任意功能词都有词对词映射。翻译中 phone、phoneme 等专业术语仍受本地模型质量影响；本回归证明此实际错位及所列词组已修复，不保证所有词或所有语种都精确。
