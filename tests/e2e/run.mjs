/**
 * 端到端测试：用 Playwright 加载构建好的扩展，在示例页面上检查整页翻译的关键行为。
 *
 *   node tests/e2e/build-ui.mjs                               # 假后端的界面测试构建 → .output/ui-test
 *   EXT_DIR=.output/ui-test node tests/e2e/run.mjs
 *
 * 断言按假后端（src/dev/mock-backend.ts）的译文和服务列表写；用真实构建（.output/chrome-mv3）跑会有断言不符。
 * 第一次运行前需要：npx playwright install chromium
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
// 默认用 build-ui.mjs 的假后端构建；没有就退回正式构建
const extDir = path.resolve(process.env.EXT_DIR || [path.join(here, '../../.output/ui-test'), path.join(here, '../../.output/chrome-mv3')].find((d) => existsSync(d)) || '.output/ui-test');

const server = http.createServer(async (req, res) => {
  try {
    const file = path.join(here, 'fixtures', path.basename(new URL(req.url, 'http://x').pathname) || 'article.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: !process.env.HEADED,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 1100, height: 900 },
  locale: 'zh-CN',
});
let failed = 0;
const errors = [];
const step = async (name, fn) => {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (e) {
    failed++;
    console.log('  ✕', name, '\n   ', e.message);
  }
};

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = sw.url().split('/')[2];
  const setUi = (patch) => sw.evaluate((p) => chrome.storage.local.set({ 'settings.ui': p }), patch);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/article.html`);
  await page.waitForSelector('tx-ui', { state: 'attached' });
  const originalHtml = await page.evaluate(() => document.querySelector('p').innerHTML);

  console.log('悬浮球');
  await step('悬停展开菜单时球的位置不变', async () => {
    const ball = page.locator('tx-ui .ball');
    await ball.hover();
    await page.waitForTimeout(300); // 从贴边处滑出完成
    const a = await ball.boundingBox();
    await page.waitForTimeout(500); // 菜单已展开
    const open = await page.evaluate(() => document.querySelector('tx-ui').shadowRoot.querySelector('.ball-wrap').classList.contains('open'));
    const b = await ball.boundingBox();
    assert.ok(open, '菜单没有展开');
    assert.ok(Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1, `球移动了：${JSON.stringify([a, b])}`);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
  });

  await step('小窗里显示用量和引擎选择', async () => {
    await page.locator('tx-ui .ball').hover();
    await page.waitForFunction(() => {
      const root = document.querySelector('tx-ui').shadowRoot;
      const sel = root.querySelector('.menu select.sel');
      return root.querySelector('.ball-wrap.open') && sel && !sel.disabled && sel.options.length >= 1 && root.querySelector('.usage .usum');
    }, null, { timeout: 6000 });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
  });

  console.log('整页翻译');
  await step('点击悬浮球后首屏出现译文', async () => {
    await page.locator('tx-ui .ball').click();
    await page.waitForFunction(() => document.querySelectorAll('tx-t[data-tx-stage="final"]').length >= 8, null, { timeout: 8000 });
  });
  await step('悬浮球：未翻译、翻译中、已翻译三种样子', async () => {
    const bp = await ctx.newPage();
    bp.on('pageerror', (e) => errors.push(e.message));
    await bp.goto(`${base}/breaks.html`);
    await bp.waitForSelector('tx-ui', { state: 'attached' });
    const st = () => bp.evaluate(() => {
      const root = document.querySelector('tx-ui').shadowRoot;
      const w = root.querySelector('.ball-wrap');
      return { state: w.dataset.state, ok: getComputedStyle(root.querySelector('.ball .ok')).display, bg: getComputedStyle(root.querySelector('.ball')).backgroundColor };
    });
    const idle = await st();
    assert.equal(idle.state, 'idle');
    assert.equal(idle.ok, 'none');
    await bp.locator('tx-ui .ball').click();
    await bp.mouse.move(5, 5);
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      const s = await st();
      seen.add(s.state);
      if (s.state === 'done') break;
      await bp.waitForTimeout(50);
    }
    assert.ok(seen.has('busy'), '没有看到「翻译中」状态：' + [...seen]);
    const done = await st();
    assert.equal(done.state, 'done');
    assert.notEqual(done.ok, 'none', '已翻译时角上应有小对勾');
    assert.notEqual(done.bg, idle.bg, '已翻译和未翻译看起来一样');
    await bp.close();
  });

  await step('译文里的链接指向原链接，纯文本网址变成链接', async () => {
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('tx-t a')].map((a) => a.href));
    assert.ok(hrefs.includes('https://example.com/guide'), hrefs.join(','));
    assert.ok(hrefs.includes('https://example.org/models'), hrefs.join(','));
  });
  await step('代码原样保留', async () => {
    const code = await page.evaluate(() => document.querySelector('tx-t code')?.textContent);
    assert.equal(code, 'llama-server -ngl 99');
  });
  await step('已是中文的段落不翻译', async () => {
    const has = await page.evaluate(() => !![...document.querySelectorAll('p')].find((p) => p.textContent.includes('已经是中文'))?.querySelector('tx-t'));
    assert.equal(has, false);
  });
  await step('页面后来插入的段落也会翻译', async () => {
    await page.waitForFunction(() => !!document.querySelector('#dyn tx-t[data-tx-stage="final"]'), null, { timeout: 6000 });
  });
  await step('还原后 DOM 与原来一致', async () => {
    await page.locator('tx-ui .ball').click();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.querySelectorAll('tx-t').length), 0);
    assert.equal(await page.evaluate(() => document.querySelector('p').innerHTML), originalHtml);
  });

  await step('鼠标停在译文上出现段落工具条', async () => {
    await page.locator('tx-ui .ball').click();
    await page.waitForFunction(() => document.querySelectorAll('tx-t[data-tx-stage="final"]').length >= 3, null, { timeout: 8000 });
    await page.locator('p').first().locator('tx-t').hover();
    await page.waitForSelector('tx-ui .ptb.on', { timeout: 3000 });
    await page.mouse.move(5, 5);
    await page.locator('tx-ui .ball').click();
    await page.waitForTimeout(150);
  });

  await step('用 <br> 分开的段落：每一段后面跟自己的译文，不全堆到最后', async () => {
    const bp = await ctx.newPage();
    bp.on('pageerror', (e) => errors.push(e.message));
    await bp.goto(`${base}/breaks.html`);
    await bp.waitForSelector('tx-ui', { state: 'attached' });
    await bp.locator('tx-ui .ball').click();
    await bp.mouse.move(5, 5);
    await bp.waitForFunction(() => {
      const t = [...document.querySelectorAll('#desc tx-t')];
      return t.length >= 6 && t.every((x) => x.dataset.txStage === 'final');
    }, null, { timeout: 8000 });
    const shape = await bp.evaluate(() => [...document.querySelector('#desc p').childNodes].map((n) => n.nodeName === 'TX-T' ? 'T' : n.nodeName === 'BR' ? 'b' : '·').join(''));
    // 每个译文紧跟在自己那一段后面；冒号结尾和列表式的单个 <br> 也分段；没有标点的诗行（单个 <br>）不拆
    assert.equal((shape.match(/T/g) || []).length, 6, shape);
    assert.ok(!/TT/.test(shape) && shape.indexOf('T') < shape.indexOf('b'), `译文位置不对：${shape}`);
    // 看不见的零宽元素不翻（以前会在零宽盒子里一字一行排下去，竖线样式下成了贯穿整页的竖线）
    assert.equal(await bp.evaluate(() => document.querySelectorAll('#ghost tx-t').length), 0, '零宽、透明的元素也被翻译了');
    await bp.locator('tx-ui .ball').click();
    await bp.waitForFunction(() => !document.querySelector('tx-t'));
    await bp.close();
  });

  await step('网格 / 弹性布局、树状表格里的译文不会被撑高（竖线样式下不出现贯穿整页的竖线）', async () => {
    await setUi({ txStyle: 'bar', mainOnly: false });
    const lp = await ctx.newPage();
    lp.on('pageerror', (e) => errors.push(e.message));
    await lp.goto(`${base}/layouts.html`);
    await lp.waitForSelector('tx-ui', { state: 'attached' });
    await lp.locator('tx-ui .ball').click();
    await lp.mouse.move(5, 5);
    await lp.waitForFunction(() => document.querySelectorAll('tx-t[data-tx-stage="final"]').length >= 6, null, { timeout: 8000 });
    await lp.waitForTimeout(500);
    const bad = await lp.evaluate(() => [...document.querySelectorAll('tx-t')].map((t) => {
      const r = t.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(t);
      const c = range.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(t).lineHeight) || parseFloat(getComputedStyle(t).fontSize) * 1.5;
      return { text: t.textContent.slice(0, 20), h: Math.round(r.height), c: Math.round(c.height), w: Math.round(r.width), lh };
    }).filter((x) => x.h > x.c + x.lh || x.w < 20));
    assert.deepEqual(bad, [], '有译文框被撑高或挤成一条：' + JSON.stringify(bad));
    // 网格容器里直接的文字（页面骨架上的提示）不翻：插进去会多出一个网格单元，打乱整页布局
    assert.equal(await lp.evaluate(() => [...document.querySelector('#grid').children].filter((c) => c.tagName === 'TX-T').length), 0);
    // 维基百科「Human」页的竖线：时间轴里 1px 高 100% 的刻度线被拷进译文，改成相对整个正文定位，贯穿整页
    const tl = await lp.evaluate(() => {
      const cloned = [...document.querySelectorAll('tx-t *')].filter((e) => /absolute|fixed/.test(getComputedStyle(e).position)).length;
      const lines = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.height > 200 && r.width > 0 && r.width < 6; }).length;
      const inLabels = document.querySelectorAll('.tl tx-t').length;
      const range = document.querySelector('#trange tx-t');
      return { cloned, lines, inLabels, range: !!range };
    });
    assert.deepEqual(tl, { cloned: 0, lines: 0, inLabels: 0, range: true }, '时间轴：' + JSON.stringify(tl));
    // 标签栏：译文和原文在同一条线上（以前译文被顶到标签的最上面）
    const tabs = await lp.evaluate(() => [...document.querySelectorAll('#tabs a')].map((a) => {
      const tx = a.querySelector('tx-t');
      if (!tx) return { text: a.textContent, missing: true };
      const w = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
      let o = null;
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.parentElement.closest('tx-t') || !n.nodeValue.trim()) continue;
        const r = document.createRange(); r.selectNodeContents(n); o = r.getBoundingClientRect();
      }
      const t = [...tx.getClientRects()].find((r) => r.height > 0);
      return { text: a.textContent.slice(0, 14), d: Math.round(((o.top + o.bottom) / 2 - (t.top + t.bottom) / 2) * 10) / 10 };
    }));
    assert.ok(tabs.every((x) => !x.missing && Math.abs(x.d) <= 2), '标签栏的译文没和原文对齐：' + JSON.stringify(tabs));
    await lp.close();
    await setUi({});
  });

  console.log('逐句对照');
  await step('逐句插入译文，还原后文本节点合并回去', async () => {
    await setUi({ bilingualStyle: 'sentence' });
    await page.waitForTimeout(200);
    await page.locator('tx-ui .ball').click();
    await page.waitForFunction(() => document.querySelectorAll('tx-t[data-tx-mode="sentence"][data-tx-stage="final"]').length >= 4, null, { timeout: 8000 });
    await page.locator('tx-ui .ball').click();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.querySelector('p').innerHTML), originalHtml);
    assert.equal(await page.evaluate(() => document.querySelector('p').childNodes.length), 5);
    await setUi({ bilingualStyle: 'paragraph' });
  });

  console.log('流式输出与首屏耗时');
  await step('精确模式下先流式出字，最后不残留半个占位符', async () => {
    await setUi({ mode: 'accurate' });
    await page.waitForTimeout(200);
    await page.locator('tx-ui .ball').click();
    await page.mouse.move(5, 5);
    await page.waitForSelector('tx-t[data-tx-stage="streaming"]', { timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector('tx-t[data-tx-stage="streaming"]')
      && document.querySelectorAll('tx-t[data-tx-stage="final"]').length >= 3, null, { timeout: 8000 });
    const leaked = await page.evaluate(() => [...document.querySelectorAll('tx-t')].some((t) => /<\/?[gx]\d*/.test(t.textContent)));
    assert.equal(leaked, false);
    const links = await page.evaluate(() => document.querySelector('p tx-t a')?.getAttribute('href'));
    assert.ok(links, '最终译文里的链接应还原');
    await page.waitForTimeout(600);
    const log = await sw.evaluate(() => chrome.storage.local.get('ui.perfLog'));
    const e = (log['ui.perfLog'] || [])[0];
    assert.ok(e && e.finalMs > 0 && e.segments > 0 && e.streamed > 0, '应记下一条首屏耗时：' + JSON.stringify(e));
    await page.locator('tx-ui .ball').click();
    await page.waitForTimeout(150);
    await setUi({ mode: 'combined' });
  });

  console.log('外观');
  await step('深色网页上悬浮球和小窗自动用深色，译文样式改了立即生效', async () => {
    const dp = await ctx.newPage();
    dp.on('pageerror', (e) => errors.push(e.message));
    await dp.goto(`${base}/dark.html`);
    await dp.waitForSelector('tx-ui', { state: 'attached' });
    await dp.waitForTimeout(300);
    const theme = await dp.evaluate(() => document.querySelector('tx-ui').shadowRoot.querySelector('.layer').dataset.theme);
    assert.equal(theme, 'dark');
    await dp.locator('tx-ui .ball').click();
    await dp.waitForSelector('tx-t[data-tx-stage="final"]', { timeout: 6000 });
    await setUi({ txStyle: 'tint' });
    await dp.waitForFunction(() => document.documentElement.dataset.txStyle === 'tint', null, { timeout: 3000 });
    await setUi({ txStyle: 'plain' });
    // 小窗只留高频项：样式和「只翻正文」都搬到了设置页
    await dp.locator('tx-ui .ball').hover();
    await dp.waitForTimeout(500);
    assert.equal(await dp.locator('tx-ui .menu .seg5').count(), 0);
    // 翻译过程中状态快照不断到来，引擎下拉框不能被重建（否则点开就收起）
    const same = await dp.evaluate(async () => {
      const root = document.querySelector('tx-ui').shadowRoot;
      const before = root.querySelector('.menu select.sel');
      await new Promise((r) => setTimeout(r, 2500));
      return !!before && before === root.querySelector('.menu select.sel') && before.isConnected;
    });
    assert.ok(same, '引擎下拉框在快照更新后被替换了');
    await dp.close();
  });

  await step('个性化：主题色、悬浮球样式 / 大小 / 不用时的透明度立即生效', async () => {
    const ap = await ctx.newPage();
    ap.on('pageerror', (e) => errors.push(e.message));
    await ap.goto(`${base}/breaks.html`);
    await ap.waitForSelector('tx-ui', { state: 'attached' });
    await setUi({ appearance: { accent: 'pine', ball: 'accent', ballSize: 'l', idleOpacity: 0.6 } });
    await ap.waitForTimeout(500);
    await ap.mouse.move(5, 5);
    const st = await ap.evaluate(() => {
      const b = document.querySelector('tx-ui').shadowRoot.querySelector('.ball');
      const cs = getComputedStyle(b);
      return { bg: cs.backgroundColor, w: Math.round(b.getBoundingClientRect().width), op: cs.opacity };
    });
    assert.equal(st.bg, 'rgb(47, 122, 106)', '主题色实心球的颜色不对');
    assert.ok(st.w >= 46 && st.w <= 50, `大号悬浮球尺寸 ${st.w}`);
    assert.equal(st.op, '0.6');
    // 半透明球翻译后（.on）图标不能变成白色，否则白底网页上看不见
    await setUi({ appearance: { accent: 'mist', ball: 'glass', ballSize: 'm', idleOpacity: 1 } });
    await ap.waitForTimeout(300);
    await ap.locator('tx-ui .ball').click();
    await ap.mouse.move(5, 5);
    await ap.waitForFunction(() => document.querySelector('tx-ui').shadowRoot.querySelector('.ball.on'), null, { timeout: 6000 });
    const gl = await ap.evaluate(() => {
      const b = document.querySelector('tx-ui').shadowRoot.querySelector('.ball');
      const rgb = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ink = lum(rgb(getComputedStyle(b).color));
      return { color: getComputedStyle(b).color, ratio: (1 + 0.05) / (ink + 0.05) };
    });
    assert.ok(gl.ratio >= 3, `半透明球图标在白底上对比度只有 ${gl.ratio.toFixed(2)}（${gl.color}）`);
    await setUi({});
    await ap.close();
  });

  console.log('只翻正文与悬停联动');
  await step('只翻正文：跳过导航、侧栏、页脚和评论区，文章目录照翻；关掉后整页都翻', async () => {
    const bp = await ctx.newPage();
    bp.on('pageerror', (e) => errors.push(e.message));
    await bp.goto(`${base}/blog.html`);
    await bp.waitForSelector('tx-ui', { state: 'attached' });
    await bp.locator('tx-ui .ball').click();
    await bp.mouse.move(5, 5);
    await bp.waitForFunction(() => document.querySelectorAll('article tx-t[data-tx-stage="final"]').length >= 4, null, { timeout: 6000 });
    const outside = await bp.evaluate(() => [...document.querySelectorAll('tx-t')].filter((t) => t.closest('nav:not(.toc), aside, footer, #comments, .share')).length);
    assert.equal(outside, 0);
    // 文章目录（链接都指向本页小标题，例如维基百科左栏）不算导航，照常翻译
    await bp.waitForFunction(() => document.querySelectorAll('nav.toc tx-t').length >= 3, null, { timeout: 6000 });
    await setUi({ mainOnly: false });
    await bp.waitForFunction(() => document.querySelectorAll('tx-t').length >= 9, null, { timeout: 6000 });
    await setUi({ mainOnly: true });
    await bp.close();
  });
  await step('完整选中一句原文：另一边连续高亮对应的整句，淡底色只铺这一句', async () => {
    const sp = await ctx.newPage();
    sp.on('pageerror', (e) => errors.push(e.message));
    await sp.goto(`${base}/sentences.html`);
    await sp.waitForSelector('tx-ui', { state: 'attached' });
    await sp.locator('tx-ui .ball').click();
    await sp.mouse.move(5, 5);
    await sp.waitForSelector('#s tx-t[data-tx-stage="final"]', { timeout: 8000 });
    await sp.waitForTimeout(400);
    const res = await sp.evaluate(async () => {
      const t = document.querySelector('#s').firstChild;
      const i = t.data.indexOf('The second');
      const j = t.data.indexOf('The third');
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, j);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      await new Promise((ok) => setTimeout(ok, 700));
      const strong = [...(CSS.highlights.get('tx-link') ?? [])].map((x) => x.toString());
      const soft = [...(CSS.highlights.get('tx-link-soft') ?? [])].map((x) => x.toString());
      const tx = document.querySelector('#s tx-t').textContent;
      return { strong, soft, tx };
    });
    const second = res.tx.split(/(?<=[。！？.!?])/)[1];
    assert.ok(second, res.tx);
    assert.equal(res.strong.length, 1, `整句应连续高亮：${JSON.stringify(res.strong)}`);
    assert.equal(res.strong[0].trim(), second.trim());
    assert.equal(res.soft.join('').trim(), second.trim(), '淡底色应只铺选中的这一句');
    await sp.close();
  });

  await step('按住 Alt 把鼠标停在词上，两边对应的词一起高亮，松开就消失', async () => {
    const p = page.locator('p').first();
    await page.locator('tx-ui .ball').click();
    await page.mouse.move(5, 5);
    await page.waitForSelector('p tx-t[data-tx-stage="final"]', { timeout: 6000 });
    const box = await p.boundingBox();
    await page.keyboard.down('Alt');
    await page.mouse.move(box.x + 12, box.y + 10);
    await page.waitForFunction(() => (CSS.highlights.get('tx-link')?.size ?? 0) >= 2, null, { timeout: 3000 });
    await page.keyboard.up('Alt');
    await page.waitForFunction(() => (CSS.highlights.get('tx-link')?.size ?? 0) === 0, null, { timeout: 2000 });
    await page.locator('tx-ui .ball').click();
    await page.waitForTimeout(150);
  });

  console.log('划词');
  await step('双击单词出现小圆点，点开显示译文', async () => {
    await page.locator('h1').dblclick({ position: { x: 300, y: 25 } });
    await page.locator('tx-ui .dot').click();
    await page.waitForFunction(() => {
      const t = document.querySelector('tx-ui').shadowRoot.querySelector('.pop .tgt');
      return t && t.dataset.stage === 'final' && t.textContent.length > 0;
    }, null, { timeout: 6000 });
  });

  console.log('划词小窗与输入框翻译');
  const shadow = (pg, fn) => pg.evaluate(fn);
  const selectText = (pg, sel) => pg.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    const b = el.getBoundingClientRect();
    return { x: b.right - 5, y: b.bottom - 4 };
  }, sel);
  const openPopFor = async (pg, sel) => {
    await selectText(pg, sel);
    // 真点一下会把选区收起来：直接发一个 mouseup，和用户拖选结束时一样
    await pg.evaluate(() => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })));
    await pg.waitForFunction(() => document.querySelector('tx-ui').shadowRoot.querySelector('.dot')?.style.display !== 'none', null, { timeout: 3000 });
    await pg.locator('tx-ui .dot').click();
  };
  await step('划词小窗是毛玻璃；固定后可以同时开好几个；顶上能改语言（存进设置）', async () => {
    const ip = await ctx.newPage();
    ip.on('pageerror', (e) => errors.push(e.message));
    await ip.goto(`${base}/inputs.html`);
    await ip.waitForSelector('tx-ui', { state: 'attached' });
    await openPopFor(ip, '#en');
    await ip.waitForFunction(() => document.querySelector('tx-ui').shadowRoot.querySelector('.pop .tgt')?.dataset.stage === 'final', null, { timeout: 6000 });
    const look = await shadow(ip, () => {
      const p = document.querySelector('tx-ui').shadowRoot.querySelector('.pop');
      const cs = getComputedStyle(p);
      return { blur: cs.backdropFilter || cs.webkitBackdropFilter, op: cs.opacity };
    });
    assert.ok(/blur/.test(look.blur), '小窗没有毛玻璃：' + look.blur);
    assert.equal(look.op, '1', '小窗整体半透明会让背后的字透出来');
    await ip.locator('tx-ui .pop [data-act="pin"]').click();
    // 再划一段：第一个固定的小窗留着，新开一个
    await openPopFor(ip, '#zh');
    await ip.waitForFunction(() => document.querySelector('tx-ui').shadowRoot.querySelectorAll('.pop').length === 2, null, { timeout: 3000 });
    // 选中的已经是中文：自动翻成「输入框翻译」的语言（英语）
    await ip.waitForFunction(() => [...document.querySelector('tx-ui').shadowRoot.querySelectorAll('.pop:not(.pinned) .tgt')].some((t) => t.dataset.stage === 'final' && t.textContent.startsWith('[en]')), null, { timeout: 6000 });
    await ip.locator('tx-ui .pop:not(.pinned) [data-act="pin"]').click();
    await openPopFor(ip, 'h1');
    await ip.waitForFunction(() => document.querySelector('tx-ui').shadowRoot.querySelectorAll('.pop').length === 3, null, { timeout: 3000 });
    // 点页面别处：只关没固定的那个
    await ip.mouse.click(20, 860);
    await ip.waitForFunction(() => document.querySelector('tx-ui').shadowRoot.querySelectorAll('.pop').length === 2, null, { timeout: 3000 });
    // 在固定的第一个小窗里把原文语言改成瑞典语、目标改成日语：存进设置，并按新语言重翻
    const first = ip.locator('tx-ui .pop.pinned').first();
    await first.locator('.langs select').first().selectOption('sv');
    await first.locator('.langs select').last().selectOption('ja');
    await ip.waitForFunction(() => document.querySelector('tx-ui').shadowRoot.querySelector('.pop.pinned .tgt')?.textContent.startsWith('[ja]'), null, { timeout: 6000 });
    const got = await sw.evaluate(async () => ({ ui: (await chrome.storage.local.get('settings.ui'))['settings.ui'], job: (await chrome.storage.local.get('mock.lastJob'))['mock.lastJob'] }));
    assert.equal(got.ui.sourceLang, 'sv');
    assert.equal(got.ui.targetLang, 'ja');
    assert.equal(got.job.sourceLang, 'sv');
    await setUi({});
    await ip.close();
  });
  await step('输入框翻译：快捷键、输入框小圆球、连按三下空格都能翻成英语，Ctrl+Z 可撤销；密码框不出现', async () => {
    await setUi({ input: { enabled: true, targetLang: 'en', mode: 'accurate', ball: true, shortcut: 'Alt+T', tripleSpace: true, hiddenOn: [] } });
    const ip = await ctx.newPage();
    ip.on('pageerror', (e) => errors.push(e.message));
    await ip.goto(`${base}/inputs.html`);
    await ip.waitForSelector('tx-ui', { state: 'attached' });
    const ballOn = () => ip.evaluate(() => document.querySelector('tx-ui').shadowRoot.querySelector('.ib').classList.contains('on'));
    // 多行输入框 + 快捷键（逐行翻译，保留换行）
    await ip.locator('#ta').click();
    await ip.keyboard.type('你好，世界');
    await ip.keyboard.press('Enter');
    await ip.keyboard.type('谢谢你的建议');
    assert.ok(await ballOn(), '光标在输入框里时应出现小圆球');
    await ip.keyboard.press('Alt+t');
    await ip.waitForFunction(() => document.querySelector('#ta').value.startsWith('[en]'), null, { timeout: 6000 });
    assert.equal(await ip.inputValue('#ta'), '[en] 你好，世界\n[en] 谢谢你的建议');
    await ip.keyboard.press('Control+z');
    assert.equal(await ip.inputValue('#ta'), '你好，世界\n谢谢你的建议', 'Ctrl+Z 没有撤回');
    // 鼠标停在小圆球上，面板展开时小圆球本身不能挪位置
    const goBox = () => ip.evaluate(() => { const r = document.querySelector('tx-ui').shadowRoot.querySelector('.ib .go').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; });
    const before = await goBox();
    await ip.mouse.move(before[0] + 12, before[1] + 12);
    await ip.waitForFunction(() => document.querySelector('tx-ui').shadowRoot.querySelector('.ib').classList.contains('open'), null, { timeout: 3000 });
    assert.deepEqual(await goBox(), before, '面板展开后小圆球被挤动了');
    await ip.mouse.move(5, 5);
    // 单行输入框 + 点小圆球
    await ip.locator('#one').click();
    await ip.keyboard.type('早上好');
    await ip.locator('tx-ui .ib .go').click();
    await ip.waitForFunction(() => document.querySelector('#one').value === '[en] 早上好', null, { timeout: 6000 });
    // 小圆球不抢焦点：点完光标还在输入框里
    assert.equal(await ip.evaluate(() => document.activeElement?.id), 'one');
    // 可编辑区域 + 连按三下空格（多出来的空格去掉）
    await ip.locator('#ce').click();
    await ip.keyboard.type('辛苦了');
    await ip.keyboard.press('Space');
    await ip.keyboard.press('Space');
    await ip.keyboard.press('Space');
    await ip.waitForFunction(() => document.querySelector('#ce').innerText.trim() === '[en] 辛苦了', null, { timeout: 6000 });
    // 密码框不出现小圆球
    await ip.locator('#pw').click();
    await ip.waitForTimeout(250);
    assert.equal(await ballOn(), false, '密码框里不该出现小圆球');
    await setUi({});
    await ip.close();
  });

  console.log('设置页');
  await step('服务状态页能收到快照并画出额度条', async () => {
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html#status`);
    await opt.waitForSelector('table tbody tr', { timeout: 6000 });
    // 「检测」按了要有反应：按钮变成「检测中…」，结果写在这一行下面
    const row = opt.locator('table tbody tr', { hasText: '微软' }).first();
    await row.locator('button', { hasText: '检测' }).click();
    await opt.waitForFunction(() => [...document.querySelectorAll('table tbody tr')].some((r) => r.textContent.includes('微软') && r.querySelector('.chk.ok') && /\d+ ms/.test(r.querySelector('.chk.ok').textContent)), null, { timeout: 6000 });
    assert.ok(/本机|账户/.test(await opt.locator('.quota-note').first().innerText()), '额度来源说明');
    await opt.locator('.head-acts button', { hasText: '全部检测' }).click();
    await opt.waitForFunction(() => [...document.querySelectorAll('.chk.ok')].length >= 3, null, { timeout: 8000 });
    await opt.close();
  });

  await step('添加服务：常用 OpenAI 兼容服务一键填好地址；本机模型可设开机自动启动', async () => {
    const opt = await ctx.newPage();
    opt.on('pageerror', (e) => errors.push(e.message));
    await opt.goto(`chrome-extension://${extId}/options.html#providers`);
    await opt.locator('.pv-add').click();
    await opt.locator('.presets .tpl', { hasText: 'DeepSeek' }).click();
    assert.equal(await opt.inputValue('.pv-card input[type="text"]'), 'DeepSeek');
    await opt.locator('.bar .btn.primary', { hasText: '添加' }).click();
    await opt.waitForFunction(() => [...document.querySelectorAll('.field input[type="url"]')].some((i) => i.value === 'https://api.deepseek.com/v1'), null, { timeout: 5000 });
    // 本机模型卡片
    await opt.locator('.lib-card .pv-item', { hasText: '本地模型' }).click();
    const sw2 = opt.locator('.local-card input.switch');
    await opt.waitForFunction(() => { const i = document.querySelector('.local-card input.switch'); return i && !i.disabled; }, null, { timeout: 5000 });
    await sw2.check();
    await opt.waitForFunction(() => /已设置/.test(document.querySelector('.local-card .hint')?.textContent || ''), null, { timeout: 5000 });
    await opt.close();
  });

  await step('新手指引：基础设置能保存；方案页按检测结果推荐；本地部署有位置和下载说明；教程页能直接填密钥添加服务', async () => {
    const opt = await ctx.newPage();
    opt.on('pageerror', (e) => errors.push(e.message));
    await opt.goto(`chrome-extension://${extId}/options.html#welcome`);
    await opt.waitForSelector('.gd-steps a[aria-current="step"]', { timeout: 6000 });
    assert.equal(await opt.locator('.gd-steps a').count(), 5);
    // ① 基础设置：改原文语言，存进设置
    await opt.selectOption('select[aria-label="原文语言"]', 'en');
    await opt.waitForFunction(async () => (await chrome.storage.local.get('settings.ui'))['settings.ui']?.sourceLang === 'en', null, { timeout: 3000 });
    await opt.selectOption('select[aria-label="原文语言"]', 'auto');
    // ② 方案
    await opt.locator('.gd-nav a.btn.primary').click();
    await opt.waitForSelector('.gd-opt', { timeout: 6000 });
    const grid = await opt.locator('.gd-grid').innerText();
    assert.ok(/本地大模型/.test(grid));
    // 浏览器内置翻译：分开说「浏览器支不支持 / 启用没有 / 语言包」，不再只凭「已启用」就说能用
    assert.ok(!/可以用，已启用/.test(grid) && /浏览器支持|不支持|暂时不能用/.test(grid), grid);
    assert.ok(/要不要部署本地模型/.test(await opt.locator('.gd-body').innerText()));
    // ③ 本地模型：目录结构、模型文件名、llama.cpp 文件按显卡切换
    await opt.goto(`chrome-extension://${extId}/options.html#welcome/local`);
    await opt.waitForSelector('.gd-tree', { timeout: 6000 });
    const tree = await opt.locator('.gd-tree').first().innerText();
    assert.ok(tree.includes('runtime') && tree.includes('Hy-MT2-1.8B-Q4_K_M.gguf') && tree.includes('llama-server.exe'), tree);
    await opt.selectOption('select[aria-label="选择显卡类型"]', 'nvidia');
    assert.ok(/cudart-llama-bin-win-cuda-13\.4-x64\.zip/.test(await opt.locator('.gd-st').innerText()));
    await opt.selectOption('select[aria-label="选择显卡类型"]', 'vulkan');
    assert.ok(/win-vulkan-x64\.zip/.test(await opt.locator('.gd-st').innerText()));
    await opt.locator('.gd-st button', { hasText: '检测并启用' }).click();
    await opt.waitForFunction(() => /已启用本地模型/.test(document.querySelector('.gd-st .ok')?.textContent || ''), null, { timeout: 5000 });
    assert.equal(await opt.locator('.local-card').count(), 1);
    // ④ 云端服务：列表 → 智谱教程 → 填密钥一键添加
    await opt.goto(`chrome-extension://${extId}/options.html#welcome/api`);
    await opt.waitForSelector('tr.pick', { timeout: 6000 });
    assert.ok((await opt.locator('tr.pick').count()) >= 6);
    await opt.locator('tr.pick', { hasText: '智谱' }).click();
    await opt.waitForSelector('#gd-form input[type="password"]', { timeout: 6000 });
    assert.ok((await opt.locator('ol.gd-st > li').count()) >= 3, '教程至少三步');
    assert.ok(await opt.locator('ol.gd-st a[href^="https://"]').count(), '教程里有具体页面的链接');
    await opt.fill('#gd-form input[type="password"]', 'sk-test');
    await opt.locator('#gd-form .btn.primary').click();
    await opt.waitForFunction(() => /可以用了/.test(document.querySelector('#gd-form [role="status"]')?.textContent || ''), null, { timeout: 6000 });
    // 同一页再改模型名保存：不用重填密钥（以前会被「先粘贴 API Key」拦住）
    await opt.evaluate(() => (document.querySelector('#gd-form [role="status"]').textContent = ''));
    await opt.fill('#gd-form input[type="text"]', 'glm-4.7-flash');
    await opt.locator('#gd-form .btn.primary').click();
    await opt.waitForFunction(() => /可以用了|先粘贴/.test(document.querySelector('#gd-form [role="status"]')?.textContent || ''), null, { timeout: 6000 });
    assert.match(await opt.locator('#gd-form [role="status"]').innerText(), /可以用了/, '第二次保存要求重填密钥');
    // 内置服务（微软）：在教程页直接填，密钥留空时不会清掉已保存的密钥
    await opt.goto(`chrome-extension://${extId}/options.html#welcome/api/microsoft`);
    await opt.waitForSelector('#gd-form .btn.primary', { timeout: 6000 });
    await opt.locator('#gd-form .btn.primary').click();
    await opt.waitForFunction(() => /可以用了/.test(document.querySelector('#gd-form [role="status"]')?.textContent || ''), null, { timeout: 6000 });
    // 翻译服务页里能看到刚加的智谱，并且有「详细教程」链接回来
    await opt.goto(`chrome-extension://${extId}/options.html#providers`);
    await opt.locator('.lib-card .pv-item', { hasText: '智谱' }).click();
    await opt.waitForSelector('.pv-meta a[href="#welcome/api/zhipu"]', { timeout: 5000 });
    // ⑤ 试译并完成
    await opt.goto(`chrome-extension://${extId}/options.html#welcome/done`);
    await opt.waitForSelector('.try .btn.primary', { timeout: 6000 });
    // 已启用的服务逐个检测，标出 ✓ / ✕
    await opt.waitForFunction(() => [...document.querySelectorAll('.gd-pill')].some((p) => /✓/.test(p.textContent)), null, { timeout: 8000 });
    await opt.locator('.try .btn.primary').click();
    await opt.waitForFunction(() => /译文 ·/.test(document.querySelector('.try .out')?.textContent || ''), null, { timeout: 8000 });
    await opt.locator('.gd-nav .btn.primary', { hasText: '完成' }).click();
    await opt.waitForFunction(() => location.hash === '#general', null, { timeout: 3000 });
    await opt.close();
  });

  await step('翻译服务：从服务库拖进高速档 / 精确档，档之间拖动是挪过去，拖回服务库就拿出来（两档都不在就停用）；卡片上的「高速」「精确」也能切', async () => {
    const op = await ctx.newPage();
    op.on('pageerror', (e) => errors.push(e.message));
    await op.goto(`chrome-extension://${extId}/options.html#providers`);
    await op.waitForSelector('.lane[data-tier="fast"]', { timeout: 6000 });
    const lanes = () => op.evaluate(() => Object.fromEntries([...document.querySelectorAll('.lane')].map((l) => [l.dataset.tier, [...l.querySelectorAll('.chip-row .nm')].map((x) => x.textContent)])));
    const has = async (tier, name) => (await lanes())[tier].some((n) => n.includes(name));
    const until = (fn) => op.waitForFunction(fn, null, { timeout: 4000 });
    // Gemini 只在精确档：拖进高速档
    assert.ok(await has('accurate', 'Gemini') && !(await has('fast', 'Gemini')));
    await op.locator('.lib-card', { hasText: 'Gemini' }).dragTo(op.locator('.lane[data-tier="fast"]'));
    await until(() => [...document.querySelectorAll('.lane[data-tier="fast"] .nm')].some((x) => x.textContent.includes('Gemini')));
    assert.ok(await has('accurate', 'Gemini'), '从库里拖进来是「加」，原来那一档应该还在');
    // 高速档 → 精确档：挪（Gemini 已经在精确档，所以只是从高速档出来）
    await op.locator('.lane[data-tier="fast"] .chip-row', { hasText: 'Gemini' }).dragTo(op.locator('.lane[data-tier="accurate"]'));
    await until(() => ![...document.querySelectorAll('.lane[data-tier="fast"] .nm')].some((x) => x.textContent.includes('Gemini')));
    // 拖回服务库：从精确档拿出来 → 两档都不在 → 停用
    await op.locator('.lane[data-tier="accurate"] .chip-row', { hasText: 'Gemini' }).dragTo(op.locator('.lib .pv-group').first());
    await until(() => ![...document.querySelectorAll('.lane .nm')].some((x) => x.textContent.includes('Gemini')));
    assert.ok(await op.locator('.lib-card', { hasText: 'Gemini' }).locator('.pv-item.off').count(), '两档都不在应停用');
    // 点卡片上的「精确」放回去
    await op.locator('.lib-card', { hasText: 'Gemini' }).locator('.tg', { hasText: '精确' }).click();
    await until(() => [...document.querySelectorAll('.lane[data-tier="accurate"] .nm')].some((x) => x.textContent.includes('Gemini')));
    // ✕ 从档里拿出、📌 置顶（只置顶一家）
    await op.locator('.lane[data-tier="accurate"] .chip-row', { hasText: 'Gemini' }).locator('.pin').click();
    assert.equal(await op.locator('.lane[data-tier="accurate"] .pin[aria-pressed="true"]').count(), 1);
    await op.close();
  });

  await step('浏览器内置翻译：一开始没启用、语言包没下载，在新手指引和「翻译服务」里都能直接下载，下好自动启用', async () => {
    // 假的 Translator 接口：语言包「可下载」，create 时报进度，下完变成「已下载」
    const fake = () => {
      // 按语言对记哪些下好了（存在 sessionStorage：页面重新加载后还在，模拟浏览器的语言包）
      const got = () => new Set(JSON.parse(sessionStorage.getItem('fakePacks') || '[]'));
      self.__packCreates = 0;
      self.Translator = {
        // 假定：日语 ↔ 泰语不支持，其他都能下
        availability: async ({ sourceLanguage: s, targetLanguage: t }) => ((s === 'ja' && t === 'th') || (s === 'th' && t === 'ja') ? 'unavailable' : got().has(`${s}>${t}`) ? 'available' : 'downloadable'),
        create: async ({ sourceLanguage: s, targetLanguage: t, monitor }) => {
          self.__packCreates++;
          const ev = new EventTarget();
          monitor?.(ev);
          for (const loaded of [0.3, 0.7, 1]) {
            await new Promise((r) => setTimeout(r, 60));
            ev.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded, total: 1 }));
          }
          sessionStorage.setItem('fakePacks', JSON.stringify([...got(), `${s}>${t}`]));
          return { destroy() {} };
        },
      };
    };
    const bp = await ctx.newPage();
    bp.on('pageerror', (e) => errors.push(e.message));
    await bp.addInitScript(fake);
    // 先把内置翻译关掉，模拟「一开始没开」
    await bp.goto(`chrome-extension://${extId}/options.html#providers`);
    await bp.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ rpc: 'providers:list', payload: undefined }, (res) => {
      const p = res.data.find((x) => x.kind === 'builtin');
      chrome.runtime.sendMessage({ rpc: 'providers:save', payload: { id: p.id, enabled: false, config: p.config } }, r);
    })));
    await bp.goto(`chrome-extension://${extId}/options.html#welcome/plan`);
    await bp.waitForSelector('.gd-opt .bp', { timeout: 6000 });
    const btn = bp.locator('.gd-opt .bp button', { hasText: '下载语言包' });
    await btn.waitFor({ timeout: 3000 });
    await btn.click();
    await bp.waitForFunction(() => /语言包已下载/.test(document.querySelector('.gd-opt .bp')?.textContent || ''), null, { timeout: 5000 });
    assert.equal(await bp.evaluate(() => self.__packCreates), 1);
    const enabledNow = await bp.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ rpc: 'providers:list', payload: undefined }, (res) => r(res.data.find((x) => x.kind === 'builtin').enabled))));
    assert.equal(enabledNow, true, '下好语言包后应自动启用内置翻译');
    // 「翻译服务」里内置翻译的详情页也有语言包卡片
    await bp.goto(`chrome-extension://${extId}/options.html#providers`);
    await bp.locator('.lib-card .pv-item', { hasText: /本地翻译|内置翻译/ }).first().click();
    await bp.waitForFunction(() => /语言包/.test(document.querySelector('main')?.innerText || '') && !!document.querySelector('.pv-card .bp'), null, { timeout: 5000 });
    // 其他语言：两个下拉框，选了原文，译文的选项后面标出状态，不支持的不能选
    await bp.locator('.pv-card .bp a.more').click();
    await bp.selectOption('.pv-card .bp select[aria-label="原文语言"]', 'ja');
    await bp.waitForFunction(() => { const o = document.querySelector('.pv-card .bp select[aria-label="译文语言"] option[value="th"]'); return o && o.disabled && /不支持/.test(o.textContent); }, null, { timeout: 3000 });
    assert.ok(/已下载|可下载/.test(await bp.locator('.pv-card .bp select[aria-label="译文语言"] option[value="en"]').innerText()));
    // 第 46.2 节：服务停用时在「其他语言」里换方向下载，下好后自动启用会重画详情页；新卡片要保留刚才选的方向和结果
    await bp.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ rpc: 'providers:list', payload: undefined }, (res) => {
      const p = res.data.find((x) => x.kind === 'builtin');
      chrome.runtime.sendMessage({ rpc: 'providers:save', payload: { id: p.id, enabled: false, config: p.config } }, r);
    })));
    await bp.reload();
    await bp.locator('.lib-card .pv-item', { hasText: /本地翻译|内置翻译/ }).first().click();
    await bp.waitForSelector('.pv-card .bp a.more', { timeout: 5000 });
    await bp.locator('.pv-card .bp a.more').click();
    await bp.selectOption('.pv-card .bp select[aria-label="原文语言"]', 'en');
    await bp.selectOption('.pv-card .bp select[aria-label="译文语言"]', 'ko');
    await bp.locator('.pv-card .bp button', { hasText: '下载语言包' }).click();
    await bp.waitForFunction(() => /한국어[^\n]*语言包已下载，浏览器内置翻译已启用/.test(document.querySelector('.pv-card .bp')?.textContent || ''), null, { timeout: 6000 });
    await bp.waitForTimeout(600); // 等详情页重画完
    assert.equal(await bp.inputValue('.pv-card .bp select[aria-label="译文语言"]'), 'ko', '重画后方向跳回了默认');
    assert.ok(/语言包已下载/.test(await bp.locator('.pv-card .bp').innerText()), '重画后看不出刚才下好了');
    await bp.close();
  });

  await step('键盘：悬浮球按方向键展开小窗，↑↓ 换控件、←→ 换选项，Esc 收起并回到圆球', async () => {
    const kp = await ctx.newPage();
    kp.on('pageerror', (e) => errors.push(e.message));
    await kp.goto(`${base}/article.html`);
    await kp.waitForSelector('tx-ui', { state: 'attached' });
    const sr = 'document.querySelector("tx-ui").shadowRoot';
    await kp.locator('tx-ui .ball').focus();
    await kp.keyboard.press('ArrowLeft');
    await kp.waitForFunction(`${sr}.querySelector('.ball-wrap').classList.contains('open')`, null, { timeout: 3000 });
    const active = () => kp.evaluate(() => { const a = document.querySelector('tx-ui').shadowRoot.activeElement; return a ? a.outerHTML.slice(0, 80) : null; });
    const first = await active();
    assert.ok(first, '焦点进了小窗');
    await kp.keyboard.press('ArrowDown');
    assert.notEqual(await active(), first, '↓ 换到下一个控件');
    const pressed = () => kp.evaluate(() => document.querySelector('tx-ui').shadowRoot.querySelector('.menu .seg button[aria-pressed="true"]')?.dataset.v);
    const before = await pressed();
    await kp.evaluate(() => document.querySelector('tx-ui').shadowRoot.querySelector('.menu .seg button[aria-pressed="true"]').focus());
    await kp.keyboard.press('ArrowRight');
    await kp.waitForFunction((b) => document.querySelector('tx-ui').shadowRoot.querySelector('.menu .seg button[aria-pressed="true"]')?.dataset.v !== b, before, { timeout: 3000 });
    await kp.waitForTimeout(200);
    await kp.keyboard.press('ArrowLeft');
    await kp.waitForFunction((b) => document.querySelector('tx-ui').shadowRoot.querySelector('.menu .seg button[aria-pressed="true"]')?.dataset.v === b, before, { timeout: 3000 });
    await kp.keyboard.press('Escape');
    await kp.waitForFunction(`!${sr}.querySelector('.ball-wrap').classList.contains('open')`, null, { timeout: 3000 });
    assert.ok(await kp.evaluate(() => document.querySelector('tx-ui').shadowRoot.activeElement?.classList.contains('ball')), 'Esc 后焦点回到圆球');
    await kp.close();
  });

  await step('输入框小圆球可以拖动：拖完不翻译、焦点留在输入框，按网站记住位置，刷新后还在，面板里「复位」回到默认位置', async () => {
    await setUi({ onboarded: true, input: { enabled: true, targetLang: 'en', mode: 'accurate', ball: true, shortcut: 'Alt+T', tripleSpace: false, hiddenOn: [] } });
    await sw.evaluate(() => chrome.storage.local.remove('ui.inputBall'));
    const dp = await ctx.newPage();
    dp.on('pageerror', (e) => errors.push(e.message));
    await dp.goto(`${base}/inputs.html`);
    await dp.waitForSelector('tx-ui', { state: 'attached' });
    await dp.locator('#ta').click();
    await dp.keyboard.type('拖动测试');
    const go = () => dp.evaluate(() => { const r = document.querySelector('tx-ui').shadowRoot.querySelector('.ib .go').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; });
    const before = await go();
    await dp.mouse.move(before.x + 12, before.y + 12);
    await dp.mouse.down();
    await dp.mouse.move(before.x - 30, before.y - 10, { steps: 4 });
    await dp.mouse.move(before.x - 68, before.y - 18, { steps: 4 });
    await dp.mouse.up();
    const after = await go();
    assert.ok(Math.abs(after.x - (before.x - 80)) <= 2 && Math.abs(after.y - (before.y - 30)) <= 2, `小圆球没跟着拖：${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    await dp.waitForTimeout(300);
    assert.equal(await dp.inputValue('#ta'), '拖动测试', '拖完不应该翻译');
    assert.equal(await dp.evaluate(() => document.activeElement?.id), 'ta', '拖动后焦点应留在输入框');
    const saved = await sw.evaluate(() => chrome.storage.local.get('ui.inputBall'));
    assert.deepEqual(saved['ui.inputBall']?.['127.0.0.1'], { dx: -80, dy: -30 });
    // 刷新后还在拖过的位置
    await dp.reload();
    await dp.waitForSelector('tx-ui', { state: 'attached' });
    await dp.locator('#ta').click();
    await dp.waitForFunction((a) => { const r = document.querySelector('tx-ui').shadowRoot.querySelector('.ib .go').getBoundingClientRect(); return Math.abs(r.x - a.x) <= 2 && Math.abs(r.y - a.y) <= 2; }, after, { timeout: 3000 });
    // 没拖时点一下照常翻译
    await dp.keyboard.type('你好');
    await dp.locator('tx-ui .ib .go').click();
    await dp.waitForFunction(() => document.querySelector('#ta').value.startsWith('[en]'), null, { timeout: 6000 });
    // 面板里「复位」
    await dp.keyboard.press('Alt+Shift+T');
    await dp.locator('tx-ui .ib .panel button', { hasText: '复位' }).click();
    const reset = await go();
    assert.ok(Math.abs(reset.x - before.x) <= 2 && Math.abs(reset.y - before.y) <= 2, '复位后应回到默认位置');
    await dp.waitForTimeout(200);
    const cleared = await sw.evaluate(() => chrome.storage.local.get('ui.inputBall'));
    assert.equal(cleared['ui.inputBall']?.['127.0.0.1'], undefined, '复位后应删掉记住的位置');
    await dp.close();
  });

  await step('键盘：光标在译文里按 Shift+F10 打开段落工具条，←→ 换按钮、Esc 收起；输入框里 Alt+Shift+T 打开小圆球面板、Esc 回到输入框', async () => {
    const kp = await ctx.newPage();
    kp.on('pageerror', (e) => errors.push(e.message));
    await kp.goto(`${base}/article.html`);
    await kp.waitForSelector('tx-ui', { state: 'attached' });
    await kp.locator('tx-ui .ball').click();
    await kp.mouse.move(5, 5);
    await kp.waitForFunction(() => document.querySelectorAll('tx-t[data-tx-stage="final"]').length >= 3, null, { timeout: 8000 });
    // 把光标放进第一段译文里（键盘用户用光标浏览 F7 也是这样）
    await kp.evaluate(() => { const t = document.querySelector('p tx-t'); getSelection().collapse(t.firstChild || t, 1); });
    await kp.keyboard.press('Shift+F10');
    await kp.waitForSelector('tx-ui .ptb.on', { timeout: 3000 });
    const label = () => kp.evaluate(() => document.querySelector('tx-ui').shadowRoot.activeElement?.getAttribute('aria-label'));
    const first = await label();
    assert.ok(first, '焦点进了工具条');
    await kp.keyboard.press('ArrowRight');
    const second = await label();
    assert.notEqual(second, first);
    // 「换一家」：Enter 打开菜单，焦点进菜单，Esc 回到按钮
    await kp.keyboard.press('Enter');
    await kp.waitForSelector('tx-ui .engs.on', { timeout: 3000 });
    await kp.waitForFunction(() => document.querySelector('tx-ui').shadowRoot.activeElement?.getAttribute('role') === 'menuitem', null, { timeout: 3000 });
    await kp.keyboard.press('Escape');
    assert.equal(await label(), second);
    await kp.keyboard.press('Escape');
    await kp.waitForFunction(() => !document.querySelector('tx-ui .ptb.on') && !document.querySelector('tx-ui').shadowRoot.querySelector('.ptb.on'), null, { timeout: 3000 });
    assert.ok(await kp.evaluate(() => !!getSelection().anchorNode?.parentElement?.closest('tx-t') || getSelection().anchorNode?.nodeName === 'TX-T'), 'Esc 后光标回到译文');
    // 输入框小圆球的面板
    await setUi({ input: { enabled: true, targetLang: 'en', mode: 'accurate', ball: true, shortcut: 'Alt+T', tripleSpace: false, hiddenOn: [] } });
    await kp.goto(`${base}/inputs.html`);
    await kp.waitForSelector('tx-ui', { state: 'attached' });
    await kp.locator('#ta').click();
    await kp.keyboard.press('Alt+Shift+T');
    await kp.waitForFunction(() => { const r = document.querySelector('tx-ui').shadowRoot; return r.querySelector('.ib').classList.contains('open') && r.activeElement?.tagName === 'SELECT'; }, null, { timeout: 3000 });
    await kp.keyboard.press('ArrowRight');
    assert.equal(await kp.evaluate(() => document.querySelector('tx-ui').shadowRoot.activeElement?.tagName), 'BUTTON');
    await kp.keyboard.press('Escape');
    await kp.waitForFunction(() => document.activeElement?.id === 'ta' && !document.querySelector('tx-ui').shadowRoot.querySelector('.ib').classList.contains('open'), null, { timeout: 3000 });
    await kp.close();
  });

  await step('英文界面：界面语言选 English 后，悬浮球、小窗和设置页都是英文', async () => {
    const setLang = (uiLang) => sw.evaluate(async (l) => { const s = (await chrome.storage.local.get('settings.ui'))['settings.ui'] || {}; await chrome.storage.local.set({ 'settings.ui': { ...s, uiLang: l } }); }, uiLang);
    await setLang('en');
    const ep = await ctx.newPage();
    ep.on('pageerror', (e) => errors.push(e.message));
    try {
      await ep.goto(`${base}/article.html`);
      await ep.waitForSelector('tx-ui', { state: 'attached' });
      assert.equal(await ep.locator('tx-ui .ball').getAttribute('aria-label'), 'Translate page');
      await ep.locator('tx-ui .ball').hover();
      await ep.waitForFunction(() => document.querySelector('tx-ui').shadowRoot.querySelector('.ball-wrap').classList.contains('open'), null, { timeout: 3000 });
      const menu = await ep.locator('tx-ui .menu').innerText();
      assert.ok(/Mode/.test(menu) && /Display/.test(menu), menu);
      // 服务名是数据（演示后端里是中文），只检查界面文字
      for (const zh of ['模式', '显示', '免费额度', '在本站隐藏', '翻译本页', '自动']) assert.ok(!menu.includes(zh), `小窗里还有中文「${zh}」`);
      await ep.goto(`chrome-extension://${extId}/options.html#general`);
      await ep.waitForSelector('.nav a');
      assert.equal(await ep.locator('.nav a').nth(1).innerText(), 'Settings');
      const main = await ep.locator('main').innerText();
      assert.ok(/Interface language/.test(main) && /Target language/.test(main), main.slice(0, 300));
      assert.ok((await ep.locator('main select').nth(1).innerText()).includes('Deutsch (German)'));
      // 其他几页也是英文
      for (const [hash, want] of [['welcome', 'Get started'], ['welcome/local', 'Deploy the local model'], ['welcome/api/microsoft', 'Create a “Translator” resource'], ['providers', 'Services'], ['status', 'Status'], ['advanced', 'Site rules']]) {
        await ep.goto(`chrome-extension://${extId}/options.html#${hash}`);
        await ep.waitForFunction((w) => document.querySelector('main')?.innerText.includes(w), want, { timeout: 6000 }).catch(() => {});
        const text = await ep.locator('main').innerText();
        assert.ok(text.includes(want), `#${hash} 没有「${want}」：` + text.slice(0, 200));
        // 界面文字里不该再有大段中文（服务名、后端返回的字段名除外）
        const zhLines = text.split('\n').filter((l) => /[\u4e00-\u9fff]{6,}/.test(l));
        assert.ok(zhLines.length <= 6, `#${hash} 还有中文：` + zhLines.slice(0, 8).join(' | '));
      }
    } finally {
      await setLang('auto');
      await ep.close();
    }
  });

  await step('没有页面脚本错误', async () => assert.deepEqual(errors, []));
} finally {
  await ctx.close();
  server.close();
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
