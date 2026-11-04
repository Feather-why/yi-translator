import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), build = path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled');
const { BackendCore } = require(path.join(build, 'backend/core.js'));
const { BackendStorage } = require(path.join(build, 'backend/storage.js'));
const { SecretVault } = require(path.join(build, 'backend/secrets.js'));
const { createRpcHandlers } = require(path.join(build, 'backend/rpc.js'));
const { encryptSecrets } = require(path.join(build, 'backend/secrets-backup.js'));
function area(initial = {}) { const data = structuredClone(initial); return { data, async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); }, async set(value) { Object.assign(data, structuredClone(value)); } }; }
async function setup({ local = area(), storage = new BackendStorage({ memory: true }), fetch } = {}) {
  globalThis.chrome = { storage: { local }, runtime: { id: 'templates032', getURL: file => 'chrome-extension://templates032/' + file } };
  const vault = new SecretVault({ memory: true, storage: local }), calls = [];
  const core = new BackendCore({ providers: [], storage, vault, fetch: async (url, init) => { calls.push({ url, init }); return fetch ? fetch(url, init) : new Response(JSON.stringify({ translatedText: '译文' })); } });
  await core.ready(); return { core, local, storage, vault, calls };
}
const job = (text = 'Hello', changes = {}) => ({ jobId: crypto.randomUUID(), mode: 'fast', sourceLang: 'sv', targetLang: 'en', priority: 0, context: { url: 'https://synthetic.example/' }, segments: [{ id: 'l0', kind: 'selection', text }], stream: false, ...changes });
const translate = (core, value) => core.translate(value, value.segments[0], 'fast', new AbortController().signal);
const admin = { id: 'templates032', url: 'chrome-extension://templates032/options.html' };

test('新增模板RPC、默认停用、元数据及实例重启恢复', async () => {
  const { core, local } = await setup(), handlers = createRpcHandlers(core);
  assert.deepEqual(await handlers['providers:templates'](undefined, admin), ['openai-compatible', 'llamacpp', 'remote-node', 'libretranslate', 'custom-http']);
  const lt = await core.add('libretranslate', '本机Libre'), ht = await core.add('custom-http', '自定义');
  assert.equal(lt.enabled, false); assert.equal(lt.config.url, 'http://127.0.0.1:5000'); assert.equal(lt.configured, true);
  assert.equal(ht.enabled, false); assert.equal(ht.configured, false); assert.equal(ht.template, 'custom-http');
  assert.equal(ht.auth.find(f => f.key === 'headers').type, 'textarea');
  const next = await setup({ local }); const all = await next.core.list(); assert.equal(all.find(p => p.id === lt.id).config.url, lt.config.url); assert.equal(all.find(p => p.id === ht.id).template, 'custom-http');
});

test('headers与body均经Vault加密；列表掩码、掩码保存和删除清理保持', async () => {
  const { core, local, vault } = await setup(), item = await core.add('custom-http', 'Secret endpoint');
  const headers = '{"Authorization":"Bearer fixture-secret-header"}', body = '{"q":"{{text}}","api_key":"fixture-secret-body"}';
  await core.save(item.id, true, { headers, body }, { endpoint: 'https://custom.example/translate', qps: 100 });
  assert.equal((await vault.get(item.id)).headers, headers); assert.equal((await vault.get(item.id)).body, body);
  const info = (await core.list()).find(p => p.id === item.id); assert.equal(info.config.headers, '••••'); assert.equal(info.config.body, '••••');
  assert.equal(JSON.stringify(local.data).includes('fixture-secret-header'), false); assert.equal(JSON.stringify(local.data).includes('fixture-secret-body'), false);
  assert.equal(local.data['backend.providers'][item.id].config.headers, undefined); assert.equal(local.data['backend.providers'][item.id].config.body, undefined);
  await core.save(item.id, true, { headers: '••••', body: '••••', resultPath: 'translatedText' }); assert.equal((await vault.get(item.id)).body, body);
  const restarted = await setup({ local }); assert.equal((await restarted.vault.get(item.id)).headers, headers); assert.equal((await restarted.core.list())[0].config.body, '••••');
  await restarted.core.remove(item.id); assert.equal(local.data['backend.providers'][item.id], undefined); assert.equal(local.data['backend.secrets'][item.id], undefined);
});

