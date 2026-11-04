# GitHub 源码与 Release 发布指南

本项目将开发源码放入 Git 仓库，将可直接安装的扩展和可选本地模型工具放入 Release 附件。仓库账号和地址确定后，再为 README 添加实际下载链接；不要提交虚构地址或尚不存在的徽章。

## 1. 源码范围

| 提交到源码仓库 | 不提交到源码仓库 |
|---|---|
| `src/`、`gateway/`、`tests/`、`typecheck/` | `node_modules/`、`.wxt/`、`.output/`、`dist/` |
| `README.md`、`LICENSE`、`.gitignore`、构建配置 | `runtime/`、`work/`、本机模型及浏览器配置 |
| `package.json`、`package-lock.json` | 密钥、环境文件、日志、个人论文或截图 |
| 整理后的 `docs/` | 编辑器的个人配置，如 `.idea/` |
| `public/dict/`、`public/licenses/`、语言等静态文件 | `public/assets/`，它由构建脚本准备 |

不能排除整个 `public/`：离线词典数据、许可证与来源清单需要随源码保留。当前 `src/backend/build-info.ts` 在构建前的类型检查中会被引用，不应只因它是生成文件就单独删除；构建脚本会更新构建信息。

首次提交前查看实际文件清单，确认没有个人姓名、账户、下载路径、临时浏览器资料、真实密钥或外部私人文档。第三方 LICENSE/NOTICE 中的作者与版权信息必须保留，不能作为个人信息批量删掉。测试用的通用姓名、示例域名和标准系统路径应与真实个人资料区分。

`.gitignore` 不能删除已经进入历史的文件。若误提交真实密钥，应先撤销或更换密钥，再单独处理仓库历史，不能只删除当前文件后继续发布。

## 2. 验证干净源码

使用新的临时目录克隆待发布提交，或按 Git 实际忽略规则导出拟提交文件。不要复制原开发目录的依赖、构建结果、模型、运行库或缓存。测试报告保存在被忽略的 `work/`，可在公开的发布准备记录中保留结果摘要和必要证据散列。

尚未建立远程仓库时，可运行 `npm run zip:source` 生成 `.output/translate-ext-0.2.13-source.zip`，将它解压到新的目录再执行下方检查。源码包按 `.gitignore` 过滤，附带 `SOURCE-MANIFEST.json` 文件哈希清单；这用于核对导出内容，不代替检查文档和源码内的个人信息。建立源码仓库时提交展开后的源文件，不把这个 ZIP 当作全部源码的唯一文件。

安装 Node.js 22 的最新补丁版本或更新的受支持版本，以及 Git 后，在新源码根目录运行。Git 用于 `zip:source` 及包含它的 `test:backend` / `verify:release` 回归；普通用户安装扩展和仅运行 `npm ci`、`npm run build` 不需要 Git：

```bash
npm ci
npm run typecheck
npm run test:backend
npm run build
npm run check:extension
```

`npm ci` 使用已提交的锁文件重新安装依赖；`build` 会准备本地运行资源并生成 `.output/chrome-mv3`。从这个目录加载扩展验证入口、设置页和基本翻译流程。

浏览器回归需要 Playwright 的 Chromium（可运行 `npx playwright install chromium`），或使用 `BROWSER_EXECUTABLE` 指定自己的 Chrome / Edge。不要复用日常浏览器资料目录。

完整发布验收本轮只实测了 Windows + Edge；默认找不到浏览器时，请显式设置 `BROWSER_EXECUTABLE`。

完整发布验收：

```bash
npm run verify:release
```

此命令串联类型、后端、界面、正式构建与浏览器验收，打包扩展和 Windows 安装工具，并校验 ZIP 内容。设置 `OCR_MODEL_CACHE`、`ALIGN_MODEL_CACHE` 后会额外运行本机已有真实权重专项；未设置时不会执行对应专项，也不会自动下载权重。报告中必须区分 HTTP 回放、模拟浏览器 API、真实 OCR/对齐和真实翻译模型质量测试。

构建记录包含时间字段，所以重新构建不必与历史 ZIP 字节完全相同。应比较源码版本、构建来源、功能验收和本次文件校验，不要沿用旧 ZIP 的哈希。

## 3. 生成交付附件

0.2.13 的 Release 应包含以下四个安装与校验文件：

```text
translate-ext-0.2.13-chrome.zip
translate-ext-0.2.13-chrome.zip.sha256
yi-local-setup-0.2.13-windows-x64.zip
yi-local-setup-0.2.13-windows-x64.zip.sha256
```

它们位于 `.output/`，作为 Release 附件上传，不把整个 `.output/` 提交到源码历史。GitHub 自动生成的 `Source code` 归档不能代替这两个交付包。

可以额外附上 `zip:source` 生成的源码包供复核，但要明确标注“需构建”，并使它与发布标签对应。

需要单独打包时：

```bash
npm run zip
npm run zip:local
node gateway/scripts/check-zip.mjs .output/translate-ext-0.2.13-chrome.zip
node gateway/scripts/check-zip.mjs .output/yi-local-setup-0.2.13-windows-x64.zip
```

`check-zip` 检查压缩包路径、清单及每个文件的 SHA-256，并写出 ZIP 自身的 `.sha256`。修改包内任何文件后都应重新验收、重新计算散列，不能继续发布旧校验文件。上传完成后可下载附件，用系统 SHA-256 工具比对对应校验文件。

Windows 安装工具只包含安装脚本及说明；模型和运行库在用户运行 `setup.cmd` 时从固定来源下载并核验，不随此 ZIP 分发。MIT 只覆盖自有代码，下载内容适用原提供方许可。卸载及 CPU/CUDA 切换说明见 [LOCAL-INSTALLER.md](LOCAL-INSTALLER.md)。

## 4. GitHub 发布

1. 完成公开前整理，检查拟提交内容，提交源码。
2. 在 GitHub 建立仓库并推送提交，按发布范围选择公开或私有。未获仓库读取权限的人不能下载私有 Release。
3. 在 Releases 中创建草稿，标签为 `v0.2.13`，Target 选择本次验收的提交，标题为 `Yi v0.2.13`。
4. 将 [RELEASE-0.2.13.md](RELEASE-0.2.13.md) 的内容作为发布说明，根据本次验收记录核对版本和结果。
5. 上传四个附件，核对文件名和校验文件，再发布 Release。源码标签、附件和说明必须对应同一版本。
6. 为 README 添加真实仓库的 Releases 链接，并检查首次访问者能找到下载、安装、隐私和许可说明。

GitHub 发布不会自动提交浏览器商店，也不会自动更新手动加载的扩展。用户需要更新解压目录、重新加载扩展并刷新网页。

## 5. 后续版本

修改完成后先测试，再同步更新版本、锁文件和发布说明，重新打包与校验。下一版使用新标签（如 `v0.2.14`），保留旧版下载以便回退。已公开的版本不要用另一份不同内容的包静默覆盖；有修正应使用新版本并说明变化。

首次开源可以先人工发布；后续再引入自动类型检查、测试和构建。不要把本机模型、云端服务密钥或个人浏览器资料作为持续集成的必需输入。
