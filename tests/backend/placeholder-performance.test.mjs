import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {translateWithProjectedPlaceholders}=require('../.compiled/backend/translation-quality.js');
const {translateTextLeaves}=require('../.compiled/backend/placeholder-fallback.js');
const {validTranslation}=require('../.compiled/backend/validation.js');
const {wordTokens}=require('../.compiled/backend/align/algorithm.js');
const base={sourceLang:'en',targetLang:'zh-CN',strategy:'lazy'};
const signal=()=>new AbortController().signal;
function diagnostic(records){assert.equal(records.length,1);const record=records[0];for(const name of ['totalMs','modelMs','lookupMs','alignmentMs','restoreMs'])assert.ok(Number.isFinite(record[name])&&record[name]>=0);assert.ok(record.totalMs+0.01>=record.modelMs+record.lookupMs+record.alignmentMs);assert.equal(Object.values(record).some((value)=>typeof value==='string'&&/TXP|指南|guide|https:/.test(value)),false);return record;}

test('lazy已有真实词典证据时只翻完整句一次，原子和链接保持严格结构',async()=>{
  const source='The <g0>browser</g0> runs <x0/> locally.',calls=[],records=[];
  const result=await translateWithProjectedPlaceholders(source,async(text,terms)=>{calls.push({text,terms});return'浏览器在本地运行[TXP0_0]。';},{...base,lookup:async()=>({translations:['n. 浏览器']}),onDiagnostic:(record)=>records.push(record)},signal());
  assert.equal(result,'<g0>浏览器</g0>在本地运行<x0/>。');assert.ok(validTranslation(source,result));assert.equal(calls.length,1);assert.equal(calls[0].terms,undefined);
  const record=diagnostic(records);assert.equal(record.outcome,'success');assert.equal(record.modelCalls,1);assert.equal(record.anchorCalls,0);assert.equal(record.plainCalls,1);assert.equal(record.lookupCalls,1);assert.equal(record.groups,1);assert.equal(record.atoms,1);
});

test('lazy真实词级映射可定位词组，不为已有可靠范围再翻短锚点',async()=>{
  const source='Read <g0>the guide</g0> before running <x0/>.',records=[];let calls=0;
  const result=await translateWithProjectedPlaceholders(source,async()=>{calls++;return'请先阅读指南，再运行[TXP0_0]。';},{...base,onDiagnostic:(record)=>records.push(record),align:async(pair)=>{
    const srcTokens=wordTokens(pair.source,'en'),tgtTokens=wordTokens(pair.target,'zh-CN');return{id:pair.id,srcTokens,tgtTokens,links:[[srcTokens.findIndex(([a,b])=>pair.source.slice(a,b)==='guide'),tgtTokens.findIndex(([a,b])=>pair.target.slice(a,b)==='指南')]]};
  }},signal());
  assert.equal(result,'请先阅读<g0>指南</g0>，再运行<x0/>。');assert.equal(calls,1);assert.equal(diagnostic(records).alignmentCalls,1);
});

test('lazy只补缺少定位证据的锚点，保留第一遍自然正文和语序',async()=>{
  const source='Read <g0>the guide</g0> before running <x0/>.',calls=[],records=[];
  const result=await translateWithProjectedPlaceholders(source,async(text,terms)=>{calls.push({text,terms});return text==='the guide'?'指南':'运行[TXP0_0]之前，请阅读指南。';},{...base,onDiagnostic:(record)=>records.push(record)},signal());
  assert.equal(result,'运行<x0/>之前，请阅读<g0>指南</g0>。');assert.equal(calls.length,2);assert.ok(calls[0].text.startsWith('Read'));assert.equal(calls[1].text,'the guide');assert.equal(calls[0].terms,undefined);
  const record=diagnostic(records);assert.equal(record.anchorCalls,1);assert.equal(record.plainCalls,1);
});

test('无法定位同义译词时回到完整术语重译，绝不拼接源序碎片',async()=>{
  const source='Read <g0>the guide</g0> before running <x0/>.',calls=[],records=[];
  const result=await translateWithProjectedPlaceholders(source,async(text,terms)=>{calls.push({text,terms});return text==='the guide'?'指南':terms?.length?'运行[TXP0_0]之前，请阅读指南。':'运行[TXP0_0]之前，请阅读说明书。';},{...base,onDiagnostic:(record)=>records.push(record)},signal());
  assert.equal(result,'运行<x0/>之前，请阅读<g0>指南</g0>。');assert.equal(calls.length,3);assert.equal(calls[0].terms,undefined);assert.deepEqual(calls[2].terms,[{source:'the guide',target:'指南'}]);
  const record=diagnostic(records);assert.equal(record.anchorCalls,1);assert.equal(record.plainCalls,2);
});

