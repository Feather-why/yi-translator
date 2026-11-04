import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BackendCore } = require('../.compiled/backend/core.js');
const { BackendStorage } = require('../.compiled/backend/storage.js');
const { SecretVault } = require('../.compiled/backend/secrets.js');
const { ProviderError, classifyError } = require('../.compiled/backend/providers/types.js');
const { translateWithProjectedPlaceholders, hasNestedPlaceholders, NESTED_PROJECTION_REVISION } = require('../.compiled/backend/translation-quality.js');
const { validTranslation } = require('../.compiled/backend/validation.js');
const { wordTokens } = require('../.compiled/backend/align/algorithm.js');

const nested = 'Initially it was named the <g0>"Dynasty of <g1>the Country of the Sea</g1>"</g0> with Sealand later becoming customary.';
const plain = 'Initially it was named the "Dynasty of the Country of the Sea" with Sealand later becoming customary.';
const natural = '最初它被称为“海之国的王朝”，后来Sealand成为惯用名称。';
const expected = '最初它被称为<g0>“<g1>海之国</g1>的王朝”</g0>，后来Sealand成为惯用名称。';
const phrases = { '"Dynasty of the Country of the Sea"': '“海之国的王朝”', 'the Country of the Sea': '海之国' };
const input = (text = nested, extra = {}) => ({ jobId: crypto.randomUUID(), sourceLang: 'en', targetLang: 'zh-CN', mode: 'combined', priority: 0,
  context: { url: 'https://public.example/article', title: 'A complete sentence' }, segments: [{ id: 's', text, kind: 'paragraph' }], ...extra });
const signal = () => new AbortController().signal;
class Storage extends BackendStorage {
  accesses = [];
  constructor() { super({ memory: true }); }
  async tmGet(...args) { this.accesses.push('tmGet'); return super.tmGet(...args); }
  async cacheGet(...args) { this.accesses.push('cacheGet'); return super.cacheGet(...args); }
  async cachePut(...args) { this.accesses.push('cachePut'); return super.cachePut(...args); }
}
async function setup(translate, options = {}) {
  const data = {}, area = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); }, async set(items) { Object.assign(data, structuredClone(items)); } };
  globalThis.chrome = { storage: { local: area } };
  const provider = { id: 'nested-local', name: 'nested-local', version: 'fixture-v1', kind: options.kind ?? 'local', official: true, auth: [],
    usedFor: ['fast', 'accurate', 'combined'], placeholders: 'prompt', limits: { maxChars: 1200, maxSegments: 1, concurrency: 2 },
    freeQuota: { unit: 'char', period: 'month', amount: 10000 }, translate, classifyError };
  const storage = new Storage(), records = [];
  const core = new BackendCore({ providers: [provider], storage, vault: new SecretVault({ memory: true, storage: area }),
    onPlaceholderDiagnostic: (row) => records.push(row), align: options.align });
  await core.ready(); return { core, storage, records, provider };
}
const run = (core, job = input(), abortSignal = signal()) => core.translate(job, job.segments[0], 'accurate', abortSignal);

test('本地嵌套保留自然整句并精确绑定Country of Sea，不采纳合法但错包Dynasty的模型标签', async () => {
  const calls = []; let alignCalls = 0;
  const { core, records } = await setup(async (request) => { calls.push(request); return request.texts.map((text) => {
    if (text.includes('<g')) return '最初称为<g0>“海之国的<g1>王朝</g1>”</g0>，后来Sealand成为惯用名称。';
    return phrases[text] ?? natural;
  }); }, { align: async () => { alignCalls++; throw Error('此宽泛语义映射不应被调用'); } });
  const result = await run(core, input(nested, { noCache: true }));
  assert.equal(result.text, expected); assert.ok(validTranslation(nested, result.text));
  assert.equal(calls.length, 3); assert.equal(calls[0].texts[0], plain);
  assert.equal(calls.some((row) => /<\/?g\d+>/.test(row.texts[0])), false);
  assert.equal(alignCalls, 0, '只有必须独立锚点的嵌套节点时不先跑无效对齐');
  assert.equal(records.length, 1); assert.equal(records[0].outcome, 'success');
  assert.equal(records[0].modelCalls, 3); assert.equal(records[0].anchorCalls, 2); assert.equal(records[0].plainCalls, 1);
  assert.equal(JSON.stringify(records).includes('Country'), false);
});

