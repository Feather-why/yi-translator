import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const build = path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled');
const { MediaService } = require(path.join(build, 'backend/media/index.js'));
const { MediaTaskRegistry } = require(path.join(build, 'backend/media/task-registry.js'));
const { PdfDocumentPool } = require(path.join(build, 'backend/media/pdf-pool.js'));
const { OcrRunner } = require(path.join(build, 'backend/media/ocr-runner.js'));
const { createRpcHandlers } = require(path.join(build, 'backend/rpc.js'));
const { BackendServices } = require(path.join(build, 'backend/services.js'));
const signal = () => new AbortController().signal;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };
const until = async (fn) => { for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('fixture did not become ready'); };
const cancelled = promise => assert.rejects(promise, { name: 'AbortError' });
const expired = promise => assert.rejects(promise, e => e.info?.code === 'bad_input' && e.info.message === 'PDF 会话已失效，请重新打开文档' && e.info.retryable);
const png = Buffer.alloc(24); png.set([137,80,78,71,13,10,26,10]); png.writeUInt32BE(100,16); png.writeUInt32BE(50,20);
const image = 'data:image/png;base64,' + png.toString('base64');
const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\nfixture').toString('base64');
const result = () => ({ width:100,height:50,blocks:[{text:'Example',confidence:.9,box:[[1,1],[30,1],[30,20],[1,20]]}] });
const page = (p = 1) => ({documentId:'',pages:[{page:p,width:100,height:200,paragraphs:[{id:`p${p}`,source:'Example',box:[1,2,30,20]}]}],warnings:[]});
const translation = async () => ({text:'示例',provider:'fixture',cached:false});

test('049 取消号按来源隔离，先到的 cancel 不会让旧请求复活，重复号不覆盖原任务', async () => {
  const tasks = new MediaTaskRegistry(), a = deferred(), b = deferred();
  const wait = (d) => async s => { s.addEventListener('abort', () => d.reject(s.reason), {once:true}); return d.promise; };
  const first = tasks.run('tab-1/doc-a', 'same', signal(), wait(a)), firstRejected = cancelled(first);
  const second = tasks.run('tab-2/doc-a', 'same', signal(), wait(b));
  await assert.rejects(tasks.run('tab-1/doc-a','same',signal(),translation), e => e.info?.code === 'bad_input');
  tasks.cancel('tab-1/doc-a','same'); await firstRejected;
  b.resolve('other owner completes'); assert.equal(await second,'other owner completes');
  await cancelled(tasks.run('tab-1/doc-a','same',signal(),translation));
  tasks.cancel('tab-1/doc-a','future');
  await cancelled(tasks.run('tab-1/doc-a','future',signal(),translation));
  assert.equal((await tasks.run('tab-1/doc-b','future',signal(),translation)).text,'示例');
  tasks.dispose();
});

test('049 同图共享 OCR：取消一方保留推理，最后一方取消才中止，取消结果不进入缓存', async t => {
  const calls = [], works = [];
  const service = new MediaService({translate:translation,offscreen:async(task,payload)=>{
    calls.push({task,payload}); if(task==='media:cancel') return {ok:true};
    const work=deferred(); works.push(work); return work.promise;
  }}); t.after(()=>service.dispose());
  const a=service.ocr({dataUrl:image,requestId:'a'},undefined,'one'), ar=cancelled(a);
  const b=service.ocr({dataUrl:image,requestId:'b'},undefined,'two'), br=cancelled(b);
  await until(()=>works.length===1); await new Promise(r=>setTimeout(r,15));
  service.cancel({requestId:'a'},'one'); await ar; assert.equal(calls.filter(c=>c.task==='media:cancel').length,0);
  service.cancel({requestId:'b'},'two'); await br; await flush();
  assert.equal(calls.filter(c=>c.task==='media:cancel').length,1);
  assert.equal(calls.at(-1).payload.taskId,calls[0].payload.taskId);
  works[0].resolve(result()); await flush();
  const next=service.ocr({dataUrl:image}); await until(()=>works.length===2); works[1].resolve(result());
  assert.equal((await next).blocks[0].text,'Example');
});

test('049 active OCR 真取消销毁原容器，队列取消不占下一轮，后续请求可新建', async () => {
  const calls=[], workers=[];
  const runner=new OcrRunner({create:()=>{const id=workers.length;const worker={initialize:async()=>{},predict:async(data,s)=>{
    calls.push([id,data]); if(data==='active') return new Promise((_r,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true})); return data;
  },destroy(){worker.destroyed=true;}}; workers.push(worker); return worker;}});
  try {
    const active=new AbortController(), queued=new AbortController();
    const a=runner.run('active',active.signal), ar=cancelled(a); await flush();
    const q=runner.run('queued',queued.signal), qr=cancelled(q); queued.abort(); await qr;
    const next=runner.run('next'); active.abort(); await ar;
    assert.equal(await next,'next'); assert.equal(workers[0].destroyed,true); assert.equal(workers.length,2);
    assert.deepEqual(calls,[[0,'active'],[1,'next']]);
  } finally { runner.dispose(); }
});

