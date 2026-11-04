import {readFileSync} from 'node:fs';
const RELEASE_VERSION=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),extension=path.resolve(process.env.EXT_DIR||path.join(root,'.output/chrome-mv3'));
const output=path.resolve(process.env.REPORT_DIR||path.join(root,'work/atoms-production-034'));await mkdir(output,{recursive:true});
const model=new URL(process.env.LLAMA_URL||'http://127.0.0.1:8083');assert.equal(model.hostname,'127.0.0.1');assert.equal(model.port,'8083');
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json')));assert.equal(manifest.version,RELEASE_VERSION);
const report={version:manifest.version,extension,source:'With 𝑁 samples, compute <x0/> first, then check <x1/>. Keep ℎ unchanged.',requests:[],cases:[]};
// 代理只删除这条合成请求的x标记，模拟模型漏标；实际文本仍由临时真实模型生成。
const proxy=createServer((req,res)=>{void(async()=>{
 try{
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'});res.end();return;}
  if(req.url!=='/v1/chat/completions'&&req.url!=='/health')throw Error('Unexpected test URL');
  const parts=[];for await(const part of req)parts.push(part);const body=Buffer.concat(parts).toString();
  if(body)assert.equal(JSON.parse(body).stream,false);
  const response=await fetch(new URL(req.url,model),{method:req.method,headers:{'Content-Type':'application/json'},...(body?{body}:{}),signal:AbortSignal.timeout(60000)});
  const value=await response.json();assert.equal(response.ok,true);
  if(body){const content=value.choices?.[0]?.message?.content;assert.equal(typeof content,'string');
   report.requests.push({request:JSON.parse(body),originalText:content,finishReason:value.choices[0].finish_reason});
   value.choices[0].message.content=content.replace(/<x\d+\/>/g,'');
  }
  res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(value));
 }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'isolated test proxy failed'}));report.proxyError=String(error);}
})()});
await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve)});
const localUrl=`http://127.0.0.1:${proxy.address().port}`,temporary=await mkdtemp(path.join(os.tmpdir(),'translate-atoms-034-'));let context;
try{
 context=await chromium.launchPersistentContext(temporary,{headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',ignoreDefaultArgs:['--disable-extensions'],args:[`--load-extension=${extension}`,`--disable-extensions-except=${extension}`]});
 let[worker]=context.serviceWorkers();worker ||= await context.waitForEvent('serviceworker',{timeout:15000});const id=new URL(worker.url()).host;report.id=id;
 await isolateAutomaticWelcome(context,id);const page=await context.newPage();await page.goto(`chrome-extension://${id}/options.html#advanced`);
 const rpc=async(rpc,payload)=>{const value=await page.evaluate(({rpc,payload})=>chrome.runtime.sendMessage({rpc,payload}),{rpc,payload});assert.equal(value?.ok,true,JSON.stringify(value));return value.data;};
 assert.equal((await rpc('ping')).backend,`${RELEASE_VERSION}-release`);await rpc('align:configure',{enabled:false});
 for(const provider of await rpc('providers:list'))await rpc('providers:save',{id:provider.id,enabled:provider.id==='llamacpp',config:provider.config});
 await rpc('providers:save',{id:'llamacpp',enabled:true,config:{url:localUrl,key:''}});
 const run=()=>page.evaluate(text=>new Promise((resolve,reject)=>{
  const port=chrome.runtime.connect({name:'tx:translate'}),jobId=crypto.randomUUID(),messages=[];
  const timer=setTimeout(()=>{port.disconnect();reject(Error('translation timeout'));},60000);
  port.onMessage.addListener(m=>{if(m.jobId!==jobId)return;messages.push(m);if(m.type==='result'||m.type==='error'){clearTimeout(timer);port.disconnect();resolve({result:m,messages});}});
  port.postMessage({type:'job',job:{jobId,sourceLang:'en',targetLang:'zh-CN',mode:'fast',priority:0,stream:false,context:{url:'https://public.example/math-test'},segments:[{id:'math',kind:'paragraph',text}]}});
 }),report.source);
 const first=await run();assert.equal(first.result.type,'result',JSON.stringify(first));assert.equal(report.requests.length,1,'不额外生成严格重试或叶子译文');assert.equal(first.result.timing.retries,0);
 const restored=first.result.text;assert.equal((restored.match(/<x0\/>/g)||[]).length,1);assert.equal((restored.match(/<x1\/>/g)||[]).length,1);
 assert.equal(restored.replace(/<x\d+\/>/g,''),report.requests[0].originalText.replace(/<x\d+\/>/g,'').trim(),'补位不得改写真实模型译文');
 assert.ok(report.requests[0].request.messages.some(m=>m.content.includes(report.source)),'送模型的原文数学字母和占位符完整保留');
 assert.ok(!first.messages.some(m=>m.type==='partial'));report.cases.push('真实Q4文本加受控缺x故障，一次HTTP本地恢复并零重试','原始Unicode数学字母进入真实模型','非流式完整结果与timing');
 const second=await run();assert.equal(second.result.cached,true);assert.equal(second.result.text,restored);assert.equal(report.requests.length,1);report.cases.push('修复后的完整结果缓存复用');
 report.first=first;report.cached=second;report.modelPreservedMath=['𝑁','ℎ'].every(s=>report.requests[0].originalText.includes(s));report.passed=true;
 report.packageHashes=Object.fromEntries(await Promise.all(['manifest.json','background.js'].map(async file=>[file,createHash('sha256').update(await readFile(path.join(extension,file))).digest('hex')])));
}catch(error){report.passed=false;report.error=String(error);throw error;}
finally{
 await context?.close();await new Promise(resolve=>proxy.close(resolve));
 if(path.dirname(temporary)!==os.tmpdir()||!path.basename(temporary).startsWith('translate-atoms-034-'))throw Error('Unexpected cleanup path');
 await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:150});await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,http:report.requests.length,modelPreservedMath:report.modelPreservedMath,report:path.join(output,'report.json')}));
