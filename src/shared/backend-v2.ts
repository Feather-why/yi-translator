import type { ErrorInfo, LangCode, Mode, PageContext, SiteRule } from './protocol';

export interface OcrBlock { text: string; confidence: number; box: [number, number][]; translation?: string; error?: ErrorInfo }
export interface OcrResult { width: number; height: number; blocks: OcrBlock[]; engine: string; model: string }
export interface ImageInput { url?: string; dataUrl?: string }
export interface SubtitleInput { id: string; text: string; startMs?: number; endMs?: number }
export interface SubtitleOutput extends SubtitleInput { source: string; provider?: string; error?: ErrorInfo }
export interface PdfParagraph { id: string; source: string; translation?: string; box: [number, number, number, number]; provider?: string; error?: ErrorInfo }
export interface PdfPage { page: number; width: number; height: number; paragraphs: PdfParagraph[]; scanned: boolean }
export interface PdfResult { documentId: string; pages: PdfPage[]; warnings: string[] }
export interface BackendCapabilities {
  protocol: number;
  dictionary: { ready: boolean; entries?: number };
  alignment: { ready: boolean; model?: string; loading?: boolean; error?: string };
  media: { ocr: boolean; subtitles: boolean; pdf: boolean; cancel?: boolean; pdfSessions?: boolean };
  sync: { enabled: boolean; lastSyncAt?: number; lastError?: string };
}
export type RuleSubscriptionVersion = string | number;
export interface RuleSubscriptionInfo {
  url: string;
  /** 上游 JSON 的 version，或有效规则的 sha256 内容版本；尚无有效版本为 null。 */
  version: RuleSubscriptionVersion | null;
  updatedAt?: number;
  etag?: string;
  lastError?: string;
  count: number;
  canRollback: boolean;
}

export interface PerformanceAggregate { count: number; totalMs: number; minMs: number; maxMs: number }
export interface PerformanceRow extends PerformanceAggregate {
  providerId?: string;
  tier?: 'fast' | 'accurate';
  lane?: 'fast' | 'final';
  kind?: string;
  outcome: string;
  cache?: 'hit' | 'miss' | 'none';
  /** 固定字段的匿名计数和子阶段耗时总和，不含请求内容。 */
  counters?: Record<string, number>;
}
export interface PerformanceSnapshot {
  since: number; capturedAt: number;
  http: PerformanceRow[]; logical: PerformanceRow[]; queue: PerformanceRow[];
  placeholder: PerformanceRow[]; modelTiming: PerformanceRow[]; shared: PerformanceRow[];
}
export interface ModelWarmupRequest { providerId?: string; reason: 'hover' | 'manual' }
export interface ModelWarmupResult {
  status: 'ready' | 'warmed' | 'cooldown' | 'ineligible' | 'unsupported' | 'failed';
  provider?: string; elapsedMs?: number; retryAfterMs?: number; error?: ErrorInfo;
}

/** 新增管理类 RPC 仅允许扩展自己的页面调用，原有 v1 消息保持兼容。 */
export interface BackendRpcMap {
  'performance:get': { req: void; res: PerformanceSnapshot };
  'models:warmup': { req: ModelWarmupRequest; res: ModelWarmupResult };
  'backend:capabilities': { req: void; res: BackendCapabilities };
  'dict:import': { req: { csv: string }; res: { ok: true; entries: number } };
  'align:configure': { req: { enabled: boolean; remoteUrl?: string; token?: string }; res: { ok: true } };
  'rules:list': { req: void; res: SiteRule[] };
  'rules:subscriptions': { req: void; res: RuleSubscriptionInfo[] };
  'rules:save': { req: { rule: SiteRule }; res: { ok: true } };
  'rules:remove': { req: { id: string }; res: { ok: true } };
  'rules:subscribe': { req: { url: string }; res: { ok: true } };
  'rules:refresh': { req: { url?: string }; res: { ok: true } };
  'rules:rollback': { req: { url: string }; res: { ok: true } };
  'sync:configure': { req: { enabled: boolean; url?: string; username?: string; password?: string; syncSecrets?: boolean; passphrase?: string }; res: { ok: true } };
  'sync:run': { req: void; res: { ok: true } };
  'secrets:export': { req: { passphrase: string }; res: { archive: string } };
  'secrets:import': { req: { passphrase: string; archive: string }; res: { ok: true } };
  /** v3：取消仅影响同一发起者的任务；已完成/未知 ID 也安全返回。 */
  'media:cancel': { req: { requestId: string }; res: { ok: true } };
  /** v3：在有界内存中打开文档，之后逐页只传句柄，关闭或超时后释放。 */
  'pdf:open': { req: ImageInput & { noCache?: boolean }; res: { documentHandle: string; documentId: string } };
  'pdf:close': { req: { documentHandle: string }; res: { ok: true } };
  'ocr:image': { req: ImageInput & { requestId?: string; sourceLang?: LangCode; targetLang?: LangCode; translate?: boolean; mode?: Mode; noCache?: boolean }; res: OcrResult };
  'subtitle:translate': { req: { videoId: string; segments: SubtitleInput[]; sourceLang: LangCode; targetLang: LangCode; mode?: Mode; context?: PageContext; noCache?: boolean }; res: { segments: SubtitleOutput[] } };
  'pdf:translate': { req: ImageInput & { requestId?: string; documentHandle?: string; sourceLang: LangCode; targetLang: LangCode; mode?: Mode; pages?: number[]; noCache?: boolean }; res: PdfResult };
}
