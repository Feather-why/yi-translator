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
const { validTranslation } = require('../.compiled/backend/validation.js');
const llamacpp = require('../.compiled/backend/providers/llamacpp.js').default;

const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, '集成回放未在时限内推进'); await pause(2); }
}
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
class Event {
  listeners = new Set();
  addListener(fn) { this.listeners.add(fn); }
  removeListener(fn) { this.listeners.delete(fn); }
  emit(...args) { for (const fn of [...this.listeners]) fn(...args); }
}
class Port {
  onMessage = new Event(); onDisconnect = new Event(); messages = [];
  postMessage(value) { this.messages.push(structuredClone(value)); }
  send(job) { this.onMessage.emit({ type: 'job', job }); }
}
class Storage extends BackendStorage {
  accesses = []; writes = [];
  constructor() { super({ memory: true }); }
  async tmGet(...args) { this.accesses.push('tmGet'); return super.tmGet(...args); }
  async tmPut(...args) { this.accesses.push('tmPut'); return super.tmPut(...args); }
  async cacheGet(...args) { this.accesses.push('cacheGet'); return super.cacheGet(...args); }
  async cachePut(...args) { this.accesses.push('cachePut'); this.writes.push(structuredClone(args)); return super.cachePut(...args); }
}
async function setup(t, options = {}) {
  const data = {}, area = {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); },
    async set(items) { Object.assign(data, structuredClone(items)); },
  };
  globalThis.chrome = { storage: { local: area } };
  const storage = new Storage();
  const core = new BackendCore({ providers: options.providers ?? [llamacpp], storage,
    vault: new SecretVault({ memory: true, storage: area }), fetch: options.fetch,
    align: options.align, lookup: options.lookup });
  await core.ready();
  const port = new Port(), backend = new TranslatePort(port, core, 8, new PriorityQueue(8));
  t.after(() => backend.dispose());
  return { core, port, storage };
}
function input(jobId, overrides = {}) {
  return { jobId, sourceLang: 'en', targetLang: 'zh-CN', mode: 'combined', priority: 1,
    context: { url: 'https://public.example/stream', title: 'Synthetic public replay' },
    segments: [{ id: 's1', text: 'The children are reading a book.', kind: 'paragraph' }], stream: true, noCache: true, ...overrides };
}
const rows = (port, jobId, type) => port.messages.filter((row) => row.jobId === jobId && row.type === type);
const done = (port, jobId) => rows(port, jobId, 'job-done').some((row) => row.stage === 'final');
const json = (content) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } });
const encode = new TextEncoder();
function sse(fragments, gate) {
  const event = (content, finish = null) => 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] }) + '\n\n';
  return new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encode.encode(event(fragments[0])));
      if (gate) await gate.promise;
      for (const fragment of fragments.slice(1)) controller.enqueue(encode.encode(event(fragment)));
      controller.enqueue(encode.encode(event('', 'stop') + 'data: [DONE]\n\n'));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
function finiteTiming(value, streaming = true) {
  assert.ok(value.timing, '实际请求必须带本次计时');
  for (const key of ['queueMs', 'providerMs']) assert.ok(Number.isFinite(value.timing[key]) && value.timing[key] >= 0, key);
  if (streaming) assert.ok(Number.isFinite(value.timing.firstTokenMs) && value.timing.firstTokenMs >= 0);
}

test('真实llama SSE贯穿Core/Port：综合同服务只执行一次，直接final且关闭全部中间消息', async (t) => {
  const gate = deferred(), calls = []; t.after(gate.resolve);
  const { port, storage } = await setup(t, { fetch: async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    assert.equal(url, 'http://127.0.0.1:8081/v1/chat/completions'); assert.equal(body.stream, true);
    return sse(['孩子', '们正在读书。'], gate);
  } });
  port.send(input('same'));
  await until(() => rows(port, 'same', 'partial').length > 0);
  assert.equal(rows(port, 'same', 'result').length, 0);
  assert.ok(rows(port, 'same', 'partial').every((row) => row.stage === 'final'));
  assert.equal(rows(port, 'same', 'partial')[0].text, '孩子');
  assert.deepEqual(storage.accesses, []);
  gate.resolve(); await until(() => done(port, 'same'));
  const results = rows(port, 'same', 'result');
  assert.equal(calls.length, 1); assert.deepEqual(results.map((row) => row.stage), ['final']);
  assert.equal(results[0].text, '孩子们正在读书。'); finiteTiming(results[0]);
  assert.deepEqual(rows(port, 'same', 'job-done').map((row) => row.stage), ['fast', 'final']);
  const finalAt = port.messages.indexOf(results[0]); await pause(100);
  assert.equal(port.messages.slice(finalAt + 1).some((row) => row.type === 'partial'), false);
  assert.deepEqual(storage.accesses, []);
});

