import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { IMAGE_MENU_ID, PDF_LINK_MENU_ID, PDF_PAGE_MENU_ID, translationMenus, installTranslationMenus, handleMediaMenu, imageResourceUrl, pdfResourceUrl } = require('../.compiled/backend/context-menu.js');
function actions() {
  const sent = [], opened = [];
  return { sent, opened, send: async (...args) => sent.push(args), open: async (url) => opened.push(url), getURL: (path) => `chrome-extension://fixture/${path}` };
}

test('媒体菜单保留旧入口，图片上下文及PDF链接/页面分别过滤，重载先清除旧菜单', async () => {
  const definitions = translationMenus(), sequence = [];
  assert.deepEqual(definitions.map((item) => item.id), ['tx-selection', 'tx-page', IMAGE_MENU_ID, PDF_LINK_MENU_ID, PDF_PAGE_MENU_ID]);
  assert.equal(definitions.find((item) => item.id === IMAGE_MENU_ID).title, '翻译这张图片');
  assert.deepEqual(definitions.find((item) => item.id === IMAGE_MENU_ID).contexts, ['image']);
  const link = definitions.find((item) => item.id === PDF_LINK_MENU_ID), page = definitions.find((item) => item.id === PDF_PAGE_MENU_ID);
  assert.equal(link.title, '用双栏阅读器打开'); assert.equal(page.title, link.title);
  assert.equal(link.targetUrlPatterns.length, 8); assert.equal(page.documentUrlPatterns.length, 10);
  assert.ok(link.targetUrlPatterns.includes('*://*/*.pDf*'));
  assert.deepEqual(page.documentUrlPatterns.slice(8), ['*://arxiv.org/pdf/*', '*://export.arxiv.org/pdf/*']);
  await installTranslationMenus({ removeAll: async () => sequence.push('reset'), create: (value) => sequence.push(value.id) });
  assert.deepEqual(sequence, ['reset', ...definitions.map((item) => item.id)]);
});

test('图片菜单只把浏览器srcUrl发往点击的frame，不广播到其他框架', async () => {
  const api = actions();
  assert.equal(await handleMediaMenu({ menuItemId: IMAGE_MENU_ID, srcUrl: 'https://example.test/sign.png?size=large', frameId: 7 }, { id: 42 }, api), true);
  assert.deepEqual(api.sent, [[42, { cmd: 'translate-image', srcUrl: 'https://example.test/sign.png?size=large' }, { frameId: 7 }]]);
  await handleMediaMenu({ menuItemId: IMAGE_MENU_ID, srcUrl: 'https://example.test/top.png' }, { id: 43 }, api);
  assert.equal(api.sent[1][2].frameId, 0); assert.deepEqual(api.opened, []);
});

test('划词菜单将浏览器选区原样交给顶层frame0，不发往PDF内部选区框架', async () => {
  const api = actions(), text = '  Dynasty of the Country of the Sea\n“海之国” 🗺️  ';
  assert.equal(await handleMediaMenu({ menuItemId: 'tx-selection', selectionText: text, frameId: 17,
    frameUrl: 'chrome-extension://native-pdf-viewer/index.html' }, { id: 42 }, api), true);
  assert.deepEqual(api.sent, [[42, { cmd: 'translate-selection', text }, { frameId: 0 }]]);
  assert.deepEqual(api.opened, []);
});

test('没有selectionText的旧划词入口仍可转发，空字符串不被自行替换', async () => {
  const api = actions();
  assert.equal(await handleMediaMenu({ menuItemId: 'tx-selection' }, { id: 0 }, api), true);
  assert.equal(await handleMediaMenu({ menuItemId: 'tx-selection', selectionText: '', frameId: 7 }, { id: 3 }, api), true);
  assert.deepEqual(api.sent, [[0, { cmd: 'translate-selection', text: undefined }, { frameId: 0 }],
    [3, { cmd: 'translate-selection', text: '' }, { frameId: 0 }]]);
  assert.deepEqual(api.opened, []);
});

