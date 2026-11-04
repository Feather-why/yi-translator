import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const { ProviderBatcher } = require(path.join(build, 'backend/scheduler/batcher.js'));
const request = (texts, extra = {}) => ({ texts, sourceLang: 'en', targetLang: 'zh-CN', ...extra });
const context = (signal) => ({ signal, config: {}, fetch: () => { throw new Error('使用回放适配器'); }, log: () => {} });
function provider(id = 'test', translate = async ({ texts }) => texts.map((text) => '译:' + text), limits = {}) {
  return { id, name: id, version: '1.0.0', kind: 'mt', official: true, usedFor: ['fast'], auth: [], placeholders: 'prompt',
    limits: { maxChars: 100, maxSegments: 10, concurrency: 2, ...limits }, translate, classifyError: () => ({ code: 'server', message: '回放错误', retryable: false }) };
}
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('不同术语锚点不能合入一个翻译批次，避免链接恢复借用另一段术语', async () => {
  const calls = [];
  const service = provider('terminology', async (req) => { calls.push(req); return req.texts; });
  const batcher = new ProviderBatcher();
  const signal = new AbortController().signal;
  await Promise.all([
    batcher.request(service, request(['bank'], { terminology: [{ source: 'bank', target: '河岸' }] }), signal, context),
    batcher.request(service, request(['bank'], { terminology: [{ source: 'bank', target: '银行' }] }), signal, context),
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((req) => req.terminology[0].target).sort(), ['河岸', '银行']);
});

test('微批量器同 tick 合批，并按原请求顺序切回多片段结果', async () => {
  const batcher = new ProviderBatcher();
  const calls = [];
  const service = provider('same', async ({ texts }) => { calls.push(texts); return texts.map((text) => text.toUpperCase()); });
  const signal = new AbortController().signal;
  const first = batcher.request(service, request(['a', 'b']), signal, context);
  const second = batcher.request(service, request(['c']), signal, context);
  assert.deepEqual(await Promise.all([first, second]), [['A', 'B'], ['C']]);
  assert.deepEqual(calls, [['a', 'b', 'c']]);
});

test('两家服务独立发批，不同版本、语言、上下文或严格标签要求也不混批', async () => {
  const batcher = new ProviderBatcher();
  const calls = [];
  const service = provider('one', async (req) => { calls.push(['one', req]); return req.texts; });
  const other = provider('two', async (req) => { calls.push(['two', req]); return req.texts; });
  const signal = new AbortController().signal;
  const requests = [
    [service, request(['a'])], [other, request(['b'])], [{ ...service, version: '2.0.0' }, request(['c'])],
    [service, request(['d'], { targetLang: 'ja' })], [service, request(['e'], { sourceLang: 'auto' })],
    [service, request(['f'], { context: { url: 'https://example.com/', title: '标题' } })],
    [service, request(['g'], { strictPlaceholders: true })],
  ];
  await Promise.all(requests.map(([p, req]) => batcher.request(p, req, signal, context)));
  assert.equal(calls.length, requests.length);
  assert.deepEqual(calls.find(([id]) => id === 'two')[1].texts, ['b']);
});

test('上下文属性顺序不同仍能合批', async () => {
  const batcher = new ProviderBatcher();
  let calls = 0;
  const service = provider('same', async ({ texts }) => { calls++; return texts; });
  const signal = new AbortController().signal;
  await Promise.all([
    batcher.request(service, request(['a'], { context: { title: '标题', url: 'https://example.com/' } }), signal, context),
    batcher.request(service, request(['b'], { context: { url: 'https://example.com/', title: '标题' } }), signal, context),
  ]);
  assert.equal(calls, 1);
});

test('累计字符或片段数量到上限时拆包，多文本请求仍汇总完整结果', async () => {
  const batcher = new ProviderBatcher();
  const calls = [];
  const service = provider('small', async ({ texts }) => { calls.push(texts); return texts.map((text) => '译:' + text); }, { maxChars: 5, maxSegments: 2 });
  const signal = new AbortController().signal;
  const result = await batcher.request(service, request(['aaa', 'bb', 'c', 'd', 'eeeee']), signal, context);
  assert.deepEqual(calls, [['aaa', 'bb'], ['c', 'd'], ['eeeee']]);
  assert.deepEqual(result, ['译:aaa', '译:bb', '译:c', '译:d', '译:eeeee']);
  assert.ok(calls.every((texts) => texts.length <= 2 && texts.join('').length <= 5));
});

test('单个片段过长时立即拒绝，不发送超限请求', async () => {
  const batcher = new ProviderBatcher();
  let calls = 0;
  const service = provider('small', async ({ texts }) => { calls++; return texts; }, { maxChars: 2 });
  await assert.rejects(batcher.request(service, request(['long']), new AbortController().signal, context), (error) => error.info.code === 'bad_input');
  assert.equal(calls, 0);
});

test('取消共享批次中的一个消费者立即拒绝自身，存活消费者仍得到结果', async () => {
  const batcher = new ProviderBatcher();
  const response = deferred();
  let batchSignal;
  const service = provider('shared', async (req, ctx) => { batchSignal = ctx.signal; return response.promise; });
  const a = new AbortController(); const b = new AbortController();
  const first = batcher.request(service, request(['a']), a.signal, context);
  const second = batcher.request(service, request(['b']), b.signal, context);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await tick();
  a.abort();
  await rejected;
  assert.equal(batchSignal.aborted, false);
  response.resolve(['A', 'B']);
  assert.deepEqual(await second, ['B']);
});

test('全部消费者取消才中止共享请求，忽略后到响应', async () => {
  const batcher = new ProviderBatcher();
  const response = deferred();
  let batchSignal;
  const service = provider('shared', async (req, ctx) => { batchSignal = ctx.signal; return response.promise; });
  const a = new AbortController(); const b = new AbortController();
  const first = batcher.request(service, request(['a']), a.signal, context);
  const second = batcher.request(service, request(['b']), b.signal, context);
  const done = Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
  await tick(); a.abort(); assert.equal(batchSignal.aborted, false); b.abort();
  await done;
  assert.equal(batchSignal.aborted, true);
  response.resolve(['A', 'B']);
  await tick();
});

test('发批前取消不进入网络，后续同 tick 请求正常执行', async () => {
  const batcher = new ProviderBatcher();
  const calls = [];
  const service = provider('same', async ({ texts }) => { calls.push(texts); return texts; });
  const a = new AbortController();
  const first = batcher.request(service, request(['a']), a.signal, context);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  a.abort();
  const second = batcher.request(service, request(['b']), new AbortController().signal, context);
  await rejected;
  assert.deepEqual(await second, ['b']);
  assert.deepEqual(calls, [['b']]);
});

test('取消一个跨批请求时只中断没有其他消费者的批次', async () => {
  const batcher = new ProviderBatcher();
  const responses = []; const signals = [];
  const service = provider('small', async (req, ctx) => { const pending = deferred(); responses.push(pending); signals.push(ctx.signal); return pending.promise; }, { maxSegments: 2 });
  const a = new AbortController(); const b = new AbortController();
  const first = batcher.request(service, request(['a', 'b', 'c']), a.signal, context);
  const second = batcher.request(service, request(['d']), b.signal, context);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await tick(); a.abort(); await rejected;
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, false]);
  responses[0].resolve(['A', 'B']); responses[1].resolve(['C', 'D']);
  assert.deepEqual(await second, ['D']);
});

