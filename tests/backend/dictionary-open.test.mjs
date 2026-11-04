import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Dictionary } = require(path.join(path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled'), 'backend/dict/index.js'));
async function flush() { for (let index = 0; index < 20; index++) await Promise.resolve(); }
function fixture(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'), opens = [];
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() { const request = {}; opens.push(request); return request; } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'indexedDB', previous); else delete globalThis.indexedDB; });
  return opens;
}
function database(word = 'bank', translation = '银行') {
  const words = new Map([[word, { word, translation }]]), forms = new Map(), meta = new Map([['count', 1]]);
  return { closed: 0, close() { this.closed++; }, transaction(names) {
    const transaction = { oncomplete: undefined, onabort: undefined, onerror: undefined,
      objectStore(name) {
        const values = name === 'words' ? words : name === 'forms' ? forms : meta;
        return { clear() { values.clear(); }, put(value, key) { values.set(key ?? value.word, value); }, get(key) {
          const request = { result: values.get(key) }; queueMicrotask(() => request.onsuccess?.()); return request;
        } };
      } };
    if (Array.isArray(names)) queueMicrotask(() => transaction.oncomplete?.());
    return transaction;
  } };
}
const dictionary = () => new Dictionary({ fetch: async () => { throw new Error('已有词库不应访问网络'); } });
function success(request, value) { request.result = value; request.onsuccess(); }

for (const type of ['error', 'blocked']) test(`IndexedDB首次${type}后ready可重试，成功时清掉旧错误`, async (t) => {
  const opens = fixture(t), value = dictionary();
  const first = value.ready(), rejected = assert.rejects(first);
  if (type === 'error') { opens[0].error = new Error('first open failed'); opens[0].onerror(); }
  else opens[0].onblocked();
  await rejected; assert.equal(value.status().ready, false);
  const second = value.ready(); assert.equal(opens.length, 2);
  const fresh = database(); success(opens[1], fresh); await second;
  assert.equal(value.status().ready, true); assert.equal(value.status().error, undefined);
  assert.deepEqual((await value.lookup('bank')).translations, ['银行']);
  await value.dispose(); assert.equal(fresh.closed, 1);
});

test('blocked旧请求迟到success只关闭自己，不能覆盖或清除新连接', async (t) => {
  const opens = fixture(t), value = dictionary();
  const first = value.ready(), rejected = assert.rejects(first, /阻塞/); opens[0].onblocked(); await rejected;
  const second = value.ready(), old = database('old', '旧连接'), fresh = database('fresh', '新连接');
  success(opens[0], old); assert.equal(old.closed, 1);
  success(opens[1], fresh); await second;
  assert.deepEqual((await value.lookup('fresh')).translations, ['新连接']); assert.equal(opens.length, 2);
  await value.dispose(); assert.equal(fresh.closed, 1); assert.equal(old.closed, 1);
});

test('首次导入open失败后dispose不抛异常，后续显式导入能创建新连接', async (t) => {
  const opens = fixture(t), value = dictionary();
  const first = value.import([{ word: 'custom', translation: '第一份' }]), rejected = assert.rejects(first);
  await flush(); opens[0].error = new Error('disk unavailable'); opens[0].onerror(); await rejected;
  await value.dispose();
  const second = value.import([{ word: 'custom', translation: '第二份' }]); await flush();
  assert.equal(opens.length, 2); const fresh = database(); success(opens[1], fresh); await second;
  assert.deepEqual((await value.lookup('custom')).translations, ['第二份']); await value.dispose(); assert.equal(fresh.closed, 1);
});

test('dispose正在等待的open报错时仍可完成释放，之后ready可恢复', async (t) => {
  const opens = fixture(t), value = dictionary();
  const first = value.ready(), rejected = assert.rejects(first), disposing = value.dispose();
  opens[0].error = new Error('open failed during dispose'); opens[0].onerror();
  await Promise.all([rejected, disposing]);
  const retry = value.ready(), fresh = database(); assert.equal(opens.length, 2); success(opens[1], fresh); await retry;
  assert.equal(value.status().error, undefined); await value.dispose(); assert.equal(fresh.closed, 1);
});

test('dispose等待旧open时新导入可使用新代连接，旧迟到success不会关闭新代', async (t) => {
  const opens = fixture(t), value = dictionary();
  const first = value.ready(), rejected = assert.rejects(first, /状态已更新/);
  const disposing = value.dispose();
  const second = value.import([{ word: 'custom', translation: '新代词库' }]); await flush();
  assert.equal(opens.length, 2); const fresh = database(), old = database();
  success(opens[1], fresh); await second; success(opens[0], old); await Promise.all([rejected, disposing]);
  assert.equal(old.closed, 1); assert.equal(fresh.closed, 0);
  assert.deepEqual((await value.lookup('custom')).translations, ['新代词库']);
  await value.dispose(); assert.equal(fresh.closed, 1);
});
