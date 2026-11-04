import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TranslatePort } = require('../.compiled/backend/ports/translate.js');
const { ProviderError } = require('../.compiled/backend/providers/types.js');
const { checkPlaceholders } = require('../.compiled/shared/placeholders.js');

class Event {
  listeners = new Set();
  addListener(fn) { this.listeners.add(fn); }
  removeListener(fn) { this.listeners.delete(fn); }
  emit(...args) { for (const fn of [...this.listeners]) fn(...args); }
}

class FakePort {
  name = 'tx:translate';
  onMessage = new Event();
  onDisconnect = new Event();
  messages = [];
  postMessage(message) { this.messages.push(structuredClone(message)); }
  send(message) { this.onMessage.emit(message, this); }
  disconnect() { this.onDisconnect.emit(this); }
}

function job(id = 'job', overrides = {}) {
  return {
    jobId: id, sourceLang: 'en', targetLang: 'zh-CN', mode: 'fast', priority: 0,
    context: { url: 'https://example.test/article', title: '合约测试' },
    segments: [{ id: 's1', text: 'Hello world.', kind: 'paragraph' }],
    ...overrides,
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const result = (text = '你好，世界。', provider = 'fixture', cached = false) => ({ text, provider, cached });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(predicate, message = '后端未在时限内完成操作') {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await tick();
  }
}

function attach(t, translate, concurrency = 4) {
  const port = new FakePort();
  const backend = new TranslatePort(port, { translate }, concurrency);
  t.after(() => backend.dispose());
  return port;
}

const done = (port, stage, id) => port.messages.filter((m) =>
  m.type === 'job-done' && m.stage === stage && (!id || m.jobId === id));

for (const mode of ['fast', 'accurate']) {
  test(`${mode}：逐段返回，每段只有一个 final，随后一次 job-done`, async (t) => {
    const pending = new Map();
    const port = attach(t, (request, segment, tier) => {
      assert.equal(tier, mode);
      const task = deferred(); pending.set(segment.id, task); return task.promise;
    });
    port.send({ type: 'job', job: job(mode, { mode, segments: [
      { id: 's1', text: 'One.', kind: 'paragraph' },
      { id: 's2', text: 'Two.', kind: 'paragraph' },
    ] }) });
    await until(() => pending.size === 2);
    pending.get('s2').resolve(result('二。'));
    await until(() => port.messages.some((m) => m.type === 'result'));
    assert.deepEqual(port.messages.map((m) => [m.type, m.segmentId, m.stage]), [['result', 's2', 'final']]);
    pending.get('s1').resolve(result('一。'));
    await until(() => done(port, 'final').length === 1);
    assert.equal(port.messages.filter((m) => m.type === 'result').length, 2);
    assert.deepEqual(port.messages.at(-1), { type: 'job-done', jobId: mode, stage: 'final' });
    assert.equal(done(port, 'fast').length, 0);
  });
}

test('服务失败：每段恰好一个 final 错误，并结束 job', async (t) => {
  const port = attach(t, async () => {
    throw new ProviderError({ code: 'quota', message: '测试额度已用尽', provider: 'fixture', retryable: false });
  });
  port.send({ type: 'job', job: job() });
  await until(() => done(port, 'final').length === 1);
  const errors = port.messages.filter((m) => m.type === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].stage, 'final');
  assert.equal(errors[0].segmentId, 's1');
  assert.equal(errors[0].error.code, 'quota');
  assert.equal(port.messages.filter((m) => m.type === 'result').length, 0);
});

