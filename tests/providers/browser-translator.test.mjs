import test from 'node:test';
import assert from 'node:assert/strict';
import { provider, request, context } from './helpers.mjs';
const builtin = provider('browser-translator');
const state = (status = 'available') => ({ status, sourceLanguage: 'en', targetLanguage: 'zh', supportsAuto: true, detectorStatus: 'available' });

test('浏览器内置服务为官方无额度高速档，不需要密钥或远程请求', async () => {
  assert.equal(builtin.kind, 'builtin'); assert.equal(builtin.official, true); assert.deepEqual(builtin.usedFor, ['fast', 'combined']);
  assert.equal(builtin.freeQuota, undefined); assert.deepEqual(builtin.auth, []); assert.equal(builtin.limits.maxSegments, 1);
  const ctx = context(() => { throw Error('不得网络请求'); });
  ctx.builtin = { availability: async () => state(), translate: async (input, signal) => { assert.equal(input.texts[0], 'Hello.'); assert.equal(signal, ctx.signal); return ['你好。']; } };
  assert.deepEqual(await builtin.translate(request(['Hello.']), ctx), ['你好。']); assert.equal(ctx.calls.length, 0);
});

test('内置 Window 传输未接入或真实结果不完整时明确不可用，不伪造译文', async () => {
  await assert.rejects(builtin.translate(request(), context(() => {})), (error) => error.info.code === 'no_provider');
  const ctx = context(() => {}); ctx.builtin = { availability: async () => state(), translate: async () => [] };
  await assert.rejects(builtin.translate(request(['Hello.']), ctx), (error) => error.info.code === 'no_provider');
});

test('内置健康检查仅用真实已准备状态，需下载时不报告健康', async () => {
  const ctx = context(() => {}); ctx.builtin = { availability: async (from, to) => { assert.equal(from, 'en'); assert.equal(to, 'zh-CN'); return state(); }, translate: async () => [] };
  const result = await builtin.health(ctx); assert.equal(result.ok, true); assert.equal(typeof result.latencyMs, 'number'); assert.equal(result.node, undefined);
  ctx.builtin.availability = async () => ({ ...state('downloadable'), reason: '需要用户在准备页点击下载' });
  await assert.rejects(builtin.health(ctx), (error) => error.info.code === 'no_provider' && /点击下载/.test(error.message));
});

test('内置取消在派发前生效，错误分类不会把模型未就绪当云额度', async () => {
  const controller = new AbortController(); controller.abort(); const ctx = context(() => {}); ctx.signal = controller.signal;
  let called = false; ctx.builtin = { translate: async () => { called = true; return ['x']; }, availability: async () => state() };
  await assert.rejects(builtin.translate(request(), ctx), { name: 'AbortError' }); assert.equal(called, false);
  assert.equal(builtin.classifyError(new Error('native API missing')).code, 'no_provider');
});
