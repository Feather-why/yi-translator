import assert from 'node:assert/strict';

export async function checkDocumentTranslationHints(ctx, base, step) {
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const previous = await worker.evaluate(async () => (await chrome.storage.local.get('settings.ui'))['settings.ui']);
  try {
    await worker.evaluate(() => chrome.storage.local.set({'settings.ui': {
      mainOnly:true, mode:'fast', targetLang:'zh-CN', display:'bilingual', bilingualStyle:'paragraph', loadingEffect:'dots',
    }}));
    await checkCases(ctx, base, step);
  } finally {
    await worker.evaluate(value => value === undefined
      ? chrome.storage.local.remove('settings.ui')
      : chrome.storage.local.set({'settings.ui':value}), previous);
  }
}

async function checkCases(ctx, base, step) {
  for (const [marker, description] of [['body', 'body.notranslate'], ['html', 'html[translate=no]']]) {
    await step(`带 ${description} 的招聘页面可手动翻译首屏和后续正文，局部禁译区和链接保留`, async () => {
      const page = await ctx.newPage();
      try {
        await page.goto(`${base}/root-hint.html?marker=${marker}`);
        const overview = page.locator('#overview');
        const original = await overview.innerHTML();
        const root = page.locator(marker === 'body' ? 'body' : 'html');
        const attribute = marker === 'body' ? 'class' : 'translate';
        const originalHint = await root.getAttribute(attribute);
        const ball = page.locator('tx-ui .ball');
        await ball.click();
        await page.locator('#job-title > tx-t[data-tx-stage="final"]').waitFor({timeout:6000});
        const link = overview.locator(':scope > tx-t[data-tx-stage="final"] a');
        await link.waitFor({timeout:6000});
        assert.equal(await link.getAttribute('href'), '#eligibility');
        assert.equal(await root.getAttribute(attribute), originalHint);

        await page.evaluate(() => {
          const added = document.createElement('p');
          added.id = 'late-details';
          added.textContent = 'Shortlisted applicants will receive additional instructions.';
          document.getElementById('duties').append(added);
          for (const keep of document.querySelectorAll('[data-preserve]')) {
            const extra = document.createElement('p');
            extra.textContent = 'This local note should stay in its original language.';
            keep.firstElementChild.append(extra);
          }
        });
        await page.locator('#late-details > tx-t[data-tx-stage="final"]').waitFor({timeout:6000});
        assert.equal(await page.locator('#eligibility tx-t').count(), 0);
        await page.locator('#eligibility').scrollIntoViewIfNeeded();
        await page.locator('#eligibility > tx-t[data-tx-stage="final"]').waitFor({timeout:6000});
        assert.equal(await page.locator('[data-preserve] tx-t').count(), 0);
        assert.ok(await page.locator('[contenteditable]').evaluate(el => el.isContentEditable));

        await ball.click();
        assert.equal(await page.locator('tx-t').count(), 0);
        assert.equal(await overview.innerHTML(), original);
        assert.equal(await root.getAttribute(attribute), originalHint);
      } finally { await page.close(); }
    });
  }
  await step('文档根保留扩展专用 tx-ignore 时仍尊重整页排除', async () => {
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/root-hint.html?marker=ignore`);
      await page.locator('tx-ui .ball').click();
      // 给扫描和动态观察各一次机会；忽略的页面应没有任何等待中或已完成的译文。
      await page.evaluate(() => document.getElementById('duties').append(Object.assign(document.createElement('p'), {textContent:'New vacancy details.'})));
      await page.waitForTimeout(700);
      assert.equal(await page.locator('tx-t').count(), 0);
    } finally { await page.close(); }
  });
  await step('冗长的隐藏 Cookie 清单不改变正文范围，可见的 aria-hidden 说明和模式切换正常', async () => {
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/root-hint.html?marker=scope`);
      assert.ok(await page.evaluate(() => {
        const details = document.getElementById('consent-details');
        return details.getClientRects().length === 0 && details.textContent.length > document.querySelector('main').textContent.length * 3;
      }));
      await page.locator('tx-ui .ball').click();
      await page.locator('#overview > tx-t[data-tx-stage="final"]').waitFor({timeout:6000});
      await page.locator('#visual-guidance > tx-t[data-tx-stage="final"]').waitFor({timeout:6000});
      assert.equal(await page.locator('#campus-news tx-t').count(), 0, '仅正文应跳过文章外的普通文本');
      const worker = ctx.serviceWorkers()[0];
      await worker.evaluate(async () => {
        const stored = await chrome.storage.local.get('settings.ui');
        await chrome.storage.local.set({'settings.ui': {...stored['settings.ui'], mainOnly:false}});
      });
      await page.locator('#campus-news > tx-t[data-tx-stage="final"]').waitFor({timeout:6000});
    } finally { await page.close(); }
  });
}
