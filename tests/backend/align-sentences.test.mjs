import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { wordTokens, heuristicAlignment, alignEmbeddings } = require('../.compiled/backend/align/algorithm.js');
const { sentenceSpans, sentenceGroups, sentenceAlignmentFallback, constrainSentenceLinks, alignmentWindows } = require('../.compiled/backend/align/sentence-alignment.js');
const { alignSentencePair } = require('../.compiled/backend/align/local-pairs.js');
const { AlignmentService } = require('../.compiled/backend/align/index.js');
const { refineWithDictionary } = require('../.compiled/backend/align/dictionary-links.js');
const { Dictionary } = require('../.compiled/backend/dict/index.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const paragraph = {
  id: 'sentences', source: 'The children are reading a book. A small dog sleeps beside the window. Tomorrow, we will visit the museum.',
  target: '孩子们正在读书。一只小狗在窗边睡觉。明天，我们将去博物馆参观。', sourceLang: 'auto', targetLang: 'zh-CN',
};
function selected(result, sourceSpan) {
  const indices = new Set(result.srcTokens.map(([a, b], index) => a < sourceSpan[1] && b > sourceSpan[0] ? index : -1));
  return [...new Set(result.links.filter(([source]) => indices.has(source)).map(([, target]) => target))].sort((a, b) => a - b).map((target) => result.tgtTokens[target]);
}

test('分句保留UTF16并处理英文缩写、小数、中文引号，不把emoji偏移当码点', () => {
  const source = '🙂 Dr. Smith paid 3.14 dollars. Then he left.';
  const spans = sentenceSpans(source, 'en');
  assert.deepEqual(spans.map(([a, b]) => source.slice(a, b)), ['🙂 Dr. Smith paid 3.14 dollars.', 'Then he left.']);
  assert.equal(spans[1][0], source.indexOf('Then'));
  const chinese = '他说：“先开门。”然后我们进去。';
  assert.deepEqual(sentenceSpans(chinese, 'zh').map(([a, b]) => chinese.slice(a, b)), ['他说：“先开门。”', '然后我们进去。']);
  const references = 'First sentence.[1][2] Second sentence.';
  assert.deepEqual(sentenceSpans(references, 'en').map(([a, b]) => references.slice(a, b)), ['First sentence.[1][2]', 'Second sentence.']);
});

test('未知词不制造位置链接；可靠词链接选整句仍局限对应句，选词保持局部', () => {
  const empty = sentenceAlignmentFallback(paragraph), groups = sentenceGroups(paragraph);
  assert.deepEqual(empty.srcTokens, wordTokens(paragraph.source, paragraph.sourceLang));
  assert.ok(empty.srcTokens.length > 12 && empty.tgtTokens.length > 8);
  assert.deepEqual(empty.links, []);
  const meanings = { A: '一只', small: '小狗', dog: '小狗', sleeps: '睡觉', beside: '边', window: '窗', '.': '。' };
  const links = [];
  empty.srcTokens.forEach(([a, b], source) => {
    if (a < groups[1].source[0] || a >= groups[1].source[1]) return;
    const meaning = meanings[paragraph.source.slice(a, b)];
    empty.tgtTokens.forEach(([x, y], target) => { if (x >= groups[1].target[0] && x < groups[1].target[1] && paragraph.target.slice(x, y) === meaning) links.push([source, target]); });
  });
  const result = constrainSentenceLinks(paragraph, { ...empty, links });
  const ranges = selected(result, groups[1].source);
  assert.ok(ranges.length > 2);
  assert.equal(Math.min(...ranges.map(([a]) => a)), groups[1].target[0]);
  assert.equal(Math.max(...ranges.map(([, b]) => b)), groups[1].target[1]);
  for (const [source, target] of result.links) {
    const left = groups.findIndex((group) => result.srcTokens[source][0] >= group.source[0] && result.srcTokens[source][0] < group.source[1]);
    const right = groups.findIndex((group) => result.tgtTokens[target][0] >= group.target[0] && result.tgtTokens[target][0] < group.target[1]);
    assert.equal(left, right);
  }
  const dog = paragraph.source.indexOf('dog');
  const wordRanges = selected(result, [dog, dog + 3]);
  assert.ok(wordRanges.reduce((sum, [a, b]) => sum + b - a, 0) < groups[1].target[1] - groups[1].target[0]);
});

