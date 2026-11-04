import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url), build = path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled');
const load = name => require(path.join(build, 'backend', name + '.js'));
const { BackendCore } = load('core'), { BackendStorage } = load('storage'), { SecretVault } = load('secrets');
const deepl = load('providers/deepl').default;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = (status, body) => status === 200 ? Response.json({ translations: JSON.parse(body).text.map(text => ({ text })) }) : new Response('', { status });
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const keyA = 'synthetic-result-A', keyB = 'synthetic-result-B';

async function fixture() {
  const local = { data: {}, async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(this.data[key])])) },
    async set(values) { Object.assign(this.data, structuredClone(values)); } };
  globalThis.chrome = { storage: { local } };
  const vault = new SecretVault({ memory: true, storage: local }), calls = [], behavior = new Map(), usageStatus = new Map();
  const core = new BackendCore({ providers: [deepl], storage: new BackendStorage({ memory: true }), vault,
    fetch: async (url, init) => {
      const key = init.headers.Authorization.replace('DeepL-Auth-Key ', ''); calls.push({ url: String(url), key, body: init.body });
      if (String(url).endsWith('/usage')) return usageStatus.has(key) ? new Response('', { status: usageStatus.get(key) })
        : Response.json({ character_count: 0, character_limit: 1000 });
      return behavior.has(key) ? behavior.get(key)(init.body) : response(200, init.body);
    } });
  await core.ready(); await core.save('deepl', true, { key: keyA }); await core.probe('deepl');
  const run = text => {
    const job = { jobId: crypto.randomUUID(), sourceLang: 'en', targetLang: 'zh-CN', mode: 'fast', priority: 0,
      context: { url: 'https://example.test/deepl-account-results' }, segments: [{ id: 's', kind: 'paragraph', text }] };
    return core.translate(job, job.segments[0], 'fast', new AbortController().signal);
  };
  const state = () => core.snapshot().providers[0];
  const change = async method => { if (method === 'save') await core.save('deepl', true, { key: keyB });
    else { await vault.set('deepl', { key: keyB }); await core.refreshStoredState(); } };
  const accountKey = () => 'deepl@' + core.accountQuota.definition(core.options.providers[0]).account;
  const hold = (key, status) => {
    const started = deferred(), gate = deferred();
    behavior.set(key, async body => { started.resolve(); await gate.promise; return response(status, body); });
    return { started: started.promise, release: gate.resolve };
  };
  return { core, local, calls, behavior, usageStatus, run, state, change, accountKey, hold };
}

for (const method of ['save', 'import']) for (const status of [200, 456, 403]) {
  test(`DeepL ${method}换key后旧HTTP ${status}结果不改变新账户，双方实际发送各计一次`, async () => {
    const f = await fixture(), oldAccount = f.accountKey(), held = f.hold(keyA, status), old = settle(f.run('old'));
    await held.started; await f.change(method);
    assert.equal(f.state().active, true, '换账户不能丢失仍在途的并发槽');
    await f.core.probe('deepl'); const newAccount = f.accountKey();
    assert.notEqual(newAccount, oldAccount); assert.equal((await f.run('new')).text, 'new');
    held.release(); const result = await old;
    if (status === 200) assert.equal(result.value.text, 'old'); else assert.equal(result.error.info.code, status === 456 ? 'quota' : 'auth');
    assert.equal(f.state().health, 'ok'); assert.equal(f.state().circuit, 'closed'); assert.equal(f.state().lastError, undefined);
    assert.equal(f.state().quota.used, 3); assert.equal(f.state().active, false);
    assert.equal(f.local.data['backend.usage'][oldAccount].used, 3); assert.equal(f.local.data['backend.usage'][newAccount].used, 3);
    assert.deepEqual(f.core.runtimes.get('deepl').attempts, [true], '迟到旧结果不进入新账户成功率');
    await f.run('fresh'); assert.equal(f.state().quota.used, 8);
    assert.equal(f.calls.filter(call => call.url.endsWith('/translate') && call.key === keyB).length, 2);
  });
}

