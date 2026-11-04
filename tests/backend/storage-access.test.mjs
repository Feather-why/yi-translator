import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),build=process.env.BACKEND_BUILD_DIR||fileURLToPath(new URL('../.compiled/',import.meta.url));
const{BackendStorage}=require(build+'/backend/storage.js');
test('访问时间异步写入失败时，后续缓存命中仍能重新安排合并写入',async(t)=>{
 const timers=[];t.mock.method(globalThis,'setTimeout',fn=>{timers.push(fn);return timers.length});t.mock.method(globalThis,'clearTimeout',()=>{});
 const storage=new BackendStorage({memory:true});let reject;
 const held=new Promise((_,j)=>reject=j).finally(()=>{storage.accessFlush=undefined});void held.catch(()=>{});storage.accessFlush=held;
 storage.touch('first');timers[0]();reject(Error('synthetic IDB write failure'));
 await new Promise(r=>setImmediate(r));
 storage.touch('later');assert.equal(timers.length,2,'旧写失败后不能永久记住已经触发的timer');
});
