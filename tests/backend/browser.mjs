import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, rm, access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { checkInteractivePage } from '../e2e/interactive.mjs';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const extension = path.resolve(process.env.EXT_DIR || path.join(root, '.output/chrome-mv3'));
await access(path.join(extension, 'manifest.json'));
const temporaryRoot = await realpath(os.tmpdir());
const profile = await mkdtemp(path.join(temporaryRoot, 'translate-backend-browser-'));
const token = 'browser-fixture-only-not-a-real-api-key';
const sources = [
  '<g0>Hello <g1>world</g1></g0> <x0/>.',
  'Second <x1/> paragraph.',
];
const translations = [
  '<g0>你好<g1>世界</g1></g0> <x0/>。',
  '第二段<x1/>。',
];
const pageSource = 'Browser <g0>integration</g0> translation.';
const pageTranslation = '浏览器<g0>集成</g0>翻译。';
const requests = [];
// 嵌套格式使用后端既有语义投影：整句先去标签翻译，再按短语锚点恢复。
const fixtures = [
  ...sources.map((source, index) => ({ source, output: translations[index], kind: 'segment', numbered: true })),
  { source: 'Hello world [TXP0_0].', output: '你好世界 [TXP0_0]。', kind: 'nested', numbered: true },
  { source: 'Hello world', output: '你好世界', kind: 'anchor', numbered: false },
  { source: 'world', output: '世界', kind: 'anchor', numbered: false },
  { source: 'Hello.', output: '你好。', kind: 'probe', numbered: true },
  { source: pageSource, output: pageTranslation, kind: 'page', numbered: false },
  { source: 'Read the current settings before opening the menu.', output: '打开菜单前请阅读当前设置。', kind: 'intro' },
  { source: 'Choose your language.', output: '选择语言。', kind: 'menu' },
  { source: 'Open your preferences.', output: '打开偏好设置。', kind: 'menu' },
  { source: 'Return to the article.', output: '返回文章。', kind: 'menu' },
].sort((a, b) => b.source.length - a.source.length);
const callsOf = (kind) => requests.filter((entry) => entry.kind === kind).length;
let healthChecks = 0;
let context;

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/interactive.html' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(await readFile(new URL('../e2e/fixtures/interactive.html', import.meta.url)));
      return;
    }
    if (request.url === '/article' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="en"><head><title>Integration fixture</title></head><body><article style="max-width:650px;margin:60px auto"><p id="source">Browser <a href="/original-link">integration</a> translation.</p></article></body></html>');
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"fixture authorization required"}');
      return;
    }
    if (request.url === '/health' && request.method === 'GET') {
      healthChecks++;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const prompt = input.messages?.[0]?.content;
    if (typeof prompt !== 'string') throw new Error('本地模型请求缺少消息');
    const fixture = fixtures.find((entry) => prompt.endsWith(entry.source));
    if (!fixture) throw new Error('本地模型收到了未定义的回放文本：' + prompt);
    const output = fixture.output;
    requests.push({ input, kind: fixture.kind, cookie: request.headers.cookie, authorized: request.headers.authorization === `Bearer ${token}` });
    if (input.stream === true) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: output.slice(0, 3) }, finish_reason: null }] }) + '\n\n');
      // 留出真实渲染帧，验证 partial 确实先于 final 到达页面。
      await new Promise((resolve) => setTimeout(resolve, 220));
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: output.slice(3) }, finish_reason: null }] }) + '\n\n');
      await new Promise((resolve) => setTimeout(resolve, 160));
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { content: fixture.numbered ? `${output} ${requests.length}` : output }, finish_reason: 'stop' }],
    }));
  } catch (error) {
    console.error('本机回放服务失败：', error.message);
    response.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"invalid fixture request"}');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = `http://127.0.0.1:${server.address().port}`;

