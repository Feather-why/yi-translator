import test from 'node:test';
import assert from 'node:assert/strict';
import { provider, request, context, json, requireCompiled } from './helpers.mjs';
const deepl = provider('deepl');
const { checkPlaceholders } = requireCompiled('../.compiled/shared/placeholders.js');

test('DeepL XML 模式保留嵌套、转义普通文本且使用 Free 域名', async () => {
  const req = request(['Hello <g0>世界 <g1>日本語</g1></g0> <x0/> & 1 < 2']);
  const ctx = context((url, init) => {
    assert.equal(url, 'https://api-free.deepl.com/v2/translate');
    const body = JSON.parse(init.body);
    assert.equal(body.tag_handling, 'xml'); assert.equal(body.tag_handling_version, 'v2');
    assert.equal(body.source_lang, undefined);
    assert.equal(body.target_lang, 'ZH');
    return json({ translations: body.text.map((text) => ({ text: text.replace('Hello', '你好').replace('<x0/>', '<x0 />') })) });
  }, { key: 'fixture-key:fx' });
  const [text] = await deepl.translate(req, ctx);
  assert.equal(text, req.texts[0].replace('Hello', '你好'));
  assert.equal(checkPlaceholders(req.texts[0], text).ok, true);
  assert.equal(deepl.cost(request(['A😀<g0>B</g0><x0/>'])), 3);
});

test('DeepL /usage 返回真实字符用量', async () => {
  const ctx = context((url) => {
    assert.equal(url, 'https://api-free.deepl.com/v2/usage');
    return json({ character_count: 1234, character_limit: 500000 });
  }, { key: 'fixture-key:fx' });
  const result = await deepl.health(ctx);
  assert.equal(result.used, 1234); assert.equal(result.amount, 500000); assert.equal(result.ok, true);
});

for (const [status, expected] of [[456, 'quota'], [429, 'rate_limit'], [403, 'auth'], [503, 'server']]) {
  test(`DeepL HTTP ${status} 分类为 ${expected}`, async () => {
    await assert.rejects(deepl.translate(request(['Hello']), context(() => json({}, status), { key: 'fixture-key' })), (error) => deepl.classifyError(error).code === expected);
  });
}

test('DeepL 拒绝缺失片段和非法 usage', async () => {
  await assert.rejects(deepl.translate(request(['Hello']), context(() => json({ translations: [] }), { key: 'fixture-key' })), (error) => error.info.code === 'server');
  await assert.rejects(deepl.health(context(() => json({}), { key: 'fixture-key' })), (error) => error.info.code === 'server');
});
