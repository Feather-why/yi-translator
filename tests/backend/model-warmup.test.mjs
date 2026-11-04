import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ModelWarmup } = require('../.compiled/backend/model-warmup.js');
const { ProviderError } = require('../.compiled/backend/providers/types.js');
const provider = (changes = {}) => ({ id: 'local', kind: 'local', adapter: 'llamacpp', enabled: true, configured: true, endpoint: 'http://127.0.0.1:8082/v1', ...changes });
const input = (changes = {}) => ({ providerId: 'local', reason: 'hover', ...changes });
const json = (value, init = {}) => new Response(JSON.stringify(value), { status: 200, ...init });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(predicate) { const end = Date.now() + 1000; while (!predicate()) { assert.ok(Date.now() < end); await tick(); } }
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }

test('已醒本地模型只查props，不重置idle、不发送prompt、Cookie或重定向，输出无私密字段', async (t) => {
  const calls = [], local = provider({ apiKey: 'fixture-private-key' });
  const service = new ModelWarmup({ provider: async () => local, fetch: async (url, init) => { calls.push({ url, init }); return json({ is_sleeping: false, endpoint_slots: true, model_path: 'private-path', chat_template: 'private-template' }); } }); t.after(() => service.dispose());
  const result = await service.warmup(input()); assert.equal(result.status, 'ready'); assert.equal(result.provider, 'local');
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://127.0.0.1:8082/props');
  assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.body, undefined); assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fixture-private-key');
  assert.doesNotMatch(JSON.stringify(result), /private|prompt|template|path/);
});

test('睡眠模型通过slots无正文唤醒，只cancel slots body，再以props确认；不解析旧prompt', async (t) => {
  const urls = []; let cancelled = 0, read = 0;
  const service = new ModelWarmup({ provider: async () => provider(), fetch: async (url) => {
    urls.push(url);
    if (url.endsWith('/slots')) return { ok: true, status: 200, body: { cancel: async () => { cancelled++; }, getReader() { read++; throw Error('不能读取旧prompt'); } }, text() { read++; }, json() { read++; } };
    return json({ is_sleeping: urls.length === 1, endpoint_slots: true });
  } }); t.after(() => service.dispose());
  const result = await service.warmup(input({ reason: 'manual' })); assert.equal(result.status, 'warmed');
  assert.deepEqual(urls.map((url) => new URL(url).pathname), ['/props', '/slots', '/props']); assert.equal(cancelled, 1); assert.equal(read, 0);
});

test('仅已启用且配置完整的本机llamacpp允许预热，远端/云端/未配置/暂停均无HTTP', async (t) => {
  const invalid = [
    { kind: 'remote' }, { kind: 'llm' }, { kind: 'builtin' }, { adapter: 'openai-compatible' }, { enabled: false }, { configured: false }, { paused: true },
    { endpoint: 'https://api.openai.com/v1' }, { endpoint: 'http://192.168.1.2:8082' }, { endpoint: 'http://localhost.evil.test:8082' },
    { endpoint: 'http://127.0.0.1.evil.test:8082' }, { endpoint: 'http://user:password@127.0.0.1:8082' },
    { endpoint: 'http://127.0.0.1:8082?token=private' }, { endpoint: 'http://127.0.0.1:8082#private' }, { endpoint: 'file:///local/model' },
  ];
  for (const changes of invalid) {
    let calls = 0; const service = new ModelWarmup({ provider: async () => provider(changes), fetch: async () => { calls++; throw Error('不能发请求'); } }); t.after(() => service.dispose());
    assert.equal((await service.warmup(input())).status, 'ineligible', JSON.stringify(changes)); assert.equal(calls, 0);
  }
});

test('localhost、IPv6 loopback与规范化127地址可用，未知编号不能误唤醒默认模型', async (t) => {
  for (const endpoint of ['http://localhost:8082/', 'http://[::1]:8082/v1/', 'http://127.1:8082/v1']) {
    const service = new ModelWarmup({ provider: async () => provider({ endpoint }), fetch: async () => json({ is_sleeping: false }) }); t.after(() => service.dispose());
    assert.equal((await service.warmup(input())).status, 'ready');
  }
  let calls = 0; const service = new ModelWarmup({ provider: async () => provider(), fetch: async () => { calls++; } });
  assert.equal((await service.warmup(input({ providerId: 'unknown' }))).status, 'ineligible'); assert.equal(calls, 0); service.dispose();
});

