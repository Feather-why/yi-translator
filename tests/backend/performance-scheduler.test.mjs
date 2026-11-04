import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BackendCore } = require('../.compiled/backend/core.js');
const { BackendStorage } = require('../.compiled/backend/storage.js');
const { SecretVault } = require('../.compiled/backend/secrets.js');
const { TranslatePort } = require('../.compiled/backend/ports/translate.js');
const { PriorityQueue } = require('../.compiled/backend/scheduler/queue.js');
const { ProviderError, classifyError } = require('../.compiled/backend/providers/types.js');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(predicate) { const end = Date.now() + 3000; while (!predicate()) { assert.ok(Date.now() < end, '任务未在时限内推进'); await tick(); } }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class Event { listeners = new Set(); addListener(fn) { this.listeners.add(fn); } removeListener(fn) { this.listeners.delete(fn); } emit(...args) { for (const fn of [...this.listeners]) fn(...args); } }
class Port {
  onMessage = new Event(); onDisconnect = new Event(); messages = [];
  postMessage(message) { this.messages.push(structuredClone(message)); }
  send(job) { this.onMessage.emit({ type: 'job', job }); }
  cancel(jobId) { this.onMessage.emit({ type: 'cancel', jobId }); }
  disconnect() { this.onDisconnect.emit(); }
}
class Storage extends BackendStorage {
  accesses = [];
  constructor() { super({ memory: true }); }
  async tmGet(...args) { this.accesses.push('tmGet'); return super.tmGet(...args); }
  async tmPut(...args) { this.accesses.push('tmPut'); return super.tmPut(...args); }
  async cacheGet(...args) { this.accesses.push('cacheGet'); return super.cacheGet(...args); }
  async cachePut(...args) { this.accesses.push('cachePut'); return super.cachePut(...args); }
}
function provider(id = 'local', options = {}) { return { id, name: id, version: '1.0.0', official: true, kind: 'local',
  auth: [], usedFor: ['fast', 'accurate', 'combined'], limits: { maxChars: 10000, maxSegments: 1, concurrency: 4 }, placeholders: 'prompt', classifyError,
  async translate(request) { return request.texts.map((text) => `译文${text}`); }, ...options }; }
async function setup(t, providers, concurrency = 8) {
  const data = {};
  const area = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); }, async set(value) { Object.assign(data, structuredClone(value)); } };
  globalThis.chrome = { storage: { local: area } };
  const storage = new Storage(), core = new BackendCore({ providers, storage, vault: new SecretVault({ memory: true, storage: area }) });
  await core.ready();
  const attach = () => {
    const port = new Port(), backend = new TranslatePort(port, core, concurrency, new PriorityQueue(concurrency));
    t.after(() => backend.dispose()); return port;
  };
  return { core, storage, port: attach(), attach };
}
function job(id = 'combined', overrides = {}) { return { jobId: id, sourceLang: 'en', targetLang: 'zh-CN', mode: 'combined', priority: 1, noCache: true,
  context: { url: 'https://example.test/article', title: 'Precise context', summary: 'A useful topic summary' },
  segments: [{ id: 's1', text: 'The children are reading a book.', kind: 'paragraph' }], ...overrides }; }
const finished = (port) => port.messages.some((message) => message.type === 'job-done' && message.stage === 'final');
const results = (port) => port.messages.filter((message) => message.type === 'result');
function assertDirectFinal(port) {
  assert.deepEqual(results(port).map((message) => message.stage), ['final']);
  assert.deepEqual(port.messages.filter((message) => message.type === 'job-done').map((message) => message.stage), ['fast', 'final']);
}

test('综合同本地服务只执行一次，使用精确上下文直接final，noCache无任何存储读写', async (t) => {
  const requests = [];
  const { port, storage } = await setup(t, [provider('local', { async translate(request) { requests.push(request); await tick(); return ['孩子们正在读书。']; } })]);
  const input = job(); port.send(input); await until(() => finished(port));
  assert.equal(requests.length, 1); assert.deepEqual(requests[0].context, input.context);
  assertDirectFinal(port); assert.deepEqual(storage.accesses, []);
});

test('综合默认内置未准备时，两档实际fallback同一local仍只执行一次', async (t) => {
  let builtinCalls = 0, localCalls = 0;
  const { port } = await setup(t, [
    provider('browser', { kind: 'builtin', usedFor: ['fast', 'combined'], async translate() { builtinCalls++; throw new ProviderError({ code: 'no_provider', message: '语言包未准备', retryable: true }); } }),
    provider('local', { usedFor: ['accurate', 'combined'], async translate(request) { localCalls++; assert.ok(request.context.summary); await tick(); return ['本机精确译文']; } }),
  ]);
  port.send(job()); await until(() => finished(port));
  assert.equal(builtinCalls, 1); assert.equal(localCalls, 1); assertDirectFinal(port);
});

