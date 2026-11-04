import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const build = path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled');
const { Dictionary } = require(path.join(build, 'backend/dict/index.js'));
const { AlignmentService } = require(path.join(build, 'backend/align/index.js'));
const { wordTokens } = require(path.join(build, 'backend/align/algorithm.js'));
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
const packed = () => new Response(gzipSync(JSON.stringify({ entries: [['bundled', '', '内置词']] })));
const pair = { id: 'dictionary', source: 'A bank.', target: '银行与河岸。', sourceLang: 'en', targetLang: 'zh-CN' };
const raw = (pair) => ({ id: pair.id, srcTokens: wordTokens(pair.source, pair.sourceLang), tgtTokens: wordTokens(pair.target, pair.targetLang), links: [] });
const links = (result) => result.links.filter(([source]) => pair.source.slice(...result.srcTokens[source]) === 'bank').map(([, target]) => pair.target.slice(...result.tgtTokens[target]));

test('首次内置初始化迟到不能覆盖已经成功的显式导入', async () => {
  const gate = deferred();
  const dictionary = new Dictionary({ memory: true, sourceUrl: 'https://fixture.invalid/dict.gz', fetch: async () => gate.promise });
  const startup = dictionary.ready();
  await dictionary.importCsv('word,translation\ncustom,用户导入词\n');
  const revision = dictionary.status().revision;
  gate.resolve(packed()); await startup;
  assert.deepEqual((await dictionary.lookup('custom')).translations, ['用户导入词']);
  assert.equal(await dictionary.lookup('bundled'), null); assert.equal(dictionary.status().revision, revision);
  await dictionary.dispose();
});

test('旧初始化失败不清空成功导入后的ready或错误状态', async () => {
  const gate = deferred();
  const dictionary = new Dictionary({ memory: true, sourceUrl: 'https://fixture.invalid/dict.gz', fetch: async () => gate.promise });
  const startup = dictionary.ready(), rejected = assert.rejects(startup, /资源不可用/);
  await dictionary.import([{ word: 'custom', translation: '已导入' }]);
  gate.resolve(new Response('', { status: 500 })); await rejected;
  assert.equal(dictionary.status().ready, true); assert.equal(dictionary.status().error, undefined);
  assert.deepEqual((await dictionary.lookup('custom')).translations, ['已导入']); await dictionary.dispose();
});

test('并发显式替换按提交顺序生效，相同条数仍递增修订，坏数据不改变词库', async () => {
  const dictionary = new Dictionary({ memory: true });
  const first = dictionary.import([{ word: 'bank', translation: '银行' }]);
  const last = dictionary.import([{ word: 'bank', translation: '河岸' }]);
  assert.deepEqual(await Promise.all([first, last]), [{ count: 1 }, { count: 1 }]);
  assert.equal(dictionary.status().revision, 2); assert.deepEqual((await dictionary.lookup('bank')).translations, ['河岸']);
  await assert.rejects(dictionary.import([{ word: 'bad' }]), /无效/);
  assert.equal(dictionary.status().revision, 2); assert.deepEqual((await dictionary.lookup('bank')).translations, ['河岸']);
  await dictionary.dispose();
});

test('替换期间已经开始的异步查询不能在新词库recent缓存写回旧答案', async () => {
  const dictionary = new Dictionary({ memory: true, entries: [{ word: 'bank', translation: '银行' }] });
  await dictionary.ready();
  const reading = dictionary.lookup('bank'); const replacing = dictionary.import([{ word: 'bank', translation: '河岸' }]);
  await Promise.all([reading, replacing]);
  assert.deepEqual((await dictionary.lookup('bank')).translations, ['河岸']); await dictionary.dispose();
});

test('dispose之后迟到bootstrap不重新发布词库，也不覆盖之后的人工导入', async () => {
  const gate = deferred();
  const dictionary = new Dictionary({ memory: true, sourceUrl: 'https://fixture.invalid/dict.gz', fetch: async () => gate.promise });
  const startup = dictionary.ready(); await dictionary.dispose();
  await dictionary.import([{ word: 'custom', translation: '新一代导入' }]); gate.resolve(packed()); await startup;
  assert.deepEqual((await dictionary.lookup('custom')).translations, ['新一代导入']); assert.equal(await dictionary.lookup('bundled'), null);
  await dictionary.dispose();
});

test('相同条数重导自动隔离普通、严格投影和noCache结果，无需重载对齐模型', async () => {
  const dictionary = new Dictionary({ memory: true, entries: [{ word: 'bank', translation: '银行' }] }); await dictionary.ready();
  let calls = 0, initialized = 0;
  const service = new AlignmentService({ dictionary, initialize: async () => { initialized++; }, infer: async (pairs) => { calls++; return pairs.map(raw); } });
  assert.deepEqual(links((await service.get([pair], { waitForModel: true }))[0]), ['银行']);
  assert.deepEqual(links(await service.projection(pair, 500, { noCache: false })), ['银行']);
  await dictionary.import([{ word: 'bank', translation: '河岸' }]);
  assert.deepEqual(links((await service.get([pair], { waitForModel: true }))[0]), ['河岸']);
  assert.deepEqual(links(await service.projection(pair, 500, { noCache: false })), ['河岸']);
  assert.equal(calls, 2); assert.equal(initialized, 1);
  const cached = service.status().cached;
  assert.deepEqual(links((await service.get([pair], { waitForModel: true, noCache: true }))[0]), ['河岸']);
  assert.equal(calls, 3); assert.equal(service.status().cached, cached);
  await dictionary.import([]); assert.deepEqual(links((await service.get([pair], { waitForModel: true }))[0]), []);
  service.dispose(); await dictionary.dispose();
});

test('精修中发生词典修订时拒绝旧结果，不写普通或严格缓存且下一请求用新释义', async () => {
  const gate = deferred(), started = deferred(); let revision = 1, meaning = '银行', calls = 0;
  const dictionary = { status: () => ({ ready: true, revision }), lookup: async (word) => {
    if (word.toLowerCase() !== 'bank') return null;
    const captured = meaning; started.resolve(); if (revision === 1) await gate.promise;
    return { word, source: 'ecdict', translations: [captured] };
  } };
  const service = new AlignmentService({ dictionary, infer: async (pairs) => { calls++; return pairs.map(raw); } });
  const first = service.get([pair], { waitForModel: true }), rejected = assert.rejects(first, /词典已更新/);
  await started.promise; revision++; meaning = '河岸'; gate.resolve(); await rejected;
  assert.equal(service.status().cached, 0);
  assert.deepEqual(links(await service.projection(pair, 500, { noCache: false })), ['河岸']); assert.equal(calls, 2);
  service.dispose();
});

test('禁用模型的备用词典链跨修订时也不返回旧释义对应，下一次使用新词库', async () => {
  const gate = deferred(), started = deferred(); let revision = 1, meaning = '银行';
  const service = new AlignmentService({ dictionary: { status: () => ({ ready: true, revision }), lookup: async (word) => {
    if (word.toLowerCase() !== 'bank') return null;
    const captured = meaning; started.resolve(); if (revision === 1) await gate.promise;
    return { word, source: 'ecdict', translations: [captured] };
  } } });
  service.configure({ enabled: false });
  const old = service.get([pair]); await started.promise; revision++; meaning = '河岸'; gate.resolve();
  assert.deepEqual(links((await old)[0]), []); assert.deepEqual(links((await service.get([pair]))[0]), ['河岸']);
  service.dispose();
});