test('父节点须有独立语义范围，子节点正确不能把父节点扩展到后续Sealand', async () => {
  const calls = [];
  const result = await translateWithProjectedPlaceholders(nested, async (text) => { calls.push(text); return text === 'the Country of the Sea' ? '海之国' : natural; },
    { sourceLang: 'en', targetLang: 'zh', strategy: 'lazy', semanticNesting: true, align: async (pair) => {
      const srcTokens = wordTokens(pair.source, 'en'), tgtTokens = wordTokens(pair.target, 'zh');
      return { id: pair.id, srcTokens, tgtTokens, links: srcTokens.flatMap((_, a) => tgtTokens.map((_, b) => [a, b])) };
    } }, signal());
  assert.equal(result, null, '没有对应父短语锚点，不能凭子范围或整段伪造完整父链接');
  assert.equal(calls.filter((text) => text === plain).length, 2);
});

test('唯一精确词典证据足以恢复时不调用对齐，重复歧义仍请求真实映射', async () => {
  const options = { sourceLang: 'en', targetLang: 'zh', strategy: 'lazy' };
  let calls = 0;
  const unique = await translateWithProjectedPlaceholders('The <g0>browser</g0> runs locally.', async () => '浏览器在本地运行。',
    { ...options, lookup: async () => ({ translations: ['浏览器'] }), align: async () => { calls++; throw Error('已有唯一词面不应调用'); } }, signal());
  assert.equal(unique, '<g0>浏览器</g0>在本地运行。'); assert.equal(calls, 0);
  const repeated = await translateWithProjectedPlaceholders('The <g0>browser</g0> opens another browser.', async () => '浏览器打开另一浏览器。',
    { ...options, lookup: async () => ({ translations: ['浏览器'] }), align: async (pair) => {
      calls++; const srcTokens = wordTokens(pair.source, 'en'), tgtTokens = wordTokens(pair.target, 'zh');
      return { id: pair.id, srcTokens, tgtTokens, links: [[srcTokens.findIndex(([a, b]) => pair.source.slice(a, b) === 'browser'), tgtTokens.findIndex(([a, b]) => pair.target.slice(a, b) === '浏览器')]] };
    } }, signal());
  assert.equal(repeated, '<g0>浏览器</g0>打开另一浏览器。'); assert.equal(calls, 1);
});

test('安装指南嵌套与多个不透明原子保持动作顺序，不发送无效带标重试', async () => {
  const source = 'Open <g2>the <g3>installation guide</g3></g2>, leave <x0/> unchanged, and copy <x7/> only after you have closed the editor.';
  const calls = [];
  const { core } = await setup(async (request) => { calls.push(request); return request.texts.map((text) => {
    if (text === 'the installation guide' || text === 'installation guide') return '安装指南';
    assert.ok(!text.includes('<g')); return '打开安装指南，保持[TXP0_0]不变，只有关闭编辑器后才能复制[TXP0_1]。';
  }); });
  const { text } = await run(core, input(source, { noCache: true }));
  assert.equal(text, '打开<g2><g3>安装指南</g3></g2>，保持<x0/>不变，只有关闭编辑器后才能复制<x7/>。');
  assert.equal(calls.length, 3); assert.ok(validTranslation(source, text));
});

test('嵌套父子与平级同名词不会把一整段归入父链接，不连续编号及原子全部保留', async () => {
  const source = '<g4>The conservation team moved <g9>the bronze seal</g9> to the north gallery</g4>, while <g2>the stone seal</g2> stayed beside <x8/>. Record both catalogue codes, <x3/> and <x11/>, exactly as printed.';
  const anchors = { 'The conservation team moved the bronze seal to the north gallery': '保护组将铜印移至北展厅', 'the bronze seal': '铜印', 'the stone seal': '石印' };
  const calls = [];
  const { core } = await setup(async ({ texts }) => { calls.push(...texts); return texts.map((text) => anchors[text] ?? '保护组将铜印移至北展厅，石印仍在[TXP0_0]旁边。请严格按印刷内容记录目录代码[TXP0_1]和[TXP0_2]。'); });
  const { text } = await run(core, input(source, { noCache: true }));
  assert.equal(text, '<g4>保护组将<g9>铜印</g9>移至北展厅</g4>，<g2>石印</g2>仍在<x8/>旁边。请严格按印刷内容记录目录代码<x3/>和<x11/>。');
  assert.equal(calls.length, 4); assert.equal(calls.some((text) => text.includes('<g')), false);
});

