import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), ts=require('typescript');
const source=await readFile(new URL('../../src/entrypoints/offscreen/media.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const flush=async()=>{for(let n=0;n<120;n++)await Promise.resolve();};
const pdf='data:application/pdf;base64,'+Buffer.from('%PDF-1.4\nfixture').toString('base64');

function load(t) {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
  const frames=[],ocrCalls=[],pdfCalls={load:0,destroy:0,pages:[],cleanup:[]};let blockOcr=true,blockText=false;
  class Channel {
    constructor(){this.port1={onmessage:null,closed:false,close(){this.closed=true;}};this.port2={close(){},reply:data=>{if(!this.port1.closed)queueMicrotask(()=>this.port1.onmessage?.({data}));}};}
  }
  const ocrResult={width:10,height:10,blocks:[]};
  const document={createElement:kind=>{
    assert.equal(kind,'iframe');
    const frame={removed:false,remove(){this.removed=true;},contentWindow:{postMessage(message,_origin,ports){
      ocrCalls.push(message);
      if(message.task==='predict'&&blockOcr)return;
      ports[0].reply({id:message.id,ok:true,data:message.task==='init'?{ready:true}:ocrResult});
    }}};frames.push(frame);return frame;
  },body:{append:frame=>queueMicrotask(()=>frame.onload?.())}};
  const hashes=['781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30','f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c'];
  const pdfjs={GlobalWorkerOptions:{},Util:{transform:(_viewport,item)=>item},getDocument:()=>{
    pdfCalls.load++;
    return {promise:Promise.resolve({numPages:250,getPage:async number=>{
      pdfCalls.pages.push(number);
      return {getViewport:()=>({width:600,height:800,transform:[]}),getTextContent:async()=>blockText?new Promise(()=>{}):({items:[{str:'Document body example',width:200,transform:[12,0,0,12,50,400]}]}),cleanup:()=>pdfCalls.cleanup.push(number)};
    }}),destroy:async()=>{pdfCalls.destroy++;}};
  }};
  const filename=path.join(path.resolve(process.env.BACKEND_BUILD_DIR||'tests/.compiled'),'entrypoints/offscreen/media.js'), localRequire=createRequire(filename), exports={};
  vm.runInNewContext(code,{exports,module:{exports},require:name=>name==='pdfjs-dist'?pdfjs:localRequire(name),document,MessageChannel:Channel,
    chrome:{runtime:{getURL:file=>'chrome-extension://fixture/'+file}},
    caches:{open:async()=>({match:async url=>{const bytes=new Uint8Array(1024);bytes[0]=url.includes('_det_')?0:1;return new Response(bytes);},put:async()=>{},delete:async()=>{}})},
    crypto:{randomUUID,subtle:{digest:async(_algorithm,data)=>Uint8Array.from(hashes[new Uint8Array(data)[0]].match(/../g),x=>parseInt(x,16)).buffer}},
    fetch:()=>{throw new Error('接线回放禁止下载');},Response,Uint8Array,AbortSignal,AbortController,DOMException,Date,setTimeout,clearTimeout,console,atob}, {filename});
  const tasks={};exports.registerMediaTasks(tasks);
  return {tasks,frames,ocrCalls,pdfCalls,unblock:()=>{blockOcr=false;},blockText:()=>{blockText=true;},advance:async ms=>{t.mock.timers.tick(ms);await flush();}};
}

test('049 生产离屏取消 RPC 移除 active iframe、跳过 queued OCR，下一张图正常重新初始化',async t=>{
  const h=load(t);
  const first=h.tasks['media:ocr']({taskId:'first',dataUrl:'data:image/png;base64,Zmlyc3Q='}), firstRejected=assert.rejects(first,{name:'AbortError'});
  await flush();assert.equal(h.ocrCalls.filter(c=>c.task==='predict').length,1);
  const queued=h.tasks['media:ocr']({taskId:'queued',dataUrl:'data:image/png;base64,cXVldWVk'}), queuedRejected=assert.rejects(queued,{name:'AbortError'});
  await h.tasks['media:cancel']({taskId:'queued'});await queuedRejected;
  await h.tasks['media:cancel']({taskId:'first'});await firstRejected;await flush();
  assert.equal(h.frames[0].removed,true);h.unblock();
  await h.tasks['media:ocr']({taskId:'next',dataUrl:'data:image/png;base64,bmV4dA=='});
  assert.equal(h.frames.length,2);assert.equal(h.ocrCalls.filter(c=>c.task==='predict').length,2);
  await h.advance(600_000);assert.equal(h.frames[1].removed,true);
});

test('049 生产离屏 PDF 会话只解析一次，页码可超过 200，关闭一次销毁并回传失效',async t=>{
  const h=load(t);await h.tasks['media:pdf:open']({taskId:'open',documentHandle:'document',dataUrl:pdf});
  for(const n of [1,249]){
    const result=await h.tasks['media:pdf:read']({taskId:'page-'+n,documentHandle:'document',pages:[n],documentId:'digest'});
    assert.equal(result.pages[0].page,n);assert.equal(result.pages[0].paragraphs[0].source,'Document body example');
  }
  assert.equal(h.pdfCalls.load,1);assert.equal(h.pdfCalls.destroy,0);assert.deepEqual(h.pdfCalls.cleanup,[1,249]);
  await h.tasks['media:pdf:close']({documentHandle:'document'});await h.tasks['media:pdf:close']({documentHandle:'document'});
  assert.equal(h.pdfCalls.destroy,1);
  const expired=await h.tasks['media:pdf:read']({taskId:'expired',documentHandle:'document',pages:[1]});assert.equal(expired.sessionExpired,true);
});

test('049 生产离屏 PDF 关闭中止未完成文本提取并清理该页，TTL 会销毁闲置文档',async t=>{
  const h=load(t);await h.tasks['media:pdf:open']({taskId:'open',documentHandle:'document',dataUrl:pdf});h.blockText();
  const reading=h.tasks['media:pdf:read']({taskId:'page',documentHandle:'document',pages:[1]}), rejected=assert.rejects(reading,{name:'AbortError'});
  await flush();await h.tasks['media:pdf:close']({documentHandle:'document'});await rejected;
  assert.equal(h.pdfCalls.destroy,1);assert.deepEqual(h.pdfCalls.cleanup,[1]);
  await h.tasks['media:pdf:open']({taskId:'open-next',documentHandle:'next',dataUrl:pdf});await h.advance(300_001);
  assert.equal(h.pdfCalls.destroy,2);
  assert.equal((await h.tasks['media:pdf:read']({taskId:'old',documentHandle:'next',pages:[1]})).sessionExpired,true);
});
