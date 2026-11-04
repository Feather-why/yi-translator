import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{TranslatePort}=require('../.compiled/backend/ports/translate.js');
class Event{listeners=new Set();addListener(fn){this.listeners.add(fn);}removeListener(fn){this.listeners.delete(fn);}emit(...args){for(const fn of [...this.listeners])fn(...args);}}
class Port{onMessage=new Event();onDisconnect=new Event();messages=[];at=[];postMessage(value){this.messages.push(structuredClone(value));this.at.push(performance.now());}send(value){this.onMessage.emit(value);}}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const stop=Date.now()+2000;while(!check()){assert.ok(Date.now()<stop,'端口操作没有完成');await pause(2);}}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const value=(text='完整译文')=>({text,provider:'replay',cached:false,timing:{queueMs:12,providerMs:41,firstTokenMs:7}});
const input=(jobId='job',extra={})=>({jobId,sourceLang:'en',targetLang:'zh-CN',mode:'accurate',priority:0,context:{url:'https://example.test'},segments:[{id:'s1',text:'Hello.',kind:'paragraph'}],stream:true,...extra});
function attach(t,service,concurrency=4){const port=new Port(),backend=new TranslatePort(port,service,concurrency);t.after(()=>backend.dispose());return port;}
const partial=(task,text,provider='replay',extra={})=>task.observer?.onPartial?.({text,provider,...extra});
const finals=port=>port.messages.filter(m=>m.type==='result');

test('stream仅接受boolean，false不注册预览；result原样携带本次timing',async t=>{
 let calls=0;const port=attach(t,{translate:async(job,segment,tier,signal,observer)=>{calls++;assert.equal(observer.onPartial,undefined);return value();}});
 port.send({type:'job',job:input('invalid',{stream:'true'})});await pause(10);assert.equal(calls,0);
 port.send({type:'job',job:input('off',{stream:false})});await until(()=>finals(port).length===1);
 assert.deepEqual(finals(port)[0].timing,{queueMs:12,providerMs:41,firstTokenMs:7});assert.equal(port.messages.some(m=>m.type==='partial'),false);
});

test('累计partial首字立即，纯标签不算首字，后续80ms合并为最新文本',async t=>{
 let task;const port=attach(t,{translate:(job,segment,tier,signal,observer)=>{task={...deferred(),observer};return task.promise;}});
 port.send({type:'job',job:input()});await until(()=>task);
 for(const text of ['', ' ', '<g0>', '<g0><x1/>', '<g0><g1', '<'])partial(task,text);
 assert.equal(port.messages.length,0);
 partial(task,'你好<g1');partial(task,'你好<g1>世界');partial(task,'你好<g1>世界。</g1>');
 assert.deepEqual(port.messages.map(m=>m.text),['你好<g1']);
 await until(()=>port.messages.length===2);assert.equal(port.messages[1].text,'你好<g1>世界。</g1>');assert.ok(port.at[1]-port.at[0]>=60);
 partial(task,port.messages[1].text);await pause(95);assert.equal(port.messages.length,2);
 task.resolve(value());await until(()=>finals(port).length===1);assert.equal(port.messages.at(-1).type,'job-done');
});

test('result立即清理待发partial，完成后回调不能复活预览',async t=>{
 let task;const port=attach(t,{translate:(job,segment,tier,signal,observer)=>{task={...deferred(),observer};return task.promise;}});
 port.send({type:'job',job:input()});await until(()=>task);partial(task,'第一');partial(task,'待发的旧前缀');task.resolve(value());
 await until(()=>finals(port).length===1);partial(task,'完成后迟到');await pause(100);
 assert.deepEqual(port.messages.map(m=>m.type),['partial','result','job-done']);assert.equal(port.messages[0].text,'第一');
});

for(const action of ['cancel','replace','disconnect'])test(`${action}清理80ms待发和迟到旧回调`,async t=>{
 const tasks=[];const port=attach(t,{translate:(job,segment,tier,signal,observer)=>{const task={...deferred(),observer,signal};tasks.push(task);return task.promise;}});
 port.send({type:'job',job:input()});await until(()=>tasks.length===1);partial(tasks[0],'旧任务首字');partial(tasks[0],'旧任务待发');
 if(action==='cancel')port.send({type:'cancel',jobId:'job'});
 else if(action==='disconnect')port.onDisconnect.emit();
 else{port.send({type:'job',job:input()});await until(()=>tasks.length===2);partial(tasks[1],'新任务');tasks[1].resolve(value('新任务完成'));}
 assert.equal(tasks[0].signal.aborted,true);partial(tasks[0],'旧任务迟到');tasks[0].resolve(value('旧结果'));await pause(110);
 assert.equal(port.messages.some(m=>/旧任务待发|旧任务迟到|旧结果/.test(m.text||'')),false);
 if(action==='replace')assert.deepEqual(finals(port).map(m=>m.text),['新任务完成']);else assert.equal(finals(port).length,0);
});

