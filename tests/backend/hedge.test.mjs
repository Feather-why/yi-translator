import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { raceWithHedge } = require('../.compiled/backend/scheduler/hedge.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('对冲：首选及时完成不发送第二份', async () => {
  let secondary = 0;
  assert.equal(await raceWithHedge(async () => 'first', async () => { secondary++; return 'second'; }, 20, new AbortController().signal), 'first');
  await sleep(30); assert.equal(secondary, 0);
});
test('对冲：第二份先完成时取消首选，迟到结果不覆盖', async () => {
  let firstSignal;
  const value = await raceWithHedge(async (signal) => { firstSignal = signal; await sleep(40); return 'late'; }, async () => 'second', 5, new AbortController().signal);
  assert.equal(value, 'second'); assert.equal(firstSignal.aborted, true);
  await sleep(45);
});
test('对冲：首选失败立即切换，两份均失败才拒绝', async () => {
  const start = performance.now();
  assert.equal(await raceWithHedge(async () => { throw new Error('first'); }, async () => 'second', 1000, new AbortController().signal), 'second');
  assert.ok(performance.now() - start < 500);
  await assert.rejects(raceWithHedge(async () => { throw new Error('first'); }, async () => { throw new Error('second'); }, 1000, new AbortController().signal), /second/);
});
test('对冲：父任务取消终止两份且不产生迟到回包', async () => {
  const parent = new AbortController(), signals = [];
  const run = async (signal) => { signals.push(signal); await sleep(40); return 'late'; };
  const result = raceWithHedge(run, run, 1, parent.signal);
  await sleep(8); parent.abort(); await assert.rejects(result, (error) => error.name === 'AbortError');
  assert.equal(signals.length, 2); assert.ok(signals.every((signal) => signal.aborted));
});
