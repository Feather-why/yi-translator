import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url),directory=path.resolve(process.env.REPORT_DIR||path.join(root,'work/fast-core-real'));
const server=process.env.LLAMA_URL||'http://127.0.0.1:8083';assert.ok(new URL(server).port==='8083','只用临时模型');await mkdir(directory,{recursive:true});
const load=(variant,name)=>require(path.join(variant==='before'?path.resolve(process.env.BASELINE_COMPILED||path.join(root,'../fast-probe/baseline')):path.join(root,'tests/.compiled'),'backend',name+'.js'));
const pack=JSON.parse(gunzipSync(await readFile(path.join(root,'public/dict/ecdict-100k.json.gz'))));
const {Dictionary}=load('after','dict/index'),dictionary=new Dictionary({memory:true,entries:pack.entries.map(row=>({word:row[0],translation:row[2],exchange:row[4]}))});await dictionary.ready();
const samples=[
 {id:'repair-known-mt',text:'<g0>Machine translation</g0> is the use of computational techniques to <g1>translate</g1> text or speech from one <g2>language</g2> to another, including the nuances of context, idioms, and usage.'},
 {id:'repair-new-flat',text:'The <g0>inspection team</g0> must not open the <g1>pressure valve</g1> until the display reads below 2 bar. Record the result in the <g2>maintenance log</g2> before leaving.'},
 {id:'facts-plain',text:'The library will reopen on Monday, but the western entrance will remain closed. Children under six may enter free of charge, but every accompanying adult needs a ticket. Visitors must leave their bags at the desk before entering the archive.'},
 {id:'long-plain',text:'The researchers collected water samples from three stations along the coast. Each sample was stored in a separate container and labelled with the date, time, and location. The team measured temperature and salinity before analysing the samples in the laboratory. Higher temperatures did not always correspond to lower oxygen levels. The researchers therefore decided to repeat the measurements during the following week. Their report describes these observations but does not claim that the entire coastline has the same conditions.'},
 {id:'one-link',text:'Read <g0>the safety instructions</g0> before replacing the battery. Do not remove the cover while the device is connected to power.'},
 {id:'atoms',text:'Open <g0>the guide</g0>, copy <x0/>, and restart the application. Do not change the value 17.5.'},
 {id:'nested-quote',text:'Initially it was named the <g0>"Dynasty of <g1>the Country of the Sea</g1>"</g0> with Sealand later becoming customary.'},
 {id:'zh-en',text:'会议将于周四下午三点开始，不是周三。只有收到确认邮件的人才能进入实验室；其他访客可以在楼下等候。',sourceLang:'zh-CN',targetLang:'en'},
];
const results=[];
try{for(const [round,seed] of [42,77].entries())for(const sample of samples)for(const variant of (round%2?['after','before']:['before','after'])){
 const state={};globalThis.chrome={storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(state[k])])),set:async v=>Object.assign(state,structuredClone(v))}}};
 const {BackendCore}=load(variant,'core'),{BackendStorage}=load(variant,'storage'),{SecretVault}=load(variant,'secrets'),{validTranslation}=load(variant,'validation'),llama=load(variant,'providers/llamacpp').default;
 const row={variant,seed,id:sample.id,source:sample.text,requests:[],diagnostics:[],model:[],partials:[]};
 const observed={...llama,defaults:{...llama.defaults,url:server},translate:async(req,ctx)=>{const request={text:req.texts[0],quality:req.quality,strict:req.strictPlaceholders,at:performance.now()};row.requests.push(request);try{const result=await llama.translate(req,ctx);request.output=result[0];return result}finally{request.ms=performance.now()-request.at}}};
 const core=new BackendCore({providers:[observed],storage:new BackendStorage({memory:true}),vault:new SecretVault({memory:true}),lookup:(word,from,to)=>dictionary.lookup(word,from,to),onPerformance:e=>{if(e.type==='model')row.model.push(e)},onPlaceholderDiagnostic:e=>row.diagnostics.push(e),fetch:async(url,init)=>{const body=JSON.parse(init.body);Object.assign(body,{seed,cache_prompt:false});return fetch(url,{...init,body:JSON.stringify(body)})}});await core.ready();
 const segment={id:sample.id,text:sample.text,kind:'paragraph'},job={jobId:sample.id,sourceLang:sample.sourceLang||'en',targetLang:sample.targetLang||'zh-CN',mode:'fast',stream:true,noCache:true,priority:0,context:{url:'https://example.test/fast-core'},segments:[segment]};
 const started=performance.now();try{const result=await core.translate(job,segment,'fast',new AbortController().signal,{receivedAt:started,onPartial:value=>row.partials.push({at:performance.now()-started,...value})});Object.assign(row,{result,structureValid:validTranslation(sample.text,result.text)});assert.ok(row.structureValid)}catch(e){row.error=String(e)}row.ms=performance.now()-started;results.push(row);console.log(JSON.stringify({variant,seed,id:sample.id,ms:row.ms,calls:row.requests.length,text:row.result?.text,error:row.error}));
 }}finally{await dictionary.dispose();await writeFile(path.join(directory,'core-results.json'),JSON.stringify({at:new Date().toISOString(),samples,results,complete:results.length===32&&!results.some(r=>r.error),scope:'真实Core/本地ECDICT，无E5、无浏览器，六槽服务但此回归逐任务运行；首/后交错，seed42/77，noCache'},null,2)+'\n')}
assert.equal(results.length,32);assert.ok(results.every(r=>!r.error));
