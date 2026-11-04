# 译 · 本地优先的网页翻译 / Yi · Local-first Web Translator

用于 Chrome / Edge 的开源翻译扩展。支持网页双语对照、划词与输入框翻译、图片文字识别、PDF 双栏阅读和 YouTube 双语字幕。可以使用浏览器内置翻译、自己的本地模型，或自行配置的云端翻译服务。

**下载：打开本仓库的 Releases 页面，选择所需版本的安装附件。** 普通用户不需要 Node.js。GitHub 自动生成的 `Source code` 压缩包是源码，需要构建后才能加载。

*English: Yi is an open-source, local-first translator for Chrome / Edge. Download the extension ZIP from this repository's Releases page; no Node.js is required for installation. An optional Windows x64 companion downloads and sets up the local translation model. The interface supports Chinese and English. Local-first does not mean every configured service runs offline.*

## 下载安装

| 文件 | 用途 |
|---|---|
| `translate-ext-0.2.13-chrome.zip` | 浏览器扩展，Chrome / Edge 使用同一份包 |
| `yi-local-setup-0.2.13-windows-x64.zip` | 可选的 Windows x64 本地模型安装工具；首次运行下载模型和运行库 |
| 对应的 `.sha256` 文件 | 校验下载文件是否完整 |
| `Source code (zip / tar.gz)` | 开发者使用的源码，不能直接作为扩展加载 |

1. 下载扩展 ZIP，解压到一个固定文件夹。不要在 ZIP 内直接加载。
2. 在浏览器打开 `edge://extensions` 或 `chrome://extensions`，开启**开发者模式**。
3. 点击**加载解压缩的扩展**，选择解压后直接包含 `manifest.json` 的文件夹。
4. 在自动打开的**新手指引**中选择翻译方案，完成语言包、服务密钥或本地模型设置，再尝试翻译。

GitHub 发布版采用手动加载方式。更新时将新版解压到原来的固定目录，在扩展管理页重新加载并刷新网页；不要只下载 ZIP 而不更新已加载的目录。

### 选择翻译方案

| 方案 | 准备事项 | 说明 |
|---|---|---|
| 浏览器内置翻译 | 浏览器支持对应 API 和语言对；首次可能下载语言包 | 无需服务密钥，可先在设置页检测可用性 |
| 本地 Hy-MT2-1.8B | 模型和推理运行库；CPU 可运行，有兼容显卡通常更快 | 不需要云端翻译额度；速度受硬件、上下文和并发影响 |
| 云端翻译服务 | 自己的账户、密钥或服务地址 | 各提供方的额度、收费、支持语言和隐私条款分别适用 |

启用多家服务后，遇到错误或额度不足会尝试其他符合当前任务条件的服务。只有配置了可用的后备服务，才能继续完成翻译；不会替你获取密钥或保证所有服务始终可用。非官方服务默认关闭，需要自行启用。

### 可选：Windows 本地模型

先加载扩展，再将本地模型安装工具解压到另一个固定目录，运行 `setup.cmd`，按提示粘贴扩展管理页中的扩展 ID。工具下载固定版本并校验 SHA-256，选择 CPU 或满足条件的 NVIDIA CUDA 模式，检查模型启动状态，最后注册浏览器助手。**安装工具不内含完整模型，也不会自动开启开机自启。** 建议预留 5 GB 磁盘空间。

该安装工具仅适用于 Windows x64。其他平台可以使用可用的浏览器内置或云端服务；自行部署兼容模型服务的说明见 [本地模型文档](docs/LOCAL-MODEL.md)。详细的安装、CPU 模式、端口、卸载和恢复步骤见 [独立安装工具说明](docs/LOCAL-INSTALLER.md)。

## 日常使用

- **整页翻译**：点击悬浮球或按 `Alt+A`，显示或还原双语页面；支持逐段、逐句和仅译文模式。
- **划词翻译**：选中文字后点击小圆点，或按 `Alt+S`；单个英文词可使用离线词典。
- **输入框翻译**：使用输入框旁的按钮或 `Alt+T`；输入框快捷键可在设置中修改。
- **图片翻译**：悬停受支持的图片后点击翻译按钮，也可使用图片右键菜单。
- **PDF 阅读**：从 PDF 链接或页面的右键菜单打开双栏阅读器；也可在阅读器中选择文件。
- **对应高亮**：选中一段文字，或按住 `Alt` 停在词上，查看另一侧的对应位置。
- **模式与服务**：快速档优先速度，精确档使用所选精确服务，综合档先显示快速结果再更新；两档实际使用同一服务时会避免重复翻译。

浏览器级快捷键可在 `edge://extensions/shortcuts` 或 `chrome://extensions/shortcuts` 修改。

## 使用范围与隐私

