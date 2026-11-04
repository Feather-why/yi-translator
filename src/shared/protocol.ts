/**
 * 前端（内容脚本、设置页）与后端（service worker、offscreen）之间的通信协议。
 *
 * 这是前后端唯一的约定来源（source of truth）：
 * - 前端（Claude 负责）只通过这里定义的消息调用后端；
 * - 后端（GPT 负责）必须实现这里定义的全部端口和 RPC；
 * - 任何一方要改这里，先在 docs/HANDOFF-BACKEND.md 的「协议变更记录」里写清楚，
 *   并把 PROTOCOL_VERSION 加 1，另一方确认后再合并。
 */

import type { BackendRpcMap } from './backend-v2';

export const PROTOCOL_VERSION = 3;

/* ------------------------------------------------------------------ */
/* 基础类型                                                             */
/* ------------------------------------------------------------------ */

/** BCP-47 语言代码，如 'en'、'zh-CN'。源语言可以是 'auto'。 */
export type LangCode = string;

/**
 * 翻译模式。
 * - fast：只用高速后端（机翻池 / 本地 1.8B / Chrome 本地翻译），每段只返回一次 stage='final'。
 * - accurate：只用精确后端（远程 7B / 云端大模型），每段只返回一次 stage='final'。
 * - combined：每段最多返回两次：先 stage='fast'，再 stage='final'。
 */
export type Mode = 'fast' | 'accurate' | 'combined';

/** 一段译文所处的阶段。前端据此决定颜色深浅：fast 浅色，final 接近原文颜色。 */
export type Stage = 'fast' | 'final';

export type SegmentKind = 'paragraph' | 'sentence' | 'subtitle' | 'selection' | 'ocr' | 'pdf';

/**
 * 一个待翻译的片段。
 *
 * text 里可能带两种占位符，后端必须原样保留（数量、编号、嵌套关系都不能变）：
 * - 成对：<g0>…</g0>、<g1>…</g1>，代表链接、加粗等行内元素，中间的文字需要翻译；
 * - 自闭合：<x0/>、<x1/>，代表网址、代码、邮箱等不该翻译的内容，原样保留。
 * 校验工具见 ./placeholders.ts。占位符丢失时后端应先重试或换服务，仍失败再返回 code='placeholder'。
 */
export interface Segment {
  /** 前端生成，在同一个 job 内唯一。 */
  id: string;
  text: string;
  kind: SegmentKind;
  /** 逐句对照时，同一段落拆出的句子共享 groupId。 */
  groupId?: string;
}

export interface PageContext {
  url: string;
  title?: string;
  /** 正文开头约 300 字，给精确模式做上下文。 */
  summary?: string;
}

export type ErrorCode =
  | 'rate_limit' // 限流，稍后可重试
  | 'quota' // 额度用尽
  | 'auth' // key 无效或缺失
  | 'server' // 服务端 5xx
  | 'network' // 网络失败、超时
  | 'bad_input' // 输入不被接受（过长、语言不支持等）
  | 'placeholder' // 译文的占位符对不上，重试后仍失败
  | 'cancelled' // 被前端取消
  | 'no_provider' // 没有可用的服务
  | 'internal'; // 其他内部错误

export interface ErrorInfo {
  code: ErrorCode;
  /** 给用户看的简短中文说明，如「腾讯额度已用完」。 */
  message: string;
  provider?: string;
  retryable: boolean;
}

/* ------------------------------------------------------------------ */
/* 端口 1：整页 / 划词翻译（长连接，流式返回）                            */
/* ------------------------------------------------------------------ */

export const PORT_TRANSLATE = 'tx:translate';

export interface TranslateJob {
  jobId: string;
  sourceLang: LangCode;
  targetLang: LangCode;
  mode: Mode;
  /** 数字越小越优先。0 = 当前屏，1 = 下一屏，2 及以上 = 更远，100 = 空闲时再翻。 */
  priority: number;
  context: PageContext;
  segments: Segment[];
  /** 强制使用某个服务（划词小窗里的「换服务重翻」）。 */
  providerHint?: string;
  /**
   * 不读也不写缓存：用户点「重翻」时，或在敏感网站上（银行、邮箱、内网）。
   * 敏感网站的译文同样不能写入译文记忆、不能进同步。
   */
  noCache?: boolean;
  /** 后端批量媒体接口使用的缓存命名空间；普通 v1 前端无需设置。 */
  cacheNamespace?: string;
  /**
   * v2.1：允许边生成边返回（`partial` 消息）。只对能流式输出的服务有意义（本地 / 远程大模型、OpenAI 兼容接口），
   * 机翻接口照常一次性返回。后端不支持时忽略即可，最后仍必须发 `result`。
   */
  stream?: boolean;
}

