/**
 * 官方服务接口：https://github.com/ggml-org/llama.cpp/blob/b12069/tools/server/README.md
 * 官方模型卡：https://huggingface.co/tencent/Hy-MT2-1.8B
 * 核实：2026-11-04。本地推理不限 API 字符额度；不虚构显存、token/s 等未返回的指标。
 */
import { defineProvider, classifyError, ProviderError, responseJson, type ProviderContext, type ProviderTiming } from './types';
import { hasPlaceholders } from '../../shared/placeholders';

function baseUrl(ctx: ProviderContext): string {
  const parsed = new URL(ctx.config.url || 'http://127.0.0.1:8081');
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ProviderError({ code: 'bad_input', message: '本地模型地址格式不正确', retryable: false });
  }
  return parsed.href.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function boundedTitle(title: string | undefined): string | undefined {
  if (title === undefined || title.length <= 256) return title;
  // 每槽上下文有限，网页标题不应挤掉正文；截断点不能落在 Unicode 代理对中间。
  const end = /[\uD800-\uDBFF]/.test(title[255]!) && /[\uDC00-\uDFFF]/.test(title[256]!) ? 255 : 256;
  return title.slice(0, end);
}

function reportTiming(value: unknown, ctx: ProviderContext) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const values = value as Record<string, unknown>, timing: ProviderTiming = { phase: 'model' };
  for (const [source, target] of [['prompt_ms', 'promptMs'], ['predicted_ms', 'generationMs']] as const) {
    const entry = values[source]; if (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0) timing[target] = entry;
  }
  for (const [source, target] of [['prompt_n', 'promptTokens'], ['predicted_n', 'outputTokens']] as const) {
    const entry = values[source]; if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) timing[target] = entry;
  }
  if (Object.keys(timing).length > 1) try { ctx.recordTiming?.(timing); } catch { /* 诊断异常不能丢弃已生成的译文。 */ }
}

const streamError = (message: string) => new ProviderError({ code: 'server', message, retryable: true });
function errorEvent(value: unknown): ProviderError {
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const status = typeof item.code === 'number' ? item.code : typeof item.status === 'number' ? item.status : undefined;
  const name = String(item.code ?? item.type ?? '');
  const code = status === 401 || status === 403 || /^(?:invalid_api_key|authentication_error|auth)$/.test(name) ? 'auth'
    : status === 429 || /^(?:rate_limit_exceeded|rate_limit)$/.test(name) ? 'rate_limit'
      : status === 456 || /^(?:insufficient_quota|quota)$/.test(name) ? 'quota'
        : status !== undefined && status >= 400 && status < 500 || name === 'invalid_request_error' ? 'bad_input' : 'server';
  return new ProviderError({ code, message: '本地模型流式响应返回错误', retryable: code === 'rate_limit' || code === 'server' });
}

