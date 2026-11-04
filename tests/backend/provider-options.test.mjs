import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BackendCore } = require('../.compiled/backend/core.js');
const { BackendStorage } = require('../.compiled/backend/storage.js');
const { SecretVault } = require('../.compiled/backend/secrets.js');
const { providers } = require('../.compiled/backend/providers/registry.js');
const { ProviderError, classifyError } = require('../.compiled/backend/providers/types.js');
const { normalizeOptions, providerMetadata, effectiveProvider } = require('../.compiled/backend/provider-options.js');
const { createRpcHandlers } = require('../.compiled/backend/rpc.js');
const { ChromeSyncStore } = require('../.compiled/backend/sync/chrome-store.js');

function area(initial = {}) {
  const data = structuredClone(initial);
  return { data, async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); },
    async set(items) { Object.assign(data, structuredClone(items)); } };
}
async function setup(options = {}) {
  const local = options.local ?? area();
  globalThis.chrome = { storage: { local }, runtime: { id: 'options-test', getURL: (path) => `chrome-extension://options-test/${path}` } };
  const vault = new SecretVault({ memory: true, storage: local });
  const core = new BackendCore({ providers: options.providers ?? providers, storage: new BackendStorage({ memory: true }), vault, ...(options.fetch ? { fetch: options.fetch } : {}) });
  await core.ready(); return { core, local, vault };
}
function request(text = 'Hello.', changes = {}) {
  return { jobId: crypto.randomUUID(), mode: 'accurate', sourceLang: 'en', targetLang: 'zh-CN', priority: 1,
    context: { url: 'https://example.test/article' }, segments: [{ id: 's0', text, kind: 'paragraph' }], ...changes };
}
const translate = (core, job = request(), tier = 'accurate') => core.translate(job, job.segments[0], tier, new AbortController().signal);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const completion = (body) => json({ choices: [{ message: { content: JSON.stringify({ translations: JSON.parse(body).messages[1] ? JSON.parse(JSON.parse(body).messages[1].content).segments.map((entry) => ({ id: entry.id, text: '译文' })) : [] }) } }] });
const fixture = (id, overrides = {}) => ({ id, name: id, version: '1', official: true, kind: 'mt', auth: [], usedFor: ['fast', 'accurate', 'combined'],
  limits: { maxChars: 1000, maxSegments: 1, concurrency: 4 }, placeholders: 'prompt', classifyError,
  async translate(req) { return req.texts.map(() => id + '译文'); }, ...overrides });

test('高级能力只声明真实支持项，严格验证并夹限，未设置项保持默认和适配器版本', () => {
  const openai = providers.find((provider) => provider.id === 'openai-compatible'), remote = providers.find((provider) => provider.id === 'remote-node');
  assert.ok(providerMetadata(openai).editable.includes('endpoint'));
  assert.ok(providerMetadata(openai).editable.includes('prompt'));
  assert.equal(providerMetadata(remote).editable.includes('temperature'), false);
  assert.equal(providerMetadata(providers[0]).editable.includes('endpoint'), false);
  assert.equal(effectiveProvider(openai, {}).version, openai.version);
  const normalized = normalizeOptions(openai, { concurrency: 999, qps: 0, timeoutMs: 1, weight: -2, maxChars: 999999, temperature: 9 });
  assert.deepEqual(normalized, { concurrency: 16, qps: 0.1, timeoutMs: 1000, weight: 0, maxChars: 6000, temperature: 2 });
  for (const value of [{ script: 'x' }, { endpoint: 'javascript:alert(1)' }, { endpoint: 'https://user:pass@example.test/' }, { weight: NaN },
    { quota: { amount: 5, unit: 'token', period: 'month' } }, { quota: { amount: 5, unit: 'char', period: 'cycle' } }, { usedFor: [] }]) assert.throws(() => normalizeOptions(openai, value));
  assert.throws(() => normalizeOptions(remote, { prompt: 'unsupported' }));
});

