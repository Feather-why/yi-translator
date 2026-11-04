import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const { BackendCore } = require(path.join(build, 'backend/core.js'));
const { BackendStorage } = require(path.join(build, 'backend/storage.js'));
const { SecretVault } = require(path.join(build, 'backend/secrets.js'));
const { ProviderError, classifyError } = require(path.join(build, 'backend/providers/types.js'));
const delay = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function until(check) { const end = Date.now() + 2000; while (!check()) { assert.ok(Date.now() < end, '等待回放超时'); await delay(2); } }
function area(initial = {}) { const data = structuredClone(initial); return { data, async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); }, async set(values) { Object.assign(data, structuredClone(values)); } }; }
const provider = (extra = {}) => ({ id: 'fixture', name: 'fixture', version: 'audit-v1', kind: 'local', official: true, auth: [], usedFor: ['fast', 'accurate', 'combined'], placeholders: 'prompt',
  limits: { maxChars: 1200, maxSegments: 1, concurrency: 4 }, async translate(req) { return req.texts.map(() => '自然译文'); }, classifyError, ...extra });
async function setup(options = {}) {
  const local = options.local ?? area(); globalThis.chrome = { storage: { local } };
  const storage = options.storage ?? new BackendStorage({ memory: true });
  const core = new BackendCore({ providers: options.providers ?? [provider()], storage, vault: options.vault ?? new SecretVault({ memory: true, storage: local }), ...(options.now ? { now: options.now } : {}) });
  if (!options.unready) await core.ready(); return { core, storage, local };
}
const job = (extra = {}) => ({ jobId: crypto.randomUUID(), sourceLang: 'en', targetLang: 'zh-CN', mode: 'accurate', priority: 1,
  context: { url: 'https://fixture.invalid/article' }, segments: [{ id: 's', text: 'Hello.', kind: 'paragraph' }], ...extra });
const signal = () => new AbortController().signal;
function run(core, input = job(), abort = signal()) { return core.translate(input, input.segments[0], input.mode === 'fast' ? 'fast' : 'accurate', abort); }

for (const method of ['tmGet', 'cacheGet']) test(`cache-fallback: ${method}失败旁路健康服务，告警不含正文且限频`, async () => {
  let reads = 0, calls = 0, clock = 100;
  const storage = new BackendStorage({ memory: true });
  storage[method] = async () => { reads++; throw Error('private-source-never-log'); };
  const { core } = await setup({ storage, now: () => clock, providers: [provider({ async translate() { calls++; return ['正确译文']; } })] });
  for (let i = 0; i < 4; i++) assert.equal((await run(core)).text, '正确译文');
  assert.equal(calls, 4); assert.equal(reads, 1);
  let warnings = core.snapshot().events.filter((e) => e.level === 'warn'); assert.equal(warnings.length, 1); assert.ok(!JSON.stringify(warnings).includes('private-source'));
  clock += 30_001; await run(core); assert.equal(reads, 2); assert.equal(core.snapshot().events.filter((e) => e.level === 'warn').length, 1);
  clock += 30_001; await run(core); warnings = core.snapshot().events.filter((e) => e.level === 'warn'); assert.equal(warnings.length, 2);
});
test('cache-fallback: 辅助ready暂错不阻断，30秒后并发查询只做一次恢复', async () => {
  let opens = 0, clock = 100;
  const storage = new BackendStorage({ memory: true }); storage.ready = async () => { if (++opens === 1) throw Error('cache unavailable'); };
  const { core } = await setup({ storage, now: () => clock }); await run(core); assert.equal(opens, 1);
  clock += 30_001; await Promise.all(Array.from({ length: 8 }, () => run(core))); assert.equal(opens, 2);
  const cached = await run(core); assert.equal(cached.cached, true);
});
test('cache-fallback: vault初始化失败严格拒绝，不能借辅助层降级发请求', async () => {
  let calls = 0;
  const { core } = await setup({ unready: true, vault: { async ready() { throw Error('device key unavailable'); } }, providers: [provider({ async translate() { calls++; return ['不可发送']; } })] });
  await assert.rejects(core.ready(), /device key/); await assert.rejects(run(core), /device key/); assert.equal(calls, 0);
});
test('cache-fallback: 取消中的失败查询不继续发服务请求', async () => {
  const waiting = gate(); let called = 0, reads = 0;
  const storage = new BackendStorage({ memory: true }); storage.tmGet = async () => { reads++; await waiting.promise; throw Error('cache read'); };
  const { core } = await setup({ storage, providers: [provider({ async translate() { called++; return ['不可发送']; } })] });
  const abort = new AbortController(), pending = run(core, job(), abort.signal), rejected = assert.rejects(pending, { name: 'AbortError' });
  await until(() => reads === 1); abort.abort(); waiting.resolve(); await rejected; assert.equal(called, 0);
});

