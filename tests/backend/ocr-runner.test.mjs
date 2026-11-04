import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OcrRunner, OcrWorkerUnavailableError } = require(path.join(path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled'), 'backend/media/ocr-runner.js'));
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function setup(t, create, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let now = 0;
  const runner = new OcrRunner({ create, now: () => now, timeoutMs: 200, initializeMs: 40, predictMs: 40, idleMs: 1000, maxQueued: 2, ...options });
  t.after(() => runner.dispose());
  return { runner, async advance(ms) { now += ms; t.mock.timers.tick(ms); await flush(); } };
}

test('OCR推理超时销毁旧容器并最多重建一次，迟到旧结果不覆盖新结果', async (t) => {
  const old = deferred(), destroyed = [], initialized = []; let created = 0;
  const { runner, advance } = setup(t, () => { const id = ++created; return {
    initialize: async () => { initialized.push(id); }, predict: async (data) => id === 1 ? old.promise : { id, data }, destroy: () => destroyed.push(id),
  }; });
  const result = runner.run('public-image'); await flush(); await advance(40);
  assert.deepEqual(await result, { id: 2, data: 'public-image' }); assert.deepEqual(destroyed, [1]);
  old.resolve({ id: 1, data: 'late' }); await flush();
  assert.deepEqual(await runner.run('next-image'), { id: 2, data: 'next-image' });
  assert.equal(created, 2); assert.deepEqual(initialized, [1, 2]);
});

test('OCR初始化超时也移除旧代，迟到初始化不能把旧模型重新标为ready', async (t) => {
  const old = deferred(), initialized = [], destroyed = []; let created = 0;
  const { runner, advance } = setup(t, () => { const id = ++created; return {
    initialize: async () => { initialized.push(id); if (id === 1) await old.promise; }, predict: async () => id, destroy: () => destroyed.push(id),
  }; });
  const result = runner.run('image'); await flush(); await advance(40);
  assert.equal(await result, 2); old.resolve(); await flush(); assert.equal(await runner.run('other'), 2);
  assert.deepEqual(initialized, [1, 2]); assert.deepEqual(destroyed, [1]);
});

test('连续两次超时即停止自动恢复，下一次明确请求仍能重新创建可用模型', async (t) => {
  const destroyed = []; let created = 0;
  const { runner, advance } = setup(t, () => { const id = ++created; return {
    initialize: async () => {}, predict: async () => id <= 2 ? new Promise(() => {}) : 'recovered', destroy: () => destroyed.push(id),
  }; });
  const result = runner.run('image'), rejected = assert.rejects(result, /推理超时/);
  await flush(); await advance(40); await advance(40); await rejected;
  assert.equal(created, 2); assert.deepEqual(destroyed, [1, 2]);
  assert.equal(await runner.run('new-explicit-request'), 'recovered'); assert.equal(created, 3);
});

test('OCR等待队列有界且按顺序执行，既有在途识别不并发访问同一模型', async (t) => {
  const gate = deferred(), order = []; let concurrent = 0, maxConcurrent = 0, created = 0;
  const { runner } = setup(t, () => { created++; return { initialize: async () => {}, destroy: () => {}, predict: async (data) => {
    order.push(data); concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    try { return data === 'one' ? await gate.promise : data; } finally { concurrent--; }
  } }; });
  const first = runner.run('one'); await flush();
  const second = runner.run('two'), third = runner.run('three');
  await assert.rejects(runner.run('over-bound'), /请求过多/);
  gate.resolve('one'); assert.deepEqual(await Promise.all([first, second, third]), ['one', 'two', 'three']);
  assert.deepEqual(order, ['one', 'two', 'three']); assert.equal(maxConcurrent, 1); assert.equal(created, 1);
});

test('总预算包含队列等待，已过期的排队图片不再解码或推理，也不额外重试', async (t) => {
  const firstGate = deferred(), secondGate = deferred(), predicted = []; let created = 0, destroyed = 0;
  const { runner, advance } = setup(t, () => { created++; return { initialize: async () => {}, destroy: () => { destroyed++; }, predict: async (data) => {
    predicted.push(data); return data === 'one' ? firstGate.promise : secondGate.promise;
  } }; }, { predictMs: 500 });
  const first = runner.run('one'); await flush();
  const second = runner.run('two'), third = runner.run('three');
  const rejected = Promise.all([assert.rejects(second, /总处理时间/), assert.rejects(third, /总处理时间/)]);
  await advance(50); firstGate.resolve('one'); assert.equal(await first, 'one'); await flush();
  await advance(150); await rejected;
  assert.deepEqual(predicted, ['one', 'two']); assert.equal(created, 1); assert.equal(destroyed, 1);
  secondGate.resolve('late'); await flush();
});

test('坏图片等模型明确失败不自动重复识别，但清掉故障实例供后续请求恢复', async (t) => {
  let created = 0, destroyed = 0;
  const { runner } = setup(t, () => { const id = ++created; return {
    initialize: async () => {}, destroy: () => { destroyed++; }, predict: async () => { if (id === 1) throw new Error('bad image'); return 'good image'; },
  }; });
  await assert.rejects(runner.run('bad'), /bad image/); assert.equal(created, 1); assert.equal(destroyed, 1);
  assert.equal(await runner.run('good'), 'good image'); assert.equal(created, 2);
});

test('容器通信失败允许一次受控重建，正常模型复用不会重复初始化', async (t) => {
  let created = 0, initialized = 0, destroyed = 0;
  const { runner } = setup(t, () => { const id = ++created; return {
    initialize: async () => { initialized++; if (id === 1) throw new OcrWorkerUnavailableError('frame closed'); },
    destroy: () => { destroyed++; }, predict: async () => id,
  }; });
  assert.equal(await runner.run('one'), 2); assert.equal(await runner.run('two'), 2);
  assert.equal(created, 2); assert.equal(initialized, 2); assert.equal(destroyed, 1);
});

test('仅真正空闲后销毁容器，新请求会清掉旧idle计时且不与释放交错', async (t) => {
  const destroyed = []; let created = 0;
  const { runner, advance } = setup(t, () => { const id = ++created; return { initialize: async () => {}, predict: async () => id, destroy: () => destroyed.push(id) }; });
  assert.equal(await runner.run('one'), 1); await flush(); await advance(1000); assert.deepEqual(destroyed, [1]);
  assert.equal(await runner.run('two'), 2); await flush(); await advance(500);
  assert.equal(await runner.run('three'), 2); await flush(); await advance(500); assert.deepEqual(destroyed, [1]);
  await advance(500); assert.deepEqual(destroyed, [1, 2]);
});

test('dispose立即拒绝在途和排队消费者，迟到结果不触发重建或再运行', async (t) => {
  const gate = deferred(); let created = 0, destroyed = 0;
  const { runner } = setup(t, () => { created++; return { initialize: async () => {}, predict: async () => gate.promise, destroy: () => { destroyed++; } }; });
  const first = runner.run('one'); await flush(); const queued = runner.run('two');
  const rejected = Promise.all([assert.rejects(first, /已关闭/), assert.rejects(queued, /已关闭/)]);
  runner.dispose(); await rejected; gate.resolve('late'); await flush();
  await assert.rejects(runner.run('three'), /已关闭/); assert.equal(created, 1); assert.equal(destroyed, 1);
});
