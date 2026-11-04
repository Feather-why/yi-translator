# 0.2.8：词典替换、对齐失效与 OCR 恢复

本次只修改后端、offscreen 入口和对应测试。没有修改前端、共享协议、生产模型或日常浏览器配置。

## 项 3：词典初始化和修订

首次自动加载内置词库可能晚于用户 CSV 导入完成。旧初始化随后再写库，会把已经成功导入的内容覆盖。本次将 bootstrap 与显式导入分开，写入按提交顺序串行执行；只要出现较新的显式导入，过期 bootstrap 就不再提交。旧初始化失败也不能清除新的 ready 状态。dispose 后的旧初始化不能发布结果。

每次成功替换递增 Dictionary 的内部 `revision`，相同条目数的词库也会产生新修订。对齐普通缓存、严格投影缓存和在途合并键同时包含 ready 与 revision；精修期间修订变化时拒绝旧结果，不写缓存。词典异步查询若跨过替换，也不能把旧条目写回 recent 缓存。没有为此重载 E5 模型；`noCache` 仍不读取或写入对齐缓存。

同时收口首次 IndexedDB 打开失败的恢复：失败 Promise 只清除自身缓存，`error` / `blocked` 后可以再次 ready 或导入。已被 blocked 拒绝的原 open 请求仍可能迟到成功，此时关闭其自身连接，不覆盖新连接。dispose 捕获自己的连接 Promise；旧连接失败不能阻止释放，也不能清掉期间新建的连接。恢复成功后清除旧初始化错误。

专项使用注入的内存词典、gzip 首次加载回放、假 IndexedDB 边界和空模型 links，不下载或运行神经网络：词典修订 8 项、数据库恢复 6 项与既有对齐性能 8 项，合计 **22/22** 通过；独立目录合约编译通过。覆盖迟到成功/失败、并发导入、同条数重导、dispose、迟到 lookup、普通/严格/noCache、精修中修订变化、禁用模型时备用链修订保护，以及打开失败/blocked迟到/dispose与新连接交错。

复现命令（项目目录运行，输出不覆盖共享 `tests/.compiled`）：

```powershell
node node_modules/typescript/lib/tsc.js -p tests/contract/tsconfig.json --outDir ../028-align-media-compiled
$env:BACKEND_BUILD_DIR='../028-align-media-compiled'
$env:ALIGNMENT_TEST_BUILD='../028-align-media-compiled/backend/align'
node --test tests/backend/dictionary-open.test.mjs tests/backend/dictionary-revision.test.mjs tests/backend/align-performance.test.mjs
```

前端若已经持有同一原文/译文的已完成对齐 Promise，后台无法主动替换该内存值。本修复保证新的后端请求遵守最新词典；当前已打开页面必要时刷新。自动推送词典修订并失效前端缓存属于后续前端协作。

## 项 8：OCR 超时重建和有界等待

原实现超时只关闭 MessagePort；如果 sandbox 的初始化或推理 Promise 永远不结束，后面的 predict/dispose 都排在它之后，用户重试也不能自愈。新增可注入的 `backend/media/ocr-runner.ts`，并由真正的 `entrypoints/offscreen/media.ts` 使用。超时后移除该次拥有的 iframe，结束旧上下文；新代重新创建、校验官方权重并初始化。迟到的旧代消息、初始化或推理结果不能发布到新代。没有修改 `ocr-sandbox`。

超时或容器通信失败最多自动重建一次；模型明确返回失败、坏图片等普通错误不重复执行，但清掉故障容器，后续明确请求仍可重建。只允许 1 个在途、3 个排队识别，超出立即返回可重试的等待提示。队列等待也计入每次 OCR 的总预算：270 秒；初始化上限 200 秒，单次推理上限 180 秒，两次尝试共用同一总预算，不是各等一份完整预算。此前业务层的 300 秒外层超时保持不变。该预算针对每次 `runOcr`，不等同整本多页 PDF 的任务预算。

这些上限意味着极慢、密集图片可能比此前 240 秒单次推理更早被中止；这样才能在业务超时前留出一次受控恢复空间。不声称提高模型吞吐。10 分钟真正空闲后移除容器，新的请求会撤销旧 idle 计时；初始化并行读取模型时一路失败也会停止同代剩余读取。模型哈希校验、公开权重缓存和识别结果的隐私策略保持原约束，没有新增文本/图片学习缓存。

OCR 新增 **12/12** 专项通过：9 项 runner 回归，加 3 项真正 offscreen 源码与假 iframe/MessageChannel 接线回放。覆盖推理和初始化超时、两次失败上限、旧回信、队列上限、总等待预算、模型明确错误、通信错误、idle 与 dispose；接线回放确认实际入口移除旧 iframe 后重新 init/predict。测试仅替换浏览器边界和公开模型字节校验，不加载真实 OCR/WASM，没有使用 GPU。offscreen 入口独立 strict `--noEmit` 检查通过。

```powershell
$env:BACKEND_BUILD_DIR='../028-align-media-compiled'
node --test tests/backend/ocr-runner.test.mjs tests/backend/ocr-offscreen-wiring.test.mjs
node node_modules/typescript/lib/tsc.js --noEmit --strict --skipLibCheck --noUncheckedIndexedAccess --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --types chrome src/entrypoints/offscreen/media.ts
```

## 项 10：混合扫描 PDF 的具体交接

本次不修改扫描判定，也不增加未经验证的 OCR 猜测。后端 `entrypoints/offscreen/media.ts` 目前仅在提取的 paragraphs 为空时执行 OCR；前端 `frontend/pdf/layout.ts` 的 `hasText` 也以 items 非空为准。只有原生页码/标题、正文为扫描图的混合页因此可能跳过正文识别。单独改后端判断不能让当前阅读器主动请求这一分支。

后续需前后端共同设计：用合成的“扫描正文 + 原生页码/标题”夹具验证正文覆盖判断，保留纯文本页、目录、图表页的行为；必要时提供明确的手动 OCR 入口。不要把所有文字少的页面都当扫描页。此问题已确认代码分支，尚未用用户私人 PDF 或真实 OCR 复测。

## 当前图片翻译速度的边界

当前图片界面先调用 `ocr:image` 的 `translate:false`，取得文字后走 `tx:translate`。`MediaService.ocr({translate:true})` 的逐块串行翻译不在这条界面路径上，不能把它当成当前图片慢的瓶颈。OCR 哈希缓存和相同识别的合并已经存在。本次优先解决超时后无法自愈；冷启动、检测、识别和 CPU 争用应分别测量，再判断后续速度优化，不承诺固定倍率。