test('一对多/多对一分句配对保留后面的独立句，不把整个段落合为一个单元', () => {
  const pair = { ...paragraph, source: 'I bought apples and oranges. We went home.', target: '我买了苹果。还买了橙子。我们回家了。' };
  const groups = sentenceGroups(pair);
  assert.equal(groups.length, 2);
  assert.equal(pair.target.slice(...groups[0].target), '我买了苹果。还买了橙子。');
  assert.equal(pair.target.slice(...groups[1].target), '我们回家了。');
  const reversed = sentenceGroups({ ...pair, source: pair.target, target: pair.source, sourceLang: 'zh', targetLang: 'en' });
  assert.equal(reversed.length, 2);
  assert.equal(pair.target.slice(...reversed[0].source), '我买了苹果。还买了橙子。');
});

test('重复词/数字的跨句模型噪声会被过滤，严格投影结果不会补比例估算链接', () => {
  const pair = { ...paragraph, source: 'A browser opens page 1. Another browser opens page 2.', target: '浏览器打开页面1。另一个浏览器打开页面2。' };
  const base = heuristicAlignment(pair);
  const first = base.srcTokens.findIndex(([a, b]) => pair.source.slice(a, b) === 'browser');
  const last = base.tgtTokens.findIndex(([a]) => a > pair.target.indexOf('。') && pair.target.slice(a).startsWith('浏览'));
  assert.ok(first >= 0 && last >= 0);
  const raw = { ...base, links: [[first, last]] };
  assert.deepEqual(constrainSentenceLinks(pair, raw, { coverage: false }).links, []);
  assert.deepEqual(constrainSentenceLinks(pair, raw).links, []);
});

test('长段按句/窗口实际调用embedding，不因整段超过254tokens而整段回退', async () => {
  const pair = { ...paragraph, source: 'A browser opens a page. '.repeat(35), target: '浏览器打开页面。'.repeat(35), sourceLang: 'en' };
  const calls = [];
  const result = await alignSentencePair(pair, async (text, language) => {
    calls.push(text);
    assert.ok(text.length <= 160);
    return wordTokens(text, language).map((_, index) => [index % 2, (index + 1) % 2]);
  });
  assert.equal(calls.length, 2);
  assert.ok(result.links.length > 10);
  assert.ok(alignmentWindows(pair).length === 35);
});

test('auto英文会用真实词典锚点，并把同义词限制在对应句内；冷词典不阻塞首次返回', async () => {
  const dictionary = new Dictionary({ memory: true, entries: [{ word: 'dog', translation: 'n. 狗, 犬' }] });
  await dictionary.ready();
  const pair = { ...paragraph, target: '孩子们正在读书。一只狗在窗边睡觉。明天，我们将去博物馆看另一只狗。' };
  const result = await refineWithDictionary(pair, heuristicAlignment(pair), dictionary);
  const dog = result.srcTokens.findIndex(([a, b]) => pair.source.slice(a, b) === 'dog');
  const linked = result.links.filter(([source]) => source === dog).map(([, target]) => result.tgtTokens[target]);
  assert.equal(linked.length, 1);
  assert.ok(linked[0][0] < pair.target.indexOf('明天'));
  let lookedUp = false;
  const cold = new AlignmentService({ initialize: async () => { await sleep(50); }, infer: async (pairs) => pairs.map(heuristicAlignment), dictionary: { status: () => ({ ready: false }), lookup: async () => { lookedUp = true; return null; } } });
  const start = performance.now();
  const [fallback] = await cold.get([paragraph]);
  assert.ok(performance.now() - start < 100);
  assert.equal(lookedUp, false); assert.deepEqual(fallback.links, []);
  await cold.precompute(paragraph);
});

