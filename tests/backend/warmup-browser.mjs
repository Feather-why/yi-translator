import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const extension = path.resolve(process.env.EXT_DIR || path.join(root, '.output/chrome-mv3'));
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work/warmup-browser'));
const endpoint = new URL(process.env.LLAMA_URL || 'http://127.0.0.1:8081');
assert.ok(['http:', 'https:'].includes(endpoint.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
const modelAddress = endpoint.href.replace(/\/+$/, '').replace(/\/v1$/, '');
const server = http.createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hover warm-up smoke</title></head><body></body></html>'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const profileRoot = path.join(root, 'work/browser-profiles'); await mkdir(profileRoot, { recursive: true }); await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(profileRoot, 'warmup-ui-'));
const report = { extension, modelAddress, requests: [], responses: [], errors: [] }; let context, active = false;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1100, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE, ignoreDefaultArgs: ['--disable-extensions'] } : { channel: 'chromium' }) });
  context.on('request', (request) => { const url = new URL(request.url()); if (active && url.origin === endpoint.origin) report.requests.push({ method: request.method(), path: url.pathname, hasBody: request.postData() !== null }); });
  context.on('response', (response) => { const url = new URL(response.url()); if (active && url.origin === endpoint.origin) report.responses.push({ path: url.pathname, status: response.status() }); });
  let [worker] = context.serviceWorkers(); worker ||= await context.waitForEvent('serviceworker'); const id = new URL(worker.url()).host;
  await isolateAutomaticWelcome(context, id);
  const settings = await context.newPage(); await settings.goto(`chrome-extension://${id}/options.html#providers`);
  const rpc = async (rpc, payload) => { const response = await settings.evaluate(({ rpc, payload }) => chrome.runtime.sendMessage({ rpc, payload }), { rpc, payload }); assert.equal(response?.ok, true, JSON.stringify(response?.error)); return response.data; };
  for (const provider of await rpc('providers:list')) if (provider.enabled) await rpc('providers:save', { id: provider.id, enabled: false, config: provider.config });
  await rpc('providers:save', { id: 'llamacpp', enabled: true, config: { url: modelAddress, key: process.env.LLAMA_API_KEY || '' } });
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ 'settings.ui': { mode: 'combined', targetLang: 'zh-CN', sensitive: [], onboarded: true } });
    globalThis.__warmSmoke = { calls: 0, jobs: 0 };
    chrome.runtime.onMessage.addListener((message) => { if (message?.rpc === 'providers:warm') globalThis.__warmSmoke.calls++; return false; });
    chrome.runtime.onConnect.addListener((port) => { if (port.name === 'tx:translate') port.onMessage.addListener((message) => { if (message?.type === 'job') globalThis.__warmSmoke.jobs++; }); });
  });
  const page = await context.newPage(); page.on('pageerror', (error) => report.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.locator('tx-ui .ball').waitFor();
  // 启动健康探测与页面初始化不计入hover窗口，窗口内不发任何翻译任务。
  await wait(250); active = true;
  await page.locator('tx-ui .ball').hover();
  const start = Date.now();
  while (!report.responses.some((response) => response.path.endsWith('/props')) && Date.now() - start < 10000) await wait(25);
  assert.ok(report.responses.some((response) => response.path.endsWith('/props') && response.status === 200));
  await wait(150);
  report.firstHover = await worker.evaluate(() => globalThis.__warmSmoke); assert.deepEqual(report.firstHover, { calls: 1, jobs: 0 });
  await page.mouse.move(20, 20); await wait(150); await page.locator('tx-ui .ball').hover(); await wait(250);
  report.secondHover = await worker.evaluate(() => globalThis.__warmSmoke); assert.deepEqual(report.secondHover, { calls: 1, jobs: 0 });
  report.acceptanceCheck = await rpc('models:warmup', { reason: 'manual', providerId: 'llamacpp' }); assert.equal(report.acceptanceCheck.status, 'cooldown');
  assert.deepEqual(report.requests, [{ method: 'GET', path: new URL(modelAddress + '/props').pathname, hasBody: false }]);
  assert.deepEqual(report.errors, []); await page.screenshot({ path: path.join(output, 'hover-warm-real.png') }); report.ok = true;
  console.log(JSON.stringify({ ok: true, aliases: report.secondHover.calls, jobs: report.secondHover.jobs, requests: report.requests, status: report.acceptanceCheck.status }));
} catch (error) { report.ok = false; report.failure = { message: error.message, stack: error.stack }; throw error; }
finally {
  await writeFile(path.join(output, 'warmup-browser-result.json'), JSON.stringify(report, null, 2));
  if (context) await context.close(); const closed = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await closed;
  if (path.dirname(path.resolve(profile)) !== path.resolve(profileRoot) || !path.basename(profile).startsWith('warmup-ui-')) throw new Error('拒绝清理非测试资料目录');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
