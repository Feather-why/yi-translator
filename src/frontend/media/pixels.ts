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

/** 读图片像素：同源或允许跨域的图片直接画；否则用 CORS 重新取一次；都不行返回 null。 */
export async function readImagePixels(img: HTMLImageElement, natW: number, natH: number): Promise<Pixels | null> {
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
    const res = await fetch(src, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const c2 = document.createElement('canvas');
    c2.width = w;
    c2.height = h;
    const x2 = c2.getContext('2d', { willReadFrequently: true })!;
    x2.drawImage(bmp, 0, 0, w, h);
    bmp.close();
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
  for (let x = X0 - pad; x <= X1 + pad; x += step) {
    for (const y of [Y0 - pad, Y1 + pad]) {
      const c = at(p, x, y);
      if (c) (x < mid ? left : right).push(c);
    }
  }
  for (let y = Y0; y <= Y1; y += step) {
    const a = at(p, X0 - pad, y);
    const b = at(p, X1 + pad, y);
    if (a) left.push(a);
    if (b) right.push(b);
  }
  const bgL = medianRGB(left.length ? left : right);
  const bgR = medianRGB(right.length ? right : left);
  const bg = medianRGB([...left, ...right]);
  const inkPx: [number, RGB][] = [];
  let total = 0;
  const st2 = Math.max(1, Math.floor(Math.min(hh, 48) / 16));
  for (let y = Y0; y <= Y1; y += st2) {
    for (let x = X0; x <= X1; x += st2) {
      const c = at(p, x, y);
      if (!c) continue;
      total++;
      const d = Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]);
      if (d > 64) inkPx.push([d, c]);
    }
  }
  inkPx.sort((a, b) => b[0] - a[0]);
  // 取离背景最远的四分之一：避开抗锯齿的半透明边缘，得到真正的文字颜色
  let fg = medianRGB(inkPx.slice(0, Math.max(1, Math.ceil(inkPx.length * 0.25))).map(([, c]) => c));
  if (!inkPx.length || contrast(fg, bg) < 2.2) fg = lum(bg) > 0.4 ? [24, 24, 28] : [250, 250, 250];
  return { bg, bgL, bgR, fg, ink: total ? inkPx.length / total : 0 };
}
