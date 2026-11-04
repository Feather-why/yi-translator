import {readFileSync} from 'node:fs';
const RELEASE_VERSION=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';

// 从本脚本定位stage，调用者不必改变工作目录；不启动、修改或关闭外部模型服务。
const root = fileURLToPath(new URL('../../', import.meta.url));
const extension = path.resolve(process.env.EXT_DIR || path.join(root, '.output/chrome-mv3'));
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work/stream-production-browser'));
const model = new URL(process.env.LLAMA_URL || 'http://127.0.0.1:8083');
assert.ok(['http:', 'https:'].includes(model.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(model.hostname));
assert.ok(!model.username && !model.password && !model.search && !model.hash);
assert.notEqual(model.port, '8081', '专项只连接独立临时模型，不使用日常8081服务');
const modelAddress = model.href.replace(/\/+$/, '').replace(/\/v1$/, '');
await access(path.join(extension, 'manifest.json'));
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, RELEASE_VERSION, '必须加载与当前源码一致的正式包');
assert.equal((await fetch(modelAddress + '/health', { signal: AbortSignal.timeout(10000) })).status, 200, '请由外部runner先启动临时模型');
await mkdir(output, { recursive: true });
const profileRoot = path.join(root, 'work/browser-profiles'); await mkdir(profileRoot, { recursive: true });
const profile = await mkdtemp(path.join(profileRoot, 'stream-production-'));
const report = { at: new Date().toISOString(), stage: root, extension, manifestVersion: manifest.version, modelAddress,
  timingBoundary: '浏览器performance.now接收时刻；不计模型下载，不用于宣称总体加速。只调用已有临时模型，不下载内置语言包。',
  cases: [], http: [], pageErrors: [] };
const hash = async (base, files) => Object.fromEntries(await Promise.all(files.map(async (file) =>
  [file, createHash('sha256').update(await readFile(path.join(base, file))).digest('hex')])));
report.sourceHashes = await hash(root, ['src/backend/core.ts', 'src/backend/ports/translate.ts', 'src/backend/translation-observer.ts',
  'src/backend/translation-trace.ts', 'src/backend/scheduler/batcher.ts', 'src/backend/providers/llamacpp.ts', 'src/shared/protocol.ts']);
report.packageHashes = await hash(extension, ['manifest.json', 'background.js']);
const source = 'Read <g0>the local translation guide</g0> and keep <x0/> unchanged. The children are reading a book beside the window while a small dog sleeps quietly. Tomorrow we will visit the museum together and learn about science and history. The museum opens at 09:30, and tickets cost 12 euros for adults. It is closed on Monday, so we will go on Tuesday.';
let context;

