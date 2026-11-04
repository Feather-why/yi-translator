import {readFileSync} from 'node:fs';
const RELEASE_VERSION=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const extension = path.resolve(process.env.EXT_DIR || path.join(root, '.output/chrome-mv3'));
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work'));
const model = new URL(process.env.LLAMA_URL || 'http://127.0.0.1:8083');
assert.ok(['http:', 'https:'].includes(model.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(model.hostname));
assert.ok(!model.username && !model.password && !model.search && !model.hash);
assert.notEqual(model.port, '8081', '专项只连接独立临时模型，不使用日常8081服务');
const modelAddress = model.href.replace(/\/+$/, '').replace(/\/v1$/, '');
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, RELEASE_VERSION, '必须加载与当前源码一致的正式包');
const mixedPath = path.resolve(process.env.MIXED_PDF || path.join(root, 'tests/e2e/fixtures/mixed.pdf'));
const mixedBytes = await readFile(mixedPath);
const mixedSha256 = createHash('sha256').update(mixedBytes).digest('hex');
await mkdir(output, { recursive: true });
const temporaryRoot = await realpath(os.tmpdir());
const profile = await mkdtemp(path.join(temporaryRoot, 'translate-media-browser-'));
let context;

function createPdf({text,jpeg,width=640,height=160}) {
  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')];
  objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources ${jpeg?'<< /XObject << /Im0 5 0 R >> >>':'<< /Font << /F1 5 0 R >> >>'} /Contents 4 0 R >>`));
  const stream = Buffer.from(jpeg?`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`:`BT /F1 28 Tf 35 75 Td (${text}) Tj ET`);
  objects.push(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),stream,Buffer.from('\nendstream')]));
  objects.push(jpeg?Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,Buffer.from('\nendstream')]):Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  const parts=[Buffer.from('%PDF-1.4\n')]; const offsets=[0]; let length=parts[0].length;
  objects.forEach((object,index)=>{offsets.push(length);const part=Buffer.concat([Buffer.from(`${index+1} 0 obj\n`),object,Buffer.from('\nendobj\n')]);parts.push(part);length+=part.length;});
  parts.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return `data:application/pdf;base64,${Buffer.concat(parts).toString('base64')}`;
}

function checkMixedPdf(result) {
  assert.equal(result.pages.length, 1, '混合夹具只有一页');
  const page = result.pages[0];
  assert.equal(page.scanned, true, '有页眉页码的扫描正文仍应走真实 OCR');
  const native = page.paragraphs.filter(paragraph => !paragraph.id.includes('-ocr-'));
  const scanned = page.paragraphs.filter(paragraph => paragraph.id.includes('-ocr-'));
  assert.equal(native.length, 2, '原生文字层必须保留准确页眉和页码');
  assert.equal(native.filter(paragraph => paragraph.source === 'Chapter 2. Background').length, 1);
  assert.equal(native.filter(paragraph => paragraph.source === '12').length, 1);
  assert.ok(native.every(({box}) => box[3] < page.height * 0.12 || box[1] > page.height * 0.88));
  assert.ok(scanned.length >= 3, '真实 OCR 必须找回中部正文，段数不照搬假后端');
  const recognized = scanned.map(paragraph => paragraph.source).join(' ');
  assert.match(recognized, /translation\s+for\s+the\s+web/i);
  assert.match(recognized, /local\s+model/i);
  assert.match(recognized, /scanner\s+left/i);
  assert.equal(page.paragraphs.filter(paragraph => /chapter\s*2\.?\s*background/i.test(paragraph.source)).length, 1, '页眉不能同时来自原生文字和 OCR');
  assert.equal(page.paragraphs.filter(paragraph => paragraph.source.trim() === '12').length, 1, '页码不能重复');
  for (const paragraph of page.paragraphs) {
    const [x0,y0,x1,y1] = paragraph.box;
    assert.ok(paragraph.box.length === 4 && paragraph.box.every(Number.isFinite) && x0 >= 0 && y0 >= 0 && x1 > x0 && y1 > y0 && x1 <= page.width + 1 && y1 <= page.height + 1, '全部坐标必须使用 PDF 页面单位');
  }
  for (const paragraph of scanned) for (const existing of native) {
    const [x0,y0,x1,y1] = paragraph.box, [left,top,right,bottom] = existing.box;
    const area = Math.max(0, Math.min(x1,right)-Math.max(x0,left)) * Math.max(0, Math.min(y1,bottom)-Math.max(y0,top));
    assert.ok(area / Math.min((x1-x0)*(y1-y0),(right-left)*(bottom-top)) <= 0.4, 'OCR 不能与准确文字层重叠超过小框的40%');
  }
  return { nativeParagraphs: native.length, scannedParagraphs: scanned.length, recognized };
}

try {
  context = await chromium.launchPersistentContext(profile,{
    headless:process.env.HEADED!=='1',
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,...(process.env.BROWSER_LOG==='1'?['--enable-logging=stderr']:[])],
    ...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE,ignoreDefaultArgs:['--disable-extensions']}:{channel:'chromium'}),
  });
  context.on('page',page=>{page.on('pageerror',error=>console.error('Browser page error:',error.message));page.on('console',message=>{if(message.type()==='error')console.error('Browser error:',message.text());});});
  if(process.env.MEDIA_DIRECT_PAGE==='1')await context.addInitScript(()=>{const original=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=function(...args){const value=original.apply(this,args);window.mediaRaster=value;window.mediaRasterSize=[this.width,this.height];return value;};});
  // 回放固定官方权重的原始字节，减少重复下载；识别仍执行真实 CPU ONNX。
  const cachedModelUrls=[];
  for(const kind of ['det','rec']) {
    const name=`PP-OCRv5_mobile_${kind}_onnx_infer.tar`;const file=path.join(root,'work/media-model-cache',name);
    try { await access(file);const url=`https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/${name}`;await context.route(url,route=>route.fulfill({status:200,contentType:'application/octet-stream',path:file}));cachedModelUrls.push(url); }
    catch(error) { if(error.code!=='ENOENT')throw error; }
  }
  let [worker] = context.serviceWorkers();
  if(!worker) {
    try { worker=await context.waitForEvent('serviceworker',{timeout:15000}); }
    catch(error) { console.error('扩展后台未注册，请检查浏览器启动诊断与 manifest CSP。');throw error; }
  }
  const id = new URL(worker.url()).host;
  await isolateAutomaticWelcome(context,id);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/${process.env.MEDIA_DIRECT_PAGE==='1'?'offscreen.html':'options.html'}`);
  // Playwright 未将 offscreen 当作页面拦截，先从同源扩展页写真实模型缓存。
  if(cachedModelUrls.length===2)await page.evaluate(async(urls)=>{const cache=await caches.open('translate-ppocr-v5-mobile-v1');for(const url of urls){const response=await fetch(url,{credentials:'omit'});if(!response.ok)throw new Error('测试模型缓存失败');await cache.put(url,response);}},cachedModelUrls);
  if(process.env.MEDIA_DIRECT_PAGE!=='1')await worker.evaluate(async()=>{if(!await chrome.offscreen.hasDocument())await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS'],justification:'验证本地 OCR 和 PDF 后端推理'});});
  const senderPage=process.env.MEDIA_DIRECT_PAGE==='1'?await context.newPage():page;
  if(senderPage!==page)await senderPage.goto(`chrome-extension://${id}/options.html`);
  console.log('已加载真实媒体任务，开始模型下载与 OCR。');
  const task = async(name,payload)=>{
    const response=await senderPage.evaluate(({name,payload})=>chrome.runtime.sendMessage({target:'tx-offscreen',task:name,payload}),{name,payload});
    assert.equal(response?.ok,true,`${name}: ${JSON.stringify(response)}`);return response.data;
  };
  const fixture=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=160;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,640,160);ctx.fillStyle='black';ctx.font='bold 42px Arial';ctx.fillText('HELLO LOCAL MODEL',30,90);
    return{png:canvas.toDataURL('image/png'),jpeg:canvas.toDataURL('image/jpeg',0.95)};
  });
  const start=Date.now();const ocr=await task('media:ocr',{dataUrl:fixture.png});const ocrMs=Date.now()-start;
  await writeFile(path.join(output,'media-source.png'),Buffer.from(fixture.png.split(',')[1],'base64'));
  await writeFile(path.join(output,'media-ocr-actual.json'),JSON.stringify(ocr,null,2));
  assert.match(ocr.model,/PP-OCRv5_mobile/);assert.match(ocr.engine,/wasm-cpu/);
  const recognized=ocr.blocks.map(block=>block.text).join(' ').toUpperCase();assert.match(recognized,/HELLO\s*LOCAL\s*MODEL/);
  console.log('真实 OCR 文本断言通过，开始文字 PDF 与扫描 PDF。');
  assert.ok(ocr.blocks.every(block=>block.box.length===4&&block.confidence>0&&block.confidence<=1));
  const text=await task('media:pdf',{dataUrl:createPdf({text:'Hello local PDF model'}),documentId:'synthetic-text'});
  assert.equal(text.pages[0].scanned,false);assert.match(text.pages[0].paragraphs[0].source,/Hello local PDF model/);assert.equal(text.pages[0].paragraphs[0].box.length,4);
  const scanStart=Date.now();const scan=await task('media:pdf',{dataUrl:createPdf({jpeg:Buffer.from(fixture.jpeg.split(',')[1],'base64')}),documentId:'synthetic-scan'});const scanMs=Date.now()-scanStart;
  if(process.env.MEDIA_DIRECT_PAGE==='1') { const raster=await page.evaluate(()=>({data:window.mediaRaster,size:window.mediaRasterSize}));console.log('扫描页渲染尺寸',raster.size);if(raster.data)await writeFile(path.join(output,'media-scan-raster.png'),Buffer.from(raster.data.split(',')[1],'base64')); }
  assert.equal(scan.pages[0].scanned,true);assert.match(scan.pages[0].paragraphs.map(paragraph=>paragraph.source).join(' ').toUpperCase(),/HELLO\s*LOCAL\s*MODEL/);
  // 直接覆盖正式 offscreen 提取链路；不为验证去重额外翻译整页，以免增加大批模型请求。
  const mixedStart=Date.now();
  const mixed=await task('media:pdf',{dataUrl:`data:application/pdf;base64,${mixedBytes.toString('base64')}`,documentId:'mixed-'+mixedSha256,pages:[1]});
  const mixedMs=Date.now()-mixedStart;
  await writeFile(path.join(output,'media-mixed-actual.json'),JSON.stringify(mixed,null,2));
  const mixedChecks=checkMixedPdf(mixed);
  const rpc=async(name,payload)=>{const response=await senderPage.evaluate(({name,payload})=>chrome.runtime.sendMessage({rpc:name,payload}),{name,payload});assert.equal(response?.ok,true,`${name}: ${JSON.stringify(response?.error)}`);return response.data;};
  const ping=await rpc('ping');assert.match(ping.backend,/^0\.2\.10(?:-|$)/,'必须使用真后端正式包');
  await rpc('align:configure',{enabled:false});
  for(const provider of await rpc('providers:list'))if(provider.id!=='llamacpp'&&provider.enabled)await rpc('providers:save',{id:provider.id,enabled:false,config:provider.config});
  await rpc('providers:save',{id:'llamacpp',enabled:true,config:{url:modelAddress,key:process.env.LLAMA_API_KEY||''}});
  const subtitleInput=[{id:'later-id',text:'The children are reading a book.',startMs:1000,endMs:2500},{id:'earlier-id',text:'Please close the door.',startMs:3000,endMs:4500}];
  const subtitles=await rpc('subtitle:translate',{videoId:'synthetic-media-rpc',sourceLang:'en',targetLang:'zh-CN',segments:subtitleInput,mode:'fast',noCache:true});
  assert.deepEqual(subtitles.segments.map(({id,startMs,endMs})=>({id,startMs,endMs})),subtitleInput.map(({id,startMs,endMs})=>({id,startMs,endMs})));
  assert.ok(subtitles.segments.every(item=>item.provider==='llamacpp'&&/[\u4e00-\u9fff]/.test(item.text)&&!item.error),JSON.stringify(subtitles));
  const ocrRpc=await rpc('ocr:image',{dataUrl:fixture.png,translate:true,sourceLang:'en',targetLang:'zh-CN',mode:'fast',noCache:true});
  assert.ok(ocrRpc.blocks.some(block=>/[\u4e00-\u9fff]/.test(block.translation||'')));
  const pdfRpc=await rpc('pdf:translate',{dataUrl:createPdf({text:'Hello local PDF model'}),sourceLang:'en',targetLang:'zh-CN',mode:'fast',noCache:true});
  assert.ok(pdfRpc.pages[0].paragraphs.every(paragraph=>paragraph.provider==='llamacpp'&&/[\u4e00-\u9fff]/.test(paragraph.translation||'')));
  const report={extension,manifestVersion:manifest.version,backend:ping.backend,modelAddress,engine:ocr.engine,model:ocr.model,ocrMs,scanMs,mixedMs,recognized,ocrBlocks:ocr.blocks,textPdf:text,scannedPdf:scan,mixedPdf:{fixture:mixedPath,sha256:mixedSha256,checks:mixedChecks,result:mixed},rpc:{subtitles,ocr:ocrRpc,pdf:pdfRpc}};
  await writeFile(path.join(output,'media-browser-result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({ok:true,engine:ocr.engine,model:ocr.model,ocrMs,scanMs,mixedMs,recognized,textParagraphs:text.pages[0].paragraphs.length,scanParagraphs:scan.pages[0].paragraphs.length,mixed:mixedChecks,rpc:['subtitle:translate','ocr:image','pdf:translate'],provider:'llamacpp',report:path.join(output,'media-browser-result.json')}));
} finally {
  if(context)await context.close();
  if(path.dirname(path.resolve(profile))!==temporaryRoot||!path.basename(profile).startsWith('translate-media-browser-'))throw new Error('拒绝清理未经验证的测试资料夹');
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:150});
}
