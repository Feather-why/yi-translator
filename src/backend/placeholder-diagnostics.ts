export interface PlaceholderDiagnostic {
  kind: 'placeholder-projection' | 'placeholder-leaves';
  outcome: 'success' | 'unresolved' | 'error' | 'cancelled';
  strategy: 'anchored' | 'lazy' | 'leaves';
  sourceChars: number;
  groups: number;
  atoms: number;
  /** helper 调用翻译回调次数，外层重试和回调内部的分块 HTTP 另计。 */
  modelCalls: number;
  anchorCalls: number;
  plainCalls: number;
  leafCalls: number;
  lookupCalls: number;
  alignmentCalls: number;
  totalMs: number;
  modelMs: number;
  lookupMs: number;
  alignmentMs: number;
  restoreMs: number;
}
export type PlaceholderDiagnosticHandler = (record: PlaceholderDiagnostic) => void;

/** 只记录计数和耗时；不包含原文、译文、URL、术语或密钥。 */
export class PlaceholderMeasurements {
  readonly record: PlaceholderDiagnostic;
  private started = performance.now();
  constructor(kind: PlaceholderDiagnostic['kind'], strategy: PlaceholderDiagnostic['strategy'], sourceChars: number, private handler?: PlaceholderDiagnosticHandler) {
    this.record = { kind, strategy, sourceChars, outcome: 'unresolved', groups: 0, atoms: 0, modelCalls: 0, anchorCalls: 0, plainCalls: 0, leafCalls: 0,
      lookupCalls: 0, alignmentCalls: 0, totalMs: 0, modelMs: 0, lookupMs: 0, alignmentMs: 0, restoreMs: 0 };
  }
  async model<T>(counter: 'anchorCalls' | 'plainCalls' | 'leafCalls', work: () => Promise<T>): Promise<T> {
    this.record.modelCalls++; this.record[counter]++;
    const start = performance.now();
    try { return await work(); } finally { this.record.modelMs += performance.now() - start; }
  }
  async auxiliary<T>(kind: 'lookup' | 'alignment', work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    if (kind === 'lookup') this.record.lookupCalls++; else this.record.alignmentCalls++;
    try { return await work(); }
    finally { if (kind === 'lookup') this.record.lookupMs += performance.now() - start; else this.record.alignmentMs += performance.now() - start; }
  }
  finish(outcome: PlaceholderDiagnostic['outcome']) {
    this.record.outcome = outcome; this.record.totalMs = performance.now() - this.started;
    this.record.restoreMs = Math.max(0, this.record.totalMs - this.record.modelMs - this.record.lookupMs - this.record.alignmentMs);
    // 可观测性故障不能改变翻译交付、占位符校验或取消语义。
    try { this.handler?.({ ...this.record }); } catch { /* 诊断使用独立快照，回调异常不传播。 */ }
  }
}
