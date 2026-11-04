import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const modules=new Map();
async function compile(id){
 if(modules.has(id))return;modules.set(id,'');
 const source=await readFile(path.join(root,id),'utf8');
 let output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const dependencies=[];
 output=output.replace(/require\("([^"]+)"\)/g,(_match,spec)=>{assert.ok(spec.startsWith('.'));const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(id),spec))+'.ts';dependencies.push(resolved);return 'require('+JSON.stringify(resolved)+')';});
 modules.set(id,output);for(const dependency of dependencies)await compile(dependency);
}
await compile('src/frontend/options/status.ts');await compile('src/frontend/options/builtin-pack.ts');
const bundle='(()=>{const modules={'+[...modules].map(([id,code])=>JSON.stringify(id)+':function(require,module,exports){'+code+'}').join(',')+'};const cache={};function require(id){if(cache[id])return cache[id].exports;const module={exports:{}};cache[id]=module;modules[id](require,module,module.exports);return module.exports;}window.testUi={...require("src/frontend/options/status.ts"),...require("src/frontend/options/builtin-pack.ts")};})();';
const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--no-first-run']});
const context=await browser.newContext({locale:'zh-CN'});
async function page(){const page=await context.newPage();await page.setContent('<main></main>');await page.evaluate(()=>{
 window.sent=[];window.snapshots=[];window.rpcCalls=[];
 window.chrome={runtime:{connect(){return {onMessage:{addListener(fn){window.snapshots.push(fn);}},onDisconnect:{addListener(){}},postMessage(msg){window.sent.push(msg);},disconnect(){}};},async sendMessage(req){window.rpcCalls.push(req);return {ok:true,data:{ok:true,latencyMs:12}};}},storage:{local:{async get(key){return {[key]:key==='settings.ui'?{sourceLang:'de',targetLang:'fr'}:[]};}},onChanged:{addListener(){},removeListener(){}}}};
});await page.addScriptTag({content:bundle});return page;}
let passed=0;
try{
 const status=await page();
 const result=await status.evaluate(async()=>{
  window.testUi.mountStatus(document.querySelector('main'));
  const provider=(id,rank)=>({id,name:id,kind:'mt',official:true,enabled:true,configured:true,health:'ok',active:false,rank,latencyP50Ms:100,successRate:1,adapter:{file:id+'.ts',version:'1'},usedFor:['fast','accurate'],pinned:false,circuit:'closed'});
  const snapshot={at:Date.now(),providers:[provider('a',1),provider('b',2)],nodes:[],events:[],perf:{samples:0}};
  const send=()=>window.snapshots[0]({type:'snapshot',status:snapshot});send();
  const row=document.querySelector('tr[data-status-key="a"]');const button=row.querySelectorAll('button')[1];button.focus();
  snapshot.providers[0].rank=2;snapshot.providers[0].latencyP50Ms=321;snapshot.providers[0].health='disabled';snapshot.providers[1].rank=1;send();
  const preserved=row===document.querySelector('tr[data-status-key="a"]')&&row.querySelectorAll('button')[1]===button&&document.activeElement===button;
  const updated=row.textContent.includes('321 ms');button.click();
  const action=window.sent.at(-1);
  const accurate=document.querySelectorAll('tbody')[1];const emptyRank=accurate.querySelector('td.rank').textContent==='';
  snapshot.providers[1].enabled=false;send();const disabledAbsent=!document.querySelector('tr[data-status-key="b"]');
  return {preserved,updated,action,emptyRank,disabledAbsent};
 });assert.equal(result.preserved,true);assert.equal(result.updated,true);assert.equal(result.action.action,'resume');assert.equal(result.emptyRank,true);assert.equal(result.disabledAbsent,true);console.log('PASS status keyed rows retain focus across reordered changed snapshots and updated actions');passed++;
 await status.locator('tr[data-status-key="a"]').first().getByRole('button',{name:'检测',exact:true}).click();
 await status.waitForFunction(()=>window.rpcCalls.length>0);const request=await status.evaluate(()=>window.rpcCalls.at(-1));assert.deepEqual(request.payload,{id:'a',sourceLang:'de',targetLang:'fr'});console.log('PASS explicit status check uses the current language direction');passed++;
 const download=await page();await download.evaluate(()=>{
  window.Translator={availability:async()=>window.downloaded?'available':'downloadable',create(options){window.created=options;return new Promise(resolve=>window.finish=()=>{window.downloaded=true;resolve({destroy(){window.destroyed=true;}});});}};
  document.querySelector('main').append(window.testUi.builtinPackCard('zh-CN',{id:'browser-translator',enabled:true,config:{}}));
 });await download.getByRole('link',{name:'其他语言…'}).click();await download.getByRole('button',{name:'下载语言包'}).click();
 assert.equal(await download.getByLabel('原文语言').isDisabled(),true);assert.equal(await download.getByLabel('译文语言').isDisabled(),true);
 await download.evaluate(()=>{const select=document.querySelector('select');select.value='ja';select.dispatchEvent(new Event('change'));window.finish();});
 await download.waitForFunction(()=>!document.querySelector('select').disabled);
 const done=await download.evaluate(()=>({created:{source:window.created.sourceLanguage,target:window.created.targetLanguage},pair:window.testUi.builtinTestPair('zh-CN'),line:document.querySelector('.bp-row').textContent,selected:document.querySelector('select').value,sent:window.sent,destroyed:window.destroyed}));
 assert.deepEqual(done.created,{source:'en',target:'zh'});assert.deepEqual(done.pair,{sourceLang:'en',targetLang:'zh-CN'});assert.equal(done.selected,'en');assert.equal(done.destroyed,true);assert.match(done.line,/English.*简体中文/);assert.ok(done.sent.some(x=>x.type==='probe'));console.log('PASS downloading locks both selectors, completion belongs to its original pair, cache invalidation is sent');passed++;
 const race=await page();await race.evaluate(()=>{
  window.Translator={availability(options){if(options.sourceLanguage==='en'&&options.targetLanguage==='de')return new Promise(resolve=>window.oldMark=resolve);return Promise.resolve('available');},create(){throw Error('unexpected download');}};
  document.querySelector('main').append(window.testUi.builtinPackCard('zh-CN'));
 });await race.getByRole('link',{name:'其他语言…'}).click();await race.waitForFunction(()=>!!window.oldMark);await race.getByLabel('原文语言').selectOption('fr');
 await race.waitForFunction(()=>document.querySelectorAll('select')[1].querySelector('option[value="de"]').textContent.includes('已下载'));
 await race.evaluate(()=>window.oldMark('unavailable'));await race.evaluate(()=>Promise.resolve());
 assert.equal(await race.locator('select').nth(1).locator('option[value="de"]').isDisabled(),false);assert.deepEqual(await race.evaluate(()=>window.testUi.builtinTestPair('zh-CN')),{sourceLang:'fr',targetLang:'zh-CN'});console.log('PASS stale availability from the previous source cannot change current options');passed++;
 const refresh=await page();await refresh.evaluate(()=>{
  let first=true;window.Translator={availability(options){if(first){first=false;return new Promise(resolve=>window.oldRefresh=resolve);}return Promise.resolve(options.sourceLanguage==='fr'?'downloadable':'available');},create(){throw Error('unexpected');}};
  document.querySelector('main').append(window.testUi.builtinPackCard('zh-CN'));
 });await refresh.getByRole('link',{name:'其他语言…'}).click();await refresh.getByLabel('原文语言').selectOption('fr');await refresh.waitForFunction(()=>document.querySelector('.bp-row').textContent.includes('还没下载'));
 await refresh.evaluate(()=>window.oldRefresh('available'));await refresh.evaluate(()=>Promise.resolve());assert.match(await refresh.locator('.bp-row').first().textContent(),/Français.*还没下载/);console.log('PASS late refresh does not overwrite the selected pair status');passed++;
 console.log(`services049 browser: ${passed}/5 passed`);
}finally{await context.close();await browser.close();}
