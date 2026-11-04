import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { provider, request, context, json, requireCompiled } from './helpers.mjs';
const tencent = provider('tencent');
const { checkPlaceholders } = requireCompiled('../.compiled/shared/placeholders.js');

test('腾讯仅发送文本叶子，嵌套标签及代码占位符留在本地', async () => {
  const req = request();
  const ctx = context((url, init) => {
    assert.equal(url, 'https://tmt.tencentcloudapi.com/');
    const body = JSON.parse(init.body);
    assert.equal(body.Source, 'auto'); assert.equal(body.Target, 'zh');
    assert.ok(body.SourceTextList.every((text) => !/<[gx]\d/.test(text)));
    assert.match(init.headers.Authorization, /^TC3-HMAC-SHA256 /);
    assert.equal(init.headers['X-TC-Action'], 'TextTranslateBatch');
    return json({ Response: { TargetTextList: body.SourceTextList.map((text) => text.replace('Hello', '你好').replace('world', '世界')) } });
  }, { secretId: 'fixture-id', secretKey: 'fixture-secret', monthlyQuota: '100' });
  const [text] = await tencent.translate(req, ctx);
  assert.equal(checkPlaceholders(req.texts[0], text).ok, true);
  assert.match(text, /你好 <g0>世界 <g1>模型<\/g1><\/g0> <x0\/>/);
  assert.equal(tencent.freeQuota, undefined);
  assert.equal(tencent.cost(request(['A😀<g0>B</g0><x0/>'])), 3);
});

test('腾讯 TC3 签名与独立 Node HMAC 实现一致', async () => {
  const { signTc3 } = requireCompiled('../.compiled/backend/providers/signers/tc3.js');
  const data = { secretId: 'fixture-id', secretKey: 'fixture-secret', host: 'tmt.tencentcloudapi.com', service: 'tmt', action: 'TextTranslateBatch', body: '{"SourceTextList":["你好"]}', timestamp: 1700000000 };
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
  const date = new Date(data.timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/tmt/tc3_request`;
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:tmt.tencentcloudapi.com\nx-tc-action:texttranslatebatch\n\ncontent-type;host;x-tc-action\n${hash(data.body)}`;
  const signature = hmac(hmac(hmac(hmac('TC3' + data.secretKey, date), 'tmt'), 'tc3_request'), `TC3-HMAC-SHA256\n${data.timestamp}\n${scope}\n${hash(canonical)}`).toString('hex');
  assert.equal(await signTc3(data), `TC3-HMAC-SHA256 Credential=fixture-id/${scope}, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`);
});

for (const [upstream, expected] of [['RequestLimitExceeded', 'rate_limit'], ['LimitExceeded.NoFreeAmount', 'quota'], ['AuthFailure.SignatureFailure', 'auth']]) {
  test(`腾讯将 ${upstream} 归类为 ${expected}`, async () => {
    const ctx = context(() => json({ Response: { Error: { Code: upstream, Message: 'sensitive upstream text' } } }), { secretId: 'fixture-id', secretKey: 'fixture-secret' });
    await assert.rejects(tencent.translate(request(['Hello']), ctx), (error) => tencent.classifyError(error).code === expected && !error.message.includes('sensitive'));
  });
}

test('腾讯拒绝不完整响应', async () => {
  await assert.rejects(tencent.translate(request(['Hello']), context(() => json({ Response: { TargetTextList: [] } }), { secretId: 'fixture-id', secretKey: 'fixture-secret' })), (error) => error.info.code === 'server');
});
