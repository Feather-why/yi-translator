/**
 * 项目协议：docs/HANDOFF-BACKEND.md 第 7.2 节、docs/B2-REMOTE.md。
 * llama.cpp 上游：https://github.com/ggml-org/llama.cpp/blob/b12069/tools/server/README.md
 * 核实：2026-11-03。用户自建节点无平台免费字符额度，实际成本由用户的模型主机承担。
 */
import { defineProvider, classifyError, ProviderError, responseJson, type ProviderContext } from './types';
import type { ErrorCode } from '../../shared/protocol';

function base(ctx: ProviderContext): string {
  let url: URL;
  try { url = new URL(ctx.config.url || ''); } catch { throw new ProviderError({ code: 'bad_input', message: '远程节点地址无效', retryable: false }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ProviderError({ code: 'bad_input', message: '节点地址不能包含凭据或查询参数', retryable: false });
  return url.href.replace(/\/+$/, '').replace(/\/v1$/, '');
}

const fail = (message: string) => new ProviderError({ code: 'server', message, retryable: true });
const codes = new Set<ErrorCode>(['rate_limit', 'quota', 'auth', 'server', 'network', 'bad_input', 'placeholder', 'cancelled', 'no_provider', 'internal']);

export default defineProvider({
  id: 'remote-node', name: '远程翻译节点', version: '1.0.2', kind: 'remote', official: true, usedFor: ['accurate', 'combined'],
  auth: [{ key: 'url', label: '节点地址', type: 'url', required: true }, { key: 'token', label: '访问令牌', secret: true, required: true }, { key: 'model', label: '模型 id（可选）' }],
  // 前端逐片段交付，避免等待同批其他远程段落完成才显示第一段。
  limits: { maxChars: 6000, maxSegments: 1, concurrency: 2 }, placeholders: 'prompt', classifyError,
  async translate(req, ctx) {
    if (!ctx.config.token) throw new ProviderError({ code: 'auth', message: '请填写远程节点访问令牌', retryable: false });
    const response = await ctx.fetch(`${base(ctx)}/v1/translate`, { method: 'POST', timeoutMs: 60_000,
      headers: { Authorization: `Bearer ${ctx.config.token}`, 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      // Core统一重试，避免网关和扩展各重试一遍而重复生成四次相同整段。
      body: JSON.stringify({ sourceLang: req.sourceLang, targetLang: req.targetLang, context: req.context, model: ctx.config.model || undefined, strictPlaceholders: req.strictPlaceholders, placeholderRetry: 'caller', segments: req.texts.map((text, index) => ({ id: `s${index}`, text })) }),
    });
    if (!response.ok) await responseJson(response);
    if (!response.body) throw fail('远程节点没有返回响应流');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    let bytes = 0;
    let done = false;
    const found = new Map<string, string>();
    const expected = new Set(req.texts.map((_, index) => `s${index}`));
    const line = (text: string) => {
      if (!text.trim()) return;
      if (done) throw fail('远程节点结束标记后仍返回数据');
      let value: any;
      try { value = JSON.parse(text); } catch { throw fail('远程节点 NDJSON 格式异常'); }
      if (value?.done === true) { done = true; return; }
      if (typeof value?.id !== 'string' || !expected.has(value.id) || found.has(value.id)) throw fail('远程节点片段编号重复或未知');
      if (value.error) {
        const code = codes.has(value.error.code) ? value.error.code as ErrorCode : 'server';
        throw new ProviderError({ code, message: `远程节点片段翻译失败（${code}）`, retryable: ['rate_limit', 'server', 'network'].includes(code) });
      }
      if (typeof value.text !== 'string' || !value.text.trim()) throw fail('远程节点译文格式异常');
      found.set(value.id, value.text);
    };
    const abort = () => { void reader.cancel().catch(() => undefined); };
    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        ctx.signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4 * 1024 * 1024) throw fail('远程节点响应过大');
        pending += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) { const current = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1); if (current.length > 256 * 1024) throw fail('远程节点响应行过长'); line(current); }
        if (pending.length > 256 * 1024) throw fail('远程节点响应行过长');
      }
      pending += decoder.decode();
      if (pending) line(pending);
      ctx.signal.throwIfAborted();
      if (!done || found.size !== req.texts.length) throw fail('远程节点遗漏片段或结束标记');
      return req.texts.map((_, index) => found.get(`s${index}`)!);
    } finally { ctx.signal.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  },
  async health(ctx) {
    if (!ctx.config.token) throw new ProviderError({ code: 'auth', message: '请填写远程节点访问令牌', retryable: false });
    const started = performance.now();
    const value = await responseJson(await ctx.fetch(`${base(ctx)}/v1/health`, { timeoutMs: 5000, headers: { Authorization: `Bearer ${ctx.config.token}` } }));
    if (typeof value?.ok !== 'boolean' || !Array.isArray(value.models) || value.models.some((entry: any) => typeof entry?.id !== 'string' || typeof entry.loaded !== 'boolean'
      || (entry.vramMB !== undefined && (!Number.isFinite(entry.vramMB) || entry.vramMB < 0)))) throw fail('远程节点健康检查格式异常');
    const loaded = value.models.find((entry: any) => entry?.loaded === true && typeof entry.id === 'string');
    return { ok: value.ok, latencyMs: performance.now() - started, ...(loaded ? { model: loaded.id } : {}), node: {
      location: 'remote' as const, online: value.ok, models: value.models.map((entry: any) => ({ id: entry.id, loaded: entry.loaded, ...(entry.vramMB === undefined ? {} : { vramMB: entry.vramMB }) })),
      ...(Number.isInteger(value.queue) && value.queue >= 0 ? { queue: value.queue } : {}),
      ...(Number.isFinite(value.tokensPerSec) && value.tokensPerSec >= 0 ? { tokensPerSec: value.tokensPerSec } : {}),
    } };
  },
});