test('options整份替换、掩码保留旧key，地址和模型实际生效且模型或提示词变化隔离缓存', async () => {
  const calls = [];
  const { core, vault } = await setup({ fetch: async (url, init) => { calls.push({ url, ...init, body: JSON.parse(init.body) }); return completion(init.body); } });
  const custom = await core.add('openai-compatible', '自定义模型');
  await core.save('llamacpp', false, {});
  const options = { endpoint: 'https://proxy.example/v1', model: 'model-a', usedFor: ['accurate', 'combined'], weight: 90 };
  await core.save(custom.id, true, { key: 'fixture-key-a' }, options);
  assert.equal((await core.test(custom.id)).ok, true);
  assert.equal(calls[0].url, 'https://proxy.example/v1/chat/completions'); assert.equal(calls[0].body.model, 'model-a');
  assert.equal((await translate(core)).provider, custom.id);
  assert.equal((await translate(core)).cached, true);
  await core.save(custom.id, true, { key: '••••' }, { ...options, model: 'model-b' });
  assert.equal((await vault.get(custom.id)).key, 'fixture-key-a'); assert.equal((await translate(core)).cached, false);
  assert.equal(calls.at(-1).body.model, 'model-b');
  await core.save(custom.id, true, { key: '••••' }, { ...options, model: 'model-b', prompt: '请译为{{to}}：{{text}}', temperature: 0.2 });
  assert.equal((await translate(core)).cached, false);
  assert.equal(calls.at(-1).body.temperature, 0.2);
  assert.ok(calls.at(-1).body.messages.some((message) => message.content.includes('请译为zh-CN')));
  await core.save(custom.id, false, { key: '••••' }); assert.equal((await core.list()).find((entry) => entry.id === custom.id).options.model, 'model-b');
  await core.save(custom.id, true, { key: '••••' }, {});
  const reset = (await core.list()).find((entry) => entry.id === custom.id);
  assert.deepEqual(reset.options, {}); assert.equal(reset.configured, false); assert.equal(reset.config.url, undefined);
  await core.save(custom.id, true, { key: '' }, { endpoint: 'http://127.0.0.1:11434/v1', model: 'ollama' });
  assert.equal((await translate(core, request('Without key', { providerHint: custom.id, noCache: true }))).provider, custom.id);
  assert.equal(calls.at(-1).headers.Authorization, undefined);
});

test('v1地址/模型配置迁移后重启仍保留，v2恢复默认不会恢复已经清除的旧配置', async () => {
  const { core, local } = await setup();
  await core.save('openai-compatible', true, { url: 'https://legacy.example/v1', model: 'legacy-model', key: 'fixture-legacy-key' });
  const restarted = await setup({ local });
  let info = (await restarted.core.list()).find((entry) => entry.id === 'openai-compatible');
  assert.equal(info.options.endpoint, 'https://legacy.example/v1'); assert.equal(info.options.model, 'legacy-model'); assert.equal(info.configured, true);
  await restarted.core.save(info.id, true, { key: '••••' }, {});
  const again = await setup({ local }); info = (await again.core.list()).find((entry) => entry.id === 'openai-compatible');
  assert.deepEqual(info.options, {}); assert.equal(info.config.url, 'https://api.openai.com/v1'); assert.equal(info.config.model, undefined); assert.equal(info.configured, false);
});