for (const usedFor of [['fast'], ['fast', 'combined']]) test(`综合fast-only服务(${usedFor.join('/')})维持无context，不错误合并不同两家`, async (t) => {
  const precise = deferred(), calls = [];
  const input = job();
  const { port } = await setup(t, [
    provider('mt', { kind: 'mt', usedFor, async translate(request) { calls.push('mt'); assert.equal(Object.hasOwn(request, 'context'), false); return ['机翻浅译']; } }),
    provider('remote', { kind: 'remote', usedFor: ['accurate'], async translate(request) { calls.push('remote'); assert.deepEqual(request.context, input.context); return precise.promise; } }),
  ]);
  port.send(input); await until(() => results(port).length === 1);
  assert.equal(results(port)[0].stage, 'fast'); precise.resolve(['远端精确译文']); await until(() => finished(port));
  assert.deepEqual(results(port).map((message) => message.stage), ['fast', 'final']); assert.deepEqual(calls.sort(), ['mt', 'remote']);
});

test('仅fast本机后备不提前获得context，后续精确档不能误复用plain结果作final', async (t) => {
  const precise = deferred(), requests = [];
  const { port } = await setup(t, [provider('local', { usedFor: ['fast'], async translate(request) {
    requests.push(request);
    return request.context ? precise.promise : ['无上下文浅译'];
  } })]);
  const input = job(); port.send(input); await until(() => results(port).length === 1);
  assert.equal(results(port)[0].stage, 'fast'); assert.equal(results(port)[0].text, '无上下文浅译');
  precise.resolve(['包含精确上下文的最终译文']); await until(() => finished(port));
  assert.equal(requests.length, 2); assert.equal(requests.filter((request) => !Object.hasOwn(request, 'context')).length, 1);
  assert.deepEqual(requests.find((request) => request.context).context, input.context);
  assert.deepEqual(results(port).map((message) => message.text), ['无上下文浅译', '包含精确上下文的最终译文']);
});

test('共享失败只实际尝试和计费一次，两档继续fallback且不重复触发服务失败', async (t) => {
  let primaryCalls = 0, fallbackCalls = 0;
  const quota = { unit: 'char', period: 'month', amount: 1000 };
  const { port, core } = await setup(t, [
    provider('primary', { kind: 'mt', freeQuota: quota, async translate() { primaryCalls++; throw new ProviderError({ code: 'server', message: '真实服务离线', retryable: true }); } }),
    provider('fallback', { freeQuota: quota, async translate() { fallbackCalls++; await tick(); return ['后备精确译文']; } }),
  ]);
  const input = job(); port.send(input); await until(() => finished(port));
  assert.equal(primaryCalls, 1); assert.equal(fallbackCalls, 1); assertDirectFinal(port);
  for (const status of core.snapshot().providers) assert.equal(status.quota.used, [...input.segments[0].text].length);
  assert.equal(core.snapshot().providers.find((status) => status.id === 'primary').successRate, 0);
});

test('余量恰好够一份请求时，另一档仍可加入已预留的共享工作', async (t) => {
  const output = deferred(); let calls = 0;
  const input = job(), cost = [...input.segments[0].text].length;
  const { core } = await setup(t, [provider('local', { freeQuota: { unit: 'char', period: 'month', amount: cost },
    async translate() { calls++; return output.promise; } })]);
  const session = core.createCombined(input, input.segments[0]); t.after(() => session.dispose());
  const fast = session.translate('fast', new AbortController().signal); await until(() => calls === 1);
  const accurate = session.translate('accurate', new AbortController().signal);
  output.resolve(['两档共用一次的结果']);
  assert.equal((await fast).text, '两档共用一次的结果'); assert.equal((await accurate).text, '两档共用一次的结果');
  assert.equal(calls, 1); assert.equal(core.snapshot().providers[0].quota.used, cost);
});

for (const action of ['cancel', 'disconnect']) test(`综合共享运行中${action}取消真实调用，不发迟到结果或完成通知`, async (t) => {
  let signal;
  const { port } = await setup(t, [provider('local', { async translate(_request, context) {
    signal = context.signal;
    return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true }));
  } })]);
  port.send(job()); await until(() => signal);
  if (action === 'cancel') port.cancel('combined'); else port.disconnect();
  await until(() => signal.aborted); await tick(); assert.deepEqual(port.messages, []);
});

test('相同jobId替换创建新片段session，旧调用迟到不能借给新任务或覆盖结果', async (t) => {
  const pending = [];
  const { port } = await setup(t, [provider('local', { async translate(request, context) { const item = deferred(); pending.push({ ...item, signal: context.signal, text: request.texts[0] }); return item.promise; } })]);
  port.send(job('same')); await until(() => pending.length === 1);
  port.send(job('same', { segments: [{ id: 's1', text: 'A replacement paragraph.', kind: 'paragraph' }] }));
  await until(() => pending.length === 2); assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(['迟到的旧译文']); pending[1].resolve(['新段落的译文']); await until(() => finished(port));
  assert.deepEqual(results(port).map((message) => message.text), ['新段落的译文']); assertDirectFinal(port);
});

