import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const { BackendCore } = require(path.join(build, 'backend/core.js'));
const { BackendStorage } = require(path.join(build, 'backend/storage.js'));
const { SecretVault, SECRETS_STORAGE_KEY } = require(path.join(build, 'backend/secrets.js'));
const { ProviderError, classifyError } = require(path.join(build, 'backend/providers/types.js'));

function area(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.map((key) => [key, structuredClone(data[key])]));
    },
    async set(items) { Object.assign(data, structuredClone(items)); },
  };
}

function provider(id = 'fixture', overrides = {}) {
  return { id, name: id, version: '1.0.0', kind: 'mt', official: true, usedFor: ['fast', 'accurate', 'combined'],
    auth: [], limits: { maxChars: 10_000, maxSegments: 50, concurrency: 4 }, placeholders: 'prompt',
    async translate(request) { return request.texts.map((text) => `译文${text}`); }, classifyError, ...overrides };
}

async function setup(providers, options = {}) {
  const local = options.local || area();
  globalThis.chrome = { storage: { local } };
  const storage = options.storage || new BackendStorage({ memory: true });
  const vault = options.vault || new SecretVault({ memory: true, storage: local });
  const core = new BackendCore({ providers, storage, vault, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}),
    ...(options.builtin ? { builtin: options.builtin } : {}), ...(options.openBuiltinSetup ? { openBuiltinSetup: options.openBuiltinSetup } : {}) });
  await core.ready();
  return { core, storage, vault, local };
}

function job(text = 'Hello.', overrides = {}) {
  return { jobId: 'fixture-job', mode: 'fast', sourceLang: 'en', targetLang: 'zh-CN', priority: 0,
    context: { url: 'https://example.test/article' }, segments: [{ id: 's1', text, kind: 'paragraph' }], ...overrides };
}
const translate = (core, request = job(), tier = 'fast', signal = new AbortController().signal) => core.translate(request, request.segments[0], tier, signal);

test('noCache 翻译完全跳过缓存和译文记忆，普通页后续明确人工修订可以保存', async () => {
  class ObservedStorage extends BackendStorage {
    accesses = [];
    constructor() { super({ memory: true }); }
    async tmGet(...args) { this.accesses.push('tmGet'); return super.tmGet(...args); }
    async tmPut(...args) { this.accesses.push('tmPut'); return super.tmPut(...args); }
    async cacheGet(...args) { this.accesses.push('cacheGet'); return super.cacheGet(...args); }
    async cachePut(...args) { this.accesses.push('cachePut'); return super.cachePut(...args); }
  }
  let calls = 0;
  const storage = new ObservedStorage();
  const { core } = await setup([provider('fixture', { translate: async () => { calls++; return ['真正请求']; } })], { storage });
  const result = await translate(core, job('Sensitive content.', { noCache: true }));
  assert.equal(result.cached, false);
  assert.equal(calls, 1);
  assert.deepEqual(storage.accesses, []);
  await core.saveMemory('en', 'zh-CN', 'Sensitive content.', '明确人工修订');
  assert.deepEqual(storage.accesses, ['tmPut']);
  await assert.rejects(core.saveMemory('en', 'zh-CN', 'Sensitive content.', '敏感页面不可保存', true), (error) => error.info?.code === 'bad_input');
  assert.deepEqual(storage.accesses, ['tmPut']);
});

test('用户修订优先于缓存，命中缓存保留服务来源，强制服务忽略其他来源', async () => {
  let calls = 0;
  const { core, storage } = await setup([provider('first'), provider('second', { translate: async () => { calls++; return ['第二家结果']; } })]);
  await storage.cachePut('en', 'zh-CN', 'fast', 'Hello.', { text: '缓存译文', provider: 'first', version: '1.0.0:fast-recovery-v1' });
  const { timing: cachedTiming, ...cached } = await translate(core);
  assert.deepEqual(cached, { text: '缓存译文', provider: 'first', cached: true });
  assert.equal(cachedTiming.providerMs, 0); assert.ok(cachedTiming.queueMs >= 0);
  await core.saveMemory('en', 'zh-CN', 'Hello.', '我的修订');
  assert.equal((await translate(core)).text, '我的修订');
  assert.equal((await translate(core, job('Hello.', { mode: 'combined' }))).finalOnly, true);
  const forced = await translate(core, job('Hello.', { providerHint: 'second' }));
  const { timing: forcedTiming, ...forcedResult } = forced;
  assert.deepEqual(forcedResult, { text: '第二家结果', provider: 'second', cached: false });
  assert.ok(forcedTiming.providerMs >= 0);
  assert.equal(calls, 1);
});

