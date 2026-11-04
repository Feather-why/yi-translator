import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url),build=path.resolve(process.env.BACKEND_BUILD_DIR||'tests/.compiled');
const load=name=>require(path.join(build,'backend',name+'.js'));
const {BackendCore}=load('core'),{BackendStorage}=load('storage'),{SecretVault}=load('secrets'),deepl=load('providers/deepl').default;
const {classifyError}=load('providers/types'),{validTranslation}=load('validation');
const area=()=>({data:{},async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(this.data[k])]))},async set(values){Object.assign(this.data,structuredClone(values))}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const until=async(predicate)=>{const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,'等待测试请求超时');await new Promise(r=>setTimeout(r,1));}};
const job=(text,extra={})=>({jobId:crypto.randomUUID(),sourceLang:'en',targetLang:'zh-CN',mode:'fast',priority:0,context:{url:'https://public.example/test'},segments:[{id:'s',kind:'paragraph',text}],...extra});
const run=(core,text,extra={})=>{const request=job(text,extra);return core.translate(request,request.segments[0],'fast',new AbortController().signal)};
async function setup(extra={}){
 const local=extra.local??area();globalThis.chrome={storage:{local}};
 const storage=extra.storage??new BackendStorage({memory:true}),vault=extra.vault??new SecretVault({memory:true,storage:local});
 const control=extra.control??{amount:1_000_000,used:0,now:Date.UTC(2026,10,4),calls:[],usage:[]};
 const provider=extra.provider??deepl;
 const fetch=async(url,init)=>{control.calls.push({url:String(url),init});if(String(url).endsWith('/usage')){
   const snapshot={character_count:control.used,character_limit:control.amount};control.usage.push(snapshot);
   if(control.wait){const wait=control.wait;control.wait=undefined;await wait.promise;}
   return Response.json(snapshot);
 }const body=JSON.parse(init.body);return Response.json({translations:body.text.map(text=>({text}))});};
 const core=new BackendCore({providers:[provider],storage,vault,fetch,now:()=>control.now});await core.ready();
 if(!extra.reopen)await core.save(provider.id,true,provider.id==='deepl'?{key:'synthetic-account-A'}:{});
 return{core,local,storage,vault,control};
}
test('官方1m替代旧500k默认，账户预算跨月及后台重建不虚假补额',async()=>{
 const f=await setup();f.control.used=750_000;await f.core.probe('deepl');
 assert.equal(f.core.snapshot().providers[0].quota.amount,1_000_000);assert.equal(f.core.snapshot().providers[0].quota.used,750_000);
 assert.equal(f.core.snapshot().providers[0].quota.resetAt,undefined);
 assert.equal(f.core.snapshot().providers[0].quota.period,'cycle');
 assert.match((await f.core.list())[0].quotaText,/1,000,000/);assert.match((await f.core.list())[0].quotaText,/不.*重置/);
 await run(f.core,'one');assert.equal(f.core.snapshot().providers[0].quota.used,750_003);
 f.control.now=Date.UTC(2027,0,2);assert.equal(f.core.snapshot().providers[0].quota.used,750_003);
 const again=await setup({...f,reopen:true});assert.equal(again.core.snapshot().providers[0].quota.amount,1_000_000);assert.equal(again.core.snapshot().providers[0].quota.used,750_003);
 assert.ok(!JSON.stringify(f.local.data['backend.accountQuota']).includes('synthetic-account-A'));
});
test('官方0额不能被用户quota0付费无限制绕过',async()=>{
 const f=await setup();await f.core.save('deepl',true,{key:'••••'},{quota:{unit:'char',amount:0,period:'month'}});
 f.control.amount=0;await f.core.probe('deepl');assert.equal(f.core.snapshot().providers[0].quota.amount,0);
 assert.equal(f.core.snapshot().providers[0].health,'exhausted');await assert.rejects(run(f.core,'hello'));
 assert.ok(f.control.calls.every(c=>c.url.endsWith('/usage')));
});
test('用户每日预算与官方一次性账户两层独立，次日只重置本地预算',async()=>{
 const f=await setup();f.control.used=500;await f.core.probe('deepl');
 await f.core.save('deepl',true,{key:'••••'},{quota:{unit:'char',amount:5,period:'day'}});
 await run(f.core,'12345');await assert.rejects(run(f.core,'6'));
 assert.equal(f.core.snapshot().providers[0].quota.used,505);
 f.control.now+=86_400_000;await run(f.core,'abcdef'.slice(0,5));assert.equal(f.core.snapshot().providers[0].quota.used,510);
 const localCounter=f.local.data['backend.usage'].deepl;assert.equal(localCounter.used,5);
});
test('批量任务同时校验两层预算，不会少扣账户或重复扣预算',async()=>{
 const f=await setup();await f.core.probe('deepl');await f.core.save('deepl',true,{key:'••••'},{quota:{unit:'char',amount:10,period:'month'}});
 await Promise.all([run(f.core,'aaa'),run(f.core,'bbbb')]);
 assert.equal(f.core.snapshot().providers[0].quota.used,7);assert.equal(f.local.data['backend.usage'].deepl.used,7);
 assert.equal(f.control.calls.filter(c=>c.url.endsWith('/translate')).length,1);
});
test('新一次usage真实下降可恢复额度，保留查询期间新增的实际发送量',async()=>{
 const f=await setup();f.control.used=100;await f.core.probe('deepl');
 const wait=deferred();f.control.wait=wait;f.control.used=1;const probing=f.core.probe('deepl');
 await until(()=>f.control.usage.length>=2);
 await run(f.core,'1234');wait.resolve();await probing;
 assert.equal(f.core.snapshot().providers[0].quota.used,5);
});
test('首次usage期间仍累计实际发送，官方查询完成不会抹去新增用量',async()=>{
 const f=await setup();f.control.used=100;const wait=deferred();f.control.wait=wait;const probing=f.core.probe('deepl');
 await until(()=>f.control.usage.length>=1);await run(f.core,'1234');wait.resolve();await probing;
 assert.equal(f.core.snapshot().providers[0].quota.used,104);
});

