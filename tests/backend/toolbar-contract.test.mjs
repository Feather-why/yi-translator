import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const { BackendCore } = require(path.join(build, 'backend/core.js'));
const { BackendStorage } = require(path.join(build, 'backend/storage.js'));
const { SecretVault } = require(path.join(build, 'backend/secrets.js'));
const { classifyError } = require(path.join(build, 'backend/providers/types.js'));
const { registerRpc } = require(path.join(build, 'backend/rpc.js'));

const id = 'toolbar-contract-extension';
const content = { id, url: 'https://example.test/article', tab: { id: 1, url: 'https://example.test/article' } };
const source = 'Visit <g4>the <g9>official guide</g9> and <x3/></g4> before <x8/>.';
const corrected = '请先查看<x8/>，再访问<g4><g9>官方指南</g9>与<x3/></g4>。';
const memoryRequest = (target = corrected) => ({ source, target, sourceLang: 'auto', targetLang: 'zh-CN' });

function area(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.map((key) => [key, structuredClone(data[key])]));
    },
    async set(items) { Object.assign(data, structuredClone(items)); },
  };
}

class ObservedStorage extends BackendStorage {
  accesses = [];
  constructor() { super({ memory: true }); }
  async tmGet(...args) { this.accesses.push('tmGet'); return super.tmGet(...args); }
  async tmPut(...args) { this.accesses.push('tmPut'); return super.tmPut(...args); }
  async cacheGet(...args) { this.accesses.push('cacheGet'); return super.cacheGet(...args); }
  async cachePut(...args) { this.accesses.push('cachePut'); return super.cachePut(...args); }
}

async function setup(t) {
  const calls = [], listeners = new Set(), local = area(), storage = new ObservedStorage();
  globalThis.chrome = {
    runtime: { id, getURL: (value) => `chrome-extension://${id}/${value}`,
      onMessage: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) } },
    storage: { local },
  };
  const vault = new SecretVault({ memory: true, storage: local });
  const providers = ['first', 'alternate'].map((name) => ({
    id: name, name, version: '1.0.0', kind: 'mt', official: true, usedFor: ['fast', 'accurate', 'combined'],
    auth: [], limits: { maxChars: 10_000, maxSegments: 20, concurrency: 2 }, placeholders: 'prompt', classifyError,
    async translate(request) {
      calls.push({ provider: name, texts: [...request.texts] });
      return request.texts.map((text) => `${name}译文：${text}`);
    },
  }));
  const coreOptions = { providers, storage, vault };
  const core = new BackendCore(coreOptions);
  await core.ready();
  let syncNotifications = 0;
  const unregister = registerRpc(core, { sync: { notifyChange: () => { syncNotifications++; } } });
  t.after(unregister);
  const [listener] = listeners;
  const rpc = (name, payload, sender = content) => new Promise((resolve) => {
    assert.equal(listener({ rpc: name, payload }, sender, resolve), true);
  });
  return { core, coreOptions, calls, local, storage, rpc, syncNotifications: () => syncNotifications };
}

function job(text, options = {}) {
  return { jobId: crypto.randomUUID(), sourceLang: 'auto', targetLang: 'zh-CN', mode: 'accurate', priority: 1,
    context: { url: content.url }, segments: [{ id: 'paragraph', kind: 'paragraph', text }], ...options };
}
const translate = (core, request, segment = request.segments[0]) => core.translate(request, segment,
  request.mode === 'fast' ? 'fast' : 'accurate', new AbortController().signal);
const storedMemory = (storage, text = source) => BackendStorage.prototype.tmGet.call(storage, 'auto', 'zh-CN', text);

test('工具条修改译文：丢失、错号、多余与嵌套变化通过真实RPC返回bad_input，不能覆盖TM或触发同步', async (t) => {
  const { storage, rpc, syncNotifications } = await setup(t);
  await storage.tmPut('auto', 'zh-CN', source, corrected);
  storage.accesses.length = 0;
  const invalid = [
    ['丢失内层g', corrected.replace('<g9>', '').replace('</g9>', '')],
    ['g编号被改写', corrected.replaceAll('g9', 'g10')],
    ['丢失x', corrected.replace('<x3/>', '')],
    ['x编号被改写', corrected.replace('<x8/>', '<x80/>')],
    ['重复x', corrected.replace('<x3/>', '<x3/><x3/>')],
    ['交叉闭合', corrected.replace('</g9>与<x3/></g4>', '</g4>与<x3/></g9>')],
    ['平衡但改变g父子关系', '请查看<x8/>、<g9>官方指南</g9>与<g4><x3/></g4>。'],
    ['平衡但把x移到父节点外', '请查看<x8/>、<g4><g9>官方指南</g9></g4>与<x3/>。'],
  ];
  for (const [reason, target] of invalid) {
    const response = await rpc('tm:save', memoryRequest(target));
    assert.equal(response.ok, false, reason);
    assert.equal(response.error.code, 'bad_input', reason);
    assert.equal(response.error.retryable, false, reason);
    assert.equal((await storedMemory(storage)).text, corrected, reason);
  }
  assert.equal(storage.accesses.includes('tmPut'), false, '无效修订不能写入译文记忆');
  assert.equal(storage.accesses.includes('cachePut'), false, '无效修订不能写入译文缓存');
  assert.equal(syncNotifications(), 0, '拒绝保存后不能安排同步');
  assert.equal((await storage.exportEntries()).length, 1);
});