/** SSE 数据必须在生成时读取；正文、事件及总字节分别限额，断流前缀不能当完整译文。 */
async function streamedText(response: Response, ctx: ProviderContext, partial: (text: string) => void): Promise<string> {
  if (!response.ok) {
    try { await responseJson(response); } finally { void response.body?.cancel().catch(() => undefined); }
  }
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream' || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw streamError('本地模型没有返回有效的流式响应');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const MAX_TEXT = 64 * 1024, MAX_EVENT = 128 * 1024, MAX_BYTES = 4 * 1024 * 1024;
  let text = '', buffer = '', data: string[] = [], event = '', eventSize = 0, totalBytes = 0, done = false, finish: string | undefined, timings: unknown;
  const abort = () => { void reader.cancel(ctx.signal.reason).catch(() => undefined); };
  ctx.signal.addEventListener('abort', abort, { once: true });
  const dispatch = () => {
    ctx.signal.throwIfAborted();
    if (!data.length) { event = ''; eventSize = 0; return; }
    const payload = data.join('\n'), eventType = event; data = []; event = ''; eventSize = 0;
    if (payload.trim() === '[DONE]') { if (eventType === 'error') throw streamError('本地模型流式响应返回错误'); done = true; return; }
    let item: any;
    try { item = JSON.parse(payload); } catch { throw streamError('本地模型流式数据不是有效 JSON'); }
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw streamError('本地模型流式数据结构无效');
    if (item.timings !== undefined) timings = item.timings;
    if (eventType === 'error' || item.error !== undefined) throw errorEvent(item.error ?? item);
    if (!Array.isArray(item.choices)) {
      if (item.timings !== undefined || item.usage !== undefined) return;
      throw streamError('本地模型流式数据缺少 choices');
    }
    if (item.choices.some((choice: any) => !choice || typeof choice !== 'object' || Array.isArray(choice))) throw streamError('本地模型流式 choices 结构无效');
    const choices = item.choices.filter((choice: any) => choice.index === undefined || choice.index === 0);
    if (choices.length > 1) throw streamError('本地模型流式响应包含多个译文');
    const choice = choices[0]; if (!choice) return;
    const delta = choice.delta;
    if (delta !== undefined && (!delta || typeof delta !== 'object' || Array.isArray(delta))) throw streamError('本地模型流式增量结构无效');
    const content = delta?.content;
    if (content !== undefined && content !== null && typeof content !== 'string') throw streamError('本地模型流式正文格式无效');
    if (content) {
      if (finish !== undefined) throw streamError('本地模型结束后仍返回正文');
      if (text.length + content.length > MAX_TEXT) throw streamError('本地模型流式正文超过上限');
      text += content;
      try { partial(text); } catch { /* 显示回调异常不能破坏真实译文。 */ }
      ctx.signal.throwIfAborted();
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (choice.finish_reason === 'length') throw new ProviderError({ code: 'bad_input', message: '本地模型输出被截断，请缩短片段', retryable: false });
      if (choice.finish_reason !== 'stop') throw streamError('本地模型流式响应未正常完成');
      finish = 'stop';
    }
  };
  const line = (value: string) => {
    if (!value) { dispatch(); return; }
    if (value.startsWith(':')) return;
    const at = value.indexOf(':'), field = at < 0 ? value : value.slice(0, at);
    let entry = at < 0 ? '' : value.slice(at + 1); if (entry.startsWith(' ')) entry = entry.slice(1);
    if (field === 'event') event = entry;
    if (field === 'data') { eventSize += entry.length + 1; if (eventSize > MAX_EVENT) throw streamError('本地模型流式事件超过上限'); data.push(entry); }
  };
  const drain = (eof = false) => {
    while (!done) {
      const boundary = buffer.search(/[\r\n]/); if (boundary < 0) break;
      if (!eof && buffer[boundary] === '\r' && boundary + 1 === buffer.length) break;
      const width = buffer[boundary] === '\r' && buffer[boundary + 1] === '\n' ? 2 : 1;
      const value = buffer.slice(0, boundary); buffer = buffer.slice(boundary + width); line(value);
    }
  };
  try {
    ctx.signal.throwIfAborted();
    while (!done) {
      const next = await reader.read(); ctx.signal.throwIfAborted();
      if (next.done) {
        // 残留字节也要检验，但没有完整事件边界或 DONE 的 EOF 不能作为完成。
        try { buffer += decoder.decode(); } catch { throw streamError('本地模型流式响应含有无效 UTF-8'); }
        drain(true);
        break;
      }
      totalBytes += next.value.byteLength; if (totalBytes > MAX_BYTES) throw streamError('本地模型流式响应超过总大小上限');
      try { buffer += decoder.decode(next.value, { stream: true }); } catch { throw streamError('本地模型流式响应含有无效 UTF-8'); }
      drain();
      if (buffer.length > MAX_EVENT) throw streamError('本地模型流式事件超过上限');
    }
    ctx.signal.throwIfAborted();
    if (!done || finish !== 'stop') throw streamError('本地模型流式响应提前结束');
    if (!text.trim()) throw streamError('本地模型没有返回有效译文');
    return text.trim();
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    // 即使服务已发送 DONE，也取消剩余传输并释放锁，避免闲置连接继续占用资源。
    void reader.cancel().catch(() => undefined); reader.releaseLock();
    reportTiming(timings, ctx);
  }
}

async function complete(prompt: string, ctx: ProviderContext, partial?: (text: string) => void): Promise<string> {
  ctx.signal.throwIfAborted();
  const stream = typeof partial === 'function';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (stream) headers.Accept = 'text/event-stream';
  if (ctx.config.key) headers.Authorization = `Bearer ${ctx.config.key}`;
  const temperature = ctx.config.temperature?.trim() ? Number(ctx.config.temperature) : 0.7;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new ProviderError({ code: 'bad_input', message: '采样温度必须在 0 到 2 之间', retryable: false });
  const response = await ctx.fetch(`${baseUrl(ctx)}/v1/chat/completions`, {
    method: 'POST', headers, timeoutMs: 60_000,
    ...(stream ? { streamResponse: true, signal: ctx.signal } : {}),
    body: JSON.stringify({ ...(ctx.config.model ? { model: ctx.config.model } : {}), messages: [{ role: 'user', content: prompt }],
      temperature, top_p: 0.6, top_k: 20, min_p: 0, repeat_penalty: 1.05, max_tokens: 1024, stream, cache_prompt: true }),
  });
  if (stream) return streamedText(response, ctx, partial!);
  const json = await responseJson(response);
  const choice = json?.choices?.[0];
  reportTiming(json?.timings, ctx);
  if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) throw new ProviderError({ code: 'server', message: '本地模型没有返回有效译文', retryable: true });
  if (choice.finish_reason === 'length') throw new ProviderError({ code: 'bad_input', message: '本地模型输出被截断，请缩短片段', retryable: false });
  return choice.message.content.trim();
}