test('冷对齐缺席时先翻子术语并注入父短语，防止铜印和青铜印章冲突退成叶子拼接', async () => {
  const source = '<g4>The conservation team moved <g9>the bronze seal</g9> to the north gallery</g4>, while <g2>the stone seal</g2> stayed beside <x8/>.';
  const parent = 'The conservation team moved the bronze seal to the north gallery', child = 'the bronze seal';
  const calls = [];
  const { core, records } = await setup(async (request) => {
    calls.push(request); return request.texts.map((text) => {
      if (text === child) return '青铜印章';
      if (text === 'the stone seal') return '石印';
      if (text === parent) {
        assert.deepEqual(request.terminology, [{ source: child, target: '青铜印章' }]);
        return '保护团队将青铜印章移至北厅';
      }
      assert.ok(!text.includes('<g'));
      return request.terminology?.length ? '保护团队将青铜印章移至北厅，而石印仍在[TXP0_0]旁边。' : '保护团队将铜印移至北厅，而石印仍在[TXP0_0]旁边。';
    });
  });
  const { text } = await run(core, input(source, { noCache: true }));
  assert.equal(text, '<g4>保护团队将<g9>青铜印章</g9>移至北厅</g4>，而<g2>石印</g2>仍在<x8/>旁边。');
  assert.equal(calls.length, 5); assert.equal(calls[1].texts[0], child);
  assert.equal(records.length, 1); assert.equal(records[0].kind, 'placeholder-projection');
  assert.equal(records[0].outcome, 'success'); assert.equal(records[0].anchorCalls, 3); assert.equal(records[0].plainCalls, 2); assert.equal(records[0].alignmentCalls, 0);
});

test('简单单链接保持原来的一次带标快路，整段重复wrapper也只翻译一次', async () => {
  const calls = [];
  const { core } = await setup(async ({ texts }) => { calls.push(...texts); return texts.map((text) => text === 'Hello.' ? '你好。' : text === 'Read <g0>guide</g0>.' ? '阅读<g0>指南</g0>。' : '不应产生额外请求'); });
  assert.equal((await run(core, input('Read <g0>guide</g0>.', { noCache: true }))).text, '阅读<g0>指南</g0>。');
  assert.equal(calls.length, 1);
  assert.equal(hasNestedPlaceholders('<g4><g9>Hello.</g9></g4>'), true, '同一个源范围的祖孙叠层仍允许新路径');
  assert.equal((await run(core, input('<g4><g9>Hello.</g9></g4>', { noCache: true }))).text, '<g4><g9>你好。</g9></g4>');
  assert.equal(calls.length, 2); assert.equal(hasNestedPlaceholders('<g0>Read</g0> <g1>guide</g1>.'), false);
});

test('不同局部语境重复bank不共用孤立锚点，旧带标路径一次保留河岸与银行', async () => {
  const source = 'The <g0><g1>bank</g1> is eroding</g0>; the <g2><g3>bank</g3> approved a loan</g2>.';
  const target = '<g0><g1>河岸</g1>正在被侵蚀</g0>；<g2><g3>银行</g3>批准了一笔贷款</g2>。';
  const calls = [];
  const { core, storage, records } = await setup(async (request) => {
    calls.push(request); assert.deepEqual(request.texts, [source], '不能先去标或生成全局bank术语'); return [target];
  });
  assert.equal(hasNestedPlaceholders(source), false);
  const { text } = await run(core, input(source));
  assert.equal(text, target); assert.equal(calls.length, 1); assert.deepEqual(records, []);
  assert.equal((await storage.cacheGet('en', 'zh-CN', 'accurate', source)).version, 'fixture-v1', '统一谓词也限制缓存revision');
});

