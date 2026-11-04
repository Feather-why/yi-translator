import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const { BackendStorage } = require(path.join(build, 'backend/storage.js'));
const { SecretVault, SECRETS_STORAGE_KEY } = require(path.join(build, 'backend/secrets.js'));

test('缓存严格区分语言、档位和含分隔符的文本，并保留真实服务来源', async () => {
  const storage = new BackendStorage({ memory: true });
  await storage.ready();
  await storage.cachePut('en', 'zh-CN', 'fast', 'Hello|world', { text: '你好世界', provider: 'microsoft', version: '1.0.0' });
  const cached = await storage.cacheGet('en', 'zh-CN', 'fast', 'Hello|world');
  assert.deepEqual(cached, { text: '你好世界', provider: 'microsoft', version: '1.0.0' });
  assert.equal(await storage.cacheGet('en', 'ja', 'fast', 'Hello|world'), undefined);
  assert.equal(await storage.cacheGet('en', 'zh-CN', 'accurate', 'Hello|world'), undefined);
  assert.equal(await storage.cacheGet('auto', 'zh-CN', 'fast', 'Hello|world'), undefined);
  assert.equal(await storage.cacheGet('en|zh-CN', 'fast', 'fast', 'Hello|world'), undefined);
  cached.text = '被调用方改写';
  assert.equal((await storage.cacheGet('en', 'zh-CN', 'fast', 'Hello|world')).text, '你好世界');
});

test('缓存达到容量时淘汰最久未访问条目，更新同一条不会重复累计容量', async () => {
  const storage = new BackendStorage({ memory: true, maxBytes: 340 });
  const put = (source, output) => storage.cachePut('en', 'zh', 'fast', source, { text: output, provider: 'test' });
  await put('one', 'a'.repeat(25));
  await put('two', 'b'.repeat(25));
  await storage.cacheGet('en', 'zh', 'fast', 'one');
  await put('three', 'c'.repeat(25));
  assert.equal(await storage.cacheGet('en', 'zh', 'fast', 'two'), undefined);
  assert.equal((await storage.cacheGet('en', 'zh', 'fast', 'one')).text, 'a'.repeat(25));
  assert.equal((await storage.cacheGet('en', 'zh', 'fast', 'three')).text, 'c'.repeat(25));
  await put('one', 'd'.repeat(25));
  assert.equal((await storage.cacheGet('en', 'zh', 'fast', 'three')).text, 'c'.repeat(25));
  await put('huge', 'x'.repeat(1000));
  assert.equal(await storage.cacheGet('en', 'zh', 'fast', 'huge'), undefined);
});

test('用户译文记忆和自动翻译缓存分开，语言对互不污染', async () => {
  const storage = new BackendStorage({ memory: true });
  await storage.tmPut('en', 'zh', 'Hello', '您好');
  assert.deepEqual(await storage.tmGet('en', 'zh', 'Hello'), { text: '您好', provider: 'memory' });
  assert.equal(await storage.tmGet('en', 'ja', 'Hello'), undefined);
  assert.equal(await storage.cacheGet('en', 'zh', 'fast', 'Hello'), undefined);
});

test('同步译文记忆拒绝损坏的占位符，整批验证后才写入', async () => {
  const storage = new BackendStorage({ memory: true });
  const entry = (source, target) => ({
    key: createHash('sha256').update(JSON.stringify(['memory', 'en', 'zh', source])).digest('hex'),
    updatedAt: 100,
    value: { sourceLang: 'en', targetLang: 'zh', source, target },
  });
  const good = entry('Hello', '你好');
  const missing = entry('<g0>World</g0><x0/>', '<g0>世界</g0>');
  await assert.rejects(storage.importEntries([good, missing]), /占位符不匹配/);
  assert.equal(await storage.tmGet('en', 'zh', 'Hello'), undefined);
  const nested = entry('<g0><g1>World</g1></g0>', '<g1><g0>世界</g0></g1>');
  await assert.rejects(storage.importEntries([nested]), /占位符不匹配/);
  const valid = entry('<g0>World</g0><x0/>', '<g0>世界</g0><x0/>');
  await storage.importEntries([good, valid]);
  assert.equal((await storage.tmGet('en', 'zh', valid.value.source)).text, valid.value.target);
});

function area() {
  const data = {};
  return {
    data,
    get: async (key) => ({ [key]: structuredClone(data[key]) }),
    set: async (items) => { Object.assign(data, structuredClone(items)); },
  };
}

test('服务密钥仅以随机 IV 的 AES-GCM 密文进入独立本机存储', async () => {
  const storage = area();
  const vault = new SecretVault({ memory: true, storage });
  await vault.ready();
  await vault.set('microsoft', { key: 'test-secret-never-return-plain' });
  assert.deepEqual(await vault.get('microsoft'), { key: 'test-secret-never-return-plain' });
  assert.equal(JSON.stringify(storage.data).includes('test-secret-never-return-plain'), false);
  assert.deepEqual(Object.keys(storage.data), [SECRETS_STORAGE_KEY]);
  const first = structuredClone(storage.data[SECRETS_STORAGE_KEY].microsoft);
  await vault.set('microsoft', { key: 'test-secret-never-return-plain' });
  assert.notEqual(storage.data[SECRETS_STORAGE_KEY].microsoft.iv, first.iv);
  const restarted = new SecretVault({ memory: true, storage });
  assert.deepEqual(await restarted.get('microsoft'), { key: 'test-secret-never-return-plain' });
  assert.deepEqual(await vault.get('unknown'), {});
});

test('密钥并发保存不覆盖其他服务，密文不能移植给另一服务', async () => {
  const storage = area();
  const vault = new SecretVault({ memory: true, storage });
  await Promise.all([vault.set('first', { key: 'alpha' }), vault.set('second', { key: 'beta' })]);
  assert.deepEqual(await vault.get('first'), { key: 'alpha' });
  assert.deepEqual(await vault.get('second'), { key: 'beta' });
  storage.data[SECRETS_STORAGE_KEY].second = storage.data[SECRETS_STORAGE_KEY].first;
  await assert.rejects(vault.get('second'), /无法解密/);
});

test('损坏的密文显式失败，不退回明文或假装未配置', async () => {
  const storage = area();
  const vault = new SecretVault({ memory: true, storage });
  await vault.set('first', { key: 'alpha' });
  storage.data[SECRETS_STORAGE_KEY].first.data = 'broken';
  await assert.rejects(vault.get('first'), /无法解密/);
});

test('删除自定义服务密钥与在途保存串行，实际移除密文且保留其他服务', async () => {
  const storage = area();
  const vault = new SecretVault({ memory: true, storage });
  await Promise.all([vault.set('custom-one', { key: 'alpha' }), vault.set('retained', { key: 'beta' }), vault.remove('custom-one')]);
  assert.equal(Object.hasOwn(storage.data[SECRETS_STORAGE_KEY], 'custom-one'), false);
  assert.deepEqual(await vault.get('custom-one'), {});
  assert.deepEqual(await vault.get('retained'), { key: 'beta' });
  assert.deepEqual(await new SecretVault({ memory: true, storage }).get('custom-one'), {});
});

test('生产存储缺少 IndexedDB 时不会默默丢弃持久化数据', { skip: typeof indexedDB !== 'undefined' }, async () => {
  await assert.rejects(new BackendStorage().ready(), /IndexedDB/);
});
