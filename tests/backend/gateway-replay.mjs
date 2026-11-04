import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createGateway } from '../../gateway/server.mjs';

export const fixtureToken = 'isolated-gateway-fixture-token';
export const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
/** 调用真正HTTP handler，但不listen、不发网络；上游始终由测试注入。 */
export function gatewayReplay(upstream, options = {}) {
  const gateway = createGateway({ token: fixtureToken, models: [{ id: 'fixture', url: 'http://upstream.invalid' }], ...options, fetch: upstream });
  const fetch = async (url, init = {}) => new Promise((resolve, reject) => {
    assert.equal(new URL(url).hostname, 'fixture.invalid');
    const req = new EventEmitter(), res = new EventEmitter(), chunks = [];
    req.url = new URL(url).pathname; req.method = init.method || 'GET'; req.headers = Object.fromEntries(new Headers(init.headers));
    req[Symbol.asyncIterator] = async function* () { if (init.body) yield Buffer.from(init.body); };
    res.headers = {}; res.destroyed = false; res.writableEnded = false; res.statusCode = 200;
    res.setHeader = (key, value) => { res.headers[key] = value; };
    res.writeHead = (status, headers = {}) => { res.statusCode = status; Object.assign(res.headers, headers); res.headersSent = true; return res; };
    res.write = (value) => { chunks.push(value); return true; };
    const cleanup = () => init.signal?.removeEventListener('abort', abort);
    const abort = () => { cleanup(); res.destroyed = true; req.emit('aborted'); res.emit('close'); reject(init.signal.reason ?? new DOMException('Cancelled', 'AbortError')); };
    res.end = (value) => { cleanup(); if (res.destroyed) return res; if (value) chunks.push(value); res.writableEnded = true;
      resolve(new Response(chunks.join(''), { status: res.statusCode, headers: res.headers })); return res; };
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) { abort(); return; }
    gateway.emit('request', req, res);
  });
  const request = (endpoint, body, init = {}) => fetch('http://fixture.invalid' + endpoint, { method: body === undefined ? 'GET' : 'POST', ...init,
    headers: { Authorization: `Bearer ${fixtureToken}`, 'Content-Type': 'application/json', ...init.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { gateway, fetch, request };
}
