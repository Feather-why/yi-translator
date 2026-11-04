import type { AlignPair, AlignResult, ErrorInfo, Mode, ProviderInfo, ProviderOptions, ProviderTemplate, ProviderStatus, QuotaInfo, Segment, StatusEvent, StatusSnapshot, TranslateJob } from '../shared/protocol';
import { ProviderError, type BuiltinTranslatorBridge, type ProviderContext, type ProviderDef, type ProviderRequest } from './providers/types';
import { BackendStorage } from './storage';
import { loadUiSettings } from '../shared/settings';
import { diagnosticPair, diagnosticSample } from './provider-diagnostics';
import { SecretVault } from './secrets';
import { QuotaLedger, QuotaReservationError } from './scheduler/quota';
import { AccountQuota } from './account-quota';
import { reserveQuotas } from './quota-reservations';
import { ProviderBatcher } from './scheduler/batcher';
import { validTranslation } from './validation';
import { translateTextLeaves } from './placeholder-fallback';
import { restoreMissingAtoms } from './placeholder-atoms';
import { hasNestedPlaceholders, NESTED_PROJECTION_REVISION, translateWithProjectedPlaceholders } from './translation-quality';
import { splitTranslationText } from './translation-chunks';
import { hasPlaceholders } from '../shared/placeholders';
import { raceWithHedge } from './scheduler/hedge';
import { cloneProvider, effectiveProvider, normalizeOptions, providerConfig, providerMetadata, providerTemplate, validateEndpoint, validateProviderConfig } from './provider-options';
import type { PlaceholderDiagnostic } from './placeholder-diagnostics';
import type { PerformanceEvent } from './performance';
import type { TranslationObserver } from './translation-observer';
import { RequestTimeline, TranslationTrace, type RequestObservation } from './translation-trace';
import { ProviderSlots, readScheduling, type BatchScheduling, type ProviderLease } from './scheduler/provider-slots';

interface Config { enabled: boolean; config: Record<string, string>; pinned?: boolean; paused?: boolean; options?: ProviderOptions; custom?: boolean; template?: ProviderTemplate; name?: string }
interface Runtime {
  active: number; failures: number; cooldown: number; attempts: boolean[]; latencies: number[]; ewma?: number;
  error?: ProviderStatus['lastError']; probeError?: ProviderStatus['lastError']; exhaustedUntil?: number; nextRequest: number; quotaAmount?: number; secretsError?: boolean; halfOpen?: boolean; backoff?: number;
}
export interface CoreOptions { providers: ProviderDef[]; storage?: BackendStorage; vault?: SecretVault; fetch?: typeof fetch; now?: () => number; builtin?: BuiltinTranslatorBridge; openBuiltinSetup?: (sourceLang: string, targetLang: string) => Promise<void>; onTranslated?: (job: TranslateJob, segment: Segment, text: string) => void; align?: (pair: AlignPair, signal: AbortSignal) => Promise<AlignResult | undefined>; lookup?: (word: string, sourceLang: string, targetLang: string) => Promise<{ translations: string[] } | null>; syncStatus?: () => StatusSnapshot['sync']; onPlaceholderDiagnostic?: (record: PlaceholderDiagnostic & { providerId: string }) => void; onPerformance?: (event: PerformanceEvent) => void }

interface InvocationObservation extends RequestObservation { scheduling?: BatchScheduling }
interface CombinedWork { provider: ProviderDef; precise: boolean; controller: AbortController; promise: Promise<string>; consumers: Set<AbortSignal>;
  observations: Map<AbortSignal, InvocationObservation>; timeline: RequestTimeline; previewOwner?: AbortSignal; partial?: string }
interface CombinedScope {
  read<T>(key: string, load: () => Promise<T>): Promise<T>;
  has(provider: ProviderDef, tier: 'fast' | 'accurate'): boolean;
  invoke(provider: ProviderDef, request: ProviderRequest, tier: 'fast' | 'accurate', version: string, signal: AbortSignal, observation: InvocationObservation): Promise<string>;
  finalOnly(provider: ProviderDef, version: string, accurateFirst: ProviderDef | undefined): boolean;
  accurateAttempt(hedged: boolean): void;
  accurateWinner(provider: ProviderDef, version: string): void;
}

const MASK = '••••';
const abortError = () => new DOMException('取消', 'AbortError');
const withoutPreview = (observation?: InvocationObservation): InvocationObservation | undefined => observation && { onRequestStart: observation.onRequestStart, onRequestEnd: observation.onRequestEnd, onRetry: observation.onRetry, retryState: observation.retryState, scheduling: observation.scheduling };
const FAST_RECOVERY_REVISION = 'fast-recovery-v1';
const percentile = (values: number[], p = 0.5) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : undefined;

export class BackendCore {
  readonly storage: BackendStorage;
  private vault: SecretVault;
  private ledger = new QuotaLedger(() => this.now());
  private accountQuota = new AccountQuota(this.ledger);
  private slots = new ProviderSlots(() => this.now(), () => this.changed());
  private batcher = new ProviderBatcher(async (provider, signal, run, scheduling) => {
    const release = await this.slot(provider, signal, scheduling);
    try { return await run(release.dispatch); }
    catch (caught) {
      // 真实批次失败必须先关闸再释放槽；否则唤醒微任务会抢在invoke的catch之前超发。
      if (!signal.aborted && !(caught instanceof QuotaReservationError) && !(caught instanceof ProviderError && this.recordedFailures.has(caught))) {
        const info = { ...(caught instanceof ProviderError ? caught.info : provider.classifyError(caught)), provider: provider.id };
        if (['network', 'server', 'rate_limit', 'auth', 'quota'].includes(info.code)) {
          await this.failure(provider, info, readScheduling(scheduling).manual);
          const failure = new ProviderError(info); this.recordedFailures.add(failure); throw failure;
        }
      }
      throw caught;
    } finally { release(); }
  });
  private configs: Record<string, Config> = {};
  private originals = new Map<string, ProviderDef>();
  private customConfigRevision = 0;
  private secrets = new Map<string, Record<string, string>>();
  private runtimes = new Map<string, Runtime>();
  private listeners = new Set<(immediate?: boolean) => void>();
  private events: StatusEvent[] = [];
  private perf: number[] = [];
  private bad = new Map<string, number>();
  private recordedFailures = new WeakSet<ProviderError>();
  private nodes: StatusSnapshot['nodes'] = [];
  private writes = Promise.resolve();
  private fetcher: typeof fetch;
  private initialization: Promise<void>;
  private sticky = new Map<string, { provider: string; at: number }>();
  private now: () => number;
  private allowUnofficial = false;
  private auxiliaryReady = false;
  private auxiliaryRetryAt = 0;
  private auxiliaryOpening?: Promise<boolean>;
  private auxiliaryWarningAt?: number;

