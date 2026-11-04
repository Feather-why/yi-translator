import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AlignmentService } = require('../.compiled/backend/align/index.js');
const { wordTokens, heuristicAlignment, alignEmbeddings, validAlignment } = require('../.compiled/backend/align/algorithm.js');
const { refineWithDictionary } = require('../.compiled/backend/align/dictionary-links.js');
const { sentenceAlignmentFallback } = require('../.compiled/backend/align/sentence-alignment.js');
const { Dictionary } = require('../.compiled/backend/dict/index.js');
const pair = { id: 'a', source: 'I like apples.', target: '我喜欢苹果。', sourceLang: 'en', targetLang: 'zh-CN' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('词对齐字符区间基于 UTF-16，中文词、emoji、空白均不造成偏移', () => {
  const text = '🙂 I like 苹果 123.';
  const spans = wordTokens(text, 'zh-CN');
  assert.deepEqual(spans.map(([a, b]) => text.slice(a, b)), ['🙂', 'I', 'like', '苹果', '123', '.']);
  assert.deepEqual(spans[0], [0, 2]);
  const result = heuristicAlignment({ ...pair, source: text, target: '苹果 🙂 123 I' });
  assert.ok(result.links.some(([a, b]) => text.slice(...result.srcTokens[a]) === '123' && '苹果 🙂 123 I'.slice(...result.tgtTokens[b]) === '123'));
});

test('双向词向量互为最佳匹配可连接真实词范围，一对多回退链接保留', () => {
  const a = { ...pair, source: 'apples grow', target: '苹果生长' };
  const result = alignEmbeddings(a, [[1, 0], [0, 1]], [[1, 0], [0, 1]]);
  assert.deepEqual(result.links, [[0, 0], [1, 1]]);
  assert.equal(validAlignment(a, result), true);
  assert.equal(validAlignment(a, { ...result, links: [null] }), false);
  assert.equal(validAlignment(a, { ...result, srcTokens: [[0, 999]] }), false);
  assert.throws(() => alignEmbeddings(a, [[NaN]], [[1], [1]]), /数量|格式/);
});

test('首次有界等待模型，后台完成后命中缓存小于 50ms', async () => {
  let calls = 0;
  const alignment = new AlignmentService({ initialize: async () => { await sleep(20); }, infer: async (pairs) => { calls++; return pairs.map(heuristicAlignment); } });
  const start = performance.now(); const [first] = await alignment.get([pair]);
  assert.ok(performance.now() - start < 50); assert.equal(first.id, 'a');
  await alignment.precompute(pair);
  const hit = performance.now(); const [cached] = await alignment.get([{ ...pair, id: 'new-id' }]);
  assert.ok(performance.now() - hit < 50); assert.equal(cached.id, 'new-id'); assert.equal(calls, 1);
  assert.equal(alignment.status().modelReady, true);
});

test('相同文本在途去重仍返回各自 id，noCache 既不读缓存也不写入', async () => {
  let calls = 0;
  const alignment = new AlignmentService({ infer: async (pairs) => { calls++; await sleep(5); return pairs.map(heuristicAlignment); } });
  const [first, second] = await alignment.get([pair, { ...pair, id: 'b' }], { waitForModel: true });
  assert.equal(first.id, 'a'); assert.equal(second.id, 'b'); assert.equal(calls, 1);
  await alignment.get([pair], { waitForModel: true, noCache: true });
  assert.equal(calls, 2); assert.equal(alignment.status().cached, 1);
});

test('敏感页面 localOnly 不向已配置远程节点发送文本', async () => {
  let remote = 0, local = 0;
  const alignment = new AlignmentService({ infer: async (pairs) => { local++; return pairs.map(heuristicAlignment); }, fetch: async () => { remote++; throw new Error('不应远程'); } });
  alignment.configure({ remoteUrl: 'http://127.0.0.1:9999', token: 'fixture' });
  await alignment.get([pair], { waitForModel: true, localOnly: true, noCache: true });
  assert.equal(remote, 0); assert.equal(local, 1); assert.equal(alignment.status().cached, 0);
});

test('远程节点使用鉴权且不带Cookie，畸形区间或错误不污染缓存', async () => {
  let captured;
  const alignment = new AlignmentService({ fetch: async (url, init) => { captured = { url, init }; return new Response(JSON.stringify([heuristicAlignment(pair)])); } });
  alignment.configure({ remoteUrl: 'https://align.example.test', token: 'fixture' });
  const [result] = await alignment.get([pair], { waitForModel: true });
  assert.equal(result.id, pair.id); assert.equal(captured.init.credentials, 'omit'); assert.equal(captured.init.headers.Authorization, 'Bearer fixture');
  assert.equal(captured.url, 'https://align.example.test/v1/align');
  assert.throws(() => alignment.configure({ remoteUrl: 'file:///secret' }), /无效/);
  assert.throws(() => alignment.configure({ remoteUrl: 'https://user:key@example.test' }), /无效/);
});

test('禁用模型时不创建 offscreen，不发推理；超长/畸形输入明确失败', async () => {
  const alignment = new AlignmentService({ infer: async () => { throw new Error('不应执行'); } });
  alignment.configure({ enabled: false });
  assert.deepEqual(await alignment.get([pair]), [sentenceAlignmentFallback(pair)]);
  await assert.rejects(alignment.get([{ ...pair, source: 'x'.repeat(10001) }]), /输入/);
  await assert.rejects(alignment.get(new Array(101).fill(pair)), /最多/);
});

test('真实词典词义将 browser 连为完整中文词组，不把 mat 例句碎片的“上”当词义', async () => {
  const dictionary = new Dictionary({ memory: true, entries: [
    { word: 'browser', translation: 'n. 吃嫩叶的动物, 浏览书本的人\\n[计] 浏览程序' },
    { word: 'mat', translation: 'n. 垫, 丛, 衬边\\nvt. 铺席于...上' },
  ] });
  const browser = { ...pair, source: 'browser', target: '浏览器' };
  const initial = { ...heuristicAlignment(browser), links: [[0, 1]] };
  const refined = await refineWithDictionary(browser, initial, dictionary);
  assert.deepEqual(refined.links, [[0, 0], [0, 1]]);
  const mat = { ...pair, source: 'mat', target: '垫子上' };
  const result = await refineWithDictionary(mat, { ...heuristicAlignment(mat), links: [[0, 1]] }, dictionary);
  assert.deepEqual(result.links, [[0, 0]]);
});
