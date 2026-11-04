import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreMissingAtoms } from '../../gateway/placeholder-atoms.mjs';
import { fixtureToken, gatewayReplay, jsonResponse } from './gateway-replay.mjs';

const require = createRequire(import.meta.url), ts = require('typescript');
const choice = text => jsonResponse({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const input = (source, extra = {}) => ({ sourceLang: 'en', targetLang: 'zh-CN', segments: [{ id: 's0', text: source }], ...extra });
const rows = async response => (await response.text()).trim().split('\n').map(JSON.parse);

test('gateway恢复算法主体与当前TypeScript转译一致，双端不能静默漂移', async () => {
  const source = await readFile(new URL('../../src/backend/placeholder-atoms.ts', import.meta.url), 'utf8');
  const generated = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/^import \{ validTranslation \} from ['"]\.\/validation['"];\r?\n/, '');
  const gateway = await readFile(new URL('../../gateway/placeholder-atoms.mjs', import.meta.url), 'utf8');
  assert.equal(gateway.split('// BEGIN TRANSLATED BACKEND ALGORITHM\n')[1], generated);
});

test('网关缺x一次推理恢复整句，各种重试责任均不额外生成', async () => {
  for (const placeholderRetry of [undefined, 'caller', 'gateway']) {
    let calls = 0;
    const replay = gatewayReplay(async () => { calls++; return choice('前文译文后文译文'); });
    const result = await rows(await replay.request('/v1/translate', input('前半<x0/>后半', { placeholderRetry })));
    assert.deepEqual(result[0], { id: 's0', text: '前文译文<x0/>后文译文' });
    assert.equal(result[1].done, true); assert.equal(calls, 1);
    const metrics = replay.gateway.gateway.snapshot();
    assert.equal(metrics.completedSegments, 1); assert.equal(metrics.failedSegments, 0); assert.equal(metrics.version, '0.2.3');
  }
});

test('网关在原父组内恢复，原文数学字母和目标组合字素保持原码点', async () => {
  const source = 'We use 𝑁<g0>𝒙<x0/> and ℎ</g0> with e\u0301.';
  const output = '我们用𝑁<g0>𝒙和ℎ</g0>与e\u0301 👩🏽‍💻。', prompts = [];
  const replay = gatewayReplay(async (_url, init) => { prompts.push(JSON.parse(init.body).messages[0].content); return choice(output); });
  const result = await rows(await replay.request('/v1/translate', input(source, { placeholderRetry: 'caller' })));
  assert.equal(result[0].text, restoreMissingAtoms(source, output));
  assert.equal(result[0].text.replace(/<x0\/>/g, ''), output);
  assert.equal(prompts.length, 1); assert.ok(prompts[0].endsWith(source));
  assert.ok(result[0].text.includes('𝑁')); assert.ok(result[0].text.includes('𝒙')); assert.ok(result[0].text.includes('ℎ')); assert.ok(result[0].text.includes('e\u0301')); assert.ok(result[0].text.includes('👩🏽‍💻'));
});

test('网关也能从空输出恢复纯原子，普通文本空输出仍是模型失败', async () => {
  let calls = 0; const replay = gatewayReplay(async () => { calls++; return choice(''); });
  const restored = await rows(await replay.request('/v1/translate', input('<x0/><x1/>', { placeholderRetry: 'caller' })));
  assert.deepEqual(restored[0], { id: 's0', text: '<x0/><x1/>' }); assert.equal(calls, 1);
  const blank = await rows(await replay.request('/v1/translate', input('Words<x0/> matter.', { placeholderRetry: 'caller' })));
  assert.equal(blank[0].error.code, 'server'); assert.equal(blank[0].text, undefined); assert.equal(calls, 2);
});

test('网关缺g、额外或重复x和不确定锚点仍拒绝，原严格重试责任保持', async () => {
  const cases = [
    ['<g0>text<x0/></g0>', '正文'],
    ['text<x0/>', '正文<x9/>'],
    ['text<x0/> more<x1/>', '正文<x0/><x0/>'],
    ['<x0/>left<x1/>right<x2/>', '<x2/>甲乙<x0/>'],
    ['text<x0/>', '正文&lt;x0/&gt;'],
    ['text<x0/>', '正文<unknown>'],
  ];
  for (const [source, output] of cases) for (const placeholderRetry of ['caller', 'gateway']) {
    let calls = 0; const replay = gatewayReplay(async () => { calls++; return choice(output); });
    const result = await rows(await replay.request('/v1/translate', input(source, { placeholderRetry })));
    assert.equal(result[0].error.code, 'placeholder'); assert.equal(result[0].text, undefined);
    assert.equal(calls, placeholderRetry === 'caller' ? 1 : 2);
    assert.equal(result.at(-1).done, true);
  }
});

test('网关批量请求按各段自己的原子编号恢复，保留NDJSON段ID', async () => {
  const requests = [], replay = gatewayReplay(async (_url, init) => {
    const source = JSON.parse(init.body).messages[0].content.split('：\n').at(-1); requests.push(source);
    return choice(source.includes('first') ? '第一段译文' : '第二段译文');
  });
  const result = await rows(await replay.request('/v1/translate', input('unused', { placeholderRetry: 'caller', segments: [
    { id: 'second-id', text: '<x8/>first<x9/>' }, { id: 'first-id', text: '<x0/>second<x1/>' },
  ] })));
  assert.deepEqual(result.find(row => row.id === 'second-id'), { id: 'second-id', text: '<x8/>第一段译文<x9/>' });
  assert.deepEqual(result.find(row => row.id === 'first-id'), { id: 'first-id', text: '<x0/>第二段译文<x1/>' });
  assert.equal(requests.length, 2); assert.equal(result.at(-1).done, true);
});

test('真实Core到remote适配器和gateway全链路缺x只推理一次并交付合法结果', async t => {
  const build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
  const compiled = name => require(path.join(build, 'backend', name + '.js'));
  const { BackendCore } = compiled('core'), { BackendStorage } = compiled('storage'), { SecretVault } = compiled('secrets');
  const remote = compiled('providers/remote-node').default, previousChrome = globalThis.chrome;
  t.after(() => { globalThis.chrome = previousChrome; });
  const data = {}, area = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); }, async set(value) { Object.assign(data, structuredClone(value)); } };
  globalThis.chrome = { storage: { local: area } };
  let calls = 0; const replay = gatewayReplay(async () => { calls++; return choice('我们使用𝑁和ℎ。'); });
  const core = new BackendCore({ providers: [remote], storage: new BackendStorage({ memory: true }), vault: new SecretVault({ memory: true, storage: area }), fetch: replay.fetch });
  await core.ready(); await core.save(remote.id, true, { url: 'http://fixture.invalid', token: fixtureToken });
  const segment = { id: 's0', text: '<x0/>We use 𝑁 and ℎ.<x1/>', kind: 'paragraph' };
  const job = { jobId: 'gateway-atom-fixture', sourceLang: 'en', targetLang: 'zh-CN', mode: 'accurate', priority: 1, noCache: true, context: { url: 'https://example.test' }, segments: [segment] };
  const result = await core.translate(job, segment, 'accurate', new AbortController().signal);
  assert.equal(calls, 1); assert.equal(result.text, '<x0/>我们使用𝑁和ℎ。<x1/>');
  assert.equal(compiled('validation').validTranslation(segment.text, result.text), true);
});
