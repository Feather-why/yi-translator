import test from 'node:test';
import assert from 'node:assert/strict';
import { provider, request, context, json, requireCompiled } from './helpers.mjs';
const niutrans = provider('niutrans');
const { checkPlaceholders } = requireCompiled('../.compiled/shared/placeholders.js');

test('小牛 JSON 接口一次批量翻译叶子，标签保存在本地', async () => {
  const req = request();
  const ctx = context((url, init) => {
    assert.equal(url, 'https://api.niutrans.com/NiuTransServer/translationJson');
    const body = JSON.parse(init.body);
    assert.equal(body.from, 'auto'); assert.equal(body.to, 'zh');
    assert.ok(Object.values(body.src_text).every((text) => !/<[gx]\d/.test(text)));
    return json({ tgt_text: Object.fromEntries(Object.entries(body.src_text).map(([key, value]) => [key, value.replace('Hello', '你好').replace('world', '世界')])) });
  }, { key: 'fixture-key' });
  const [text] = await niutrans.translate(req, ctx);
  assert.equal(checkPlaceholders(req.texts[0], text).ok, true);
  assert.equal(ctx.calls.length, 1);
  assert.equal(niutrans.cost(request(['A😀<g0>B</g0><x0/>'])), 3);
  assert.equal(niutrans.freeQuota.amount, 200000);
});

for (const [upstream, expected] of [['10001', 'rate_limit'], ['13001', 'quota'], ['13002', 'auth'], ['13008', 'network'], ['13007', 'bad_input']]) {
  test(`小牛错误 ${upstream} 分类为 ${expected}`, async () => {
    await assert.rejects(niutrans.translate(request(['Hello']), context(() => json({ error_code: upstream }), { key: 'fixture-key' })), (error) => niutrans.classifyError(error).code === expected);
  });
}

test('小牛拒绝丢失的 JSON 项', async () => {
  await assert.rejects(niutrans.translate(request(['Hello']), context(() => json({ tgt_text: {} }), { key: 'fixture-key' })), (error) => error.info.code === 'server');
});
