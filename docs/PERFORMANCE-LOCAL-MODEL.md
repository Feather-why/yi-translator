# 本机 2 / 6 / 8 路并行实测

2026-11-03，Windows、RTX 5070 Ti、官方 llama.cpp b12069/e6192de0a、Hy-MT2-1.8B-Q4_K_M。选用 GPU 默认六路，CPU 默认仍两路。

## 测法与结果

`tests/backend/local-parallel-real.mjs` 在独立 8082 逐一启动测试服务，只终止自身创建的进程。原 8081 留驻但无请求；每路上下文固定 2048，总上下文分别 4096 / 12288 / 16384，避免增加槽数却缩短单段上下文。量化 KV、GPU 层数、官方采样、batch、cache 和休眠参数一致。各档先做一次不计时预热，再分别翻译二十个短段、二十个长段，各三轮。

直接调用真实适配器 1.0.4，无浏览器、逻辑队列或标签恢复。每段一个实际 HTTP 请求；每轮二十次。模型驻留、服务缓存未清，属于热模型吞吐实验。

| 并行 | 二十短段全部完成中位 | 短段首条中位 | 二十长段全部完成中位 | 长段首条中位 | 独立内存重测专用显存峰值 |
|---|---:|---:|---:|---:|---:|
| 2 | 1882 ms | 149 ms | 5477 ms | 485 ms | 1407.551 MiB |
| 6 | 1031 ms | 223 ms | 3600 ms | 882 ms | 1691.559 MiB |
| 8 | 1075 ms | 269 ms | 5043 ms | 1013 ms | 1833.559 MiB |

六路相对两路整批耗时减少约 45% / 34%；首条变慢，不能宣称任何交互都提升相同倍数。八路长段明显更慢，所以最终选择六路。浏览器同段两档去重后的综合收益另见 `PERFORMANCE-VALIDATION.md`，不把两种实验混算。

首组三轮的显存采集子进程缺少 Windows Diagnostics 模块，结果里的显存是 null，不能作为预算依据。修正为当前实际 PowerShell 7 后另做每档一轮，逐秒采集 Windows GPU Process Memory 中测试进程 PID 的 Dedicated/Shared Usage；该次三档均成功、专用峰值都小于 2048 MiB。内存重测数据独立保留，不冒充三轮同时采集，也不是整卡占用。六路实测约 1.65 GiB；不同上下文或其他模型需重测。

## 实际设置与回退

启动脚本 `gateway/scripts/run-local.ps1` 新增 `-Parallel 1..8`（0 表示 GPU 6 / CPU 2 默认）和 `-ContextPerSlot 512..8192`（默认 2048）。总上下文始终为二者乘积，状态文件同时保存三项；已有进程不会因重复启动被替换。GPU、CPU、localhost 监听、身份校验、日志、600 秒闲置卸载和停止方式继续有效。

```powershell
# 从项目根目录运行。
# 先停止本项目记录并核实身份的进程，再按默认六路启动。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\gateway\scripts\stop-local.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\gateway\scripts\run-local.ps1 -Background

# 需要两路时：先停止，再使用以下参数。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\gateway\scripts\run-local.ps1 -Background -Parallel 2
```

适配器最终 1.0.5 默认并发也为六，用户显式 `options.concurrency` 优先；自定义服务器若只有两路，应在设置里显式填 2。脚本不探测并擅自变更其他服务器。

## 证据与复测

- 三轮吞吐：工作区 `outputs/test-evidence/local-parallel/local-parallel-result.json`。
- 独立显存重测：`outputs/test-evidence/local-parallel-memory/local-parallel-result.json`。
- 每档包含实际参数、请求耗时、模型时间、PID 及独立服务器日志；不记录完整源文、译文或 API 密钥。
- 支持 `LLAMA_EXE`、`MODEL_PATH`、`BENCH_PORT`、`BENCH_ROUNDS`、`REPORT_DIR`、`PERF_SHELL`。Windows 使用可加载 Diagnostics 的 PowerShell 7 路径；端口被占用时直接停止实验。

参数依据：[固定版本服务文档](https://github.com/ggml-org/llama.cpp/blob/b12069/tools/server/README.md)。本机程序 `--version` / `--help` 及日志同时核实；未修改显卡驱动、功耗或系统安全设置。

## 启停兼容性验收

实际应用六路时发现 PowerShell 7 的 ConvertFrom-Json 会把 ISO 时间转换为 DateTime，旧脚本再转字符串会丢失微秒精度，导致身份核对失败。仅兼容两种时间类型，仍精确比较创建时间和程序路径。已在实际 8081 验证重复启动 PID 不变、停止成功、再次启动六路；props 确认每路 2048、slots 数为 6。原两路进程在完整路径和精确创建时间双重核对后关闭，未停止其他服务。
