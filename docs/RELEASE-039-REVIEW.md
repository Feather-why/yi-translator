# 前端完成后的集成审查与 0.2.11 更新

> 历史记录更新：本页发现已由前端第 41 节修复，第 42 节在本机 PDF.js 6.5.438 重新验收，页面 29/29、媒体 12/12 通过。当前同版本新版 ZIP 的校验值见 [repack-041-checksums.json](repack-041-checksums.json)。以下保留原始审查证据。


日期：2026-11-04。依据 本机项目 AGENTS.md、最新 HANDOFF 第 39 节及实际源文件。扩展 0.2.11，后台版本标识 0.2.11-release；共享协议不变。没有修改前端源码、共享文件、前端测试或用户模型运行状态。

## 已修复

1. **正式 ZIP 可能漏运行文件。** 原 npm run zip 直接调用 WXT 内部构建，不触发 npm prebuild，而 public/assets 不进入源码仓库。新增 prezip 准备 PDF / OCR / ONNX 文件；postbuild、postzip 和 check:extension 验证实际入口、双语消息与关键运行文件。新增 8 项正反向回归，覆盖缺 worker、缺 / 错误 WASM、缺 chunk、远程 / 越界入口及测试构建。
2. **测试入口已经与新前端错配。** 原 test:e2e 以 pseudo 后端套用依赖 mock.lastJob、模拟密钥和模拟自启的前端测试。现在 test:ui 单独构建假后端并运行前端两套测试；test:e2e 构建正式包，用真实内容脚本、后台、RPC、IndexedDB 和本机 HTTP 回放验证整条链路。两个入口支持 BROWSER_EXECUTABLE 和独立临时资料夹，普通 PowerShell 无需 Bash 环境变量写法。
3. **本地助手忘记 CPU / 端口。** 新增 runtime/local-model.settings.json，只保存 cpu、port、parallel、contextPerSlot 四项有界数据。正常启动在 /health 就绪后原子保存；停止模型不删除。后续双击、立即启动和已有自启快捷方式复用这些设置。手动只改一个参数时保留其他参数；显式切换 CPU/GPU 且不指定并行时用 2/6 路默认。坏配置明确报错，失败启动保留原配置。旧快捷方式字符串、归属检查、默认模型 / 程序路径保持。
4. **安装和说明。** README 区分源码构建与已构建 ZIP（后者不需要 Node），提供跨平台测试命令；本地部署文档去掉“未设置自启”等过时状态说明。版本更新及历史专项测试门禁同步到 0.2.11。

## 仍需 Claude 处理

本轮遵守此前“只改后端，前端问题写交接”的范围。以下问题已写入 HANDOFF 第 14 / 40 节。

| 优先级 | 位置 | 复现与修复方向 |
|---|---|---|
| 高 | src/frontend/pdf/layout.ts:127、160–162 | 当前 PDF.js 6.5.438 的字体对象没有 name，但有 italic/bold；前端只检查名字，使数学变量 N/x 变成普通字母。正式包和界面测试包都复现。应读取真实样式属性并兼容旧字段，单独核对数学字体名。详见 [PDF 专项报告](PDF-FONT-REGRESSION-039.md)。 |
| 中 | src/frontend/options/welcome.ts:151–184、315–317 | 选择方案页丢弃 builtin 的真实测试结果，仍按 enabled 显示“可以用”；第 39 节修好的是完成页。应分别表示 API 存在、已启用和语言包已就绪。 |
| 中 | src/frontend/options/welcome.ts:638–657 | 新建 OpenAI 兼容服务首次保存成功后，current 仍为添加时的 configured:false，而输入框已清空。同页修改模型再保存被“先粘贴 API Key”拦住。保存后刷新服务信息；后端已能保留未重新填写的密钥。 |
| 文案 | src/frontend/options/welcome.ts:445、479 | “移动项目后重新安装助手”不充分；助手会正确拒绝旧路径注册和不同 owner。应说明移动前从原位置卸载助手，再移动、重新加载扩展并重装；不能靠放宽归属检查解决。 |
| 文案 | src/frontend/options/welcome.ts:132 | quota 错误一律提示等下周期，与 DeepL API Developer 总额度不自动重置不符。建议提示查看账户额度或更换服务，明确存在账期时才提示等待。 |

