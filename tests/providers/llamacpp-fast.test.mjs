import test from 'node:test';
import assert from 'node:assert/strict';
import { provider, request, context, json } from './helpers.mjs';

const llama = provider('llamacpp');
const targetName = (language) => new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(language) || language;
const oldPrompt = (text, language = 'zh-CN') => `将以下文本翻译为${targetName(language)}，注意只需要输出翻译后的结果，不要额外解释：\n${text}`;
const fastPrompt = (text, language = 'zh-CN') => `译成${targetName(language)}，只输出译文：\n${text}`;
const response = () => json({ choices: [{ message: { content: '完整结果。' }, finish_reason: 'stop' }] });
async function capture(input, config = {}) {
  const bodies = [], ctx = context((_url, init) => { bodies.push(JSON.parse(init.body)); return response(); }, config);
  await llama.translate(input, ctx);
  return bodies;
}

test('显式fast/plain采用实测P2完整提示，语言名、官方采样及输出预算不变', async () => {
  for (const [sourceLang, targetLang, text] of [
    ['en', 'zh-CN', 'The western entrance remains closed, but the library reopens on Monday.'],
    ['zh-CN', 'en', '下午六点半开放，不是早上六点半。'],
  ]) {
    const [body] = await capture({ ...request([text]), sourceLang, targetLang, quality: 'fast' });
    assert.deepEqual(body.messages, [{ role: 'user', content: `原文语言：${targetName(sourceLang)}。\n` + fastPrompt(text, targetLang) }]);
    assert.equal(body.temperature, 0.7); assert.equal(body.top_p, 0.6); assert.equal(body.top_k, 20);
    assert.equal(body.min_p, 0); assert.equal(body.repeat_penalty, 1.05); assert.equal(body.max_tokens, 1024);
    assert.equal(body.stream, false); assert.equal(body.cache_prompt, true);
  }
  assert.equal(llama.version, '1.0.9');
});

test('accurate与未指定quality仍逐字使用既有完整模板', async () => {
  const text = 'Do not open the red valve unless both sensors agree.';
  for (const quality of [undefined, 'accurate']) {
    const [body] = await capture({ ...request([text]), quality });
    assert.deepEqual(body.messages, [{ role: 'user', content: oldPrompt(text) }]);
  }
});

test('fast的g、x、嵌套及严格标签路径与accurate请求体完全相同', async () => {
  for (const text of [
    'Read <g4>the guide</g4>.',
    'Close <x5/> before copying the record.',
    'Read <g3>the <g8>inspection record</g8> for March</g3> before using <x5/>.',
  ]) for (const strictPlaceholders of [undefined, true]) {
    const input = { ...request([text]), strictPlaceholders };
    const [fast] = await capture({ ...input, quality: 'fast' });
    const [accurate] = await capture({ ...input, quality: 'accurate' });
    assert.deepEqual(fast, accurate);
    assert.ok(fast.messages[0].content.endsWith(oldPrompt(text)));
    assert.match(fast.messages[0].content, /XML 标记不是句子边界/);
  }
});

test('有术语的fast纯文本保持原术语与整句模板，空术语数组也保守沿用旧路径', async () => {
  const text = 'The coastal bus stops at Harbour Square.';
  for (const terminology of [[{ source: 'coastal bus', target: '沿海公交' }], []]) {
    const input = { ...request([text]), terminology };
    const [fast] = await capture({ ...input, quality: 'fast' });
    const [accurate] = await capture({ ...input, quality: 'accurate' });
    assert.deepEqual(fast, accurate);
    assert.ok(fast.messages[0].content.endsWith(oldPrompt(text)));
    if (terminology.length) assert.ok(fast.messages[0].content.startsWith('参考下面的翻译：\ncoastal bus 翻译成 沿海公交\n'));
  }
  const ctx = context(() => assert.fail('Invalid terminology must not reach the server'));
  await assert.rejects(llama.translate({ ...request([text]), quality: 'fast', terminology: [{ source: '', target: '词' }] }, ctx),
    (error) => error.info?.code === 'bad_input');
  assert.equal(ctx.calls.length, 0);
});

test('fast自定义提示、变量和完整自定义context与原路径完全一致', async () => {
  const text = 'A complete source with {{to}} kept literally.', page = {
    url: 'https://example.test/fast-synthetic', title: 'Custom title '.repeat(40), summary: 'Synthetic summary',
  };
  const config = { prompt: 'from={{from}} to={{to}} text={{text}} context={{context}}', temperature: '0.4' };
  const input = { ...request([text]), sourceLang: 'en', context: page };
  const [fast] = await capture({ ...input, quality: 'fast' }, config);
  const [accurate] = await capture({ ...input, quality: 'accurate' }, config);
  assert.deepEqual(fast, accurate);
  assert.ok(fast.messages[0].content.startsWith(`背景信息：${page.title}\n${page.summary}\n`));
  assert.ok(fast.messages[0].content.includes(`context=${JSON.stringify(page)}`));
  assert.ok(fast.messages[0].content.endsWith(oldPrompt(text)));
  assert.equal(fast.temperature, 0.4);
});

test('fast短模板保留背景预算与完整正文，不截断Unicode、数字或条件', async () => {
  const title = 'a'.repeat(255) + '😀tail', summary = 'S'.repeat(400);
  const text = 'If the temperature is below -3°C, keep the valve closed for 15 minutes. '.repeat(12) + 'End 😀.';
  const [body] = await capture({ ...request([text]), quality: 'fast', context: { url: 'https://example.test', title, summary } });
  assert.equal(body.messages[0].content, `背景信息：${'a'.repeat(255)}\n${summary.slice(0, 300)}\n${fastPrompt(text)}`);
  assert.equal(body.messages[0].content.split('：\n').at(-1), text);
  assert.equal(body.max_tokens, 1024);
});

test('同一fast调用逐段决定快捷资格，不能把标签段跟随纯文本改用P2', async () => {
  const [plain, tagged] = await capture({ ...request(['A complete plain sentence.', 'Read <g4>the guide</g4>.']), quality: 'fast' });
  assert.equal(plain.messages[0].content, fastPrompt('A complete plain sentence.'));
  assert.ok(tagged.messages[0].content.endsWith(oldPrompt('Read <g4>the guide</g4>.')));
  assert.match(tagged.messages[0].content, /XML/);
});

test('fast/P2支持真实SSE累计回调，传输、完整结束和结果不改变', async () => {
  const encoder = new TextEncoder(), partials = [];
  const event = (content, finish_reason = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] }) + '\n\n';
  const text = 'Hello.', ctx = context((_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.messages[0].content, fastPrompt(text)); assert.equal(body.stream, true);
    assert.equal(init.streamResponse, true); assert.equal(init.headers.Accept, 'text/event-stream');
    assert.equal(body.temperature, 0.7); assert.equal(body.max_tokens, 1024);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(event('你')));
      controller.enqueue(encoder.encode(event('好。') + event('', 'stop') + 'data: [DONE]\n\n'));
      controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  ctx.onPartial = (value, index) => partials.push({ value, index });
  assert.deepEqual(await llama.translate({ ...request([text]), quality: 'fast', stream: true }, ctx), ['你好。']);
  assert.deepEqual(partials, [{ value: '你', index: 0 }, { value: '你好。', index: 0 }]);
});
