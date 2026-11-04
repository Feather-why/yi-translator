import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRpcHandlers, registerRpc, isAdminSender } = require('../.compiled/backend/rpc.js');
const { encryptSecrets } = require('../.compiled/backend/secrets-backup.js');
const id = 'fixture-extension-id';
const admin = { id, url: `chrome-extension://${id}/options.html`, tab: { id: 1, windowId: 1 } };
const content = { id, url: 'https://example.test/article', tab: { id: 2, windowId: 1, url: 'https://example.test/article' } };
function setup() {
  const values = { fixture: { key: 'fixture-private-key' } }, calls = [], listeners = new Set();
  globalThis.chrome = { runtime: { id, getURL: (path) => `chrome-extension://${id}/${path}`, openOptionsPage: async () => { calls.push('open-options'); },
    onMessage: { addListener: (callback) => listeners.add(callback), removeListener: (callback) => listeners.delete(callback) } },
    storage: { local: { get: async () => ({}) } }, tabs: { create: async (value) => { calls.push(['tab', value]); } } };
  const vault = { get: async (name) => structuredClone(values[name] || {}), set: async (name, value) => { values[name] = structuredClone(value); } };
  const core = { getVault: () => vault, refreshStoredState: async () => calls.push('refresh-core'),
    list: async () => [{ id: 'fixture', config: { key: '••••' } }, { id: 'pseudo' }], save: async (...args) => { calls.push(['save', ...args]); return { ok: true }; },
    test: async () => ({ ok: true, latencyMs: 5 }), feedback: async () => ({ ok: true }), saveMemory: async (...args) => { calls.push(['tm', ...args]); return { ok: true }; },
    report: async () => ({ ok: true }), explain: async () => ({ text: '合成解释', provider: 'fixture' }) };
  const services = { dictionary: { lookup: async (...args) => { calls.push(['lookup', ...args]); return { word: args[0], source: 'ecdict', translations: ['合成释义'] }; }, importCsv: async () => ({ count: 2 }) },
    alignment: { get: async (pairs, options) => { calls.push(['align', options]); return pairs.map((pair) => ({ id: pair.id, srcTokens: [], tgtTokens: [], links: [] })); } },
    rules: { ready: async () => {}, forUrl: (url) => { calls.push(['rule', url]); return null; }, all: () => [], list: () => ({subscriptions:[]}), save: async () => calls.push('save-rule'), remove: async () => {}, subscribe: async () => ({ subscriptions: [] }), refresh: async () => ({ subscriptions: [] }), rollback: async () => {} },
    sync: { notifyChange: () => calls.push('notify-sync') }, configureAlignment: async () => ({ ok: true }), configureSync: async () => ({ ok: true }), runSync: async () => ({ ok: true }),
    refresh: async () => calls.push('refresh-services'), capabilities: () => ({ protocol: 2, dictionary: { ready: true }, alignment: { ready: true }, media: { ocr: true, subtitles: true, pdf: true }, sync: { enabled: false } }),
    media: { ocr: async (request) => { calls.push(['ocr', request]); return { width: 1, height: 1, blocks: [], engine: 'fixture', model: 'fixture' }; },
      subtitles: async (request) => { calls.push(['subtitles', request]); return { segments: [] }; }, pdf: async (request) => { calls.push(['pdf', request]); return { documentId: 'fixture', pages: [], warnings: [] }; } } };
  return { values, calls, listeners, core, services, handlers: createRpcHandlers(core, services) };
}
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.info?.code === code);

test('协议v2保留旧v1 RPC兼容，无业务实例时查词/规则及启发式对齐仍有返回', async () => {
  const { core } = setup(); const handlers = createRpcHandlers(core);
  assert.equal((await handlers.ping(undefined, content)).protocol, 3);
  assert.equal(await handlers['dict:lookup']({ word: 'word', lang: 'en', targetLang: 'zh' }, content), null);
  assert.equal(await handlers['rules:forUrl']({ url: 'https://example.test/' }, content), null);
  const [alignment] = await handlers['align:get']({ pairs: [{ id: 's1', source: 'abc 123', target: 'abc 123', sourceLang: 'en', targetLang: 'en' }] }, content);
  assert.deepEqual(alignment.links, [[0, 0], [1, 1]]);
});