test('combined：两档并行，fast 在 final 前，各阶段只结束一次', async (t) => {
  const pending = new Map();
  const port = attach(t, (request, segment, tier) => {
    const task = deferred(); pending.set(tier, task); return task.promise;
  });
  port.send({ type: 'job', job: job('combined', { mode: 'combined' }) });
  await until(() => pending.size === 2, '综合模式必须并行启动两个档位');
  pending.get('fast').resolve(result('高速译文', 'fast-fixture'));
  await until(() => done(port, 'fast').length === 1);
  assert.equal(done(port, 'final').length, 0);
  pending.get('accurate').resolve(result('精确译文', 'accurate-fixture'));
  await until(() => done(port, 'final').length === 1);
  assert.deepEqual(port.messages.filter((m) => m.type === 'result').map((m) => [m.stage, m.provider]), [
    ['fast', 'fast-fixture'], ['final', 'accurate-fixture'],
  ]);
  assert.equal(done(port, 'fast').length, 1);
});

test('combined：final 先到时跳过 fast，迟到的 fast 不得覆盖 final', async (t) => {
  const pending = new Map();
  const port = attach(t, (request, segment, tier) => {
    const task = deferred(); pending.set(tier, task); return task.promise;
  });
  port.send({ type: 'job', job: job('combined', { mode: 'combined' }) });
  await until(() => pending.size === 2);
  pending.get('accurate').resolve(result('精确缓存', 'accurate-fixture', true));
  await until(() => done(port, 'final').length === 1);
  pending.get('fast').resolve(result('迟到的高速译文'));
  await until(() => done(port, 'fast').length === 1);
  await tick();
  assert.deepEqual(port.messages.filter((m) => m.type === 'result').map((m) => m.stage), ['final']);
  assert.equal(done(port, 'final').length, 1);
  assert.equal(done(port, 'fast').length, 1);
});

test('combined：fast 失败不影响 final，两个阶段仍有完成通知', async (t) => {
  const port = attach(t, async (request, segment, tier) => {
    if (tier === 'fast') throw new Error('测试高速服务离线');
    return result('精确译文');
  });
  port.send({ type: 'job', job: job('combined', { mode: 'combined' }) });
  await until(() => done(port, 'fast').length === 1 && done(port, 'final').length === 1);
  const finals = port.messages.filter((m) => m.stage === 'final' && m.type !== 'job-done');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].type, 'result');
});

test('combined：同一 tick 两档完成时，final 之后不得出现 fast', async (t) => {
  const pending = new Map();
  const port = attach(t, (request, segment, tier) => {
    const task = deferred(); pending.set(tier, task); return task.promise;
  });
  port.send({ type: 'job', job: job('same-tick', { mode: 'combined' }) });
  await until(() => pending.size === 2);
  pending.get('accurate').resolve(result('先完成的精确译文'));
  pending.get('fast').resolve(result('同轮完成的高速译文'));
  await until(() => done(port, 'final').length === 1 && done(port, 'fast').length === 1);
  assert.deepEqual(port.messages.filter((m) => m.type === 'result').map((m) => m.stage), ['final']);
});

test('部分取消：取消片段 abort 且无迟到消息，其他片段正常完成', async (t) => {
  const pending = new Map();
  const port = attach(t, (request, segment, tier, signal) => {
    const task = deferred(); pending.set(segment.id, { ...task, signal }); return task.promise;
  });
  port.send({ type: 'job', job: job('partial', { segments: [
    { id: 'cancelled', text: 'Cancel.', kind: 'paragraph' },
    { id: 'retained', text: 'Keep.', kind: 'paragraph' },
  ] }) });
  await until(() => pending.size === 2);
  port.send({ type: 'cancel', jobId: 'partial', segmentIds: ['cancelled'] });
  assert.equal(pending.get('cancelled').signal.aborted, true);
  pending.get('cancelled').resolve(result('不应发送'));
  pending.get('retained').resolve(result('保留'));
  await until(() => done(port, 'final').length === 1);
  assert.equal(port.messages.some((m) => m.segmentId === 'cancelled'), false);
  assert.deepEqual(port.messages.filter((m) => m.type === 'result').map((m) => m.segmentId), ['retained']);
});

