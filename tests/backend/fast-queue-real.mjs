import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url),directory=path.resolve(process.env.REPORT_DIR||path.join(root,'work/fast-queue-real'));
const server=process.env.LLAMA_URL||'http://127.0.0.1:8083';assert.ok(new URL(server).port==='8083');await mkdir(directory,{recursive:true});
const load=(variant,name)=>require(path.join(variant==='before'?path.resolve(process.env.BASELINE_COMPILED||path.join(root,'../fast-probe/baseline')):path.join(root,'tests/.compiled'),'backend',name+'.js'));
class Event{listeners=new Set();addListener(fn){this.listeners.add(fn)}removeListener(fn){this.listeners.delete(fn)}emit(...a){for(const fn of this.listeners)fn(...a)}}
class Port{onMessage=new Event();onDisconnect=new Event();messages=[];postMessage(m){this.messages.push({at:performance.now(),...structuredClone(m)})}send(m){this.onMessage.emit(m)}}
const pause=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn){const end=Date.now()+90000;while(!fn()){assert.ok(Date.now()<end,'模型队列超时');await pause(3)}}
const long='The research team collected samples from three coastal stations and recorded the temperature at each location. Every container was labelled with its date and origin. The researchers compared the measurements with the previous year, but they did not assume that a single observation represented the entire coast. They planned another visit in December to check whether the changes continued. The final report would include both successful measurements and equipment failures so that other teams could evaluate the evidence.';
const fast='The west entrance is closed on Monday. Please use the east entrance after 09:30, and do not leave your bags unattended.';
const rows=[];
try{for(const round of [0,1])for(const scenario of ['fast-alone','combined-alone','backlog-fast','backlog-combined'])for(const variant of (round?['after','before']:['before','after'])){
 const state={};globalThis.chrome={storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(state[k])])),set:async v=>Object.assign(state,structuredClone(v))}}};
 const {BackendCore}=load(variant,'core'),{BackendStorage}=load(variant,'storage'),{SecretVault}=load(variant,'secrets'),{TranslatePort}=load(variant,'ports/translate'),{PriorityQueue}=load(variant,'scheduler/queue'),llama=load(variant,'providers/llamacpp').default;
 const http=[],core=new BackendCore({providers:[{...llama,defaults:{...llama.defaults,url:server}}],storage:new BackendStorage({memory:true}),vault:new SecretVault({memory:true}),fetch:async(url,init)=>{const body=JSON.parse(init.body);Object.assign(body,{seed:42,cache_prompt:false});http.push({at:performance.now(),prompt:body.messages[0].content,stream:body.stream});return fetch(url,{...init,body:JSON.stringify(body)})}});await core.ready();
 const queue=new PriorityQueue(32),oldPort=new Port(),newPort=new Port(),oldService=new TranslatePort(oldPort,core,32,queue),newService=new TranslatePort(newPort,core,32,queue);
 const make=(id,mode,text,count)=>({jobId:id,sourceLang:'en',targetLang:'zh-CN',mode,stream:true,noCache:true,priority:0,context:{url:'https://example.test/fast-queue'},segments:Array.from({length:count},(_,i)=>({id:`s${i}`,kind:'paragraph',text:count>1?`Record ${i+1}. ${text}`:text}))});
 const backlog=scenario.startsWith('backlog'),mode=scenario.endsWith('combined')||scenario==='combined-alone'?'combined':'fast',count=backlog?1:12;
 try{
  if(backlog){oldPort.send({type:'job',job:make('old','accurate',long,36)});await until(()=>http.length>=6);await pause(25)}
  const beforeHttp=http.length,started=performance.now();newPort.send({type:'job',job:make('foreground',mode,backlog?fast:long,count)});
  await until(()=>newPort.messages.some(m=>m.type==='job-done'&&m.stage==='final'));
  const complete=newPort.messages.filter(m=>m.type==='result'),partials=newPort.messages.filter(m=>m.type==='partial'),errors=newPort.messages.filter(m=>m.type==='error');assert.deepEqual(errors,[]);assert.equal(complete.length,count);
  const row={round,scenario,variant,firstPreviewMs:partials[0]?.at-started,firstResultMs:complete[0].at-started,allResultsMs:complete.at(-1).at-started,results:complete.map(m=>({...m,at:m.at-started})),newRequestsAfterStart:http.slice(beforeHttp).map(r=>({...r,at:r.at-started})),oldResultsBeforeNew:oldPort.messages.filter(m=>m.type==='result'&&m.at<complete[0].at).length};rows.push(row);
  console.log(JSON.stringify({round,scenario,variant,firstPreviewMs:row.firstPreviewMs,firstResultMs:row.firstResultMs,allResultsMs:row.allResultsMs,oldResultsBeforeNew:row.oldResultsBeforeNew}));
 }finally{oldService.dispose();newService.dispose();await pause(100)}
 }}finally{await writeFile(path.join(directory,'queue-results.json'),JSON.stringify({at:new Date().toISOString(),complete:rows.length===16,scope:'真实六槽模型，同一个32并发逻辑队列；积压为36准确段落，6请求入网25ms后加入fast/combined；完成前台后取消余下后台；不含DOM。',rows},null,2)+'\n')}
assert.equal(rows.length,16);
