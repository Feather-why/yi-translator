import type { OcrResult, PdfResult } from '../../shared/backend-v2';
import { groupPdfText, type TextBox } from '../../backend/media/pdf-layout';
import { hasScannedBody, marginOnlyText, overlapsNative } from '../../backend/media/pdf-scan';
import { PdfDocumentPool } from '../../backend/media/pdf-pool';
import { MediaTaskRegistry, mediaId } from '../../backend/media/task-registry';
import { withAbort } from '../../backend/media/input';
import { OcrRunner, OcrWorkerUnavailableError, type OcrWorker } from '../../backend/media/ocr-runner';

const MODEL_BASE = 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/';
const MODEL_URLS = ['PP-OCRv5_mobile_det_onnx_infer.tar', 'PP-OCRv5_mobile_rec_onnx_infer.tar'].map((name) => MODEL_BASE + name);
// 固定本次核实的官方权重，避免同名下载地址变化后静默使用不同模型。
const MODEL_HASHES = ['781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30', 'f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c'];
async function modelBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  const cache = await caches.open('translate-ppocr-v5-mobile-v1');
  const stored = await cache.match(url);
  if (stored) { const bytes = await stored.arrayBuffer(); if (await validModel(bytes, url)) { signal.throwIfAborted(); return bytes; } await cache.delete(url); }
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) });
  if (!response.ok || !response.body) throw new Error('无法下载 PaddleOCR 官方模型');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 64 * 1024 * 1024) throw new Error('OCR 模型超过大小限制'); chunks.push(part.value); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  if (!await validModel(bytes.buffer, url)) throw new Error('OCR 官方模型完整性校验失败');
  signal.throwIfAborted();
  await cache.put(url, new Response(bytes)); return bytes.buffer;
}

async function validModel(bytes: ArrayBuffer, url: string): Promise<boolean> {
  if (bytes.byteLength < 1024 || bytes.byteLength > 64 * 1024 * 1024) return false;
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return hash === MODEL_HASHES[MODEL_URLS.indexOf(url)];
}

function createOcrWorker(): OcrWorker<OcrResult> {
  let element: HTMLIFrameElement | undefined, loaded: Promise<HTMLIFrameElement> | undefined, destroyed = false;
  const pending = new Set<() => void>();
  const frame = (signal: AbortSignal) => loaded ??= new Promise<HTMLIFrameElement>((resolve, reject) => {
    signal.throwIfAborted();
    const iframe = document.createElement('iframe'); element = iframe;
    const cleanup = () => { iframe.onload = null; iframe.onerror = null; signal.removeEventListener('abort', abort); pending.delete(cancel); };
    const cancel = () => { cleanup(); reject(new OcrWorkerUnavailableError('OCR 容器已关闭')); };
    const abort = () => { cleanup(); reject(signal.reason); };
    pending.add(cancel); signal.addEventListener('abort', abort, { once: true });
    iframe.hidden = true; iframe.src = chrome.runtime.getURL('ocr-sandbox.html');
    iframe.onload = () => { cleanup(); if (destroyed) reject(new OcrWorkerUnavailableError('OCR 容器已关闭')); else resolve(iframe); };
    iframe.onerror = () => { cleanup(); reject(new OcrWorkerUnavailableError('无法加载本地 OCR 容器')); };
    document.body.append(iframe);
  });
  const request = async <T>(task: 'init' | 'predict', payload: unknown, signal: AbortSignal, transfer: Transferable[] = []): Promise<T> => {
    const iframe = await frame(signal); signal.throwIfAborted();
    if (destroyed || !iframe.contentWindow) throw new OcrWorkerUnavailableError('OCR 容器已关闭');
    const channel = new MessageChannel(), id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { pending.delete(cancel); signal.removeEventListener('abort', abort); channel.port1.close(); channel.port2.close(); };
      const cancel = () => { cleanup(); reject(new OcrWorkerUnavailableError('OCR 容器已关闭')); };
      const abort = () => { cleanup(); reject(signal.reason); };
      pending.add(cancel); signal.addEventListener('abort', abort, { once: true });
      channel.port1.onmessage = (event) => {
        const result = event.data; if (destroyed || !result || result.id !== id || typeof result.ok !== 'boolean') return;
        cleanup(); if (result.ok) resolve(result.data as T); else reject(new Error('本地 OCR 模型加载或推理失败'));
      };
      channel.port1.onmessageerror = () => cancel();
      try { iframe.contentWindow!.postMessage({ target: 'tx-ocr-sandbox', id, task, payload }, '*', [channel.port2, ...transfer]); }
      catch { cancel(); }
      if (signal.aborted) abort();
    });
  };
  return {
    initialize: async (signal) => {
      const [det, rec] = await Promise.all(MODEL_URLS.map((url) => modelBytes(url, signal)));
      signal.throwIfAborted(); await request('init', { det, rec }, signal, [det!, rec!]);
    },
    predict: (dataUrl, signal) => request<OcrResult>('predict', { dataUrl }, signal),
    destroy: () => {
      destroyed = true;
      for (const cancel of [...pending]) cancel(); pending.clear();
      // 挂起的WASM任务无法通过队尾dispose解锁，移除本次拥有的iframe以结束旧上下文。
      element?.remove(); element = undefined; loaded = undefined;
    },
  };
}
const ocr = new OcrRunner({ create: createOcrWorker });
export const runOcr = (dataUrl: string, signal?: AbortSignal): Promise<OcrResult> => ocr.run(dataUrl, signal);

