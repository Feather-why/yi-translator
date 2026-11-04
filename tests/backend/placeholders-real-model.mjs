import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { BackendCore } = require('../.compiled/backend/core.js');
const { BackendStorage } = require('../.compiled/backend/storage.js');
const { SecretVault } = require('../.compiled/backend/secrets.js');
const { validTranslation } = require('../.compiled/backend/validation.js');
const provider = require('../.compiled/backend/providers/llamacpp.js').default;
const data = {};
globalThis.chrome = { storage: { local: {
  async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); },
  async set(items) { Object.assign(data, structuredClone(items)); },
} } };
const storage = new BackendStorage({ memory: true }), vault = new SecretVault({ memory: true });
const core = new BackendCore({ providers: [provider], storage, vault });
await core.ready();
const cases = [
  '<g0>Machine translation</g0> is the use of computational techniques to <g1>translate</g1> text or speech from one <g2>language</g2> to another, including the contextual, idiomatic, and pragmatic nuances of both languages.',
  'While some language models are capable of generating comprehensible results, machine translation tools remain limited by the complexity of language and emotion.<g0>[1]</g0><g1>[2]</g1> Effective improvement requires human intervention in <g2>simultaneous interpretation</g2>.',
  'Read the <g0>installation <g1>guide and <g2>examples</g2></g1></g0>, then use <x0/> and visit <x1/>. 日本語も翻訳できます。',
  'The <g0>browser</g0> and the <g1>translation model</g1> run locally. '.repeat(24).replace(/<g0>/g, '<g10>').replace(/<\/g0>/g, '</g10>'),
  '<g0><g1>See also</g1></g0>: <g2>neural machine translation</g2>, <g3>large language models</g3> and <x0/>.',
];
const results = [];
for (let index = 0; index < cases.length; index++) {
  const source = cases[index]; const segment = { id: `real-${index}`, text: source, kind: 'paragraph' };
  const job = { jobId: `real-${index}`, segments: [segment], sourceLang: 'en', targetLang: 'zh-CN', priority: 0, mode: 'fast', noCache: true, context: { url: 'https://en.wikipedia.org/wiki/Machine_translation' } };
  const start = performance.now();
  const result = await core.translate(job, segment, 'fast', new AbortController().signal);
  assert.equal(validTranslation(source, result.text), true);
  assert.equal(result.provider, 'llamacpp'); assert.equal(result.cached, false);
  assert.doesNotMatch(result.text, /严格保留原文|禁止新增.*标记|请原样保留|将以下文本翻译/);
  results.push({ source, text: result.text, ms: Math.round(performance.now() - start) });
}
assert.equal(core.snapshot().providers[0].circuit, 'closed');
await mkdir(new URL('../../work/', import.meta.url), { recursive: true });
await writeFile(new URL('../../work/placeholders-real-model.json', import.meta.url), JSON.stringify({ ok: true, results }, null, 2));
console.log(JSON.stringify({ ok: true, cases: results.length, ms: results.map((item) => item.ms), health: core.snapshot().providers[0].health }));
