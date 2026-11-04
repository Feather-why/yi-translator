/** 独立本机进程按相同每槽上下文比较2/6/8路，不停止用户现有8081服务。 */
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {access,mkdir,open,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../../',import.meta.url));
const provider=require('../.compiled/backend/providers/llamacpp.js').default;
const exe=path.resolve(process.env.LLAMA_EXE||path.join(root,'runtime/llama-b12069/llama-server.exe'));
const model=path.resolve(process.env.MODEL_PATH||path.join(root,'runtime/models/Hy-MT2-1.8B-Q4_K_M.gguf'));
const output=path.resolve(process.env.REPORT_DIR||path.join(root,'work/local-parallel'));
const port=Number(process.env.BENCH_PORT||8082),perSlot=2048,rounds=Number(process.env.BENCH_ROUNDS||3);
assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535&&port!==8081);assert.ok(Number.isInteger(rounds)&&rounds>=1&&rounds<=5);
await access(exe);await access(model);await mkdir(output,{recursive:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
async function occupied(){return new Promise(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.setTimeout(1000,()=>{socket.destroy();resolve(true);});});}
const report={at:new Date().toISOString(),adapter:provider.version,perSlotContext:perSlot,rounds,presets:[],conditions:'独立临时端口；原8081仅驻留且未发请求；每槽上下文与原2路相同；真实官方采样，热模型、固定20段三轮；不含浏览器/占位符恢复。'};
let modelChild,sampler;
async function stopChild(child){if(!child||!child.pid||child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([exited,pause(5000)]);if(child.exitCode===null&&child.signalCode===null)throw Error('自建测试进程未退出，拒绝复用端口');}
function sampleGpu(processId,readings){
 const script=String.raw`$taskModelPid=${processId}; Get-Counter '\GPU Process Memory(*)\Dedicated Usage','\GPU Process Memory(*)\Shared Usage' -SampleInterval 1 -MaxSamples 240 | ForEach-Object { $taskGpuSamples=$_.CounterSamples | Where-Object { $_.InstanceName -like ('pid_'+$taskModelPid+'_*') }; $taskDedicated=($taskGpuSamples | Where-Object { $_.Path -like '*\dedicated usage' } | Measure-Object CookedValue -Sum).Sum; $taskShared=($taskGpuSamples | Where-Object { $_.Path -like '*\shared usage' } | Measure-Object CookedValue -Sum).Sum; [pscustomobject]@{at=[DateTime]::UtcNow.ToString('o');dedicatedMiB=[math]::Round($taskDedicated/1MB,3);sharedMiB=[math]::Round($taskShared/1MB,3)} | ConvertTo-Json -Compress }`;
 const child=spawn(process.env.PERF_SHELL || 'pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['ignore','pipe','pipe']});let pending='';let error='';
 child.on('error',e=>{error=String(e.message);readings.push({samplerError:error});});child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{pending+=chunk;let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i).trim();pending=pending.slice(i+1);try{const row=JSON.parse(line);if(Number.isFinite(row.dedicatedMiB))readings.push(row);}catch{}}});child.stderr.on('data',chunk=>error+=chunk.toString());child.on('exit',()=>{if(error)readings.push({samplerError:error.slice(0,500)});});return child;
}
async function translated(text,requests){
 const signal=AbortSignal.timeout(60000),start=performance.now();let timing;
 const result=await provider.translate({texts:[text],sourceLang:'en',targetLang:'zh-CN',context:{url:'https://performance.example/article',title:'Browser translation benchmark',summary:'A local browser translator preserves privacy and displays clear bilingual text.'}},{config:{url:`http://127.0.0.1:${port}`},signal,log(){},recordTiming(row){timing=row;},async fetch(url,init){return fetch(url,{...init,credentials:'omit',redirect:'error',signal});}});
 assert.equal(result.length,1);assert.match(result[0],/[\u3400-\u9fff]/u);assert.ok(!/<\/?[gx]\d/.test(result[0]));
 const row={ms:performance.now()-start,sourceChars:text.length,outputChars:result[0].length,...(timing?{timing}:{})};requests.push(row);return result[0];
}
const longBody='The browser translates complete sentences locally and keeps private reading on this computer. Clear context helps the model choose natural wording while preserving links, numbers, and code. A reader can select a sentence to see its corresponding translation, and can save an explicit correction for a future visit. Downloaded language packages work without a cloud character quota. The scheduler should avoid duplicate work and keep the first visible paragraphs ahead of distant content.';
try{
 for(const parallel of [2,6,8]){
  if(await occupied())throw Error(`测试端口${port}已占用，不会终止其他进程`);
  const folder=path.join(output,`np${parallel}`);await mkdir(folder,{recursive:true});const stdout=await open(path.join(folder,'server.stdout.log'),'w'),stderr=await open(path.join(folder,'server.stderr.log'),'w');
  const args=['-m',model,'--host','127.0.0.1','--port',String(port),'-ngl','99','-fa','on','-c',String(parallel*perSlot),'-np',String(parallel),'-ctk','q8_0','-ctv','q8_0','-b','512','-ub','256','--jinja','--temp','0.7','--top-p','0.6','--top-k','20','--min-p','0','--repeat-penalty','1.05','--cache-ram','128','--sleep-idle-seconds','600'];
  const row={parallel,totalContext:parallel*perSlot,arguments:args,results:[],gpu:[]};report.presets.push(row);
  try{
   modelChild=spawn(exe,args,{cwd:path.dirname(exe),windowsHide:true,stdio:['ignore',stdout.fd,stderr.fd]});row.processId=modelChild.pid;await stdout.close();await stderr.close();
   sampler=sampleGpu(modelChild.pid,row.gpu);
   const deadline=Date.now()+60000;let ready=false;
   while(Date.now()<deadline){if(modelChild.exitCode!==null)throw Error('测试模型启动退出');try{const r=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1500)});if(r.ok){ready=true;break;}}catch{}await pause(200);}
   if(!ready)throw Error('测试模型未能在60秒内准备好');
   await translated('The local browser translator is ready to translate complete sentences. This untimed request warms the model before measurement.',[]);await pause(1200);
   for(const kind of ['short','paragraph'])for(let round=0;round<rounds;round++){
    const texts=Array.from({length:20},(_,i)=>kind==='short'?`Test ${round+1}, item ${i+1}: the children read a book beside the window while a small dog sleeps quietly.`:`Test ${round+1}, item ${i+1}. ${longBody}`);
    const requests=[],begin=performance.now();let next=0,first;
    await Promise.all(Array.from({length:parallel},async()=>{while(next<texts.length){const index=next++;await translated(texts[index],requests);first??=performance.now()-begin;}}));
    row.results.push({kind,round,firstMs:first,allMs:performance.now()-begin,requests});
   }
   await pause(1100);row.summary=Object.fromEntries(['short','paragraph'].map(kind=>{const cases=row.results.filter(x=>x.kind===kind);return[kind,{allMedianMs:Math.round(median(cases.map(x=>x.allMs))),firstMedianMs:Math.round(median(cases.map(x=>x.firstMs))),requestMedianMs:Math.round(median(cases.flatMap(x=>x.requests.map(y=>y.ms)))),httpRequests:cases.map(x=>x.requests.length)}];}));
   const memory=row.gpu.filter(x=>Number.isFinite(x.dedicatedMiB)&&x.dedicatedMiB>0);row.peakDedicatedMiB=memory.length?Math.max(...memory.map(x=>x.dedicatedMiB)):null;row.peakSharedMiB=memory.length?Math.max(...memory.map(x=>x.sharedMiB)):null;row.within2GiB=row.peakDedicatedMiB===null?null:row.peakDedicatedMiB<=2048;row.ok=true;
   console.log(JSON.stringify({parallel,ok:true,...row.summary,peakDedicatedMiB:row.peakDedicatedMiB,within2GiB:row.within2GiB}));
  }catch(error){row.ok=false;row.error=String(error.message);console.log(JSON.stringify({parallel,ok:false,error:row.error}));}
  finally{await stopChild(sampler);sampler=undefined;await stopChild(modelChild);modelChild=undefined;await pause(500);await writeFile(path.join(output,'local-parallel-result.json'),JSON.stringify(report,null,2));}
 }
 report.ok=report.presets.every(x=>x.ok);await writeFile(path.join(output,'local-parallel-result.json'),JSON.stringify(report,null,2));assert.equal(report.ok,true,'部分并发档启动或翻译失败，不能选为默认');
}finally{await stopChild(sampler);await stopChild(modelChild);}