for (const method of ['save', 'import']) for (const status of [456, 403]) {
  test(`DeepL ${method}换key后旧成功不能清除新账户${status}错误或耗尽状态`, async () => {
    const f = await fixture(), oldAccount = f.accountKey(), held = f.hold(keyA, 200), old = settle(f.run('old'));
    await held.started; await f.change(method); await f.core.probe('deepl'); const newAccount = f.accountKey();
    f.behavior.set(keyB, body => response(status, body));
    assert.equal((await settle(f.run('newfail'))).error.info.code, status === 456 ? 'quota' : 'auth');
    const before = f.state(); held.release(); assert.equal((await old).value.text, 'old'); const after = f.state();
    assert.equal(after.health, before.health); assert.equal(after.circuit, before.circuit); assert.deepEqual(after.lastError, before.lastError);
    assert.equal(after.quota.used, before.quota.used); assert.equal(after.quota.used, status === 456 ? 1000 : 7);
    assert.deepEqual(f.core.runtimes.get('deepl').attempts, [false]);
    assert.equal(f.local.data['backend.usage'][oldAccount].used, 3); assert.equal(f.local.data['backend.usage'][newAccount].used, before.quota.used);
    await assert.rejects(f.run('blocked')); assert.equal(f.calls.filter(call => call.url.endsWith('/translate') && call.key === keyB).length, 1);
  });
}

for (const method of ['save', 'import']) for (const status of [456, 403]) {
  test(`DeepL ${method}换key清除原账户已完成的${status}错误，不需要重启后台`, async () => {
    const f = await fixture(); f.behavior.set(keyA, body => response(status, body));
    assert.equal((await settle(f.run('oldfail'))).error.info.code, status === 456 ? 'quota' : 'auth');
    await f.change(method); assert.equal(f.state().health, 'ok'); assert.equal(f.state().lastError, undefined); assert.equal(f.state().circuit, 'closed');
    await f.core.probe('deepl'); assert.equal((await f.run('new')).text, 'new'); assert.equal(f.state().quota.used, 3);
  });
}

for (const method of ['save', 'import']) test(`DeepL ${method}换key清除旧usage探测错误`, async () => {
  const f = await fixture(); f.usageStatus.set(keyA, 403); await f.core.probe('deepl'); assert.equal(f.state().lastError.code, 'auth');
  await f.change(method); assert.equal(f.state().lastError, undefined); assert.equal(f.state().health, 'ok');
});

test('DeepL未换key的存储刷新保留真实auth熔断', async () => {
  const f = await fixture(); f.behavior.set(keyA, body => response(403, body)); await settle(f.run('failed'));
  await f.core.refreshStoredState(); assert.equal(f.state().lastError.code, 'auth'); assert.equal(f.state().circuit, 'open');
  await assert.rejects(f.run('blocked')); assert.equal(f.calls.filter(call => call.url.endsWith('/translate')).length, 1);
});

test('DeepL旧账户exhaust等待落盘时换key，await之后不得给新账户追加耗尽状态', async () => {
  const f = await fixture(), oldAccount = f.accountKey(), entered = deferred(), gate = deferred();
  const set = f.local.set.bind(f.local); let once = true;
  f.local.set = async values => {
    if (once && values['backend.usage']?.[oldAccount]?.used === 1000) { once = false; entered.resolve(); await gate.promise; }
    return set(values);
  };
  f.behavior.set(keyA, body => response(456, body)); const old = settle(f.run('old'));
  await entered.promise; await f.change('save'); assert.equal(f.state().health, 'ok');
  gate.resolve(); assert.equal((await old).error.info.code, 'quota');
  assert.equal(f.state().health, 'ok'); assert.equal(f.state().lastError, undefined); assert.equal(f.core.runtimes.get('deepl').exhaustedUntil, undefined);
  await f.core.probe('deepl'); await f.run('new'); assert.equal(f.state().quota.used, 3);
  assert.equal(f.local.data['backend.usage'][oldAccount].used, 1000, '原账户已确认的耗尽计数仍应保存');
});
