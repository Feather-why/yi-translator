import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript');
const root = new URL('../../', import.meta.url);
const source = async (file) => readFile(new URL('src/' + file, root), 'utf8');
const compile = (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function named(code, name) {
  const file = ts.createSourceFile('fixture.ts', code, ts.ScriptTarget.Latest, true); let found;
  const walk = (node) => { if (node.name?.text === name && (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node))) found = node; else ts.forEachChild(node, walk); };
  walk(file); assert.ok(found, name); return found.getText(file).replace(/^export\s+/, '');
}
function evaluate(code, name, env = {}) {
  return vm.runInNewContext(compile(code) + `\n${name}`, { console, AbortController, DOMException, setTimeout, clearTimeout, Uint8Array, ...env });
}
const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise,resolve,reject }; };
const tick = () => new Promise((r) => setTimeout(r,0));
const readerSource = await source('frontend/pdf/reader.ts');
const imageSource = await source('frontend/media/images.ts');
const docSource = await source('frontend/pdf/backend-document.ts');
const lifeSource = await source('frontend/pdf/lifetime.ts');

test('PDF 文档会话：并发页只上传一次，页请求只含句柄，noCache 贯穿打开和翻译', async () => {
  const opening = defer(), calls=[];
  const call=async (name,input)=>{calls.push([name,input]);if(name==='pdf:open') return opening.promise;if(name==='pdf:translate')return {pages:[]};return {ok:true};};
  const Doc=evaluate(named(docSource,'PdfBackendDocument'),'PdfBackendDocument',{rpc:call,uid:()=>Math.random().toString(),EXPIRED:'PDF 会话已失效，请重新打开文档'});
  const doc=new Doc({dataUrl:'private PDF'}, {pdfSessions:true,cancel:true},true,call);
  const jobs=[1,2,3].map(n=>doc.translate({pages:[n],sourceLang:'en',targetLang:'zh-CN'}));
  assert.equal(calls.filter(([n])=>n==='pdf:open').length,1);
  opening.resolve({documentHandle:'h1',documentId:'d1'});await Promise.all(jobs);
  const pages=calls.filter(([n])=>n==='pdf:translate'); assert.equal(pages.length,3);
  assert.ok(pages.every(([,p])=>p.documentHandle==='h1' && p.noCache===true && !('dataUrl' in p)));
  assert.equal(calls[0][1].noCache,true);doc.close();doc.close();await tick();
  assert.equal(calls.filter(([n])=>n==='pdf:close').length,1);
});

test('PDF 旧后端不调用新 RPC；丢失会话仅按约定错误透明重开一次', async () => {
  let opens=0, attempts=0; const calls=[];
  const call=async(name,p)=>{calls.push([name,p]);if(name==='pdf:open')return {documentHandle:'h'+(++opens),documentId:'d'};if(name==='pdf:translate'){attempts++;if(attempts===1)throw {info:{code:'bad_input',message:'PDF 会话已失效，请重新打开文档',retryable:true}};return {pages:[]};}return {ok:true};};
  const Doc=evaluate(named(docSource,'PdfBackendDocument'),'PdfBackendDocument',{rpc:call,uid:()=>String(attempts),EXPIRED:'PDF 会话已失效，请重新打开文档'});
  const doc=new Doc({url:'https://fixture.test/doc.pdf'},{pdfSessions:true},false,call);
  await doc.translate({pages:[2],sourceLang:'en',targetLang:'zh'});assert.equal(opens,2);assert.equal(attempts,2);
  const oldCalls=[];const old=new Doc({dataUrl:'PDF'},{pdf:true},false,async(name,p)=>{oldCalls.push([name,p]);return {pages:[]};});
  await old.translate({pages:[1],sourceLang:'en',targetLang:'zh'});old.close();
  assert.deepEqual(oldCalls.map(([n])=>n),['pdf:translate']);assert.equal(oldCalls[0][1].dataUrl,'PDF');
});

test('PDF 关闭中的打开会话回包立即释放；取消后不提交页翻译', async () => {
  const pending=defer(),calls=[];const call=async(n,p)=>{calls.push([n,p]);if(n==='pdf:open')return pending.promise;return {ok:true};};
  const Doc=evaluate(named(docSource,'PdfBackendDocument'),'PdfBackendDocument',{rpc:call,uid:()=> 'r',EXPIRED:'PDF 会话已失效，请重新打开文档'});
  const doc=new Doc({dataUrl:'PDF'},{pdfSessions:true,cancel:true},false,call);
  const work=doc.translate({pages:[1],sourceLang:'en',targetLang:'zh'});doc.close();pending.resolve({documentHandle:'late',documentId:'d'});
  await assert.rejects(work,{name:'AbortError'});await tick();
  assert.equal(calls.filter(([n])=>n==='pdf:translate').length,0);
  assert.equal(calls.filter(([n])=>n==='pdf:close').length,1);
});

