import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PriorityQueue } = require('../.compiled/backend/scheduler/queue.js');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('队列：已取消任务绝不运行，abort 监听器清理', async () => {
  const queue = new PriorityQueue(1);
  const controller = new AbortController();
  let calls = 0;
  const task = queue.add(0, controller.signal, async () => { calls++; });
  const rejection = assert.rejects(task.promise, { name: 'AbortError' });
  controller.abort();
  await rejection;
  await tick();
  assert.equal(calls, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('队列：正常完成和失败后均清理监听器', async () => {
  const queue = new PriorityQueue(2);
  const success = new AbortController();
  const failure = new AbortController();
  const a = queue.add(0, success.signal, async () => '译文');
  const b = queue.add(0, failure.signal, async () => { throw new Error('测试失败'); });
  const rejection = assert.rejects(b.promise, /测试失败/);
  assert.equal(await a.promise, '译文');
  await rejection;
  assert.equal(getEventListeners(success.signal, 'abort').length, 0);
  assert.equal(getEventListeners(failure.signal, 'abort').length, 0);
});

test('队列：取消运行中的任务释放并发槽，迟到 resolve 不会重复释放槽', async () => {
  const queue = new PriorityQueue(1);
  const controller = new AbortController();
  let resolveOld; let started = false;
  const old = queue.add(0, controller.signal, () => {
    started = true;
    return new Promise((resolve) => { resolveOld = resolve; });
  });
  const rejection = assert.rejects(old.promise, { name: 'AbortError' });
  while (!started) await tick();
  controller.abort();
  await rejection;
  assert.equal(await queue.add(0, new AbortController().signal, async () => '下一段').promise, '下一段');
  resolveOld('迟到译文');
  await tick();
  let active = 0; let maximum = 0;
  const pending = Array.from({ length: 4 }, () => queue.add(0, new AbortController().signal, async () => {
    active++; maximum = Math.max(maximum, active); await tick(); active--; return '完成';
  }).promise);
  await Promise.all(pending);
  assert.equal(maximum, 1);
});

test('队列：非法并发数立即拒绝，不留下永远不执行的任务', () => {
  for (const concurrency of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => new PriorityQueue(concurrency), RangeError);
});

test('队列：相同视口快速档先出队，每三次快速档为最终档留一个槽', async () => {
  const queue = new PriorityQueue(1), order = [];
  const final = queue.add(0, new AbortController().signal, async () => { order.push('final'); }, 'final');
  const fast = Array.from({ length: 6 }, (_, index) => queue.add(0, new AbortController().signal, async () => { order.push(`fast${index}`); }, 'fast'));
  await Promise.all([final.promise, ...fast.map((task) => task.promise)]);
  assert.deepEqual(order.slice(0, 4), ['fast0', 'fast1', 'fast2', 'final']);
});

test('队列：等待满一秒的后台最终档不能越过新到达的首屏快速档', async () => {
  let now = 0; const queue = new PriorityQueue(1, () => now), order = [];
  const old = queue.add(100, new AbortController().signal, async () => { order.push('old-final'); }, 'final');
  now = 1000;
  const visible = Array.from({ length: 4 }, (_, index) => queue.add(0, new AbortController().signal, async () => { order.push(`visible-fast${index}`); }, 'fast'));
  await Promise.all([old.promise, ...visible.map((task) => task.promise)]);
  assert.deepEqual(order, ['visible-fast0', 'visible-fast1', 'visible-fast2', 'visible-fast3', 'old-final']);
  const idle = queue.add(100, new AbortController().signal, async () => { order.push('idle'); }, 'fast');
  const final = queue.add(0, new AbortController().signal, async () => { order.push('visible-final'); }, 'final');
  await Promise.all([idle.promise, final.promise]); assert.deepEqual(order.slice(5), ['visible-final', 'idle']);
});

test('队列：等待满一秒的后台最终档不能越过新到达的首屏最终档', async () => {
  let now = 0; const queue = new PriorityQueue(1, () => now), order = [];
  const old = queue.add(100, new AbortController().signal, async () => { order.push('old-background-final'); }, 'final');
  now = 1000;
  const visible = queue.add(0, new AbortController().signal, async () => { order.push('new-visible-final'); }, 'final');
  await Promise.all([old.promise, visible.promise]);
  assert.deepEqual(order, ['new-visible-final', 'old-background-final']);
});
