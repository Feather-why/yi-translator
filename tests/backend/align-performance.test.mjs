import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const build = path.resolve(process.env.ALIGNMENT_TEST_BUILD || 'tests/.compiled/backend/align');
const { AlignmentService } = require(path.join(build, 'index.js'));
const { alignSentencePair } = require(path.join(build, 'local-pairs.js'));
const { heuristicAlignment, wordTokens } = require(path.join(build, 'algorithm.js'));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(predicate) { const end = Date.now() + 1000; while (!predicate()) { assert.ok(Date.now() < end); await tick(); } }
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
const pair = { id: 'a', source: 'alpha beta.', target: '甲。乙。', sourceLang: 'en', targetLang: 'zh-CN' };
const value = (pair, local) => ({ ...heuristicAlignment(pair), links: local ? [[1, 2]] : [[0, 0]] });

test('真实结果成功时不并行执行备用词典链，首次只精修一次，重复命中不查词', async () => {
  let lookups = 0;
  const input = { ...pair, source: 'browser', target: '浏览器' };
  const service = new AlignmentService({ infer: async (pairs) => pairs.map(heuristicAlignment), dictionary: {
    status: () => ({ ready: true }), lookup: async (word) => { lookups++; return { word, translations: ['n. 浏览器'], source: 'ecdict' }; },
  } });
  const [first] = await service.get([input], { waitForModel: true });
  assert.equal(lookups, 1); assert.ok(first.links.length > 0);
  await service.get([input]); assert.equal(lookups, 1); service.dispose();
});

for (const order of ['remote-first', 'local-first']) test(`来源缓存隔离(${order})：普通/仅本地/严格投影互不借用远程结果`, async () => {
  let local = 0, remote = 0;
  const service = new AlignmentService({ infer: async (pairs) => { local++; return pairs.map((pair) => value(pair, true)); },
    fetch: async () => { remote++; return new Response(JSON.stringify([value(pair, false)])); } });
  service.configure({ remoteUrl: 'https://align.example.test' });
  const requests = order === 'remote-first' ? [false, true] : [true, false];
  for (const localOnly of requests) {
    const [result] = await service.get([pair], { waitForModel: true, localOnly }); assert.deepEqual(result.links, value(pair, localOnly).links);
  }
  assert.equal(local, 1); assert.equal(remote, 1);
  assert.deepEqual((await service.projection(pair, 50, { noCache: false })).links, value(pair, true).links);
  assert.deepEqual((await service.get([pair], { waitForModel: true }))[0].links, value(pair, false).links);
  assert.equal(local, 1); assert.equal(remote, 1); service.dispose();
});

test('词典从未准备变就绪时不命中旧的未精修结果，严格投影也使用新词典阶段', async () => {
  let ready = false, calls = 0;
  const input = { ...pair, source: 'browser', target: '浏览器' };
  const service = new AlignmentService({ infer: async (pairs) => { calls++; return pairs.map(heuristicAlignment); }, dictionary: {
    status: () => ({ ready }), lookup: async (word) => ({ word, translations: ['n. 浏览器'], source: 'ecdict' }),
  } });
  assert.deepEqual((await service.get([input], { waitForModel: true }))[0].links, []);
  ready = true;
  assert.ok((await service.get([input], { waitForModel: true }))[0].links.length > 0);
  assert.ok((await service.projection(input, 50, { noCache: false })).links.length > 0);
  assert.equal(calls, 2); service.dispose();
});

test('一次noCache请求中复用重复窗口向量，但不跨请求留存或改变词边界', async () => {
  const input = { ...pair, source: 'The browser translates a page. '.repeat(4), target: '浏览器翻译页面。'.repeat(4) };
  let encoded = 0;
  const embed = async (text, language) => { encoded++; return wordTokens(text, language).map((_, index) => [index % 2, (index + 1) % 2]); };
  const service = new AlignmentService({ infer: async (pairs) => Promise.all(pairs.map((pair) => alignSentencePair(pair, embed))) });
  const [first] = await service.get([input], { waitForModel: true, noCache: true }); assert.equal(encoded, 2);
  const [second] = await service.get([input], { waitForModel: true, noCache: true }); assert.equal(encoded, 4);
  assert.deepEqual(first, second); assert.deepEqual(first.srcTokens, wordTokens(input.source, input.sourceLang));
  assert.equal(service.status().cached, 0); service.dispose();
});

test('无远程配置时普通预计算与localOnly选择加入同一个实际CPU任务', async () => {
  let calls = 0; const gate = deferred();
  const service = new AlignmentService({ infer: async (pairs) => { calls++; await gate.promise; return pairs.map(heuristicAlignment); } });
  const precomputed = service.precompute(pair); await until(() => calls === 1);
  const selected = service.get([pair], { localOnly: true, waitForModel: true }); await tick(); gate.resolve();
  await Promise.all([precomputed, selected]); assert.equal(calls, 1); service.dispose();
});

test('配置换节点不能复用旧在途结果，旧结果不返回也不污染新节点缓存', async () => {
  const old = deferred(); const urls = [];
  const service = new AlignmentService({ fetch: async (url) => { urls.push(url); return url.includes('old.') ? old.promise : new Response(JSON.stringify([value(pair, true)])); } });
  service.configure({ remoteUrl: 'https://old.example.test' });
  const first = service.get([pair], { waitForModel: true }); const rejected = assert.rejects(first, /设置已更新/); await until(() => urls.length === 1);
  service.configure({ remoteUrl: 'https://new.example.test' }); const second = service.get([pair], { waitForModel: true });
  old.resolve(new Response(JSON.stringify([value(pair, false)])));
  await rejected; assert.deepEqual((await second)[0].links, value(pair, true).links); assert.equal(urls.length, 2);
  assert.deepEqual((await service.get([pair]))[0].links, value(pair, true).links); service.dispose();
});

test('dispose发生于模型初始化期间时迟到初始化不重标ready，也不继续启动推理', async () => {
  const initialized = deferred(); let started = false, inferred = 0;
  const service = new AlignmentService({ initialize: async () => { started = true; await initialized.promise; }, infer: async (pairs) => { inferred++; return pairs.map(heuristicAlignment); } });
  const work = service.get([pair], { waitForModel: true }); const rejected = assert.rejects(work, /设置已更新/); await until(() => started);
  service.dispose(); initialized.resolve(); await rejected;
  assert.equal(service.status().modelReady, false); assert.equal(service.status().cached, 0); assert.equal(inferred, 0);
});