test('同目标并发hover/manual合并一次HTTP，别名调用仍返回自己的provider编号', async (t) => {
  const response = deferred(); let calls = 0;
  const service = new ModelWarmup({ provider: async (id) => provider({ id }), fetch: async () => { calls++; return response.promise; } }); t.after(() => service.dispose());
  const a = service.warmup(input({ providerId: 'alias-a' })), b = service.warmup(input({ providerId: 'alias-b', reason: 'manual' }));
  await until(() => calls === 1); await tick(); response.resolve(json({ is_sleeping: false }));
  const results = await Promise.all([a, b]); assert.equal(calls, 1); assert.deepEqual(results.map((result) => result.provider), ['alias-a', 'alias-b']); assert.ok(results.every((result) => result.status === 'ready'));
});

test('取消单个消费者不打断另一个，取消监听在结束后清理', async (t) => {
  const response = deferred(); let nativeSignal;
  const service = new ModelWarmup({ provider: async () => provider(), fetch: async (_url, init) => { nativeSignal = init.signal; return response.promise; } }); t.after(() => service.dispose());
  const a = new AbortController(), b = new AbortController();
  const first = service.warmup(input(), a.signal), second = service.warmup(input(), b.signal); const rejected = assert.rejects(first, { name: 'AbortError' });
  await until(() => nativeSignal); await tick(); a.abort(); await rejected; assert.equal(nativeSignal.aborted, false);
  response.resolve(json({ is_sleeping: false })); assert.equal((await second).status, 'ready');
});

test('所有消费者退出时取消真实请求，失败/取消后的同目标120秒不重复请求', async (t) => {
  let calls = 0, nativeSignal;
  const service = new ModelWarmup({ provider: async () => provider(), fetch: async (_url, init) => { calls++; nativeSignal = init.signal; return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true })); } }); t.after(() => service.dispose());
  const controller = new AbortController(), pending = service.warmup(input(), controller.signal); const rejection = assert.rejects(pending, { name: 'AbortError' });
  await until(() => nativeSignal); controller.abort(); await rejection; await until(() => nativeSignal.aborted); await tick();
  const next = await service.warmup(input()); assert.equal(next.status, 'cooldown'); assert.ok(next.retryAfterMs > 119000); assert.equal(calls, 1);
});

test('网络层忽略abort也被有界超时结束，返回脱敏失败而不假造ready', async (t) => {
  let nativeSignal; const service = new ModelWarmup({ provider: async () => provider(), timeoutMs: 20, fetch: async (_url, init) => { nativeSignal = init.signal; return new Promise(() => {}); } }); t.after(() => service.dispose());
  const start = performance.now(), result = await service.warmup(input()); assert.equal(result.status, 'failed'); assert.match(result.error.message, /超时/); assert.ok(performance.now() - start < 300); assert.equal(nativeSignal.aborted, true);
});

test('props响应body卡住同样超时并cancel reader', async (t) => {
  let cancelled = false;
  const service = new ModelWarmup({ provider: async () => provider(), timeoutMs: 20, fetch: async () => new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } })) }); t.after(() => service.dispose());
  assert.equal((await service.warmup(input())).status, 'failed'); assert.equal(cancelled, true);
});

test('每目标120秒间隔与全局两枚token同时生效，时间推进后可再尝试', async (t) => {
  let now = 0, calls = 0;
  const service = new ModelWarmup({ provider: async (id) => provider({ id, endpoint: `http://127.0.0.1:${id}/` }), now: () => now,
    fetch: async () => { calls++; return json({ is_sleeping: false }); } }); t.after(() => service.dispose());
  assert.equal((await service.warmup(input({ providerId: '8082' }))).status, 'ready');
  assert.equal((await service.warmup(input({ providerId: '8082' }))).status, 'cooldown');
  assert.equal((await service.warmup(input({ providerId: '8083' }))).status, 'ready');
  assert.equal((await service.warmup(input({ providerId: '8084' }))).status, 'cooldown'); assert.equal(calls, 2);
  now += 120000; assert.equal((await service.warmup(input({ providerId: '8084' }))).status, 'ready'); assert.equal(calls, 3);
});