async function rpc(page, name, payload) {
  const reply = await page.evaluate(({ name, payload }) => chrome.runtime.sendMessage({ rpc: name, payload }), { name, payload });
  assert.equal(reply?.ok, true, JSON.stringify(reply)); return reply.data;
}
function structure(text) {
  const stack = [], records = [];
  for (const match of text.matchAll(/<(\/?)([gx])(\d+)(\/?)>/g)) {
    const [, closing, kind, id, atom] = match, name = kind + id;
    if (kind === 'x') { assert.equal(closing, ''); assert.equal(atom, '/'); records.push(`${name}:${stack.join('/')}`); }
    else if (closing) { assert.equal(atom, ''); assert.equal(stack.pop(), name, 'g父子关系和闭合顺序必须保留'); }
    else { assert.equal(atom, ''); records.push(`${name}:${stack.join('/')}`); stack.push(name); }
  }
  assert.equal(stack.length, 0); return records.sort();
}
function timing(result, streamed) {
  assert.ok(result.timing, '正式结果必须包含本次实测计时');
  for (const key of ['queueMs', 'providerMs']) assert.ok(Number.isFinite(result.timing[key]) && result.timing[key] >= 0, key);
  assert.ok(Number.isSafeInteger(result.timing.retries) && result.timing.retries >= 0);
  if (streamed) assert.ok(Number.isFinite(result.timing.firstTokenMs) && result.timing.firstTokenMs >= 0);
  else assert.equal(result.timing.firstTokenMs, undefined);
}
function job(label, text, extra = {}) {
  return { jobId: `stream-accept-${label}-${crypto.randomUUID()}`, sourceLang: 'en', targetLang: 'zh-CN', mode: 'combined', priority: 1,
    context: { url: 'https://public.example/stream-acceptance', title: 'Synthetic local translation acceptance' },
    segments: [{ id: 's1', kind: 'paragraph', text }], stream: true, noCache: true, ...extra };
}
async function exchange(page, request, cancelOnPreview = false) {
  const httpFrom = report.http.length;
  const result = await page.evaluate(({ job, cancelOnPreview }) => new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'tx:translate' }), started = performance.now(), messages = [];
    let observation, cancelAtMs, finalAtMs, closed = false;
    const finish = (failure) => {
      if (closed) return; closed = true; clearTimeout(timeout); clearTimeout(observation);
      const value = { messages, elapsedMs: performance.now() - started, cancelAtMs, finalAtMs, ...(failure ? { failure } : {}) };
      port.disconnect(); resolve(value);
    };
    const timeout = setTimeout(() => finish('正式包翻译端口超时'), 90000);
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (!closed) finish('端口提前断开'); });
    port.onMessage.addListener((message) => {
      if (closed || message.jobId !== job.jobId) return;
      const atMs = performance.now() - started; messages.push({ atMs, message });
      if (cancelOnPreview && message.type === 'partial' && cancelAtMs === undefined) {
        cancelAtMs = performance.now() - started;
        port.postMessage({ type: 'cancel', jobId: job.jobId });
        observation = setTimeout(() => finish(), 300); return;
      }
      if (!cancelOnPreview && message.type === 'result' && message.stage === 'final' && finalAtMs === undefined) {
        finalAtMs = atMs;
        // 保持连接，让迟到的80ms待发预览或重复result有机会暴露，不能先断端口遮住问题。
        observation = setTimeout(() => finish(), 100);
      }
      if (message.type === 'error' && message.stage === 'final' && cancelAtMs === undefined) finish('正式包翻译返回最终错误');
      if (cancelOnPreview && message.type === 'result' && cancelAtMs === undefined) finish('取消专项还未预览就已完成');
    });
    port.postMessage({ type: 'job', job });
  }), { job: request, cancelOnPreview });
  const item = { job: request, ...result, http: report.http.slice(httpFrom) }; report.cases.push(item);
  assert.equal(result.failure, undefined, JSON.stringify(item));
  return item;
}
function validateComplete(item, expectedSource, streamed, cached = false) {
  const results = item.messages.filter(({ message }) => message.type === 'result');
  assert.equal(results.length, 1, '同一实际服务的综合模式必须直接单次final');
  const [{ message: result, atMs: finalAt }] = results;
  assert.equal(result.stage, 'final'); assert.equal(result.provider, 'llamacpp'); assert.equal(result.cached, cached);
  assert.deepEqual(structure(result.text), structure(expectedSource));
  if (item.job.targetLang === 'zh-CN') assert.match(result.text, /[\u4e00-\u9fff]/);
  else if (item.job.targetLang === 'en') { assert.match(result.text, /[a-z]/i); assert.doesNotMatch(result.text, /[\u4e00-\u9fff]/); }
  assert.doesNotMatch(result.text, /\[?TXP\d+_/);
  assert.deepEqual(item.messages.filter(({ message }) => message.type === 'job-done').map(({ message }) => message.stage), item.job.mode === 'combined' ? ['fast', 'final'] : ['final']);
  assert.equal(item.messages.some(({ atMs, message }) => atMs > finalAt && message.type === 'partial'), false, 'final后不允许任何partial');
  assert.equal(item.messages.some(({ message }) => message.type === 'error'), false);
  timing(result, streamed);
  const previews = item.messages.filter(({ message }) => message.type === 'partial');
  if (streamed) {
    assert.ok(previews.length > 0, '必须真实流式出字，不能只带stream标志');
    item.firstPreviewLeadMs = finalAt - previews[0].atMs;
    assert.ok(item.firstPreviewLeadMs >= 60, '首预览必须至少领先最终结果60ms');
    item.previewIntervalsMs = previews.slice(1).map((row, index) => row.atMs - previews[index].atMs);
    assert.ok(item.previewIntervalsMs.every((ms) => ms >= 60), '相邻预览至少间隔60ms');
    for (const { atMs, message } of previews) {
      assert.equal(message.stage, 'final', '同服务精确工作应以final阶段预览');
      assert.equal(message.provider, 'llamacpp'); assert.ok(atMs < finalAt);
      assert.doesNotMatch(message.text, /\[?TXP\d+_/);
      assert.ok(message.text.replace(/<\/?[gx]\d+\/?>/g, '').replace(/<\/?(?:[gx]\d*\/?)?$/, '').trim());
    }
  } else assert.equal(previews.length, 0);
  return result;
}

try {
  const disabledFeatures = ['AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider',
    'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning',
    'BlockOriginHeaderModificationOnRedirect', 'AvoidCorsURLLoaderRestartOnRedirect', 'Translate', 'AutoDeElevate',
    'OptimizationHints', 'NetworkTimeServiceQuerying', 'AimEnabled', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion'];
  context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1250, height: 900 },
    executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-update', '--disable-background-networking', '--disable-features=' + disabledFeatures.join(',')],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-features=' + disabledFeatures.join(',')] });
  report.browserVersion = context.browser()?.version(); report.headless = true;
  context.on('page', (page) => page.on('pageerror', (error) => report.pageErrors.push(String(error))));
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== model.origin || !url.pathname.endsWith('/v1/chat/completions')) return;
    let body; try { body = request.postDataJSON(); } catch { /* 报告原始请求类型异常，不记录凭据。 */ }
    report.http.push({ at: new Date().toISOString(), url: request.url(), method: request.method(), stream: body?.stream,
      compactPrompt: /^(?:原文语言：[^\n]+。\n)?译成[^\n]+，只输出译文：\n/.test(body?.messages?.[0]?.content ?? ''),
      explicitSource: body?.messages?.[0]?.content?.match(/(?:^|\n)原文语言：([^\n]+)。\n/)?.[1],
      source: body?.messages?.[0]?.content?.split('：\n').at(-1) });
  });
  let [worker] = context.serviceWorkers(); worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host; report.extensionId = id;
  await isolateAutomaticWelcome(context, id);
  const settings = await context.newPage(); await settings.goto(`chrome-extension://${id}/options.html#providers`);
  report.ping = await rpc(settings, 'ping'); assert.match(report.ping.backend, /^0\.2\.10(?:-|$)/);
  const providers = await rpc(settings, 'providers:list');
  assert.ok(providers.some((provider) => provider.id === 'llamacpp'));
  assert.equal(providers.some((provider) => provider.id === 'pseudo'), false, '拒绝假后端构建');
  for (const provider of providers) await rpc(settings, 'providers:save', { id: provider.id,
    enabled: provider.id === 'llamacpp', config: provider.id === 'llamacpp' ? { ...provider.config, url: modelAddress } : provider.config });
  report.alignment = await rpc(settings, 'align:configure', { enabled: false });
  report.providers = await rpc(settings, 'providers:list');
  assert.deepEqual(report.providers.filter((provider) => provider.enabled).map((provider) => provider.id), ['llamacpp']);
  assert.equal(report.providers.find((provider) => provider.id === 'llamacpp').options.endpoint, modelAddress);

  const streaming = await exchange(settings, job('stream', source, { noCache: false }));
  validateComplete(streaming, source, true);
  assert.ok(streaming.http.length > 0 && streaming.http[0].stream === true, '真实模型HTTP必须开启SSE');

  const cached = await exchange(settings, job('cached', source, { noCache: false }));
  const cachedResult = validateComplete(cached, source, false, true);
  assert.equal(cachedResult.timing.providerMs, 0); assert.equal(cachedResult.timing.retries, 0);
  assert.equal(cached.http.length, 0, '缓存命中不应产生新的模型请求');

  const nonstreamSource = source.replace('Tomorrow', 'Next week');
  const nonstream = await exchange(settings, job('nonstream', nonstreamSource, { stream: false }));
  validateComplete(nonstream, nonstreamSource, false);
  assert.ok(nonstream.http.length > 0 && nonstream.http.every((request) => request.stream === false));

  const fastSource = 'The library will reopen on Monday, but the western entrance will remain closed. Please use the eastern entrance after 09:30. Children under six may enter free of charge.';
  const fast = await exchange(settings, job('fast', fastSource, { mode: 'fast' }));
  validateComplete(fast, fastSource, true);
  assert.equal(fast.http.length, 1); assert.equal(fast.http[0].compactPrompt, true, '纯文本快速模式应实际发送短模板');
  assert.ok(streaming.http.every((request) => !request.compactPrompt), '综合共享最终工作保留准确模板');

  // 只增加一句真实模型请求，验证显式源语言与英文目标，不以译文逐字相等衡量质量。
  const swedishSource = 'Biblioteket öppnar på måndag.';
  const swedish = await exchange(settings, job('swedish-english', swedishSource, { sourceLang: 'sv', targetLang: 'en', mode: 'fast', stream: false }));
  const swedishResult = validateComplete(swedish, swedishSource, false);
  assert.equal(swedish.http.length, 1); assert.equal(swedish.http[0].compactPrompt, true);
  assert.equal(swedish.http[0].explicitSource, '瑞典语', 'HTTP 中必须实际传入所选原文语言');
  assert.match(swedishResult.text, /\blibrary\b/i); assert.match(swedishResult.text, /\bopen(?:s|ing|ed)?\b/i); assert.match(swedishResult.text, /\bmonday\b/i);
  assert.doesNotMatch(swedishResult.text, /bibliotek|öppnar|måndag/i);

  const cancelSource = 'The visitors will spend all afternoon walking around the museum and reading the history of every object. They will compare the old maps, discuss the paintings, and write a detailed report for their classmates. After the museum closes, they will walk back to the station and take the evening train together.';
  const cancelled = await exchange(settings, job('cancel', cancelSource), true);
  assert.ok(Number.isFinite(cancelled.cancelAtMs));
  assert.ok(cancelled.messages.some(({ message }) => message.type === 'partial'));
  assert.equal(cancelled.messages.some(({ atMs }) => atMs > cancelled.cancelAtMs), false, '发送取消后不允许再收到此job的任何消息');
  assert.equal(cancelled.messages.some(({ message }) => message.type === 'result'), false);
  assert.ok(cancelled.http.some((request) => request.stream === true));
  report.passed = true;
  console.log(JSON.stringify({ passed: true, cases: report.cases.length, report: path.join(output, 'report.json'),
    firstPreviewLeadMs: streaming.firstPreviewLeadMs, previewIntervalsMs: streaming.previewIntervalsMs }));
} catch (error) { report.passed = false; report.failure = String(error?.stack || error); throw error; }
finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (context) await context.close();
  if (path.dirname(path.resolve(profile)) !== path.resolve(profileRoot) || !path.basename(profile).startsWith('stream-production-')) throw Error('拒绝清理未经验证的临时profile');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