  constructor(private options: CoreOptions) {
    this.options = { ...options, providers: options.providers.slice() };
    this.now = options.now ?? Date.now;
    this.storage = options.storage ?? new BackendStorage();
    this.vault = options.vault ?? new SecretVault();
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    for (const provider of options.providers) { this.originals.set(provider.id, provider); this.runtimes.set(provider.id, this.newRuntime()); }
    this.initialization = this.initialize();
    void this.initialization.catch(() => this.event('error', '后端本地存储初始化失败，请检查扩展存储权限'));
  }
  ready() { return this.initialization; }
  private auxiliaryWarning(write = false) {
    if (this.auxiliaryWarningAt !== undefined && this.now() - this.auxiliaryWarningAt < 60_000) return;
    this.auxiliaryWarningAt = this.now();
    this.event('warn', write ? '译文已完成，但本机缓存写入失败，稍后重试' : '本机译文缓存暂不可用，已继续使用翻译服务，稍后重试');
  }
  private auxiliaryStorage(): Promise<boolean> {
    if (this.auxiliaryReady) return Promise.resolve(true);
    if (this.auxiliaryOpening) return this.auxiliaryOpening;
    if (this.now() < this.auxiliaryRetryAt) return Promise.resolve(false);
    this.auxiliaryRetryAt = this.now() + 30_000;
    this.auxiliaryOpening = Promise.resolve().then(() => this.storage.ready()).then(() => {
      this.auxiliaryReady = true; return true;
    }, () => { this.auxiliaryWarning(); return false; }).finally(() => { this.auxiliaryOpening = undefined; });
    return this.auxiliaryOpening;
  }
  private async auxiliaryRead<T>(load: () => Promise<T>): Promise<T | undefined> {
    if (!await this.auxiliaryStorage()) return undefined;
    try { return await load(); }
    catch {
      this.auxiliaryReady = false; this.auxiliaryRetryAt = this.now() + 30_000; this.auxiliaryWarning();
      return undefined;
    }
  }
  getVault() { return this.vault; }
  private measurement(event: PerformanceEvent) { try { this.options.onPerformance?.(event); } catch { /* 诊断不能影响业务结果。 */ } }
  private placeholderMeasurement(provider: ProviderDef, record: PlaceholderDiagnostic) {
    try { this.options.onPlaceholderDiagnostic?.({ ...record, providerId: provider.id }); } catch { /* 外部统计异常与翻译隔离。 */ }
  }
  private newRuntime(): Runtime { return { active: 0, failures: 0, cooldown: 0, attempts: [], latencies: [], nextRequest: 0 }; }
  private resetAccountRuntime(id: string) {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    // 槽位仍持有这个runtime；保留active/QPS预约，只清上一个账户的故障和额度状态。
    runtime.quotaAmount = undefined; runtime.exhaustedUntil = undefined; runtime.cooldown = 0; runtime.failures = 0;
    runtime.error = undefined; runtime.probeError = undefined; runtime.backoff = 0; runtime.halfOpen = false;
    runtime.attempts = []; runtime.latencies = []; runtime.ewma = undefined;
  }
  private currentAccountResult(provider: ProviderDef) {
    // 旧密钥已经发出的请求可以返回结果，但不能修改新账户的预算或健康状态。
    return provider.id !== 'deepl' || this.options.providers.includes(provider);
  }
  notifyStatus() { this.changed(); }
  async refreshPolicy() {
    await this.ready();
    const value = (await chrome.storage.local.get('settings.core'))['settings.core'] as { allowUnofficial?: boolean } | undefined;
    this.allowUnofficial = value?.allowUnofficial === true; this.changed();
  }
  async mergeUsage(counters: Record<string, { used: number; resetAt: number; devices: Record<string, number> }>) {
    await this.ready(); await this.ledger.mergeCounters(Object.fromEntries(Object.entries(counters).filter(([id]) => this.originals.has(id)))); this.changed();
  }
  async refreshStoredState() {
    await this.ready();
    for (const provider of this.options.providers) {
      try {
        const secrets = await this.vault.get(provider.id), base = this.originals.get(provider.id)!;
        let changedCustomConfig = false;
        if (providerTemplate(base) === 'custom-http') {
          const previous = this.config(provider);
          const next = providerConfig(base, { ...provider.defaults, ...this.configs[provider.id]?.config, ...secrets }, this.configs[provider.id]?.options ?? {});
          validateProviderConfig(base, next);
          changedCustomConfig = ['url', 'headers', 'body', 'resultPath', 'batch'].some((key) => previous[key] !== next[key]);
        }
        const changedDeepL = provider.id === 'deepl' && (this.config(provider).key ?? '').trim() !== (secrets.key ?? '').trim();
        this.secrets.set(provider.id, secrets); this.runtimes.get(provider.id)!.secretsError = false;
        if (changedDeepL) this.options.providers = this.options.providers.map((entry) => entry.id === provider.id ? this.effective(provider.id) : entry);
        const changedAccount = await this.accountQuota.configure(provider, this.config(provider));
        // 密钥导入也能修改请求模板；立即换代，避免旧排队任务用新模板发送却写入旧缓存版本。
        // 普通刷新未改变有效配置时保留实例，不中断已有队列和其他服务的密钥刷新。
        if (changedCustomConfig || changedAccount) this.options.providers = this.options.providers.map((entry) => entry.id === provider.id ? this.effective(provider.id) : entry);
        if (changedAccount) this.resetAccountRuntime(provider.id);
      }
      catch { this.runtimes.get(provider.id)!.secretsError = true; }
    }
    await this.ledger.reload(); this.changed();
  }
  private async initialize() {
    const stored = await chrome.storage.local.get(['backend.providers', 'backend.perf', 'settings.core']);
    this.allowUnofficial = (stored['settings.core'] as { allowUnofficial?: boolean } | undefined)?.allowUnofficial === true;
    const configs: Record<string, Config> = stored['backend.providers'] && typeof stored['backend.providers'] === 'object' ? stored['backend.providers'] as Record<string, Config> : {};
    this.perf = Array.isArray(stored['backend.perf']) ? stored['backend.perf'].filter((n: unknown) => typeof n === 'number' && Number.isFinite(n)).slice(-200) : [];
    // 缓存是可丢弃的辅助层；设备密钥和额度账本失败仍必须阻止启动。
    await Promise.all([this.auxiliaryStorage(), this.vault.ready(), this.ledger.ready(), this.accountQuota.ready()]);
    for (const [id, saved] of Object.entries(configs)) {
      if (!saved || saved.custom !== true || !/^custom-[a-z0-9-]{8,80}$/.test(id) || this.originals.has(id)) continue;
      try {
        const provider = cloneProvider(saved.template!, id, this.providerName(saved.name));
        this.originals.set(id, provider); this.options.providers.push(provider); this.runtimes.set(id, this.newRuntime());
      } catch { this.event('warn', '已忽略格式损坏的自定义服务配置'); }
    }
    for (const provider of this.options.providers) {
      const saved = configs[provider.id];
      const config: Record<string, string> = {};
      for (const field of provider.auth) {
        const value = saved?.config?.[field.key];
        if (!field.secret && typeof value === 'string') config[field.key] = value;
      }
      let options: ProviderOptions = {};
      try {
        const migrated: ProviderOptions = {};
        const editable = providerMetadata(provider, saved?.template).editable;
        if (editable.includes('endpoint') && config.url) migrated.endpoint = config.url;
        if (editable.includes('model') && config.model) migrated.model = config.model;
        options = normalizeOptions(provider, saved?.options ?? migrated, saved?.template);
        if (editable.includes('endpoint')) delete config.url;
        if (editable.includes('model')) delete config.model;
      } catch { this.event('warn', `${provider.name}的高级设置格式异常，已恢复默认`, provider.id); }
      this.configs[provider.id] = { enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : provider.official && !['tencent', 'openai-compatible', 'gemini', 'remote-node'].includes(provider.id),
        config, pinned: saved?.pinned === true, paused: saved?.paused === true, options,
        ...(saved?.custom && provider.id.startsWith('custom-') ? { custom: true, template: saved.template, name: this.providerName(saved.name) } : {}) };
      try { this.secrets.set(provider.id, await this.vault.get(provider.id)); }
      catch {
        this.secrets.set(provider.id, {});
        this.runtimes.get(provider.id)!.secretsError = true;
        this.event('error', `${provider.name}的本机密钥无法解密，请重新填写并保存`, provider.id);
      }
    }
    this.options.providers = this.options.providers.map((provider) => this.effective(provider.id));
    for (const provider of this.options.providers) await this.accountQuota.configure(provider, this.config(provider));
    this.changed();
  }
  private providerName(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f]/.test(value)) throw new ProviderError({ code: 'bad_input', message: '服务名称须为 1–80 个可见字符', retryable: false });
    return value.trim();
  }
  private effective(id: string) {
    const base = this.originals.get(id)!;
    const config = this.configs[id];
    const effective = effectiveProvider(base, config?.options ?? {}, this.config(base));
    // 配置代号只用于拆开旧/新批次；公开版本中不放密钥或可猜测的密钥短哈希。
    if (providerTemplate(base) === 'custom-http' || id === 'deepl') effective.version += `+config.${++this.customConfigRevision}`;
    return { ...effective, ...(config?.custom ? { name: config.name! } : {}) };
  }
  private definition(id: string) {
    const provider = this.options.providers.find((p) => p.id === id);
    if (!provider) throw new ProviderError({ code: 'bad_input', message: '未知翻译服务', retryable: false });
    return provider;
  }
  private config(provider: ProviderDef) { return providerConfig(this.originals.get(provider.id) ?? provider,
    { ...provider.defaults, ...this.configs[provider.id]?.config, ...this.secrets.get(provider.id) }, this.configs[provider.id]?.options ?? {}); }
  private nestedProjection(provider: ProviderDef, source: string) { return provider.kind === 'local' && provider.placeholders === 'prompt' && hasNestedPlaceholders(source); }
  private async cacheVersion(provider: ProviderDef, source: string, quality: 'fast' | 'accurate' = 'accurate') {
    const config = this.config(provider);
    const customHttp = providerTemplate(this.originals.get(provider.id) ?? provider) === 'custom-http';
    const version = customHttp || provider.id === 'deepl' ? provider.version.replace(/\+config\.\d+$/, '') : provider.version;
    const values = [config.model ?? '', config.prompt ?? '', config.url ?? '', config.temperature ?? ''];
    if (customHttp) values.push(config.body ?? '', config.headers ?? '', config.resultPath ?? '', config.batch ?? '');
    const revision = (this.nestedProjection(provider, source) ? ':' + NESTED_PROJECTION_REVISION : '') + (quality === 'fast' ? ':' + FAST_RECOVERY_REVISION : '')
      + (/<x\d+\/>/.test(source) ? ':atom-repair-v1' : '');
    if (values.every((value) => !value)) return version + revision;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values)));
    return version + ':' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') + revision;
  }
  private configured(provider: ProviderDef) {
    if (this.runtimes.get(provider.id)?.secretsError) return false;
    const config = this.config(provider);
    return provider.auth.every((field) => !field.required || !!config[field.key]?.trim());
  }
  private quota(provider: ProviderDef): Omit<QuotaInfo, 'used' | 'resetAt'> | undefined {
    const budget = Number(this.config(provider).monthlyQuota);
    // 官方已知后不再用旧500k默认截断账户；显式用户预算仍按自己的日/月周期单独限制。
    if (this.accountQuota.definition(provider) && !this.configs[provider.id]?.options?.quota && !(Number.isFinite(budget) && budget > 0)) return undefined;
    const quota: Omit<QuotaInfo, 'used' | 'resetAt'> | undefined = this.configs[provider.id]?.options?.quota ? provider.freeQuota
      : Number.isFinite(budget) && budget > 0 ? { unit: 'char', amount: budget, period: 'month' } : provider.freeQuota;
    const officialAmount = this.runtimes.get(provider.id)?.quotaAmount;
    if (!quota || quota.amount <= 0) return undefined;
    if (provider.id === 'deepl') return quota;
    return officialAmount !== undefined ? { ...quota, amount: Math.min(quota.amount, officialAmount) } : quota;
  }
  private quotaInfo(provider: ProviderDef) {
    return this.ledger.info(provider.id, this.accountQuota.definition(provider) ?? this.quota(provider));
  }
  private quotaAvailable(provider: ProviderDef) {
    return this.ledger.available(provider.id, this.quota(provider)) && this.ledger.available(provider.id, this.accountQuota.definition(provider));
  }
  private available(provider: ProviderDef, manual = false) {
    const config = this.configs[provider.id];
    const runtime = this.runtimes.get(provider.id);
    if (!runtime) return false;
    return (manual || (!!config?.enabled && !config.paused && (provider.official || this.allowUnofficial))) && this.configured(provider) && !runtime.halfOpen
      && (manual || runtime.cooldown <= this.now()) && (runtime.exhaustedUntil ?? 0) <= this.now()
      && this.quotaAvailable(provider);
  }
  private score(provider: ProviderDef) {
    const runtime = this.runtimes.get(provider.id)!;
    if (this.configs[provider.id]?.pinned) return -1;
    const rate = runtime.attempts.length ? runtime.attempts.filter(Boolean).length / runtime.attempts.length : 1;
    const quota = this.quotaInfo(provider);
    const pressure = quota && quota.amount ? 1 + quota.used / quota.amount : 1;
    const days = quota?.resetAt ? Math.max(0.25, (quota.resetAt - this.now()) / 86_400_000) : 30;
    const expiring = quota && quota.amount ? 1 + Math.min(0.5, (quota.amount - quota.used) / quota.amount / days) : 1;
    const weight = this.configs[provider.id]?.options?.weight ?? 50;
    const paid = (this.configs[provider.id]?.options?.quota?.amount ?? provider.freeQuota?.amount) === 0;
    return (paid ? 1e9 : 0) + (runtime.ewma ?? (provider.kind === 'local' ? 350 : 500)) * pressure / Math.max(0.1, rate) / expiring * (150 - weight) / 100;
  }
  private fallbackGroup(provider: ProviderDef, tier: 'fast' | 'accurate') {
    if (!provider.official) return 4;
    if (this.configs[provider.id]?.pinned) return -1;
    if ((this.configs[provider.id]?.options?.quota?.amount ?? provider.freeQuota?.amount) === 0) return 3;
    // 首次引导推荐已开启的内置翻译；高速档优先本机原生模型，不消耗云端额度。
    if (provider.kind === 'builtin') return tier === 'fast' ? 0 : 2;
    if (provider.kind === 'local') return tier === 'fast' ? 2 : 1;
    return tier === 'fast' ? 1 : 0;
  }
  private participates(provider: ProviderDef, tier: 'fast' | 'accurate') {
    // 两个本机后备保留在用户停用/暂停控制下，额度耗尽时也能接住另一档。
    return provider.usedFor.includes(tier) || provider.kind === 'local' || provider.kind === 'builtin';
  }
  private candidates(tier: 'fast' | 'accurate', job: TranslateJob, scope?: CombinedScope) {
    let ranked = this.options.providers.filter((provider) => (this.available(provider) || scope?.has(provider, tier))
      && provider.supports?.(job.sourceLang, job.targetLang) !== false
      && !(provider.kind === 'builtin' && this.options.builtin?.unavailable?.(job.sourceLang, job.targetLang))
      && (job.providerHint || this.participates(provider, tier)))
      .sort((a, b) => this.fallbackGroup(a, tier) - this.fallbackGroup(b, tier) || this.score(a) - this.score(b));
    if (job.providerHint) {
      const requested = ranked.find((provider) => provider.id === job.providerHint);
      // 选择服务也不能把可选网页接口变成主服务；手动“保存并测试”另走显式测试。
      return requested && (requested.official || !ranked.some((provider) => provider.official && this.participates(provider, tier))) ? [requested] : [];
    }
    const sticky = this.sticky.get(`${tier}:${job.context.url}`);
    const pinned = ranked.find((provider) => this.configs[provider.id]?.pinned);
    const previous = sticky && this.now() - sticky.at < 1_800_000 ? ranked.find((provider) => provider.id === sticky.provider) : undefined;
    if (!pinned && previous && ranked[0] && this.fallbackGroup(previous, tier) === this.fallbackGroup(ranked[0], tier)
      && (this.configs[previous.id]?.options?.quota?.amount ?? previous.freeQuota?.amount) !== 0) return [previous, ...ranked.filter((provider) => provider !== previous)];
    return ranked;
  }

  /** 只在一个端口的一段综合任务内共享，不用全局jobId，取消或替换不会借到旧任务。 */
  createCombined(job: TranslateJob, segment: Segment) {
    const pending = new Map<string, CombinedWork>();
    const reads = new Map<string, Promise<unknown>>();
    let disposed = false, accurateProvider: string | undefined, accurateWinner: string | undefined, accurateHedged = false;
    const key = (provider: ProviderDef, version: string, precise = true) => `${provider.id}:${version}:${precise ? 'precise' : 'plain'}`;
    const scope: CombinedScope = {
      read: <T>(identity: string, load: () => Promise<T>): Promise<T> => {
        if (disposed) return Promise.reject(abortError());
        let query = reads.get(identity);
        if (!query) { query = Promise.resolve().then(load); reads.set(identity, query); }
        return query as Promise<T>;
      },
      // 额度已为这份工作预留，即便恰好用完余量，另一档仍应加入它而非误报无服务。
      has: (provider, tier) => [...pending.values()].some((entry) => entry.provider === provider && !entry.controller.signal.aborted
        && entry.precise === (tier === 'accurate' || provider.usedFor.some((mode) => mode === 'accurate' || mode === 'combined'))),
      invoke: (provider, request, tier, version, signal, observation) => {
        if (disposed || signal.aborted) return Promise.reject(abortError());
        const precise = request.context !== undefined, identity = key(provider, version, precise);
        if (tier === 'accurate') accurateProvider = identity;
        let work = pending.get(identity);
        if (!work) {
          this.measurement({ type: 'shared', providerId: provider.id, outcome: 'created' });
          const controller = new AbortController();
          const timeline = new RequestTimeline();
          timeline.observation.retryState = observation.retryState;
          work = { provider, precise, controller, timeline, consumers: new Set(), observations: new Map(), promise: Promise.resolve().then(() => {
            controller.signal.throwIfAborted();
            const best = (): { priority: number; lane: 'fast' | 'final' } => [...entry.observations].filter(([consumer]) => !consumer.aborted).map(([, listener]) => readScheduling(listener.scheduling))
              .sort((a, b) => a.priority - b.priority || (a.lane === b.lane ? 0 : a.lane === 'fast' ? -1 : 1))[0] ?? { priority: 100, lane: 'final' as const };
            return this.invoke(provider, { ...request, quality: 'accurate' }, controller.signal, false, { ...timeline.observation,
              scheduling: { priority: () => best().priority, lane: () => best().lane }, onPartial: (text) => {
              entry.partial = text;
              const owner = entry.previewOwner;
              if (owner && !owner.aborted) entry.observations.get(owner)?.onPartial?.(text, 0);
            } });
          }) };
          const entry: CombinedWork = work;
          // 被对冲/取消中断的工作不是服务失败；后续真正需要它时可以重试。
          void entry.promise.catch(() => { if (entry.controller.signal.aborted && pending.get(identity) === entry) pending.delete(identity); });
          pending.set(identity, work);
        } else this.measurement({ type: 'shared', providerId: provider.id, outcome: 'reused' });
        const entry = work;
        return new Promise<string>((resolve, reject) => {
          const unsubscribe = entry.timeline.subscribe(observation);
          const cleanup = (handoff = false) => {
            signal.removeEventListener('abort', abort); entry.consumers.delete(signal); entry.observations.delete(signal); unsubscribe();
            if (entry.previewOwner === signal) {
              entry.previewOwner = undefined;
              if (handoff) {
                const next = [...entry.observations].find(([candidate, listener]) => !candidate.aborted && listener.onPartial);
                if (next) { entry.previewOwner = next[0]; if (entry.partial !== undefined) next[1].onPartial?.(entry.partial, 0, true); }
              }
            }
          };
          const abort = () => { cleanup(true); if (!entry.consumers.size) entry.controller.abort(); reject(abortError()); };
          entry.consumers.add(signal);
          entry.observations.set(signal, observation);
          if (!entry.previewOwner && observation.onPartial) { entry.previewOwner = signal; if (entry.partial !== undefined) observation.onPartial(entry.partial, 0, true); }
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) { abort(); return; }
          void entry.promise.then((text) => { cleanup(); if (signal.aborted) reject(abortError()); else resolve(text); }, (error) => { cleanup(); reject(error); });
        });
      },
      finalOnly: (provider, version, accurateFirst) => accurateHedged ? accurateWinner === key(provider, version)
        : accurateProvider === key(provider, version)
          || (accurateProvider === undefined && accurateFirst?.id === provider.id && accurateFirst.version === provider.version),
      accurateAttempt: (hedged) => { accurateHedged = hedged; accurateWinner = undefined; },
      accurateWinner: (provider, version) => { accurateWinner = key(provider, version); },
    };
    return {
      translate: (tier: 'fast' | 'accurate', signal: AbortSignal, observer?: TranslationObserver) => disposed ? Promise.reject(abortError()) : this.translateScoped(job, segment, tier, signal, scope, observer),
      dispose: () => { disposed = true; for (const work of pending.values()) work.controller.abort(); pending.clear(); reads.clear(); },
    };
  }

  translate(job: TranslateJob, segment: Segment, tier: 'fast' | 'accurate', signal: AbortSignal, observer?: TranslationObserver) {
    return this.translateScoped(job, segment, tier, signal, undefined, observer);
  }

  private async translateScoped(job: TranslateJob, segment: Segment, tier: 'fast' | 'accurate', signal: AbortSignal, scope?: CombinedScope, observer?: TranslationObserver) {
    const started = performance.now();
    const trace = new TranslationTrace(observer);
    try {
      const value = await this.translateScopedWork(job, segment, tier, signal, trace, scope, observer);
      this.measurement({ type: 'logical', providerId: value.provider, tier, outcome: 'success', cached: value.cached, durationMs: performance.now() - started });
      return { ...value, timing: trace.finish(value.cached, value.provider) };
    } catch (error) {
      trace.finish();
      this.measurement({ type: 'logical', providerId: error instanceof ProviderError ? error.info.provider : undefined, tier, outcome: signal.aborted ? 'cancelled' : 'failure', durationMs: performance.now() - started });
      throw error;
    }
  }

  private async translateScopedWork(job: TranslateJob, segment: Segment, tier: 'fast' | 'accurate', signal: AbortSignal, trace: TranslationTrace, scope?: CombinedScope, observer?: TranslationObserver) {
    await this.ready();
    if (signal.aborted) throw abortError();
    const quality = !scope && job.mode === 'fast' ? 'fast' as const : 'accurate' as const;
    const sourceKey = await (scope ? scope.read('source-key', () => this.sourceKey(job.sourceLang, job.targetLang, segment.text)) : this.sourceKey(job.sourceLang, job.targetLang, segment.text));
    const cacheText = job.cacheNamespace ? `${job.cacheNamespace}\u0000${segment.text}` : segment.text;
    if (signal.aborted) throw abortError();
    if (!job.noCache) {
      const readMemory = () => this.auxiliaryRead(() => this.storage.tmGet(job.sourceLang, job.targetLang, segment.text));
      const memory = await (scope ? scope.read('memory', readMemory) : readMemory());
      if (signal.aborted) throw abortError();
      if (memory && !job.providerHint && validTranslation(segment.text, memory.text)) {
        this.precompute(job, segment, memory.text);
        return { ...memory, cached: true, ...(job.mode === 'combined' ? { finalOnly: true as const } : {}) };
      }
      // 综合模式优先精确缓存，避免先显示较差的旧译文。
      const tiers: ('fast' | 'accurate')[] = job.mode === 'combined' ? ['accurate', ...(tier === 'fast' ? ['fast' as const] : [])] : [tier];
      for (const cachedTier of tiers) {
        const readCache = () => this.auxiliaryRead(() => this.storage.cacheGet(job.sourceLang, job.targetLang, cachedTier, cacheText));
        const cached = await (scope ? scope.read(`cache:${cachedTier}`, readCache) : readCache());
        if (signal.aborted) throw abortError();
        const provider = cached && this.options.providers.find((p) => p.id === cached.provider);
        if (cached && provider && (provider.official || (this.available(provider) && !this.candidates(cachedTier, job).some((entry) => entry.official)))
          && cached.version === await this.cacheVersion(provider, segment.text, cachedTier === 'accurate' ? 'accurate' : quality) && (!job.providerHint || cached.provider === job.providerHint)
          && (job.providerHint || (this.bad.get(`${provider.id}:${sourceKey}`) ?? 0) <= this.now())
          && validTranslation(segment.text, cached.text)) {
          this.precompute(job, segment, cached.text);
          return { text: cached.text, provider: cached.provider, cached: true,
            ...(job.mode === 'combined' && cachedTier === 'accurate' ? { finalOnly: true as const } : {}) };
        }
      }
    }
    let error: ErrorInfo = { code: 'no_provider', message: tier === 'accurate' ? '请配置本地模型以使用精确模式' : '请在设置中配置至少一家翻译服务', retryable: false };
    const candidates = this.candidates(tier, job, scope).filter((provider) => job.providerHint || (this.bad.get(`${provider.id}:${sourceKey}`) ?? 0) <= this.now());
    const accurateCandidates = scope && tier === 'fast' ? this.candidates('accurate', job, scope).filter((provider) => job.providerHint || (this.bad.get(`${provider.id}:${sourceKey}`) ?? 0) <= this.now()) : [];
    const accurateFirst = accurateCandidates[0];
    if (!candidates.length) {
      const availableForMode = this.options.providers.filter((provider) => this.available(provider)
        && (!job.providerHint || provider.id === job.providerHint) && (job.providerHint || this.participates(provider, tier)));
      if (availableForMode.length && availableForMode.every((provider) => provider.supports?.(job.sourceLang, job.targetLang) === false)) {
        throw new ProviderError({ code: 'bad_input', message: `当前可用服务不支持从 ${job.sourceLang} 翻译到 ${job.targetLang}，请换服务或调整语言`, retryable: false });
      }
      const previous = this.options.providers.filter((provider) => this.configs[provider.id]?.enabled && this.configured(provider)
        && (!job.providerHint || provider.id === job.providerHint) && (job.providerHint || this.participates(provider, tier)))
        .map((provider) => ({ provider: provider.id, error: this.runtimes.get(provider.id)?.error })).filter((value) => value.error)
        .sort((a, b) => b.error!.at - a.error!.at)[0];
      if (previous?.error) error = { code: previous.error.code, message: previous.error.message, provider: previous.provider, retryable: previous.error.code !== 'auth' };
    }
    const request: ProviderRequest = { texts: [segment.text], sourceLang: job.sourceLang, targetLang: job.targetLang, quality, ...(tier === 'accurate' ? { context: job.context } : {}), ...(job.stream === true ? { stream: true } : {}) };
    const versions = new Map(await Promise.all(candidates.map(async (provider) => [provider.id, await this.cacheVersion(provider, segment.text, quality)] as const)));
    // 只有两档共同候选才提前使用精确上下文；仅快速档的接口不能额外收到页面标题或摘要。
    const sharedPrecise = (provider: ProviderDef) => provider.usedFor.some((mode) => mode === 'accurate' || mode === 'combined') && accurateCandidates.includes(provider);
    const invoke = (provider: ProviderDef, child: AbortSignal, preview = true) => {
      const observation: InvocationObservation = { ...trace.branch(provider.id, child, job.stream === true && preview,
        () => tier === 'fast' && sharedPrecise(provider) && scope?.finalOnly(provider, versions.get(provider.id)!, accurateFirst) === true),
        scheduling: { priority: () => observer?.priority?.() ?? job.priority, lane: () => tier === 'fast' ? 'fast' : 'final' } };
      return scope ? scope.invoke(provider, tier === 'fast' && sharedPrecise(provider) ? { ...request, context: job.context } : request,
        tier, versions.get(provider.id)!, child, observation) : this.invoke(provider, request, child, false, observation);
    };
    const enough = (provider: ProviderDef) => {
      if (!['mt', 'local', 'builtin'].includes(provider.kind)) return false;
      const quota = this.ledger.info(provider.id, this.quota(provider));
      const cost = provider.cost?.(request) ?? [...segment.text].length;
      return !quota || quota.amount - quota.used >= Math.max(cost * 2, quota.amount * 0.1);
    };
    for (let index = 0; index < candidates.length; index++) {
      let provider = candidates[index]!;
      try {
        let text: string;
        const second = candidates[index + 1];
        const hedged = job.priority === 0 && !job.providerHint && second !== undefined && this.fallbackGroup(provider, tier) === this.fallbackGroup(second, tier)
          && enough(provider) && enough(second);
        if (tier === 'accurate') scope?.accurateAttempt(hedged);
        if (hedged && second) {
          index++;
          const first = provider;
          const delay = Math.max(300, percentile(this.runtimes.get(first.id)!.latencies, 0.9) ?? 300);
          const winner = await raceWithHedge(
            async (child) => ({ text: await invoke(first, child), provider: first }),
            async (child) => ({ text: await invoke(second, child, false), provider: second }), delay, signal);
          text = winner.text; provider = winner.provider;
        } else text = await invoke(provider, signal);
        if (signal.aborted) throw abortError();
        if (tier === 'accurate') scope?.accurateWinner(provider, versions.get(provider.id)!);
        const finalOnly = tier === 'fast' && sharedPrecise(provider) && scope?.finalOnly(provider, versions.get(provider.id)!, accurateFirst) === true;
        const cacheTier = finalOnly ? 'accurate' : tier;
        if (!job.noCache) {
          try { if (await this.auxiliaryStorage()) await this.storage.cachePut(job.sourceLang, job.targetLang, cacheTier, cacheText, { text, provider: provider.id, version: versions.get(provider.id)! }); }
          catch { this.auxiliaryReady = false; this.auxiliaryRetryAt = this.now() + 30_000; this.auxiliaryWarning(true); }
        }
        // “换一家”只作用于本次任务，不能改写普通任务的页面粘性。
        if (!job.providerHint) this.sticky.set(`${tier}:${job.context.url}`, { provider: provider.id, at: this.now() });
        while (this.sticky.size > 500) this.sticky.delete(this.sticky.keys().next().value!);
        this.precompute(job, segment, text);
        return { text, provider: provider.id, cached: false, ...(finalOnly ? { finalOnly: true as const } : {}) };
      } catch (caught) {
        if (signal.aborted) throw abortError();
        error = caught instanceof ProviderError ? caught.info : provider.classifyError(caught);
        this.event('warn', `${provider.name}不可用，尝试下一服务`, provider.id);
      }
    }
    throw new ProviderError(error);
  }

  private slot(provider: ProviderDef, signal: AbortSignal, scheduling?: BatchScheduling): Promise<ProviderLease> {
    return this.slots.acquire(provider.id, { runtime: () => this.runtimes.get(provider.id),
      limits: () => this.options.providers.find((entry) => entry.id === provider.id)?.limits ?? provider.limits,
      allowed: (manual) => {
        const config = this.configs[provider.id];
        if ((config?.template === 'custom-http' || provider.id === 'deepl') && !this.options.providers.includes(provider)) return false;
        return !!config && this.configured(provider) && (manual || config.enabled && !config.paused && (provider.official || this.allowUnofficial));
      } }, signal, scheduling);
  }

  private context(provider: ProviderDef, signal: AbortSignal): ProviderContext {
    const context: ProviderContext = {
      config: this.config(provider), signal, log: () => undefined,
      ...(provider.kind === 'builtin' && this.options.builtin ? { builtin: this.options.builtin } : {}),
      recordTiming: (timing) => {
        try { this.measurement({ type: 'model', providerId: provider.id, phase: 'model', promptMs: timing.promptMs, generationMs: timing.generationMs, promptTokens: timing.promptTokens, outputTokens: timing.outputTokens }); }
        catch { /* 不读取或转发诊断对象的其他内容。 */ }
      },
      fetch: async (input, init = {}) => {
        const { timeoutMs: adapterTimeout = 15_000, streamResponse = false, signal: requestSignal, ...request } = init;
        const timeoutMs = this.configs[provider.id]?.options?.timeoutMs ?? adapterTimeout;
        const controller = new AbortController();
        const abort = () => controller.abort();
        const signals = requestSignal ? [signal, requestSignal] : [signal];
        for (const source of signals) source.addEventListener('abort', abort, { once: true });
        if (signals.some((source) => source.aborted)) controller.abort();
        const httpStarted = performance.now();
        let finished = false, streamAbort: (() => void) | undefined;
        const finish = (outcome: 'success' | 'failure' | 'cancelled') => {
          if (finished) return;
          finished = true; clearTimeout(timer);
          if (streamAbort) controller.signal.removeEventListener('abort', streamAbort);
          for (const source of signals) source.removeEventListener('abort', abort);
          try { context.onRequestEnd?.(); } catch { /* 时序回调不改变真实请求。 */ }
          this.measurement({ type: 'http', providerId: provider.id, outcome, durationMs: performance.now() - httpStarted });
        };
        const cancelledOutcome = () => signals.some((source) => source.aborted) ? 'cancelled' as const : 'failure' as const;
        const timer = setTimeout(abort, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000);
        try {
          controller.signal.throwIfAborted();
          try { context.onRequestStart?.(); } catch { /* 批次统计异常不阻断HTTP。 */ }
          const response = await this.fetcher(input, { ...request, credentials: 'omit', redirect: 'error', signal: controller.signal });
          const successful = () => response.ok ? 'success' as const : 'failure' as const;
          const metadata = { status: response.status, statusText: response.statusText, headers: response.headers };
          if (!response.body || [204, 205, 304].includes(response.status)) { finish(successful()); return new Response(null, metadata); }
          const reader = response.body.getReader();
          // 同一个受控body用于JSON和SSE；timer/取消一直保留到消费EOF、错误或cancel。
          const body = new ReadableStream<Uint8Array>({
            start: (output) => {
              streamAbort = () => {
                void reader.cancel().catch(() => undefined);
                try { output.error(abortError()); } catch { /* 已取消/关闭的body无需再次报错。 */ }
                finish(cancelledOutcome());
              };
              controller.signal.addEventListener('abort', streamAbort, { once: true });
              if (controller.signal.aborted) streamAbort();
            },
            pull: async (output) => {
              try {
                controller.signal.throwIfAborted();
                const part = await reader.read();
                controller.signal.throwIfAborted();
                if (part.done) { output.close(); finish(successful()); }
                else output.enqueue(part.value);
              } catch (error) {
                void reader.cancel().catch(() => undefined);
                try { output.error(error); } catch { /* body可能已被取消。 */ }
                finish(cancelledOutcome());
              }
            },
            cancel: async (reason) => {
              // 适配器读到DONE后主动cancel是正常消费结束；外部取消和超时仍独立归类。
              finish(controller.signal.aborted ? cancelledOutcome() : successful());
              controller.abort();
              await reader.cancel(reason).catch(() => undefined);
            },
          });
          const guarded = new Response(body, metadata);
          return streamResponse ? guarded : new Response(await guarded.arrayBuffer(), metadata);
        } catch (error) {
          finish(cancelledOutcome()); throw error;
        }
      },
    };
    return context;
  }

  private async invoke(provider: ProviderDef, request: ProviderRequest, signal: AbortSignal, manual = false, observation?: InvocationObservation): Promise<string> {
    const text = request.texts[0];
    if (typeof text !== 'string') throw new ProviderError({ code: 'bad_input', message: '翻译片段格式无效', retryable: false, provider: provider.id });
    if (text.length > provider.limits.maxChars) {
      const chunks = splitTranslationText(text, provider.limits.maxChars, request.sourceLang);
      if (chunks.every((chunk) => validTranslation(chunk, chunk))) {
        let combined = '';
        for (const chunk of chunks) {
          signal.throwIfAborted();
          if (!/[\p{L}\p{N}]/u.test(chunk)) { combined += chunk; continue; }
          const translated = await this.invoke(provider, { ...request, texts: [chunk], quality: hasPlaceholders(text) ? 'accurate' : request.quality }, signal, manual,
            observation && { ...observation, ...(observation.onPartial ? { onPartial: (text, index) => observation.onPartial!(combined + (chunk.match(/^\s*/)?.[0] ?? '') + text, index) } : {}) });
          combined += (chunk.match(/^\s*/)?.[0] ?? '') + translated.trim() + (chunk.match(/\s*$/)?.[0] ?? '');
        }
        if (!validTranslation(text, combined)) throw new ProviderError({ code: 'placeholder', message: '长段落重组未通过校验', provider: provider.id, retryable: false });
        return combined;
      }
      if ((provider.kind === 'local' || provider.kind === 'builtin' || !provider.official) && hasPlaceholders(text)) {
        const projected = await this.projectTranslation(provider, request, signal, manual, observation);
        if (projected !== null) return projected;
      }
      // 超长片段按文本叶子切分，标签始终留在本地，拼接时不会重复标签编号。
      const pieces = text.split(/(<\/?[gx]\d+\/?>)/);
      let result = '';
      for (const piece of pieces) {
        if (/^<\/?[gx]\d+\/?>$/.test(piece) || !piece.trim()) { result += piece; continue; }
        let chunk = '';
        for (const character of piece) {
          if (chunk.length + character.length > provider.limits.maxChars) { result += await this.invoke(provider, { ...request, texts: [chunk], stream: false, quality: 'accurate' }, signal, manual, withoutPreview(observation)); chunk = ''; }
          chunk += character;
        }
        if (chunk) result += await this.invoke(provider, { ...request, texts: [chunk], stream: false, quality: 'accurate' }, signal, manual, withoutPreview(observation));
      }
      if (!validTranslation(text, result)) throw new ProviderError({ code: 'placeholder', message: '长段落的占位符校验失败', provider: provider.id, retryable: false });
      return result;
    }
    const started = performance.now();
    try {
      // 字符预算先逐片段预留，QPS 和并发只限制实际合并后的 HTTP 请求。
      if (!this.available(provider, manual)) throw new ProviderError({ code: 'no_provider', message: '服务当前不可用或免费预算不足', provider: provider.id, retryable: true });
      if (this.nestedProjection(provider, text)) {
        // 本地嵌套标签即使结构合法也可能绑错词；直接保留本地结构，不先浪费两次带标请求。
        const projected = await this.projectTranslation(provider, request, signal, manual, observation);
        if (projected !== null) { this.success(provider, performance.now() - started, manual); return projected; }
        const restored = await translateTextLeaves(text, (leaf) => this.invoke(provider, { ...request, texts: [leaf], strictPlaceholders: false, stream: false, quality: 'accurate' }, signal, manual, withoutPreview(observation)), signal,
          { onDiagnostic: (record) => this.placeholderMeasurement(provider, record) });
        this.success(provider, performance.now() - started, manual);
        return restored;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted) throw abortError();
        const cost = provider.cost?.(request) ?? [...text].length;
        // 等槽只占临时预算；已发批次失败/取消仍保守计费，未发取消不进入同步计数。
        const reservation = await reserveQuotas(this.ledger, provider.id, [this.quota(provider), this.accountQuota.definition(provider, true)], cost);
        let result: string[];
        try {
          result = await this.batcher.request(provider, { ...request, strictPlaceholders: attempt > 0 }, signal,
            (batchSignal) => this.context(provider, batchSignal), observation && { ...observation, onRequestStart: (at) => {
              observation.onRequestStart?.(at); if (observation.retryState?.active || attempt > 0) observation.onRetry?.();
            } }, { priority: observation?.scheduling?.priority ?? (() => 0), lane: observation?.scheduling?.lane ?? (() => 'final'), manual: () => manual }, reservation);
        } catch (caught) {
          const info = caught instanceof ProviderError ? caught.info : provider.classifyError(caught);
          if (info.code !== 'placeholder') throw caught;
          result = [];
        } finally {
          try { await reservation?.release(); }
          catch { this.event('warn', '额度提交暂未完成，已保留本机发送预备记录以便恢复', provider.id); }
        }
        if (signal.aborted) throw abortError();
        if (Array.isArray(result) && result.length === 1 && !validTranslation(text, result[0])) {
          // 仅补原文已有且丢失的x节点；其余结构错误继续严格重试，避免为保留公式重新翻整段。
          const restored = restoreMissingAtoms(text, result[0]!);
          if (restored !== undefined) result = [restored];
        }
        if (Array.isArray(result) && result.length === 1 && validTranslation(text, result[0])) {
          this.success(provider, performance.now() - started, manual);
          return result[0];
        }
        if (observation?.retryState) observation.retryState.active = true;
        if (attempt === 1 || request.quality === 'fast' && ['local', 'builtin'].includes(provider.kind)) {
          if (hasPlaceholders(text)) {
            if (provider.kind === 'local' || provider.kind === 'builtin' || !provider.official) {
              const projected = await this.projectTranslation(provider, request, signal, manual, observation);
              if (projected !== null) { this.success(provider, performance.now() - started, manual); return projected; }
            }
            const restored = await translateTextLeaves(text, (leaf) => this.invoke(provider, { ...request, texts: [leaf], strictPlaceholders: false, stream: false, quality: 'accurate' }, signal, manual, withoutPreview(observation)), signal, { onDiagnostic: (record) => this.placeholderMeasurement(provider, record) });
            this.success(provider, performance.now() - started, manual);
            return restored;
          }
          throw new ProviderError({ code: 'placeholder', message: '翻译结果未通过占位符校验', provider: provider.id, retryable: false });
        }
      }
      throw new Error('unreachable');
    } catch (caught) {
      if (signal.aborted) throw abortError();
      const info = { ...(caught instanceof ProviderError ? caught.info : provider.classifyError(caught)), provider: provider.id };
      // 投影/叶子递归会再次经过这里，同一个真实失败不能在父调用再累加一次熔断。
      if (!(caught instanceof QuotaReservationError) && !(caught instanceof ProviderError && this.recordedFailures.has(caught))) await this.failure(provider, info, manual);
      const failure = new ProviderError(info); this.recordedFailures.add(failure);
      throw failure;
    }
  }

  private precompute(job: TranslateJob, segment: Segment, text: string) {
    if (!job.noCache) { try { this.options.onTranslated?.(job, segment, text); } catch { /* 辅助预计算不阻塞缓存命中或翻译完成 */ } }
  }

  private async projectTranslation(provider: ProviderDef, request: ProviderRequest, signal: AbortSignal, manual: boolean, observation?: InvocationObservation) {
    try {
      return await translateWithProjectedPlaceholders(request.texts[0]!,
        (text, terminology, purpose) => {
          const preview = purpose === 'plain' && !/<x\d+\/>/.test(request.texts[0]!);
          return this.invoke(provider, { ...request, texts: [text], strictPlaceholders: false, stream: preview && request.stream === true, quality: 'accurate',
            ...(terminology?.length ? { terminology } : {}) }, signal, manual, preview ? observation : withoutPreview(observation));
        },
        { sourceLang: request.sourceLang, targetLang: request.targetLang, align: this.options.align, strategy: provider.kind === 'local' ? 'lazy' : 'anchored', semanticNesting: this.nestedProjection(provider, request.texts[0]!), onDiagnostic: (record) => this.placeholderMeasurement(provider, record),
          lookup: this.options.lookup ? (word) => this.options.lookup!(word, request.sourceLang === 'auto' ? 'en' : request.sourceLang, request.targetLang) : undefined }, signal);
    } catch (error) {
      signal.throwIfAborted();
      // 辅助锚点本身格式不合法时仍保留最终安全降级；网络等真实故障继续上报。
      if (error instanceof ProviderError && error.info.code === 'placeholder') return null;
      throw error;
    }
  }

  private success(provider: ProviderDef, latency: number, diagnostic = false) {
    if (!this.currentAccountResult(provider)) return;
    const runtime = this.runtimes.get(provider.id);
    if (!runtime) return;
    runtime.failures = 0; runtime.cooldown = 0; runtime.error = undefined; runtime.probeError = undefined; runtime.backoff = 0;
    // 检测仍更新真实健康状态和额度，但短样例不能改变正文调度评分。
    if (!diagnostic) {
      runtime.ewma = runtime.ewma === undefined ? latency : runtime.ewma * 0.7 + latency * 0.3;
      runtime.latencies = [...runtime.latencies, Math.round(latency)].slice(-50);
      runtime.attempts = [...runtime.attempts, true].slice(-50);
    }
    if (provider.kind === 'local') this.updateNode(provider, true);
    this.changed();
  }
  private async failure(provider: ProviderDef, info: ErrorInfo, diagnostic = false) {
    if (!this.currentAccountResult(provider)) return;
    const runtime = this.runtimes.get(provider.id);
    if (!runtime) return;
    const infrastructure = ['network', 'server', 'rate_limit', 'auth', 'quota'].includes(info.code);
    if (infrastructure) runtime.failures++;
    runtime.error = { code: info.code, message: info.message, at: this.now() };
    if (!diagnostic && !(provider.kind === 'builtin' && info.code === 'no_provider')) runtime.attempts = [...runtime.attempts, false].slice(-50);
    if (info.code === 'quota') {
      await this.ledger.exhaust(provider.id, this.accountQuota.definition(provider) ?? this.quota(provider));
      // 旧账户的耗尽计数可以落盘；等待期间换密钥后不能再把冷却状态写到新账户。
      if (!this.currentAccountResult(provider)) return;
      runtime.exhaustedUntil = this.quotaInfo(provider)?.resetAt ?? this.now() + 86_400_000;
    } else if (info.code === 'rate_limit' && !provider.official) {
      // 网页接口的 429 不自动循环重试；持久暂停，直到用户明确恢复。
      this.configs[provider.id]!.paused = true;
      runtime.cooldown = Number.POSITIVE_INFINITY;
      await this.persistConfigs();
    } else if (info.code === 'auth') runtime.cooldown = Number.POSITIVE_INFINITY;
    else if (info.code === 'rate_limit' || (infrastructure && runtime.failures >= 3)) {
      runtime.backoff = (runtime.backoff ?? 0) + 1;
      runtime.cooldown = this.now() + Math.min(300_000, 30_000 * 2 ** (runtime.backoff - 1));
    }
    if (provider.kind === 'local' && infrastructure) this.updateNode(provider, false);
    this.changed(true);
  }
  private updateNode(provider: ProviderDef, online: boolean, model?: string) {
    const old = this.nodes.find((node) => node.id === provider.id);
    const node: StatusSnapshot['nodes'][number] = { id: provider.id, name: provider.name, location: 'local', online, models: model ? [{ id: model, loaded: true }] : old?.models ?? [] };
    if (!online) node.lastError = { message: '本地模型未连接，请启动 llama-server', at: this.now() };
    this.nodes = [...this.nodes.filter((entry) => entry.id !== provider.id), node];
  }

  async list(): Promise<ProviderInfo[]> {
    await this.ready();
    return this.options.providers.map((provider) => {
      const config = this.config(provider);
      for (const field of provider.auth) if (field.secret && config[field.key]) config[field.key] = MASK;
      const quota = this.quota(provider);
      const saved = this.configs[provider.id]!;
      const metadata = providerMetadata(this.originals.get(provider.id)!, saved.template);
      const template = saved.template ?? providerTemplate(this.originals.get(provider.id)!);
      return { id: provider.id, name: provider.name, kind: provider.kind, official: provider.official, enabled: this.configs[provider.id]!.enabled,
        configured: this.configured(provider), auth: provider.auth.filter((field) => !(field.key === 'url' && metadata.editable.includes('endpoint')) && !(field.key === 'model' && metadata.editable.includes('model'))), config,
        ...(provider.quotaText ? { quotaText: provider.quotaText + (this.accountQuota.definition(provider) ? `；账户当前上限 ${this.accountQuota.definition(provider)!.amount.toLocaleString()} 字符（含付费/成本控制，以账户为准）` : '') }
          : quota ? { quotaText: `${quota.amount.toLocaleString()} ${quota.unit === 'char' ? '字符' : 'token'}/${quota.period === 'day' ? '天' : '月'}` } : {}),
        usedFor: provider.usedFor.slice(), adapter: { file: `src/backend/providers/${provider.official ? '' : 'unofficial/'}${template ?? provider.id}.ts`, version: this.originals.get(provider.id)!.version },
        ...metadata, options: structuredClone(saved.options ?? {}), ...(saved.custom ? { custom: true, template: saved.template } : {}) };
    });
  }
  async save(id: string, enabled: boolean, incoming: Record<string, string>, options?: ProviderOptions, name?: string) {
    await this.ready();
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming) || typeof enabled !== 'boolean') throw new ProviderError({ code: 'bad_input', message: '服务配置格式无效', retryable: false });
    const provider = this.definition(id);
    const base = this.originals.get(id)!;
    const editable = providerMetadata(base, this.configs[id]!.template).editable;
    const migrated = { ...this.configs[id]!.options };
    if (options === undefined) {
      if (editable.includes('endpoint') && Object.hasOwn(incoming, 'url')) migrated.endpoint = incoming.url;
      if (editable.includes('model') && Object.hasOwn(incoming, 'model')) migrated.model = incoming.model;
    }
    const advanced = normalizeOptions(base, options ?? migrated, this.configs[id]!.template);
    const savedName = this.configs[id]!.custom && name !== undefined ? this.providerName(name) : this.configs[id]!.name;
    const previous = this.config(provider);
    const config: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const field of provider.auth) {
      let value = incoming[field.key] ?? previous[field.key] ?? '';
      if (typeof value !== 'string') throw new ProviderError({ code: 'bad_input', message: '服务配置必须为文本', retryable: false });
      if (field.secret && value === MASK) value = previous[field.key] ?? '';
      if (field.type === 'url' && value) {
        let url: URL;
        try { url = new URL(value); } catch { throw new ProviderError({ code: 'bad_input', message: '服务地址格式不正确', retryable: false }); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ProviderError({ code: 'bad_input', message: '服务地址只能使用无附加凭据的 HTTP(S) 地址', retryable: false });
      }
      (field.secret ? secrets : config)[field.key] = value;
    }
    if (editable.includes('endpoint')) delete config.url;
    if (editable.includes('model')) delete config.model;
    validateProviderConfig(this.originals.get(id)!, providerConfig(provider, { ...provider.defaults, ...config, ...secrets }, advanced));
    await this.vault.set(id, secrets);
    this.secrets.set(id, secrets);
    this.configs[id] = { ...this.configs[id], enabled, config, options: advanced, ...(savedName ? { name: savedName } : {}) };
    if (id === 'deepl') this.options.providers = this.options.providers.map((entry) => entry.id === id ? this.effective(id) : entry);
    if (await this.accountQuota.configure(provider, this.config(provider))) this.resetAccountRuntime(id);
    if (!provider.official) {
      // 现有设置页的单家启用开关就是明确选择；同时维护原有全局默认关闭约定。
      this.allowUnofficial = this.options.providers.some((entry) => !entry.official && this.configs[entry.id]?.enabled);
      const storedCore = (await chrome.storage.local.get('settings.core'))['settings.core'];
      await chrome.storage.local.set({ 'settings.core': { ...(storedCore && typeof storedCore === 'object' ? storedCore : {}), version: 1, allowUnofficial: this.allowUnofficial } });
    }
    this.options.providers = this.options.providers.map((entry) => entry.id === id ? this.effective(id) : entry);
    const runtime = this.runtimes.get(id)!;
    runtime.cooldown = 0; runtime.failures = 0; runtime.error = undefined; runtime.exhaustedUntil = undefined; runtime.secretsError = false;
    await this.persistConfigs();
    this.changed();
    return { ok: true as const };
  }
  async add(template: ProviderTemplate, name: string): Promise<ProviderInfo> {
    await this.ready();
    const id = 'custom-' + crypto.randomUUID();
    const provider = cloneProvider(template, id, this.providerName(name));
    this.originals.set(id, provider); this.options.providers.push(provider); this.runtimes.set(id, this.newRuntime()); this.secrets.set(id, {});
    this.configs[id] = { enabled: false, config: {}, options: {}, custom: true, template, name: provider.name };
    try { await this.persistConfigs(); }
    catch (error) { this.originals.delete(id); this.options.providers = this.options.providers.filter((entry) => entry.id !== id); this.runtimes.delete(id); this.secrets.delete(id); delete this.configs[id]; throw error; }
    this.changed(); return (await this.list()).find((entry) => entry.id === id)!;
  }
  async remove(id: string) {
    await this.ready(); this.definition(id);
    if (!this.configs[id]?.custom || !id.startsWith('custom-')) throw new ProviderError({ code: 'bad_input', message: '内置翻译服务不能删除', retryable: false });
    const runtime = this.runtimes.get(id)!;
    if (runtime.active) throw new ProviderError({ code: 'bad_input', message: '该服务仍有翻译请求，请等待完成后再删除', retryable: true });
    this.configs[id]!.enabled = false;
    await this.vault.remove(id); await this.ledger.remove(id);
    const syncMetadata = (await chrome.storage.local.get('backend.sync.document'))['backend.sync.document'];
    if (syncMetadata && typeof syncMetadata === 'object' && !Array.isArray(syncMetadata)) {
      const document = structuredClone(syncMetadata) as { usage?: Record<string, unknown> };
      if (document.usage && Object.hasOwn(document.usage, id)) { delete document.usage[id]; await chrome.storage.local.set({ 'backend.sync.document': document }); }
    }
    this.options.providers = this.options.providers.filter((entry) => entry.id !== id);
    this.originals.delete(id); this.runtimes.delete(id); this.secrets.delete(id); delete this.configs[id];
    this.nodes = this.nodes.filter((node) => node.id !== id);
    for (const [key, value] of this.sticky) if (value.provider === id) this.sticky.delete(key);
    await this.persistConfigs(); this.changed(); return { ok: true as const };
  }
  async models(id: string, endpoint?: string, incoming?: Record<string, string>): Promise<string[]> {
    await this.ready();
    const provider = this.definition(id), template = providerTemplate(this.originals.get(id)!);
    if (!template || template === 'libretranslate' || template === 'custom-http') throw new ProviderError({ code: 'bad_input', message: '该服务不支持查询模型列表', retryable: false });
    if (endpoint !== undefined && typeof endpoint !== 'string') throw new ProviderError({ code: 'bad_input', message: '模型列表地址格式无效', retryable: false });
    if (incoming !== undefined && (!incoming || typeof incoming !== 'object' || Array.isArray(incoming) || Object.values(incoming).some((value) => typeof value !== 'string'))) throw new ProviderError({ code: 'bad_input', message: '模型列表凭据格式无效', retryable: false });
    const saved = this.config(provider);
    const target = validateEndpoint(endpoint || incoming?.url || saved.url || '');
    if (!target) throw new ProviderError({ code: 'bad_input', message: '请先填写模型服务地址', retryable: false });
    let sameOrigin = false;
    try { sameOrigin = new URL(target).origin === new URL(saved.url ?? '').origin; } catch { /* 新服务没有旧地址 */ }
    const credential = (field: string) => {
      const value = incoming?.[field];
      return value !== undefined && value !== MASK ? value : sameOrigin ? saved[field] ?? '' : '';
    };
    const secret = template === 'remote-node' ? credential('token') : credential('key');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    const controller = new AbortController();
    let rejectTimeout: (reason: unknown) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => { controller.abort(); rejectTimeout(new ProviderError({ code: 'network', message: '查询模型列表超过 5 秒', retryable: true })); }, 5000);
    const read = async (path: string) => {
      const response = await Promise.race([this.fetcher(path, { headers, credentials: 'omit', redirect: 'error', signal: controller.signal }), deadline]);
      const limit = 2 * 1024 * 1024;
      if (Number(response.headers.get('Content-Length')) > limit) { await response.body?.cancel(); throw new ProviderError({ code: 'server', message: '模型列表响应过大', retryable: false }); }
      if (!response.ok) throw new ProviderError({ code: response.status === 401 || response.status === 403 ? 'auth' : 'server', message: `模型列表接口返回 HTTP ${response.status}`, retryable: response.status >= 500 });
      const reader = response.body?.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0, body = '';
      try {
        if (reader) while (true) {
          const chunk = await Promise.race([reader.read(), deadline]);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > limit) throw new ProviderError({ code: 'server', message: '模型列表响应过大', retryable: false });
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
        try { return JSON.parse(body) as unknown; } catch { throw new ProviderError({ code: 'server', message: '模型列表不是有效 JSON', retryable: false }); }
      } finally { void reader?.cancel().catch(() => undefined); reader?.releaseLock(); }
    };
    try {
      const base = target.replace(/\/+$/, '').replace(/\/v1$/, '');
      let value: unknown;
      if (template === 'remote-node') value = await read(base + '/v1/health');
      else {
        try { value = await read(base + '/v1/models'); }
        catch (error) {
          if (template !== 'openai-compatible' || !(error instanceof ProviderError) || error.info.code === 'auth' || controller.signal.aborted) throw error;
          value = await read(base + '/api/tags');
        }
      }
      if (!value || typeof value !== 'object') throw new ProviderError({ code: 'server', message: '模型列表结构异常', retryable: false });
      const result = value as { data?: unknown; models?: unknown };
      const rows = template === 'remote-node' ? result.models : result.data ?? result.models;
      if (!Array.isArray(rows) || rows.length > 10_000) throw new ProviderError({ code: 'server', message: '模型列表结构异常', retryable: false });
      const models = rows.map((entry: unknown) => entry && typeof entry === 'object' ? (entry as { id?: unknown; name?: unknown; model?: unknown }).id ?? (entry as { name?: unknown }).name ?? (entry as { model?: unknown }).model : undefined);
      if (models.some((model) => typeof model !== 'string' || !model.trim() || model.length > 500)) throw new ProviderError({ code: 'server', message: '模型名称格式异常', retryable: false });
      return [...new Set(models as string[])].sort();
    } catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError({ code: 'network', message: '模型列表连接失败', retryable: true }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  private persistConfigs() {
    const configs = structuredClone(this.configs);
    const next = this.writes.then(() => chrome.storage.local.set({ 'backend.providers': configs }));
    this.writes = next.catch(() => undefined);
    return next;
  }
  async action(id: string, action: 'pin' | 'unpin' | 'pause' | 'resume') {
    await this.ready(); this.definition(id);
    const config = this.configs[id]!;
    if (action === 'pin' || action === 'unpin') config.pinned = action === 'pin';
    else if (action === 'pause' || action === 'resume') config.paused = action === 'pause';
    if (action === 'resume' && !this.definition(id).official) {
      const runtime = this.runtimes.get(id)!; runtime.cooldown = 0; runtime.failures = 0; runtime.backoff = 0;
    }
    await this.persistConfigs(); this.changed();
  }
  async test(id: string, options: { prepare?: boolean; sourceLang?: string; targetLang?: string } = {}) {
    await this.ready();
    const provider = this.definition(id);
    if (!this.configured(provider)) return { ok: false, error: { code: 'auth' as const, message: '请先填写服务配置', retryable: false, provider: id } };
    const runtime = this.runtimes.get(id)!;
    runtime.cooldown = 0;
    const pair = diagnosticPair(options.sourceLang ?? (provider.kind === 'builtin' ? 'auto' : 'en'), options.targetLang ?? 'zh-CN');
    const start = performance.now();
    try {
      if (pair.sourceLang !== 'auto' && pair.sourceLang.toLowerCase() === pair.targetLang.toLowerCase()) throw new ProviderError({ code: 'bad_input', message: '检测的原文语言和译文语言相同，请选择不同方向', retryable: false });
      const sample = provider.kind !== 'builtin' && options.sourceLang === undefined && options.targetLang === undefined ? 'Hello.' : diagnosticSample(pair.sourceLang, pair.targetLang);
      if (provider.kind === 'builtin') this.options.builtin?.invalidate?.(pair.sampleLang, pair.targetLang);
      await this.invoke(provider, { texts: [sample], sourceLang: pair.sourceLang, targetLang: pair.targetLang }, new AbortController().signal, true);
      return { ok: true, latencyMs: Math.round(performance.now() - start) };
    } catch (error) {
      let info = { ...(error instanceof ProviderError ? error.info : provider.classifyError(error)), provider: id };
      if (options.prepare !== false && provider.kind === 'builtin' && info.code === 'no_provider' && this.options.builtin && this.options.openBuiltinSetup) {
        try {
          const state = await this.options.builtin.availability(pair.sampleLang, pair.targetLang, new AbortController().signal);
          if ([state.status, state.detectorStatus].some((status) => status === 'downloadable' || status === 'downloading')) {
            await this.options.openBuiltinSetup(pair.sampleLang, pair.targetLang);
            info = { ...info, message: '已打开浏览器内置翻译的语言包设置。此次检测方向为 ' + pair.sampleLang + ' → ' + pair.targetLang + '；请下载对应语言包后再试，其他可用服务不受影响' };
          }
        } catch { /* 准备窗口打不开时保留真实不可用原因，不影响其他服务。 */ }
      }
      return { ok: false, error: info };
    }
  }
  async probe(id?: string) {
    await this.ready();
    const settings = await loadUiSettings();
    const pair = diagnosticPair(settings.sourceLang, settings.targetLang);
    for (const provider of id ? [this.definition(id)] : this.options.providers.filter((p) => p.official && this.configs[p.id]?.enabled && !this.configs[p.id]?.paused && this.configured(p))) {
      if (provider.health) {
        const accountCheck = this.accountQuota.begin(provider);
        try {
          if (!this.configured(provider)) throw new ProviderError({ code: 'auth', message: '请先填写服务配置', retryable: false });
          const context = this.context(provider, new AbortController().signal);
          if (provider.kind === 'builtin') {
            this.options.builtin?.invalidate?.();
            context.config = { ...context.config, probeSourceLang: pair.sampleLang, probeTargetLang: pair.targetLang };
          }
          const health = await provider.health(context);
          if (!health.ok) throw new ProviderError({ code: 'server', message: '服务健康检查失败', retryable: true });
          if (provider.id === 'deepl') {
            if (!await this.accountQuota.accept(provider, accountCheck, health)) continue;
            if (this.quotaAvailable(provider)) this.runtimes.get(provider.id)!.exhaustedUntil = undefined;
          } else if (health.amount !== undefined && Number.isFinite(health.amount) && health.amount >= 0) this.runtimes.get(provider.id)!.quotaAmount = health.amount;
          // /health只证明连通性，不代表真实生成成功，也不能覆盖翻译熔断/耗时样本。
          this.runtimes.get(provider.id)!.probeError = undefined;
          if (provider.id !== 'deepl') await this.ledger.calibrate(provider.id, this.quota(provider), health.used);
          if (provider.kind === 'local') this.updateNode(provider, true, health.model);
          if (health.node) this.nodes = [...this.nodes.filter((node) => node.id !== provider.id), { id: provider.id, name: provider.name, ...health.node }];
        } catch (error) {
          if (accountCheck && !this.accountQuota.current(accountCheck)) continue;
          const info = error instanceof ProviderError ? error.info : provider.classifyError(error);
          const runtime = this.runtimes.get(provider.id);
          if (runtime) runtime.probeError = { code: info.code, message: info.message, at: this.now() };
          if (provider.kind === 'local') this.updateNode(provider, false);
          this.changed(true);
        }
      } // 没有只读健康接口时跳过；自动同步不能偷偷产生付费试译。
    }
    this.changed();
  }
  snapshot(): StatusSnapshot {
    const ranked = this.options.providers.filter((p) => this.available(p)).sort((a, b) => this.fallbackGroup(a, 'fast') - this.fallbackGroup(b, 'fast') || this.score(a) - this.score(b));
    const providers: ProviderStatus[] = this.options.providers.map((provider) => {
      const config = this.configs[provider.id];
      const runtime = this.runtimes.get(provider.id)!;
      const quota = this.quotaInfo(provider);
      const enabled = config?.enabled ?? false;
      const configured = this.configured(provider);
      const health: ProviderStatus['health'] = !enabled || config?.paused ? 'disabled' : !configured ? 'unconfigured'
        : !this.quotaAvailable(provider) || (runtime.exhaustedUntil ?? 0) > this.now() ? 'exhausted'
        : runtime.error || runtime.probeError ? runtime.cooldown === Infinity ? 'error' : 'degraded' : 'ok';
      const rank = ranked.indexOf(provider) + 1;
      const circuit: ProviderStatus['circuit'] = runtime.cooldown > this.now() ? 'open' : runtime.halfOpen || runtime.failures >= 3 ? 'half-open' : 'closed';
      return { id: provider.id, name: provider.name, kind: provider.kind, official: provider.official, enabled, configured, health,
        active: runtime.active > 0, rank: rank || null, latencyP50Ms: percentile(runtime.latencies),
        successRate: runtime.attempts.length ? runtime.attempts.filter(Boolean).length / runtime.attempts.length : undefined,
        quota, lastError: runtime.error ?? runtime.probeError, adapter: { file: `src/backend/providers/${provider.official ? '' : 'unofficial/'}${providerTemplate(this.originals.get(provider.id)!) ?? provider.id}.ts`, version: this.originals.get(provider.id)!.version }, usedFor: provider.usedFor,
        pinned: config?.pinned ?? false, circuit,
        ...(Number.isFinite(runtime.cooldown) && runtime.cooldown > this.now() ? { cooldownUntil: runtime.cooldown } : {}) };
    }).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    return { at: this.now(), providers, nodes: structuredClone(this.nodes), events: this.events.slice(0, 50), perf: { firstScreenMsP50: percentile(this.perf), samples: this.perf.length }, sync: this.options.syncStatus?.() };
  }
  subscribe(callback: (immediate?: boolean) => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  private changed(immediate = false) { this.slots.wake(); for (const callback of this.listeners) callback(immediate); }
  private event(level: StatusEvent['level'], message: string, providerId?: string) { this.events.unshift({ at: this.now(), level, message, providerId }); this.events = this.events.slice(0, 50); this.changed(level !== 'info'); }
  async report(firstScreenMs: number) {
    await this.ready();
    if (!Number.isFinite(firstScreenMs) || firstScreenMs < 0) return { ok: true as const };
    this.perf = [...this.perf, firstScreenMs].slice(-200);
    await chrome.storage.local.set({ 'backend.perf': this.perf }); this.changed();
    return { ok: true as const };
  }
  private async sourceKey(sourceLang: string, targetLang: string, text: string) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([sourceLang, targetLang, text])));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  private rememberUntil(entries: Map<string, number>, key: string) {
    const now = this.now();
    for (const [entry, expiry] of entries) if (expiry <= now) entries.delete(entry);
    entries.delete(key);
    entries.set(key, now + 600_000);
    while (entries.size > 10_000) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }
  async feedback(source: string, providerId: string, sourceLang: string, targetLang: string) {
    const provider = this.definition(providerId);
    const key = await this.sourceKey(sourceLang, targetLang, source);
    this.rememberUntil(this.bad, `${providerId}:${key}`);
    const runtime = this.runtimes.get(provider.id)!;
    runtime.attempts = [...runtime.attempts, false].slice(-50);
    this.changed(); return { ok: true as const };
  }
  async saveMemory(sourceLang: string, targetLang: string, source: string, target: string, sensitive = false) {
    await this.ready();
    if (typeof sourceLang !== 'string' || typeof targetLang !== 'string' || typeof source !== 'string' || typeof target !== 'string'
      || !sourceLang || !targetLang || !source.trim() || !target.trim()) throw new ProviderError({ code: 'bad_input', message: '修订原文、译文和语言格式无效', retryable: false });
    // noCache 只约束翻译任务；之后普通网页的明确人工修订应可保存。敏感性由真实sender决定。
    if (sensitive) throw new ProviderError({ code: 'bad_input', message: '敏感页面的译文不保存到译文记忆', retryable: false });
    if (!validTranslation(source, target)) throw new ProviderError({ code: 'bad_input', message: '修订译文的占位符编号、数量或嵌套与原文不一致', retryable: false });
    await this.storage.tmPut(sourceLang, targetLang, source, target); return { ok: true as const };
  }
  async explain(text: string, context?: string) {
    await this.ready();
    const provider = this.options.providers.filter((p) => p.explain && this.available(p)).sort((a, b) => this.score(a) - this.score(b))[0];
    if (!provider?.explain) throw new ProviderError({ code: 'no_provider', message: '请配置支持解释的本地模型', retryable: false });
    const release = await this.slot(provider, new AbortController().signal);
    try {
      const dispatch = await release.dispatch(); dispatch.validate?.();
      const requestContext = this.context(provider, new AbortController().signal); requestContext.onRequestStart = () => dispatch();
      if (provider.kind === 'builtin') dispatch();
      return { text: [...await provider.explain(text, context, requestContext)].slice(0, 120).join(''), provider: provider.id };
    }
    finally { release(); }
  }
}

