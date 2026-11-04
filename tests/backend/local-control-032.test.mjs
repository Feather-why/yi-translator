import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const build = path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled');
const { NativeLocalControl, LOCAL_HOST, HELPER_HINT } = require(path.join(build, 'backend/local-control.js'));
const { createRpcHandlers } = require(path.join(build, 'backend/rpc.js'));
const { broadcastAlignmentReset } = require(path.join(build, 'backend/align-reset.js'));
function event() { const listeners = new Set(); return { listeners, addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => [...listeners].forEach(fn => fn(...args)) }; }
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture(t, reply) {
  const previous = globalThis.chrome, calls = [], ports = [];
  globalThis.chrome = { runtime: { id: 'test-id', getURL: name => 'chrome-extension://test-id/' + name }, tabs: { query: async () => [], sendMessage: async () => {} } };
  t.after(() => { globalThis.chrome = previous; });
  const connect = host => {
    assert.equal(host, LOCAL_HOST);
    const port = { onMessage: event(), onDisconnect: event(), closed: false, disconnect() { this.closed = true; },
      postMessage(message) { calls.push(message); if (reply) queueMicrotask(() => reply(message, port)); } };
    ports.push(port); return port;
  };
  return { calls, ports, client: new NativeLocalControl({ connect, timeoutMs: 1500 }), connect };
}
const state = enabled => ({ ok: true, data: { supported: true, enabled, canStart: true } });
test('local: 未安装助手明确提示，不假报已启用', async t => {
  fixture(t); const client = new NativeLocalControl();
  assert.deepEqual(await client.status(), { supported: false, enabled: false, canStart: false, hint: HELPER_HINT });
  assert.equal((await client.start()).ok, false);
  await assert.rejects(client.autostart(true), e => e.info.code === 'no_provider');
});
test('local: 并发查询共享一份连接，后续查询重新读取真实状态', async t => {
  let enabled = false; const f = fixture(t, (_, port) => port.onMessage.emit(state(enabled)));
  const values = await Promise.all([f.client.status(), f.client.status(), f.client.status()]);
  assert.ok(values.every(value => value.supported && !value.enabled)); assert.equal(f.calls.length, 1);
  enabled = true; assert.equal((await f.client.status()).enabled, true); assert.equal(f.calls.length, 2);
  assert.ok(f.ports.every(port => port.closed && port.onMessage.listeners.size === 0 && port.onDisconnect.listeners.size === 0));
});
test('local: 开关顺序串行，状态查询等最新写入，启动并发只发一次', async t => {
  const f = fixture(t); const first = f.client.autostart(true), second = f.client.autostart(false), status = f.client.status();
  await tick(); assert.deepEqual(f.calls, [{ action: 'autostart', enable: true }]);
  f.ports[0].onMessage.emit(state(true)); assert.equal((await first).enabled, true); await tick();
  assert.equal(f.calls[1].enable, false); f.ports[1].onMessage.emit(state(false)); await second; await tick();
  assert.equal(f.calls[2].action, 'status'); f.ports[2].onMessage.emit(state(false)); assert.equal((await status).enabled, false);
  const starts = [f.client.start(), f.client.start()]; await tick(); assert.equal(f.calls.length, 4);
  f.ports[3].onMessage.emit({ ok: true, data: { ok: true, message: '已经运行' } }); assert.ok((await Promise.all(starts)).every(r => r.ok));
});
test('local: 畸形结果和助手原始错误不会泄露正文或密钥', async t => {
  const f = fixture(t, (_, port) => port.onMessage.emit({ ok: false, error: { message: 'PRIVATE_API_KEY' } }));
  assert.ok(!JSON.stringify(await f.client.start()).includes('PRIVATE_API_KEY'));
  await assert.rejects(f.client.autostart(true), e => !e.message.includes('PRIVATE_API_KEY'));
  const malformed = new NativeLocalControl({ connect: () => { const p = f.connect(LOCAL_HOST); p.postMessage = () => queueMicrotask(() => p.onMessage.emit({ ok: true, data: { supported: true, enabled: 'yes' } })); return p; } });
  assert.equal((await malformed.status()).supported, false);
});
test('local: 断开、超时和dispose关闭原生端口，结束后不重连', async t => {
  const f = fixture(t); const status = f.client.status(); await tick(); f.ports[0].onDisconnect.emit(); assert.equal((await status).supported, false);
  const timed = new NativeLocalControl({ connect: f.connect, timeoutMs: 5 }); assert.equal((await timed.start()).ok, false);
  assert.equal(f.ports[1].closed, true);
  const pending = f.client.start(); await tick(); f.client.dispose(); assert.equal((await pending).ok, false);
  const count = f.ports.length; await f.client.status(); assert.equal(f.ports.length, count);
});
const admin = { id: 'test-id', url: 'chrome-extension://test-id/options.html#providers' };
const page = { id: 'test-id', url: 'https://example.org/', tab: { id: 7 } };
function rpcFixture(t) {
  fixture(t); const calls = [], resets = [], imports = [];
  chrome.tabs.query = async () => [{ id: 7 }, { id: 8 }, { id: undefined }, { id: -1 }];
  chrome.tabs.sendMessage = async (id, command) => { resets.push({ id, command }); if (id === 8) throw Error('页面没有内容脚本'); };
  const services = { dictionary: { importCsv: async csv => { imports.push(csv); if (csv === 'bad') throw Error('bad CSV'); return { count: 4 }; } } };
  const core = { probe: async id => { calls.push(['probe', id]); } };
  const localControl = { status: async () => { calls.push(['status']); return state(false).data; }, autostart: async enable => { calls.push(['autostart', enable]); return state(enable).data; }, start: async () => { calls.push(['start']); return { ok: true }; } };
  return { handlers: createRpcHandlers(core, services, { localControl }), calls, resets, imports };
}
test('local RPC: 查询/启动允许本扩展内容脚本，开机设置仅扩展管理页可写', async t => {
  const f = rpcFixture(t);
  assert.equal((await f.handlers['local:autostart']({}, page)).supported, true);
  assert.equal((await f.handlers['local:start'](undefined, page)).ok, true);
  await assert.rejects(f.handlers['local:autostart']({ enable: true }, page), e => e.info.code === 'auth');
  assert.equal((await f.handlers['local:autostart']({ enable: true }, admin)).enabled, true);
  for (const sender of [{}, { id: 'foreign', url: admin.url }]) {
    await assert.rejects(f.handlers['local:autostart']({}, sender), e => e.info.code === 'auth');
    await assert.rejects(f.handlers['local:start'](undefined, sender), e => e.info.code === 'auth');
  }
  assert.deepEqual(f.calls, [['status'], ['start'], ['probe', 'llamacpp'], ['autostart', true]]);
});
test('local RPC: 拒绝额外命令、路径和错误布尔值，不触达助手', async t => {
  const f = rpcFixture(t);
  for (const value of [null, [], { enable: 'yes' }, { enable: true, command: 'other' }]) await assert.rejects(f.handlers['local:autostart'](value, admin), e => e.info.code === 'bad_input');
  for (const value of [{}, { path: 'C:/anything' }, null]) await assert.rejects(f.handlers['local:start'](value, admin), e => e.info.code === 'bad_input');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.handlers['providers:templates'](undefined, admin), ['openai-compatible', 'llamacpp', 'remote-node', 'libretranslate', 'custom-http']);
});
test('dict: 导入提交成功后广播align-reset，关闭/受限标签页不影响导入', async t => {
  const f = rpcFixture(t);
  assert.deepEqual(await f.handlers['dict:import']({ csv: 'valid' }, admin), { ok: true, entries: 4 });
  assert.deepEqual(f.resets, [{ id: 7, command: { cmd: 'align-reset' } }, { id: 8, command: { cmd: 'align-reset' } }]);
  const before = f.resets.length;
  await assert.rejects(f.handlers['dict:import']({ csv: 'bad' }, admin));
  await assert.rejects(f.handlers['dict:import']({ csv: 'valid' }, page), e => e.info.code === 'auth');
  assert.equal(f.resets.length, before); assert.equal(f.imports.length, 2);
  await assert.doesNotReject(broadcastAlignmentReset({ query: async () => { throw Error('tabs unavailable'); }, sendMessage: async () => {} }));
});