test('内置语言包不可用后两档落在同一本地SSE，真实fallback调用仍只一次', async (t) => {
  let builtinCalls = 0, localCalls = 0;
  const builtin = { id: 'browser-replay', name: 'browser-replay', version: '1', kind: 'builtin', official: true,
    auth: [], usedFor: ['fast', 'combined'], placeholders: 'prompt', limits: { maxChars: 1200, maxSegments: 1, concurrency: 1 }, classifyError,
    async translate() { builtinCalls++; throw new ProviderError({ code: 'no_provider', message: '合成语言包未准备', retryable: true }); } };
  const { port } = await setup(t, { providers: [builtin, { ...llamacpp, usedFor: ['accurate', 'combined'] }],
    fetch: async (_url, init) => { localCalls++; assert.equal(JSON.parse(init.body).stream, true); return sse(['本机', '准确译文。']); } });
  port.send(input('fallback')); await until(() => done(port, 'fallback'));
  assert.equal(builtinCalls, 1); assert.equal(localCalls, 1);
  assert.deepEqual(rows(port, 'fallback', 'result').map((row) => [row.stage, row.text]), [['final', '本机准确译文。']]);
  assert.deepEqual(rows(port, 'fallback', 'job-done').map((row) => row.stage), ['fast', 'final']);
});

for (const noCache of [true, false]) test(`坏标签SSE重试后只发布合法最终值；noCache=${noCache}不存中间正文`, async (t) => {
  const first = deferred(), second = deferred(), calls = []; t.after(first.resolve); t.after(second.resolve);
  const source = 'Read <g0>the guide</g0>.', expected = '阅读<g0>指南</g0>。';
  const { port, storage } = await setup(t, { fetch: async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    return calls.length === 1 ? sse(['阅读', '指南。'], first) : sse(['阅读<g0>指', '南</g0>。'], second);
  } });
  const job = input(`retry-${noCache}`, { mode: 'accurate', noCache, segments: [{ id: 's1', text: source, kind: 'paragraph' }] });
  port.send(job); await until(() => rows(port, job.jobId, 'partial').length > 0);
  assert.equal(storage.writes.length, 0); assert.equal(rows(port, job.jobId, 'result').length, 0);
  first.resolve(); await until(() => calls.length === 2);
  assert.equal(storage.writes.length, 0, '第二次请求未完成不能把预览写进缓存');
  assert.match(calls[1].messages[0].content, /严格保留/);
  second.resolve(); await until(() => done(port, job.jobId));
  const [result] = rows(port, job.jobId, 'result');
  assert.equal(result.text, expected); assert.ok(validTranslation(source, result.text));
  assert.equal(result.timing.retries, 1); finiteTiming(result);
  assert.equal(calls.length, 2);
  if (noCache) assert.deepEqual(storage.accesses, []);
  else { assert.equal(storage.writes.length, 1); assert.equal(storage.writes[0].at(-1).text, expected); }
});

test('本轮缓存/TM命中不复用旧stream计时，不生成新的partial或模型请求', async (t) => {
  let requests = 0;
  const { port, storage } = await setup(t, { fetch: async (_url, init) => { requests++; assert.equal(JSON.parse(init.body).stream, true); return sse(['孩子', '们正在读书。']); } });
  port.send(input('populate', { noCache: false })); await until(() => done(port, 'populate'));
  finiteTiming(rows(port, 'populate', 'result')[0]);
  for (const memory of [false, true]) {
    if (memory) await storage.tmPut('en', 'zh-CN', input('unused').segments[0].text, '人工确认译文。');
    const id = memory ? 'memory-hit' : 'cache-hit'; port.send(input(id, { noCache: false }));
    await until(() => done(port, id));
    const [result] = rows(port, id, 'result'); assert.equal(result.cached, true);
    assert.equal(rows(port, id, 'partial').length, 0); assert.equal(requests, 1);
    assert.ok(result.timing?.providerMs === undefined || result.timing.providerMs === 0);
    assert.equal(result.timing?.firstTokenMs, undefined);
    assert.ok(result.timing?.retries === undefined || result.timing.retries === 0);
    if (memory) { assert.equal(result.provider, 'memory'); assert.equal(result.text, '人工确认译文。'); }
  }
});

