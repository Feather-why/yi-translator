import type { AuthField, ErrorInfo, LangCode, Mode, ModelNodeStatus, PageContext, ProviderKind, QuotaInfo } from '../../shared/protocol';

export interface ProviderTiming { phase: 'model'; promptMs?: number; generationMs?: number; promptTokens?: number; outputTokens?: number }
export interface ProviderContext {
  fetch(input: string, init?: RequestInit & { timeoutMs?: number; streamResponse?: boolean }): Promise<Response>;
  signal: AbortSignal;
  config: Record<string, string>;
  log(message: string): void;
  /** 浏览器 Window 专属 API 通过本机 offscreen 传输注入，适配器不跨目录依赖实现。 */
  builtin?: BuiltinTranslatorBridge;
  /** 仅报告服务真实返回的模型计时；不包含原文或推测的排队耗时。 */
  recordTiming?: (timing: ProviderTiming) => void;
  /** 累计预览，仅用于本次请求；index对应request.texts，不能写入译文缓存。 */
  onPartial?: (text: string, index: number) => void;
  /** 内部请求时序；由后端传输层触发，批量请求广播给每个存活成员。 */
  onRequestStart?: () => void;
  onRequestEnd?: () => void;
}

export type BuiltinAvailabilityStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable';
export interface BuiltinTranslatorAvailability {
  status: BuiltinAvailabilityStatus;
  sourceLanguage: string;
  targetLanguage: string;
  supportsAuto: boolean;
  detectorStatus: BuiltinAvailabilityStatus;
  reason?: string;
}
export interface BuiltinTranslatorBridge {
  /** 仅缓存真实语言对的短暂不可用；显式检测和语言包下载后清除。 */
  unavailable?(sourceLang: string, targetLang: string): boolean;
  invalidate?(sourceLang?: string, targetLang?: string): void;
  availability(sourceLang: string, targetLang: string, signal: AbortSignal): Promise<BuiltinTranslatorAvailability>;
  translate(request: ProviderRequest, signal: AbortSignal): Promise<string[]>;
}

export interface ProviderRequest {
  texts: string[];
  sourceLang: LangCode;
  targetLang: LangCode;
  context?: PageContext;
  strictPlaceholders?: boolean;
  /** 能力可选，未实现流式的服务忽略。 */
  stream?: boolean;
  /** 后端内部恢复策略；综合模式一律准确档，不作为URL/用户提示配置。 */
  quality?: 'fast' | 'accurate';
  /** 本机占位符恢复用术语锚点；仍由完整句子决定语序，不拼接词组译文。 */
  terminology?: { source: string; target: string }[];
}

export interface ProviderDef {
  id: string;
  name: string;
  version: string;
  kind: ProviderKind;
  official: boolean;
  usedFor: Mode[];
  auth: AuthField[];
  defaults?: Record<string, string>;
  freeQuota?: Omit<QuotaInfo, 'used' | 'resetAt'>;
  /** 套餐并非统一月额时，说明默认预算与官方账户额度的区别。 */
  quotaText?: string;
  limits: { maxChars: number; maxSegments: number; concurrency: number; qps?: number };
  placeholders: 'xml' | 'html' | 'strip-reinsert' | 'prompt';
  mapLang?(code: LangCode): string;
  /** 已知不支持的语言对不占用额度；动态语言能力仍由实际服务响应决定。 */
  supports?(sourceLang: LangCode, targetLang: LangCode): boolean;
  translate(req: ProviderRequest, ctx: ProviderContext): Promise<string[]>;
  classifyError(error: unknown): ErrorInfo;
  health?(ctx: ProviderContext): Promise<{ ok: boolean; latencyMs?: number; used?: number; amount?: number; quotaResetAt?: number; model?: string; node?: Omit<ModelNodeStatus, 'id' | 'name'> }>;
  explain?(text: string, context: string | undefined, ctx: ProviderContext): Promise<string>;
  cost?(req: ProviderRequest): number;
}

export const defineProvider = (definition: ProviderDef): ProviderDef => definition;

export class ProviderError extends Error {
  constructor(public info: ErrorInfo) { super(info.message); }
}

export function classifyError(error: unknown): ErrorInfo {
  if (error instanceof ProviderError) return error.info;
  return { code: 'network', message: '翻译服务连接失败或超时', retryable: true };
}

export async function responseJson(response: Response): Promise<any> {
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'auth'
      : response.status === 429 ? 'rate_limit' : response.status === 456 ? 'quota'
      : response.status >= 500 ? 'server' : 'bad_input';
    throw new ProviderError({ code, message: `翻译接口返回 HTTP ${response.status}`, retryable: code === 'rate_limit' || code === 'server' });
  }
  try { return await response.json(); }
  catch { throw new ProviderError({ code: 'server', message: '翻译接口返回格式异常', retryable: true }); }
}
