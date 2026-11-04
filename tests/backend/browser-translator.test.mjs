import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const { BrowserTranslatorEngine, browserLanguage } = require(path.join(build, 'backend/browser-translator-engine.js'));
const { createBrowserTranslatorBridge } = require(path.join(build, 'backend/browser-translator-bridge.js'));
const fixture = () => {
  const calls = { availability: [], creates: [], translated: [], destroyed: 0, detections: [], detectorCreates: 0 };
  const environment = { secure: true, translator: {
    availability: async (options) => { calls.availability.push(options); return 'available'; },
    create: async (options) => { calls.creates.push(options); return { translate: async (text, input) => { calls.translated.push({ text, signal: input?.signal }); return `译:${text}`; }, destroy: () => calls.destroyed++ }; },
  }, detector: { availability: async () => 'available', create: async () => { calls.detectorCreates++; return { detect: async (text) => { calls.detections.push(text); return [{ detectedLanguage: 'fr', confidence: 0.98 }]; }, destroy() {} }; } } };
  const engine = new BrowserTranslatorEngine(() => environment); return { engine, environment, calls };
};
const input = (sourceLang = 'en', targetLang = 'zh-CN') => ({ texts: ['Hello.'], sourceLang, targetLang });

test('内置语言代码规范化，不把auto或坏代码传入Translator', () => {
  assert.equal(browserLanguage('zh-CN'), 'zh'); assert.equal(browserLanguage('zh-TW'), 'zh-Hant'); assert.equal(browserLanguage('pt-BR'), 'pt-BR');
  assert.throws(() => browserLanguage('auto')); assert.throws(() => browserLanguage('not a language'));
});

test('未提供Window API、非安全上下文或需下载时快速不可用，绝不后台下载', async () => {
  const { engine, environment, calls } = fixture();
  environment.translator.availability = async () => 'downloadable';
  assert.equal((await engine.availability('en', 'zh')).status, 'downloadable');
  await assert.rejects(engine.translate(input()), (error) => error.info.code === 'no_provider'); assert.equal(calls.creates.length, 0);
  environment.secure = false; assert.equal((await engine.availability('en', 'zh')).status, 'unavailable'); engine.dispose();
});

test('真实已准备语言对按输入顺序翻译并复用本机会话，dispose释放', async () => {
  const { engine, calls } = fixture();
  const result = await engine.translate({ ...input(), texts: ['One.', 'Two.'] }); assert.deepEqual(result, ['译:One.', '译:Two.']);
  await engine.translate(input()); assert.equal(calls.creates.length, 1); assert.equal(calls.creates[0].targetLanguage, 'zh');
  engine.dispose(); assert.equal(calls.destroyed, 1);
});

test('auto必须使用真实检测结果，不猜英语；检测模型未就绪不创建Translator', async () => {
  const { engine, environment, calls } = fixture();
  await engine.translate(input('auto')); assert.equal(calls.creates[0].sourceLanguage, 'fr'); assert.equal(calls.detectorCreates, 1);
  assert.deepEqual(calls.detections, ['Hello.']); engine.dispose();
  environment.detector.availability = async () => 'unavailable';
  await assert.rejects(engine.translate(input('auto')), (error) => error.info.code === 'no_provider'); assert.equal(calls.creates.length, 1); engine.dispose();
});

test('低置信检测和不支持语言对返回本机不可用，不产生推测结果', async () => {
  const { engine, environment, calls } = fixture();
  environment.detector.create = async () => ({ detect: async () => [{ detectedLanguage: 'en', confidence: 0.2 }], destroy() {} });
  await assert.rejects(engine.translate(input('auto')), (error) => error.info.code === 'no_provider'); assert.equal(calls.creates.length, 0); engine.dispose();
});

test('内置原子/数字段落无需模型，坏输入仍拒绝', async () => {
  const { engine, calls } = fixture();
  assert.deepEqual(await engine.translate({ ...input('auto'), texts: ['123 <x0/>.'] }), ['123 <x0/>.']); assert.equal(calls.creates.length, 0);
  await assert.rejects(engine.translate({ ...input(), texts: ['x'.repeat(2001)] }), (error) => error.info.code === 'bad_input'); engine.dispose();
});