test('适配器升级后不复用旧版缓存，combined 优先精确缓存', async () => {
  let calls = 0;
  const { core, storage } = await setup([provider('fixture', { version: '2.0.0', translate: async () => { calls++; return ['新版本结果']; } })]);
  await storage.cachePut('en', 'zh-CN', 'fast', 'Hello.', { text: '旧版结果', provider: 'fixture', version: '1.0.0' });
  assert.equal((await translate(core)).text, '新版本结果');
  assert.equal(calls, 1);
  await storage.cachePut('en', 'zh-CN', 'accurate', 'Hello.', { text: '精确缓存', provider: 'fixture', version: '2.0.0' });
  const hit = await translate(core, job('Hello.', { mode: 'combined' }));
  const { timing, ...hitResult } = hit;
  assert.deepEqual(hitResult, { text: '精确缓存', provider: 'fixture', cached: true, finalOnly: true });
  assert.equal(timing.providerMs, 0); assert.equal(timing.firstTokenMs, undefined);
  assert.equal(calls, 1);
});

test('剩余额度不足时不发送超额请求，同一次翻译自动切换服务', async () => {
  let firstCalls = 0, secondCalls = 0;
  const { core } = await setup([
    provider('first', { freeQuota: { unit: 'char', period: 'month', amount: 3 }, translate: async () => { firstCalls++; return ['第一家结果']; } }),
    provider('second', { translate: async () => { secondCalls++; return ['第二家结果']; } }),
  ]);
  const result = await translate(core, job('Hello.', { noCache: true }));
  assert.equal(result.provider, 'second');
  assert.equal(firstCalls, 0);
  assert.equal(secondCalls, 1);
  const status = core.snapshot();
  assert.equal(status.providers.find((entry) => entry.id === 'first').health, 'ok');
  assert.equal(status.providers.find((entry) => entry.id === 'first').quota.used, 0);
  assert.ok(status.events.some((entry) => entry.providerId === 'first'));
  assert.equal((await translate(core, job('Hi', { noCache: true, providerHint: 'first' }))).provider, 'first');
  assert.equal(firstCalls, 1);
});

test('服务返回额度错误也在同一次请求中切换，错误与实际用量进入状态', async () => {
  const { core } = await setup([
    provider('first', { freeQuota: { unit: 'char', period: 'month', amount: 100 }, translate: async () => { throw new ProviderError({ code: 'quota', message: '账户额度已用尽', retryable: false }); } }),
    provider('second'),
  ]);
  assert.equal((await translate(core, job('Hello.', { noCache: true }))).provider, 'second');
  const first = core.snapshot().providers.find((entry) => entry.id === 'first');
  assert.equal(first.health, 'exhausted');
  assert.equal(first.lastError.code, 'quota');
  assert.equal(first.quota.used, 100);
});

test('用量跨请求累计且重启后保留，状态没有虚构的速度或节点数据', async () => {
  const fixture = provider('fixture', { freeQuota: { unit: 'char', period: 'month', amount: 100 } });
  const { core, local } = await setup([fixture]);
  assert.equal(core.snapshot().providers[0].latencyP50Ms, undefined);
  assert.deepEqual(core.snapshot().nodes, []);
  await translate(core, job('one', { noCache: true }));
  await translate(core, job('two', { noCache: true }));
  assert.equal(core.snapshot().providers[0].quota.used, 6);
  const restarted = await setup([fixture], { local });
  assert.equal(restarted.core.snapshot().providers[0].quota.used, 6);
  await translate(restarted.core, job('three', { noCache: true }));
  assert.equal(restarted.core.snapshot().providers[0].quota.used, 11);
  assert.ok(Object.values(local.data['backend.usage'].fixture.devices).includes(11));
});