export default defineProvider({
  id: 'llamacpp', name: '本地 Hy-MT2（llama.cpp）', version: '1.0.9', kind: 'local', official: true,
  // B1 暂无远程精确档时允许本地 1.8B 带上下文承担精确模式。
  usedFor: ['fast', 'accurate', 'combined'], defaults: { url: 'http://127.0.0.1:8081' },
  auth: [{ key: 'url', label: 'llama-server 地址', type: 'url', required: true, placeholder: 'http://127.0.0.1:8081' },
    { key: 'key', label: 'API key（服务器启用时填写）', secret: true }, { key: 'model', label: '模型别名（可选）' }],
  limits: { maxChars: 1200, maxSegments: 1, concurrency: 6 }, placeholders: 'prompt',
  async translate(req, ctx) {
    const target = new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(req.targetLang) || req.targetLang;
    // 用户纠正短句的源语言时必须传给模型；提示放在模板前，避免被当作待译正文。
    const source = req.sourceLang === 'auto' ? '' : `原文语言：${new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(req.sourceLang) || req.sourceLang}。\n`;
    const title = ctx.config.prompt ? req.context?.title : boundedTitle(req.context?.title);
    const extra = title || req.context?.summary ? `背景信息：${[title, req.context?.summary?.slice(0, 300)].filter(Boolean).join('\n')}\n` : '';
    const results: string[] = [];
    for (const [index, text] of req.texts.entries()) {
      // Hy-MT 会把翻译模板冒号之后的内容全部当作原文，标签要求必须放在模板前。
      const tags = !hasPlaceholders(text) ? '' : (req.strictPlaceholders ? '严格保留' : '保留')
        + '原文中的全部 XML 标记及其编号、数量和嵌套。绝不遗漏、重复、转义或翻译标记。\n'
        + '先理解完整句意，再用自然通顺的译文表达；XML 标记不是句子边界，不要按标记拆成碎片翻译。每对标记放在对应译词两侧，可以随译文语序整体移动。\n';
      if (req.terminology && (!Array.isArray(req.terminology) || req.terminology.length > 12 || req.terminology.some((term) => !term || typeof term.source !== 'string' || typeof term.target !== 'string'
        || !term.source.trim() || !term.target.trim() || term.source.length > 200 || term.target.length > 300))) throw new ProviderError({ code: 'bad_input', message: '本地翻译术语格式无效', retryable: false });
      // 术语只是整句译文的参考，不将孤立词组译文按源文顺序拼回正文。
      const terminology = req.terminology?.length ? '参考下面的翻译：\n' + req.terminology.map((term) => `${term.source} 翻译成 ${term.target}`).join('\n') + '\n' : '';
      const variables: Record<string, string> = { from: req.sourceLang, to: req.targetLang, text, context: req.context ? JSON.stringify(req.context) : '' };
      const custom = ctx.config.prompt ? `附加翻译要求：${ctx.config.prompt.replace(/\{\{(from|to|text|context)\}\}/g, (_match, key: string) => variables[key]!)}\n` : '';
      // 仅显式高速纯文本使用小样本验证过的短模板，背景和完整正文仍原样传入。
      const instruction = req.quality === 'fast' && !ctx.config.prompt && req.terminology === undefined && !hasPlaceholders(text)
        ? `译成${target}，只输出译文：\n` : `将以下文本翻译为${target}，注意只需要输出翻译后的结果，不要额外解释：\n`;
      results.push(await complete(`${extra}${tags}${terminology}${custom}${source}${instruction}${text}`, ctx,
        req.stream === true && ctx.onPartial ? (value) => ctx.onPartial!(value, index) : undefined));
    }
    return results;
  },
  async health(ctx) {
    const start = performance.now();
    const headers: Record<string, string> = {};
    if (ctx.config.key) headers.Authorization = `Bearer ${ctx.config.key}`;
    const json = await responseJson(await ctx.fetch(`${baseUrl(ctx)}/health`, { headers, timeoutMs: 5000 }));
    return { ok: json?.status === 'ok', latencyMs: performance.now() - start };
  },
  async explain(text, context, ctx) {
    return Array.from(await complete(`请用不超过120字的中文解释下列词句在上下文中的意思，只输出解释。\n上下文：${context?.slice(0, 1000) || '无'}\n词句：${text.slice(0, 1200)}`, ctx)).slice(0, 120).join('');
  }, classifyError,
});