test('非法JSON模板在持久化前拒绝，不改变旧密钥和有效设置', async () => {
  const { core, local, vault } = await setup(), item = await core.add('custom-http', 'Safe config');
  await core.save(item.id, true, { headers: '{"X-Key":"fixture-old-secret"}' }, { endpoint: 'https://custom.example/translate' });
  const before = structuredClone(local.data['backend.providers'][item.id]);
  for (const config of [{ headers: '{"X-Key":' }, { body: '{"q":"{{bad}}"}' }, { resultPath: 'data.__proto__.secret' }, { batch: 'many' }]) await assert.rejects(core.save(item.id, true, config), error => error.info.code === 'bad_input');
  assert.deepEqual(local.data['backend.providers'][item.id], before); assert.equal((await vault.get(item.id)).headers, '{"X-Key":"fixture-old-secret"}');
  assert.equal((await core.list())[0].enabled, true);
});

test('custom-http模板/请求头/返回路径变更隔离旧缓存，摘要不暴露秘密', async () => {
  const { core, calls } = await setup({ fetch: (_url, init) => {
    const parsed = JSON.parse(init.body), value = Array.isArray(parsed.q) ? parsed.q.map(() => '译文') : '译文'; return new Response(JSON.stringify({ translatedText: value, nested: { result: value } }));
  } });
  const item = await core.add('custom-http', 'Cache config'), options = { endpoint: 'https://custom.example/translate', qps: 100 };
  await core.save(item.id, true, {}, options);
  const first = job('Same input', { providerHint: item.id }); assert.equal((await translate(core, first)).cached, false); assert.equal((await translate(core, { ...first, jobId: crypto.randomUUID() })).cached, true);
  for (const config of [{ body: '{"q":"{{text}}","variant":"fixture-private-body"}' }, { headers: '{"X-Key":"fixture-private-header"}' }, { resultPath: 'nested.result' }, { body: '', batch: 'array' }]) {
    await core.save(item.id, true, config); assert.equal((await translate(core, { ...first, jobId: crypto.randomUUID() })).cached, false);
    const info = (await core.list())[0]; assert.equal(info.adapter.version.includes('fixture-private'), false);
  }
  assert.equal(calls.length, 5);
});

test('single两任务为两HTTP，array两任务合批一次HTTP，切换后真实生效', async () => {
  const { core, calls } = await setup({ fetch: (_url, init) => { const body = JSON.parse(init.body); return new Response(JSON.stringify({ translatedText: Array.isArray(body.q) ? body.q.map(text => '译' + text) : '译' + body.q })); } });
  const item = await core.add('custom-http', 'Batch config');
  await core.save(item.id, true, { batch: 'single' }, { endpoint: 'https://custom.example/translate', qps: 100 });
  await Promise.all(['A', 'B'].map(text => translate(core, job(text, { providerHint: item.id, noCache: true })))); assert.equal(calls.length, 2); assert.ok(calls.every(row => typeof JSON.parse(row.init.body).q === 'string'));
  calls.length = 0;
  await core.save(item.id, true, { batch: 'array' });
  const result = await Promise.all(['C', 'D'].map(text => translate(core, job(text, { providerHint: item.id, noCache: true })))); assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(calls[0].init.body).q, ['C', 'D']); assert.deepEqual(result.map(row => row.text), ['译C', '译D']);
});