test('密钥列表仅返回掩码，保存掩码保留密钥，普通配置中没有明文秘密', async () => {
  const definition = provider('fixture', { auth: [{ key: 'key', label: 'Key', secret: true, required: true }, { key: 'region', label: 'Region' }] });
  const { core, vault, local } = await setup([definition]);
  await core.save('fixture', true, { key: 'sensitive-test-key', region: 'east' });
  assert.equal((await core.list())[0].config.key, '••••');
  assert.equal((await core.list())[0].config.region, 'east');
  await core.save('fixture', true, { key: '••••', region: 'west' });
  assert.deepEqual(await vault.get('fixture'), { key: 'sensitive-test-key' });
  assert.equal(local.data['backend.providers'].fixture.config.key, undefined);
  assert.equal(JSON.stringify(local.data).includes('sensitive-test-key'), false);
  assert.ok(local.data[SECRETS_STORAGE_KEY].fixture);
});

test('手动测试会真实测试已配置但停用的服务，仍保留免费预算限制', async () => {
  let calls = 0;
  const { core } = await setup([provider('fixture', { freeQuota: { unit: 'char', period: 'month', amount: 10 }, translate: async () => { calls++; return ['你好']; } })]);
  await core.save('fixture', false, {});
  await core.action('fixture', 'pause');
  assert.equal((await core.test('fixture')).ok, true);
  assert.equal(calls, 1);
  assert.equal(core.snapshot().providers[0].health, 'disabled');
  assert.equal((await core.test('fixture')).ok, false);
  assert.equal(calls, 1);
});

test('额度不足完整测试样句时probe不发送，也不伪造已消费用量', async () => {
  let calls = 0;
  const { core } = await setup([provider('fixture', { freeQuota: { unit: 'char', period: 'month', amount: 5 }, translate: async () => { calls++; return ['你好']; } })]);
  await core.probe();
  assert.equal(calls, 0);
  assert.equal(core.snapshot().providers[0].health, 'ok');
  assert.equal(core.snapshot().providers[0].quota.used, 0);
});

test('health 返回官方额度与用量后立即按真实上限拒绝超额翻译', async () => {
  let calls = 0;
  const { core } = await setup([provider('fixture', { freeQuota: { unit: 'char', period: 'month', amount: 100 }, health: async () => ({ ok: true, used: 4, amount: 5 }), translate: async () => { calls++; return ['你好']; } })]);
  await core.probe('fixture');
  assert.equal(core.snapshot().providers[0].quota.amount, 5);
  assert.equal(core.snapshot().providers[0].quota.used, 4);
  await assert.rejects(translate(core, job('Hello.', { noCache: true })), (error) => error.info?.code === 'quota');
  assert.equal(calls, 0);
});

test('后台网络请求强制不带Cookie且禁止重定向，保留真实响应', async () => {
  let observed;
  const fixture = provider('fixture', { translate: async (_request, context) => {
    const response = await context.fetch('https://provider.example/translate', { credentials: 'include', redirect: 'follow' });
    return [(await response.json()).text];
  } });
  const { core } = await setup([fixture], { fetch: async (_input, init) => { observed = init; return new Response(JSON.stringify({ text: '实际返回' }), { headers: { 'Content-Type': 'application/json' } }); } });
  assert.equal((await translate(core, job('Hello.', { noCache: true }))).text, '实际返回');
  assert.equal(observed.credentials, 'omit');
  assert.equal(observed.redirect, 'error');
  assert.equal(observed.signal.aborted, false);
});

test('取消 job 会终止正在等待响应的网络请求', async () => {
  let started;
  const connected = new Promise((resolve) => { started = resolve; });
  let networkSignal;
  const fixture = provider('fixture', { translate: async (_request, context) => { await context.fetch('https://provider.example/translate'); return ['不应返回']; } });
  const { core } = await setup([fixture], { fetch: async (_input, init) => {
    networkSignal = init.signal; started();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true }));
  } });
  const controller = new AbortController();
  const pending = translate(core, job('Hello.', { noCache: true }), 'fast', controller.signal);
  await connected;
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(networkSignal.aborted, true);
});

test('适配器自身的取消信号也会终止请求', async () => {
  let started;
  const connected = new Promise((resolve) => { started = resolve; });
  const controller = new AbortController();
  const fixture = provider('fixture', { translate: async (_request, context) => { await context.fetch('https://provider.example/translate', { signal: controller.signal }); return ['不应返回']; } });
  const { core } = await setup([fixture], { fetch: async (_input, init) => {
    started();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true }));
  } });
  const pending = translate(core, job('Hello.', { noCache: true }));
  await connected;
  controller.abort();
  await assert.rejects(pending, (error) => error.info?.code === 'network');
});