test('049 PDF 打开一次，逐页只传句柄；noCache 会话隔离，关闭后明确失效', async t => {
  let fetched=0; const calls=[], jobs=[];
  const service=new MediaService({fetch:async()=>{fetched++;return new Response(Buffer.from('%PDF-1.4\nfixture'));},translate:async job=>{jobs.push(job);return translation();},offscreen:async(task,payload)=>{
    calls.push({task,payload}); return task==='media:pdf:read'?page(payload.pages[0]):{ok:true};
  }}); t.after(()=>service.dispose());
  const opened=await service.openPdf({url:'https://fixture.test/document.pdf',noCache:true},'owner');
  for(const n of [1,2]) { const value=await service.pdf({...opened,pages:[n],sourceLang:'en',targetLang:'zh',requestId:`p${n}`},undefined,'owner'); assert.equal(value.pages[0].page,n); }
  assert.equal(fetched,1); assert.equal(calls.filter(c=>c.task==='media:pdf:open').length,1);
  assert.ok(calls.filter(c=>c.task==='media:pdf:read').every(c=>!('dataUrl'in c.payload)&&!('url'in c.payload)&&c.payload.documentHandle===opened.documentHandle));
  assert.ok(jobs.every(j=>j.noCache&&j.cacheNamespace===`pdf:${opened.documentId}`));
  await expired(service.pdf({...opened,pages:[1],sourceLang:'en',targetLang:'zh'},undefined,'stranger'));
  await service.closePdf(opened,'stranger'); assert.equal(calls.filter(c=>c.task==='media:pdf:close').length,0);
  await service.closePdf(opened,'owner'); await service.closePdf(opened,'owner');
  assert.equal(calls.filter(c=>c.task==='media:pdf:close').length,1);
  await expired(service.pdf({...opened,pages:[1],sourceLang:'en',targetLang:'zh'},undefined,'owner'));
});

test('049 PDF 关闭只取消该会话的在途页；其他会话仍然能读', async t => {
  const calls=[], waiting=deferred();
  const service=new MediaService({translate:translation,offscreen:async(task,payload)=>{
    calls.push({task,payload}); if(task==='media:pdf:read') return payload.pages[0]===1?waiting.promise:page(2); return {ok:true};
  }}); t.after(()=>service.dispose());
  const first=await service.openPdf({dataUrl:pdf},'owner'), second=await service.openPdf({dataUrl:pdf},'owner');
  assert.notEqual(first.documentHandle,second.documentHandle);
  const reading=service.pdf({...first,requestId:'p1',pages:[1],sourceLang:'en',targetLang:'zh'},undefined,'owner'), rejected=cancelled(reading);
  await until(()=>calls.some(c=>c.task==='media:pdf:read'));
  await service.closePdf(first,'owner'); await rejected;
  assert.equal(calls.filter(c=>c.task==='media:cancel').length,1);
  assert.equal((await service.pdf({...second,pages:[2],sourceLang:'en',targetLang:'zh'},undefined,'owner')).pages[0].page,2);
  waiting.resolve(page());
});

test('049 离屏重启/淘汰失效有明确可重试错误，重新打开恢复', async t => {
  let invalid=true, opens=0;
  const service=new MediaService({translate:translation,offscreen:async(task)=>{
    if(task==='media:pdf:open') opens++;
    return task==='media:pdf:read'?(invalid?{sessionExpired:true}:page()):{ok:true};
  }}); t.after(()=>service.dispose());
  const first=await service.openPdf({dataUrl:pdf});
  await expired(service.pdf({...first,pages:[1],sourceLang:'en',targetLang:'zh'}));
  invalid=false; const fresh=await service.openPdf({dataUrl:pdf});
  assert.equal((await service.pdf({...fresh,pages:[1],sourceLang:'en',targetLang:'zh'})).pages.length,1); assert.equal(opens,2);
});

test('049 PDF 内存池按字节/数量淘汰、TTL 释放，关闭取消正在使用的文档', async t => {
  t.mock.timers.enable({apis:['setTimeout'],now:0});
  const destroyed=[];let serial=0;
  const pool=new PdfDocumentPool({maxBytes:8,maxEntries:2,ttlMs:100,open:async()=>++serial,destroy:async value=>{destroyed.push(value);}});
  await pool.open('a',new Uint8Array(4)); await pool.open('b',new Uint8Array(4));
  assert.equal(await pool.use('a',signal(),async v=>v),1);
  await pool.open('c',new Uint8Array(4)); assert.deepEqual(destroyed,[2]); assert.equal(await pool.use('b',signal(),translation),undefined);
  const inUse=pool.use('a',signal(),async(_v,s)=>new Promise((_r,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true}))), rejected=cancelled(inUse); await flush();
  await pool.close('a'); await rejected; assert.deepEqual(destroyed,[2,1]);
  t.mock.timers.tick(101); await flush(); assert.equal(pool.size,0); assert.deepEqual(destroyed,[2,1,3]);
  await pool.dispose();
});

