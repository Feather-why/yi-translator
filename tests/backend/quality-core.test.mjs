import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BackendCore } = require('../.compiled/backend/core.js');
const { BackendStorage } = require('../.compiled/backend/storage.js');
const { SecretVault } = require('../.compiled/backend/secrets.js');
const { classifyError, ProviderError } = require('../.compiled/backend/providers/types.js');
const { splitTranslationText } = require('../.compiled/backend/translation-chunks.js');
const { validTranslation } = require('../.compiled/backend/validation.js');

function setup(translate, options = {}) {
  const data = {};
  const area = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); }, async set(values) { Object.assign(data, structuredClone(values)); } };
  globalThis.chrome = { storage: { local: area } };
  const provider = { id: 'local', name: 'local', kind: 'local', version: 'quality-fixture', official: true, auth: [],
    usedFor: ['fast', 'accurate', 'combined'], limits: { maxChars: options.maxChars ?? 1200, maxSegments: 1, concurrency: 2 }, placeholders: 'prompt', translate, classifyError };
  const storage = new BackendStorage({ memory: true });
  const core = new BackendCore({ providers: [provider], storage, vault: new SecretVault({ memory: true, storage: area }), onTranslated: options.onTranslated });
  return { core, storage };
}
function job(text, extra = {}) {
  return { jobId: crypto.randomUUID(), mode: 'fast', sourceLang: 'en', targetLang: 'zh-CN', priority: 0,
    context: { url: 'https://example.test/quality' }, segments: [{ id: 's', text, kind: 'paragraph' }], ...extra };
}
const run = (core, request, signal = new AbortController().signal) => core.translate(request, request.segments[0], 'fast', signal);

test('本地模型两次丢标签后优先整句投影，译文语序不再由标签叶子决定', async () => {
  const calls = [];
  const source = 'A <g0>small dog</g0> sleeps beside the <g1>window</g1>.';
  const { core } = setup(async (request) => {
    calls.push(request);
    return request.texts.map((text) => text.includes('<g') ? '无标签的旧响应' : text === 'small dog' ? '小狗' : text === 'window' ? '窗' : text === 'A small dog sleeps beside the window.' ? '一只小狗在窗边睡觉。' : '不应进入碎片翻译');
  });
  const result = await run(core, job(source, { noCache: true, mode: 'accurate' }));
  assert.equal(result.text, '一只<g0>小狗</g0>在<g1>窗</g1>边睡觉。');
  assert.equal(validTranslation(source, result.text), true);
  const whole = calls.filter((call) => call.texts[0] === 'A small dog sleeps beside the window.');
  assert.equal(whole.length, 1, '先完整语境译一次，按需补锚点后不重复译正文');
  assert.equal(calls[2], whole[0], 'local lazy策略先取完整正文，不预先逐个译标签短语');
  assert.equal(whole[0].terminology, undefined);
  assert.ok(!calls.some((call) => call.texts.includes('sleeps beside the')));
});

test('缓存与个人译文命中也预计算对应关系，noCache不触发预计算', async () => {
  let network = 0;
  const precomputed = [];
  const { core, storage } = setup(async ({ texts }) => { network++; return texts.map(() => '你好。'); }, { onTranslated: (request, segment, text) => precomputed.push(text) });
  const request = job('Hello.');
  await run(core, request);
  assert.equal((await run(core, request)).cached, true);
  assert.equal(network, 1);
  await storage.tmPut('en', 'zh-CN', 'Hello.', '您好。');
  assert.equal((await run(core, request)).provider, 'memory');
  await run(core, job('Hello.', { noCache: true }));
  assert.deepEqual(precomputed, ['你好。', '你好。', '您好。']);
});

test('长纯文本按句边界请求，模型不再接收半个英文词', async () => {
  const source = 'The children read a book. A dog sleeps beside the window. Tomorrow we visit the museum.';
  const chunks = [];
  const { core } = setup(async ({ texts }) => { chunks.push(...texts); return texts.map((text) => text.trim()); }, { maxChars: 40 });
  const result = await run(core, job(source, { noCache: true }));
  assert.equal(result.text, source);
  assert.deepEqual(chunks, ['The children read a book. ', 'A dog sleeps beside the window. ', 'Tomorrow we visit the museum.']);
});

test('翻译分块不劈开Unicode代理对或不透明原子，且完整保留源文本', () => {
  const source = 'Read carefully; keep [TXP0_0] and 🙂 unchanged. Then continue with this sentence.';
  const chunks = splitTranslationText(source, 27, 'en');
  assert.equal(chunks.join(''), source);
  assert.ok(chunks.every((chunk) => chunk.length <= 27));
  assert.ok(chunks.every((chunk) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk)));
  assert.equal(chunks.filter((chunk) => chunk.includes('[TXP0_0]')).length, 1);
  const ordinary = 'Read [this long bracketed explanation] now.';
  assert.equal(splitTranslationText(ordinary, 16, 'en').join(''), ordinary);
});

test('辅助锚点出现意外标签时仍进入最终安全降级', async () => {
  const source = 'A <g0>small dog</g0> sleeps.';
  let anchorCalls = 0;
  const { core } = setup(async ({ texts }) => texts.map((text) => {
    if (text.includes('<g')) return '无标记响应';
    if (text === 'small dog') return ++anchorCalls <= 2 ? '<g9>坏锚点</g9>' : '小狗';
    return text.trim() === 'A' ? '一只' : '睡觉。';
  }));
  const result = await run(core, job(source, { noCache: true, mode: 'accurate' }));
  assert.equal(validTranslation(source, result.text), true);
  assert.equal(anchorCalls, 3);
});

test('整句恢复中的网络故障和取消均立即上报，不继续执行叶子降级', async () => {
  const source = 'A <g0>small dog</g0> sleeps.';
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const calls = [];
    const { core } = setup(async ({ texts }) => {
      calls.push(...texts);
      if (texts[0].includes('<g')) return ['无标记响应'];
      if (cancelled) { controller.abort(); return ['小狗']; }
      throw new ProviderError({ code: 'network', message: '合成网络故障', retryable: true });
    });
    await assert.rejects(run(core, job(source, { noCache: true, mode: 'accurate' }), controller.signal), (error) => cancelled ? error.name === 'AbortError' : error.info?.code === 'network');
    assert.equal(calls.length, 3);
    assert.ok(!calls.includes('A'));
  }
});

test('标签结构保持完整的长多句段落优先整句分块', async () => {
  const source = 'The <g0>children</g0> read a book. The <g1>dog</g1> sleeps by the window.';
  const calls = [];
  const { core } = setup(async ({ texts }) => { calls.push(...texts); return texts; }, { maxChars: 48 });
  const result = await run(core, job(source, { noCache: true }));
  assert.equal(validTranslation(source, result.text), true);
  assert.ok(calls.includes('The <g0>children</g0> read a book. '));
  assert.ok(calls.includes('The <g1>dog</g1> sleeps by the window.'));
});
