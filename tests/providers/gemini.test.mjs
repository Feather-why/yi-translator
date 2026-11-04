import test from 'node:test';
import assert from 'node:assert/strict';
import { provider, request, context, json } from './helpers.mjs';
const adapter = provider('gemini');
const config = { key: 'fixture-google-key', model: 'fixture-gemini' };
const answer = (translations, finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify({ translations }) }] } }] });

test('Gemini 使用官方 generateContent、header key 与 JSON MIME', async () => {
  const ctx = context((url, init) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/fixture-gemini:generateContent');
    assert.ok(!url.includes('fixture-google-key'));
    assert.equal(init.headers['x-goog-api-key'], 'fixture-google-key');
    const value = JSON.parse(init.body);
    assert.equal(value.generationConfig.responseMimeType, 'application/json');
    assert.ok(value.systemInstruction.parts[0].text.includes('XML'));
    return json(answer([{ id: 's1', text: '二' }, { id: 's0', text: '一' }]));
  }, config);
  assert.deepEqual(await adapter.translate(request(['one', 'two']), ctx), ['一', '二']);
});

test('Gemini 不接受安全拦截、截断、缺号、重号或坏 JSON', async () => {
  for (const reply of [answer([], 'MAX_TOKENS'), answer([], 'SAFETY'), {}, answer([{ id: 's1', text: '错号' }]), answer([{ id: 's0', text: '' }])]) {
    await assert.rejects(adapter.translate(request(['one']), context(() => json(reply), config)));
  }
  await assert.rejects(adapter.translate(request(['one', 'two']), context(() => json(answer([{ id: 's0', text: '一' }, { id: 's0', text: '二' }])), config)));
});

test('Gemini 每日额度与短期限流分别分类，不回传包含凭据的错误消息', async () => {
  for (const [body, expected] of [[{ error: { details: [{ quotaId: 'RequestsPerDayPerProject' }] } }, 'quota'], [{ error: { details: [{ quotaId: 'RequestsPerMinute' }] } }, 'rate_limit']]) {
    await assert.rejects(adapter.translate(request(), context(() => json(body, 429), config)), (error) => error.info.code === expected && !error.info.message.includes(config.key));
  }
  await assert.rejects(adapter.translate(request(), context(() => json({ error: { status: 'INVALID_ARGUMENT' } }, 400), config)), (error) => error.info.code === 'bad_input');
});

test('Gemini 模型名不能注入路径或查询，health 核实生成能力', async () => {
  const ctx = context(() => { throw new Error('不应请求'); }, { ...config, model: 'bad?key=secret' });
  await assert.rejects(adapter.translate(request(), ctx), (error) => error.info.code === 'bad_input');
  const healthy = await adapter.health(context((url) => { assert.ok(url.endsWith('/fixture-gemini')); return json({ supportedGenerationMethods: ['generateContent'] }); }, config));
  assert.equal(healthy.ok, true);
});
