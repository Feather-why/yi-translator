import test from 'node:test';
import assert from 'node:assert/strict';
import {provider,request,context,json} from './helpers.mjs';
const llama=provider('llamacpp'),encoder=new TextEncoder();
const event=(value)=>'data: '+JSON.stringify(value)+'\n\n';
const delta=(text)=>event({choices:[{index:0,delta:{content:text},finish_reason:null}]});
const stop=(timings)=>event({choices:[{index:0,delta:{},finish_reason:'stop'}],...(timings?{timings}:{})});
const done='data: [DONE]\n\n';
function replay(parts,{keepOpen=false}={}){
  let next=0,cancelled=0;
  const body=new ReadableStream({pull(controller){if(next<parts.length){const value=parts[next++];controller.enqueue(typeof value==='string'?encoder.encode(value):value);}else if(!keepOpen)controller.close();},cancel(){cancelled++;}});
  return{response:new Response(body,{headers:{'Content-Type':'text/event-stream; charset=utf-8'}}),body,cancelled:()=>cancelled};
}
const streamRequest=(texts=['Hello.'])=>({...request(texts),stream:true});
const rejectsCode=(promise,code)=>assert.rejects(promise,(error)=>error.info?.code===code);

test('llama SSE按真实生成累计回调，未结束前不返回整段，传内部streamResponse且保留官方采样',async()=>{
  let controller;const body=new ReadableStream({start(value){controller=value;}}),response=new Response(body,{headers:{'Content-Type':'text/event-stream'}}),partials=[];
  const ctx=context((_url,init)=>{const input=JSON.parse(init.body);assert.equal(input.stream,true);assert.equal(init.streamResponse,true);assert.equal(init.headers.Accept,'text/event-stream');assert.equal(init.signal,ctx.signal);assert.equal(input.temperature,.7);assert.equal(input.top_p,.6);assert.equal(input.top_k,20);assert.equal(input.max_tokens,1024);return response;});ctx.onPartial=(text,index)=>partials.push({text,index});
  let returned=false;const pending=llama.translate(streamRequest(),ctx).then((value)=>{returned=true;return value;});
  controller.enqueue(encoder.encode(delta('你')));await new Promise((resolve)=>setImmediate(resolve));assert.deepEqual(partials,[{text:'你',index:0}]);assert.equal(returned,false);
  controller.enqueue(encoder.encode(delta('好。')+stop()+done));assert.deepEqual(await pending,['你好。']);assert.deepEqual(partials,[{text:'你',index:0},{text:'你好。',index:0}]);assert.equal(body.locked,false);
});

test('任意UTF8字节切分、BOM、CRLF、多事件和多data行不会损坏中文/emoji',async()=>{
  const multiline=JSON.stringify({choices:[{index:0,delta:{content:'<g0>世界😀</g0>'},finish_reason:null}]},null,2).split('\n').map((line)=>'data: '+line).join('\r\n')+'\r\n\r\n';
  const input='\uFEFF: heartbeat\r\nid: 9\r\nretry: 20\r\n\r\n'+delta('你好').replaceAll('\n','\r\n')+multiline+stop().replaceAll('\n','\r\n')+done.replaceAll('\n','\r\n');
  const bytes=encoder.encode(input),parts=Array.from(bytes,(byte)=>Uint8Array.of(byte)),fixture=replay(parts),partials=[],ctx=context(()=>fixture.response);ctx.onPartial=(text)=>partials.push(text);
  assert.deepEqual(await llama.translate(streamRequest(),ctx),['你好<g0>世界😀</g0>']);assert.deepEqual(partials,['你好','你好<g0>世界😀</g0>']);assert.equal(fixture.body.locked,false);
});

test('SSE支持纯CR边界，忽略空role与heartbeat；最后有效timings只报告一次',async()=>{
  const fixture=replay([(': ping\n\n'+event({choices:[{index:0,delta:{role:'assistant',content:''},finish_reason:null}],timings:{predicted_ms:1}})+delta(' 完整译文。 ')+stop()+event({choices:[],usage:{completion_tokens:4},timings:{prompt_ms:3,predicted_ms:17,prompt_n:6,predicted_n:4}})+done).replaceAll('\n','\r')]),partials=[],timings=[],ctx=context(()=>fixture.response);
  ctx.onPartial=(text)=>partials.push(text);ctx.recordTiming=(value)=>timings.push(value);
  assert.deepEqual(await llama.translate(streamRequest(),ctx),['完整译文。']);assert.deepEqual(partials,[' 完整译文。 ']);assert.deepEqual(timings,[{phase:'model',promptMs:3,generationMs:17,promptTokens:6,outputTokens:4}]);
});

