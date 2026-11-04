import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const provider=require('../.compiled/backend/providers/llamacpp.js').default;
const {translateWithProjectedPlaceholders}=require('../.compiled/backend/translation-quality.js');
const {translateTextLeaves}=require('../.compiled/backend/placeholder-fallback.js');
const {splitTranslationText}=require('../.compiled/backend/translation-chunks.js');
const {validTranslation}=require('../.compiled/backend/validation.js');
const {Dictionary}=require('../.compiled/backend/dict/index.js');
const root=fileURLToPath(new URL('../../',import.meta.url));
const samples=[
  {id:'wikipedia-lead',text:'<g0>Machine translation</g0> is the use of computational techniques to <g1>translate</g1> text or speech from one <g2>language</g2> to another, including the contextual, idiomatic, and pragmatic nuances of both languages.'},
  {id:'citations',text:'While some language models are capable of generating comprehensible results, machine translation tools remain limited by the complexity of language and emotion.<g0>[1]</g0><g1>[2]</g1> Effective improvement requires human intervention in <g2>simultaneous interpretation</g2>.'},
  {id:'nested-atoms',text:'Read the <g0>installation <g1>guide and <g2>examples</g2></g1></g0>, then use <x0/> and visit <x1/>.'},
  {id:'three-sentences',text:'The <g0>browser</g0> translates this page locally. The <g1>model</g1> preserves links and code. Read <g2>the guide</g2> before running <x0/>.'},
  {id:'enclosing-format',text:'<g0>The browser translates complete sentences locally after downloading the language package. The original meaning and the position of protected code <x0/> must be preserved.</g0>'},
];
const packed=JSON.parse(gunzipSync(await readFile(path.join(root,'public/dict/ecdict-100k.json.gz'))));
const dictionary=new Dictionary({memory:true,entries:packed.entries.map((row)=>({word:row[0],translation:row[2],exchange:row[4]}))});await dictionary.ready();
let alignment,extractor;
if(process.env.WITH_ALIGNMENT==='1'){
  const {env,pipeline}=await import('@huggingface/transformers');
  const {AlignmentService}=require('../.compiled/backend/align/index.js');
  const {alignSentencePair}=require('../.compiled/backend/align/local-pairs.js');
  const {tokenPieceRanges}=require('../.compiled/backend/align/algorithm.js');
  env.allowLocalModels=true;env.allowRemoteModels=false;env.cacheDir=path.resolve(process.env.ALIGN_CACHE||path.join(root,'../translate-next/work/align-model-cache'));
  extractor=await pipeline('feature-extraction','Xenova/multilingual-e5-small',{revision:'761b726dd34fb83930e26aab4e9ac3899aa1fa78',dtype:'q8',device:'cpu',local_files_only:true});
  const vectors=async(text,language)=>{
    const encode=(value)=>extractor.tokenizer.encode(value,{add_special_tokens:false}),prefix='query: ',ranges=tokenPieceRanges(text,language,encode,prefix);
    const tensor=await extractor(prefix+text,{pooling:'none',normalize:false});assert.equal(encode(prefix+text).length+2,tensor.dims[1]);
    return ranges.map(([a,b])=>{const value=new Array(384).fill(0);for(let sub=a;sub<b;sub++)for(let dim=0;dim<384;dim++)value[dim]+=Number(tensor.data[(1+sub)*384+dim])/(b-a);return value;});
  };
  alignment=new AlignmentService({dictionary,infer:async(pairs)=>Promise.all(pairs.map((pair)=>alignSentencePair(pair,vectors)))});
  await alignment.get([{id:'warm',source:'I like apples.',target:'我喜欢苹果。',sourceLang:'en',targetLang:'zh-CN'}],{waitForModel:true});
}
const reports=[],server=process.env.LLAMA_URL||'http://127.0.0.1:8081';
try{
  for(const mode of alignment?['dictionary-only','warm-alignment']:['dictionary-only'])for(const sample of samples)for(const strategy of ['anchored','lazy']){
    const calls=[],diagnostics=[];
    const translate=async(text,terms,strictPlaceholders=false,phase='projection')=>{
      if(text.length>provider.limits.maxChars){let output='';for(const chunk of splitTranslationText(text,provider.limits.maxChars,'en'))output+=await translate(chunk,terms,strictPlaceholders,phase);return output;}
      const call={phase,inputChars:text.length,sourceHash:createHash('sha256').update(text).digest('hex'),terms:terms?.map((term)=>({...term})),strictPlaceholders};calls.push(call);const start=performance.now();
      const ctx={config:{url:server},signal:new AbortController().signal,log(){},recordTiming:(timing)=>{call.modelTiming=timing;},fetch:async(url,init)=>{
        const body=JSON.parse(init.body);body.seed=42;call.promptHash=createHash('sha256').update(body.messages[0].content).digest('hex');
        const response=await fetch(url,{...init,body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
        const raw=await response.clone().json();call.serverTimings=Object.fromEntries(Object.entries(raw.timings||{}).filter(([key,value])=>['cache_n','prompt_n','predicted_n','prompt_ms','predicted_ms'].includes(key)&&typeof value==='number'&&Number.isFinite(value)&&value>=0));return response;
      }};
      try{return(await provider.translate({texts:[text],sourceLang:'en',targetLang:'zh-CN',strictPlaceholders,...(terms?.length?{terminology:terms}:{}),context:{url:'https://en.wikipedia.org/wiki/Machine_translation',title:'Machine translation'}},ctx))[0];}
      finally{call.elapsedMs=performance.now()-start;}
    };
    const start=performance.now();let result,route='direct';
    for(let attempt=0;attempt<2;attempt++){const candidate=await translate(sample.text,undefined,attempt>0,'tagged-attempt');if(validTranslation(sample.text,candidate)){result=candidate;break;}}
    if(result===undefined){route='projection';result=await translateWithProjectedPlaceholders(sample.text,(text,terms)=>translate(text,terms),{sourceLang:'en',targetLang:'zh-CN',strategy,onDiagnostic:(record)=>diagnostics.push(record),lookup:(word)=>dictionary.lookup(word,'en','zh-CN'),...(mode==='warm-alignment'?{align:(pair)=>alignment.projection(pair,1000,{noCache:true})}:{})},new AbortController().signal);}
    if(result===null){route='leaves';result=await translateTextLeaves(sample.text,(text)=>translate(text,undefined,false,'leaves'),new AbortController().signal,{onDiagnostic:(record)=>diagnostics.push(record)});}
    const report={mode,id:sample.id,strategy,pairOrder:strategy==='anchored'?1:2,route,source:sample.text,translation:result,totalMs:performance.now()-start,httpCalls:calls.length,calls,diagnostics,passed:false};reports.push(report);
    try{
      assert.ok(validTranslation(sample.text,result));
      if(sample.id==='wikipedia-lead'){
        const visible=result.replace(/<\/?g\d+>/g,'');assert.match(visible,/一种语言.*(?:转换|翻译|转化).*另一种语言/);assert.doesNotMatch(visible,/来自一个的|另一方面/);
        assert.match(result.match(/<g0>(.*?)<\/g0>/)?.[1]||'',/机器翻译/);assert.match(result.match(/<g1>(.*?)<\/g1>/)?.[1]||'',/翻译|转换|转化/);assert.match(result.match(/<g2>(.*?)<\/g2>/)?.[1]||'',/语言/);
      }
      report.passed=true;
    }catch(error){report.failure=String(error);throw error;}
    console.log(JSON.stringify({mode,id:sample.id,strategy,route,totalMs:report.totalMs,httpCalls:calls.length,translation:result}));
  }
}finally{
  await mkdir(path.join(root,'work'),{recursive:true});await writeFile(path.join(root,'work/placeholder-performance-real.json'),JSON.stringify({at:new Date().toISOString(),provider:provider.id,adapterVersion:provider.version,seed:42,realServer:server,cachePrompt:true,pairOrder:'anchored then lazy; cache_n and exact source/prompt hashes recorded per call, not a cold-start comparison',complete:reports.length===samples.length*2*(alignment?2:1)&&reports.every((report)=>report.passed),measurementScope:'真实适配器/占位符恢复调用，未包含Core队列、内容脚本或DOM；真实CPU对齐仅WITH_ALIGNMENT=1',reports},null,2));
  alignment?.dispose();await extractor?.dispose();await dictionary.dispose();
}
