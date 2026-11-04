import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BackendCore } = require('../.compiled/backend/core.js');
const { BackendStorage } = require('../.compiled/backend/storage.js');
const { SecretVault } = require('../.compiled/backend/secrets.js');
const { classifyError } = require('../.compiled/backend/providers/types.js');
const { ProviderBatcher } = require('../.compiled/backend/scheduler/batcher.js');
const { TranslationTrace, RequestTimeline } = require('../.compiled/backend/translation-trace.js');
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < end, '等待流事件超时'); await delay(2); } }
const encode = (text) => new TextEncoder().encode(text);
const job = (text = 'Hello.', extra = {}) => ({ jobId: crypto.randomUUID(), sourceLang: 'en', targetLang: 'zh-CN', mode: 'accurate', priority: 1, noCache: true,
  stream: true, context: { url: 'https://fixture.example/' }, segments: [{ id: 's', text, kind: 'paragraph' }], ...extra });
async function consume(request, context, timeoutMs = 2000) {
  const results = [];
  for (let index = 0; index < request.texts.length; index++) {
    const response = await context.fetch('https://fixture.invalid/translate', { method: 'POST', body: request.texts[index], streamResponse: request.stream === true, timeoutMs });
    const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '';
    try {
      while (true) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); context.onPartial?.(text, index); }
      text += decoder.decode(); results.push(text);
    } finally { await reader.cancel().catch(() => {}); }
  }
  return results;
}
const provider = (id = 'fixture', extra = {}) => ({ id, name: id, version: 'stream-fixture', kind: 'local', official: true, auth: [], usedFor: ['fast', 'accurate', 'combined'],
  placeholders: 'prompt', limits: { maxChars: 1200, maxSegments: 1, concurrency: 4 }, freeQuota: { unit: 'char', period: 'month', amount: 10000 },
  translate: consume, classifyError, ...extra });
async function setup(fetcher, providers = [provider()]) {
  const data = {}, area = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); }, async set(items) { Object.assign(data, structuredClone(items)); } };
  globalThis.chrome = { storage: { local: area } };
  const storage = new BackendStorage({ memory: true }), core = new BackendCore({ providers, storage, vault: new SecretVault({ memory: true, storage: area }), fetch: fetcher });
  await core.ready(); return { core, storage };
}
const run = (core, input, observation, signal = new AbortController().signal) => core.translate(input, input.segments[0], 'accurate', signal, observation);

test('trace取实际请求并集，首次可见文字不把纯标签当首字，finish后不再回调', () => {
  let clock = 0; const partials = [], trace = new TranslationTrace({ receivedAt: 0, onPartial: (value) => partials.push(value) }, () => clock);
  const a = trace.branch('a', new AbortController().signal, true), b = trace.branch('b', new AbortController().signal, false);
  a.onRequestStart(10); b.onRequestStart(20); clock = 22; a.onPartial('<g0>', 0); clock = 25; a.onPartial('<g0>你', 0);
  a.onRequestEnd(30); b.onRequestEnd(40); clock = 45;
  assert.deepEqual(trace.finish(false, 'a'), { queueMs: 10, providerMs: 30, firstTokenMs: 15, retries: 0 });
  a.onPartial('迟到', 0); assert.equal(partials.length, 2);
});

test('共享工作给晚加入消费者回放原始请求区间，不把回放文字冒充新token', () => {
  let clock = 50; const timeline = new RequestTimeline(), a = new TranslationTrace({ receivedAt: 0 }, () => clock);
  const first = a.branch('provider', new AbortController().signal, false); timeline.subscribe(first); timeline.observation.onRequestStart(60);
  clock = 75; const previews = [], b = new TranslationTrace({ receivedAt: 25, onPartial: (value) => previews.push(value) }, () => clock), second = b.branch('provider', new AbortController().signal, true);
  timeline.subscribe(second); second.onPartial('已生成', 0, true); timeline.observation.onRequestEnd(90); clock = 100;
  assert.deepEqual(a.finish(), { queueMs: 60, providerMs: 30, retries: 0 });
  assert.deepEqual(b.finish(), { queueMs: 35, providerMs: 30, retries: 0 }); assert.equal(previews.length, 1);
});

