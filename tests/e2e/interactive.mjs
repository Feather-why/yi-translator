import assert from 'node:assert/strict';

export async function checkInteractivePage(ctx, base, step) {
  async function openPage() {
    const page = await ctx.newPage();
    await page.goto(`${base}/interactive.html`);
    await page.waitForSelector('tx-ui .ball');
    return page;
  }

  await step('展开、收起和复用深层菜单时，每行只插入一份译文，快速点击网页按钮仍然生效', async () => {
    const page = await openPage();
    try {
      await page.locator('tx-ui .ball').click();
      await page.waitForSelector('#intro tx-t[data-tx-stage="final"]');
      const menu = page.locator('#toggle-menu');
      async function checkRows() {
        await page.waitForFunction(() => document.querySelectorAll('#menu p:has(> tx-t[data-tx-stage="final"])').length === 3, null, { timeout: 5000 });
        const counts = await page.locator('#menu p').evaluateAll(rows => rows.map(row => row.querySelectorAll(':scope > tx-t').length));
        assert.deepEqual(counts, [1, 1, 1]);
      }
      await menu.click();
      await checkRows();
      await menu.click();
      // 跨过动态页面的防抖期，让翻译器先处理一次真正的卸载。
      await page.waitForTimeout(450);
      await menu.click();
      await checkRows();
      await menu.click({ clickCount: 12, delay: 8 });
      await page.locator('#action').click({ clickCount: 8, delay: 8 });
      assert.equal(await page.locator('#action').getAttribute('data-clicks'), '8');
      await page.waitForTimeout(450); // 等快速开关产生的最后一批页面变更处理完

      await checkRows();
    } finally { await page.close(); }
  });

  await step('翻译和还原连续触发后，只有最后一次开启有效，停止后新增内容保持原文', async () => {
    const page = await openPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.locator('tx-ui .ball').click();
      await page.waitForSelector('#intro tx-t[data-tx-stage="final"]');
      await page.locator('tx-ui .ball').click();
      // 从真实的键盘入口在同一任务内连发，保证覆盖上一次规则读取尚未返回的情况。
      const toggle = count => page.locator('tx-ui .ball').evaluate((ball, n) => {
        for (let i = 0; i < n; i++) ball.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }, count);
      await toggle(20);
      await toggle(11);
      await page.waitForSelector('#intro tx-t[data-tx-stage="final"]');
      assert.equal(await page.locator('#intro tx-t').count(), 1);
      await page.locator('tx-ui .ball').click();
      await page.locator('#toggle-menu').click();
      await page.waitForTimeout(600);
      assert.equal(await page.locator('tx-t').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await step('单页应用连续更换整个 body，译文随新页面恢复，关闭后不再重启', async () => {
    const page = await openPage();
    try {
      await page.locator('tx-ui .ball').click();
      await page.waitForSelector('#intro tx-t[data-tx-stage="final"]');
      await page.evaluate(() => {
        window.previousRouteBody = document.body;
        for (let i = 0; i < 4; i++) {
          const next = document.createElement('body');
          next.innerHTML = '<main><button type="button" translate="no">Continue</button><p id="route">Read the current settings before opening the menu.</p></main>';
          next.querySelector('button').onclick = () => { next.dataset.clicked = 'yes'; };
          document.body.replaceWith(next);
        }
      });
      await page.locator('#route tx-t[data-tx-stage="final"]').waitFor({ timeout: 4000 });
      await page.locator('main button').click();
      assert.equal(await page.locator('body').getAttribute('data-clicked'), 'yes');
      assert.equal(await page.locator('#route tx-t').count(), 1);
      assert.equal(await page.evaluate(() => !!window.previousRouteBody.querySelector('tx-t')), false);
      await page.evaluate(() => {
        const p = document.createElement('p');
        p.id = 'later';
        p.textContent = 'Read the current settings before opening the menu.';
        document.querySelector('main').append(p);
      });
      await page.locator('#later tx-t[data-tx-stage="final"]').waitFor({ timeout: 4000 });
      await page.locator('tx-ui .ball').click();
      await page.evaluate(() => { document.body.replaceWith(window.previousRouteBody); });
      await page.waitForTimeout(500);
      assert.equal(await page.locator('tx-t').count(), 0);
    } finally { await page.close(); }
  });

  await step('预先渲染的 hidden 菜单和原生折叠区展开后显示译文', async () => {
    const page = await openPage();
    try {
      await page.evaluate(() => {
        document.querySelector('main').insertAdjacentHTML('beforeend', '<div id="pre-menu" hidden><p>Read the current settings before opening the menu.</p></div><details><summary translate="no">More</summary><p id="detail">Read the current settings before opening the menu.</p></details>');
      });
      await page.locator('tx-ui .ball').click();
      await page.waitForSelector('#intro tx-t[data-tx-stage="final"]');
      await page.locator('summary').click();
      await page.waitForSelector('#detail tx-t[data-tx-stage="final"]', {timeout:4000});
      await page.evaluate(() => { document.querySelector('#pre-menu').hidden = false; });
      await page.waitForSelector('#pre-menu tx-t[data-tx-stage="final"]', {timeout:4000});
      assert.equal(await page.locator('#pre-menu tx-t').count(), 1);
    } finally { await page.close(); }
  });

  await step('网页清理插件浮层时会让出事件循环，清理结束后浮球恢复', async () => {
    const page = await openPage();
    try {
      const removalsBeforeTimer = await page.evaluate(() => new Promise(resolve => {
        let removals = 0;
        const observer = new MutationObserver(() => {
          const host = document.querySelector('tx-ui');
          // 上限使旧实现的回归测试也会结束。
          if (host && removals < 100) { removals++; host.remove(); }
        });
        observer.observe(document.documentElement, { childList: true });
        document.querySelector('tx-ui').remove();
        setTimeout(() => { observer.disconnect(); resolve(removals); }, 0);
      }));
      assert.ok(removalsBeforeTimer <= 1, `一个事件循环内重挂 ${removalsBeforeTimer} 次`);
      await page.waitForSelector('tx-ui .ball', { timeout: 4000 });
      await page.locator('#action').click();
      assert.equal(await page.locator('#action').getAttribute('data-clicks'), '1');
    } finally { await page.close(); }
  });
}