test('旧前端auto英文查词映射到ECDICT，真实规则和敏感来源对齐保护被接线', async () => {
  const { handlers, calls } = setup();
  const entry = await handlers['dict:lookup']({ word: 'running', lang: 'auto', targetLang: 'zh-CN' }, content); assert.equal(entry.source, 'ecdict');
  assert.deepEqual(calls[0], ['lookup', 'running', 'en', 'zh-CN']);
  await handlers['rules:forUrl']({ url: 'https://example.test/a' }, content); assert.ok(calls.some((entry) => entry[0] === 'rule'));
  const pair = { id: 'x', source: 'source', target: '译文', sourceLang: 'en', targetLang: 'zh' };
  await handlers['align:get']({ pairs: [pair] }, { ...content, url: 'https://mail.google.com/' }); assert.deepEqual(calls.at(-1), ['align', { noCache: true, localOnly: true }]);
  await handlers['align:get']({ pairs: [pair] }, content); assert.deepEqual(calls.at(-1), ['align', { noCache: false, localOnly: false }]);
});

test('所有新管理RPC仅允许本扩展页面，content脚本和伪造origin不能改变管理状态', async () => {
  const { handlers, calls } = setup();
  for (const sender of [content, { id: 'other', url: admin.url }, { id, url: `chrome-extension://${id}.evil/options.html` }, { id }]) {
    assert.equal(isAdminSender(sender), false);
    for (const name of ['dict:import', 'align:configure', 'rules:list', 'rules:subscriptions', 'rules:save', 'rules:remove', 'rules:subscribe', 'rules:refresh', 'rules:rollback', 'sync:configure', 'sync:run', 'secrets:export', 'secrets:import']) await rejectsCode(handlers[name]({}, sender), 'auth');
  }
  assert.deepEqual(calls, []); assert.equal(isAdminSender(admin), true);
  assert.deepEqual(await handlers['dict:import']({ csv: 'synthetic' }, admin), { ok: true, entries: 2 });
  assert.deepEqual(await handlers['sync:configure']({ enabled: false }, admin), { ok: true });
  await rejectsCode(handlers['rules:save'](null, admin), 'bad_input');
});

test('译文记忆及本地规则更新通知同步，敏感TM标记保留', async () => {
  const { handlers, calls } = setup();
  await handlers['tm:save']({ source: 'Hello', target: '你好', sourceLang: 'en', targetLang: 'zh' }, content);
  assert.equal(calls.at(-1), 'notify-sync'); assert.equal(calls.find((entry) => entry[0] === 'tm').at(-1), false);
  await handlers['rules:save']({ rule: { id: 'x', match: ['https://example.test/*'], source: 'local' } }, admin); assert.equal(calls.at(-1), 'notify-sync');
});

test('媒体RPC只接受本扩展，敏感/隐身来源即使传noCache=false也强制保护', async () => {
  const { handlers, calls, core, services } = setup();
  for (const [name, tag] of [['ocr:image', 'ocr'], ['subtitle:translate', 'subtitles'], ['pdf:translate', 'pdf']]) {
    await rejectsCode(handlers[name]({ noCache: false }, { ...content, id: 'other' }), 'auth');
    await handlers[name]({ noCache: false }, { ...content, tab: { ...content.tab, incognito: true } }); assert.equal(calls.at(-1)[0], tag); assert.equal(calls.at(-1)[1].noCache, true);
    await handlers[name]({ noCache: false }, content); assert.equal(calls.at(-1)[1].noCache, false);
  }
  delete services.media; await rejectsCode(handlers['ocr:image']({}, content), 'no_provider');
  assert.equal((await handlers['backend:capabilities'](undefined, content)).protocol, 2);
  assert.equal(createRpcHandlers(core, services).__proto__, undefined);
});

test('RPC备份只返回加密归档，导入后刷新核心；拒绝导入sync自身凭据', async () => {
  const { handlers, values, calls } = setup();
  const { archive } = await handlers['secrets:export']({ passphrase: 'fixture-password' }, admin);
  assert.equal(archive.includes('fixture-private-key'), false); values.fixture = { key: 'changed' };
  await handlers['secrets:import']({ passphrase: 'fixture-password', archive }, admin); assert.equal(values.fixture.key, 'fixture-private-key'); assert.ok(calls.includes('refresh-services'));
  const forbidden = await encryptSecrets({ sync: { password: 'must-not-import' } }, 'fixture-password');
  await rejectsCode(handlers['secrets:import']({ archive: JSON.stringify(forbidden), passphrase: 'fixture-password' }, admin), 'bad_input'); assert.equal(values.sync, undefined);
});

