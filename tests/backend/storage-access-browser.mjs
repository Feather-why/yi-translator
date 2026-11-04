import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,mkdtemp} from 'node:fs/promises';
import {build} from 'vite';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../../',import.meta.url)),fixture=path.join(root,'work/storage-access-028'),dist=path.join(fixture,'dist');
await mkdir(fixture,{recursive:true});
await writeFile(path.join(fixture,'index.html'),'<html><body><script type="module" src="./main.ts"></script></body></html>');
await writeFile(path.join(fixture,'main.ts'),"import {BackendStorage,getBackendDatabase} from '../../src/backend/storage'; Object.assign(window,{BackendStorage,getBackendDatabase});");
await build({configFile:false,root:fixture,base:'./',publicDir:false,logLevel:'warn',build:{outDir:dist,emptyOutDir:true,rolldownOptions:{input:path.join(fixture,'index.html')}}});
await writeFile(path.join(dist,'manifest.json'),JSON.stringify({manifest_version:3,name:'Storage access regression fixture',version:'1.0.0',permissions:['storage'],background:{service_worker:'background.js'}}));
await writeFile(path.join(dist,'background.js'),'chrome.runtime.onMessage.addListener(()=>false);');
const profile=await mkdtemp(path.join(fixture,'profile-'));let context;
try{
 context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${dist}`,`--load-extension=${dist}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host,page=await context.newPage();await page.goto(`chrome-extension://${id}/index.html`);await page.waitForFunction(()=>!!window.BackendStorage);
 const results=await page.evaluate(async()=>{
  const {BackendStorage,getBackendDatabase}=window,db=await getBackendDatabase(),storage=new BackendStorage({maxBytes:340}),modes=[];
  const original=IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction=function(names,mode,...rest){if((Array.isArray(names)?names:[names]).includes('cache'))modes.push(mode||'readonly');return original.call(this,names,mode,...rest)};
  const expect=(condition,message)=>{if(!condition)throw Error(message)};
  const put=(source,text)=>storage.cachePut('en','zh','fast',source,{text,provider:'test'}),get=source=>storage.cacheGet('en','zh','fast',source);
  const clear=()=>new Promise((resolve,reject)=>{const tx=db.transaction(['cache','meta'],'readwrite');tx.objectStore('cache').clear();tx.objectStore('meta').delete('cache.bytes');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
  await clear();await put('one','a'.repeat(25));await put('two','b'.repeat(25));modes.length=0;
  const hits=await Promise.all(Array.from({length:50},()=>get('one')));expect(hits.every(h=>h?.text==='a'.repeat(25)),'all hits');expect(modes.length===50&&modes.every(m=>m==='readonly'),'cache hits must only read while pending');
  await storage.flushAccesses();const writes=modes.filter(m=>m==='readwrite').length;expect(writes===1,'touches must coalesce into one transaction');
  await put('three','c'.repeat(25));expect(await get('two')===undefined,'cold entry must be evicted');expect((await get('one'))?.text==='a'.repeat(25),'recent entry must survive');
  await put('one','updated');await storage.flushAccesses();expect((await get('one')).text==='updated','touch cannot overwrite new translation');
  await storage.flushAccesses();await get('one');await clear();await storage.flushAccesses();expect(await get('one')===undefined,'touch cannot resurrect deleted entry');
  await storage.tmPut('en','zh','manual','人工修订');expect((await storage.tmGet('en','zh','manual')).text==='人工修订','manual memory is independent');
  IDBDatabase.prototype.transaction=original;return{checks:6,hits:50,readTransactions:50,mergedTouchWrites:writes,passed:true};
 });
 assert.equal(results.passed,true);const report=process.env.REPORT_DIR||fixture;await mkdir(report,{recursive:true});await writeFile(path.join(report,'storage-access-browser.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));
}finally{await context?.close();}