async function launch() {
  const options = {
    headless: process.env.HEADED !== '1',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    ...(process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE, ignoreDefaultArgs: ['--disable-extensions'] }
      : { channel: 'chromium' }),
  };
  context = await chromium.launchPersistentContext(profile, options);
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('settings.ui');
    await chrome.storage.local.set({ 'settings.ui': { ...stored['settings.ui'], onboarded: true, sourceLang: 'en', targetLang: 'zh-CN', mode: 'fast', mainOnly: false, loadingEffect: 'dots' } });
  });
  await isolateAutomaticWelcome(context, extensionId);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html#providers`);
  return page;
}

async function rpc(page, name, payload) {
  const result = await page.evaluate(({ name, payload }) => chrome.runtime.sendMessage({ rpc: name, payload }), { name, payload });
  assert.equal(result?.ok, true, `${name} 失败：${JSON.stringify(result?.error)}`);
  return result.data;
}

async function snapshot(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'tx:status' });
    const timer = setTimeout(() => { port.disconnect(); reject(new Error('状态端口建立后没有立即发送快照')); }, 2000);
    port.onMessage.addListener((message) => {
      clearTimeout(timer);
      port.disconnect();
      resolve(message);
    });
  }));
}

async function translate(page, segments, overrides = {}) {
  const request = { jobId: crypto.randomUUID(), sourceLang: 'en', targetLang: 'zh-CN', mode: 'fast', priority: 0,
    context: { url: 'https://example.test/browser-backend-fixture' }, providerHint: 'llamacpp',
    segments: segments.map((text, index) => ({ id: `s${index}`, text, kind: 'paragraph' })), ...overrides };
  const messages = await page.evaluate((job) => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'tx:translate' });
    const messages = [];
    const timer = setTimeout(() => { port.disconnect(); reject(new Error('真实后台翻译超时')); }, 10_000);
    port.onMessage.addListener((message) => {
      if (message.jobId !== job.jobId) return;
      messages.push(message);
      if (message.type === 'job-done' && message.stage === 'final') {
        clearTimeout(timer);
        port.disconnect();
        resolve(messages);
      }
    });
    port.postMessage({ type: 'job', job });
  }), request);
  assert.equal(messages.filter((message) => message.type === 'job-done').length, 1);
  assert.equal(messages.at(-1).type, 'job-done');
  for (const segment of request.segments) {
    const final = messages.filter((message) => message.segmentId === segment.id && message.stage === 'final');
    assert.equal(final.length, 1, '每片段必须恰好有一次 final');
    assert.equal(final[0].type, 'result', JSON.stringify(final[0]));
    assert.equal(final[0].provider, 'llamacpp');
  }
  return messages.filter((message) => message.type === 'result').sort((a, b) => a.segmentId.localeCompare(b.segmentId));
}