test('取消传递到真实本机会话，取消后的输出不交付且会话释放', async () => {
  const { engine, environment, calls } = fixture();
  environment.translator.create = async () => ({ translate: async (_text, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }), destroy: () => calls.destroyed++ });
  const controller = new AbortController(); const pending = engine.translate(input(), controller.signal); setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls.destroyed, 1); engine.dispose();
});

test('内置会话最多缓存三组语言对，淘汰和关闭均真实destroy', async () => {
  const { engine, calls } = fixture(); for (const source of ['en', 'fr', 'de', 'es']) await engine.translate(input(source));
  assert.equal(calls.creates.length, 4); assert.equal(calls.destroyed, 1); engine.dispose(); assert.equal(calls.destroyed, 4);
});

test('本机bridge取消派发内部任务，保持编号且不经HTTP', async () => {
  const calls = [];
  const bridge = createBrowserTranslatorBridge(async (task, payload) => { calls.push({ task, payload }); return task.endsWith('translate') ? new Promise(() => {}) : { ok: true }; });
  const controller = new AbortController(); const pending = bridge.translate(input(), controller.signal); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.deepEqual(calls.map(({ task }) => task), ['browser-translator:translate', 'browser-translator:cancel']);
  assert.equal(calls[0].payload.id, calls[1].payload.id);
});

test('后台CLD可靠识别后向offscreen传真实语言，auto状态不依赖AI检测模型下载', async () => {
  const calls = [], samples = [];
  const bridge = createBrowserTranslatorBridge(async (task,payload) => {
    calls.push({task,payload}); return task.endsWith('availability') ? {status:'available',sourceLanguage:payload.sourceLang,targetLanguage:'zh',supportsAuto:false,detectorStatus:'unavailable'} : {ok:true,texts:['真实结果']};
  }, async (text) => { samples.push(text); return {isReliable:true,languages:[{language:'fr',percentage:100}]}; });
  const signal = new AbortController().signal;
  const status = await bridge.availability('auto','zh',signal); assert.equal(status.supportsAuto,true); assert.equal(status.sourceLanguage,'auto');
  assert.deepEqual(await bridge.translate({...input('auto'),texts:['<g0>Bonjour à tous.</g0>']},signal),['真实结果']);
  assert.equal(calls[1].payload.sourceLang,'fr'); assert.deepEqual(samples,['Bonjour à tous.']);
});

test('后台CLD不可靠、未知或混合语言均降级，不发出猜测翻译请求', async () => {
  for (const result of [{isReliable:false,languages:[{language:'en',percentage:100}]},{isReliable:true,languages:[{language:'und',percentage:100}]},{isReliable:true,languages:[{language:'en',percentage:90},{language:'fr',percentage:10}]}]) {
    let called=false; const bridge = createBrowserTranslatorBridge(async()=>{called=true;},async()=>result);
    await assert.rejects(bridge.translate(input('auto'),new AbortController().signal),(error)=>error.info.code==='no_provider'); assert.equal(called,false);
  }
});

test('后台CLD等待期间可取消，不创建offscreen翻译会话', async () => {
  let called=false; const bridge=createBrowserTranslatorBridge(async()=>{called=true;},async()=>new Promise(()=>{}));
  const controller=new AbortController(), pending=bridge.translate(input('auto'),controller.signal); controller.abort();
  await assert.rejects(pending,{name:'AbortError'}); assert.equal(called,false);
});

test('dispose后迟到的原生会话真实释放，不能重新写回缓存', async () => {
  const {engine,environment,calls}=fixture(); let release;
  environment.translator.create=()=>new Promise((resolve)=>{release=resolve;});
  const pending=engine.translate(input()); while(!release)await new Promise((resolve)=>setImmediate(resolve));
  engine.dispose(); release({translate:async()=> '不应交付',destroy:()=>calls.destroyed++});
  await assert.rejects(pending,(error)=>error.info.code==='no_provider'); assert.equal(calls.destroyed,1); engine.dispose(); assert.equal(calls.destroyed,1);
});