/** v2.1：单段译文在后端的耗时（毫秒），都可选，量不到就不填。 */
export interface SegmentTiming {
  /** 从后端收到 job 到这一段开始发请求（排队、等并发槽、查缓存）。 */
  queueMs?: number;
  /** 服务本身的耗时（发出请求到拿到完整译文；批量请求填整批的耗时）。 */
  providerMs?: number;
  /** 流式时，从发出请求到第一个字。 */
  firstTokenMs?: number;
  /** 占位符校验失败后的额外请求次数（0 = 一次成功）。 */
  retries?: number;
}

/** 前端 → 后端 */
export type TranslateClientMsg =
  | { type: 'job'; job: TranslateJob }
  /** 取消整个 job，或其中的部分片段。已取消的片段不再返回任何结果。 */
  | { type: 'cancel'; jobId: string; segmentIds?: string[] }
  /** 调整尚未完成片段的优先级（滚动时用）。 */
  | { type: 'priority'; jobId: string; segmentIds: string[]; priority: number };

/** 后端 → 前端 */
export type TranslateServerMsg =
  | {
      type: 'result';
      jobId: string;
      segmentId: string;
      /** 译文，占位符已按原样保留。 */
      text: string;
      stage: Stage;
      /** 实际给出译文的服务 id，如 'tencent'、'llamacpp-local'。命中缓存时仍填原服务 id，并设 cached=true。 */
      provider: string;
      cached: boolean;
      /** v2.1 可选：这一段在后端的耗时拆分，前端用来在「服务状态」里显示首屏时间花在哪。 */
      timing?: SegmentTiming;
    }
  /**
   * v2.1：流式的中间结果（仅当 job.stream 为 true）。text 是**到目前为止的完整译文**（不是增量），
   * 可能停在半个占位符上（如 `<g1`），前端自己处理。同一段约每 60–100ms 最多发一次；
   * 收到 `result` 后不再发。中间结果不进缓存、不计入完成数。
   */
  | { type: 'partial'; jobId: string; segmentId: string; stage: Stage; text: string; provider?: string }
  | { type: 'error'; jobId: string; segmentId: string; stage: Stage; error: ErrorInfo }
  /** 某个阶段的所有片段都已返回（结果或错误）。combined 模式下会收到两次。 */
  | { type: 'job-done'; jobId: string; stage: Stage };

/* ------------------------------------------------------------------ */
/* 端口 2：服务状态（设置页的服务状态面板订阅）                            */
/* ------------------------------------------------------------------ */

export const PORT_STATUS = 'tx:status';

export type ProviderKind = 'mt' | 'llm' | 'local' | 'remote' | 'builtin';
export type ProviderHealth = 'ok' | 'degraded' | 'error' | 'exhausted' | 'disabled' | 'unconfigured';

export interface QuotaInfo {
  unit: 'char' | 'token' | 'request';
  /** 本周期的免费额度。 */
  amount: number;
  used: number;
  period: 'day' | 'month' | 'cycle';
  /** 下次重置时间（毫秒时间戳）。 */
  resetAt?: number;
}

export interface ProviderStatus {
  id: string;
  name: string;
  kind: ProviderKind;
  /** false = 非官方的免 key 接口。 */
  official: boolean;
  enabled: boolean;
  configured: boolean;
  health: ProviderHealth;
  /** 当前正在承担翻译的服务。 */
  active: boolean;
  /** 调度排名，从 1 开始；不参与排名时为 null。 */
  rank: number | null;
  latencyP50Ms?: number;
  /** 0~1 */
  successRate?: number;
  /** 不限量的服务（本地、远程、Chrome 本地翻译）没有 quota。 */
  quota?: QuotaInfo;
  lastError?: { code: ErrorCode; message: string; at: number };
  /** 适配器文件与版本，用于在状态页定位要替换的文件。 */
  adapter: { file: string; version: string };
  usedFor: Mode[];
  pinned?: boolean;
  circuit?: 'closed' | 'open' | 'half-open';
  cooldownUntil?: number;
}