test('前台请求插到排队预计算之前，配置变更不把旧结果缓存进新配置', async () => {
  const order = []; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = new AlignmentService({ infer: async (pairs) => { order.push(pairs[0].id); if (pairs[0].id === 'running') await gate; return pairs.map(heuristicAlignment); } });
  const active = service.precompute({ ...paragraph, id: 'running' });
  await sleep(2);
  const background = service.precompute({ ...paragraph, id: 'background', source: paragraph.source + ' Back.' });
  const foreground = service.get([{ ...paragraph, id: 'foreground', source: paragraph.source + ' Front.' }], { waitForModel: true });
  release(); await Promise.all([active, background, foreground]);
  assert.deepEqual(order, ['running', 'foreground', 'background']);
  let complete;
  const delayed = new AlignmentService({ infer: (pairs) => new Promise((resolve) => { complete = () => resolve(pairs.map(heuristicAlignment)); }) });
  const work = delayed.precompute(paragraph); await sleep(2); delayed.configure({ enabled: false }); complete(); await work;
  assert.equal(delayed.status().cached, 0);
});

test('标签投影冷机不加载模型，热机只返回raw语义链接，超时不把排队比例回退当真链接', async () => {
  let inferCalls = 0;
  const raw = { ...heuristicAlignment(paragraph), links: [[1, 0]] };
  const service = new AlignmentService({ infer: async () => { inferCalls++; return [raw]; } });
  assert.equal(await service.projection(paragraph), undefined); assert.equal(inferCalls, 0);
  const [full] = await service.get([paragraph], { waitForModel: true });
  assert.deepEqual(full.links, raw.links);
  const projected = await service.projection(paragraph);
  assert.deepEqual(projected.links, raw.links);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let blocked = false;
  const slow = new AlignmentService({ infer: async (pairs) => { if (blocked) await gate; return pairs.map(heuristicAlignment); } });
  await slow.get([paragraph], { waitForModel: true }); blocked = true;
  assert.equal(await slow.projection(paragraph, 5), undefined);
  release(); await sleep(2);
});

test('首次模型加载在有界等待内完成时，返回真实词义而不锁定冷启动空结果', async () => {
  const pair = { ...paragraph, source: 'It mainly concerns speech sounds.', target: '它主要研究语音。' };
  const base = heuristicAlignment(pair);
  const source = base.srcTokens.findIndex(([a, b]) => pair.source.slice(a, b) === 'concerns');
  const target = base.tgtTokens.findIndex(([a, b]) => pair.target.slice(a, b) === '研究');
  const service = new AlignmentService({ initialize: async () => sleep(80), infer: async () => [{ ...base, links: [[source, target]] }] });
  const [result] = await service.get([pair]);
  assert.deepEqual(result.links, [[source, target]]);
});

test('模型已热但新段未预计算时仍等待真实结果，不在280ms退回空链接锁死前端', async () => {
  const pair = { ...paragraph, source: 'It mainly concerns speech sounds.', target: '它主要研究语音。' };
  const base = heuristicAlignment(pair);
  const source = base.srcTokens.findIndex(([a, b]) => pair.source.slice(a, b) === 'concerns');
  const target = base.tgtTokens.findIndex(([a, b]) => pair.target.slice(a, b) === '研究');
  const service = new AlignmentService({ infer: async (pairs) => {
    if (pairs[0].id === 'slow-new-pair') { await sleep(350); return [{ ...base, id: 'slow-new-pair', links: [[source, target]] }]; }
    return pairs.map(heuristicAlignment);
  } });
  await service.get([{ ...paragraph, id: 'warmup' }], { waitForModel: true });
  assert.equal(service.status().modelReady, true);
  const [result] = await service.get([{ ...pair, id: 'slow-new-pair' }]);
  assert.deepEqual(result.links, [[source, target]]);
});

