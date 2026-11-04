/**
 * 首屏耗时记录：点下翻译 → 准备（查站点规则、扫描段落）→ 后台排队 → 服务翻译 → 显示。
 * 每次整页翻译记一条，存在 chrome.storage.local（最多 30 条），「服务状态」页读出来画成条形图。
 * 后台在 result 里带了 timing 就用它拆出排队和翻译；没带就只显示「后台」一整段。
 */
import type { Mode, SegmentTiming, Stage } from '../../shared/protocol';
import { rpc } from '../../shared/rpc';

export const PERF_LOG_KEY = 'ui.perfLog';
const MAX_ENTRIES = 30;

export interface PerfEntry {
  at: number;
  host: string;
  mode: Mode;
  /** 首屏段落数 */
  segments: number;
  /** 点击到第一批请求发出 */
  prepareMs: number;
  /** 点击到第一段出现任何文字（含流式的第一个字） */
  firstMs?: number;
  /** 点击到首屏全部出现快速译文 */
  fastMs?: number;
  /** 点击到首屏全部出现最终译文（或失败） */
  finalMs: number;
  /** 最慢那一段在后台的拆分（后台提供时才有） */
  queueMs?: number;
  providerMs?: number;
  firstTokenMs?: number;
  cached: number;
  streamed: number;
  errors: number;
  retries: number;
  ruleCached: boolean;
}

interface Seg {
  fast?: number;
  final?: number;
  timing?: SegmentTiming;
  cached?: boolean;
  streamed?: boolean;
  error?: boolean;
}

export class FirstScreenPerf {
  private segs = new Map<string, Seg>();
  private sealed = false;
  private sentAt = 0;
  private firstAt = 0;
  private done = false;
  ruleCached = false;

  constructor(private t0: number, private mode: Mode) {}

  /** 首屏段落：第一批 priority 0 发出之前登记的都算。 */
  expect(segId: string): void {
    if (!this.sealed) this.segs.set(segId, {});
  }

  sent(): void {
    if (this.sealed) return;
    this.sealed = true;
    this.sentAt = performance.now();
    if (!this.segs.size) this.done = true;
  }

  partial(segId: string): void {
    const s = this.segs.get(segId);
    if (!s) return;
    s.streamed = true;
    if (!this.firstAt) this.firstAt = performance.now();
  }

  result(segId: string, stage: Stage, cached: boolean, timing?: SegmentTiming): void {
    const s = this.segs.get(segId);
    if (!s || this.done) return;
    const now = performance.now();
    if (!this.firstAt) this.firstAt = now;
    if (!s.fast) s.fast = now;
    if (stage === 'final' || this.mode !== 'combined') {
      s.final = now;
      s.cached = cached;
      if (timing) s.timing = timing;
    } else if (timing && !s.timing) s.timing = timing;
    this.check();
  }

  error(segId: string, stage: Stage): void {
    const s = this.segs.get(segId);
    if (!s || this.done) return;
    if (stage === 'fast' && this.mode === 'combined') return;
    s.final = performance.now();
    s.error = true;
    this.check();
  }

  /** 首屏的段落被移除（站点改了 DOM）：不再等它。 */
  drop(segId: string): void {
    if (this.segs.delete(segId)) this.check();
  }

  private check() {
    if (this.done || !this.sealed) return;
    const all = [...this.segs.values()];
    if (!all.length || all.some((s) => !s.final)) return;
    this.done = true;
    let slowest = all[0];
    for (const s of all) if ((s.final ?? 0) > (slowest.final ?? 0)) slowest = s;
    const ms = (t?: number) => (t ? Math.max(0, Math.round(t - this.t0)) : undefined);
    const fastTimes = all.map((s) => s.fast ?? s.final!);
    const entry: PerfEntry = {
      at: Date.now(),
      host: location.hostname,
      mode: this.mode,
      segments: all.length,
      prepareMs: ms(this.sentAt) ?? 0,
      firstMs: ms(this.firstAt),
      fastMs: this.mode === 'combined' ? ms(Math.max(...fastTimes)) : undefined,
      finalMs: ms(Math.max(...all.map((s) => s.final!))) ?? 0,
      queueMs: slowest.timing?.queueMs,
      providerMs: slowest.timing?.providerMs,
      firstTokenMs: slowest.timing?.firstTokenMs,
      cached: all.filter((s) => s.cached).length,
      streamed: all.filter((s) => s.streamed).length,
      errors: all.filter((s) => s.error).length,
      retries: all.reduce((n, s) => n + (s.timing?.retries ?? 0), 0),
      ruleCached: this.ruleCached,
    };
    void save(entry);
    rpc('perf:report', {
      url: location.origin,
      mode: this.mode,
      firstScreenMs: entry.firstMs ?? entry.finalMs,
      segments: entry.segments,
      firstScreenFastMs: entry.fastMs,
      firstScreenFinalMs: entry.finalMs,
      prepareMs: entry.prepareMs,
    }).catch(() => {});
  }
}

async function save(entry: PerfEntry): Promise<void> {
  try {
    const got: Record<string, unknown> = await chrome.storage.local.get(PERF_LOG_KEY);
    const list = parsePerfLog(got[PERF_LOG_KEY]);
    list.unshift(entry);
    await chrome.storage.local.set({ [PERF_LOG_KEY]: list.slice(0, MAX_ENTRIES) });
  } catch {
    /* 存不下也不影响翻译 */
  }
}

/** 存储里的东西类型不可信，逐项检查。 */
export function parsePerfLog(value: unknown): PerfEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((e): e is PerfEntry =>
    !!e && typeof e === 'object' && typeof (e as PerfEntry).at === 'number' && typeof (e as PerfEntry).finalMs === 'number'
    && typeof (e as PerfEntry).host === 'string' && typeof (e as PerfEntry).prepareMs === 'number');
}
