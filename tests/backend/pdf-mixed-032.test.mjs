import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const build = path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled');
const { hasScannedBody, overlapsNative } = require(path.join(build, 'backend/media/pdf-scan.js'));
const source = await readFile(new URL('../../src/entrypoints/offscreen/media.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const header = { str: 'Public header', width: 80, transform: [1, 0, 0, 10, 20, 30] };
const body = { str: 'Native body text', width: 200, transform: [1, 0, 0, 12, 20, 300] };
const block = (text, box) => ({ text, confidence: .95, box: [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]] });
function pixels(width, height, kind) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = Math.floor(height * .2); y < height * .8; y++) for (let x = Math.floor(width * .12); x < width * .88; x++) {
    const dark = (kind === 'text' || kind === 'text-noise') ? y % 28 < 10 && x % 14 < 5 : kind === 'chart' && x < width * .65;
    if (dark) { const at = (y * width + x) * 4; data[at] = data[at + 1] = data[at + 2] = 0; }
  }
  if (kind === 'text-noise' || kind === 'noise') for (let y = Math.floor(height * .12); y < height * .88; y++) {
    const at = (y * width + Math.floor(width * .08)) * 4; data[at] = data[at + 1] = data[at + 2] = 0;
  }
  return data;
}
function load(items, kind, blocks) {
  const trace = { renders: 0, ocr: 0, destroyed: 0, cleaned: 0, canvas: undefined };
  const exports = {}, filename = path.join(build, 'entrypoints/offscreen/media.js'), localRequire = createRequire(filename);
  const pdfjs = { GlobalWorkerOptions: {}, Util: { transform: (_viewport, value) => value }, getDocument() { return {
    promise: Promise.resolve({ numPages: 1, async getPage() { return { getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale, transform: [1, 0, 0, 1, 0, 0] }),
      getTextContent: async () => ({ items }), render() { trace.renders++; return { promise: Promise.resolve() }; }, cleanup() { trace.cleaned++; } }; } }),
    async destroy() { trace.destroyed++; },
  }; } };
  const document = { createElement(name) { assert.equal(name, 'canvas'); const canvas = { width: 0, height: 0,
    getContext() { return { getImageData: () => ({ data: pixels(canvas.width, canvas.height, kind) }) }; }, toDataURL: () => 'data:image/png;base64,cHVibGlj' };
    trace.canvas = canvas; return canvas;
  } };
  const context = { exports, module: { exports }, require(name) {
    if (name === 'pdfjs-dist') return pdfjs;
    if (name.endsWith('/ocr-runner')) return { OcrRunner: class { async run() { trace.ocr++; return { blocks }; } } };
    return localRequire(name);
  }, document, chrome: { runtime: { getURL: file => `chrome-extension://fixture/${file}` } }, atob, Uint8Array, Uint8ClampedArray, AbortController, AbortSignal, DOMException, console };
  vm.runInNewContext(code, context, { filename });
  return { trace, async extract() { return JSON.parse(JSON.stringify(await exports.extractPdf({ dataUrl: 'data:application/pdf;base64,JVBERg==', pages: [1] }))); } };
}

test('原生正文页不渲染也不OCR', async () => {
  const harness = load([header, body], 'text', []), result = await harness.extract();
  assert.equal(result.pages[0].scanned, false); assert.equal(result.pages[0].paragraphs.length, 2);
  assert.equal(harness.trace.ocr, 0); assert.equal(harness.trace.renders, 0); assert.equal(harness.trace.destroyed, 1);
});

test('纯扫描页仍执行OCR且恢复PDF坐标', async () => {
  const harness = load([], 'text', [block('Scanned text', [40, 200, 500, 240])]), result = await harness.extract();
  assert.equal(result.pages[0].scanned, true); assert.equal(harness.trace.ocr, 1);
  assert.deepEqual(result.pages[0].paragraphs[0].box, [20, 100, 250, 120]);
  assert.equal(harness.trace.canvas.width, 1); assert.equal(harness.trace.canvas.height, 1);
});

test('仅页眉文字层+扫描正文会OCR，页眉重叠去重而正文保留', async () => {
  const harness = load([header], 'text', [block('OCR duplicate header', [40, 40, 200, 60]), block('Scanned body', [40, 300, 900, 340])]);
  const result = await harness.extract(), page = result.pages[0];
  assert.equal(page.scanned, true); assert.equal(harness.trace.ocr, 1); assert.equal(harness.trace.renders, 1);
  assert.deepEqual(page.paragraphs.map(p => p.source), ['Public header', 'Scanned body']);
  assert.deepEqual(page.paragraphs.map(p => p.box), [[20, 20, 100, 30], [20, 150, 450, 170]]);
});

test('已有完整隐藏文字层的扫描页不重复OCR', async () => {
  const harness = load([header, { ...body, str: 'Existing hidden OCR body text' }], 'text', [block('duplicate', [40, 300, 900, 340])]);
  const result = await harness.extract(); assert.equal(result.pages[0].scanned, false);
  assert.equal(harness.trace.ocr, 0); assert.equal(harness.trace.renders, 0); assert.equal(result.pages[0].paragraphs.length, 2);
});

for (const kind of ['blank', 'chart', 'noise']) test(`仅页眉加${kind}不误运行OCR`, async () => {
  const harness = load([header], kind, [block('must not appear', [40, 300, 900, 340])]), result = await harness.extract();
  assert.equal(result.pages[0].scanned, false); assert.equal(harness.trace.renders, 1); assert.equal(harness.trace.ocr, 0);
  assert.deepEqual(result.pages[0].paragraphs.map(p => p.source), ['Public header']);
});

test('扫描空白行的孤立噪点不会掩盖正文文字证据', async () => {
  const harness = load([header], 'text-noise', [block('Scanned noisy body', [40, 300, 900, 340])]);
  const result = await harness.extract();
  assert.equal(result.pages[0].scanned, true); assert.equal(harness.trace.ocr, 1);
  assert.ok(result.pages[0].paragraphs.some(p => p.source === 'Scanned noisy body'));
});

test('扫描正文分类与40%较小框重叠边界', () => {
  const native = [{ box: [10, 10, 110, 20] }];
  assert.equal(overlapsNative({ box: [70, 10, 170, 20] }, native), false);
  assert.equal(overlapsNative({ box: [69, 10, 169, 20] }, native), true);
  assert.equal(overlapsNative({ box: [10, 10, 10, 20] }, native), false);
  const image = { width: 600, height: 800, data: pixels(600, 800, 'text'), scale: 1 };
  assert.equal(hasScannedBody(native, 800, image), true);
  assert.equal(hasScannedBody([{ box: [10, 200, 500, 400] }], 800, image), false);
});
