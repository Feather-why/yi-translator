import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fixtureToken, gatewayReplay, jsonResponse } from './gateway-replay.mjs';

const require = createRequire(import.meta.url), build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const compiled = (name) => require(path.join(build, 'backend', name + '.js'));
const remote = compiled('providers/remote-node').default;
const nodeContext = (replay) => ({ config: { url: 'http://fixture.invalid', token: fixtureToken }, signal: new AbortController().signal, log() {}, fetch: replay.fetch });

test('上游休眠但health正常时节点在线，loaded保持false且不发唤醒或生成请求', async () => {
  const urls = [], replay = gatewayReplay(async (url) => {
    urls.push(url); return jsonResponse(url.endsWith('/health') ? { status: 'ok' } : { is_sleeping: true });
  });
  const value = await (await replay.request('/v1/health')).json();
  assert.equal(value.ok, true); assert.equal(value.version, '0.2.3'); assert.deepEqual(value.models, [{ id: 'fixture', loaded: false }]);
  assert.deepEqual(urls.map((url) => new URL(url).pathname), ['/health', '/props']);
  const status = await remote.health(nodeContext(replay));
  assert.equal(status.ok, true); assert.equal(status.node.online, true); assert.equal(status.node.models[0].loaded, false);
  assert.equal(status.model, undefined); assert.equal(status.node.models[0].vramMB, undefined);
});

test('已加载上游的旧健康结构不变', async () => {
  const replay = gatewayReplay(async (url) => jsonResponse(url.endsWith('/health') ? { status: 'ok' } : { is_sleeping: false }));
  const value = await (await replay.request('/v1/health')).json();
  assert.equal(value.ok, true); assert.deepEqual(value.models, [{ id: 'fixture', loaded: true }]);
});

test('HTTP错误、未就绪或坏health响应仍离线，不借休眠兼容掩盖故障', async () => {
  for (const response of [() => jsonResponse({ status: 'ok' }, 503), () => jsonResponse({ status: 'ok' }, 401),
    () => jsonResponse({ status: 'loading' }), () => new Response('{bad-json')]) {
    const urls = [], replay = gatewayReplay(async (url) => { urls.push(url); return response(); });
    const value = await (await replay.request('/v1/health')).json();
    assert.equal(value.ok, false); assert.deepEqual(value.models, [{ id: 'fixture', loaded: false }]);
    assert.deepEqual(urls.map((url) => new URL(url).pathname), ['/health']);
  }
});

test('props连接或解析异常仍保守离线，旧上游不提供props时保持已有兼容', async () => {
  for (const props of [async () => { throw Error('fixture offline'); }, async () => new Response('{bad-json')]) {
    const replay = gatewayReplay(async (url) => url.endsWith('/health') ? jsonResponse({ status: 'ok' }) : props());
    const value = await (await replay.request('/v1/health')).json();
    assert.equal(value.ok, false); assert.equal(value.models[0].loaded, false);
  }
  const legacy = gatewayReplay(async (url) => url.endsWith('/health') ? jsonResponse({ status: 'ok' }) : jsonResponse({}, 404));
  const value = await (await legacy.request('/v1/health')).json();
  assert.equal(value.ok, true); assert.equal(value.models[0].loaded, true);
});

test('多模型只要一个可接收任务即在线，休眠和离线的loaded都不伪造', async () => {
  const replay = gatewayReplay(async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'offline.invalid') return jsonResponse({ error: 'offline' }, 503);
    return jsonResponse(parsed.pathname === '/health' ? { status: 'ok' } : { is_sleeping: true });
  }, { models: [{ id: 'sleeping', url: 'http://sleeping.invalid' }, { id: 'offline', url: 'http://offline.invalid' }] });
  const value = await (await replay.request('/v1/health')).json();
  assert.equal(value.ok, true); assert.deepEqual(value.models, [{ id: 'sleeping', loaded: false }, { id: 'offline', loaded: false }]);
});

test('健康状态每次真实刷新，休眠后再断线不能复用上次在线结果', async () => {
  let online = true;
  const replay = gatewayReplay(async (url) => online
    ? jsonResponse(url.endsWith('/health') ? { status: 'ok' } : { is_sleeping: true })
    : jsonResponse({ error: 'offline' }, 503));
  assert.equal((await (await replay.request('/v1/health')).json()).ok, true);
  online = false; const value = await (await replay.request('/v1/health')).json();
  assert.equal(value.ok, false); assert.equal(value.models[0].loaded, false);
});

test('真实Core连续探测休眠节点不记server故障、不打开冷却', async () => {
  let generations = 0;
  const replay = gatewayReplay(async (url) => {
    if (!url.endsWith('/health') && !url.endsWith('/props')) generations++;
    return jsonResponse(url.endsWith('/health') ? { status: 'ok' } : { is_sleeping: true });
  });
  const data = {}, area = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); }, async set(value) { Object.assign(data, structuredClone(value)); } };
  globalThis.chrome = { storage: { local: area } };
  const { BackendCore } = compiled('core'), { BackendStorage } = compiled('storage'), { SecretVault } = compiled('secrets');
  const core = new BackendCore({ providers: [remote], storage: new BackendStorage({ memory: true }), vault: new SecretVault({ memory: true, storage: area }), fetch: replay.fetch });
  await core.ready(); await core.save(remote.id, true, { url: 'http://fixture.invalid', token: fixtureToken });
  for (let index = 0; index < 3; index++) await core.probe(remote.id);
  const status = core.snapshot(), provider = status.providers.find((row) => row.id === remote.id);
  assert.equal(provider.circuit, 'closed'); assert.equal(provider.lastError, undefined); assert.equal(provider.cooldownUntil, undefined);
  assert.equal(status.nodes[0].online, true); assert.equal(status.nodes[0].models[0].loaded, false); assert.equal(generations, 0);
});
