import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';

// 正式前后端 / RPC / 标签页导航均真实；仅浏览器模型消息与下载 API 用回放，不下载模型。
const root = fileURLToPath(new URL('../../', import.meta.url));
const extension = path.resolve(process.env.EXT_DIR || path.join(root, '.output/chrome-mv3'));
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work/builtin-setup-browser'));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, version, '必须加载与当前源码版本一致的正式包');
await mkdir(output, { recursive: true });
const profileRoot = await realpath(os.tmpdir());
const profile = await mkdtemp(path.join(profileRoot, 'translate-builtin-setup-'));
const report = { at: new Date().toISOString(), version, extension, mocked: ['browser-translator offscreen responses', 'CLD result', 'Translator API download'], cases: [] };
let context;

async function rpc(page, name, payload) {
  const response = await page.evaluate(({ name, payload }) => chrome.runtime.sendMessage({ rpc: name, payload }), { name, payload });
  assert.equal(response?.ok, true, JSON.stringify(response));
  return response.data;
}

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 1000 },
    executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  // 不依赖外网，禁止卡片回归意外访问真实服务。
  await context.route(/^https?:\/\//, (route) => route.abort());
  await context.addInitScript(() => {
    const downloaded = new Set();
    window.__builtinFixture = { calls: [], finished: 0 };
    const pair = (options) => `${options.sourceLanguage}>${options.targetLanguage}`;
    Object.defineProperty(globalThis, 'Translator', { configurable: true, value: {
      async availability(options) {
        if (options.sourceLanguage === options.targetLanguage) return 'unavailable';
        return downloaded.has(pair(options)) ? 'available' : 'downloadable';
      },
      create(options) {
        window.__builtinFixture.calls.push({ source: options.sourceLanguage, target: options.targetLanguage, userActivation: navigator.userActivation.isActive });
        const monitor = new EventTarget();
        options.monitor?.(monitor);
        const event = new Event('downloadprogress');
        Object.assign(event, { loaded: 0.5, total: 1 });
        monitor.dispatchEvent(event);
        return new Promise((resolve) => {
          window.__finishBuiltinDownload = () => {
            downloaded.add(pair(options));
            resolve({ destroy() { window.__builtinFixture.finished++; } });
          };
        });
      },
    } });
  });
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const optionsUrl = `chrome-extension://${id}/options.html`;
  const setupUrl = optionsUrl + '?sourceLang=en&targetLang=ja#providers/browser-translator';
  await isolateAutomaticWelcome(context, id);
  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('settings.ui');
    await chrome.storage.local.set({ 'settings.ui': { ...stored['settings.ui'], onboarded: false, targetLang: 'ja', sourceLang: 'auto', uiLang: 'zh-CN' } });
    globalThis.__builtinMessages = [];
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function (message, ...rest) {
      if (message?.target !== 'tx-offscreen' || !message.task?.startsWith('browser-translator:')) return original(message, ...rest);
      globalThis.__builtinMessages.push(structuredClone(message));
      if (message.task === 'browser-translator:availability') return Promise.resolve({ ok: true, data: {
        status: 'downloadable', sourceLanguage: message.payload.sourceLang, targetLanguage: message.payload.targetLang, supportsAuto: true, detectorStatus: 'available',
      } });
      if (message.task === 'browser-translator:translate') return Promise.resolve({ ok: true, data: { ok: false, error: { code: 'no_provider', message: 'fixture: 语言包尚未下载', retryable: true } } });
      return Promise.resolve({ ok: true, data: {} });
    };
    chrome.i18n.detectLanguage = async () => ({ isReliable: true, languages: [{ language: 'en', percentage: 100 }] });
  });
  const settings = await context.newPage();
  await settings.goto(optionsUrl + '#providers');
  assert.equal((await rpc(settings, 'ping')).backend, `${version}-release`);
  const providers = await rpc(settings, 'providers:list');
  assert.equal(providers.some((provider) => provider.id === 'pseudo'), false);
  for (const provider of providers) await rpc(settings, 'providers:save', { id: provider.id, enabled: false, config: provider.config });
  const before = await settings.evaluate(() => chrome.storage.local.get('settings.ui'));
  const originalSettingsUrl = settings.url();
  const result = await rpc(settings, 'providers:test', { id: 'browser-translator', sourceLang: 'en', targetLang: 'ja' });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /en → ja/);
  let setup;
  for (let attempt = 0; attempt < 50 && !setup; attempt++) {
    setup = context.pages().find((page) => page.url() === setupUrl);
    if (!setup) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(setup, '显式测试必须打开新版设置卡片');
  await setup.locator('.bp').waitFor();
  assert.equal(setup.url(), setupUrl, '首次未完成引导仍应到指定服务');
  assert.match(await setup.locator('.bp').innerText(), /日语|日文|日本語/);
  assert.deepEqual(await setup.evaluate(() => window.__builtinFixture.calls), []);
  assert.deepEqual(await settings.evaluate(() => chrome.storage.local.get('settings.ui')), before);
  report.cases.push('显式检测从真后台打开新版卡片；首次引导和日语目标设置不被改写；无点击不下载');

  await setup.locator('.bp a.more').click();
  await setup.getByLabel('译文语言', { exact: true }).selectOption('zh-CN');
  await setup.waitForFunction(() => document.querySelector('.bp .bp-row')?.textContent?.includes('中文'));
  await setup.evaluate(() => { window.__setupSentinel = 'keep-this-document'; });
  const repeated = await Promise.all(Array.from({ length: 3 }, () => rpc(settings, 'providers:test', { id: 'browser-translator', sourceLang: 'en', targetLang: 'ja' })));
  assert.ok(repeated.every((reply) => reply.ok === false));
  assert.equal(context.pages().filter((page) => page.url() === setupUrl).length, 1);
  assert.equal(await setup.evaluate(() => window.__setupSentinel), 'keep-this-document');
  assert.equal(await setup.getByLabel('译文语言', { exact: true }).inputValue(), 'zh-CN');
  assert.equal(settings.url(), originalSettingsUrl, '不能改写原设置标签');
  report.cases.push('并发 / 重复检测复用同一标签，保留用户已选语言和页面状态');

  await setup.getByRole('button', { name: '下载语言包', exact: true }).click();
  await setup.locator('.bp progress:visible').waitFor();
  assert.equal(await setup.locator('.bp progress').getAttribute('value'), '0.5');
  const calls = await setup.evaluate(() => window.__builtinFixture.calls);
  assert.deepEqual(calls, [{ source: 'en', target: 'zh', userActivation: true }]);
  await setup.evaluate(() => { window.__beforeEnableCard = document.querySelector('.bp'); });
  await setup.evaluate(() => window.__finishBuiltinDownload());
  await setup.waitForFunction(() => document.querySelector('.bp')?.textContent?.includes('已下载'));
  assert.equal((await rpc(settings, 'providers:list')).find((provider) => provider.id === 'browser-translator').enabled, true);
  assert.equal(await setup.evaluate(() => window.__builtinFixture.finished), 1);
  // 第 47 节：确保经过父页面重画后检查，不能只读到旧卡片短暂出现的成功提示。
  await setup.waitForFunction(() => document.querySelector('.bp') !== window.__beforeEnableCard);
  await setup.waitForFunction(() => document.querySelector('.bp .ok')?.textContent?.includes('已下载'));
  assert.equal(await setup.getByLabel('原文语言', { exact: true }).inputValue(), 'en');
  assert.equal(await setup.getByLabel('译文语言', { exact: true }).inputValue(), 'zh-CN');
  assert.equal(await setup.getByLabel('译文语言', { exact: true }).isVisible(), true);
  assert.equal(await setup.getByRole('button', { name: '下载语言包', exact: true }).isVisible(), false);
  assert.equal(await setup.evaluate(() => window.__setupSentinel), 'keep-this-document');
  assert.deepEqual(await settings.evaluate(() => chrome.storage.local.get('settings.ui')), before);
  await setup.screenshot({ path: path.join(output, 'language-pack.png') });
  report.cases.push('真实点击下载完成后启用服务，父卡片已重画且保留临时方向、展开状态和已下载结果；全局语言不变');

  await setup.close();
  await settings.evaluate(async () => {
    const data = await chrome.storage.local.get('settings.ui');
    await chrome.storage.local.set({ 'settings.ui': { ...data['settings.ui'], targetLang: 'en' } });
  });
  const englishBefore = await settings.evaluate(() => chrome.storage.local.get('settings.ui'));
  await rpc(settings, 'providers:test', { id: 'browser-translator', sourceLang: 'zh-CN', targetLang: 'en' });
  const englishSetupUrl = optionsUrl + '?sourceLang=zh-CN&targetLang=en#providers/browser-translator';
  let englishSetup;
  for (let attempt = 0; attempt < 50 && !englishSetup; attempt++) {
    englishSetup = context.pages().find((page) => page.url() === englishSetupUrl);
    if (!englishSetup) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(englishSetup);
  await englishSetup.locator('.bp').waitFor();
  await englishSetup.locator('.bp a.more').click();
  assert.equal(await englishSetup.getByLabel('原文语言', { exact: true }).inputValue(), 'zh-CN');
  assert.equal(await englishSetup.getByLabel('译文语言', { exact: true }).inputValue(), 'en');
  assert.deepEqual(await settings.evaluate(() => chrome.storage.local.get('settings.ui')), englishBefore);
  assert.deepEqual(await englishSetup.evaluate(() => window.__builtinFixture.calls), []);
  report.cases.push('显式中文→英文检测打开同方向卡片；后台提示与实际检测一致，不偷偷改配置');
  report.messages = await worker.evaluate(() => globalThis.__builtinMessages);
  assert.ok(report.messages.some((message) => message.task === 'browser-translator:translate'));
  assert.ok(report.messages.some((message) => message.task === 'browser-translator:availability'));
  report.passed = true;
  console.log(JSON.stringify(report));
} catch (error) {
  report.passed = false;
  report.failure = String(error?.stack || error);
  throw error;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (context) await context.close();
  if (path.dirname(path.resolve(profile)) !== profileRoot || !path.basename(profile).startsWith('translate-builtin-setup-')) throw new Error('拒绝清理未经验证的测试资料夹');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