test('lazy嵌套重复短语共用预算；缺失、重复原子及过宽伪对齐仍安全拒绝',async()=>{
  for(const target of ['请阅读指南。','请阅读指南[TXP0_0][TXP0_0]。']){
    const source='Read <g0><g1>the guide</g1></g0> with <x0/>.',records=[];let calls=0;
    const result=await translateWithProjectedPlaceholders(source,async(text)=>{calls++;return text==='the guide'?'指南':target;},{...base,onDiagnostic:(record)=>records.push(record)},signal());
    assert.equal(result,null);assert.equal(calls,3);const record=diagnostic(records);assert.equal(record.outcome,'unresolved');assert.equal(record.anchorCalls,1);assert.equal(record.plainCalls,2);
  }
  const source='The <g0>guide</g0> explains how a complete page is translated.';
  const result=await translateWithProjectedPlaceholders(source,async(text)=>text==='guide'?'指导书':'该指南解释整页翻译。',{...base,align:async(pair)=>{const srcTokens=wordTokens(pair.source,'en'),tgtTokens=wordTokens(pair.target,'zh-CN');return{id:pair.id,srcTokens,tgtTokens,links:srcTokens.flatMap((_,a)=>tgtTokens.map((_,b)=>[a,b]))};}},signal());assert.equal(result,null);
});

test('lazy六锚点预算固定，原安全策略仍默认且保持原请求顺序',async()=>{
  const source=Array.from({length:10},(_,index)=>`<g${index}>word${index}</g${index}>`).join(' '),records=[];let calls=0;
  assert.equal(await translateWithProjectedPlaceholders(source,async()=>{calls++;return'没有对应锚点';},{...base,onDiagnostic:(record)=>records.push(record)},signal()),null);
  assert.equal(calls,8);assert.equal(diagnostic(records).anchorCalls,6);
  const order=[],anchored=[];assert.equal(await translateWithProjectedPlaceholders('Read <g0>guide</g0>.',async(text)=>{order.push(text);return text==='guide'?'指南':'阅读指南。';},{sourceLang:'en',targetLang:'zh-CN',onDiagnostic:(record)=>anchored.push(record)},signal()),'阅读<g0>指南</g0>。');
  assert.deepEqual(order,['guide','Read guide.']);assert.equal(diagnostic(anchored).strategy,'anchored');
});

test('诊断只发一次无文本计时，回调异常不影响结果，取消仍及时传播',async()=>{
  const records=[],controller=new AbortController();
  await assert.rejects(translateWithProjectedPlaceholders('Read <g0>guide</g0>.',async()=>{controller.abort();return'指南';},{...base,onDiagnostic:(record)=>records.push(record)},controller.signal),{name:'AbortError'});
  assert.equal(diagnostic(records).outcome,'cancelled');
  const done=await translateWithProjectedPlaceholders('<g0>Read a sentence.</g0>',async()=> '阅读完整句子。',{...base,onDiagnostic:()=>{throw Error('诊断故障');}},signal());assert.equal(done,'<g0>阅读完整句子。</g0>');
});

test('最后叶子安全降级单独记次数和取消，不把碎片次数称为完整句翻译',async()=>{
  const records=[],source='Read <g0>guide</g0> <x0/>.';
  const result=await translateTextLeaves(source,async(text)=>text==='Read'?'阅读':'指南',signal(),{onDiagnostic:(record)=>records.push(record)});
  assert.ok(validTranslation(source,result));const record=diagnostic(records);assert.equal(record.kind,'placeholder-leaves');assert.equal(record.leafCalls,2);assert.equal(record.plainCalls,0);assert.equal(record.modelCalls,2);
  const cancelled=[],controller=new AbortController();controller.abort();await assert.rejects(translateTextLeaves(source,async()=>'',controller.signal,{onDiagnostic:(record)=>cancelled.push(record)}),{name:'AbortError'});assert.equal(diagnostic(cancelled).outcome,'cancelled');assert.equal(cancelled[0].modelCalls,0);
});