async function inspectStorage(page) {
  return page.evaluate(async () => {
    const stored = await chrome.storage.local.get(null);
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('translate-backend', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (store, key) => new Promise((resolve, reject) => {
      const objectStore = database.transaction(store, 'readonly').objectStore(store);
      const request = key === undefined ? objectStore.getAll() : objectStore.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const key = await read('meta', 'device.secrets-key');
    let exportDenied = false;
    try { await crypto.subtle.exportKey('raw', key); } catch { exportDenied = true; }
    const result = { stored, key: { algorithm: key.algorithm.name, extractable: key.extractable, exportDenied },
      cache: await read('cache'), memory: await read('memory') };
    database.close();
    return result;
  });
}

try {
  let page = await launch();
  const ping = await rpc(page, 'ping');
  assert.equal(ping.protocol, 3);
  assert.match(ping.backend, /^\d+\.\d+\.\d+-/);
  const providers = await rpc(page, 'providers:list');
  assert.ok(providers.some((provider) => provider.id === 'llamacpp'));
  assert.ok(providers.every((provider) => provider.id !== 'pseudo'), '生产构建不能注册 pseudo 服务');
  assert.equal(providers.find((provider) => provider.id === 'google-web')?.enabled, false, '非官方网页兜底默认关闭');
  // 所有外部服务停用，独立测试既不触碰用户的本机 8081，也不消耗任何云端额度。
  for (const provider of providers.filter((entry) => entry.id !== 'llamacpp')) {
    await rpc(page, 'providers:save', { id: provider.id, enabled: false, config: provider.config });
  }
  await rpc(page, 'providers:save', { id: 'llamacpp', enabled: true, config: { url: address, key: token } });
  let local = (await rpc(page, 'providers:list')).find((provider) => provider.id === 'llamacpp');
  assert.equal(local.config.key, '••••');
  await rpc(page, 'providers:save', { id: 'llamacpp', enabled: true, config: { url: address, key: '••••' } });
  assert.equal((await rpc(page, 'providers:test', { id: 'llamacpp' })).ok, true);
  assert.equal(requests.length, 1, '服务测试必须发出真实的小请求');
  console.log('  ✓ 生产服务列表、真实 RPC 配置、密钥掩码及保留');

  const firstSnapshot = await snapshot(page);
  assert.equal(firstSnapshot.type, 'snapshot');
  assert.ok(firstSnapshot.status.providers.some((provider) => provider.id === 'llamacpp' && provider.configured));
  console.log('  ✓ 状态端口连接后立即返回真实快照');

  const first = await translate(page, sources);
  assert.ok(first.every((result) => result.cached === false));
  assert.ok(first.every((result) => Number.isFinite(result.timing?.queueMs) && result.timing.queueMs >= 0 && Number.isFinite(result.timing?.providerMs) && result.timing.providerMs >= 0), '真实结果必须包含排队与服务耗时');
  const firstCalls = requests.length;
  assert.equal(callsOf('nested'), 1, '嵌套片段必须只生成一次完整正文');
  assert.equal(callsOf('segment'), 1, '第二片段必须只请求一次');
  assert.ok(callsOf('anchor') >= 1 && callsOf('anchor') <= 2, '嵌套恢复只允许所需的两个独立短语锚点');
  assert.ok(first[0].text.startsWith(translations[0]), '嵌套 g/x 占位符须原样保留');
  assert.ok(first[1].text.startsWith(translations[1]));
  const cached = await translate(page, sources);
  assert.ok(cached.every((result) => result.cached === true));
  assert.deepEqual(cached.map((result) => result.text), first.map((result) => result.text));
  assert.equal(requests.length, firstCalls, '缓存命中不能重新调用服务');
  console.log('  ✓ 真实翻译端口逐段 final、嵌套占位符与 IndexedDB 缓存命中');

  const fresh = await translate(page, [sources[0]], { noCache: true });
  assert.equal(fresh[0].cached, false);
  assert.notEqual(fresh[0].text, first[0].text);
  const freshCalls = requests.length;
  assert.equal(callsOf('nested'), 2, 'noCache 必须重新生成一次完整正文');
  const afterPrivate = await translate(page, [sources[0]]);
  assert.equal(afterPrivate[0].text, first[0].text, 'noCache 不能覆盖已有缓存');
  assert.equal(requests.length, freshCalls, 'noCache 之后普通请求仍应复用已有缓存');
  let data = await inspectStorage(page);
  assert.equal(data.cache.length, 2);
  assert.equal(data.memory.length, 0);
  assert.equal(JSON.stringify(data.stored).includes(token), false);
  assert.ok(data.stored['backend.secrets'].llamacpp.data);
  assert.equal(data.stored['backend.providers'].llamacpp.config.key, undefined);
  assert.deepEqual(data.key, { algorithm: 'AES-GCM', extractable: false, exportDenied: true });
  assert.ok(requests.every((request) => request.authorized && request.cookie === undefined));
  console.log('  ✓ noCache 不读写缓存；真实密文存储、不可导出设备密钥与无 Cookie 请求');

  await context.close();
  context = undefined;
  page = await launch();
  local = (await rpc(page, 'providers:list')).find((provider) => provider.id === 'llamacpp');
  assert.equal(local.config.key, '••••');
  assert.equal(local.config.url, address);
  const restored = await translate(page, sources);
  assert.ok(restored.every((result) => result.cached));
  assert.deepEqual(restored.map((result) => result.text), first.map((result) => result.text));
  assert.equal(requests.length, freshCalls, '重启后应复用持久缓存');
  const restartFresh = await translate(page, [sources[0]], { noCache: true });
  assert.equal(restartFresh[0].cached, false);
  assert.equal(callsOf('nested'), 3, '重启后必须能解密密钥并重新生成一次完整正文');
  assert.ok(requests.length > freshCalls && requests.every((request) => request.authorized && request.cookie === undefined));
  data = await inspectStorage(page);
  assert.equal(data.key.exportDenied, true);
  assert.equal(JSON.stringify(data.stored).includes(token), false);
  console.log('  ✓ 关闭浏览器后重开同一独立资料夹，缓存与加密密钥均持久保留');
  const article = await context.newPage();
  const pageErrors = [];
  article.on('pageerror', (error) => pageErrors.push(error.message));
  await article.goto(address + '/article');
  await article.waitForSelector('tx-ui', { state: 'attached' });
  const original = await article.locator('#source').innerHTML();
  await article.evaluate(() => {
    globalThis.fixtureStages = [];
    globalThis.fixtureObserver = new MutationObserver(() => {
      for (const element of document.querySelectorAll('tx-t')) globalThis.fixtureStages.push(element.dataset.txStage);
    });
    globalThis.fixtureObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tx-stage'] });
  });
  await article.locator('tx-ui .ball').click();
  await article.waitForSelector('tx-t[data-tx-stage="final"]', { timeout: 15000 });
  assert.equal((await article.locator('tx-t').innerText()).trim(), '浏览器集成翻译。');
  assert.equal(await article.locator('tx-t a').getAttribute('href'), '/original-link');
  assert.ok((await article.evaluate(() => globalThis.fixtureStages)).includes('streaming'), 'SSE partial 必须先显示在真正的内容脚本中');
  assert.ok(requests.some((entry) => entry.input.stream === true && entry.input.messages[0].content.endsWith(pageSource)));
  await article.locator('tx-ui .ball').click();
  await article.waitForFunction(() => document.querySelectorAll('tx-t').length === 0);
  assert.equal(await article.locator('#source').innerHTML(), original, '还原后原文与链接必须保持精确一致');
  await article.evaluate(() => globalThis.fixtureObserver.disconnect());
  assert.deepEqual(pageErrors, []);
  await article.close();
  console.log('  ✓ 真实网页点击 → 内容脚本 → 后台 → SSE HTTP → partial/final 渲染、链接与原文还原');
  await checkInteractivePage(context, address, async (name, run) => {
    await run();
    console.log('  ✓ ' + name);
  });
  // 127.0.0.1 属于敏感站点。菜单卸载后再次展开可以重新翻译，每个条目在两轮稳定展示中至多两次。
  for (const row of fixtures.filter(entry => entry.kind === 'menu')) {
    const hits = requests.filter(entry => entry.kind === 'menu' && entry.input.messages[0].content.endsWith(row.source)).length;
    assert.ok(hits >= 1 && hits <= 2, row.source + ' 的翻译请求数异常：' + hits);
  }
  console.log(`浏览器后端集成验收通过：${requests.length} 次本机回放请求，${healthChecks} 次健康检查。`);
} finally {
  if (context) await context.close();
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
  // 只删除本次 mkdtemp 创建且仍位于临时根目录直属下的测试资料夹。
  if (path.dirname(path.resolve(profile)) !== temporaryRoot || !path.basename(profile).startsWith('translate-backend-browser-')) throw new Error('拒绝清理未经验证的测试资料夹路径');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