test('不同端口相同jobId/文本仍独立，一方取消不能取消另一方session', async (t) => {
  const pending = [];
  const { port: first, attach } = await setup(t, [provider('local', { async translate(_request, context) { const item = deferred(); pending.push({ ...item, signal: context.signal }); return item.promise; } })]);
  const second = attach(); first.send(job('same')); second.send(job('same')); await until(() => pending.length === 2);
  first.cancel('same'); await until(() => pending.filter((item) => item.signal.aborted).length === 1);
  pending.find((item) => !item.signal.aborted).resolve(['另一端口的译文']); await until(() => finished(second));
  assert.deepEqual(first.messages, []); assertDirectFinal(second);
});

test('共享服务只取消一个消费者时保留另一档的真实调用', async (t) => {
  const output = deferred(); let nativeSignal;
  const { core } = await setup(t, [provider('local', { async translate(_request, context) { nativeSignal = context.signal; return output.promise; } })]);
  const input = job(), session = core.createCombined(input, input.segments[0]); t.after(() => session.dispose());
  const fast = new AbortController(), accurate = new AbortController();
  const a = session.translate('fast', fast.signal), b = session.translate('accurate', accurate.signal);
  const cancelled = assert.rejects(a, { name: 'AbortError' });
  await until(() => nativeSignal); fast.abort(); await cancelled;
  assert.equal(nativeSignal.aborted, false); output.resolve(['另一档仍可使用']);
  assert.equal((await b).text, '另一档仍可使用');
});

test('lazy session创建迟于取消完成时仍释放，不启动模型或发迟到消息', async (t) => {
  const created = deferred(); let factories = 0, disposed = 0, calls = 0;
  const port = new Port(), backend = new TranslatePort(port, {
    async translate() { assert.fail('综合任务不能绕开session'); },
    async createCombined() { factories++; return created.promise; },
  }); t.after(() => backend.dispose());
  port.send(job()); await until(() => factories === 1); port.cancel('combined');
  created.resolve({ async translate() { calls++; return { text: '不能返回', provider: 'local', cached: false }; }, dispose() { disposed++; } });
  await until(() => disposed === 1); await tick(); assert.equal(calls, 0); assert.deepEqual(port.messages, []);
});

test('提升为final的本地结果写精确缓存，下一次综合任务直接final且不再调用模型', async (t) => {
  let calls = 0;
  const { port, core, storage } = await setup(t, [provider('local', { async translate() { calls++; return ['精确上下文译文']; } })], 1);
  const input = job('first', { noCache: false }); port.send(input); await until(() => finished(port)); assertDirectFinal(port);
  assert.equal(calls, 1);
  assert.equal((await storage.cacheGet('en', 'zh-CN', 'accurate', input.segments[0].text)).text, '精确上下文译文');
  assert.equal(await storage.cacheGet('en', 'zh-CN', 'fast', input.segments[0].text), undefined);
  const session = core.createCombined({ ...input, jobId: 'next' }, input.segments[0]);
  const cached = await session.translate('fast', new AbortController().signal); session.dispose();
  assert.equal(cached.finalOnly, true); assert.equal(cached.cached, true); assert.equal(calls, 1);
});

test('综合命中TM仍只发final并结束两个阶段，不创建模型工作', async (t) => {
  let calls = 0;
  const { port, storage } = await setup(t, [provider('local', { async translate() { calls++; return ['不该调用']; } })]);
  const input = job('tm', { noCache: false }); await storage.tmPut('en', 'zh-CN', input.segments[0].text, '用户记忆');
  port.send(input); await until(() => finished(port)); assertDirectFinal(port); assert.equal(calls, 0);
  assert.equal(results(port)[0].provider, 'memory');
});

test('32个有界逻辑槽允许MT形成大于8段的批次，实际HTTP仍遵守并发和QPS', async (t) => {
  const batches = [], starts = []; let active = 0, maxActive = 0;
  const { port } = await setup(t, [provider('mt', { kind: 'mt', limits: { maxChars: 10000, maxSegments: 20, concurrency: 1, qps: 10 }, async translate(request) {
    batches.push([...request.texts]); starts.push(performance.now()); active++; maxActive = Math.max(maxActive, active);
    await tick(); active--; return request.texts.map((text) => `译文${text}`);
  } })], 32);
  port.send(job('batch', { mode: 'fast', segments: Array.from({ length: 24 }, (_, index) => ({ id: `s${index}`, text: `Paragraph number ${index}.`, kind: 'paragraph' })) }));
  await until(() => finished(port));
  assert.ok(Math.max(...batches.map((batch) => batch.length)) > 8);
  assert.ok(batches.every((batch) => batch.length <= 20)); assert.equal(batches.flat().length, 24);
  assert.equal(maxActive, 1); assert.ok(starts.slice(1).every((time, index) => time - starts[index] >= 90));
  assert.equal(results(port).length, 24);
});