test('缓存写满不会丢弃已成功的真实译文或向下一家重复发送', async () => {
  class FullStorage extends BackendStorage {
    constructor() { super({ memory: true }); }
    async cachePut() { throw new Error('disk full'); }
  }
  let secondCalls = 0;
  const { core } = await setup([provider('first'), provider('second', { translate: async () => { secondCalls++; return ['不应重发']; } })], { storage: new FullStorage() });
  assert.equal((await translate(core)).provider, 'first');
  assert.equal(secondCalls, 0);
  assert.ok(core.snapshot().events.some((entry) => entry.message.includes('缓存写入失败')));
});

test('真实核心并行片段合成一次批量请求，结果分回原片段且用量逐项记账', async () => {
  const batches = [];
  const fixture = provider('fixture', { freeQuota: { unit: 'char', period: 'month', amount: 100 }, translate: async (request) => {
    batches.push(request.texts.slice());
    return request.texts.map((text) => `结果${text}`);
  } });
  const { core } = await setup([fixture]);
  const sources = ['one', 'two', 'three'];
  const results = await Promise.all(sources.map((source, index) => translate(core, job(source, { jobId: `batch-${index}`, noCache: true }))));
  assert.deepEqual(results.map((result) => result.text), sources.map((source) => `结果${source}`));
  assert.equal(batches.length, 1);
  assert.deepEqual([...batches[0]].sort(), [...sources].sort());
  assert.equal(core.snapshot().providers[0].quota.used, 11);
});

test('真实核心共享批次中取消一个片段，其余片段继续完成', async () => {
  let started, finish;
  const connected = new Promise((resolve) => { started = resolve; });
  let batchSignal;
  const fixture = provider('fixture', { translate: async (request, context) => {
    batchSignal = context.signal;
    started();
    await new Promise((resolve) => { finish = resolve; });
    return request.texts.map((text) => `结果${text}`);
  } });
  const { core } = await setup([fixture]);
  const controller = new AbortController();
  const first = translate(core, job('one', { jobId: 'one', noCache: true }), 'fast', controller.signal);
  const second = translate(core, job('two', { jobId: 'two', noCache: true }));
  await connected;
  controller.abort();
  await assert.rejects(first, (error) => error.name === 'AbortError');
  assert.equal(batchSignal.aborted, false);
  finish();
  assert.equal((await second).text, '结果two');
});

test('带 QPS 的服务按 HTTP 批次限流，多个片段仍可合成一批', async () => {
  const batches = [];
  const fixture = provider('fixture', { limits: { maxChars: 4000, maxSegments: 20, concurrency: 2, qps: 1 },
    async translate(request) { batches.push(request.texts.slice()); return request.texts.map((text) => `结果${text}`); } });
  const { core } = await setup([fixture]);
  const sources = ['alpha', 'beta', 'gamma'];
  const results = await Promise.all(sources.map((source, index) => translate(core, job(source, { jobId: `qps-${index}`, noCache: true }))));
  assert.deepEqual(results.map((result) => result.text), sources.map((source) => `结果${source}`));
  assert.equal(batches.length, 1);
  assert.deepEqual([...batches[0]].sort(), [...sources].sort());
  assert.equal(core.snapshot().providers[0].active, false);
});

test('差评后的十分钟内同句也避开该服务的缓存，用户显式指定服务仍有效', async () => {
  const { core, storage } = await setup([provider('first'), provider('second')]);
  await storage.cachePut('en', 'zh-CN', 'fast', 'alpha', { text: '已差评的缓存', provider: 'first', version: '1.0.0' });
  await core.feedback('alpha', 'first', 'en', 'zh-CN');
  const result = await translate(core, job('alpha'));
  assert.equal(result.provider, 'second');
  assert.equal(result.cached, false);
  const forced = await translate(core, job('alpha', { providerHint: 'first' }));
  assert.equal(forced.provider, 'first');
});