export interface ModelNodeStatus {
  id: string;
  name: string;
  location: 'local' | 'remote';
  online: boolean;
  models: { id: string; loaded: boolean; vramMB?: number }[];
  queue?: number;
  tokensPerSec?: number;
  lastError?: { message: string; at: number };
}

export interface StatusEvent {
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  providerId?: string;
}

export interface StatusSnapshot {
  at: number;
  /** 按 rank 升序；rank 为 null 的排在最后。 */
  providers: ProviderStatus[];
  nodes: ModelNodeStatus[];
  /** 最新的在前，最多 50 条。 */
  events: StatusEvent[];
  perf?: { firstScreenMsP50?: number; samples: number };
  sync?: { lastSyncAt?: number; lastError?: string };
}

/** 后端在连接建立时立即推一次 snapshot，之后每 5 秒或状态变化时再推。 */
export type StatusServerMsg = { type: 'snapshot'; status: StatusSnapshot };

export type StatusClientMsg =
  /** 立即对某个服务（不传则全部）做一次健康检查。 */
  | { type: 'probe'; providerId?: string }
  | { type: 'provider-action'; providerId: string; action: 'pin' | 'unpin' | 'pause' | 'resume' };

/* ------------------------------------------------------------------ */
/* 一次性请求（chrome.runtime.sendMessage）                              */
/* ------------------------------------------------------------------ */

export interface AuthField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  /** v2.2：'textarea' 多行（自定义 HTTP 接口的请求模板等）。 */
  type?: 'text' | 'url' | 'number' | 'select' | 'textarea';
  options?: { value: string; label: string }[];
  /** 申请教程链接。 */
  helpUrl?: string;
}

/**
 * v2：每家服务都可能有的通用高级设置。后端在 ProviderInfo.editable 里声明支持哪些项，
 * 前端只显示这些项。所有字段可选：没设置就用 ProviderInfo.defaults 里的默认值。
 */
export interface ProviderOptions {
  /** 接口地址：官方服务可改成代理或区域端点；本地 / 远程 / OpenAI 兼容服务必填。 */
  endpoint?: string;
  /** 模型名（大模型、本地、远程服务）。 */
  model?: string;
  /** 参与哪些模式。高速档 = ['fast','combined']，精确档 = ['accurate','combined']。 */
  usedFor?: Mode[];
  /** 调度权重 0~100，默认 50；越大越优先。 */
  weight?: number;
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number;
  /** 同时进行的请求数。 */
  concurrency?: number;
  /** 每秒最多请求数。 */
  qps?: number;
  /** 每次请求最多带多少字符（批量大小）。 */
  maxChars?: number;
  /** 用户自己账号的实际免费额度，覆盖适配器的默认值；amount 为 0 表示没有免费额度。 */
  quota?: { amount: number; unit: QuotaInfo['unit']; period: QuotaInfo['period'] };
  /** 大模型提示词，覆盖默认值。可用变量：{{from}} {{to}} {{text}} {{context}}。 */
  prompt?: string;
  temperature?: number;
}

/** v2：用户可以自己添加的服务类型。 */
export type ProviderTemplate =
  | 'openai-compatible' // DeepSeek、硅基流动、Ollama、LM Studio、vLLM 等 OpenAI 兼容接口
  | 'llamacpp' // 另一台 llama-server
  | 'remote-node' // 另一个远程节点（gateway）
  | 'libretranslate' // 自托管的 LibreTranslate
  | 'custom-http'; // 声明式 JSON 请求/响应接口

/**
 * v2.2 已实现的新模板；保留独立别名，兼容已接入能力查询的前端：
 * - libretranslate：自己部署的 LibreTranslate（开源机器翻译）
 * - custom-http：自定义 HTTP 接口（请求 / 返回按模板填）
 */
export type ExtraProviderTemplate = 'libretranslate' | 'custom-http';

