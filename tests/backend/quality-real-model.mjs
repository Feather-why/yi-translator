import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { env, pipeline } from '@huggingface/transformers';
const require = createRequire(import.meta.url);
const { BackendCore } = require('../.compiled/backend/core.js');
const { BackendStorage } = require('../.compiled/backend/storage.js');
const { SecretVault } = require('../.compiled/backend/secrets.js');
const { AlignmentService } = require('../.compiled/backend/align/index.js');
const { alignSentencePair } = require('../.compiled/backend/align/local-pairs.js');
const { tokenPieceRanges } = require('../.compiled/backend/align/algorithm.js');
const { Dictionary } = require('../.compiled/backend/dict/index.js');
const { translateTextLeaves } = require('../.compiled/backend/placeholder-fallback.js');
const { validTranslation } = require('../.compiled/backend/validation.js');
const provider = require('../.compiled/backend/providers/llamacpp.js').default;
const cases = [
 { id: 'wikipedia-lead', text: '<g0>Machine translation</g0> is the use of computational techniques to <g1>translate</g1> text or speech from one <g2>language</g2> to another, including the contextual, idiomatic, and pragmatic nuances of both languages.' },
 { id: 'citations', text: 'While some language models are capable of generating comprehensible results, machine translation tools remain limited by the complexity of language and emotion.<g0>[1]</g0><g1>[2]</g1> Effective improvement requires human intervention in <g2>simultaneous interpretation</g2>.' },
 { id: 'nested-atoms', text: 'Read the <g0>installation <g1>guide and <g2>examples</g2></g1></g0>, then use <x0/> and visit <x1/>.' },
 { id: 'sentences', text: 'The <g0>browser</g0> translates this page locally. The <g1>model</g1> preserves links and code. Read <g2>the guide</g2> before running <x0/>.' },
 { id: 'long-enclosing-format', text: '<g0>' + 'The browser translates the page locally. The translation model preserves the meaning of complete sentences. '.repeat(15) + '</g0>' },
];
const state = {};
globalThis.chrome = { storage: { local: {
 get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(state[key])])),
 set: async (items) => Object.assign(state, structuredClone(items)),
} } };
const fetcher = async (url, init) => {
 if (init?.body && String(url).endsWith('/v1/chat/completions')) {
   const body = JSON.parse(init.body); body.seed = 42; return fetch(url, { ...init, body: JSON.stringify(body) });
 }
 return fetch(url, init);
};
const packed = JSON.parse(gunzipSync(await readFile('public/dict/ecdict-100k.json.gz')));
const dictionary = new Dictionary({ memory: true, entries: packed.entries.map((row) => ({ word: row[0], translation: row[2], exchange: row[4] })) });
await dictionary.ready();
env.allowLocalModels = false;
env.cacheDir = path.resolve(process.env.ALIGN_CACHE || '../translate-next/work/align-model-cache');
const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78', dtype: 'q8', device: 'cpu' });
async function vectors(text, language) {
 const encode = (value) => extractor.tokenizer.encode(value, { add_special_tokens: false });
 const prefix = 'query: '; const ranges = tokenPieceRanges(text, language, encode, prefix);
 const tensor = await extractor(prefix + text, { pooling: 'none', normalize: false });
 assert.equal(encode(prefix + text).length + 2, tensor.dims[1]);
 return ranges.map(([a,b]) => { const value = new Array(384).fill(0); for(let sub=a;sub<b;sub++)for(let dim=0;dim<384;dim++)value[dim]+=Number(tensor.data[(1+sub)*384+dim])/(b-a);return value; });
}
const alignment = new AlignmentService({ dictionary, infer: async (pairs) => Promise.all(pairs.map((pair) => alignSentencePair(pair, vectors))) });
await alignment.get([{ id:'warm',source:'I like apples.',target:'我喜欢苹果。',sourceLang:'en',targetLang:'zh-CN' }], { waitForModel:true });
const reports=[];
for(const mode of ['cold','warm']) for(const sample of cases) {
 const requests=[];
 const observed = { ...provider, translate: async (request, ctx) => { requests.push({ text:request.texts[0],terms:request.terminology });return provider.translate(request,ctx); } };
 const core = new BackendCore({ providers:[observed],storage:new BackendStorage({memory:true}),vault:new SecretVault({memory:true}),fetch:fetcher,
   lookup:(word,from,to)=>dictionary.lookup(word,from,to),
   ...(mode==='warm'?{align:(pair)=>alignment.projection(pair,1000,{noCache:true})}:{}) });
 await core.ready();
 const segment={id:sample.id,text:sample.text,kind:'paragraph'};
 const job={jobId:`${mode}-${sample.id}`,segments:[segment],sourceLang:'en',targetLang:'zh-CN',priority:0,mode:'fast',noCache:true,context:{url:'https://en.wikipedia.org/wiki/Machine_translation',title:'Machine translation'}};
 const started=performance.now();const result=await core.translate(job,segment,'fast',new AbortController().signal);
 assert.equal(validTranslation(sample.text,result.text),true);
 if(sample.id==='wikipedia-lead') {
   const visible=result.text.replace(/<\/?g\d+>/g,'');
   assert.match(visible,/一种语言.*(?:转换|翻译|转化).*另一种语言/,'主复现必须保留从一种语言到另一种语言的完整句义');
   assert.doesNotMatch(visible,/来自一个的|另一方面/,'主复现不能重新退回缺少上下文的叶子碎片译文');
 }
 const report={mode,id:sample.id,source:sample.text,translation:result.text,ms:Math.round(performance.now()-started),requests:requests.length,projected:requests.some((request)=>request.terms?.length),modelInputs:requests};reports.push(report);
 console.log(JSON.stringify({mode,id:sample.id,translation:result.text,ms:report.ms,requests:requests.length,projected:report.projected}));
}
const legacy=await translateTextLeaves(cases[0].text,async(text)=>(await provider.translate({texts:[text],sourceLang:'en',targetLang:'zh-CN'}, {signal:new AbortController().signal,config:{},log(){},fetch:fetcher}))[0],new AbortController().signal);
await mkdir('work',{recursive:true});await writeFile('work/quality-real-model.json',JSON.stringify({at:new Date().toISOString(),engine:'actual llama.cpp GPU + real ONNX CPU alignment (warm only)',model:'Hy-MT2-1.8B-Q4_K_M',seed:42,legacyLeafLead:legacy,reports},null,2));
console.log(JSON.stringify({legacyLeafLead:legacy}));
await extractor.dispose();alignment.dispose();await dictionary.dispose();