test('concerns不会被位置补齐到逗号，英语冠词不会被模型噪声贴到“馆”', () => {
  const pair = { ...paragraph, source: 'Phonetics mainly concerns speech sounds.', target: '语音学主要研究语音，' };
  const base = heuristicAlignment(pair);
  const source = base.srcTokens.findIndex(([a, b]) => pair.source.slice(a, b) === 'concerns');
  const comma = base.tgtTokens.findIndex(([a, b]) => pair.target.slice(a, b) === '，');
  assert.deepEqual(constrainSentenceLinks(pair, { ...base, links: [[source, comma]] }).links, []);
  const museum = { ...paragraph, source: 'We visit the museum.', target: '我们参观博物馆。' };
  const tokens = heuristicAlignment(museum);
  const article = tokens.srcTokens.findIndex(([a, b]) => museum.source.slice(a, b) === 'the');
  const hall = tokens.tgtTokens.findIndex(([a, b]) => museum.target.slice(a, b) === '馆');
  assert.deepEqual(constrainSentenceLinks(museum, { ...tokens, links: [[article, hall]] }).links, []);
});

test('语义单向差距可以恢复非互选词组，完全相似的未知候选不会产生猜测链接', () => {
  const pair = { ...paragraph, source: 'mainly concerns linguistics', target: '主要 学的 研究' };
  const result = alignEmbeddings(pair, [[1, 0, 0], [0.7, 0.7, 0.14], [0, 1, 0]], [[1, 0, 0], [0, 1, 0], [0.2, 0.2, 0.959]]);
  assert.ok(result.links.some(([a, b]) => pair.source.slice(...result.srcTokens[a]) === 'concerns' && pair.target.slice(...result.tgtTokens[b]) === '研究'));
  assert.ok(!result.links.some(([a, b]) => pair.source.slice(...result.srcTokens[a]) === 'concerns' && pair.target.slice(...result.tgtTokens[b]) !== '研究'));
  const unknown = { ...paragraph, source: 'foo bar', target: '苹果 香蕉' };
  assert.deepEqual(alignEmbeddings(unknown, [[1, 0], [1, 0]], [[1, 0], [1, 0]]).links, []);
});

test('词典先用唯一形容词义项消歧，不让acoustic吞掉auditory或按位置分配重复术语', async () => {
  const dictionary = new Dictionary({ memory: true, entries: [
    { word: 'acoustic', translation: 'a. 听觉的, 声学的' },
    { word: 'auditory', translation: 'a. 听觉的' },
    { word: 'phonetics', translation: 'n. 语音学' },
  ] });
  await dictionary.ready();
  const pair = { ...paragraph, source: 'The acoustic and auditory branches are separate.', target: '声学分支和听觉分支不同。' };
  const raw = heuristicAlignment(pair);
  const acoustic = raw.srcTokens.findIndex(([a, b]) => pair.source.slice(a, b) === 'acoustic');
  const auditory = raw.srcTokens.findIndex(([a, b]) => pair.source.slice(a, b) === 'auditory');
  const sound = raw.tgtTokens.findIndex(([a, b]) => pair.target.slice(a, b) === '声学');
  const hearing = raw.tgtTokens.findIndex(([a, b]) => pair.target.slice(a, b) === '听觉');
  const fixed = await refineWithDictionary(pair, { ...raw, links: [[acoustic, sound], [acoustic, hearing]] }, dictionary);
  assert.deepEqual(fixed.links.filter(([source]) => source === acoustic), [[acoustic, sound]]);
  assert.deepEqual(fixed.links.filter(([source]) => source === auditory), [[auditory, hearing]]);
  const repeated = { ...paragraph, source: 'Phonetics follows phonetics.', target: '语音学跟随语音学。' };
  const spans = heuristicAlignment(repeated);
  const sources = spans.srcTokens.map(([a, b], index) => repeated.source.slice(a, b).toLowerCase() === 'phonetics' ? index : -1).filter((index) => index >= 0);
  const targets = spans.tgtTokens.map(([a], index) => repeated.target.slice(a).startsWith('语音') ? index : -1).filter((index) => index >= 0);
  const refined = await refineWithDictionary(repeated, { ...spans, links: [[sources[1], targets[1]]] }, dictionary);
  assert.ok(refined.links.every(([source]) => source === sources[1]));
  assert.ok(refined.links.every(([, target]) => spans.tgtTokens[target][0] >= spans.tgtTokens[targets[1]][0]));
});
