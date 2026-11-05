import assert from 'node:assert/strict';

export async function checkRecycledContent(ctx, base, step) {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const initial = await sw.evaluate(async () => (await chrome.storage.local.get('settings.ui'))['settings.ui']);
  async function openPage(style = 'paragraph') {
    await sw.evaluate(bilingualStyle => chrome.storage.local.set({
      'settings.ui': { mode: 'fast', mainOnly: false, loadingEffect: 'dots', targetLang: 'zh-CN', display: 'bilingual', bilingualStyle },
    }), style);
    const page = await ctx.newPage();
    await page.goto(`${base}/recycled.html`);
    await page.locator('tx-ui .ball').click();
    await page.waitForSelector('#sentences tx-t[data-tx-stage="final"]');
    return page;
  }

  try {
    await step('虚拟列表重绘相同文本时沿用原译文，重建的链接和代码来自新节点', async () => {
      const page = await openPage();
      try {
        const old = await page.locator('#same tx-t').getAttribute('data-tx-seg');
        const linkId = await page.locator('#linked tx-t').getAttribute('data-tx-seg');
        await page.evaluate(() => {
          document.querySelector('#same').replaceChildren(document.createTextNode('Products 15.'));
          const row = document.querySelector('#linked');
          row.innerHTML = 'Read <a href="#new">details</a> for <code>NEW</code>.';
          row.querySelector('a').onclick = event => { event.preventDefault(); row.dataset.used = 'new'; };
          document.querySelector('#attr a').href = '#after';
        });
        await page.waitForFunction(() => document.querySelector('#linked tx-t code')?.textContent === 'NEW'
          && document.querySelector('#attr tx-t a')?.hash === '#after');
        assert.equal(await page.locator('#same tx-t').getAttribute('data-tx-seg'), old);
        assert.equal(await page.locator('#linked tx-t').getAttribute('data-tx-seg'), linkId);
        assert.equal(await page.locator('#linked tx-t a').getAttribute('href'), '#new');
        await page.locator('#linked tx-t a').click();
        assert.equal(await page.locator('#linked').getAttribute('data-used'), 'new');
      } finally { await page.close(); }
    });

    await step('从空文本开始逐字输出、连续复用同一行并重排时，保留最终文字且点击照常生效', async () => {
      const page = await openPage();
      try {
        await page.waitForSelector('#untouched tx-t[data-tx-stage="final"]');
        const stableId = await page.locator('#untouched tx-t').getAttribute('data-tx-seg');
        await page.evaluate(async () => {
          const row = document.querySelector('#live');
          const list = document.querySelector('#list');
          const stream = document.querySelector('#empty').firstChild;
          for (let i = 2; i <= 25; i++) {
            row.firstChild.data = 'Live ' + i + '.';
            stream.appendData(i === 25 ? ' 775.' : 'a');
            if (i % 2) list.prepend(row); else list.append(row);
            document.querySelector('#action').click();
            await new Promise(resolve => setTimeout(resolve, 12));
          }
        });
        await page.waitForFunction(() => document.querySelector('#empty tx-t[data-tx-stage="final"]')?.textContent.includes('775')
          && document.querySelector('#live tx-t[data-tx-stage="final"]')?.textContent.includes('25'));
        assert.equal(await page.locator('#live tx-t').count(), 1);
        assert.equal(await page.locator('#untouched tx-t').getAttribute('data-tx-seg'), stableId);
        assert.equal(await page.locator('#action').getAttribute('data-hits'), '24');
      } finally { await page.close(); }
    });

    await step('夹在块元素间的菜单行插入、重排、移除行内文字后，译文按可见原文的顺序更新', async () => {
      const page = await openPage();
      try {
        const id = await page.locator('#footer tx-t').getAttribute('data-tx-seg');
        await page.evaluate(() => {
          const row = document.querySelector('#runs');
          row.insertBefore(document.createTextNode(' now 85'), row.querySelector('tx-t'));
          row.prepend(row.querySelector('b'));
        });
        await page.waitForFunction(() => /2.*1.*85/.test(document.querySelector('#runs > tx-t[data-tx-stage="final"]')?.textContent ?? ''));
        await page.locator('#runs > b').evaluate(el => el.remove());
        await page.waitForFunction(() => {
          const text = document.querySelector('#runs > tx-t[data-tx-stage="final"]')?.textContent ?? '';
          return text.includes('85') && !text.includes('2');
        });
        assert.equal(await page.locator('#runs > tx-t').count(), 1);
        assert.equal(await page.locator('#footer tx-t').getAttribute('data-tx-seg'), id);
      } finally { await page.close(); }
    });

    await step('逐句模式下重建同一段时保留两条译文，停止后原文可完整还原', async () => {
      const page = await openPage('sentence');
      try {
        const parts = page.locator('#sentences tx-t[data-tx-stage="final"]');
        await page.waitForFunction(() => document.querySelectorAll('#sentences tx-t[data-tx-stage="final"]').length === 2);
        const ids = await parts.evaluateAll(txs => txs.map(tx => tx.dataset.txSeg));
        const original = 'This is the first sentence. Here is another sentence.';
        await page.locator('#sentences').evaluate((p, source) => p.textContent = source, original);
        await page.waitForFunction(() => document.querySelectorAll('#sentences tx-t[data-tx-stage="final"]').length === 2);
        assert.deepEqual(await parts.evaluateAll(txs => txs.map(tx => tx.dataset.txSeg)), ids);
        await page.locator('tx-ui .ball').click();
        assert.equal(await page.locator('#sentences').innerHTML(), original);
      } finally { await page.close(); }
    });
  } finally {
    await sw.evaluate(previous => previous === undefined ? chrome.storage.local.remove('settings.ui') : chrome.storage.local.set({'settings.ui': previous}), initial);
  }
}
