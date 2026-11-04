import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { env, pipeline } from '@huggingface/transformers';
const require = createRequire(import.meta.url);
const { tokenPieceRanges } = require('../.compiled/backend/align/algorithm.js');
const { alignSentencePair } = require('../.compiled/backend/align/local-pairs.js');
const { constrainSentenceLinks } = require('../.compiled/backend/align/sentence-alignment.js');
const { refineWithDictionary } = require('../.compiled/backend/align/dictionary-links.js');
const { Dictionary } = require('../.compiled/backend/dict/index.js');
const { pairs } = JSON.parse(await fs.readFile('tests/backend/align-selection.fixture.json'));
const packed = JSON.parse(gunzipSync(await fs.readFile('public/dict/ecdict-100k.json.gz')));
const dictionary = new Dictionary({ memory: true, entries: packed.entries.map((row) => ({ word: row[0], translation: row[2], exchange: row[4] })) }); await dictionary.ready();
env.allowLocalModels = true; env.allowRemoteModels = false;
env.cacheDir = path.resolve(process.env.ALIGN_MODEL_CACHE_DIR || '../translate-next/work/align-model-cache');
const directory = path.join(env.cacheDir, 'Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78');
const begin = performance.now();
const extractor = await pipeline('feature-extraction', directory, { dtype: 'q8', device: 'cpu', local_files_only: true });
const loadMs = performance.now() - begin;
const encode = (text) => extractor.tokenizer.encode(text, { add_special_tokens: false });
async function vectors(text, language) {
  const prefix = 'query: '; if (encode(prefix + text).length > 254) throw Error('句子超过本地词对齐 token 上限');
  const pieces = tokenPieceRanges(text, language, encode, prefix), tensor = await extractor(prefix + text, { pooling: 'none', normalize: false });
  return pieces.map(([a, b]) => Array.from({ length: 384 }, (_, dimension) => {
    let value = 0; for (let piece = a; piece < b; piece++) value += Number(tensor.data[(piece + 1) * 384 + dimension]) / (b - a); return value;
  }));
}
function selection(pair, result, text, reverse = false) {
  const input = reverse ? pair.target : pair.source, output = reverse ? pair.source : pair.target;
  const start = input.indexOf(text); assert.ok(start >= 0);
  const from = reverse ? result.tgtTokens : result.srcTokens, to = reverse ? result.srcTokens : result.tgtTokens;
  const chosen = new Set(from.map(([a, b], index) => a < start + text.length && b > start ? index : -1));
  const indices = [...new Set(result.links.filter((link) => chosen.has(link[reverse ? 1 : 0])).map((link) => link[reverse ? 0 : 1]))].sort((a, b) => a - b);
  return indices.map((index) => ({ range: to[index], text: output.slice(...to[index]) }));
}
const report = { at: new Date().toISOString(), engine: 'real q8 multilingual-e5-small / CPU / fixed local weights', loadMs, baseline: process.env.ALIGN_SELECTION_BASELINE === '1', results: [] };
try {
  for (const pair of pairs) {
    const started = performance.now(), raw = await alignSentencePair(pair, vectors);
    const result = constrainSentenceLinks(pair, await refineWithDictionary(pair, raw, dictionary));
    const chosen = pair.phrase ?? pair.sentence, selected = selection(pair, result, chosen);
    const reverse = selection(pair, result, pair.expectedPhrase ?? pair.expectedSentence, true);
    const words = result.links.map(([a, b]) => [pair.source.slice(...result.srcTokens[a]), pair.target.slice(...result.tgtTokens[b])]);
    const row = { pair, result, words, selected, reverse, elapsedMs: performance.now() - started };
    report.results.push(row); console.log(JSON.stringify({ id: pair.id, elapsedMs: row.elapsedMs, selected: selected.map((item) => item.text), reverse: reverse.map((item) => item.text), spans: result.spans }));
    if (!report.baseline && pair.phrase) {
      const start = pair.target.indexOf(pair.expectedPhrase), end = start + pair.expectedPhrase.length;
      assert.ok(selected.length); assert.ok(selected.every((item) => item.range[0] >= start && item.range[1] <= end));
      const from = pair.source.indexOf(pair.phrase), to = from + pair.phrase.length;
      assert.ok(reverse.length); assert.ok(reverse.every((item) => item.range[0] >= from && item.range[1] <= to));
      assert.deepEqual(result.spans.find((item) => item.kind === 'phrase'), { kind: 'phrase', source: [from, to], target: [start, end] });
    }
    if (!report.baseline && pair.sentence) {
      const from = pair.source.indexOf(pair.sentence), to = from + pair.sentence.length;
      const start = pair.target.indexOf(pair.expectedSentence), end = start + pair.expectedSentence.length;
      assert.deepEqual(result.spans.find((item) => item.kind === 'sentence'), { kind: 'sentence', source: [from, to], target: [start, end] });
      assert.ok(selected.every((item) => item.range[0] >= start && item.range[1] <= end));
    }
  }
} finally {
  await extractor.dispose(); await fs.mkdir('work', { recursive: true });
  await fs.writeFile(`work/alignment-selection-${report.baseline ? 'before' : 'after'}.json`, JSON.stringify(report, null, 2));
}