test('三模板实例唯一、默认停用并重启恢复；独立密钥及删除清理，内置不可删除', async () => {
  const { core, local, vault } = await setup({ fetch: async (_url, init) => completion(init.body) });
  const created = await Promise.all(['openai-compatible', 'llamacpp', 'remote-node'].map((template) => core.add(template, template + '实例')));
  assert.equal(new Set(created.map((entry) => entry.id)).size, 3);
  for (const entry of created) { assert.equal(entry.custom, true); assert.equal(entry.enabled, false); assert.equal(entry.configured, false); }
  const [a] = created, b = await core.add('openai-compatible', '第二个模型');
  assert.equal(core.snapshot().providers.find((entry) => entry.id === a.id).adapter.file, 'src/backend/providers/openai-compatible.ts');
  await core.save(a.id, true, { key: 'fixture-a' }, { endpoint: 'https://a.example/v1', model: 'a', quota: { unit: 'char', amount: 100, period: 'day' } }, '改过的名字');
  await core.save(b.id, true, { key: 'fixture-b' }, { endpoint: 'https://b.example/v1', model: 'b' });
  await translate(core, request('Hello.', { providerHint: a.id }));
  assert.equal(local.data['backend.usage'][a.id].used, 6);
  const restarted = await setup({ local });
  const restored = (await restarted.core.list()).find((entry) => entry.id === a.id);
  assert.equal(restored.name, '改过的名字'); assert.equal(restored.enabled, true); assert.equal(restored.options.model, 'a');
  assert.equal((await restarted.vault.get(a.id)).key, 'fixture-a'); assert.equal((await restarted.vault.get(b.id)).key, 'fixture-b');
  await restarted.core.remove(a.id);
  assert.equal((await restarted.core.list()).some((entry) => entry.id === a.id), false);
  assert.equal(restarted.core.snapshot().providers.some((entry) => entry.id === a.id), false);
  assert.equal(local.data['backend.providers'][a.id], undefined); assert.equal(local.data['backend.secrets'][a.id], undefined); assert.equal(local.data['backend.usage'][a.id], undefined);
  assert.equal((await vault.get(b.id)).key, 'fixture-b');
  await assert.rejects(restarted.core.remove('llamacpp'), (error) => error.info.code === 'bad_input');
  await assert.rejects(restarted.core.add('constructor', '坏模板'), (error) => error.info.code === 'bad_input');
});

test('调度真实使用usedFor/weight及零免费额度回退，置顶可优先选择付费服务', async () => {
  const { core } = await setup({ providers: [fixture('free'), fixture('paid')] });
  await core.save('free', true, {}, { usedFor: ['accurate', 'combined'], weight: 0 });
  await core.save('paid', true, {}, { weight: 100, quota: { unit: 'char', amount: 0, period: 'month' } });
  assert.equal((await translate(core, request('One', { noCache: true }))).provider, 'free');
  assert.equal(core.snapshot().providers.find((entry) => entry.id === 'paid').quota, undefined);
  await core.action('paid', 'pin'); assert.equal((await translate(core, request('Two', { noCache: true }))).provider, 'paid');
  await core.action('paid', 'unpin');
  assert.equal((await translate(core, request('Three', { mode: 'fast', noCache: true }), 'fast')).provider, 'paid');
  await core.save('free', true, {}, { weight: 0 }); await core.save('paid', true, {}, { weight: 100 });
  assert.equal((await translate(core, request('Four', { noCache: true, context: { url: 'https://other.test/' } }))).provider, 'paid');
});

