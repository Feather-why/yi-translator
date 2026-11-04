/**
 * Node.js 22+ 内置 HTTP 翻译网关；不记录原文、访问令牌或完整请求体。
 * 上游协议：https://github.com/ggml-org/llama.cpp/blob/b12069/tools/server/README.md
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { restoreMissingAtoms } from './placeholder-atoms.mjs';

export const GATEWAY_VERSION = '0.2.3';
const allowedCodes = new Set(['rate_limit', 'quota', 'auth', 'server', 'network', 'bad_input', 'placeholder', 'cancelled', 'no_provider', 'internal']);
const error = (code, message, status = 500) => Object.assign(new Error(message), { code, status });
const abortError = () => new DOMException('请求已取消', 'AbortError');
const asError = (value) => ({ code: allowedCodes.has(value?.code) ? value.code : value?.name === 'AbortError' ? 'cancelled' : 'network', message: allowedCodes.has(value?.code) ? value.message : '节点上游请求失败', retryable: !['auth', 'bad_input', 'placeholder', 'quota'].includes(value?.code) });

function validUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label}地址无效`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${label}只接受无凭据的 HTTP(S) 地址`);
  return url.href.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function placeholderSignature(text) {
  const stack = [];
  const values = [];
  const tokens = text.match(/<\/?g\d+>|<x\d+\/>/g) || [];
  for (const token of tokens) {
    if (token.startsWith('</')) { if (stack.pop() !== token.slice(2, -1)) return null; }
    else {
      const name = token.startsWith('<x') ? token.slice(1, -2) : token.slice(1, -1);
      values.push(`${name}:${stack.join('/')}`);
      if (token.startsWith('<g')) stack.push(name);
    }
  }
  return stack.length ? null : values.sort().join('|');
}

export function placeholdersMatch(source, target) {
  return typeof target === 'string' && !!target.trim() && placeholderSignature(source) !== null && placeholderSignature(source) === placeholderSignature(target);
}

class Pool {
  active = 0;
  waiting = [];
  constructor(limit) { this.limit = limit; }
  run(signal, fn) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const item = { signal, fn, resolve, reject, started: false, abort: () => {
        if (item.started) return;
        const index = this.waiting.indexOf(item);
        if (index >= 0) this.waiting.splice(index, 1);
        signal.removeEventListener('abort', item.abort);
        reject(abortError());
      } };
      signal.addEventListener('abort', item.abort, { once: true });
      this.waiting.push(item); this.drain();
    });
  }
  drain() {
    while (this.active < this.limit && this.waiting.length) {
      const item = this.waiting.shift();
      item.signal.removeEventListener('abort', item.abort);
      if (item.signal.aborted) { item.reject(abortError()); continue; }
      item.started = true; this.active++;
      Promise.resolve().then(() => item.fn(item.signal)).then(item.resolve, item.reject).finally(() => { this.active--; this.drain(); });
    }
  }
}

async function bodyJson(req, maximum) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw error('bad_input', '请求必须为 JSON', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > maximum) throw error('bad_input', '请求内容过大', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error('bad_input', 'JSON 格式无效', 400); }
}

function languages(body) {
  if (typeof body?.sourceLang !== 'string' || (body.sourceLang !== 'auto' && !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(body.sourceLang))
    || typeof body.targetLang !== 'string' || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(body.targetLang)) throw error('bad_input', '源语言或目标语言无效', 400);
}

/** createGateway 不启动监听，便于集成测试与嵌入式部署。 */
export function createGateway(options = {}) {
  if (typeof options.token !== 'string' || options.token.length < 16) throw new Error('GATEWAY_TOKEN 至少需要 16 个字符');
  const origins = new Set(options.allowedOrigins || []);
  for (const origin of origins) {
    if (typeof origin !== 'string' || origin === '*' || !/^(?:chrome-extension:\/\/[a-p]{32}|https?:\/\/[^/]+)$/.test(origin)) throw new Error('CORS 只能配置明确的扩展或 HTTP(S) 来源');
  }
  const modelConfig = options.models || [{ id: 'local', url: 'http://127.0.0.1:8081' }];
  if (!Array.isArray(modelConfig) || !modelConfig.length) throw new Error('至少配置一个 llama-server 模型');
  const seen = new Set();
  const models = modelConfig.map((model) => {
    if (!model || typeof model.id !== 'string' || !/^[\w.-]{1,80}$/.test(model.id) || seen.has(model.id)) throw new Error('模型 id 无效或重复');
    seen.add(model.id);
    const limit = model.concurrency ?? options.concurrency ?? 2;
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error('并发数必须在 1–64 之间');
    return { ...model, url: validUrl(model.url, '模型'), pool: new Pool(limit), loaded: false, samples: [], completed: 0, failed: 0, tokens: 0, predictionMs: 0 };
  });
  const fetcher = options.fetch || fetch;
  const maximum = options.maxBodyBytes ?? 1024 * 1024;
  const timeout = options.timeoutMs ?? 60_000;
  const metrics = { requests: 0, completedSegments: 0, failedSegments: 0, cancelledSegments: 0 };
  const token = Buffer.from(options.token);

  const snapshot = () => ({ version: GATEWAY_VERSION, queue: models.reduce((sum, model) => sum + model.pool.waiting.length, 0), active: models.reduce((sum, model) => sum + model.pool.active, 0), ...metrics,
    models: models.map((model) => ({ id: model.id, loaded: model.loaded, active: model.pool.active, queue: model.pool.waiting.length, completed: model.completed, failed: model.failed,
      ...(model.samples.length ? { latencyMsP50: [...model.samples].sort((a, b) => a - b)[Math.floor(model.samples.length / 2)] } : {}),
      ...(model.predictionMs ? { tokensPerSec: model.tokens * 1000 / model.predictionMs } : {}) })) });

  async function upstream(model, path, init, signal) {
    const headers = new Headers(init?.headers);
    if (model.apiKey) headers.set('Authorization', `Bearer ${model.apiKey}`);
    try { return await fetcher(`${model.url}${path}`, { ...init, headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) }); }
    catch (caught) { if (signal.aborted) throw abortError(); throw error('network', '无法连接模型服务', 502); }
  }

  async function infer(model, source, request, strict, signal) {
    let target;
    try { target = new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(request.targetLang) || request.targetLang; } catch { target = request.targetLang; }
    let sourceHint = '';
    if (request.sourceLang !== 'auto') {
      let language;
      try { language = new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(request.sourceLang) || request.sourceLang; } catch { language = request.sourceLang; }
      sourceHint = `原文语言：${language}。\n`;
    }
    const context = request.context && typeof request.context === 'object'
      ? [request.context.title, request.context.summary].filter((value) => typeof value === 'string').join('\n').slice(0, 600) : '';
    const tags = /<\/?[gx]\d/.test(source) ? (strict ? '严格保留原文全部 XML 标记的编号、数量和嵌套，禁止增加或删除标记。\n' : '原样保留原文所有 XML 标记及其嵌套。\n') : '';
    const prompt = `${context ? `背景信息：${context}\n` : ''}${tags}${sourceHint}将以下文本翻译为${target}，注意只需要输出翻译后的结果，不要额外解释：\n${source}`;
    const response = await upstream(model, '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(model.model ? { model: model.model } : {}), messages: [{ role: 'user', content: prompt }], temperature: 0.7, top_p: 0.6, top_k: 20, min_p: 0, repeat_penalty: 1.05, max_tokens: 2048, stream: false, cache_prompt: true }) }, signal);
    if (!response.ok) throw error(response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'server' : 'bad_input', `模型接口返回 HTTP ${response.status}`, response.status >= 500 ? 502 : response.status);
    let value;
    try { value = await response.json(); } catch { throw error('server', '模型接口返回格式异常', 502); }
    const choice = value?.choices?.[0];
    if (choice?.finish_reason === 'length') throw error('bad_input', '模型译文被截断', 422);
    const text = choice?.message?.content;
    if (typeof text !== 'string' || !text.trim() && restoreMissingAtoms(source, text) === undefined) throw error('server', '模型没有返回有效译文', 502);
    if (Number.isFinite(value?.timings?.predicted_n) && Number.isFinite(value?.timings?.predicted_ms) && value.timings.predicted_ms > 0) { model.tokens += value.timings.predicted_n; model.predictionMs += value.timings.predicted_ms; }
    return text.trim();
  }

  async function translated(model, source, request, signal) {
    const started = performance.now();
    try {
      // 扩展Core已负责失标重试；明确交给调用方时只推理一次，旧直接客户端仍保留原重试。
      const attempts = request.placeholderRetry === 'caller' ? 1 : 2;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const text = await infer(model, source, request, attempt > 0 || request.strictPlaceholders === true, signal);
        if (signal.aborted) throw abortError();
        // 网关不能先丢弃缺x的整句，再让Core拿不到原结果；与本机共用经双端合约约束的恢复算法。
        const accepted = placeholdersMatch(source, text) ? text : restoreMissingAtoms(source, text);
        if (accepted !== undefined && placeholdersMatch(source, accepted)) { model.loaded = true; model.completed++; model.samples = [...model.samples, performance.now() - started].slice(-200); metrics.completedSegments++; return accepted; }
      }
      throw error('placeholder', '模型译文的占位符与原文不符', 422);
    } catch (caught) {
      if (signal.aborted) metrics.cancelledSegments++;
      else { model.failed++; metrics.failedSegments++; }
      throw caught;
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const origin = req.headers.origin;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (origin && !origins.has(origin)) throw error('auth', '来源未获允许', 403);
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.writeHead(204).end(); return;
      }
      const received = Buffer.from(typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '');
      if (received.length !== token.length || !timingSafeEqual(received, token)) throw error('auth', '节点令牌无效', 401);
      const path = (req.url || '/').split('?')[0];
      const controller = new AbortController();
      const abort = () => controller.abort();
      const closed = () => { if (!res.writableEnded) abort(); };
      req.once('aborted', abort); res.once('close', closed);
      try {
        if (req.method === 'GET' && path === '/v1/health') {
          const reachable = await Promise.all(models.map(async (model) => {
            try {
              const health = await upstream(model, '/health', {}, controller.signal);
              const value = await health.json();
              model.loaded = health.ok && value?.status === 'ok';
              if (model.loaded) {
                const props = await upstream(model, '/props', {}, controller.signal);
                if (props.ok) model.loaded = (await props.json())?.is_sleeping !== true;
              }
              // 休眠只表示权重未驻留；正常的health仍说明节点能接受并自动唤醒后续任务。
              return health.ok && value?.status === 'ok';
            } catch { model.loaded = false; return false; }
          }));
          const status = snapshot();
          const seconds = models.reduce((sum, model) => sum + model.predictionMs, 0);
          const tokens = models.reduce((sum, model) => sum + model.tokens, 0);
          json(res, 200, { ok: reachable.some(Boolean), version: GATEWAY_VERSION, models: status.models.map(({ id, loaded }) => ({ id, loaded })), queue: status.queue, ...(seconds ? { tokensPerSec: tokens * 1000 / seconds } : {}) }); return;
        }
        if (req.method === 'GET' && path === '/v1/metrics') { json(res, 200, snapshot()); return; }
        if (req.method === 'POST' && path === '/v1/translate') {
          const body = await bodyJson(req, maximum);
          languages(body);
          if (body.placeholderRetry !== undefined && !['caller', 'gateway'].includes(body.placeholderRetry)) throw error('bad_input', '占位符重试责任无效', 400);
          if (!Array.isArray(body.segments) || !body.segments.length || body.segments.length > 64) throw error('bad_input', '片段列表必须有 1–64 项', 400);
          const ids = new Set();
          let chars = 0;
          for (const segment of body.segments) {
            if (!segment || typeof segment.id !== 'string' || !segment.id || segment.id.length > 128 || ids.has(segment.id) || typeof segment.text !== 'string' || !segment.text.trim() || segment.text.length > 12_000 || placeholderSignature(segment.text) === null) throw error('bad_input', '片段 id、文本或标签无效', 400);
            ids.add(segment.id); chars += segment.text.length;
          }
          if (chars > 64_000) throw error('bad_input', '批次字符过多', 413);
          const model = body.model ? models.find((candidate) => candidate.id === body.model) : models.find((candidate) => candidate.id === options.modeModels?.[body.mode]) || models[0];
          if (!model) throw error('bad_input', '未知模型', 400);
          metrics.requests++;
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
          const write = (value) => { if (!controller.signal.aborted && !res.destroyed) res.write(JSON.stringify(value) + '\n'); };
          await Promise.all(body.segments.map(async (segment) => {
            try { const text = await model.pool.run(controller.signal, (signal) => translated(model, segment.text, body, signal)); write({ id: segment.id, text }); }
            catch (caught) { write({ id: segment.id, error: asError(caught) }); }
          }));
          write({ done: true, model: model.id });
          if (!res.destroyed) res.end(); return;
        }
        if (req.method === 'POST' && ['/v1/align', '/v1/pdf', '/v1/ocr'].includes(path)) {
          const name = path.slice(4);
          const body = await bodyJson(req, maximum);
          const handler = options.handlers?.[name];
          const configuredUrl = options[`${name}Url`];
          if (typeof handler === 'function') { json(res, 200, await handler(body, { signal: controller.signal })); return; }
          if (!configuredUrl) throw error('no_provider', `节点尚未配置 ${name} 模块`, 501);
          const url = new URL(configuredUrl);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw error('bad_input', '模块上游地址无效', 500);
          const upstream = await fetcher(url.href, { method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]), headers: { 'Content-Type': 'application/json', ...(options.moduleToken ? { Authorization: `Bearer ${options.moduleToken}` } : {}) }, body: JSON.stringify(body) });
          if (!upstream.ok) throw error('server', '节点模块上游请求失败', 502);
          json(res, 200, await upstream.json()); return;
        }
        throw error('bad_input', '接口不存在', 404);
      } finally { req.removeListener('aborted', abort); res.removeListener('close', closed); }
    })().catch((caught) => {
      if (res.destroyed) return;
      if (res.headersSent) { res.end(); return; }
      json(res, caught.status || 500, { error: asError(caught) });
    });
  });
  server.gateway = { snapshot };
  return server;
}

function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = process.env.GATEWAY_CONFIG ? JSON.parse(await readFile(process.env.GATEWAY_CONFIG, 'utf8')) : {};
    const options = { ...config, token: process.env.GATEWAY_TOKEN || config.token,
      allowedOrigins: process.env.GATEWAY_ORIGINS ? process.env.GATEWAY_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean) : config.allowedOrigins,
      models: config.models || [{ id: process.env.GATEWAY_MODEL_ID || 'local', url: process.env.LLAMA_URL || 'http://127.0.0.1:8081', apiKey: process.env.LLAMA_API_KEY }] };
    const host = process.env.GATEWAY_HOST || config.host || '127.0.0.1';
    const port = Number(process.env.GATEWAY_PORT || config.port || 8090);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间');
    const server = createGateway(options);
    server.listen(port, host, () => console.log(`翻译节点 ${GATEWAY_VERSION} 已监听 http://${host}:${port}`));
    const shutdown = () => { server.close(); server.closeAllConnections(); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } catch (caught) { console.error(caught.message); process.exitCode = 1; }
}