test('整 job 取消：结果、错误及 job-done 均不再发送', async (t) => {
  const tasks = [];
  const port = attach(t, (request, segment, tier, signal) => {
    const task = deferred(); tasks.push({ ...task, signal }); return task.promise;
  });
  port.send({ type: 'job', job: job('cancel', { mode: 'combined' }) });
  await until(() => tasks.length === 2);
  port.send({ type: 'cancel', jobId: 'cancel' });
  assert.ok(tasks.every((task) => task.signal.aborted));
  tasks[0].resolve(result()); tasks[1].reject(new Error('取消后的迟到错误'));
  await tick(); await tick();
  assert.deepEqual(port.messages, []);
});

test('断开连接：取消所有网络任务、移除监听器，禁止迟到回包', async (t) => {
  const pending = deferred(); let signal;
  const port = attach(t, (request, segment, tier, abortSignal) => { signal = abortSignal; return pending.promise; });
  port.send({ type: 'job', job: job() });
  await until(() => signal);
  port.disconnect();
  assert.equal(signal.aborted, true);
  pending.resolve(result());
  await tick(); await tick();
  assert.deepEqual(port.messages, []);
  assert.equal(port.onMessage.listeners.size, 0);
  assert.equal(port.onDisconnect.listeners.size, 0);
});

test('同 jobId 重发：只返回新片段集合，旧请求不能发送迟到结果', async (t) => {
  const tasks = [];
  const port = attach(t, (request, segment, tier, signal) => {
    const task = deferred(); tasks.push({ ...task, segmentId: segment.id, signal }); return task.promise;
  });
  port.send({ type: 'job', job: job('retry', { segments: [
    { id: 'already-complete', text: 'Old.', kind: 'paragraph' },
    { id: 'remaining', text: 'Remaining.', kind: 'paragraph' },
  ] }) });
  await until(() => tasks.length === 2);
  port.send({ type: 'job', job: job('retry', { segments: [
    { id: 'remaining', text: 'Remaining.', kind: 'paragraph' },
  ] }) });
  await until(() => tasks.length === 3);
  assert.ok(tasks.slice(0, 2).every((task) => task.signal.aborted));
  tasks[0].resolve(result('旧一')); tasks[1].resolve(result('旧二'));
  tasks[2].resolve(result('重连后的新结果'));
  await until(() => done(port, 'final').length === 1);
  await tick();
  assert.deepEqual(port.messages.filter((m) => m.type === 'result').map((m) => [m.segmentId, m.text]), [
    ['remaining', '重连后的新结果'],
  ]);
  assert.equal(done(port, 'final').length, 1);
});

test('同 job 内重复片段 id 去重，不重复翻译或回包', async (t) => {
  let calls = 0;
  const port = attach(t, async () => { calls++; return result(); });
  const segment = { id: 'same', text: 'Hello.', kind: 'paragraph' };
  port.send({ type: 'job', job: job('dedupe', { segments: [segment, { ...segment }] }) });
  await until(() => done(port, 'final').length === 1);
  assert.equal(calls, 1);
  assert.equal(port.messages.filter((m) => m.type === 'result').length, 1);
});

test('新端口重连：同 jobId 只返回重发的剩余片段', async (t) => {
  const port = attach(t, async (request, segment) => result(segment.text));
  port.send({ type: 'job', job: job('reconnect', { segments: [
    { id: 'remaining', text: 'Still pending.', kind: 'paragraph' },
  ] }) });
  await until(() => done(port, 'final').length === 1);
  assert.deepEqual(port.messages.filter((m) => m.type === 'result').map((m) => m.segmentId), ['remaining']);
});

test('当前屏优先：同一 tick 后来的 priority=0 插到 priority=100 前面', async (t) => {
  const order = [];
  const port = attach(t, async (request) => { order.push(request.jobId); return result(); }, 1);
  port.send({ type: 'job', job: job('idle', { priority: 100 }) });
  port.send({ type: 'job', job: job('visible', { priority: 0 }) });
  await until(() => done(port, 'final').length === 2);
  assert.deepEqual(order, ['visible', 'idle']);
  assert.equal(port.messages.find((m) => m.type === 'result').jobId, 'visible');
});

