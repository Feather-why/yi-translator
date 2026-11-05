# 隐私与数据流 / Privacy and data flows

更新于 2026-11-05，适用于 0.2.13 至 0.2.17。

译（Yi）没有项目运营方的分析统计或广告服务器。处理位置取决于你启用的翻译、对齐和同步服务，不能把“本地优先”理解为所有配置下都不联网。

## 翻译、图片和 PDF

- 使用本机 llama.cpp 或浏览器内置翻译时，正文由本机服务或浏览器处理；远程节点地址由你配置。
- 启用云端翻译时，待翻译的文字、语言方向和必要上下文发送给选中的服务。服务调度可能尝试其他已启用的服务。各服务适用自己的隐私政策。
- 图片识别在扩展的本地 OCR 运行环境执行。网络图片/PDF 会从原始地址下载；解析出的文字若交给云端翻译，就会发往对应服务。PDF 会话只在内存短时保存，关闭文档或过期后释放。
- 划词对齐默认可在本机执行；配置远程对齐服务后，对齐所需的原文和译文会发送给它。
- 首次使用 OCR、对齐模型或浏览器翻译语言包时，需要从相应提供方下载模型。下载站能看到请求 IP 等通常的网络信息。本地模型安装工具从固定的官方地址下载并验证 SHA-256。

## 本机保存

设置、服务密钥、翻译缓存、翻译记忆、规则、词典和服务统计保存在浏览器配置目录。密钥不是匿名数据，拥有该电脑或浏览器配置访问权的人可能读取它；请勿把浏览器配置目录或含密钥的导出文件公开。

敏感网站和隐身页受额外策略限制，包括禁止写入相关缓存、限制对齐到本地；这不能代替你选择合适的翻译服务。需要严格离线时，只启用本地服务并先完成模型下载。

## 可选联网功能

规则订阅从你选择的来源下载规则数据。同步默认关闭；开启后会向配置的同步存储传输选定的数据。同步密钥需要单独选择并加密；不要分享密码或密钥备份。手动检测服务可能发送一小段测试文字并消耗该服务额度，自动健康检查不会再用正文翻译代替检测。

## 本机助手

Windows 助手只为你允许的扩展 ID 注册，支持查询、启动/停止及开机启动配置等受限操作。助手安装和开机启动是分开的；安装工具不会自动开启开机启动。本地模型默认仅监听 `127.0.0.1:8081`，日志在安装目录的 `runtime/logs`。

## 删除与反馈

可在设置页清除缓存、记忆、密钥或同步配置。卸载扩展会删除它的浏览器本地存储，但不会自动删除同步存储中的副本、本机模型、助手或日志；这些需要分别清理。发送报错或截图前，请自行检查其中的网页文字、地址和服务信息。

## English summary

Yi has no project-operated analytics or advertising endpoint. Local translation, OCR and local alignment run on your device; enabled cloud translators or remote alignment endpoints receive the text needed for their task. Network images/PDFs and first-use model downloads contact their original hosts. Settings, credentials, caches and translation memories are stored in your browser profile. Optional synchronization and rule subscriptions contact the destinations you configure. Removing the extension does not remove cloud copies, separately installed local models, helper registration or logs. Use only local services for offline processing after downloading the required models.

## 许可范围

项目自有代码采用 [MIT](../LICENSE)。`public/licenses/` 保留第三方组件的原始许可证；模型权重、浏览器语言包、CUDA 运行库和其他下载内容按各提供方的条款使用，不因本项目采用 MIT 而改变。
