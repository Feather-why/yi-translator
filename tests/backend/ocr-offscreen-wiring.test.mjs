import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = await readFile(new URL('../../src/entrypoints/offscreen/media.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
async function flush() { for (let index = 0; index < 150; index++) await Promise.resolve(); }

function load(t, mode) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const frames = [], calls = []; let oldReply;
  const expected = { width: 4, height: 4, blocks: [{ text: 'public image', confidence: 0.9, box: [[0, 0], [4, 0], [4, 4], [0, 4]] }] };
  class Channel {
    constructor() {
      this.port1 = { onmessage: undefined, onmessageerror: undefined, closed: false, close() { this.closed = true; } };
      this.port2 = { close() {}, reply: (data) => { if (!this.port1.closed) queueMicrotask(() => this.port1.onmessage?.({ data })); } };
    }
  }
  const document = { createElement: () => {
    const id = frames.length + 1;
    const frame = { removed: false, hidden: false, src: '', onload: undefined, onerror: undefined,
      remove() { this.removed = true; }, contentWindow: { postMessage(message, _origin, ports) {
        calls.push({ frame: id, task: message.task, dataUrl: message.payload?.dataUrl });
        const reply = () => ports[0].reply({ id: message.id, ok: true, data: message.task === 'init' ? { ready: true } : expected });
        if (id === 1 && (mode === 'predict-timeout' && message.task === 'predict' || mode === 'init-timeout' && message.task === 'init')) { oldReply = reply; return; }
        if (id === 1 && mode === 'model-error' && message.task === 'predict') { ports[0].reply({ id: message.id, ok: false }); return; }
        reply();
      } } };
    frames.push(frame); return frame;
  }, body: { append(frame) { queueMicrotask(() => frame.onload?.()); } } };
  const hashes = ['781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30', 'f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c'];
  const bytes = (url) => { const value = new Uint8Array(1024); value[0] = url.includes('_det_') ? 0 : 1; return value; };
  const exports = {}, filename = path.join(path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled'), 'entrypoints/offscreen/media.js');
  const context = { exports, module: { exports }, require: createRequire(filename), document, MessageChannel: Channel,
    chrome: { runtime: { getURL: (file) => `chrome-extension://fixture/${file}` } },
    caches: { open: async () => ({ match: async (url) => new Response(bytes(url)), delete: async () => {}, put: async () => {} }) },
    crypto: { randomUUID, subtle: { digest: async (_algorithm, data) => Uint8Array.from(hashes[new Uint8Array(data)[0]].match(/../g), (part) => parseInt(part, 16)).buffer } },
    Response, Uint8Array, AbortController, AbortSignal, DOMException, Date, setTimeout, clearTimeout, console,
    fetch: () => { throw new Error('生产接线回放不能访问网络或下载模型'); } };
  // 加载真正的offscreen入口源码，只替换浏览器边界和公开模型字节校验，不运行OCR/WASM。
  vm.runInNewContext(code, context, { filename });
  return { api: exports, frames, calls, expected, late: () => oldReply?.(), async advance(ms) { t.mock.timers.tick(ms); await flush(); } };
}

for (const [mode, timeout] of [['predict-timeout', 180_000], ['init-timeout', 200_000]]) test(`生产offscreen接线：${mode}真实移除iframe并重新init/predict，旧回信无效`, async (t) => {
  const harness = load(t, mode), tasks = {};
  harness.api.registerMediaTasks(tasks);
  const work = tasks['media:ocr']({ dataUrl: 'data:image/png;base64,cHVibGlj' }); await flush();
  assert.equal(harness.frames.length, 1); assert.equal(harness.frames[0].removed, false);
  await harness.advance(timeout);
  assert.deepEqual(JSON.parse(JSON.stringify(await work)), harness.expected);
  assert.equal(harness.frames.length, 2); assert.equal(harness.frames[0].removed, true);
  assert.equal(harness.frames[1].removed, false);
  harness.late(); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(await harness.api.runOcr('data:image/png;base64,bmV4dA=='))), harness.expected);
  assert.equal(harness.frames.length, 2);
  assert.equal(harness.calls.filter((row) => row.frame === 2 && row.task === 'init').length, 1);
  await harness.advance(600_000); assert.equal(harness.frames[1].removed, true);
});

test('生产offscreen接线：模型明确错误不会当通信故障重复执行，后续请求仍能重建', async (t) => {
  const harness = load(t, 'model-error');
  await assert.rejects(harness.api.runOcr('data:image/png;base64,YmFk'), /加载或推理失败/);
  assert.equal(harness.frames.length, 1); assert.equal(harness.frames[0].removed, true);
  assert.equal(harness.calls.filter((row) => row.task === 'predict').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(await harness.api.runOcr('data:image/png;base64,Z29vZA=='))), harness.expected);
  assert.equal(harness.frames.length, 2); await harness.advance(600_000);
});
