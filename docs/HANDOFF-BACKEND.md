# 后端交接文档（给 GPT / Codex）

> 一句话：前端（Claude）已经把 M1 的全部界面和页面逻辑写完，并用一个假后端（`src/dev/mock-backend.ts`）跑通。
> 你的任务是写出**真后端**，替换掉假后端，**前端代码一行不用改**就能工作。
>
> 前后端之间唯一的约定是 `src/shared/protocol.ts`。读完本文后请完整读一遍它。

---

## 1. 分工与目录归属

| 归属 | 路径 | 说明 |
|---|---|---|
| **后端（你）** | `src/entrypoints/background.ts` | service worker 入口，现在接的是假后端 |
| | `src/entrypoints/offscreen/**` | offscreen 文档：跑 ONNX（词对齐、OCR）、需要 DOM 的工作 |
| | `src/backend/**` | 调度器、各家接口适配器、缓存、额度、状态、词典、对齐、规则、同步、密钥 |
| | `gateway/**` | 远程推理节点（台式机上跑的服务） |
| | `tests/backend/**`、`tests/providers/**`、`tests/contract/**` | 后端测试 |
| **前端（Claude）** | `src/frontend/**` | 内容脚本逻辑、悬浮球、划词小窗、设置页 |
| | `src/entrypoints/content.ts`、`src/entrypoints/options/**` | 以后还有 `pdf/`、`main-world.ts`（YouTube 字幕钩子） |
| | `src/dev/**` | 假后端，后端完成后可删 |
| | `tests/e2e/**` | 端到端测试 |
| **共用** | `src/shared/**` | 协议、占位符、RPC 工具、设置的存储约定 |

规则：

- **不改对方的目录。** 需要对方配合时，写进本文第 12 节「待对方处理」。
- **改 `src/shared/` 要走流程：** 先在第 11 节「协议变更记录」加一行，`PROTOCOL_VERSION` 加 1（仅新增可选字段时可不加，但要记录），并保证旧前端仍能工作。
- 设置分两份存储（见 `src/shared/settings.ts`）：`settings.ui` 只有前端写，`settings.core` 只有后端写。**密钥不放在这两份里**，由后端单独加密保存。

---

## 2. 现状与本地运行

已完成（前端 + 共用）：

- `src/shared/`：协议、占位符校验（`placeholders.ts`）、RPC 收发工具（`rpc.ts`，后端用 `onRpc()` 注册处理函数）、设置。
- 整页翻译：扫描段落、只翻视口附近、批量请求、流式渲染、综合模式浅→深覆盖、逐段 / 逐句对照、仅译文 / 仅原文、链接保持可点（SPA 点击转发）、纯文本网址变可点链接、字体颜色继承与 CJK 字体回退、动态内容跟踪、还原后 DOM 与原来完全一致。
- 联动高亮（原文⇄译文，用 `align:get` 的结果）、悬浮球、划词圆点与半透明小窗、词典卡片、设置页（常用 / 翻译服务 / 服务状态 / 关于）。
- 假后端：实现了全部端口和 RPC，返回「像中文」的假译文和示例状态数据。

命令：

```bash
npm i                 # 安装依赖（会自动 wxt prepare）
npm run dev           # 打开带扩展的 Chrome，改代码热更新
npm run build         # 产物在 .output/chrome-mv3
npm run typecheck
npm run test:e2e      # 先 build；用 Playwright 加载扩展跑页面测试
```

---

## 3. 协议要点（必须遵守）

### 3.1 翻译端口 `tx:translate`

内容脚本每个标签页一条长连接。消息类型见 `TranslateClientMsg` / `TranslateServerMsg`。

- **结果逐段流式返回**，翻完一段发一段，不要等整个 job。
- **阶段（stage）：**
  - `fast`、`accurate` 模式：每段只发一次 `stage:'final'`。
  - `combined` 模式：高速档与精确档**并行**开跑，先发 `stage:'fast'`，再发 `stage:'final'`。精确结果先到（或命中缓存）时可以**只发 final**；final 之后不得再发 fast。
  - 每个阶段的全部片段都返回后发一次 `job-done`（combined 模式发两次；跳过了 fast 的片段在 fast 阶段的 `job-done` 里视为已完成）。
- **每个片段最终必须恰好有一个 final 结果或一个 final 错误。** combined 模式下 fast 出错可以不报，但 final 必须有交代。
- **取消：** 收到 `cancel` 后，被取消的片段不再发送任何消息；正在进行的网络请求尽量 abort。
- **优先级：** 数字越小越先做。`0` = 当前屏，`1` = 下一屏，`100` = 空闲。新来的 0 号 job 要插队到正在排队的 1/100 前面。`priority` 消息用于滚动时调整。
- **重连：** service worker 被回收后前端会重连，并把**同一个 jobId、只含未完成片段**的 job 再发一次。后端要能幂等处理（同 jobId 再来就当新 job，按片段 id 去重）。
- **`noCache: true`：** 不读也不写缓存、不写译文记忆、不进同步。用于「重翻」和敏感网站。
- **`providerHint`：** 强制用某家（划词小窗的「换一家重翻」将来会用）。
- **长片段：** 后端可以内部切分再拼接，但对前端仍是一个片段一个结果。
- **`provider` 字段：** 填实际出译文的服务 id。命中缓存时填原服务 id 并设 `cached:true`（协议注释里的 `'cache'` 示例作废，见变更记录）。

### 3.2 占位符

`<gN>…</gN>`（链接、加粗等，里面的字要翻）和 `<xN/>`（代码、网址、图片，原样保留）。

- 后端**必须保证**译文里的占位符和原文一致（数量、编号、嵌套）。用 `checkPlaceholders(source, translated)` 校验。
- 推荐做法：
  1. 机翻接口：用各家自带的标签处理（DeepL `tag_handling=xml`、微软 `textType=html`、谷歌云 `format=html` 等），把 `<g0>` 转成接口接受的标签，回来再转回；不支持标签的接口，先去掉占位符翻译，再按位置把 `<xN/>` 插回（`<gN>` 丢失时整句降级为不带格式）。
  2. 大模型 / 本地模型：提示词里明确「原样保留 <g0></g0> <x0/> 这类标记」；校验失败时用更强的提示重试一次。
  3. 仍失败：换下一家；都失败才返回 `code:'placeholder'`。
- 前端还原时有容错（丢失的链接和代码会补在句末），但这只是兜底。
- **网址永远不取自模型输出。** 后端不得新增或改写占位符。

### 3.3 状态端口 `tx:status`

设置页「服务状态」订阅它。连接建立时**立即**推一次 `snapshot`，之后每 5 秒或状态变化时推。`providers` 按 rank 升序，`events` 最新在前、最多 50 条。收到 `probe` 立即检测并推送；`provider-action` 的 `pin` 置顶（调度时优先）、`pause` / `resume` 暂停 / 恢复。

服务状态页已经按 `StatusSnapshot` 的每个字段做好了展示（额度占比条、排名表、节点显存对照 2 GB 预算、事件），字段填真实数据即可。

### 3.4 RPC

格式 `{rpc, payload} → {ok:true, data} | {ok:false, error: ErrorInfo}`，用 `src/shared/rpc.ts` 的 `onRpc({...})` 注册。逐个说明：

| RPC | 要求 |
|---|---|
| `ping` | 返回 `{protocol: PROTOCOL_VERSION, backend: '版本号'}` |
| `dict:lookup` | ECDICT 离线查词，含词形还原（用 ECDICT 的 exchange 字段）。查不到返回 `null`。**≤ 20 ms** |
| `align:get` | 见第 8 节。预计算命中 **≤ 50 ms**，现算单句 **≤ 300 ms**（CPU） |
| `rules:forUrl` | 合并本地 > 订阅 > 内置，返回最具体的一条或 `null`。**≤ 30 ms**（前端最多等 400 ms） |
| `explain` | 用精确档大模型解释词或句在上下文中的意思，≤ 120 字，中文 |
| `providers:list` | 全部服务；密钥字段的值返回 `'••••'`，**绝不回传明文** |
| `providers:save` | 保存配置；值仍是 `'••••'` 的密钥字段视为未修改 |
| `providers:test` | 真发一次小请求，返回延迟或错误 |
| `feedback:bad` | 记该服务一次差评（降权），并在 10 分钟内对这句原文避开该服务；前端随后会带 `noCache` 重翻 |
| `tm:save` | 写译文记忆；以后同一原文优先用它 |
| `perf:report` | 记录首屏耗时，用于状态页的 P50 |
| `ui:openOptions` | 打开设置页，`tab` 作为网址 hash（`options.html#status`） |

### 3.5 后台入口要保留的部分

`background.ts` 里把扩展图标、快捷键（`toggle-page`、`translate-selection`）、右键菜单转成 `ContentCommand` 发给标签页的那段代码要保留。

---

## 4. 建议的后端结构

```
src/backend/
  index.ts              startBackend()：注册端口、RPC、定时任务
  ports/translate.ts    翻译端口：job → 队列；结果流式回传；取消、重连幂等
  ports/status.ts       状态端口
  rpc.ts                onRpc 注册表
  scheduler/
    queue.ts            全局优先级队列（可抢占）
    pool.ts             选服务：EWMA、熔断、对冲、页面粘性
    quota.ts            额度记账（按设备计数，便于同步合并）
  providers/
    types.ts            defineProvider 接口（见第 5 节）
    registry.ts         所有适配器的清单
    tencent.ts  microsoft.ts  deepl.ts  niutrans.ts  baidu.ts  google-cloud.ts
    openai-compatible.ts  gemini.ts  llamacpp.ts  remote-node.ts  chrome-builtin.ts
    unofficial/         非官方免 key 接口，默认关闭，official:false
    declarative/        声明式适配器（JSON 描述的简单 HTTP 接口）
  cache/                IndexedDB：译文缓存（LRU）、译文记忆
  dict/                 ECDICT 导入与查询
  align/                词对齐（调 offscreen 里的 ONNX 模型）
  rules/                站点规则：内置 / 订阅 / 本地
  sync/                 WebDAV
  secrets.ts            密钥加密存储
  status.ts             汇总状态快照、事件环形缓冲
src/entrypoints/offscreen/   onnxruntime-web / transformers.js（WebGPU 优先，CPU 回退）
gateway/                      远程节点服务
```

---

## 5. 接口适配器（一家一个文件）

目标：**某家接口失效时只换一个文件**；状态页上能直接看到是哪个文件、哪个版本出了问题（`ProviderStatus.adapter`）。

```ts
// src/backend/providers/types.ts（建议）
import type { AuthField, ErrorInfo, LangCode, Mode, PageContext, ProviderKind, QuotaInfo } from '../../shared/protocol';

export interface ProviderContext {
  /** 统一的 fetch：自动超时、计时、记账、测试替身。适配器禁止直接用全局 fetch。 */
  fetch(input: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
  signal: AbortSignal;
  config: Record<string, string>; // 已解密
  log(msg: string): void;          // 生产环境不得记录原文全文
}

export interface ProviderRequest {
  texts: string[];                 // 一批片段（已按 limits 切好）
  sourceLang: LangCode;            // 可能是 'auto'
  targetLang: LangCode;
  context?: PageContext;
}

export interface ProviderDef {
  id: string;                      // 与文件名一致
  name: string;
  version: string;                 // 每次修改 +1，状态页显示
  kind: ProviderKind;
  official: boolean;
  usedFor: Mode[];
  auth: AuthField[];
  /** 默认免费额度；以官网为准，在文件头注释写来源链接与核实日期。 */
  freeQuota?: Omit<QuotaInfo, 'used' | 'resetAt'>;
  limits: { maxChars: number; maxSegments: number; concurrency: number; qps?: number };
  /** 占位符怎么处理：xml/html 标签透传，或去掉后按位置插回。 */
  placeholders: 'xml' | 'html' | 'strip-reinsert' | 'prompt';
  /** 语言代码映射（如 zh-CN → zh-Hans）。 */
  mapLang?(code: LangCode): string;
  translate(req: ProviderRequest, ctx: ProviderContext): Promise<string[]>;
  /** 把 HTTP 状态 / 接口错误码归类成协议的 ErrorCode（限流、额度、鉴权……）。 */
  classifyError(err: unknown): ErrorInfo;
  /** 健康检查；能查到官方用量的（如 DeepL /usage）一并返回，用来校准本地记账。 */
  health?(ctx: ProviderContext): Promise<{ ok: boolean; latencyMs?: number; used?: number; amount?: number }>;
  /** 计费口径（默认按字符数）。 */
  cost?(req: ProviderRequest): number;
}

export const defineProvider = (d: ProviderDef) => d;
```

约定：

- 适配器只 import `types.ts` 和 `src/shared/**`，不 import 其他适配器。
- 签名算法（腾讯 TC3-HMAC-SHA256、百度 MD5 签名等）放 `providers/signers/`，适配器按名引用。
- **尽量少依赖非官方接口：** 默认只启用官方接口；非官方的放 `unofficial/`、`official:false`、默认关闭、设置页有提示。
- **声明式适配器：** 简单的 REST 接口（OpenAI 兼容、各类 JSON API）可以用 JSON 描述（地址、请求头模板、请求体模板、结果路径、错误码映射、签名器名称），支持订阅更新。MV3 禁止远程代码，所以 JSON 里**只能是数据**，不能有脚本。
- 首批建议实现：腾讯、微软、DeepL Free、小牛（或百度）、OpenAI 兼容（DeepSeek / 硅基流动等）、Gemini、llama.cpp 本地、远程节点、Chrome 内置翻译。

---

## 6. 调度算法

- **两档：** 高速档（机翻池、本地 1.8B、Chrome 内置翻译）与精确档（远程 7B、云端大模型）。`fast` 只用高速档，`accurate` 只用精确档，`combined` 两档并行。
- **缓存优先：** 译文记忆 → 精确缓存 → 高速缓存 → 发请求。combined 模式下精确缓存命中就只发 final。
- **打分：** 延迟用 EWMA（α≈0.3）；乘上成功率；再按额度压力调整。**用掉会作废的额度优先**：离重置越近、剩余越多的服务权重越高（日额度当天不用就浪费）。
- **熔断：** 连续 3 次失败或收到限流 → 暂停 30 秒，之后 60、120 秒……指数退避；到期放一个探测请求（半开）。
- **对冲请求：** 优先级 0 的请求，如果首选服务超过 `max(300ms, 它的 P90)` 还没回，向第二家再发一份，取先到的，取消另一个（两边都记用量）。只在额度充足时启用。
- **页面粘性：** 同一页面尽量一直用同一家，保证术语前后一致；该服务失败或被熔断才换。
- **额度：** 本地按「服务 × 周期 × 设备」计数（存 `chrome.storage.local`，同步时各设备相加）；能查官方用量的定期校准。剩余不够这次请求、或收到额度错误 → 标记 `exhausted` 直到 `resetAt`，立即换下一家，写一条事件。
- **并发与批量：** 按每家的 `limits` 合并片段成批；全局队列按优先级出队；优先级 0 可抢占。
- **首屏目标：** 机翻档首屏第一段 P50 < 600 ms；本地 1.8B < 800 ms。

---

## 7. 本地模型与远程节点

### 7.1 笔记本本地（显存 ≤ 2 GB，速度优先）

Hy-MT2-1.8B Q4_K_M 跑在 `llama-server` 上，约 1.5 GB 显存：

```bash
llama-server -m Hy-MT2-1.8B-Q4_K_M.gguf --port 8081 \
  -ngl 99 -fa on -c 4096 -np 2 -ctk q8_0 -ctv q8_0 -b 512 -ub 256 --jinja
# 采样：temperature 0.7, top_p 0.6, top_k 20, repeat_penalty 1.05
```

- 适配器 `llamacpp.ts` 调 `/v1/chat/completions`，用模型卡给的翻译提示模板；`/health` 做健康检查。
- 状态页的本机节点要报：已加载模型、显存（`vramMB`）、token/s、排队数；显存超过 2 GB 预算时状态页会标出。
- 建议在 `gateway/` 里也放一个 Windows 一键启动脚本（`scripts/run-local.ps1`）。

### 7.2 远程节点 gateway（台式机跑 Hy-MT2-7B）

薄薄一层服务：鉴权、排队、批量、NDJSON 流式；后面接 llama-server。建议 Python FastAPI，监听 Tailscale 地址。

| 接口 | 说明 |
|---|---|
| `GET /v1/health` | `{ok, version, models:[{id, loaded, vramMB}], queue, tokensPerSec}` |
| `POST /v1/translate` | 请求 `{segments:[{id,text}], sourceLang, targetLang, context?, model?}`；返回 NDJSON，每行 `{id,text}` 或 `{id,error:{code,message}}`，最后 `{done:true}` |
| `POST /v1/align` | 请求 `{pairs: AlignPair[]}`，返回 `AlignResult[]`（awesome-align，GPU） |
| `GET /v1/metrics` | JSON：队列、吞吐、各模型延迟 |
| `POST /v1/pdf` | （M7，可选）BabelDOC 保留排版翻译 PDF |

- 鉴权：`Authorization: Bearer <token>`；CORS 只放行 `chrome-extension://<扩展 id>`。
- 扩展里 `remote-node.ts` 适配器读这些接口；节点状态进 `StatusSnapshot.nodes`。

---

## 8. 词对齐（联动高亮用）

前端在两处调用 `align:get`：页面上划选（按下鼠标时就预取）和划词小窗。要求：

- 输入是**纯文本**（前端已去掉占位符，是页面上看得到的文字），返回的 `srcTokens` / `tgtTokens` 是**相对这两段字符串**的字符区间，`links` 是 `[原文词下标, 译文词下标]`。
- 不需要字字精确，**能把一个词对到对应的词或词组**就行。
- 速度：译文到达后在空闲时预计算（以 `segmentId` 和译文为键缓存）；命中 ≤ 50 ms。模型用 SimAlign / awesome-align 的 ONNX 版本，transformers.js 在 offscreen 文档里跑，默认 CPU（避免和本地翻译模型抢显存）。远程节点在线时可以转给 `/v1/align`。
- 模型没就绪时返回启发式结果（相同的数字、拉丁词、标点对齐），或 `links: []`，不要报错。

---

## 9. 其他模块

- **缓存（IndexedDB）：** 键 = `sha256(源语言|目标语言|档位|文本)`；LRU，上限约 200 MB；`noCache` 时不读不写。
- **译文记忆：** `tm:save` 写入，查询优先级最高；参与同步。
- **词典：** ECDICT 首次使用时导入 IndexedDB（可放扩展包里压缩分发，或首次下载）；支持词形还原。
- **站点规则：** JSON 结构见 `SiteRule`；订阅只接受 JSON 数据，做结构校验；`style` 只允许排版属性（前端也会再过滤一次）；可导入 kiss-rules（导入前核对许可证）。
- **WebDAV 同步：** 同步 `settings.ui`、`settings.core`、规则、译文记忆、各设备用量计数；**密钥默认不同步**，用户开启后用口令派生密钥（PBKDF2）+ AES-GCM 加密；按键的时间戳后写者胜；每 10 分钟及变更后防抖同步；结果写进 `StatusSnapshot.sync`。
- **密钥：** 存 `chrome.storage.local` 的独立键，用 WebCrypto AES-GCM 加密，设备密钥是存在 IndexedDB 里的不可导出 `CryptoKey`。
- **图片 OCR（M6）：** offscreen 里 PP-OCRv5 + onnxruntime-web（WebGPU 优先）。需要的 RPC（如 `ocr:image`）由前端在协议 v2 提出。
- **YouTube 字幕（M5）：** 前端从播放器自己的字幕请求里拿到字幕，按 `kind:'subtitle'`、同一视频同一 `groupId` 发来；后端成批翻译时带上前后几行做上下文，**行数必须一一对应**。
- **PDF（M7）：** 前端做 pdf.js 双栏阅读器，按段发 `kind:'pdf'`；远程节点可选 BabelDOC 走保留排版的整本翻译。

---

## 10. 里程碑与验收

| 后端里程碑 | 内容 | 验收标准 |
|---|---|---|
| **B1** 替换假后端 | `startBackend()`、翻译端口、状态端口、全部 RPC（可先简单实现）、3 家官方机翻 + 本地 llama.cpp、缓存、额度记账 | 合约测试全过；`npm run test:e2e` 通过；机翻首屏 P50 < 600 ms；额度用尽一次请求内切换；状态页显示真实数据 |
| **B2** 精确档与调度 | 远程节点 gateway、OpenAI 兼容 / Gemini、对冲、熔断、页面粘性、占位符重试链 | combined 模式在 7B 节点上首段 final < 1.5 s；断网 / 限流时自动降级且状态页有事件 |
| **B3** 词典与对齐 | ECDICT、词对齐（offscreen ONNX）、译文记忆、差评降权 | `dict:lookup` ≤ 20 ms；`align:get` 预计算命中 ≤ 50 ms；联动高亮在真译文上能对到词 |
| **B4** 规则、同步、密钥 | 站点规则（内置 / 订阅 / 本地）、WebDAV、密钥加密 | 两台设备同步设置与用量计数；密钥默认不出本机 |
| **B5** OCR、字幕、PDF | 配合前端 M5–M7 | 由前端按协议 v2 提出接口后再定 |

---

## 11. 合约测试（B1 必须有）

在 `tests/contract/` 用假端口直接驱动后端（不经过浏览器），逐条检查：

1. 每个片段最终恰好一个 final 结果或 final 错误；combined 下 fast 最多一次且在 final 之前。
2. `cancel` 之后被取消的片段不再有任何消息。
3. 每个阶段在全部片段返回后发且只发一次 `job-done`。
4. 占位符：用一组带嵌套 `<g>` 和 `<x/>` 的样例（含中英日混排、网址、代码）跑一遍，`checkPlaceholders` 全部通过。
5. 优先级：先提交 100 号 job、再提交 0 号 job，0 号的第一段先完成。
6. 重连：同 jobId 只含部分片段重发，只返回这些片段，不重复。
7. `noCache`：结果不进缓存、不进译文记忆。
8. 状态端口：连上立即收到 snapshot。

适配器测试放 `tests/providers/<id>.test.ts`，用 `ctx.fetch` 替身回放录好的响应，CI 里不放任何真实 key。

为了让 `npm run test:e2e` 在没有任何 key 的机器上也能跑，请保留一个只在开发构建启用的 `pseudo` 服务（可直接搬 `mock-backend.ts` 里的 `pseudoTranslate`）。

---

## 12. 安全与隐私红线

- 仓库和发布包里**不放任何 API key**；不做任何遥测；生产环境日志不记录原文全文。
- 敏感网站（`noCache`）的内容不进缓存、译文记忆和同步。
- 网址不取自模型输出；后端不新增、不改写占位符。
- MV3 不允许远程代码：订阅（规则、声明式适配器）只能是 JSON 数据。
- 后台请求翻译接口时 `credentials: 'omit'`，不带用户在这些网站上的 Cookie。
- **许可证：** 沉浸式翻译类的开源项目（如 KISS Translator、Read Frog）是 GPL-3.0，复制它们的代码会让本项目也必须用 GPL。只借鉴思路，不复制代码；导入规则数据前核对其许可证。

