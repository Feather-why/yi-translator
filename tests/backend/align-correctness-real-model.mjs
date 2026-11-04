import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { env, pipeline } from '@huggingface/transformers';
const require = createRequire(import.meta.url);
const { tokenPieceRanges, alignmentLinkAllowed } = require('../.compiled/backend/align/algorithm.js');
const { alignSentencePair } = require('../.compiled/backend/align/local-pairs.js');
const { constrainSentenceLinks, sentenceGroups } = require('../.compiled/backend/align/sentence-alignment.js');
const { refineWithDictionary } = require('../.compiled/backend/align/dictionary-links.js');
const { Dictionary } = require('../.compiled/backend/dict/index.js');
const fixture = JSON.parse(await fs.readFile('tests/backend/align-phonetics.fixture.json'));
const packed = JSON.parse(gunzipSync(await fs.readFile('public/dict/ecdict-100k.json.gz')));
const dictionary = new Dictionary({ memory: true, entries: packed.entries.map((row) => ({ word: row[0], translation: row[2], exchange: row[4] })) });
await dictionary.ready();
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.cacheDir = path.resolve(process.env.ALIGN_MODEL_CACHE_DIR || 'work/align-model-cache');
const modelDirectory = path.join(env.cacheDir, 'Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78');
const started = performance.now();
const extractor = await pipeline('feature-extraction', modelDirectory, { dtype: 'q8', device: 'cpu', local_files_only: true });
const loadMs = Math.round(performance.now() - started);
const encode = (text) => extractor.tokenizer.encode(text, { add_special_tokens: false });
async function vectors(text, language) {
  const prefix = 'query: ';
  if (encode(prefix + text).length > 254) throw new Error('句子超过本地词对齐 token 上限');
  const spans = tokenPieceRanges(text, language, encode, prefix);
  const tensor = await extractor(prefix + text, { pooling: 'none', normalize: false });
  assert.equal(tensor.dims[2], 384);
  return spans.map(([a, b]) => Array.from({ length: 384 }, (_, dimension) => {
    let value = 0;
    for (let piece = a; piece < b; piece++) value += Number(tensor.data[(piece + 1) * 384 + dimension]) / (b - a);
    return value;
  }));
}
const pairs = [fixture.pair, { ...fixture.pair, id: 'phonetics-actual-edge', target: '语音学是语言学的一个分支，主要研究语音的发音、声波特性及感知。语音学领域传统上分为三个子学科：发音语音学、声学语音学和听觉语音学。专门研究发声这些物理特性的语言学家被称为语音学家。 传统上，语音学的最小语言单位是“音”，即单个语音。这与音系学的最小语言单位“音素”不同。音素是对“音”进行的抽象、特定于某种语言的分类，被定义为影响语义的最小单位。[1]' }, {
  id: 'three-sentences', source: 'The children are reading a book. A small dog sleeps beside the window. Tomorrow, we will visit the museum.',
  target: '孩子们正在读书。一只小狗在窗边睡觉。明天，我们将去博物馆参观。', sourceLang: 'auto', targetLang: 'zh-CN',
}, {
  id: 'repeated-terminology', source: 'Phonetics studies speech sounds. Articulatory phonetics describes articulation. Acoustic phonetics studies sound waves.',
  target: '语音学研究语音。发音语音学描述发音。声学语音学研究声波。', sourceLang: 'auto', targetLang: 'zh-CN',
}, {
  id: 'long-paragraph', source: 'The browser translates each page. '.repeat(40), target: '浏览器翻译每个页面。'.repeat(40), sourceLang: 'auto', targetLang: 'zh-CN',
}];
const results = [];
function selection(result, from, to, reverse = false) {
  const source = reverse ? result.tgtTokens : result.srcTokens, target = reverse ? result.srcTokens : result.tgtTokens;
  const chosen = new Set(source.map(([a, b], index) => a < to && b > from ? index : -1));
  const selected = [...new Set(result.links.filter((link) => chosen.has(link[reverse ? 1 : 0])).map((link) => link[reverse ? 0 : 1]))].sort((a, b) => a - b);
  const ranges = [];
  for (const index of selected) { const span = target[index], last = ranges.at(-1); if (last && span[0] - last[1] <= 1) last[1] = span[1]; else ranges.push([...span]); }
  return ranges;
}
const countLetters = (text) => [...text.matchAll(/[\p{L}\p{N}]/gu)].length;
for (const pair of pairs) {
  const sourceTokens = encode('query: ' + pair.source).length;
  if (pair.id === 'long-paragraph') assert.ok(sourceTokens > 254);
  const begin = performance.now();
  const raw = await alignSentencePair(pair, vectors);
  const result = constrainSentenceLinks(pair, await refineWithDictionary(pair, raw, dictionary));
  const elapsedMs = Math.round(performance.now() - begin);
  const groups = sentenceGroups(pair);
  const words = result.links.map(([source, target]) => [pair.source.slice(...result.srcTokens[source]), pair.target.slice(...result.tgtTokens[target])]);
  for (const [source, target] of result.links) {
    assert.ok(alignmentLinkAllowed(pair, result.srcTokens[source], result.tgtTokens[target]));
    const sourceGroup = groups.findIndex(({ source: [a, b] }) => result.srcTokens[source][0] >= a && result.srcTokens[source][0] < b);
    const targetGroup = groups.findIndex(({ target: [a, b] }) => result.tgtTokens[target][0] >= a && result.tgtTokens[target][0] < b);
    assert.equal(sourceGroup, targetGroup);
  }
  const concerns = words.filter(([source]) => source === 'concerns').map(([, target]) => target);
  const sentenceSelection = { forward: selection(result, ...groups[0].source), backward: selection(result, ...groups[0].target, true) };
  const targetCoverage = sentenceSelection.forward.reduce((sum, [a, b]) => sum + countLetters(pair.target.slice(a, b)), 0) / countLetters(pair.target.slice(...groups[0].target));
  const sourceCoverage = sentenceSelection.backward.reduce((sum, [a, b]) => sum + countLetters(pair.source.slice(a, b)), 0) / countLetters(pair.source.slice(...groups[0].source));
  if (pair.id.startsWith('phonetics')) {
    assert.deepEqual(fixture.oldConcerns, ['，']);
    assert.ok(concerns.some((word) => /研究|涉及|关注/.test(word)), JSON.stringify(concerns));
    assert.ok(concerns.every((word) => /\p{L}/u.test(word)));
    const reverse = result.links.filter(([, target]) => result.tgtTokens[target][0] < groups[0].target[1] && pair.target.slice(...result.tgtTokens[target]) === '研究').map(([source]) => pair.source.slice(...result.srcTokens[source]));
    assert.deepEqual(reverse, ['concerns']);
    const acoustics = words.filter(([source]) => source === 'acoustic').map(([, target]) => target).join('');
    const auditory = words.filter(([source]) => source === 'auditory').map(([, target]) => target).join('');
    assert.equal(acoustics, '声学'); assert.equal(auditory, '听觉');
    assert.deepEqual(words.filter(([, target]) => target === '声学').map(([source]) => source), ['acoustic']);
    assert.ok(sentenceSelection.forward.length && sentenceSelection.backward.length);
    assert.ok(sentenceSelection.forward.every(([a, b]) => a >= groups[0].target[0] && b <= groups[0].target[1]));
    assert.ok(sentenceSelection.backward.every(([a, b]) => a >= groups[0].source[0] && b <= groups[0].source[1]));
    const firstWords = result.links.filter(([, target]) => result.tgtTokens[target][0] < groups[0].target[1]).map(([source]) => pair.source.slice(...result.srcTokens[source]));
    assert.ok(['Phonetics', 'linguistics', 'concerns', 'articulation', 'perception', 'properties'].filter((word) => firstWords.includes(word)).length >= 5);
  }
  if (pair.id === 'three-sentences') {
    assert.ok(words.some(([source, target]) => source === 'dog' && /狗/.test(target)));
    assert.ok(!words.some(([source, target]) => source === 'the' && target === '馆'));
    assert.ok(!words.some(([source, target]) => source === 'are' && target === '们'));
  }
  results.push({ pair, result, words, elapsedMs, concerns, sentenceSelection, targetCoverage, sourceCoverage, sourceTokens });
  console.log(JSON.stringify({ id: pair.id, elapsedMs, semanticLinks: result.links.length, concerns, targetCoverage, sourceCoverage, sourceTokens }));
}
await fs.mkdir('work', { recursive: true });
await fs.writeFile('work/alignment-correctness-real-model.json', JSON.stringify({ at: new Date().toISOString(), engine: 'onnxruntime-node CPU', model: 'Xenova/multilingual-e5-small', loadMs, oldPhoneticsConcerns: fixture.oldConcerns, results }, null, 2));
await extractor.dispose();