test('换key丢弃旧usage，旧探测迟到不能覆盖新账户额度',async()=>{
 const f=await setup();f.control.amount=0;const wait=deferred();f.control.wait=wait;const old=f.core.probe('deepl');
 await until(()=>f.control.usage.length>=1);
 await f.core.save('deepl',true,{key:'synthetic-account-B'});f.control.amount=2_000_000;await f.core.probe('deepl');wait.resolve();await old;
 assert.equal(f.core.snapshot().providers[0].quota.amount,2_000_000);await run(f.core,'new account');
});
test('导入密钥刷新也隔离旧账户，不借用之前的零额状态',async()=>{
 const f=await setup();f.control.amount=0;await f.core.probe('deepl');
 await f.vault.set('deepl',{key:'synthetic-imported-account'});await f.core.refreshStoredState();
 f.control.amount=1_000_000;await f.core.probe('deepl');await run(f.core,'hello');
 assert.equal(f.core.snapshot().providers[0].quota.used,5);
});
test('同账户探测乱序只接收最后一次发起的结果',async()=>{
 const f=await setup();f.control.amount=0;const wait=deferred();f.control.wait=wait;const old=f.core.probe('deepl');
 await until(()=>f.control.usage.length>=1);
 f.control.amount=1_000_000;await f.core.probe('deepl');wait.resolve();await old;
 assert.equal(f.core.snapshot().providers[0].quota.amount,1_000_000);
});
for(const kind of ['local','llm'])test(`Core ${kind}缺x保留整段译文，只调用一次并零重试`,async()=>{
 let calls=0;const raw='前文𝑁与ℎ后文';const provider={id:'fixture',name:'fixture',version:'1',kind,official:true,usedFor:['fast','accurate','combined'],auth:[],limits:{maxChars:1000,maxSegments:1,concurrency:1},placeholders:'prompt',classifyError,translate:async req=>{calls++;assert.equal(req.texts[0],'前文<x0/>𝑁与ℎ后文<x1/>');return[raw]}};
 const f=await setup({provider});const result=await run(f.core,'前文<x0/>𝑁与ℎ后文<x1/>',{stream:false});
 assert.equal(calls,1);assert.equal(result.text.replace(/<x\d+\/>/g,''),raw);assert.equal(validTranslation('前文<x0/>𝑁与ℎ后文<x1/>',result.text),true);assert.equal(result.timing.retries,0);
 const cached=await run(f.core,'前文<x0/>𝑁与ℎ后文<x1/>');assert.equal(cached.cached,true);assert.equal(calls,1);
});
test('Unicode数学字母与普通字母不共用缓存或人工记忆，实际请求字节不归一化',async()=>{
 const calls=[];const provider={id:'fixture',name:'fixture',version:'1',kind:'local',official:true,usedFor:['fast'],auth:[],limits:{maxChars:1000,maxSegments:1,concurrency:1},placeholders:'prompt',classifyError,translate:async req=>{calls.push(req.texts[0]);return req.texts;}};
 const f=await setup({provider}),source='𝑁 𝐱 ℎ 𝛼 e\u0301 Ａ',folded=source.normalize('NFKC');
 await f.core.saveMemory('en','zh-CN',folded,'普通符号记忆');assert.equal((await run(f.core,source)).text,source);assert.deepEqual(calls,[source]);
 assert.equal((await run(f.core,folded)).text,'普通符号记忆');
 await f.core.saveMemory('en','zh-CN',source,source);assert.equal((await f.storage.tmGet('en','zh-CN',source)).text,source);
});
