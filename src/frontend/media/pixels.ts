/**
 * 从图片 / 画布读像素，估计一块文字区域的背景色和文字色，用于「抹掉原字、按原样写上译文」。
 */
export type RGB = [number, number, number];

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** 像素坐标 = 原图坐标 × scale。 */
  scale: number;
}

export interface BoxColors {
  bg: RGB;
  bgL: RGB;
  bgR: RGB;
  fg: RGB;
  /** 框内「墨水」占比，用来估计字重。 */
  ink: number;
}

export const rgb = (c: RGB, a = 1) => (a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`);

const lum = (c: RGB) => {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
export const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

function medianRGB(px: RGB[]): RGB {
  if (!px.length) return [255, 255, 255];
  const ch = (i: 0 | 1 | 2) => px.map((p) => p[i]).sort((a, b) => a - b)[px.length >> 1];
  return [ch(0), ch(1), ch(2)];
}

export function fromCanvas(ctx: CanvasRenderingContext2D, scale: number): Pixels {
  const { width, height } = ctx.canvas;
  return { data: ctx.getImageData(0, 0, width, height).data, width, height, scale };
}

/** blob: 地址只能在网页中读取。优先用已有的编码，失效地址或其他格式从已显示的图像异步生成 PNG。 */
export async function blobImageDataUrl(img: HTMLImageElement, url: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  // 与后台 OCR 的输入限制一致，避免分配一幅后台一定会拒绝的巨大画布。
  const maxBytes = 10 * 1024 * 1024;
  if (img.naturalWidth * img.naturalHeight > 16_000_000) throw new Error('OCR image exceeds 16 megapixels');
  let blob: Blob | null = null;
  try {
    const response = await fetch(url, {signal});
    if (response.ok) {
      const original = await response.blob();
      if (original.size <= maxBytes && /^image\/(?:png|jpeg|webp)$/.test(original.type)) blob = original;
    }
  } catch { /* 网页可能在图片解码后撤销临时 URL，此时还能从已加载的图片生成 PNG。 */ }
  signal.throwIfAborted();
  if (!blob) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    try {
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    } finally {
      canvas.width = canvas.height = 0;
    }
  }
  signal.throwIfAborted();
  if (!blob || !blob.size || blob.size > maxBytes) throw new Error('OCR image must be at most 10 MiB');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.onabort = () => reject(signal.reason);
    reader.onloadend = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, {once:true});
    reader.readAsDataURL(blob);
  });
}

/** 读图片像素：同源或允许跨域的图片直接画；否则用 CORS 重新取一次；都不行返回 null。 */
export async function readImagePixels(img: HTMLImageElement, natW: number, natH: number, signal?: AbortSignal): Promise<Pixels | null> {
  signal?.throwIfAborted();
  const scale = Math.min(1, 1600 / Math.max(natW, natH));
  const w = Math.max(1, Math.round(natW * scale));
  const h = Math.max(1, Math.round(natH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  try {
    ctx.drawImage(img, 0, 0, w, h);
    return fromCanvas(ctx, scale);
  } catch {
    /* 跨域图片，画布被污染 */
  }
  try {
    const src = img.currentSrc || img.src;
    const res = await fetch(src, { mode: 'cors', credentials: 'omit', signal });
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const c2 = document.createElement('canvas');
    c2.width = w;
    c2.height = h;
    const x2 = c2.getContext('2d', { willReadFrequently: true })!;
    try {
      signal?.throwIfAborted();
      x2.drawImage(bmp, 0, 0, w, h);
    } finally { bmp.close(); }
    return fromCanvas(x2, scale);
  } catch {
    return null;
  }
}

const at = (p: Pixels, x: number, y: number): RGB | null => {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= p.width || yi >= p.height) return null;
  const i = (yi * p.width + xi) * 4;
  return [p.data[i], p.data[i + 1], p.data[i + 2]];
};

/** 保留原本的取样间距和起点，只枚举落在图片内的像素。 */
function sampleRange(from: number, to: number, step: number, size: number): [number, number] {
  const first = Math.round(from);
  const start = first + Math.max(0, Math.ceil(-first / step)) * step;
  const end = first + Math.floor((to - from) / step) * step;
  return [start, Math.min(size - 1, end)];
}

const MAX_DISTANCE = 3 * 255 * 255;
// 每个页面复用一份计数表。RGB 的平方距离是小整数，可用两级直方图找到最远四分之一的分界。
let colorWorkspace: { counts: Uint32Array; bands: Uint32Array } | undefined;

function medianChannel(histogram: Uint32Array, offset: number, total: number): number {
  let index = total >> 1;
  for (let value = 0; value < 256; value++) {
    index -= histogram[offset + value];
    if (index < 0) return value;
  }
  return 0;
}

function foreground(p: Pixels, bg: RGB, step: number, xs: [number, number], ys: [number, number]) {
  const [x0, x1] = xs, [y0, y1] = ys;
  const columns = Math.max(0, 1 + Math.floor((x1 - x0) / step));
  const rows = Math.max(0, 1 + Math.floor((y1 - y0) / step));
  const pixels = p.data;
  let count = 0;
  const { counts: distanceCounts, bands: distanceBands } = colorWorkspace ??= {
    counts: new Uint32Array(MAX_DISTANCE + 1), bands: new Uint32Array((MAX_DISTANCE >> 8) + 1),
  };
  distanceCounts.fill(0);
  distanceBands.fill(0);
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const i = (y * p.width + x) * 4;
      const dr = pixels[i] - bg[0], dg = pixels[i + 1] - bg[1], db = pixels[i + 2] - bg[2];
      const d = dr * dr + dg * dg + db * db;
      if (d <= 64 * 64) continue;
      distanceCounts[d]++;
      distanceBands[d >> 8]++;
      count++;
    }
  }
  if (!count) return { color: null, ink: 0 };
  const keep = Math.ceil(count / 4);
  let remaining = keep;
  let band = distanceBands.length - 1;
  while (remaining > distanceBands[band]) remaining -= distanceBands[band--];
  let cutoff = Math.min(MAX_DISTANCE, (band << 8) + 255);
  while (remaining > distanceCounts[cutoff]) remaining -= distanceCounts[cutoff--];
  const rgbCounts = new Uint32Array(3 * 256);
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const i = (y * p.width + x) * 4;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const dr = r - bg[0], dg = g - bg[1], db = b - bg[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < cutoff || (d === cutoff && !remaining)) continue;
      if (d === cutoff) remaining--; // 同距离时保留原来的扫描顺序。
      rgbCounts[r]++;
      rgbCounts[256 + g]++;
      rgbCounts[512 + b]++;
    }
  }
  const color: RGB = [medianChannel(rgbCounts, 0, keep), medianChannel(rgbCounts, 256, keep), medianChannel(rgbCounts, 512, keep)];
  return { color, ink: count / (columns * rows) };
}

/**
 * 估计一个框（原图坐标）的背景与文字颜色：
 * 背景 = 框外一圈像素的中位数（左右两半分别算，用来画渐变）；
 * 文字 = 框内离背景色最远的那批像素的中位数。
 */
export function sampleBox(p: Pixels, x0: number, y0: number, x1: number, y1: number): BoxColors {
  const s = p.scale;
  const [X0, Y0, X1, Y1] = [x0 * s, y0 * s, x1 * s, y1 * s];
  const hh = Math.max(1, Y1 - Y0);
  const pad = Math.max(2, hh * 0.18);
  const step = Math.max(1, Math.floor(hh / 10));
  const left: RGB[] = [];
  const right: RGB[] = [];
  const mid = (X0 + X1) / 2;
  const [leftX, rightX] = sampleRange(X0 - pad, X1 + pad, step, p.width);
  const xOffset = (X0 - pad) - Math.round(X0 - pad);
  for (let x = leftX; x <= rightX; x += step) {
    for (const y of [Y0 - pad, Y1 + pad]) {
      const c = at(p, x, y);
      if (c) (x + xOffset < mid ? left : right).push(c);
    }
  }
  const [topY, bottomY] = sampleRange(Y0, Y1, step, p.height);
  for (let y = topY; y <= bottomY; y += step) {
    const a = at(p, X0 - pad, y);
    const b = at(p, X1 + pad, y);
    if (a) left.push(a);
    if (b) right.push(b);
  }
  const bgL = medianRGB(left.length ? left : right);
  const bgR = medianRGB(right.length ? right : left);
  const bg = medianRGB([...left, ...right]);
  const st2 = Math.max(1, Math.floor(Math.min(hh, 48) / 16));
  const { color, ink } = foreground(p, bg, st2, sampleRange(X0, X1, st2, p.width), sampleRange(Y0, Y1, st2, p.height));
  const fg: RGB = color && contrast(color, bg) >= 2.2 ? color : lum(bg) > 0.4 ? [24, 24, 28] : [250, 250, 250];
  return { bg, bgL, bgR, fg, ink };
}