test('划词菜单缺少有效tab时安全退出，不发送消息或打开页面', async () => {
  const api = actions();
  for (const tab of [undefined, {}, { id: -1 }, { id: NaN }, { id: 1.5 }]) {
    assert.equal(await handleMediaMenu({ menuItemId: 'tx-selection', selectionText: 'public selected text' }, tab, api), false);
  }
  assert.deepEqual(api.sent, []); assert.deepEqual(api.opened, []);
});

test('划词顶层接收者已关闭时只尝试一次，异常隔离后其他菜单仍可执行', async () => {
  const api = actions(); let attempts = 0;
  const failing = { ...api, send: async (...args) => { attempts++; api.sent.push(args); throw new Error('top frame closed'); } };
  assert.equal(await handleMediaMenu({ menuItemId: 'tx-selection', selectionText: 'selected text', frameId: 5 }, { id: 8 }, failing), false);
  assert.equal(attempts, 1);
  assert.deepEqual(api.sent, [[8, { cmd: 'translate-selection', text: 'selected text' }, { frameId: 0 }]]);
  assert.deepEqual(api.opened, []);
  assert.equal(await handleMediaMenu({ menuItemId: IMAGE_MENU_ID, srcUrl: 'https://example.test/image.png', frameId: 5 }, { id: 8 }, api), true);
  assert.deepEqual(api.sent.at(-1), [8, { cmd: 'translate-image', srcUrl: 'https://example.test/image.png' }, { frameId: 5 }]);
});

test('合法blob/data图片保持资源地址，脚本/HTML/凭据地址不转发', async () => {
  for (const value of ['blob:https://example.test/a-resource', 'data:image/png;base64,iVBORw0KGgo=']) assert.equal(imageResourceUrl(value), value);
  for (const value of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'https://user:pass@example.test/a.png', 'blob:https://user:pass@example.test/a', 'blob:null/a', 'file:///C:/a.png', undefined]) assert.equal(imageResourceUrl(value), undefined);
});

test('无效tab/frame或源地址不执行，页面已关闭的发送失败不重发', async () => {
  const api = actions();
  for (const tab of [undefined, {}, { id: -1 }, { id: NaN }]) assert.equal(await handleMediaMenu({ menuItemId: IMAGE_MENU_ID, srcUrl: 'https://example.test/a.png' }, tab, api), false);
  for (const frameId of [-1, 1.5, NaN]) assert.equal(await handleMediaMenu({ menuItemId: IMAGE_MENU_ID, srcUrl: 'https://example.test/a.png', frameId }, { id: 4 }, api), false);
  assert.equal(await handleMediaMenu({ menuItemId: IMAGE_MENU_ID, srcUrl: 'javascript:alert(1)' }, { id: 4 }, api), false);
  assert.deepEqual(api.sent, []); assert.deepEqual(api.opened, []);
  let attempts = 0;
  assert.equal(await handleMediaMenu({ menuItemId: IMAGE_MENU_ID, srcUrl: 'https://example.test/a.png' }, { id: 4 }, { ...api, send: async () => { attempts++; throw new Error('frame closed'); } }), false);
  assert.equal(attempts, 1);
});

test('PDF地址按pathname判断，兼容大小写、查询、fragment与编码扩展名', () => {
  for (const value of ['https://example.test/PAPER.PDF?download=1&x=2#page=3', 'http://127.0.0.1:1234/a.pDf#page=2', 'https://example.test/paper%2Epdf']) assert.equal(pdfResourceUrl(value), value);
  for (const value of ['https://example.test/a.html?file=paper.pdf', 'https://example.test/a.pdfx', 'https://example.test/a.pdf/chapter', 'javascript:paper.pdf', 'file:///C:/paper.pdf', 'https://user:pass@example.test/paper.pdf', 'https://example.test/a%ZZ.pdf']) assert.equal(pdfResourceUrl(value), undefined);
});

