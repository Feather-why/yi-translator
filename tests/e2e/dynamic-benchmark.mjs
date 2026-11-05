// 在浏览器外发送鼠标点击。网页主线程忙时，点击仍会排队，下一幅画面也会推迟。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const extension = path.resolve(process.env.EXT_DIR || fileURLToPath(new URL('../../.output/ui-test', import.meta.url)));
const html = await readFile(new URL('./fixtures/interactive.html', import.meta.url));
const server = http.createServer((_req,res) => res.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end(html));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let ctx;
try {
  ctx = await chromium.launchPersistentContext('', {headless:true,
    ...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE,ignoreDefaultArgs:['--disable-extensions']} : {channel:'chromium'}),
    args:[`--load-extension=${extension}`, `--disable-extensions-except=${extension}`],viewport:{width:1080,height:850}});
  const sw=ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({'settings.ui':{mainOnly:false, loadingEffect:'dots',mode:'fast'}}));
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/interactive.html`);
  await page.locator('tx-ui .ball').click();
  await page.waitForSelector('#intro tx-t[data-tx-stage="final"]');
  const samples=[];
  for (let run=0;run<3;run++) {
    await page.evaluate(() => {
      const action=document.getElementById('action');
      action.style.cssText='position:fixed;top:2px;left:2px;width:70px;height:30px;z-index:10';
      const measurement=window.dynamicSample={previous:0,frames:[],raf:0,trusted:0};
      action.onpointerdown=e=>{if(e.isTrusted)measurement.trusted++;};
      const next=stamp=>{
        if(measurement.previous)measurement.frames.push(stamp-measurement.previous);
        measurement.previous=stamp;
        measurement.raf=requestAnimationFrame(next);
      };
      measurement.raf=requestAnimationFrame(next);
      const grid=document.createElement('section');grid.id='measure-grid';
      grid.style.cssText='display:grid;grid-template-columns:repeat(24,minmax(0,1fr))';
      for(let i=0;i<768;i++){
        const row=document.createElement('p');row.textContent='Menu option number '+i;
        row.style.cssText='height:15px;margin:0;overflow:hidden;font-size:12px';grid.append(row);
      }
      document.querySelector('main').append(grid);
    });
    const clicks=[], deadline=performance.now()+2200;
    while(performance.now()<deadline){
      const start=performance.now();
      await page.mouse.click(20,12);
      clicks.push(performance.now()-start);
      await new Promise(resolve=>setTimeout(resolve,18));
    }
    const sample=await page.evaluate(()=>{
      const m=window.dynamicSample;
      cancelAnimationFrame(m.raf);
      return {longestFrameMs:Math.round(Math.max(0,...m.frames)),trustedClicks:m.trusted};
    });
    assert.equal(sample.trustedClicks,clicks.length);
    const ordered=clicks.slice().sort((a,b)=>a-b);
    samples.push({...sample,largestClickRoundtripMs:Math.round(ordered.at(-1)),p95ClickRoundtripMs:Math.round(ordered[Math.ceil(ordered.length*.95)-1])});
    await page.waitForFunction(()=>document.querySelectorAll('#measure-grid tx-t[data-tx-stage="final"]').length===768,null,{timeout:20000});
    assert.ok(await page.locator('#measure-grid').evaluate(grid=>[...grid.children].every(row=>row.querySelectorAll('tx-t').length===1)));
    await page.evaluate(()=>document.querySelector('#measure-grid').remove());
    await page.waitForTimeout(450);
  }
  console.log(JSON.stringify({visibleCells:768,windowMs:2200,samples},null,2));
} finally {
  await ctx?.close();
  await new Promise(resolve=>server.close(resolve));
}
