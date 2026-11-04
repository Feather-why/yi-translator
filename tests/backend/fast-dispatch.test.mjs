import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const { ProviderSlots } = require(path.join(build, 'backend/scheduler/provider-slots.js'));
const { PriorityQueue } = require(path.join(build, 'backend/scheduler/queue.js'));
const { ProviderBatcher } = require(path.join(build, 'backend/scheduler/batcher.js'));
const { BackendCore } = require(path.join(build, 'backend/core.js'));
const { BackendStorage } = require(path.join(build, 'backend/storage.js'));
const { SecretVault } = require(path.join(build, 'backend/secrets.js'));
const { classifyError, ProviderError } = require(path.join(build, 'backend/providers/types.js'));
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
async function until(check) { const end = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < end, '等待调度超时'); await delay(2); } }
const signal = () => new AbortController().signal;
const hints = (priority = 0, lane = 'final') => ({ priority: () => priority, lane: () => lane });
function slots(limits = { concurrency: 1 }) {
  const runtime = { active: 0, failures: 0, cooldown: 0, nextRequest: 0 }, queue = new ProviderSlots();
  const access = { runtime: () => runtime, limits: () => limits };
  return { queue, runtime, access, acquire: (order = hints(), abort = signal()) => queue.acquire('fixture', access, abort, order) };
}
function provider(translate, extra = {}) { return { id: 'fixture', name: 'fixture', version: 'v1', kind: 'local', official: true, auth: [],
  usedFor: ['fast', 'accurate', 'combined'], limits: { maxChars: 1200, maxSegments: 1, concurrency: 1 }, placeholders: 'prompt', translate, classifyError, ...extra }; }
async function setup(translate, extra = {}) {
  const data = {}, area = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); }, async set(value) { Object.assign(data, structuredClone(value)); } };
  globalThis.chrome = { storage: { local: area } };
  const storage = new BackendStorage({ memory: true }), core = new BackendCore({ providers: [provider(translate, extra)], storage, vault: new SecretVault({ memory: true, storage: area }) });
  await core.ready(); return { core, storage };
}
const input = (text = 'Read <g0>guide</g0>.', mode = 'fast', extra = {}) => ({ jobId: crypto.randomUUID(), mode, sourceLang: 'en', targetLang: 'zh-CN', priority: 0,
  noCache: true, context: { url: 'https://fixture.example/' }, segments: [{ id: 's', text, kind: 'paragraph' }], ...extra });
const run = (core, job, observer, abort = signal()) => core.translate(job, job.segments[0], job.mode === 'fast' ? 'fast' : 'accurate', abort, observer);

test('真实槽按当前numeric优先级出队，低优先fast不能越过高优先final', async () => {
  const fixture = slots(), release = await fixture.acquire(), order = []; let moved = 100;
  const request = (id, schedule) => fixture.acquire(schedule).then((done) => { order.push(id); done(); });
  const a = request('moved', { priority: () => moved, lane: () => 'final' });
  const b = request('fast-low', hints(1, 'fast')), c = request('final-high', hints(0, 'final'));
  moved = -1; release(); await Promise.all([a, b, c]);
  assert.deepEqual(order, ['moved', 'final-high', 'fast-low']); assert.equal(fixture.runtime.active, 0);
});

test('真实槽同层fast:final为3:1，准确请求不会被持续fast饿死', async () => {
  const fixture = slots(), release = await fixture.acquire(), order = [];
  const final = fixture.acquire(hints(0, 'final')).then((done) => { order.push('final'); done(); });
  const fast = Array.from({ length: 6 }, (_, index) => fixture.acquire(hints(0, 'fast')).then((done) => { order.push('fast' + index); done(); }));
  release(); await Promise.all([final, ...fast]); assert.deepEqual(order.slice(0, 4), ['fast0', 'fast1', 'fast2', 'final']);
});

test('QPS按真实批次发槽，释放不绕过最小间隔或并发限制', async () => {
  const fixture = slots({ concurrency: 3, qps: 40 }), starts = []; let maximum = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { const release = await fixture.acquire(); const dispatch = await release.dispatch(); dispatch(); starts.push(performance.now()); maximum = Math.max(maximum, fixture.runtime.active); release(); }));
  assert.ok(starts.slice(1).every((at, index) => at - starts[index] >= 20)); assert.ok(maximum <= 3); assert.equal(fixture.runtime.active, 0);
});

