import test from 'node:test';
import assert from 'node:assert/strict';
import { provider, request, context, json, requireCompiled } from './helpers.mjs';
const google=provider('unofficial/google-web');
const {providerMetadata,normalizeOptions}=requireCompiled('../.compiled/backend/provider-options.js');

test('Google网页兜底标识非官方，不承诺免费额度，限速和权重不能上调',()=>{
  assert.equal(google.official,false);assert.equal(google.freeQuota,undefined);assert.equal(google.limits.qps,0.2);assert.equal(google.limits.concurrency,1);assert.equal(google.limits.maxSegments,1);
  const meta=providerMetadata(google);assert.equal(meta.defaults.weight,0);assert.deepEqual(meta.editable,['timeoutMs','maxChars']);
  for(const key of ['weight','qps','concurrency','usedFor','quota','endpoint'])assert.throws(()=>normalizeOptions(google,{[key]:key==='usedFor'?['fast']:99}),e=>e.info.code==='bad_input');
});

test('Google网页真实响应回放保留分句顺序，只发固定端点且不带Cookie',async()=>{
 const ctx=context((url,init)=>{
   const u=new URL(url);assert.equal(u.origin,'https://translate.googleapis.com');assert.equal(u.pathname,'/translate_a/single');assert.equal(u.searchParams.get('q'),'Phonetics mainly concerns speech sounds.');
   assert.equal(u.searchParams.get('client'),'gtx');assert.equal(u.searchParams.get('sl'),'auto');assert.equal(u.searchParams.get('tl'),'zh-CN');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.timeoutMs,8000);
   return json([[['语音学主要涉及语音。','Phonetics mainly concerns speech sounds.',null,null,3]],null,'en',null,null,null,null,[]]);
 });
 assert.deepEqual(await google.translate(request(['Phonetics mainly concerns speech sounds.']),ctx),['语音学主要涉及语音。']);assert.equal(ctx.calls.length,1);
});

test('Google429不在适配器里重试，错误明确要求暂停',async()=>{
 const ctx=context(()=>json({error:'Too Many Requests'},429));
 await assert.rejects(google.translate(request(['Hello.']),ctx),e=>e.info.code==='rate_limit'&&e.info.retryable===false&&e.info.message.includes('暂停'));assert.equal(ctx.calls.length,1);
});

test('Google网页异常结构/空译文不能当成功',async()=>{
 for(const value of [{sentences:[]},[[]],[[[null,'source']]],[[['','source']]]])await assert.rejects(google.translate(request(['Hello.']),context(()=>json(value))),e=>e.info.code==='server');
});

test('Google网页取消、非法批次与不明确目标语言不发网络',async()=>{
 const ctx=context(()=>{throw new Error('must not send');});const controller=new AbortController();controller.abort();
 await assert.rejects(google.translate(request(['Hello.']),{...ctx,signal:controller.signal}),e=>e.name==='AbortError');
 for(const req of [request(['a','b']),request(['']),{...request(['a']),targetLang:'auto'}])await assert.rejects(google.translate(req,ctx),e=>e.info.code==='bad_input');assert.equal(ctx.calls.length,0);
});