function decodeDataUrl(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > 35_000_000 || !/^data:application\/pdf;base64,[a-zA-Z0-9+/]+={0,2}$/.test(value)) throw new Error('PDF 内容格式无效');
  return Uint8Array.from(atob(value.slice(value.indexOf(',') + 1)), (character) => character.charCodeAt(0));
}

interface PdfPayload { dataUrl?: unknown; documentId?: unknown; pages?: unknown; documentHandle?: unknown; taskId?: string }
type PdfLoaded = Awaited<ReturnType<typeof loadPdf>>;
async function loadPdf(bytes: Uint8Array, signal: AbortSignal) {
  signal.throwIfAborted();
  const pdfjs = await import('pdfjs-dist');
  signal.throwIfAborted();
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('assets/pdf/pdf.worker.min.mjs');
  const loading = pdfjs.getDocument({ data: bytes, useSystemFonts: true, disableFontFace: true,
    cMapUrl: chrome.runtime.getURL('assets/pdf/cmaps/'), cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('assets/pdf/standard_fonts/'), wasmUrl: chrome.runtime.getURL('assets/pdf/wasm/'),
  });
  let destroyed: Promise<void> | undefined;
  const destroy = () => destroyed ??= loading.destroy();
  const abort = () => { void destroy().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const document = await withAbort(loading.promise, signal);
    return { pdfjs, document, destroy: async () => { signal.removeEventListener('abort', abort); await destroy(); } };
  } catch (error) { signal.removeEventListener('abort', abort); await destroy().catch(() => undefined); throw error; }
}
const pdfDocuments = new PdfDocumentPool<PdfLoaded>({ open: loadPdf, destroy: (value) => value.destroy() });

