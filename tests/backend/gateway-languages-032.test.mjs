import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayReplay, jsonResponse } from './gateway-replay.mjs';

test('远程网关把显式源语言写进模型提示，auto保持旧模板并保留标签约束', async () => {
  const prompts = [];
  const replay = gatewayReplay(async (_url, init) => {
    prompts.push(JSON.parse(init.body).messages[0].content);
    return jsonResponse({ choices: [{ message: { content: '<g0>Hello</g0>' }, finish_reason: 'stop' }] });
  });
  for (const sourceLang of ['sv', 'nl', 'pl', 'tr', 'uk', 'vi', 'th', 'id', 'ar', 'pt', 'it', 'auto']) {
    const response = await replay.request('/v1/translate', { sourceLang, targetLang: 'en', strictPlaceholders: true, placeholderRetry: 'caller', segments: [{ id: 's0', text: '<g0>Hej</g0>' }] });
    const rows = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].text, '<g0>Hello</g0>');
    const prompt = prompts.at(-1);
    assert.match(prompt, /^严格保留/); assert.ok(prompt.endsWith('<g0>Hej</g0>'));
    if (sourceLang === 'auto') assert.equal(prompt.includes('原文语言：'), false);
    else assert.ok(prompt.includes(`原文语言：${new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(sourceLang)}。`));
  }
  assert.equal(prompts.length, 12);
});
