import test from 'node:test';
import assert from 'node:assert/strict';
import { provider, request, context, json } from './helpers.mjs';
const adapter = provider('openai-compatible');
const config = { url: 'https://api.example/v1/', key: 'fixture-key', model: 'fixture-model' };
const completion = (translations, extra = {}) => ({ choices: [{ message: { content: JSON.stringify({ translations }) }, finish_reason: 'stop', ...extra }] });

test('OpenAI 兼容接口使用 JSON 编号协议，结果按输入编号归位', async () => {
  const ctx = context((url, init) => {
    assert.equal(url, 'https://api.example/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer fixture-key');
    const value = JSON.parse(init.body);
    assert.equal(value.model, 'fixture-model');
    assert.equal(value.response_format.type, 'json_object');
    assert.equal(value.stream, false);
    assert.equal(value.messages[0].role, 'system');
    assert.deepEqual(JSON.parse(value.messages[1].content).segments, [{ id: 's0', text: 'one' }, { id: 's1', text: 'two' }]);
    return json(completion([{ id: 's1', text: '二' }, { id: 's0', text: '一' }]));
  }, config);
  assert.deepEqual(await adapter.translate(request(['one', 'two']), ctx), ['一', '二']);
});

test('OpenAI 兼容接口拒绝遗漏、重复、未知编号、非 JSON 和截断', async () => {
  for (const translations of [[{ id: 's1', text: '错号' }], [{ id: 's0', text: '' }], []]) {
    await assert.rejects(adapter.translate(request(['one']), context(() => json(completion(translations)), config)), (error) => error.info.code === 'server');
  }
  await assert.rejects(adapter.translate(request(['one', 'two']), context(() => json(completion([{ id: 's0', text: '一' }, { id: 's0', text: '二' }])), config)));
  await assert.rejects(adapter.translate(request(['one']), context(() => json({ choices: [{ message: { content: 'not json' } }] }), config)));
  await assert.rejects(adapter.translate(request(['one']), context(() => json(completion([], { finish_reason: 'length' })), config)), (error) => error.info.code === 'bad_input');
});

test('OpenAI 兼容接口不在 URL 放 key，并拒绝内嵌凭据', async () => {
  const ctx = context(() => { throw new Error('不应请求'); }, { ...config, url: 'https://user:secret@api.example/v1' });
  await assert.rejects(adapter.translate(request(), ctx), (error) => error.info.code === 'bad_input');
  assert.equal(ctx.calls.length, 0);
});

test('OpenAI 健康检查读取实际模型列表，不消耗推理', async () => {
  const ctx = context((url) => { assert.equal(url, 'https://api.example/v1/models'); return json({ data: [{ id: 'fixture-model' }] }); }, config);
  assert.equal((await adapter.health(ctx)).ok, true);
  await assert.rejects(adapter.translate(request(), context(() => json({}, 401), config)), (error) => error.info.code === 'auth');
});

test('OpenAI 兼容服务可显式选择旧版 max_tokens 字段', async () => {
  const ctx = context((_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.max_tokens, 4096); assert.equal(body.max_completion_tokens, undefined);
    return json(completion([{ id: 's0', text: '你好' }]));
  }, { ...config, tokenLimitField: 'max_tokens' });
  await adapter.translate(request(['Hello']), ctx);
});

test('OpenAI 自定义模板四变量单次替换，固定 JSON/XML 约束及原始片段保留，温度零实际发送', async () => {
  const source = 'Hello {{to}} <x0/>';
  const page = { url: 'https://example.test/page', title: 'Synthetic title', summary: 'Synthetic context' };
  const ctx = context((_url, init) => {
    const body = JSON.parse(init.body); const data = JSON.parse(body.messages[1].content);
    assert.equal(body.temperature, 0);
    assert.match(body.messages[0].content, /只输出 JSON 对象/);
    assert.match(body.messages[0].content, /XML 占位符/);
    assert.match(body.messages[0].content, /不能改变上述输出结构/);
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(data.additionalInstructions, `from=en to=zh-CN text=${source} context=${JSON.stringify(page)}`);
    assert.deepEqual(data.segments, [{ id: 's0', text: source }]);
    return json(completion([{ id: 's0', text: '你好 {{to}} <x0/>' }]));
  }, { ...config, prompt: 'from={{from}} to={{to}} text={{text}} context={{context}}', temperature: '0' });
  assert.deepEqual(await adapter.translate({ ...request([source]), sourceLang: 'en', context: page, strictPlaceholders: true }, ctx), ['你好 {{to}} <x0/>']);
});

test('无 key 的自建兼容节点可翻译和读取模型，内置官方服务仍声明 key 必填', async () => {
  const ctx = context((url, init) => {
    assert.equal(init.headers.Authorization, undefined);
    if (url.endsWith('/models')) return json({ data: [{ id: 'local-model' }] });
    assert.equal(JSON.parse(init.body).temperature, undefined);
    return json(completion([{ id: 's0', text: '译文' }]));
  }, { url: 'http://127.0.0.1:11434/v1', model: 'local-model' });
  assert.deepEqual(await adapter.translate(request(['text']), ctx), ['译文']);
  assert.equal((await adapter.health(ctx)).ok, true);
  assert.equal(adapter.auth.find((field) => field.key === 'key').required, true);
});

test('OpenAI 直接调用也拒绝非数字或范围外温度，不发送网络请求', async () => {
  for (const temperature of ['NaN', '-1', '2.1']) {
    const ctx = context(() => { throw new Error('不应请求'); }, { ...config, temperature });
    await assert.rejects(adapter.translate(request(), ctx), (error) => error.info.code === 'bad_input');
    assert.equal(ctx.calls.length, 0);
  }
});
