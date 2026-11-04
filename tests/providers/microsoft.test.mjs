import test from 'node:test';
import assert from 'node:assert/strict';
import { provider, request, context, json, requireCompiled } from './helpers.mjs';
const microsoft = provider('microsoft');
const { checkPlaceholders } = requireCompiled('../.compiled/shared/placeholders.js');
const { encodeHtml, decodeHtml } = requireCompiled('../.compiled/backend/providers/microsoft.js');

test('微软 HTML 还原嵌套标签、原子占位符和特殊字符', async () => {
  const req = request(['Hello <g0>world <g1>模型</g1></g0> <x0/> & 1 < 2']);
  const ctx = context((url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('to'), 'zh-Hans');
    assert.equal(parsed.searchParams.has('from'), false);
    assert.equal(parsed.searchParams.get('textType'), 'html');
    assert.equal(init.headers['Ocp-Apim-Subscription-Region'], 'eastasia');
    const texts = JSON.parse(init.body);
    assert.match(texts[0].Text, /^<div data-tx-root="1">[\s\S]*<\/div>$/);
    assert.ok(texts[0].Text.includes('class="notranslate"'));
    return json(texts.map(({ Text }) => ({ translations: [{ text: Text.replace('Hello', '你好').replace('world', '世界') }] })));
  }, { key: 'fixture-key', region: 'eastasia' });
  const [text] = await microsoft.translate(req, ctx);
  assert.equal(checkPlaceholders(req.texts[0], text).ok, true);
  assert.ok(text.endsWith('& 1 < 2'));
  assert.equal(decodeHtml(encodeHtml(req.texts[0])), req.texts[0]);
  assert.equal(microsoft.cost(request(['A😀<g0>B</g0><x0/>'])), 3);
});

test('微软 403001 识别为额度耗尽，普通 403 为鉴权失败', async () => {
  for (const [data, code] of [[{ error: { code: 403001 } }, 'quota'], [{ error: { code: 403000 } }, 'auth']]) {
    await assert.rejects(microsoft.translate(request(['Hello']), context(() => json(data, 403), { key: 'fixture-key' })), (error) => microsoft.classifyError(error).code === code);
  }
});

test('微软拒绝标签丢失、嵌套错误和非预期 HTML', () => {
  assert.throws(() => decodeHtml('<span data-tx-g="0">Hello'));
  assert.throws(() => decodeHtml('<a href="https://wrong.invalid">Hello</a>'));
});

test('微软拒绝返回片段缺失', async () => {
  await assert.rejects(microsoft.translate(request(['Hello']), context(() => json([]), { key: 'fixture-key' })), (error) => error.info.code === 'server');
});