test('单家服务密文损坏不阻断其他服务，重新保存可恢复该服务', async () => {
  const broken = provider('broken', { auth: [{ key: 'key', label: 'Key', secret: true, required: true }] });
  const first = await setup([broken, provider('healthy')]);
  await first.core.save('broken', true, { key: 'fixture-before-corruption' });
  first.local.data[SECRETS_STORAGE_KEY].broken.data = 'invalid-ciphertext';
  const restarted = await setup([broken, provider('healthy')], { local: first.local });
  assert.equal((await restarted.core.list()).find((entry) => entry.id === 'broken').configured, false);
  assert.ok(restarted.core.snapshot().events.some((entry) => entry.providerId === 'broken' && entry.message.includes('重新填写')));
  assert.equal((await translate(restarted.core)).provider, 'healthy');
  await restarted.core.save('broken', true, { key: 'fixture-after-corruption' });
  assert.equal((await restarted.core.list()).find((entry) => entry.id === 'broken').configured, true);
  assert.deepEqual(await restarted.vault.get('broken'), { key: 'fixture-after-corruption' });
  assert.equal((await translate(restarted.core, job('new text', { providerHint: 'broken' }))).provider, 'broken');
});

for (const mode of ['fast', 'accurate']) test(`${mode}失标后只翻译文本叶子，本机原样还原嵌套和原子标记`, async () => {
  const requests = [];
  const fixture = provider('fixture', { async translate(request) {
    requests.push(...request.texts);
    return request.texts.map((text) => text.includes('<') ? '模型丢掉了标签' : `译${text}`);
  } });
  const { core } = await setup([fixture]);
  const source = '<g0>Read <g1>the guide</g1></g0> and keep <x0/>.';
  const result = await translate(core, job(source, { noCache: true, mode }));
  assert.equal(result.text, '<g0>译Read <g1>译the guide</g1></g0> 译and keep <x0/>.');
  assert.equal(requests.filter((text) => text.includes('<')).length, 2, '官方MT保留自有格式重试策略');
  assert.ok(requests.filter((text) => !text.includes('<')).length > 0);
  assert.equal(core.snapshot().providers[0].health, 'ok');
});

test('适配器抛出 placeholder 也经过加强重试与本机标签降级', async () => {
  const fixture = provider('fixture', { async translate(request) {
    if (request.texts.some((text) => text.includes('<'))) throw new ProviderError({ code: 'placeholder', message: '标签异常', retryable: false });
    return request.texts.map((text) => `译${text}`);
  } });
  const { core } = await setup([fixture]);
  assert.equal((await translate(core, job('<g0>guide</g0> <x0/>', { noCache: true }))).text, '<g0>译guide</g0> <x0/>');
});

test('同一服务多次文本校验失败不会熔断后续可正常翻译的片段', async () => {
  const fixture = provider('fixture', { async translate(request) { return request.texts.map((text) => text === 'bad' ? '<g999>错误标记</g999>' : '可用译文'); } });
  const { core } = await setup([fixture]);
  for (let index = 0; index < 4; index++) await assert.rejects(translate(core, job('bad', { noCache: true })), (error) => error.info.code === 'placeholder');
  assert.equal((await translate(core, job('good', { noCache: true }))).text, '可用译文');
});

test('B2：连续失败进入30秒熔断，到期只有一个半开探测，成功恢复', async () => {
  let now = Date.now(), failures = true, finish, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const fixture = provider('fixture', { limits: { maxChars: 4000, maxSegments: 1, concurrency: 2 }, async translate(request) {
    if (failures) throw new ProviderError({ code: 'server', message: '模拟离线', retryable: true });
    entered(); await new Promise((resolve) => { finish = resolve; }); return request.texts.map(() => '恢复');
  } });
  const { core } = await setup([fixture], { now: () => now });
  for (let i = 0; i < 3; i++) await assert.rejects(translate(core, job('failure', { noCache: true })), (error) => error.info.code === 'server');
  assert.equal(core.snapshot().providers[0].circuit, 'open');
  assert.equal(core.snapshot().providers[0].cooldownUntil, now + 30_000);
  failures = false; now += 30_001;
  const probe = translate(core, job('probe', { noCache: true })); await started;
  assert.equal(core.snapshot().providers[0].circuit, 'half-open');
  await assert.rejects(translate(core, job('parallel', { noCache: true })), (error) => error.info.code === 'server');
  finish(); assert.equal((await probe).text, '恢复');
  assert.equal(core.snapshot().providers[0].circuit, 'closed');
});