test('新增机翻模板不向/models发送带密钥的无关请求', async () => {
  const { core, calls } = await setup();
  for (const template of ['custom-http', 'libretranslate']) { const item = await core.add(template, template); await assert.rejects(core.models(item.id), error => error.info.code === 'bad_input'); }
  assert.equal(calls.length, 0);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const field of ['body', 'headers']) test(`真实密钥导入修改${field}：拒绝旧等待批次，A/B译文缓存不会串用`, async t => {
  const held = deferred(), started = deferred(); t.after(() => held.resolve());
  const { core, calls } = await setup({ fetch: async (_url, init) => {
    const value = JSON.parse(init.body), style = value.style ?? init.headers['X-Style'];
    if (value.q === 'Block') { started.resolve(); await held.promise; }
    return new Response(JSON.stringify({ translatedText: `${style}:${value.q}` }));
  } });
  const item = await core.add('custom-http', 'Imported config');
  const secrets = style => ({ headers: field === 'headers' ? JSON.stringify({ 'X-Style': style }) : '',
    body: JSON.stringify({ q: '{{text}}', ...(field === 'body' ? { style } : {}) }) });
  await core.save(item.id, true, secrets('A'), { endpoint: 'https://custom.example/translate', qps: 100, concurrency: 1 });
  const request = text => job(text, { providerHint: item.id });
  assert.equal((await translate(core, request('Warm'))).text, 'A:Warm');
  const blocking = translate(core, { ...request('Block'), noCache: true }); await started.promise;
  const rejected = assert.rejects(translate(core, request('Queued')), error => error.info?.code === 'no_provider');
  await pause(25);
  const handlers = createRpcHandlers(core), passphrase = 'fixture-032-import-passphrase';
  const restore = async style => {
    const archive = JSON.stringify(await encryptSecrets({ [item.id]: secrets(style) }, passphrase));
    assert.deepEqual(await handlers['secrets:import']({ archive, passphrase }, admin), { ok: true });
  };
  await restore('B'); await rejected;
  assert.equal(calls.some(row => JSON.parse(row.init.body).q === 'Queued'), false, '旧等待任务不得改用导入后的模板发送');
  held.resolve(); assert.equal((await blocking).text, 'A:Block', '已经发送的旧请求正常完成');
  const b = await translate(core, request('Queued')); assert.equal(b.text, 'B:Queued'); assert.equal(b.cached, false);
  await restore('A');
  const a = await translate(core, request('Queued')); assert.equal(a.text, 'A:Queued'); assert.equal(a.cached, false);
  const warm = await translate(core, request('Warm')); assert.equal(warm.text, 'A:Warm'); assert.equal(warm.cached, true, '相同配置的已有缓存保持有效');
});

test('刷新未改变custom配置时不取消队列，其他模板密钥仍正常刷新', async t => {
  const held = deferred(), started = deferred(); t.after(() => held.resolve());
  const { core, vault, calls } = await setup({ fetch: async (_url, init) => {
    const value = JSON.parse(init.body);
    if (value.q === 'Block') { started.resolve(); await held.promise; }
    return new Response(JSON.stringify({ translatedText: Array.isArray(value.q) ? value.q.map(text => '译' + text) : '译' + value.q }));
  } });
  const item = await core.add('custom-http', 'Unchanged config'), libre = await core.add('libretranslate', 'Other provider');
  await core.save(item.id, true, {}, { endpoint: 'https://custom.example/translate', qps: 100, concurrency: 1 });
  await core.save(libre.id, true, { key: 'fixture-old-key' }, { endpoint: 'https://libre.example', qps: 100 });
  const request = text => job(text, { providerHint: item.id, noCache: true });
  const blocking = translate(core, request('Block')); await started.promise;
  const waiting = translate(core, request('Queued')); await pause(25);
  await vault.set(libre.id, { key: 'fixture-new-key' }); await core.refreshStoredState(); held.resolve();
  assert.deepEqual((await Promise.all([blocking, waiting])).map(row => row.text), ['译Block', '译Queued']);
  await translate(core, job('Libre', { providerHint: libre.id, noCache: true }));
  assert.equal(JSON.parse(calls.find(row => row.url.startsWith('https://libre.example')).init.body).api_key, 'fixture-new-key');
});

test('导入非法custom模板不替换当前有效配置并阻止调用，其他密钥刷新及恢复不受影响', async () => {
  const { core, vault, calls } = await setup();
  const item = await core.add('custom-http', 'Validated import'), libre = await core.add('libretranslate', 'Other secrets');
  await core.save(item.id, true, {}, { endpoint: 'https://custom.example/translate', qps: 100 });
  await core.save(libre.id, false, { key: 'fixture-old-key' });
  const previous = await vault.get(item.id);
  await vault.set(item.id, { ...previous, body: '{invalid' });
  await vault.set(libre.id, { key: 'fixture-new-key' }); await core.refreshStoredState();
  const list = await core.list(); assert.equal(list.find(row => row.id === item.id).configured, false); assert.equal(list.find(row => row.id === libre.id).configured, true);
  await assert.rejects(translate(core, job('Do not send', { providerHint: item.id })), error => error.info?.code === 'no_provider');
  assert.equal(calls.length, 0); assert.equal((await vault.get(libre.id)).key, 'fixture-new-key');
  await vault.set(item.id, previous); await core.refreshStoredState();
  assert.equal((await core.list()).find(row => row.id === item.id).configured, true);
  assert.equal((await translate(core, job('Recovered', { providerHint: item.id }))).text, '译文');
});
