/** 可选真实本机烟测：不属于默认 CI，不需要或发送任何云端 API key。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createGateway } from '../../gateway/server.mjs';
const require = createRequire(import.meta.url);
const adapter = require('../.compiled/backend/providers/remote-node.js').default;
const token = randomBytes(32).toString('hex');
const upstream = process.env.GATEWAY_SMOKE_LLAMA_URL || 'http://127.0.0.1:8081';
const server = createGateway({ token, models: [{ id: 'local-real', url: upstream }], allowedOrigins: [] });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
try {
  const ctx = { config: { url, token, model: 'local-real' }, signal: new AbortController().signal, log() {}, fetch: async (input, init = {}) => {
    const { timeoutMs = 60_000, ...options } = init;
    return fetch(input, { ...options, credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
  } };
  const health = await adapter.health(ctx);
  assert.equal(health.ok, true);
  const start = performance.now();
  const texts = ['The library opens every morning.', 'Read the <g0>short <g1>guide</g1></g0> and keep <x0/> unchanged.'];
  const translated = await adapter.translate({ texts, sourceLang: 'en', targetLang: 'zh-CN' }, ctx);
  assert.equal(translated.length, texts.length);
  assert.ok(translated.every((text) => /\p{Script=Han}/u.test(text)));
  assert.match(translated[1], /<g0>.*<g1>.*<\/g1>.*<\/g0>/s);
  assert.match(translated[1], /<x0\/>/);
  assert.ok(!translated.some((text) => /保留原文中的全部|严格保留原文全部 XML|将以下文本翻译为/.test(text)));
  console.log(JSON.stringify({ gateway: 'real-local-llama', model: 'local-real', elapsedMs: Math.round(performance.now() - start), translated, metrics: server.gateway.snapshot() }, null, 2));
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
