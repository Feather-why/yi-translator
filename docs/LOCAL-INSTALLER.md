# Windows 本地模型独立安装工具

适用于 Windows 10/11 x64、Chrome / Edge；不需要 Node.js，也不需要完整项目源码。扩展本身和本地模型是两个独立安装包。其他系统可使用浏览器内置/云端翻译，本工具不支持 Windows ARM、macOS 或 Linux。

1. 先解压并加载扩展 ZIP。在浏览器的扩展管理页打开开发者模式，复制 Yi 的 32 位扩展 ID。
2. 将 `yi-local-setup-0.2.13-windows-x64.zip` 解压到固定目录，例如 `D:\YiLocal`。不要在 ZIP 内直接运行，也不要解压到需要管理员权限的系统目录。建议预留 5 GB 磁盘空间。
3. 双击根目录 `setup.cmd`，粘贴扩展 ID。工具选择 CPU 或满足条件的 NVIDIA CUDA 13.4 模式，下载固定版本并校验 SHA-256，启动模型、检查 `/health`，最后为当前用户注册 Chrome / Edge 本机助手。
4. 在扩展新手指引中连接本地模型，默认 `http://127.0.0.1:8081`。首次初始化需要稍等。开机自启仍由你在设置页开启，安装不会擅自启用。

CPU 模式更通用但较慢。自动使用 CUDA 要求驱动报告支持 CUDA 13.4 且至少有 4 GB 显存；这不保证所有显卡都兼容。若启动失败，先运行 `gateway\scripts\stop-local.cmd`，再在此目录终端运行 `setup.cmd -Cpu`。已有端口被占用时可用 `setup.cmd -Port 8082`，同时把扩展服务地址改为该端口。模型已有其他来源部署时，请使用新的安装目录；工具不会覆盖没有安装标记的运行库。

下载中断后重新运行会续传 `.part` 文件。正式缓存或模型校验不符时工具停止，不执行未校验内容；移走报错指出的文件后再试。原始下载缓存位于 `runtime\downloads`，模型在 `runtime\models`，运行库在 `runtime\llama-b12069`，日志在 `runtime\logs`。默认只监听回环地址，不需要开放防火墙端口。

`setup.cmd -PrepareOnly` 只准备文件，不启动或注册助手。需要换浏览器或扩展加载路径导致 ID 改变时，可运行 `gateway\scripts\install-helper.cmd -ExtensionId 新ID`；多个 ID 可用 PowerShell 的 install-helper.ps1 参数。助手拒绝覆盖其他安装目录的注册，需要先在旧目录运行卸载助手。

卸载顺序：运行 `gateway\scripts\disable-autostart.cmd`、`stop-local.cmd`、`uninstall-helper.cmd`，再删除这个安装目录。不要删除仍被启动项或助手引用的目录。浏览器扩展可独立卸载。

固定来源：llama.cpp b12069 官方 GitHub Release；腾讯 Hy-MT2-1.8B-GGUF revision `a0c709d9fac510f2c807aa3af52872340dc37a4a`。完整 URL、大小与 SHA-256 在 `gateway/scripts/local-downloads.json`。Q4_K_M 模型为 1,133,080,448 字节，SHA-256 `dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699`。

项目脚本采用 MIT；下载的模型和运行库不因此重新许可。使用前可查阅模型说明和许可：https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF ，运行库：https://github.com/ggml-org/llama.cpp/releases/tag/b12069 ，CUDA：https://docs.nvidia.com/cuda/eula/ 。本工具不收集账户、密钥或遥测数据。

English: Extract both ZIPs into stable folders, load the extension, copy its 32-letter ID, then run setup.cmd from this companion folder. No Node.js required. Windows x64 only. Downloads are pinned and hash-checked. CPU is the fallback; use setup.cmd -Cpu explicitly if needed. Autostart remains opt-in. Logs: runtime/logs. Uninstall the helper and disable autostart before deleting the folder.

安装归属清单位于 `runtime\llama-b12069\.yi-setup-runtime.json`。切换运行方式前会核对目录所有文件，发现用户增改文件就停止。旧运行库完整保留为 `runtime\previous-<GUID>`，新目录搬入失败会恢复旧目录；确认新方式正常后可以手动删除不再需要的 previous-* 目录。同方式同内容重复运行不会再生成备份。旧版没有清单的手工目录不会覆盖。
