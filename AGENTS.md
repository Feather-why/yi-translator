# AGENTS.md

给在这个仓库里工作的 AI 编程助手（Codex / GPT、Claude 等）看的说明。

## 先读

1. `docs/HANDOFF-BACKEND.md` —— 前后端分工、协议语义、后端任务与验收标准。
2. `src/shared/protocol.ts` —— 前后端唯一的约定。
3. `docs/design.md`（如果有）—— 完整设计文档。

## 分工

- **后端（GPT）**：`src/entrypoints/background.ts`、`src/entrypoints/offscreen/**`、`src/backend/**`、`gateway/**`、`tests/backend|providers|contract/**`。
- **前端（Claude）**：`src/frontend/**`、`src/entrypoints/content.ts`、`src/entrypoints/options/**`、`src/dev/**`、`tests/e2e/**`。
- **共用**：`src/shared/**`。改动前先在 `docs/HANDOFF-BACKEND.md` 第 13 节「协议变更记录」写一行，并保证旧的另一端仍能工作。
- 不改对方的目录；需要对方配合，写进交接文档第 14 节。

## 命令

```bash
npm i
npm run dev          # 带扩展的 Chrome，热更新
npm run build        # .output/chrome-mv3
npm run typecheck
npm run test:e2e     # 先 build
```

没有 `node_modules` 的环境（例如沙箱）可以用 `npx tsc -p typecheck/tsconfig.json` 做类型检查，它用 `typecheck/shims.d.ts` 代替 WXT 与 @types/chrome。

## 约定

- TypeScript strict；注释写中文，说明「为什么」而不是「做了什么」。
- 不加运行时依赖，除非确有必要（扩展包体积和审核都更麻烦）；加之前在 PR 里说明理由。
- 接口适配器一家一个文件（`src/backend/providers/<id>.ts`），只 import `types.ts` 和 `src/shared/**`；文件头写官方文档链接、免费额度来源与核实日期；每次修改把 `version` 加 1。
- 非官方免 key 接口放 `providers/unofficial/`，`official: false`，默认关闭。
- 仓库里不放任何 API key；测试用录好的响应回放。
- MV3 禁止远程代码：规则订阅、声明式适配器只能是 JSON 数据。
- 提交前：`npm run typecheck` 通过；改了后端跑合约测试；改了前端跑 `npm run test:e2e`。
- 提交信息用中文，一行说清改了什么，例如 `后端：腾讯适配器支持 TC3 签名`。
