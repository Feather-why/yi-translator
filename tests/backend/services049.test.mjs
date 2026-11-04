import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const build=process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.compiled');
const {BackendCore}=require(path.join(build,'backend/core.js'));
const {BackendStorage}=require(path.join(build,'backend/storage.js'));
const {SecretVault}=require(path.join(build,'backend/secrets.js'));
const {ProviderError,classifyError}=require(path.join(build,'backend/providers/types.js'));
const {createBrowserTranslatorBridge}=require(path.join(build,'backend/browser-translator-bridge.js'));
const builtin=require(path.join(build,'backend/providers/browser-translator.js')).default;
const {diagnosticSample}=require(path.join(build,'backend/provider-diagnostics.js'));
const signal=()=>new AbortController().signal;
function provider(overrides={}) {return {id:'fixture',name:'fixture',version:'1.0.0',kind:'mt',official:true,usedFor:['fast','accurate','combined'],auth:[],limits:{maxChars:10000,maxSegments:50,concurrency:4},placeholders:'prompt',translate:async r=>r.texts.map(()=> '测试译文'),classifyError,...overrides};}
async function setup(providers,options={}) {
 const data={'settings.ui':{sourceLang:'de',targetLang:'fr'}};
 const local={async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(data[key])]));},async set(values){Object.assign(data,structuredClone(values));}};
 globalThis.chrome={storage:{local}};
 const core=new BackendCore({providers,storage:new BackendStorage({memory:true}),vault:new SecretVault({memory:true,storage:local}),...options});await core.ready();return {core,data};
}
const job={jobId:'sample',mode:'fast',sourceLang:'en',targetLang:'zh-CN',priority:0,noCache:true,context:{url:'https://example.test/'},segments:[{id:'p',text:'Some useful text.',kind:'paragraph'}]};

