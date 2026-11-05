import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const { QuotaLedger } = require(path.join(build, 'backend/scheduler/quota.js'));
const { ProviderBatcher } = require(path.join(build, 'backend/scheduler/batcher.js'));
const { BackendCore } = require(path.join(build, 'backend/core.js'));
const { BackendStorage } = require(path.join(build, 'backend/storage.js'));
const { SecretVault } = require(path.join(build, 'backend/secrets.js'));
const { ProviderError, classifyError } = require(path.join(build, 'backend/providers/types.js'));
const quota = { unit: 'char', amount: 20, period: 'day' };
const delay = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function until(fn) { const end = Date.now() + 2500; while (!fn()) { assert.ok(Date.now() < end, '等待额度回放超时'); await delay(2); } }
function area(initial = {}) {
  const data = structuredClone(initial), writes = [];
  return { data, writes, beforeSet: undefined,
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); },
    async set(values) { if (this.beforeSet) await this.beforeSet(values); writes.push(structuredClone(values)); Object.assign(data, structuredClone(values)); } };
}
async function ledger(local = area(), now) {
  globalThis.chrome = { storage: { local } }; const value = new QuotaLedger(now); await value.ready(); return { value, local };
}
const pendingCount = (local) => Object.keys(local.data['backend.usage.pending'] ?? {}).length;

