import assert from 'node:assert/strict';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const extension = path.resolve(process.env.EXT_DIR || path.join(root, '.output/chrome-mv3'));
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work/quality-browser'));
const profileRoot = path.join(root, 'work/browser-profiles');
const modelRevision = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const modelBase = `https://huggingface.co/Xenova/multilingual-e5-small/resolve/${modelRevision}/`;
const modelDirectory = process.env.ALIGN_MODEL_CACHE || path.resolve(root, '../translate-next/work/align-model-cache/Xenova/multilingual-e5-small', modelRevision);
const modelFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
const source = 'The children are reading a book. A small dog sleeps beside the window. Tomorrow, we will visit the museum.';
const second = 'A small dog sleeps beside the window.';
const linkedSource = 'Machine translation is the use of computational techniques to translate text or speech from one language to another, including the contextual, idiomatic, and pragmatic nuances of both languages.';
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local translation quality and sentence alignment</title><style>body{font:20px/1.7 Arial,sans-serif;max-width:980px;margin:45px auto;padding:0 30px}p{margin:28px 0}h1{font-size:28px}</style></head><body><h1>Local translation quality and sentence alignment</h1><p id="sentences">${source}</p><div id="spacer" style="height:6000px"></div><p id="linked"><strong>Machine translation</strong> is the use of computational techniques to <a href="https://example.com/translate">translate</a> text or speech from one <a href="https://example.com/language">language</a> to another, including the contextual, idiomatic, and pragmatic nuances of both languages.</p><p id="atoms">Read the <a href="https://example.com/guide"><strong>installation guide</strong></a>, then run <code>llama-server -ngl 99</code>. The original address is <a href="https://example.com/official">the official website</a>.</p></body></html>`;
await access(path.join(extension, 'manifest.json'));
await mkdir(output, { recursive: true });
await mkdir(profileRoot, { recursive: true });
const profile = await mkdtemp(path.join(profileRoot, 'quality-'));
const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/quality') return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
    const file = request.url?.startsWith('/models/') ? request.url.slice('/models/'.length) : '';
    if (!modelFiles.includes(file)) return response.writeHead(404).end();
    const artifact = path.join(modelDirectory, file), info = await stat(artifact);
    response.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'content-length': info.size, 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    createReadStream(artifact).on('error', () => response.destroy()).pipe(response);
  } catch { response.writeHead(500).end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = `http://127.0.0.1:${server.address().port}/quality`;
let context;
const report = { source, sourceSecondSentence: second, linkedSource, cases: [], softHighlightBoundary: '现有前端始终对整个part保留淡底色；后端只控制tx-link强高亮。' };

