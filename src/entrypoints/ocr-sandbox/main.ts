import { PaddleOCR } from '@paddleocr/paddleocr-js';
import type { OcrResult } from '../../shared/backend-v2';

// OpenCV 的代码生成只允许在无扩展权限的 sandbox 内运行。
const extensionBase = location.href.slice(0, location.href.lastIndexOf('/') + 1);
const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}/.exec(location.href)?.[0];
let engine: Awaited<ReturnType<typeof PaddleOCR.create>> | undefined;
let sequence = Promise.resolve();

async function initialize(payload: { det?: unknown; rec?: unknown }): Promise<{ ready: true }> {
  if (!(payload.det instanceof ArrayBuffer) || !(payload.rec instanceof ArrayBuffer)
    || payload.det.byteLength < 1024 || payload.rec.byteLength < 1024 || payload.det.byteLength > 64 * 1024 * 1024 || payload.rec.byteLength > 64 * 1024 * 1024) throw new Error('OCR 模型数据无效');
  if (!engine) {
    const assets: Record<string, ArrayBuffer> = { 'ocr-model:det': payload.det, 'ocr-model:rec': payload.rec };
    engine = await PaddleOCR.create({
      worker: false,
      textDetectionModelName: 'PP-OCRv5_mobile_det', textRecognitionModelName: 'PP-OCRv5_mobile_rec',
      textDetectionModelAsset: { url: 'ocr-model:det' }, textRecognitionModelAsset: { url: 'ocr-model:rec' },
      fetch: (async (input: RequestInfo | URL) => {
        const key = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const bytes = assets[key]; if (!bytes) throw new Error('OCR 模型地址不在允许列表中');
        return new Response(bytes);
      }) as typeof fetch,
      ortOptions: { backend: 'wasm', wasmPaths: `${extensionBase}assets/ocr-onnx/`, numThreads: 1, simd: true, proxy: false },
      // SDK 管线默认 min/64；只改边长会把矮图片放大到 960 像素高，破坏检测。
      textDetLimitSideLen: 960, textDetLimitType: 'max', textRecScoreThresh: 0.35,
    });
  }
  return { ready: true };
}

async function predict(payload: { dataUrl?: unknown }): Promise<OcrResult> {
  if (!engine || typeof payload.dataUrl !== 'string' || payload.dataUrl.length > 14_000_000 || !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/]+={0,2}$/.test(payload.dataUrl)) throw new Error('OCR 图片输入无效');
  const base64 = payload.dataUrl.slice(payload.dataUrl.indexOf(',') + 1);
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 16_000_000) throw new Error('OCR 图片像素数过大');
    const result = (await engine.predict(bitmap))[0]; if (!result) throw new Error('OCR 未返回结果');
    return {
      width: result.image.width, height: result.image.height, engine: 'paddleocr-js/0.4.2:wasm-cpu', model: 'PP-OCRv5_mobile_det+PP-OCRv5_mobile_rec',
      blocks: result.items.slice(0, 2000).map((item) => ({ text: item.text, confidence: Math.max(0, Math.min(1, item.score)), box: item.poly.map(([x, y]) => [Math.max(0, Math.min(result.image.width, x)), Math.max(0, Math.min(result.image.height, y))]) })),
    };
  } finally { bitmap.close(); }
}

window.addEventListener('message', (event: MessageEvent) => {
  if (!extensionOrigin || event.source !== parent || event.origin !== extensionOrigin || !event.ports[0]) return;
  const message = event.data;
  if (!message || message.target !== 'tx-ocr-sandbox' || typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id) || !['init', 'predict', 'dispose'].includes(message.task)) return;
  const port = event.ports[0];
  const work = async () => {
    if (message.task === 'dispose') { await engine?.dispose(); engine = undefined; return { disposed: true }; }
    if (message.task === 'init') return initialize(message.payload ?? {});
    return predict(message.payload ?? {});
  };
  sequence = sequence.then(async () => {
    try { port.postMessage({ id: message.id, ok: true, data: await work() }); }
    catch (error) { console.error('Local OCR engine failed', error); port.postMessage({ id: message.id, ok: false, error: '本地 OCR 模型加载或推理失败' }); }
    finally { port.close(); }
  }, () => undefined);
});
