import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { heuristicAlignment, wordTokens, alignmentLinkAllowed, validAlignment } = require('../.compiled/backend/align/algorithm.js');
const { quotedSpans, pairedQuotes, quoteLinkAllowed } = require('../.compiled/backend/align/quote-boundaries.js');
const { constrainSentenceLinks, semanticSentenceGroups } = require('../.compiled/backend/align/sentence-alignment.js');
const { refineWithDictionary } = require('../.compiled/backend/align/dictionary-links.js');
const { AlignmentService } = require('../.compiled/backend/align/index.js');
const { pairs } = JSON.parse(readFileSync(new URL('./align-selection.fixture.json', import.meta.url)));
const quote = pairs[0], babylon = pairs[2];
const span = (text, fragment) => [text.indexOf(fragment), text.indexOf(fragment) + fragment.length];
function rawQuote(pair = quote) {
  const value = heuristicAlignment(pair);
  for (const [source, target] of [['Dynasty', '王朝'], ['Country', '国'], ['Sea', '海'], ['the', 'Sealand'], ['of', 'Sealand']]) {
    const a = value.srcTokens.findIndex(([x, y]) => pair.source.slice(x, y) === source);
    const b = value.tgtTokens.findIndex(([x, y]) => pair.target.slice(x, y) === target);
    assert.ok(a >= 0 && b >= 0); value.links.push([a, b]);
  }
  return value;
}
function selected(pair, value, from, reverse = false) {
  const tokens = reverse ? value.tgtTokens : value.srcTokens, target = reverse ? value.srcTokens : value.tgtTokens;
  const chosen = new Set(tokens.map(([a, b], index) => a < from[1] && b > from[0] ? index : -1));
  return [...new Set(value.links.filter((link) => chosen.has(link[reverse ? 1 : 0])).map((link) => link[reverse ? 0 : 1]))].map((index) => target[index]);
}
function rawBabylon() {
  const value = heuristicAlignment(babylon);
  const meanings = { Babylon: '巴比伦', also: '还', regional: '地区', capital: '首都', other: '其他', empires: '帝国', Achaemenid: '契', Empire: '帝国', ancient: '古城', Mesopotamia: '美' };
  for (const [word, meaning] of Object.entries(meanings)) {
    const a = value.srcTokens.findIndex(([x, y]) => babylon.source.slice(x, y) === word);
    const targets = value.tgtTokens.map(([x, y], index) => babylon.target.slice(x, y) === meaning ? index : -1).filter((index) => index >= 0);
    value.links.push([a, word === 'Empire' || word === 'Mesopotamia' ? targets.at(-1) : targets[0]]);
  }
  value.links.push([value.srcTokens.findIndex(([a, b]) => babylon.source.slice(a, b) === '.'), value.tgtTokens.length - 1]);
  return value;
}

test('截图引用用真实多实词锚点配对，目标多一对Sealand引号也不会按序硬配', () => {
  for (const pair of [quote, { ...quote, target: '后来“Sealand”成为常用名称；最初它被称为“海之国王朝”。' }]) {
    const value = rawQuote(pair), matched = pairedQuotes(pair, value);
    assert.deepEqual(matched, [{ source: span(pair.source, pair.phrase), target: span(pair.target, pair.expectedPhrase) }]);
    const result = constrainSentenceLinks(pair, value);
    const linked = selected(pair, result, span(pair.source, pair.phrase));
    const target = span(pair.target, pair.expectedPhrase);
    assert.ok(linked.length); assert.ok(linked.every(([a, b]) => a >= target[0] && b <= target[1]));
    const back = selected(pair, result, target, true), source = span(pair.source, pair.phrase);
    assert.ok(back.every(([a, b]) => a >= source[0] && b <= source[1]));
    assert.deepEqual(result.spans.find((item) => item.kind === 'phrase'), { kind: 'phrase', source, target });
  }
});

test('英语虚词不能映到中文译文里的另一个Latin专名，同文词和其他目标语言仍保留', () => {
  const pair = { ...quote, source: 'the was of Sealand', target: 'Sealand' };
  const source = wordTokens(pair.source, 'en'), target = [0, 7];
  assert.deepEqual(source.map((item) => alignmentLinkAllowed(pair, item, target)), [false, false, false, true]);
  assert.equal(alignmentLinkAllowed({ ...pair, target: 'le', targetLang: 'fr' }, source[0], [0, 2]), true);
});

test('含引号一起选择时，开闭标记也只能落在同一被证实的引用，不亮后面的Sealand引号', () => {
  const raw = rawQuote();
  raw.srcTokens.forEach(([a, b], left) => {
    if (quote.source.slice(a, b) !== '"') return;
    raw.tgtTokens.forEach(([x, y], right) => { if (/[“”]/u.test(quote.target.slice(x, y))) raw.links.push([left, right]); });
  });
  const result = constrainSentenceLinks(quote, raw), source = quotedSpans(quote.source)[0].outer, target = quotedSpans(quote.target)[0].outer;
  assert.ok(selected(quote, result, source).every(([a, b]) => a >= target[0] && b <= target[1]));
});