---

## 13. 协议变更记录

- 2026-11-04（本轮八项优化补充）：`ping` 响应新增可选 `buildId`，版本与构建编号从生成文件读取；旧调用者可忽略。

- 2026-11-04，Codex，本轮八项优化 / v3：用户明确授权同时修改前后端，覆盖 AGENTS 旧目录分工。PROTOCOL_VERSION 2→3；旧请求与旧结果保持有效。providers:test 新增可选 sourceLang/targetLang；ocr:image、pdf:translate 新增可选 requestId，pdf:translate 新增可选 documentHandle；新增 media:cancel {requestId}、pdf:open {url?/dataUrl?,noCache?}→{documentHandle,documentId}、pdf:close {documentHandle}，media 能力新增可选 cancel/pdfSessions。任务与文档句柄按发起者隔离，只存有界内存，旧媒体请求仍支持直接传文件；前端对旧后端能力缺失回退。具体实现、验收和限制将在本轮完成后追加。


| 版本 | 日期 | 改动 | 提出 |
|---|---|---|---|
| v2.2 | 2026-11-04 | 落实第32节：将 `libretranslate` / `custom-http` 并入 `ProviderTemplate`，保留 `ExtraProviderTemplate` 别名；实现已有可选 `providers:templates`、`local:autostart`、`local:start` 和 `align-reset`。旧模板、RPC及协议号2保持兼容；`wxt.config.ts`新增用户明确要求的 `nativeMessaging` 权限，不设置manifest key以保留现有扩展ID。 | Codex |
| v1 | 2026-11-03 | 初版 | Claude |
| v1 | 2026-11-03 | 新增 RPC `ui:openOptions`（内容脚本不能直接打开设置页） | Claude |
| v1 | 2026-11-03 | `noCache` 明确为「不读也不写缓存、不写译文记忆、不进同步」 | Claude |
| v1 | 2026-11-03 | 命中缓存时 `provider` 填原服务 id、`cached:true`（不再用 `'cache'`） | Claude |
| **v2** | 2026-11-03 | `ProviderInfo` 新增可选字段 `options` / `defaults` / `editable` / `custom` / `template` / `docsUrl`；新增类型 `ProviderOptions`、`ProviderTemplate`。详见第 17 节 | Claude |
| **v2** | 2026-11-03 | `providers:save` 请求新增可选 `options`、`name`；新增 RPC `providers:add`、`providers:remove`、`providers:models` | Claude |
| v2 | 2026-11-03 | `UiSettings` 新增 `loadingEffect`（前端自用，后端不用处理） | Claude |
| v2 | 2026-11-03 | `ContentCommand` 新增 `{cmd:'translate-image', srcUrl}`（图片右键菜单用，前端已处理）；`UiSettings` 新增 `imageButton`、`subtitles`（前端自用） | Claude |
| v2 | 2026-11-03 | B2–B5 后端扩展：保留全部 v1 RPC/端口语义，新增后端能力查询、词典导入、对齐配置、规则管理、显式开启的同步/密钥备份、OCR/字幕/PDF RPC；状态新增可选熔断/置顶字段，翻译任务新增可选缓存命名空间。前端代码不改。 | Codex |
| v2 | 2026-11-03 | `UiSettings` 新增 `onboarded`（首次引导是否走完，前端自用）；`ui:openOptions` 的 `tab` 新增可选值 `'welcome'`、`'advanced'`。旧后端不认识这两个值时打开默认设置页，前端会自己跳转，不会坏。详见第 21 节 | Claude |
| v2.1 | 2026-11-03 | 流式输出：`TranslateJob.stream?`；新服务端消息 `{type:'partial', jobId, segmentId, stage, text}`（text 为到目前为止的完整译文）。`result.timing?: SegmentTiming`（queueMs / providerMs / firstTokenMs / retries）。新 RPC `providers:warm`。`PerfReport` 新增可选 `firstScreenFastMs` / `firstScreenFinalMs` / `prepareMs`。全部可选，旧后端不改也能用，`PROTOCOL_VERSION` 不变。详见第 23 节 | Claude |
| v2 | 2026-11-03 | 第 21 节后端联调：实现 `ui:openOptions` 的 welcome/advanced；兼容新增只读管理 RPC `rules:subscriptions`，返回来源 URL、实际 JSON 版本或有效规则 SHA256 版本、更新时间、独立 ETag、错误及规则数/回滚能力。旧 RPC 返回结构不变，不提高协议号，不改前端。 | Codex |
| v2 | 2026-11-03 | 兼容新增 `performance:get`（仅管理页读取匿名内存聚合，不持久化/同步）和显式 `models:warmup`（manual 仅管理页；hover 仅同扩展真实标签页且非敏感/隐身；只使用已配置本机节点，不接受调用方 URL/密钥）。旧接口不变，不提高协议号，不改前端。 | Codex |
| v2 | 2026-11-03 | 对接第 23 节已有前端 `providers:warm({mode?})`，安全转到 `models:warmup` 的 hover 逻辑；保留真实来源保护、本机配置和限频，不用 health 冒充唤醒，不自动下载内置/对齐模型。partial 和逐段 timing 暂不生成，旧最终结果保持兼容。 | Codex |
| v2 | 2026-11-03 | 兼容新增 AlignResult.spans 可选句子/短语 UTF-16 半开范围，独立于词链接；前端需按选区粒度采用，旧前端忽略不受影响。 | Codex |

---





## 14. 待对方处理 / 待验证

**第 47 节已重新构建并验收（第 48 节，0.2.12 同版本新包）：** 语言包自动启用后的卡片重画保留方向；真实后端服务停用后从状态表移除，暂停仍保留；精确表隐藏快速档排名；三种顶部 flex 标签原译文对齐通过。第 46.2.2 节问题已修复，下方旧发现保留为历史。

**第 45 节后端已接入 / 0.2.12（第 46 节）：** 显式内置翻译检测改为打开统一语言包卡片，已有标签复用、不重载；783 项后端、32 项页面、12 项媒体及正式浏览器联调通过。第 44.2 节调度板说明已由前端第 45.2 节处理。新待前端小项：下载后自动启用导致详情重画、临时语言选择回到全局目标，建议保留当前 pair；详见 46.2。下方旧发现为历史记录。

**第 43 节调度板语义核对（第 44.2 节）：** 目前 pinned 是服务级全局属性，status.rank 是快速档排名；不能将其表示为两档独立置顶 / 精确档实际排名。本地 / 内置服务仍有跨档后备规则。本轮仅重新打包，未改协议或调度行为。

**第 41 节修复已在本机验收（第 42 节）：** 最新前端的页面 29/29、图片/PDF 12/12 通过，PDF.js 6.5.438 数学字母回归已通过。下方第 40 节发现及旧任务保留作历史记录。

**最新 0.2.11 交接（2026-11-04）：** PDF 字体 name 缺失导致数学变量格式丢失、方案页误报 builtin 可用、新服务保存后二次保存误要求密钥，以及移动助手 / 额度两处教程文案。详见第 40.2 节与 [RELEASE-039-REVIEW.md](RELEASE-039-REVIEW.md)。前端源码和测试保持不变；下文旧条目为历史记录。

**0.2.8新增交接（2026-11-04，后端未改前端）：**

- 混合扫描PDF：后端`offscreen/media.ts`和阅读器`pdf/layout.ts`都只按“有没有文字层”决定是否OCR。页面仅有原生页码/标题、正文仍为扫描图时可能漏正文。建议前端按正文文字覆盖与图像区域判断需要OCR的区域，和后端确定去重/坐标约定；验收夹具至少包含纯文字、纯扫描、仅页码+扫描正文、已有完整隐藏文字层四类。不自动对所有稀疏页面OCR，避免标题页误识别和重复覆盖。本轮保持该策略并记录限制。
- 重导词典后后端的词对齐缓存已按revision失效，不能主动清除网页里已保存的对齐Promise；当前页面重新高亮仍沿用前端缓存时需刷新。若前端后续增加“导入成功使当前页对齐失效”的通知，应另列协议兼容变更。

**2026-11-03 / 0.2.5补充：** 后端本次不改高亮绘制。请按第26节消费现有句子/引用spans并失效同长改译的旧Promise缓存；量化与后端验证详见 [QUANTIZATION-SEMANTIC-FOLLOWUP.md](QUANTIZATION-SEMANTIC-FOLLOWUP.md)。


**本轮后端 → 前端交接（0.2.4，用户明确仍不授权改前端）：**

- 整句/引用选区：后端新增可选 `AlignResult.spans`（纯文本 UTF-16 半开范围），请按完整选区覆盖消费 sentence/phrase；部分选词仍用 links，反向选择交换两端。不要按“有重叠”扩大到整句，更不要制造逐词全覆盖。现有整段淡底色和只合并相邻 token 的绘制需前端处理。详见 [SELECTION-FOLLOWUP.md](SELECTION-FOLLOWUP.md)。
- 对齐前端 Promise 缓存需纳入完整源/目标文本与版本，重翻/编辑失效；目前仅后端更新不能清理网页已有的缓存。新后端已隔离策略版本。
- PDF 漏译优先修：`extractLayout` 将物理第 13 页 / 印刷 x 的目录 References 当成 startsReferences，`reader.ts` 从 refsFrom=13 过滤后面 89 页；真正参考文献为物理 87 / 印刷 70。请识别正文参考文献标题，不能让目录条目触发全局截止，附录也需有明确策略。
- PDF 排版：保留目录逐行标题与页码、日期/署名两行及段落对齐；勿把正文首行缩进当居中。Background 截图是物理 18 / 印刷 1。论文 102 页逐页数据和具体函数/验收见 [PDF-THESIS-FOLLOWUP.md](PDF-THESIS-FOLLOWUP.md)，尚未修改前端实现。
- 图片：邻近同字号地图标签会被当前 groupLines 合成段落，需区分独立标签与正文；识别完成不等于翻译完成，状态需分阶段。此机制已用纯函数合成例验证，但未伪称复现未知截图 OCR 文本。
- 阅读顺序：后端只在同一任务内按输入顺序短等最多 250ms；跨任务 DOM/当前页顺序仍需前端调度，长段超时不能无限挡住后段。后端本次没有 partial 或逐段 timing 新实现。

**需要后端确认：**

- Chrome 内置翻译（`Translator` API）只在页面类上下文可用、service worker 里没有。请验证 offscreen 文档里能否使用；不能的话告诉前端，改由内容脚本代调（协议 v2 加一个反向请求）。
- 本地 llama-server 由谁启动：用户手动、还是 gateway 的本机模式代管。

**前端接下来会做（可能带来协议 v2）：**

- M5 YouTube 字幕（`main-world.ts` 钩子）、M6 图片 OCR 覆盖层（`ocr:image`）、M7 PDF 阅读器与站点规则编辑界面。
- 状态页上「置顶 / 暂停」的当前状态：现在 `ProviderStatus` 里没有 `pinned` 字段，前端暂时只发命令不显示状态；如果后端方便，v2 加一个可选的 `pinned?: boolean`。

**B1 后端确认（2026-11-03）：**

- 本地 llama-server 由用户手动启动；已提供 `gateway/scripts/run-local.ps1`。默认只监听 `127.0.0.1:8081`，模型权重不随扩展分发。
- Chrome 内置 Translator 的 offscreen 可用性仍待验证，B1 不将其显示为可用服务；不填云端 key 时需先启动本地 llama-server。
- 全量 ECDICT、ONNX 词对齐、规则订阅和 WebDAV 仍按 B3/B4 推进；B1 查词返回 `null`，对齐只链接相同文字和数字，规则查询返回 `null`，不会返回示例词典或伪造模型结果。

---

### 14.1 2026-11-04：第32节混合扫描判定的噪点反例（需要前端参考）

真实 mixed.pdf 在后端固定2倍栅格上，扫描噪点令大量空白行只有1～2个深色像素，原“有墨水就参与交替中位数”得到4而不是文字阈值28，因此漏OCR。后端已只让深色像素至少max(8, ceil(画布宽×1%))的行参与中位数，并增加带噪文字/纯噪点回归。实际图为2.80%墨迹，文字清楚，不能通过降低28阈值来放宽成图片都识别。

前端 imageBodyPage 当前仍用 inkN>0，渲染比例不同时可能触发同一问题。请前端考虑同步“排除孤立噪点行”的规则；本轮按用户要求未修改阅读器。backend pdf:translate收到混合页后已经能识别正文；不能把此结果扩大为所有缩放下的阅读器自动触发均已修复。

## 15. B1 实施与验收记录（2026-11-03）

### 已实现

- `background.ts` 改接 `startBackend()`，保留原来的图标、快捷键、右键菜单命令转发。`src/frontend/**`、内容脚本、设置页、`src/dev/**`、`tests/e2e/**` 和 `src/shared/**` 均未修改，协议仍为 v1。
- 真实翻译端口与状态端口、全部 13 个 RPC；逐段返回、综合模式两档并行、精确缓存只发 final、按阶段结束、取消与断开清理、重复 job 替换、首屏优先与滚动调优。
- 微软、DeepL Free、小牛三家面向新用户的官方机翻；腾讯存量用户适配器；本地 llama.cpp。每家独立文件，版本与官方资料在文件头，所有请求通过统一 fetch 且 `credentials:'omit'`。
- 5ms 微批量窗口、按 HTTP 批次执行并发/QPS 限制、占位符数量/平衡/父子关系校验、加强提示重试、失败换家；超长片段按文本叶子切分，标签留在本地。
- IndexedDB 缓存（约 200 MB LRU）与译文记忆；缓存区分语言/档位/适配器版本并保留原服务；`noCache` 不读写缓存和译文记忆。敏感页面及隐身以消息发送方为依据强制保护。
- 按设备与周期持久化字符用量，发请求前预留预算；额度不足或接口返回额度错误时同一次请求换家。DeepL `/usage` 校准实际上限与用量。
- API key 以 AES-GCM 加密，设备密钥为 IndexedDB 内不可导出的 CryptoKey；设置页只收到掩码，保存掩码保留旧密钥；单家密文损坏可重新保存恢复且不阻断其他服务。
- 状态页显示实际请求延迟、用量、错误、事件和首屏耗时；没有来源的显存/吞吐/模型信息留空。置顶、暂停、测速真实生效；差评后的同句缓存也避开原服务十分钟。

### 官方政策修正