test('只有stream=true且有partial回调才请求SSE，其他调用保持JSON，不伪造流式',async()=>{
  for(const streamed of [false,true]){
    const ctx=context((_url,init)=>{assert.equal(JSON.parse(init.body).stream,false);assert.equal(init.streamResponse,undefined);return json({choices:[{message:{content:'完整结果。'},finish_reason:'stop'}]});});
    if(!streamed)ctx.onPartial=()=>assert.fail('不能从完整JSON合成partial');assert.deepEqual(await llama.translate({...request(['Hello.']),stream:streamed},ctx),['完整结果。']);
  }
});

test('多输入逐条真实流式，累计文本从每段重新开始并传准确index',async()=>{
  const callbacks=[],ctx=context((_url,init)=>replay([delta(JSON.parse(init.body).messages[0].content.endsWith('First.')?'第一段。':'第二段。')+stop()+done]).response);ctx.onPartial=(text,index)=>callbacks.push({text,index});
  assert.deepEqual(await llama.translate(streamRequest(['First.','Second.']),ctx),['第一段。','第二段。']);assert.deepEqual(callbacks,[{text:'第一段。',index:0},{text:'第二段。',index:1}]);
});

test('length截断拒绝交付完整结果，仍记录末尾真实模型计时并释放reader',async()=>{
  const fixture=replay([delta('半句')+event({choices:[{index:0,delta:{},finish_reason:'length'}],timings:{predicted_ms:8,predicted_n:2}})],{keepOpen:true}),timings=[],ctx=context(()=>fixture.response);ctx.onPartial=()=>{};ctx.recordTiming=(value)=>timings.push(value);
  await rejectsCode(llama.translate(streamRequest(),ctx),'bad_input');assert.equal(fixture.body.locked,false);assert.equal(fixture.cancelled(),1);assert.deepEqual(timings,[{phase:'model',generationMs:8,outputTokens:2}]);
});

test('未完成EOF、缺终止事件、无finish stop、空译文和不支持的finish均拒绝',async()=>{
  for(const input of [delta('半句'),delta('半句')+stop(),delta('半句')+done,stop()+done,delta('半句')+event({choices:[{delta:{},finish_reason:'tool_calls'}]})+done,delta('半句')+stop()+'data: [DONE]\n']){
    const fixture=replay([input]),ctx=context(()=>fixture.response);ctx.onPartial=()=>{};await rejectsCode(llama.translate(streamRequest(),ctx),'server');assert.equal(fixture.body.locked,false);
  }
});

test('坏JSON、错误增量、无效UTF8与服务结束后继续正文不会被当成成功',async()=>{
  const cases=['data: {bad}\n\n',event(null),event({choices:[null]}),event({choices:[{delta:{content:12}}]}),event({choices:[{delta:'invalid'}]}),delta('文本')+stop()+delta('越界')+done,Uint8Array.of(0xff)];
  for(const input of cases){const fixture=replay([input],{keepOpen:typeof input==='string'}),ctx=context(()=>fixture.response);ctx.onPartial=()=>{};await rejectsCode(llama.translate(streamRequest(),ctx),'server');assert.equal(fixture.body.locked,false);}
});

test('HTTP错误保持原分类，SSE错误事件与error对象也准确拒绝',async()=>{
  for(const [status,code]of [[401,'auth'],[403,'auth'],[429,'rate_limit'],[456,'quota'],[500,'server'],[400,'bad_input']]){
    const ctx=context(()=>json({error:'fixture'},status));ctx.onPartial=()=>{};await rejectsCode(llama.translate(streamRequest(),ctx),code);
  }
  for(const [payload,code]of [[{error:{code:429}},'rate_limit'],[{error:{type:'authentication_error'}},'auth'],[{error:{code:'insufficient_quota'}},'quota'],[{error:{status:400}},'bad_input']]){
    const fixture=replay([event(payload)],{keepOpen:true}),ctx=context(()=>fixture.response);ctx.onPartial=()=>{};await rejectsCode(llama.translate(streamRequest(),ctx),code);assert.equal(fixture.body.locked,false);
  }
  const fixture=replay(['event: error\ndata: '+JSON.stringify({message:'fixture'})+'\n\n'],{keepOpen:true}),ctx=context(()=>fixture.response);ctx.onPartial=()=>{};await rejectsCode(llama.translate(streamRequest(),ctx),'server');
});

