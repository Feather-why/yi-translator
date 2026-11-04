import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createGateway, placeholdersMatch } from '../../gateway/server.mjs';

const TOKEN = 'fixture-gateway-token';
const origin = 'chrome-extension://' + 'a'.repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}` };
async function serve(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
async function setup(handler, options = {}) {
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }));
    if (req.url === '/props') return res.end(JSON.stringify({ is_sleeping: false }));
    let input = ''; for await (const chunk of req) input += chunk;
    try { await handler(req, res, JSON.parse(input)); } catch { if (!res.destroyed) res.writeHead(500).end(); }
  });
  const source = await serve(upstream);
  const gateway = createGateway({ token: TOKEN, models: [{ id: 'fixture', url: source.url, concurrency: 2 }], allowedOrigins: [origin], ...options });
  const node = await serve(gateway);
  return { ...node, gateway, async close() { await node.close(); await source.close(); } };
}
const payload = (segments) => ({ sourceLang: 'en', targetLang: 'zh-CN', segments });
const post = (url, body, extra = {}) => fetch(url + '/v1/translate', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', ...extra.headers }, body: JSON.stringify(body), ...extra });
const reply = (res, text) => res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], timings: { predicted_n: 10, predicted_ms: 100 } }));

test('网关要求令牌，CORS 只放行明确来源，默认配置不暴露推理', async () => {
  assert.throws(() => createGateway({ token: '' }));
  assert.throws(() => createGateway({ token: TOKEN, allowedOrigins: ['*'] }));
  const server = await setup((_req, res) => reply(res, '你好'));
  try {
    assert.equal((await fetch(server.url + '/v1/metrics')).status, 401);
    assert.equal((await fetch(server.url + '/v1/metrics', { headers: { ...auth, Origin: 'https://evil.example' } })).status, 403);
    const allowed = await fetch(server.url + '/v1/metrics', { headers: { ...auth, Origin: origin } });
    assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
    assert.equal(allowed.headers.get('cache-control'), 'no-store');
    const preflight = await fetch(server.url + '/v1/translate', { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(preflight.status, 204);
  } finally { await server.close(); }
});

test('网关逐段写 NDJSON，后完成片段不阻塞先完成片段', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const server = await setup(async (_req, res, body) => {
    const source = body.messages[0].content.split('：\n').at(-1);
    if (source === 'slow') await held;
    reply(res, source === 'slow' ? '慢' : '快');
  });
  try {
    const response = await post(server.url, payload([{ id: 'slow', text: 'slow' }, { id: 'fast', text: 'fast' }]));
    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"id":"fast"/); assert.doesNotMatch(first, /"done"/);
    release();
    let rest = ''; while (true) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); }
    assert.match(rest, /"id":"slow"/); assert.match(rest, /"done":true/);
    const metrics = await (await fetch(server.url + '/v1/metrics', { headers: auth })).json();
    assert.equal(metrics.completedSegments, 2); assert.equal(metrics.models[0].tokensPerSec, 100);
  } finally { release(); await server.close(); }
});

test('网关对标签失配重试一次，仍失配则明确报 placeholder', async () => {
  let calls = 0;
  const server = await setup((_req, res) => { calls++; reply(res, '丢标签的结果'); });
  try {
    const response = await post(server.url, payload([{ id: 'nested', text: '<g0>read <g1>guide</g1></g0><x0/>' }]));
    const lines = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(lines[0].error.code, 'placeholder'); assert.equal(lines.at(-1).done, true); assert.equal(calls, 2);
    assert.equal(placeholdersMatch('<g0>a<g1>b</g1></g0>', '<g0>甲</g0><g1>乙</g1>'), false);
  } finally { await server.close(); }
});

test('网关批量输入校验：重复 id、坏语言、未知模型和过大文本不发推理', async () => {
  let calls = 0;
  const server = await setup((_req, res) => { calls++; reply(res, '你好'); });
  try {
    for (const body of [payload([{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }]), { ...payload([{ id: 'a', text: 'x' }]), targetLang: '../bad' }, { ...payload([{ id: 'a', text: 'x' }]), model: 'missing' }, payload([{ id: 'a', text: 'x'.repeat(12_001) }])]) assert.equal((await post(server.url, body)).status, 400);
    assert.equal(calls, 0);
  } finally { await server.close(); }
});

test('网关客户端断开会取消在途上游，并清理排队片段', async () => {
  let connected;
  const begun = new Promise((resolve) => { connected = resolve; });
  let disconnected;
  const ended = new Promise((resolve) => { disconnected = resolve; });
  const server = await setup((req, res) => { connected(); res.on('close', disconnected); }, { concurrency: 1 });
  try {
    const controller = new AbortController();
    const pending = post(server.url, payload([{ id: 'a', text: 'wait' }, { id: 'b', text: 'wait2' }]), { signal: controller.signal });
    await begun; controller.abort();
    await assert.rejects(pending);
    await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('上游未取消')), 2000))]);
  } finally { await server.close(); }
});

test('网关健康与模块路由提供真实状态，未配置模块明确 501', async () => {
  const server = await setup((_req, res) => reply(res, '你好'), { handlers: { align: async (body) => body.pairs.map((pair) => ({ id: pair.id, srcTokens: [], tgtTokens: [], links: [] })) } });
  try {
    const health = await (await fetch(server.url + '/v1/health', { headers: auth })).json();
    assert.equal(health.ok, true); assert.deepEqual(health.models, [{ id: 'fixture', loaded: true }]); assert.equal(health.models[0].vramMB, undefined);
    const align = await fetch(server.url + '/v1/align', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairs: [{ id: 'a' }] }) });
    assert.equal((await align.json())[0].id, 'a');
    const pdf = await fetch(server.url + '/v1/pdf', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(pdf.status, 501);
  } finally { await server.close(); }
});
