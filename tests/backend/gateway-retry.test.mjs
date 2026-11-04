import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fixtureToken, gatewayReplay, jsonResponse } from './gateway-replay.mjs';

const require = createRequire(import.meta.url), build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const compiled = (name) => require(path.join(build, 'backend', name + '.js'));
const remote = compiled('providers/remote-node').default;
const choice = (text) => jsonResponse({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const payload = (extra = {}) => ({ sourceLang: 'en', targetLang: 'zh-CN', segments: [{ id: 's0', text: 'Read <g0>the guide</g0>.' }], ...extra });
const lines = async (response) => (await response.text()).trim().split('\n').map(JSON.parse);

test('旧直接客户端缺省或显式gateway时仍保留一次网关失标重试', async () => {
  for (const placeholderRetry of [undefined, 'gateway']) {
    let calls = 0; const replay = gatewayReplay(async () => { calls++; return choice('丢失标签'); });
    const result = await lines(await replay.request('/v1/translate', payload({ placeholderRetry })));
    assert.equal(calls, 2); assert.equal(result[0].error.code, 'placeholder'); assert.equal(result.at(-1).done, true);
  }
});

test('caller责任每次只生成一次，仍拒绝失标并保留Core传来的strict要求', async () => {
  for (const strictPlaceholders of [false, true]) {
    const prompts = [], replay = gatewayReplay(async (_url, init) => { prompts.push(JSON.parse(init.body).messages[0].content); return choice('丢失标签'); });
    const result = await lines(await replay.request('/v1/translate', payload({ placeholderRetry: 'caller', strictPlaceholders })));
    assert.equal(prompts.length, 1); assert.equal(result[0].error.code, 'placeholder');
    assert.equal(prompts[0].startsWith('严格保留'), strictPlaceholders);
  }
});

test('caller成功结果照常交付，未知重试责任在推理前拒绝', async () => {
  let calls = 0; const replay = gatewayReplay(async () => { calls++; return choice('阅读<g0>指南</g0>。'); });
  const result = await lines(await replay.request('/v1/translate', payload({ placeholderRetry: 'caller' })));
  assert.equal(result[0].text, '阅读<g0>指南</g0>。'); assert.equal(calls, 1);
  for (const placeholderRetry of ['none', true, 0, null, {}]) {
    assert.equal((await replay.request('/v1/translate', payload({ placeholderRetry }))).status, 400);
  }
  assert.equal(calls, 1);
});

test('remote适配器明确传caller但不改strict、原文、语言及节点模型', async () => {
  assert.equal(remote.version, '1.0.2');
  for (const strictPlaceholders of [false, true]) {
    const calls = [], ctx = { signal: new AbortController().signal, config: { url: 'http://fixture.invalid', token: 'fixture-token', model: 'fixture-model' }, log() {},
      fetch: async (_url, init) => { calls.push(JSON.parse(init.body)); return new Response('{"id":"s0","text":"阅读<g0>指南</g0>。"}\n{"done":true}\n'); } };
    const input = { texts: [payload().segments[0].text], sourceLang: 'en', targetLang: 'zh-CN', strictPlaceholders };
    assert.deepEqual(await remote.translate(input, ctx), ['阅读<g0>指南</g0>。']);
    assert.deepEqual(calls[0], { sourceLang: 'en', targetLang: 'zh-CN', model: 'fixture-model', strictPlaceholders,
      placeholderRetry: 'caller', segments: [{ id: 's0', text: input.texts[0] }] });
  }
});

test('真实Core+remote+gateway失标整段由四次减为两次，最终安全恢复仍合法', async () => {
  const inputs = [], replay = gatewayReplay(async (_url, init) => {
    const text = JSON.parse(init.body).messages[0].content.split('：\n').at(-1); inputs.push(text);
    return choice(/<g\d+>/.test(text) ? '丢失标签' : text.trim() === 'Read' ? '阅读' : '指南');
  });
  const data = {}, area = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); }, async set(value) { Object.assign(data, structuredClone(value)); } };
  globalThis.chrome = { storage: { local: area } };
  const { BackendCore } = compiled('core'), { BackendStorage } = compiled('storage'), { SecretVault } = compiled('secrets'), { validTranslation } = compiled('validation');
  const core = new BackendCore({ providers: [remote], storage: new BackendStorage({ memory: true }), vault: new SecretVault({ memory: true, storage: area }), fetch: replay.fetch });
  await core.ready(); await core.save(remote.id, true, { url: 'http://fixture.invalid', token: fixtureToken });
  const segment = { id: 's0', text: payload().segments[0].text, kind: 'paragraph' }, job = { jobId: 'gateway-retry-fixture', sourceLang: 'en', targetLang: 'zh-CN', mode: 'accurate', priority: 1, noCache: true, context: { url: 'https://example.test' }, segments: [segment] };
  const result = await core.translate(job, segment, 'accurate', new AbortController().signal);
  assert.equal(inputs.length, 4); assert.deepEqual(inputs.slice(0, 2), [segment.text, segment.text]);
  assert.deepEqual(inputs.slice(2), ['Read', 'the guide']); assert.ok(validTranslation(segment.text, result.text));
});

test('caller在途取消传播到上游且不会补一次隐藏网关重试', async () => {
  let begun, calls = 0; const entered = new Promise((resolve) => { begun = resolve; });
  const replay = gatewayReplay(async (_url, init) => { calls++; begun(); return new Promise((_, reject) => {
    const abort = () => reject(init.signal.reason); init.signal.addEventListener('abort', abort, { once: true }); if (init.signal.aborted) abort();
  }); });
  const controller = new AbortController(), pending = replay.request('/v1/translate', payload({ placeholderRetry: 'caller' }), { signal: controller.signal });
  await entered; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls, 1);
});
