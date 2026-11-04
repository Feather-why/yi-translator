import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const build = path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled');
const load = name => require(path.join(build, 'backend', name + '.js'));
const { BackendCore } = load('core');
const { BackendStorage } = load('storage');
const { SecretVault } = load('secrets');
const deepl = load('providers/deepl').default;

async function fixture() {
  const local = { data: {}, async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(this.data[key])])) },
    async set(values) { Object.assign(this.data, structuredClone(values)) } };
  globalThis.chrome = { storage: { local } };
  const calls = [], vault = new SecretVault({ memory: true, storage: local });
  const core = new BackendCore({ providers: [deepl], storage: new BackendStorage({ memory: true }), vault,
    fetch: async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.Authorization, body: init.body });
      return Response.json({ translations: JSON.parse(init.body).text.map(text => ({ text })) });
    } });
  await core.ready(); await core.save('deepl', true, { key: 'synthetic-A' });
  const run = text => {
    const job = { jobId: crypto.randomUUID(), sourceLang: 'en', targetLang: 'zh-CN', mode: 'fast', priority: 0,
      context: { url: 'https://example.test/deepl-generation' }, segments: [{ id: 's', kind: 'paragraph', text }] };
    return core.translate(job, job.segments[0], 'fast', new AbortController().signal);
  };
  return { core, vault, calls, run };
}

async function waitFor(predicate) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('任务没有进入预期聚合队列');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

for (const change of ['save', 'import']) test(`DeepL ${change}换key不能把新任务并入待失效的旧任务批次`, async () => {
  const { core, vault, calls, run } = await fixture();
  // 控制5ms聚合窗口，确定性覆盖保存/导入与聚合交错的情况，不依赖机器速度。
  const flush = core.batcher.flush.bind(core.batcher);
  core.batcher.flush = () => {};
  const oldTask = run('old account task').then(value => ({ value }), error => ({ error }));
  await waitFor(() => core.batcher.pending.size === 1);
  if (change === 'save') await core.save('deepl', true, { key: 'synthetic-B' });
  else { await vault.set('deepl', { key: 'synthetic-B' }); await core.refreshStoredState(); }
  const newTask = run('new account task');
  await waitFor(() => [...core.batcher.pending.values()].flat().length === 2);
  assert.equal(core.batcher.pending.size, 2, '不同配置代号必须独立聚合');
  flush();
  assert.match((await oldTask).error.message, /配置已变更/);
  assert.equal((await newTask).text, 'new account task');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, 'DeepL-Auth-Key synthetic-B');
  assert.deepEqual(JSON.parse(calls[0].body).text, ['<txroot>new account task</txroot>']);
});

test('DeepL内部配置代号不导致已验证缓存因保存设置失效', async () => {
  const { core, calls, run } = await fixture();
  assert.equal((await run('cached sentence')).cached, false);
  await core.save('deepl', true, { key: 'synthetic-B' });
  assert.equal((await run('cached sentence')).cached, true);
  assert.equal(calls.length, 1);
});