test('批量stream按原item/index分发，不串段，stream与非stream请求不合批', async () => {
  const batcher = new ProviderBatcher(), calls = [], a = [], b = [];
  const context = (signal) => ({ signal, config: {}, log() {}, fetch() { throw Error(); } });
  const service = provider('batch', { kind: 'mt', limits: { maxChars: 100, maxSegments: 10, concurrency: 2 }, async translate(request, ctx) {
    calls.push(request); request.texts.forEach((text, index) => ctx.onPartial?.(text.toUpperCase(), index)); return request.texts;
  } });
  const input = (texts, stream) => ({ texts, sourceLang: 'en', targetLang: 'zh', stream });
  await Promise.all([
    batcher.request(service, input(['a', 'b'], true), new AbortController().signal, context, { onPartial: (text, index) => a.push([text, index]) }),
    batcher.request(service, input(['c'], true), new AbortController().signal, context, { onPartial: (text, index) => b.push([text, index]) }),
    batcher.request(service, input(['d'], false), new AbortController().signal, context),
  ]);
  assert.equal(calls.length, 2); assert.deepEqual(a, [['A', 0], ['B', 1]]); assert.deepEqual(b, [['C', 0]]);
});

test('streamResponse不先整包缓存，正文关闭前已有partial，传输私有开关不发给fetch', async () => {
  let controller, complete = false; const previews = [];
  const { core } = await setup(async (_url, init) => {
    assert.equal(init.streamResponse, undefined); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    return new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(encode('你')); } }));
  });
  const input = job(), pending = run(core, input, { receivedAt: performance.now() - 100, onPartial: (value) => previews.push(value) }).then((value) => { complete = true; return value; });
  await until(() => previews.length); assert.equal(complete, false); assert.equal(previews[0].text, '你');
  await delay(15); controller.enqueue(encode('好。')); controller.close(); const result = await pending;
  assert.equal(result.text, '你好。'); assert.ok(result.timing.queueMs >= 100); assert.ok(result.timing.providerMs >= 15); assert.ok(result.timing.firstTokenMs >= 0);
});

for (const reason of ['cancel', 'timeout']) test(`响应头和首预览之后${reason}仍中断body，并阻止迟到partial`, async () => {
  let cancelled = false, nativeSignal; const previews = [], abort = new AbortController();
  const { core } = await setup(async (_url, init) => {
    nativeSignal = init.signal; return new Response(new ReadableStream({ start(value) { value.enqueue(encode('你')); }, cancel() { cancelled = true; } }));
  }, [provider('fixture', { translate: (request, context) => consume(request, context, reason === 'timeout' ? 40 : 2000) })]);
  const pending = run(core, job(), { onPartial: (value) => previews.push(value) }, abort.signal);
  const rejection = assert.rejects(pending, (error) => reason === 'cancel' ? error.name === 'AbortError' : error.info?.code === 'network');
  await until(() => previews.length); if (reason === 'cancel') abort.abort(); await rejection;
  assert.equal(nativeSignal.aborted, true); assert.equal(cancelled, true); const before = previews.length; await delay(10); assert.equal(previews.length, before);
});

test('combined只有一个实际流和输出owner，晚加入者获得完整批次时序和独立queue', async () => {
  let controller, requests = 0; const fast = [], final = [];
  const { core } = await setup(async () => { requests++; return new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(encode('你')); } })); });
  const input = job('Hello.', { mode: 'combined' }), session = core.createCombined(input, input.segments[0]);
  try {
    const a = session.translate('fast', new AbortController().signal, { receivedAt: performance.now() - 500, onPartial: (value) => fast.push(value) });
    await until(() => fast.length);
    const b = session.translate('accurate', new AbortController().signal, { receivedAt: performance.now() - 25, onPartial: (value) => final.push(value) });
    await delay(10); controller.enqueue(encode('好。')); controller.close(); const [left, right] = await Promise.all([a, b]);
    assert.equal(requests, 1); assert.equal(final.length, 0); assert.ok(fast.every((value) => value.finalOnly));
    assert.equal(left.text, right.text); assert.equal(left.timing.providerMs, right.timing.providerMs); assert.ok(left.timing.queueMs - right.timing.queueMs > 400);
  } finally { session.dispose(); }
});