test('页取消通知后端且忽略随后到达的成功结果；非会话错误不重试', async () => {
  const result=defer(),calls=[];const call=async(n,p)=>{calls.push([n,p]);if(n==='pdf:translate')return result.promise;return {ok:true};};
  const Doc=evaluate(named(docSource,'PdfBackendDocument'),'PdfBackendDocument',{rpc:call,uid:()=> 'r',EXPIRED:'PDF 会话已失效，请重新打开文档'});
  const doc=new Doc({url:'url'},{cancel:true},false,call), controller=new AbortController();
  const work=doc.translate({pages:[1],sourceLang:'en',targetLang:'zh'},controller.signal);controller.abort();result.resolve({pages:[]});
  await assert.rejects(work,{name:'AbortError'});assert.equal(calls.filter(([n])=>n==='media:cancel').length,1);
  let count=0;const invalid=new Doc({url:'url'},{pdfSessions:true},false,async(n)=>{if(n==='pdf:open')return {documentHandle:'h'};count++;throw {info:{code:'bad_input',message:'其他错误',retryable:true}};});
  await assert.rejects(invalid.translate({pages:[1],sourceLang:'en',targetLang:'zh'}));assert.equal(count,1);
});

test('生命周期清理幂等，晚加入的资源立即释放；画布淘汰优先远页并保护可视/工作页', () => {
  const Lifetime=evaluate(named(lifeSource,'ReaderLifetime'),'ReaderLifetime');const life=new Lifetime();const calls=[];
  life.add(()=>calls.push('listener'));life.add(()=>{calls.push('broken');throw Error('fixture');});life.add(()=>calls.push('doc'));
  life.dispose();life.dispose();life.add(()=>calls.push('late'));assert.deepEqual(calls,['listener','broken','doc','late']);assert.equal(life.active,false);
  const distant=evaluate(named(lifeSource,'distantPages'),'distantPages');
  const pages=Array.from({length:20},(_,i)=>({n:i+1,state:i===19?'working':'done',canvas:{width:100,height:100}}));
  const removed=distant(pages,10,new Set([9,10,11]),8,1_000_000);
  assert.equal(removed.length,12);assert.ok(removed.every(p=>![9,10,11,20].includes(p.n)));assert.equal(removed[0].n,1);
});

function imageHarness(ocr) {
  const calls=[];
  const Image=evaluate(named(imageSource,'ImageTranslator'),'ImageTranslator',{
    rpc:async(n,p)=>{calls.push([n,p]);return n==='ocr:image'?ocr():{ok:true};}, uid:()=> 'image-request',
    readImagePixels:async()=>null,L:(zh)=>zh,groupLines:()=>[{text:'Hello world',patches:[],stage:'pending'}],looksLikeTarget:()=>false,
    hostMatches:()=>false,location:{href:'https://fixture.test',hostname:'fixture.test'},document:{title:'fixture'},stopScramble:()=>{},
  });
  const image=Object.create(Image.prototype);Object.assign(image,{states:new WeakMap(),live:new Set(),queue:[],canCancel:true,ro:{unobserve(){}},settings:{sourceLang:'en',targetLang:'zh',mode:'fast',sensitive:[]},client:{send(...v){calls.push(['send',...v]);},cancel(id){calls.push(['cancel',id]);}},source:async()=>({url:'fixture'}),buildStage(){}});
  const img={isConnected:true,naturalWidth:100,naturalHeight:100};const st={status:'loading',host:{remove(){}}};image.states.set(img,st);image.live.add(img);
  return {image,img,st,calls};
}
test('图片 OCR 取消→重新打开：旧成功结果不能复活覆盖层或发送翻译任务', async()=>{
  const pending=defer();const {image,img,st,calls}=imageHarness(()=>pending.promise);const work=image.recognize(img,st);await tick();
  image.remove(img);const next={status:'loading'};image.states.set(img,next);pending.resolve({width:100,blocks:[{text:'hello',confidence:1}]});await work;
  assert.equal(image.states.get(img),next);assert.equal(next.status,'loading');assert.equal(calls.filter(([n])=>n==='send').length,0);assert.equal(calls.filter(([n])=>n==='media:cancel').length,1);
});
test('图片旧翻译回调不写新代际；读源期间取消不会再启动 OCR',async()=>{
  const h=imageHarness(async()=>({width:100,blocks:[{text:'hello',confidence:1}]}));await h.image.recognize(h.img,h.st);
  const handlers=h.calls.find(([n])=>n==='send')[2];h.image.remove(h.img);h.image.states.set(h.img,{status:'shown'});let fills=0;h.image.fill=()=>fills++;h.image.drop=()=>fills++;
  handlers.onResult('0','旧结果','final');handlers.onError('0','final');assert.equal(fills,0);
  const p=defer();const other=imageHarness(()=>{throw Error('Must not OCR');});other.image.source=()=>p.promise;const work=other.image.recognize(other.img,other.st);other.image.remove(other.img);p.resolve({url:'fixture'});await work;assert.equal(other.calls.length,0);
});