test('PDF链接打开本扩展阅读器并编码整个原始地址，不误用当前页', async () => {
  const api = actions(), url = 'https://example.test/PAPER.PDF?download=1&signature=a%2Fb#page=3';
  assert.equal(await handleMediaMenu({ menuItemId: PDF_LINK_MENU_ID, linkUrl: url, pageUrl: 'https://example.test/index.html' }, { id: 4 }, api), true);
  assert.deepEqual(api.opened, ['chrome-extension://fixture/pdf.html?url=' + encodeURIComponent(url)]);
  assert.equal(new URL(api.opened[0]).searchParams.get('url'), url); assert.deepEqual(api.sent, []);
  assert.equal(await handleMediaMenu({ menuItemId: PDF_LINK_MENU_ID, linkUrl: 'https://example.test/page.html' }, { id: 4, url }, api), false);
  assert.equal(api.opened.length, 1);
});

test('PDF页面支持frame来源及内置查看器回退，未知菜单与无效地址没有动作', async () => {
  const api = actions();
  assert.equal(await handleMediaMenu({ menuItemId: PDF_PAGE_MENU_ID, frameUrl: 'https://example.test/inside.pdf', pageUrl: 'https://example.test/index.html' }, { id: 4 }, api), true);
  assert.equal(await handleMediaMenu({ menuItemId: PDF_PAGE_MENU_ID, frameUrl: 'chrome-extension://native-viewer/index.html', pageUrl: 'https://example.test/top.pdf?x=1' }, { id: 4 }, api), true);
  assert.equal(await handleMediaMenu({ menuItemId: PDF_PAGE_MENU_ID }, { id: 4, url: 'https://example.test/fallback.PDF#page=1' }, api), true);
  assert.equal(await handleMediaMenu({ menuItemId: PDF_PAGE_MENU_ID, pageUrl: 'data:application/pdf;base64,AA==' }, { id: 4 }, api), false);
  assert.equal(await handleMediaMenu({ menuItemId: 'unknown', linkUrl: 'https://example.test/a.pdf' }, { id: 4 }, api), false);
  assert.equal(api.opened.length, 3);
});

function routeActions(chunks, { status = 206, type = 'application/pdf' } = {}) {
  const api = actions(), requests = [];
  let reads = 0, cancelled = 0;
  const reader = { read: async () => { reads++; const value = chunks.shift(); return value ? { value, done: false } : { done: true }; }, cancel: async () => { cancelled++; } };
  api.fetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: status >= 200 && status < 300, status, redirected: false, headers: new Headers({ 'content-type': type }), body: { getReader: () => reader, cancel: async () => { cancelled++; } } };
  };
  return { api, requests, counts: () => ({ reads, cancelled }) };
}
const bytes = (text) => new TextEncoder().encode(text);

test('仅两个arXiv页面路由取Range文件头，跨chunk识别后取消流并完整编码阅读器地址', async () => {
  for (const source of ['https://arxiv.org/pdf/2501.12345?download=1#page=3', 'http://export.arxiv.org/pdf/hep-th/9901001']) {
    const fixture = routeActions([bytes('%P'), bytes('DF-1.7\nextra chunk already buffered'), bytes('must not read remaining paper')]);
    assert.equal(await handleMediaMenu({ menuItemId: PDF_PAGE_MENU_ID, pageUrl: source }, { id: 4 }, fixture.api), true);
    assert.deepEqual(fixture.api.opened, ['chrome-extension://fixture/pdf.html?url=' + encodeURIComponent(source)]);
    assert.equal(fixture.requests.length, 1);
    const { url, init } = fixture.requests[0]; assert.equal(url, source);
    assert.equal(init.method, 'GET'); assert.deepEqual(init.headers, { Range: 'bytes=0-4' });
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted, true);
    assert.deepEqual(fixture.counts(), { reads: 2, cancelled: 1 });
  }
});