test('状态表有32条上限且不保存原始key，凭据变更不会复用旧鉴权失败', async (t) => {
  let now = 0, secret = 'old-secret', calls = 0;
  const service = new ModelWarmup({ provider: async (id) => provider({ id, endpoint: `http://127.0.0.1:${id}/`, apiKey: secret }), now: () => now,
    fetch: async (_url, init) => { calls++; return init.headers.Authorization === 'Bearer old-secret' ? json({ private: '不能泄露' }, { status: 401 }) : json({ is_sleeping: false }); } }); t.after(() => service.dispose());
  assert.equal((await service.warmup(input({ providerId: '8082' }))).status, 'failed');
  secret = 'new-secret'; assert.equal((await service.warmup(input({ providerId: '8082' }))).status, 'ready'); assert.equal(calls, 2);
  for (let i = 0; i < 35; i++) { now += 120000; assert.equal((await service.warmup(input({ providerId: String(9000 + i) }))).status, 'ready'); }
  assert.ok(service.targets.size <= 32); assert.ok([...service.targets.keys()].every((key) => !key.includes('secret')));
});

test('slots未开放/旧版本无sleep字段时明确unsupported，不调用completion补救', async (t) => {
  for (const props of [{ is_sleeping: true, endpoint_slots: false }, { is_sleeping: true }, {}, { is_sleeping: 'false', endpoint_slots: true }]) {
    const urls = [], service = new ModelWarmup({ provider: async () => provider(), fetch: async (url) => { urls.push(url); return json(props); } }); t.after(() => service.dispose());
    assert.equal((await service.warmup(input())).status, 'unsupported'); assert.equal(urls.length, 1);
  }
});

test('slots返回成功但props仍睡眠不算warmed，slots错误body也不解析', async (t) => {
  let cancelled = 0;
  const asleep = new ModelWarmup({ provider: async () => provider(), fetch: async (url) => url.endsWith('/slots') ? json([]) : json({ is_sleeping: true, endpoint_slots: true }) }); t.after(() => asleep.dispose());
  assert.equal((await asleep.warmup(input())).status, 'failed');
  const denied = new ModelWarmup({ provider: async () => provider(), fetch: async (url) => url.endsWith('/slots')
    ? { ok: false, status: 401, body: { cancel: async () => { cancelled++; } }, json() { assert.fail('不能读slots'); } }
    : json({ is_sleeping: true, endpoint_slots: true }) }); t.after(() => denied.dispose());
  const result = await denied.warmup(input()); assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'auth'); assert.equal(cancelled, 1);
});

test('props格式/体积错误或网络异常均脱敏失败，不返回路径、key和原始错误', async (t) => {
  for (const response of [() => json([]), () => new Response('bad-json'), () => new Response('x', { headers: { 'content-length': String(128 * 1024 + 1) } }),
    () => { throw Error('private-secret-and-model-path'); }, () => { throw new ProviderError({ code: 'network', message: 'private-secret-and-model-path', retryable: true }); }]) {
    const service = new ModelWarmup({ provider: async () => provider(), fetch: async () => response() }); t.after(() => service.dispose());
    const result = await service.warmup(input()); assert.equal(result.status, 'failed'); assert.doesNotMatch(JSON.stringify(result), /private-secret|model-path/);
  }
});

test('取消发生在配置查询期间或dispose之后，不创建迟到HTTP工作', async () => {
  const configured = deferred(); let calls = 0;
  const service = new ModelWarmup({ provider: async () => configured.promise, fetch: async () => { calls++; } });
  const controller = new AbortController(), pending = service.warmup(input(), controller.signal), rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); configured.resolve(provider()); await rejected; assert.equal(calls, 0); service.dispose();
  assert.equal((await service.warmup(input())).status, 'ineligible');
});

test('错误reason/providerId拒绝为bad_input，预先取消不读取Vault配置', async () => {
  let reads = 0; const service = new ModelWarmup({ provider: async () => { reads++; return provider(); } });
  for (const request of [null, {}, input({ reason: 'automatic' }), input({ providerId: '' }), input({ providerId: 1 })]) {
    await assert.rejects(service.warmup(request), (error) => error.info?.code === 'bad_input');
  }
  const controller = new AbortController(); controller.abort(); await assert.rejects(service.warmup(input(), controller.signal), { name: 'AbortError' });
  assert.equal(reads, 0); service.dispose();
});