class ReadCountStorage extends BackendStorage {
  counts = { memory: 0, fast: 0, accurate: 0 };
  constructor() { super({ memory: true }); }
  async tmGet(...args) { this.counts.memory++; return super.tmGet(...args); }
  async cacheGet(from, to, tier, text) { this.counts[tier]++; return super.cacheGet(from, to, tier, text); }
}
async function combined(core, input, fastSignal = signal(), accurateSignal = signal()) {
  const scope = core.createCombined(input, input.segments[0]);
  try { return await Promise.all([scope.translate('fast', fastSignal), scope.translate('accurate', accurateSignal)]); } finally { scope.dispose(); }
}
test('combined-read: 同段两档共用一次TM及每档cache查询，推理仍一份准确工作', async () => {
  let calls = 0; const storage = new ReadCountStorage();
  const { core } = await setup({ storage, providers: [provider({ async translate() { calls++; await delay(10); return ['准确译文']; } })] });
  const values = await combined(core, job({ mode: 'combined' }));
  assert.deepEqual(storage.counts, { memory: 1, fast: 1, accurate: 1 }); assert.equal(calls, 1); assert.equal(values[0].text, values[1].text);
});
test('combined-read: 精确缓存两档共享命中且都直接final，零推理', async () => {
  let calls = 0; const storage = new ReadCountStorage(); await storage.cachePut('en', 'zh-CN', 'accurate', 'Hello.', { text: '准确缓存', provider: 'fixture', version: 'audit-v1' });
  const { core } = await setup({ storage, providers: [provider({ async translate() { calls++; return ['不可发送']; } })] });
  const values = await combined(core, job({ mode: 'combined' })); assert.deepEqual(storage.counts, { memory: 1, fast: 0, accurate: 1 }); assert.equal(calls, 0); assert.ok(values.every((v) => v.finalOnly && v.cached));
});
test('combined-read: noCache两档零存储访问，不与普通scope共享', async () => {
  const storage = new ReadCountStorage(), { core } = await setup({ storage });
  await combined(core, job({ mode: 'combined', noCache: true })); assert.deepEqual(storage.counts, { memory: 0, fast: 0, accurate: 0 });
  await combined(core, job({ mode: 'combined' })); assert.equal(storage.counts.memory, 1);
});
test('combined-read: 一个消费者等待TM时取消，不取消另一档查询/推理', async () => {
  const storage = new ReadCountStorage(), waiting = gate(); let reads = 0, calls = 0;
  storage.tmGet = async () => { reads++; await waiting.promise; return undefined; };
  const { core } = await setup({ storage, providers: [provider({ async translate() { calls++; return ['剩余准确译文']; } })] });
  const input = job({ mode: 'combined' }), scope = core.createCombined(input, input.segments[0]), abort = new AbortController();
  try {
    const a = scope.translate('fast', abort.signal), rejected = assert.rejects(a, { name: 'AbortError' }), b = scope.translate('accurate', signal());
    await until(() => reads === 1); abort.abort(); waiting.resolve(); await rejected; assert.equal((await b).text, '剩余准确译文'); assert.equal(reads, 1); assert.equal(calls, 1);
  } finally { scope.dispose(); }
});
test('combined-read: 相同文本独立scope、providerHint与namespace互不复用查询', async () => {
  const storage = new ReadCountStorage(), selected = [];
  const { core } = await setup({ storage, providers: [provider({ id: 'a', async translate() { selected.push('a'); return ['甲']; } }), provider({ id: 'b', async translate() { selected.push('b'); return ['乙']; } })] });
  const [a, b] = await Promise.all([combined(core, job({ mode: 'combined', providerHint: 'a', cacheNamespace: 'one' })), combined(core, job({ mode: 'combined', providerHint: 'b', cacheNamespace: 'two' }))]);
  assert.equal(storage.counts.memory, 2); assert.equal(storage.counts.accurate, 2); assert.equal(a[0].provider, 'a'); assert.equal(b[0].provider, 'b'); assert.deepEqual(selected.sort(), ['a', 'b']);
});

test('probe-separation: health成功不建立翻译耗时/成功率样本', async () => {
  const { core } = await setup({ providers: [provider({ async health() { return { ok: true, latencyMs: 1 }; } })] });
  await core.probe(); const state = core.snapshot().providers[0]; assert.equal(state.latencyP50Ms, undefined); assert.equal(state.successRate, undefined); assert.equal(state.circuit, 'closed');
});
test('probe-separation: health不能清除三次真实生成失败的熔断和错误', async () => {
  let calls = 0, clock = Date.now(), broken = true;
  const { core } = await setup({ now: () => clock, providers: [provider({ async health() { return { ok: true, latencyMs: 1 }; }, async translate() { calls++; if (broken) throw new ProviderError({ code: 'server', message: 'generation broken', retryable: true }); return ['恢复译文']; } })] });
  for (let i = 0; i < 3; i++) await assert.rejects(run(core, job({ noCache: true })));
  const before = core.snapshot().providers[0]; await core.probe(); const after = core.snapshot().providers[0];
  assert.equal(after.circuit, 'open'); assert.equal(after.health, 'degraded'); assert.deepEqual(after.lastError, before.lastError); assert.equal(after.successRate, 0); assert.equal(after.latencyP50Ms, undefined);
  await assert.rejects(run(core, job({ noCache: true }))); assert.equal(calls, 3);
  clock += 30_001; broken = false; assert.equal((await run(core, job({ noCache: true }))).text, '恢复译文'); assert.equal(core.snapshot().providers[0].circuit, 'closed');
});
test('probe-separation: health失败只改变健康状态，不计生成失败/熔断，恢复检查可清自身错误', async () => {
  let healthy = false;
  const { core } = await setup({ providers: [provider({ async health() { return { ok: healthy, latencyMs: 1 }; } })] });
  for (let i = 0; i < 4; i++) await core.probe(); let state = core.snapshot().providers[0];
  assert.equal(state.circuit, 'closed'); assert.equal(state.health, 'degraded'); assert.equal(state.successRate, undefined); assert.equal(state.latencyP50Ms, undefined);
  healthy = true; await core.probe(); state = core.snapshot().providers[0]; assert.equal(state.health, 'ok'); assert.equal(state.lastError, undefined);
});
test('probe-separation: 重要失败即时通知，普通slot与success可合并', async () => {
  const notifications = []; const { core } = await setup({ providers: [provider({ async translate() { throw new ProviderError({ code: 'server', message: 'failure', retryable: true }); } })] });
  core.subscribe((immediate) => notifications.push(immediate)); await assert.rejects(run(core, job({ noCache: true })));
  assert.ok(notifications.includes(true)); assert.ok(notifications.includes(false));
});