test('候选路由的HTML、错误HTTP、过短响应均不开阅读器并取消流', async () => {
  for (const [chunks, options, reads] of [
    [[bytes('<html>not a PDF')], { type: 'application/pdf' }, 1],
    [[bytes('%PDF-')], { status: 403 }, 0],
    [[bytes('%PD')], {}, 2],
  ]) {
    const fixture = routeActions(chunks, options);
    assert.equal(await handleMediaMenu({ menuItemId: PDF_PAGE_MENU_ID, pageUrl: 'https://arxiv.org/pdf/2501.12345' }, { id: 4 }, fixture.api), false);
    assert.deepEqual(fixture.api.opened, []); assert.deepEqual(fixture.counts(), { reads, cancelled: 1 });
  }
});

test('服务器忽略Range返回整份PDF的首chunk时只读一次立即取消，不读剩余文件', async () => {
  const fixture = routeActions([bytes('%PDF-1.7\n' + 'x'.repeat(65536)), bytes('unread')], { status: 200, type: 'application/octet-stream' });
  assert.equal(await handleMediaMenu({ menuItemId: PDF_PAGE_MENU_ID, pageUrl: 'https://arxiv.org/pdf/2501.12345' }, { id: 4 }, fixture.api), true);
  assert.deepEqual(fixture.counts(), { reads: 1, cancelled: 1 });
});

test('探测fetch及读取流均受五秒Abort约束，取消并拒绝打开', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const phase of ['fetch', 'read']) {
    const api = actions(); let signal, cancelled = 0;
    api.fetch = async (_url, init) => {
      signal = init.signal;
      const waitForAbort = () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
      if (phase === 'fetch') return waitForAbort();
      return { ok: true, redirected: false, body: { getReader: () => ({ read: waitForAbort, cancel: async () => { cancelled++; } }) } };
    };
    const operation = handleMediaMenu({ menuItemId: PDF_PAGE_MENU_ID, pageUrl: 'https://arxiv.org/pdf/2501.12345' }, { id: 4 }, api);
    await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(5000);
    assert.equal(await operation, false); assert.equal(signal.aborted, true); assert.deepEqual(api.opened, []);
    assert.equal(cancelled, phase === 'read' ? 1 : 0);
  }
});

test('未知route、伪域名、凭据地址和无后缀链接均不探测，原.pdf仍直接打开', async () => {
  const api = actions(); let requests = 0;
  api.fetch = async () => { requests++; throw new Error('unexpected network'); };
  for (const source of ['https://example.test/pdf/2501.12345', 'https://arxiv.org/abs/2501.12345', 'https://arxiv.org/pdf/', 'https://arxiv.org.evil.test/pdf/1', 'https://user:pass@arxiv.org/pdf/1', 'file:///pdf/1']) {
    assert.equal(await handleMediaMenu({ menuItemId: PDF_PAGE_MENU_ID, pageUrl: source }, { id: 4 }, api), false);
  }
  assert.equal(await handleMediaMenu({ menuItemId: PDF_LINK_MENU_ID, linkUrl: 'https://arxiv.org/pdf/2501.12345' }, { id: 4 }, api), false);
  assert.equal(await handleMediaMenu({ menuItemId: PDF_PAGE_MENU_ID, pageUrl: 'https://example.test/paper.pdf' }, { id: 4 }, api), true);
  assert.equal(requests, 0); assert.equal(api.opened.length, 1);
});

test('候选验证网络/重定向拒绝只尝试一次，不退到其他候选来源', async () => {
  const api = actions(); let requests = 0;
  api.fetch = async (_url, init) => { requests++; assert.equal(init.redirect, 'error'); throw new TypeError('redirect rejected'); };
  assert.equal(await handleMediaMenu({ menuItemId: PDF_PAGE_MENU_ID, frameUrl: 'https://arxiv.org/pdf/1', pageUrl: 'https://example.test/top.pdf' }, { id: 4 }, api), false);
  assert.equal(requests, 1); assert.deepEqual(api.opened, []);
});
