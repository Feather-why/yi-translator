/**
 * 核实2026-11-03：固定b12069的GET/slots会等待退出sleep，仅查询slot，不创建生成任务。
 * https://github.com/ggml-org/llama.cpp/blob/b12069/tools/server/server-context.cpp#L5286-L5323
 * https://github.com/ggml-org/llama.cpp/blob/b12069/tools/server/README.md#sleeping-on-idle
 */
import { ProviderError } from './providers/types';
import type { ErrorInfo } from '../shared/protocol';

export interface WarmupProvider {
  id: string; kind: string; adapter: string; enabled: boolean; configured: boolean; paused?: boolean;
  endpoint: string; apiKey?: string;
}
export interface WarmupRequest { providerId?: string; reason: 'hover' | 'manual' }
export interface WarmupResult {
  status: 'ready' | 'warmed' | 'cooldown' | 'ineligible' | 'unsupported' | 'failed';
  provider?: string; elapsedMs?: number; retryAfterMs?: number; error?: ErrorInfo;
}
export interface ModelWarmupOptions {
  provider(id?: string): Promise<WarmupProvider | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}
interface Work { controller: AbortController; promise: Promise<WarmupResult>; consumers: Set<object> }
interface Target { started: number; pending?: Work }
const INTERVAL = 120_000;
const MAX_TARGETS = 32;
const MAX_PROPS_BYTES = 128 * 1024;
const abortError = () => new DOMException('预热已取消', 'AbortError');
class WarmupFailure extends ProviderError {}
const failure = (code: ErrorInfo['code'], message: string) => new WarmupFailure({ code, message, retryable: code === 'network' || code === 'server' });

