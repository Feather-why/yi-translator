import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PerformanceMetrics, MeasuredQueue } = require('../.compiled/backend/performance.js');
const { BackendCore } = require('../.compiled/backend/core.js');
const { BackendStorage } = require('../.compiled/backend/storage.js');
const { SecretVault } = require('../.compiled/backend/secrets.js');
const { classifyError } = require('../.compiled/backend/providers/types.js');
const { createRpcHandlers } = require('../.compiled/backend/rpc.js');
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
function area() { const data = {}; return { get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]])), set: async (value) => Object.assign(data, value) }; }
async function setup(provider, options = {}) {
  const local = area(); globalThis.chrome = { storage: { local } };
  const core = new BackendCore({ providers: [provider], storage: new BackendStorage({ memory: true }), vault: new SecretVault({ memory: true, storage: local }), ...options });
  await core.ready(); await core.save(provider.id, true, {}); return core;
}
const provider = (overrides = {}) => ({ id: 'fixture', name: 'fixture', version: '1.0.0', kind: 'mt', official: true, auth: [], usedFor: ['fast', 'accurate', 'combined'], limits: { maxChars: 10000, maxSegments: 50, concurrency: 4 }, placeholders: 'prompt', classifyError, ...overrides });
const job = (text, options = {}) => ({ jobId: 'private-job-id', sourceLang: 'en', targetLang: 'zh-CN', mode: 'fast', priority: 0, context: { url: 'https://private.example/path' }, segments: [{ id: 's', text, kind: 'paragraph' }], ...options });

test('匿名聚合只允许固定维度/有限数字，表有界且快照不能修改内部状态', () => {
  const metrics = new PerformanceMetrics(() => 100);
  metrics.record({ type: 'http', providerId: 'fixture', outcome: 'success', durationMs: 12, source: 'NEVER_STORE_SOURCE', url: 'NEVER_STORE_URL', key: 'NEVER_STORE_KEY' });
  for (const value of [NaN, Infinity, -1, 1e100]) metrics.record({ type: 'http', providerId: 'fixture', outcome: 'success', durationMs: value });
  metrics.record({ type: 'http', providerId: 'fixture', outcome: 'NEVER_STORE_OUTCOME', durationMs: 1 });
  for (let i = 0; i < 400; i++) metrics.record({ type: 'http', providerId: 'provider-' + i, outcome: 'failure', durationMs: 3 });
  const first = metrics.snapshot(); assert.ok(first.http.length <= 128);
  const row = first.http.find((item) => item.providerId === 'fixture'); assert.equal(row.count, 1); assert.equal(row.totalMs, 12);
  row.totalMs = 999; assert.equal(metrics.snapshot().http.find((item) => item.providerId === 'fixture').totalMs, 12);
  assert.ok(!JSON.stringify(first).includes('NEVER_STORE'));
  assert.doesNotThrow(() => metrics.record({ get type() { throw new Error('unexpected getter'); } }));
});

test('真实batch HTTP只计一次，两个逻辑片段分开计，模型返回字段不推测', async () => {
  const metrics = new PerformanceMetrics(); let http = 0;
  const adapter = provider({ async translate(request, context) {
    const response = await context.fetch('https://fixture.invalid/translate', { method: 'POST', body: JSON.stringify(request.texts) });
    context.recordTiming({ phase: 'model', promptMs: 3, generationMs: 8, promptTokens: 10, outputTokens: 12, source: 'DO_NOT_SAVE' });
    return response.json();
  } });
  const core = await setup(adapter, { onPerformance: (event) => metrics.record(event), fetch: async (_url, init) => { http++; return new Response(JSON.stringify(JSON.parse(init.body).map(() => '合成译文')), { status: 200 }); } });
  const a = job('One private sentence.'), b = job('Another private sentence.');
  await Promise.all([core.translate(a, a.segments[0], 'fast', new AbortController().signal), core.translate(b, b.segments[0], 'fast', new AbortController().signal)]);
  const snapshot = metrics.snapshot(); assert.equal(http, 1); assert.equal(snapshot.http[0].count, 1); assert.equal(snapshot.logical[0].count, 2);
  assert.equal(snapshot.modelTiming.find((item) => item.kind === 'generationMs').totalMs, 8);
  assert.equal(snapshot.modelTiming.find((item) => item.kind === 'outputTokens').counters.tokens, 12);
  await core.translate(a, a.segments[0], 'fast', new AbortController().signal);
  assert.equal(metrics.snapshot().logical.find((item) => item.cache === 'hit').count, 1); assert.equal(http, 1);
  assert.ok(!JSON.stringify(snapshot).includes('private')); assert.ok(!JSON.stringify(snapshot).includes('DO_NOT_SAVE'));
});

