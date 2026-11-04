import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { env, pipeline } from '@huggingface/transformers';
const require = createRequire(import.meta.url);
const { tokenPieceRanges, alignEmbeddings } = require('../.compiled/backend/align/algorithm.js');
const { refineWithDictionary } = require('../.compiled/backend/align/dictionary-links.js');
const { Dictionary } = require('../.compiled/backend/dict/index.js');
const packed = JSON.parse(gunzipSync(await fs.readFile('public/dict/ecdict-100k.json.gz')));
const dictionary = new Dictionary({ memory: true, entries: packed.entries.map((row) => ({ word: row[0], translation: row[2], exchange: row[4] })) });
await dictionary.ready();
env.allowLocalModels = false;
env.cacheDir = path.resolve('work/align-model-cache');
const started = performance.now();
const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78', dtype: 'q8', device: 'cpu',
});
const loadMs = Math.round(performance.now() - started);
async function vectors(text, language) {
  const encode = (value) => extractor.tokenizer.encode(value, { add_special_tokens: false });
  const prefix = 'query: ';
  const ranges = tokenPieceRanges(text, language, encode, prefix);
  const tensor = await extractor(prefix + text, { pooling: 'none', normalize: false });
  assert.equal(tensor.dims[2], 384);
  assert.equal(encode(prefix + text).length + 2, tensor.dims[1]);
  return ranges.map(([start, end]) => {
    const count = end - start;
    const vector = new Array(384).fill(0);
    for (let sub = 0; sub < count; sub++) for (let dim = 0; dim < 384; dim++) vector[dim] += Number(tensor.data[(1 + start + sub) * 384 + dim]) / count;
    return vector;
  });
}
const pairs = [
  { id: 'apple', source: 'I like apples.', target: '我喜欢苹果。', sourceLang: 'en', targetLang: 'zh-CN' },
  { id: 'browser', source: 'The browser translates this page.', target: '浏览器翻译此页面。', sourceLang: 'en', targetLang: 'zh-CN' },
  { id: 'cat', source: 'A cat sits on the mat.', target: '一只猫坐在垫子上。', sourceLang: 'en', targetLang: 'zh-CN' },
];
const results = [];
for (const pair of pairs) {
  const start = performance.now();
  const result = await refineWithDictionary(pair, alignEmbeddings(pair, await vectors(pair.source, 'en'), await vectors(pair.target, 'zh-CN')), dictionary);
  const words = result.links.map(([src, tgt]) => [pair.source.slice(...result.srcTokens[src]), pair.target.slice(...result.tgtTokens[tgt])]);
  results.push({ pair, result, words, ms: Math.round(performance.now() - start) });
  console.log(JSON.stringify({ id: pair.id, ms: results.at(-1).ms, words }));
}
assert.ok(results.some(({ words }) => words.some(([source, target]) => source === 'apples' && target === '苹果')));
assert.ok(results.some(({ words }) => words.filter(([source]) => source === 'browser').map(([, target]) => target).join('') === '浏览器'));
await fs.mkdir('work', { recursive: true });
await fs.writeFile('work/b3-real-model.json', JSON.stringify({ at: new Date().toISOString(), engine: 'onnxruntime-node CPU', model: 'Xenova/multilingual-e5-small', revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78', loadMs, results }, null, 2));
await extractor.dispose();
console.log(`真实 ONNX CPU 词对齐验证通过，此次模型加载（可复用权重缓存） ${loadMs}ms。`);