/** 不允许配置把本机唤醒请求变成云服务请求、附带凭据的URL或跳转入口。 */
function localBase(provider: WarmupProvider | undefined): string | undefined {
  if (!provider || provider.kind !== 'local' || provider.adapter !== 'llamacpp' || provider.enabled !== true
    || provider.configured !== true || provider.paused === true || typeof provider.id !== 'string' || !provider.id || provider.id.length > 128
    || typeof provider.endpoint !== 'string' || provider.endpoint.length > 2048
    || (provider.apiKey !== undefined && (typeof provider.apiKey !== 'string' || provider.apiKey.length > 8192))) return undefined;
  try {
    const url = new URL(provider.endpoint);
    const host = url.hostname.toLowerCase();
    const loopback = host === 'localhost' || host === '[::1]' || /^127(?:\.(?:\d{1,3})){3}$/.test(host);
    if (!loopback || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return url.href.replace(/\/+$/, '').replace(/\/v1$/, '');
  } catch { return undefined; }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });
    void work.then((value) => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(abortError()); else resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** 只发送无正文的本机GET；调用方负责从已保存配置和Vault提供候选，不接受网页提交的地址。 */
export class ModelWarmup {
  private targets = new Map<string, Target>();
  private fetcher: typeof fetch;
  private now: () => number;
  private timeoutMs: number;
  private tokens = 2;
  private refillAt: number;
  private disposed = false;
  constructor(private options: ModelWarmupOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.refillAt = this.now();
    this.timeoutMs = Math.min(30_000, Math.max(1, Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 15_000));
  }

  async warmup(request: WarmupRequest, signal = new AbortController().signal): Promise<WarmupResult> {
    const requestedAt = performance.now();
    if (!request || !['hover', 'manual'].includes(request.reason) || (request.providerId !== undefined
      && (typeof request.providerId !== 'string' || !request.providerId.trim() || request.providerId.length > 128))) {
      throw failure('bad_input', '预热请求格式无效');
    }
    signal.throwIfAborted();
    if (this.disposed) return { status: 'ineligible' };
    const lookupController = new AbortController(), lookupTimer = setTimeout(() => lookupController.abort(), this.timeoutMs);
    const abortLookup = () => lookupController.abort(); signal.addEventListener('abort', abortLookup, { once: true });
    let provider: WarmupProvider | undefined;
    try { provider = await abortable(Promise.resolve().then(() => this.options.provider(request.providerId)), lookupController.signal); }
    catch { signal.throwIfAborted(); return { status: 'failed', error: { code: 'network', message: '读取本机预热配置失败或超时', retryable: true } }; }
    finally { clearTimeout(lookupTimer); signal.removeEventListener('abort', abortLookup); }
    signal.throwIfAborted();
    const base = localBase(provider);
    if (!base || !provider || this.disposed || (request.providerId !== undefined && request.providerId !== provider.id)) {
      return { status: 'ineligible', ...(typeof provider?.id === 'string' ? { provider: provider.id } : {}) };
    }
    // 只保留凭据摘要以区分配置变更；状态表不保存API key、响应体或网页内容。
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(provider.apiKey ?? ''));
    signal.throwIfAborted();
    if (this.disposed) return { status: 'ineligible', provider: provider.id };
    const remainingMs = this.timeoutMs - (performance.now() - requestedAt);
    if (remainingMs <= 0) return { status: 'failed', provider: provider.id, error: { code: 'network', message: '本机模型预热超时', retryable: true } };
    const key = base + ':' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    let target = this.targets.get(key);
    if (target?.pending) return { ...await this.join(target.pending, signal, remainingMs), provider: provider.id };
    const now = this.now();
    if (target && now - target.started < INTERVAL) return { status: 'cooldown', provider: provider.id, retryAfterMs: Math.max(0, INTERVAL - (now - target.started)) };
    const elapsed = Math.max(0, now - this.refillAt);
    this.tokens = Math.min(2, this.tokens + elapsed / INTERVAL); this.refillAt = Math.max(this.refillAt, now);
    if (this.tokens < 1) return { status: 'cooldown', provider: provider.id, retryAfterMs: Math.ceil((1 - this.tokens) * INTERVAL) };
    this.tokens--;
    if (!target) { target = { started: now }; this.targets.set(key, target); }
    target.started = now;
    // 最近启动的目标留在末尾；并发最多由全局两枚token限制，淘汰不打断正在唤醒的目标。
    this.targets.delete(key); this.targets.set(key, target);
    while (this.targets.size > MAX_TARGETS) {
      const oldest = [...this.targets].find(([, value]) => !value.pending);
      if (!oldest) break;
      this.targets.delete(oldest[0]);
    }
    const controller = new AbortController();
    const work: Work = { controller, consumers: new Set(), promise: Promise.resolve().then(() => this.run(base, provider!.apiKey, controller.signal, remainingMs)) };
    target.pending = work;
    const current = target;
    void work.promise.finally(() => { if (current.pending === work) current.pending = undefined; }).catch(() => undefined);
    return { ...await this.join(work, signal, remainingMs), provider: provider.id };
  }

  private join(work: Work, signal: AbortSignal, remainingMs: number): Promise<WarmupResult> {
    return new Promise((resolve, reject) => {
      const consumer = {}; let settled = false;
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); work.consumers.delete(consumer); };
      const abort = () => { if (settled) return; settled = true; cleanup(); if (!work.consumers.size) work.controller.abort(); reject(abortError()); };
      // 每个消费者有自己的剩余预算；慢配置查询不能借共享工作把一次请求拖成两倍超时。
      const timer = setTimeout(() => {
        if (settled) return; settled = true; cleanup(); if (!work.consumers.size) work.controller.abort();
        resolve({ status: 'failed', error: { code: 'network', message: '本机模型预热超时', retryable: true } });
      }, remainingMs);
      work.consumers.add(consumer); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void work.promise.then((result) => { if (settled) return; settled = true; cleanup(); if (signal.aborted) reject(abortError()); else resolve(result); },
        (error) => { if (settled) return; settled = true; cleanup(); reject(error); });
    });
  }

  private async run(base: string, apiKey: string | undefined, signal: AbortSignal, remainingMs: number): Promise<WarmupResult> {
    const started = this.now(), controller = new AbortController(); let timeout = false;
    const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(() => { timeout = true; controller.abort(); }, remainingMs);
    const elapsed = () => ({ elapsedMs: Math.max(0, this.now() - started) });
    try {
      const before = await this.props(base, apiKey, controller.signal);
      if (before.is_sleeping === false) return { status: 'ready', ...elapsed() };
      if (before.is_sleeping !== true || before.endpoint_slots !== true) return { status: 'unsupported', ...elapsed() };
      // b12069的GET/slots通过wait_until_no_sleep唤醒，不进行推理。body可能含旧prompt，绝不读取。
      const slots = await this.get(base + '/slots', apiKey, controller.signal);
      void slots.body?.cancel().catch(() => undefined);
      this.checkStatus(slots);
      const after = await this.props(base, apiKey, controller.signal);
      if (after.is_sleeping !== false) throw failure('server', '本机模型尚未确认唤醒');
      return { status: 'warmed', ...elapsed() };
    } catch (error) {
      if (signal.aborted) throw abortError();
      return { status: 'failed', ...elapsed(), error: timeout ? { code: 'network', message: '本机模型预热超时', retryable: true }
        : error instanceof WarmupFailure ? error.info : { code: 'network', message: '本机模型预热连接失败', retryable: true } };
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  }

  private async get(url: string, apiKey: string | undefined, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    return abortable(this.fetcher(url, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) } }).then((response) => {
      if (signal.aborted) { void response.body?.cancel().catch(() => undefined); throw abortError(); }
      return response;
    }), signal);
  }
  private checkStatus(response: Response) {
    if (response.ok) return;
    throw failure(response.status === 401 || response.status === 403 ? 'auth' : 'server', `本机预热接口返回HTTP ${response.status}`);
  }
  private async props(base: string, apiKey: string | undefined, signal: AbortSignal): Promise<{ is_sleeping?: boolean; endpoint_slots?: boolean }> {
    const response = await this.get(base + '/props', apiKey, signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      this.checkStatus(response);
      if (Number(response.headers.get('content-length')) > MAX_PROPS_BYTES || !response.body) throw failure('server', '本机模型状态响应无效');
      reader = response.body.getReader(); let bytes = 0, text = ''; const decoder = new TextDecoder();
      while (true) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_PROPS_BYTES) throw failure('server', '本机模型状态响应过大');
        text += decoder.decode(chunk.value, { stream: true });
      }
      const data: unknown = JSON.parse(text + decoder.decode());
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('server', '本机模型状态格式无效');
      const value = data as Record<string, unknown>;
      return { ...(typeof value.is_sleeping === 'boolean' ? { is_sleeping: value.is_sleeping } : {}),
        ...(typeof value.endpoint_slots === 'boolean' ? { endpoint_slots: value.endpoint_slots } : {}) };
    } finally {
      if (reader) { void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* 取消尚未返回的读取由浏览器结束 */ } }
      else void response.body?.cancel().catch(() => undefined);
    }
  }

  dispose() { this.disposed = true; for (const target of this.targets.values()) target.pending?.controller.abort(); this.targets.clear(); }
}
