import test from 'node:test';
import assert from 'node:assert/strict';
import { provider, request, context, json } from './helpers.mjs';
const deepl = provider('deepl');

for (const [key, host] of [['fixture-free:fx', 'api-free.deepl.com'], ['fixture-paid', 'api.deepl.com'], [' \tfixture-free:fx\r\n', 'api-free.deepl.com'], [' \tfixture-paid\r\n', 'api.deepl.com'], ['fixture:fx-extra', 'api.deepl.com']]) {
  test(`DeepL: ${JSON.stringify(key)} 的翻译和usage使用同一套餐主机`, async () => {
    const ctx = context((address, init) => {
      const url = new URL(address);
      assert.equal(url.hostname, host); assert.equal(url.search, ''); assert.equal(url.username, ''); assert.equal(url.password, '');
      assert.equal(init.headers.Authorization, 'DeepL-Auth-Key ' + key.trim());
      if (url.pathname === '/v2/usage') return json({ character_count: 321, character_limit: 1_000_000 });
      assert.equal(url.pathname, '/v2/translate'); assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body); assert.equal(body.source_lang, 'SV'); assert.equal(body.target_lang, 'EN');
      return json({ translations: [{ text: '<txroot>The library opens.</txroot>' }] });
    }, { key });
    assert.deepEqual(await deepl.translate({ texts: ['Biblioteket öppnar.'], sourceLang: 'sv', targetLang: 'en' }, ctx), ['The library opens.']);
    const usage = await deepl.health(ctx); assert.equal(usage.used, 321); assert.equal(usage.amount, 1_000_000);
    assert.equal(ctx.calls.length, 2);
  });
}

test('DeepL: 未配置或全空白密钥不发送HTTP，标签不限定API Free', async () => {
  for (const key of [undefined, '', ' \r\n\t']) {
    const ctx = context(() => assert.fail('不应调用网络'), key === undefined ? {} : { key });
    for (const invoke of [() => deepl.translate(request(['Hello']), ctx), () => deepl.health(ctx)]) await assert.rejects(invoke, error => error.info?.code === 'auth' && /API 密钥/.test(error.info.message));
    assert.equal(ctx.calls.length, 0);
  }
  assert.equal(deepl.name, 'DeepL API'); assert.equal(deepl.auth[0].label, 'API 密钥');
  assert.match(deepl.quotaText, /Developer.*100万.*不按月重置/); assert.match(deepl.quotaText, /Free.*每月50万/);
});

test('DeepL: XML请求与响应不归一化Unicode数学字母，按码点计费', async () => {
  const text = '𝑁 ℎ 𝐱 𝛼 𝟘 <g0>𝑁</g0><x0/> & A';
  const ctx = context((_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.text[0], '<txroot>𝑁 ℎ 𝐱 𝛼 𝟘 <g0>𝑁</g0><x0/> &amp; A</txroot>');
    return json({ translations: [{ text: body.text[0].replace('𝑁', '&#x1D441;') }] });
  }, { key: 'fixture-paid' });
  assert.deepEqual(await deepl.translate(request([text]), ctx), [text]);
  assert.equal(deepl.cost(request(['𝑁ℎ𝐱𝛼𝟘<g0>𝑁</g0><x0/>'])), 6);
});

test('DeepL: usage原样接受账户实际上限，包括零额度和无上限哨兵', async () => {
  for (const [used, amount] of [[0, 0], [499_999, 500_000], [1_000_000, 1_000_000], [10, 1_000_000_000_000]]) {
    const result = await deepl.health(context(() => json({ character_count: used, character_limit: amount }), { key: 'fixture-paid' }));
    assert.equal(result.used, used); assert.equal(result.amount, amount); assert.equal(result.ok, true);
  }
});

test('DeepL: 无效usage数值不能变成错误额度', async () => {
  for (const value of [-1, 0.5, '1000000', null, Number.MAX_SAFE_INTEGER + 1]) for (const field of ['character_count', 'character_limit']) {
    const data = { character_count: 0, character_limit: 1_000_000, [field]: value };
    await assert.rejects(deepl.health(context(() => json(data), { key: 'fixture-paid' })), error => error.info?.code === 'server');
  }
});

test('DeepL: 仅从实际有效未来end_time返回账户周期，不从套餐额度推断', async () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  for (const endTime of [future, future.replace('Z', '+00:00')]) {
    const result = await deepl.health(context(() => json({ character_count: 0, character_limit: 1_000_000, end_time: endTime }), { key: 'fixture-paid' }));
    assert.equal(result.quotaResetAt, Date.parse(endTime));
  }
  for (const key of ['fixture-paid', 'fixture-free:fx']) {
    const result = await deepl.health(context(() => json({ character_count: 0, character_limit: 1_000_000 }), { key }));
    assert.equal(Object.hasOwn(result, 'quotaResetAt'), false);
  }
});

test('DeepL: 非ISO、越界日历日期和已过期账期不虚构重置时间', async () => {
  const year = new Date().getUTCFullYear() + 2;
  for (const endTime of [undefined, null, 0, new Date(Date.now() - 1000).toISOString(), `${year}-02-30T00:00:00Z`, `${year}-01-01T24:00:00Z`, `${year}-01-01T00:60:00Z`, `${year}-01-01T00:00:60Z`, `${year}-01-01`, `${year}-01-01T00:00:00+99:99`]) {
    const result = await deepl.health(context(() => json({ character_count: 0, character_limit: 1_000_000, end_time: endTime }), { key: 'fixture-paid' }));
    assert.equal(Object.hasOwn(result, 'quotaResetAt'), false, String(endTime)); assert.equal(result.amount, 1_000_000);
  }
});