腾讯官方说明 2026-10-01 起不再发放新的文本翻译免费资源包，文本接口也不再接入新用户：[官方快速入门](https://cloud.tencent.com/document/product/551/104415)。因此腾讯适配器默认停用、字符预算为 0，不再宣称每月 500 万免费字符；存量用户需自行设置预算。小牛每日 20 万字符来源为[官方文档](https://niutrans.com/documents/contents/trans_text)。历史设计中的额度不应覆盖这些已核实的变化。

### 命令与测试构建

```powershell
npm install
npm run typecheck
npm run test:backend
npm run build
npm run test:backend:browser
npm run test:e2e
```

- `npm run build` 生成正式包 `.output/chrome-mv3`，不注册 pseudo 服务。
- `npm run test:e2e` 自动生成独立的 `.output/chrome-mv3-backend-test` 并运行原有前端测试；只有开发模式或这个测试构建才注册明确标为「非真实翻译」的 pseudo 服务。正式包不会用假译文掩盖未配置服务。
- 浏览器测试默认用 Playwright Chromium，可先运行 `npx playwright install chromium`；也可设置 `$env:BROWSER_EXECUTABLE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'` 使用本机 Edge 的独立临时资料夹。
- `npm run test:backend:browser` 对正式包使用本机 HTTP 回放验证真实适配器、RPC、端口和 IndexedDB，包括重启后缓存与加密密钥持久化，不发送真实凭据。
- 根 `tsconfig.json` 显式关闭 WXT 自动附加的 `noUncheckedIndexedAccess`，与仓库已有独立类型检查的约定一致，保留 TypeScript strict；后端合约编译单独开启该检查，避免为兼容旧前端而降低后端检查力度。
- 本地启动示例：`powershell -File gateway/scripts/run-local.ps1 -ModelPath '.\runtime\models\Hy-MT2-1.8B-Q4_K_M.gguf'`，随后在翻译服务中设置 llama.cpp 地址并测速。

### 验证结果与剩余验收

- 后端合约、核心、微批量、存储与五家适配器回放测试：107/107 通过。
- `npm run typecheck`、正式构建与测试构建通过。
- 原有前端端到端测试：10/10 通过，使用独立 Edge；前端源文件未修改。
- 正式包浏览器后端集成测试通过：生产无 pseudo、真实端口、嵌套占位符、缓存/noCache、密钥掩码、不可导出设备密钥及重启后的持久化。
- 未使用用户真实 API key 或下载/运行真实模型；B1 的真实机翻首屏 P50 < 600ms、本地模型速度/显存仍需在配置服务后测量，不能用回放结果代替。因此这里记录为「B1 实现及离线/浏览器验收通过，真实服务性能待验收」。
- B2 的远程节点、云端精确模型、对冲、页面粘性与完整半开熔断尚未展开；B5 等待协议 v2。

---

## 16. 本地模型部署实测（2026-11-03）

- 已部署官方 Hy-MT2-1.8B Q4_K_M 与 llama.cpp b12069 CUDA 13.4，默认服务 `http://127.0.0.1:8081`，只绑定本机。
- 显卡为 RTX 5070 Ti Laptop 12GB；Windows 进程 GPU 计数测得模型专用显存约 1.37 GiB，另有约 88 MiB 共享显存。五条合成短句热启动约 66–136ms；真实插件普通片段约 91ms、嵌套占位符约 191ms。均为小样本，不代替整页 P50 基准。
- GPU 真实运行发现并修复翻译提示词被混入译文的问题，`llamacpp.ts` 版本升至 1.0.1；新增两项回归后 109/109 后端测试、类型检查与构建通过。前端和共享协议未改。
- 新增一键 `start-local.cmd` / `stop-local.cmd`，重复启动检查、PID 身份核验、后台日志和闲置 600 秒卸载；不设置开机自启。运行目录已排除出仓库。
- 第 15 节的「未运行真实模型」是 B1 当时记录；现在已完成本机模型及真实插件调用验证，云端机翻性能、完整首屏基准及远程节点仍未验证。
- 使用、参数、来源和排错见 `docs/LOCAL-MODEL.md`。默认插件地址可直接使用，API key 留空。

---

## 17. 协议 v2：服务的高级设置（需要后端实现）

> 前端已完成并用假后端测通：设置页「翻译服务」改成左侧列表 + 右侧详细设置，可以改接口地址、模型、调度参数、额度、提示词，可以添加 / 删除自定义服务。
> v2 全部是**新增的可选字段和新 RPC**，v1 后端不改也能继续工作：`ProviderInfo.editable` 缺省时前端只显示账号字段，并提示「后端还不支持高级设置」。

### 17.1 `providers:list` 要多返回的字段

| 字段 | 含义 |
|---|---|
| `editable` | 这家服务支持改哪些通用设置（`ProviderOptions` 的键）。**前端只显示这里列出的项**。机翻一般是 `endpoint, timeoutMs, usedFor, weight, concurrency, qps, maxChars, quota`；大模型 / 本地 / 远程再加 `model, prompt, temperature` |
| `defaults` | 每项的默认值（来自适配器）。前端显示成「默认 xxx」的占位文字，并据此判断「恢复默认」 |
| `options` | 用户改过的值（只含改过的项） |
| `custom`、`template` | 用户自己添加的服务 |
| `docsUrl` | 官方文档链接 |

### 17.2 各项设置的含义

- `endpoint`：覆盖适配器的接口地址。只接受 `http:` / `https:`；官方服务允许改成代理或区域端点（密钥会发往用户填的地址，这是用户的选择）。本地 / 远程 / OpenAI 兼容服务没有默认地址时，未填视为「未配置」。
- `model`：模型名。缓存键要带上模型名和提示词的哈希，换模型后不能命中旧缓存。
- `usedFor`：参与哪一档。高速档 = `['fast','combined']`，精确档 = `['accurate','combined']`，两档都选 = 三个都有。调度按它分档，状态页按它分组。
- `weight`：0–100，默认 50，作为调度打分的偏置；置顶相当于 100。
- `timeoutMs` / `concurrency` / `qps` / `maxChars`：覆盖适配器 `limits` 和超时，后端需夹在合理范围内（例如并发 1–16）。
- `quota`：用户账号的实际免费额度，覆盖适配器默认值（例如腾讯老用户自己填预算）。`amount: 0` 表示没有免费额度：不计入状态页的免费额度，调度时只在用户置顶或没有别的服务可用时使用。
- `prompt` / `temperature`：大模型类服务的提示词和温度。提示词可用 `{{from}} {{to}} {{text}} {{context}}`；占位符校验和重试链照旧。
- `providers:save` 带 `options` 时**整份替换**：没出现的项恢复默认。值仍是 `'••••'` 的密钥字段照旧视为不修改。`name` 只对自定义服务生效。

### 17.3 新 RPC

| RPC | 要求 |
|---|---|
| `providers:add` `{template, name}` | 按模板新建一个服务实例：`openai-compatible`（DeepSeek、硅基流动、Ollama、LM Studio、vLLM…）、`llamacpp`（另一台 llama-server）、`remote-node`（另一台 gateway）。生成唯一 id，`custom: true`，**默认停用**，返回完整 `ProviderInfo`。同一个适配器文件可以有多个实例 |
| `providers:remove` `{id}` | 删除自定义服务及其配置、密钥、用量计数；内置服务返回 `bad_input` |
| `providers:models` `{id, endpoint?, config?}` | 用表单里尚未保存的地址和 key 查询可用模型：OpenAI 兼容和 llama-server 用 `GET /v1/models`，Ollama 可回退 `GET /api/tags`，远程节点用 `/v1/health` 的 `models`。5 秒超时，返回模型 id 列表 |

### 17.4 验收

- 设置页改了地址 / 模型后「保存并测试」，测试请求确实发往新地址、用新模型。
- 添加一个 OpenAI 兼容服务，填地址、key、模型，启用后能参与精确档调度；删除后状态页和调度里都消失。
- 合约测试补：`options` 整份替换语义、`'••••'` 不覆盖密钥、`providers:remove` 拒绝内置服务。

---

## 18. B2–B5 后端与当前 v2 前端兼容交接（2026-11-03）

- 后台版本 `0.2.0-b5`、扩展 0.2.0、协议 v2。保留全部 v1 翻译/状态端口与 RPC，合并第 17 节已存在的可选高级服务字段，不覆盖前端的独立更新。
- 占位符保留严格结构校验；正常请求和加强提示均失败后，只翻译本地保留标签之间的文本叶子。格式错误不再触发整家本地服务熔断，冷却错误不再误报未配置。
- B2 三家精确适配器、鉴权 gateway、EWMA/额度调度、对冲、半开和粘性；B3 100,000 词 ECDICT、真实 CPU ONNX 对齐、预计算与 TM；B4 规则订阅/回退、WebDAV、LWW/墓碑、跨设备用量合并、密钥默认不上云；均有分阶段测试和详细文档。
- B5 按用户确认仅完成后端：真实 PP-OCRv5 CPU、字幕逐行翻译、PDF.js 提取与扫描页 OCR，新增业务接口统一在 `backend-v2.ts`。图片覆盖、字幕监听/叠加和 PDF 阅读器仍由前端实现，本轮未增加入口。
- 第 17 节服务管理已接真后端：自定义模板实例、模型列表、掩码密钥保留、支持项配置及整份替换、配置变更缓存失效、实例删除清理。仅暴露实际支持的 editable，不承诺任意机翻代理端点或 token 额度精确计量。
- 全后端 strict/noUnchecked 编译及测试 205/205，当前前端浏览器测试 11/11、实际项目类型检查通过；部署前保护文件共 23 个，前端未写入。统一正式包及真实网页验收继续记录于 `BACKEND-ACCEPTANCE.md`。
- 用户确认重新加载后的日常 Edge 也已验收：同一公开问题页面首屏 88/88、滚动后 99/99 段完成，零等待、零错误；译文链接与精确 DOM 还原通过，控制台无警告/错误，最后留在双语状态。该轮按正常缓存策略使用，不作为冷启动性能基准。
- 真实本机 GPU、网关、词典、WASM 对齐和三类媒体 RPC 已验证；没有真实云账户、远程 7B、实体第二设备和用户 WebDAV，不能宣称那些环境或性能已验收。自定义实例定义仍保存在当前设备，跨设备恢复边界见 `PROVIDER-OPTIONS.md`。

详细入口：[BACKEND-ACCEPTANCE.md](BACKEND-ACCEPTANCE.md)、[BACKEND-V2-API.md](BACKEND-V2-API.md)。各阶段记录与许可原文另见文档导航和 `public/licenses/`。

---

## 19. B5 前端已接入（2026-11-03，Claude）

前端已按 `backend-v2.ts` 和 `B5-MEDIA.md` 接好三类媒体功能，先用 `backend:capabilities.media` 判断后端是否支持，不支持就不显示入口。

| 功能 | 前端文件 | 调用的后端接口 |
|---|---|---|
| 图片翻译：鼠标移到大图上出现按钮，点一下翻译；整页翻译时可自动翻译进入视口的大图（设置里开关）。译文画在图片上方的覆盖层里，不改图片、不改排版 | `src/frontend/media/images.ts` | `ocr:image`（`url` 或 blob/data 图转成的 `dataUrl`，`translate:true`） |
| YouTube 双语字幕：MAIN world 钩子拿到播放器自己请求的 `/api/timedtext`，按句合并后批量翻译，当前播放位置附近的先翻；拿不到整条字幕时读原生字幕逐行翻译。播放器右下角有开关 | `src/frontend/youtube/*`、`src/entrypoints/youtube-hook.content.ts`（`world:'MAIN'`、`document_start`）、`src/entrypoints/youtube.content.ts` | `subtitle:translate`（每批最多 80 行 / 12,000 字符） |
| PDF 双栏阅读器：左栏 PDF.js 渲染原页，右栏每段译文放在原段落位置，悬停两侧联动高亮；滚动到附近才翻译，每批 3 页 | `src/frontend/pdf/reader.ts`、`src/entrypoints/pdf/` | `pdf:translate`（网上的 PDF 传 `url`，本地文件 ≤25 MiB 传 `dataUrl`）；用 `assets/pdf/` 下的 worker、cmaps、字体 |

`wxt.config.ts` 只加了一项：`pdf.html` 加入 `web_accessible_resources`，因为在浏览器自带的 PDF 查看器里，内容脚本要用 `window.open` 打开阅读器（右下角「双栏对照翻译」按钮）。

**请后端配合（都在 `background.ts`）：**

1. 右键菜单「翻译这张图片」（`contexts: ['image']`）：发 `{cmd:'translate-image', srcUrl: info.srcUrl}` 给标签页，前端已处理。
2. 右键菜单「用双栏阅读器打开 PDF」（链接以 `.pdf` 结尾，或当前页是 PDF）：打开 `chrome.runtime.getURL('pdf.html') + '?url=' + encodeURIComponent(链接)`。
3. `ui:openOptions` 目前只接受 general / providers / status，前端暂时不需要新 tab。

**测试：** `node tests/e2e/media.mjs`（图片覆盖层与 PDF 阅读器）在假后端下 6/6 通过；原有 `tests/e2e/run.mjs` 12/12 通过。YouTube 用模拟的播放器页面测过字幕截获、合并、双语显示和开关按钮；真实 youtube.com 和真后端的 OCR / PDF 还没在用户电脑上测过。

**19.1 更新：图片与 PDF 改为「保留原排版」（2026-11-03，Claude）**

- **图片**：现在调用 `ocr:image` 时传 `translate:false`，只要识别结果。前端把相邻行合并成段落，再走普通翻译端口（`kind:'ocr'`，有上下文，综合模式先浅后深）。读得到像素时，前端用原背景色抹掉原字，按原文字颜色和字重写上译文；读不到像素（跨域且不允许 CORS 的图片）时用深色毛玻璃卡片。
  - 后端可选优化：`OcrBlock` 增加可选的 `bg` / `fg` 颜色（后端解码时就有像素），前端以后可以用来处理跨域图片。不做也不影响现有功能。
- **PDF**：有文本层的页，前端用 PDF.js 自己分析版面（`src/frontend/pdf/layout.ts`），再通过翻译端口逐段翻译（`kind:'pdf'`）。不翻译的内容：公式、表格、纯数字，以及参考文献标题之后的条目。段落中的数学字体片段以 `<xN/>` 发出，**请保证原样保留**（与网页占位符同一规则）。
  - 右栏是原页的拷贝：只抹掉要翻译的行，按原字号、行距、颜色、字体写上译文。
  - `pdf:translate` 现在**只用于没有文本层的扫描页**（每次 1 页）。
- 测试：`tests/e2e/media.mjs` 7/7 通过（新增论文样例 `fixtures/paper.pdf`：双栏、图、公式、参考文献）。

---

## 20. 本地翻译与句/词对应质量优化（2026-11-03）

- 扩展 0.2.1、后台 `0.2.1-quality`，共享协议不变。llama.cpp 适配器升至 1.0.3，旧自动译文缓存按版本失效；保留用户译文记忆和采样/提示设置。
- 失标后优先完整语境翻译，再用精确词组、真实 ECDICT 义项或本机已热模型语义映射恢复格式；不再把标签之间的短词译文作为主要正文拼接。原子、嵌套与链接结构继续严格校验，未增加远程代码或依赖。
- 首次对齐返回句内词区间，模型推理按句/窗口，过滤跨句重复词，支持自动英文词典锚点。普通缓存/TM 命中也预计算，前台请求优先。用于标签恢复的原始语义链接与高亮近似覆盖分离。
- 全后端 230/230、类型检查、当前前端 12/12 通过；真实模型冷/热十例结构校验和主复现语义断言通过；浏览器首次划句、热词及句/词反向对应五项通过，原链接、代码和三段精确 HTML 还原通过。
- 本次不写入前端源码。整段浅底色由现有前端固定绘制，仍然保留；后端使强高亮范围对应所选句/词。模型未就绪时的单词范围含句内位置估计，不能宣称完全语义精确。
- 主文档：[QUALITY-FOLLOWUP.md](QUALITY-FOLLOWUP.md)，细节：[TRANSLATION-QUALITY.md](TRANSLATION-QUALITY.md)、[ALIGNMENT-QUALITY.md](ALIGNMENT-QUALITY.md)。首定义句约 795/849ms 是本机冷/热小样本，不代替 P50 或全语言质量评测。

---

## 21. 前端：首次引导、高级设置、段落工具条、报错收拢（2026-11-03，Claude）

本轮只改前端，共享协议只加了上面变更记录里的两处可选值。

| 功能 | 前端文件 | 用到的后端接口 |
|---|---|---|
| **首次使用引导**（设置页「快速设置」）：选语言和模式 → 自动测试所有不需要密钥的官方服务，能用的自动打开，并用第一个能用的试翻一句 → 完成。`kind:'builtin'` 排在最前并标「推荐」，其次本地模型、远程节点。`official:false` 的服务单独列出，**默认关闭、不自动测试**。需要密钥的服务只给链接，跳到 `#providers/<id>` | `src/frontend/options/welcome.ts` | `providers:list`、`providers:test`、`providers:save`、翻译端口 |
| **高级设置页**：站点规则（列表、新建/编辑/删除本地规则、订阅/刷新/回滚）、WebDAV 同步（密钥同步要单独打开并填口令）、密钥备份导出/导入、词典 CSV 导入、词对齐开关与远程地址。按 `backend:capabilities` 隐藏后端不支持的卡片 | `src/frontend/options/advanced.ts` | `rules:*`、`sync:configure`、`sync:run`、`secrets:export/import`、`dict:import`、`align:configure` |
| **段落工具条**：鼠标停在一段译文上 0.35 秒出现：重翻 · 换一家翻译 · 复制 · 修改译文 · 翻得不好 | `src/frontend/ui/toolbar.ts`、`content/page.ts` | 见下 |
| **报错收拢**：段落里只留一个小红点（悬停看原因），不再整段红字。悬浮球菜单顶部出现「全部重试（N）」和一个按错误类型给出的按钮（去设置服务 / 检查密钥 / 换一个引擎）。没有可用服务或密钥错误时，球旁边出现一次提示条，12 秒后自动消失 | `src/frontend/ui/ball.ts`、`content/page.ts`、`content/style.ts` | 只读错误码：`no_provider`、`auth` 优先级最高，其次 `quota`，其余归为一般错误 |

**段落工具条的调用方式（请后端确认语义一致）：**

- **重翻：** 同一段重新发一个任务，`noCache:true`。
- **换一家翻译：** `noCache:true` + `providerHint:<id>` + `mode:'accurate'`（只要一次结果，不要先浅后深）。引擎列表取自状态端口的服务列表，按延迟排序。**`providerHint` 只对这一次任务生效，不要当成置顶。**
- **修改译文：** 用户直接在译文上改，回车保存。前端把改后的 DOM 按 `data-tx-slot` 还原成占位符文本，再调 `tm:save`：
  - `source`：这一段当初发出去的原文，**带 `<gN>…</gN>` / `<xN/>` 占位符**，与翻译端口 `segments[].text` 完全相同；
  - `target`：同一套编号的占位符。
  - 请后端按与普通翻译相同的规则校验占位符（编号对不上就返回 `bad_input`），并保证以后同一原文的普通任务能命中这条记忆。敏感网站照旧不写（后端已按 sender 判断）。
- **翻得不好：** 先调 `feedback:bad`，再按「重翻」重新发。

**请后端配合（都在 GPT 的目录里）：**

1. `src/entrypoints/background.ts`：`chrome.runtime.onInstalled` 里，`details.reason === 'install'` 时打开 `chrome.runtime.getURL('options.html#welcome')`。更新扩展时不要打开。
2. `src/backend/rpc.ts` 的 `ui:openOptions`：允许的 tab 加上 `'welcome'`、`'advanced'`。现在这两个值会落到 `openOptionsPage()`；用户还没走完引导时前端会自己跳到引导页，走完了就停在常规页，所以不改也能用，只是「去设置服务」不能直达。
3. 谷歌、微软的本地翻译接入后：
   - `kind` 用 `'builtin'`、`official:true`、不需要密钥。引导页会把它们排在第一、标「推荐」，并自动测试、自动打开。
   - `providers:test` 遇到「语言包没下载」或「当前浏览器不支持」时，请返回明确的 `message`（引导页原样显示在这一行上），不要只返回 `ok:false`。
   - 建议这两家打开后在调度里默认排最前（免费、不出本机）。前端不需要再改。
4. （可选）`rules:subscriptions` 列表 RPC：返回每个订阅的地址、上次更新时间、版本、错误。现在前端自己在 `chrome.storage.local` 的 `ui.ruleSubscriptions` 里记订阅地址，后端有了这个接口前端就改用它。

**测试：** `tests/e2e/run.mjs` 新增「鼠标停在译文上出现段落工具条」，13/13 通过；`tests/e2e/media.mjs` 7/7 通过。假后端（`src/dev/mock-backend.ts`）新增：一个 `chrome-builtin` 服务（默认关闭）、规则/同步/备份/词典/对齐的模拟实现、原文含 `NOPROVIDER` 时返回 `no_provider`。真后端还没联调过引导页和高级页。

---

**21.1 跟进（2026-11-03，Claude）**

- 修复 `advanced.ts:175` 的类型错误：从 `chrome.storage.local` 读出的值先当 `unknown`，只保留 https 字符串数组（旧版留下的脏数据不会让页面出错）。用 `@types/chrome` 的真实类型复现并确认已消除。
- 高级页的规则订阅改用后端 `rules:subscriptions`：显示版本（内容 hash 只显示前 8 位）、规则数、更新时间和上次失败原因；只有 `canRollback:true` 才显示「回滚到上一版」。调用失败（旧后端）时才退回前端自己记的 `ui.ruleSubscriptions`；新后端下前端不再写这个键。
- 假后端加了 `rules:subscriptions`。前端回归 13/13、媒体 7/7 通过。

## 22. 划词纠错、B5 菜单与高速后备（2026-11-03，Codex）

- 扩展 0.2.2，后台 `0.2.2-alignment`，公共协议仍为 v2。保留第 19/19.1 节已接入前端与 PDF 原布局逻辑；未修改 `wxt.config.ts`。
- 用户具体复现 `concerns → ，` 已在日常 Edge 确认。删除句内位置补齐、禁止实词/标点错连、语义差距匹配和词典消歧；所有未缓存段落最多等真实计算 5 秒，修正 loaded=true 但当前 pair 尚未算完时 280ms 锁空的问题。原段六句/九链接的严格浏览器八项通过，`concerns ↔ 研究`、`acoustic ↔ 声学`、`auditory → 听觉`，句内范围和精确还原通过。
- 图片菜单按 frame 转发 `{cmd:'translate-image',srcUrl}`，PDF 菜单打开 `pdf.html?url=...`。菜单控制流有独立回归；原始 `tests/e2e/media.mjs` 通过真实本机模型和真实 PaddleOCR 的七项验收，不以假后端替代。实际资源边界见媒体专项文档。
- 新增官方浏览器内置 Translator 适配器及 backend/offscreen 桥接，无字符额度，默认启用并归高速档。首次准备通过显式测试打开后端可见准备页，再由真实用户按钮下载；自动探测不开页面、不伪激活。后台 CLD 与原生 Detector 可靠检测，未知/混语安全落其他服务；实际 Edge 中已验证原生显式和自动语言翻译。
- 按用户最新第 21 节建议，高速默认内置→有额度官方服务→本地→可选网页接口，精确档保留官方精确服务/本地优先；官方手动置顶仍优先。跨顺位不对冲，粘性不抢占更高顺位。停用/暂停不自动打开。
- `providers/unofficial/google-web.ts` 默认关闭、固定每 5 秒最多一个请求、最低权重；429 持久暂停，须手动恢复，自动 probe 和重启不重试。显式启用同步维护已有 allowUnofficial 开关，关闭时不读该服务自动缓存。不依赖 Google Cookie 或账户登录态。
- 用户特别允许仅调整前端「非官方」分组，因此只改 `src/frontend/options/providers.ts`、`status.ts` 两处分组过滤，其他前端和共享文件保留。整段浅底色、首次 Promise 缓存及句选无法填满所有字的边界详见对齐文档，未制造假的词链接填空。
- 文档入口：[QUALITY-FOLLOWUP.md](QUALITY-FOLLOWUP.md)、[ALIGNMENT-QUALITY.md](ALIGNMENT-QUALITY.md)、[PHONETICS-BROWSER-REGRESSION.md](PHONETICS-BROWSER-REGRESSION.md)、[TRANSLATION-FALLBACK.md](TRANSLATION-FALLBACK.md)、[BROWSER-TRANSLATOR.md](BROWSER-TRANSLATOR.md)、[MEDIA-CONTEXT-AND-E2E.md](MEDIA-CONTEXT-AND-E2E.md)。
- 第 21 节后端联调补齐：`ui:openOptions` 已直达 welcome/advanced；向导自动 `providers:test` 依据真实 sender 的 welcome 路由传内部 `prepare:false`，返回明确原因且不自动弹准备页，服务设置显式测试仍保留准备流程。新增受管理页权限保护的只读 `rules:subscriptions`，独立返回文档版本/规则内容 SHA256、ETag、更新时间、错误与回滚状态；失败、304、回滚和重启元数据均有回归。针对 RPC/规则测试 19/19 与后端合约编译通过。详细接口和既存前端 `advanced.ts:175` 类型错误边界见 [FRONTEND21-BACKEND.md](FRONTEND21-BACKEND.md)。

- 第 21 节安装/工具条语义也已补齐：仅 install 打开 welcome，update 不打开；修订占位符错误统一 bad_input，成功保存可跨 Core 重启命中人工记忆；providerHint 不写页面粘性或持久置顶。最新后端 302/302 通过，完整类型检查仅保留用户明确留给前端的 advanced.ts:175 错误。

- 普通页重翻后人工编辑也可正常保存：移除所有 noCache 源十分钟禁存的误锁定。noCache 本任务仍零自动缓存/TM读写；独立用户 tm:save 可保存非敏感修订，真实敏感/隐身 sender 仍拒绝。相应合约已加入 302/302 全套。
- 第 21 节高级页真实新建规则联调发现裸域输入被拒，已仅在本地 `RuleService.save` 入口兼容 `example.com` / `*.example.org` 并保存为明确模式，支持 IDN、localhost、明确 IP 与合法端口；既有协议模式原样保留，危险简写不写入。订阅 JSON 继续严格要求原协议模式。追加四项回归后规则文件 13/13 通过，后端合约编译通过；实际高级页继续使用原裸域输入验证，未修改前端或把测试改成带协议来绕开问题。详见 [FRONTEND21-BACKEND.md](FRONTEND21-BACKEND.md)。

---

## 23. 提速：流式输出、耗时拆分、预热（2026-11-03，Claude）

前端这轮做了四件事，其中三件需要后端配合才能完全生效；不配合也不会坏。

| 前端改动 | 文件 | 需要后端 |
|---|---|---|
| **流式显示**：job 带 `stream:true`；收到 `partial` 就把「到目前为止的译文」画出来（按帧合并，末尾半个占位符自动去掉，链接/加粗随写随还原），末尾有个闪烁光标；收到 `result` 后换成完整译文、轻轻淡入。综合模式下已有快速译文时不显示精确档的中间结果（避免可读的字又变回半截）。划词小窗同样支持 | `content/port.ts`、`content/page.ts`、`content/serialize.ts`（`restore(..., {partial:true})` 不补缺失内容）、`ui/selection.ts` | **要**：见下 1 |
| **首屏耗时拆分**：每次整页翻译记一条（准备 / 排队 / 翻译 / 其他、第一段出字、快速出齐、最终出齐、缓存命中、流式段数），存本机 `ui.perfLog`（最多 30 条），「服务状态」页新增「首屏耗时」条形图。也照旧发 `perf:report`（多了三个可选字段） | `content/perf.ts`、`options/status.ts` | **要**：见下 2（不填就只显示「后台」一整段） |
| **站点规则缓存**：点翻译时直接用缓存的规则，不再等后台最多 0.4 秒；后台照常再查一次，规则变了就按新规则重来。高级页改规则时清缓存。实测准备时间 134 → 43 ms（假后端） | `content/rule-cache.ts` | 不需要 |
| **预热**：鼠标移到悬浮球上（同一页 60 秒最多一次）时，先连上翻译端口唤醒 service worker、调 `providers:warm`、顺便查好站点规则 | `content/index.ts`、`ui/ball.ts` | **要**：见下 3 |
| 定格动画缩短到最长 0.26 秒；快速 → 精确替换不再跳字，只淡入 | `ui/scramble.ts`、`content/style.ts` | 不需要 |

**请后端配合：**

1. **流式（`partial`）**：`job.stream === true` 且所选服务支持流式时（llama.cpp、远程节点、OpenAI 兼容接口都支持 `stream:true` 的 SSE），边生成边发：
   - `{type:'partial', jobId, segmentId, stage, text}`，`text` 是**累计的完整译文**，不是增量；同一段 60–100 ms 最多发一次；
   - 最后照旧发 `result`（校验过占位符的完整译文），之后不再发 `partial`；中间结果不进缓存、不算完成；
   - 占位符校验失败要重试时，重试那次的中间结果也可以发（前端会覆盖显示），或者不发都行；
   - 机翻接口（微软、DeepL 等）和浏览器内置翻译不用流式，忽略 `stream` 即可。批量请求（一次多段）的服务也可以不流式。
2. **耗时（`result.timing`）**：每段的 `queueMs`（收到 job 到开始发请求：排队、等并发槽、查缓存）、`providerMs`（请求本身；批量请求填整批耗时）、`firstTokenMs`（流式时到第一个字）、`retries`（占位符校验失败后的额外请求次数）。量不到的不填。
3. **预热（`providers:warm`，请求 `{mode?}`）**：要便宜、可重复调用。建议：对本地 llama.cpp 发一个极短请求（或 `/health`）让闲置卸载的模型重新加载；需要 offscreen 的服务（浏览器内置翻译、对齐模型）先把 offscreen 文档建好；远程节点预连。失败直接返回 `{ok:true}` 也行，前端不看结果。
4. 之前讨论过的后端提速项：综合模式下两档选到同一个服务时只翻一次、快速档优先出队、本地模型多开几个并行槽、限流按实际请求而不是按段——这些前端不需要改，做完后「首屏耗时」图里能直接看出效果。

**测试：** `tests/e2e/run.mjs` 新增「精确模式下先流式出字，最后不残留半个占位符」（同时检查首屏耗时记录），14/14 通过；`media.mjs` 7/7 通过。假后端的精确档在 `stream:true` 时分 5 次发中间结果（会故意停在半个占位符上），并在 `result` 里带 `timing`。


---

## 24. 后端提速集成（2026-11-03，Codex）

- 扩展 0.2.3、后台 `0.2.3-performance`，共享协议号仍 2。保留前端第 21.1 / 23 节及其最新源码，后端不写前端目录。
- 综合模式按本段实际服务与配置共享工作，包括内置失败后共同落本地；同服务直接 final、精确上下文、一次额度预留。真正双服务仍快速先显示；取消/替换/noCache 不退步。
- 逻辑队列 8→32，同视口优先级 fast:final=3:1；老后台任务不能越过新首屏。每家 HTTP 并发/QPS 仍由真实批量请求计，不按段扣请求额度。
- 本机实测 2/6/8，选 GPU 六路，每路 2048；适配器 1.0.5 默认六并发，用户显式配置优先。CPU 默认两路。
- 本地失标恢复先自然正文、按需补格式锚点；结构校验仍严格。匿名占位符/HTTP/模型/排队指标可用 `performance:get`，仅管理页，无正文或持久化。
- `providers:warm({mode?})` 兼容第 23 节前端，转受控 hover 预热；只唤醒已配置本机 llama.cpp，限频、敏感/隐身拒绝、不发提示词、不用 health 冒充唤醒。显式 `models:warmup` 仍提供状态详情。
- 第 23 节 `partial` 与逐段 `result.timing` 本次保持可选缺省；前端正常显示完整结果和已有准备/首屏统计。匿名聚合不能伪装成逐段排队/模型时间；SSE 与共享批次 trace 需要另外验证，不影响本次实际去重提速。
- 详细方法、资源边界和验收：[PERFORMANCE-LOCAL-MODEL.md](PERFORMANCE-LOCAL-MODEL.md)、[PERFORMANCE-SCHEDULER.md](PERFORMANCE-SCHEDULER.md)、[PERFORMANCE-PLACEHOLDERS.md](PERFORMANCE-PLACEHOLDERS.md)、[PERFORMANCE-WARMUP.md](PERFORMANCE-WARMUP.md)、[PERFORMANCE-METRICS.md](PERFORMANCE-METRICS.md)、[PERFORMANCE-VALIDATION.md](PERFORMANCE-VALIDATION.md)。最终实测与测试数量以性能验收文档为准。


## 25. 图片、划选与阅读顺序追加修复（2026-11-03，Codex）

- 扩展 0.2.4，后台 `0.2.4-reading`，协议 v2；遵从“仍只改后端，前端问题写成交接文档”。本节及第 14 节明确列出仍未修复的前端体验。
- 后端已修复截图 Sealand 引号内虚词误连到外部 Latin 专名；多实词锚点约束引用，新增独立句/短语范围。真实 E5 的三个新例和五个原问题样例通过。完整整句绘制需要前端读取可选 spans。
- 同图 OCR 内容哈希缓存 8 项、2 分钟逻辑有效期，最多登记 4 个在途共享项；独立结果副本，noCache/敏感/隐身绕过。仅改善重复图；首次引擎初始化仍慢。
- 同一批 paragraph/sentence/pdf 的结果最多短等前段 250ms，不串行推理，不承诺全页绝对顺序；取消/替换清理，final 替换不重置等待期限。
- llama.cpp 适配器 1.0.6 只限制默认模板的网页 title 为 256 UTF-16 单位，不裁剪正文或用户自定义模板。234 次真实本机实验不支持删除短标签背景或压低输出上限，均未上线。
- 用户 PDF 全部 102 页已只读检查，后半本漏译为前端目录 References 假阳性，排版问题需前端修复；详见 [PDF-THESIS-FOLLOWUP.md](PDF-THESIS-FOLLOWUP.md)。
- 回归 380/380、完整类型检查通过；真实 E5/OCR/本地模型方法、计时及限制见 [READING-MEDIA-FOLLOWUP.md](READING-MEDIA-FOLLOWUP.md)、[SELECTION-FOLLOWUP.md](SELECTION-FOLLOWUP.md)、[LOCAL-MODEL-FOLLOWUP.md](LOCAL-MODEL-FOLLOWUP.md)。最终浏览器体验由用户测试。


## 26. 后端 0.2.5：量化复核、嵌套语义恢复与对齐提速

2026-11-03。用户继续授权仅改后端，前端问题交接。当前正式版本0.2.5 / `0.2.5-semantic`，协议仍v2，适配器1.0.6不变。总报告：[QUANTIZATION-SEMANTIC-FOLLOWUP.md](QUANTIZATION-SEMANTIC-FOLLOWUP.md)。

- **量化：保留Q4。** 新增官方Q6 SHA校验与Q4/Q6/Q8新样例对照，8独立source、2seed；AI盲审主口径12/16、11/16、10/16，严格口径11/16、11/16、10/16。不能宣称Q4一般更准。Q6六槽2015.6MiB，余量32.4MiB；Q8六槽2425.6MiB。未切生产模型、未编辑权重。

- **标签：本地可消歧nested先翻完整正文再恢复。** 子锚点先于父，并将后代术语用于父短语，避免同物两译导致整段碎片降级。唯一精确证据足够时不额外跑E5；局部nested节点有语义证据才放标签。普通单链接/平级路径不增加请求；非祖孙重复同词不启用新增强化。自动缓存按策略失效，人工TM保留。

- **真实回归：** 旧、新各24个Core任务，12nested请求78→44，无对齐模型下3困难例中位602→263ms、666→283ms、1736→676ms；热对齐507→262、581→272、1314→715ms。最终nested无叶子拼接，普通对照译文逐字不变。已见样例、单槽热模型且prompt缓存关闭，不可推为全页提速。第一次候选失败数据保留，未发布。

- **对齐：** 缓存隔离本地/远程来源、词典就绪阶段；配置/dispose拒绝迟到工作；真实结果不重复计算fallback词典；相同窗口仅本请求内复用向量。五例完整tokens/links/spans前后相同，Phonetics首次198.8→175.4ms，重复40句287.8→21.5ms（仅重复场景）。noCache仍不跨请求共享。

- **前端待接，未修改：** `src/frontend/content/highlight.ts`仍主要通过links/tokenRanges绘制，未读取后端`al.spans`。整句选中时优先使用有依据的sentence span；引用内短语限制在phrase span；单词仍用细links，不按位置比例补满。UTF-16半开偏移不变。前端`${segId}|${stage}|${target.length}`键不包含同长新译文内容，需在译文替换/失败恢复后失效；不要缓存首次空对齐直到刷新。

- **显示验收建议：** Babylon完整句连续覆盖相应中文句、不中下一句；Sealand只选引号内内容不亮后面的Sealand；concerns不亮逗号；同长度改译后重新请求词对；禁用/切换远程对齐、词典由冷转热后无陈旧结果。整段淡色底、PDF/图片布局及跨任务顺序继续按第25节处理。

- **上线操作：** 正式包仍为`.output\chrome-mv3`。用户自行重新加载扩展、刷新网页验证即可，不要求回复确认。未操作日常浏览器。完整自动测试、构建和保护文件哈希见交付`release-audit.json`。

## 27. 前端：PDF 版面修复、阅读器补全、`<br>` 分段、小窗精简、缩放适配（2026-11-03，Claude）

本轮只改前端，共享协议没动。按第 25 节和 `PDF-THESIS-FOLLOWUP.md` 的诊断修了 PDF，用户的论文在本机只读测试过（没有放进仓库）。

| 改动 | 文件 |
|---|---|
| **参考文献区整本预先算好**（`scanSections`）：有书签用书签，没有就只读文字层扫一遍（102 页约 0.6–1 秒）。目录页里的 References 不算；文献区到下一个大标题（附录、索引、大字号章标题）结束。和滚动顺序、窗口缩放无关。论文实测：只有物理 88–91 页整页不翻（纯文献），87 页标题前的正文和 92 页附录照常翻译 | `pdf/layout.ts`、`pdf/reader.ts` |
| **目录逐条翻译**：每条单独成段，只把标题送去翻译；编号、点线、页码原样保留；译文单行、放不下先缩字号；译文更短时盖住原标题。目录最后一页条目少也能认出来（跟在目录页后面） | `pdf/layout.ts` |
| **对齐按行判断**：不再用整段外框离页面中心多远（两端对齐的正文会被误判居中）；识别首行缩进和悬挂缩进（项目符号）；单行居中 / 右对齐另判 | `pdf/layout.ts`、`pdf/reader.ts` |
| **硬换行**：上一行明显没写满、下一行同一位置开始（日期 / 署名、地址）不合并；单独一行的人名（2–3 个首字母大写的词）保留原文 | `pdf/layout.ts` |
| **状态统计**：顶栏分开显示已翻译页、原样保留页、正在翻译页、失败段数（可点重试） | `pdf/reader.ts` |
| **阅读器补全**：书签目录 / 缩略图侧栏、跳页、缩放（Ctrl ± / 0）、左栏原文可以选中复制（PDF.js 文本层）、记住每个文件读到第几页和缩放（`chrome.storage.local` 的 `ui.pdfResume`，最多 40 个）、打印 / 另存译文版（先翻完整本，再只打印右栏，一页对一页） | `pdf/reader.ts` |
| **网页里用 `<br>` 分段的正文**（课程网站、论坛常见）：连续两个 `<br>`、或者前一行以句号 / 冒号收尾、或者下一行是列表项时分段，每段后面跟自己的译文；没有标点的单个 `<br>`（诗、地址）不拆 | `content/scanner.ts`、`content/style.ts` |
| **悬浮球小窗只留高频项**：模式、显示、引擎、用量、在本站隐藏。译文样式和「只翻正文」只在设置页。翻译过程中状态快照很频繁，引擎下拉框不再被重建（以前点开就收起） | `ui/ball.ts`、`options/app.ts` |
| **网页缩放适配**：网站给 `<html>` 设了 CSS zoom 时，悬浮球和图片按钮 / 覆盖层反向抵消，并按实际落点校正原点；图片按钮的进度文字（识别文字… / 翻译 k/n）不再折行；地图上相邻的短标签不再拼成一段 | `ui/host.ts`、`media/images.ts` |

测试：`tests/e2e/run.mjs` 新增 `<br>` 分段、引擎下拉框在快照下不被替换，18/18；`tests/e2e/media.mjs` 新增网页缩放、论文排版（新夹具 `fixtures/thesis-mini.pdf`，合成内容）、阅读器功能，10/10。

**请后端配合：**

1. **流式 `partial` 已完成**：0.2.6 已实现 llama.cpp 真 SSE、累计预览及取消清理（见第 28 节）；本条原待办已经关闭。
2. **`result.timing` 已完成**：0.2.6 已逐段返回真实 `queueMs` / `providerMs`，并在可测时返回首字与重试信息（见第 28 节）；本条原待办已经关闭。
3. ~~第 26 节说的划选对齐 `spans` 和对齐缓存键问题~~ 已接（见下）。

**27.1 划选对齐接入 `spans`（Claude）**：`content/highlight.ts` 按 `SELECTION-FOLLOWUP.md` 接好：
- 完整选中一个源端句组（去掉两端空白，句末标点可以不选）才用 `sentence` 范围，另一边连续绘制；多句选择只合并完整覆盖的句子，两端没选全的句子继续用词级链接；
- 基本正好选中引用里的短语（两头最多多 2 个字符）才用 `phrase`；已在完整选中句子里的短语不重复；
- Alt 悬停、单词选择只用词级链接；
- 淡底色改成选区碰到的句子的对应范围；没有 `sentence` 范围时仍铺整段；
- 对齐缓存键改为 `segId|stage|原文|译文`（同长度改译、重翻、换服务都会重取）；失败或没有链接的结果不缓存，下次再取。
- 测试：`run.mjs` 新增「完整选中一句原文：另一边连续高亮对应的整句，淡底色只铺这一句」（假后端句数相同时给 `sentence` 范围），19/19。

**27.2 跟进（Claude）**
- PDF 硬换行改成「下一行第一个词明明放得下却换了行」的判断（标题页的「学位项目 / 日期」「学院 / 瑞典语标题」各自成行，正文段落不受影响）；快写满一行的列表项不再被当成居中。
- 图片按钮以右边缘为锚点，悬停露出文字、进度文字变长时只往左伸。
- 网页上「贯穿整页的竖线」：译文落在网格容器里（页面骨架上的「跳到正文」之类直接文字），被拉成整行高度，竖线样式的左边框就成了长线。现在译文不再被弹性 / 网格布局拉伸，网格容器里夹在块之间的文字不翻；看不见的元素（零宽、透明、读屏专用的 1px 文字）也不翻。
- PDF 划词：我们的阅读器里左栏原文可以划词翻译；新增单栏阅读（`pdf.html?view=original`，只画原页、不整篇翻译，切到对照时再翻）。浏览器自带的 PDF 查看器右下角入口改成「双栏对照翻译 / 单栏阅读 · 可划词」两个按钮。
- 测试：`run.mjs` 20/20（新增网格 / 弹性 / 树状表格布局、零宽透明元素），`media.mjs` 11/11（新增单栏阅读划词、图片按钮只往左伸）。

**协议（v2.1，可选字段）**：`ContentCommand` 的 `translate-selection` 加了可选 `text`。

**请后端配合**：浏览器自带的 PDF 查看器里，内容脚本读不到选区。请在右键菜单「翻译「%s」」的处理里（`context-menu.ts`）把 `info.selectionText` 一起发过去：`{cmd:'translate-selection', text: info.selectionText}`，发给 `frameId: 0`。前端收到 `text` 时直接用它开划词小窗（自带 PDF 查看器页面上也已经在监听）。

**27.3 个性化外观（Claude）**：`UiSettings` 新增 `appearance`（前端自用，后端不用处理）：主题色（7 个预设或自定义 `#rrggbb`）、悬浮球样式（浅色 / 主题色 / 半透明）、大小、不用时的透明度。默认主题色从靛蓝 `#4256d6` 改成更柔和的「雾蓝」`#5065c0`（白字对比度 5.3:1），深色界面用同色调浅色版 `#96a3d9`。主题变量仍集中在 `src/frontend/theme.ts`。`run.mjs` 21/21。


## 28. 后端 0.2.6：llama真实流式与逐段耗时（2026-11-03，Codex）

- 第23/27节的两项已完成：job.stream=true的本机llama走SSE，partial为累计译文，首个可见字立即发、之后每段80ms合并；最后严格校验后result。false/缺省仍JSON。扩展0.2.6、后台0.2.6-stream、llama适配器1.0.7。
- 普通g/x段落可预览；嵌套恢复完整自然正文可预览，内部TXP、锚点/叶子不发。预览不入缓存、不算完成；final/error/cancel/替换/断线清待发。综合同服务仍一次实际工作直接final；快速结果出现后不回退成半截。
- result.timing至少queueMs/providerMs；前者从收到job至第一次实际请求，后者为本段真实请求区间并集，批次成员各取整批实际耗时。缓存/TM命中providerMs=0；可测才给firstTokenMs；retries含失标后恢复额外请求。不是全局聚合值，后续恢复间隙不冒充模型时间。
- 后端444/444；真实Q4模型7/7；正式生产包独立Edge4/4（流式、缓存、非流式、取消），首预览领先完整译文319.8ms。本轮没有修改前端/共享协议，没有更换本地模型或生产六槽参数。
- 已以本机项目最新文件为准保留第26节完整原文及第27/27.1/27.2节。第27.1的spans和缓存键已由前端接入。本节只落实用户当前明确提出的流式和计时两项；第27.2新增PDF选区text右键转发交接仍另列待办，未混入本次修改。
- 详见 [STREAMING-TIMING.md](STREAMING-TIMING.md)、[STREAMING-RESULTS.md](STREAMING-RESULTS.md)。正式包仍在.output\chrome-mv3；用户自行重载并刷新即可，不要求回复确认。真实数据不包含日常浏览器动画，不据此宣称整页吞吐同倍提高。


## 29. 后端 0.2.7：快速调度与PDF右键选区（2026-11-03，Codex）

- 右键tx-selection已由context-menu统一发送 `{cmd:'translate-selection', text:info.selectionText}` 至frameId:0；background不再提前发缺text的旧命令。undefined/空串兼容，无效tab安全，发送失败不影响其他菜单。第27.2的这一项完成；协议已有字段，未改shared/front。
- 第23/27节流式与timing此前0.2.6已完成，本轮复核并更新第27节过时待办文字。第26节完整原文未动。
- 快速独立模式的默认纯文本采用实测短模板；标签/自定义/术语/内部恢复保留原要求。fast本地和builtin首次失标直接进入原语义恢复，最终校验仍严格；accurate及combined的共享工作始终准确策略，缓存按profile隔离，人工TM不变。
- 真实服务槽改显式优先队列：视口优先、同层fast:final=3:1公平，批次动态取存活成员；生产32逻辑槽保留8fast入口（准确最大24），本机六槽仍能满载。暂停/停用/明确额度错误/冷却在发前检查，429先写冷却再释放。
- 实测：80次提示/采样对照，P2配对约7–8%收益；完整Core32任务通过，已知失标5→4请求；六槽12段fast总耗时2.15–2.36→1.73–1.95秒，准确积压时前台1.27–1.40秒（原1.34–5.77秒有抢槽波动）。这些不是全页通用速度承诺；综合无积压首预览并非每次更快。
- 回归480/480，菜单17/17；详情和限制见 [FAST-MODE-PERFORMANCE.md](FAST-MODE-PERFORMANCE.md)。扩展0.2.7、后台0.2.7-fast、llama适配器1.0.8；未改生产模型或六槽参数，GPU采样候选未上线。正式包.output\chrome-mv3，用户自行重载刷新。

- 最终实际本机项目类型检查与生产构建通过；同步后480/480合约，正式包独立Edge5/5（SSE、缓存、非流式、取消、fast短模板）。日常模型8081未重启，临时验收服务已退出；用户日常PDF选区显示由用户自行测试。

## 30. 后端 0.2.8：审阅优化逐项验收（2026-11-04，Codex）

用户授权仅改后端；前端及共享协议保持不变。以下在暂存项目逐项验证后登记，最终构建与完整验收另附。已完成项目：

### 30.1 内置翻译明确语言快速路径

明确sourceLanguage时只检查Translator，真正auto仍检查Detector；不缓存downloadable，不绕过语言包状态。详见OPTIMIZATION-028-PROVIDERS.md。

测试：独立strict编译通过；builtin新7项+旧13项，共20/20。

### 30.2 缓存故障旁路与有限恢复

辅助缓存ready/read失败不再阻止健康服务翻译；30秒共享恢复窗口、60秒限频无正文告警。密钥Vault和额度账本初始化失败仍严格阻断，保留noCache语义与原人工记忆。详见OPTIMIZATION-028-CORE.md。

测试：独立strict编译；缓存故障专项5/5。

### 30.3 词典初始化、数据库恢复与对齐修订隔离

人工导入与bootstrap串行提交；成功导入revision隔离在途/缓存对齐。不缓存首次IDB打开失败，旧blocked迟到连接自关闭，dispose不破坏新代。前端已有对齐缓存可能仍需刷新。详见OPTIMIZATION-028-ALIGNMENT-MEDIA.md。

测试：独立strict编译；词典修订8+打开恢复6+原对齐性能8，共22/22。

### 30.4 缓存查询与后台通知、读写减负

综合同段共享TM和每档缓存查询；cacheGet改readonly，LRU访问500ms/256key合并，淘汰前提交且不复活旧值。状态按Core共享快照和订阅，普通变化100ms合并、重要错误即时。敏感名单事件失效、迟到失败保守保护；同步同时间计划去重、写入和alarm串行。详见OPTIMIZATION-028-OVERHEAD.md及OPTIMIZATION-028-CORE.md。

测试：Core共享读取5/5；后台减负、LRU故障恢复和状态专项18/18；原同步12/12。独立Edge真实IndexedDB六组检查通过：50次readonly命中→1次touch写，热点淘汰/不覆盖/不复活/人工记忆保持。

### 30.5 远程占位符重试责任去重

remote-node 1.0.2发送可选placeholderRetry:caller，gateway 0.2.1单次尝试，由Core决定重试。老客户端缺省仍两次；非法值拒绝，最终结构校验保留。新增字段是网关JSON兼容扩展，不涉及前端shared协议。详见OPTIMIZATION-028-PROVIDERS.md。

测试：独立strict编译；新6项+旧远程适配器5项，共11/11。完整Core+网关固定失标回放：完整尝试4→2，总推理6→4。

### 30.6 健康探测与真实翻译、休眠状态分离

健康探测不再改生成EWMA/P50/成功率，不以health成功清除翻译熔断；探测错误独立记录，真实生成成功才恢复翻译状态。网关把可接受任务的休眠上游保留在线，models.loaded=false，不因巡检唤醒模型。详见OPTIMIZATION-028-CORE.md及OPTIMIZATION-028-PROVIDERS.md。

测试：Core探测专项4/4；网关休眠专项7/7；旧网关实际临时HTTP回归6/6。

### 30.7 额度预留、发送提交与实际请求限流

等待只预留；取得并发槽后才耐久prepare，最后同步检查可用性和整批额度再提交。慢存储或异步签名不会挤压实际HTTP间隔；无QPS服务停用也在提交前阻止。正常取消未发请求不扣永久用量，崩溃journal保守恢复一次。详见OPTIMIZATION-028-CORE.md。

测试：独立strict通过；额度31项、发送gate12项；连同Core优化14、旧Core39、batcher14和fast22，共132/132。涵盖慢journal并发1/6、异步签名、等待停用/取消与正常非双倍间隔。

### 30.8 OCR故障容器重建与有限重试

超时或通信失败移除旧iframe，最多重建一次；显式模型错误不重试。每次OCR总270秒含排队，1活跃+3排队；旧代迟到结果丢弃，模型hash和10分钟idle保持。详见OPTIMIZATION-028-ALIGNMENT-MEDIA.md。

测试：runner9项+真实offscreen源码接线3项，共12/12；连词典新8和既有对齐8共28/28，独立strict及offscreen noEmit通过。

### 30.9 长段两路并行实测与保留串行决策

同一Q4/6槽、2921字符、3同prompt块、seed42/77、空闲与12后台任务AB/BA共8trial；两组快两组慢，暂不启用。使用较旧独立compiled且本地无quota，此为先导而非最终包对比。详见OPTIMIZATION-028-LONG-CHUNKS.md。

测试：72次推理，请求数/提示词相等、KV全0、stop正常、并发不超过6；AI非盲语义检查发现两策略皆有既有误译，不宣称语义通过。临时模型已关闭，生产串行和参数不变。

### 30.10 混合扫描PDF前端协作交接

已在第14节及专项文档记录页码+扫描正文漏OCR的后端和阅读器双重条件，提出四类夹具与覆盖判断/去重协作；按用户要求不改前端，本轮保持扫描判定。

测试：代码路径确认；未把该限制声称为已修复，也未对用户私人PDF执行猜测性全页OCR。

### 30.11 0.2.8正式包最终验收

实际本机项目typecheck及常规production构建通过；版本0.2.8，后端0.2.8-optimized。独立Edge加载实际正式包，使用临时8083的Q4模型与真实CPU OCR，已完成验收并关闭测试进程。完整记录见OPTIMIZATION-028-RESULTS.md。

测试：完整合约593/593，0失败0跳过；真实流式5组，媒体6组均通过。50次IDB命中→1次touch写的6组专项保持；前端/共享等70文件及HANDOFF第26节发布摘要校验另附。


## 31. 前端：网页竖线的根因、PDF 版面重叠与表格、文章目录、半透明球（2026-11-04，Claude）

本轮只改前端，共享协议没动，后端不用配合。

| 改动 | 文件 |
|---|---|
| **网页上贯穿整页的竖线（根因）**：维基百科「Human」信息框里的地质年代图是「行内 `<span class="noprint">` 包着块级的图」。扫描时把这个 span 当成段落里的行内片段，整张图被拷进了译文；图里那条 1px、`position:absolute; height:100%` 的「现在」刻度线离开了原来 18px 高的定位容器，改成相对整个 `#bodyContent` 定位，于是变成约 1×81000px 的灰线。修复：包着块级元素的行内标签当块继续往里拆（`containsBlock` / `isInlineFlow`）；绝对 / 固定定位的元素不进译文；图表、时间轴上的绝对定位小标签不翻（`isPinnedLabel`） | `content/dom.ts`、`content/scanner.ts`、`content/serialize.ts`、`content/page.ts` |
| **「只翻正文」时文章目录也翻**：维基百科左栏的 Contents 在 `<nav>` 里，以前整块跳过。现在链接里七成以上指向本页锚点的导航 / 侧栏算文章目录，照常翻译（普通导航、侧栏仍跳过） | `content/main-content.ts` |
| **半透明悬浮球翻译后图标消失**：`.on` 状态把图标改成白色，半透明底色上看不见。半透明球的图标始终用深色 / 主题色，翻译后底色带一点主题色 | `ui/ball.ts`、`options/app.ts` |
| **PDF 文字重叠**：① 同一行的字基线有零点几的差别时，左边的字晚到就接不上，一行被拆成两行、分进两段（「where 𝑢 is…」），现在按基线分带后把挨着的片段接回去；② 两端对齐的宽空隙接回时，不再把表格相邻两栏接成一行（前面要有标点、且空隙后面不是一栏的左边）；③ 栏间距只有一个多字宽的表格，按附近几行共同的行首拆成格子；④ 往回找段落时不能跳过同一栏里夹在中间的另一段；⑤ 最后的保险：两段的框仍重叠时改成一行一段 | `pdf/layout.ts` |
| **PDF 公式**：公式编号「(2.13)」不并进段落（以前最后一行被当成靠右、译文压住公式）；只有单个字母变量和公式符号的行不送去翻译；行内公式小图按 em 缩放，不撑高行距；首行缩进开始新的一段 | `pdf/layout.ts`、`pdf/reader.ts` |
| **PDF 表格**：有词的格子照常翻译（以前同一行三段以上的短文字整段跳过，表格一半翻一半不翻），只有数字、缩写、单位的格子不翻 | `pdf/layout.ts` |
| **PDF 译文框可以拖动**（最后的保险）：鼠标移到译文段落上，左上角出现拖动点，拖开后位置记住（`chrome.storage.local` 的 `ui.pdfMoves`，最多 40 个文件），双击拖动点复原；打印时不显示 | `pdf/reader.ts` |

用户的论文在本机只读测试（没有放进仓库）：102 页逐页检查译文框，除了整页都是参考文献的 88–91 页（本来就不翻），没有任何两段译文框重叠。

测试：`run.mjs` 21/21（新增时间轴竖线夹具、文章目录），`media.mjs` 11/11（`fixtures/thesis-mini.pdf` 新增第 6 页行间公式和第 7 页窄栏距三栏表格，加拖动测试）。

**关于第 30.10 节（混合扫描 PDF）**：收到，前端下一轮看「只有页码 / 页眉是文字、正文是扫描图」的判断和去重，做完在这里登记，到时再约定坐标。


## 32. 前端：输入框翻译、原文语言、划词小窗多开、悬浮球三态、服务预设、本地模型自启入口、混合扫描页（2026-11-04，Claude）

已读第 28–30 节：流式 `partial`、`result.timing`、右键菜单带 `selectionText` 前端原来就接好了，实测正常，不用再改。第 30.10 节混合扫描 PDF 前端这一侧已做（见下表最后一行）；第 30.3 节词典重新导入后的对齐缓存，前端加了接收端，请后端在导入成功后发一条命令（见「请后端配合」第 5 条）。

| 改动 | 文件 |
|---|---|
| **悬浮球三种状态**：未翻译（白底）；翻译中（浅主题色底，还没有进度时转圈，有了进度显示进度环）；已翻译（实心主题色，靠页面内侧的角上有一个小对勾，球贴边半藏时也看得见）。`.ball-wrap[data-state]` = `idle / busy / done / error` | `ui/ball.ts` |
| **首屏耗时收起来**：服务状态页只保留顶上一格「首屏出译文」；逐次的耗时条移到页面最下面「诊断：最近几次首屏耗时」，默认收起，标题里只显示中位数 | `options/status.ts` |
| **划词小窗**：① 毛玻璃（去掉了整个小窗的 `opacity`，以前背后清晰的字会透出来）；② 固定以后不限数量，可以同时固定好几个，各自翻译、各自关；③ 顶上可以随手改原文语言和目标语言（存进设置）；④ 选中的已经是目标语言时（例如目标是中文、选中的是中文），自动翻成「输入框翻译」的语言（默认英语）；⑤ 用 Alt+S 打开时焦点给小窗，Tab 可以在按钮之间切换，Esc 关闭 | `ui/selection.ts`、`ui/lang-picker.ts` |
| **原文语言设置**：`UiSettings.sourceLang`，默认 `'auto'`。整页、划词、PDF、图片、段落反馈、`tm:save` 的 `sourceLang` 都改用它（以前全是写死的 `'auto'`）。设置页和划词小窗里都能改；可选语言见 `src/frontend/langs.ts`（新增瑞典语、荷兰语、波兰语、土耳其语、乌克兰语、越南语、泰语、印尼语、阿拉伯语、葡萄牙语、意大利语） | `shared/settings.ts`、`content/page.ts`、`pdf/reader.ts`、`media/images.ts`、`ui/toolbar.ts` |
| **输入框翻译（反向翻译）**：光标在网页输入框里时，右下角（单行输入框是右上角）出现小圆球，点一下把输入框里的文字翻成设定的语言（默认英语）并替换；鼠标停在小圆球上可以临时换语言、撤销、在本站隐藏。快捷键默认 Alt+T（可换 Alt+Y / Ctrl+Shift+Y / 不用），可选「连按三下空格」（中文输入法组字时的空格不算）。选中一部分时只翻选中的部分；多行逐行翻译、保留换行。用 `execCommand('insertText')` 替换，网页自己的 Ctrl+Z 能撤回，React 等框架也能收到 input 事件。密码、邮箱、数字等输入框不出现。设置在 `UiSettings.input` | `ui/input-translate.ts`、`content/index.ts`、`options/app.ts` |
| **「添加服务」里的常用 OpenAI 兼容服务**：DeepSeek、硅基流动、智谱、阿里云百炼、Kimi、火山方舟、OpenRouter、Groq、Mistral、OpenAI、Ollama、LM Studio、vLLM，选一个就填好接口地址（存在 `options.endpoint`，走已有的 `providers:add` + `providers:save`）。模型名变化快，不预填，添加后用「查询模型」选 | `options/providers.ts` |
| **服务设置里支持多行字段**：`AuthField.type = 'textarea'`（给下面请求的「自定义 HTTP 接口」用） | `options/providers.ts`、`shared/protocol.ts` |
| **本机模型卡片**（服务设置里「本地模型」那一页）：「开机自动启动」开关和「立即启动」按钮，走新的 `local:autostart` / `local:start`；后端还不支持时显示怎么手动启动。悬浮球小窗里：启用了的本地模型离线时出现一行「本地模型没有启动」，后端能启动时带「启动」按钮，否则「怎么开」跳到设置 | `options/providers.ts`、`ui/ball.ts` |
| **混合扫描 PDF（第 30.10 节）**：文字层里的段落都在页面最上 / 最下 12%（页眉、页码），中间区域（按纸张底色判断）墨水超过 1.5%、而且像一行行的字（有墨水的行里深浅交替次数的中位数 ≥ 28），就在照常翻译文字层的同时把这一页交给 `pdf:translate`。OCR 回来的段落和文字层段落重叠超过较小框的 40% 的丢掉（页码、页眉不重复）。用户论文 102 页里没有一页误判（附录 93–96 页的工程图因为线条长、交替少，不会被识别）；新夹具 `fixtures/mixed.pdf`（文字层只有页眉和页码，正文是扫描图片） | `pdf/reader.ts` |
| **PDF 表格格子**：判断「这一行有没有写满」时，表格里用这一格所在那一栏的右边，一个格子里的几行不再被拆成好几段分别翻译 | `pdf/layout.ts` |

测试：`tests/e2e/run.mjs` 25/25，新增：悬浮球三态；划词小窗毛玻璃、同时固定三个、小窗里改语言并写进设置、选中中文自动翻成英语；输入框翻译（快捷键 + Ctrl+Z 撤销、小圆球不抢焦点、可编辑区域连按三下空格、密码框不出现）；添加服务的预设和本机模型开关（新夹具 `fixtures/inputs.html`）。`tests/e2e/media.mjs` 12/12，新增混合扫描页。假后端：目标语言不是中文时返回 `[en] 原文`，并把最近一次任务的语言记在 `mock.lastJob`、OCR 次数记在 `mock.pdfOcr`（只给测试看）。

**协议 v2.2（全部可选，老后端不受影响；前端在 RPC 失败时自动退回原来的样子）：**

- `AuthField.type` 增加 `'textarea'`。
- `ExtraProviderTemplate = 'libretranslate' | 'custom-http'`：提议的新模板。**没有改 `ProviderTemplate`**（后端的 `Record<ProviderTemplate, …>` 会编译失败），后端实现时请把它们并进 `ProviderTemplate`。
- RPC `providers:templates`：`req: void → (ProviderTemplate | ExtraProviderTemplate)[]`。前端只显示列出来的新模板。
- RPC `local:autostart`：`{ enable?: boolean } → LocalAutostart { supported, enabled, canStart?, hint? }`。`enable` 不传就是查询。
- RPC `local:start`：`void → { ok, message? }`。已经在运行时直接返回 `ok: true`。
- `ContentCommand` 增加 `{ cmd: 'align-reset' }`：前端收到后清掉页面里缓存的词对齐结果。
- 前端自用的设置（后端不用处理）：`UiSettings.sourceLang`、`UiSettings.input`。

**请后端配合：**

1. **本地模型开机自启（用户这次明确要求，前端入口已做好）**。扩展自己启动不了电脑上的程序，需要后端在 Windows 这边做：
   - 最简单、马上能解决「每次重启电脑本地模型都显示离线」的：`gateway/scripts/enable-autostart.cmd` / `disable-autostart.cmd`，在当前用户的「启动」文件夹（`[Environment]::GetFolderPath('Startup')`）里放 / 删一个快捷方式，目标是 `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<项目>\gateway\scripts\run-local.ps1" -Background`。不需要管理员权限；`run-local.ps1` 已有的互斥锁和状态文件能保证重复启动不会开第二份。
   - 让扩展里的开关和「立即启动」能用：一个本机助手（native messaging host），注册在 `HKCU\Software\Google\Chrome\NativeMessagingHosts\` 和 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\` 下（按用户注册，不要管理员）。助手处理 `status` / `start` / `autostart(enable)`；`wxt.config.ts` 的 `permissions` 要加 `nativeMessaging`（共享文件，请后端加）；`allowed_origins` 要写扩展 ID：解压加载的扩展 ID 跟着文件夹路径走，可以考虑在 manifest 里固定 `key`。然后实现上面的 `local:autostart` / `local:start`。助手没装时返回 `{ supported: false, enabled: false, hint: '先双击 gateway\\scripts\\install-helper.cmd 一次' }`（hint 原样显示给用户）。
   - 可选：翻译任务要用本地模型、它却离线、而助手可用时，自动拉起来一次（按需启动），省得用户点。
2. **更多可自定义接口（用户要求）**：
   - `libretranslate`：开源、可以自己部署。`url` 默认 `http://127.0.0.1:5000`，`key` 可选；`POST /translate`，`{ q: [...], source, target, format: 'text', api_key }`，返回 `{ translatedText: [...] }`。语言代码要映射（`zh-CN` → `zh`，`zh-TW` → `zt`）。
   - `custom-http`：`url`（POST）、`headers`（多行 JSON，可能带密钥，按密钥保存）、`body`（多行 JSON 模板，可用 `{{text}}`、`{{texts}}`、`{{from}}`、`{{to}}`）、`resultPath`（如 `data.translations[*].text`，只做 JSON 路径取值，不能求值）、`batch`（一段一个请求 / 一次发数组）。字段用 `AuthField`（多行用 `type: 'textarea'`），前端会自动显示。
   - 实现后在 `providers:templates` 里列出来，并把这两个并进 `ProviderTemplate`。
3. **原文语言不再总是 `auto`**：用户可以指定（例如很短的瑞典语）。请各家适配器支持非 `auto` 的 `sourceLang`，并补全新增语言的代码映射（`sv nl pl tr uk vi th id ar pt it`，见 `src/frontend/langs.ts`）。哪家不支持这对语言就跳过它、换下一家；都不支持时报一个看得懂的错误。
4. **输入框翻译的任务**：`kind: 'selection'`，按行拆成 `l{行号}` 几个片段，`stream: false`，`targetLang` 通常是英语。这是用户自己写的话，敏感网站上（邮箱、银行）会带 `noCache: true`。
5. **词典重新导入以后（第 30.3 节）**：导入成功时给各标签页发 `{ cmd: 'align-reset' }`（`chrome.tabs.sendMessage`，发不到的忽略即可），前端就会重新取对齐，不用刷新页面。
6. **混合扫描页**：后端接口不用改。前端只在文字层「只有页眉、页码」并且中间像扫描文字的页面上调 `pdf:translate`，坐标仍按 `page.width` 换算。如果以后 `pdf:translate` 能接受 `skipBoxes`（这些区域不用识别），可以省一点 OCR 时间，可选。


## 33. 后端 0.2.9：完成第 32 节六项协作（2026-11-04，Codex）

本轮以 本机项目第 32 节为准。协议号仍为 2，新增可选字段保持兼容；前端正式实现不改。用户单独批准的假后端仅两处类型兼容：模板表改为 Partial<Record<...>>、不支持的模板返回 bad_input。共享协议 ProviderTemplate 合并两新模板，wxt 增加 nativeMessaging；变更先登记在第 13 节。未设置 manifest key，保留原扩展 ID。

### 33.1 本机助手与当前用户登录自启

新增 install/uninstall-helper、enable/disable-autostart 的 cmd/PowerShell 脚本和固定白名单 native host；只注册当前用户 Chrome/Edge，只操作本项目的 Startup 快捷方式。RPC local:autostart 查询真实链接；修改限扩展设置页，local:start 允许本扩展内容脚本以支持悬浮球按钮。未安装助手时返回第 32 节原样提示。启动幂等、并发合并、固定动作无自定义路径/命令、二进制标准流，错误不包含环境和密钥。start 90 秒、状态15秒、切换30秒；端口断开不视为停止模型。详见 INTEGRATION-032-NATIVE.md。

独立 native 12/12、后端控制/RPC 8/8 通过；真实 Edge、实际安装及最终自启状态见 INTEGRATION-032-RESULTS.md。当前用户登录后自启，不是登录前系统服务；可选“翻译任务遇离线自动启动”本次未实现，用户可用既有立即启动按钮。

### 33.2 LibreTranslate 和自定义 HTTP 模板

providers:templates 返回五种已实现模板。新模板默认不启用；LibreTranslate 默认127.0.0.1:5000、可选key、数组请求与中繁体代码映射。custom-http 支持 JSON headers/body、四种变量、安全 resultPath、单段/数组模式；headers和body均进加密Vault，列表只显示掩码。无表达式求值。实际网络请求按batch模式合批与限速。模板/密钥变更隔离缓存和等待批次，真实 secrets:import 也换代，防止旧任务写入错误版本。详见 INTEGRATION-032-PROVIDERS.md。

新增26项 + 既有高级设置9项通过。LibreTranslate使用官方响应合约回放，未部署实际Libre服务或调用收费接口；不宣称其在线译文质量通过。

### 33.3 指定原文语言及不支持语言跳过

llamacpp 1.0.9在非auto时加入明确源语言提示，远程gateway0.2.2同步；auto和既有采样/正文边界保持。新增语言由各家代码映射或透传；腾讯1.0.3用其实际批量API的语言方向表，调度提前跳过不支持服务，全部不可用时返回清楚错误。未给用户自建LLM或动态浏览器语言包硬套静态白名单。适配器语言及相关回归通过，真实Core候选3/3；瑞典语→英语小样本真模型结果见总验收，不作整体精度/提速结论。

### 33.4 输入框逐行反向翻译

复用现有 selection 任务：l0/l1/l2逐行ID、显式语言、stream:false，不发送partial。4项真实startBackend→Port→Core合约确认noCache不读写TM/缓存；银行、邮件及隐身以浏览器sender信息强制保护，不能被任务伪造普通网址绕过。没有改输入框前端。

### 33.5 词典导入后立即刷新对齐

dict:import成功提交后向所有标签页广播align-reset；已关闭、无内容脚本或受限标签页失败不影响导入。导入失败和无权限请求不广播。已完成RPC回归；前端接收端沿用第32节实现。

### 33.6 混合扫描PDF

已修复“只要存在页眉/页码就跳过OCR”的后端缺口。仅当原生文字全在上下12%且中部墨迹/交替阈值匹配文字时OCR；保留原生段落、按40%重叠阈值去除重复OCR，再恢复原PDF坐标排序。普通正文或完整隐藏文字层不多做OCR。未新增skipBoxes或修改阅读器。四类关键页面和空白/图表/噪点反例、坐标/去重共9项通过；最新mixed.pdf真实OCR结果见总验收。详见 INTEGRATION-032-LANG-MEDIA.md，稀疏/浅色/倾斜扫描仍存在启发式边界。

### 33.7 最终验收与交付

最终实际E项目668/668完整合约、typecheck及production构建通过；原前端mock测试25/25，真实Edge启动助手6组、实际本机RPC3组、流式/语言6组、真实媒体7组通过。已安装当前用户助手、启用登录自启，8081模型正常运行。详细原始验收及正式包摘要登记于 INTEGRATION-032-RESULTS.md。日常浏览器由用户重载；独立验收资料夹不读写用户的网页、服务密钥或浏览器设置。原第26、31、32节发布前后校验保留。

## 34. 前端：新手指引、PDF 小圆球、公式与符号不翻、表格不换行、英文界面、键盘操作（2026-11-04，Claude）

以 本机项目第 33 节（后端 0.2.9）为准接上。**协议没有改**，前端用到的都是已有 RPC。

### 34.1 前端做了什么（不需要后端改）

1. **新手指引**（设置页 `#welcome`，五步，每步有自己的地址 `#welcome/basics|plan|local|api|done`，教程页 `#welcome/api/<id>`）：
   - ① 基础设置（目标 / 原文语言、模式、显示、只翻正文、划词、输入框翻译、快捷键）；
   - ② 选方案：检测浏览器内置翻译、WebGPU 显卡（`requestAdapter({powerPreference:'high-performance'}).info`）、本地模型，按结果推荐组合；不需要密钥的官方服务（builtin / local / remote）`providers:test` 通过就自动启用（和以前的快速设置一样）；
   - ③ 本地模型部署：硬件要求、**放在哪里**（`<项目>\runtime\models\…gguf`、`<项目>\runtime\llama-b12069\llama-server.exe`）、按显卡给出 llama.cpp 压缩包名、`start-local.cmd`（`-Cpu`、`-Port 8082`）、`/health`、`install-helper.cmd` + 开机自启开关（`local:autostart`）、常见问题（端口占用、驱动旧、`runtime\logs\*.stderr.log`）；
   - ④ 云端服务：8 家对比 + 每家一步一步的教程（注册 → 开通 → 拿密钥 → 填写），教程页里直接填密钥并测试：内置服务用它自己的 `auth` 字段 → `providers:save` + `providers:test`；大模型预设 `providers:add('openai-compatible')` → `providers:save`（config `{url,key,model}`，editable 含 endpoint 时同时给 options `{endpoint, model}`）；LibreTranslate 用 `providers:templates` 里的 `libretranslate` 模板；
   - ⑤ 试译（`noCache`）并完成（`onboarded: true`）。翻译服务详情页的元信息里加了「详细教程」链接回到对应教程。
   - `rpc.ts` 里引导页测试不弹准备页的判断是 `hash.split('/')[0] === '#welcome'`，子路由同样生效 ✓。
2. **PDF 小圆球**：浏览器自带 PDF 查看器上的入口从胶囊改成可拖动的小圆球（位置存 `chrome.storage.local['ui.pdfBall']`），鼠标停留展开「双栏对照 / 单栏阅读 / 隐藏」。
3. **公式和学术符号不翻**：整行是公式的段落 `skip('formula')`；方程编号旁的 `min / subject to / where` 这类标签一起跳过；正文里单个变量（`N`、粗体 `x`、斜体 `h`）直接换成 **Unicode 数学字母**（U+1D400–1D7FF，斜体 h 用 U+210E）随文本发送；只有带上下标的复杂片段才用 `<xN/>` 占位。表格照常翻。
4. **表格不换行**：表格里的单行格子标成 `cell`，译文不换行、超出宽度时缩字号 / 省略，表头和第一行数字不再合并。
5. **英文界面**：新设置 `uiLang: 'auto' | 'zh-CN' | 'en'`（默认 auto：中文浏览器用中文，其他用英文）。悬浮球、划词小窗、段落工具条、输入框小球、图片按钮、PDF 小圆球与阅读器、设置页外壳和「常用」页已有英文；「新手指引 / 翻译服务 / 服务状态 / 高级」几页暂时只有中文（英文模式下页顶有一句说明）。写法：`L('中文', 'English')`（`src/frontend/i18n.ts`）。
6. **键盘**：悬浮球获得焦点后按方向键（或菜单键）展开设置小窗并把焦点移进去；↑↓ 换控件、分段按钮里 ←→ 换选项、Esc 收起并回到圆球；Tab 出去自动收起。

### 34.2 共享文件的改动

- `src/shared/settings.ts`：`UiSettings.uiLang`（只有前端读；后端不用管）。
- `src/dev/mock-backend.ts`（在 0.2.9 的版本上只加了两处）：假翻译遇到 Unicode 数学字母原样保留；假后端也支持 `libretranslate` 模板（测试新手指引用）。
- `src/shared/protocol.ts`、`package.json`、`wxt.config.ts`：**没动**。

### 34.3 请后端看看（按重要程度）

1. **DeepL 端点按密钥选**：`providers/deepl.ts` 现在固定请求 `api-free.deepl.com`。DeepL 的规则是密钥以 `:fx` 结尾用 `api-free.deepl.com`，否则用 `api.deepl.com`，用错主机会 403——付费（Pro / Growth）用户现在必然 403。请按后缀选主机（translate 和 usage 两处）。
2. **DeepL 免费额度**：DeepL 现在给新用户开的是免费的「API Developer」套餐（新手指引里写的是一次性 100 万字符、不按月重置，请以 DeepL 账户页为准再核实一次）；以前开通 API Free 的老用户仍是每月 50 万。适配器的 `freeQuota: 500_000 / month` 对新用户不准：建议默认值保持但 `quotaText` 写清两种情况，`auth` 标签「API Free 密钥」改成「API 密钥」，用户可以用已有的 `options.quota` 覆盖。如果能从 `/v2/usage` 读到 `character_limit`，直接以它为准最好。
3. **占位符丢失**：真实后端 / 模型偶尔把 `<xN/>` 丢掉（用户截图里方程 2.35 的 `N` 不见了）。前端已经把简单符号改成直接发 Unicode 数学字母，复杂片段仍用占位符。请确认：(a) 后端不对文本做 NFKC 之类的归一化（会把 𝑁 变回 N、丢掉斜体）；(b) 模型输出缺了某个占位符时，`placeholder-fallback` 能把它按原文相对位置补回去，而不是整段丢掉或报错。
4. **新手指引里写死的本机脚本参数**：`start-local.cmd -Cpu`、`start-local.cmd -Port 8082`、日志在 `runtime\logs\llama-*.stderr.log`、健康检查 `http://127.0.0.1:8081/health`、模型 sha256 `DC5F44FC…6699`。以后脚本参数或路径改了，请在交接文档里说一声，前端同步改 `src/frontend/options/welcome.ts`（`local()`）和 `guides.ts`（`LLAMA_BUILDS`、`MODEL_FILE`）。
5. （可选）英文界面下后端返回的 `ErrorInfo.message` 仍是中文，前端原样显示。暂时不用改；以后如果要做，可以在 ErrorInfo 里加可选的 `messageEn`。

### 34.4 验证

- 前端 e2e（假后端）：页面 28/28（新增「新手指引」「键盘」「英文界面」三项），媒体与 PDF 12/12；论文 PDF 本地扫描 1–95 页 0 处重叠、0 次误 OCR。
- 类型检查：精简环境和真实 `@types/chrome` 环境都没有前端错误。

## 35. 后端 0.2.10：DeepL 账户额度与数学占位符恢复（2026-11-04，Codex）

本轮依据 本机项目第 34.3 节。共享协议和全部前端文件保持不变，包括新 `uiLang`、新手指引、`mock-backend.ts` 的两处更新；本轮没有追加协议字段。正式包验收及边界见 [INTEGRATION-034-RESULTS.md](INTEGRATION-034-RESULTS.md)。

### 35.1 DeepL 地址与实际额度

- DeepL 适配器 1.0.2：凭据去除两端空白后，仅结尾 `:fx` 选 `api-free.deepl.com`，其他密钥选 `api.deepl.com`。翻译和 `/v2/usage` 共用规则；空密钥在联网前报错。服务及字段名改为“DeepL API / API 密钥”。
- 已按 [官方套餐说明](https://support.deepl.com/hc/en-us/articles/360021200939-DeepL-API-plans) 核实：API Developer 总计 100 万字符，用完不重置；存量 API Free 每月 50 万。`quotaText` 写明两种规则。官方 `character_limit` / `character_count` 优先，不能从密钥后缀或 100 万上限猜套餐；没有实际账期时不虚构下月补额。
- 读取实际上限后替换旧默认 50 万；显式用户日/月预算独立生效，不能靠用户的“0 = 不限制本地预算”绕过官方零额度。每次实际发送同时预留/提交两层预算，批量请求不漏扣或重复扣。同账户用量查询迟到、乱序、查询期间发送、真实用量下降和后台重建均有测试。
- 账户状态沿用 本机项目已有协议/前端支持的 `period: 'cycle'`，界面显示“周期”，不把一次性额度显示成每月；本轮没有修改这个共享枚举。
- 账户状态按凭据 SHA-256 隔离，明文密钥仍只存 Vault。切换/导入密钥会隔离旧排队批次和旧探测，旧结果不能覆盖新账户。官方账户上限包含成本控制，不能保证等于免费额度；更低的 key 级限制仍以实际 HTTP 456 和既有降级处理为准。
- 详细官方依据、合约回放与局部测试见 [INTEGRATION-034-DEEPL.md](INTEGRATION-034-DEEPL.md)、[INTEGRATION-034-QUOTA.md](INTEGRATION-034-QUOTA.md)。未访问用户 DeepL 账户或消耗付费字符。

### 35.2 缺失原子占位符与 Unicode

- 新公共恢复函数只修复“缺少 `<xN/>`”且其他结构安全的完整译文，保留已生成文字。按同一父组和存留标记锚点定位，再按原文相对位置插入；不打断代理对、组合字素或英文单词。
- Core 在严格重试/叶子拆译前尝试恢复；远程网关也同步恢复（gateway 0.2.3），避免网关先丢掉原始译文。修复仍必须通过完整占位符校验；缺组、重复/新增标记、跨组错位及不确定结构继续原有错误/重试流程。
- 仅带原子占位符的自动翻译缓存加恢复版本标记。普通段落缓存继续复用，人工记忆保持原有严格校验。
- 翻译输入、输出、缓存和记忆均不做 NFKC/NFKD/NFC 等归一化，`𝑁 𝐱 𝛼 ℎ` 与普通字母不会混用。词典/对齐内部检索键的规范化不写回正文。模型自身可能改写字符，与后端字节保留是不同问题。
- 位置补回是结构约束下的相对位置估计，不保证公式在语义重排后总处于精确语义位置。详见 [INTEGRATION-034-ATOMS.md](INTEGRATION-034-ATOMS.md)。

### 35.3 本地教程兼容与前端协作

本轮未改本机模型文件、启动脚本、端口、采样参数、Native Messaging、自启设置或日志路径。`start-local.cmd -Cpu`、`-Port 8082`、`runtime\\logs\\llama-*.stderr.log` 和默认 `http://127.0.0.1:8081/health` 仍一致。模型 SHA-256 为 `dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699`，与 runtime 清单及已有模型文档一致（本轮没有重新哈希大模型文件）。

以后若改变以上参数、路径、二进制版本或模型文件，应同时在本交接文档记录，并通知前端同步 `welcome.ts` 的 `local()` 与 `guides.ts` 的 `LLAMA_BUILDS` / `MODEL_FILE`。本轮前端无需配合。可选英文错误消息暂不新增。

### 35.4 最终验收

实际 E 项目完整合约 **754/754**、类型检查和正式构建通过。真实 Edge + 临时 Q4 模型的缺标故障注入/缓存 **4/4**、流式/语言 **6/6** 通过。前端/共享等 78 个保护文件保持原 SHA-256，原交接全文至第 34 节也保持原摘要。0.2.10 正式包已生成；日常 8081 模型进程和自启设置保持。缺标仅一次模型请求，本地补回两个原子；DeepL 未使用真实计费密钥。详细边界、证据及复现入口见 [INTEGRATION-034-RESULTS.md](INTEGRATION-034-RESULTS.md)。

## 36. 前端：接上 0.2.10，设置页全部英文化（2026-11-04，Claude）

以 本机项目第 35 节（后端 0.2.10）为准。**协议、共享文件都没改**（这一轮没动 `src/shared/**` 和 `mock-backend.ts`）。

1. **DeepL 教程跟上 0.2.10**：字段名改成「API 密钥」；说明免费（`:fx`）和付费密钥都能用、扩展自动选地址；403 的说明去掉「免费密钥用在付费接口」；补一句额度从 DeepL 账户读取、一次性额度显示为「周期 / 总额度」而不是每月。
2. **设置页全部有英文了**：新手指引（含 8 家服务的分步教程）、翻译服务、服务状态、高级四页补齐，英文模式下不再显示「未翻译」提示。`guides.ts` 的 `API_GUIDES` 改成函数 `apiGuides()`。
3. **界面语言先于页面模块确定**：`src/entrypoints/options/main.ts`、`src/entrypoints/pdf/main.ts` 先读设置、`setUiLang()`，再动态 `import()` 设置页 / 阅读器模块，这样模块顶层的文字表（服务类型、健康状态、模板说明等）也按设置的语言生成。正式构建里这两个页面会多一个 chunk，属正常。
4. 仍是中文的地方（数据，不是界面）：后端返回的服务名、`auth` 字段名（如「订阅密钥」「资源地域」）、`quotaText`、`ErrorInfo.message`。英文教程里在这些字段名后面括号注了英文。后端以后若要做英文，可选的做法是在 `AuthField` / `ProviderInfo` 里加可选的 `labelEn` / `quotaTextEn`，前端会优先用；**现在不需要做**。

验证：前端 e2e 页面 28/28（「英文界面」一项扩展到逐页检查新手指引、本地部署、微软教程、翻译服务、服务状态、高级），媒体与 PDF 12/12；精简环境和真实 `@types/chrome` 两套类型检查都没有前端错误。

## 37. 前端：剩余英文、可复现的界面测试构建、README（2026-11-04，Claude）

协议和共享文件都没改。

1. **剩余英文**：YouTube 双语字幕的设置小窗、字幕稿侧栏、播放器按钮提示，整页翻译的失败提示，设置页的主题色名称。YouTube 脚本读到设置后也调 `setUiLang()`。前端界面里剩下的中文只有数据（后端给的服务名、字段名、`quotaText`、错误信息）和语言名表。
2. **界面测试构建可复现**：新增 `tests/e2e/build-ui.mjs`，把内容脚本、设置页、PDF 阅读器、YouTube 脚本照常打包，后台换成 `src/dev/mock-backend.ts`，产物在 `.output/ui-test`（已在 `.gitignore` 的 `.output/` 下）。有 esbuild 就用 esbuild，没有就用 Vite 8 自带的 rolldown，不加依赖。用法：
   `node tests/e2e/build-ui.mjs && node tests/e2e/run.mjs && node tests/e2e/media.mjs`（默认就用 `.output/ui-test`，也可以用 `EXT_DIR` 指定）。
   原因：`npm run test:e2e` 现在是后端端到端测试，前端 `tests/e2e/run.mjs` 的断言按假后端写，之前只能在我的沙箱里跑。**rolldown 这条路我这边没法装包验证，第一次在 本机项目跑如果报错请贴给我。**
3. **README 更新**：去掉「接的是假后端」「图片 / YouTube / PDF 规划中」等过时内容，写明现有功能、安装步骤、方案选择、本地模型位置、前后端各自的测试命令。

### 37.1 可选（不急，需要动 `wxt.config.ts`，归后端 / 共用）

- 扩展名、描述、快捷键说明现在是中文硬编码在 `wxt.config.ts` 的 manifest 里。英文浏览器的 `chrome://extensions` 和快捷键页里仍显示中文。要做的话：加 `public/_locales/zh_CN/messages.json`、`public/_locales/en/messages.json`，manifest 里 `default_locale: 'zh_CN'`，`name` / `description` / `commands.*.description` 改成 `__MSG_xxx__`。文案我可以提供。
- `package.json` 可以加一条 `"test:ui": "node tests/e2e/build-ui.mjs && node tests/e2e/run.mjs && node tests/e2e/media.mjs"`（两个测试默认已经指向 `.output/ui-test`）。

## 38. 后端：扩展原生名称与快捷键中英文（2026-11-04，Codex）

按第 37.1 节及用户本轮明确要求，完成扩展原生名称与快捷键中英文。英文名称由用户确认：**Yi · Local-first Web Translator**。

- 只改 `wxt.config.ts`，新增 `public/_locales/zh_CN/messages.json`、`public/_locales/en/messages.json`；实际前端、后台业务逻辑、共享协议及 package 文件未改。
- manifest 使用 `default_locale: 'zh_CN'` 和 `__MSG_…__` 消息引用，覆盖名称、简介、两个快捷键说明，以及工具栏按钮悬停提示。
- 中文原文保持。英文为：名称“Yi · Local-first Web Translator”；简介“Bilingual webpages, selection translation, and dictionaries, with local models and multiple translation services.”；工具栏“Translate this page (Alt+A)”；命令“Translate / restore this page”和“Translate selected text”。
- 命令 ID、Alt+A / Alt+S、所有权限、扩展 ID 和版本 0.2.10 保持不变；没有引入新依赖或修改第 37.1 节另一条可选的 test:ui 脚本。
- 浏览器扩展管理页、快捷键页及工具栏文字由**浏览器语言**解析，独立于插件内部 `uiLang` 设置。en-US / en-GB 使用 en；zh-CN 使用 zh_CN；未提供的语言回退 zh_CN。没有动态修改用户浏览器语言。

验证：实际 E 项目 `npm run typecheck`、`npm run build` 通过；独立真实 Edge 环境的 en-US、en-GB、zh-CN、de 共 **4/4 通过**，检查 `runtime.getManifest()`、`commands.getAll()` 和 `action.getTitle()`。同时校验 136 个既有源文件/package 文件摘要不变，manifest 其他字段不变。此前真实浏览器把 Alt 返回为大写 ALT，验收按键不区分大小写，命令实际未改。

这次是静态配置及语言资源变更，未重复运行与之无关的翻译合约或模型测试。正式目录 `.output/chrome-mv3` 已重建，日常浏览器重新加载扩展后生效。尚未上传 GitHub / 商店；对外 ZIP 待前端最终完成后统一生成。

原始验证记录位于本次 本机验收工作区 `work/localization-037/typecheck.log`、`build.log`、`browser-report.json`。原生语言机制参考：[Chrome 官方 i18n 文档](https://developer.chrome.com/docs/extensions/reference/api/i18n)。

## 39. 前端：键盘操作补全、用正式构建（真后端）走查新手指引（2026-11-04，Claude）

接第 38 节。协议、共享文件、`wxt.config.ts` 都没改；第 38 节的名称与快捷键本地化已在 本机项目正式构建里确认生效（`_locales/en`、`_locales/zh_CN` 都在产物里）。

### 39.1 键盘

- **段落工具条**：光标 / 选区在某段译文里时按 `Shift+F10`（或菜单键）打开这段译文的工具条，焦点在第一个按钮；`←` `→` `Home` `End` 换按钮，`Enter` 执行；「换一家」菜单里 `↑` `↓` 选、`Esc` 回到按钮；再按 `Esc` 收起，光标回到这段译文。这一次浏览器自己的右键菜单不弹，鼠标右键不受影响。
- **输入框小圆球**：在输入框里按快捷键加 Shift（默认 `Alt+Shift+T`）打开小圆球的面板，焦点在语言下拉框；`←` `→` 在「语言 / 撤销 / 本站隐藏」之间走；`Esc` 收起并回到输入框。
- 新手指引「记住这几个快捷键」里加了这两条。

### 39.2 用 本机项目正式构建走查（真后端 0.2.10 + 最新前端）

把 本机项目 `.output/chrome-mv3` 的后台、离屏页、沙箱原样留着，只换成最新的内容脚本和设置页，在干净的浏览器配置里走了一遍新手指引（中文、英文各一次）。沙箱连不上外网、没有本地模型，所以所有服务的测试都应该失败，重点看失败时的提示对不对。发现并已修：

1. **网络不通时提示「检查密钥」**：误导。现在按 `ErrorInfo.code` 给下一步：`auth` 查密钥 / 地域 / 模型名，`network` 查网络和代理（并说明密钥已保存），`quota`、`rate_limit`、`server` 各有说明。
2. **完成页把「已启用」当成「能用」**：现在逐家 `providers:test`，每个服务后面标 ✓ / ✕，鼠标停上去看原因。
3. **完成页一打开就自动试译**：浏览器内置翻译第一次用某个语言时后端会打开下载语言包的页面，自动试译等于一进页面就弹出新标签。改成用户点「试译」才翻。
4. **悬浮球和服务状态页的免费额度把「未配置」的服务也算进去**（干净配置下显示「剩 270 万」，其实一家都没配）：现在只算已配置的服务。
5. 设置页的浏览器标签标题跟随界面语言。

走查里后端的行为都符合预期：微软 / DeepL 填密钥后 `configured`，智谱预设新建的自定义服务带着 `endpoint` / `model`，LibreTranslate 模板可添加，「查询可用模型」网络失败时有提示，本地模型没启动时自启卡片给出 `install-helper.cmd` 的提示，整页翻译每段显示后端的错误并可重试，页面和设置页都没有脚本错误。

（只是记录，**不需要后端改**）英文界面下这些仍是中文：后端的错误信息（如「翻译服务连接失败或超时」「浏览器语言包尚未准备…」）、`local:autostart` 的 `hint`、内置服务名（如「微软 Azure Translator」）。以后要做的话，可选做法仍是第 36 节提的 `messageEn` / `labelEn`。

### 39.3 验证

前端 e2e 页面 29/29（新增「键盘：段落工具条与输入框面板」），媒体与 PDF 12/12；两套类型检查无前端错误。


## 40. 后端：前端完成后的集成审查与 0.2.11（2026-11-04，Codex）

依据 本机项目第 39 节，按用户此前分工继续不改前端、共享协议和前端测试。详细结果及边界见 [RELEASE-039-REVIEW.md](RELEASE-039-REVIEW.md)。

### 40.1 本轮更新

- 扩展 0.2.11，后台标识 0.2.11-release。npm run zip 增加资源准备；postbuild / postzip 增加正式目录校验，避免干净源码漏 PDF/OCR/ONNX 文件。ZIP 根目录直接包含 manifest.json。
- npm run test:ui 用独立假后端运行前端页面 / 媒体测试；test:e2e 改为正式前端 + 真后台 + 本机 HTTP 回放，修复旧 pseudo 后端与新 mock 断言错配。支持 BROWSER_EXECUTABLE，始终使用临时资料夹。
- 本机默认模型成功启动后保存 CPU、端口、并行、上下文到 runtime/local-model.settings.json；停止后保留，助手和旧自启快捷方式复用，显式参数逐字段覆盖。坏配置拒绝自动启动并明确提示，失败启动不覆盖旧设置。没有操作本机正在运行的模型或现有自启状态。
- 第 34.3 节教程参数和路径未删除：-Cpu、-Port、日志、/health、模型 SHA256 都保持；**新行为是成功参数会被记住**。改端口仍需同步改扩展地址。只保存默认模型 / 程序路径，60 秒内尚未就绪时明确提示未保存。详见 [LOCAL-MODEL.md](LOCAL-MODEL.md)。

### 40.2 需要前端处理

1. **PDF 字体兼容（优先）**：layout.ts 只读字体 name，当前 PDF.js 对象 name 缺失，但 italic/bold 可用，导致 N/x 未转数学字母。正式/UI 包均复现；隔离 A/B 可恢复 𝑁/𝑥。后端无法从普通字母推断原字体，不能靠后端替换字符修复。详见 [PDF-FONT-REGRESSION-039.md](PDF-FONT-REGRESSION-039.md)。
2. **方案页可用状态**：welcome.ts detect() 丢弃 builtin 真实测试结果，plan() 仍用 enabled 显示“可以用”，请同步第 39 节完成页的修复。
3. **新服务二次保存**：welcome.ts 新建服务保存后 current.configured 仍为 false、密钥框已清空，导致再次修改模型要求重填密钥。请刷新本地条目；后端省略密钥的保留行为已经正确。
4. **教程两处**：移动项目应在原路径先卸载助手再移动 / 重装；quota 提示不要对总额度服务一律说等下周期。完整位置及复现见审查报告。

### 40.3 测试与产物

类型检查通过；完整后端 **770/770**；页面 **29/29**；媒体 **11/12**（PDF 数学字母失败，保留原断言）；真实前后端 HTTP 回放 **6 组通过**。正式 ZIP 285 文件逐个校验通过：.output/translate-ext-0.2.11-chrome.zip。**不是全绿验收，尚未上传 GitHub / 商店。**

## 41. 前端：修完第 40.2 节四项 + 输入框小圆球被挤动（2026-11-04，Claude）

以 本机项目第 40 节（0.2.11）为准。协议、共享文件、`README.md`、`package.json` 都没动；`npm run test:ui`（`tests/backend/run-ui.mjs`）照常调用 `tests/e2e/build-ui.mjs`，不用改。

1. **PDF 数学字母（第 40.2.1 项）**：`layout.ts` 改成 `fontInfo()`：粗体 / 斜体以字体对象的 `bold` / `italic` / `black` 布尔属性为准，名字只用来认数学字体，并保留按名字认粗斜体的旧路子。`reader.ts` 的 `getDocument()` 加 `fontExtraProperties: true`，为了拿回字体原名（CMMI / STIX 等）；如果某个 PDF.js 版本仍不给 `name`，样式判断也不受影响。
   测试：`media.mjs` 第 8 页同一页分析两遍，一遍正常，一遍把字体对象的 `name` 去掉（模拟 6.5 的行为），两遍都要求：斜体 N、x → `𝑁` `𝑥`；粗体单字母 w → `𝐰`；斜体单词 *et al.*、*in situ* 保持原样。`thesis-mini.pdf` 第 8 页加了这一句。我这边的 pdf.js 是 6.2.108，**请在 本机项目 6.5.438 上跑一次 `npm run test:ui` 确认 12/12**。
   真论文复查：第 1–87 页 0 处重叠、0 次误 OCR；方程 2.35 下面那句是「Here, 𝑁 is the prediction-horizon length. The vector 𝐱̂(𝑡) …」。
2. **方案页「可以用」（第 40.2.2 项）**：`detect()` 保存每个免密钥服务的真实检测结果。浏览器内置翻译分三层说：浏览器支不支持；扩展里启用没有；英语 ↔ 目标语言的语言包下好没有（直接问浏览器的 `Translator.availability()`：已下载 / 第一次用时下载 / 不支持这个组合）。检测失败时显示后端的原因。
3. **新服务二次保存（第 40.2.3 项）**：预设服务和 LibreTranslate 保存后都从 `providers:list` 刷新本地条目，同页再改模型名保存不用重填密钥。e2e 加了「改模型再保存」。
4. **教程两处（第 40.2.4 项）**：挪项目文件夹改成「先在原位置运行 uninstall-helper.cmd → 挪 → 重新加载扩展 → 新位置运行 install-helper.cmd」，「放在哪里」和常见问题两处都改了。额度用完的提示区分按周期重置和一次性总额度（DeepL API Developer）。CPU 启动那段补了一句「启动成功后参数会被记住」（对应 0.2.11 的新行为）。
5. **用户反馈：输入框小圆球鼠标停一会儿就挪动**。原因是面板展开后和小圆球一起放在 flex 行里，面板比球高 6px，球被垂直居中挤下来 3px。现在面板绝对定位在球的左边，球的位置和大小始终不变；球和面板之间的空隙加了透明桥，鼠标移过去不会收起；左边放不下时面板改到右边。e2e 加了「面板展开前后球的位置相同」。

验证：前端 e2e 页面 29/29、媒体与 PDF 12/12（沙箱里 pdf.js 6.2.108）；两套类型检查无前端错误。


## 42. 最新前端重新打包与本机复验（2026-11-04，Codex）

按用户要求将第 41 节最新前端重新打包，版本保持 **0.2.11**、后台 **0.2.11-release**。本轮未改源码、共享协议、package 或模型设置；构建前后共 154 个源码 / 测试 / 配置文件 SHA-256 一致。

- 实际 E 项目类型检查通过。
- npm run test:ui：独立真实 Edge + 当前 pdfjs-dist **6.5.438**，页面 **29/29**、图片/PDF **12/12**。上次失败的数学变量 N / x 本轮通过；新增粗体 w、普通斜体单词与缺字体 name 的兼容断言也运行通过。输入框小圆球位置与二次保存回归一并通过。
- 刚生成的正式包运行 tests/backend/run-e2e.mjs：**6 组通过**，真实前后端配本机 HTTP 回放，9 次翻译回放请求、1 次健康检查；没有调用付费服务，不代表真实模型质量评测。
- npm run zip 的资源准备、正式构建、目录检查全部通过；ZIP 根目录含 manifest.json，285 个文件逐一与正式目录哈希一致。
- 本轮只重打前端更新，未重复执行未改动的完整后端 770 项；其结果仍是第 40 节记录。

产物：.output/chrome-mv3 与 .output/translate-ext-0.2.11-chrome.zip。**同版本重新构建，已替换上轮旧 ZIP**；大小 50487492 字节，SHA-256：`1b580f3ec203f244d5a6217bcd1cf843e32c4cc35e2c628df15b77e9a0e24dd4`。校验记录见 [repack-041-checksums.json](repack-041-checksums.json)。没有上传 GitHub 或商店。

本轮日志在 本机验收工作区 work/repack041：typecheck.log、ui-tests.log、backend-browser.log、zip.log、zip-check.json。原第 40 节报告及旧校验值保留为历史，不代表此新 ZIP。

## 43. 前端：浏览器内置翻译的语言包下载入口、「翻译服务」改成拖拽调度板（2026-11-04，Claude）

接第 42 节（谢谢在 6.5.438 上复验）。协议、共享文件都没改。**第 42 节的 ZIP 不含本节改动，发出去前要再 `npm run zip`。**

### 43.1 语言包下载入口

用户问：一开始没开内置翻译，还能方便地下载语言包吗？查下来：后台准备页只在「翻译服务」里点「测试」时弹出（`core.test` 的 `prepare`），新手指引里的检测是 `prepare: false`，翻译时也不弹；所以从新手指引进来、内置翻译没启用的用户没有顺手的下载入口，方案页那句「第一次翻译时浏览器会打开一页」也不对。

- 新增 `src/frontend/options/builtin-pack.ts`：在设置页里直接查 `Translator.availability()`，「下载语言包」按钮在点击里第一时间调 `Translator.create({ monitor })`（满足用户手势要求），带进度条；下好后如果内置翻译没启用就 `providers:save` 启用。语言包整个浏览器共用，离屏页翻译时直接能用。「其他语言…」打开后台已有的准备页（`offscreen.html?translatorSetup=1&sourceLang=…&targetLang=…`），没有改后台。
- 用在两处：新手指引「选择方案」的浏览器内置翻译卡片；「翻译服务」里浏览器内置翻译的详情页（新的「语言包」卡片）。
- 方案页不再显示后台那句「需要在可见准备页点击下载」（语言包卡片已经说明并给按钮）；其他失败原因照常显示。

### 43.2 「翻译服务」左栏改成调度板（用户要求）

- 上面两条「档」：**高速档**（快速模式、综合模式第一遍）、**精确档**（精确模式、综合模式第二遍）；下面是**服务库**（全部服务：已配置 / 还没配置 / 非官方）。
- 从服务库拖进某一档 = 加进这一档并启用；档与档之间拖 = 挪过去；拖回服务库 = 从那一档拿出来，两档都不在就停用（保留原来的参与设置，下次启用还原）。库里每张卡片还有「高速」「精确」两个开关按钮，不能拖的时候（键盘、触屏）也能操作。
- 档里的顺序就是调度的实时排名（按速度、成功率、剩余额度），不做手动排序——手动顺序会和自动调度打架，而且同一家服务在两档里共用一个权重。每行有 📌：在这一档里优先用它（和悬浮球里选引擎一样，走状态端口的 `provider-action` pin / unpin，同档只置顶一家）。
- 实现：改的是 `providers:save` 的 `enabled` 和 `options.usedFor`（只在 `editable` 含 `usedFor` 时可拖）；非官方服务第一次放进档里会先确认；放进来的服务没配置时自动打开它的详情让用户填。详情页「调度 → 参与」的两个勾选和调度板是同一份数据。

验证：页面 31/31（新增「拖拽调度板」「语言包下载」两项；语言包用假的 Translator 接口模拟下载进度），媒体与 PDF 12/12；两套类型检查无前端错误。真实浏览器里，语言包状态在我这边的无头 Chromium 上读到的是 downloadable，按钮和卡片正常显示。


## 44. 第 43 节前端重新打包与兼容核对（2026-11-04，Codex）

### 44.1 构建与验收

按用户要求，正式目录与 ZIP 已纳入第 43 节的语言包下载入口、服务拖拽调度板。保持扩展 **0.2.11**、后台 **0.2.11-release**；本轮不修改源码、共享协议、package 或模型配置。155 个源码 / 测试 / 配置文件构建前后摘要一致。

- 类型检查通过。
- 独立真实 Edge + 假后端界面回归：页面 **31/31**、图片/PDF **12/12**（本机 PDF.js 6.5.438）。语言包下载测试使用模拟 Translator 接口验证按钮 / 进度 / 启用流程；没有实际下载语言包，不能扩大为所有浏览器版本的真实下载验收。
- 刚生成的正式包，真实前后端配本机 HTTP 回放：现有 **6 组通过**，9 次翻译回放请求 / 1 次健康检查。覆盖流式显示、耗时、链接、缓存及密钥持久化，不包含两档独立 pin 的业务承诺。
- npm run zip 资源准备、构建、正式目录检查均通过；ZIP 根目录 manifest.json 存在，285 个文件逐个与正式目录 SHA-256 一致。
- 后端代码未改，未重复运行第 40 节已通过的 770 项完整后端合约。

产物为 .output/chrome-mv3 与 **.output/translate-ext-0.2.11-chrome.zip**；同版本新构建已替换第 42 节旧包。大小 50491465 字节，SHA-256：`3ebe7d149805cb9c32a065d8b3816aa8b8ea286a5f201deda7fddce458a28b81`。最新校验记录：[repack-043-checksums.json](repack-043-checksums.json)。未上传 GitHub / 商店。

### 44.2 调度板待前端协调的语义（源码核对，非本轮修复）

1. **按档置顶与现有全局置顶不一致。** providers.ts:246–257 的 pinIn(tier, id) 只遍历某档，但发送的 provider-action 不含 tier；core.ts:945 仅保存服务级 config.pinned。同一服务同时在两档时，一档 pin / unpin 会影响另一档。应先按当前全局语义修改界面说明 / 操作，或另行约定兼容的按档协议，不能宣称当前已实现两档独立置顶。
2. **精确档显示顺序不能当成其实际调度排名。** providers.ts:323 两档使用同一 status.rank，core.ts:1009 的 snapshot 排名固定按 fast 生成。精确候选的实际优先级可能不同。建议明确当前显示含义，或以后约定独立的按档排名字段。
3. **后备例外需要说明。** core.ts:305–307 对 local / builtin 保留跨档后备；把本地模型移出某档不等于该档永远不会用到它。这是现有不中断翻译的策略，本轮未改变。

语言包入口直接点击调用 Translator.create、更多语言链接以及 providers:save / options.usedFor 的请求格式与现有后端兼容，未发现新增 RPC 字段缺口。以上调度板限制不会阻止构建，但不能以界面测试通过代替真实调度语义一致。

本轮日志位于 本机验收工作区 work/repack043：typecheck.log、ui-tests.log、backend-browser.log、zip.log、zip-check.json。

## 45. 前端：输入框小圆球可拖动、调度板滚动与第 44.2 节三点、服务状态「检测」有反馈 + 自动同步额度、语言包下拉框（2026-11-04，Claude）

接第 44 节。协议、共享文件都没改。**第 44 节的 ZIP 不含本节改动，要再 `npm run zip`。**

### 45.1 用户这一轮提的

1. **输入框小圆球可以拖动**：按住移动超过 4px 才算拖，没拖就是普通点击（照常翻译）；拖完不翻译、输入框焦点不丢；位置按网站记在 `chrome.storage.local['ui.inputBall']`（`{ [hostname]: { dx, dy } }`，相对默认位置的偏移，最多离开输入框 30px，不出屏幕）；面板里多了「复位」。
2. **调度板拖到边缘自动滚 + 滚动手感**：左栏不再是套在页面里的第二个滚动区（以前一会儿滚里面、一会儿滚外面），跟页面一起滚；拖动时靠近窗口上下边缘 72px 内自动滚，越靠边越快、平滑加减速。状态快照内容没变就不重画（以前每几秒重画一次，会打断悬停和焦点）。
3. **「优先」改成文字小标签**：去掉 📌 图标，平时隐藏，鼠标移到那一行才出现；选中后是主题色实底。
4. **服务状态页「检测」按了没反应**：后台 `probe` 只做健康检查、按设计不改延迟和成功率（第 0.2.x 的约定，没问题），所以界面上看不出变化。现在「检测」同时 `providers:test` 真翻一句，按钮变「检测中…」，结果写在那一行下面（✓ 可用 · 312 ms / ✕ 原因 · 刚刚）；顶部加「全部检测」（3 家并发；浏览器内置翻译只做健康检查，免得弹语言包页面）。**P50 延迟和成功率仍只来自真实翻译**，这次测试的延迟单独显示。
5. **自动同步剩余额度**：服务状态页打开时和之后每 5 分钟发一次 `probe`（全部），能查账户的服务（DeepL）借此同步实际用量；额度总览下面加了一句说明，哪些是账户实时、哪些是本机计数。
6. **语言包「其他语言」改成下拉框**：前端的语言包卡片里，选了原文，译文下拉框每个选项后面标「已下载 / 可下载 / 不支持」（不支持的灰掉），反过来也一样；不再链接到准备页。

### 45.2 第 44.2 节三点

1. **按档置顶**：界面改成和后台一致的「按服务」语义：「优先」是服务级的，同一家在两档里时两档都优先，提示里写明；置顶一家时只取消和它同档的其他服务的置顶。**不需要后端改**；以后想要真正分档置顶，可以加 `provider-action` 的可选 `tier` 字段。
2. **精确档顺序**：快照的 `rank` 是按高速档排的，所以精确档不再显示名次（显示「·」），按「优先 → 权重 → 延迟」排；只有高速档显示实时名次。（可选）以后 `ProviderStatus` 加 `rankByMode?: { fast?: number; accurate?: number }`，前端就能两档都显示真实名次。
3. **本地 / 内置的跨档兜底**：本地模型、浏览器内置翻译的「移出」按钮提示里写明「这一档平时不用它；别的服务都不可用时仍会拿它兜底」。

### 45.3 请后端看看（用户反馈）

**浏览器内置翻译的准备页**（`entrypoints/offscreen/browser-translator-setup.ts`，你的目录）：用户觉得手填 `en` / `zh` 语言代码很不直观，希望改成下拉框，选了一边，另一边列出可选的。两种做法任选：
- **推荐**：`openBuiltinSetup` 改成打开设置页的语言包卡片：`options.html#providers/<内置翻译的 id>`。那张卡片（`src/frontend/options/builtin-pack.ts`）已经有下拉框、逐项标「已下载 / 可下载 / 不支持」、进度条，还会顺手启用内置翻译；两边只维护一个界面。卡片没有可选的 LanguageDetector 模型，扩展用 CLD，不影响。
- 或者在准备页里把两个输入框换成下拉框，语言列表和代码映射可以照 `src/frontend/langs.ts` 的 `LANGS`（`zh-CN` → `zh`，`zh-TW` → `zh-Hant`），选了一边用 `Translator.availability()` 给另一边标状态。

验证：前端 e2e 页面 32/32（新增「输入框小圆球拖动」，「服务状态检测」「语言包下拉框」并进原用例），媒体与 PDF 12/12；两套类型检查无前端错误。


## 46. 后端接入第 45 节与 0.2.12 正式包（2026-11-04，Codex）

### 46.1 已实现

按第 45.3 节推荐方案，`index.ts` 的 `openBuiltinSetup` 使用新的 `builtin-setup.ts`，打开 **`options.html#providers/browser-translator`**。显式检测发现语言包可下载或正在下载时，直接到前端现有语言包卡片，可使用语言下拉框、状态标记和进度条。没有再维护一套新下拉框，没有修改前端或共享协议。

- 精确复用该服务的现有标签页，只激活标签并聚焦窗口，**不重新导航**，不清除卡片已选语言或打断下载。并发打开合并为一次；标签在查询后被关闭时复查再创建；普通激活/聚焦失败不会制造副本，后续显式操作可以重试。
- 其他服务详情页、首次引导和带其他参数的页面不改写。旧 `offscreen.html?translatorSetup=1` 保留兼容，后端检测不再导向它；旧直接链接的输入框仍保留，若未来去除应另行约定。
- 自动健康探测、首次引导的 `prepare:false`、浏览器不支持 API 时仍不打开页面。打开卡片只查询状态，下载仍必须由用户点击触发。打开失败保留原始检测错误，不谎称已经打开。
- 更新 backend engine / adapter 的旧“准备页”提示，指向设置中的语言包卡片。适配器 `browser-translator` 升至 **1.0.1**，扩展 **0.2.12**，后台 **0.2.12-release**；其他翻译服务、模型参数、自启脚本、权限及依赖没有更改。

### 46.2 语言方向与前端后续小项

1. **检测方向仍是英语→简体中文**：保留现有 `providers:test` 的英文样本与 `auto` 源语言检测；原健康检查也仍使用 en→zh-CN。本轮提示明确说明方向，卡片方向不同时请在“其他语言”选择。卡片默认读取全局目标语言，不读 URL 的临时 source/target；后台没有为跳转偷偷改写用户语言设置。目标日语和目标英文均已回归。若之后希望失败的语言对自动预选，应由前端增加临时 pair 参数读取，再协调后端传入；不是本轮新增协议要求。
2. **待前端改进，未阻断本轮构建**：服务原来停用、全局目标为日语时，用户在卡片里改为英语→中文并下载，成功后自动启用服务会触发 `onChange`，父详情页重画，新卡片又恢复英语→日语，显示这个方向还未下载。这会让用户以为刚才的下载没成功；已下载的英语→中文包没有丢失。建议自动启用刷新时保留卡片临时 pair，或避免因此重建卡片。复现位于 `builtin-pack.ts` 的 `enabled !== wasEnabled` 回调及 providers 详情重画；本轮不改前端，测试截图保留于日志目录的 `builtin-browser/language-pack.png`。
3. 第 44.2 节的三项语义，已核对最新第 45.2 节按服务优先 / 精确档不显示伪排名 / 跨档兜底提示；本轮不新增 `tier`、`rankByMode`，不改变实际调度。

### 46.3 验证

| 检查 | 结果与边界 |
|---|---|
| 实际 E 项目完整类型检查 | 通过 |
| 完整后端合约 | **783/783**；比此前增加 11 个导航测试、2 个 core 回归；首次执行一项新增断言漏写已有 provider 字段，修正测试期望后完整重跑全绿 |
| 最新前端 UI 回归 | **页面 32/32、图片/PDF 12/12**；独立 Edge、假后端、PDF.js 6.5.438；包含输入框球拖动、状态页检测及语言包下拉框 |
| 正式包真实前后端联调 | **6 组通过**；本机 HTTP 回放 9 次翻译、1 次健康检查；包含缓存/密钥持久化、SSE partial/final、耗时、链接及原文还原 |
| 新入口正式浏览器专项 | **4 组通过**；真 core/RPC/bridge/Chrome 标签页导航、真实点击和用户手势，浏览器模型响应、CLD 与下载 API 受控模拟；没有实际下载语言包，不能当作真实模型下载/翻译质量验收 |
| 正式目录 / ZIP | 资源准备、构建和 34 个入口/资源检查通过；ZIP 285 个文件逐一与正式目录 SHA-256 一致，根目录包含 manifest.json |

`tests/backend/builtin-setup-browser.mjs` 为新浏览器专项入口；`builtin-production-browser.mjs` 已适配新卡片并从 package 读取版本，但本轮未运行其真实语言包下载。另四个现有真实模型专项脚本同步 0.2.12 版本断言，本轮未运行这些专项。

前端/共享/前端测试及 wxt.config 共 **69 个保护文件**构建前后哈希一致；没有覆盖 Claude 的源码更新。日志保存在 本机验收工作区 `work/integration045`：typecheck.log、backend-tests-final.log、ui-tests.log、backend-browser.log、builtin-browser.log、builtin-browser/report.json、zip.log、zip-check.json、source-changes.json。

### 46.4 交付

- 正式目录：`.output/chrome-mv3`。
- 新版 ZIP：`.output/translate-ext-0.2.12-chrome.zip`，**50495123 字节**，SHA-256：`58ec814295ba6cfe7677d9e2f9912e15f75da132e34ea5fd4ec1c1b295f0a1bc`。
- 校验记录：[release-045-checksums.json](release-045-checksums.json)。第 44 节的 0.2.11 ZIP 是历史包，不含本轮改动。
- 在扩展管理页重新加载原 `.output/chrome-mv3`，再刷新使用中的网页即可测试。未操作用户日常浏览器，未上传 GitHub / 商店。

## 47. 前端：第 46.2 节语言包卡片保留方向、服务状态只列已启用服务 + 检测结果样式、弹性标签栏里译文对齐（2026-11-04，Claude）

### 47.1 第 46.2 节第 2 项：自动启用后卡片不再恢复默认方向

`builtin-pack.ts` 加了模块级的临时记忆（只在当前设置页里，不写存储）：用户在卡片里选的语言对、下拉框是否展开、下载完成的结果文字。自动启用触发 `onChange`、父详情页重画后，新卡片读回这份记忆，仍是刚才的「英语 → 中文」并显示「已下载」，不会回到全局目标语言。全局目标语言变了（`target` 不同）就不沿用。后端协议没变，`onChange` 仍只在启用状态真的变化时调用。

回归：`run.mjs` 的语言包一步新增「先停用、目标日语、在卡片里改选 en→ko 并下载」，断言重画后下拉框仍是 ko、文字为已下载；假 `Translator` 改成按语言对记下载状态（sessionStorage）。

### 47.2 服务状态页

- **只列在「翻译服务」里启用的服务**（`enabled`，暂停的照样列出来方便点「恢复」）。以前高速池按 `official && usedFor.includes('fast')` 过滤，不看 `enabled`，所以没启用的「腾讯云翻译（存量用户）」等一直出现在高速池。没启用的只在表格下面一句话列名字，并链接到 `#providers`。
- 高速池 = 启用且 `usedFor` 含 fast；精确 = 启用且含 accurate，**不显示名次**（快照 `rank` 只按高速档排，见第 44.2 节），按优先 → 延迟排序；非官方 = 启用的非官方接口。
- 「检测」结果改成小胶囊：绿 / 红 / 检测中三种底色加圆点，成功显示「● 123 ms　刚刚」，失败显示错误摘要（超长省略，鼠标停留看完整错误和检测时刻）。检测逻辑与第 45 节相同（`probe` + `providers:test`），没改消息。

### 47.3 弹性布局标签栏里的行内译文对齐

现象：文档站顶部 Guides / API Reference 一类标签（固定高度的 flex 标签，`align-items: center` 或靠下），译文比原文高出一截，不在同一条线。

根因：`style.ts` 全局给 `tx-t` 设了 `align-self: flex-start`（防止在 flex / grid 里被拉伸成整行高、竖线样式出现贯穿长线），它无视了容器的 `align-items`，译文这个 flex 项被顶到最上面。

修法（纯 CSS）：去掉 `align-self: flex-start`，改为 `height: fit-content`。拉伸只作用于高度为 auto 的项，所以防拉伸仍然有效；容器是 center / flex-end 时译文跟原文一起居中 / 靠下。`layouts.html` 加了三种标签（居中、靠下带内边距、文字在带上边距的 span 里），`run.mjs` 断言三者译文与原文竖直中心差 ≤ 2px；原有的「不被撑高 / 不出现贯穿竖线」断言照旧通过。

### 47.4 验证与交付

- 页面 **32/32**、图片 / PDF **12/12**（假后端）；云端与 `@types/chrome` 两套类型检查通过（后者仅 `entrypoints/background.ts` 原有的 contextMenus 类型差异）。
- 改动文件：`src/frontend/options/builtin-pack.ts`、`src/frontend/options/status.ts`、`src/frontend/content/style.ts`、`tests/e2e/run.mjs`、`tests/e2e/fixtures/layouts.html`。没有改后端、共享协议、manifest 或 package.json。
- 第 46.4 节的 0.2.12 ZIP 不含本节改动，需要重新 `npm run build` / `npm run zip`；建议 Codex 顺手用真实后端复核状态页过滤（停用的服务不出现、精确表无名次）和标签栏对齐。


## 48. 第 47 节重新 build + zip 与真实后端复验（2026-11-04，Codex）

### 48.1 交付范围

按用户要求读取最新第 47 节，顺序执行 **npm run build** 和 **npm run zip**，版本保持 **0.2.12**、后台 **0.2.12-release**。已纳入语言包卡片方向保留、服务状态过滤与检测结果样式、文档站顶部 flex 标签对齐。没有修改前端、后端产品逻辑、共享协议、manifest、package 或本地模型设置；构建前后 **156 个源码 / 前端测试 / 配置文件 SHA-256 一致**。

后端测试目录新增 tests/backend/handoff047-browser.mjs，增强 builtin-setup-browser.mjs，防止只在假后端或旧卡片短暂成功状态下通过。产品源码未改，因此没有重复运行第 46 节已通过的 783 项完整后端合约。

### 48.2 用户指定的真实后端验收

全部加载刚生成的正式包，在独立 Edge 临时配置中执行，后台 / RPC / 状态端口 / 内容脚本均是真实现；模型接口使用本机 HTTP 回放，无真实云密钥，不消耗翻译额度。这是联调与布局验收，不是本地模型质量或真实文档网站的全面兼容评测。

1. **停用服务不在状态表出现：通过。** 先通过真后台启用微软服务和本地服务；再在“翻译服务”的微软详情真实点击启用开关关闭、点击保存，确认后端 enabled=false 后切到服务状态。微软已从所有服务表行移除；未启用服务允许出现在表格下方的说明文字中。启用但暂停的本地服务仍在快速 / 精确两表中，能够点击恢复。
2. **精确表无排名：通过。** 真后端快照中本地服务的快速排名为 **1**；精确表的首列表头及所有排名单元格均为空，未误用快速档名次。
3. **顶部标签原译文同线：通过。** 使用最新 tests/e2e/fixtures/layouts.html 的居中、靠下带内边距、文字 span 带上内边距三种标签，点击真实悬浮球，经过内容脚本→后台→本机 HTTP→最终译文。按原文文本 Range 与译文框实测竖直中心差，阈值≤2px：

| 原文 | 最终译文 | 竖直中心差 |
|---|---|---|
| Guides | 指南 | 0.500 px |
| API Reference | 接口参考 | 0.500 px |
| Released Notes | 发布说明 | 0.000 px |

同时验证没有译文框被撑高 / 挤成窄条、没有克隆 absolute/fixed 图形、没有贯穿正文的细竖线、没有在时间轴标签或页面 grid 骨架中新增错误译文项。专项共 20 次本机翻译回放请求，2 次健康检查；没有页面脚本错误。

### 48.3 语言包与其余回归

- 第 46.2.2 节修复已复验：停用内置服务、全局目标日语，卡片临时选择英语→中文；模拟下载成功并真实保存启用状态后，**确认旧卡片节点已经被替换**，再断言新卡片仍选英语→中文、下拉框展开、已下载状态保留、下载按钮隐藏，全局目标语言未改。该方向仅在当前设置页生命周期内记忆，不意味着浏览器刷新后持久保存。
- 类型检查通过；UI 页面 **32/32**、图片/PDF **12/12**（本机 PDF.js 6.5.438，独立假后端 UI 套件）。
- 常规正式前后端 HTTP 回放 **6 组通过**，9 次翻译 / 1 次健康检查，覆盖配置、状态、翻译端口、缓存/密钥持久化、SSE partial/final、链接和原文还原。
- 新第 47 节正式浏览器专项 **3 组通过**；语言包入口专项 **4 组通过**。语言包 API、CLD 和模型返回受控模拟，没有实际下载浏览器语言包。
- build / zip 的资源准备、正式目录 **34 个入口与资源**检查通过；ZIP **285 文件**逐一与正式目录哈希相同，根目录直接包含 manifest.json。

证据位于 本机验收工作区 work/repack047：typecheck.log、build.log、zip.log、ui-tests.log、backend-browser.log、builtin-browser/report.json、handoff-browser/report.json、handoff-browser/status-paused.png、handoff-browser/layout-translated.png、source-verification.json、zip-check.json。

### 48.4 正式包

- 正式目录：.output/chrome-mv3。
- ZIP：.output/translate-ext-0.2.12-chrome.zip，**50496296 字节**，SHA-256：fe1ffb4029074dc7982086ff649376f5809249c1213952e26c42f5840e01a06e。
- 校验记录：[repack-047-checksums.json](repack-047-checksums.json)。**同版本新包已覆盖第 46 节旧 ZIP**，旧摘要仅保留作历史。
- 用户原来加载的目录已经更新；在 Edge 扩展管理页重新加载扩展、刷新网页即可使用。未操作日常浏览器、未上传 GitHub 或商店。


## 49. 前后端八项优化、MIT 与 0.2.13 正式交付（2026-11-04，Codex）

用户授权本轮同时修改前后端，并明确采用 MIT。完整实现说明、协议规则、验收结果与限制见 [OPTIMIZATION-0.2.13.md](OPTIMIZATION-0.2.13.md)。本轮无待前端配合的必做项。

### 49.1 已完成的八项

1. **检测与统计**：自动 probe 只做 health，不重复试译；显式检测计实际额度/错误，但不污染正文 P50、EWMA、成功率与排名。RPC 可传本次语言方向，欢迎页仍不自动开准备页。
2. **扫描 PDF 失败/重试**：成功、失败、保留项分别统计；页级异常可重试；打印有失败不自动输出；初始计数显式为零。
3. **取消/释放**：图片代际防迟到回写；任务按来源隔离；共享 OCR 最后订阅者退出才中止，活动容器真正销毁；PDF 换文档释放旧文档、监听器、端口、渲染和后台会话。
4. **内置翻译**：真实语言对负缓存 15 秒；auto 先识别；手动检测/下载后失效，语言包方向锁定及迟到返回保护；适配器 1.0.2。
5. **长 PDF**：一次上传/解析、逐页句柄复用；前端书签优先、按阅读页缓存扫描；画布目标 8 页/2400 万像素，保留译文后本地重画；没有可靠书签时首次跳到后页仍可能扫描此前文字层，打印期间暂时保留全本画布。
6. **状态页面**：增量更新，保留服务行/按钮和焦点；停用服务不显示，精确表不显示高速排名。
7. **资源瘦身**：仅同字节 WASM 去重并改写引用，两种 ONNX 版本分别保留；去掉无用 SDK 分发文件。ZIP -31.3%，解压目录 -38.0%。
8. **交付**：独立 Windows x64 模型安装 ZIP、固定来源和哈希、可恢复运行库切换、MIT/LICENSE、PRIVACY.md、统一 verify:release、构建编号和 ZIP 完整性检查。未发布 GitHub 或商城。

### 49.2 协议与边界

- 协议版本为 **3**，所有增量字段和媒体能力标志均可选，旧调用保留。新增 `media:cancel`、`pdf:open`、`pdf:close`；`ocr:image/pdf:translate.requestId`、`pdf:translate.documentHandle`、`providers:test.sourceLang/targetLang`、`ping.buildId`。
- PDF 内存会话最多 3 份，原始输入合计 64 MiB、单文件仍限 25 MiB，5 分钟闲置销毁；不是整个浏览器的内存上限。失效固定 `bad_input` + `retryable:true` +「PDF 会话已失效，请重新打开文档」，前端透明重开一次。
- 取消来源包含 extension/tab/frame/document，requestId 为 1–128 个字母数字或 `._:-`；最多 64 在途 ID，取消墓碑 256 项/30 秒；敏感来源继续强制 noCache。
- `run-local.ps1` 的既有参数、8081、runtime/logs、/health 和 Q4_K_M SHA 未变。新增独立安装工具见 [LOCAL-INSTALLER.md](LOCAL-INSTALLER.md)，不要求源码或 Node.js。Windows x64 自动 CPU/CUDA；开机自启仍需用户开启。运行库清单为 `runtime/llama-b12069/.yi-setup-runtime.json`，切换模式的旧目录保留为 `runtime/previous-<GUID>`，不覆盖用户增改文件。
- MIT 只覆盖自有代码，第三方/模型/运行库继续适用各自许可证。

### 49.3 验收与交付

类型检查通过；后端 **834/834**、前端 UI **44/44**、正式后台 **6 组**、语言包 **4 组**、第47节 **3 组**、媒体 **7 组** 均通过。另完成服务状态专项 **5/5**、安装工具 **8/8**（后端测试子集）、正式包真实离线 OCR/对齐模型验证。对齐验证不等同于完整词对齐质量评测，云端/API 翻译用本机 HTTP 回放而非真实扣费服务。

构建编号 `0.2.13-bae7b5db8661`；扩展包 `.output/translate-ext-0.2.13-chrome.zip`（34,694,478 字节）；独立安装工具 `.output/yi-local-setup-0.2.13-windows-x64.zip`（30,629 字节）。哈希、详细结果与证据路径见完整优化记录。正式目录及两个 ZIP 已逐文件校验。


## 50. GitHub 公开前整理与干净源码构建（2026-11-04，Codex）

按用户要求完成个人信息 / 本机路径清理、.gitignore、README、发布说明与源码导出。未上传、未初始化 Git；版本保持 0.2.13。完整记录见 [PUBLISH-PREP-0.2.13.md](PUBLISH-PREP-0.2.13.md)，发布步骤见 [PUBLISHING.md](PUBLISHING.md)。

- 匿名化 33 份历史文档；3 个诊断脚本改为相对路径或显式输入；前端仅将新手指引的本机目录文字改为通用示例，未改 UI 逻辑。第三方许可和测试资料来源保留。协议、模型参数、端口、自启行为与权限不变。
- 新增 zip:source，按 Git 忽略规则生成附带逐文件 SHA-256 的源码 ZIP；拒绝本机模型、真实环境文件和链接 / 越界路径，防止输出覆盖外部链接。Git 是此命令及其测试的额外要求，普通构建不需要 Git。
- 新目录独立 npm ci 和完整 verify:release 通过：类型、后端 **837/837**、UI **44/44**、正式后台 **6 组**、语言包 **4 组**、第 47 节 **3 组**。末尾打包防护调整再通过 3 项定向测试和 6 组正式后台回归。未重跑真实 OCR / 对齐权重专项，没有消耗云端翻译额度。
- 最终构建 **0.2.13-8931b5a47e37**；干净副本和工作目录源码摘要相同。正式扩展 / 独立安装 ZIP 分别校验 **272 / 23 个文件**；当前摘要见 [release-050-checksums.json](release-050-checksums.json)，第 49 节扩展包哈希为历史。
- 来源文件、清理检查和 PDF / PNG 夹具元数据均已检查；不要将被忽略的本机备份、日志、模型、依赖或实际个人文档加入首次提交。


## 51. 动态菜单与快速点击卡顿、图片翻译按钮拖动

2026-11-05，扩展 0.2.14。用户反馈在打开下拉菜单、页面更新或快速点击时偶发卡住。以下是能在独立 Edge 重复触发的问题。

| 场景 | 修复前 | 本轮处理与复测 |
|---|---|---|
| 菜单逐层创建并复用节点 | 浏览器回归中的 3 个条目每个出现 34 份译文。已卸载节点再次接回时还可能漏翻 | 合并本轮新增子树，并及时清理旧段落索引。每个条目仅生成一份译文，反复打开和还原通过 |
| 翻译规则尚未返回时快速开关 | 连续切换触发旧启动回调访问已释放的状态 | 每轮启动单独管理取消信号。等待规则、等待元素以及观察器回调均检查该轮是否有效。连续点击后由最后一次操作决定状态 |
| 网页同步清理插件浮层 | 对照测试中，浮球在下一次定时事件前反复重挂 100 次，达到测试保护上限 | 将恢复放到后续任务，连续移除时延长间隔。浏览器可以处理输入，清理结束后浮球恢复 |
| 长文本扫描 | 连续标识符反复尝试匹配邮箱；软换行会反复读取整段前文 | 同一合成样本中，32,000 个连续 ASCII 字符的序列化约 515 → 1.7 毫秒；1,400 行软换行读取 textContent 约 197 万 → 7,004 次。测量只覆盖相应的处理步骤 |

图片翻译浮球优先选择未被网页控件占用的角落。主要指针按住拖动达到 4 像素后移动，松手不会发起 OCR。每张图片在当前页面内分别记住相对位置。回归包括拖走后点击原网页按钮、普通点击、图片改宽和页面缩放。

类型检查通过。后端及合约 839/839，界面 49/49（页面 35，图片及 PDF 14），正式后台浏览器联调 9 组通过。正式联调使用真实扩展和本机 HTTP 模型回放。回放网址属于敏感站点，菜单卸载后重新展示可以重新请求，测试分别检查每轮稳定展示的译文数量及总请求数。

本轮修复通过可复现的本地菜单夹具、快速开关与浮层冲突用例验证；原反馈未提供具体网址。发布说明见 [RELEASE-0.2.14.md](RELEASE-0.2.14.md)。


## 52. 动态网页交互与性能回归

2026-11-05，扩展 0.2.15。基线是 0.2.14。旧版打开动态菜单的修复保留，这轮进一步复现和修复大量条目同时可见、虚拟列表替换旧节点、网页整体切换主体和动态字幕等情况。

| 测试场景 | 实现及结果 |
|---|---|
| 密集菜单和网格 | 将子树扫描、可见条目处理分到多个浏览器任务，视口内条目优先。480 格回归中，按钮在所有译文插入前已响应。800 格中途还原，滚动和新增条目后仍保持原文 |
| 无限滚动、重绘 | 12,000 行列表滚至尾行后可翻译。768 格分别作同文重绘和全部改文，最终每格各有一份译文，已移走的节点退出待处理队列 |
| 节点复用 | 相同文本重绘可复用已有译文，保留链接与代码的新内容。仅修改 href、重排行内菜单、逐句重绘、还原原文以及原链接点击均有回归 |
| 流式写入与动态可见性 | 从空文本逐字写入、同一行连续更新 24 次后保留最新结果；预渲染 hidden 菜单、原生 details 折叠区展开后能翻译 |
| 单页应用和正文范围 | 连续更换四次 body，旧任务结束，新页面及后加的段落可翻。正文计分改为每段一次、由内向外累加；250 种生成布局的正文过滤结果与旧算法一致 |
| 动态播放器 | 网页清理按钮时退避恢复；字幕容器替换后切换监听。一次短时的 60 次逐词变更合并为一次翻译请求。超过单行上限的字幕保留原文，后续正常字幕可继续翻译 |

**浏览器响应测量**　同一台 Windows 电脑，独立无头 Edge，界面测试构建使用确定性翻译服务。每次插入 768 个可见条目，在 2.2 秒窗口内由 Playwright 持续发送真实鼠标点击，同时用 requestAnimationFrame 测绘制间隔。每轮最终均核对 768 个条目各有一份最终译文。点击往返包括自动化和浏览器处理的总耗时。

| 版本及轮次 | 该轮最慢点击往返（毫秒） | 该轮最长帧间隔（毫秒） |
|---|---:|---:|
| 0.2.14，第 1 轮 | 722 | 744 |
| 0.2.14，第 2 轮 | 730 | 733 |
| 0.2.14，第 3 轮 | 677 | 694 |
| 0.2.15，第 1 轮 | 110 | 22 |
| 0.2.15，第 2 轮 | 11 | 12 |
| 0.2.15，第 3 轮 | 10 | 17 |

单独测量 32 层嵌套正文候选、2,500 个段落，5 次识别的中位耗时约由 719 毫秒降至 20 毫秒。调度的 6 毫秒为任务预算；单段处理和浏览器布局仍影响实际响应。在超大列表的滚动测试中，个别间隔仍达到约百毫秒。重新测量网格可先构建界面测试版本，再指定测试浏览器并运行 `node tests/e2e/dynamic-benchmark.mjs`。

**公开网页抽测**　使用独立 Edge 资料、正式扩展及本机 llama.cpp 翻译服务。React 待办页新增 4 项，切换已完成、活动、全部并编辑标题成功。Bootstrap 示例下拉菜单打开 8 次，鼠标及 Esc 各关闭 4 次。两页均取得最终译文，操作期间没有捕获页面脚本错误。测试页面为 [React TodoMVC](https://demo.playwright.dev/todomvc/) 和 [Bootstrap 下拉菜单](https://getbootstrap.com/docs/5.3/components/dropdowns/)。

**验收**　类型检查通过，界面 61/61（页面 43、媒体 18），正式前后端联调 11 组，已有状态/布局专项 3 组。后端及合约最终 839/839。首次合约有一条限速取消测试失败，原因是并发启动的两个测试请求可能交换先后；夹具针对实际等待的请求安排取消，仍检查发送顺序、计费和发送间隔。正式前后端专项使用本机 HTTP 回放，上述公开页面另外使用本机真实模型。

**本机交付**　构建编号 `0.2.15-081b5a781f0d`。扩展和 Windows 安装工具已逐文件校验。

- `translate-ext-0.2.15-chrome.zip`，34697093 字节，SHA-256 `fdbf0b97a363a62d34dd267faa77ecbd3934ad9857c0ed9785dd6579bf5bf46a`。
- `yi-local-setup-0.2.15-windows-x64.zip`，30630 字节，SHA-256 `09c7fc8752e2cf171652ef7d78e05296df72754e9168e01201e78befc0b77220`。

使用说明见 [0.2.15 发布说明](RELEASE-0.2.15.md)。


## 53. 长正文、图片及综合模式的页面卡顿

2026-11-05，扩展 0.2.16，基线 0.2.15。以下对照来自独立 Edge 和相同测试输入。回调耗时、DOM 写入次数、帧间隔和模型推理时间分别计量。

| 场景 | 改动及验证 |
|---|---|
| 异步创建 1,400 层菜单 | 共用祖先判断并分批归并增量扫描根。旧版观察回调约 57 毫秒、准备扫描约 280 毫秒，新版分别约 7–8 及 6–7 毫秒；滚到末端正文能获得译文。一次加入 18,000 个同级正文节点的归并约 36 → 9 毫秒 |
| 持续刷新的 SVG、编辑器与排除区域 | 已排除的 18,000 个新增节点不进入待扫描集合。可编辑原文保留，旁边新增和正在变更的正文按自己的防抖窗口翻译。卸载时仍清理跟踪过的段落。2,400 段即时还原约 12 毫秒 |
| 长文档的小节目录 | 按文档顺序认领外层目录，使用祖先和集合判断正文范围。1,000 个小节、8,000 个元素，三轮过滤约 163–179 → 3–4 毫秒；250 组 DOM 结构的范围与旧版一致 |
| 综合模式成批收到最终译文 | 透明度由 CSS 过渡，结果回调不再为重启动画读取宽度。768 个可见条目均出现一份最终译文，专为切换阶段读取布局的次数每轮 768 → 0；进度文字更新约 1,590–1,597 → 73–229 次。等待提示轮流更新，定格动画共享字符预算，超预算的译文直接以最终状态显示 |
| 格式密集的译文 | 512 个含强调标记的结果同时到达，排版预热后三轮文本节点写入约 18,432–24,576 → 1,554–1,974 次，逐项核对最终 HTML 一致。浏览器首次绘制和字体加载仍会影响单次帧间隔 |
| 深层标签和超长正文 | 用迭代遍历及连续文字区间映射 DOM 端点。4,200 层包裹可翻译、高亮及还原。约 100.8 万字符的连续正文，序列化约 28–71 → 7–9 毫秒，高亮建图约 43–63 → 4–5 毫秒。1,250 组 Unicode/DOM 输入、74,944 个位置与原端点对照一致。该基准测量页面文本处理 |
| 超长单段的逐句对照 | 超过 96 句时分批插入占位，并按原文顺序派发。1,200 句样本中，插入时最长帧间隔约 106 → 22 毫秒；完整插入约 175 → 316 毫秒，两轮均包含相同的测试启动等待。600 句中途还原、切换段落模式、重绘和移除均可中止。点击 48 句中间的一条译文，只预取所点句子的对齐 |
| 图片画廊与隐藏后卸载 | 36 张已译图在内层容器滚动，69 个帧间隔内的布局计算 2,485 → 81 次。可见覆盖层按批次读写布局；换图丢弃旧结果，图库先隐藏再卸载也会释放覆盖层 |
| OCR 大图框及临时图片 | 1600×1600 纹理图的大框取色约 172–209 → 2.5–8.3 毫秒，1,500 个随机框的前景、背景及墨水比例与旧版一致。2400×1600 的有效 JPEG blob 复用原图异步读取，点击线程准备约 86–149 → 0.2–0.9 毫秒。已撤销的 URL 使用异步 PNG 回退，保留像素、字节和取消限制 |

类型检查通过，界面 **70/70**（页面 51、媒体 19），后端与合约 **843/843**，正式前后端 **11 组**。离线真实 OCR / PDF 专项 **7 组**和本机 ONNX 词对齐专项通过。独立配置只启用本机 llama.cpp，公开页面抽测覆盖 [React 待办列表](https://demo.playwright.dev/todomvc/) 的新增、筛选及编辑，[Bootstrap 下拉菜单](https://getbootstrap.com/docs/5.3/components/dropdowns/) 的 8 次开合和 [Phonetics](https://en.wikipedia.org/wiki/Phonetics) 首段翻译的 9 个链接、滚动与原文还原。三页均无捕获的页面脚本错误。

构建编号 `0.2.16-0303a3baff2a`。两个安装包逐文件校验通过。

- `translate-ext-0.2.16-chrome.zip`，272 个文件，SHA-256 `c5945465e63bb3f73701be45c51a8f54a9eba961d19f68905bdaa378ab6f1354`。
- `yi-local-setup-0.2.16-windows-x64.zip`，23 个文件，SHA-256 `8f75b523d06eafac484e71c729e5d4402fa15867c68c8ad8c914e1df35fa4f5d`。

见[0.2.16 发布说明](RELEASE-0.2.16.md)。

## 54. 带整页免译标记的招聘页

2026-11-05，扩展 0.2.17。按用户提供的奥尔堡大学招聘页复现，点击悬浮球后，0.2.16 一直显示“正在扫描页面”。职位正文在顶层页面的普通段落里。网站在整个 body 上设置了 notranslate，扫描入口因此跳过所有后代。

- `src/frontend/content/dom.ts` 区分文档根和局部免译标记。用户为页面开启翻译时，HTML 或 BODY 上的 `notranslate` 和 `translate="no"` 允许正文进入扫描。局部标记、编辑区域和扩展专用 `tx-ignore` 继续生效。扩展保留网站原有属性，首屏和增量扫描使用同一判断。
- `src/frontend/content/main-content.ts` 修正“只翻正文”的文字计分。在该站，预置的隐藏 Cookie 详情会贡献 562,432 个字符，足以让旧算法放弃约一万字符的职位正文。现在对带隐藏标志或对话框语义的面板检查它和祖先的实际显示状态，按本次扫描缓存；视觉上可见的 aria-hidden 文字仍可参与计分。
- `tests/e2e/root-hint.mjs` 和合成夹具覆盖全局与局部标记、异步招聘信息、滚动和原文链接还原、正文与全页模式切换、隐藏 Cookie 详情以及可见的 aria-hidden 说明。4 项测试在 0.2.16 上复现其中 3 项失败；专用整页排除用例作为对照，在前后两版均通过。

| 真实职位页 | 0.2.16 候选数 | 0.2.17 候选数 | 其中位于职位描述的单元 |
|---|---:|---:|---:|
| [981852](https://www.vacancies.aau.dk/phd-positions/show-vacancy/vacancyId/981852) | 0 | 82 | 41 |
| [983659](https://www.vacancies.aau.dk/phd-positions/show-vacancy/vacancyId/983659) | 0 | 77 | 36 |

两页均识别到 `main#main`。同意弹层打开或关闭时，默认正文范围内的 Cookie 清单候选均为 0。表中统计扫描候选数；实际翻译单独用独立 Edge、正式扩展、快速模式和真实本机 llama.cpp 验证。每页均点击悬浮球，检查标题、首段、中段、末尾长段出现中文的最终译文，关闭后四处的原文 HTML 和链接逐项还原。

类型检查、界面 74/74（页面 55、媒体 19）、后端与合约 843/843、正式前后端 11 组均通过。构建编号 `0.2.17-610ff82eb2c9`，两个 ZIP 已逐文件校验。

- `translate-ext-0.2.17-chrome.zip`，272 个文件，SHA-256 `22820d0f8711b4a7761294a4f7d7ad305e2a63a1abfb40914c270e4342fc3d9e`。
- `yi-local-setup-0.2.17-windows-x64.zip`，23 个文件，SHA-256 `685fdb3600b2c23d3eb7e018200e912d420e7867f3b35642bdeaf03a2076a4d8`。

见[0.2.17 发布说明](RELEASE-0.2.17.md)。