test('注册RPC桥保留标准成功/错误信封，未知原型RPC不响应且可正常注销', async () => {
  const { core, services, listeners } = setup(); const unregister = registerRpc(core, services); assert.equal(listeners.size, 1);
  const [listener] = listeners;
  const response = (rpc, payload, sender) => new Promise((resolve) => { assert.equal(listener({ rpc, payload }, sender, resolve), true); });
  assert.equal((await response('ping', undefined, content)).ok, true);
  const denied = await response('sync:configure', { enabled: true, url: 'https://example.test' }, content); assert.equal(denied.ok, false); assert.equal(denied.error.code, 'auth');
  assert.equal(listener({ rpc: '__proto__' }, content, () => assert.fail('不应响应原型字段')), false);
  unregister(); assert.equal(listeners.size, 0);
});

test('设置RPC直达welcome/advanced并保留旧tab，未知目标仍打开默认设置页', async () => {
  const {handlers,calls}=setup();
  for(const tab of ['general','providers','status','welcome','advanced'])await handlers['ui:openOptions']({tab},content);
  assert.deepEqual(calls.map((call)=>call[1]?.url),['general','providers','status','welcome','advanced'].map((tab)=>`chrome-extension://${id}/options.html#${tab}`));
  await handlers['ui:openOptions']({},content);await handlers['ui:openOptions']({tab:'https://evil.example/'},content);
  assert.deepEqual(calls.slice(-2),['open-options','open-options']);
});

test('向导自动测试禁止打开准备页，保留真实错误；服务设置和内容脚本测试保持默认语义', async () => {
  const {core,services,calls}=setup();
  const error={code:'no_provider',message:'浏览器语言包尚未准备，请到服务设置点击测试打开准备页',retryable:true};
  core.test=async(...args)=>{calls.push(['test',...args]);return{ok:false,error};};
  const handlers=createRpcHandlers(core,services);
  for(const hash of ['#welcome','#welcome/step2'])assert.deepEqual(await handlers['providers:test']({id:'browser-translator'},{...admin,url:admin.url+hash}),{ok:false,error});
  assert.deepEqual(calls.slice(0,2),[['test','browser-translator',{prepare:false}],['test','browser-translator',{prepare:false}]]);
  await handlers['providers:test']({id:'browser-translator'},{...admin,url:admin.url+'#providers'});
  await handlers['providers:test']({id:'browser-translator'},{...content,url:content.url+'#welcome'});
  assert.deepEqual(calls.slice(-2),[['test','browser-translator'],['test','browser-translator']]);
  assert.equal(calls.some((call)=>call[0]==='tab'),false);
});

test('订阅状态RPC只向本扩展管理页返回元数据，void请求兼容旧规则列表', async () => {
  const {core,services}=setup();let ready=0;
  const entry={url:'https://rules.example/list.json',version:'2026.11.03',updatedAt:123,etag:'"http-tag"',lastError:'上次更新失败',count:4,canRollback:true};
  services.rules.ready=async()=>{ready++;};services.rules.list=()=>({local:[],subscriptions:[entry]});
  const handlers=createRpcHandlers(core,services);
  assert.deepEqual(await handlers['rules:subscriptions'](undefined,admin),[entry]);assert.equal(ready,1);
  assert.deepEqual(await handlers['rules:list'](undefined,admin),[]);
  await rejectsCode(handlers['rules:subscriptions'](undefined,content),'auth');
  await rejectsCode(createRpcHandlers(core)['rules:subscriptions'](undefined,admin),'no_provider');
});


test('手动检测透传本次语言方向并保留引导页不弹窗语义', async () => {
 const {core,services}=setup();const seen=[]; core.test=async (...args)=>{seen.push(args);return{ok:true};};const handlers=createRpcHandlers(core,services);
 await handlers['providers:test']({id:'browser-translator',sourceLang:'zh-CN',targetLang:'en'},admin);
 await handlers['providers:test']({id:'browser-translator',sourceLang:'de',targetLang:'es'},{...admin,url:admin.url+'#welcome'});
 assert.deepEqual(seen,[['browser-translator',{sourceLang:'zh-CN',targetLang:'en'}],['browser-translator',{sourceLang:'de',targetLang:'es',prepare:false}]]);
});