test('工具条保存成功：保留非连续编号与嵌套，新的Core普通任务优先命中用户记忆', async (t) => {
  const { coreOptions, calls, storage, rpc, syncNotifications } = await setup(t);
  await storage.cachePut('auto', 'zh-CN', 'accurate', source, { text: `旧机翻：${source}`, provider: 'first', version: '1.0.0' });
  assert.deepEqual(await rpc('tm:save', memoryRequest()), { ok: true, data: { ok: true } });
  assert.equal(syncNotifications(), 1);
  assert.deepEqual(await storedMemory(storage), { text: corrected, provider: 'memory' });

  // 换新实例避免只检验当前任务中的临时状态；沿用真实存储，不模拟TM返回值。
  const restarted = new BackendCore(coreOptions);
  await restarted.ready();
  for (const mode of ['fast', 'accurate', 'combined']) {
    const result = await translate(restarted, job(source, { mode }));
    assert.equal(result.text, corrected);
    assert.equal(result.provider, 'memory');
    assert.equal(result.cached, true);
    assert.equal(result.finalOnly, mode === 'combined' ? true : undefined);
  }
  assert.deepEqual(calls, [], '普通任务命中用户记忆后不得再请求翻译服务');
});

test('工具条保存仍按真实sender保护敏感站点和隐身页，不能覆盖既有记忆', async (t) => {
  const { storage, rpc, syncNotifications } = await setup(t);
  await storage.tmPut('auto', 'zh-CN', source, corrected);
  storage.accesses.length = 0;
  const senders = [
    { ...content, tab: { ...content.tab, incognito: true } },
    { ...content, url: 'https://mail.google.com/mail/u/0/', tab: { ...content.tab, url: 'https://mail.google.com/mail/u/0/' } },
    { id, tab: { id: 2, url: 'https://outlook.office.com/mail/' } },
    { ...content, url: 'http://wiki.internal/article', tab: { ...content.tab, url: 'http://wiki.internal/article' } },
  ];
  for (const sender of senders) {
    const response = await rpc('tm:save', memoryRequest(corrected.replace('官方指南', '新的敏感内容')), sender);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'bad_input');
    assert.equal((await storedMemory(storage)).text, corrected);
  }
  assert.equal(storage.accesses.includes('tmPut'), false);
  assert.equal(storage.accesses.includes('cachePut'), false);
  assert.equal(syncNotifications(), 0);
});

test('工具条换一家：hint只属于本次任务，不能替换原页面sticky或改写置顶配置', async (t) => {
  const { core, calls, local } = await setup(t);
  await core.save('first', true, {});
  await core.save('alternate', true, {});
  assert.equal((await translate(core, job('Establish the ordinary page provider.'))).provider, 'first');
  const beforeConfig = structuredClone(local.data['backend.providers']);
  const pinned = () => Object.fromEntries(core.snapshot().providers.map((provider) => [provider.id, provider.pinned]));
  const beforePinned = pinned();
  const hinted = job('Use another provider once.', { noCache: true, providerHint: 'alternate', segments: [
    { id: 'one', kind: 'paragraph', text: 'Use another provider once.' },
    { id: 'two', kind: 'paragraph', text: 'The same task may contain a second segment.' },
  ] });
  for (const segment of hinted.segments) assert.equal((await translate(core, hinted, segment)).provider, 'alternate');

  assert.deepEqual(pinned(), beforePinned);
  assert.deepEqual(local.data['backend.providers'], beforeConfig);
  assert.equal((await translate(core, job('A later ordinary paragraph on the same page.'))).provider, 'first');
  assert.equal((await translate(core, job(hinted.segments[0].text))).provider, 'first', '后续任务不继承上次的hint或重翻结果');
  assert.deepEqual(calls.map((call) => call.provider), ['first', 'alternate', 'alternate', 'first', 'first']);
});

test('工具条noCache重翻不自动落盘，普通页面随后明确保存人工修订可独立写入TM', async (t) => {
  const { core, storage, rpc, syncNotifications } = await setup(t);
  const text = 'A private retry keeps the saved correction and cache intact.';
  await storage.tmPut('auto', 'zh-CN', text, '原有人工修订');
  await storage.cachePut('auto', 'zh-CN', 'accurate', text, { text: '原有机翻缓存', provider: 'first', version: '1.0.0' });
  storage.accesses.length = 0;
  const retried = await translate(core, job(text, { noCache: true, providerHint: 'alternate' }));
  assert.equal(retried.provider, 'alternate');
  assert.equal(retried.cached, false);
  assert.equal(retried.text, `alternate译文：${text}`);
  assert.deepEqual(storage.accesses, [], 'noCache不读写TM或译文缓存');
  assert.deepEqual(await storedMemory(storage, text), { text: '原有人工修订', provider: 'memory' });
  assert.deepEqual(await BackendStorage.prototype.cacheGet.call(storage, 'auto', 'zh-CN', 'accurate', text),
    { text: '原有机翻缓存', provider: 'first', version: '1.0.0' });
  assert.deepEqual(storage.accesses, [], '观察旧记录不能掩盖重翻期间的隐式读写');
  const saved = await rpc('tm:save', { source: text, target: '用户在重翻后明确保存的新修订', sourceLang: 'auto', targetLang: 'zh-CN' });
  assert.deepEqual(saved, { ok: true, data: { ok: true } });
  assert.deepEqual(storage.accesses, ['tmPut'], '明确保存只写入用户记忆，不回填自动缓存');
  assert.equal(syncNotifications(), 1);
  assert.deepEqual(await BackendStorage.prototype.cacheGet.call(storage, 'auto', 'zh-CN', 'accurate', text),
    { text: '原有机翻缓存', provider: 'first', version: '1.0.0' });
  assert.equal((await translate(core, job(text))).text, '用户在重翻后明确保存的新修订');
});