test('final预览后抑制迟到fast前缀，fast完整译文后停止preview但保留最终result',async t=>{
 const tasks=new Map();const port=attach(t,{translate:(job,segment,tier,signal,observer)=>{const task={...deferred(),observer};tasks.set(tier,task);return task.promise;}});
 port.send({type:'job',job:input('combined',{mode:'combined'})});await until(()=>tasks.size===2);
 partial(tasks.get('accurate'),'精确首字');partial(tasks.get('fast'),'迟到高速首字');await pause(90);
 assert.deepEqual(port.messages.filter(m=>m.type==='partial').map(m=>m.stage),['final']);
 tasks.get('fast').resolve(value('可读高速全文'));await until(()=>finals(port).length===1);
 partial(tasks.get('accurate'),'不应覆盖高速全文的半句');await pause(90);assert.equal(port.messages.filter(m=>m.type==='partial').length,1);
 tasks.get('accurate').resolve(value('精确全文'));await until(()=>finals(port).length===2);assert.deepEqual(finals(port).map(m=>m.stage),['fast','final']);
});

test('fast失败不误禁用仍在生成的final预览',async t=>{
 const tasks=new Map();const port=attach(t,{translate:(job,segment,tier,signal,observer)=>{const task={...deferred(),observer};tasks.set(tier,task);return task.promise;}});
 port.send({type:'job',job:input('combined',{mode:'combined'})});await until(()=>tasks.size===2);tasks.get('fast').reject(Error('fast unavailable'));
 await until(()=>port.messages.some(m=>m.type==='job-done'&&m.stage==='fast'));
 partial(tasks.get('accurate'),'准确档仍在翻译');assert.equal(port.messages.at(-1).type,'partial');
 tasks.get('accurate').resolve(value());await until(()=>finals(port).length===1);
});

test('队列等待沿用收到job的起点；不同段首条preview不受另一段80ms限制',async t=>{
 const tasks=[];const port=attach(t,{translate:(job,segment,tier,signal,observer)=>{const task={...deferred(),observer,segment,started:performance.now()};tasks.push(task);return task.promise;}},1);
 port.send({type:'job',job:input('queued',{segments:[{id:'a',text:'A.',kind:'paragraph'},{id:'b',text:'B.',kind:'paragraph'}]})});await until(()=>tasks.length===1);
 partial(tasks[0],'甲');await pause(90);tasks[0].resolve(value());await until(()=>tasks.length===2);
 assert.equal(tasks[1].observer.receivedAt,tasks[0].observer.receivedAt);assert.ok(tasks[1].started-tasks[1].observer.receivedAt>=80);
 partial(tasks[1],'乙');assert.ok(port.messages.some(m=>m.type==='partial'&&m.segmentId==='b'));tasks[1].resolve(value());await until(()=>finals(port).length===2);
});

test('后段完整结果在阅读顺序缓冲期间也不再发该段partial',async t=>{
 const tasks=new Map();const port=attach(t,{translate:(job,segment,tier,signal,observer)=>{const task={...deferred(),observer};tasks.set(segment.id,task);return task.promise;}});
 port.send({type:'job',job:input('ordered',{segments:[{id:'a',text:'A.',kind:'paragraph'},{id:'b',text:'B.',kind:'paragraph'}]})});await until(()=>tasks.size===2);
 partial(tasks.get('b'),'第二段首字');partial(tasks.get('b'),'旧的第二段待发');tasks.get('b').resolve(value('第二段完成'));await pause(100);
 assert.equal(finals(port).length,0);partial(tasks.get('b'),'已经完成却迟到');
 tasks.get('a').resolve(value('第一段完成'));await until(()=>finals(port).length===2);await pause(90);
 assert.deepEqual(port.messages.filter(m=>m.type==='partial').map(m=>m.text),['第二段首字']);assert.deepEqual(finals(port).map(m=>m.segmentId),['a','b']);
});

test('逻辑任务开始后视口priority仍传递给实际服务槽的动态getter',async t=>{
 let task;const port=attach(t,{translate:(job,segment,tier,signal,observer)=>{task={...deferred(),observer};return task.promise;}});
 port.send({type:'job',job:input('priority',{priority:100})});await until(()=>task);
 assert.equal(task.observer.priority(),100);
 port.send({type:'priority',jobId:'priority',segmentIds:['s1'],priority:0});
 assert.equal(task.observer.priority(),0);
 port.send({type:'priority',jobId:'priority',segmentIds:['other'],priority:7});assert.equal(task.observer.priority(),0);
 task.resolve(value());await until(()=>finals(port).length===1);
});
