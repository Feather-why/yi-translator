import assert from 'node:assert/strict';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work/phonetics-browser'));
const extension = path.resolve(process.env.EXT_DIR || path.join(root, '.output/chrome-mv3'));
const fixture = JSON.parse((await readFile(new URL('./fixtures/phonetics-daily.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
assert.ok(!fixture.sourceHtml.includes('<tx-t') && fixture.sourceText.includes('mainly concerns'));
const model = new URL(process.env.LLAMA_URL || 'http://127.0.0.1:8081');
assert.ok(['http:', 'https:'].includes(model.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(model.hostname) && !model.username && !model.password);
const modelAddress = model.href.replace(/\/+$/, '').replace(/\/v1$/, '');
assert.equal((await fetch(modelAddress + '/health', { signal: AbortSignal.timeout(10000) })).status, 200);
const revision = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const modelBase = `https://huggingface.co/Xenova/multilingual-e5-small/resolve/${revision}/`;
const modelDirectory = process.env.ALIGN_MODEL_CACHE || path.resolve(root, '../translate-next/work/align-model-cache/Xenova/multilingual-e5-small', revision);
const modelFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
const profileRoot = path.join(root, 'work/browser-profiles');
await mkdir(output, { recursive: true }); await mkdir(profileRoot, { recursive: true });
await access(path.join(extension, 'manifest.json'));
const profile = await mkdtemp(path.join(profileRoot, 'phonetics-'));
const report = { extension, fixtureUrl: fixture.url, fixtureCapturedAt: fixture.capturedAt, source: fixture.sourceText,
  sourceHtml: fixture.sourceHtml, dailyTranslation: fixture.dailyTranslation, cases: [], llamaResponses: [], alignmentWeights: [],
  coldMeaning: '权重缓存已准备，未显式调用align:init；首次concerns必须产生精确研究强高亮，不能只显示段落浅底色或位置近似。',
  softHighlightBoundary: '现有前端对整个part的浅色底纹保留；本回归检查tx-link强高亮的真实DOM范围。' };
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Phonetics · Wikipedia paragraph regression</title><style>body{font:20px/1.65 Arial,sans-serif;max-width:1050px;margin:32px auto;padding:0 24px}h1{font-size:28px}a{color:#2456a6}sup{font-size:70%}</style></head><body><h1>Phonetics</h1><p id="sentences">${fixture.sourceHtml}</p></body></html>`;
const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/phonetics') return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
    const file = request.url?.startsWith('/models/') ? request.url.slice('/models/'.length) : '';
    if (!modelFiles.includes(file)) return response.writeHead(404).end();
    const artifact = path.join(modelDirectory, file), info = await stat(artifact);
    response.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'content-length': info.size, 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    createReadStream(artifact).on('error', () => response.destroy()).pipe(response);
  } catch { response.writeHead(500).end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = `http://127.0.0.1:${server.address().port}/phonetics`;
let context, page, rpc, worker;
const responses = [], errors = [];

async function selection(side, text) {
  await page.evaluate(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
  await page.waitForFunction(() => !CSS.highlights.get('tx-link')?.size && !CSS.highlights.get('tx-link-soft')?.size, null, { timeout: 5000 });
  await page.evaluate(({ side, text }) => {
    const paragraph = document.querySelector('#sentences'), scope = side === 'target' ? paragraph.querySelector('tx-t') : paragraph;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, { acceptNode(node) { return side === 'source' && node.parentElement.closest('tx-t') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
    const nodes = []; let node, full = '';
    while ((node = walker.nextNode())) { nodes.push({ node, start: full.length }); full += node.data; }
    const from = full.indexOf(text), to = from + text.length;
    if (from < 0) throw new Error('真实译文/原文没有待选词：' + text);
    const first = nodes.find((item) => item.start + item.node.length > from), last = nodes.find((item) => item.start + item.node.length >= to);
    const range = document.createRange(); range.setStart(first.node, from - first.start); range.setEnd(last.node, to - last.start);
    getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange'));
  }, { side, text });
  const started = Date.now();
  await page.waitForFunction(() => CSS.highlights.get('tx-link')?.size > 0, null, { timeout: 12000 });
  return page.evaluate((elapsedMs) => {
    const paragraph = document.querySelector('#sentences');
    const ranges = (name) => [...CSS.highlights.get(name) || []].map((range) => {
      const element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      const target = element.closest('tx-t'), scope = target || paragraph;
      const offset = (node, position) => { const prefix = document.createRange(); prefix.selectNodeContents(scope); prefix.setEnd(node, position); return prefix.toString().length; };
      return { text: range.toString(), from: offset(range.startContainer, range.startOffset), to: offset(range.endContainer, range.endOffset), side: target ? 'target' : 'source' };
    });
    return { selected: getSelection().toString(), elapsedMs, strong: ranges('tx-link'), soft: ranges('tx-link-soft') };
  }, Date.now() - started);
}
function bounded(result, side, from, to) {
  assert.ok(result.strong.length, '真实词/句应有强高亮：' + JSON.stringify(result));
  assert.ok(result.strong.every((range) => range.side === side && range.from >= from && range.to <= to), JSON.stringify({ expected: { side, from, to }, result }));
}
function exactWord(result, expected, side, from, to) {
  bounded(result, side, from, to);
  assert.equal(result.strong.map((range) => range.text).join('').replace(/\s+/g, ''), expected, '强高亮必须是正确短词，不能只是标点、相邻词或整句');
}
async function sentences(text, language) {
  return page.evaluate(({ text, language }) => [...new Intl.Segmenter(language, { granularity: 'sentence' }).segment(text)].map(({ segment, index }) => ({ text: segment.trim(), from: index, to: index + segment.length })), { text, language });
}
async function translate() {
  await page.goto(address); await page.locator('tx-ui .ball').waitFor();
  assert.equal(await page.locator('#sentences').textContent(), fixture.sourceText);
  const original = await page.locator('#sentences').innerHTML();
  const links = await page.locator('#sentences a').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
  const started = Date.now();
  await page.getByRole('button', { name: '翻译本页', exact: true }).press('Enter');
  await page.locator('#sentences tx-t[data-tx-stage="final"]').waitFor({ timeout: 120000 });
  const target = await page.locator('#sentences tx-t').textContent();
  assert.match(target, /研究/); assert.equal(await page.locator('tx-t[data-tx-stage="error"]').count(), 0);
  const translatedLinks = await page.locator('#sentences tx-t a').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
  assert.deepEqual(translatedLinks.slice().sort(), links.slice().sort(), '所有原始链接含引文均必须保留');
  return { original, links, translatedLinks, target, translationMs: Date.now() - started };
}

try {
  context = await chromium.launchPersistentContext(profile, { headless: process.env.HEADED !== '1', reducedMotion: 'reduce', viewport: { width: 1350, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE, ignoreDefaultArgs: ['--disable-extensions'] } : { channel: 'chromium' }) });
  context.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== model.origin || !url.pathname.endsWith('/v1/chat/completions')) return;
    responses.push(response.json().then((body) => report.llamaResponses.push({ status: response.status(), text: body.choices?.[0]?.message?.content, finishReason: body.choices?.[0]?.finish_reason, outputTokens: body.usage?.completion_tokens })).catch(() => undefined));
  });
  for (const file of modelFiles) {
    const bytes = await readFile(path.join(modelDirectory, file));
    report.alignmentWeights.push({ file, bytes: bytes.length, revision, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await context.route(modelBase + '**', async (route) => {
    const file = route.request().url().slice(modelBase.length);
    if (!modelFiles.includes(file)) return route.continue();
    await route.fulfill({ status: 302, headers: { location: address.replace('/phonetics', '/models/') + file } });
  });
  [worker] = context.serviceWorkers(); worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  await isolateAutomaticWelcome(context, extensionId);
  const settings = await context.newPage(); await settings.goto(`chrome-extension://${extensionId}/options.html#providers`);
  rpc = async (rpc, payload) => {
    const response = await settings.evaluate(({ rpc, payload }) => chrome.runtime.sendMessage({ rpc, payload }), { rpc, payload });
    assert.equal(response?.ok, true, `${rpc}: ${JSON.stringify(response?.error)}`); return response.data;
  };
  report.backend = await rpc('ping');
  const providers = await rpc('providers:list'); assert.ok(!providers.some((provider) => provider.id === 'pseudo'));
  for (const provider of providers) if (provider.enabled && provider.id !== 'llamacpp') await rpc('providers:save', { id: provider.id, enabled: false, config: provider.config });
  await rpc('providers:save', { id: 'llamacpp', enabled: true, config: { url: modelAddress, key: process.env.LLAMA_API_KEY || '' } });
  await rpc('align:configure', { enabled: true, remoteUrl: '', token: '' });
  await worker.evaluate(() => chrome.storage.local.set({ 'settings.ui': { mode: 'fast', targetLang: 'zh-CN', display: 'bilingual', bilingualStyle: 'paragraph', loadingEffect: 'dots', sensitive: [] } }));
  for (const file of modelFiles) {
    console.log('准备真实固定修订权重：' + file);
    await settings.evaluate(async (url) => { const cache = await caches.open('transformers-cache'), response = await fetch(url, { credentials: 'omit' }); if (!response.ok) throw new Error('真实权重缓存失败'); await cache.put(url, response); }, modelBase + file);
  }
  report.beforeTranslationCapabilities = await rpc('backend:capabilities');
  assert.equal(report.beforeTranslationCapabilities.alignment.ready, false, '本回归首次不显式预热推理引擎');
  const modelReadinessStart = Date.now();
  const modelReadiness = settings.waitForFunction(async () => { const result = await chrome.runtime.sendMessage({ rpc: 'backend:capabilities' }); return result?.data?.alignment?.ready; }, null, { timeout: 180000, polling: 100 })
    .then(() => { report.modelReadyAfterPageStartMs = Date.now() - modelReadinessStart; return true; })
    .catch((error) => { report.modelReadinessError = error.message; return false; });
  page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  const cold = await translate(); report.coldTranslation = cold.target; report.coldTranslationMs = cold.translationMs;
  const firstSource = (await sentences(fixture.sourceText, 'en'))[0], firstColdTarget = (await sentences(cold.target, 'zh-CN'))[0];
  report.sourceSentences = await sentences(fixture.sourceText, 'en');
  report.firstSelectionCapabilities = await rpc('backend:capabilities');
  const coldConcern = await selection('source', 'concerns');
  exactWord(coldConcern, '研究', 'target', firstColdTarget.from, firstColdTarget.to);
  report.cases.push({ name: 'cold-first-concerns-exact-research', strongAvailable: true, result: coldConcern });
  await page.screenshot({ path: path.join(output, 'cold-concerns.png') });
  // 等真实生产服务完成首次模型初始化；不以手工向量或裸offscreen结果替代最终RPC。
  assert.equal(await modelReadiness, true, '真实WASM模型必须完成初始化');
  report.warmCapabilities = await rpc('backend:capabilities');
  const pair = { id: 'phonetics-real-page', source: fixture.sourceText, target: cold.target, sourceLang: 'auto', targetLang: 'zh-CN' };
  report.productionAlignment = (await rpc('align:get', { pairs: [pair] }))[0];
  // 重新载入清除现有前端的首次Promise缓存；正文仍来自真实GPU翻译/生产缓存。
  const warm = await translate(); report.translation = warm.target; report.warmTranslationMs = warm.translationMs; report.links = warm.links; report.translatedLinks = warm.translatedLinks;
  const targetSentences = await sentences(warm.target, 'zh-CN'), firstTarget = targetSentences[0]; report.targetSentences = targetSentences;
  const secondSource = report.sourceSentences[1], secondTarget = targetSentences.find((item) => item.text.includes('声学') && item.text.includes('听觉'));
  assert.ok(secondTarget, warm.target);
  const concern = await selection('source', 'concerns'); exactWord(concern, '研究', 'target', firstTarget.from, firstTarget.to);
  report.cases.push({ name: 'warm-concerns-to-research', result: concern });
  await page.screenshot({ path: path.join(output, 'concerns-highlight.png') });
  const research = await selection('target', '研究'); exactWord(research, 'concerns', 'source', firstSource.from, firstSource.to);
  report.cases.push({ name: 'warm-research-to-concerns', result: research });
  await page.screenshot({ path: path.join(output, 'research-highlight.png') });
  const sentenceForward = await selection('source', firstSource.text); bounded(sentenceForward, 'target', firstTarget.from, firstTarget.to);
  assert.ok(sentenceForward.strong.some((range) => range.text.includes('研究')));
  report.cases.push({ name: 'first-sentence-forward-no-cross', result: sentenceForward });
  await page.screenshot({ path: path.join(output, 'first-sentence-forward.png') });
  const sentenceReverse = await selection('target', firstTarget.text); bounded(sentenceReverse, 'source', firstSource.from, firstSource.to);
  assert.ok(sentenceReverse.strong.some((range) => range.text.includes('concerns')));
  report.cases.push({ name: 'first-sentence-reverse-no-cross', result: sentenceReverse });
  const acoustic = await selection('source', 'acoustic'); exactWord(acoustic, '声学', 'target', secondTarget.from, secondTarget.to);
  report.cases.push({ name: 'acoustic-only-acoustic', result: acoustic });
  await page.screenshot({ path: path.join(output, 'acoustic-highlight.png') });
  const auditory = await selection('source', 'auditory'); exactWord(auditory, '听觉', 'target', secondTarget.from, secondTarget.to);
  report.cases.push({ name: 'auditory-only-auditory', result: auditory });
  const acousticReverse = await selection('target', '声学'); exactWord(acousticReverse, 'acoustic', 'source', secondSource.from, secondSource.to);
  report.cases.push({ name: 'acoustic-reverse-only-acoustic', result: acousticReverse });
  await page.getByRole('button', { name: '翻译本页', exact: true }).press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('tx-t').length === 0);
  assert.equal(await page.locator('#sentences').innerHTML(), warm.original); report.restoredExactly = true;
  await Promise.all(responses); assert.ok(report.llamaResponses.some((response) => response.status === 200 && /研究/.test(response.text)), '必须捕获真实本机GPU模型响应');
  assert.deepEqual(errors, []); report.pageErrors = errors; report.ok = true;
  console.log(JSON.stringify({ ok: true, cases: report.cases.length, firstStrongAvailable: coldConcern.strong.length > 0, realLlamaResponses: report.llamaResponses.length, restoredExactly: true }));
} catch (error) {
  report.ok = false; report.failure = { message: error.message, stack: error.stack };
  if (page && !page.isClosed()) {
    report.failureHighlights = await page.evaluate(() => ({ selected: getSelection()?.toString(), strong: [...CSS.highlights.get('tx-link') || []].map((range) => range.toString()), soft: [...CSS.highlights.get('tx-link-soft') || []].map((range) => range.toString()) })).catch(() => undefined);
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
  }
  throw error;
} finally {
  await writeFile(path.join(output, 'phonetics-browser-result.json'), JSON.stringify(report, null, 2));
  if (context) await context.close();
  const closed = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await closed;
  if (path.dirname(path.resolve(profile)) !== path.resolve(profileRoot) || !path.basename(profile).startsWith('phonetics-')) throw new Error('拒绝清理非测试资料目录');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