test('滚动调整优先级：已排队片段按新 priority 出队', async (t) => {
  const blocker = deferred(); const order = [];
  const port = attach(t, async (request, segment) => {
    order.push(segment.id);
    if (request.jobId === 'blocker') return blocker.promise;
    return result();
  }, 1);
  port.send({ type: 'job', job: job('blocker', { segments: [{ id: 'blocker', text: 'Busy.', kind: 'paragraph' }] }) });
  await until(() => order.length === 1);
  port.send({ type: 'job', job: job('scroll', { priority: 100, segments: [
    { id: 'offscreen', text: 'Far away.', kind: 'paragraph' },
    { id: 'now-visible', text: 'Visible now.', kind: 'paragraph' },
  ] }) });
  port.send({ type: 'priority', jobId: 'scroll', segmentIds: ['now-visible'], priority: 0 });
  blocker.resolve(result());
  await until(() => done(port, 'final', 'scroll').length === 1);
  assert.deepEqual(order, ['blocker', 'now-visible', 'offscreen']);
});

test('强制服务与隐私标记透传：noCache/providerHint 原样交给服务', async (t) => {
  const port = attach(t, async (request) => {
    assert.equal(request.noCache, true);
    assert.equal(request.providerHint, 'deepl');
    return result('不缓存的新译文', 'deepl', false);
  });
  port.send({ type: 'job', job: job('flags', { noCache: true, providerHint: 'deepl' }) });
  await until(() => done(port, 'final').length === 1);
  const response = port.messages.find((m) => m.type === 'result');
  assert.equal(response.provider, 'deepl');
  assert.equal(response.cached, false);
});

test('缓存命中回包：provider 保留原服务 id，cached=true', async (t) => {
  const port = attach(t, async () => result('缓存中的译文', 'deepl', true));
  port.send({ type: 'job', job: job('cache') });
  await until(() => done(port, 'final').length === 1);
  const response = port.messages.find((m) => m.type === 'result');
  assert.equal(response.provider, 'deepl');
  assert.equal(response.cached, true);
});

test('占位符样例：嵌套、代码、网址、中英日混排均可逐段传递且通过校验', async (t) => {
  const cases = [
    ['Read <g0>the <g1>new</g1> guide</g0> and <x0/>.', '阅读<g0><g1>新</g1>指南</g0>和<x0/>。'],
    ['Visit <g2>example.com</g2>: <x1/> <x2/>', '访问<g2>示例网站</g2>：<x1/> <x2/>'],
    ['Hello 世界。<g3>日本語 <g4>link</g4></g3> <x3/>', '你好，世界。<g3>日语<g4>链接</g4></g3> <x3/>'],
  ];
  const translations = new Map(cases);
  const port = attach(t, async (request, segment) => result(translations.get(segment.text)));
  port.send({ type: 'job', job: job('placeholders', { segments: cases.map(([text], i) => ({
    id: `s${i}`, text, kind: 'paragraph',
  })) }) });
  await until(() => done(port, 'final').length === 1);
  for (const response of port.messages.filter((m) => m.type === 'result')) {
    const source = cases[Number(response.segmentId.slice(1))][0];
    assert.equal(checkPlaceholders(source, response.text).ok, true);
  }
  assert.equal(port.messages.filter((m) => m.type === 'result').length, cases.length);
});

