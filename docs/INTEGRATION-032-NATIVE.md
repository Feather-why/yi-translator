# 第 32.1 节：Windows 本机助手与登录自启

日期：2026-11-04。本模块只增加 `gateway/scripts` 的 Windows 辅助脚本和后端测试。扩展的 RPC、权限及最终浏览器验收由集成记录另列。没有修改模型文件、生产六槽参数、现有 `run-local.ps1`，也不会停止已经运行的模型。

## 安装和使用

1. 本项目已部署默认模型、`runtime/llama-b12069/llama-server.exe` 并构建扩展后，双击 `gateway/scripts/install-helper.cmd`。它只注册当前用户的 Chrome / Edge 助手，不自动开启自启，不需要管理员权限。
2. 在扩展设置里开启自启，或双击 `enable-autostart.cmd`。Windows **当前用户登录后**启动模型，未登录前不会运行。快捷方式目标是系统 PowerShell，以隐藏窗口执行本项目 `run-local.ps1 -Background`。
3. `disable-autostart.cmd` 只删除本项目的启动项；不会停止正在运行的模型。`uninstall-helper.cmd` 另外删除属于本项目的 Chrome / Edge 助手注册及三份生成文件，也不会停模型。

自动化安装用 `.ps1`，避免 `.cmd` 的交互暂停：

```powershell
# 从项目根目录运行。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\gateway\scripts\install-helper.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\gateway\scripts\enable-autostart.ps1
```

非默认加载目录或商店版可以显式指定一个或多个 ID：`-ExtensionId abc...`；多个 ID 使用逗号分隔，最多 16 个，逐个严格校验 32 个小写 a–p 字母。助手仅接受这些精确 origin，没有通配符。

