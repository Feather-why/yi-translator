import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work/media-e2e-real'));
process.env.EXT_DIR ||= path.join(root, '.output/chrome-mv3');
const model = new URL(process.env.LLAMA_URL || 'http://127.0.0.1:8081');
assert.ok(['http:', 'https:'].includes(model.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(model.hostname) && !model.username && !model.password, '真实媒体验收只允许显式本机模型地址');
const modelAddress = model.href.replace(/\/+$/, '').replace(/\/v1$/, '');
const modelHeaders = process.env.LLAMA_API_KEY ? { Authorization: `Bearer ${process.env.LLAMA_API_KEY}` } : {};
assert.equal((await fetch(modelAddress + '/health', { headers: modelHeaders, signal: AbortSignal.timeout(10000) })).status, 200, '请先启动真实本机llama-server');
const profileRoot = path.join(root, 'work/browser-profiles');
await mkdir(profileRoot, { recursive: true }); await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(await realpath(profileRoot), 'media-e2e-real-'));
const source = await readFile(path.join(root, 'tests/e2e/media.mjs'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = { extension: path.resolve(process.env.EXT_DIR), frontendTestSha256: hash(source), frontendSteps: [...source.toString().matchAll(/await step\(/g)].length, reducedMotion: true, realOcrModels: [], llamaResponses: [] };
let modelDirectory = path.resolve(process.env.OCR_MODEL_CACHE || path.join(root, 'work/media-model-cache'));
if (!process.env.OCR_MODEL_CACHE) {
  try { await access(path.join(modelDirectory, 'PP-OCRv5_mobile_det_onnx_infer.tar')); }
  catch {
    const previousWorkspaceCache = path.resolve(root, '../translate-next/work/media-model-cache');
    try { await access(path.join(previousWorkspaceCache, 'PP-OCRv5_mobile_det_onnx_infer.tar')); modelDirectory = previousWorkspaceCache; }
    catch { /* 独立仓库没有本机权重缓存时，使用生产首次下载路径。 */ }
  }
}
const artifacts = [
  { kind: 'det', sha256: '781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30' },
  { kind: 'rec', sha256: 'f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c' },
];
let context, closeContext, frontendExit, auditError;
const observedResponses = [];
const launch = chromium.launchPersistentContext.bind(chromium);

chromium.launchPersistentContext = async (directory, options) => {
  // 无障碍的“减少动态效果”只关闭显字动画，避免把最终译文截图拍成动画中的随机字符。
  context = await launch(directory || profile, { ...options, timeout: 60000, reducedMotion: 'reduce',
    ...(process.env.BROWSER_EXECUTABLE ? { channel: undefined, executablePath: process.env.BROWSER_EXECUTABLE, ignoreDefaultArgs: ['--disable-extensions'] } : {}) });
  closeContext = context.close.bind(context);
  context.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== model.origin || !url.pathname.endsWith('/v1/chat/completions')) return;
    observedResponses.push(response.json().then((body) => {
      const text = body.choices?.[0]?.message?.content;
      report.llamaResponses.push({ status: response.status(), finishReason: body.choices?.[0]?.finish_reason,
        text: typeof text === 'string' ? text.slice(0, 300) : '', outputTokens: body.usage?.completion_tokens });
    }).catch(() => report.llamaResponses.push({ status: response.status(), invalidJson: true })));
  });
  let [worker] = context.serviceWorkers(); worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  await isolateAutomaticWelcome(context, extensionId);
  const settings = await context.newPage(); await settings.goto(`chrome-extension://${extensionId}/options.html#providers`);
  const rpc = async (rpc, payload) => {
    const response = await settings.evaluate(({ rpc, payload }) => chrome.runtime.sendMessage({ rpc, payload }), { rpc, payload });
    assert.equal(response?.ok, true, `${rpc}: ${JSON.stringify(response?.error)}`); return response.data;
  };
  report.backend = await rpc('ping');
  const providers = await rpc('providers:list');
  assert.ok(!providers.some((provider) => provider.id === 'pseudo'), '媒体真后端测试必须加载正式构建，不允许pseudo');
  for (const provider of providers) await rpc('providers:save', { id: provider.id, enabled: provider.id === 'llamacpp', config: provider.config });
  await rpc('providers:save', { id: 'llamacpp', enabled: true, config: { url: modelAddress, key: process.env.LLAMA_API_KEY || '' } });
  await rpc('align:configure', { enabled: false, remoteUrl: '', token: '' });
  await worker.evaluate(() => chrome.storage.local.set({ 'settings.ui': { mode: 'fast', targetLang: 'zh-CN', loadingEffect: 'dots', imageTranslate: false, sensitive: ['127.0.0.1'] } }));
  const modelUrls = [];
  for (const artifact of artifacts) {
    const name = `PP-OCRv5_mobile_${artifact.kind}_onnx_infer.tar`, file = path.join(modelDirectory, name);
    try { await access(file); }
    catch (error) {
      if (process.env.OCR_MODEL_CACHE) throw error;
      report.realOcrModels.push({ name, requiredSha256: artifact.sha256, source: 'production-first-download' });
      continue;
    }
    const bytes = await readFile(file);
    assert.equal(hash(bytes), artifact.sha256, '缓存必须是固定官方真实模型字节');
    const url = `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/${name}`;
    await context.route(url, (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', path: file }));
    modelUrls.push(url); report.realOcrModels.push({ name, bytes: bytes.length, sha256: artifact.sha256 });
  }
  // 只回放固定权重数据；生产OCR、PDF解析、翻译RPC和真实HTTP均不替换。
  await settings.evaluate(async (urls) => { const cache = await caches.open('translate-ppocr-v5-mobile-v1'); for (const url of urls) { const response = await fetch(url, { credentials: 'omit' }); if (!response.ok) throw new Error('官方OCR权重缓存失败'); await cache.put(url, response); } }, modelUrls);
  context.close = async (...args) => {
    try {
      const image = context.pages().find((page) => new URL(page.url()).pathname.endsWith('/image.html'));
      const pdf = context.pages().find((page) => new URL(page.url()).pathname === '/pdf.html');
      assert.ok(image && pdf, '原媒体测试应覆盖图片页面与正式PDF阅读器');
      report.image = await image.evaluate(() => ({
        paragraphs: [...document.querySelector('tx-ocr')?.shadowRoot?.querySelectorAll('.p') || []].map((node) => ({ text: node.textContent, stage: node.dataset.stage })),
        hiddenAfterToggle: document.querySelector('tx-ocr')?.style.display === 'none',
      }));
      assert.ok(report.image.paragraphs.length && report.image.paragraphs.every((item) => item.stage === 'final'), '图片段落不能停留错误或pending');
      assert.ok(report.image.paragraphs.some((item) => /[\u4e00-\u9fff]/.test(item.text)), '真实本地模型应在图片上生成中文译文');
      assert.equal(report.image.hiddenAfterToggle, true);
      await image.locator('#sign').hover({ position: { x: 300, y: 150 } }); await image.locator('tx-ui .img-btn').click();
      await image.waitForFunction(() => document.querySelector('tx-ocr')?.style.display !== 'none');
      await image.screenshot({ path: path.join(output, 'image-overlay.png') });
      report.pdf = await pdf.evaluate(() => ({
        paragraphs: [...document.querySelectorAll('.tp')].map((node) => ({ text: node.textContent, stage: node.dataset.stage })),
        originalPages: document.querySelectorAll('.orig canvas.page').length,
        translatedPages: document.querySelectorAll('.trans canvas.page').length,
        linkedHoverRanges: document.querySelectorAll('.hl-layer div.on').length,
      }));
      assert.ok(report.pdf.paragraphs.length >= 5 && report.pdf.paragraphs.every((item) => item.stage === 'final'), '论文段落不能停留错误或pending');
      assert.ok(report.pdf.paragraphs.some((item) => /[\u4e00-\u9fff]/.test(item.text)), 'PDF阅读器应有真实中文译文');
      assert.ok(!report.pdf.paragraphs.some((item) => /\[1\]|\[2\]|α|β|γ/.test(item.text)), '参考文献与公式应保留在原画面中');
      await pdf.screenshot({ path: path.join(output, 'paper-reader.png') });
      const png = await readFile(path.join(root, 'tests/e2e/fixtures/sign.png'));
      const ocr = await rpc('ocr:image', { dataUrl: 'data:image/png;base64,' + png.toString('base64'), translate: false, noCache: true });
      assert.match(ocr.engine, /paddleocr-js.*wasm-cpu/); assert.match(ocr.model, /PP-OCRv5/); assert.ok(ocr.blocks.length > 0);
      report.ocr = { engine: ocr.engine, model: ocr.model, blocks: ocr.blocks };
      await Promise.all(observedResponses);
      assert.ok(report.llamaResponses.some((item) => item.status === 200 && /[\u4e00-\u9fff]/.test(item.text)), '需要捕获真实llama-server的成功中文响应');
    } catch (error) { auditError = error; }
    finally { await closeContext(...args); }
  };
  return context;
};

const exit = process.exit;
process.exit = (code = 0) => { frontendExit = Number(code); process.exitCode = Number(code); };
try {
  await import('../e2e/media.mjs');
  assert.equal(frontendExit, 0, '原始媒体端到端测试存在失败项');
  if (auditError) throw auditError;
  assert.equal(hash(await readFile(path.join(root, 'tests/e2e/media.mjs'))), report.frontendTestSha256, '不得改写前端测试');
  report.ok = true;
  console.log(JSON.stringify({ realBackend: true, backend: report.backend.backend, frontendSteps: report.frontendSteps, llamaResponses: report.llamaResponses.length, ocr: report.ocr.engine, ok: true }));
} catch (error) { report.ok = false; report.failure = { message: error.message, stack: error.stack }; throw error; }
finally {
  process.exit = exit;
  await writeFile(path.join(output, 'media-e2e-real-result.json'), JSON.stringify(report, null, 2));
  if (closeContext) await closeContext().catch(() => undefined);
  if (path.dirname(path.resolve(profile)) !== path.resolve(profileRoot) || !path.basename(profile).startsWith('media-e2e-real-')) throw new Error('拒绝清理非测试资料目录');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
