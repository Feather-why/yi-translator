/** 正式后台 + 真实本地 OCR；仅翻译 HTTP 使用确定性本机响应，独立浏览器资料夹。 */
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const extension=path.resolve(process.env.EXT_DIR||path.join(root,'.output/chrome-mv3'));
const output=path.resolve(process.env.REPORT_DIR||path.join(root,'work/media-reader-049'));
assert.ok(process.env.OCR_MODEL_CACHE,'必须提供本机已有 OCR 权重，测试不会下载');
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
assert.equal(manifest.version,'0.2.13');
await mkdir(output,{recursive:true});
const tmp=await realpath(os.tmpdir()),profile=await mkdtemp(path.join(tmp,'translate-media-049-'));
const files=new Map();let fail=false,delay=0,requests=0,context;
const server=http.createServer(async(req,res)=>{
  res.setHeader('access-control-allow-origin','*');
  const pathname=new URL(req.url,'http://fixture').pathname;
  if(files.has(pathname)){res.writeHead(200,{'content-type':'application/pdf'});res.end(files.get(pathname));return;}
  if(pathname==='/health'){res.setHeader('content-type','application/json');res.end('{"status":"ok"}');return;}
  if(pathname==='/v1/chat/completions'){
    requests++;for await(const _ of req){};
    const failing=fail, wait=delay;if(wait)await new Promise(r=>setTimeout(r,wait));
    if(failing){res.writeHead(400,{'content-type':'application/json'});res.end('{"error":{"message":"fixture translation failure"}}');}
    else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'这是用于验证翻译和分页恢复的测试文本。'},finish_reason:'stop'}]}));}return;
  }
  res.writeHead(404);res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;

