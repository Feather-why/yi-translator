import { ProviderError } from '../providers/types';
import type { ImageInput } from '../../shared/backend-v2';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const badMedia = (message: string) => new ProviderError({ code: 'bad_input', message, retryable: false });

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

export function mediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') return 'application/pdf';
  return undefined;
}

function declaredPixels(bytes: Uint8Array, mime: string): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png' && bytes.length >= 24) return view.getUint32(16) * view.getUint32(20);
  if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1]!;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return view.getUint16(offset + 5) * view.getUint16(offset + 7);
      if (marker === 0xd9 || marker === 0xda) break;
      const length = view.getUint16(offset + 2); if (length < 2) break; offset += length + 2;
    }
  }
  if (mime === 'image/webp' && bytes.length >= 30) {
    const kind = String.fromCharCode(...bytes.subarray(12, 16));
    if (kind === 'VP8X') return (1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16)) * (1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16));
    if (kind === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) return (view.getUint16(26, true) & 0x3fff) * (view.getUint16(28, true) & 0x3fff);
    if (kind === 'VP8L' && bytes[20] === 47) { const bits = view.getUint32(21, true); return ((bits & 0x3fff) + 1) * (((bits >>> 14) & 0x3fff) + 1); }
  }
  return undefined;
}

export async function loadMedia(input: ImageInput, kind: 'image' | 'pdf', fetcher: typeof fetch, signal: AbortSignal): Promise<{ bytes: Uint8Array; dataUrl: string; mime: string }> {
  signal.throwIfAborted();
  if (!input || typeof input !== 'object' || (!!input.url === !!input.dataUrl)) throw badMedia('只能提供一个媒体 URL 或 data URL');
  const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_PDF_BYTES;
  let bytes: Uint8Array;
  if (input.dataUrl) {
    if (typeof input.dataUrl !== 'string' || input.dataUrl.length > Math.ceil(limit * 4 / 3) + 200) throw badMedia('媒体内容超过大小限制');
    const match = /^data:(image\/(?:png|jpeg|webp)|application\/pdf);base64,([a-zA-Z0-9+/]*={0,2})$/.exec(input.dataUrl);
    if (!match || match[2]!.length % 4 !== 0) throw badMedia('媒体 data URL 格式无效');
    try { bytes = Uint8Array.from(atob(match[2]!), (character) => character.charCodeAt(0)); } catch { throw badMedia('媒体 base64 无效'); }
  } else {
    let url: URL;
    try { url = new URL(input.url!); } catch { throw badMedia('媒体地址格式无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw badMedia('媒体地址只接受无凭据的 HTTP(S)');
    const response = await fetcher(url.href, { credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    if (!response.ok || !response.body) throw new ProviderError({ code: 'network', message: '无法读取媒体文件', retryable: true });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) { await response.body.cancel(); throw badMedia('媒体内容超过大小限制'); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) throw badMedia('媒体内容超过大小限制'); chunks.push(part.value); }
      bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > limit) throw badMedia('媒体为空或超过大小限制');
  const mime = mediaType(bytes);
  if (!mime || (kind === 'pdf' ? mime !== 'application/pdf' : !mime.startsWith('image/'))) throw badMedia(kind === 'pdf' ? '输入不是有效 PDF 文件' : '仅支持 PNG、JPEG 或 WebP 图片');
  if (kind === 'image') { const pixels = declaredPixels(bytes, mime); if (pixels !== undefined && (!pixels || pixels > MAX_IMAGE_PIXELS)) throw badMedia('图片像素数超过 1600 万限制'); }
  return { bytes, mime, dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}` };
}

export function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('请求已取消', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('请求已取消', 'AbortError')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    void work.then((value) => { cleanup(); if (signal.aborted) reject(signal.reason); else resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
