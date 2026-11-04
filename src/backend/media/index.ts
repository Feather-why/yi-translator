import type { BackendRpcMap, OcrResult, PdfResult, SubtitleOutput } from '../../shared/backend-v2';
import type { ErrorInfo, Segment, TranslateJob } from '../../shared/protocol';
import { ProviderError } from '../providers/types';
import { offscreenRequest } from '../align/offscreen-client';
import { badMedia, loadMedia, withAbort } from './input';
import { cancelledMedia, expiredPdf, mediaId, MediaTaskRegistry } from './task-registry';

interface PendingOcr { controller: AbortController; work: Promise<OcrResult>; users: number; settled: boolean }
interface PdfSession { owner: string; documentId: string; noCache: boolean; controller: AbortController; timer?: ReturnType<typeof setTimeout> }
interface Translation { text: string; provider: string; cached: boolean }
export interface MediaOptions {
  translate(job: TranslateJob, segment: Segment, tier: 'fast' | 'accurate', signal: AbortSignal): Promise<Translation>;
  fetch?: typeof fetch;
  offscreen?: <T>(task: string, payload: unknown) => Promise<T>;
}
const failure = (error: unknown): ErrorInfo => error instanceof ProviderError ? error.info : { code: 'internal', message: '媒体片段翻译失败', retryable: true };

export class MediaService {
  // 只复用短时识别结果，不保存图片；敏感来源/noCache 完全绕过，译文不混入识别缓存。
  private ocrCache = new Map<string, { until: number; value: OcrResult }>();
  private ocrPending = new Map<string, PendingOcr>();
  private tasks = new MediaTaskRegistry();
  private sessions = new Map<string, PdfSession>();
  private lifetime = new AbortController();
  private openingPdf = 0;
  private fetcher: typeof fetch;
  private offscreen: <T>(task: string, payload: unknown) => Promise<T>;
  constructor(private options: MediaOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    // 首次权重下载、解码和识别共用一次调用，不能套用单句对齐的超时。
    this.offscreen = options.offscreen ?? (<T>(task: string, payload: unknown) => offscreenRequest<T>(task, payload, 300_000));
  }

  ocr(request: BackendRpcMap['ocr:image']['req'], signal = new AbortController().signal, owner = 'direct'): Promise<OcrResult> {
    return this.tasks.run(owner, request.requestId, AbortSignal.any([signal, this.lifetime.signal]), (active) => this.ocrWork(request, active));
  }
  cancel(request: BackendRpcMap['media:cancel']['req'], owner = 'direct') { return this.tasks.cancel(owner, request.requestId); }

