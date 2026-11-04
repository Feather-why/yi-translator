import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),build=process.env.BACKEND_BUILD_DIR||fileURLToPath(new URL('../.compiled/',import.meta.url));
const {StatusPort}=require(build+'/backend/ports/status.js'),{SyncService}=require(build+'/backend/sync/index.js'),{sensitiveSender}=require(build+'/backend/rpc.js'),{disposeSensitivePolicy}=require(build+'/backend/sensitive-policy.js');
const tick=()=>new Promise(r=>setImmediate(r)),delay=ms=>new Promise(r=>setTimeout(r,ms));
function event(){const listeners=new Set();return{listeners,addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),emit(...args){for(const fn of [...listeners])fn(...args)}}}
function area(){const data={};return{data,writes:0,reads:0,async get(keys){this.reads++;return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(data[k])]))},async set(value){this.writes++;Object.assign(data,structuredClone(value))}}}

test('10个状态端口100次普通变化只算一份新快照、每端口只收一条',async(t)=>{
 const listeners=event();let snapshots=0,value=0;const service={snapshot:()=>{snapshots++;return{at:value}},subscribe:fn=>{listeners.addListener(fn);return()=>listeners.removeListener(fn)},probe:async()=>{},action:async()=>{}};
 const ports=Array.from({length:10},()=>({messages:[],onMessage:event(),onDisconnect:event(),postMessage(m){this.messages.push(structuredClone(m))}}));
 const handlers=ports.map(p=>new StatusPort(p,service));t.after(()=>handlers.forEach(h=>h.dispose()));assert.equal(snapshots,1);assert.equal(listeners.listeners.size,1);
 for(let i=1;i<=100;i++){value=i;listeners.emit()};assert.ok(ports.every(p=>p.messages.length===1));await delay(125);
 assert.equal(snapshots,2);assert.ok(ports.every(p=>p.messages.length===2&&p.messages[1].status.at===100));
});
test('重要状态立即广播并清掉旧定时器，断开最后端口不再计算',async(t)=>{
 const listeners=event();let snapshots=0;const service={snapshot:()=>({at:++snapshots}),subscribe:fn=>{listeners.addListener(fn);return()=>listeners.removeListener(fn)},probe:async()=>{},action:async()=>{}};
 const port={messages:[],onMessage:event(),onDisconnect:event(),postMessage(m){this.messages.push(m)}};const handler=new StatusPort(port,service);t.after(()=>handler.dispose());
 listeners.emit();listeners.emit(true);assert.equal(port.messages.length,2);await delay(125);assert.equal(port.messages.length,2);
 handler.dispose();assert.equal(listeners.listeners.size,0);listeners.emit(true);assert.equal(snapshots,2);
});
test('坏端口不影响其他订阅，初次发送失败及时注销',async(t)=>{
 const listeners=event(),service={snapshot:()=>({at:1}),subscribe:fn=>{listeners.addListener(fn);return()=>listeners.removeListener(fn)},probe:async()=>{},action:async()=>{}};
 const bad=new StatusPort({onMessage:event(),onDisconnect:event(),postMessage(){throw Error('closed')}},service);t.after(()=>bad.dispose());assert.equal(listeners.listeners.size,0);
 let messages=0;const ok=new StatusPort({onMessage:event(),onDisconnect:event(),postMessage(){messages++}},service);t.after(()=>ok.dispose());listeners.emit(true);assert.equal(messages,2);
});
function sensitiveFixture(t){disposeSensitivePolicy();const local=area(),onChanged=event();globalThis.chrome={storage:{local,onChanged}};t.after(disposeSensitivePolicy);return{local,onChanged,sender:{url:'https://public.example/',tab:{id:1}}}}
test('100次敏感域名检查共用一次读取，更新事件立即失效',async(t)=>{
 const{local,onChanged,sender}=sensitiveFixture(t);assert.ok((await Promise.all(Array.from({length:100},()=>sensitiveSender(sender)))).every(v=>!v));assert.equal(local.reads,1);
 local.data['settings.ui']={sensitive:['public.example']};onChanged.emit({'settings.ui':{newValue:local.data['settings.ui']}},'local');assert.equal(await sensitiveSender(sender),true);assert.equal(local.reads,2);
 onChanged.emit({'backend.usage':{}},'local');await sensitiveSender(sender);assert.equal(local.reads,2);
});
test('设置变更期间的迟到读取不能覆盖新敏感名单',async(t)=>{
 const{local,onChanged,sender}=sensitiveFixture(t);let release;local.get=()=>{local.reads++;return local.reads===1?new Promise(r=>release=r):Promise.resolve({'settings.ui':{sensitive:['public.example']}})};
 const waiting=sensitiveSender(sender);await tick();onChanged.emit({'settings.ui':{}},'local');release({'settings.ui':{sensitive:[]}});assert.equal(await waiting,true);assert.equal(local.reads,2);
});
test('敏感规则读取错误按敏感处理且可恢复，隐身不读取，dispose拒绝迟到重注册',async(t)=>{
 const{local,onChanged,sender}=sensitiveFixture(t);local.get=async()=>{throw Error('read failed')};assert.equal(await sensitiveSender(sender),true);
 local.get=async()=>({'settings.ui':{sensitive:[]}});assert.equal(await sensitiveSender(sender),false);assert.equal(await sensitiveSender({...sender,tab:{id:1,incognito:true}}),true);
 onChanged.emit({'settings.ui':{}},'local');let release;local.get=()=>new Promise(r=>release=r);const waiting=sensitiveSender(sender);await tick();disposeSensitivePolicy();release({'settings.ui':{sensitive:[]}});assert.equal(await waiting,true);assert.equal(onChanged.listeners.size,0);
});
async function syncFixture(t){const local=area(),scheduled=[],service=new SyncService({storage:local,now:()=>1000,vault:{get:async()=>({}),set:async()=>{}},store:{export:async()=>({version:1,fields:{},usage:{}}),import:async()=>{}},schedule:async when=>scheduled.push(when)});await service.ready();await service.configure({enabled:true,url:'https://fixture.invalid/dav/'});t.after(()=>service.dispose());local.writes=0;scheduled.length=0;return{local,scheduled,service}}
test('100次同步通知只写一次并更新一次相同计划',async(t)=>{
 const{local,scheduled,service}=await syncFixture(t);for(let i=0;i<100;i++)service.notifyChange();await tick();assert.equal(local.writes,1);assert.deepEqual(scheduled,[31000]);service.notifyChange();await tick();assert.equal(local.writes,1);
});
test('同步计划落盘失败后可重试，相同时间也不永久跳过',async(t)=>{
 const{local,scheduled,service}=await syncFixture(t);const set=local.set.bind(local);let fail=true;local.set=async v=>{if(fail){fail=false;throw Error('temporary')}await set(v)};
 service.notifyChange();await tick();assert.match(service.status().lastError,/无法保存/);assert.equal(scheduled.length,0);service.notifyChange();await tick();assert.deepEqual(scheduled,[31000]);
});
test('旧同步写入完成后，较新的停用配置和alarm仍最后生效',async(t)=>{
 const{local,scheduled,service}=await syncFixture(t);const set=local.set.bind(local);let release,began;const started=new Promise(r=>began=r);let block=true;
 local.set=async v=>{if(block){block=false;began();await new Promise(r=>release=r)}await set(v)};
 service.notifyChange();await started;const disabled=service.configure({enabled:false,url:'https://fixture.invalid/dav/'});await tick();release();await disabled;
 assert.equal(local.data['backend.sync'].enabled,false);assert.equal(local.data['backend.sync'].nextRunAt,undefined);assert.equal(scheduled.at(-1),undefined);
});
