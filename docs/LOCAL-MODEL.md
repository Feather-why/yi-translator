# 本地翻译模型使用说明

2026-11-03 已在本机部署并完成真实插件调用验证。0.2.3 提速版默认 GPU 六路、CPU 两路，每路上下文仍为 2048；原始两路验收数据保留为历史记录。详见 [PERFORMANCE-LOCAL-MODEL.md](PERFORMANCE-LOCAL-MODEL.md)。

## 现在怎么用

默认地址是 `http://127.0.0.1:8081`；是否正在运行以本机启动输出及 `/health` 为准。

1. 在扩展设置的「翻译服务」中启用「本地 Hy-MT2（llama.cpp）」。
2. 地址填写 `http://127.0.0.1:8081`，API key 和模型别名留空，保存后点击测试。
3. 页面翻译先选择「高速」体验本地速度；「精确」和「综合」也可使用这个本地 1.8B 模型。

如果浏览器里加载的还是旧构建，请在扩展管理页重新加载 `.output\chrome-mv3`。更新构建后请重新加载扩展并刷新待翻译网页。

## 开启与关闭

- 双击 `.\gateway\scripts\start-local.cmd` 开启，等待显示「本地模型已就绪」。重复双击不会启动第二份模型。
- 双击 `.\gateway\scripts\stop-local.cmd` 关闭，释放模型占用的资源。
- 可安装本机助手后在设置页启用开机自启；以设置页显示的本机状态为准。未启用时重启电脑后手动开启。
- 闲置 10 分钟后服务会卸载模型，下次翻译自动重新加载，第一句可能比连续翻译慢。

也可以在 PowerShell 中运行：

```powershell
# 从项目根目录运行。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\gateway\scripts\run-local.ps1 -Background
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\gateway\scripts\stop-local.ps1
```

`run-local.ps1` 保留 `-ModelPath`、`-LlamaServer`、`-Port` 和 `-Cpu` 参数，新增 `-Parallel` 与 `-ContextPerSlot`；自定义参数前请先停止已运行服务。不带 `-Background` 时在当前窗口运行。

## 已安装内容

| 内容 | 位置 |
|---|---|
| 官方 Hy-MT2-1.8B Q4_K_M 模型 | `runtime/models/Hy-MT2-1.8B-Q4_K_M.gguf` |
| llama.cpp b12069 / CUDA 13.4 | `runtime/llama-b12069/` |
| 运行进程和日志位置记录 | `runtime/local-model.state.json` |
| 日志 | `runtime/logs/` |
| 下载来源、版本和 SHA256 | `runtime/manifest.json` |
| 合成短句真实测试结果 | `runtime/benchmark.json` |
| Windows GPU 进程显存计数 | `runtime/gpu-memory.json` |

`runtime/` 已加入 `.gitignore`，程序、权重、日志和本机状态均不进入代码仓库。首次部署没有安装全局 CUDA Toolkit 或改动显卡驱动。Windows 自启由后来增加的本机助手单独管理，不随扩展自动打开。

## 本机验证结果

- 显卡：NVIDIA GeForce RTX 5070 Ti Laptop，12 GB；驱动 621.01。
- Windows GPU Process Memory 的模型进程专用显存为 1,475,923,968 字节，约 1.37 GiB；另有约 88 MiB 共享显存，符合模型专用显存 2 GB 的预算。整张显卡的总占用还包括其他应用。
- 五条合成英文/混合语言短句，模型已启动后的适配器调用耗时约 66–136 ms；均通过占位符校验。
- 正式插件实际调用：普通片段约 91 ms，嵌套标签片段约 191 ms，服务测速约 54 ms。以上是小样本热启动结果，不代表任意长文的耗时或首屏 P50。
- 真正使用了 GPU 模型，未启用 pseudo、云端服务或测试回放；输入均为自拟测试句。
- 109 项后端测试、类型检查、正式构建通过；真实浏览器检查通过，包含提示词污染检查。
- 重复启动、停止、重新启动均验证通过，最终保持服务运行。

真实运行暴露并修复了 `llamacpp.ts` 的提示词边界问题：标签说明必须位于官方翻译模板之前，冒号之后只放待翻译原文；无标签原文不附加标签示例。适配器版本已升至 1.0.1，并增加两项回归测试。

## 连接不上时

先双击 `start-local.cmd`。浏览器打开 `http://127.0.0.1:8081/health`，正常应显示 `{"status":"ok"}`。若提示端口被其他程序占用，脚本不会替换该程序。

如果首次 CUDA 初始化长时间没有就绪，先用 `stop-local.cmd` 停止，再启动一次。本机首次初始化出现过等待，后续显卡探测约 1.4 秒、服务启动约 3 秒；未据此修改驱动或安全设置。若仍失败，查看 `runtime/logs/` 最新日志。

服务仅绑定 `127.0.0.1`，供这台电脑上的插件使用。

## 官方来源

- [腾讯官方 GGUF 模型](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF)
- [llama.cpp b12069 官方发布](https://github.com/ggml-org/llama.cpp/releases/tag/b12069)
- [该版本服务参数和闲置睡眠说明](https://github.com/ggml-org/llama.cpp/blob/b12069/tools/server/README.md)

模型文件大小 1,133,080,448 字节，SHA256：`dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699`。模型及 CUDA 程序包均已按官方哈希核验。


## 0.2.11：保留本机启动参数

默认模型在 60 秒健康等待内就绪后，自动把 CPU/GPU、端口、并行数和每路上下文保存到 runtime/local-model.settings.json。下次双击启动、设置页“立即启动”和已有开机启动项都会复用；stop-local.cmd 只停止进程，不清除这些参数。

手动传入参数只覆盖该字段。例如先用 start-local.cmd -Cpu 成功启动，停止后再用 start-local.cmd -Port 8082，仍使用 CPU。显式指定 -Cpu 而不传 -Parallel 时使用 CPU 两路默认。改端口后要同时更新扩展里的本地服务地址。旧启动快捷方式不需要重建。

启动失败不会覆盖原配置；坏配置会阻止助手启动并给出文件名，先停止模型，再用明确参数手动启动可修复。超过 60 秒仍在加载时会提示参数未保存，可就绪后停止再启动。自定义 -ModelPath / -LlamaServer 不写入助手自动启动配置，只用于手动运行。

默认程序路径、模型文件、SHA256、日志路径、/health、采样参数和闲置卸载设置不变。本轮没有重启日常模型或修改本机自启开关。

移动项目之前请先从旧路径运行 gateway/scripts/uninstall-helper.cmd，移动后重新加载扩展并从新路径安装助手。已移动后遇到 owner / 注册路径冲突时，不要删除身份检查或直接覆盖；先恢复原路径完成卸载。

上面的“本机验证结果”为历史硬件与性能记录，不代表其他电脑的速度。0.2.11 本轮验证的是启动参数保留和集成兼容，见 [审查报告](RELEASE-039-REVIEW.md)。


## 0.2.13 独立安装工具

朋友使用 Windows x64 时，可直接解压 `yi-local-setup-0.2.13-windows-x64.zip` 并运行 `setup.cmd`，不再要求项目源码或 Node.js。下载、校验、CPU/CUDA 选择、安装/卸载和恢复步骤见 [LOCAL-INSTALLER.md](LOCAL-INSTALLER.md)。旧启动参数、端口、日志路径和模型哈希保持不变。
