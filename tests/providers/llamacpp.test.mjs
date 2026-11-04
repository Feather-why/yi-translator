import test from 'node:test';
import assert from 'node:assert/strict';
import { provider, request, context, json } from './helpers.mjs';
const llamacpp = provider('llamacpp');

test('llama.cpp 使用官方模型采样参数、单用户消息和标签约束', async () => {
  const ctx = context((url, init) => {
    assert.equal(url, 'http://127.0.0.1:8081/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.messages.length, 1); assert.equal(body.messages[0].role, 'user');
    assert.match(body.messages[0].content, /中文/); assert.match(body.messages[0].content, /<g0>/);
    assert.equal(body.temperature, 0.7); assert.equal(body.top_p, 0.6); assert.equal(body.top_k, 20); assert.equal(body.repeat_penalty, 1.05);
    assert.equal(body.min_p, 0); assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    return json({ choices: [{ message: { content: '你好 <g0>世界 <g1>模型</g1></g0> <x0/>.' }, finish_reason: 'stop' }] });
  }, { url: 'http://127.0.0.1:8081/v1/', key: 'fixture-token' });
  const [text] = await llamacpp.translate(request(), ctx);
  assert.match(text, /^你好/);
});

test('llama.cpp 健康检查不编造显存或吞吐', async () => {
  const ctx = context((url) => { assert.equal(url, 'http://127.0.0.1:8081/health'); return json({ status: 'ok' }); });
  const result = await llamacpp.health(ctx);
  assert.equal(result.ok, true); assert.equal(result.model, undefined); assert.equal(result.vramMB, undefined);
});

test('llama.cpp 拒绝截断输出和缺失内容', async () => {
  for (const choice of [{ finish_reason: 'length', message: { content: '半句' } }, { message: {} }]) {
    await assert.rejects(llamacpp.translate(request(['Hello']), context(() => json({ choices: [choice] }))));
  }
});

test('llama.cpp 拒绝 URL 内嵌密钥', async () => {
  const ctx = context(() => { throw new Error('不应发送请求'); }, { url: 'http://user:secret@localhost:8081' });
  await assert.rejects(llamacpp.translate(request(['Hello']), ctx), (error) => error.info.code === 'bad_input');
  assert.equal(ctx.calls.length, 0);
});

test('llama.cpp 纯文本使用官方翻译边界，不把标签示例混入待翻译原文', async () => {
  const source = 'The browser translates this page locally.';
  const ctx = context((_url, init) => {
    const prompt = JSON.parse(init.body).messages[0].content;
    assert.equal(prompt.split('：\n').at(-1), source);
    assert.doesNotMatch(prompt, /<[gx]\d/);
    assert.doesNotMatch(prompt, /XML/);
    return json({ choices: [{ message: { content: '浏览器在本地翻译此页面。' }, finish_reason: 'stop' }] });
  });
  await llamacpp.translate(request([source]), ctx);
});

test('llama.cpp 标签要求及上下文位于翻译模板前，模板后只有原文', async () => {
  const source = 'Read the <g0>guide</g0> and keep <x0/>.';
  for (const strictPlaceholders of [false, true]) {
    const ctx = context((_url, init) => {
      const prompt = JSON.parse(init.body).messages[0].content;
      assert.equal(prompt.split('：\n').at(-1), source);
      assert.ok(prompt.indexOf('XML') < prompt.indexOf('将以下文本翻译为'));
      assert.ok(prompt.indexOf('背景信息') < prompt.indexOf('将以下文本翻译为'));
      assert.equal((prompt.match(/<g0>/g) || []).length, 1);
      return json({ choices: [{ message: { content: '阅读<g0>指南</g0>，保留<x0/>。' }, finish_reason: 'stop' }] });
    });
    await llamacpp.translate({ ...request([source]), strictPlaceholders, context: { url: 'https://example.test', title: 'Synthetic title' } }, ctx);
  }
});

test('llama.cpp 自定义模板实际替换四变量，XML 要求前附且官方原文边界保留，零温度生效', async () => {
  const source = 'Read <g0>{{to}}</g0> <x0/>.';
  const page = { url: 'https://example.test/page', title: 'Synthetic title', summary: 'Synthetic summary' };
  const ctx = context((_url, init) => {
    const body = JSON.parse(init.body); const prompt = body.messages[0].content;
    assert.equal(body.temperature, 0);
    assert.ok(prompt.indexOf('严格保留') < prompt.indexOf('附加翻译要求'));
    assert.ok(prompt.indexOf('附加翻译要求') < prompt.lastIndexOf('将以下文本翻译为'));
    assert.ok(prompt.includes(`from=en to=zh-CN text=${source} context=${JSON.stringify(page)}`));
    assert.equal(prompt.split('：\n').at(-1), source);
    return json({ choices: [{ message: { content: '阅读<g0>{{to}}</g0><x0/>。' }, finish_reason: 'stop' }] });
  }, { prompt: 'from={{from}} to={{to}} text={{text}} context={{context}}', temperature: '0' });
  assert.deepEqual(await llamacpp.translate({ ...request([source]), sourceLang: 'en', context: page, strictPlaceholders: true }, ctx), ['阅读<g0>{{to}}</g0><x0/>。']);
});

test('llama.cpp 直接调用拒绝非法温度且不请求上游', async () => {
  for (const temperature of ['Infinity', '-0.1', '3']) {
    const ctx = context(() => { throw new Error('不应请求'); }, { temperature });
    await assert.rejects(llamacpp.translate(request(), ctx), (error) => error.info.code === 'bad_input');
    assert.equal(ctx.calls.length, 0);
  }
});

test('llama.cpp 术语使用官方整句模板，标签要求明确不是句子边界', async () => {
  const source = 'Read <g0>the guide</g0>.';
  const ctx = context((_url, init) => {
    const prompt = JSON.parse(init.body).messages[0].content;
    assert.ok(prompt.includes('XML 标记不是句子边界'));
    assert.ok(prompt.includes('参考下面的翻译：\nthe guide 翻译成 指南'));
    assert.equal(prompt.split('：\n').at(-1), source);
    return json({ choices: [{ message: { content: '阅读<g0>指南</g0>。' }, finish_reason: 'stop' }] });
  });
  await llamacpp.translate({ ...request([source]), terminology: [{ source: 'the guide', target: '指南' }] }, ctx);
});

test('llama.cpp只报告真实响应timings，区分prompt评估和生成且不附带文本',async()=>{
  const records=[],ctx=context(()=>json({choices:[{message:{content:'你好。'},finish_reason:'stop'}],timings:{prompt_ms:0,predicted_ms:37.25,prompt_n:0,predicted_n:3,cache_n:88}}));
  ctx.recordTiming=(record)=>records.push(record);assert.deepEqual(await llamacpp.translate(request(['Hello.']),ctx),['你好。']);
  assert.deepEqual(records,[{phase:'model',promptMs:0,generationMs:37.25,promptTokens:0,outputTokens:3}]);
});

test('llama.cpp缺失或非法timings不伪造计时，独立有效字段仍可报告',async()=>{
  for(const timings of [undefined,[],{prompt_ms:-1,predicted_ms:'9',prompt_n:0.5,predicted_n:null},{prompt_ms:Infinity,predicted_ms:NaN}]){
    const records=[],ctx=context(()=>json({choices:[{message:{content:'你好。'}}],timings}));ctx.recordTiming=(record)=>records.push(record);await llamacpp.translate(request(['Hello.']),ctx);assert.deepEqual(records,[]);
  }
  const records=[],ctx=context(()=>json({choices:[{message:{content:'你好。'}}],timings:{prompt_ms:'1',predicted_ms:4}}));ctx.recordTiming=(record)=>records.push(record);await llamacpp.translate(request(['Hello.']),ctx);assert.deepEqual(records,[{phase:'model',generationMs:4}]);
});

test('llama.cpp诊断故障不影响译文，模型截断时仍保留服务真实用时',async()=>{
  const ctx=context(()=>json({choices:[{message:{content:'你好。'}}],timings:{predicted_ms:4}}));ctx.recordTiming=()=>{throw Error('诊断不可用');};assert.deepEqual(await llamacpp.translate(request(['Hello.']),ctx),['你好。']);
  const records=[],truncated=context(()=>json({choices:[{message:{content:'半句'},finish_reason:'length'}],timings:{predicted_ms:7}}));truncated.recordTiming=(record)=>records.push(record);await assert.rejects(llamacpp.translate(request(['Hello.']),truncated));assert.deepEqual(records,[{phase:'model',generationMs:7}]);
});

test('llama.cpp默认标题预算256，保留摘要预算和完整待翻译正文',async()=>{
  const source='Original text with intact meaning. '.repeat(25),title='Map title '.repeat(100),summary='S'.repeat(400);
  const ctx=context((_url,init)=>{
    const body=JSON.parse(init.body),prompt=body.messages[0].content;
    assert.ok(prompt.startsWith(`背景信息：${title.slice(0,256)}\n${summary.slice(0,300)}\n`));
    assert.equal(prompt.split('：\n').at(-1),source);assert.equal(body.max_tokens,1024);assert.equal(body.temperature,.7);
    return json({choices:[{message:{content:'完整译文。'},finish_reason:'stop'}]});
  });
  await llamacpp.translate({...request([source]),context:{url:'https://example.test',title,summary}},ctx);
});

test('llama.cpp普通标题和上下文保持原样，标题预算不切断Unicode代理对',async()=>{
  for(const [title,expected]of [['Normal title','Normal title'],['a'.repeat(255)+'😀tail','a'.repeat(255)],['a'.repeat(254)+'😀tail','a'.repeat(254)+'😀']]){
    const ctx=context((_url,init)=>{
      const prompt=JSON.parse(init.body).messages[0].content;assert.ok(prompt.startsWith(`背景信息：${expected}\nNormal summary\n`));
      assert.equal(prompt.split('：\n').at(-1),'A complete original sentence 😀.');
      return json({choices:[{message:{content:'完整句子😀。'}}]});
    });await llamacpp.translate({...request(['A complete original sentence 😀.']),context:{url:'https://example.test',title,summary:'Normal summary'}},ctx);
  }
});

test('llama.cpp自定义prompt保留原始context和title语义，不自动套用默认标题预算',async()=>{
  const page={url:'https://example.test',title:'Custom context title '.repeat(40),summary:'Custom summary'},source='Hello.';
  const ctx=context((_url,init)=>{
    const prompt=JSON.parse(init.body).messages[0].content;assert.ok(prompt.startsWith(`背景信息：${page.title}\n${page.summary}\n`));assert.ok(prompt.includes(`context=${JSON.stringify(page)}`));assert.equal(prompt.split('：\n').at(-1),source);
    return json({choices:[{message:{content:'你好。'}}]});
  },{prompt:'context={{context}} source={{text}}'});
  await llamacpp.translate({...request([source]),context:page},ctx);
});
