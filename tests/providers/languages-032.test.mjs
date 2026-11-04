import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), build = process.env.BACKEND_BUILD_DIR || fileURLToPath(new URL('../.compiled/', import.meta.url));
const provider = name => require(path.join(build, `backend/providers/${name}.js`)).default;
const languages = ['sv', 'nl', 'pl', 'tr', 'uk', 'vi', 'th', 'id', 'ar', 'pt', 'it'];
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const translated = { translations: [{ id: 's0', text: 'Translated text.' }] };

function mock(name, sourceLang, targetLang) {
  let calls = 0;
  const ctx = { signal: new AbortController().signal, log() {}, config: { key: 'fixture', secretId: 'fixture', secretKey: 'fixture', token: 'fixture', model: 'fixture', url: 'http://127.0.0.1:8081' },
    builtin: { async translate(req) { calls++; assert.equal(req.sourceLang, sourceLang); assert.equal(req.targetLang, targetLang); return ['Translated text.']; } },
    async fetch(address, init = {}) {
      calls++; const url = new URL(address), body = init.body ? JSON.parse(init.body) : undefined;
      if (name === 'microsoft') {
        assert.equal(url.searchParams.get('from'), sourceLang); assert.equal(url.searchParams.get('to'), targetLang);
        return json([{ translations: [{ text: '<div data-tx-root="1">Translated text.</div>' }] }]);
      }
      if (name === 'deepl') {
        assert.equal(body.source_lang, sourceLang.toUpperCase()); assert.equal(body.target_lang, targetLang.toUpperCase());
        return json({ translations: [{ text: '<txroot>Translated text.</txroot>' }] });
      }
      if (name === 'niutrans') {
        assert.equal(body.from, sourceLang); assert.equal(body.to, targetLang); return json({ tgt_text: { s0: 'Translated text.' } });
      }
      if (name === 'tencent') {
        assert.equal(body.Source, sourceLang); assert.equal(body.Target, targetLang); return json({ Response: { TargetTextList: ['Translated text.'] } });
      }
      if (name === 'llamacpp') {
        const label = code => new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(code);
        assert.match(body.messages[0].content, new RegExp(`原文语言：${label(sourceLang)}。\\n`));
        assert.ok(body.messages[0].content.includes(`翻译为${label(targetLang)}`));
        return json({ choices: [{ message: { content: 'Translated text.' }, finish_reason: 'stop' }] });
      }
      if (name === 'gemini' || name === 'openai-compatible') {
        const data = JSON.parse(name === 'gemini' ? body.contents[0].parts[0].text : body.messages[1].content);
        assert.equal(data.sourceLang, sourceLang); assert.equal(data.targetLang, targetLang);
        return name === 'gemini' ? json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(translated) }] } }] })
          : json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(translated) } }] });
      }
      if (name === 'remote-node') {
        assert.equal(body.sourceLang, sourceLang); assert.equal(body.targetLang, targetLang);
        return new Response(JSON.stringify({ id: 's0', text: 'Translated text.' }) + '\n' + JSON.stringify({ done: true }) + '\n');
      }
      if (name === 'unofficial/google-web') {
        assert.equal(url.searchParams.get('sl'), sourceLang); assert.equal(url.searchParams.get('tl'), targetLang); return json([[['Translated text.']]]);
      }
      assert.fail(`未知适配器 ${name}`);
    } };
  return { ctx, calls: () => calls };
}

for (const name of ['microsoft', 'deepl', 'niutrans', 'tencent', 'llamacpp', 'gemini', 'openai-compatible', 'remote-node', 'browser-translator', 'unofficial/google-web']) {
  test(`${name}: 第32节新增语言显式传递源与目标，不暗改为auto`, async () => {
    const adapter = provider(name);
    for (const language of languages) for (const [from, to] of [[language, 'en'], ['en', language]]) {
      const { ctx, calls } = mock(name, from, to);
      if (name === 'tencent' && ['sv', 'nl', 'pl', 'uk'].includes(language)) {
        assert.equal(adapter.supports(from, to), false);
        await assert.rejects(adapter.translate({ texts: ['Public example.'], sourceLang: from, targetLang: to }, ctx), error => error.info?.code === 'bad_input' && error.message.includes('不支持'));
        assert.equal(calls(), 0);
      } else {
        assert.notEqual(adapter.supports?.(from, to), false);
        assert.deepEqual(await adapter.translate({ texts: ['Public example.'], sourceLang: from, targetLang: to }, ctx), ['Translated text.']);
        assert.equal(calls(), 1);
      }
    }
  });
}

test('腾讯方向矩阵与中文映射：不能把支持一端语言误当成任意语言对可用', () => {
  const tencent = provider('tencent');
  for (const [from, to, expected] of [['ja', 'ko', true], ['ja', 'fr', false], ['hi', 'en', true], ['zh-CN', 'hi', false], ['en', 'hi', true], ['fr', 'de', true], ['vi', 'th', false], ['auto', 'uk', false], ['auto', 'zh-Hant', true], ['zh-Hant', 'en', true], ['auto', 'auto', false]]) {
    assert.equal(tencent.supports(from, to), expected, `${from} → ${to}`);
  }
});

test('本地auto继续使用原模板，显式语言与stream:false不会启用SSE', async () => {
  const llama = provider('llamacpp'); let prompt;
  await llama.translate({ texts: ['Hej!'], sourceLang: 'auto', targetLang: 'en', quality: 'fast', stream: false }, {
    signal: new AbortController().signal, config: {}, log() {}, onPartial() { assert.fail('stream:false不得产生partial'); },
    async fetch(_url, init) { const body = JSON.parse(init.body); prompt = body.messages[0].content; assert.equal(body.stream, false); return json({ choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }] }); },
  });
  assert.equal(prompt, '译成英语，只输出译文：\nHej!');
});