test('数量或数据类型异常返回 server 错误并清理监听器', async () => {
  for (const result of [[], ['a', 'extra'], [1]]) {
    const batcher = new ProviderBatcher();
    const service = provider('broken', async () => result);
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { listeners++; add(...args); };
    controller.signal.removeEventListener = (...args) => { listeners--; remove(...args); };
    await assert.rejects(batcher.request(service, request(['a']), controller.signal, context), (error) => error.info.code === 'server');
    assert.equal(listeners, 0);
  }
});

test('正常响应和取消都移除消费者监听器，取消后错误响应不造成未处理拒绝', async () => {
  for (const cancel of [false, true]) {
    const batcher = new ProviderBatcher();
    const response = deferred();
    const service = provider('one', async () => response.promise);
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { listeners++; add(...args); };
    controller.signal.removeEventListener = (...args) => { listeners--; remove(...args); };
    const result = batcher.request(service, request(['a']), controller.signal, context);
    const rejected = cancel ? assert.rejects(result, { name: 'AbortError' }) : undefined;
    await tick();
    if (cancel) { controller.abort(); await rejected; response.reject(new Error('后到的网络错误')); }
    else { response.resolve(['A']); assert.deepEqual(await result, ['A']); }
    await tick();
    assert.equal(listeners, 0);
  }
});

test('批次执行钩子先于适配器执行，成功和异常都经由钩子的 finally 释放', async () => {
  for (const fail of [false, true]) {
    const order = [];
    const expected = new Error('适配器回放错误');
    const service = provider('hook', async ({ texts }) => { order.push('translate'); if (fail) throw expected; return texts; });
    const batcher = new ProviderBatcher(async (actualProvider, signal, run) => {
      assert.equal(actualProvider, service);
      assert.equal(signal.aborted, false);
      order.push('acquire');
      try { return await run(); } finally { order.push('release'); }
    });
    const result = batcher.request(service, request(['a']), new AbortController().signal, context);
    if (fail) await assert.rejects(result, (error) => error === expected);
    else assert.deepEqual(await result, ['a']);
    assert.deepEqual(order, ['acquire', 'translate', 'release']);
  }
});

test('批次在执行钩子中排队时取消，稍后获得执行机会也不调用适配器', async () => {
  const queued = deferred();
  let sharedSignal; let calls = 0;
  const service = provider('queued', async ({ texts }) => { calls++; return texts; });
  const batcher = new ProviderBatcher(async (actualProvider, signal, run) => { sharedSignal = signal; await queued.promise; return run(); });
  const controller = new AbortController();
  const result = batcher.request(service, request(['a']), controller.signal, context);
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await tick(); controller.abort(); await rejected;
  assert.equal(sharedSignal.aborted, true);
  queued.resolve(); await tick();
  assert.equal(calls, 0);
});
