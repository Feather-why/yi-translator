interface PdfEntry<T> {
  value: Promise<T>;
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
  close: () => Promise<void>;
}

/** 离屏 PDF.js 文档只驻留有限内存；同一文档逐页复用，关闭会终止在途页操作。 */
export class PdfDocumentPool<T> {
  private entries = new Map<string, PdfEntry<T>>();
  private bytes = 0;
  constructor(private options: { open(bytes: Uint8Array, signal: AbortSignal): Promise<T>; destroy(value: T): Promise<void>; ttlMs?: number; maxBytes?: number; maxEntries?: number }) {}
  async open(id: string, bytes: Uint8Array, signal = new AbortController().signal): Promise<void> {
    signal.throwIfAborted();
    if (this.entries.has(id)) throw new Error('PDF 会话编号重复');
    const maxBytes = this.options.maxBytes ?? 64 * 1024 * 1024, maxEntries = this.options.maxEntries ?? 3;
    if (bytes.byteLength > maxBytes) throw new Error('PDF 会话超过内存上限');
    while (this.entries.size >= maxEntries || this.bytes + bytes.byteLength > maxBytes) await this.close(this.entries.keys().next().value!);
    signal.throwIfAborted();
    if (this.entries.has(id)) throw new Error('PDF 会话编号重复');
    const controller = new AbortController();
    const entry: PdfEntry<T> = { bytes: bytes.byteLength, controller, value: Promise.resolve().then(() => { controller.signal.throwIfAborted(); return this.options.open(bytes, controller.signal); }), close: async () => {} };
    this.entries.set(id, entry); this.bytes += entry.bytes;
    entry.close = async () => { controller.abort(new DOMException('PDF 会话已关闭', 'AbortError')); try { await this.options.destroy(await entry.value); } catch { /* 加载失败或已经销毁仍算关闭。 */ } };
    this.touch(id, entry);
    const abort = () => { void this.close(id); };
    signal.addEventListener('abort', abort, { once: true });
    try { await entry.value; controller.signal.throwIfAborted(); }
    catch (error) { await this.close(id); throw error; }
    finally { signal.removeEventListener('abort', abort); }
  }
  private touch(id: string, entry: PdfEntry<T>) {
    clearTimeout(entry.timer); this.entries.delete(id); this.entries.set(id, entry);
    entry.timer = setTimeout(() => { void this.close(id); }, this.options.ttlMs ?? 300_000);
  }
  async use<R>(id: string, signal: AbortSignal, action: (value: T, signal: AbortSignal) => Promise<R>): Promise<R | undefined> {
    const entry = this.entries.get(id); if (!entry) return undefined;
    this.touch(id, entry); const combined = AbortSignal.any([signal, entry.controller.signal]);
    combined.throwIfAborted(); const value = await entry.value; combined.throwIfAborted();
    return action(value, combined);
  }
  async close(id: string) {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id); this.bytes -= entry.bytes; clearTimeout(entry.timer);
    await entry.close();
  }
  async dispose() { await Promise.all([...this.entries.keys()].map(id => this.close(id))); }
  get size() { return this.entries.size; }
}