test('不请求stream的PDF/图片契约沿用完整result，无partial和首token假计时', async (t) => {
  let calls = 0;
  const { port } = await setup(t, { fetch: async (_url, init) => { calls++; assert.equal(JSON.parse(init.body).stream, false); return json('完整的媒体译文。'); } });
  for (const kind of ['pdf', 'ocr']) {
    const id = `media-${kind}`; port.send(input(id, { mode: 'accurate', stream: undefined, segments: [{ id: 's1', text: 'Complete media text.', kind }] }));
    await until(() => done(port, id));
    const [result] = rows(port, id, 'result'); assert.equal(result.text, '完整的媒体译文。');
    assert.equal(rows(port, id, 'partial').length, 0); assert.equal(result.timing?.firstTokenMs, undefined); finiteTiming(result, false);
  }
  assert.equal(calls, 2);
});

test('含原子占位符的嵌套恢复不泄漏内部TXP正文或短锚点到流式端口', async (t) => {
  const calls = [], source = '<g0>Read <g1>the guide</g1> near <x0/>.</g0>';
  const { port } = await setup(t, { fetch: async (_url, init) => {
    const body = JSON.parse(init.body), prompt = body.messages[0].content, text = prompt.split('：\n').at(-1);
    calls.push({ body, text }); assert.equal(body.stream, false, '内部原子正文与锚点均禁止stream');
    return json(text === 'the guide' ? '指南' : '在[TXP0_0]附近阅读指南。');
  } });
  port.send(input('internal-atoms', { segments: [{ id: 's1', text: source, kind: 'paragraph' }] }));
  await until(() => done(port, 'internal-atoms'));
  const [result] = rows(port, 'internal-atoms', 'result'); assert.ok(validTranslation(source, result.text));
  assert.equal(result.text, '<g0>在<x0/>附近阅读<g1>指南</g1>。</g0>');
  assert.equal(rows(port, 'internal-atoms', 'partial').length, 0);
  assert.ok(calls.some(({ text }) => /\[TXP\d+_\d+\]/.test(text))); assert.ok(calls.some(({ text }) => text === 'the guide'));
  assert.doesNotMatch(result.text, /TXP/);
});

test('同一实际MT批次广播请求计时，但每位消费者保留自己的收到任务时间', async (t) => {
  const batches = [];
  const provider = { id: 'batch-replay', name: 'batch-replay', version: '1', kind: 'mt', official: true,
    auth: [], usedFor: ['fast'], placeholders: 'prompt', limits: { maxChars: 100, maxSegments: 8, concurrency: 1 }, classifyError,
    async translate(request, ctx) {
      batches.push(request); assert.notEqual(request.stream, true);
      const response = await ctx.fetch('https://batch.invalid/translate', { method: 'POST', body: JSON.stringify(request.texts) });
      return response.json();
    } };
  const { core } = await setup(t, { providers: [provider], fetch: async (_url, init) => { await pause(15); return new Response(JSON.stringify(JSON.parse(init.body).map((text) => '译' + text))); } });
  const first = input('batch-a', { mode: 'fast', stream: false, segments: [{ id: 'a', text: 'A', kind: 'paragraph' }] });
  const second = input('batch-b', { mode: 'fast', stream: false, segments: [{ id: 'b', text: 'B', kind: 'paragraph' }] });
  const now = performance.now(), signal = new AbortController().signal;
  const [a, b] = await Promise.all([
    core.translate(first, first.segments[0], 'fast', signal, { receivedAt: now - 500 }),
    core.translate(second, second.segments[0], 'fast', signal, { receivedAt: now - 25 }),
  ]);
  assert.equal(batches.length, 1); assert.deepEqual(batches[0].texts, ['A', 'B']);
  assert.deepEqual([a.text, b.text], ['译A', '译B']); finiteTiming(a, false); finiteTiming(b, false);
  assert.ok(a.timing.queueMs - b.timing.queueMs > 400, '不能借用第一位消费者的接收时钟');
  assert.ok(a.timing.providerMs >= 10 && b.timing.providerMs >= 10, '实际HTTP耗时应广播到每个存活成员');
  assert.equal(a.timing.firstTokenMs, undefined); assert.equal(b.timing.firstTokenMs, undefined);
});