test('冷却后半开只放一个真实批次，成功恢复后重新利用全部并发', async () => {
  const fixture = slots({ concurrency: 3 }); fixture.runtime.failures = 3; fixture.runtime.cooldown = Date.now() - 1;
  const first = await fixture.acquire(); let granted = 0;
  const a = fixture.acquire().then((release) => { granted++; return release; }), b = fixture.acquire().then((release) => { granted++; return release; });
  await delay(10); assert.equal(granted, 0); assert.equal(fixture.runtime.active, 1);
  fixture.runtime.failures = 0; fixture.runtime.cooldown = 0; first(); const releases = await Promise.all([a, b]);
  assert.equal(granted, 2); assert.equal(fixture.runtime.active, 2); releases.forEach((release) => { release(); release(); }); assert.equal(fixture.runtime.active, 0);
});

for (const kind of ['deleted', 'cooldown', 'quota']) test(`等待期间${kind}立即拒绝待办，运行中的lease仍只释放一次`, async () => {
  const fixture = slots(), release = await fixture.acquire(), pending = fixture.acquire();
  const rejection = assert.rejects(pending, (error) => error.info?.code === 'no_provider');
  if (kind === 'deleted') fixture.access.runtime = () => undefined;
  else if (kind === 'quota') fixture.runtime.exhaustedUntil = Date.now() + 30000;
  else fixture.runtime.cooldown = Date.now() + 30000;
  fixture.queue.wake(); await rejection; release(); release(); assert.equal(fixture.runtime.active, 0);
});

test('等待取消移除listener和队列，不占后续槽或延迟正常请求', async () => {
  const fixture = slots(), release = await fixture.acquire(), abort = new AbortController();
  const pending = fixture.acquire(hints(0, 'fast'), abort.signal), rejection = assert.rejects(pending, { name: 'AbortError' });
  abort.abort(); await rejection; assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  release(); const next = await fixture.acquire(); assert.equal(fixture.runtime.active, 1); next(); assert.equal(fixture.runtime.active, 0);
});

test('无fast时真实服务并发全部可用，持续准确任务不会死锁', async () => {
  const fixture = slots({ concurrency: 6 }); let maximum = 0, done = 0;
  await Promise.all(Array.from({ length: 20 }, async () => { const release = await fixture.acquire(hints(0, 'final')); maximum = Math.max(maximum, fixture.runtime.active); await delay(3); done++; release(); }));
  assert.equal(maximum, 6); assert.equal(done, 20); assert.equal(fixture.runtime.active, 0);
});

test('32逻辑槽最多24准确在途，fast可立即入场；无fast时准确任务仍全部结束', async () => {
  const queue = new PriorityQueue(32), gate = deferred(); let started = 0;
  const finals = Array.from({ length: 40 }, () => queue.add(0, signal(), async () => { started++; await gate.promise; }, 'final').promise);
  await until(() => started === 24); await delay(5); assert.equal(started, 24);
  let fastStarted = false; await queue.add(0, signal(), async () => { fastStarted = true; }, 'fast').promise; assert.equal(fastStarted, true);
  gate.resolve(); await Promise.all(finals); assert.equal(started, 40);
});

test('保留fast入口也不越过更高numeric final；默认4并发不保留', async () => {
  const queue = new PriorityQueue(8), gate = deferred(); let running = 0, fast = false;
  const active = Array.from({ length: 7 }, () => queue.add(0, signal(), async () => { running++; await gate.promise; }, 'final').promise);
  await until(() => running === 6);
  const low = queue.add(1, signal(), async () => { fast = true; }, 'fast'); await delay(10); assert.equal(fast, false);
  gate.resolve(); await Promise.all([...active, low.promise]); assert.equal(fast, true);
  const small = new PriorityQueue(4), wait = deferred(); let all = 0;
  const requests = Array.from({ length: 4 }, () => small.add(0, signal(), async () => { all++; await wait.promise; }, 'final').promise);
  await until(() => all === 4); wait.resolve(); await Promise.all(requests);
});

test('独立fast首次失标直接投影，accurate仍严格重试，原始坏正文不作initialTarget复用', async () => {
  for (const mode of ['fast', 'accurate']) {
    const requests = [], { core } = await setup(async (request) => { requests.push(request); return request.texts.map((text) => text.includes('<g') ? '遗漏标签的第一输出' : text === 'guide' ? '指南' : '请阅读指南。'); });
    const result = await run(core, input(undefined, mode)); assert.equal(result.text, '请阅读<g0>指南</g0>。');
    assert.equal(requests.filter((request) => request.texts[0].includes('<g')).length, mode === 'fast' ? 1 : 2);
    assert.equal(requests.filter((request) => request.texts[0] === 'Read guide.').length, 1);
    assert.equal(requests.length, mode === 'fast' ? 3 : 4); assert.equal(requests[0].quality, mode);
    assert.ok(requests.filter((request) => !request.texts[0].includes('<g')).every((request) => request.quality === 'accurate'), '语义恢复不走P2');
    assert.equal(result.timing.retries, requests.length - 1);
  }
});

