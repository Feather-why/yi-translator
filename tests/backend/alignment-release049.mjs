import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const extension=path.resolve(process.env.EXT_DIR||path.join(root,'.output/chrome-mv3'));
const output=path.resolve(process.env.REPORT_DIR||path.join(root,'work/release-align-049'));
const modelCache=path.resolve(process.env.ALIGN_MODEL_CACHE||path.join(root,'work/align-model-cache/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78'));
const prefix='https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/';
const names=['config.json','tokenizer_config.json','tokenizer.json','onnx/model_quantized.onnx'];
const models=[];
for(const name of names){const bytes=await readFile(path.join(modelCache,name));models.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
await access(path.join(extension,'assets/onnx/ort-wasm-simd-threaded.jsep.wasm'));
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
await mkdir(output,{recursive:true});
const profileRoot=await realpath(output),profile=await mkdtemp(path.join(profileRoot,'edge-alignment-'));
const report={at:new Date().toISOString(),extension,version:manifest.version,models,modelResponses:[],wasmResponses:[],blockedRequests:[],consoleErrors:[],ok:false};
// offscreen 不一定受 Playwright 页面路由管理；拒绝代理覆盖整个临时浏览器，防止任何缓存漏项外连。
const proxy=createServer((request,response)=>{
  // 只对已知文件提供本机流式响应；绝不代理任意地址，也不把大模型塞进 DevTools 消息。
  const name=request.url?.startsWith('/cache/')?request.url.slice('/cache/'.length):undefined;
  if(request.method==='GET'&&names.includes(name)){
    report.modelResponses.push(name);
    response.writeHead(200,{'Content-Type':name.endsWith('.json')?'application/json':'application/octet-stream','Content-Length':models.find(item=>item.name===name).bytes,'Access-Control-Allow-Origin':'*'});
    createReadStream(path.join(modelCache,name)).on('error',()=>response.destroy()).pipe(response);return;
  }
  report.blockedRequests.push('proxy: '+request.url);response.writeHead(502);response.end();
});
proxy.on('connect',(request,socket)=>{report.blockedRequests.push('proxy CONNECT: '+request.url);socket.end('HTTP/1.1 502 Offline test\r\n\r\n');});
await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
let context;
try{
  const localBase=`http://127.0.0.1:${proxy.address().port}/cache/`;
  context=await chromium.launchPersistentContext(profile,{headless:true,timeout:60000,executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--proxy-server=http://127.0.0.1:${proxy.address().port}`,'--proxy-bypass-list=127.0.0.1']});
  console.log('alignment smoke: isolated Edge started');
  await context.route('**/*',async route=>{
    const url=route.request().url();
    if(url.startsWith(localBase)&&names.includes(url.slice(localBase.length))){await route.continue();return;}
    if(/^https?:/.test(url)){report.blockedRequests.push(url);await route.abort('blockedbyclient');return;}
    await route.continue();
  });
  context.on('response',response=>{if(/\.wasm(?:\?|$)/.test(response.url()))report.wasmResponses.push({url:response.url(),status:response.status()});});
  let [worker]=context.serviceWorkers();worker||=await context.waitForEvent('serviceworker',{timeout:15000});
  const extensionId=new URL(worker.url()).host;
  await isolateAutomaticWelcome(context,extensionId);
  const page=await context.newPage();page.on('pageerror',error=>report.consoleErrors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/options.html#general`);
  const rpc=async(name,payload)=>{
    const response=await page.evaluate(({rpc,payload})=>Promise.race([chrome.runtime.sendMessage({rpc,payload}),new Promise((_resolve,reject)=>setTimeout(()=>reject(new Error('RPC timeout: '+rpc)),30000))]),{rpc:name,payload});
    assert.equal(response?.ok,true,`${name}: ${JSON.stringify(response?.error)}`);return response.data;
  };
  report.backend=await rpc('ping');assert.equal(report.backend.protocol,3);assert.equal(report.backend.backend,manifest.version+'-release');
  console.log('alignment smoke: formal backend '+report.backend.backend);
  assert.ok(!(await rpc('providers:list')).some(provider=>provider.id==='pseudo'),'必须是真正式后台');
  for(const provider of await rpc('providers:list'))await rpc('providers:save',{id:provider.id,enabled:false,config:provider.config});
  report.seededCache=await page.evaluate(async({prefix,names,localBase})=>{
    const cache=await caches.open('transformers-cache'),seeded=[];
    for(const name of names){
      const url=prefix+name,response=await fetch(localBase+name,{credentials:'omit',signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error('Offline cache seed failed: '+name);
      const bytes=await response.arrayBuffer();
      const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
      await cache.put(url,new Response(bytes,{headers:{'Content-Type':name.endsWith('.json')?'application/json':'application/octet-stream'}}));
      seeded.push({name,bytes:bytes.byteLength,sha256});
    }
    return seeded;
  },{prefix,names,localBase});
  assert.deepEqual(report.seededCache,models);
  console.log('alignment smoke: four local files seeded and SHA256 verified; network blocked');
  // 西语→德语不走英汉词典；基线无词义链接可防止将启发式回退算作真实推理成功。
  const pair={id:'semantic-proof',source:'El gato duerme.',target:'Die Katze schläft.',sourceLang:'es',targetLang:'de'};
  const mapped=result=>result.links.map(([a,b])=>[pair.source.slice(...result.srcTokens[a]),pair.target.slice(...result.tgtTokens[b])]);
  await rpc('align:configure',{enabled:false,remoteUrl:'',token:''});
  report.baseline=mapped((await rpc('align:get',{pairs:[pair]}))[0]);
  assert.ok(!report.baseline.some(([a,b])=>a==='gato'&&b==='Katze'));
  await rpc('align:configure',{enabled:true,remoteUrl:'',token:''});
  console.log('alignment smoke: baseline verified; loading fixed local ONNX weights');
  const started=performance.now();
  let result;report.attempts=[];
  for(let attempt=0;attempt<8;attempt++){
    const at=performance.now();result=(await rpc('align:get',{pairs:[pair]}))[0];
    const links=mapped(result);report.attempts.push({elapsedMs:Math.round(performance.now()-at),links});
    if(links.some(([a,b])=>a==='gato'&&b==='Katze'))break;
    await page.waitForTimeout(1000);
  }
  report.modelAndFirstAlignmentMs=Math.round(performance.now()-started);
  report.alignment=result;report.semanticLinks=mapped(result);report.capabilities=await rpc('backend:capabilities');
  assert.equal(report.capabilities.alignment.ready,true,'真实对齐模型未就绪');
  assert.equal(report.capabilities.alignment.model,'Xenova/multilingual-e5-small');
  assert.ok(report.semanticLinks.some(([a,b])=>a==='gato'&&b==='Katze'),'没有得到真实模型专属的 gato→Katze 语义链接');
  assert.ok(report.modelResponses.includes('onnx/model_quantized.onnx'),'未读取真实ONNX缓存权重');
  const warmPair={id:'warm-semantic',source:'El perro corre.',target:'Der Hund rennt.',sourceLang:'es',targetLang:'de'};
  const warmAt=performance.now(),warm=(await rpc('align:get',{pairs:[warmPair]}))[0];
  report.warmMs=Math.round(performance.now()-warmAt);
  report.warmLinks=warm.links.map(([a,b])=>[warmPair.source.slice(...warm.srcTokens[a]),warmPair.target.slice(...warm.tgtTokens[b])]);
  assert.ok(report.warmLinks.some(([a,b])=>a==='perro'&&b==='Hund'),'热模型第二次语义推理未成功');
  assert.equal(report.consoleErrors.length,0);
  report.ok=true;
  console.log(JSON.stringify({ok:true,backend:report.backend.backend,coldMs:report.modelAndFirstAlignmentMs,warmMs:report.warmMs,semanticLinks:report.semanticLinks,warmLinks:report.warmLinks,modelFiles:report.modelResponses,wasmResponses:report.wasmResponses}));
}catch(error){report.failure={message:error.message,stack:error.stack};throw error;}
finally{
  await writeFile(path.join(output,'alignment-release049.json'),JSON.stringify(report,null,2));
  if(context)await context.close().catch(()=>{});
  await new Promise(resolve=>proxy.close(resolve));
  const resolved=await realpath(profile);
  if(path.dirname(resolved)!==profileRoot||!path.basename(resolved).startsWith('edge-alignment-'))throw new Error('拒绝清理非测试资料目录');
  await rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:150});
}