  /** 每次实际离屏工作有自己的编号；共享调用只有最后一个订阅者退出才发取消。 */
  private async dispatch<T>(task: string, payload: object, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted(); const taskId = crypto.randomUUID();
    const cancel = () => { void this.offscreen('media:cancel', { taskId }).catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try { return await withAbort(this.offscreen<T>(task, { ...payload, taskId }), signal); }
    catch (error) { if (!signal.aborted) cancel(); throw error; }
    finally { signal.removeEventListener('abort', cancel); }
  }

  private async ocrWork(request: BackendRpcMap['ocr:image']['req'], signal: AbortSignal): Promise<OcrResult> {
    const input = await loadMedia(request, 'image', this.fetcher, signal);
    const digest = await this.hash(input.bytes);
    signal.throwIfAborted();
    const result = await this.recognize(input.dataUrl, digest, request.noCache === true, signal);
    if (!request.translate) return result;
    if (!request.targetLang || typeof request.targetLang !== 'string') throw badMedia('翻译 OCR 文字时需要目标语言');
    this.languages(request.sourceLang ?? 'auto', request.targetLang);
    const namespace = `ocr:${digest}`;
    for (let index = 0; index < result.blocks.length; index++) {
      signal.throwIfAborted();
      const block = result.blocks[index]!;
      if (!block.text.trim()) continue;
      const segment: Segment = { id: `ocr-${index}`, text: block.text, kind: 'ocr' };
      try { block.translation = (await this.options.translate(this.job(segment, request.sourceLang ?? 'auto', request.targetLang, request.mode, request.noCache, namespace), segment, request.mode === 'fast' ? 'fast' : 'accurate', signal)).text; }
      catch (error) { if (signal.aborted) throw error; block.error = failure(error); }
    }
    return result;
  }

  private async recognize(dataUrl: string, key: string, noCache: boolean, signal: AbortSignal): Promise<OcrResult> {
    const now = Date.now();
    for (const [id, entry] of this.ocrCache) if (entry.until <= now) this.ocrCache.delete(id);
    if (!noCache) {
      const hit = this.ocrCache.get(key);
      if (hit) { this.ocrCache.delete(key); this.ocrCache.set(key, hit); return structuredClone(hit.value); }
    }
    let entry = noCache ? undefined : this.ocrPending.get(key);
    if (entry?.controller.signal.aborted) entry = undefined;
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, users: 0, settled: false, work: Promise.resolve().then(() => this.dispatch<OcrResult>('media:ocr', { dataUrl }, controller.signal)).then((value) => { this.checkOcr(value); return value; }) };
      const created = entry;
      const clear = () => { created.settled = true; if (this.ocrPending.get(key) === created) this.ocrPending.delete(key); };
      void created.work.then(clear, clear);
      if (!noCache && this.ocrPending.size < 4) this.ocrPending.set(key, created);
    }
    entry.users++;
    try {
      const result = await withAbort(entry.work, signal);
      signal.throwIfAborted();
      if (!noCache && JSON.stringify(result).length <= 64_000) {
        this.ocrCache.delete(key);
        this.ocrCache.set(key, { until: Date.now() + 120_000, value: structuredClone(result) });
        while (this.ocrCache.size > 8) this.ocrCache.delete(this.ocrCache.keys().next().value!);
      }
      return structuredClone(result);
    } finally {
      if (--entry.users === 0 && !entry.settled) {
        entry.controller.abort(cancelledMedia());
        if (this.ocrPending.get(key) === entry) this.ocrPending.delete(key);
      }
    }
  }

  async subtitles(request: BackendRpcMap['subtitle:translate']['req'], signal = new AbortController().signal): Promise<{ segments: SubtitleOutput[] }> {
    if (!request || typeof request.videoId !== 'string' || !request.videoId || request.videoId.length > 300 || !Array.isArray(request.segments) || request.segments.length > 500) throw badMedia('字幕视频标识或行数无效');
    this.languages(request.sourceLang, request.targetLang);
    const ids = new Set<string>();
    let chars = 0;
    for (const item of request.segments) {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 128 || ids.has(item.id) || typeof item.text !== 'string' || item.text.length > 12_000
        || (item.startMs !== undefined && (!Number.isFinite(item.startMs) || item.startMs < 0)) || (item.endMs !== undefined && (!Number.isFinite(item.endMs) || item.endMs < (item.startMs ?? 0)))) throw badMedia('字幕编号、文本或时间区间无效');
      ids.add(item.id); chars += item.text.length;
    }
    if (chars > 200_000) throw badMedia('字幕批次过大');
    const results: SubtitleOutput[] = new Array(request.segments.length);
    for (let offset = 0; offset < request.segments.length; offset += 8) {
      signal.throwIfAborted();
      const chunk = request.segments.slice(offset, offset + 8);
      const summary = chunk.map((item) => item.text).join('\n').slice(0, 600);
      await Promise.all(chunk.map(async (item, relative) => {
        const output: SubtitleOutput = { ...item, source: item.text };
        results[offset + relative] = output;
        if (!item.text.trim()) return;
        const segment: Segment = { id: item.id, text: item.text, kind: 'subtitle', groupId: request.videoId };
        const job = this.job(segment, request.sourceLang, request.targetLang, request.mode, request.noCache, `subtitle:${request.videoId}`);
        job.context = { url: request.context?.url ?? 'https://www.youtube.com/', title: request.context?.title, summary };
        try { const translated = await this.options.translate(job, segment, request.mode === 'fast' ? 'fast' : 'accurate', signal); output.text = translated.text; output.provider = translated.provider; }
        catch (error) { if (signal.aborted) throw error; output.error = failure(error); }
      }));
    }
    signal.throwIfAborted();
    return { segments: results };
  }

  async openPdf(request: BackendRpcMap['pdf:open']['req'], owner = 'direct'): Promise<BackendRpcMap['pdf:open']['res']> {
    if (this.openingPdf >= 3) throw new ProviderError({ code: 'rate_limit', message: '正在打开的 PDF 过多，请稍后重试', retryable: true });
    this.openingPdf++;
    try { return await this.openPdfWork(request, owner); }
    finally { this.openingPdf--; }
  }
  private async openPdfWork(request: BackendRpcMap['pdf:open']['req'], owner: string): Promise<BackendRpcMap['pdf:open']['res']> {
    const signal = this.lifetime.signal;
    const input = await loadMedia(request, 'pdf', this.fetcher, signal);
    const documentId = await this.hash(input.bytes), documentHandle = crypto.randomUUID();
    signal.throwIfAborted();
    try {
      await this.dispatch('media:pdf:open', { dataUrl: input.dataUrl, documentHandle }, signal);
      // 不复用其他调用的会话，隐私请求仅在本次显式打开的生命周期内驻留内存。
      while (this.sessions.size >= 3) await this.releasePdf(this.sessions.keys().next().value!);
      signal.throwIfAborted();
      const entry: PdfSession = { owner, documentId, noCache: request.noCache === true, controller: new AbortController() };
      this.sessions.set(documentHandle, entry); this.touchPdf(documentHandle, entry);
      return { documentHandle, documentId };
    } catch (error) {
      void this.offscreen('media:pdf:close', { documentHandle }).catch(() => undefined); throw error;
    }
  }

  async closePdf(request: BackendRpcMap['pdf:close']['req'], owner = 'direct') {
    const handle = mediaId(request.documentHandle, '文档编号');
    const entry = this.sessions.get(handle);
    if (entry?.owner === owner) await this.releasePdf(handle);
    return { ok: true as const };
  }
  private touchPdf(handle: string, entry: PdfSession) {
    clearTimeout(entry.timer); this.sessions.delete(handle); this.sessions.set(handle, entry);
    entry.timer = setTimeout(() => { void this.releasePdf(handle); }, 300_000);
  }
  private async releasePdf(handle: string) {
    const entry = this.sessions.get(handle); if (!entry) return;
    this.sessions.delete(handle); clearTimeout(entry.timer); entry.controller.abort(cancelledMedia());
    await this.offscreen('media:pdf:close', { documentHandle: handle }).catch(() => undefined);
  }
  pdf(request: BackendRpcMap['pdf:translate']['req'], signal = new AbortController().signal, owner = 'direct'): Promise<PdfResult> {
    return this.tasks.run(owner, request.requestId, AbortSignal.any([signal, this.lifetime.signal]), async (active) => {
      let session: PdfSession | undefined;
      if (request.documentHandle !== undefined) {
        const handle = mediaId(request.documentHandle, '文档编号');
        session = this.sessions.get(handle);
        if (!session || session.owner !== owner) throw expiredPdf();
        if (request.url !== undefined || request.dataUrl !== undefined) throw badMedia('使用 PDF 会话时不应重复发送文档内容');
        this.touchPdf(handle, session);
        active = AbortSignal.any([active, session.controller.signal]);
      }
      return this.pdfWork({ ...request, noCache: request.noCache === true || session?.noCache === true }, active, session);
    });
  }
  private async pdfWork(request: BackendRpcMap['pdf:translate']['req'], signal: AbortSignal, session?: PdfSession): Promise<PdfResult> {
    this.languages(request.sourceLang, request.targetLang);
    if (request.pages !== undefined && (!Array.isArray(request.pages) || request.pages.length > 200 || new Set(request.pages).size !== request.pages.length || request.pages.some((page) => !Number.isInteger(page) || page < 1))) throw badMedia('PDF 页码列表无效');
    let documentId: string, result: PdfResult;
    if (session) {
      documentId = session.documentId;
      const extracted = await this.dispatch<PdfResult | { sessionExpired: true }>('media:pdf:read', { documentHandle: request.documentHandle, pages: request.pages, documentId }, signal);
      if (extracted && 'sessionExpired' in extracted) { await this.releasePdf(request.documentHandle!); throw expiredPdf(); }
      result = extracted;
    } else {
      const input = await loadMedia(request, 'pdf', this.fetcher, signal);
      documentId = await this.hash(input.bytes);
      result = await this.dispatch<PdfResult>('media:pdf', { dataUrl: input.dataUrl, pages: request.pages, documentId }, signal);
    }
    if (!result || !Array.isArray(result.pages) || result.pages.length > 200) throw badMedia('PDF 提取结果格式无效');
    result.documentId = documentId;
    for (const page of result.pages) {
      if (!Number.isInteger(page.page) || page.page < 1 || !Number.isFinite(page.width) || !Number.isFinite(page.height) || !Array.isArray(page.paragraphs) || page.paragraphs.length > 2000
        || page.paragraphs.some((item) => typeof item.id !== 'string' || typeof item.source !== 'string' || item.source.length > 12_000 || !Array.isArray(item.box) || item.box.length !== 4 || item.box.some((coordinate) => !Number.isFinite(coordinate)))) throw badMedia('PDF 段落或坐标无效');
      for (let offset = 0; offset < page.paragraphs.length; offset += 8) {
        signal.throwIfAborted();
        await Promise.all(page.paragraphs.slice(offset, offset + 8).map(async (paragraph) => {
          const segment: Segment = { id: paragraph.id, text: paragraph.source, kind: 'pdf', groupId: documentId };
          const job = this.job(segment, request.sourceLang, request.targetLang, request.mode, request.noCache, `pdf:${documentId}`);
          try { const translated = await this.options.translate(job, segment, request.mode === 'fast' ? 'fast' : 'accurate', signal); paragraph.translation = translated.text; paragraph.provider = translated.provider; }
          catch (error) { if (signal.aborted) throw error; paragraph.error = failure(error); }
        }));
      }
    }
    signal.throwIfAborted();
    return result;
  }

  async dispose() {
    this.lifetime.abort(cancelledMedia()); this.tasks.dispose(); this.ocrCache.clear();
    for (const entry of this.ocrPending.values()) entry.controller.abort(cancelledMedia());
    this.ocrPending.clear();
    await Promise.all([...this.sessions.keys()].map((handle) => this.releasePdf(handle)));
  }

  private job(segment: Segment, sourceLang: string, targetLang: string, mode: TranslateJob['mode'] = 'accurate', noCache = false, namespace: string): TranslateJob {
    return { jobId: `media-${crypto.randomUUID()}`, sourceLang, targetLang, mode, priority: 0, context: { url: 'https://translate.local/media' }, segments: [segment], noCache, cacheNamespace: namespace };
  }
  private languages(source: unknown, target: unknown) {
    if (typeof source !== 'string' || !source || typeof target !== 'string' || !target || target === 'auto') throw badMedia('媒体翻译语言无效');
  }
  private checkOcr(value: OcrResult) {
    if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width <= 0 || value.height <= 0 || value.width * value.height > 16_000_000 || !Array.isArray(value.blocks) || value.blocks.length > 2000
      || value.blocks.some((block) => typeof block.text !== 'string' || !Number.isFinite(block.confidence) || block.confidence < 0 || block.confidence > 1 || !Array.isArray(block.box) || block.box.length !== 4 || block.box.some((point) => !Array.isArray(point) || point.length !== 2 || point.some((coordinate) => !Number.isFinite(coordinate))))) throw badMedia('OCR 返回结果无效');
  }
  private async hash(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  }
}