test('并发/QPS/maxChars覆盖实际请求；超时覆盖适配器自身60秒设置', async () => {
  let active = 0, maximum = 0; const times = [], lengths = [];
  const p = fixture('limits', { async translate(req, ctx) {
    active++; maximum = Math.max(maximum, active); times.push(performance.now()); lengths.push(...req.texts.map((text) => text.length));
    try { await ctx.fetch('https://limits.example/', { timeoutMs: 60000 }); return req.texts.map(() => '译文'); } finally { active--; }
  } });
  const { core } = await setup({ providers: [p], fetch: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return json({}); } });
  await core.save('limits', true, {}, { concurrency: 1, qps: 20, maxChars: 16 });
  await Promise.all([translate(core, request('x'.repeat(32), { noCache: true, context: { url: 'https://a.test/' } })), translate(core, request('other', { noCache: true, context: { url: 'https://b.test/' } }))]);
  assert.equal(maximum, 1); assert.ok(lengths.every((length) => length <= 16)); assert.ok(times.slice(1).every((time, index) => time - times[index] >= 35));
  const slow = await setup({ providers: [p], fetch: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  await slow.core.save('limits', true, {}, { timeoutMs: 1000 });
  const started = performance.now(); assert.equal((await slow.core.test('limits')).ok, false); assert.ok(performance.now() - started < 1800);
});

test('模型列表真实HTTP查询/回退，5秒限制且无Cookie/重定向；未保存跨origin不复用掩码密钥', async (t) => {
  const calls = [];
  async function server() {
    const instance = http.createServer((req, res) => {
      calls.push({ path: req.url, auth: req.headers.authorization, cookie: req.headers.cookie });
      if (req.url.endsWith('/v1/health')) return res.end(JSON.stringify({ ok: true, models: [{ id: 'remote-model', loaded: true }] }));
      if (req.url === '/ollama/v1/models') return res.writeHead(404).end('{}');
      if (req.url === '/ollama/api/tags') return res.end(JSON.stringify({ models: [{ name: 'ollama-model' }] }));
      if (req.url.startsWith('/redirect')) return res.writeHead(302, { Location: '/v1/models' }).end();
      res.end(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }));
    });
    await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve)); t.after(() => instance.close());
    return `http://127.0.0.1:${instance.address().port}`;
  }
  const first = await server(), second = await server(), { core } = await setup();
  const custom = await core.add('openai-compatible', '模型列表');
  await core.save(custom.id, false, { key: 'fixture-list-key' }, { endpoint: first + '/v1', model: 'a' });
  assert.deepEqual(await core.models(custom.id, undefined, { key: '••••' }), ['a', 'b']); assert.equal(calls.at(-1).auth, 'Bearer fixture-list-key');
  await core.models(custom.id, second, { key: '••••' }); assert.equal(calls.at(-1).auth, undefined);
  await core.models(custom.id, second, { key: 'explicit-new-key' }); assert.equal(calls.at(-1).auth, 'Bearer explicit-new-key');
  assert.deepEqual(await core.models(custom.id, first + '/ollama', { key: '' }), ['ollama-model']);
  const remote = await core.add('remote-node', '远程'); assert.deepEqual(await core.models(remote.id, first, { token: 'fixture-token' }), ['remote-model']);
  await assert.rejects(core.models(custom.id, first + '/redirect', { key: '' })); assert.ok(calls.every((call) => !call.cookie));
  const hang = await setup({ fetch: async () => new Promise(() => {}) });
  const h = await hang.core.add('llamacpp', '超时');
  const start = performance.now(); await assert.rejects(hang.core.models(h.id, first)); assert.ok(performance.now() - start >= 4800 && performance.now() - start < 6500);
});

test('高级服务管理RPC只允许本扩展页面，非法来源在解析参数前拒绝', async () => {
  const { core } = await setup(), handlers = createRpcHandlers(core);
  for (const name of ['providers:save', 'providers:add', 'providers:remove', 'providers:models']) {
    for (const sender of [{ id: 'options-test', url: 'https://page.test/' }, { id: 'other', url: 'chrome-extension://options-test/options.html' }]) {
      await assert.rejects(handlers[name](undefined, sender), (error) => error.info.code === 'auth');
    }
  }
  const admin = { id: 'options-test', url: 'chrome-extension://options-test/options.html', tab: { id: 1 } };
  const custom = await handlers['providers:add']({ template: 'llamacpp', name: '设置页实例' }, admin);
  assert.equal(custom.custom, true); await handlers['providers:remove']({ id: custom.id }, admin);
});

test('动态同步密钥白名单包含新实例，未知归档实例不会被导入或创建', async () => {
  const { core, local, vault } = await setup();
  const store = new ChromeSyncStore({ storage: local, vault, providerIds: async () => (await core.list()).map((entry) => entry.id) });
  const first = await store.export(true); const custom = await core.add('openai-compatible', '同步实例');
  await core.save(custom.id, false, { key: 'fixture-sync-key' });
  assert.equal(first.secrets[custom.id], undefined); assert.equal((await store.export(true)).secrets[custom.id].key, 'fixture-sync-key');
  await store.import({ version: 1, fields: {}, usage: {}, secrets: { 'custom-unknown-instance': { key: 'must-ignore' } } });
  assert.deepEqual(await vault.get('custom-unknown-instance'), {});
  assert.equal((await core.list()).some((entry) => entry.id === 'custom-unknown-instance'), false);
});
