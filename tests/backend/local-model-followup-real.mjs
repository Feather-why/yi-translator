import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url),provider=require('../.compiled/backend/providers/llamacpp.js').default;
const root=fileURLToPath(new URL('../../',import.meta.url)),server=process.env.LLAMA_URL||'http://127.0.0.1:8081';
const target=new Intl.DisplayNames(['zh-CN'],{type:'language'}).of('zh-CN');
const context={url:'https://example.test/synthetic-ancient-map',title:'Ancient Mesopotamia',summary:'Ancient Mesopotamia was a region between the Tigris and Euphrates rivers. Its historical civilizations include Sumer, Akkad, Babylonia, and Assyria. The image is a historical map of the ancient Near East.'};
const labels=[
  ['Akkad',/^(?:阿卡德|阿卡得|Akkad)[。.!]?$/i],['Babylon',/^(?:巴比伦|Babylon)[。.!]?$/i],['Assyria',/^(?:亚述|Assyria)[。.!]?$/i],
  ['Sea of Galilee',/^(?:加利利海|加利利湖|Sea of Galilee)[。.!]?$/i],['Kingdom of Mari',/^(?:马里王国|玛里王国|马里城王国|Mari王国|Kingdom of Mari)[。.!]?$/i],
  ['17.5 m',/^17\.5\s*(?:米|m)[。.!]?$/],['Euphrates',/^(?:幼发拉底河?|Euphrates)[。.!]?$/i],['Tigris',/^(?:底格里斯河?|Tigris)[。.!]?$/i],
  ['Mediterranean Sea',/^(?:地中海|Mediterranean Sea)[。.!]?$/i],['A-12',/^A-12[。.!]?$/],['35°N',/^(?:35\s*°\s*N|北纬\s*35\s*(?:°|度)?|35\s*°\s*北纬)[。.!]?$/i],['ZKR-17',/^ZKR-17[。.!]?$/],
];
const variants=['current-context','no-context','faithful-short'];
const seeds=[42,77,123],reports=[];
for(let round=0;round<seeds.length;round++)for(let index=0;index<labels.length;index++){
  const [source,expected]=labels[index];
  for(let offset=0;offset<variants.length;offset++){
    const variant=variants[(offset+round+index)%variants.length],record={round,seed:seeds[round],source,variant,order:offset+1};
    const start=performance.now(),ctx={config:{url:server},signal:new AbortController().signal,log(){},fetch:async(url,init)=>{
      const body=JSON.parse(init.body);body.seed=record.seed;
      if(variant!=='current-context')body.messages[0].content=(variant==='faithful-short'?'这是 OCR 识别的独立短标签。忠实翻译给定文字，不扩写、不补全、不解释；无法确定的专有名称保留原文。\n':'')+`将以下文本翻译为${target}，注意只需要输出翻译后的结果，不要额外解释：\n${source}`;
      record.promptHash=createHash('sha256').update(body.messages[0].content).digest('hex');record.promptChars=body.messages[0].content.length;record.maxTokens=body.max_tokens;
      const response=await fetch(url,{...init,body:JSON.stringify(body),signal:AbortSignal.timeout(60000)}),json=await response.clone().json();record.timings=json.timings;record.finishReason=json.choices?.[0]?.finish_reason;record.rawOutput=json.choices?.[0]?.message?.content;return response;
    }};
    try{record.output=(await provider.translate({texts:[source],sourceLang:'en',targetLang:'zh-CN',context,kind:'ocr'},ctx))[0];record.acceptable=expected.test(record.output.trim());}
    catch(error){record.error=String(error);record.acceptable=false;}
    record.ms=performance.now()-start;reports.push(record);
  }
  console.log(JSON.stringify({round,source,results:reports.slice(-variants.length).map(({variant,output,acceptable,ms,finishReason})=>({variant,output,acceptable,ms,finishReason}))}));
}
const summarize=(name)=>{
  const rows=reports.filter((row)=>row.variant===name),sorted=rows.map((row)=>row.ms).sort((a,b)=>a-b),quantile=(p)=>sorted[Math.ceil(sorted.length*p)-1];
  return{variant:name,n:rows.length,acceptable:rows.filter((row)=>row.acceptable).length,truncated:rows.filter((row)=>row.finishReason==='length').length,totalMs:rows.reduce((sum,row)=>sum+row.ms,0),p50Ms:quantile(.5),p95Ms:quantile(.95),totalOutputTokens:rows.reduce((sum,row)=>sum+(row.timings?.predicted_n||0),0),meanPromptTokens:rows.reduce((sum,row)=>sum+(row.timings?.prompt_n||0),0)/rows.length};
};
const summary=variants.map(summarize);assert.equal(reports.length,108);
await mkdir(path.join(root,'work'),{recursive:true});await writeFile(path.join(root,'work/local-model-followup-short.json'),JSON.stringify({at:new Date().toISOString(),server,adapterVersion:provider.version,scope:'合成古地图网页上下文与公开地理标签，不是用户截图OCR重现；固定官方采样、多seed轮转顺序；无生产行为变更',context,summary,reports},null,2));console.log(JSON.stringify(summary));