方案页和重复保存问题通过执行当前实际前端函数的本地桩稳定复现；没有调用真实云端或写入真实密钥。[复现结果](review-039/frontend-findings.json)。

## 验收结果

| 检查 | 结果与边界 |
|---|---|
| 完整类型检查 | 通过，实际 E 项目 |
| 后端 / 适配器 / 合约 | **770/770 通过**，含新增发布检查和本机参数测试 |
| 页面界面回归 | **29/29 通过**，真实独立 Edge + 假后端 |
| 图片 / PDF 界面回归 | **11/12 通过**；失败为论文变量 N 的格式断言，此大用例中其后的断言未执行，不能宣称全部论文排版通过 |
| 前后端集成 | **6 组通过**；真实后台 + 本机 HTTP 回放，9 次翻译回放请求 / 1 次健康检查。覆盖 partial/final 真实网页渲染、queueMs/providerMs、嵌套占位符、缓存、noCache、加密密钥、浏览器重启和链接还原 |
| 本机助手 | 隔离实际 Windows 进程验证 CPU、自定义端口、3 路 / 1024、停止再由 Native host 启动；另覆盖配置损坏、失败启动和逐字段覆盖 |
| 正式构建 / ZIP | 通过，285 个文件逐个 SHA-256 与正式目录一致；manifest.json 在 ZIP 根目录 |
| 分工保护 | 151 个既有源码 / 前端测试 / wxt 配置文件摘要保持；源码仅后台版本标识有变化 |

本轮没有重新评测真实 Hy-MT 翻译质量、联网云服务或真实 OCR 下载；HTTP 回放不是实际模型。Mac 没有真机验收。PDF 字体问题在真实正式包中已独立确认，不是回放误差。rolldown 构建成功，仅有 inlineDynamicImports 弃用提示。

## 本机启动兼容边界

- 默认仍是 127.0.0.1:8081、GPU 6 路 / CPU 2 路、每路上下文 2048，日志仍为 runtime/logs/llama-*.stderr.log；模型文件、SHA256、llama.cpp 版本及采样参数未变。
- 已有 runtime/local-model.state.json 是进程记录，不自动当成新启动配置迁移；本轮未重启日常模型、修改注册表或自启开关。
- 参数只在默认模型及默认程序路径、60 秒健康等待内就绪后保存。超过 60 秒仍在加载会明确提示尚未保存；可以在加载完成后停止并再次启动。自定义 -ModelPath / -LlamaServer 不写入助手配置，仍需手动运行。
- 改端口后，扩展中的本地服务地址仍需用户同步修改；本轮不新增协议或暗改浏览器设置。
- 配置损坏时，助手不会悄悄回到 GPU / 8081；先停止模型，再用明确参数手动启动修复。
- 扩展 ZIP 不包含本机助手、GGUF 和 llama-server。朋友只用浏览器内置 / 云服务可单独安装 ZIP；使用本地模型需源码中的 gateway/scripts 与各自 runtime 部署，不能复制本机注册状态。

## 正式产物

- 目录：.output/chrome-mv3
- ZIP：.output/translate-ext-0.2.11-chrome.zip
- 大小：50486299 字节
- SHA-256：`f177d9816c376cb6eb249d750641917d08e42b806035cfd4b24e2320f040c49a`
- [归档核验](review-039/package-checksums.json)

这是含上述已知前端问题的新版构建，不代表全部功能已无缺陷或商店审核已通过。没有上传 GitHub 或商店；项目许可证在 README 中仍为待定。

原始日志位于本轮 本机验收工作区 work/release039：typecheck.log、ui-build.log、ui-test.log、backend-tests.log、backend-browser-retest.log、zip.log、zip-check.json。专项数据随本报告保存在 review-039/。
