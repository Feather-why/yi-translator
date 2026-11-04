import {readFileSync} from 'node:fs';
const RELEASE_VERSION=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const extension = path.resolve(process.env.EXT_DIR || path.join(root, '.output/chrome-mv3'));
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work'));
const profileRoot = path.join(root, 'work/browser-profiles');
await mkdir(profileRoot, { recursive: true });
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(profileRoot, 'real-page-'));
let context;
const url = 'https://en.wikipedia.org/wiki/Machine_translation';
const observations = [];
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: process.env.HEADED !== '1', viewport: { width: 1360, height: 940 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE, ignoreDefaultArgs: ['--disable-extensions'] } : { channel: 'chromium' }),
  });
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${id}/options.html`);
  const rpc = async (rpc, payload) => {
    const response = await settings.evaluate(({ rpc, payload }) => chrome.runtime.sendMessage({ rpc, payload }), { rpc, payload });
    assert.equal(response?.ok, true, JSON.stringify(response?.error));
    return response.data;
  };
  assert.equal((await rpc('ping')).backend, `${RELEASE_VERSION}-release`);
  await rpc('align:configure', { enabled: false });
  for (const provider of await rpc('providers:list')) if (provider.enabled && provider.id !== 'llamacpp') await rpc('providers:save', { id: provider.id, enabled: false, config: provider.config });
  await rpc('providers:save', { id: 'llamacpp', enabled: true, config: { url: process.env.LLAMA_URL || 'http://127.0.0.1:8081', key: '' } });
  await worker.evaluate(() => chrome.storage.local.set({ 'settings.ui': { mode: 'fast', targetLang: 'zh-CN', display: 'bilingual', bilingualStyle: 'paragraph', loadingEffect: 'dots', sensitive: [] } }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('tx-ui .ball').waitFor();
  const lead = page.locator('.mw-parser-output p').filter({ hasText: /^Machine translation is the use/ }).first();
  const original = await lead.innerHTML();
  const originalLinks = await lead.locator('a').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  const start = Date.now();
  await page.getByRole('button', { name: '翻译本页', exact: true }).press('Enter');
  await page.waitForFunction(() => document.querySelector('tx-t[data-tx-stage="final"]'), null, { timeout: 30000 });
  const firstResultMs = Date.now() - start;
  for (const scrollY of [0, 940, 1880]) {
    await page.evaluate((top) => window.scrollTo(0, top), scrollY);
    await page.waitForTimeout(600);
    await page.waitForFunction(() => document.querySelectorAll('tx-t[data-tx-stage="pending"]').length === 0, null, { timeout: 180000 });
    const observation = await page.evaluate(() => ({
      scrollY: window.scrollY, total: document.querySelectorAll('tx-t').length,
      final: document.querySelectorAll('tx-t[data-tx-stage="final"]').length,
      pending: document.querySelectorAll('tx-t[data-tx-stage="pending"]').length,
      errors: [...document.querySelectorAll('tx-t[data-tx-stage="error"]')].map((node) => node.getAttribute('title')),
    }));
    observations.push(observation);
    console.log(JSON.stringify(observation));
    assert.deepEqual(observation.errors, [], '实际网页不得有占位符/服务错误');
    assert.ok(observation.final >= 10);
  }
  const translatedLead = await lead.locator('tx-t').innerText();
  assert.match(translatedLead, /[\u4e00-\u9fff]/);
  const translatedLinks = await lead.locator('tx-t a').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  assert.ok(translatedLinks.length >= originalLinks.length && originalLinks.every((link) => translatedLinks.includes(link)), '译文链接应来自原网页');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'whole-page-real-model.png') });
  await page.getByRole('button', { name: '翻译本页', exact: true }).press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('tx-t').length === 0);
  assert.equal(await lead.innerHTML(), original, '还原应与原始 DOM 完全相同');
  assert.deepEqual(errors, []);
  const report = { ok: true, url, provider: 'llamacpp', model: 'Hy-MT2-1.8B-Q4_K_M', firstResultMs, observations, translatedLead, originalLinks, translatedLinks, restoredExactly: true, pageErrors: errors };
  await writeFile(path.join(output, 'whole-page-real-model.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, firstResultMs, testedScrollPositions: observations.length, restoredExactly: true }));
} finally {
  if (context) await context.close();
  if (path.dirname(path.resolve(profile)) !== path.resolve(profileRoot) || !path.basename(profile).startsWith('real-page-')) throw new Error('拒绝清理未经验证的测试目录');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