test('正文、单事件、总传输分别限额，拒绝超量且不继续回调',async()=>{
  const cases=[delta('a'.repeat(65537)), 'data: '+ ' '.repeat(131073)+'\n\n', ': '+ ' '.repeat(4*1024*1024)];
  for(const input of cases){const fixture=replay([input],{keepOpen:true}),ctx=context(()=>fixture.response);let calls=0;ctx.onPartial=()=>calls++;await rejectsCode(llama.translate(streamRequest(),ctx),'server');assert.equal(calls,0);assert.equal(fixture.body.locked,false);assert.equal(fixture.cancelled(),1);}
});

test('待读取期间取消会cancel底层并释放锁，同一chunk余下事件不再partial',async()=>{
  let controller,cancelled=0;const body=new ReadableStream({start(value){controller=value;},cancel(){cancelled++;}}),abort=new AbortController(),partials=[];
  const ctx=context(()=>new Response(body,{headers:{'Content-Type':'text/event-stream'}}));ctx.signal=abort.signal;ctx.onPartial=(text)=>partials.push(text);
  const pending=llama.translate(streamRequest(),ctx);controller.enqueue(encoder.encode(delta('前缀')));await new Promise((resolve)=>setImmediate(resolve));abort.abort();await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(partials,['前缀']);assert.equal(cancelled,1);assert.equal(body.locked,false);
  const secondAbort=new AbortController(),fixture=replay([delta('一')+delta('二')+stop()+done],{keepOpen:true}),second=context(()=>fixture.response),values=[];second.signal=secondAbort.signal;second.onPartial=(text)=>{values.push(text);secondAbort.abort();};await assert.rejects(llama.translate(streamRequest(),second),{name:'AbortError'});assert.deepEqual(values,['一']);assert.equal(fixture.body.locked,false);
});

test('预先取消不发送请求，回调异常隔离，DONE后的传输不再产生partial',async()=>{
  const abort=new AbortController();abort.abort();const before=context(()=>assert.fail('不该发送请求'));before.signal=abort.signal;before.onPartial=()=>{};await assert.rejects(llama.translate(streamRequest(),before),{name:'AbortError'});assert.equal(before.calls.length,0);
  const fixture=replay([delta('你好')+stop()+done+delta('不应处理')],{keepOpen:true}),ctx=context(()=>fixture.response);let calls=0;ctx.onPartial=()=>{calls++;throw Error('UI异常');};ctx.recordTiming=()=>{throw Error('诊断异常');};assert.deepEqual(await llama.translate(streamRequest(),ctx),['你好']);assert.equal(calls,1);assert.equal(fixture.cancelled(),1);assert.equal(fixture.body.locked,false);
});

test('SSE请求收到JSON类型不能伪装流式交付',async()=>{
  const ctx=context(()=>json({choices:[{message:{content:'完整JSON'}}]}));ctx.onPartial=()=>assert.fail('不能合成partial');await rejectsCode(llama.translate(streamRequest(),ctx),'server');
});

test('读取中的真实网络异常拒绝前缀、保持network分类并释放reader锁',async()=>{
  let controller;const body=new ReadableStream({start(value){controller=value;}}),ctx=context(()=>new Response(body,{headers:{'Content-Type':'text/event-stream'}})),partials=[];
  ctx.onPartial=(text)=>{partials.push(text);controller.error(new TypeError('fixture connection reset'));};
  const pending=llama.translate(streamRequest(),ctx);controller.enqueue(encoder.encode(delta('前缀')));
  await assert.rejects(pending,(error)=>llama.classifyError(error).code==='network');assert.deepEqual(partials,['前缀']);assert.equal(body.locked,false);
});