async function selectedRange(page, side, text) {
  await page.evaluate(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
  await page.waitForFunction(() => !CSS.highlights.get('tx-link')?.size && !CSS.highlights.get('tx-link-soft')?.size, null, { timeout: 5000 });
  await page.evaluate(({ side, text }) => {
    const paragraph = document.querySelector('#sentences');
    const scope = side === 'target' ? paragraph.querySelector('tx-t') : paragraph;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, { acceptNode(node) { return side === 'source' && node.parentElement.closest('tx-t') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
    const nodes = []; let node; let full = '';
    while ((node = walker.nextNode())) { nodes.push({ node, start: full.length }); full += node.data; }
    const from = full.indexOf(text);
    if (from < 0) throw new Error('选区文本不在真实页面中：' + text);
    const to = from + text.length;
    const start = nodes.find((item) => item.start + item.node.length > from);
    const end = nodes.find((item) => item.start + item.node.length >= to);
    const range = document.createRange();
    range.setStart(start.node, from - start.start); range.setEnd(end.node, to - end.start);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, { side, text });
  await page.waitForFunction(() => CSS.highlights.get('tx-link')?.size > 0, null, { timeout: 10_000 });
  return page.evaluate(() => {
    const paragraph = document.querySelector('#sentences');
    const ranges = (name) => [...CSS.highlights.get(name) || []].map((range) => {
      const element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      const target = element.closest('tx-t'); const scope = target || paragraph;
      const offset = (node, position) => { const prefix = document.createRange(); prefix.selectNodeContents(scope); prefix.setEnd(node, position); return prefix.toString().length; };
      return { text: range.toString(), from: offset(range.startContainer, range.startOffset), to: offset(range.endContainer, range.endOffset), side: target ? 'target' : 'source' };
    });
    return { selected: getSelection().toString(), strong: ranges('tx-link'), soft: ranges('tx-link-soft') };
  });
}

function bounded(result, side, from, to) {
  assert.ok(result.strong.length > 0, '需要真实强高亮范围');
  assert.ok(result.strong.every((range) => range.side === side && range.from >= from && range.to <= to), JSON.stringify({ expected: { side, from, to }, result }));
}

function coversSentence(result, sentence) {
  const letters = (text) => (text.match(/[\p{L}\p{N}]/gu) || []).length;
  const coverage = letters(result.strong.map((range) => range.text).join('')) / Math.max(1, letters(sentence));
  assert.ok(coverage >= 0.8, JSON.stringify({ expectedSentence: sentence, coverage, result }));
}

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: process.env.HEADED !== '1', viewport: { width: 1250, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE, ignoreDefaultArgs: ['--disable-extensions'] } : { channel: 'chromium' }),
  });
  for (const name of modelFiles) await access(path.join(modelDirectory, name));
  await context.route(modelBase + '**', async (route) => {
    const name = route.request().url().slice(modelBase.length);
    if (!modelFiles.includes(name)) return route.continue();
    // 大型权重由本机HTTP流发送，避免经自动化协议复制117MB字节造成浏览器内存峰值。
    await route.fulfill({ status: 302, headers: { location: address.replace('/quality', '/models/') + name } });
  });
  let [worker] = context.serviceWorkers(); worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const settings = await context.newPage(); await settings.goto(`chrome-extension://${id}/options.html`);
  const rpc = async (rpc, payload) => {
    const response = await settings.evaluate(({ rpc, payload }) => chrome.runtime.sendMessage({ rpc, payload }), { rpc, payload });
    assert.equal(response?.ok, true, `${rpc}: ${JSON.stringify(response?.error)}`); return response.data;
  };
  await rpc('align:configure', { enabled: true, remoteUrl: '', token: '' });
  for (const provider of await rpc('providers:list')) if (provider.id !== 'llamacpp' && provider.enabled) await rpc('providers:save', { id: provider.id, enabled: false, config: provider.config });
  await rpc('providers:save', { id: 'llamacpp', enabled: true, config: { url: process.env.LLAMA_URL || 'http://127.0.0.1:8081', key: '' } });
  await worker.evaluate(() => chrome.storage.local.set({ 'settings.ui': { mode: 'fast', targetLang: 'zh-CN', display: 'bilingual', bilingualStyle: 'paragraph', loadingEffect: 'dots', sensitive: ['127.0.0.1'] } }));
  const page = await context.newPage(); const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(address); await page.locator('tx-ui .ball').waitFor();
  const original = { sentences: await page.locator('#sentences').innerHTML(), linked: await page.locator('#linked').innerHTML(), atoms: await page.locator('#atoms').innerHTML() };
  await page.getByRole('button', { name: '翻译本页', exact: true }).press('Enter');
  await page.locator('#sentences tx-t[data-tx-stage="final"]').waitFor({ timeout: 60000 });
  const target = await page.locator('#sentences tx-t').innerText(); report.translation = target;
  const targetSentences = await page.evaluate((text) => [...new Intl.Segmenter('zh-CN', { granularity: 'sentence' }).segment(text)].map(({ segment, index }) => ({ text: segment.trim(), from: index, to: index + segment.length })), target);
  const targetSecond = targetSentences.find((item) => /狗|犬/.test(item.text) && /窗/.test(item.text));
  assert.ok(targetSecond, JSON.stringify({ target, targetSentences }));
  report.firstSelectionCapabilities = await rpc('backend:capabilities');
  const first = await selectedRange(page, 'source', second);
  bounded(first, 'target', targetSecond.from, targetSecond.to);
  coversSentence(first, targetSecond.text);
  assert.match(first.strong.map((item) => item.text).join(''), /狗|犬/);
  report.cases.push({ name: 'first-source-sentence', result: first });
  await page.screenshot({ path: path.join(output, 'first-sentence-highlight.png') });
  console.log('首次划句强高亮范围未跨句。');

  // 真正的WASM模型预热；不把注入的模拟向量冒充实际词对齐。
  for (const file of modelFiles) {
    console.log('准备真实对齐缓存：' + file);
    await settings.evaluate(async (url) => { const cache = await caches.open('transformers-cache'); const response = await fetch(url, { credentials: 'omit' }); if (!response.ok) throw new Error('真实模型缓存准备失败'); await cache.put(url, response); }, modelBase + file);
  }
  await worker.evaluate(async () => { if (!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: '真实句词对齐浏览器验收' }); });
  const modelStart = Date.now();
  const initialized = await settings.evaluate(() => chrome.runtime.sendMessage({ target: 'tx-offscreen', task: 'align:init', payload: {} }));
  assert.equal(initialized?.ok, true, JSON.stringify(initialized)); report.modelInitializeMs = Date.now() - modelStart;
  const pair = { id: 'quality-direct', source, target, sourceLang: 'auto', targetLang: 'zh-CN' };
  const modelAlignment = await settings.evaluate((pair) => chrome.runtime.sendMessage({ target: 'tx-offscreen', task: 'align:get', payload: { pairs: [pair] } }), pair);
  assert.equal(modelAlignment?.ok, true, JSON.stringify(modelAlignment)); report.realModelAlignment = modelAlignment.data[0];
  await worker.evaluate(() => chrome.storage.local.set({ 'settings.ui': { mode: 'fast', targetLang: 'zh-CN', display: 'bilingual', bilingualStyle: 'paragraph', loadingEffect: 'dots', sensitive: [] } }));
  await page.reload(); await page.locator('tx-ui .ball').waitFor();
  await page.getByRole('button', { name: '翻译本页', exact: true }).press('Enter');
  await page.locator('#sentences tx-t[data-tx-stage="final"]').waitFor({ timeout: 60000 });
  const warmTarget = await page.locator('#sentences tx-t').innerText();
  const warmPair = { ...pair, target: warmTarget };
  await rpc('align:get', { pairs: [warmPair] });
  await page.waitForTimeout(1500);
  report.warmRpcAlignment = (await rpc('align:get', { pairs: [warmPair] }))[0];
  const warmSentences = await page.evaluate((text) => [...new Intl.Segmenter('zh-CN', { granularity: 'sentence' }).segment(text)].map(({ segment, index }) => ({ text: segment.trim(), from: index, to: index + segment.length })), warmTarget);
  const warmSecond = warmSentences.find((item) => /狗|犬/.test(item.text) && /窗/.test(item.text)); assert.ok(warmSecond, warmTarget);
  const forwardSentence = await selectedRange(page, 'source', second); bounded(forwardSentence, 'target', warmSecond.from, warmSecond.to);
  coversSentence(forwardSentence, warmSecond.text);
  await page.screenshot({ path: path.join(output, 'sentence-highlight.png') });
  const forwardWord = await selectedRange(page, 'source', 'dog'); bounded(forwardWord, 'target', warmSecond.from, warmSecond.to);
  assert.match(forwardWord.strong.map((item) => item.text).join(''), /狗|犬/);
  assert.ok(forwardWord.strong.reduce((sum, item) => sum + item.text.length, 0) < warmSecond.text.length * 0.7);
  const sourceFrom = source.indexOf(second), sourceTo = sourceFrom + second.length;
  const reverseSentence = await selectedRange(page, 'target', warmSecond.text); bounded(reverseSentence, 'source', sourceFrom, sourceTo);
  coversSentence(reverseSentence, second);
  const targetWord = /狗/.test(warmSecond.text) ? '狗' : '犬';
  const reverseWord = await selectedRange(page, 'target', targetWord); bounded(reverseWord, 'source', sourceFrom, sourceTo);
  assert.match(reverseWord.strong.map((item) => item.text).join(' '), /dog/i);
  assert.ok(reverseWord.strong.reduce((sum, item) => sum + item.text.length, 0) < second.length * 0.7);
  report.cases.push({ name: 'warm-source-sentence', result: forwardSentence }, { name: 'warm-source-word', result: forwardWord }, { name: 'warm-target-sentence', result: reverseSentence }, { name: 'warm-target-word', result: reverseWord });
  await page.screenshot({ path: path.join(output, 'word-highlight.png') });
  console.log('真实ONNX预热后句子/单词正反向强高亮均未跨句。');

  await page.locator('#linked').scrollIntoViewIfNeeded();
  await page.locator('#linked tx-t[data-tx-stage="final"]').waitFor({ timeout: 120000 });
  await page.locator('#atoms tx-t[data-tx-stage="final"]').waitFor({ timeout: 120000 });
  const linked = await page.locator('#linked tx-t').evaluate((element) => ({ text: element.textContent, links: [...element.querySelectorAll('a')].map((link) => ({ text: link.textContent, href: link.getAttribute('href') })) }));
  const atoms = await page.locator('#atoms tx-t').evaluate((element) => ({ text: element.textContent, code: element.querySelector('code')?.textContent, links: [...element.querySelectorAll('a')].map((link) => link.getAttribute('href')) }));
  assert.deepEqual(linked.links.map((item) => item.href).sort(), ['https://example.com/language', 'https://example.com/translate']);
  assert.ok(linked.links.every((item) => item.text?.trim())); assert.equal(atoms.code, 'llama-server -ngl 99');
  assert.deepEqual(atoms.links.sort(), ['https://example.com/guide', 'https://example.com/official']);
  assert.equal(await page.locator('tx-t[data-tx-stage="error"]').count(), 0);
  report.linkedTranslation = linked; report.atomicTranslation = atoms;
  // 完成懒加载验收后，仅收起合成页面的隔离留白，让完整译文和原子代码出现在同一张证据图。
  await page.evaluate(() => { document.querySelector('#spacer').style.height = '25px'; window.scrollTo(0, 0); });
  await page.waitForFunction(() => document.querySelector('#spacer').getBoundingClientRect().height === 25);
  await page.screenshot({ path: path.join(output, 'linked-translation.png') });
  await page.getByRole('button', { name: '翻译本页', exact: true }).press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('tx-t').length === 0);
  assert.equal(await page.locator('#sentences').innerHTML(), original.sentences);
  assert.equal(await page.locator('#linked').innerHTML(), original.linked);
  assert.equal(await page.locator('#atoms').innerHTML(), original.atoms);
  assert.deepEqual(pageErrors, []); report.pageErrors = pageErrors; report.restoredExactly = true; report.ok = true;
  console.log(JSON.stringify({ ok: true, cases: report.cases.length, modelInitializeMs: report.modelInitializeMs, restoredExactly: true }));
} catch (error) {
  report.ok = false; report.failure = { message: error.message, stack: error.stack };
  const failedPage = context?.pages().find((page) => page.url() === address);
  if (failedPage) {
    report.failureHighlights = await failedPage.evaluate(() => ({ selected: getSelection()?.toString(), strong: [...CSS.highlights.get('tx-link') || []].map((range) => range.toString()), soft: [...CSS.highlights.get('tx-link-soft') || []].map((range) => range.toString()) })).catch(() => undefined);
    await failedPage.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
  }
  throw error;
} finally {
  await writeFile(path.join(output, 'quality-browser-result.json'), JSON.stringify(report, null, 2));
  if (context) await context.close();
  const closed = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await closed;
  if (path.dirname(path.resolve(profile)) !== path.resolve(profileRoot) || !path.basename(profile).startsWith('quality-')) throw new Error('拒绝清理未经验证的测试目录');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
