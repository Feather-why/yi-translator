import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {env,pipeline} from '@huggingface/transformers';

// 对照使用冻结的旧编译产物；默认仅验证当前代码。只读取合成/公开样例。
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../../',import.meta.url));
const compiled=path.resolve(process.env.PROBE_BACKEND||path.join(root,'tests/.compiled'));
const load=name=>require(path.join(compiled,'backend',name+'.js'));
const {BackendCore}=load('core'),{BackendStorage}=load('storage'),{SecretVault}=load('secrets');
const {AlignmentService}=load('align/index'),{alignSentencePair}=load('align/local-pairs'),{tokenPieceRanges}=load('align/algorithm');
const {Dictionary}=load('dict/index'),{validTranslation}=load('validation'),provider=load('providers/llamacpp').default;
const plan=JSON.parse(await readFile(path.join(root,'tests/backend/nested-projection.fixture.json')));
const report={at:new Date().toISOString(),condition:process.env.PROBE_CONDITION||'current',compiled,model:process.env.PROBE_MODEL||'Q4_K_M',adapter:provider.version,
  seedPolicy:plan.seeds,cachePrompt:false,scope:'Core+真实llama.cpp+本机CPU E5；不包含浏览器DOM/动画/OCR。既有样例回归，非留出集。',results:[]};
const directory=path.resolve(process.env.REPORT_DIR||path.join(root,'work/nested-projection-real'));
await mkdir(directory,{recursive:true});
const state={};globalThis.chrome={storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(state[key])])),set:async items=>Object.assign(state,structuredClone(items))}}};
const packed=JSON.parse(gunzipSync(await readFile(path.join(root,'public/dict/ecdict-100k.json.gz'))));
const dictionary=new Dictionary({memory:true,entries:packed.entries.map(row=>({word:row[0],translation:row[2],exchange:row[4]}))});await dictionary.ready();
env.allowLocalModels=true;env.allowRemoteModels=false;
env.cacheDir=path.resolve(process.env.ALIGN_MODEL_CACHE_DIR||path.join(root,'../translate-next/work/align-model-cache'));
const modelDirectory=path.join(env.cacheDir,'Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78');
const loadStart=performance.now();
const extractor=await pipeline('feature-extraction',modelDirectory,{dtype:'q8',device:'cpu',local_files_only:true});report.alignmentLoadMs=performance.now()-loadStart;
const encode=value=>extractor.tokenizer.encode(value,{add_special_tokens:false});
const vectors=async(text,language)=>{
  const prefix='query: ',ranges=tokenPieceRanges(text,language,encode,prefix),tensor=await extractor(prefix+text,{pooling:'none',normalize:false});
  assert.equal(encode(prefix+text).length+2,tensor.dims[1]);
  return ranges.map(([a,b])=>Array.from({length:384},(_,dimension)=>{let sum=0;for(let piece=a;piece<b;piece++)sum+=Number(tensor.data[(piece+1)*384+dimension])/(b-a);return sum;}));
};
const alignment=new AlignmentService({dictionary,infer:async pairs=>Promise.all(pairs.map(pair=>alignSentencePair(pair,vectors)))});
await alignment.get([{id:'warm',source:'I like apples.',target:'我喜欢苹果。',sourceLang:'en',targetLang:'zh-CN'}],{waitForModel:true,noCache:true});
const server=process.env.LLAMA_URL||'http://127.0.0.1:8083';
const modes=process.env.PROBE_MODES?.split(',')||plan.modes;
try{
  for(const mode of modes) for(const sample of plan.cases) for(const seed of plan.seeds){
    const row={id:sample.id,mode,seed,source:sample.source,checks:sample.checks,requests:[],diagnostics:[],performance:[],alignment:[]};
    const observed={...provider,defaults:{...provider.defaults,url:server},translate:async(request,ctx)=>{
      const call={input:request.texts[0],terms:request.terminology,strict:request.strictPlaceholders};row.requests.push(call);const at=performance.now();
      try{const values=await provider.translate(request,ctx);call.output=values[0];return values;}finally{call.ms=performance.now()-at;}
    }};
    const core=new BackendCore({providers:[observed],storage:new BackendStorage({memory:true}),vault:new SecretVault({memory:true}),
      lookup:(word,from,to)=>dictionary.lookup(word,from,to),
      onPerformance:event=>row.performance.push(event),onPlaceholderDiagnostic:event=>row.diagnostics.push(event),
      ...(mode==='warm-alignment'?{align:async(pair,signal)=>{const at=performance.now();const result=await alignment.projection(pair,350,{noCache:true});row.alignment.push({ms:performance.now()-at,available:!!result});return signal.aborted?undefined:result;}}:{}),
      fetch:async(url,init)=>{
        const body=JSON.parse(init.body);Object.assign(body,{seed,cache_prompt:false,id_slot:0});
        const call=row.requests.at(-1);call.promptHash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const response=await fetch(url,{...init,body:JSON.stringify(body)});const json=await response.clone().json();call.serverTimings=json.timings;call.finish=json.choices?.[0]?.finish_reason;return response;
      }});
    await core.ready();const segment={id:sample.id,text:sample.source,kind:'paragraph'},job={jobId:sample.id,segments:[segment],sourceLang:sample.sourceLang,targetLang:sample.targetLang,mode:'accurate',priority:0,noCache:true,context:{url:'https://example.test/public-regression',...sample.context}};
    const at=performance.now();
    try{
      const result=await core.translate(job,segment,'accurate',new AbortController().signal);row.translation=result.text;row.structureValid=validTranslation(sample.source,result.text);assert.ok(row.structureValid);
      // 既有复现的必要语义护栏；词表通过不替代完整的逐条审阅。
      if(report.condition!=='before'){
        if(sample.id.includes('dev-06')){const inner=result.text.match(/<g1>(.*?)<\/g1>/s)?.[1]||'';assert.match(inner,/海/);assert.doesNotMatch(inner,/王朝/);}
        if(sample.id.includes('dev-07')){assert.match(result.text,/<g2>\s*<g3>安装指南<\/g3>\s*<\/g2>/);assert.match(result.text,/关闭.*复制/s);}
        if(sample.id.includes('holdout-03')){const parent=result.text.match(/<g4>(.*?)<\/g4>/s)?.[1]||'';assert.match(parent,/团队将.*<g9>青铜印章<\/g9>.*移.*北/s);assert.doesNotMatch(parent,/行动了/);}
      }
    }catch(error){row.error=String(error);}
    row.totalMs=performance.now()-at;row.httpCalls=row.requests.length;report.results.push(row);
    console.log(JSON.stringify({condition:report.condition,mode,id:row.id,seed,totalMs:row.totalMs,calls:row.httpCalls,translation:row.translation,error:row.error}));
  }
}finally{
  report.complete=report.results.length===modes.length*plan.cases.length*plan.seeds.length&&!report.results.some(row=>row.error);
  await writeFile(path.join(directory,report.condition+'.json'),JSON.stringify(report,null,2)+'\n');alignment.dispose();await extractor.dispose();await dictionary.dispose();
}
assert.ok(report.complete,'查看JSON里的逐项错误；结构通过仍需单独核对语义和标签绑定。');
