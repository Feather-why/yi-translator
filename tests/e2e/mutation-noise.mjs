import assert from 'node:assert/strict';

export async function checkMutationNoise(ctx, base, step) {
  await step('图表和编辑器持续刷新时，新增正文及时进入翻译，输入内容保持可编辑', async () => {
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/interactive.html`);
      await page.locator('tx-ui .ball').click();
      await page.waitForSelector('#intro tx-t[data-tx-stage="final"]');
      const result = await page.evaluate(async () => {
        const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const editor = document.createElement('div');
        editor.contentEditable = 'true';
        const ignored = document.createElement('aside');
        ignored.setAttribute('translate', 'no');
        const main = document.querySelector('main');
        main.append(chart, editor, ignored);
        const article = document.createElement('p');
        article.id = 'new-source';
        article.textContent = 'New text appeared while the chart was updating.';
        main.prepend(article);
        const intro = document.querySelector('#intro');
        const originalSegment = intro.querySelector('tx-t').dataset.txSeg;
        intro.firstChild.data = 'Existing text changed while the chart was updating.';
        let updates = 0;
        const update = () => {
          editor.replaceChildren('Current input ' + ++updates);
          ignored.replaceChildren('Account notice ' + updates);
          chart.replaceChildren(document.createElementNS(chart.namespaceURI, 'g'));
        };
        update();
        const timer = setInterval(update, 25);
        try {
          // 普通正文的 250ms 防抖应独立于这些排除区域，不能被持续刷新推迟到 1 秒上限。
          await new Promise(resolve => setTimeout(resolve, 800));
          return { updates, entered: article.querySelectorAll(':scope > tx-t').length,
            revised: !!intro.querySelector('tx-t') && intro.querySelector('tx-t').dataset.txSeg !== originalSegment,
            ignored: [editor, ignored, chart].some(el => el.querySelector('tx-t')),
            editable: editor.isContentEditable };
        } finally { clearInterval(timer); }
      });
      assert.ok(result.updates > 4);
      assert.equal(result.entered, 1, '连续装饰更新阻止了同屏新正文进入翻译');
      assert.equal(result.revised, true, '持续的装饰刷新阻止原有段落更新');
      assert.equal(result.ignored, false);
      assert.equal(result.editable, true);
      await page.waitForSelector('#new-source tx-t[data-tx-stage="final"]');
    } finally { await page.close(); }
  });
}
