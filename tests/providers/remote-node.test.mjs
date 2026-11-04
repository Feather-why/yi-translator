import test from 'node:test';
import assert from 'node:assert/strict';
import { provider, request, context, json } from './helpers.mjs';
const adapter = provider('remote-node');
const config = { url: 'http://node.example:8090/v1/', token: 'fixture-remote-token', model: 'remote-7b' };
const ndjson = (lines) => new Response(lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n'), { headers: { 'Content-Type': 'application/x-ndjson' } });

test('远程节点 Bearer 鉴权，NDJSON 按 id 归位且支持任意 UTF8 分块', async () => {
  const bytes = new TextEncoder().encode('{"id":"s1","text":"第二段"}\n{"id":"s0","text":"第一段"}\n{"done":true}\n');
  const ctx = context((url, init) => {
    assert.equal(url, 'http://node.example:8090/v1/translate');
    assert.equal(init.headers.Authorization, 'Bearer fixture-remote-token');
    assert.equal(JSON.parse(init.body).model, 'remote-7b');
    return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
  }, config);
  assert.deepEqual(await adapter.translate(request(['first', 'second']), ctx), ['第一段', '第二段']);
});

test('远程节点拒绝缺号、重号、越界号、无 done、done 后数据和坏 JSON', async () => {
  const cases = [[], [{ id: 's0', text: '一' }], [{ id: 's1', text: '错号' }, { done: true }], [{ id: 's00', text: '非规范编号' }, { done: true }], [{ id: 's0', text: '一' }, { id: 's0', text: '重复' }, { done: true }], [{ id: 's0', text: '一' }, { done: true }, { done: true }], ['broken-json']];
  for (const lines of cases) await assert.rejects(adapter.translate(request(['one']), context(() => ndjson(lines), config)), (error) => error.info.code === 'server');
});

test('远程节点保留错误分类但不透传上游任意错误文本', async () => {
  await assert.rejects(adapter.translate(request(['one']), context(() => ndjson([{ id: 's0', error: { code: 'quota', message: 'private-source-data' } }, { done: true }]), config)), (error) => error.info.code === 'quota' && !error.info.message.includes('private-source-data'));
});

test('远程节点拒绝超大行并在取消时关闭共享读取器', async () => {
  await assert.rejects(adapter.translate(request(['one']), context(() => ndjson(['x'.repeat(256 * 1024 + 1)]), config)), (error) => error.info.code === 'server');
  let cancel;
  let started;
  const begin = new Promise((resolve) => { started = resolve; });
  const signal = new AbortController();
  const ctx = context(() => new Response(new ReadableStream({ start() { started(); }, cancel() { cancel = true; } })), config);
  ctx.signal = signal.signal;
  const pending = adapter.translate(request(['one']), ctx);
  await begin;
  signal.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(cancel, true);
});

test('远程节点 health 不伪造显存和吞吐', async () => {
  const status = await adapter.health(context(() => json({ ok: true, version: '0.2.0', models: [{ id: 'remote-7b', loaded: true }], queue: 2 }), config));
  assert.equal(status.model, 'remote-7b'); assert.equal(status.vramMB, undefined);
  assert.equal(status.node.location, 'remote'); assert.equal(status.node.queue, 2); assert.equal(status.node.models[0].vramMB, undefined);
});