test('综合任务实际共享次数可证，两个逻辑档位只产生一次模型HTTP', async () => {
  const metrics = new PerformanceMetrics(); let calls = 0;
  const core = await setup(provider({ kind: 'local', limits: { maxChars: 10000, maxSegments: 1, concurrency: 2 }, translate: async (_request, context) => { await context.fetch('https://fixture.invalid/translate'); return ['共享译文']; } }), {
    onPerformance: (event) => metrics.record(event), fetch: async () => { calls++; await tick(); return new Response('{}'); },
  });
  const request = job('Same source.', { mode: 'combined', noCache: true }), scope = core.createCombined(request, request.segments[0]);
  await Promise.all([scope.translate('fast', new AbortController().signal), scope.translate('accurate', new AbortController().signal)]); scope.dispose();
  const snapshot = metrics.snapshot(); assert.equal(calls, 1); assert.equal(snapshot.http[0].count, 1);
  assert.equal(snapshot.shared.find((item) => item.outcome === 'created').count, 1); assert.equal(snapshot.shared.find((item) => item.outcome === 'reused').count, 1);
  assert.equal(snapshot.logical.reduce((sum, item) => sum + item.count, 0), 2);
});

test('HTTP失败与完整body异常计失败，诊断回调抛错不改变有效译文', async () => {
  const metrics = new PerformanceMetrics();
  const core = await setup(provider({ translate: async (_request, context) => { await context.fetch('https://fixture.invalid/fail'); return ['不会到达']; } }), {
    onPerformance: (event) => metrics.record(event), fetch: async () => { throw new TypeError('private network address must never enter metrics'); },
  });
  const request = job('Private text.', { noCache: true });
  await assert.rejects(core.translate(request, request.segments[0], 'fast', new AbortController().signal));
  assert.equal(metrics.snapshot().http[0].outcome, 'failure'); assert.ok(!JSON.stringify(metrics.snapshot()).includes('private network'));
  const brokenBody = await setup(provider({ translate: async (_request, context) => { await context.fetch('https://fixture.invalid/body'); return ['不会到达']; } }), {
    onPerformance: (event) => metrics.record(event), fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('private body failure')); } })),
  });
  await assert.rejects(brokenBody.translate(request, request.segments[0], 'fast', new AbortController().signal));
  assert.equal(metrics.snapshot().http[0].count, 2); assert.ok(!JSON.stringify(metrics.snapshot()).includes('private body'));
  const safe = await setup(provider({ translate: async (_request, context) => { context.recordTiming({ phase: 'model', generationMs: 2 }); await context.fetch('https://fixture.invalid/ok'); return ['有效译文']; } }), { onPerformance: () => { throw new Error('broken metrics'); }, fetch: async () => new Response('{}') });
  assert.equal((await safe.translate(request, request.segments[0], 'fast', new AbortController().signal)).text, '有效译文');
});

test('正在读取的HTTP取消被单独记录，不作为成功或普通失败', async () => {
  const metrics = new PerformanceMetrics(); let begin; const begun = new Promise((resolve) => { begin = resolve; });
  const core = await setup(provider({ translate: async (_request, context) => { await context.fetch('https://fixture.invalid/pending'); return ['不会到达']; } }), {
    onPerformance: (event) => metrics.record(event), fetch: async (_url, init) => { begin(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })); },
  });
  const request = job('Cancellation source.', { noCache: true }), controller = new AbortController();
  const rejection = assert.rejects(core.translate(request, request.segments[0], 'fast', controller.signal), (error) => error.name === 'AbortError');
  await begun; controller.abort(); await rejection;
  assert.deepEqual(metrics.snapshot().http.map((row) => [row.outcome, row.count]), [['cancelled', 1]]);
  assert.equal(metrics.snapshot().logical[0].outcome, 'cancelled');
});

test('local投影接lazy，builtin保持anchored，诊断含provider而回调异常不影响结构', async () => {
  for (const kind of ['local', 'builtin']) for (const mode of ['fast', 'accurate']) {
    const seen = [], diagnostics = [];
    const core = await setup(provider({ kind, limits: { maxChars: 1000, maxSegments: 1, concurrency: 2 }, async translate(request) {
      const text = request.texts[0]; seen.push(text);
      return [text.includes('<g') ? '没有标记的译文' : text.trim() === 'installation guide' ? '安装指南' : '请阅读安装指南。'];
    } }), { onPlaceholderDiagnostic: (record) => { diagnostics.push(record); throw new Error('metrics sink failure'); } });
    const request = job('Read <g0>installation guide</g0>.', { noCache: true, mode });
    assert.equal((await core.translate(request, request.segments[0], mode, new AbortController().signal)).text, '请阅读<g0>安装指南</g0>。');
    assert.equal(seen.filter((text) => text.includes('<g')).length, mode === 'fast' ? 1 : 2);
    assert.equal(seen.find((text) => !text.includes('<g')), kind === 'local' ? 'Read installation guide.' : 'installation guide');
    assert.equal(diagnostics[0].providerId, 'fixture'); assert.equal(diagnostics[0].strategy, kind === 'local' ? 'lazy' : 'anchored');
  }
});

