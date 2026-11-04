import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = path.join(root, 'work/b3-offscreen-fixture');
const extension = path.join(fixtureRoot, 'dist');
await mkdir(fixtureRoot, { recursive: true });
await writeFile(path.join(fixtureRoot, 'harness.html'), '<html><body><h1>B3 integration fixture</h1><script type="module" src="./harness.ts"></script></body></html>');
await writeFile(path.join(fixtureRoot, 'harness.ts'), `import { Dictionary } from '../../src/backend/dict/index'; (window as Window & {dictionary: Dictionary}).dictionary = new Dictionary();`);
await writeFile(path.join(fixtureRoot, 'offscreen.html'), '<html><body><script type="module" src="../../src/entrypoints/offscreen/main.ts"></script></body></html>');
await build({ configFile: false, root: fixtureRoot, base: './', publicDir: path.join(root, 'public'), logLevel: 'warn',
  build: { outDir: extension, emptyOutDir: true, rolldownOptions: { input: { offscreen: path.join(fixtureRoot, 'offscreen.html'), harness: path.join(fixtureRoot, 'harness.html') } } } });
// 不依赖最终后台集成，fixture 直接验证真实 offscreen 源文件、CSP 与本机 WASM。
await writeFile(path.join(extension, 'background.js'), 'chrome.runtime.onMessage.addListener(()=>false);');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Translate B3 integration fixture', version: '1.0.0',
  permissions: ['offscreen', 'storage', 'unlimitedStorage'], host_permissions: ['https://huggingface.co/*', 'https://*.hf.co/*'],
  background: { service_worker: 'background.js' }, content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" } }));
await access(path.join(extension, 'assets/onnx/ort-wasm-simd-threaded.wasm'));
const temporary = await realpath(os.tmpdir());
const profile = await mkdtemp(path.join(temporary, 'translate-b3-offscreen-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE, ignoreDefaultArgs: ['--disable-extensions'] } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  // 此处回放的是官方固定修订的真实权重字节，推理仍由浏览器 CPU WASM 真正执行。
  await context.route('https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('761b726dd34fb83930e26aab4e9ac3899aa1fa78/')[1];
    if (!['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'].includes(name)) { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: name.endsWith('.json') ? 'application/json' : 'application/octet-stream', body: await readFile(path.join(root, 'work/align-model-cache/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78', name)) });
  });
  let [worker] = context.serviceWorkers(); if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/harness.html`);
  await page.waitForFunction(() => window.dictionary);
  const imported = await page.evaluate(async () => { const start = performance.now(); await window.dictionary.ready(); return { ms: performance.now() - start, status: window.dictionary.status() }; });
  assert.equal(imported.status.entries, 100000);
  const actualWords = await page.evaluate(() => new Promise((resolve, reject) => {
    const operation = indexedDB.open('translate-ecdict'); operation.onsuccess = () => { const db = operation.result; const count = db.transaction('words').objectStore('words').count(); count.onsuccess = () => { resolve(count.result); db.close(); }; count.onerror = () => reject(count.error); }; operation.onerror = () => reject(operation.error);
  }));
  assert.equal(actualWords, 100000);
  const dictionary = await page.evaluate(async () => { const start = performance.now(); const result = await window.dictionary.lookup('running'); return { ms: performance.now() - start, result }; });
  assert.equal(dictionary.result.lemma, 'run'); assert.ok(dictionary.ms < 20);
  await worker.evaluate(() => chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'B3 integration CPU model test' }));
  const init = await page.evaluate(async () => { const start = performance.now(); const result = await chrome.runtime.sendMessage({ target: 'tx-offscreen', task: 'align:init', payload: {} }); return { ms: performance.now() - start, result }; });
  assert.equal(init.result.ok, true);
  const pair = { id: 'apple', source: 'I like apples.', target: '我喜欢苹果。', sourceLang: 'en', targetLang: 'zh-CN' };
  const alignment = await page.evaluate(async (pair) => { const start = performance.now(); const result = await chrome.runtime.sendMessage({ target: 'tx-offscreen', task: 'align:get', payload: { pairs: [pair] } }); return { ms: performance.now() - start, result }; }, pair);
  assert.equal(alignment.result.ok, true);
  const result = alignment.result.data[0];
  assert.ok(result.links.some(([a, b]) => pair.source.slice(...result.srcTokens[a]) === 'apples' && pair.target.slice(...result.tgtTokens[b]) === '苹果'));
  assert.deepEqual(errors, []);
  const report = { at: new Date().toISOString(), dictionaryImport: imported, dictionaryLookup: dictionary, modelInitialize: init, modelAlign: alignment };
  await writeFile(path.join(root, 'work/b3-offscreen-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ dictionaryEntries: imported.status.entries, dictionaryImportMs: Math.round(imported.ms), lookupMs: dictionary.ms, modelInitMs: Math.round(init.ms), alignMs: Math.round(alignment.ms), links: result.links }));
} finally {
  if (context) await context.close();
  const resolved = await realpath(profile);
  if (resolved.startsWith(temporary + path.sep) && path.basename(resolved).startsWith('translate-b3-offscreen-')) await rm(resolved, { recursive: true, force: true });
}
