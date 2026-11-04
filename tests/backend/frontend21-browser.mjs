import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const extension = path.resolve(process.env.EXT_DIR || path.join(root, '.output/chrome-mv3'));
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work/frontend21-browser'));
const profileRoot = path.join(root, 'work/browser-profiles');
const model = new URL(process.env.LLAMA_URL || 'http://127.0.0.1:8081');
assert.ok(['http:', 'https:'].includes(model.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(model.hostname) && !model.username && !model.password);
const modelAddress = model.href.replace(/\/+$/, '').replace(/\/v1$/, '');
assert.equal((await fetch(modelAddress + '/health', { signal: AbortSignal.timeout(10000) })).status, 200);
await mkdir(output, { recursive: true }); await mkdir(profileRoot, { recursive: true });
const profile = await mkdtemp(path.join(profileRoot, 'frontend21-'));
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
const report = { extension, version: manifest.version, backgroundSha256: createHash('sha256').update(await readFile(path.join(extension, 'background.js'))).digest('hex'), cases: [], llamaResponses: [] };
const body = '<h1>Frontend integration</h1><p id="paragraph">Read the <a href="https://example.com/guide"><strong>installation guide</strong></a>, then run <code>llama-server -ngl 99</code>. Keep all links and commands intact.</p>';
const errorBody = '<h1>No available engines</h1><p id="paragraph">When all engines are disabled, this new sentence cannot be translated.</p>';
const server = http.createServer((request, response) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Frontend 21 integration</title><style>body{max-width:980px;margin:55px auto;font:21px/1.8 Arial,sans-serif;padding:0 25px}h1{font-size:28px}a{color:#2456a6}code{font-size:17px}</style></head><body>${request.url === '/error' ? errorBody : body}</body></html>`));
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = `http://127.0.0.1:${server.address().port}`;
let context, worker, settings, page, rpc, id, activePage;
const errors = [], responses = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const result = await fn(); if (result) return result; await sleep(50); }
  throw new Error('等待真实浏览器状态超时');
}
const caseDone = (name, evidence = {}) => { report.cases.push({ name, ...evidence }); console.log('通过：' + name); };
const audit = () => worker.evaluate(() => globalThis.__frontend21Audit);
const latestParagraphJob = async () => (await audit()).filter((item) => item.type === 'job' && item.job.segments.some((segment) => segment.text.includes('installation'))).at(-1)?.job;
async function showToolbar() { await page.locator('#paragraph tx-t').hover(); await page.locator('tx-ui .ptb.on').waitFor({ timeout: 5000 }); }
async function translatePage(route = '/article') {
  await page.goto(address + route); await page.locator('tx-ui .ball').waitFor();
  await page.getByRole('button', { name: '翻译本页', exact: true }).press('Enter');
  await page.locator('#paragraph tx-t[data-tx-stage="final"]').waitFor({ timeout: 120000 });
  return page.locator('#paragraph tx-t').textContent();
}
async function currentEngine() {
  await showToolbar(); await page.getByRole('button', { name: '换一家翻译', exact: true }).click();
  await page.locator('tx-ui .engs.on [role="menuitem"]').first().waitFor();
  return page.locator('tx-ui .engs.on [aria-current="true"] span').first().textContent();
}
async function snapshot(action) {
  return settings.evaluate((action) => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'tx:status' });
    const timer = setTimeout(() => { port.disconnect(); reject(new Error('状态端口超时')); }, 10000);
    let sent = false;
    port.onMessage.addListener((message) => {
      if (message.type !== 'snapshot') return;
      if (action && !sent) { sent = true; port.postMessage({ type: 'provider-action', ...action }); return; }
      if (action && message.status.providers.find((provider) => provider.id === action.providerId)?.pinned !== (action.action === 'pin')) return;
      clearTimeout(timer); port.disconnect(); resolve(message.status);
    });
  }), action);
}