test('未知、重复单一实词或虚词不够支持引号配对，保留词级tokens不造整短语假词', () => {
  const pair = { ...quote, source: '"Sea Sea"', target: '“海 国”' }, value = heuristicAlignment(pair);
  value.links = [[1, 1], [2, 2]];
  assert.deepEqual(pairedQuotes(pair, value), []);
  const result = constrainSentenceLinks(pair, value);
  assert.deepEqual(result.srcTokens, wordTokens(pair.source, 'en')); assert.equal(result.spans.some((item) => item.kind === 'phrase'), false);
});

test('词典不能把引用里的Country改贴到同句引号外的地区', async () => {
  const pair = { ...quote, target: '最初它被称为“海之国王朝”，后来该地区以“Sealand”为常用名称。' };
  const result = await refineWithDictionary(pair, rawQuote(pair), { lookup: async (word) => word.toLowerCase() === 'country' ? { word, translations: ['n. 地区'], source: 'ecdict' } : null });
  const country = result.srcTokens.findIndex(([a, b]) => pair.source.slice(a, b) === 'Country');
  assert.deepEqual(result.links.filter(([a]) => a === country).map(([, b]) => pair.target.slice(...result.tgtTokens[b])), ['国']);
});

test('截图缺句末标点借实词及重复主语译词定位边界，整句span不越下一句巴比伦', () => {
  const raw = rawBabylon(), expected = { source: span(babylon.source, babylon.sentence), target: span(babylon.target, babylon.expectedSentence) };
  const groups = semanticSentenceGroups(babylon, raw); assert.equal(groups.length, 2); assert.deepEqual(groups[0], expected);
  const result = constrainSentenceLinks(babylon, raw);
  assert.deepEqual(result.spans[0], { kind: 'sentence', ...expected });
  assert.ok(selected(babylon, result, expected.source).every(([a, b]) => a >= expected.target[0] && b <= expected.target[1]));
  assert.ok(selected(babylon, result, expected.target, true).every(([a, b]) => a >= expected.source[0] && b <= expected.source[1]));
  assert.deepEqual(result.srcTokens, raw.srcTokens); assert.deepEqual(result.tgtTokens, raw.tgtTokens);
  assert.ok(result.links.length < raw.links.length, '只滤掉跨界句号，不用虚假覆盖补链接');
});

test('缺句号且没有足够独立实词证据时保留合并句组，不按长度拆出伪句界', () => {
  const pair = { ...babylon, source: 'Alpha remains. Beta grows.', target: '甲仍在乙生长。' }, raw = heuristicAlignment(pair);
  raw.links = [[0, 0], [3, 2]];
  assert.equal(semanticSentenceGroups(pair, raw).length, 1);
});

test('引用范围使用UTF16，emoji不偏移，英文词内撇号不成为边界', () => {
  const value = '🙂 Sealand\'s title is “Dynasty of the Sea”.';
  assert.deepEqual(quotedSpans(value).map((item) => value.slice(...item.inner)), ['Dynasty of the Sea']);
  assert.equal(quotedSpans(value)[0].inner[0], value.indexOf('Dynasty'));
  const matched = [{ source: [5, 10], target: [3, 8] }];
  assert.equal(quoteLinkAllowed([6, 8], [9, 11], matched), false);
});

test('可选spans严格检查范围/kind，缓存复制可保留并保护元数据', async () => {
  const raw = rawQuote(), value = constrainSentenceLinks(quote, raw);
  assert.equal(validAlignment(quote, value), true);
  for (const invalid of [{ kind: 'word', source: [0, 1], target: [0, 1] }, { kind: 'phrase', source: [0, 999], target: [0, 1] }, { kind: 'sentence', source: [0, 1], target: [2, 2] }]) {
    assert.equal(validAlignment(quote, { ...value, spans: [invalid] }), false);
  }
  const service = new AlignmentService({ infer: async () => [raw] });
  const [first] = await service.get([quote], { waitForModel: true }); first.spans[0].target[1] = 999;
  const [cached] = await service.get([{ ...quote, id: 'cached' }]);
  assert.equal(cached.id, 'cached'); assert.ok(cached.spans.every((item) => item.target[1] <= quote.target.length)); service.dispose();
});

test('策略revision隔离旧链接、严格缓存及预计算在途键，不复用旧Sealand结果', async () => {
  let calls = 0; const raw = rawQuote(), service = new AlignmentService({ infer: async () => { calls++; return [raw]; } });
  const oldKey = JSON.stringify([quote.source, quote.target, quote.sourceLang, quote.targetLang]);
  service.cache.set(oldKey, raw); service.preciseCache.set(oldKey + ':local', raw);
  service.pending.set(oldKey, { promise: new Promise(() => {}), task: { priority: 100, run: async () => {} } });
  await service.precompute(quote);
  const [result] = await service.get([quote], { waitForModel: true });
  assert.equal(calls, 1); assert.ok(result.spans.some((item) => item.kind === 'phrase'));
  assert.ok(selected(quote, result, span(quote.source, quote.phrase)).every(([a, b]) => a >= 7 && b <= 12)); service.dispose();
});
