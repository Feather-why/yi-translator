import assert from 'node:assert/strict';

/** 密集页面的输入和绘制要能穿插在译文插入之间。通过 DOM 的实际变化观测，不依赖 CPU 速度。 */
export async function checkDynamicGrid(ctx, base, step) {
  await step('动态创建密集网格时，网页按钮在全部译文插入前已能响应，格子最终各有一份译文', async () => {
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/interactive.html`);
      await page.locator('tx-ui .ball').click();
      await page.waitForSelector('#intro tx-t[data-tx-stage="final"]');
      await page.evaluate(() => {
        const grid = document.createElement('section');
        grid.id = 'live-grid';
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(24,minmax(0,1fr));';
        const count = 480;
        for (let i = 0; i < count; i++) {
          const row = document.createElement('p');
          row.style.cssText = 'margin:0;overflow:hidden;height:18px;font-size:12px';
          row.textContent = 'Live cell ' + i;
          grid.append(row);
        }
        const observe = new MutationObserver(() => {
          if (!grid.querySelector('tx-t')) return;
          observe.disconnect();
          setTimeout(() => {
            document.querySelector('#action').click();
            grid.dataset.atClick = String(grid.querySelectorAll('tx-t').length);
          }, 0);
        });
        observe.observe(grid, { subtree: true, childList: true });
        document.querySelector('main').append(grid);
      });
      await page.waitForFunction(() => document.querySelector('#live-grid')?.dataset.atClick, null, {timeout: 7000});
      const atClick = Number(await page.locator('#live-grid').getAttribute('data-at-click'));
      assert.equal(await page.locator('#action').getAttribute('data-clicks'), '1');
      assert.ok(atClick > 0 && atClick < 480, `网页按钮响应时已同步插入 ${atClick}/480 个译文`);
      await page.waitForFunction(() => document.querySelectorAll('#live-grid tx-t[data-tx-stage="final"]').length === 480, null, {timeout: 20000});
      assert.ok(await page.locator('#live-grid').evaluate(grid => [...grid.children].every(row => row.querySelectorAll(':scope > tx-t').length === 1)));
    } finally { await page.close(); }
  });

  await step('大量可见段落翻译到一半时还原，再滚动和新增段落也不会补写旧译文', async () => {
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/interactive.html`);
      await page.locator('tx-ui .ball').click();
      await page.waitForSelector('#intro tx-t[data-tx-stage="final"]');
      await page.evaluate(() => {
        const feed = document.createElement('section');
        feed.id = 'stop-grid';
        feed.style.cssText = 'display:grid;grid-template-columns:repeat(24,minmax(0,1fr));';
        for (let i=0; i<800; i++) {
          const row = document.createElement('p');
          row.style.cssText = 'margin:0;overflow:hidden;height:16px';
          row.textContent = 'Feed item ' + i;
          feed.append(row);
        }
        const mo = new MutationObserver(() => {
          if (!feed.querySelector('tx-t')) return;
          mo.disconnect();
          setTimeout(() => {
            feed.dataset.beforeStop = String(feed.querySelectorAll('tx-t').length);
            const ball = document.querySelector('tx-ui').shadowRoot.querySelector('.ball');
            ball.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
            feed.lastElementChild.scrollIntoView();
            feed.append(Object.assign(document.createElement('p'),{textContent:'Added after stop'}));
            feed.dataset.stopped = '1';
          },0);
        });
        mo.observe(feed,{childList:true,subtree:true});
        document.querySelector('main').append(feed);
      });
      await page.waitForSelector('#stop-grid[data-stopped]', {timeout:7000});
      const beforeStop = Number(await page.locator('#stop-grid').getAttribute('data-before-stop'));
      assert.ok(beforeStop > 0 && beforeStop < 800, `还原前已插入 ${beforeStop}/800 个译文`);
      await page.waitForTimeout(800);
      assert.equal(await page.locator('tx-t').count(), 0);
    } finally { await page.close(); }
  });
}
