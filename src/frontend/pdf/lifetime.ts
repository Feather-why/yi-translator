/** 每份文档只活一代；异步结果与监听器共用同一个终止信号。 */
export class ReaderLifetime {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private cleanups = new Set<() => void>();
  get active(): boolean { return !this.signal.aborted; }
  add(cleanup: () => void): () => void {
    if (!this.active) cleanup();
    else this.cleanups.add(cleanup);
    return () => this.cleanups.delete(cleanup);
  }
  dispose(): void {
    if (!this.active) return;
    this.controller.abort();
    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch { /* 一个资源释放失败不妨碍其余资源 */ }
    }
    this.cleanups.clear();
  }
}

/** 只淘汰已完成且不在阅读区域内的页，保留译文模型供返回时本地重画。 */
export function distantPages<T extends { n: number; state: string; canvas?: { width: number; height: number }; sheet?: { width: number; height: number } }>(
  pages: T[], current: number, visible: Set<number>, maxPages = 8, maxPixels = 24_000_000,
): T[] {
  const resident = pages.filter((p) => p.canvas);
  let count = resident.length;
  const pixels = (p: T) => (p.canvas ? p.canvas.width * p.canvas.height : 0) + (p.sheet ? p.sheet.width * p.sheet.height : 0);
  let total = resident.reduce((n, p) => n + pixels(p), 0);
  const evict: T[] = [];
  for (const p of resident.filter((p) => p.state !== 'working' && !visible.has(p.n) && p.n !== current)
    .sort((a, b) => Math.abs(b.n - current) - Math.abs(a.n - current))) {
    if (count <= maxPages && total <= maxPixels) break;
    evict.push(p);
    count--;
    total -= pixels(p);
  }
  return evict;
}