test('049: probe 无健康接口不暗中翻译，手动检测恰好产生一次付费用量且不计正文统计',async()=>{
 let calls=0;const {core}=await setup([provider({freeQuota:{unit:'char',period:'day',amount:10000},translate:async r=>{calls++;return r.texts.map(()=> '正常译文');}})]);
 await core.probe();assert.equal(calls,0);
 assert.equal((await core.test('fixture')).ok,true);assert.equal(calls,1);
 let status=core.snapshot().providers[0];assert.ok(status.quota.used>0);assert.equal(status.successRate,undefined);assert.equal(status.latencyP50Ms,undefined);
 await core.translate(job,job.segments[0],'fast',signal());status=core.snapshot().providers[0];const latency=status.latencyP50Ms;
 await core.test('fixture');status=core.snapshot().providers[0];assert.equal(status.successRate,1);assert.equal(status.latencyP50Ms,latency);
});
test('049: 检测限流仍记账和熔断但不污染正文成功率，随后正常检测不覆盖P50',async()=>{
 let failed=false;const {core}=await setup([provider({freeQuota:{unit:'request',period:'day',amount:100},cost:()=>1,translate:async()=>{if(failed)throw new ProviderError({code:'rate_limit',message:'429',retryable:true});return ['正常译文'];}})]);
 await core.translate(job,job.segments[0],'fast',signal());const before=core.snapshot().providers[0];failed=true;
 assert.equal((await core.test('fixture')).ok,false);const after=core.snapshot().providers[0];assert.equal(after.successRate,before.successRate);assert.equal(after.latencyP50Ms,before.latencyP50Ms);assert.equal(after.quota.used,2);assert.equal(after.circuit,'open');assert.equal(after.lastError.code,'rate_limit');
});
test('049: 测试使用真实语言样例；auto→英语使用中文，未知样例明确拒绝',async()=>{
 const calls=[];const {core}=await setup([provider({translate:async req=>{calls.push(req);return ['A correct translation.'];}})]);
 assert.equal((await core.test('fixture',{sourceLang:'ja',targetLang:'en'})).ok,true);assert.match(calls[0].texts[0],/ブラウザー/);assert.equal(calls[0].sourceLang,'ja');assert.equal(calls[0].targetLang,'en');
 await core.test('fixture',{sourceLang:'auto',targetLang:'en'});assert.match(calls[1].texts[0],/浏览器/);
 const bad=await core.test('fixture',{sourceLang:'xx',targetLang:'en'});assert.equal(bad.error.code,'bad_input');assert.equal(calls.length,2);
 for(const code of ['en','zh-CN','zh-TW','ja','ko','fr','de','es','pt','it','ru','sv','nl','pl','tr','uk','vi','th','id','ar'])assert.ok(diagnosticSample(code).length>15);
});
test('049: 内置健康检查采用当前设置，不改设置；显式测试采用卡片语言方向并清缓存',async()=>{
 const pairs=[],invalidations=[],opens=[];const bridge={unavailable:()=>false,invalidate:(...args)=>invalidations.push(args),availability:async(source,target)=>{pairs.push([source,target]);return {status:'downloadable',detectorStatus:'available'};},translate:async()=>{throw new ProviderError({code:'no_provider',message:'pack missing',retryable:true});}};
 const {core,data}=await setup([builtin],{builtin:bridge,openBuiltinSetup:async(...args)=>opens.push(args)});
 const before=structuredClone(data['settings.ui']);await core.probe(builtin.id);assert.deepEqual(pairs.shift(),['de','fr']);assert.deepEqual(invalidations.shift(),[]);
 await core.test(builtin.id,{sourceLang:'ja',targetLang:'en'});assert.deepEqual(invalidations.shift(),['ja','en']);assert.deepEqual(opens,[['ja','en']]);assert.deepEqual(pairs,[['ja','en']]);assert.deepEqual(data['settings.ui'],before);
});
test('049: 内置短负缓存只覆盖真实语言对，十五秒后可重试，检测和下载刷新可失效',async()=>{
 let now=1,calls=0,ok=false;
 const bridge=createBrowserTranslatorBridge(async(task,payload)=>{calls++;return task.endsWith('availability')?{status:'available',sourceLanguage:payload.sourceLang,targetLanguage:payload.targetLang,supportsAuto:true,detectorStatus:'available'}:ok?{ok:true,texts:['译文']}:{ok:false,error:{code:'no_provider',message:'pack missing',retryable:true}};},undefined,()=>now);
 const input={texts:['Hello.'],sourceLang:'en',targetLang:'zh-CN'};
 await assert.rejects(bridge.translate(input,signal()));await assert.rejects(bridge.translate(input,signal()));assert.equal(calls,1);
 assert.equal(bridge.unavailable('en','zh'),true);assert.equal(bridge.unavailable('fr','zh'),false);assert.equal(bridge.unavailable('auto','zh'),false);
 now+=15000;await assert.rejects(bridge.translate(input,signal()));assert.equal(calls,2);
 await bridge.availability('en','zh-CN',signal());assert.equal(bridge.unavailable('en','zh'),false);
 await assert.rejects(bridge.translate(input,signal()));bridge.invalidate('en','zh');ok=true;assert.deepEqual(await bridge.translate(input,signal()),['译文']);
});
test('049: auto 先可靠识别实际语言再查负缓存，另一种语言不受影响',async()=>{
 let language='fr',calls=0;
 const bridge=createBrowserTranslatorBridge(async(_task,payload)=>{calls++;return payload.sourceLang==='fr'?{ok:false,error:{code:'no_provider',message:'fr missing',retryable:true}}:{ok:true,texts:['德语译文']};},async()=>({isReliable:true,languages:[{language,percentage:100}]}));
 const input={texts:['A sufficiently long sentence.'],sourceLang:'auto',targetLang:'zh-CN'};
 await assert.rejects(bridge.translate(input,signal()));await assert.rejects(bridge.translate(input,signal()));assert.equal(calls,1);
 language='de';assert.deepEqual(await bridge.translate(input,signal()),['德语译文']);assert.equal(calls,2);
});
test('049: 调度跳过已知不可用语言对，另一个语言对继续优先内置',async()=>{
 let calls=0;const {core}=await setup([provider({...builtin,translate:async()=>{calls++;return ['内置译文'];}}),provider({id:'fallback'})],{builtin:{unavailable:(source)=>source==='en',translate:async()=>[],availability:async()=>({status:'available'})}});
 await core.save(builtin.id,true,{});
 assert.equal((await core.translate(job,job.segments[0],'fast',signal())).provider,'fallback');assert.equal(calls,0);
 assert.equal((await core.translate({...job,sourceLang:'fr'},job.segments[0],'fast',signal())).provider,builtin.id);assert.equal(calls,1);
});

test('049: 下载或手动检测失效后，旧请求迟到的不可用结果不能重新写入负缓存',async()=>{
 let finish;
 const bridge=createBrowserTranslatorBridge(async()=>new Promise(resolve=>finish=resolve));
 const input={texts:['A complete sentence.'],sourceLang:'en',targetLang:'zh-CN'};
 const pending=bridge.translate(input,signal());bridge.invalidate('en','zh-CN');
 finish({ok:false,error:{code:'no_provider',message:'old failure',retryable:true}});await assert.rejects(pending);
 assert.equal(bridge.unavailable('en','zh-CN'),false);
});
test('049: 同一语言方向检测不能用原样回传冒充翻译成功',async()=>{
 let calls=0;const {core}=await setup([provider({translate:async()=>{calls++;return ['unchanged'];}})]);
 const result=await core.test('fixture',{sourceLang:'en',targetLang:'en'});assert.equal(result.error.code,'bad_input');assert.equal(calls,0);
});
