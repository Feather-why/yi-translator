import assert from 'node:assert/strict';

export async function checkImageGallery(ctx, base, step) {
  await step('图片列表滚动时隐藏离屏覆盖层，返回后准确对齐，复用图片元素时清除旧译图', async () => {
    const page = await ctx.newPage();
    try {
      await page.goto(base + '/image.html?gallery');
      await page.waitForSelector('tx-ui', { state: 'attached' });
      const urls = await page.evaluate(() => {
        document.body.replaceChildren();
        const feed = document.createElement('div');
        feed.id = 'gallery';
        feed.style.cssText = 'height:150px;width:370px;overflow:auto;border:3px solid';
        document.body.append(feed);
        return Array.from({ length: 6 }, (_, i) => {
          const img = document.createElement('img');
          img.style.cssText = 'display:block;width:320px;height:150px';
          img.src = new URL('sign.png?gallery=' + i, location.href).href;
          feed.append(img);
          return img.src;
        });
      });
      await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth));
      const sw = ctx.serviceWorkers()[0];
      const tab = await sw.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, page.url());
      const translate = srcUrl => sw.evaluate(({tab,srcUrl}) => chrome.tabs.sendMessage(tab, {cmd:'translate-image',srcUrl}), {tab,srcUrl});
      for (const url of urls) await translate(url);
      await page.waitForFunction(() => [...document.querySelectorAll('tx-ocr')].filter(h => h.shadowRoot.querySelector('[data-stage="final"]')).length === 6,
        null, {timeout:20000});
      const aligned = index => page.waitForFunction(i => {
        const list = [...document.querySelectorAll('tx-ocr')];
        const visible = list.filter(el => getComputedStyle(el).display !== 'none');
        const box = document.images[i].getBoundingClientRect();
        return visible.length <= 3 && visible.some(host => {
          const r = host.getBoundingClientRect();
          return Math.abs(r.left-box.left) < 1 && Math.abs(r.top-box.top) < 1;
        });
      }, index, {timeout:3000});
      await aligned(0);
      await page.evaluate(() => { document.querySelector('#gallery').scrollTop = 600; });
      await aligned(4);
      await page.evaluate(() => { document.querySelector('#gallery').scrollTop = 0; });
      await aligned(0);
      const replacement = await page.evaluate(() => {
        const img = document.images[0];
        img.src = new URL('sign.png?replacement', location.href).href;
        return img.src;
      });
      await page.waitForFunction(() => document.querySelectorAll('tx-ocr').length === 5, null, {timeout:3000});
      await translate(replacement);
      await page.waitForFunction(() => [...document.querySelectorAll('tx-ocr')].filter(h => h.shadowRoot.querySelector('[data-stage="final"]')).length === 6,
        null, {timeout:5000});
      await aligned(0);
      // 先完全隐藏，等尺寸和可见性通知结束；之后移除本身可能不再触发这些通知。
      await page.evaluate(() => { document.querySelector('#gallery').style.display = 'none'; });
      await page.waitForFunction(() => [...document.querySelectorAll('tx-ocr')].every(el => getComputedStyle(el).display === 'none'));
      await page.waitForTimeout(200);
      await page.evaluate(() => document.querySelector('#gallery').remove());
      await page.waitForFunction(() => !document.querySelector('tx-ocr'), null, {timeout:3000});
      assert.equal(await page.locator('tx-ocr').count(), 0);
    } finally { await page.close(); }
  });
}