test('049 PDF 还未加载完时关闭，立即中止加载且不会漏掉迟到资源', async () => {
  const started=deferred(), unloaded=deferred();let aborted=false,destroyed=false;
  const pool=new PdfDocumentPool({open:async(_bytes,s)=>{s.addEventListener('abort',()=>{aborted=true;unloaded.reject(s.reason);},{once:true});started.resolve();return unloaded.promise;},destroy:async()=>{destroyed=true;}});
  const opening=pool.open('a',new Uint8Array(4)), rejected=cancelled(opening); await started.promise;
  await pool.close('a'); await rejected; assert.equal(aborted,true); assert.equal(pool.size,0); assert.equal(destroyed,false);
});

test('049 RPC 浏览器来源含 tab/frame/document，隐身打开强制 noCache，取消映射明确', async () => {
  const calls=[];globalThis.chrome={runtime:{id:'fixture',getURL:x=>'chrome-extension://fixture/'+x},storage:{local:{get:async()=>({})}}};
  const core={}, media={ocr:async(_request,_signal,owner)=>{calls.push(owner);throw new DOMException('cancel','AbortError');},pdf:async()=>page(),subtitles:async()=>({segments:[]}),cancel:async(req,owner)=>{calls.push(owner);return {ok:true};},openPdf:async(req,owner)=>{calls.push([req,owner]);return {documentHandle:'h',documentId:'id'};},closePdf:async()=>({ok:true})};
  const handlers=createRpcHandlers(core,{media});
  const sender={id:'fixture',tab:{id:4,incognito:true},frameId:0,documentId:'document-a',url:'https://example.test/'};
  await handlers['pdf:open']({dataUrl:pdf,noCache:false},sender); assert.equal(calls[0][0].noCache,true);
  await assert.rejects(handlers['ocr:image']({dataUrl:image,requestId:'x'},sender),e=>e.info?.code==='cancelled');
  await handlers['media:cancel']({requestId:'x'},sender); assert.equal(calls[1],calls[2]);
  await handlers['media:cancel']({requestId:'x'},{...sender,documentId:'document-b'}); assert.notEqual(calls[2],calls[3]);
  await assert.rejects(handlers['pdf:close']({documentHandle:'h'},{...sender,id:'foreign'}),e=>e.info?.code==='auth');
  const capabilities=BackendServices.prototype.capabilities.call({dictionary:{status:()=>({})},alignment:{status:()=>({})},sync:{status:()=>({})},media});
  assert.equal(capabilities.media.cancel,true); assert.equal(capabilities.media.pdfSessions,true);
  const legacy=BackendServices.prototype.capabilities.call({dictionary:{status:()=>({})},alignment:{status:()=>({})},sync:{status:()=>({})},media:{ocr(){},pdf(){}}});
  assert.equal('cancel'in legacy.media,false);assert.equal('pdfSessions'in legacy.media,false);
});

test('049 PDF 打开并发有界，拒绝额外上传，释放后仍可继续打开', async t => {
  const gate=deferred();let calls=0;
  const service=new MediaService({translate:translation,offscreen:async task=>{if(task==='media:pdf:open'){calls++;await gate.promise;}return {ok:true};}});t.after(()=>service.dispose());
  const pending=[service.openPdf({dataUrl:pdf}),service.openPdf({dataUrl:pdf}),service.openPdf({dataUrl:pdf})];
  await assert.rejects(service.openPdf({dataUrl:pdf}),e=>e.info?.code==='rate_limit');
  await until(()=>calls===3);gate.resolve();const opened=await Promise.all(pending);
  assert.equal(new Set(opened.map(x=>x.documentHandle)).size,3);
  const next=await service.openPdf({dataUrl:pdf});assert.equal(calls,4);
  assert.equal((await service.closePdf(next)).ok,true);
});

test('049 PDF 已完成提取后关闭也会中止译文生成，不再发往后续批次', async t => {
  const active=deferred();let cancelledProvider=false,translated=0;
  const service=new MediaService({offscreen:async task=>task==='media:pdf:read'?{...page(),pages:[{...page().pages[0],paragraphs:Array.from({length:12},(_,n)=>({id:'p'+n,source:'Example',box:[1,2,30,20]}))}]}:{ok:true},
    translate:async(_job,_segment,_tier,s)=>{translated++;active.resolve();return new Promise((_r,reject)=>s.addEventListener('abort',()=>{cancelledProvider=true;reject(s.reason);},{once:true}));}});t.after(()=>service.dispose());
  const opened=await service.openPdf({dataUrl:pdf});const reading=service.pdf({...opened,requestId:'translating',pages:[1],sourceLang:'en',targetLang:'zh'}), rejected=cancelled(reading);
  await active.promise;await service.closePdf(opened);await rejected;
  assert.equal(cancelledProvider,true);assert.equal(translated,8);
});
