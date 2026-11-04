import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { StatusPort } = require((process.env.BACKEND_BUILD_DIR || fileURLToPath(new URL('../.compiled/', import.meta.url))) + '/backend/ports/status.js');

class Event {
  listeners = new Set();
  addListener(fn) { this.listeners.add(fn); }
  removeListener(fn) { this.listeners.delete(fn); }
  emit(...args) { for (const fn of [...this.listeners]) fn(...args); }
}

function setup(t, overrides = {}) {
  let push;
  let state = { at: 1, providers: [], nodes: [], events: [], perf: { samples: 0 } };
  let unsubscribed = 0;
  const calls = [];
  const port = {
    name: 'tx:status', messages: [], onMessage: new Event(), onDisconnect: new Event(),
    postMessage(message) { this.messages.push(structuredClone(message)); },
  };
  const service = {
    snapshot: () => state,
    subscribe(callback) { push = callback; return () => { unsubscribed++; }; },
    async probe(id) { calls.push(['probe', id]); state = { ...state, at: state.at + 1 }; },
    async action(id, action) { calls.push(['action', id, action]); state = { ...state, at: state.at + 1 }; },
    ...overrides,
  };
  const backend = new StatusPort(port, service);
  t.after(() => backend.dispose());
  return {
    port, backend, calls, push: () => push(), unsubscribed: () => unsubscribed,
    update: (next) => { state = { ...state, ...next }; push(); },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('状态端口：建立连接立即同步收到 snapshot', (t) => {
  const { port } = setup(t);
  assert.deepEqual(port.messages, [{
    type: 'snapshot', status: { at: 1, providers: [], nodes: [], events: [], perf: { samples: 0 } },
  }]);
});

test('状态端口：每5秒推送，普通状态变更在100ms窗口合并', async (t) => {
  let periodic;
  t.mock.method(globalThis, 'setInterval', (callback, delay) => {
    assert.equal(delay, 5000); periodic = callback; return 12345;
  });
  t.mock.method(globalThis, 'clearInterval', (handle) => assert.equal(handle, 12345));
  const { port, update } = setup(t);
  periodic();
  assert.equal(port.messages.length, 2);
  update({ at: 2, perf: { samples: 1, firstScreenMsP50: 320 } });
  assert.equal(port.messages.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.equal(port.messages.length, 3);
  assert.equal(port.messages.at(-1).status.perf.firstScreenMsP50, 320);
});

test('状态端口：probe 指定服务/全部服务，检测结束立即更新快照', async (t) => {
  const { port, calls } = setup(t);
  port.onMessage.emit({ type: 'probe', providerId: 'deepl' }, port);
  await tick();
  assert.deepEqual(calls, [['probe', 'deepl']]);
  assert.equal(port.messages.at(-1).status.at, 2);
  port.onMessage.emit({ type: 'probe' }, port);
  await tick();
  assert.deepEqual(calls.at(-1), ['probe', undefined]);
  assert.equal(port.messages.at(-1).status.at, 3);
});

test('状态端口：置顶/取消置顶/暂停/恢复均交给服务并更新状态', async (t) => {
  const { port, calls } = setup(t);
  for (const action of ['pin', 'unpin', 'pause', 'resume']) {
    port.onMessage.emit({ type: 'provider-action', providerId: 'microsoft', action }, port);
    await tick();
  }
  assert.deepEqual(calls, ['pin', 'unpin', 'pause', 'resume'].map((action) => ['action', 'microsoft', action]));
  assert.equal(port.messages.length, 5);
});

test('状态端口：断开时注销订阅和监听器，不再发送快照', (t) => {
  const { port, push, unsubscribed, backend } = setup(t);
  port.onDisconnect.emit(port);
  assert.equal(unsubscribed(), 1);
  assert.equal(port.onMessage.listeners.size, 0);
  assert.equal(port.onDisconnect.listeners.size, 0);
  push(); backend.dispose();
  assert.equal(unsubscribed(), 1);
  assert.equal(port.messages.length, 1);
});

test('状态端口：检测失败仍推送状态，不产生未处理的异常', async (t) => {
  const { port } = setup(t, { async probe() { throw new Error('检测服务离线'); } });
  port.onMessage.emit({ type: 'probe', providerId: 'llamacpp' }, port);
  await tick();
  assert.equal(port.messages.length, 2);
  assert.equal(port.messages.at(-1).type, 'snapshot');
});

test('状态端口：服务同步抛错也会被收束，随后继续处理其他消息', async (t) => {
  const { port, calls } = setup(t, { probe() { throw new Error('同步失败'); } });
  assert.doesNotThrow(() => port.onMessage.emit({ type: 'probe' }, port));
  await tick();
  port.onMessage.emit({ type: 'provider-action', providerId: 'deepl', action: 'pause' }, port);
  await tick();
  assert.deepEqual(calls, [['action', 'deepl', 'pause']]);
  assert.equal(port.messages.length, 3);
});

test('状态端口：未知或格式错误消息不会执行服务操作', async (t) => {
  const { port, calls } = setup(t);
  for (const invalid of [
    null, [], true, 'probe', {}, { type: 'probe', providerId: 7 },
    { type: 'provider-action', providerId: 'deepl', action: 'delete' },
    { type: 'provider-action', action: 'pin' },
  ]) assert.doesNotThrow(() => port.onMessage.emit(invalid, port));
  await tick();
  assert.deepEqual(calls, []);
  assert.equal(port.messages.length, 1);
});