function scannedHarness(translate) {
  const life={active:true};const s={n:1,width:100,token:1,paras:[],total:0,ok:0,failed:0};
  const scanned=evaluate(named(readerSource,'scanned'),'scanned',{
    life,caps:{pdf:true},backend:{translate},source:'en',target:'zh',mode:'fast',L:(s)=>s,toast(){},sampleBox(){return {};},place(){},fill(){},
    pageFailure(sh,message){sh.pageFailed=true;sh.failure=message;},finish(sh){sh.state='done';if(sh.failed)sh.pageFailed=true;},
  });
  return {s,life,run:()=>scanned(s,1,{})};
}
const paragraph=(extra={})=>({id:'p',source:'Hello world',translation:'你好',box:[1,1,90,20],...extra});
test('扫描 PDF 正确累计成功、段落失败、整页失败，缺失页不算原样保留',async()=>{
  for(const [paras,ok,failed] of [[[paragraph()],1,0],[[paragraph({translation:undefined,error:{message:'failed'}})],0,1]]) {
    const h=scannedHarness(async()=>({warnings:[],pages:[{page:1,width:100,paragraphs:paras}]}));await h.run();assert.equal(h.s.total,1);assert.equal(h.s.ok,ok);assert.equal(h.s.failed,failed);assert.equal(!!h.s.pageFailed,!!failed);
  }
  for(const response of [async()=>{throw Error('offline');},async()=>({warnings:[],pages:[]})]){const h=scannedHarness(response);await h.run();assert.equal(h.s.pageFailed,true);assert.equal(h.s.ok,0);}
});
test('扫描 PDF 取消后的成功/失败均不回写；原生页旧 catch 不能覆盖新页',async()=>{
  for(const reject of [false,true]){const p=defer();const h=scannedHarness(()=>p.promise);const work=h.run();h.s.token++;reject?p.reject(Error('old')):p.resolve({warnings:[],pages:[{page:1,width:100,paragraphs:[paragraph()]}]});await work;assert.equal(h.s.state,undefined);assert.equal(h.s.pageFailed,undefined);assert.equal(h.s.paras.length,0);}
  const p=defer(),sh={token:1,state:'idle'};let errors=0;
  const run=evaluate(named(readerSource,'runPage'),'runPage',{life:{active:true},processPage:async(sh)=>{sh.token++;return p.promise;},pageFailure(){errors++;},L:(s)=>s});
  const work=run(sh);sh.token++;sh.state='done';p.reject(Error('old page'));await work;assert.equal(sh.state,'done');assert.equal(errors,0);
});

test('逐页索引：首屏只读第 1 页；再读第 3 页只补读两页，取消停止后续扫描',async()=>{
  const layout=await source('frontend/pdf/layout.ts');let read=[];
  const cache=new WeakMap(),outlineCache=new WeakMap();
  const scan=evaluate(named(layout,'scanSections'),'scanSections',{sectionLines:cache,sectionOutlines:outlineCache,outlineZones:async()=>null,readItems:async(p)=>{read.push(p.n);return {items:[]};},buildLines:()=>[],tocParts:()=>null,bodySize:()=>10,median:(s)=>s[0]??0,isTocPage:()=>false,lineText:()=>'',REFS:/References/,MAJOR:/Appendix/});
  const doc={numPages:800,getPage:async(n)=>({n,getViewport:()=>({width:600})})};await scan(doc,{throughPage:1});assert.deepEqual(read,[1]);await scan(doc,{throughPage:3});assert.deepEqual(read,[1,2,3]);
  const controller=new AbortController();controller.abort();await assert.rejects(scan(doc,{throughPage:10,signal:controller.signal}),{name:'AbortError'});assert.equal(read.length,3);
});
test('可靠书签立即给出文献区；目录原生检测仍然可用',async()=>{
  const layout=await source('frontend/pdf/layout.ts');const zones=new Map([[500,{start:10,end:Infinity}]]);
  const scan=evaluate(named(layout,'scanSections'),'scanSections',{sectionLines:new WeakMap(),sectionOutlines:new WeakMap(),outlineZones:async()=>zones});
  const sec=await scan({numPages:800,getPage(){throw Error('Should not read pages');}},{throughPage:1});assert.equal(sec.zones,zones);
  assert.match(readerSource,/toc: sec\.toc\.has\(s\.n\) \|\| undefined/);
});

