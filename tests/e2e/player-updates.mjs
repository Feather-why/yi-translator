import assert from 'node:assert/strict';

async function captureSubtitles(ctx) {
  return ctx.serviceWorkers()[0].evaluateHandle(() => {
    const batches = [];
    const capture = msg => {
      if (msg.rpc === 'subtitle:translate') batches.push(msg.payload.segments.map(s => s.text));
    };
    chrome.runtime.onMessage.addListener(capture);
    return { batches, stop: () => chrome.runtime.onMessage.removeListener(capture) };
  });
}

export async function checkPlayerUpdates(ctx, base, step) {
  async function open() {
    const page = await ctx.newPage();
    await page.goto(`${base}/player.html?v=fixture`);
    await page.waitForSelector('.tx-yt-btn', {state:'attached', timeout:4000});
    return page;
  }
  await step('播放器持续清理扩展按钮时仍响应页面操作，清理结束后恢复一个按钮', async () => {
    const page = await open();
    try {
      const count = await page.evaluate(() => new Promise(resolve => {
        let removed = 0;
        const controls = document.querySelector('.ytp-right-controls');
        const observer = new MutationObserver(() => {
          const btn = controls.querySelector('.tx-yt-btn');
          // 让旧版也能结束测试，真实网页的清理器通常没有这个上限。
          if (btn && removed < 100) { removed++; btn.remove(); }
        });
        observer.observe(controls,{childList:true});
        controls.querySelector('.tx-yt-btn').remove();
        setTimeout(() => { observer.disconnect(); resolve(removed); },0);
      }));
      assert.ok(count <= 1, `浏览器执行下一个任务前重复插入了 ${count} 个按钮`);
      await page.locator('#action').click({timeout:2000});
      assert.equal(await page.locator('#action').textContent(),'clicked');
      await page.waitForSelector('.ytp-right-controls .tx-yt-btn', {state:'attached',timeout:3500});
      assert.equal(await page.locator('.tx-yt-btn').count(),1);
    } finally { await page.close(); }
  });
  await step('播放器独立替换原生字幕容器时，立即显示新容器里的字幕', async () => {
    const page = await open();
    try {
      await page.locator('.ytp-caption-segment').evaluate(el => { el.textContent='First caption.'; });
      const translated = page.locator('tx-yt .tr');
      await translated.waitFor({ timeout:3500 });
      const first = await translated.textContent();
      await page.evaluate(() => {
        const old=document.querySelector('.ytp-caption-window-container');
        const next=old.cloneNode(true);
        next.querySelector('.ytp-caption-segment').textContent='A new caption on this player.';
        old.replaceWith(next);
      });
      await page.waitForFunction(first => {
        const text=document.querySelector('tx-yt')?.shadowRoot?.querySelector('.tr')?.textContent;
        return !!text && text !== first;
      },first,{timeout:3500});
    } finally { await page.close(); }
  });
  await step('原生字幕连续 60 次逐词更新时只翻译稳定下来的字幕', async () => {
    const page = await open();
    const capture = await captureSubtitles(ctx);
    try {
      await page.evaluate(async () => {
        const text = document.querySelector('.ytp-caption-segment');
        for (let i=1; i<=60; i++) {
          text.textContent = 'Live caption ' + i;
          await Promise.resolve();
        }
      });
      await page.waitForSelector('tx-yt .tr', {timeout:3600});
      const batches = await capture.evaluate(c => c.batches);
      assert.equal(batches.length,1,`60 次更新发送了 ${batches.length} 个翻译请求`);
      assert.deepEqual(batches[0],['Live caption 60']);
    } finally {
      await capture.evaluate(c => c.stop());
      await capture.dispose();
      await page.close();
    }
  });
  await step('超长字幕行不阻塞之后的正常字幕翻译', async () => {
    const page = await open();
    const capture = await captureSubtitles(ctx);
    try {
      await page.evaluate(() => {
        window.postMessage({__tx_yt_timedtext:true,url:'/api/timedtext?v=fixture&lang=en',body:JSON.stringify({events:[
          {tStartMs:0,dDurationMs:1000,segs:[{utf8:'A'.repeat(12001)+'.'}]},
          {tStartMs:2000,dDurationMs:4000,segs:[{utf8:'A later caption.'}]}
        ]})},location.origin);
      });
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-tx-yt-track'),null,{timeout:3500});
      let first;
      for (let attempt=0; attempt<40 && !first; attempt++) {
        first = await capture.evaluate(c => c.batches[0]);
        if (!first) await new Promise(resolve => setTimeout(resolve,50));
      }
      assert.deepEqual(first,['A later caption.']);
      await page.evaluate(() => {
        const video = document.querySelector('video');
        video.currentTime = 3;
        video.dispatchEvent(new Event('seeked'));
      });
      await page.waitForSelector('tx-yt .tr', {timeout:3600});
    } finally {
      await capture.evaluate(c => c.stop());
      await capture.dispose();
      await page.close();
    }
  });
}
