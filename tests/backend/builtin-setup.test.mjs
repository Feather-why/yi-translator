import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const build = path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled');
const { createBuiltinSetupOpener } = require(path.join(build, 'backend/builtin-setup.js'));
const base = 'chrome-extension://fixture/options.html';
const url = base + '#providers/browser-translator';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(initial = []) {
  const state = { tabs: structuredClone(initial), calls: { query: [], create: [], update: [], focus: [] } };
  const api = {
    runtime: { getURL(file) { assert.equal(file, 'options.html'); return base; } },
    tabs: {
      async query(query) { state.calls.query.push(query); return structuredClone(state.tabs); },
      async create(properties) { state.calls.create.push(properties); const tab = { id: 100, windowId: 5, url: properties.url }; state.tabs.push(tab); return tab; },
      async update(id, properties) { state.calls.update.push([id, properties]); const tab = state.tabs.find(item => item.id === id); if (!tab) throw new Error('tab closed'); return structuredClone(tab); },
    },
    windows: { async update(id, properties) { state.calls.focus.push([id, properties]); } },
  };
  return { state, api, open: createBuiltinSetupOpener(api) };
}

test('内置准备：打开真实服务卡片，不经过旧准备页', async () => {
  const { open, state } = fixture(); await open();
  assert.deepEqual(state.calls.query, [{ url: base + '*' }]);
  assert.deepEqual(state.calls.create, [{ url, active: true }]);
  assert.deepEqual(state.calls.update, []); assert.deepEqual(state.calls.focus, []);
});

test('内置准备：精确地址复用且只激活与聚焦，不重新导航', async () => {
  const tabs = [{ id: 0, url, windowId: 9 }];
  const { open, state } = fixture(tabs); await open();
  assert.deepEqual(state.calls.update, [[0, { active: true }]]);
  assert.deepEqual(state.calls.focus, [[9, { focused: true }]]);
  assert.deepEqual(state.calls.create, []); assert.deepEqual(state.tabs, tabs);
});

test('内置准备：其他服务、其他设置页和其他扩展不复用也不修改', async () => {
  const tabs = [
    { id: 1, windowId: 2, url: base + '#providers/deepl' },
    { id: 2, windowId: 2, url: base + '#welcome' },
    { id: 3, windowId: 2, url: base + '?setup=1#providers/browser-translator' },
    { id: 4, windowId: 2, url: 'chrome-extension://other/options.html#providers/browser-translator' },
    { id: -1, windowId: 2, url },
    { windowId: 2, url },
  ];
  const { open, state } = fixture(tabs); await open();
  assert.deepEqual(state.calls.update, []); assert.deepEqual(state.calls.focus, []);
  assert.deepEqual(state.calls.create, [{ url, active: true }]);
  assert.deepEqual(state.tabs.slice(0, tabs.length), tabs);
});

test('内置准备：并发调用合并一次打开，完成后的调用复用已经打开的卡片', async () => {
  const { open, api, state } = fixture(), gate = deferred(), query = api.tabs.query;
  api.tabs.query = async args => { await gate.promise; return query(args); };
  const first = open(), second = open(), third = open();
  assert.equal(first, second); assert.equal(first, third);
  gate.resolve(); await Promise.all([first, second, third]);
  assert.equal(state.calls.query.length, 1); assert.equal(state.calls.create.length, 1);
  await open(); assert.equal(state.calls.create.length, 1);
  assert.deepEqual(state.calls.update, [[100, { active: true }]]);
});

test('内置准备：查询后标签被关闭，确认消失后只新建一次', async () => {
  const { open, api, state } = fixture([{ id: 7, windowId: 2, url }]);
  api.tabs.update = async (id, properties) => { state.calls.update.push([id, properties]); state.tabs = []; throw new Error('tab closed'); };
  await open();
  assert.equal(state.calls.query.length, 2); assert.equal(state.calls.create.length, 1);
  assert.deepEqual(state.calls.focus, []);
});

test('内置准备：目标被关闭但已有另一张同址卡片，优先复用其余卡片', async () => {
  const { open, api, state } = fixture([{ id: 7, windowId: 2, url }, { id: 8, windowId: 3, url }]);
  const update = api.tabs.update;
  api.tabs.update = async (id, properties) => {
    if (id === 7) { state.calls.update.push([id, properties]); state.tabs.shift(); throw new Error('tab closed'); }
    return update(id, properties);
  };
  await open(); assert.deepEqual(state.calls.update, [[7, { active: true }], [8, { active: true }]]);
  assert.deepEqual(state.calls.focus, [[3, { focused: true }]]); assert.deepEqual(state.calls.create, []);
});

test('内置准备：标签仍在但激活失败时不制造副本，下一次可重试', async () => {
  const { open, api, state } = fixture([{ id: 7, windowId: 2, url }]), update = api.tabs.update;
  api.tabs.update = async () => { throw new Error('activation failed'); };
  await assert.rejects(open(), /activation failed/); assert.deepEqual(state.calls.create, []);
  api.tabs.update = update; await open(); assert.deepEqual(state.calls.focus, [[2, { focused: true }]]);
});

test('内置准备：聚焦失败不重新导航或新开页，后续点击仍可重试', async () => {
  const { open, api, state } = fixture([{ id: 7, windowId: 2, url }]), focus = api.windows.update;
  api.windows.update = async () => { throw new Error('focus failed'); };
  await assert.rejects(open(), /focus failed/); assert.deepEqual(state.calls.create, []);
  api.windows.update = focus; await open();
  assert.deepEqual(state.calls.update, [[7, { active: true }], [7, { active: true }]]);
  assert.deepEqual(state.calls.focus, [[2, { focused: true }]]);
});

test('内置准备：查询失败不盲目新开页，失败后可重新查询', async () => {
  const { open, api, state } = fixture(), query = api.tabs.query;
  api.tabs.query = async () => { throw new Error('query failed'); };
  await assert.rejects(open(), /query failed/); assert.deepEqual(state.calls.create, []);
  api.tabs.query = query; await open(); assert.equal(state.calls.create.length, 1);
});

test('内置准备：创建失败由并发调用共同收到，下次调用不沿用已拒绝Promise', async () => {
  const { open, api, state } = fixture(), create = api.tabs.create;
  api.tabs.create = async () => { throw new Error('create failed'); };
  const first = open(), second = open(); assert.equal(first, second);
  await assert.rejects(first, /create failed/);
  api.tabs.create = create; const retry = open(); assert.notEqual(retry, first);
  await retry; assert.equal(state.calls.create.length, 1);
});

test('内置准备：默认浏览器接口延迟到显式打开时读取', async t => {
  const previous = globalThis.chrome; delete globalThis.chrome;
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
  const open = createBuiltinSetupOpener(), { api, state } = fixture(); globalThis.chrome = api;
  await open(); assert.deepEqual(state.calls.create, [{ url, active: true }]);
});

test('049 内置准备：新开卡片带真实检测语言对；已有卡片即使方向不同仍不导航打断下载',async()=>{
 const {open,state}=fixture();await open('ja','en');
 assert.equal(state.calls.create[0].url,base+'?sourceLang=ja&targetLang=en#providers/browser-translator');
 await open('fr','zh-CN');assert.equal(state.calls.create.length,1);assert.deepEqual(state.calls.update,[[100,{active:true}]]);
});
