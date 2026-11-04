export interface PdfTextRegion { box: [number, number, number, number] }
export interface PdfPixels { width: number; height: number; data: Uint8ClampedArray; scale: number }

/** 与阅读器的候选条件保持一致：完整隐藏文字层已有正文时，不再次运行 OCR。 */
export function marginOnlyText(paragraphs: readonly PdfTextRegion[], height: number): boolean {
  return paragraphs.length > 0 && paragraphs.every(({ box }) => box[3] < height * 0.12 || box[1] > height * 0.88);
}

/** 页眉下的大幅照片/图表不能仅凭墨迹率当成扫描正文，还要有足够的横向字符变化。 */
export function hasScannedBody(paragraphs: readonly PdfTextRegion[], height: number, pixels: PdfPixels): boolean {
  if (!marginOnlyText(paragraphs, height)) return false;
  const { width, height: rasterHeight, data, scale } = pixels;
  const boxes = paragraphs.map(({ box }) => [box[0] * scale - 4, box[1] * scale - 4, box[2] * scale + 4, box[3] * scale + 4]);
  const hist = new Uint32Array(256); let total = 0;
  const luminance = (x: number, y: number) => Math.round(0.3 * data[(y * width + x) * 4]! + 0.59 * data[(y * width + x) * 4 + 1]! + 0.11 * data[(y * width + x) * 4 + 2]!);
  for (let y = Math.floor(rasterHeight * 0.12); y < rasterHeight * 0.88; y += 3) {
    for (let x = Math.floor(width * 0.06); x < width * 0.94; x += 3) {
      if (boxes.some((box) => x >= box[0]! && x <= box[2]! && y >= box[1]! && y <= box[3]!)) continue;
      const value = luminance(x, y); hist[value] = hist[value]! + 1; total++;
    }
  }
  if (!total) return false;
  let paper = 255, accumulated = 0;
  for (; paper > 0; paper--) { accumulated += hist[paper]!; if (accumulated >= total / 2) break; }
  const threshold = Math.max(0, paper - 50); let ink = 0;
  for (let value = 0; value < threshold; value++) ink += hist[value]!;
  if (ink / total <= 0.015) return false;
  const transitions: number[] = [];
  for (let y = Math.floor(rasterHeight * 0.12); y < rasterHeight * 0.88; y += 4) {
    let previous = false, count = 0, darkPixels = 0;
    for (let x = Math.floor(width * 0.06); x < width * 0.94; x++) {
      const dark = luminance(x, y) < threshold;
      if (dark !== previous) count++;
      if (dark) darkPixels++;
      previous = dark;
    }
    // 扫描纸张的孤立噪点会铺满空白行；只让有实际笔画量的行参与中位数。
    // 否则正文之间的单像素噪点会把真实文字页的交替中位数压到2～4。
    if (darkPixels >= Math.max(8, Math.ceil(width * 0.01))) transitions.push(count);
  }
  transitions.sort((a, b) => a - b);
  return transitions.length > 0 && transitions[transitions.length >> 1]! >= 28;
}

/** 在同一 PDF 坐标系去重，保留原生文字层的准确文字与边界。 */
export function overlapsNative(ocr: PdfTextRegion, native: readonly PdfTextRegion[]): boolean {
  const [x0, y0, x1, y1] = ocr.box;
  return native.some(({ box: [left, top, right, bottom] }) => {
    const intersection = Math.max(0, Math.min(x1, right) - Math.max(x0, left)) * Math.max(0, Math.min(y1, bottom) - Math.max(y0, top));
    const smaller = Math.min(Math.max(0, x1 - x0) * Math.max(0, y1 - y0), Math.max(0, right - left) * Math.max(0, bottom - top));
    return smaller > 0 && intersection / smaller > 0.4;
  });
}
