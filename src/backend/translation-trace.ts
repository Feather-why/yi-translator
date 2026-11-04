import type { SegmentTiming } from '../shared/protocol';
import type { TranslationObserver } from './translation-observer';

export interface RequestObservation {
  onRequestStart?: (at: number) => void;
  onRequestEnd?: (at: number) => void;
  onPartial?: (text: string, index: number, replay?: boolean) => void;
  onRetry?: () => void;
  retryState?: { active: boolean };
}
interface RequestEvent { start: boolean; at: number }

/** 同一次实际工作在两档之间共享时，仅回放瞬时时序，不复用别的段落/页面。 */
export class RequestTimeline {
  private events: RequestEvent[] = [];
  private listeners = new Set<RequestObservation>();
  private retries = 0;
  readonly observation: RequestObservation = {
    onRequestStart: (at) => this.record(true, at),
    onRequestEnd: (at) => this.record(false, at),
    onRetry: () => { this.retries++; for (const listener of this.listeners) { try { listener.onRetry?.(); } catch { /* 观察者隔离。 */ } } },
  };
  private record(start: boolean, at: number) {
    if (!Number.isFinite(at)) return;
    this.events.push({ start, at });
    for (const listener of this.listeners) this.send(listener, { start, at });
  }
  private send(listener: RequestObservation, event: RequestEvent) {
    try { if (event.start) listener.onRequestStart?.(event.at); else listener.onRequestEnd?.(event.at); } catch { /* 观察者不改变真实调用。 */ }
  }
  subscribe(listener: RequestObservation) {
    for (const event of this.events) this.send(listener, event);
    for (let index = 0; index < this.retries; index++) { try { listener.onRetry?.(); } catch { /* 观察者隔离。 */ } }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** 仅存本次调用的时刻；不包含原文、译文、jobId，也不进入缓存或匿名全局统计。 */
export class TranslationTrace {
  private events: RequestEvent[] = [];
  private receivedAt: number;
  private closed = false;
  private firstTokenMs?: number;
  private firstTokenProvider?: string;
  private retries = 0;
  private retryState = { active: false };
  constructor(private observer?: TranslationObserver, private now: () => number = () => performance.now()) {
    const current = now(), supplied = observer?.receivedAt;
    this.receivedAt = typeof supplied === 'number' && Number.isFinite(supplied) ? Math.min(current, supplied) : current;
  }
  branch(provider: string, signal: AbortSignal, preview: boolean, finalOnly?: () => boolean): RequestObservation {
    let requestAt: number | undefined;
    return {
      onRequestStart: (at) => { if (!this.closed) { requestAt = at; this.events.push({ start: true, at }); } },
      onRequestEnd: (at) => { if (!this.closed) this.events.push({ start: false, at }); },
      onRetry: () => { if (!this.closed) { this.retries++; this.retryState.active = true; } },
      retryState: this.retryState,
      ...(preview && this.observer?.onPartial ? { onPartial: (text: string, _index: number, replay = false) => {
        if (this.closed || signal.aborted || typeof text !== 'string' || text.length > 128_000) return;
        // 半个XML标记不是首字；原始g/x仍交前端作暂时预览，最终结果另行严格校验。
        const visible = text.replace(/<[^>]*>/g, '').replace(/<[^>]*$/g, '').trim();
        if (!replay && visible && this.firstTokenMs === undefined && requestAt !== undefined) { this.firstTokenMs = Math.max(0, this.now() - requestAt); this.firstTokenProvider = provider; }
        try { this.observer?.onPartial?.({ text, provider, ...(finalOnly?.() ? { finalOnly: true } : {}) }); } catch { /* 预览异常不能中断最终译文。 */ }
      } } : {}),
    };
  }
  finish(cached = false, provider?: string): SegmentTiming {
    const end = this.now(); this.closed = true;
    if (cached || !this.events.length) return { queueMs: Math.max(0, end - this.receivedAt), providerMs: 0, retries: 0 };
    const events = this.events.filter((event) => Number.isFinite(event.at)).sort((a, b) => a.at - b.at || Number(b.start) - Number(a.start));
    let active = 0, since = 0, providerMs = 0;
    for (const event of events) {
      const at = Math.min(end, event.at);
      if (event.start) { if (active++ === 0) since = at; }
      else if (active > 0 && --active === 0) providerMs += Math.max(0, at - since);
    }
    if (active) providerMs += Math.max(0, end - since);
    const first = events.find((event) => event.start)?.at ?? end;
    return { queueMs: Math.max(0, first - this.receivedAt), providerMs, retries: this.retries,
      ...(this.firstTokenMs === undefined || provider !== undefined && provider !== this.firstTokenProvider ? {} : { firstTokenMs: this.firstTokenMs }) };
  }
}