test('重复短语输入在两次带标失败后也不启用新增nested语义锚点模式', async (t) => {
  const quality = require('../.compiled/backend/translation-quality.js'), original = quality.translateWithProjectedPlaceholders;
  const source = 'The <g0><g1>bank</g1> is eroding</g0>; the <g2><g3>bank</g3> approved a loan</g2>.';
  const target = '<g0><g1>河岸</g1>正在被侵蚀</g0>；<g2><g3>银行</g3>批准了一笔贷款</g2>。';
  const options = [], calls = [];
  quality.translateWithProjectedPlaceholders = async (_source, _translate, settings) => { options.push(settings); return target; };
  t.after(() => { quality.translateWithProjectedPlaceholders = original; });
  const { core } = await setup(async (request) => { calls.push(request); return ['结构坏了']; });
  assert.equal((await run(core, input(source, { noCache: true }))).text, target);
  assert.equal(calls.length, 2); assert.ok(calls.every((call) => call.texts[0] === source));
  assert.deepEqual(calls.map((call) => call.strictPlaceholders), [false, true]);
  assert.equal(options.length, 1); assert.equal(options[0].semanticNesting, false);
});

test('nested策略revision仅让受影响的自动缓存失效，人工记忆保留', async () => {
  let calls = 0;
  const { core, storage } = await setup(async ({ texts }) => { calls++; return texts.map((text) => phrases[text] ?? natural); });
  await storage.cachePut('en', 'zh-CN', 'accurate', nested, { text: '最初称为<g0>海之国的<g1>王朝</g1></g0>，后来Sealand成为惯用名称。', provider: 'nested-local', version: 'fixture-v1' });
  const result = await run(core); assert.equal(result.cached, false); assert.equal(result.text, expected); assert.equal(calls, 3);
  const cached = await storage.cacheGet('en', 'zh-CN', 'accurate', nested); assert.ok(cached.version.endsWith(':' + NESTED_PROJECTION_REVISION));
  assert.equal((await run(core)).cached, true); assert.equal(calls, 3);
  await storage.cachePut('en', 'zh-CN', 'accurate', 'Hello.', { text: '你好。', provider: 'nested-local', version: 'fixture-v1' });
  assert.equal((await run(core, input('Hello.'))).cached, true); assert.equal(calls, 3);
  await storage.tmPut('en', 'zh-CN', nested, expected); assert.equal((await run(core)).provider, 'memory'); assert.equal(calls, 3);
});

test('综合两档共享一次嵌套恢复及实际字符预算，noCache不触碰自动存储', async () => {
  const calls = [];
  const { core, storage } = await setup(async (request) => { calls.push(request); return request.texts.map((text) => phrases[text] ?? natural); });
  const request = input(nested, { noCache: true }), session = core.createCombined(request, request.segments[0]);
  try {
    const [a, b] = await Promise.all([session.translate('fast', signal()), session.translate('accurate', signal())]);
    assert.equal(a.text, expected); assert.equal(b.text, expected); assert.equal(calls.length, 3);
    assert.deepEqual(storage.accesses, []);
    assert.equal(core.snapshot().providers[0].quota.used, calls.reduce((sum, call) => sum + [...call.texts[0]].length, 0));
  } finally { session.dispose(); }
});

test('取消和网络故障立即停止恢复，不运行锚点/叶子，也不重复累计父层服务失败', async () => {
  for (const cancel of [false, true]) {
    let calls = 0;
    const controller = new AbortController();
    const { core, records } = await setup(async () => { calls++; if (cancel) { controller.abort(); return [natural]; } throw new ProviderError({ code: 'network', message: '合成网络错误', retryable: true }); });
    await assert.rejects(run(core, input(nested, { noCache: true }), controller.signal), (error) => cancel ? error.name === 'AbortError' : error.info?.code === 'network');
    assert.equal(calls, 1); assert.equal(records.length, 1); assert.equal(records[0].modelCalls, 1);
    assert.equal(records[0].outcome, cancel ? 'cancelled' : 'error');
    if (!cancel) {
      await assert.rejects(run(core, input(nested, { noCache: true })), (error) => error.info?.code === 'network');
      assert.equal(calls, 2); assert.equal(core.snapshot().providers[0].circuit, 'closed', '两次真实失败不能被父子递归算作四次');
    }
  }
});