test('综合同提供方仍准确profile且一份完整恢复，cheap fast缓存不晋级准确final；TM不变', async () => {
  const requests = [], { core, storage } = await setup(async (request) => { requests.push(request); return request.texts.map((text) => text.includes('<g') ? '缺标签' : text === 'guide' ? '指南' : '请阅读指南。'); });
  const fastJob = input(undefined, 'fast', { noCache: false }), fast = await run(core, fastJob); assert.equal(fast.cached, false); assert.equal(requests.length, 3);
  const fastEntry = await storage.cacheGet('en', 'zh-CN', 'fast', fastJob.segments[0].text); assert.match(fastEntry.version, /:fast-recovery-v1$/);
  const combined = input(undefined, 'combined', { noCache: false }), scope = core.createCombined(combined, combined.segments[0]);
  try {
    const [a, b] = await Promise.all([scope.translate('fast', signal()), scope.translate('accurate', signal())]);
    assert.equal(requests.length, 7); assert.ok(requests.slice(3).every((request) => request.quality === 'accurate'));
    assert.equal(a.text, b.text); assert.equal(a.cached, false); assert.equal(b.cached, false);
  } finally { scope.dispose(); }
  const precise = await storage.cacheGet('en', 'zh-CN', 'accurate', fastJob.segments[0].text); assert.ok(!precise.version.includes('fast-recovery'));
  await storage.tmPut('en', 'zh-CN', fastJob.segments[0].text, '请阅读<g0>使用指南</g0>。');
  assert.equal((await run(core, fastJob)).provider, 'memory'); assert.equal((await run(core, input(undefined, 'accurate', { noCache: false }))).provider, 'memory'); assert.equal(requests.length, 7);
});

test('旧fast缓存不能冒充新fast策略，未改的准确缓存仍可复用', async () => {
  let calls = 0; const { core, storage } = await setup(async ({ texts }) => { calls++; return texts.map(() => '新译文'); });
  await storage.cachePut('en', 'zh-CN', 'fast', 'Hello.', { text: '旧快速译文', provider: 'fixture', version: 'v1' });
  assert.equal((await run(core, input('Hello.', 'fast', { noCache: false }))).cached, false); assert.equal(calls, 1);
  await storage.cachePut('en', 'zh-CN', 'accurate', 'Hello.', { text: '准确缓存', provider: 'fixture', version: 'v1' });
  assert.equal((await run(core, input('Hello.', 'accurate', { noCache: false }))).text, '准确缓存'); assert.equal(calls, 1);
});

test('quality区分批次，动态优先级不拆同批，排队取消成员不再进入实际请求', async () => {
  const dispatch = deferred(), metadata = [], requests = [], batcher = new ProviderBatcher(async (_provider, _signal, run, scheduling) => { metadata.push(scheduling); await dispatch.promise; return run(); });
  const service = provider(async (request) => { requests.push(request); return request.texts; }, { limits: { maxChars: 100, maxSegments: 10, concurrency: 1 } });
  const context = (abort) => ({ signal: abort, config: {}, log() {}, fetch() { throw Error(); } });
  let priority = 0; const abort = new AbortController();
  const req = (text, quality) => ({ texts: [text], sourceLang: 'en', targetLang: 'zh', quality });
  const a = batcher.request(service, req('drop', 'accurate'), abort.signal, context, undefined, { priority: () => priority, lane: () => 'fast' });
  const rejection = assert.rejects(a, { name: 'AbortError' });
  const b = batcher.request(service, req('stay', 'accurate'), signal(), context, undefined, hints(100, 'final'));
  const c = batcher.request(service, req('cheap', 'fast'), signal(), context, undefined, hints(0, 'fast'));
  await until(() => metadata.length === 2); assert.equal(metadata[0].priority(), 0); priority = -5; assert.equal(metadata[0].priority(), -5);
  abort.abort(); await rejection; assert.equal(metadata[0].priority(), 100); assert.equal(metadata[0].lane(), 'final');
  dispatch.resolve(); assert.deepEqual(await b, ['stay']); assert.deepEqual(await c, ['cheap']);
  assert.deepEqual(requests.map((request) => request.texts), [['stay'], ['cheap']]);
});

