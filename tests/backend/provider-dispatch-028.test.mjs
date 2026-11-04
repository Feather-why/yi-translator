import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { getEventListeners } from 'node:events';
const require = createRequire(import.meta.url), build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const { ProviderSlots } = require(path.join(build, 'backend/scheduler/provider-slots.js'));
const signal = () => new AbortController().signal;
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
function fixture(t, concurrency = 6) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const runtime = { active: 0, cooldown: 0, failures: 0, nextRequest: 0 }, queue = new ProviderSlots();
  let allowed = true;
  const access = { runtime: () => runtime, limits: () => ({ concurrency, qps: 20 }), allowed: () => allowed };
  return { queue, runtime, access, allow(value) { allowed = value; queue.wake(); },
    acquire(priority = 0, lane = 'final', abort = signal()) { return queue.acquire('p', access, abort, { priority: () => typeof priority === 'function' ? priority() : priority, lane: () => lane }); },
    async advance(ms) { t.mock.timers.tick(ms); await flush(); } };
}
test('dispatch-gate: 正常准备无固定双倍QPS等待，后续grant跟随实际发送起点', async (t) => {
  const f = fixture(t), a = await f.acquire(), first = await a.dispatch(); first(); a();
  let at; const b = f.acquire().then(async (lease) => { const mark = await lease.dispatch(); mark(); at = Date.now(); lease(); });
  await flush(); await f.advance(49); assert.equal(at, undefined); await f.advance(1); await b; assert.equal(at, 50);
  let next; const c = f.acquire().then(async (lease) => { const mark = await lease.dispatch(); mark(); next = Date.now(); lease(); });
  await f.advance(50); await c; assert.equal(next, 100);
});
test('dispatch-gate: 首批慢prepare后两个已grant请求仍不能同时发送', async (t) => {
  const f = fixture(t), a = await f.acquire(), pending = f.acquire(); await f.advance(50); const b = await pending;
  await f.advance(30); const mark = await a.dispatch(); mark(); a(); let at;
  const work = b.dispatch().then((dispatch) => { dispatch(); at = Date.now(); b(); });
  await flush(); await f.advance(49); assert.equal(at, undefined); await f.advance(1); await work; assert.equal(at, 130);
});
test('dispatch-gate: 等发送期间取消立即移除监听，不计发送、不影响下一有效请求', async (t) => {
  const f = fixture(t), a = await f.acquire(), abort = new AbortController(), waiting = f.acquire(0, 'fast', abort.signal);
  await f.advance(50); const b = await waiting; const first = await a.dispatch(); first(); a();
  const request = b.dispatch(), rejected = assert.rejects(request, { name: 'AbortError' }); await flush(); abort.abort(); await rejected; b();
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  let at; const next = f.acquire().then(async (lease) => { const mark = await lease.dispatch(); mark(); at = Date.now(); lease(); });
  await f.advance(50); await next; assert.equal(at, 100); assert.equal(f.runtime.active, 0);
});
test('dispatch-gate: 取消已grant但未发送的预约不消耗多余间隔', async (t) => {
  const f = fixture(t), a = await f.acquire(); a(); let granted = false;
  const next = f.acquire().then(async (lease) => { granted = true; const mark = await lease.dispatch(); mark(); lease(); });
  await flush(); await next; assert.equal(granted, true); assert.equal(Date.now(), 0);
});
test('dispatch-gate: 数值优先级和同层3:1公平在实际发送队列继续生效', async (t) => {
  const f = fixture(t, 8), leases = [], hints = [[0, 'final'], [0, 'fast'], [0, 'fast'], [0, 'fast'], [0, 'fast'], [1, 'fast']];
  for (const [priority, lane] of hints) { const next = f.acquire(priority, lane); await flush(); await f.advance(50); leases.push(await next); }
  const order = [], work = leases.map((lease, i) => lease.dispatch().then((mark) => { mark(); order.push(i); lease(); }));
  await flush(); for (let i = 0; i < 6; i++) await f.advance(50); await Promise.all(work);
  assert.deepEqual(order, [1, 2, 3, 0, 4, 5]); assert.equal(f.runtime.active, 0);
});
test('dispatch-gate: 等待期间pause拒绝未发送工作，恢复后可以继续', async (t) => {
  const f = fixture(t), a = await f.acquire(), waiting = f.acquire(); await f.advance(50); const b = await waiting;
  const mark = await a.dispatch(); mark(); a(); const pending = b.dispatch(), rejected = assert.rejects(pending, (e) => e.info.code === 'no_provider');
  f.allow(false); await rejected; b(); f.allow(true); await f.advance(50);
  const c = await f.acquire(), dispatch = await c.dispatch(); dispatch(); c(); assert.equal(f.runtime.active, 0);
});
for (const kind of ['paused', 'cooldown', 'exhausted', 'deleted']) test(`dispatch-gate: 无QPS慢准备后的${kind}也必须最终拒绝`, async () => {
  const runtime = { active: 0, cooldown: 0, failures: 0, nextRequest: 0 }, queue = new ProviderSlots(); let allowed = true, current = runtime;
  const lease = await queue.acquire('p', { runtime: () => current, limits: () => ({ concurrency: 1 }), allowed: () => allowed }, signal());
  if (kind === 'paused') allowed = false;
  if (kind === 'cooldown') runtime.cooldown = Date.now() + 1000;
  if (kind === 'exhausted') runtime.exhaustedUntil = Date.now() + 1000;
  if (kind === 'deleted') current = undefined;
  await assert.rejects(lease.dispatch(), (e) => e.info.code === 'no_provider'); lease(); assert.equal(runtime.active, 0);
});
for (const qps of [undefined, 20]) test(`dispatch-gate: permit返回后配置改变，在quota提交前同步复验（qps=${qps ?? 'none'}）`, async () => {
  const runtime = { active: 0, cooldown: 0, failures: 0, nextRequest: 0 }, queue = new ProviderSlots(); let allowed = true;
  const lease = await queue.acquire('p', { runtime: () => runtime, limits: () => ({ concurrency: 1, qps }), allowed: () => allowed }, signal());
  const permit = await lease.dispatch(); allowed = false; assert.throws(() => permit.validate(), (e) => e.info.code === 'no_provider'); lease(); assert.equal(runtime.active, 0);
});