test('B2：首屏对冲选择更快服务，两份均记账，只缓存胜出的译文', async () => {
  let aborted = false;
  const quota = { unit: 'char', period: 'month', amount: 10_000 };
  const first = provider('slow', { freeQuota: quota, async translate(_request, context) {
    return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('cancel', 'AbortError')); }, { once: true }));
  } });
  const second = provider('fast', { freeQuota: quota, async translate(request) { return request.texts.map(() => '更快译文'); } });
  const { core, storage } = await setup([first, second]);
  const result = await translate(core, job('hedge'));
  assert.equal(result.provider, 'fast'); assert.equal(aborted, true);
  assert.equal((await storage.cacheGet('en', 'zh-CN', 'fast', 'hedge')).provider, 'fast');
  assert.ok(core.snapshot().providers.every((entry) => entry.quota.used === 5));
});

test('B2：同页粘性保留已用服务，用户置顶和强制服务覆盖粘性', async () => {
  const { core } = await setup([provider('first'), provider('second')]);
  assert.equal((await translate(core, job('one', { noCache: true, priority: 1 }))).provider, 'first');
  assert.equal((await translate(core, job('two', { noCache: true, priority: 1 }))).provider, 'first');
  await core.action('second', 'pin');
  assert.equal((await translate(core, job('three', { noCache: true, priority: 1 }))).provider, 'second');
  assert.equal((await translate(core, job('four', { noCache: true, priority: 1, providerHint: 'first' }))).provider, 'first');
});

test('B5：媒体缓存命名空间隔离同一句字幕/文档，不污染普通网页缓存', async () => {
  let calls = 0;
  const { core } = await setup([provider('fixture', { async translate(request) { calls++; return request.texts.map(() => `第${calls}次译文`); } })]);
  const first = await translate(core, job('same', { cacheNamespace: 'subtitle:video-a' }));
  const second = await translate(core, job('same', { cacheNamespace: 'subtitle:video-b' }));
  const page = await translate(core, job('same'));
  assert.notEqual(first.text, second.text); assert.notEqual(second.text, page.text);
  assert.equal((await translate(core, job('same', { cacheNamespace: 'subtitle:video-a' }))).cached, true);
  assert.equal(calls, 3);
});

test('兜底：高速档默认优先已开启内置，不消耗额度且不跨组对冲', async () => {
  const calls=[];
  const make=(id,changes={})=>provider(id,{async translate(){calls.push(id);return [id+'译文'];},...changes});
  const {core}=await setup([make('browser',{kind:'builtin',usedFor:['fast','combined']}),make('local',{kind:'local',usedFor:['accurate','combined']}),make('quota',{freeQuota:{unit:'char',period:'month',amount:1000}})]);
  const result=await translate(core,job('hello',{noCache:true}));
  assert.equal(result.provider,'browser');assert.deepEqual(calls,['browser']);
  assert.equal(core.snapshot().providers.find(p=>p.id==='quota').quota.used,0);
});

test('兜底：同一次请求内置不可用→额度用尽→仅精确档本地，快速翻译不中断',async()=>{
  const calls=[];
  const {core}=await setup([
    provider('quota',{freeQuota:{unit:'char',period:'month',amount:1000},async translate(){calls.push('quota');throw new ProviderError({code:'quota',message:'额度耗尽',retryable:false});}}),
    provider('browser',{kind:'builtin',usedFor:['fast','combined'],async translate(){calls.push('browser');throw new ProviderError({code:'no_provider',message:'语言包未准备',retryable:false});}}),
    provider('local',{kind:'local',usedFor:['accurate','combined'],async translate(){calls.push('local');return ['本机译文'];}}),
  ]);
  assert.equal((await translate(core,job('hello',{noCache:true}))).provider,'local');
  assert.deepEqual(calls,['browser','quota','local']);
  assert.equal(core.snapshot().providers.find(p=>p.id==='quota').health,'exhausted');
});

test('兜底：内置已可用时不会调用本地或非官方服务',async()=>{
  const calls=[];
  const {core}=await setup([
    provider('web',{official:false,async translate(){calls.push('web');return ['网页译文'];}}),
    provider('local',{kind:'local',async translate(){calls.push('local');return ['本地译文'];}}),
    provider('browser',{kind:'builtin',async translate(){calls.push('browser');return ['浏览器译文'];}}),
  ]);
  await core.save('web',true,{});
  assert.equal((await translate(core,job('hello',{noCache:true}))).provider,'browser');assert.deepEqual(calls,['browser']);
});