for (const reprioritize of [false, true]) test(`Core真实批次等待按动态优先级发槽（准确优先级${reprioritize ? '提升' : '保持低位'}）`, async () => {
  const starts = [], completions = new Map();
  const { core } = await setup(async (request) => { const text = request.texts[0], gate = deferred(); starts.push(text); completions.set(text, gate); await gate.promise; return ['译' + text]; });
  const first = run(core, input('first', 'accurate'));
  await until(() => starts.length === 1);
  let priority = 100;
  const old = run(core, input('older', 'accurate', { priority: 100 }), { priority: () => priority });
  await delay(15);
  const fast = run(core, input('fast', 'fast', { priority: 0 })); await delay(15);
  if (reprioritize) priority = -1;
  completions.get('first').resolve(); await first;
  const second = reprioritize ? 'older' : 'fast', third = reprioritize ? 'fast' : 'older';
  await until(() => starts.length === 2); assert.equal(starts[1], second); completions.get(second).resolve(); await (reprioritize ? old : fast);
  await until(() => starts.length === 3); assert.equal(starts[2], third); completions.get(third).resolve(); await (reprioritize ? fast : old);
});

test('429先记录冷却再释放实际槽，已经排队的下一批不能借微任务竞争超发', async () => {
  const gate = deferred(), starts = [];
  const { core } = await setup(async (request) => {
    starts.push(request.texts[0]);
    if (request.texts[0] === 'first') { await gate.promise; throw new ProviderError({ code: 'rate_limit', message: '429回放', retryable: true }); }
    return ['不能发出的请求'];
  });
  const first = run(core, input('first', 'accurate')), rejected = assert.rejects(first, (error) => error.info?.code === 'rate_limit');
  await until(() => starts.length === 1);
  const pending = run(core, input('second', 'accurate')), stopped = assert.rejects(pending, (error) => ['no_provider', 'rate_limit'].includes(error.info?.code));
  await delay(20); gate.resolve(); await Promise.all([rejected, stopped]);
  assert.deepEqual(starts, ['first']); assert.equal(core.snapshot().providers[0].circuit, 'open');
});

for (const action of ['pause', 'disable']) test(`用户${action}后未发批次不再dispatch，显式停用测试仍可单独执行`, async () => {
  const gate = deferred(), starts = [];
  const { core } = await setup(async (request) => { const text = request.texts[0]; starts.push(text); if (text === 'first') await gate.promise; return ['译文']; });
  const first = run(core, input('first', 'accurate')); await until(() => starts.length === 1);
  const pending = run(core, input('second', 'accurate')), stopped = assert.rejects(pending, (error) => error.info?.code === 'no_provider');
  await delay(20);
  if (action === 'pause') await core.action('fixture', 'pause'); else await core.save('fixture', false, {});
  await stopped; gate.resolve(); await first; assert.deepEqual(starts, ['first']);
  assert.equal((await core.test('fixture')).ok, true); assert.deepEqual(starts, ['first', 'Hello.']);
});

test('外部官方MT和gateway的格式重试不因fast而改变', async () => {
  for (const kind of ['mt', 'remote']) {
    const requests = [], { core } = await setup(async (request) => { requests.push(request); return request.texts.map((text) => text.includes('<g') ? '缺标签' : '指南'); }, { kind });
    assert.equal((await run(core, input('<g0>guide</g0>', 'fast'))).text, '<g0>指南</g0>');
    assert.equal(requests.filter((request) => request.texts[0].includes('<g')).length, 2);
    assert.equal(requests.at(-1).quality, 'accurate');
  }
});

test('fast的nested投影/叶子恢复均用accurate，正常纯文本长句块仍保留fast', async () => {
  const requests = [], { core } = await setup(async (request) => { requests.push(request); return request.texts; }, { limits: { maxChars: 18, maxSegments: 1, concurrency: 1 } });
  const text = 'Alpha beta. Gamma delta. Epsilon zeta.';
  assert.equal((await run(core, input(text, 'fast'))).text, text); assert.ok(requests.length > 1); assert.ok(requests.every((request) => request.quality === 'fast'));
  const nestedRequests = [], { core: nested } = await setup(async (request) => {
    nestedRequests.push(request); return request.texts.map((value) => value === 'guide' ? '指南' : value === 'Read guide' ? '阅读指南' : '阅读指南。');
  });
  await run(nested, input('<g0>Read <g1>guide</g1></g0>.', 'fast'));
  assert.ok(nestedRequests.length); assert.ok(nestedRequests.every((request) => request.quality === 'accurate'));
});
