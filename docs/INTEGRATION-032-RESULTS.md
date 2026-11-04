# 0.2.9 / 第32节后端集成验收

日期：2026-11-04。实际项目：项目根目录。正式扩展版本0.2.9，后端标识0.2.9-integration，协议号仍为2。本轮六项均已实现并逐项回归；详细设计与用法分别见 INTEGRATION-032-NATIVE.md、INTEGRATION-032-PROVIDERS.md、INTEGRATION-032-LANG-MEDIA.md。

## 当前可用结果

- 已为当前账户安装本机助手，注册到Chrome和Edge的HKCU；已开启**当前用户登录后自启**，实际快捷方式指向E项目run-local.ps1 -Background。默认本地模型8081已运行，状态supported/enabled/canStart均为true。保持Q4模型、6路、每槽2048，未改权重和原有休眠参数。
- 原扩展ID仍为mplkfppahopobgepekidcnfejdjehaod，没有添加manifest key。新版manifest新增nativeMessaging；日常Edge需要手动重载扩展，才能加载新代码与权限。
- 设置页新模板可用：LibreTranslate及自定义HTTP；输入框任务按行/语言原样处理；词典导入成功广播align-reset；不支持的已知语言对跳过并保留可理解错误。
- 混合扫描PDF的后端现在能识别页眉页码之外的正文，并去除重复OCR。没有修改阅读器、界面、选区算法和其他前端正式代码。

## 测试结果

| 层次 | 结果 | 验证内容 |
|---|---|---|
| 实际E项目完整后端合约 | 668/668，0失败、0跳过 | 严格编译后运行全部contract/providers/backend测试，包含native Windows夹具 |
| 实际E项目typecheck、production build | 通过 | WXT prepare + TypeScript noEmit，常规production构建 |
| 前端原始假后端回归 | 25/25 | 原tests/e2e/run.mjs不改；独立构建仅在内存中接回原mock，原源码和正式包hash不变 |
| 新HTTP模板专项 | 26/26 | 适配器16 + Core/Vault/缓存/真实导入10；既有高级设置9项也通过 |
| 新语言/输入/媒体初步专项 | 69/69 | 新增语言参数、4类输入隐私、7个初始PDF与原有回归；随后新增Core候选3项和噪点2项均通过 |
| 本机控制RPC专项 | 8/8 | 并发去重、顺序、超时、权限、无助手提示、字典广播 |
| 系统助手独立专项 | 12/12 | 真实PS5二进制帧、实际隔离快捷方式、注册回滚、cold start生命周期 |
| 真实Edge助手隔离验收 | 6/6 | 固定动作、冷启动、断开后存活、幂等、开关、浏览器退出后存活；唯一测试注册/进程已清理 |
| 实际E正式助手RPC | 3组通过 | 自启关闭→开启→查询、两次启动同PID、浏览器关闭后health200；最终保持开启 |
| 正式包真实本地模型 | 6组通过 | SSE、缓存无HTTP、非流式、fast、sv→en、取消；最后结果timing完整 |
| 正式包真实媒体 | 7组通过 | CPU OCR、原生PDF、纯扫描PDF、混合PDF，以及字幕/图片/PDF三项翻译RPC |

所有真实浏览器验收使用独立资料夹，未操作日常浏览器。翻译/OCR验收使用临时8083模型，结束后已关闭；当前仅保留用户使用的8081模型。OCR回放的是已校验SHA256的原始官方模型字节，实际识别执行PaddleOCR CPU/WASM，没有把OCR结果替换成固定答案。

## 实际样本和计时

瑞典语 Biblioteket öppnar på måndag. 指定sv→en，实际返回 The library opens on Monday.，一次HTTP，providerMs约108ms。该值只描述这一条本地热请求，不是跨语言质量或整体速度基准。

流式样本每段约80ms累计预览，最早预览比最终结果提前约388ms；占位符、取消、最终计时检查通过。普通非流式样本中仍观察到把Tomorrow误译成“下周”的小模型语义偏差，因此本轮测试通过不等于所有译文人工质量通过。

真实混合夹具mixed.pdf：保留2段原生页眉/页码，识别9段扫描文字，关键词与原文顺序正确，原生段落各出现一次，坐标与40%去重检查通过。该次OCR约2581ms；首张图片OCR约2147ms、后续简单扫描PDF约369ms，均是单次验收值，没有作为提速对照。

## 验收中发现并修复的问题

1. 自定义HTTP在secrets:import导入新headers/body后，旧等待任务可能使用新配置、却按旧版本写缓存。现在验证新配置并仅在实际改变时换代，旧排队请求被发送前检查挡住；body/headers两种实际加密导入路径均有回归。
2. 混合PDF原先仅页眉/页码即停止OCR；补扫描判断后，真实2倍栅格又发现扫描噪点令空白行参与中位数，文字页交替值降到4。现在排除深色像素少于max(8,ceil(width×1%))的噪点行，保留28次阈值，带噪文字与纯噪点都有回归。
3. Windows PS5启动等待改为只等待启动脚本进程，不等待常驻模型整棵进程树；提前缓存进程句柄保证ExitCode读取可靠，日志不污染native消息帧。

完整回归第一次为657/659：旧网关版本断言尚未更新，另一测试未经等待就假定两个并发缓存摘要先后固定。现在版本断言与网关0.2.2一致；发送gate测试明确等待首任务进入签名，仍检查真实HTTP间隔。最后实际E项目668项全部通过。

旧run-e2e包装器采用真Core+pseudo，与新版前端测试依赖的mock.lastJob、模拟流式/对齐和本机卡片不匹配，曾出现6项失败。新增run-frontend-mock-032.mjs仅在独立测试构建中切回原mock，排除WXT虚拟入口后原25项全部通过；没有为迎合测试改前端或正式后端。

## 前端边界和后续

- 用户批准的mock兼容仅两处；将这两处逆向还原后的SHA256与开工快照完全一致。其余72个受保护文件保持不变。原HANDOFF第26、31、32节保留，六项实现登记在第33节。
- 前端imageBodyPage仍以“该行有任意深色像素”计入统计，在部分缩放下也可能受同一噪点问题影响。后端收到pdf:translate后已能处理；阅读器是否自动触发仍需前端同步修正，已交接第14.1节。本轮不宣称已修改前端判定或版式。
- 没有新增可选skipBoxes；没有实现可选“遇到离线模型就自动拉起”策略。启动入口和登录自启已可用。
- 未重启Windows验证整个登录流程；实际Startup文件、参数、权限和模型生命周期已检查。没有部署LibreTranslate服务或使用真实收费账号；相关接口按官方合约测试，用户自定义端点仍需自行配置。

## 复现与回退

在E项目可运行npm run typecheck、npm run test:backend、npm run build。真实媒体：先准备独立模型地址并设置LLAMA_URL、EXT_DIR、BROWSER_EXECUTABLE，再运行tests/backend/media-browser.mjs；脚本拒绝使用日常8081。助手隔离验收运行tests/backend/native-browser-032.mjs，使用唯一临时native名称并自动清理。

停止登录自启：双击gateway\scripts\disable-autostart.cmd；卸载助手：uninstall-helper.cmd。两者均不停止当前模型。如需停模型使用已有stop-local.cmd。项目移动或扩展加载路径改变后重新安装助手；默认ID算法保留现有路径对应ID。

正式ZIP的SHA256、逐文件摘要和发布范围另附package-checksums.json、release-audit.json。ZIP是浏览器扩展；本机助手脚本保留在E项目gateway/scripts，当前机器已经安装。