test('兜底：精确档保留本地优先，只有本地失败才降为内置',async()=>{
  const calls=[];
  const {core}=await setup([
    provider('browser',{kind:'builtin',usedFor:['fast','combined'],async translate(){calls.push('browser');return ['内置译文'];}}),
    provider('local',{kind:'local',usedFor:['accurate','combined'],async translate(){calls.push('local');throw new ProviderError({code:'network',message:'本机未启动',retryable:true});}}),
  ]);
  assert.equal((await translate(core,job('hello',{noCache:true,mode:'accurate'}),'accurate')).provider,'browser');assert.deepEqual(calls,['local','browser']);
});

test('兜底：可选网页接口默认关闭，显式启用维护全局开关，始终排在本机之后',async()=>{
  const {core,local}=await setup([provider('web',{official:false}),provider('local',{kind:'local'})]);
  assert.equal((await core.list()).find(p=>p.id==='web').enabled,false);
  await core.save('web',true,{}); await core.action('web','pin');
  assert.equal(local.data['settings.core'].allowUnofficial,true);
  assert.equal((await translate(core,job('hello',{noCache:true}))).provider,'local');
  assert.equal(core.snapshot().providers.find(p=>p.id==='web').rank,2);
  await assert.rejects(translate(core,job('hello',{noCache:true,providerHint:'web'})),e=>e.info.code==='no_provider');
  await core.save('web',false,{});assert.equal(local.data['settings.core'].allowUnofficial,false);
});

test('兜底：Google收到429持久暂停，重启/自动探测不重试，明确恢复后才再请求',async()=>{
  let calls=0, now=Date.now();
  const web=provider('web',{official:false,async translate(){calls++;throw new ProviderError({code:'rate_limit',message:'429已暂停',retryable:false});}});
  const {core,local}=await setup([web],{now:()=>now});
  await core.save('web',true,{});
  await assert.rejects(translate(core,job('hello',{noCache:true})),e=>e.info.code==='rate_limit');assert.equal(calls,1);
  assert.equal(local.data['backend.providers'].web.paused,true);
  now+=86_400_000;
  await core.probe();await assert.rejects(translate(core,job('next',{noCache:true})));assert.equal(calls,1);
  const restarted=await setup([web],{local,now:()=>now});await restarted.core.probe();
  await assert.rejects(translate(restarted.core,job('restart',{noCache:true})));assert.equal(calls,1);
  await restarted.core.action('web','resume');await assert.rejects(translate(restarted.core,job('resume',{noCache:true})),e=>e.info.code==='rate_limit');assert.equal(calls,2);
});

test('兜底：恢复额度后页面粘性不能把本地提升到额度服务之前',async()=>{
  let quotaFails=true;
  const {core}=await setup([
    provider('quota',{freeQuota:{unit:'char',period:'month',amount:1000},async translate(){if(quotaFails)throw new ProviderError({code:'network',message:'暂时失败',retryable:true});return ['恢复的额度服务'];}}),
    provider('local',{kind:'local'}),
  ]);
  assert.equal((await translate(core,job('one',{noCache:true,priority:1}))).provider,'local');
  quotaFails=false;assert.equal((await translate(core,job('two',{noCache:true,priority:1}))).provider,'quota');
});

test('兜底：网页接口的旧缓存不能绕过关闭开关或抢占可用官方服务',async()=>{
  const {core,storage}=await setup([provider('web',{official:false}),provider('official')]);
  await storage.cachePut('en','zh-CN','fast','Hello.',{text:'网页缓存',provider:'web',version:'1.0.0'});
  assert.equal((await translate(core)).provider,'official');
  await core.save('web',true,{});
  await storage.cachePut('en','zh-CN','fast','Hello.',{text:'网页缓存',provider:'web',version:'1.0.0'});
  assert.equal((await translate(core)).provider,'official');
});

test('内置：真实Window桥接由core注入，显式测试可开准备页，自动探测绝不打开',async()=>{
  const native=require(path.join(build,'backend/providers/browser-translator.js')).default;
  const opened=[],languages=[];
  const {core}=await setup([native],{builtin:{
    async availability(sourceLang,targetLang){languages.push([sourceLang,targetLang]);return {status:'downloadable',sourceLanguage:sourceLang,targetLanguage:targetLang,supportsAuto:false,detectorStatus:'unavailable'};},
    async translate(req){assert.equal(req.sourceLang,'auto');throw new ProviderError({code:'no_provider',message:'语言包未准备',retryable:true});},
  },async openBuiltinSetup(...args){opened.push(args);}});
  await core.probe();assert.deepEqual(opened,[]);
  const result=await core.test(native.id);assert.equal(result.ok,false);assert.ok(result.error.message.includes('已打开'));assert.deepEqual(opened,[['en','zh-CN']]);assert.ok(languages.length>=2);
});

