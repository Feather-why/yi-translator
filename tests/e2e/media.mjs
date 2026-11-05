/**
 * 媒体功能的端到端测试：图片翻译覆盖层、PDF 双栏阅读器和动态播放器。
 *
 *   node tests/e2e/build-ui.mjs && EXT_DIR=.output/ui-test node tests/e2e/media.mjs
 *
 * 需要后端支持 B5（backend:capabilities.media）。真实后端第一次做 OCR 要下载 PP-OCRv5 模型，
 * 所以超时设得比较长。假后端构建允许在本机夹具测试 YouTube 字幕。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { checkPlayerUpdates } from './player-updates.mjs';
import { checkImageGallery } from './image-gallery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// 默认用 build-ui.mjs 的假后端构建；没有就退回正式构建
const extDir = path.resolve(process.env.EXT_DIR || [path.join(here, '../../.output/ui-test'), path.join(here, '../../.output/chrome-mv3')].find((d) => existsSync(d)) || '.output/ui-test');
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.pdf': 'application/pdf' };

const server = http.createServer(async (req, res) => {
  try {
    const name = path.basename(new URL(req.url, 'http://x').pathname) || 'image.html';
    const body = await readFile(path.join(here, 'fixtures', name));
    res.writeHead(200, { 'content-type': TYPES[path.extname(name)] ?? 'application/octet-stream' });
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
  viewport: { width: 1200, height: 820 },
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

  console.log('图片');
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/image.html`);
  await page.waitForSelector('tx-ui', { state: 'attached' });
  await step('鼠标移到大图上出现翻译按钮', async () => {
    await page.locator('#sign').hover({ position: { x: 300, y: 150 } });
    await page.waitForSelector('tx-ui .img-btn.on', { timeout: 3000 });
  });
  await step('图片入口给网页原有的右上角按钮留出点击位置', async () => {
    const b = await page.locator('tx-ui .img-btn').boundingBox();
    const native = await page.locator('#expand').boundingBox();
    assert.ok(b.x + b.width <= native.x || b.y >= native.y + native.height);
    await page.locator('#expand').click({ timeout: 2000 });
    assert.equal(await page.locator('#expand').getAttribute('data-clicked'), 'yes');
  });
  await step('拖动图片入口让出后来出现的按钮，松开不翻译，重新悬停和调整图片大小后仍在选定位置', async () => {
    const img = page.locator('#sign');
    const btn = page.locator('tx-ui .img-btn');
    await img.hover({ position: { x: 300, y: 150 } });
    await btn.hover();
    const b = await btn.boundingBox();
    const r = await img.boundingBox();
    const details = page.locator('#details');
    await details.evaluate(el => { el.hidden = false; });
    const overlaps = await page.evaluate(() => {
      const a = document.querySelector('#details').getBoundingClientRect();
      const b = document.querySelector('tx-ui').shadowRoot.querySelector('.img-btn').getBoundingClientRect();
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    });
    assert.ok(overlaps, '网页延迟显示的控件应和旧位置重合');
    await page.mouse.move(b.x + 10, b.y + 10);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width + 30, r.y + r.height + 30, { steps: 9 });
    await page.mouse.up();
    assert.equal(await page.locator('tx-ocr').count(), 0, '松开拖动不应开始识别');
    await details.click({ timeout: 1500 });
    assert.equal(await details.getAttribute('data-clicked'), 'yes');
    await page.mouse.move(1, 1);
    await page.waitForSelector('tx-ui .img-btn.on', { state: 'detached' });
    await img.hover({ position: { x: 300, y: 150 } });
    const atBottomRight = () => page.waitForFunction(() => {
      const r = document.querySelector('#sign').getBoundingClientRect();
      const btn = document.querySelector('tx-ui').shadowRoot.querySelector('.img-btn.on');
      if (!btn) return false;
      const b = btn.getBoundingClientRect();
      return Math.abs(r.right - b.right - 8) <= 1 && Math.abs(Math.min(innerHeight, r.bottom) - b.bottom - 8) <= 1;
    }, null, { timeout: 2000 });
    await atBottomRight();
    await img.evaluate(el => { el.style.width = '560px'; });
    await atBottomRight();
    await img.evaluate(el => { el.style.width = ''; });
    await atBottomRight();
  });
  await step('点击后图片上出现译文覆盖层，且不改变页面排版', async () => {
    const before = await page.evaluate(() => document.body.scrollHeight);
    await page.locator('tx-ui .img-btn').click();
    await page.waitForFunction(() => [...(document.querySelector('tx-ocr')?.shadowRoot?.querySelectorAll('.p') ?? [])].some((p) => p.dataset.stage === 'final'), null, { timeout: 180000 });
    assert.equal(await page.evaluate(() => document.body.scrollHeight), before);
    const ov = await page.evaluate(() => {
      const o = document.querySelector('tx-ocr').getBoundingClientRect();
      const i = document.querySelector('#sign').getBoundingClientRect();
      return [o.left - i.left, o.top - i.top, o.width - i.width, o.height - i.height].map(Math.round);
    });
    assert.deepEqual(ov, [0, 0, 0, 0], '覆盖层没有对齐图片');
  });
  await step('再点一次切回原图', async () => {
    await page.locator('#sign').hover({ position: { x: 300, y: 150 } });
    await page.locator('tx-ui .img-btn').click();
    assert.equal(await page.evaluate(() => document.querySelector('tx-ocr').style.display), 'none');
  });

  await step('网页缩放（html zoom 125% / 80%）、图片被 transform 缩小时，按钮和覆盖层都对得上', async () => {
    for (const z of ['1.25', '0.8']) {
      const zp = await ctx.newPage();
      zp.on('pageerror', (e) => errors.push(e.message));
      await zp.goto(`${base}/image-zoom.html?z=${z}`);
      await zp.waitForSelector('tx-ui', { state: 'attached' });
      await zp.locator('#sign').hover();
      await zp.waitForSelector('tx-ui .img-btn.on', { timeout: 3000 });
      const b = await zp.evaluate(() => {
        const i = document.querySelector('#sign').getBoundingClientRect();
        const btn = document.querySelector('tx-ui').shadowRoot.querySelector('.img-btn').getBoundingClientRect();
        return { inside: btn.right <= i.right + 0.5 && btn.right >= i.right - 40 && btn.top >= i.top - 0.5 && btn.top <= i.top + 20, h: Math.round(btn.height) };
      });
      assert.ok(b.inside, `zoom ${z}：按钮不在图片右上角`);
      assert.equal(b.h, 28, `zoom ${z}：按钮被缩放了`);
      // 鼠标移到按钮上露出文字：按钮只往左伸，右边缘不动
      const right = () => zp.evaluate(() => Math.round(document.querySelector('tx-ui').shadowRoot.querySelector('.img-btn').getBoundingClientRect().right));
      const r0 = await right();
      await zp.locator('tx-ui .img-btn').hover();
      await zp.waitForTimeout(250);
      assert.ok(Math.abs((await right()) - r0) <= 1, `zoom ${z}：按钮展开时右边缘移动了`);
      await zp.locator('tx-ui .img-btn').click();
      // 进度文字（识别文字… / 翻译 k/n）不能把按钮挤成两行
      await zp.locator('#sign').hover();
      await zp.waitForTimeout(150);
      assert.equal(await zp.evaluate(() => Math.round(document.querySelector('tx-ui').shadowRoot.querySelector('.img-btn').getBoundingClientRect().height)), 28, `zoom ${z}：按钮文字折行了`);
      await zp.waitForFunction(() => [...(document.querySelector('tx-ocr')?.shadowRoot?.querySelectorAll('.p') ?? [])].some((p) => p.dataset.stage === 'final'), null, { timeout: 60000 });
      const ov = await zp.evaluate(() => {
        const o = document.querySelector('tx-ocr').getBoundingClientRect();
        const i = document.querySelector('#sign').getBoundingClientRect();
        return [o.left - i.left, o.top - i.top, o.width - i.width, o.height - i.height].map((v) => Math.abs(Math.round(v)));
      });
      assert.ok(ov.every((v) => v <= 1), `zoom ${z}：覆盖层偏了 ${ov}`);
      const ball = await zp.evaluate(() => Math.round(document.querySelector('tx-ui').shadowRoot.querySelector('.ball').getBoundingClientRect().width));
      assert.ok(ball >= 40 && ball <= 56, `zoom ${z}：悬浮球尺寸 ${ball}`);
      await zp.close();
    }
  });

  console.log('PDF');
  const pdf = await ctx.newPage();
  pdf.on('pageerror', (e) => errors.push(e.message));
  await pdf.goto(`chrome-extension://${extId}/pdf.html?url=${encodeURIComponent(base + '/test.pdf')}`);
  await step('渲染原页并显示译文页', async () => {
    await pdf.waitForFunction(() => document.querySelectorAll('.orig canvas.page').length >= 1 && document.querySelectorAll('.trans canvas.page').length >= 1 && [...document.querySelectorAll('.tp')].some((t) => t.dataset.stage === 'final'), null, { timeout: 120000 });
  });
  await step('参考文献和公式不翻译，原样保留', async () => {
    await pdf.goto(`chrome-extension://${extId}/pdf.html?url=${encodeURIComponent(base + '/paper.pdf')}`);
    await pdf.waitForFunction(() => [...document.querySelectorAll('.tp')].length >= 5 && [...document.querySelectorAll('.tp')].every((t) => t.dataset.stage !== 'pending'), null, { timeout: 120000 });
    const texts = await pdf.evaluate(() => [...document.querySelectorAll('.tp')].map((t) => t.textContent));
    assert.ok(!texts.some((t) => /\[1\]|\[2\]/.test(t)), '参考文献条目被翻译了');
    assert.ok(!texts.some((t) => /α|β|γ/.test(t)), '公式被翻译了');
  });
  await step('论文排版：目录逐条翻译、页码和点线不进模型；署名单独成行；正文不误居中；公式编号、表格格子不重叠；参考文献之后的附录照常翻译', async () => {
    const tp = await ctx.newPage();
    tp.on('pageerror', (e) => errors.push(e.message));
    await tp.goto(`chrome-extension://${extId}/pdf.html?url=${encodeURIComponent(base + '/thesis-mini.pdf')}`);
    const pageDone = async (n) => {
      await tp.evaluate((n) => document.querySelector(`.pg[data-page="${n}"]`).scrollIntoView(), n);
      await tp.waitForFunction((n) => {
        const tps = [...document.querySelectorAll(`.pg[data-page="${n}"] .tp`)];
        return tps.length > 0 && tps.every((t) => t.dataset.stage === 'final');
      }, n, { timeout: 60000 });
      return tp.evaluate((n) => [...document.querySelectorAll(`.pg[data-page="${n}"] .tp`)].map((t) => ({
        text: t.textContent, align: t.style.textAlign, nowrap: t.style.whiteSpace === 'nowrap', h: t.getBoundingClientRect().height, top: t.getBoundingClientRect().top,
      })), n);
    };
    await tp.waitForSelector('.pg[data-page="5"]');
    // 先直接跳到附录（不经过目录）：参考文献区的判断和滚动顺序无关
    const p5 = await pageDone(5);
    assert.ok(p5.length >= 3, '附录页没有翻译');
    const p4 = await pageDone(4);
    assert.equal(p4.length, 1, '参考文献条目不该翻译（只翻标题）');
    const p1 = await pageDone(1);
    const entries = p1.filter((t) => t.nowrap);
    assert.ok(entries.length >= 6, `目录条目应逐条翻译，实际 ${entries.length} 条`);
    assert.ok(entries.every((t) => !/\.\s?\.\s?\./.test(t.text) && !/\d\s*$/.test(t.text)), '点线或页码被送去翻译了');
    const p2 = await pageDone(2);
    assert.equal(p2.length, 3, '致谢页应是：标题、正文、日期（署名保留原文）');
    const body2 = [...p2].sort((a, b) => b.h - a.h)[0];
    assert.equal(body2.align, 'justify');
    const p3 = await pageDone(3);
    assert.equal([...p3].sort((a, b) => b.h - a.h)[0].align, 'justify', '两端对齐的正文被当成居中了');
    // 第 6 页：行间公式的编号（2.13）不并进段落（否则最后一行被当成靠右、译文压住公式）
    const p6 = await pageDone(6);
    assert.ok(!p6.some((t) => t.text.includes('2.13')), '公式编号被并进段落送去翻译了');
    assert.ok(!p6.some((t) => t.align === 'right'), '公式后面的段落被当成靠右对齐');
    assert.ok(p6.length >= 3, `第 6 页应有标题和两段正文，实际 ${p6.length} 段`);
    // 第 7 页：三栏表格，栏间只隔一个字宽：每个格子单独翻译，译文框互不重叠
    await pageDone(7);
    const t7 = await tp.evaluate(() => {
      const rs = [...document.querySelectorAll('.pg[data-page="7"] .tp')].map((t) => t.getBoundingClientRect());
      let overlaps = 0;
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i], b = rs[j];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) overlaps++;
      }
      return { n: rs.length, overlaps };
    });
    assert.equal(t7.overlaps, 0, `表格的译文框互相重叠 ${t7.overlaps} 处`);
    assert.ok(t7.n >= 12, `表格格子应分别翻译，实际 ${t7.n} 段`);
    // 第 8 页：行间公式（min、subject to、带下标的约束）原样保留；正文里的变量写成数学字母不翻；数字表格一行一格、表头不粘在一起
    const dp = await ctx.newPage();
    await dp.goto(`chrome-extension://${extId}/pdf.html?debug&url=${encodeURIComponent(base + '/thesis-mini.pdf')}`);
    await dp.waitForFunction(() => window.__txPdf, null, { timeout: 60000 });
    // noName：模拟 PDF.js 6.5 起字体对象不带 name 的情况（只剩 bold / italic 这些属性），两种都要对
    const layout8 = (noName) => dp.evaluate(async (strip) => {
      const { doc, extractLayout, target } = window.__txPdf;
      const page = await doc.getPage(8);
      await page.render({ canvasContext: document.createElement('canvas').getContext('2d'), viewport: page.getViewport({ scale: 0.3 }) }).promise;
      const objs = page.commonObjs;
      const get = objs.get;
      if (strip) objs.get = function (id) {
        const o = get.call(this, id);
        return o && typeof o === 'object' && 'loadedName' in o ? new Proxy(o, { get: (t, k) => (k === 'name' ? undefined : Reflect.get(t, k, t)) }) : o;
      };
      try {
        const L = await extractLayout(page, target, {});
        return L.paras.map((x) => ({ text: x.text, kind: x.kind, cell: !!x.cell }));
      } finally {
        objs.get = get;
      }
    }, noName);
    const L8 = await layout8(false);
    const L8n = await layout8(true);
    await dp.close();
    for (const [label, LL] of [['有字体名', L8], ['没有字体名', L8n]]) {
      const here = LL.find((x) => x.text.includes('Here,'));
      assert.ok(here && here.text.includes('\u{1D441}') && here.text.includes('\u{1D465}') && !/<x\d/.test(here.text), `${label}：正文里的斜体变量 N、x 应写成数学字母：` + here?.text);
      const smith = LL.find((x) => x.text.includes('Smith'));
      assert.ok(smith && smith.kind === 'body', `${label}：带斜体词的句子应正常翻译：` + smith?.text);
      assert.ok(smith.text.includes('et al.') && smith.text.includes('in situ'), `${label}：斜体单词不能变成数学字母：` + smith.text);
      assert.ok(smith.text.includes('\u{1D430}'), `${label}：粗体单字母 w 应写成数学粗体 𝐰：` + smith.text);
    }
    const find = (t) => L8.find((x) => x.text.includes(t));
    assert.equal(find('subject to')?.kind, 'skip', '公式左边的 subject to 被送去翻译了');
    assert.equal(L8.find((x) => x.text.trim() === 'min')?.kind, 'skip', '公式里的 min 被送去翻译了');
    assert.ok(!L8.some((x) => x.kind !== 'skip' && /max|≤/.test(x.text)), '带下标的约束被送去翻译了');
    const here = find('Here,');
    assert.ok(here && here.kind === 'body' && here.text.includes('\u{1D441}') && !/<x\d/.test(here.text), '正文里的变量 N 应写成数学字母：' + here?.text);
    assert.ok(!L8.some((x) => x.text.includes('error (cm)') && x.text.includes('samples')), '表头两个格子粘成了一段');
    assert.ok(!L8.some((x) => x.text.includes('Near-front') && x.text.includes('Right-side')), '表格的几行被并成了一段');
    assert.ok(find('Near-front')?.cell, '表格格子应单行显示');
    // 最后的保险：译文框可以拖开，位置记住；双击复原
    const box = tp.locator('.pg[data-page="6"] .tp').last();
    await box.scrollIntoViewIfNeeded();
    await box.hover();
    const grip = tp.locator('.pg[data-page="6"] .grip.on');
    await grip.waitFor({ timeout: 3000 });
    const g = await grip.boundingBox();
    const cx = g.x + g.width / 2;
    const cy = g.y + g.height / 2;
    await tp.mouse.move(cx, cy, { steps: 3 });
    await tp.mouse.down();
    await tp.mouse.move(cx + 20, cy + 15, { steps: 4 });
    await tp.mouse.move(cx + 40, cy + 30, { steps: 4 });
    await tp.mouse.up();
    const last6 = () => tp.evaluate(() => { const t = [...document.querySelectorAll('.pg[data-page="6"] .tp')].pop(); return { cls: t.classList.contains('moved'), tr: t.style.translate }; });
    const moved = await last6();
    assert.ok(moved.cls && /px/.test(moved.tr), '拖动后译文框没有移动：' + JSON.stringify(moved));
    await tp.waitForTimeout(250);
    const saved = await tp.evaluate(async () => Object.keys((await chrome.storage.local.get('ui.pdfMoves'))['ui.pdfMoves'] ?? {}).length);
    assert.ok(saved >= 1, '挪动的位置没有记住');
    await tp.locator('.pg[data-page="6"] .grip').dblclick();
    const back = await last6();
    assert.ok(!back.cls && !back.tr, '双击没有复原：' + JSON.stringify(back));
    await tp.close();
  });

  await step('阅读器：缩略图、跳页、缩放、左栏原文可选中复制、记住读到第几页、打印译文版', async () => {
    const rp = await ctx.newPage();
    rp.on('pageerror', (e) => errors.push(e.message));
    const url = `chrome-extension://${extId}/pdf.html?url=${encodeURIComponent(base + '/thesis-mini.pdf')}`;
    await rp.goto(url);
    // 上一步已经读过这个文件（会记住读到第几页），先清掉
    await rp.evaluate(() => chrome.storage.local.remove('ui.pdfResume'));
    await rp.reload();
    await rp.waitForSelector('.pg[data-page="1"] .orig .textLayer span', { state: 'attached', timeout: 30000 });
    // 原文可选中
    const sel = await rp.evaluate(() => {
      const tl = document.querySelector('.pg[data-page="1"] .orig .textLayer');
      const r = document.createRange();
      r.selectNodeContents(tl);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return getSelection().toString();
    });
    assert.match(sel, /Contents/);
    // 侧栏：没有书签时自动切到缩略图
    await rp.locator('.bar .iconbtn').click();
    await rp.waitForSelector('.side .thumb .tc canvas', { timeout: 10000 });
    assert.equal(await rp.locator('.side .thumb').count(), 8);
    // 跳页
    await rp.locator('.pnav input').fill('4');
    await rp.locator('.pnav input').press('Enter');
    await rp.waitForTimeout(600);
    assert.equal(await rp.locator('.side .thumb[aria-current="true"]').innerText(), '4');
    // 缩放
    const w0 = await rp.evaluate(() => document.querySelector('.pg[data-page="4"] .orig').getBoundingClientRect().width);
    await rp.locator('.zoom button[aria-label="放大"]').click();
    await rp.waitForTimeout(400);
    assert.equal(await rp.locator('.zoom .z').innerText(), '110%');
    const w1 = await rp.evaluate(() => document.querySelector('.pg[data-page="4"] .orig').getBoundingClientRect().width);
    assert.ok(w1 > w0 * 1.05, `放大后页面没有变宽 ${w0} → ${w1}`);
    await rp.waitForTimeout(900);
    // 记住读到第几页
    await rp.reload();
    await rp.waitForSelector('.toast', { timeout: 10000 });
    assert.match(await rp.locator('.toast').innerText(), /第 4 页/);
    assert.equal(await rp.locator('.zoom .z').innerText(), '110%');
    // 打印：先把整本翻完，再调用打印
    await rp.evaluate(() => { window.print = () => { window.__printed = true; }; });
    await rp.locator('.bar button:has-text("打印")').click();
    const modal = await rp.locator('.modal').count();
    if (modal) await rp.locator('.modal button:has-text("开始翻译")').click();
    await rp.waitForFunction(() => window.__printed === true, null, { timeout: 90000 });
    const allDone = await rp.evaluate(() => [...document.querySelectorAll('.pg')].every((pg) => pg.querySelector('.trans canvas.page')));
    assert.ok(allDone, '打印前没有把每一页都处理完');
    await rp.close();
  });

  await step('单栏阅读（仅原文）：不整篇翻译，选中原文出现划词小圆点并能翻译', async () => {
    const op = await ctx.newPage();
    op.on('pageerror', (e) => errors.push(e.message));
    await op.goto(`chrome-extension://${extId}/pdf.html?view=original&url=${encodeURIComponent(base + '/thesis-mini.pdf')}`);
    await op.evaluate(() => chrome.storage.local.remove('ui.pdfResume'));
    await op.reload();
    await op.waitForSelector('.pg[data-page="2"]');
    await op.evaluate(() => document.querySelector('.pg[data-page="2"]').scrollIntoView());
    await op.waitForSelector('.pg[data-page="2"] .orig .textLayer span', { state: 'attached', timeout: 30000 });
    await op.waitForTimeout(800);
    assert.equal(await op.locator('.tp').count(), 0, '单栏阅读时不该整篇翻译');
    // 在原文文字层上拖选一段
    const box = await op.locator('.pg[data-page="2"] .orig').boundingBox();
    const span = await op.locator('.pg[data-page="2"] .orig .textLayer span', { hasText: 'Finally' }).first().boundingBox();
    await op.mouse.move(span.x + 2, span.y + span.height / 2);
    await op.mouse.down();
    await op.mouse.move(Math.min(box.x + box.width - 80, span.x + 260), span.y + span.height / 2, { steps: 6 });
    await op.mouse.up();
    await op.waitForSelector('tx-ui .dot', { state: 'visible', timeout: 3000 });
    await op.locator('tx-ui .dot').click();
    await op.waitForFunction(() => {
      const t = document.querySelector('tx-ui')?.shadowRoot?.querySelector('.pop .tgt');
      return t && t.dataset.stage === 'final' && t.textContent.trim().length > 0;
    }, null, { timeout: 15000 });
    await op.close();
  });

  await step('混合扫描页（文字层只有页眉、页码，正文是图片）：正文交给 OCR，普通页面不误识别', async () => {
    const ocrCount = () => sw.evaluate(async () => (await chrome.storage.local.get('mock.pdfOcr'))['mock.pdfOcr'] ?? 0);
    const before = await ocrCount();
    assert.equal(before, 0, '前面的普通 PDF 页面不该走 OCR');
    const mp = await ctx.newPage();
    mp.on('pageerror', (e) => errors.push(e.message));
    await mp.goto(`chrome-extension://${extId}/pdf.html?url=${encodeURIComponent(base + '/mixed.pdf')}`);
    await mp.waitForFunction(() => document.querySelector('.pg[data-page="1"]')?.dataset.state === 'done' || document.querySelectorAll('.pg[data-page="1"] .tp').length >= 3, null, { timeout: 60000 });
    await mp.waitForFunction(() => document.querySelectorAll('.pg[data-page="1"] .tp').length >= 3, null, { timeout: 30000 });
    assert.equal(await ocrCount(), 1, '混合页应该识别一次');
    // 页眉（文字层）照常翻译，OCR 段落不和它重复
    const n = await mp.evaluate(() => document.querySelectorAll('.pg[data-page="1"] .tp').length);
    assert.equal(n, 4, `页眉 1 段 + OCR 3 段，实际 ${n} 段`);
    await mp.close();
  });

  await step('悬停译文段落时原文对应位置同时高亮', async () => {
    await pdf.locator('.tp').first().hover();
    assert.ok(await pdf.locator('.hl-layer div.on').count() >= 1);
  });

  // 只有界面测试构建会在本机测试域名注入字幕脚本。
  const manifest = JSON.parse(await readFile(path.join(extDir, 'manifest.json'), 'utf8'));
  const localPlayer = manifest.content_scripts.some(script => script.matches.includes('http://127.0.0.1/*') && script.js.includes('youtube.js'));
  if (localPlayer) {
    await checkImageGallery(ctx, base, step);
    await checkPlayerUpdates(ctx, base, step);
  }
  await step('没有页面脚本错误', async () => assert.deepEqual(errors, []));
} finally {
  await ctx.close();
  server.close();
}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
