import type { ImageInput } from '../../shared/backend-v2';
import type { RpcMap } from '../../shared/protocol';
import { rpc, uid } from '../../shared/rpc';
import type { MediaCaps } from '../media/capabilities';

type TranslateInput = Omit<RpcMap['pdf:translate']['req'], keyof ImageInput | 'documentHandle'>;
const EXPIRED = 'PDF 会话已失效，请重新打开文档';

/** 文档仅上传一次；worker 重启后下一页透明重开一次，旧后端保持逐页兼容。 */
export class PdfBackendDocument {
  private handle?: string;
  private opening?: Promise<string>;
  private closed = false;
  private pending = new Set<string>();
  constructor(private source: ImageInput, private caps: MediaCaps, private noCache = false, private call: typeof rpc = rpc) {}

  private open(): Promise<string> {
    if (this.closed) return Promise.reject(new DOMException('Document closed', 'AbortError'));
    if (this.handle) return Promise.resolve(this.handle);
    if (!this.opening) {
      const opening = this.call('pdf:open', { ...this.source, noCache: this.noCache || undefined }).then((r) => {
        if (this.closed) {
          void this.call('pdf:close', { documentHandle: r.documentHandle }).catch(() => {});
          throw new DOMException('Document closed', 'AbortError');
        }
        this.handle = r.documentHandle;
        return r.documentHandle;
      });
      this.opening = opening;
      void opening.finally(() => { if (this.opening === opening) this.opening = undefined; }).catch(() => {});
    }
    return this.opening;
  }

  async translate(input: TranslateInput, signal?: AbortSignal): Promise<RpcMap['pdf:translate']['res']> {
    const requestId = input.requestId ?? uid('pdfocr');
    const valid = () => {
      if (this.closed || signal?.aborted) throw new DOMException('Document closed', 'AbortError');
    };
    const cancel = () => this.cancel(requestId);
    valid();
    this.pending.add(requestId);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const handle = this.caps.pdfSessions ? await this.open() : undefined;
        valid();
        try {
          const result = await this.call('pdf:translate', {
            ...(handle ? { documentHandle: handle } : this.source), ...input,
            requestId: this.caps.cancel ? requestId : undefined, noCache: this.noCache || input.noCache || undefined,
          });
          valid();
          return result;
        } catch (e) {
          valid();
          const info = (e as { info?: { code?: string; message?: string; retryable?: boolean } }).info;
          if (attempt || !handle || info?.code !== 'bad_input' || info.message !== EXPIRED || !info.retryable) throw e;
          if (this.handle === handle) this.handle = undefined;
        }
      }
      throw new Error(EXPIRED);
    } finally {
      this.pending.delete(requestId);
      signal?.removeEventListener('abort', cancel);
    }
  }

  cancel(requestId: string): void {
    if (this.caps.cancel) void this.call('media:cancel', { requestId }).catch(() => {});
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const requestId of this.pending) this.cancel(requestId);
    this.pending.clear();
    const handle = this.handle;
    this.handle = undefined;
    if (handle) void this.call('pdf:close', { documentHandle: handle }).catch(() => {});
  }
}