/** v2.2：本地模型开机自启 / 立即启动的状态（Windows 上由后端通过本机助手实现）。 */
export interface LocalAutostart {
  /** 后端能不能控制本地模型（没装本机助手时 false）。 */
  supported: boolean;
  /** 已设置开机自动启动。 */
  enabled: boolean;
  /** 能否从扩展里直接启动（「立即启动」按钮）。 */
  canStart?: boolean;
  /** 不支持时给用户看的一句说明，如「先双击 gateway\scripts\install-helper.cmd 一次」。 */
  hint?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  kind: ProviderKind;
  official: boolean;
  enabled: boolean;
  configured: boolean;
  auth: AuthField[];
  /** 已保存的非密钥配置；密钥字段只返回 '••••'，不回传明文。 */
  config: Record<string, string>;
  /** 如「500 万字符/月」。 */
  quotaText?: string;
  usedFor: Mode[];
  adapter: { file: string; version: string };
  /** v2：当前的通用设置（只含用户改过的项）。 */
  options?: ProviderOptions;
  /** v2：通用设置的默认值，前端用作占位提示和「恢复默认」。 */
  defaults?: ProviderOptions;
  /** v2：这家服务支持修改哪些通用设置；缺省表示后端还不支持（前端只显示账号字段）。 */
  editable?: (keyof ProviderOptions)[];
  /** v2：用户自己添加的服务，可以改名和删除。 */
  custom?: boolean;
  /** v2：由哪种模板添加。 */
  template?: ProviderTemplate;
  /** v2：官方文档 / 申请页面。 */
  docsUrl?: string;
}

export interface DictEntry {
  word: string;
  lemma?: string;
  phonetic?: string;
  /** 每行一个中文释义，如 'n. 苹果'。 */
  translations: string[];
  /** 英文释义（可选）。 */
  definitions?: string[];
  /** 时态、复数等：{ 过去式: 'ran', 现在分词: 'running' } */
  forms?: Record<string, string>;
  tags?: string[];
  collins?: number;
  oxford?: boolean;
  source: 'ecdict' | 'llm';
}

/** 词对齐的输入：纯文本（已去掉占位符），一句原文和对应的一句译文。 */
export interface AlignPair {
  id: string;
  source: string;
  target: string;
  sourceLang: LangCode;
  targetLang: LangCode;
}

/** 词对齐的结果：两边的词按字符区间给出，links 是 [原文词下标, 译文词下标]。 */
export interface AlignResult {
  id: string;
  srcTokens: [number, number][];
  tgtTokens: [number, number][];
  links: [number, number][];
  /** 可选选区范围，UTF-16 半开区间；句选/短语选用，不可当作逐词链接。 */
  spans?: { kind: 'sentence' | 'phrase'; source: [number, number]; target: [number, number] }[];
}

export interface SiteRule {
  id: string;
  match: string[];
  include?: string[];
  exclude?: string[];
  display?: 'append' | 'hover' | 'replace';
  waitFor?: string;
  shadowHosts?: string[];
  /** 只允许排版相关属性（font-size、margin、line-height 等）。 */
  style?: Record<string, string>;
  autoTranslate?: boolean;
  source: 'local' | 'subscription' | 'builtin';
}

export interface PerfReport {
  url: string;
  mode: Mode;
  /** 点击翻译到首屏第一段译文出现的耗时。 */
  firstScreenMs: number;
  /** 首屏内的段落数。 */
  segments: number;
  /** v2.1 可选：首屏全部出现快速译文 / 最终译文的耗时，以及开始翻译前的准备时间。 */
  firstScreenFastMs?: number;
  firstScreenFinalMs?: number;
  prepareMs?: number;
}