test('队列取消未出队不记started，真实run分别记录fast/final等待', async () => {
  const metrics = new PerformanceMetrics(); let clock = 0, finish;
  const queue = new MeasuredQueue((event) => metrics.record(event), 1, () => clock);
  const first = queue.add(0, new AbortController().signal, () => new Promise((resolve) => { finish = resolve; }), 'fast');
  await tick(); clock = 20;
  const cancelled = new AbortController(), second = queue.add(0, cancelled.signal, async () => 'never', 'final');
  const rejection = assert.rejects(second.promise, (error) => error.name === 'AbortError'); clock = 25; cancelled.abort(); await rejection;
  const third = queue.add(0, new AbortController().signal, async () => 'final', 'final'); clock = 40; finish('fast'); await first.promise; await third.promise;
  const snapshot = metrics.snapshot(); assert.equal(snapshot.queue.find((row) => row.lane === 'fast' && row.outcome === 'started').count, 1);
  assert.equal(snapshot.queue.find((row) => row.lane === 'final' && row.outcome === 'started').count, 1);
  assert.equal(snapshot.queue.find((row) => row.outcome === 'cancelled-before-start').count, 1);
  const throwing = new MeasuredQueue(() => { throw new Error('sink'); }, 1); assert.equal(await throwing.add(0, new AbortController().signal, async () => 42).promise, 42);
});

test('性能仅admin读，warmup按manual/hover验证来源，未知URL参数拒绝且不触发warmup', async () => {
  const id = 'fixture-extension', reads = [], warmups = [];
  globalThis.chrome = { runtime: { id, getURL: (path) => `chrome-extension://${id}/${path}` }, storage: { local: { get: async () => ({ 'settings.ui': { sensitive: ['private.example'] } }) } } };
  const admin = { id, url: `chrome-extension://${id}/options.html` }, content = { id, url: 'https://public.example/', tab: { id: 5, url: 'https://public.example/', windowId: 1 } };
  const handlers = createRpcHandlers({}, undefined, { performance: () => { reads.push(1); return new PerformanceMetrics().snapshot(); }, warmup: async (request) => { warmups.push(request); return { status: 'ready' }; } });
  await assert.rejects(handlers['performance:get'](undefined, content), (error) => error.info.code === 'auth'); assert.equal(reads.length, 0);
  assert.ok((await handlers['performance:get'](undefined, admin)).http); assert.equal(reads.length, 1);
  await handlers['models:warmup']({ reason: 'manual' }, admin); await handlers['models:warmup']({ reason: 'hover' }, content);
  assert.deepEqual(await handlers['providers:warm']({ mode: 'combined' }, content), { ok: true });
  assert.deepEqual(warmups.at(-1), { reason: 'hover' });
  for (const sender of [{ ...content, id: 'foreign' }, { ...content, url: 'https://private.example/' }, { ...content, tab: { ...content.tab, incognito: true } }, { id, url: content.url }]) await assert.rejects(handlers['models:warmup']({ reason: 'hover' }, sender), (error) => error.info.code === 'auth');
  await assert.rejects(handlers['models:warmup']({ reason: 'manual' }, content), (error) => error.info.code === 'auth');
  await assert.rejects(handlers['models:warmup']({ reason: 'manual', url: 'http://evil.invalid' }, admin), (error) => error.info.code === 'bad_input');
  await assert.rejects(handlers['models:warmup']({ reason: 'manual', providerId: 123 }, admin), (error) => error.info.code === 'bad_input');
  await assert.rejects(handlers['providers:warm']({ mode: 'fast' }, { ...content, tab: { ...content.tab, incognito: true } }), (error) => error.info.code === 'auth');
  await assert.rejects(handlers['providers:warm']({ mode: 'fast' }, { ...content, url: 'https://private.example/' }), (error) => error.info.code === 'auth');
  await assert.rejects(handlers['providers:warm']({ mode: 'invalid' }, content), (error) => error.info.code === 'bad_input');
  await assert.rejects(handlers['providers:warm']({ mode: 'fast', url: 'http://evil.invalid' }, content), (error) => error.info.code === 'bad_input');
  assert.equal(warmups.length, 3);
});