export async function extractPdf(payload: PdfPayload, signal = new AbortController().signal): Promise<PdfResult> {
  const loaded = await loadPdf(decodeDataUrl(payload.dataUrl), signal);
  try { return await extractDocument(loaded, payload, signal); }
  finally { await loaded.destroy(); }
}
async function extractDocument(loaded: PdfLoaded, payload: PdfPayload, signal: AbortSignal): Promise<PdfResult> {
  const { document, pdfjs } = loaded;
  signal.throwIfAborted();
  const result: PdfResult = { documentId: typeof payload.documentId === 'string' ? payload.documentId : '', pages: [], warnings: [] };
  {
    if (document.numPages > 200 && payload.pages === undefined) throw new Error('PDF 超过 200 页，请指定页码分批处理');
    const selected = payload.pages === undefined ? Array.from({ length: document.numPages }, (_, index) => index + 1) : payload.pages;
    if (!Array.isArray(selected) || selected.length > 200 || selected.some((value) => !Number.isInteger(value) || value < 1 || value > document.numPages)) throw new Error('PDF 页码超出范围');
    for (const pageNumber of selected as number[]) {
      signal.throwIfAborted();
      const page = await withAbort(document.getPage(pageNumber), signal);
      try {
        const viewport = page.getViewport({ scale: 1 });
        if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0 || viewport.width > 20_000 || viewport.height > 20_000) throw new Error('PDF 页面尺寸无效');
        const content = await withAbort(page.getTextContent(), signal); const items: TextBox[] = [];
        for (const item of content.items) {
          if (!('str' in item) || !item.str.trim()) continue;
          const transform = pdfjs.Util.transform(viewport.transform, item.transform);
          const height = Math.max(1, Math.hypot(transform[2]!, transform[3]!));
          const x = transform[4]!; const y = transform[5]! - height;
          items.push({ text: item.str, box: [Math.max(0, x), Math.max(0, y), Math.min(viewport.width, x + Math.max(0, item.width)), Math.min(viewport.height, y + height)] });
        }
        let paragraphs = groupPdfText(items, pageNumber); let scanned = paragraphs.length === 0;
        if (scanned || marginOnlyText(paragraphs, viewport.height)) {
          const scale = Math.min(2, 1800 / Math.max(viewport.width, viewport.height));
          const raster = page.getViewport({ scale }); const canvas = documentCanvas(Math.ceil(raster.width), Math.ceil(raster.height));
          try {
            // offscreen 文档不会刷新画面；display 模式等待 rAF 会一直挂起。
            const render = page.render({ canvas, viewport: raster, canvasContext: canvas.getContext('2d')!, intent: 'print' });
            const abort = () => render.cancel();
            signal.addEventListener('abort', abort, { once: true });
            try { await withAbort(render.promise, signal); }
            finally { signal.removeEventListener('abort', abort); if (signal.aborted) render.cancel(); }
            // 阅读器对仅有页眉/页码的扫描正文也走 pdf:translate，不能因有几个字符就跳过 OCR。
            scanned ||= hasScannedBody(paragraphs, viewport.height, { width: canvas.width, height: canvas.height, data: canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data, scale });
            if (scanned) {
              const ocr = await runOcr(canvas.toDataURL('image/png'), signal);
              const native = paragraphs;
              const detected = ocr.blocks.filter((block) => block.text.trim()).map((block, index) => ({ id: `p${pageNumber}-ocr-${index}`, source: block.text, box: [Math.min(...block.box.map((point) => point[0])) / scale, Math.min(...block.box.map((point) => point[1])) / scale, Math.max(...block.box.map((point) => point[0])) / scale, Math.max(...block.box.map((point) => point[1])) / scale] as [number, number, number, number] }));
              paragraphs = [...native, ...detected.filter((paragraph) => !overlapsNative(paragraph, native))].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
              if (!paragraphs.length) result.warnings.push(`第 ${pageNumber} 页未识别到文字`);
            }
          } finally { canvas.width = 1; canvas.height = 1; }
        }
        result.pages.push({ page: pageNumber, width: viewport.width, height: viewport.height, paragraphs, scanned });
      } finally { page.cleanup(); }
    }
  }
  signal.throwIfAborted();
  return result;
}

function documentCanvas(width: number, height: number): HTMLCanvasElement { const canvas = globalThis.document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas; }

const mediaTasks = new MediaTaskRegistry();
export function registerMediaTasks(tasks: Record<string, (payload: any) => Promise<unknown>>) {
  const run = <T>(payload: { taskId?: string }, action: (signal: AbortSignal) => Promise<T>) => mediaTasks.run('offscreen', payload.taskId, new AbortController().signal, action);
  tasks['media:cancel'] = async (payload) => mediaTasks.cancel('offscreen', payload.taskId);
  tasks['media:ocr'] = async (payload) => run(payload, (signal) => runOcr(payload.dataUrl, signal));
  tasks['media:pdf'] = async (payload) => run(payload, (signal) => extractPdf(payload, signal));
  tasks['media:pdf:open'] = async (payload) => run(payload, async (signal) => {
    await pdfDocuments.open(mediaId(payload.documentHandle, '文档编号'), decodeDataUrl(payload.dataUrl), signal);
    return { ok: true };
  });
  tasks['media:pdf:read'] = async (payload) => run(payload, async (signal) => {
    const result = await pdfDocuments.use(mediaId(payload.documentHandle, '文档编号'), signal, (loaded, active) => extractDocument(loaded, payload, active));
    // 离屏进程也可能重启，明确回传失效状态供后台/阅读器透明重开。
    return result ?? { sessionExpired: true };
  });
  tasks['media:pdf:close'] = async (payload) => { await pdfDocuments.close(mediaId(payload.documentHandle, '文档编号')); return { ok: true }; };
}