test('不同端口同 jobId 相互隔离', async (t) => {
  const a = deferred(); const b = deferred();
  const portA = attach(t, () => a.promise);
  const portB = attach(t, () => b.promise);
  portA.send({ type: 'job', job: job('same-id') });
  portB.send({ type: 'job', job: job('same-id') });
  await tick();
  portA.send({ type: 'cancel', jobId: 'same-id' });
  a.resolve(result('不发送')); b.resolve(result('B 正常完成'));
  await until(() => done(portB, 'final').length === 1);
  assert.deepEqual(portA.messages, []);
  assert.equal(portB.messages.find((m) => m.type === 'result').text, 'B 正常完成');
});

test('空 job 也会完成，不留下悬挂的前端等待', async (t) => {
  const port = attach(t, async () => { assert.fail('空 job 不应调用服务'); });
  port.send({ type: 'job', job: job('empty', { mode: 'combined', segments: [] }) });
  await until(() => done(port, 'fast').length === 1 && done(port, 'final').length === 1);
  assert.equal(port.messages.length, 2);
});

test('combined：final 提前完成后 abort 仍在运行的 fast 请求', async (t) => {
  const pending = new Map();
  const port = attach(t, (request, segment, tier, signal) => {
    const task = deferred(); pending.set(tier, { ...task, signal }); return task.promise;
  });
  port.send({ type: 'job', job: job('abort-fast', { mode: 'combined' }) });
  await until(() => pending.size === 2);
  pending.get('accurate').resolve(result('精确译文'));
  await until(() => done(port, 'final').length === 1);
  assert.equal(pending.get('fast').signal.aborted, true);
  assert.equal(pending.get('accurate').signal.aborted, false);
  pending.get('fast').resolve(result('迟到结果'));
  await tick();
  assert.equal(port.messages.filter((message) => message.type === 'result').length, 1);
});

test('取消占用槽的请求后，即使服务忽略 abort，也能继续调度新 job', async (t) => {
  const hanging = deferred(); let started = false;
  const port = attach(t, (request) => {
    if (request.jobId === 'hanging') { started = true; return hanging.promise; }
    return Promise.resolve(result('可见内容'));
  }, 1);
  port.send({ type: 'job', job: job('hanging') });
  await until(() => started);
  port.send({ type: 'cancel', jobId: 'hanging' });
  port.send({ type: 'job', job: job('visible') });
  await until(() => done(port, 'final', 'visible').length === 1);
  hanging.resolve(result('不能发送的旧内容'));
  await tick();
  assert.equal(port.messages.some((message) => message.jobId === 'hanging'), false);
});

test('格式错误消息不会抛异常、取消正常 job 或调用翻译服务', async (t) => {
  const pending = deferred(); let calls = 0;
  const port = attach(t, () => { calls++; return pending.promise; });
  const invalidJobs = [
    null, {}, job('invalid', { segments: [null] }), job('invalid', { segments: [{}] }),
    job('invalid', { mode: 'other' }), job('invalid', { priority: NaN }),
    job('invalid', { context: null }), job('invalid', { noCache: 'true' }),
    job('invalid', { segments: Array(1) }),
  ];
  for (const invalid of invalidJobs) assert.doesNotThrow(() => port.send({ type: 'job', job: invalid }));
  for (const invalid of [null, [], true, 'job']) assert.doesNotThrow(() => port.send(invalid));
  await tick();
  assert.equal(calls, 0);
  port.send({ type: 'job', job: job('valid') });
  await until(() => calls === 1);
  for (const invalid of [
    { type: 'cancel', jobId: 'valid', segmentIds: 's1' },
    { type: 'priority', jobId: 'valid', priority: 0 },
    { type: 'priority', jobId: 'valid', priority: NaN, segmentIds: ['s1'] },
    { type: 'priority', jobId: 'valid', priority: 0, segmentIds: [null] },
  ]) assert.doesNotThrow(() => port.send(invalid));
  pending.resolve(result('正常结果'));
  await until(() => done(port, 'final', 'valid').length === 1);
  assert.equal(port.messages.find((message) => message.type === 'result').text, '正常结果');
});