默认读取 `<项目>/.output/chrome-mv3/manifest.json`：已有 `key` 时从其解码字节生成 ID；否则遵循 Chromium 的 Windows 路径算法（驱动器大写、UTF-16LE 路径、SHA-256 前 16 字节映射为 a–p）。**不写 manifest key、不改变现有扩展 ID**。本机 E 目录的算法结果已与上一版真实 Edge 的 `mplkfppahopobgepekidcnfejdjehaod` 核对，最终版本仍需用真实加载结果再核对。路径移动后重新安装；遇到另一项目的同名助手注册会拒绝覆盖，应先从原项目卸载。算法依据：[Chromium id_util.cc](https://github.com/chromium/chromium/blob/main/components/crx_file/id_util.cc)。

## 文件和持久状态

- 助手名称：`com.translate.local_model`。
- 当前用户注册项：`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.translate.local_model` 与 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.translate.local_model`。
- 生成文件只有 `<项目>/runtime/helper/` 下的 manifest、`native-host.cmd` 和 `owner.json`。安装保存旧内容，第二个浏览器注册失败时恢复之前的文件和已改注册项；不会留下声称安装成功的半状态。
- 启动项通过系统 API 获取当前用户 Startup，名称含项目路径哈希。启用/停用前比对目标、参数、工作目录和项目标记；同名但不是本项目的链接不会被覆盖或删除。状态中的 `enabled` 来自这个真实链接，未用配置布尔值冒充系统状态。
- 安装/卸载和启动项写入分别受当前会话的命名互斥锁保护；模型启动继续使用 `run-local.ps1` 已有的项目互斥锁与状态文件。
- 助手使用系统自带的 Windows PowerShell 5.1，不依赖 Node、Python、管理员服务或额外下载。PS 源码使用 UTF-8 BOM，所有 JSON 文件显式按 UTF-8 读取。

Windows native messaging 允许清单指向批处理启动器，Chrome 官方示例也采用此方式：[官方示例清单](https://github.com/GoogleChrome/chrome-extensions-samples/blob/main/api-samples/nativeMessaging/host/com.google.chrome.example.echo-win.json)。注册位置及精确 origin 规则见 [Chrome 官方文档](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) 和 [Edge 官方文档](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/native-messaging)。

## Native 消息约定

请求严格白名单，任何额外字段、未知命令、非布尔 `enable` 都返回固定 `bad_input`。不能从消息传入路径、命令、模型、参数或端口。

```json
{"action":"status"}
{"action":"start"}
{"action":"autostart","enable":true}
```

状态和自启成功：`{ "ok": true, "data": { "supported": true, "enabled": false, "canStart": true } }`。缺少默认模型文件时 `canStart:false`，附部署提示，启用自启会失败。

启动成功：`{ "ok": true, "data": { "ok": true, "message": "..." } }`。默认 8081 的状态文件必须同时匹配 PID、可执行文件完整路径、精确 UTC 启动时间，才视为已经运行；重复启动直接成功，不新开一份。其他端口或未登记的服务不会被替换。成功表示模型进程已启动，首次加载仍可能未完成。

失败：`{ "ok": false, "error": { "code": "bad_input|unavailable", "message": "固定中文说明" } }`。不透传异常里的本机路径、参数或环境值。

输入输出使用标准流的二进制字节、32 位小端长度和 UTF-8 JSON。单请求上限 4096 字节，输出上限 64 KiB。支持单次 `sendNativeMessage` 及连续 `connectNative` 消息；串行执行。origin 不匹配、截断和非法长度会关闭连接；stdout 只写协议帧，诊断写 stderr。启动脚本自身输出重定向到项目 `runtime/logs/helper-start-*.log`。

`start` 的客户端预算建议 90 秒：既有启动锁最多等 15 秒，冷启动健康检查最多等 60 秒。`status` / `autostart` 包含真实快捷方式 COM 读取，也需要留出合理时间。超长 Windows 项目路径可能让系统快捷方式解析明显变慢，建议保持项目在正常长度的本地路径。

助手只等待启动器那个进程退出，**不使用会等待整棵子进程树的 `Start-Process -Wait`**。PS5 先取得进程句柄，再调用 `Process.WaitForExit()` 和读取退出状态；这样模型可以持续运行。取消/关闭扩展连接不能被当成停止模型命令。

## 分项验收与隔离

测试命令：`node --test tests/backend/native-helper.test.mjs`。测试使用短临时目录中的独立 Startup；真实快捷方式由 WScript.Shell 创建，注册表由内存函数代替。隔离的 C# 模拟进程只休眠，不监听端口，不加载 GPU，清理时核对本次状态里的可执行路径及启动时间。

独立 Windows PowerShell 5.1 验收 **12/12 通过**（约 56 秒），覆盖二进制 UTF-8 帧/多消息、origin 拒绝、命令和额外字段、截断/长度/坏 JSON、真实链接启停幂等、非本项目链接保护、双浏览器注册和部分失败回滚、原注册冲突保护、UTF-8 清单和 ID 算法、模型缺失、重复启动与 host 退出后模拟进程存活。冷启动测试确认第二次 start 沿用同一 PID / 启动时间，启动次数文件只有一行。原始日志在本次工作区的 `work/integration-032/native-helper-final.log`。

`tests/backend/native-helper-fixture.mjs` 还提供 `createNativeFixture({fakeModel:true,id,nativeName:'com.translate.local_model.test_032'})`，供真实浏览器冷启动验收使用。使用独立名称不会覆盖正式助手注册；测试前仍应核对该名称原先未占用。

真实 Edge 验收命令：`node tests/backend/native-browser-032.mjs`。该测试使用正式 `.output/chrome-mv3` 包、单独临时浏览器配置和 `com.translate.local_model.test_032_<测试进程号>`；只注册这个唯一名称到当前用户 Chrome / Edge 的 HKCU。模拟模型没有网络端口和 GPU 占用，启动链接仍写入隔离目录。无论测试成功或失败，都尝试卸载该测试助手并清理对应模拟进程和临时浏览器目录。

2026-11-04 使用正式 **0.2.9** 包通过 **6/6**：真实 `connectNative` 状态查询；冷启动返回并断开连接后 native host 已退出、模型仍运行；第二次 start 保持同一 PID 和启动时间、启动记录仅一行；真实启用／停用接口与唯一快捷方式一致；native 消息只含 `action` / `enable`；整个测试浏览器退出后模型仍存活。报告记录包的 SHA-256、PID、启动时间和清理结果，路径为项目内 `work/native-browser032/report.json`。测试助手注册、模拟模型和临时目录均已清理，未修改正式助手注册、日常模型或真实 Startup。

测试构建路径的实际扩展 ID 为 `bfmhhkikgapngplmkgkjaboimobgnjfe`，仅用于此次临时浏览器；E 项目的 ID 应用最终 E 路径加载结果核对，不能使用此测试 ID 代替。正式 E 助手安装、真实模型冷启动和实际登录自启开关由总集成验收另记。