PDF 阅读器尽量保留原页结构；复杂分栏、表格、公式、扫描质量和过长译文仍可能影响识别或排版。失败页会显示错误并提供重试，打印前应检查结果。词句对齐由启发式规则和模型共同完成，可能出现遗漏或范围偏宽。

OCR 和对齐模型首次使用需要下载模型数据；内置翻译的支持情况也取决于浏览器、系统和语言包。浏览器内部页、扩展管理页等受限页面通常无法注入内容脚本。

使用本地翻译时，文字由本机服务处理；启用云端翻译或远程对齐后，相关文字会发送给对应服务。设置、密钥、缓存和翻译记忆保存在浏览器配置目录，可选同步按设置传输。需要离线处理时，请只启用本地服务并提前完成模型下载。完整数据流见 [隐私说明](docs/PRIVACY.md)。

## 从源码构建

安装 Node.js 22 的最新补丁版本或更新的受支持版本，以及 npm。在源码根目录运行：

```bash
npm ci
npm run build
```

输出目录为 `.output/chrome-mv3`，按上面的开发者模式步骤加载即可。构建会从已安装依赖准备本地 WASM、OCR 和 PDF 运行文件，不需要复制原开发机的 `node_modules`、`runtime` 或 `work`。

`package-lock.json`、`public/dict/` 和 `public/licenses/` 是源码的一部分，应保留。`public/assets/` 是构建生成目录，不需要手工提交。更多发布准备步骤见 [发布指南](docs/PUBLISHING.md)。

### 开发与检查

安装和普通源码构建不要求 Git。`zip:source` 使用 Git 解释忽略规则，需要安装 Git 并使其可执行文件可被找到；`test:backend` 和 `verify:release` 包含源码打包回归，也需要 Git。

```bash
npm run dev             # 开发模式
npm run typecheck       # 完整类型检查
npm run test:backend    # 后端与合约测试
npm run test:ui         # 独立假后端的界面回归
npm run test:e2e        # 正式前后端 + 本机 HTTP 回放
npm run zip             # 构建正式扩展 ZIP
npm run zip:local       # 打包 Windows 安装工具，不下载模型
npm run zip:source      # 按忽略规则导出源码包及文件清单
npm run verify:release  # 串联发布验收并校验两个 ZIP
```

浏览器测试需要 Playwright 可用的 Chromium，首次可运行 `npx playwright install chromium`；也可以通过 `BROWSER_EXECUTABLE` 指向自己的 Chrome / Edge 可执行文件。测试使用独立临时配置目录。Windows 原生助手用例需要 Windows，其他平台会按测试声明跳过相应用例。

完整发布验收本轮只实测了 Windows + Edge；默认找不到浏览器时，请显式设置 `BROWSER_EXECUTABLE`。

完整发布验收默认使用确定性的本机翻译接口回放，不消耗云端服务额度。设置 `OCR_MODEL_CACHE`、`ALIGN_MODEL_CACHE` 后可加入已有真实权重的专项测试；未设置时不会执行这两项，也不会自动下载这些权重。这些结果不能代替模型翻译质量评测。

`zip:source` 生成 `.output/translate-ext-0.2.13-source.zip`，用于公开前复核或在新目录验证构建；它按 `.gitignore` 排除本地文件，附带 `SOURCE-MANIFEST.json` 文件哈希清单。该包也是源码，需要构建后使用。

0.2.13 原始功能验收记录为 **834 项后端测试、44 项界面测试通过**，另有正式后台、OCR、PDF 和对齐专项；具体条件和边界见 [优化与验收记录](docs/OPTIMIZATION-0.2.13.md)。

本次公开前另在干净源码上完成独立安装和发布验收：**837 项后端、44 项界面测试通过**，并通过正式包浏览器联调和 ZIP 校验。环境与范围见 [发布准备记录](docs/PUBLISH-PREP-0.2.13.md)。

## 项目结构与反馈

```text
src/shared/       前后端通信约定与设置
src/frontend/     网页、设置页、PDF 和媒体界面
src/backend/      调度、服务适配器、缓存、OCR、对齐和同步
src/entrypoints/  扩展入口
src/dev/          界面测试使用的假后端
gateway/          远程节点与本地模型脚本
public/           语言、词典、许可及其他静态资源
tests/            合约、单元和浏览器测试
docs/             使用、设计、协议与验收记录
```

报告问题时，请注明扩展版本、浏览器和系统、使用的翻译服务、复现步骤及预期结果。截图和日志请先去掉密钥、账户信息和不想公开的文档文字。贡献前请阅读 [AGENTS.md](AGENTS.md) 和 [前后端交接文档](docs/HANDOFF-BACKEND.md)。

## 许可证

项目自有代码采用 [MIT](LICENSE)。第三方组件、离线词典、模型和下载的运行库遵循各自许可证；其原文与来源见 [第三方许可说明](docs/THIRD-PARTY.md)、`public/licenses/` 和 `public/dict/`。
