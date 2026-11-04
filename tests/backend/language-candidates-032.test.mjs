import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), build = path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled');
const { BackendCore } = require(path.join(build, 'backend/core.js'));
const { BackendStorage } = require(path.join(build, 'backend/storage.js'));
const { SecretVault } = require(path.join(build, 'backend/secrets.js'));
const tencent = require(path.join(build, 'backend/providers/tencent.js')).default;
const { classifyError } = require(path.join(build, 'backend/providers/types.js'));

async function setup(includeSupported = false) {
  const data = {}, calls = []; let tencentAttempts = 0;
  const local = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); }, async set(value) { Object.assign(data, structuredClone(value)); } };
  globalThis.chrome = { storage: { local } };
  const known = { ...tencent, async translate(...args) { tencentAttempts++; return tencent.translate(...args); } };
  const supported = { id: 'supported-language-fixture', name: '支持该语言的服务', version: '1', kind: 'mt', official: true, auth: [],
    usedFor: ['fast', 'combined'], freeQuota: { amount: 1000, unit: 'char', period: 'month' }, limits: { maxChars: 1000, maxSegments: 1, concurrency: 1 }, placeholders: 'prompt',
    supports: (from, to) => ['sv', 'auto'].includes(from) && to === 'en', classifyError,
    async translate(request, context) {
      const response = await context.fetch('https://supported.example/translate', { method: 'POST', body: JSON.stringify(request) });
      return (await response.json()).translations;
    },
  };
  const core = new BackendCore({ providers: includeSupported ? [known, supported] : [known], storage: new BackendStorage({ memory: true }), vault: new SecretVault({ memory: true, storage: local }),
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(url.includes('tencentcloudapi.com') ? { Response: { TargetTextList: ['Hello world.'] } } : { translations: ['Hello world.'] }));
    },
  });
  await core.ready();
  await core.save('tencent', true, { secretId: 'fixture-id', secretKey: 'fixture-secret', monthlyQuota: '1000' }, { qps: 100 });
  await core.action('tencent', 'pin');
  return { core, calls, attempts: () => tencentAttempts };
}
function job(sourceLang = 'sv') { return { jobId: crypto.randomUUID(), sourceLang, targetLang: 'en', mode: 'fast', priority: 0, noCache: true,
  context: { url: 'https://public.example/' }, segments: [{ id: 'l0', kind: 'selection', text: 'Hej världen.' }] }; }
const translate = (core, value = job()) => core.translate(value, value.segments[0], 'fast', new AbortController().signal);
const quota = (core, id) => core.snapshot().providers.find(provider => provider.id === id).quota;

test('真实Core跳过已置顶但不支持sv→en的腾讯，未调用adapter/HTTP/扣额，下一服务成功', async () => {
  const { core, calls, attempts } = await setup(true);
  assert.equal(core.snapshot().providers.find(provider => provider.id === 'tencent').pinned, true);
  const result = await translate(core);
  assert.equal(result.provider, 'supported-language-fixture'); assert.equal(result.text, 'Hello world.');
  assert.equal(attempts(), 0); assert.deepEqual(calls.map(row => row.url), ['https://supported.example/translate']);
  assert.equal(calls[0].body.sourceLang, 'sv'); assert.equal(calls[0].body.targetLang, 'en');
  assert.equal(quota(core, 'tencent').used, 0); assert.ok(quota(core, 'supported-language-fixture').used > 0);
});

test('真实Core只剩不支持候选时返回可读bad_input且零请求零用量', async () => {
  const { core, calls, attempts } = await setup();
  await assert.rejects(translate(core), error => error.info?.code === 'bad_input' && error.info.retryable === false
    && error.message.includes('不支持') && error.message.includes('sv') && error.message.includes('en'));
  assert.equal(attempts(), 0); assert.equal(calls.length, 0); assert.equal(quota(core, 'tencent').used, 0);
});

test('真实Core不误拒auto→en，腾讯收到auto并按实际一次请求计量', async () => {
  const { core, calls, attempts } = await setup();
  const result = await translate(core, job('auto'));
  assert.equal(result.provider, 'tencent'); assert.equal(result.text, 'Hello world.');
  assert.equal(attempts(), 1); assert.equal(calls.length, 1); assert.equal(calls[0].body.Source, 'auto'); assert.equal(calls[0].body.Target, 'en');
  assert.equal(quota(core, 'tencent').used, Array.from('Hej världen.').length);
});
