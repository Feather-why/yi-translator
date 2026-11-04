import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BackendCore } = require('../.compiled/backend/core.js');
const { BackendStorage } = require('../.compiled/backend/storage.js');
const { SecretVault } = require('../.compiled/backend/secrets.js');
const { BackendServices } = require('../.compiled/backend/services.js');
const { Dictionary } = require('../.compiled/backend/dict/index.js');
const { createRpcHandlers } = require('../.compiled/backend/rpc.js');

test('真实业务服务接线：离线词典/规则/TM可用，远程对齐token加密并支持掩码保留和清空', async () => {
  const data = {};
  const area = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); },
    async set(items) { Object.assign(data, structuredClone(items)); } };
  globalThis.chrome = { storage: { local: area }, runtime: { id: 'service-test-id', getURL: (path) => `chrome-extension://service-test-id/${path}` } };
  const vault = new SecretVault({ memory: true, storage: area });
  const core = new BackendCore({ providers: [], storage: new BackendStorage({ memory: true }), vault }); await core.ready();
  const services = new BackendServices(core, { storage: area, providerIds: ['align'], schedule() {}, dictionary: new Dictionary({ memory: true,
    entries: [{ word: 'run', translation: 'v. 跑步', exchange: 'i:running/p:ran/d:run' }] }) });
  try {
    await services.ready(); const handlers = createRpcHandlers(core, services);
    const sender = { id: 'service-test-id', url: 'https://example.test/' };
    const entry = await handlers['dict:lookup']({ word: 'running', lang: 'auto', targetLang: 'zh-CN' }, sender);
    assert.equal(entry.lemma, 'run'); assert.ok(entry.translations.includes('v. 跑步'));
    assert.equal((await handlers['rules:forUrl']({ url: 'https://en.wikipedia.org/wiki/Translate' }, sender)).source, 'builtin');
    await handlers['tm:save']({ source: 'Hello', target: '你好', sourceLang: 'en', targetLang: 'zh' }, sender);
    assert.equal((await core.storage.exportEntries())[0].value.target, '你好');
    await services.configureAlignment({ enabled: true, remoteUrl: 'https://align.example/', token: 'fixture-align-token' });
    assert.equal((await vault.get('align')).token, 'fixture-align-token'); assert.equal(JSON.stringify(data).includes('fixture-align-token'), false);
    await services.configureAlignment({ enabled: true, token: '••••' }); assert.equal((await vault.get('align')).token, 'fixture-align-token');
    await services.configureAlignment({ enabled: true, token: '' }); assert.equal((await vault.get('align')).token, '');
    await services.configureAlignment({ enabled: true, token: 'second-fixture-token' });
    await services.configureAlignment({ enabled: true, remoteUrl: 'https://new-align.example/' }); assert.equal((await vault.get('align')).token, '');
    await services.configureAlignment({ enabled: false, remoteUrl: '' });
    assert.equal(services.capabilities().dictionary.ready, true); assert.equal(services.capabilities().alignment.model, 'Xenova/multilingual-e5-small');
    assert.equal(services.capabilities().media.ocr, false); assert.equal(services.sync.status().enabled, false);
  } finally { await services.dispose(); }
});