test('quota: 临时预留不写永久用量或同步，取消后余量可立即复用', async () => {
  const { value, local } = await ledger(), writes = local.writes.length, a = value.reserve('p', quota, 12);
  assert.equal(value.info('p', quota).used, 0); assert.equal(local.writes.length, writes);
  assert.throws(() => value.reserve('p', quota, 9), (e) => e.info.code === 'quota');
  await a.release(); const b = value.reserve('p', quota, 20); assert.equal(value.available('p', quota), false); await b.release(); assert.equal(value.available('p', quota), true);
  assert.equal(local.data['backend.usage'].p, undefined);
});
test('quota: release只释放自己的预留，不影响其他任务竞争', async () => {
  const { value } = await ledger(), a = value.reserve('p', quota, 7), b = value.reserve('p', quota, 8);
  await a.release(); assert.throws(() => value.reserve('p', quota, 13), (e) => e.info.code === 'quota');
  await b.prepare(); b.dispatch(); await b.release(); assert.equal(value.info('p', quota).used, 8);
  await a.release(); await b.release(); assert.equal(value.info('p', quota).used, 8);
});
test('quota: durable预备journal与used分开，dispatch提交且重启不重复归账', async () => {
  const { value, local } = await ledger(), a = value.reserve('p', quota, 6);
  await a.prepare(); assert.equal(value.info('p', quota).used, 0); assert.equal(local.data['backend.usage'].p?.used ?? 0, 0); assert.equal(pendingCount(local), 1);
  a.dispatch(); await a.release(); assert.equal(value.info('p', quota).used, 6); assert.equal(pendingCount(local), 0);
  const restarted = (await ledger(local)).value; assert.equal(restarted.info('p', quota).used, 6);
  const twice = (await ledger(local)).value; assert.equal(twice.info('p', quota).used, 6);
});
test('quota: 崩溃留下的prepared journal只保守归账一次', async () => {
  const { value, local } = await ledger(), a = value.reserve('p', quota, 5); await a.prepare();
  assert.equal(local.data['backend.usage'].p.used, 0); const restarted = (await ledger(local)).value;
  assert.equal(restarted.info('p', quota).used, 5); assert.equal(pendingCount(local), 0);
  const twice = (await ledger(local)).value; assert.equal(twice.info('p', quota).used, 5);
});
test('quota: prepare写入期间取消，持久化完成后清journal且不扣used', async () => {
  const { value, local } = await ledger(), waiting = gate(); let entered = false;
  local.beforeSet = async (next) => { if (Object.keys(next['backend.usage.pending'] ?? {}).length && !entered) { entered = true; await waiting.promise; } };
  const a = value.reserve('p', quota, 9), prepared = a.prepare(); await until(() => entered);
  const released = a.release(); waiting.resolve(); await Promise.all([prepared, released]);
  assert.equal(value.info('p', quota).used, 0); assert.equal(local.data['backend.usage'].p.used, 0); assert.equal(pendingCount(local), 0);
  assert.throws(() => a.dispatch(), (e) => e.info.code === 'no_provider'); assert.equal((await ledger(local)).value.info('p', quota).used, 0);
});
test('quota: 预备记录写失败不能dispatch，释放不会留下有效journal', async () => {
  const { value, local } = await ledger(); let fail = true;
  local.beforeSet = async (next) => { if (fail && Object.keys(next['backend.usage.pending'] ?? {}).length) { fail = false; throw Error('disk unavailable'); } };
  const a = value.reserve('p', quota, 4); await assert.rejects(a.prepare(), (e) => e.info.code === 'internal'); assert.throws(() => a.dispatch(), (e) => e.info.code === 'no_provider'); await a.release();
  assert.equal(value.info('p', quota).used, 0); assert.equal(pendingCount(local), 0);
});
test('quota: dispatch提交写失败仍保有耐久journal，重启保守归账不漏计', async () => {
  const { value, local } = await ledger(), a = value.reserve('p', quota, 6); await a.prepare(); let fail = true;
  local.beforeSet = async (next) => { if (fail && next['backend.usage']?.p?.used === 6) { fail = false; throw Error('commit disk unavailable'); } };
  a.dispatch(); await assert.rejects(a.release()); assert.equal(value.info('p', quota).used, 6); assert.equal(local.data['backend.usage'].p.used, 0); assert.equal(pendingCount(local), 1);
  const restarted = (await ledger(local)).value; assert.equal(restarted.info('p', quota).used, 6); assert.equal(pendingCount(local), 0);
});
test('quota: 本机预留不进入同步G-counter，merge增长后未发预留必须重新验余量', async () => {
  const { value, local } = await ledger(), a = value.reserve('p', quota, 12), resetAt = value.info('p', quota).resetAt;
  await value.mergeCounters({ p: { used: 10, resetAt, devices: { remote: 10 } } });
  assert.equal(local.data['backend.usage'].p.used, 10); await assert.rejects(a.prepare(), (e) => e.info.code === 'quota'); await a.release();
  assert.equal(value.info('p', quota).used, 10); assert.equal(pendingCount(local), 0);
});
test('quota: 已prepared后远端用量增长也不能突破预算发送', async () => {
  const { value } = await ledger(), a = value.reserve('p', quota, 12); await a.prepare();
  await value.mergeCounters({ p: { used: 10, resetAt: value.info('p', quota).resetAt, devices: { remote: 10 } } });
  assert.throws(() => a.dispatch(), (e) => e.info.code === 'quota'); await a.release(); assert.equal(value.info('p', quota).used, 10);
});
test('quota: 同设备重复merge与reload保持单调且不重复计已发送用量', async () => {
  const { value, local } = await ledger(), a = value.reserve('p', quota, 5); await a.prepare(); a.dispatch(); await a.release();
  const copy = structuredClone(local.data['backend.usage']); await value.mergeCounters(copy); await value.mergeCounters(copy); await value.reload(); assert.equal(value.info('p', quota).used, 5);
});
test('quota: 周期跨界的排队预留记入新周期，不继承上一周期used', async () => {
  let clock = new Date(2026, 10, 3, 23, 59, 59).getTime(); const { value, local } = await ledger(area(), () => clock);
  await value.charge('p', quota, 10); const a = value.reserve('p', quota, 6); clock += 2000;
  await a.prepare(); a.dispatch(); await a.release(); assert.equal(value.info('p', quota).used, 6); assert.equal(local.data['backend.usage'].p.used, 6);
});
test('quota: prepare持久化期间跨周期，先重新耐久化新周期再允许发送', async () => {
  let clock = new Date(2026, 10, 3, 23, 59, 59).getTime(); const { value, local } = await ledger(area(), () => clock); let rolled = false;
  local.beforeSet = async (next) => { if (!rolled && Object.keys(next['backend.usage.pending'] ?? {}).length) { rolled = true; clock += 2000; } };
  const a = value.reserve('p', quota, 5); await a.prepare(); const record = Object.values(local.data['backend.usage.pending'])[0]; assert.equal(record.resetAt, value.info('p', quota).resetAt);
  a.dispatch(); await a.release(); assert.equal(value.info('p', quota).used, 5);
});
test('quota: 过期journal不污染新周期，remove使未发送lease失效且不复活服务计数', async () => {
  const { value, local } = await ledger(), a = value.reserve('p', quota, 7); await a.prepare(); await value.remove('p');
  assert.throws(() => a.dispatch(), (e) => e.info.code === 'no_provider'); await a.release(); assert.equal(local.data['backend.usage'].p, undefined); assert.equal(pendingCount(local), 0);
  local.data['backend.usage.pending'] = { old: { provider: 'p', device: 'old', amount: 7, resetAt: Date.now() - 1 } };
  const restarted = (await ledger(local)).value; assert.equal(restarted.info('p', quota).used, 0);
});
test('quota: 后一项预备周期失效时，前一项有效lease也不能部分提交整个未发批次', async () => {
  let clock = new Date(2026, 10, 3, 23, 59, 59).getTime(); const { value, local } = await ledger(area(), () => clock);
  const b = value.reserve('p', quota, 6); await b.prepare(); clock += 2000;
  const a = value.reserve('p', quota, 4); await a.prepare();
  assert.throws(() => a.dispatch([a, b]), (e) => e.info.code === 'no_provider'); assert.equal(value.info('p', quota).used, 0);
  await a.release(); await b.release(); assert.equal(local.data['backend.usage'].p.used, 0); assert.equal(pendingCount(local), 0);
});
test('quota: 同批多成员统一提交，一次写入且幂等重复dispatch不重复计费', async () => {
  const { value, local } = await ledger(), a = value.reserve('p', quota, 4), b = value.reserve('p', quota, 6); await Promise.all([a.prepare(), b.prepare()]);
  const writes = local.writes.length; a.dispatch([a, b]); await Promise.all([a.release(), b.release()]);
  assert.equal(value.info('p', quota).used, 10); assert.equal(local.writes.length, writes + 1); a.dispatch([a, b]); assert.equal(value.info('p', quota).used, 10);
});

