import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { translateWithProjectedPlaceholders } = require('../.compiled/backend/translation-quality.js');
const { validTranslation } = require('../.compiled/backend/validation.js');
const { wordTokens } = require('../.compiled/backend/align/algorithm.js');
const options = { sourceLang: 'en', targetLang: 'zh-CN' };
const signal = () => new AbortController().signal;

test('整句投影保留自然语序，链接/原子从本机复原而非拼接短词译文', async () => {
  const source = 'Read <g0>the guide</g0> before you run <x0/>.';
  const calls = [];
  const result = await translateWithProjectedPlaceholders(source, async (text, terms) => {
    calls.push({ text, terms });
    return text === 'the guide' ? '指南' : '运行[TXP0_0]之前，请阅读指南。';
  }, options, signal());
  assert.equal(result, '运行<x0/>之前，请阅读<g0>指南</g0>。');
  assert.equal(validTranslation(source, result), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].terms, [{ source: 'the guide', target: '指南' }]);
});

test('嵌套词组只作锚点，不改变整句译文或父子层级', async () => {
  const source = 'Read the <g0>installation <g1>guide and <g2>examples</g2></g1></g0>.';
  const dictionary = { 'installation guide and examples': '安装指南和示例', 'guide and examples': '指南和示例', examples: '示例' };
  const result = await translateWithProjectedPlaceholders(source, async (text) => dictionary[text] ?? '请阅读安装指南和示例。', options, signal());
  assert.equal(result, '请阅读<g0>安装<g1>指南和<g2>示例</g2></g1></g0>。');
  assert.equal(validTranslation(source, result), true);
});

test('真实词映射允许中文语序调整，并把重复词链接限制在对应词上', async () => {
  const source = '<g0>Machine translation</g0> is used to <g1>translate</g1> from one <g2>language</g2> to another language.';
  const target = '机器翻译用于将一种语言的内容翻译成另一种语言。';
  const anchors = { 'Machine translation': '机器翻译', translate: '翻译', language: '语言' };
  const result = await translateWithProjectedPlaceholders(source, async (text) => anchors[text] ?? target, { ...options, align: async (pair) => {
    const srcTokens = wordTokens(pair.source, 'en'), tgtTokens = wordTokens(pair.target, 'zh-CN');
    return { id: pair.id, srcTokens, tgtTokens, links: [[srcTokens.findIndex(([a,b]) => pair.source.slice(a,b) === 'language'), tgtTokens.findIndex(([a,b]) => pair.target.slice(a,b) === '语言')]] };
  } }, signal());
  assert.equal(result, '<g0>机器翻译</g0>用于将一种<g2>语言</g2>的内容<g1>翻译</g1>成另一种语言。');
});

test('句子级全连边不能拿来把单个链接包住整句，缺证据安全返回null', async () => {
  const source = 'The <g0>guide</g0> explains how the local browser translates a complete page.';
  const result = await translateWithProjectedPlaceholders(source, async (text) => text === 'guide' ? '指导书' : '该指南解释本地浏览器如何翻译整个页面。', { ...options, align: async (pair) => {
    const srcTokens = wordTokens(pair.source, 'en'), tgtTokens = wordTokens(pair.target, 'zh-CN');
    return { id: pair.id, srcTokens, tgtTokens, links: srcTokens.flatMap((_, a) => tgtTokens.map((_, b) => [a,b])) };
  } }, signal());
  assert.equal(result, null);
});

test('冷模型通过真实词典义项匹配同义译词，保留完整从一种语言到另一种的句义', async () => {
  const source = '<g0>Machine translation</g0> uses computers to <g1>translate</g1> from one <g2>language</g2> to another language.';
  const target = '机器翻译利用计算机将一种语言转换为另一种语言。';
  const anchors = { 'Machine translation': '机器翻译', translate: '翻译', language: '语言' };
  const result = await translateWithProjectedPlaceholders(source, async (text) => anchors[text] ?? target, { ...options, lookup: async (word) => word === 'translate' ? { translations: ['vt. 翻译, 解释, 转化\\n[计] 转换'] } : null }, signal());
  assert.equal(result, '<g0>机器翻译</g0>利用计算机将一种<g2>语言</g2><g1>转换</g1>为另一种语言。');
  assert.equal(validTranslation(source, result), true);
});

test('原子缺失/重复/更名均拒绝，原有同形文本不会与内部marker冲突', async () => {
  for (const translated of ['运行命令。', '运行[TXP0_0][TXP0_0]。', '运行[TXP0_9]。']) {
    assert.equal(await translateWithProjectedPlaceholders('Run <x0/>.', async () => translated, options, signal()), null);
  }
  const source = 'Keep [TXP0_0] and <x0/>.';
  assert.equal(await translateWithProjectedPlaceholders(source, async () => '保留[TXP0_0]和[TXP1_0]。', options, signal()), '保留[TXP0_0]和<x0/>。');
});

test('外层整段不重复翻译为术语，原子仍位于原格式父级', async () => {
  const calls = [];
  const source = '<g0>Run <x0/>.</g0>';
  const result = await translateWithProjectedPlaceholders(source, async (text) => { calls.push(text); return '运行[TXP0_0]。'; }, options, signal());
  assert.equal(result, '<g0>运行<x0/>。</g0>'); assert.equal(calls.length, 1);
});

test('取消或不可用对齐不伪造比例位置；锚点额外请求有上限', async () => {
  const controller = new AbortController();
  await assert.rejects(translateWithProjectedPlaceholders('Read <g0>guide</g0>.', async () => { controller.abort(); return '指南'; }, options, controller.signal), { name: 'AbortError' });
  const source = Array.from({ length: 10 }, (_, index) => `<g${index}>word${index}</g${index}>`).join(' ');
  let count = 0;
  const result = await translateWithProjectedPlaceholders(source, async () => { count++; return '没有对应锚点'; }, options, signal());
  assert.equal(result, null); assert.equal(count, 7);
});
