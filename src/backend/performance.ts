import type { PerformanceRow, PerformanceSnapshot } from '../shared/backend-v2';
import type { PlaceholderDiagnostic } from './placeholder-diagnostics';
import type { ProviderTiming } from './providers/types';
import { PriorityQueue } from './scheduler/queue';

type Outcome = 'success' | 'failure' | 'cancelled';
export type PerformanceEvent =
  | { type: 'http'; providerId: string; outcome: Outcome; durationMs: number }
  | { type: 'logical'; providerId?: string; tier: 'fast' | 'accurate'; outcome: Outcome; durationMs: number; cached?: boolean }
  | { type: 'queue'; lane: 'fast' | 'final'; outcome: 'started' | 'cancelled-before-start'; durationMs: number }
  | { type: 'shared'; providerId: string; outcome: 'created' | 'reused' }
  | ({ type: 'model'; providerId: string } & ProviderTiming)
  | ({ type: 'placeholder'; providerId: string } & PlaceholderDiagnostic);

const MAX_ROWS = 128;
const finite = (value: unknown, limit = 86_400_000): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= limit;
const sum = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const providerId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : 'other';
type Table = 'http' | 'logical' | 'queue' | 'placeholder' | 'modelTiming' | 'shared';

/** 仅保留有界、固定维度聚合；未知字段永不进入快照，也不连接存储或同步。 */
export class PerformanceMetrics {
  private since: number;
  private tables: Record<Table, Map<string, PerformanceRow>> = { http: new Map(), logical: new Map(), queue: new Map(), placeholder: new Map(), modelTiming: new Map(), shared: new Map() };
  constructor(private clock: () => number = Date.now) { this.since = clock(); }
  private add(table: Table, dimensions: Omit<PerformanceRow, 'count' | 'totalMs' | 'minMs' | 'maxMs' | 'counters'>, duration: number, counters?: Record<string, number>) {
    const map = this.tables[table]; let key = JSON.stringify(dimensions), row = map.get(key);
    if (!row && map.size >= MAX_ROWS - 1) { key = 'overflow'; dimensions = { kind: 'overflow', outcome: 'aggregated' }; row = map.get(key); }
    if (!row) { row = { ...dimensions, count: 0, totalMs: 0, minMs: duration, maxMs: duration }; map.set(key, row); }
    row.count = sum(row.count, 1); row.totalMs = sum(row.totalMs, duration); row.minMs = Math.min(row.minMs, duration); row.maxMs = Math.max(row.maxMs, duration);
    if (counters) for (const [name, value] of Object.entries(counters)) {
      if (!finite(value, Number.MAX_SAFE_INTEGER)) continue;
      row.counters ??= {}; row.counters[name] = sum(row.counters[name] ?? 0, value);
    }
  }
  record(event: PerformanceEvent): void {
    // 诊断不能改变业务结果；含getter的意外对象也不传播错误。
    try {
      if (!event || typeof event !== 'object') return;
      const id = providerId('providerId' in event ? event.providerId : undefined);
      if (event.type === 'http' || event.type === 'logical') {
        if (!['success', 'failure', 'cancelled'].includes(event.outcome) || !finite(event.durationMs)) return;
        if (event.type === 'http') this.add('http', { providerId: id, outcome: event.outcome }, event.durationMs);
        else if (['fast', 'accurate'].includes(event.tier)) this.add('logical', { providerId: id, tier: event.tier, outcome: event.outcome, cache: event.outcome === 'success' ? event.cached ? 'hit' : 'miss' : 'none' }, event.durationMs);
      } else if (event.type === 'queue') {
        if (['fast', 'final'].includes(event.lane) && ['started', 'cancelled-before-start'].includes(event.outcome) && finite(event.durationMs)) this.add('queue', { lane: event.lane, outcome: event.outcome }, event.durationMs);
      } else if (event.type === 'shared') {
        if (['created', 'reused'].includes(event.outcome)) this.add('shared', { providerId: id, outcome: event.outcome }, 0);
      } else if (event.type === 'model' && event.phase === 'model') {
        for (const field of ['promptMs', 'generationMs', 'promptTokens', 'outputTokens'] as const) {
          const value = event[field]; if (!finite(value, field.endsWith('Tokens') ? 1_000_000_000 : 86_400_000)) continue;
          this.add('modelTiming', { providerId: id, kind: field, outcome: 'reported' }, field.endsWith('Ms') ? value : 0, field.endsWith('Tokens') ? { tokens: value } : undefined);
        }
      } else if (event.type === 'placeholder') {
        if (!['placeholder-projection', 'placeholder-leaves'].includes(event.kind) || !['anchored', 'lazy', 'leaves'].includes(event.strategy)
          || !['success', 'unresolved', 'error', 'cancelled'].includes(event.outcome) || !finite(event.totalMs)) return;
        const counters: Record<string, number> = {};
        for (const field of ['sourceChars', 'groups', 'atoms', 'modelCalls', 'anchorCalls', 'plainCalls', 'leafCalls', 'lookupCalls', 'alignmentCalls', 'modelMs', 'lookupMs', 'alignmentMs', 'restoreMs'] as const) {
          const value = event[field]; if (finite(value, field.endsWith('Ms') ? 86_400_000 : 1_000_000_000)) counters[field] = value;
        }
        this.add('placeholder', { providerId: id, kind: event.kind + ':' + event.strategy, outcome: event.outcome }, event.totalMs, counters);
      }
    } catch { /* 可观测性异常不影响翻译或取消。 */ }
  }
  snapshot(): PerformanceSnapshot {
    const result = { since: this.since, capturedAt: this.clock() } as PerformanceSnapshot;
    for (const table of Object.keys(this.tables) as Table[]) result[table] = [...this.tables[table].values()].map((row) => ({ ...row, ...(row.counters ? { counters: { ...row.counters } } : {}) }));
    return result;
  }
}

/** 从排入逻辑队列到实际run；取消前未出队不记作started。 */
export class MeasuredQueue extends PriorityQueue {
  constructor(private report: (event: PerformanceEvent) => void, concurrency = 32, private measureNow: () => number = () => performance.now()) { super(concurrency); }
  override add<T>(priority: number, signal: AbortSignal, run: () => Promise<T>, lane: 'fast' | 'final' = 'fast') {
    const queued = this.measureNow(); let started = false, cancelled = false;
    const emit = (outcome: 'started' | 'cancelled-before-start') => { try { this.report({ type: 'queue', lane, outcome, durationMs: Math.max(0, this.measureNow() - queued) }); } catch { /* 统计回调隔离。 */ } };
    const abort = () => { if (!started && !cancelled) { cancelled = true; emit('cancelled-before-start'); } };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    return super.add(priority, signal, async () => {
      started = true; signal.removeEventListener('abort', abort); emit('started'); return run();
    }, lane);
  }
}