test('combined：高速通道命中精确缓存时只发 final，并 abort 精确请求', async (t) => {
  const pending = new Map();
  const port = attach(t, (request, segment, tier, signal) => {
    const task = deferred(); pending.set(tier, { ...task, signal }); return task.promise;
  });
  port.send({ type: 'job', job: job('precise-cache', { mode: 'combined' }) });
  await until(() => pending.size === 2);
  pending.get('fast').resolve({ ...result('精确缓存译文', 'deepl', true), finalOnly: true });
  await until(() => done(port, 'final').length === 1);
  assert.equal(pending.get('accurate').signal.aborted, true);
  pending.get('accurate').reject(new Error('被取消后的迟到错误'));
  await tick();
  assert.deepEqual(port.messages.filter((message) => message.type === 'result'), [{
    type: 'result', jobId: 'precise-cache', segmentId: 's1', stage: 'final',
    text: '精确缓存译文', provider: 'deepl', cached: true,
  }]);
  assert.equal(port.messages.some((message) => 'finalOnly' in message), false);
  assert.equal(port.messages.some((message) => message.type === 'error'), false);
  assert.equal(done(port, 'fast').length, 1);
  assert.equal(done(port, 'final').length, 1);
});

for (const first of ['fast', 'accurate']) {
  test(`combined：精确缓存和精确通道同一 tick 完成（${first} 先）时 final 恰好一次`, async (t) => {
    const pending = new Map();
    const port = attach(t, (request, segment, tier) => {
      const task = deferred(); pending.set(tier, task); return task.promise;
    });
    port.send({ type: 'job', job: job('cache-race', { mode: 'combined' }) });
    await until(() => pending.size === 2);
    const settle = (tier) => pending.get(tier).resolve(tier === 'fast'
      ? { ...result('精确缓存译文', 'deepl', true), finalOnly: true }
      : result('精确通道译文', 'llamacpp'));
    settle(first); settle(first === 'fast' ? 'accurate' : 'fast');
    await until(() => done(port, 'final').length === 1 && done(port, 'fast').length === 1);
    await tick();
    const results = port.messages.filter((message) => message.type === 'result');
    assert.equal(results.length, 1);
    assert.equal(results[0].stage, 'final');
    assert.equal('finalOnly' in results[0], false);
    assert.equal(done(port, 'fast').length, 1);
    assert.equal(done(port, 'final').length, 1);
  });
}

test('combined：命中精确缓存前取消，两个通道迟到后均不发任何消息', async (t) => {
  const pending = new Map();
  const port = attach(t, (request, segment, tier, signal) => {
    const task = deferred(); pending.set(tier, { ...task, signal }); return task.promise;
  });
  port.send({ type: 'job', job: job('cancel-cache', { mode: 'combined' }) });
  await until(() => pending.size === 2);
  port.send({ type: 'cancel', jobId: 'cancel-cache' });
  pending.get('fast').resolve({ ...result('精确缓存译文', 'deepl', true), finalOnly: true });
  pending.get('accurate').resolve(result('精确通道译文'));
  await tick(); await tick();
  assert.equal(pending.get('fast').signal.aborted, true);
  assert.equal(pending.get('accurate').signal.aborted, true);
  assert.deepEqual(port.messages, []);
});

test('combined：精确缓存命中可取消尚未出队的精确请求，避免重复调用', async (t) => {
  const calls = [];
  const port = attach(t, async (request, segment, tier) => {
    calls.push(tier);
    return { ...result('用户译文记忆', 'memory', true), finalOnly: true };
  }, 1);
  port.send({ type: 'job', job: job('queued-cache', { mode: 'combined' }) });
  await until(() => done(port, 'final').length === 1);
  await tick();
  assert.deepEqual(calls, ['fast']);
  assert.equal(port.messages.filter((message) => message.type === 'result').length, 1);
  assert.equal(port.messages.find((message) => message.type === 'result').stage, 'final');
});
