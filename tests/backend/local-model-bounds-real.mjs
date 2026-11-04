import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url),provider=require('../.compiled/backend/providers/llamacpp.js').default;
const root=fileURLToPath(new URL('../../',import.meta.url)),server=process.env.LLAMA_URL||'http://127.0.0.1:8081';
const initial=JSON.parse(await readFile(path.join(root,'work/local-model-followup-short.json'),'utf8'));
const sources=[...new Set(initial.reports.map((row)=>row.source))],reports=[];
async function run(source,context,limit,seed,label){
  const row={source,seed,label,maxTokens:limit,titleChars:context.title.length},start=performance.now();
  const ctx={config:{url:server},signal:new AbortController().signal,log(){},fetch:async(url,init)=>{
    const body=JSON.parse(init.body);body.seed=seed;body.max_tokens=limit;row.promptChars=body.messages[0].content.length;
    if(label==='title-budget'){
      // 显式构造旧默认模板，避免适配器上线标题预算后把实验基线也自动裁短。
      const target=new Intl.DisplayNames(['zh-CN'],{type:'language'}).of('zh-CN');
      body.messages[0].content=`背景信息：${[context.title,context.summary?.slice(0,300)].filter(Boolean).join('\n')}\n将以下文本翻译为${target}，注意只需要输出翻译后的结果，不要额外解释：\n${source}`;
      row.promptChars=body.messages[0].content.length;
    }
    const response=await fetch(url,{...init,body:JSON.stringify(body),signal:AbortSignal.timeout(60000)}),json=await response.clone().json();row.httpStatus=response.status;row.finishReason=json.choices?.[0]?.finish_reason;row.timings=json.timings;row.serverError=json.error?.message;return response;
  }};
  try{row.output=(await provider.translate({texts:[source],sourceLang:'en',targetLang:'zh-CN',kind:'ocr',context},ctx))[0];}catch(error){row.error=String(error);}
  row.ms=performance.now()-start;reports.push(row);return row;
}
for(let round=0;round<3;round++)for(let index=0;index<sources.length;index++)for(let offset=0;offset<3;offset++){
  const limits=[1024,64,128],limit=limits[(offset+round+index)%3];await run(sources[index],initial.context,limit,[42,77,123][round],'output-cap');
}
const phrase='Ancient Mesopotamia map, civilizations, rivers and historical kingdoms. ';
for(const titleLength of [160,2000,12000])for(let round=0;round<2;round++)for(let offset=0;offset<3;offset++){
  const budgets=[null,160,256],budget=budgets[(offset+round)%3],full=phrase.repeat(Math.ceil(titleLength/phrase.length)).slice(0,titleLength);
  const row=await run('Babylon',{...initial.context,title:budget===null?full:full.slice(0,budget)},1024,[42,77][round],'title-budget');row.originalTitleChars=titleLength;row.titleBudget=budget;
}
const outputCap=[1024,64,128].map((limit)=>{
  const rows=reports.filter((row)=>row.label==='output-cap'&&row.maxTokens===limit),sorted=rows.map((row)=>row.ms).sort((a,b)=>a-b);
  const differences=rows.filter((row)=>row.output!==reports.find((other)=>other.label===row.label&&other.source===row.source&&other.seed===row.seed&&other.maxTokens===1024)?.output);
  return{maxTokens:limit,n:rows.length,truncated:rows.filter((row)=>row.finishReason==='length').length,errors:rows.filter((row)=>row.error).length,changedOutput: differences.length,p50Ms:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],totalOutputTokens:rows.reduce((sum,row)=>sum+(row.timings?.predicted_n||0),0)};
});
const titleBudget=[null,160,256].map((budget)=>{const rows=reports.filter((row)=>row.label==='title-budget'&&row.titleBudget===budget);return{budget,n:rows.length,errors:rows.filter((row)=>row.error).length,outputs:rows.map(({originalTitleChars,output,httpStatus,promptChars,timings,ms})=>({originalTitleChars,output,httpStatus,promptChars,promptMs:timings?.prompt_ms,promptTokens:timings?.prompt_n,ms}))};});
await writeFile(path.join(root,'work/local-model-followup-bounds.json'),JSON.stringify({at:new Date().toISOString(),server,adapterVersion:provider.version,scope:'仅合成标签/上下文，官方采样；上限和标题截断为测试边界，不改变生产适配器',outputCap,titleBudget,reports},null,2));console.log(JSON.stringify({outputCap,titleBudget}));
