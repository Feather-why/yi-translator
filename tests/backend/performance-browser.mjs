import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const extension = path.resolve(process.env.EXT_DIR || path.join(root, '.output/chrome-mv3'));
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work/performance-browser'));
const rounds = Number(process.env.PERFORMANCE_ROUNDS || 3);
assert.ok(Number.isInteger(rounds) && rounds >= 3 && rounds <= 10);
const model = new URL(process.env.LLAMA_URL || 'http://127.0.0.1:8081');
assert.ok(['http:', 'https:'].includes(model.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(model.hostname) && !model.username && !model.password && !model.search && !model.hash);
const modelAddress = model.href.replace(/\/+$/, '').replace(/\/v1$/, '');
const headers = process.env.LLAMA_API_KEY ? { Authorization: `Bearer ${process.env.LLAMA_API_KEY}` } : {};
assert.equal((await fetch(modelAddress + '/health', { headers, signal: AbortSignal.timeout(10000) })).status, 200);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const shortTexts = [
  'The children are reading a book beside the window.', 'A small dog sleeps quietly near the door.',
  'Tomorrow we will visit the museum after breakfast.', 'The library opens at nine every morning.',
  'This tool translates complete sentences on your computer.', 'Please keep the original meaning clear and natural.',
  'The train arrives at the station in ten minutes.', 'Fresh water is essential for every living organism.',
  'The researchers compared the results of both experiments.', 'A careful plan helps the team finish its work.',
  'The new bridge connects two villages across the river.', 'Music can change the atmosphere of a crowded room.',
  'The package contains instructions and a small adapter.', 'We need a reliable method for measuring response time.',
  'The teacher explained the difference with a simple example.', 'The garden looks beautiful after the spring rain.',
  'Local processing keeps private text on this device.', 'The application restores the original page when requested.',
  'Each paragraph should preserve its links and formatting.', 'The final translation should be accurate and readable.',
];
const phonetics = JSON.parse((await readFile(new URL('./fixtures/phonetics-daily.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const lead = phonetics.sourceHtml.split(' The field of phonetics')[0].replace(/\s+id="[^"]*"/g, '');
const structured = lead + ' Follow the <a href="https://example.com/guide"><strong>installation guide</strong></a> and run <code>llama-server -ngl 99</code>.';
function fixture(kind, round) {
  return Array.from({ length: 20 }, (_, index) => `<p id="p${index}">Batch ${round}, paragraph ${String(index + 1).padStart(2, '0')}: ${kind === 'structured' ? structured : shortTexts[index]}</p>`).join('');
}
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixed translation performance fixture</title><style>body{font:14px/1.35 Arial,sans-serif;max-width:1500px;margin:10px auto;padding:0 15px}p{margin:0 0 8px}a{color:#2456a6}code{font:12px monospace}</style></head><body>${fixture(url.searchParams.get('kind'), Number(url.searchParams.get('round')))}</body></html>`);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = `http://127.0.0.1:${server.address().port}`;
const profileRoot = path.join(root, 'work/browser-profiles'); await mkdir(profileRoot, { recursive: true }); await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(profileRoot, 'performance-'));
const report = { at: new Date().toISOString(), extension, modelAddress, rounds, mode: 'combined', noCache: true, frontendLabel: process.env.PERFORMANCE_FRONTEND_LABEL || 'unspecified',
  fixture: { paragraphs: 20, shortTexts, structuredHtml: structured, structuredSource: phonetics.url, license: phonetics.license, sha256: hash(JSON.stringify({ shortTexts, structured })) },
  coldDefinition: '首轮仅浏览器首次样本；本脚本不卸载模型、不清llama KV/prompt缓存，不能称GPU冷启动。', runs: [] };
const bodyPromises = [], requests = new WeakMap(), errors = [];
let context, settings, worker, page, activeRun;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function slots() {
  const response = await fetch(modelAddress + '/slots', { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const data = await response.json(); assert.ok(Array.isArray(data));
  return data.map((slot) => ({ id: slot.id, is_processing: slot.is_processing }));
}
async function idle(timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const state = await slots(); if (state.every((slot) => slot.is_processing === false)) return state; await delay(100); }
  throw new Error('模型slots未空闲；停止本轮，避免混入其他任务');
}
const percentile = (values, fraction) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null; };
function summarize(run) {
  const network = run.requests, done = run.dom?.events?.filter((event) => event.stage === 'final') || [], fast = run.dom?.events?.filter((event) => event.stage === 'fast') || [];
  const sources = new Set(network.map((request) => request.sourceHash));
  return { firstFastMs: fast.length ? Math.min(...fast.map((event) => event.ms)) : null, firstFinalMs: done.length ? Math.min(...done.map((event) => event.ms)) : null,
    finalP50Ms: percentile(done.map((event) => event.ms), .5), all20FinalMs: done.length === 20 ? Math.max(...done.map((event) => event.ms)) : null,
    httpRequests: network.length, duplicateSourceRequests: network.length - sources.size, taggedRequests: network.filter((request) => request.tagged).length,
    strictTaggedRequests: network.filter((request) => request.strict && request.tagged).length, taglessRequests: network.filter((request) => !request.tagged).length,
    abortedRequests: network.filter((request) => request.failure).length, outputTokens: network.reduce((sum, request) => sum + (request.outputTokens || 0), 0) };
}

try {
  report.initialSlots = await idle();
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8')); report.version = manifest.version;
  const mainContent = manifest.content_scripts?.find((script) => script.matches?.includes('<all_urls>'))?.js?.[0];
  if (mainContent) report.contentScriptSha256 = hash(await readFile(path.join(extension, mainContent)));
  report.backgroundSha256 = hash(await readFile(path.join(extension, 'background.js')));
  context = await chromium.launchPersistentContext(profile, { headless: process.env.HEADED !== '1', reducedMotion: 'reduce', viewport: { width: 1600, height: 1800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE, ignoreDefaultArgs: ['--disable-extensions'] } : { channel: 'chromium' }) });
  context.on('request', (request) => {
    const url = new URL(request.url()); if (!activeRun || url.origin !== model.origin || !url.pathname.endsWith('/v1/chat/completions')) return;
    const prompt = request.postDataJSON()?.messages?.[0]?.content || '', marker = '不要额外解释：\n', offset = prompt.lastIndexOf(marker);
    const source = offset < 0 ? prompt : prompt.slice(offset + marker.length);
    const entry = { startedAt: Date.now(), sourceHash: hash(source), sourceChars: source.length, tagged: /<\/?[gx]\d+\/?\>/.test(source), strict: prompt.includes('严格保留原文中的全部 XML'), promptHash: hash(prompt) };
    activeRun.requests.push(entry); requests.set(request, entry);
  });
  context.on('requestfailed', (request) => { const entry = requests.get(request); if (entry) { entry.failure = request.failure()?.errorText; entry.durationMs = Date.now() - entry.startedAt; } });
  context.on('response', (response) => {
    const entry = requests.get(response.request()); if (!entry) return;
    entry.status = response.status();
    bodyPromises.push(response.json().then((body) => { entry.durationMs = Date.now() - entry.startedAt; entry.outputTokens = body.usage?.completion_tokens; entry.finishReason = body.choices?.[0]?.finish_reason;
      const text = body.choices?.[0]?.message?.content || ''; entry.outputChars = text.length; entry.outputHasTags = /<\/?[gx]\d+\/?\>/.test(text); entry.outputHasChinese = /[\u4e00-\u9fff]/.test(text); entry.outputSha256 = hash(text);
    }).catch(() => { entry.bodyUnavailable = true; }));
  });
  [worker] = context.serviceWorkers(); worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 }); const extensionId = new URL(worker.url()).host;
  await isolateAutomaticWelcome(context, extensionId);
  settings = await context.newPage(); await settings.goto(`chrome-extension://${extensionId}/options.html#providers`);
  const rpc = async (rpc, payload) => {
    const result = await settings.evaluate(({ rpc, payload }) => chrome.runtime.sendMessage({ rpc, payload }), { rpc, payload });
    assert.equal(result?.ok, true, `${rpc}: ${JSON.stringify(result?.error)}`); return result.data;
  };
  report.backend = await rpc('ping');
  const providers = await rpc('providers:list'); assert.ok(!providers.some((provider) => provider.id === 'pseudo'));
  for (const provider of providers) if (provider.enabled) await rpc('providers:save', { id: provider.id, enabled: false, config: provider.config });
  await rpc('providers:save', { id: 'llamacpp', enabled: true, config: { url: modelAddress, key: process.env.LLAMA_API_KEY || '' } });
  await rpc('align:configure', { enabled: false, remoteUrl: '', token: '' });
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ 'settings.ui': { targetLang: 'zh-CN', mode: 'combined', display: 'bilingual', bilingualStyle: 'paragraph', loadingEffect: 'dots', sensitive: ['127.0.0.1'], onboarded: true } });
    globalThis.__performanceJobs = [];
    globalThis.__performanceWarmCalls = 0;
    chrome.runtime.onMessage.addListener((message) => { if (message?.rpc === 'providers:warm') globalThis.__performanceWarmCalls++; return false; });
    chrome.runtime.onConnect.addListener((port) => { if (port.name === 'tx:translate') port.onMessage.addListener((message) => { if (message?.type === 'job') globalThis.__performanceJobs.push({ noCache: message.job.noCache, mode: message.job.mode, segments: message.job.segments.length }); }); });
  });
  report.provider = (await rpc('providers:list')).find((provider) => provider.id === 'llamacpp');
  page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    globalThis.__performance = { start: null, cancel: null, events: [] }; const seen = new Set();
    const toggle = (event) => {
      if (!event.composedPath().some((node) => node?.classList?.contains('ball'))) return;
      if (globalThis.__performance.lastToggle && performance.now() - globalThis.__performance.lastToggle < 100) return;
      globalThis.__performance.lastToggle = performance.now();
      if (globalThis.__performance.start === null) globalThis.__performance.start = performance.now(); else globalThis.__performance.cancel = performance.now();
    };
    document.addEventListener('click', toggle, true);
    document.addEventListener('keydown', (event) => { if (event.key === 'Enter') toggle(event); }, true);
    new MutationObserver((records) => {
      const bench = globalThis.__performance; if (bench.start === null) return;
      const candidates = new Set();
      for (const record of records) { if (record.target.nodeType === 1) candidates.add(record.target); for (const node of record.addedNodes) if (node.nodeType === 1) candidates.add(node); }
      for (const root of candidates) for (const element of [root, ...root.querySelectorAll('tx-t')]) {
        if (element.localName !== 'tx-t') continue;
        const stage = element.getAttribute('data-tx-stage'), id = element.closest('p')?.id;
        if (!id || !['fast', 'final', 'error'].includes(stage) || seen.has(id + stage)) continue;
        seen.add(id + stage); bench.events.push({ id, stage, ms: performance.now() - bench.start });
      }
    }).observe(document, { attributes: true, attributeFilter: ['data-tx-stage'], childList: true, subtree: true });
  });
  async function run(kind, round, { cancellation = false, builtinFallback = false } = {}) {
    await idle(); const item = { kind, round, cancellation, builtinFallback, browserFirst: report.runs.length === 0, requests: [] }; report.runs.push(item);
    if (builtinFallback) {
      const builtin = providers.find((provider) => provider.kind === 'builtin');
      assert.ok(builtin); item.builtinId = builtin.id; await rpc('providers:save', { id: builtin.id, enabled: true, config: builtin.config });
    }
    await page.goto(`${address}/?kind=${kind}&round=${round}`); await page.locator('tx-ui .ball').waitFor();
    item.layout = await page.locator('p').evaluateAll((nodes) => ({ count: nodes.length, allVisible: nodes.every((node) => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }), sourceChars: nodes.map((node) => node.textContent.length) }));
    assert.equal(item.layout.count, 20); assert.equal(item.layout.allVisible, true, '源段落必须全部位于本次首屏');
    const originals = await page.locator('p').evaluateAll((nodes) => nodes.map((node) => node.innerHTML));
    activeRun = item; const wallStart = Date.now(); await page.locator('tx-ui .ball').press('Enter');
    if (cancellation) {
      while (item.requests.length < 2 && Date.now() - wallStart < 15000) await delay(10);
      assert.ok(item.requests.length >= 2); item.cancelRequestedAt = Date.now();
      await page.locator('tx-ui .ball').press('Enter'); await page.waitForFunction(() => document.querySelectorAll('tx-t').length === 0);
      await idle(); item.cancelDrainMs = Date.now() - item.cancelRequestedAt; await delay(150);
      item.requestsAfterCancel = item.requests.filter((request) => request.startedAt > item.cancelRequestedAt).length;
    } else {
      await page.waitForFunction(() => document.querySelectorAll('p tx-t[data-tx-stage="final"]').length === 20 || document.querySelector('p tx-t[data-tx-stage="error"]'), null, { timeout: 180000 });
      assert.equal(await page.locator('tx-t[data-tx-stage="error"]').count(), 0);
      assert.equal(await page.locator('p tx-t[data-tx-stage="final"]').count(), 20);
      if (kind === 'structured') {
        assert.equal(await page.locator('p tx-t a').count(), 80);
        assert.equal(await page.locator('p tx-t code').count(), 20);
        assert.ok((await page.locator('p tx-t code').allTextContents()).every((text) => text === 'llama-server -ngl 99'));
      }
      await idle();
    }
    item.dom = await page.evaluate(() => globalThis.__performance);
    await Promise.all(bodyPromises); item.summary = summarize(item);
    if (builtinFallback) {
      item.builtinAfter = (await rpc('providers:list')).find((provider) => provider.id === item.builtinId);
      item.builtinStatus = await settings.evaluate((id) => new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'tx:status' });
        const timer = setTimeout(() => { port.disconnect(); reject(new Error('读取真实内置服务状态超时')); }, 10000);
        port.onMessage.addListener((message) => { if (message.type === 'snapshot') { clearTimeout(timer); port.disconnect(); resolve(message.status.providers.find((provider) => provider.id === id)); } });
      }), item.builtinId);
      assert.ok(item.requests.length >= 20, 'fallback必须真正请求本机模型');
      await rpc('providers:save', { id: item.builtinId, enabled: false, config: item.builtinAfter.config });
    }
    if (!cancellation) {
      assert.equal(item.dom.events.filter((event) => event.stage === 'final').length, 20);
      if (round === rounds) await page.screenshot({ path: path.join(output, kind + '-final.png'), fullPage: true });
      await page.locator('tx-ui .ball').press('Enter'); await page.waitForFunction(() => document.querySelectorAll('tx-t').length === 0);
    }
    assert.deepEqual(await page.locator('p').evaluateAll((nodes) => nodes.map((node) => node.innerHTML)), originals);
    item.restoredExactly = true; activeRun = undefined; console.log(JSON.stringify({ kind, round, cancellation, builtinFallback, ...item.summary, cancelDrainMs: item.cancelDrainMs }));
    await writeFile(path.join(output, 'performance-browser-result.json'), JSON.stringify(report, null, 2));
  }
  for (const kind of ['short', 'structured']) for (let round = 1; round <= rounds; round++) await run(kind, round);
  await run('short', rounds + 1, { builtinFallback: true });
  await run('structured', rounds + 2, { cancellation: true });
  report.jobs = await worker.evaluate(() => globalThis.__performanceJobs); assert.ok(report.jobs.length && report.jobs.every((job) => job.noCache === true && job.mode === 'combined'));
  report.warmAliasCalls = await worker.evaluate(() => globalThis.__performanceWarmCalls);
  try { report.backendMetrics = await rpc('performance:get'); } catch { report.backendMetricsUnavailable = true; }
  report.aggregates = ['short', 'structured'].map((kind) => {
    const runs = report.runs.filter((run) => run.kind === kind && !run.cancellation && !run.builtinFallback);
    return { kind, rounds: runs.length, firstFinalMedianMs: percentile(runs.map((run) => run.summary.firstFinalMs), .5), all20FinalMedianMs: percentile(runs.map((run) => run.summary.all20FinalMs), .5), requestsPerRound: runs.map((run) => run.summary.httpRequests) };
  });
  assert.deepEqual(errors, []); report.pageErrors = errors; report.ok = true;
  await rm(path.join(output, 'failure.png'), { force: true });
} catch (error) {
  report.ok = false; report.failure = { message: error.message, stack: error.stack }; if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  throw error;
} finally {
  await writeFile(path.join(output, 'performance-browser-result.json'), JSON.stringify(report, null, 2));
  if (context) await context.close(); const closed = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await closed;
  if (path.dirname(path.resolve(profile)) !== path.resolve(profileRoot) || !path.basename(profile).startsWith('performance-')) throw new Error('拒绝清理非测试资料目录');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