test('shared预览owner取消后另一消费者继续，取消者没有后续回调', async () => {
  let controller; const first = [], second = [], abort = new AbortController();
  const { core } = await setup(async () => new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(encode('你')); } })));
  const input = job('Hello.', { mode: 'combined' }), session = core.createCombined(input, input.segments[0]);
  try {
    const a = session.translate('fast', abort.signal, { onPartial: (value) => first.push(value) }), rejection = assert.rejects(a, { name: 'AbortError' });
    const b = session.translate('accurate', new AbortController().signal, { onPartial: (value) => second.push(value) });
    await until(() => first.length); abort.abort(); await rejection; const count = first.length;
    controller.enqueue(encode('好。')); controller.close(); assert.equal((await b).text, '你好。');
    assert.equal(first.length, count); assert.equal(second.at(-1).text, '你好。');
  } finally { session.dispose(); }
});

test('原始XML流可预览但只在最终严格结构通过后返回正式结果', async () => {
  const previews = [], { core } = await setup(async () => new Response('<g0>机器翻译</g0>有效。'));
  const input = job('<g0>Machine translation</g0> works.');
  const result = await run(core, input, { onPartial: (value) => previews.push(value.text) });
  assert.ok(previews[0].includes('<g0>')); assert.equal(result.text, '<g0>机器翻译</g0>有效。');
});

test('恢复只预览无atoms完整正文，anchor与TXP投影不泄漏；重试数含失败后的真实恢复请求', async () => {
  const previews = [], requests = [];
  const { core } = await setup(async (_url, init) => {
    const text = init.body; requests.push(text);
    return new Response(text.includes('<g') ? '缺少标签' : text === 'the guide' ? '指南' : requests.length < 5 ? '请阅读说明书。' : '请阅读指南。');
  });
  const input = job('Read <g0>the guide</g0>.'); const result = await run(core, input, { onPartial: (value) => previews.push(value.text) });
  assert.equal(result.text, '请阅读<g0>指南</g0>。'); assert.equal(requests.length, 5); assert.equal(result.timing.retries, 4);
  assert.ok(!previews.includes('指南'), '孤立anchor不作为整段预览'); assert.ok(previews.includes('请阅读说明书。'));
  const atoms = [], { core: other } = await setup(async (_url, init) => new Response(init.body.includes('Read') ? '阅读指南并保留[TXP0_0]。' : '指南'));
  const withAtoms = job('<g0>Read <g1>guide</g1></g0> and keep <x0/>.');
  await run(other, withAtoms, { onPartial: (value) => atoms.push(value.text) }); assert.deepEqual(atoms, []);
});

test('长片段preview累计前面已完成分块，不把后半段当成整段替换', async () => {
  const previews = [], { core } = await setup(async (_url, init) => new Response(init.body.trim() === 'One.' ? '一。' : '二。'), [provider('fixture', { limits: { maxChars: 6, maxSegments: 1, concurrency: 2 } })]);
  const result = await run(core, job('One. Two.'), { onPartial: (value) => previews.push(value.text) });
  assert.equal(result.text, '一。 二。'); assert.equal(previews.at(-1), '一。 二。');
});

test('hedge只展示主分支流，第二家获胜时不交错且不把首家的TTFT归给赢家', async () => {
  const previews = [], fetcher = async (_url, init) => init.body === 'first'
    ? new Response(new ReadableStream({ start(value) { value.enqueue(encode('首选预览')); } })) : new Response('第二家完整结果');
  const make = (id) => provider(id, { kind: 'mt', translate: (request, context) => consume({ ...request, texts: [id] }, context) });
  const { core } = await setup(fetcher, [make('first'), make('second')]);
  const input = job('Hello.', { priority: 0 }); const result = await run(core, input, { onPartial: (value) => previews.push(value) });
  assert.equal(result.provider, 'second'); assert.ok(previews.length); assert.ok(previews.every((value) => value.provider === 'first'));
  assert.equal(result.timing.firstTokenMs, undefined); assert.ok(result.timing.providerMs >= 290);
});