try {
  context = await chromium.launchPersistentContext(profile, { headless: process.env.HEADED !== '1', reducedMotion: 'reduce', viewport: { width: 1350, height: 1050 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE, ignoreDefaultArgs: ['--disable-extensions'] } : { channel: 'chromium' }) });
  const watch = (target) => target.on('pageerror', (error) => errors.push({ url: target.url(), message: error.message }));
  context.on('page', watch); context.pages().forEach(watch);
  context.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== model.origin || !url.pathname.endsWith('/v1/chat/completions')) return;
    responses.push(response.json().then((body) => report.llamaResponses.push({ status: response.status(), text: body.choices?.[0]?.message?.content, finishReason: body.choices?.[0]?.finish_reason })).catch(() => undefined));
  });
  [worker] = context.serviceWorkers(); worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 }); id = new URL(worker.url()).host;
  const installedWelcome = await until(() => context.pages().find((target) => target.url() === `chrome-extension://${id}/options.html#welcome`));
  await installedWelcome.getByRole('heading', { name: '欢迎使用「译」', exact: true }).waitFor();
  caseDone('fresh-install-opens-welcome', { url: installedWelcome.url() });
  await installedWelcome.close();
  // 仅被动记录真实RPC与端口输入，不响应消息、不替换实现或模型数据。
  await worker.evaluate(() => {
    globalThis.__frontend21Audit = [];
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (['providers:test', 'tm:save', 'feedback:bad', 'ui:openOptions'].includes(message?.rpc)) globalThis.__frontend21Audit.push({ type: 'rpc', rpc: message.rpc, payload: message.payload, sender: sender.url });
      return false;
    });
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === 'tx:translate') port.onMessage.addListener((message) => { if (message?.type === 'job') globalThis.__frontend21Audit.push({ type: 'job', job: message.job }); });
    });
  });
  settings = await context.newPage(); await settings.goto(`chrome-extension://${id}/options.html#general`);
  activePage = settings;
  rpc = async (rpc, payload) => {
    const result = await settings.evaluate(({ rpc, payload }) => chrome.runtime.sendMessage({ rpc, payload }), { rpc, payload });
    assert.equal(result?.ok, true, `${rpc}: ${JSON.stringify(result?.error)}`); return result.data;
  };
  report.backend = await rpc('ping');
  const providers = await rpc('providers:list'); assert.ok(!providers.some((provider) => provider.id === 'pseudo'));
  for (const provider of providers) if (provider.enabled) await rpc('providers:save', { id: provider.id, enabled: false, config: provider.config });
  await rpc('providers:save', { id: 'llamacpp', enabled: false, config: { url: modelAddress, key: process.env.LLAMA_API_KEY || '' } });
  await rpc('align:configure', { enabled: false, remoteUrl: '', token: '' });
  await worker.evaluate(() => chrome.storage.local.set({ 'settings.ui': { targetLang: 'zh-CN', mode: 'fast', display: 'bilingual', bilingualStyle: 'paragraph', loadingEffect: 'dots', sensitive: [], onboarded: false } }));
  await settings.getByRole('link', { name: '快速设置', exact: true }).click();
  await settings.locator('.pvr').first().waitFor();
  const localRow = settings.locator('.pvr').filter({ hasText: providers.find((provider) => provider.id === 'llamacpp').name });
  await localRow.locator('.res.ok').waitFor({ timeout: 60000 });
  const states = await until(async () => {
    const result = await settings.locator('.wz .pvr .res').allTextContents();
    return result.every((text) => text !== '检测中…') && result;
  }, 90000);
  report.welcomeRows = await settings.locator('.pvr').evaluateAll((rows) => rows.map((row) => ({ text: row.textContent, enabled: row.querySelector('input')?.checked })));
  const builtinNames = providers.filter((provider) => provider.kind === 'builtin').map((provider) => provider.name);
  assert.ok(report.welcomeRows[0].text.includes('推荐') && builtinNames.some((name) => report.welcomeRows[0].text.includes(name)));
  const unofficialIds = new Set(providers.filter((provider) => !provider.official).map((provider) => provider.id));
  assert.ok(!(await audit()).some((item) => item.rpc === 'providers:test' && unofficialIds.has(item.payload?.id)));
  assert.ok((await rpc('providers:list')).filter((provider) => !provider.official).every((provider) => !provider.enabled));
  // 引导自动检测可启用多个实际可用服务；试译单独只保留本机，保证这条证据确实来自本机模型。
  for (const provider of await rpc('providers:list')) if (provider.enabled && provider.id !== 'llamacpp') await rpc('providers:save', { id: provider.id, enabled: false, config: provider.config });
  await settings.locator('.try textarea').fill('The browser translates this sentence locally and keeps the original links safe.');
  await settings.getByRole('button', { name: '试译', exact: true }).click();
  await settings.locator('.try .out[data-stage="final"]').waitFor({ timeout: 60000 });
  report.welcomeTranslation = await settings.locator('.try .out').textContent(); assert.match(report.welcomeTranslation, /[\u4e00-\u9fff]/);
  assert.match(await settings.locator('.try .out .by').textContent(), /llamacpp/);
  await settings.screenshot({ path: path.join(output, 'welcome-real.png'), fullPage: true });
  caseDone('welcome-tests-official-only-and-real-local-try', { detectionRows: states.length, translation: report.welcomeTranslation });
  const paid = settings.locator('.keyl a').first();
  const paidHash = await paid.getAttribute('href'); await paid.click(); await until(() => settings.url().endsWith(paidHash));
  caseDone('welcome-provider-link-navigates-detail', { hash: paidHash });
  await settings.getByRole('link', { name: '快速设置', exact: true }).click();
  await settings.getByRole('button', { name: '完成，开始使用', exact: true }).click();
  await until(() => settings.url().endsWith('#general'));
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('settings.ui'))['settings.ui'].onboarded), true);
  caseDone('welcome-completion-persists');

  const beforeAdvanced = new Set(context.pages()); await rpc('ui:openOptions', { tab: 'advanced' });
  const advanced = await until(() => context.pages().find((target) => !beforeAdvanced.has(target) && target.url().endsWith('/options.html#advanced')));
  activePage = advanced;
  await advanced.getByRole('heading', { name: '高级', exact: true }).waitFor();
  const rules = advanced.locator('.card').filter({ has: advanced.getByRole('heading', { name: '站点规则', exact: true }) });
  await rules.getByRole('button', { name: '＋ 新建规则', exact: true }).click();
  await rules.getByLabel('适用的网站（每行一个，支持 *）', { exact: true }).fill('frontend21.example.test');
  await rules.getByLabel('只翻译这些区域（CSS 选择器，可空）', { exact: true }).fill('article');
  await rules.getByRole('button', { name: '添加规则', exact: true }).click();
  const row = rules.locator('tr').filter({ hasText: 'frontend21.example.test' });
  await until(async () => await row.count() > 0 || await rules.locator('.msg.bad').count() > 0);
  assert.equal(await rules.locator('.msg.bad').count(), 0, await rules.locator('.msg.bad').allTextContents());
  await row.waitFor();
  const created = (await rpc('rules:list')).find((rule) => rule.match.includes('*://frontend21.example.test/*'));
  assert.ok(created, '裸域名应在后端归一为完整安全模式'); assert.deepEqual(created.include, ['article']);
  assert.equal((await rpc('rules:forUrl', { url: 'https://frontend21.example.test/article' })).id, created.id);
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await rules.getByLabel('不翻译这些区域（CSS 选择器，可空）', { exact: true }).fill('.comments');
  await rules.getByRole('button', { name: '保存修改', exact: true }).click();
  await until(async () => (await rpc('rules:list')).find((rule) => rule.id === created.id)?.exclude?.includes('.comments'));
  await row.getByRole('button', { name: '删除', exact: true }).click(); await row.waitFor({ state: 'detached' });
  assert.ok(!(await rpc('rules:list')).some((rule) => rule.id === created.id));
  const alignCard = advanced.locator('.card').filter({ has: advanced.getByRole('heading', { name: '词典与词对齐', exact: true }) });
  await alignCard.getByLabel('启用词对齐模型（不启用时只按相同的词和数字对齐）', { exact: true }).uncheck();
  await alignCard.getByRole('button', { name: '保存', exact: true }).click();
  await alignCard.locator('.msg.ok').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('backend.alignment'))['backend.alignment'].enabled), false);
  const syncCard = advanced.locator('.card').filter({ has: advanced.getByRole('heading', { name: 'WebDAV 同步', exact: true }) });
  await syncCard.getByRole('button', { name: '停用同步', exact: true }).click(); await syncCard.locator('.msg.ok').filter({ hasText: '已停用' }).waitFor();
  await advanced.screenshot({ path: path.join(output, 'advanced-real.png'), fullPage: true });
  caseDone('advanced-deep-link-rules-crud-align-and-sync-save');

  // 离开引导后重新锁定本机提供方，避免仍在完成的检测启用远程服务。
  for (const provider of await rpc('providers:list')) if (provider.enabled && provider.id !== 'llamacpp') await rpc('providers:save', { id: provider.id, enabled: false, config: provider.config });
  await rpc('providers:save', { id: 'llamacpp', enabled: true, config: { url: modelAddress, key: process.env.LLAMA_API_KEY || '' } });
  page = await context.newPage(); activePage = page; await translatePage();
  assert.equal(await page.locator('#paragraph tx-t code').textContent(), 'llama-server -ngl 99');
  const secondary = await rpc('providers:add', { template: 'llamacpp', name: '联调本机二号' });
  await rpc('providers:save', { id: secondary.id, enabled: true, config: { url: modelAddress, key: '' } });
  const pinned = await snapshot({ providerId: 'llamacpp', action: 'pin' });
  const mainName = providers.find((provider) => provider.id === 'llamacpp').name;
  await showToolbar(); await page.getByRole('button', { name: '换一家翻译', exact: true }).click();
  await page.getByRole('menuitem', { name: /联调本机二号/ }).click();
  await page.locator('#paragraph tx-t[data-tx-stage="final"]').waitFor({ timeout: 60000 });
  assert.equal((await latestParagraphJob()).providerHint, secondary.id); assert.equal((await latestParagraphJob()).noCache, true); assert.equal((await latestParagraphJob()).mode, 'accurate');
  assert.equal(await currentEngine(), '联调本机二号');
  assert.deepEqual((await snapshot()).providers.map(({ id, pinned }) => [id, pinned]), pinned.providers.map(({ id, pinned }) => [id, pinned]));
  await translatePage(); assert.equal(await currentEngine(), mainName); assert.equal((await latestParagraphJob()).providerHint, undefined);
  caseDone('toolbar-provider-hint-is-one-job-and-does-not-change-pins');
  await page.mouse.move(10, 10); await showToolbar();
  const beforeRetry = (await audit()).filter((item) => item.type === 'job').length;
  await page.getByRole('button', { name: '重新翻译', exact: true }).click();
  await until(async () => (await audit()).filter((item) => item.type === 'job').length > beforeRetry);
  await page.locator('#paragraph tx-t[data-tx-stage="final"]').waitFor({ timeout: 60000 });
  assert.equal((await latestParagraphJob()).noCache, true);
  await showToolbar(); await page.getByRole('button', { name: '翻得不好（记一次差评并换一家重翻）', exact: true }).click();
  await until(async () => (await audit()).some((item) => item.rpc === 'feedback:bad'));
  await page.locator('#paragraph tx-t[data-tx-stage="final"]').waitFor({ timeout: 60000 });
  caseDone('toolbar-retry-and-feedback-send-real-backend-requests');
  await showToolbar(); await page.getByRole('button', { name: '修改译文（会记住，以后同一句直接用）', exact: true }).click();
  const editable = page.locator('#paragraph tx-t[contenteditable="true"]'); await editable.waitFor();
  const marker = ' 人工校订标记20261103'; await page.keyboard.insertText(marker); await page.keyboard.press('Enter');
  await page.getByRole('status').filter({ hasText: '已保存，以后同一句会直接用这个译文' }).waitFor({ timeout: 8000 });
  const memory = (await audit()).filter((item) => item.rpc === 'tm:save').at(-1)?.payload;
  assert.ok(memory?.source.includes('<g') && memory.source.includes('<x') && memory.target.includes(marker.trim()));
  const slots = (text) => [...text.matchAll(/<\/?[gx]\d+\/?>/g)].map((match) => match[0]).sort(); assert.deepEqual(slots(memory.target), slots(memory.source));
  await translatePage(); assert.match(await page.locator('#paragraph tx-t').textContent(), /人工校订标记20261103/);
  assert.equal((await latestParagraphJob()).noCache, undefined); assert.equal((await latestParagraphJob()).providerHint, undefined);
  assert.equal(await page.locator('#paragraph tx-t code').textContent(), 'llama-server -ngl 99'); assert.equal(await page.locator('#paragraph tx-t a').getAttribute('href'), 'https://example.com/guide');
  assert.equal(await page.locator('#paragraph tx-t a strong').count(), 1, '嵌套链接/加粗结构应与原占位符一致');
  report.memory = memory; await page.screenshot({ path: path.join(output, 'toolbar-memory-real.png') });
  caseDone('toolbar-edit-preserves-placeholders-and-normal-job-hits-memory');
  await showToolbar(); await page.getByRole('button', { name: '修改译文（会记住，以后同一句直接用）', exact: true }).click();
  await editable.fill('错误修改，故意移除全部链接和代码'); await page.keyboard.press('Enter');
  await page.getByRole('status').filter({ hasText: '已修改，但没能写入译文记忆' }).waitFor({ timeout: 8000 });
  const invalidEdit = (await audit()).filter((item) => item.rpc === 'tm:save').at(-1)?.payload;
  assert.equal(invalidEdit.source, memory.source); assert.ok(!/<[gx]\d/.test(invalidEdit.target));
  // 界面仅显示通用失败提示；另用同一真实payload核实正式RPC的校验错误码，不冒充读到原UI响应。
  report.invalidEditValidation = await settings.evaluate((payload) => chrome.runtime.sendMessage({ rpc: 'tm:save', payload }), invalidEdit);
  assert.equal(report.invalidEditValidation.ok, false); assert.equal(report.invalidEditValidation.error.code, 'bad_input'); assert.match(report.invalidEditValidation.error.message, /占位符/);
  await translatePage(); assert.match(await page.locator('#paragraph tx-t').textContent(), /人工校订标记20261103/); assert.equal(await page.locator('#paragraph tx-t code').textContent(), 'llama-server -ngl 99');
  caseDone('toolbar-missing-slots-rejected-and-previous-memory-kept');

  for (const provider of await rpc('providers:list')) if (provider.enabled) await rpc('providers:save', { id: provider.id, enabled: false, config: provider.config });
  await page.goto(address + '/error'); await page.locator('tx-ui .ball').waitFor(); await page.getByRole('button', { name: '翻译本页', exact: true }).press('Enter');
  const failed = page.locator('#paragraph tx-t[data-tx-stage="error"]'); await failed.waitFor({ timeout: 30000 }); assert.equal(await failed.textContent(), '');
  assert.match(await failed.getAttribute('title'), /失败/); await page.locator('tx-ui .ball').hover();
  await page.getByRole('button', { name: /全部重试/ }).waitFor();
  const pagesBeforeErrorAction = new Set(context.pages()); await page.getByRole('button', { name: /去设置服务/ }).click();
  const recovery = await until(() => context.pages().find((target) => !pagesBeforeErrorAction.has(target) && target.url().endsWith('/options.html#welcome')));
  await recovery.getByRole('heading', { name: '欢迎使用「译」', exact: true }).waitFor();
  report.errorRecovery = { title: await failed.getAttribute('title'), url: recovery.url() };
  await page.screenshot({ path: path.join(output, 'error-collapsed-real.png') }); caseDone('no-provider-collapses-error-and-action-opens-welcome');
  report.audit = await audit(); await Promise.all(responses);
  assert.ok(report.llamaResponses.some((item) => item.status === 200 && /[\u4e00-\u9fff]/.test(item.text)), '必须观察到真实本地模型中文响应');
  assert.deepEqual(errors, []); report.pageErrors = errors; report.ok = true;
  await rm(path.join(output, 'failure.png'), { force: true });
  console.log(JSON.stringify({ ok: true, cases: report.cases.length, backend: report.backend, realLocalResponses: report.llamaResponses.length }));
} catch (error) {
  report.ok = false; report.failure = { message: error.message, stack: error.stack }; report.pageErrors = errors;
  if (worker) report.audit = await audit().catch(() => undefined);
  const target = activePage || page || settings;
  if (target && !target.isClosed()) {
    report.failurePage = { url: target.url(), text: (await target.locator('body').innerText()).slice(0, 16000) };
    await target.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  }
  throw error;
} finally {
  await writeFile(path.join(output, 'frontend21-browser-result.json'), JSON.stringify(report, null, 2));
  if (context) await context.close();
  const closed = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await closed;
  if (path.dirname(path.resolve(profile)) !== path.resolve(profileRoot) || !path.basename(profile).startsWith('frontend21-')) throw new Error('拒绝清理非测试资料目录');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
