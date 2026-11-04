import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { env, pipeline } from '@huggingface/transformers';
const require = createRequire(import.meta.url);
const { tokenPieceRanges, alignEmbeddings, heuristicAlignment } = require('../.compiled/backend/align/algorithm.js');
const { alignSentencePair } = require('../.compiled/backend/align/local-pairs.js');
const { constrainSentenceLinks, sentenceGroups } = require('../.compiled/backend/align/sentence-alignment.js');
const { refineWithDictionary } = require('../.compiled/backend/align/dictionary-links.js');
const { Dictionary } = require('../.compiled/backend/dict/index.js');
const { AlignmentService } = require('../.compiled/backend/align/index.js');
const packed = JSON.parse(gunzipSync(await fs.readFile('public/dict/ecdict-100k.json.gz')));
const dictionary = new Dictionary({ memory: true, entries: packed.entries.map((row) => ({ word: row[0], translation: row[2], exchange: row[4] })) });
await dictionary.ready();
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.cacheDir = path.resolve(process.env.ALIGN_MODEL_CACHE_DIR || 'work/align-model-cache');
const modelDirectory = path.join(env.cacheDir, 'Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78');
const start = performance.now();
const extractor = await pipeline('feature-extraction', modelDirectory, {
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78', dtype: 'q8', device: 'cpu', local_files_only: true,
});
const loadMs = Math.round(performance.now() - start);
const encode = (text) => extractor.tokenizer.encode(text, { add_special_tokens: false });
async function vectors(text, language) {
  const prefix = 'query: ';
  if (encode(prefix + text).length > 254) throw new Error('句子超过本地词对齐 token 上限');
  const spans = tokenPieceRanges(text, language, encode, prefix);
  const tensor = await extractor(prefix + text, { pooling: 'none', normalize: false });
  assert.equal(tensor.dims[2], 384);
  assert.equal(encode(prefix + text).length + 2, tensor.dims[1]);
  return spans.map(([a, b]) => Array.from({ length: 384 }, (_, dimension) => {
    let value = 0;
    for (let piece = a; piece < b; piece++) value += Number(tensor.data[(piece + 1) * 384 + dimension]) / (b - a);
    return value;
  }));
}
const paragraph = { id: 'three-sentences', source: 'The children are reading a book. A small dog sleeps beside the window. Tomorrow, we will visit the museum.', target: '孩子们正在读书。一只小狗在窗边睡觉。明天，我们将去博物馆参观。', sourceLang: 'auto', targetLang: 'zh-CN' };
const pairs = [paragraph,
  { ...paragraph, id: 'repeated-dog', source: 'The dog sleeps. The child reads. Another dog runs.', target: '狗在睡觉。孩子在读书。另一只狗在跑。' },
  { ...paragraph, id: 'long-paragraph', source: 'The browser translates each page. '.repeat(40), target: '浏览器翻译每个页面。'.repeat(40) },
];
const results = [];
for (const pair of pairs) {
  const beforeTokens = encode('query: ' + pair.source).length;
  if (pair.id === 'long-paragraph') assert.ok(beforeTokens > 254);
  const before = beforeTokens > 254 ? { failedTokenLimit: true, tokenCount: beforeTokens } : await (async () => {
    // 旧生产路径对 auto 不调用词典，直接在整段向量矩阵上互为最近邻。
    const result = alignEmbeddings(pair, await vectors(pair.source, pair.sourceLang), await vectors(pair.target, pair.targetLang));
    return { result, tokenCount: beforeTokens };
  })();
  const started = performance.now();
  const raw = await refineWithDictionary(pair, await alignSentencePair(pair, vectors), dictionary);
  const after = constrainSentenceLinks(pair, raw), elapsedMs = Math.round(performance.now() - started);
  const groups = sentenceGroups(pair);
  for (const [a, b] of after.links) {
    const sourceGroup = groups.findIndex((group) => after.srcTokens[a][0] >= group.source[0] && after.srcTokens[a][0] < group.source[1]);
    const targetGroup = groups.findIndex((group) => after.tgtTokens[b][0] >= group.target[0] && after.tgtTokens[b][0] < group.target[1]);
    assert.equal(sourceGroup, targetGroup, '模型链接不能跨句');
  }
  if (pair.id === 'three-sentences') {
    const dog = after.srcTokens.findIndex(([a, b]) => pair.source.slice(a, b) === 'dog');
    const words = after.links.filter(([source]) => source === dog).map(([, target]) => pair.target.slice(...after.tgtTokens[target]));
    assert.ok(words.some((word) => word.includes('狗')), JSON.stringify(words));
    assert.ok(words.join('').length < groups[1].target[1] - groups[1].target[0]);
  }
  const service = new AlignmentService({ dictionary, infer: async () => [raw] });
  await service.get([pair], { waitForModel: true });
  const cachedStart = performance.now(); await service.get([pair]); const cachedMs = performance.now() - cachedStart;
  assert.ok(cachedMs < 50);
  results.push({ pair, before, after, raw, elapsedMs, cachedMs, semanticWords: raw.links.map(([a, b]) => [pair.source.slice(...raw.srcTokens[a]), pair.target.slice(...raw.tgtTokens[b])]) });
  console.log(JSON.stringify({ id: pair.id, beforeTokens, oldTokenLimitFailure: !!before.failedTokenLimit, semanticLinks: raw.links.length, coveredLinks: after.links.length, elapsedMs, cachedMs }));
}
await fs.mkdir('work', { recursive: true });
await fs.writeFile('work/alignment-quality-real-model.json', JSON.stringify({ at: new Date().toISOString(), engine: 'onnxruntime-node CPU', model: 'Xenova/multilingual-e5-small', loadMs, results }, null, 2));
await extractor.dispose();