function pdf(pages,{jpeg,width=600,height=800}={}){
  const objects=[null,Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),null];const ids=[];
  const fontOrImage=3;objects.push(jpeg?Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,Buffer.from('\nendstream')]):Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  for(let i=0;i<pages;i++){
    const page=objects.length,content=page+1;ids.push(page);
    const resources=jpeg?`<< /XObject << /Im0 ${fontOrImage} 0 R >> >>`:`<< /Font << /F1 ${fontOrImage} 0 R >> >>`;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources ${resources} /Contents ${content} 0 R >>`));
    const text=`BT /F1 18 Tf 35 700 Td (This is a complete sentence on document page ${i+1}.) Tj 0 -36 Td (The local reader preserves its translation after returning.) Tj ET`;
    const stream=Buffer.from(jpeg?`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`:text);
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),stream,Buffer.from('\nendstream')]));
  }
  objects[2]=Buffer.from(`<< /Type /Pages /Kids [${ids.map(n=>n+' 0 R').join(' ')}] /Count ${pages} >>`);
  const parts=[Buffer.from('%PDF-1.4\n')],offsets=[0];let length=parts[0].length;
  for(let i=1;i<objects.length;i++){offsets[i]=length;const part=Buffer.concat([Buffer.from(`${i} 0 obj\n`),objects[i],Buffer.from('\nendobj\n')]);parts.push(part);length+=part.length;}
  parts.push(Buffer.from(`xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));return Buffer.concat(parts);
}
const results=[],measurements={};
async function check(name,fn){const at=Date.now();await fn();results.push({name,ms:Date.now()-at});console.log('✓',name);}
try{
 context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:1200,height:820},locale:'zh-CN',args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE,ignoreDefaultArgs:['--disable-extensions']}:{channel:'chromium'})});
 const browserErrors=[];context.on('page',p=>p.on('pageerror',e=>browserErrors.push(e.message)));
 const modelUrls=[],hashes={det:'781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30',rec:'f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c'};
 for(const kind of ['det','rec']){const name=`PP-OCRv5_mobile_${kind}_onnx_infer.tar`,file=path.join(process.env.OCR_MODEL_CACHE,name);assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hashes[kind]);const url='https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/'+name;modelUrls.push(url);await context.route(url,r=>r.fulfill({path:file,status:200,contentType:'application/octet-stream'}));}
 await context.addInitScript(()=>{
  if(location.protocol!=='chrome-extension:')return;
  window.__mediaTrace=[];window.__printCalls=0;window.print=()=>window.__printCalls++;
  const original=chrome.runtime.sendMessage.bind(chrome.runtime);window.__rawSend=original;
  chrome.runtime.sendMessage=async(...args)=>{const m=args[0];const entry=m?.rpc?.startsWith('pdf:')||m?.rpc==='media:cancel'?{name:m.rpc,payload:{...m.payload,dataUrl:m.payload?.dataUrl?'[PDF bytes]':undefined},at:Date.now()}:null;if(entry)window.__mediaTrace.push(entry);try{const r=await original(...args);if(entry){entry.ok=r?.ok;entry.data=r?.data?.documentHandle?{documentHandle:r.data.documentHandle}:undefined;entry.error=r?.error;}return r;}catch(e){if(entry)entry.rejected=String(e);throw e;}};
 });
 let[sw]=context.serviceWorkers();sw??=await context.waitForEvent('serviceworker');const id=new URL(sw.url()).host;await isolateAutomaticWelcome(context,id);
 const setup=await context.newPage();await setup.goto(`chrome-extension://${id}/options.html#providers`);
 const rpc=async(name,payload)=>{const r=await setup.evaluate(({name,payload})=>chrome.runtime.sendMessage({rpc:name,payload}),{name,payload});assert.equal(r?.ok,true,`${name}: ${JSON.stringify(r?.error)}`);return r.data;};
 await setup.evaluate(async(urls)=>{const c=await caches.open('translate-ppocr-v5-mobile-v1');for(const url of urls){const r=await fetch(url);if(!r.ok)throw Error('Cannot seed offline OCR cache');await c.put(url,r);}},modelUrls);
 const ping=await rpc('ping');assert.notEqual(ping.backend,'mock');assert.equal((await rpc('backend:capabilities')).protocol,3);
 await rpc('align:configure',{enabled:false});for(const p of await rpc('providers:list'))if(p.enabled)await rpc('providers:save',{id:p.id,enabled:false,config:p.config});
 await rpc('providers:save',{id:'llamacpp',enabled:true,config:{url:base}});
 await setup.evaluate(()=>chrome.storage.local.set({'settings.ui':{sourceLang:'en',targetLang:'zh-CN',mode:'fast',loadingEffect:'dots',sensitive:['127.0.0.1']}}));
 const jpg=await setup.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=800;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,600,800);x.fillStyle='black';x.font='26px Arial';x.fillText('HELLO LOCAL READER',35,160);x.fillText('This is scanned document text.',35,205);return c.toDataURL('image/jpeg',.95).split(',')[1];});
 files.set('/scan.pdf',pdf(2,{jpeg:Buffer.from(jpg,'base64')}));files.set('/native.pdf',pdf(1));files.set('/long.pdf',pdf(20));
 const page=await context.newPage();page.setDefaultTimeout(15_000);
 const open=async(url)=>page.goto(`chrome-extension://${id}/pdf.html?debug&url=${encodeURIComponent(url)}`);
 const state=async()=>page.evaluate(()=>window.__txPdf?.shells.map(s=>({n:s.n,state:s.state,total:s.total,ok:s.ok,failed:s.failed,pageFailed:s.pageFailed,evicted:s.evicted,canvas:!!s.canvas,paras:s.paras.length})));
 fail=true;
 await check('扫描 PDF 失败计数与页级错误，不冒充翻译成功/原样保留',async()=>{
  await open(base+'/scan.pdf');await page.waitForFunction(()=>window.__txPdf?.shells[0].state==='done'&&window.__txPdf.shells[0].pageFailed,null,{timeout:120_000});
  const first=(await state())[0];measurements.failedScan=first;assert.ok(first.total>0&&first.failed>0);assert.equal(process.env.PROVISIONAL_OLD_BUILD ? (first.ok ?? 0) : first.ok,0);assert.match(await page.locator('.bar .meta').innerText(),/0 页|0 translated/);
  assert.ok(await page.locator('.pg[data-page="1"] .fail .linkbtn').count());await page.screenshot({path:path.join(output,'scanned-failure.png')});
 });
 await check('打印遇到失败页不会自动打印，保留页级重试',async()=>{
  await page.getByRole('button',{name:'打印 / 存 PDF',exact:true}).click();await page.getByRole('button',{name:'开始翻译',exact:true}).click();await page.locator('.modal').waitFor({state:'detached',timeout:120_000});
  assert.equal(await page.evaluate(()=>window.__printCalls),0);
 });
 fail=false;
 await check('扫描页重试成功，成功段数与已翻译页数真实更新，文档只打开一次',async()=>{
  await page.locator('.pg[data-page="1"] .fail .linkbtn').click();await page.waitForFunction(()=>{const s=window.__txPdf.shells[0];return s.state==='done'&&s.ok>0&&!s.pageFailed;},null,{timeout:120_000});
  const first=(await state())[0];measurements.retriedScan=first;assert.equal(first.ok,first.total);assert.equal(first.failed,0);
  const trace=await page.evaluate(()=>window.__mediaTrace);assert.equal(trace.filter(t=>t.name==='pdf:open').length,1);assert.ok(trace.filter(t=>t.name==='pdf:translate').every(t=>t.payload.documentHandle&&!t.payload.dataUrl&&t.payload.noCache));
  await page.waitForTimeout(350);await page.screenshot({path:path.join(output,'scanned-retry-success.png')});
 });
 await check('后端句柄失效后透明重开一次，第二页仍可完成',async()=>{
  await page.evaluate(async()=>{const t=window.__mediaTrace.findLast(t=>t.name==='pdf:open'&&t.ok);await window.__rawSend({rpc:'pdf:close',payload:{documentHandle:t.data.documentHandle}});});
  await page.locator('.pg[data-page="2"] .fail .linkbtn').click();await page.waitForFunction(()=>{const s=window.__txPdf.shells[1];return s.state==='done'&&s.ok>0&&!s.pageFailed;},null,{timeout:120_000});
  assert.equal((await page.evaluate(()=>window.__mediaTrace)).filter(t=>t.name==='pdf:open').length,2);
 });
 await check('切换文件释放旧页面画布和文档，旧任务不能污染新文档',async()=>{
  await page.evaluate(()=>window.__oldShells=window.__txPdf.shells);await page.getByRole('button',{name:'打开其他文件',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__oldShells.every(s=>!s.canvas&&!s.sheet&&s.paras.length===0)),true);
  assert.equal(await page.evaluate(()=>window.__txPdf===undefined),true);
  const trace=await page.evaluate(()=>window.__mediaTrace);assert.ok(trace.some(t=>t.name==='pdf:close'));
  await page.locator('input[type=url]').fill(base+'/native.pdf');await page.getByRole('button',{name:'打开',exact:true}).click();
  await page.locator('.pg[data-page="1"] .tp[data-stage="final"]').first().waitFor({timeout:60_000});
  await page.keyboard.press('Control+=');assert.equal(await page.locator('.zoom .z').innerText(),'110%');
 });
 await check('长 PDF 远页画布有界，返回旧页复用译文而不重新请求翻译',async()=>{
  await open(base+'/long.pdf');await page.waitForFunction(()=>window.__txPdf?.shells[0].state==='done');
  assert.ok((await state()).filter(s=>s.state!=='idle').length<10,'首屏不应处理整本20页');
  for(const n of [4,7,10,13,16,20]){await page.getByRole('spinbutton',{name:'页码',exact:true}).fill(String(n));await page.getByRole('spinbutton',{name:'页码',exact:true}).press('Enter');await page.waitForFunction(n=>{const s=window.__txPdf.shells[n-1];return s.state==='done'&&s.canvas;},n,{timeout:60_000});}
  await page.waitForTimeout(700);const far=await state();measurements.longResidentPages=far.filter(s=>s.canvas).length;assert.ok(far.filter(s=>s.canvas).length<=8,JSON.stringify(far));assert.equal(far[0].evicted,true);
  const before=requests;await page.getByRole('spinbutton',{name:'页码',exact:true}).fill('1');await page.getByRole('spinbutton',{name:'页码',exact:true}).press('Enter');await page.waitForFunction(()=>{const s=window.__txPdf.shells[0];return s.state==='done'&&s.canvas&&!s.evicted;});
  assert.ok(await page.locator('.pg[data-page="1"] .tp[data-stage="final"]').count());measurements.restoreTranslationRequests=requests-before;assert.equal(requests,before,'恢复已有页不能新增翻译请求');await page.screenshot({path:path.join(output,'long-pdf-restored.png')});
 });
 await check('文档关闭时取消正在等待的扫描翻译，延迟回包不重建旧界面',async()=>{
  delay=1800;await open(base+'/scan.pdf');await page.waitForFunction(()=>window.__mediaTrace.some(t=>t.name==='pdf:translate'&&!('ok' in t)),null,{timeout:60_000});
  await page.evaluate(()=>window.__oldShells=window.__txPdf.shells);await page.getByRole('button',{name:'打开其他文件',exact:true}).click();await page.waitForTimeout(2200);
  assert.equal(await page.locator('.pages').count(),0);assert.equal(await page.locator('.empty').count(),1);assert.ok((await page.evaluate(()=>window.__mediaTrace)).some(t=>t.name==='media:cancel'));assert.equal(await page.evaluate(()=>window.__oldShells.every(s=>!s.canvas&&!s.sheet&&s.paras.length===0)),true);delay=0;
 });
 assert.deepEqual(browserErrors,[]);await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,manifest:manifest.version,ping,requests,results,measurements,browserErrors},null,2));console.log(JSON.stringify({ok:true,results:results.length,requests,output}));
}catch(e){await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(e),stack:e.stack,results,requests},null,2));throw e;}
finally{await context?.close();await new Promise(r=>server.close(r));if(path.dirname(path.resolve(profile))!==tmp||!path.basename(profile).startsWith('translate-media-049-'))throw Error('Unexpected profile path');await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:150});}
