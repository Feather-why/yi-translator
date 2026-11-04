import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MediaService } = require('../.compiled/backend/media/index.js');
const { loadMedia, MAX_IMAGE_BYTES } = require('../.compiled/backend/media/input.js');
const { groupPdfText } = require('../.compiled/backend/media/pdf-layout.js');
const signal = () => new AbortController().signal;
const pdf = (suffix = '') => `data:application/pdf;base64,${Buffer.from('%PDF-1.4\nsynthetic contract fixture' + suffix).toString('base64')}`;
const png = Buffer.alloc(24); png.set([137,80,78,71,13,10,26,10]); png.writeUInt32BE(100,16); png.writeUInt32BE(50,20);
const image = `data:image/png;base64,${png.toString('base64')}`;
const translation = { text: '译文', provider: 'fixture', cached: false };

test('媒体输入校验魔数、像素、协议、凭据和上限，HTTP 不带网站 cookie', async () => {
  await assert.rejects(loadMedia({ url:'file:///a' },'image',fetch,signal()), /HTTP/);
  await assert.rejects(loadMedia({ url:'https://user:pass@example.test/a' },'image',fetch,signal()), /HTTP/);
  await assert.rejects(loadMedia({ dataUrl:pdf() },'image',fetch,signal()), /仅支持/);
  await assert.rejects(loadMedia({ url:'https://example.test/image' },'image',async () => new Response('x',{headers:{'content-length':String(MAX_IMAGE_BYTES + 1)}}),signal()), /大小/);
  const huge = Buffer.from(png); huge.writeUInt32BE(1000000,16);
  await assert.rejects(loadMedia({dataUrl:`data:image/png;base64,${huge.toString('base64')}`},'image',fetch,signal()), /像素/);
  let init;
  const value = await loadMedia({url:'https://example.test/image'},'image',async (_url, options) => { init = options; return new Response(png); },signal());
  assert.equal(init.credentials,'omit'); assert.equal(init.redirect,'error'); assert.equal(value.mime,'image/png');
});

test('字幕保持逐行 id、顺序、时间，按八行分批并隔离视频缓存', async () => {
  const calls = []; let active = 0; let max = 0;
  const service = new MediaService({translate:async (job, segment) => { active++; max=Math.max(active,max); calls.push({job,segment}); await new Promise(resolve=>setTimeout(resolve,5)); active--; return {...translation,text:`译:${segment.text}`}; }});
  const segments = Array.from({length:11},(_,index)=>({id:`id${index}`,text:index===4?'':'line'+index,startMs:index*1000,endMs:index*1000+500}));
  const result = await service.subtitles({videoId:'video-a',segments,sourceLang:'en',targetLang:'zh-CN',noCache:true});
  assert.deepEqual(result.segments.map(({id,startMs,endMs})=>({id,startMs,endMs})),segments.map(({id,startMs,endMs})=>({id,startMs,endMs})));
  assert.deepEqual(result.segments.map(x=>x.source),segments.map(x=>x.text));
  assert.equal(result.segments[4].text,''); assert.equal(calls.length,10); assert.ok(max<=8);
  assert.ok(calls.every(({job})=>job.noCache && job.cacheNamespace==='subtitle:video-a' && job.context.summary.includes('line')));
  assert.equal(calls[0].segment.kind,'subtitle');
});

test('字幕重复 id、倒置时间拒绝，单行失败仍保留原始编号和时间', async () => {
  const service = new MediaService({translate:async()=>{ throw new Error('fixture'); }});
  await assert.rejects(service.subtitles({videoId:'v',sourceLang:'en',targetLang:'zh',segments:[{id:'a',text:'a'},{id:'a',text:'b'}]}),/字幕编号/);
  await assert.rejects(service.subtitles({videoId:'v',sourceLang:'en',targetLang:'zh',segments:[{id:'a',text:'a',startMs:20,endMs:10}]}),/字幕编号/);
  const result = await service.subtitles({videoId:'v',sourceLang:'en',targetLang:'zh',segments:[{id:'a',text:'a',startMs:10,endMs:20}]});
  assert.equal(result.segments[0].error.code,'internal'); assert.equal(result.segments[0].text,'a'); assert.equal(result.segments[0].startMs,10);
});

test('OCR 真实引擎接口返回四边形和置信度，翻译转交调度器并传 noCache', async () => {
  const calls = [];
  const service = new MediaService({offscreen:async (task,payload)=>{ assert.equal(task,'media:ocr'); assert.ok(payload.dataUrl.startsWith('data:image/png')); return {width:100,height:50,engine:'contract-boundary-only',model:'fixture',blocks:[{text:'Hello',confidence:0.9,box:[[1,2],[40,2],[40,20],[1,20]]}]}; },translate:async(job,segment)=>{calls.push({job,segment});return translation;}});
  const result = await service.ocr({dataUrl:image,translate:true,targetLang:'zh-CN',noCache:true});
  assert.equal(result.blocks[0].translation,'译文'); assert.equal(calls[0].job.noCache,true); assert.match(calls[0].job.cacheNamespace,/^ocr:[a-f0-9]{64}$/);
  assert.equal(result.blocks[0].box.length,4); assert.equal(result.blocks[0].confidence,0.9);
});

test('取消等待 offscreen 时立即结束，不进行后续翻译', async () => {
  const controller = new AbortController(); let translated = false;
  const service = new MediaService({offscreen:()=>new Promise(()=>{}),translate:async()=>{translated=true;return translation;}});
  const work = service.ocr({dataUrl:image,translate:true,targetLang:'zh'},controller.signal); setTimeout(()=>controller.abort(),5);
  await assert.rejects(work,{name:'AbortError'}); assert.equal(translated,false);
});

test('PDF 使用内容 SHA256 隔离缓存，页码和坐标保持，noCache 传到调度器', async () => {
  const calls = []; const inputs = [];
  const service = new MediaService({offscreen:async(task,payload)=>{ assert.equal(task,'media:pdf'); inputs.push(payload); return {documentId:'wrong',pages:[{page:2,width:200,height:300,scanned:false,paragraphs:[{id:'p2-0',source:'Hello',box:[1,2,30,40]}]}],warnings:[]};},translate:async(job)=>{calls.push(job);return translation;}});
  const first = await service.pdf({dataUrl:pdf(),pages:[2],sourceLang:'en',targetLang:'zh',noCache:true});
  const second = await service.pdf({dataUrl:pdf('different'),pages:[2],sourceLang:'en',targetLang:'zh'});
  assert.match(first.documentId,/^[a-f0-9]{64}$/); assert.notEqual(first.documentId,second.documentId);
  assert.equal(calls[0].cacheNamespace,`pdf:${first.documentId}`); assert.equal(calls[0].noCache,true);
  assert.equal(first.pages[0].paragraphs[0].translation,'译文'); assert.deepEqual(first.pages[0].paragraphs[0].box,[1,2,30,40]); assert.deepEqual(inputs[0].pages,[2]);
});

test('PDF 文本按行合并，同高远列保持分离', () => {
  const paragraphs = groupPdfText([{text:'Hello',box:[10,10,45,20]},{text:'world',box:[48,10,80,20]},{text:'Right column',box:[300,10,390,20]}],1);
  assert.equal(paragraphs.length,2); assert.equal(paragraphs[0].source,'Hello world'); assert.equal(paragraphs[1].source,'Right column');
});
