import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { env, pipeline } from '@huggingface/transformers';
const require = createRequire(import.meta.url);
const build = path.resolve(process.env.ALIGN_PERFORMANCE_BUILD || 'tests/.compiled/backend/align');
const { AlignmentService } = require(path.join(build, 'index.js'));
const { alignSentencePair } = require(path.join(build, 'local-pairs.js'));
const { tokenPieceRanges } = require(path.join(build, 'algorithm.js'));
const { Dictionary } = require('../.compiled/backend/dict/index.js');
const phonetics = JSON.parse(await fs.readFile('tests/backend/align-phonetics.fixture.json'));
const selection = JSON.parse(await fs.readFile('tests/backend/align-selection.fixture.json'));
const packed = JSON.parse(gunzipSync(await fs.readFile('public/dict/ecdict-100k.json.gz')));
const dictionary = new Dictionary({ memory: true, entries: packed.entries.map((row) => ({ word: row[0], translation: row[2], exchange: row[4] })) }); await dictionary.ready();
env.allowLocalModels = true; env.allowRemoteModels = false;
const directory = path.resolve('../translate-next/work/align-model-cache/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78');
const start = performance.now(), extractor = await pipeline('feature-extraction', directory, { dtype: 'q8', device: 'cpu', local_files_only: true });
const loadMs = performance.now() - start, encode = (text) => extractor.tokenizer.encode(text, { add_special_tokens: false });
let embeddingCalls = 0;
async function embed(text, language) {
  embeddingCalls++; const prefix = 'query: ';
  if (encode(prefix + text).length > 254) throw Error('句子超过本地词对齐 token 上限');
  const pieces = tokenPieceRanges(text, language, encode, prefix), tensor = await extractor(prefix + text, { pooling: 'none', normalize: false });
  return pieces.map(([a, b]) => Array.from({ length: 384 }, (_, dimension) => {
    let value = 0; for (let piece = a; piece < b; piece++) value += Number(tensor.data[(piece + 1) * 384 + dimension]) / (b - a); return value;
  }));
}
const cases = [phonetics.pair, selection.pairs[0], selection.pairs[2], {
  id: 'nested-link-visible-text', source: 'Read the installation guide, then run llama-server -ngl 99. Keep all links and commands intact.',
  target: '阅读安装指南，然后运行llama-server -ngl 99。保持所有链接和命令完整。', sourceLang: 'auto', targetLang: 'zh-CN',
}, { id: 'repeated-sentences-40', source: 'The browser translates each page. '.repeat(40), target: '浏览器翻译每个页面。'.repeat(40), sourceLang: 'auto', targetLang: 'zh-CN' }];
const report = { at: new Date().toISOString(), label: process.env.ALIGN_PERFORMANCE_LABEL || 'after', build, model: 'real fixed q8 multilingual-e5-small', device: 'CPU', loadMs, results: [] };
try {
  for (const pair of cases) {
    let inferCalls = 0, lookupCalls = 0; embeddingCalls = 0;
    const service = new AlignmentService({ infer: async (pairs) => { inferCalls++; return Promise.all(pairs.map((pair) => alignSentencePair(pair, embed))); },
      dictionary: { status: () => ({ ready: true }), lookup: (...args) => { lookupCalls++; return dictionary.lookup(...args); } } });
    const begin = performance.now(), [result] = await service.get([pair], { waitForModel: true });
    const firstMs = performance.now() - begin, firstEmbeddingCalls = embeddingCalls, firstLookupCalls = lookupCalls;
    const repeats = [];
    for (let n = 0; n < 10; n++) { const at = performance.now(); const [cached] = await service.get([{ ...pair, id: `${pair.id}-${n}` }]); repeats.push(performance.now() - at); assert.deepEqual({ ...cached, id: pair.id }, result); }
    const projectedAt = performance.now(), projected = await service.projection(pair, 1000, { noCache: false });
    const projectionHitMs = performance.now() - projectedAt; assert.deepEqual(projected, result);
    assert.equal(embeddingCalls, firstEmbeddingCalls); assert.equal(lookupCalls, firstLookupCalls); assert.equal(inferCalls, 1);
    const repeatP50Ms = [...repeats].sort((a, b) => a - b)[Math.floor(repeats.length / 2)];
    report.results.push({ pair, firstMs, repeatP50Ms, repeatMaxMs: Math.max(...repeats), projectionHitMs, embeddingCalls, lookupCalls, inferCalls, result });
    console.log(JSON.stringify({ id: pair.id, firstMs, repeatP50Ms, projectionHitMs, embeddingCalls, lookupCalls })); service.dispose();
  }
} finally {
  await extractor.dispose(); await fs.mkdir('work', { recursive: true });
  await fs.writeFile(`work/align-performance-${report.label}.json`, JSON.stringify(report, null, 2));
}
