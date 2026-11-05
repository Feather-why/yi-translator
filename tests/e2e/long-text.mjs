import assert from 'node:assert/strict';

export async function checkLongText(ctx, base, step) {
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const previous = await worker.evaluate(async () => (await chrome.storage.local.get('settings.ui'))['settings.ui']);
  async function open(style) {
    await worker.evaluate(bilingualStyle => chrome.storage.local.set({ 'settings.ui': {
      mainOnly: false, mode: 'fast', loadingEffect: 'dots', bilingualStyle, display: 'bilingual', targetLang: 'zh-CN',
    } }), style);
    const page = await ctx.newPage();
    await page.goto(`${base}/interactive.html`);
    await page.waitForSelector('tx-ui .ball');
    return page;
  }

  try {
    await step('深层行内包装可翻译、划选高亮和还原，保留最内层的原文及占位符', async () => {
      const page = await open('paragraph');
      try {
        await page.evaluate(() => {
          const p = document.createElement('p');
          p.id = 'deep'; p.append('Please read ');
          let outer = p;
          for (let i = 0; i < 4200; i++) outer = outer.appendChild(document.createElement('span'));
          const link = document.createElement('a'); link.href = '#source'; link.textContent = 'the last sentence';
          outer.append(link); p.append(' carefully.'); document.querySelector('main').prepend(p);
        });
        await page.locator('tx-ui .ball').click();
        await page.waitForSelector('#deep > tx-t[data-tx-stage="final"]');
        assert.equal(await page.locator('#deep > tx-t a').getAttribute('href'), '#source');
        await page.evaluate(() => {
          const node = document.querySelector('#deep').firstChild;
          const selection = getSelection(); selection.setBaseAndExtent(node, 0, node, 6);
        });
        await page.waitForFunction(() => CSS.highlights.get('tx-link-soft')?.size > 0);
        await page.locator('tx-ui .ball').click();
        assert.equal(await page.locator('#deep').count(), 1);
        assert.equal(await page.locator('#deep').textContent(), 'Please read the last sentence carefully.');
      } finally { await page.close(); }
    });

    await step('超长逐句段落分批插入时仍能点击，全部译完且关闭后逐字还原', async () => {
      const page = await open('sentence');
      try {
        const source = await page.evaluate(() => {
          const p = document.querySelector('#intro');
          const source = Array.from({ length: 400 }, (_, i) => `Read sentence number ${i + 1}.`).join(' ');
          p.textContent = source;
          const observer = new MutationObserver(() => {
            if (!p.querySelector('tx-t')) return;
            observer.disconnect();
            setTimeout(() => {
              document.querySelector('#action').click();
              p.dataset.atClick = String(p.querySelectorAll('tx-t').length);
            }, 0);
          });
          observer.observe(p, { childList: true });
          return source;
        });
        await page.locator('tx-ui .ball').click();
        await page.waitForFunction(() => document.querySelector('#intro tx-t') && document.querySelector('#intro').dataset.atClick);
        const count = Number(await page.locator('#intro').getAttribute('data-at-click'));
        assert.ok(count > 0 && count < 400, `响应点击时已插入 ${count}/400 句`);
        assert.equal(await page.locator('#action').getAttribute('data-clicks'), '1');
        await page.waitForFunction(() => document.querySelectorAll('#intro > tx-t[data-tx-stage="final"]').length === 400, null, { timeout: 20000 });
        await page.locator('tx-ui .ball').click();
        assert.equal(await page.locator('#intro').textContent(), source);
        assert.equal(await page.locator('#intro').evaluate(el => el.childNodes.length), 1);
      } finally { await page.close(); }
    });

    await step('逐句挂载中途关闭、切换模式、替换或移除原段落，释放未完成的译文和拆开的文本节点', async () => {
      for (const action of ['stop', 'mode', 'replace', 'remove']) {
        const page = await open('sentence');
        try {
          if (action === 'mode') await page.exposeFunction('switchToParagraph', () => worker.evaluate(async () => {
            const settings = (await chrome.storage.local.get('settings.ui'))['settings.ui'];
            await chrome.storage.local.set({'settings.ui': {...settings, bilingualStyle:'paragraph'}});
          }));
          const source = await page.evaluate(action => {
            const p = document.querySelector('#intro');
            const source = 'A sentence for the reader. '.repeat(600);
            p.textContent = source;
            const mo = new MutationObserver(() => {
              if (!p.querySelector('tx-t')) return;
              mo.disconnect();
              window.oldParagraph = p;
              // 在两批之间操作，而非在已经完成后才取消。
              setTimeout(() => {
                p.dataset.atAction = String(p.querySelectorAll('tx-t').length);
                if (action === 'stop') document.querySelector('tx-ui').shadowRoot.querySelector('.ball').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
                else if (action === 'mode') void window.switchToParagraph();
                else if (action === 'replace') p.textContent = 'The page now shows a new paragraph.';
                else p.remove();
              }, 0);
            });
            mo.observe(p,{childList:true});
            return source;
          }, action);
          await page.locator('tx-ui .ball').click();
          await page.waitForFunction(() => window.oldParagraph?.dataset.atAction);
          const atAction = Number(await page.evaluate(() => window.oldParagraph.dataset.atAction));
          assert.ok(atAction > 0 && atAction < 600, `${action} 开始时已有 ${atAction}/600 句`);
          if (action === 'replace' || action === 'mode') {
            await page.waitForSelector('#intro > tx-t[data-tx-mode="block"][data-tx-stage="final"]');
            assert.equal(await page.locator('#intro tx-t').count(), 1);
            await page.locator('tx-ui .ball').click();
          } else await page.waitForTimeout(450);
          const old = await page.evaluate(() => ({ html:window.oldParagraph.innerHTML, nodes:window.oldParagraph.childNodes.length }));
          assert.equal(old.html, action === 'replace' ? 'The page now shows a new paragraph.' : source);
          assert.equal(old.nodes, 1);
        } finally { await page.close(); }
      }
    });

    await step('点击四十八句中间的一条译文，只预取该句的词对齐', async () => {
      const page = await open('sentence');
      try {
        await page.evaluate(() => {
          const p = document.createElement('p'); p.id = 'many-sentences';
          p.textContent = Array.from({ length: 48 }, (_, i) => `Read sentence number ${i + 1}.`).join(' ');
          document.querySelector('main').prepend(p);
        });
        await page.locator('tx-ui .ball').click();
        await page.waitForFunction(() => document.querySelectorAll('#many-sentences > tx-t[data-tx-stage="final"]').length === 48);
        await worker.evaluate(() => {
          self.longTextPairs = [];
          self.longTextListener = msg => {
            if (msg?.rpc === 'align:get') self.longTextPairs.push(...msg.payload.pairs.map(p => p.id));
          };
          chrome.runtime.onMessage.addListener(self.longTextListener);
        });
        const target = page.locator('#many-sentences > tx-t').nth(24);
        const id = await target.getAttribute('data-tx-seg');
        await target.click();
        // 消息和点击来自不同的进程；轮询到第一条请求后再检查本次预取的范围。
        const until = Date.now() + 3000;
        while (Date.now() < until && !(await worker.evaluate(() => self.longTextPairs.length))) await page.waitForTimeout(20);
        assert.deepEqual(await worker.evaluate(() => self.longTextPairs), [id]);
      } finally {
        await worker.evaluate(() => {
          if (self.longTextListener) chrome.runtime.onMessage.removeListener(self.longTextListener);
          delete self.longTextPairs; delete self.longTextListener;
        });
        await page.close();
      }
    });
  } finally {
    await worker.evaluate(value => value === undefined ? chrome.storage.local.remove('settings.ui') : chrome.storage.local.set({'settings.ui': value}), previous);
  }
}