test('内置：浏览器根本不支持API时不打开无效下载页',async()=>{
  const native=require(path.join(build,'backend/providers/browser-translator.js')).default;let opened=0;
  const {core}=await setup([native],{builtin:{
    async availability(sourceLang,targetLang){return {status:'unavailable',sourceLanguage:sourceLang,targetLanguage:targetLang,supportsAuto:false,detectorStatus:'unavailable'};},
    async translate(){throw new ProviderError({code:'no_provider',message:'不支持此API',retryable:true});},
  },async openBuiltinSetup(){opened++;}});
  assert.equal((await core.test(native.id)).ok,false);assert.equal(opened,0);
});

test('兜底：全局非官方开关关闭会阻止已启用的网页服务',async()=>{
  let calls=0;
  const {core,local}=await setup([provider('web',{official:false,async translate(){calls++;return ['网页译文'];}})]);
  await core.save('web',true,{});await translate(core,job('one',{noCache:true}));assert.equal(calls,1);
  await local.set({'settings.core':{version:1,allowUnofficial:false}});await core.refreshPolicy();
  await assert.rejects(translate(core,job('two',{noCache:true})));assert.equal(calls,1);
});

test('兜底：Google429后尚在并发/QPS队列的片段也不会继续发送',async()=>{
  let calls=0;
  const {core}=await setup([provider('web',{official:false,limits:{maxChars:1000,maxSegments:1,concurrency:1,qps:0.2},async translate(){calls++;throw new ProviderError({code:'rate_limit',message:'429已暂停',retryable:false});}})]);
  await core.save('web',true,{});
  const results=await Promise.allSettled([translate(core,job('one',{noCache:true})),translate(core,job('two',{noCache:true}))]);
  assert.ok(results.every(r=>r.status==='rejected'));assert.equal(calls,1);
});


test('内置：显式检测下载中语言包也打开管理卡片，并说明检测方向而不改用户目标语言', async () => {
  const native = require(path.join(build, 'backend/providers/browser-translator.js')).default;
  for (const targetLang of ['ja', 'en']) {
    const local = area({ 'settings.ui': { targetLang } });
    const opened = [];
    const { core } = await setup([native], { local, builtin: {
      async availability(sourceLang, targetLang) { return { status: 'downloading', sourceLanguage: sourceLang, targetLanguage: targetLang }; },
      async translate(request) {
        assert.equal(request.sourceLang, 'auto'); assert.equal(request.targetLang, 'zh-CN');
        throw new ProviderError({ code: 'no_provider', message: '下载尚未完成', retryable: true });
      },
    }, async openBuiltinSetup(...args) { opened.push(args); } });
    const quiet = await core.test(native.id, { prepare: false });
    assert.equal(quiet.error.message, '下载尚未完成'); assert.deepEqual(opened, []);
    const result = await core.test(native.id);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'no_provider');
    assert.match(result.error.message, /已打开.*语言包设置/);
    assert.match(result.error.message, /en → zh-CN/);
    assert.match(result.error.message, /对应语言包/);
    assert.deepEqual(opened, [['en', 'zh-CN']]);
    assert.deepEqual(local.data['settings.ui'], { targetLang });
  }
});

test('内置：管理卡片打开失败时保留真实检测错误，不能谎称已打开', async () => {
  const native = require(path.join(build, 'backend/providers/browser-translator.js')).default;
  let attempts = 0;
  const { core } = await setup([native], { builtin: {
    async availability(sourceLang, targetLang) { return { status: 'downloadable', sourceLanguage: sourceLang, targetLanguage: targetLang }; },
    async translate() { throw new ProviderError({ code: 'no_provider', message: '原始语言包不可用原因', retryable: true }); },
  }, async openBuiltinSetup() { attempts++; throw new Error('标签页创建失败'); } });
  const result = await core.test(native.id);
  assert.equal(result.ok, false); assert.equal(attempts, 1);
  assert.deepEqual(result.error, { code: 'no_provider', message: '原始语言包不可用原因', retryable: true, provider: native.id });
});