function service(translate, extra = {}) { return { id: 'fixture', name: 'fixture', version: 'v1', kind: 'local', official: true, auth: [], usedFor: ['fast', 'accurate', 'combined'],
  placeholders: 'prompt', limits: { maxChars: 1200, maxSegments: 1, concurrency: 1 }, freeQuota: { ...quota, amount: 100 }, translate, classifyError, ...extra }; }
async function coreSetup(translate, extra = {}, options = {}) {
  const local = area(); globalThis.chrome = { storage: { local } };
  const core = new BackendCore({ providers: [service(translate, extra)], storage: new BackendStorage({ memory: true }), vault: new SecretVault({ memory: true, storage: local }), ...options });
  await core.ready(); return { core, local };
}
const job = (text) => ({ jobId: crypto.randomUUID(), sourceLang: 'en', targetLang: 'zh-CN', mode: 'fast', priority: 1, noCache: true,
  context: { url: 'https://fixture.invalid' }, segments: [{ id: 's', text, kind: 'paragraph' }] });
const signal = () => new AbortController().signal;
function run(core, text, abort = signal()) { const j = job(text); return core.translate(j, j.segments[0], 'fast', abort); }

test('quota-core: 等真实槽取消零永久计费，首请求已发则保守计费', async () => {
  const waiting = gate(); let calls = 0;
  const { core, local } = await coreSetup(async ({ texts }) => { calls++; await waiting.promise; return texts; });
  const first = run(core, 'one'); await until(() => calls === 1);
  const abort = new AbortController(), second = run(core, 'unused', abort.signal), rejected = assert.rejects(second, { name: 'AbortError' });
  await delay(20); assert.equal(core.snapshot().providers[0].quota.used, 3); abort.abort(); await rejected; waiting.resolve(); await first;
  assert.equal(calls, 1); assert.equal(local.data['backend.usage'].fixture.used, 3); assert.equal(pendingCount(local), 0);
});
test('quota-core: 批次prepare期间取消一个成员，实际texts与计费只保留存活成员', async () => {
  const waiting = gate(); let prepared = false; const calls = [];
  const { core, local } = await coreSetup(async ({ texts }) => { calls.push(texts); return texts; }, { limits: { maxChars: 1200, maxSegments: 10, concurrency: 1 } });
  local.beforeSet = async (next) => { if (!prepared && Object.keys(next['backend.usage.pending'] ?? {}).length) { prepared = true; await waiting.promise; } };
  const abort = new AbortController(), a = run(core, 'drop', abort.signal), rejected = assert.rejects(a, { name: 'AbortError' }), b = run(core, 'stay');
  await until(() => prepared); abort.abort(); waiting.resolve(); await Promise.all([rejected, b]);
  assert.deepEqual(calls, [['stay']]); assert.equal(local.data['backend.usage'].fixture.used, 4); assert.equal(pendingCount(local), 0);
});
test('quota-core: prepare期间全部取消，零provider调用且重启零用量', async () => {
  const waiting = gate(); let prepared = false, calls = 0;
  const { core, local } = await coreSetup(async ({ texts }) => { calls++; return texts; });
  local.beforeSet = async (next) => { if (!prepared && Object.keys(next['backend.usage.pending'] ?? {}).length) { prepared = true; await waiting.promise; } };
  const abort = new AbortController(), a = run(core, 'cancelled', abort.signal), rejected = assert.rejects(a, { name: 'AbortError' });
  await until(() => prepared); abort.abort(); waiting.resolve(); await rejected;
  assert.equal(calls, 0); assert.equal(local.data['backend.usage'].fixture.used, 0); assert.equal(pendingCount(local), 0); assert.equal((await ledger(local)).value.info('fixture', { ...quota, amount: 100 }).used, 0);
});
test('quota-core: prepare持久化失败禁止发出provider请求，也不误熔断上游', async () => {
  let calls = 0, failed = false;
  const { core, local } = await coreSetup(async ({ texts }) => { calls++; return texts; });
  local.beforeSet = async (next) => { if (!failed && Object.keys(next['backend.usage.pending'] ?? {}).length) { failed = true; throw Error('disk full'); } };
  await assert.rejects(run(core, 'unused'), (e) => e.info.code === 'internal'); assert.equal(calls, 0); assert.equal(core.snapshot().providers[0].circuit, 'closed'); assert.equal(local.data['backend.usage'].fixture.used, 0);
});
test('quota-core: 已调度失败仍计费，批次同一基础设施故障仅记一次', async () => {
  let calls = 0;
  const { core, local } = await coreSetup(async () => { calls++; throw new ProviderError({ code: 'server', message: 'failed generation', retryable: true }); }, { limits: { maxChars: 1200, maxSegments: 10, concurrency: 1 } });
  await Promise.all([assert.rejects(run(core, 'one')), assert.rejects(run(core, 'two'))]);
  assert.equal(calls, 1); assert.equal(local.data['backend.usage'].fixture.used, 6); assert.equal(core.snapshot().providers[0].circuit, 'closed');
});
test('quota-core: 额度竞争只允许合法预留，未发送的大请求不耗尽短请求可用余量', async () => {
  let calls = 0; const { core } = await coreSetup(async ({ texts }) => { calls++; return texts; }, { freeQuota: { ...quota, amount: 5 } });
  await assert.rejects(run(core, 'too long'), (e) => e.info.code === 'quota'); assert.equal(calls, 0); assert.equal(core.snapshot().providers[0].quota.used, 0);
  assert.equal((await run(core, 'Hi')).text, 'Hi'); assert.equal(calls, 1); assert.equal(core.snapshot().providers[0].quota.used, 2);
});
test('quota-core: combined共享实际工作只预留/提交一份字符预算', async () => {
  let calls = 0; const { core, local } = await coreSetup(async ({ texts }) => { calls++; await delay(5); return texts; });
  const j = { ...job('Hello'), mode: 'combined' }, scope = core.createCombined(j, j.segments[0]);
  try { await Promise.all([scope.translate('fast', signal()), scope.translate('accurate', signal())]); } finally { scope.dispose(); }
  assert.equal(calls, 1); assert.equal(local.data['backend.usage'].fixture.used, 5); assert.equal(pendingCount(local), 0);
});
test('quota-batcher: 已取消成员的prepare拒绝不拖失败仍存活成员', async () => {
  const waiting = gate(), batcher = new ProviderBatcher(), calls = []; let preparing = false, committed = 0;
  const provider = service(async ({ texts }) => { calls.push(texts); return texts; }, { limits: { maxChars: 1200, maxSegments: 10, concurrency: 1 } });
  const context = (abort) => ({ signal: abort, config: {}, log() {} }), abort = new AbortController();
  const request = (text) => ({ texts: [text], sourceLang: 'en', targetLang: 'zh-CN' });
  const a = batcher.request(provider, request('drop'), abort.signal, context, undefined, undefined,
    { async prepare() { preparing = true; await waiting.promise; throw Error('cancelled preparation'); }, dispatch() { throw Error('cancelled lease cannot dispatch'); } });
  const rejected = assert.rejects(a, { name: 'AbortError' });
  const b = batcher.request(provider, request('stay'), signal(), context, undefined, undefined,
    { async prepare() {}, dispatch(leases) { committed += leases.length; } });
  await until(() => preparing); abort.abort(); waiting.resolve(); await rejected; assert.deepEqual(await b, ['stay']); assert.equal(committed, 1); assert.deepEqual(calls, [['stay']]);
});
for (const concurrency of [1, 6]) test(`quota-qps: 慢journal后真实HTTP仍保持发送间隔（concurrency=${concurrency}）`, async () => {
  const starts = []; let slowed = false;
  const { core, local } = await coreSetup(async (req, ctx) => [await (await ctx.fetch('https://fixture.invalid/translate')).text()],
    { limits: { maxChars: 1200, maxSegments: 1, concurrency, qps: 20 } },
    { fetch: async () => { starts.push(performance.now()); await delay(3); return new Response('译文'); } });
  local.beforeSet = async (next) => { if (!slowed && Object.keys(next['backend.usage.pending'] ?? {}).length) { slowed = true; await delay(80); } };
  await Promise.all(['first', 'second', 'third'].map((text) => run(core, text)));
  assert.equal(starts.length, 3); assert.ok(starts.slice(1).every((at, index) => at - starts[index] >= 45), JSON.stringify(starts.map((at) => Math.round(at - starts[0]))));
  assert.equal(local.data['backend.usage'].fixture.used, 16);
});
test('quota-qps: 等实际发送gate时取消，零永久提交且下一有效请求只等剩余间隔', async () => {
  const calls = []; let slowed = false;
  const { core, local } = await coreSetup(async (req, ctx) => [await (await ctx.fetch('https://fixture.invalid/translate', { body: req.texts[0] })).text()],
    { limits: { maxChars: 1200, maxSegments: 1, concurrency: 6, qps: 10 } },
    { fetch: async (_url, init) => { calls.push({ text: init.body, at: performance.now() }); return new Response('译文'); } });
  local.beforeSet = async (next) => { if (!slowed && Object.keys(next['backend.usage.pending'] ?? {}).length) { slowed = true; await delay(150); } };
  // 缓存摘要是异步的。先让 first 进入慢 journal，否则 cancelled 可能抢先发送并已经完成。
  const first = run(core, 'first');
  await until(() => slowed);
  const abort = new AbortController();
  const second = run(core, 'cancelled', abort.signal);
  const rejected = assert.rejects(second, { name: 'AbortError' });
  await until(() => calls[0]?.text === 'first' && Object.values(local.data['backend.usage.pending'] ?? {}).some(record => record.amount === 'cancelled'.length));
  abort.abort(); await rejected; await first;
  await run(core, 'third'); assert.deepEqual(calls.map((x) => x.text), ['first', 'third']);
  assert.ok(calls[1].at - calls[0].at >= 90); assert.ok(calls[1].at - calls[0].at < 190, '不重复等两份100ms间隔');
  assert.equal(local.data['backend.usage'].fixture.used, 10); assert.equal(pendingCount(local), 0);
});
test('quota-qps: adapter异步签名不能让真实HTTP相互追上，gate保留到首次fetch', async () => {
  const calls = []; let signing = false;
  const { core } = await coreSetup(async (req, ctx) => { if (req.texts[0] === 'first') { signing = true; await delay(75); } return [await (await ctx.fetch('https://fixture.invalid/translate', { body: req.texts[0] })).text()]; },
    { limits: { maxChars: 1200, maxSegments: 1, concurrency: 6, qps: 20 } },
    { fetch: async (_url, init) => { calls.push({ text: init.body, at: performance.now() }); return new Response('译文'); } });
  // 先确认首请求进入签名；并发缓存摘要的完成顺序不是本项要验证的发送 gate 顺序。
  const first = run(core, 'first'); await until(() => signing);
  await Promise.all([first, run(core, 'second')]); assert.deepEqual(calls.map((x) => x.text), ['first', 'second']); assert.ok(calls[1].at - calls[0].at >= 45);
});
for (const action of ['pause', 'disable']) test(`quota-qps: 无QPS的slow prepare期间${action}，永久提交前复验且零请求`, async () => {
  const waiting = gate(); let entered = false, calls = 0;
  const { core, local } = await coreSetup(async ({ texts }) => { calls++; return texts; });
  local.beforeSet = async (next) => { if (!entered && Object.keys(next['backend.usage.pending'] ?? {}).length) { entered = true; await waiting.promise; } };
  const pending = run(core, 'unspent'), rejected = assert.rejects(pending, (e) => e.info.code === 'no_provider'); await until(() => entered);
  if (action === 'pause') await core.action('fixture', 'pause'); else await core.save('fixture', false, {});
  waiting.resolve(); await rejected; assert.equal(calls, 0); assert.equal(local.data['backend.usage'].fixture.used, 0); assert.equal(pendingCount(local), 0);
});
for (const reason of ['failure', 'cancel']) test(`quota-qps: 首次HTTP前签名${reason}仍释放gate给后续请求`, async () => {
  const calls = []; let signing = false;
  const { core } = await coreSetup(async (req, ctx) => {
    if (req.texts[0] === 'first') { signing = true; await delay(75); if (reason === 'failure') throw new ProviderError({ code: 'bad_input', message: 'signature preparation failed', retryable: false }); }
    return [await (await ctx.fetch('https://fixture.invalid/translate', { body: req.texts[0] })).text()];
  }, { limits: { maxChars: 1200, maxSegments: 1, concurrency: 6, qps: 20 } },
  { fetch: async (_url, init) => { calls.push(init.body); return new Response('译文'); } });
  const abort = new AbortController(), first = run(core, 'first', abort.signal), rejected = assert.rejects(first), second = run(core, 'second');
  await until(() => signing); if (reason === 'cancel') abort.abort(); await rejected; await second; assert.deepEqual(calls, ['second']);
});
