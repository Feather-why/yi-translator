import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const event = () => ({ listeners: new Set(), addListener(callback) { this.listeners.add(callback); }, removeListener(callback) { this.listeners.delete(callback); } });

test('正式index共享同一32槽队列，普通/敏感combined异步工厂正确接线，warm候选只从已配置本机及Vault获取', async (t) => {
  const changed = [], ports = [], calls = [], vault = [], candidates = [{ id: 'llamacpp', kind: 'local', enabled: true, configured: true, config: { url: 'http://127.0.0.1:8081' }, options: {} }];
  let diagnostics, warmupOptions, coreOptions, disposed = false;
  const stub = (name, exports) => {
    const target = require.resolve('../.compiled/backend/' + name + '.js'), old = require.cache[target]; changed.push([target, old]);
    require.cache[target] = { id: target, filename: target, loaded: true, exports };
  };
  class Core {
    constructor(options) { coreOptions = options; }
    ready() { return Promise.resolve(); } probe() { return Promise.resolve(); } notifyStatus() {} refreshPolicy() { return Promise.resolve(); }
    list() { return Promise.resolve(candidates); } snapshot() { return { providers: candidates.map((provider) => ({ id: provider.id, health: provider.enabled ? 'idle' : 'disabled' })) }; }
    getVault() { return { get: async (id) => { vault.push(id); return { key: 'synthetic-private-key' }; } }; }
    createCombined(job) { calls.push(['combined', job]); return { translate: async () => ({ text: '合成译文', provider: 'llamacpp', cached: false }), dispose() {} }; }
    translate(job) { calls.push(['translate', job]); return Promise.resolve({ text: '合成译文', provider: 'llamacpp', cached: false }); }
  }
  class Services {
    constructor() { this.alignment = { precompute: async () => {}, projection: async () => undefined }; this.dictionary = { status: () => ({ ready: false }) }; this.sync = { status: () => ({ enabled: false }), notifyChange() {} }; this.rules = { refresh: async () => {} }; }
    ready() { return Promise.resolve(); } dispose() { return Promise.resolve(); }
  }
  stub('core', { BackendCore: Core }); stub('services', { BackendServices: Services });
  stub('ports/translate', { TranslatePort: class { constructor(_port, service, concurrency, queue) { ports.push({ service, concurrency, queue }); } dispose() {} } });
  stub('rpc', { sensitiveSender: async (sender) => sender.tab?.incognito || sender.url?.includes('private.example'), registerRpc: (_core, _services, options) => { diagnostics = options; return () => {}; } });
  stub('model-warmup', { ModelWarmup: class { constructor(options) { warmupOptions = options; } warmup() { return Promise.resolve({ status: 'ready' }); } dispose() { disposed = true; } } });
  stub('browser-translator-bridge', { createBrowserTranslatorBridge: () => ({}) });
  const index = require.resolve('../.compiled/backend/index.js'), oldIndex = require.cache[index]; delete require.cache[index];
  t.after(() => { for (const [target, old] of changed) { if (old) require.cache[target] = old; else delete require.cache[target]; } if (oldIndex) require.cache[index] = oldIndex; else delete require.cache[index]; });
  globalThis.chrome = { runtime: { onConnect: event(), getURL: (path) => 'chrome-extension://fixture/' + path }, storage: { local: {}, onChanged: event() },
    alarms: { onAlarm: event(), get: async () => undefined, create: async () => {}, clear: async () => true }, tabs: { create: async () => ({}) } };
  const backend = require(index).startBackend();
  const connect = [...chrome.runtime.onConnect.listeners][0];
  connect({ name: 'tx:translate', sender: { url: 'https://public.example/', tab: { id: 1 } }, onDisconnect: event() });
  connect({ name: 'tx:translate', sender: { url: 'https://private.example/', tab: { id: 2 } }, onDisconnect: event() });
  assert.equal(ports.length, 2); assert.equal(ports[0].queue, ports[1].queue); assert.equal(ports[0].concurrency, 32); assert.equal(ports[0].queue.concurrency, 32);
  const job = { mode: 'combined', noCache: false }, segment = { text: 'Private source must not enter stats.' };
  await ports[0].service.createCombined(job, segment); await ports[1].service.createCombined(job, segment);
  assert.equal(calls[0][1], job); assert.notEqual(calls[1][1], job); assert.equal(calls[1][1].noCache, true); assert.equal(job.noCache, false);
  await ports[1].service.translate(job, segment, 'accurate', new AbortController().signal); assert.equal(calls[2][1].noCache, true);
  coreOptions.onPerformance({ type: 'http', providerId: 'llamacpp', outcome: 'success', durationMs: 7, source: segment.text });
  assert.equal(diagnostics.performance().http[0].count, 1); assert.ok(!JSON.stringify(diagnostics.performance()).includes(segment.text));
  const warm = await warmupOptions.provider(); assert.equal(warm.id, 'llamacpp'); assert.equal(warm.adapter, 'llamacpp'); assert.equal(warm.endpoint, 'http://127.0.0.1:8081'); assert.equal(warm.apiKey, 'synthetic-private-key');
  assert.equal(await warmupOptions.provider('unknown-id'), undefined);
  candidates[0].enabled = false; await warmupOptions.provider('llamacpp'); assert.equal(vault.length, 1, '停用候选不读取Vault');
  backend.dispose(); assert.equal(disposed, true);
});
