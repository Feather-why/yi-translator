import { ProviderError } from '../providers/types';

export const expiredPdf = () => new ProviderError({ code: 'bad_input', message: 'PDF 会话已失效，请重新打开文档', retryable: true });
export const cancelledMedia = () => new DOMException('媒体任务已取消', 'AbortError');
export function mediaId(value: unknown, label = '任务编号'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new ProviderError({ code: 'bad_input', message: `媒体${label}无效`, retryable: false });
  return value;
}

/** 请求号按浏览器提供的发起者隔离；短期墓碑处理 cancel 比原请求先到的竞态。 */
export class MediaTaskRegistry {
  private active = new Map<string, AbortController>();
  private cancelled = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  private key(owner: string, id: string) { return JSON.stringify([owner, id]); }
  cancel(owner: string, id: string) {
    mediaId(id);
    const key = this.key(owner, id);
    this.active.get(key)?.abort(cancelledMedia());
    const now = this.now();
    for (const [item, expiry] of this.cancelled) if (expiry <= now) this.cancelled.delete(item);
    this.cancelled.delete(key); this.cancelled.set(key, now + 30_000);
    while (this.cancelled.size > 256) this.cancelled.delete(this.cancelled.keys().next().value!);
    return { ok: true as const };
  }
  async run<T>(owner: string, id: string | undefined, outer: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    outer.throwIfAborted();
    if (id === undefined) return work(outer);
    mediaId(id); const key = this.key(owner, id);
    if ((this.cancelled.get(key) ?? 0) > this.now()) throw cancelledMedia();
    if (this.active.has(key)) throw new ProviderError({ code: 'bad_input', message: '媒体任务编号重复', retryable: false });
    if (this.active.size >= 64) throw new ProviderError({ code: 'rate_limit', message: '媒体任务过多，请稍后重试', retryable: true });
    const controller = new AbortController(); this.active.set(key, controller);
    try { return await work(AbortSignal.any([outer, controller.signal])); }
    finally { if (this.active.get(key) === controller) this.active.delete(key); }
  }
  dispose() { for (const controller of this.active.values()) controller.abort(cancelledMedia()); this.active.clear(); this.cancelled.clear(); }
}
