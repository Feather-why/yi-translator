import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const build = process.env.BACKEND_BUILD_DIR || fileURLToPath(new URL('../.compiled/', import.meta.url));
const { SyncService } = require(build + '/backend/sync/index.js');
const { ChromeSyncStore } = require(build + '/backend/sync/chrome-store.js');
const { mergeDocuments, validateDocument } = require(build + '/backend/sync/merge.js');
const empty = () => ({ version: 1, fields: {}, usage: {} });
const rec = (value, updatedAt, deviceId, deleted = false) => ({ ...(deleted ? { deleted: true } : { value }), updatedAt, deviceId });
function area(initial = {}) {
  const data = structuredClone(initial);
  return { data, async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); }, async set(items) { Object.assign(data, structuredClone(items)); } };
}
function vault() { const data = {}; return { data, get: async (id) => structuredClone(data[id] || {}), set: async (id, value) => { data[id] = structuredClone(value); } }; }
function memoryStore(document = empty()) {
  let data = structuredClone(document); const exports = [], imports = [];
  return { exports, imports, get data() { return data; }, set data(value) { data = value; }, async export(secrets) { exports.push(secrets); const copy = structuredClone(data); if (!secrets) delete copy.secrets; return copy; }, async import(value) { imports.push(structuredClone(value)); data = { ...structuredClone(value), ...(value.secrets ? {} : data.secrets ? { secrets: data.secrets } : {}) }; } };
}
async function dav(t, options = {}) {
  let document = options.document, version = 1;
  const requests = []; let conflicts = options.conflicts || 0;
  const server = http.createServer(async (req, res) => {
    const body = await new Promise((resolve) => { let value = ''; req.on('data', (chunk) => value += chunk); req.on('end', () => resolve(value)); });
    requests.push({ method: req.method, headers: req.headers, body });
    if (req.headers.authorization !== 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64')) { res.writeHead(401).end(); return; }
    if (req.method === 'GET') {
      if (!document) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', ...(options.noEtag ? {} : { ETag: `"${version}"` }) }).end(JSON.stringify(document)); return;
    }
    if (req.method === 'PUT') {
      if (conflicts > 0) {
        conflicts--; document ||= empty(); document.fields.remoteDuringConflict = rec('remote-new', 9000, 'remote'); version++;
        res.writeHead(412).end(); return;
      }
      if ((!document && req.headers['if-none-match'] !== '*') || (document && req.headers['if-match'] !== `"${version}"`)) { res.writeHead(412).end(); return; }
      document = JSON.parse(body); version++; res.writeHead(201, { ETag: `"${version}"` }).end(); return;
    }
    res.writeHead(405).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/folder/`, requests, get document() { return document; } };
}
const configuration = (url, extra = {}) => ({ enabled: true, url, username: 'fixture-user', password: 'fixture-password', ...extra });
async function client(t, store, options = {}) {
  const storage = options.storage || area(), secrets = options.vault || vault(), scheduled = [];
  const service = new SyncService({ store, vault: secrets, storage, now: options.now || (() => 1000), schedule: (when) => scheduled.push(when), ...(options.fetch ? { fetch: options.fetch } : {}) });
  await service.ready(); t.after(() => service.dispose()); return { service, storage, vault: secrets, scheduled };
}

test('按字段LWW和墓碑收敛；同设备计数取max、不同设备累加且周期隔离', () => {
  const a = { version: 1, fields: { x: rec('old', 10, 'a'), remove: rec('old', 10, 'a'), tie: rec('a', 20, 'a') }, usage: { mt: { '100': { a: 4 }, '200': { a: 2 } } } };
  const b = { version: 1, fields: { x: rec('new', 20, 'b'), remove: rec(undefined, 30, 'b', true), tie: rec('b', 20, 'b') }, usage: { mt: { '100': { a: 5, b: 3 }, '200': { b: 1 } } } };
  const merged = mergeDocuments(a, b); assert.deepEqual(merged, mergeDocuments(b, a)); assert.equal(merged.fields.x.value, 'new');
  assert.equal(merged.fields.remove.deleted, true); assert.equal(merged.fields.tie.value, 'b'); assert.deepEqual(merged.usage.mt['100'], { a: 5, b: 3 });
  assert.deepEqual(merged.usage.mt['200'], { a: 2, b: 1 }); assert.deepEqual(mergeDocuments(merged, b), merged);
  for (const value of [{}, { version: 1, fields: { x: rec('x', -1, 'a') }, usage: {} }, { version: 1, fields: {}, usage: { x: { y: { z: -2 } } } }]) assert.throws(() => validateDocument(value));
  for (const value of [Infinity, () => undefined, JSON.parse('{"__proto__":{"polluted":true}}')]) assert.throws(() => validateDocument({ version: 1, fields: { x: rec(value, 10, 'a') }, usage: {} }));
});

test('默认关闭同步不发网络；启用后的计划防抖30秒并在重启后恢复', async (t) => {
  let now = 1000, fetches = 0;
  const first = await client(t, memoryStore(), { now: () => now, fetch: async () => { fetches++; throw new Error('unexpected'); } });
  await first.service.run(); assert.equal(fetches, 0);
  await first.service.configure(configuration('https://dav.example/folder/')); assert.equal(first.scheduled.at(-1), 601000);
  first.service.notifyChange(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(first.scheduled.at(-1), 31000);
  now = 5000; first.service.notifyChange(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(first.scheduled.at(-1), 31000);
  const restarted = await client(t, memoryStore(), { storage: first.storage, vault: first.vault, now: () => now }); assert.equal(restarted.scheduled.at(-1), 31000);
  await restarted.service.configure({ enabled: false, url: 'https://dav.example/folder/' }); assert.equal(restarted.scheduled.at(-1), undefined);
  assert.equal(JSON.stringify(first.storage.data).includes('fixture-password'), false);
});

test('两设备经真实WebDAV同步设置和用量，重复同步不把同设备用量相加且默认不上传密钥', async (t) => {
  const remote = await dav(t);
  const a = memoryStore({ version: 1, fields: { 'settings.ui:/targetLang': rec('zh-CN', 10, 'a') }, usage: { mt: { '20000': { a: 7 } } }, secrets: { mt: { key: 'fixture-secret-never-upload' } } });
  const b = memoryStore({ version: 1, fields: { 'settings.ui:/mode': rec('fast', 20, 'b') }, usage: { mt: { '20000': { b: 5 } } } });
  const ca = await client(t, a), cb = await client(t, b);
  await ca.service.configure(configuration(remote.url)); await cb.service.configure(configuration(remote.url));
  assert.equal((await ca.service.run()).lastError, undefined); assert.equal((await cb.service.run()).lastError, undefined); await ca.service.run();
  assert.equal(a.data.fields['settings.ui:/mode'].value, 'fast'); assert.equal(b.data.fields['settings.ui:/targetLang'].value, 'zh-CN');
  assert.deepEqual(remote.document.usage.mt['20000'], { a: 7, b: 5 }); assert.equal(remote.document.secrets, undefined);
  assert.ok(a.exports.every((value) => value === false)); assert.ok(remote.requests.every((entry) => !entry.body.includes('fixture-secret-never-upload') && !entry.headers.cookie));
});

test('ETag冲突重新拉取合并保留远端修改，最多重试三次且缺少ETag不覆盖远端', async (t) => {
  const remote = await dav(t, { conflicts: 1 }); const store = memoryStore({ version: 1, fields: { local: rec('local', 100, 'a') }, usage: {} });
  const { service } = await client(t, store); await service.configure(configuration(remote.url)); assert.equal((await service.run()).lastError, undefined);
  assert.equal(remote.document.fields.remoteDuringConflict.value, 'remote-new'); assert.equal(remote.document.fields.local.value, 'local');
  assert.equal(remote.requests.filter((r) => r.method === 'PUT').length, 2);
  const failing = await dav(t, { conflicts: 9 }); const failedStore = memoryStore(); const f = await client(t, failedStore);
  await f.service.configure(configuration(failing.url)); assert.ok((await f.service.run()).lastError); assert.equal(failing.requests.filter((r) => r.method === 'PUT').length, 3); assert.equal(failedStore.imports.length, 0);
  const noEtag = await dav(t, { document: empty(), noEtag: true }); const n = await client(t, memoryStore()); await n.service.configure(configuration(noEtag.url));
  assert.ok((await n.service.run()).lastError); assert.equal(noEtag.requests.filter((r) => r.method === 'PUT').length, 0);
});

test('显式开启密钥同步只上传密文，另一设备解密并按字段时间戳收敛', async (t) => {
  const remote = await dav(t);
  const a = memoryStore({ ...empty(), secrets: { mt: { key: 'fixture-key-a' } } }), b = memoryStore({ ...empty(), secrets: { mt: { key: 'fixture-key-b' } } });
  const ca = await client(t, a, { now: () => 1000 }), cb = await client(t, b, { now: () => 2000 });
  await ca.service.configure(configuration(remote.url, { syncSecrets: true, passphrase: 'shared-fixture-passphrase' }));
  await cb.service.configure(configuration(remote.url, { syncSecrets: true, passphrase: 'shared-fixture-passphrase' }));
  assert.equal((await ca.service.run()).lastError, undefined); assert.equal((await cb.service.run()).lastError, undefined); assert.equal((await ca.service.run()).lastError, undefined);
  assert.equal(a.data.secrets.mt.key, 'fixture-key-b'); assert.equal(b.data.secrets.mt.key, 'fixture-key-b');
  const body = JSON.stringify(remote.document); assert.ok(remote.document.encryptedSecrets); assert.equal(body.includes('fixture-key-'), false);
  assert.equal(JSON.stringify(ca.storage.data).includes('shared-fixture-passphrase'), false);
});

test('不启用密钥同步的设备保留远端加密包，拒绝远端明文密钥文件', async (t) => {
  const opaque = { version: 1, kdf: 'PBKDF2-SHA256', iterations: 600000, salt: 'opaque', iv: 'opaque', ciphertext: 'opaque' };
  const remote = await dav(t, { document: { ...empty(), encryptedSecrets: opaque } }); const store = memoryStore(); const { service } = await client(t, store);
  await service.configure(configuration(remote.url)); assert.equal((await service.run()).lastError, undefined); assert.deepEqual(remote.document.encryptedSecrets, opaque); assert.equal(store.data.secrets, undefined);
  const plaintext = await dav(t, { document: { ...empty(), secrets: { mt: { key: 'must-reject' } } } });
  const denied = await client(t, memoryStore()); await denied.service.configure(configuration(plaintext.url)); assert.ok((await denied.service.run()).lastError);
  assert.equal(plaintext.requests.filter((r) => r.method === 'PUT').length, 0);
});

test('同步请求统一omit/禁止重定向，改origin不沿用旧认证，关闭时中止在途请求', async (t) => {
  const observed = [];
  const c = await client(t, memoryStore(), { fetch: async (url, init) => { observed.push({ url, ...init }); return init.method === 'PUT' ? new Response('', { status: 201 }) : new Response('', { status: 404 }); } });
  await c.service.configure(configuration('https://first.example/')); await c.service.run();
  assert.ok(observed[0].headers.Authorization); assert.ok(observed.every((entry) => entry.credentials === 'omit' && entry.redirect === 'error'));
  observed.length = 0; await c.service.configure({ enabled: true, url: 'https://second.example/' }); await c.service.run(); assert.equal(observed[0].headers.Authorization, undefined);
  await assert.rejects(c.service.configure(configuration('http://remote.example/')));
  let connected; const began = new Promise((resolve) => connected = resolve); let signal;
  const d = await client(t, memoryStore(), { fetch: async (_url, init) => { signal = init.signal; connected(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
  await d.service.configure(configuration('https://first.example/')); const pending = d.service.run(); await began;
  await d.service.configure({ enabled: false, url: 'https://first.example/' }); await pending; assert.equal(signal.aborted, true); assert.equal(d.service.status().enabled, false); assert.equal(d.scheduled.at(-1), undefined);
});

test('ChromeSyncStore逐字段追踪设置/规则/TM墓碑，导入时保留网络期间的新本地修改', async () => {
  let now = 1000;
  const local = area({ 'settings.ui': { version: 1, mode: 'fast', ball: { side: 'right', y: 0.5 } }, 'settings.core': { version: 1, allowUnofficial: false },
    'backend.rules': { version: 1, local: [{ id: 'r1', match: ['https://example.test/*'], source: 'local' }], subscriptions: [] } });
  let entries = [{ key: 'tm1', updatedAt: 800, value: { source: 'Hello', target: '你好', sourceLang: 'en', targetLang: 'zh' } }];
  const tm = { exportEntries: async () => structuredClone(entries), importEntries: async (incoming) => { for (const entry of incoming) entries = [...entries.filter((old) => old.key !== entry.key), entry]; } };
  const store = new ChromeSyncStore({ storage: local, now: () => now, deviceId: 'a', tm }); await store.ready();
  const first = await store.export(); assert.equal(first.fields['settings.ui:/ball/side'].value, 'right'); assert.equal(first.fields['tm:tm1'].value.target, '你好');
  now = 2000; local.data['settings.ui'].mode = 'accurate'; delete local.data['settings.ui'].ball.y; local.data['backend.rules'].local = []; entries = [];
  const changed = await store.export(); assert.equal(changed.fields['settings.ui:/mode'].updatedAt, 2000); assert.equal(changed.fields['settings.ui:/ball/y'].deleted, true);
  assert.equal(changed.fields['rule:r1'].deleted, true); assert.equal(changed.fields['tm:tm1'].deleted, true);
  now = 4000; local.data['settings.ui'].mode = 'combined';
  await store.import({ version: 1, fields: { 'settings.ui:/mode': rec('fast', 3000, 'b'), 'settings.ui:/targetLang': rec('zh-CN', 3000, 'b') }, usage: {} });
  assert.equal(local.data['settings.ui'].mode, 'combined'); assert.equal(local.data['settings.ui'].targetLang, 'zh-CN');
});

test('ChromeSyncStore周期用量跨设备取max与求和，旧周期不计入新周期；密钥仅显式请求才导出', async () => {
  const local = area({ 'backend.usage': { mt: { resetAt: 20000, devices: { a: 4 }, used: 4 } } }); const secrets = vault(); await secrets.set('mt', { key: 'fixture-local-key' });
  const store = new ChromeSyncStore({ storage: local, deviceId: 'a', now: () => 1000, vault: secrets, providerIds: ['mt', 'sync'] }); await store.ready();
  assert.equal((await store.export()).secrets, undefined); assert.equal((await store.export(true)).secrets.mt.key, 'fixture-local-key');
  await store.import({ version: 1, fields: {}, usage: { mt: { '10000': { c: 900 }, '20000': { a: 3, b: 6 } } } });
  assert.deepEqual(local.data['backend.usage'].mt, { resetAt: 20000, devices: { a: 4, b: 6 }, used: 10 });
  await store.import({ version: 1, fields: {}, usage: { mt: { '10000': { c: 999 } } } }); assert.equal(local.data['backend.usage'].mt.used, 10);
  assert.equal(JSON.stringify(local.data).includes('fixture-local-key'), false);
});

test('ChromeSyncStore用量导入交账本合并，保留尚未落盘的本机计数并不再直接覆盖', async () => {
  const incoming = { version: 1, fields: {}, usage: { mt: { '20000': { a: 3, b: 6 } } } };
  const initial = { 'backend.usage': { mt: { resetAt: 20000, devices: { a: 4 }, used: 4 } } };
  const direct = area(initial), directStore = new ChromeSyncStore({ storage: direct, deviceId: 'a', now: () => 1000 });
  await directStore.import(incoming);
  assert.deepEqual(direct.data['backend.usage'].mt, { resetAt: 20000, devices: { a: 4, b: 6 }, used: 10 });

  const local = area(initial), writes = [], save = local.set;
  local.set = async (updates) => { writes.push(structuredClone(updates)); await save(updates); };
  // 翻译已在内存增加到 7，但上一个持久化任务仍只让存储可见 4。
  const liveLedger = { mt: { resetAt: 20000, devices: { a: 7 }, used: 7 } };
  let imported;
  const store = new ChromeSyncStore({ storage: local, deviceId: 'a', now: () => 1000, onUsageImported: async (counters) => {
    imported = structuredClone(counters);
    const devices = { ...counters.mt.devices };
    for (const [id, count] of Object.entries(liveLedger.mt.devices)) devices[id] = Math.max(devices[id] || 0, count);
    liveLedger.mt = { resetAt: counters.mt.resetAt, devices, used: Object.values(devices).reduce((sum, count) => sum + count, 0) };
    await local.set({ 'backend.usage': liveLedger });
  } });
  await store.import(incoming);
  assert.deepEqual(imported.mt, { resetAt: 20000, devices: { a: 4, b: 6 }, used: 10 });
  assert.deepEqual(local.data['backend.usage'].mt, { resetAt: 20000, devices: { a: 7, b: 6 }, used: 13 });
  assert.equal(writes.filter((update) => Object.hasOwn(update, 'backend.usage')).length, 1);
  assert.equal(Object.hasOwn(writes.at(-1), 'backend.usage'), false);
  assert.deepEqual((await store.export()).usage.mt['20000'], { a: 7, b: 6 });
});

test('跨多年用量合并只保留最新400周期，不使元数据无界增长', () => {
  const first = empty(), second = empty(); first.usage.mt = {}; second.usage.mt = {};
  for (let n = 0; n < 400; n++) first.usage.mt[String(n)] = { a: 1 };
  for (let n = 400; n < 800; n++) second.usage.mt[String(n)] = { b: 2 };
  const merged = mergeDocuments(first, second); assert.equal(Object.keys(merged.usage.mt).length, 400); assert.equal(merged.usage.mt['399'], undefined);
  assert.deepEqual(merged.usage.mt['799'], { b: 2 }); assert.doesNotThrow(() => validateDocument(merged));
});

test('更换WebDAV地址中止旧请求，即便fetch忽略abort也不向新origin泄漏旧认证', async (t) => {
  let resolveRequest, begin; const began = new Promise((resolve) => begin = resolve), requests = [];
  const c = await client(t, memoryStore(), { fetch: async (url, init) => { requests.push({ url, headers: init.headers }); begin(); return new Promise((resolve) => resolveRequest = resolve); } });
  await c.service.configure(configuration('https://first.example/')); const pending = c.service.run(); await began;
  await c.service.configure({ enabled: true, url: 'https://second.example/' }); resolveRequest(new Response('', { status: 404 })); await pending;
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://first.example/translate-state-v1.json'); assert.equal(c.service.status().url, 'https://second.example/translate-state-v1.json');
});
