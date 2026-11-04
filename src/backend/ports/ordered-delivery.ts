/** 同一批按阅读顺序短暂等前段；慢段最多阻挡250ms，不把推理改为串行。 */
export class OrderedDelivery<T extends { stage: 'fast' | 'final' }> {
  private visible = new Set<string>();
  private cancelled = new Set<string>();
  private pending = new Map<string, { value: T; at: number }[]>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private ids: string[], private send: (value: T) => void, private changed: () => void, private waitMs = 250) {}
  get waiting() { return this.pending.size > 0; }
  push(id: string, value: T) {
    if (this.closed || this.cancelled.has(id)) return;
    const previous = this.pending.get(id);
    const at = previous?.[0]?.at ?? performance.now();
    const rows = value.stage === 'final' ? [] : previous ?? [];
    rows.push({ value, at }); this.pending.set(id, rows); this.flush();
  }
  cancel(ids: string[]) { for (const id of ids) { this.cancelled.add(id); this.pending.delete(id); } this.flush(); }
  dispose() { this.closed = true; clearTimeout(this.timer); this.pending.clear(); }
  private flush() {
    clearTimeout(this.timer);
    if (this.closed) return;
    let blocked = false, next = Infinity;
    for (const id of this.ids) {
      if (this.cancelled.has(id)) continue;
      const rows = this.pending.get(id);
      if (rows?.length && (!blocked || this.visible.has(id) || performance.now() - rows[0]!.at >= this.waitMs)) {
        this.pending.delete(id); this.visible.add(id);
        for (const row of rows) this.send(row.value);
      } else if (rows?.length) next = Math.min(next, rows[0]!.at + this.waitMs - performance.now());
      if (!this.visible.has(id)) blocked = true;
    }
    if (Number.isFinite(next)) this.timer = setTimeout(() => this.flush(), Math.max(1, next));
    this.changed();
  }
}
