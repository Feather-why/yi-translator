import type { AlignPair, AlignResult } from '../../shared/protocol';
import { validAlignment } from './algorithm';
import { constrainSentenceLinks, sentenceAlignmentFallback } from './sentence-alignment';
import { offscreenRequest } from './offscreen-client';
import { refineWithDictionary, type AlignmentDictionary } from './dictionary-links';

export interface AlignmentConfiguration { enabled?: boolean; remoteUrl?: string; token?: string }
export interface AlignmentOptions { infer?: (pairs: AlignPair[]) => Promise<AlignResult[]>; initialize?: () => Promise<void>; fetch?: typeof fetch; maxEntries?: number; dictionary?: AlignmentDictionary }
interface AlignmentTask { priority: number; run(): Promise<void> }
export const ALIGNMENT_STRATEGY_REVISION = '2026-11-selection-boundaries-v2';

export class AlignmentService {
  private cache = new Map<string, AlignResult>();
  private preciseCache = new Map<string, AlignResult>();
  private pending = new Map<string, { promise: Promise<AlignResult>; task: AlignmentTask }>();
  private initialized?: Promise<void>;
  private loaded = false;
  private config: AlignmentConfiguration = { enabled: true };
  private error?: string;
  private queue: AlignmentTask[] = [];
  private running = false;
  private generation = 0;
  constructor(private options: AlignmentOptions = {}) {}
  status() { return { enabled: this.config.enabled !== false, modelReady: this.loaded, mode: this.config.remoteUrl ? 'remote' : 'wasm', cached: this.cache.size, ...(this.error ? { error: this.error } : {}) }; }
  configure(config: AlignmentConfiguration) {
    if (config.remoteUrl) {
      const url = new URL(config.remoteUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('对齐节点地址无效');
    }
    this.config = { ...this.config, ...config }; this.cache.clear(); this.preciseCache.clear(); this.pending.clear(); this.initialized = undefined; this.loaded = false; this.generation++;
    return this.status();
  }
  private key(pair: AlignPair) { return JSON.stringify([ALIGNMENT_STRATEGY_REVISION, pair.source, pair.target, pair.sourceLang, pair.targetLang]); }
  private dictionaryReady() { return this.options.dictionary?.status?.().ready !== false; }
  private dictionaryKey() {
    const status = this.options.dictionary?.status?.();
    return JSON.stringify([status?.ready !== false, status?.revision ?? 0]);
  }
  private cacheKey(pair: AlignPair, localOnly = false, config = this.config, dictionaryKey = this.dictionaryKey()) {
    return this.key(pair) + ((config.remoteUrl && !localOnly) ? ':remote' : ':local') + ':dict:' + dictionaryKey;
  }
  private async initialize(localOnly = false) {
    if (this.config.remoteUrl && !localOnly) return;
    if (!this.initialized) {
      const generation = this.generation;
      const work = Promise.resolve().then(() => this.options.initialize ? this.options.initialize() : this.options.infer ? undefined : offscreenRequest('align:init', {}))
        .then(() => { if (generation !== this.generation) throw new Error('词对齐设置已更新'); this.loaded = true; this.error = undefined; });
      const current = work.catch((error: unknown) => {
        if (this.initialized === current) { this.initialized = undefined; if (generation === this.generation) this.error = '本地词对齐模型尚未就绪'; }
        throw error;
      });
      this.initialized = current;
    }
    await this.initialized;
  }
  private async fallback(pair: AlignPair): Promise<AlignResult> {
    const result = sentenceAlignmentFallback(pair);
    const dictionary = this.options.dictionary;
    if (!dictionary || dictionary.status?.().ready === false) return result;
    const dictionaryKey = this.dictionaryKey();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        refineWithDictionary(pair, result, dictionary).then((refined) => dictionaryKey === this.dictionaryKey() ? constrainSentenceLinks(pair, refined) : result).catch(() => result),
        new Promise<AlignResult>((resolve) => { timer = setTimeout(() => resolve(result), 45); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        this.queue.sort((a, b) => a.priority - b.priority);
        await this.queue.shift()!.run();
      }
    } finally { this.running = false; }
  }
  async get(pairs: AlignPair[], options: { noCache?: boolean; localOnly?: boolean; waitForModel?: boolean } = {}): Promise<AlignResult[]> {
    if (!Array.isArray(pairs) || pairs.length > 100) throw new Error('词对齐每次最多 100 对');
    return Promise.all(pairs.map(async (pair) => {
      if (!pair || typeof pair.id !== 'string' || typeof pair.source !== 'string' || typeof pair.target !== 'string' || pair.source.length > 10000 || pair.target.length > 10000) throw new Error('词对齐输入格式无效');
      const key = this.cacheKey(pair, options.localOnly);
      const cached = options.noCache ? undefined : this.cache.get(key);
      if (cached) { this.cache.delete(key); this.cache.set(key, cached); return { ...structuredClone(cached), id: pair.id }; }
      if (this.config.enabled === false) return this.fallback(pair);
      const computation = this.compute(pair, options, 0).then((result) => ({ ...result, id: pair.id }));
      if (options.waitForModel) return computation;
      // 前端缓存首次 Promise；模型热不等于这一整段已算完，未命中时都给真实结果有界等待。
      const budget = 5000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([computation, new Promise<AlignResult>((resolve, reject) => { timer = setTimeout(() => { void this.fallback(pair).then(resolve, reject); }, budget); })]); }
      catch { return this.fallback(pair); }
      finally { if (timer) clearTimeout(timer); }
    }));
  }
  precompute(pair: AlignPair, options: { noCache?: boolean; localOnly?: boolean } = {}) {
    if (options.noCache || this.config.enabled === false) return Promise.resolve();
    if (this.cache.has(this.cacheKey(pair, options.localOnly)) || this.queue.filter((task) => task.priority > 0).length >= 32) return Promise.resolve();
    return this.compute(pair, options, 1).then(() => undefined).catch(() => undefined);
  }
  /** 专供标签恢复的有界本机语义请求；默认无缓存且不会触发首次下载。 */
  async projection(pair: AlignPair, timeoutMs = 350, options: { noCache?: boolean } = { noCache: true }): Promise<AlignResult | undefined> {
    if (!this.loaded || this.config.enabled === false || this.queue.filter((task) => task.priority === 0).length > 1) return undefined;
    const cacheAllowed = options.noCache === false;
    if (cacheAllowed) {
      const cached = this.preciseCache.get(this.cacheKey(pair, true));
      if (cached) return { ...structuredClone(cached), id: pair.id };
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.compute(pair, { noCache: !cacheAllowed, localOnly: true, signal: controller.signal }, 0, true).catch(() => undefined),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, Math.max(1, Math.min(1000, timeoutMs))); }),
      ]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  private compute(pair: AlignPair, options: { noCache?: boolean; localOnly?: boolean; signal?: AbortSignal }, priority: number, precise = false) {
    const key = this.cacheKey(pair, options.localOnly) + (precise ? ':precise' : '');
    const pending = options.noCache ? undefined : this.pending.get(key);
    if (pending) { pending.task.priority = Math.min(pending.task.priority, priority); return pending.promise; }
    const generation = this.generation, config = { ...this.config };
    const work = async () => {
      if (generation !== this.generation) throw new Error('词对齐设置已更新');
      options.signal?.throwIfAborted();
      let result: AlignResult;
      if (config.remoteUrl && !options.localOnly) {
        const response = await (this.options.fetch ?? globalThis.fetch)(config.remoteUrl.replace(/\/$/, '') + '/v1/align', {
          method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { 'Content-Type': 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) }, body: JSON.stringify({ pairs: [pair] }),
        });
        if (!response.ok) throw new Error('远程词对齐节点不可用');
        const data: unknown = await response.json();
        if (!Array.isArray(data) || !validAlignment(pair, data[0])) throw new Error('远程词对齐结果格式无效');
        result = data[0];
      } else {
        await this.initialize(options.localOnly);
        if (generation !== this.generation) throw new Error('词对齐设置已更新');
        const data = this.options.infer ? await this.options.infer([pair]) : await offscreenRequest<AlignResult[]>('align:get', { pairs: [pair] });
        if (!validAlignment(pair, data[0])) throw new Error('本地词对齐结果格式无效');
        result = data[0];
      }
      if (generation !== this.generation) throw new Error('词对齐设置已更新');
      options.signal?.throwIfAborted();
      const dictionaryKey = this.dictionaryKey();
      if (this.dictionaryReady()) result = await refineWithDictionary(pair, result, this.options.dictionary);
      if (generation !== this.generation) throw new Error('词对齐设置已更新');
      if (dictionaryKey !== this.dictionaryKey()) throw new Error('词典已更新，请重试词对齐');
      options.signal?.throwIfAborted();
      const semantic = constrainSentenceLinks(pair, result, { coverage: false });
      result = precise ? semantic : constrainSentenceLinks(pair, semantic);
      if (!options.noCache && generation === this.generation) {
        const cacheKey = this.cacheKey(pair, options.localOnly, config, dictionaryKey);
        this.preciseCache.set(cacheKey, structuredClone(semantic));
        if (!precise) this.cache.set(cacheKey, structuredClone(result));
        while (this.cache.size > (this.options.maxEntries ?? 1000)) this.cache.delete(this.cache.keys().next().value!);
        while (this.preciseCache.size > (this.options.maxEntries ?? 1000)) this.preciseCache.delete(this.preciseCache.keys().next().value!);
      }
      return result;
    };
    let task!: AlignmentTask;
    const promise = new Promise<AlignResult>((resolve, reject) => {
      task = { priority, run: async () => { try { resolve(await work()); } catch (error) { reject(error); } } };
    });
    this.queue.push(task);
    if (!options.noCache) this.pending.set(key, { promise, task });
    queueMicrotask(() => { void this.drain(); });
    void promise.finally(() => { if (this.pending.get(key)?.promise === promise) this.pending.delete(key); }).catch(() => undefined);
    return promise;
  }
  dispose() { this.cache.clear(); this.preciseCache.clear(); this.pending.clear(); this.loaded = false; this.initialized = undefined; this.generation++; }
}