test('恢复淘汰页使用已保存译文，不调用翻译；失败页不触发自动打印',()=>{
  const restore=named(readerSource,'processPage');const start=restore.indexOf('if (restoring &&');const end=restore.indexOf('const sec =',start);
  const branch=restore.slice(start,end);assert.ok(start>0);assert.match(branch,/fill\(s, r, r\.text, stage\)/);assert.doesNotMatch(branch,/client\.send|backend\.translate/);
  const printing=named(readerSource,'printTranslated');assert.ok(printing.indexOf('sh.pageFailed || sh.failed || !sh.sheet')<printing.indexOf('window.print()'));
});


test('按阅读页扫描仍保留目录/文献续页/附录边界，且第 600 页之后不丢索引', async()=>{
  const layout=await source('frontend/pdf/layout.ts');
  const line=(text,y0,fs=10,toc=false)=>({text,y0,fs,toc});
  const scan=evaluate(named(layout,'scanSections'),'scanSections',{sectionLines:new WeakMap(),sectionOutlines:new WeakMap(),outlineZones:async()=>null,
    readItems:async(p)=>({items:p.lines}),buildLines:(items)=>items,tocParts:l=>l.toc?{}:null,bodySize:()=>10,median:s=>s[0],
    isTocPage:lines=>lines.some(l=>l.toc),lineText:l=>l.text,REFS:/^References$/,MAJOR:/^Appendix/});
  const doc={numPages:750,getPage:async(n)=>({lines:n===1?[line('References',10,20,true)]:n===699?[line('References',20,20)]:n===700?[line('Appendix A',80,20)]:[],getViewport:()=>({width:600})})};
  const sec=await scan(doc,{throughPage:700});assert.equal(sec.zones.has(1),false);assert.deepEqual(JSON.parse(JSON.stringify(sec.zones.get(699))),{start:20.5,end:null});
  assert.equal(sec.zones.get(700).end,80);assert.equal(sec.toc.has(1),true);
});

test('已淘汰 PDF 页仅重画并重新安放保留译文；计数不变且不再提取/翻译',async()=>{
  let placements=0,filled=0;
  const dom=()=>({querySelector(){return null;},insertBefore(){},replaceChildren(){},style:{setProperty(){}}});
  const canvas=()=>({width:600,height:800,getContext(){return {drawImage(){}};}});
  const s={n:1,state:'done',evicted:true,token:3,paras:[{stage:'final',text:'保留译文'}],ok:1,total:1,failed:0,orig:dom(),trans:dom(),hl:dom(),textLayer:dom(),origText:dom()};
  const process=evaluate(named(readerSource,'processPage'),'processPage',{
    life:{active:true},doc:{getPage:async()=>({getViewport:()=>({width:600,height:800}),streamTextContent(){}})},sizeShell(){},colWidth:()=>600,window:{devicePixelRatio:1},
    renderCanvas:async()=>canvas(),TextLayer:class{async render(){}},view:'both',document:{createElement:()=>canvas()},fromCanvas(){return {};},
    place(){placements++;},fill(sh,r,text,stage){assert.equal(text,'保留译文');assert.equal(stage,'final');filled++;},trimPages(){},
    sectionsFor(){throw Error('Do not extract again');},
  });
  await process(s);assert.equal(placements,1);assert.equal(filled,1);assert.equal(s.state,'done');assert.equal(s.evicted,false);assert.equal(s.ok,1);assert.equal(s.total,1);assert.ok(s.canvas&&s.sheet);
});

test('专用翻译端口 dispose 先取消再断开，断线事件不再重连',async()=>{
  const code=await source('frontend/content/port.ts');let connections=0,disconnects=0,listener;const messages=[];
  const Client=evaluate(named(code,'TranslateClient'),'TranslateClient',{PORT_TRANSLATE:'translate',window:{setTimeout},chrome:{runtime:{id:'fixture',connect(){connections++;return {postMessage:m=>messages.push(m),onMessage:{addListener(){}},onDisconnect:{addListener(fn){listener=fn;}},disconnect(){disconnects++;listener();}};}}}});
  const client=new Client();client.send({jobId:'test',segments:[{id:'1',text:'hello'}]},{onResult(){},onError(){}});client.dispose();client.warm();await tick();
  assert.equal(client.dead,true);assert.equal(connections,1);assert.equal(disconnects,1);assert.deepEqual(messages.map(m=>m.type),['job','cancel']);
});
