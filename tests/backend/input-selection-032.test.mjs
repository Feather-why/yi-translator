import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), build = path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled');
const compiled = name => require(path.join(build, `backend/${name}.js`));
const { BackendCore } = compiled('core'), { BackendStorage } = compiled('storage'), { SecretVault } = compiled('secrets');
const { classifyError } = compiled('providers/types'), { sensitiveSender } = compiled('rpc'), { disposeSensitivePolicy } = compiled('sensitive-policy');
const indexCode = await readFile(path.join(build, 'backend/index.js'), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit(...args) { for (const fn of [...listeners]) fn(...args); } }; };
class ObservedStorage extends BackendStorage {
  accesses = [];
  constructor() { super({ memory: true }); }
  async cacheGet(...args) { this.accesses.push('cacheGet'); return super.cacheGet(...args); }
  async cachePut(...args) { this.accesses.push('cachePut'); return super.cachePut(...args); }
  async tmGet(...args) { this.accesses.push('tmGet'); return super.tmGet(...args); }
}
async function setup(t, sender, noCache) {
  disposeSensitivePolicy(); const data = { 'settings.ui': { sensitive: ['bank.fixture', 'mail.fixture'] } }, calls = [], storage = new ObservedStorage();
  const local = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); }, async set(value) { Object.assign(data, structuredClone(value)); } };
  const chrome = { storage: { local, onChanged: event() }, runtime: { onConnect: event() }, alarms: { onAlarm: event() } };
  globalThis.chrome = chrome;
  const provider = { id: 'input-fixture', name: 'Input fixture', kind: 'local', official: true, version: '1', auth: [], usedFor: ['fast', 'accurate', 'combined'],
    limits: { maxChars: 1200, maxSegments: 1, concurrency: 3 }, placeholders: 'prompt', classifyError,
    async translate(request, ctx) {
      calls.push(structuredClone(request));
      if (request.texts[0] === 'Första raden.') await delay(15);
      return request.texts.map(text => ({ 'Första raden.': 'First line.', 'Andra raden.': 'Second line.', 'Tredje raden.': 'Third line.' })[text]);
    },
  };
  const filename = path.join(build, 'backend/index.js'), localRequire = createRequire(filename), exports = {};
  class TestCore extends BackendCore {
    constructor(options) { super({ ...options, providers: [provider], storage, vault: new SecretVault({ memory: true, storage: local }) }); }
    async probe() {}
  }
  class Services { ready() { return new Promise(() => {}); } alignment = { precompute() { assert.fail('敏感输入不得预计算或缓存对齐'); } }; sync = { status: () => ({ enabled: false }) }; dispose() {} }
  vm.runInNewContext(indexCode, { exports, module: { exports }, chrome, console, require(name) {
    if (name === './core') return { BackendCore: TestCore };
    if (name === './providers/registry') return { providers: [] };
    if (name === './services') return { BackendServices: Services };
    if (name === './rpc') return { sensitiveSender, registerRpc: () => () => {} };
    if (name === './local-control') return { NativeLocalControl: class { dispose() {} } };
    if (name === './model-warmup') return { ModelWarmup: class { dispose() {} } };
    if (name === './browser-translator-bridge') return { createBrowserTranslatorBridge: () => undefined };
    return localRequire(name);
  } }, { filename });
  // 运行真实 startBackend 的 sender/noCache 边界与真实 TranslatePort/Core；只替换无关服务和模型传输。
  const backend = exports.startBackend(); await backend.core.ready();
  t.after(() => { backend.dispose(); disposeSensitivePolicy(); });
  const port = { name: 'translate', sender, messages: [], onMessage: event(), onDisconnect: event(), postMessage(value) { this.messages.push(structuredClone(value)); } };
  const protocol = require(path.join(build, 'shared/protocol.js')); port.name = protocol.PORT_TRANSLATE;
  chrome.runtime.onConnect.emit(port);
  const segments = ['Första raden.', 'Andra raden.', 'Tredje raden.'].map((text, index) => ({ id: `l${index}`, text, kind: 'selection' }));
  const job = { jobId: 'input-lines', sourceLang: 'sv', targetLang: 'en', mode: 'fast', priority: 0, stream: false, noCache,
    context: { url: 'https://public.fixture/' }, segments };
  for (const segment of segments) await BackendStorage.prototype.tmPut.call(storage, 'sv', 'en', segment.text, 'Cached secret must never be used.');
  storage.accesses.length = 0;
  port.onMessage.emit({ type: 'job', job });
  const end = Date.now() + 3000;
  while (!port.messages.some(message => message.type === 'job-done')) { assert.ok(Date.now() < end, JSON.stringify(port.messages)); await delay(2); }
  return { calls, storage, messages: port.messages };
}

for (const [name, sender, noCache] of [
  ['显式 noCache', { url: 'https://public.fixture/', tab: { id: 1 } }, true],
  ['银行 sender 强制 noCache', { url: 'https://bank.fixture/', tab: { id: 1 } }, false],
  ['邮件 sender 强制 noCache', { url: 'https://mail.fixture/compose', tab: { id: 1 } }, false],
  ['隐身 sender 强制 noCache', { url: 'https://public.fixture/', tab: { id: 1, incognito: true } }, false],
]) test(`${name}：逐行 selection 保留 l编号、显式 sv→en、无 partial，绕过全部译文存储`, async t => {
  const { calls, storage, messages } = await setup(t, sender, noCache);
  assert.equal(calls.length, 3);
  for (const call of calls) { assert.equal(call.sourceLang, 'sv'); assert.equal(call.targetLang, 'en'); assert.notEqual(call.stream, true); assert.equal(call.texts.length, 1); }
  const results = messages.filter(message => message.type === 'result').sort((a, b) => a.segmentId.localeCompare(b.segmentId));
  assert.deepEqual(results.map(message => [message.segmentId, message.text]), [['l0', 'First line.'], ['l1', 'Second line.'], ['l2', 'Third line.']], JSON.stringify(messages));
  assert.equal(messages.some(message => message.type === 'partial' || message.type === 'error'), false);
  assert.deepEqual(storage.accesses, []);
});
