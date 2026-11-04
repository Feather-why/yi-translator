import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { handleInstallation } = require('../.compiled/backend/installation.js');

function fixture() {
  const calls = { menus: 0, paths: [], opened: [] };
  return { calls, actions: {
    installMenus: async () => { calls.menus++; },
    getURL: (path) => { calls.paths.push(path); return 'chrome-extension://fixture/' + path; },
    open: async (url) => { calls.opened.push(url); },
  } };
}

test('首次安装注册一次菜单并打开本扩展welcome锚点', async () => {
  const { calls, actions } = fixture();
  await handleInstallation('install', actions);
  assert.equal(calls.menus, 1);
  assert.deepEqual(calls.paths, ['options.html#welcome']);
  assert.deepEqual(calls.opened, ['chrome-extension://fixture/options.html#welcome']);
});

test('扩展更新、浏览器更新和共享模块更新只更新菜单，不创建欢迎标签页', async () => {
  for (const reason of ['update', 'chrome_update', 'shared_module_update', 'unknown']) {
    const { calls, actions } = fixture();
    await handleInstallation(reason, actions);
    assert.deepEqual(calls, { menus: 1, paths: [], opened: [] }, reason);
  }
});

test('菜单同步抛错或异步拒绝都不阻断欢迎页，也不向安装事件泄漏拒绝', async () => {
  for (const installMenus of [() => { throw new Error('sync menu failure'); }, async () => { throw new Error('async menu failure'); }]) {
    const { calls, actions } = fixture();
    await assert.doesNotReject(handleInstallation('install', { ...actions, installMenus }));
    assert.deepEqual(calls.opened, ['chrome-extension://fixture/options.html#welcome']);
  }
});

test('菜单尚未完成时欢迎页已独立打开，不等菜单完成', async () => {
  const { calls, actions } = fixture();
  let finish;
  const operation = handleInstallation('install', { ...actions, installMenus: () => new Promise((resolve) => { finish = resolve; }) });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls.opened, ['chrome-extension://fixture/options.html#welcome']);
  finish(); await operation;
});

test('创建欢迎页或计算扩展地址失败时仍注册菜单并收拢错误', async () => {
  for (const failing of [
    { getURL: () => { throw new Error('runtime closing'); } },
    { open: async () => { throw new Error('window closing'); } },
  ]) {
    const { calls, actions } = fixture();
    await assert.doesNotReject(handleInstallation('install', { ...actions, ...failing }));
    assert.equal(calls.menus, 1);
  }
});