/** 每个 RPC 的请求与返回类型。 */
export interface RpcMap extends BackendRpcMap {
  ping: { req: void; res: { protocol: number; backend: string; buildId?: string } };
  'dict:lookup': { req: { word: string; lang: LangCode; targetLang: LangCode }; res: DictEntry | null };
  'align:get': { req: { pairs: AlignPair[] }; res: AlignResult[] };
  'rules:forUrl': { req: { url: string }; res: SiteRule | null };
  'explain': {
    req: { text: string; context?: string; kind: 'word' | 'sentence'; targetLang: LangCode };
    res: { text: string; provider: string };
  };
  'providers:list': { req: void; res: ProviderInfo[] };
  'providers:save': {
    /**
     * options（v2，可选）：整份替换已保存的通用设置，没出现的项恢复默认。
     * name（v2，可选）：只对自定义服务生效。
     */
    req: { id: string; enabled: boolean; config: Record<string, string>; options?: ProviderOptions; name?: string };
    res: { ok: true };
  };
  /** v2：按模板添加一个服务，返回新服务（默认停用，等用户填好再启用）。 */
  'providers:add': { req: { template: ProviderTemplate; name: string }; res: ProviderInfo };
  /** v2：删除自定义服务（内置服务不可删，返回 bad_input）。 */
  'providers:remove': { req: { id: string }; res: { ok: true } };
  /**
   * v2：向服务的接口查询可用模型（OpenAI 兼容的 /v1/models、llama-server、远程节点 /v1/health）。
   * endpoint / config 是表单里尚未保存的值，不传就用已保存的。
   */
  'providers:models': { req: { id: string; endpoint?: string; config?: Record<string, string> }; res: string[] };
  'providers:test': { req: { id: string; sourceLang?: LangCode; targetLang?: LangCode }; res: { ok: boolean; latencyMs?: number; error?: ErrorInfo } };
  /** 用户标记「这句翻得不好」：后端记录该服务出错一次，并可换一家重翻（结果走翻译端口）。 */
  'feedback:bad': {
    req: { source: string; translation: string; provider: string; sourceLang: LangCode; targetLang: LangCode };
    res: { ok: true };
  };
  /** 用户手动修正的译文，存入译文记忆；以后同一句原文直接用它。 */
  'tm:save': { req: { source: string; target: string; sourceLang: LangCode; targetLang: LangCode }; res: { ok: true } };
  'perf:report': { req: PerfReport; res: { ok: true } };
  /**
   * v2.1：预热。用户把鼠标移到悬浮球上、或这个网站设了自动翻译时，前端提前调用：
   * 后端可以借此唤醒本地模型（闲置卸载后重新加载）、建好 offscreen 文档、预连远程节点。
   * 必须很便宜、可以重复调用（前端每页最多 1 次、同一标签页 60 秒内最多 1 次），失败也不影响翻译。
   */
  'providers:warm': { req: { mode?: Mode }; res: { ok: true } };
  /** v2.2：后端支持哪些「添加服务」模板。老后端没有这个 RPC：前端只显示前三个。 */
  'providers:templates': { req: void; res: (ProviderTemplate | ExtraProviderTemplate)[] };
  /** v2.2：查询 / 设置本地模型开机自动启动。enable 不传 = 只查询。 */
  'local:autostart': { req: { enable?: boolean }; res: LocalAutostart };
  /** v2.2：现在就启动本地模型（已在运行时直接返回 ok）。 */
  'local:start': { req: void; res: { ok: boolean; message?: string } };
  /** 内容脚本不能直接打开设置页，由后端调用 chrome.runtime.openOptionsPage()。tab 为设置页里的标签名。 */
  'ui:openOptions': { req: { tab?: 'general' | 'providers' | 'status' | 'welcome' | 'advanced' }; res: { ok: true } };
}

export type RpcName = keyof RpcMap;

export interface RpcRequest<K extends RpcName = RpcName> {
  rpc: K;
  payload: RpcMap[K]['req'];
}

export type RpcResponse<K extends RpcName = RpcName> =
  | { ok: true; data: RpcMap[K]['res'] }
  | { ok: false; error: ErrorInfo };

/* ------------------------------------------------------------------ */
/* 后端 → 内容脚本（chrome.tabs.sendMessage）                            */
/* ------------------------------------------------------------------ */

/** 点击扩展图标、快捷键、右键菜单时，后端把命令转给当前标签页。 */
export type ContentCommand =
  | { cmd: 'toggle-page' }
  | { cmd: 'set-mode'; mode: Mode }
  /**
   * 划词翻译。text 可选（v2.1）：浏览器自带的 PDF 查看器里内容脚本拿不到选区，
   * 后台从右键菜单 info.selectionText 取到文字后一并发来，前端直接用它开小窗。
   */
  | { cmd: 'translate-selection'; text?: string }
  /** v2：图片右键菜单「翻译这张图片」，srcUrl 取自 contextMenus 的 info.srcUrl。 */
  | { cmd: 'translate-image'; srcUrl: string }
  /** v2.2：词典重新导入等让词对齐失效时，后台发给各标签页：前端清掉页面里缓存的对齐结果（第 30.3 节）。 */
  | { cmd: 'align-reset' };
