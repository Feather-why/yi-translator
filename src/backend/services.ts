import { PROTOCOL_VERSION, type RpcMap } from '../shared/protocol';
import type { BackendCapabilities, OcrResult, PdfResult, SubtitleOutput } from '../shared/backend-v2';
import type { BackendCore } from './core';
import { Dictionary } from './dict';
import { AlignmentService } from './align';
import { RuleService } from './rules';
import { SyncService, type SyncConfig } from './sync';
import { ChromeSyncStore } from './sync/chrome-store';
import type { LocalArea, SyncStore } from './sync/types';
import { ProviderError } from './providers/types';

export interface MediaBackend {
  ocr(request: RpcMap['ocr:image']['req'], signal?: AbortSignal, owner?: string): Promise<OcrResult>;
  subtitles(request: RpcMap['subtitle:translate']['req']): Promise<{ segments: SubtitleOutput[] }>;
  pdf(request: RpcMap['pdf:translate']['req'], signal?: AbortSignal, owner?: string): Promise<PdfResult>;
  cancel?(request: RpcMap['media:cancel']['req'], owner?: string): RpcMap['media:cancel']['res'] | Promise<RpcMap['media:cancel']['res']>;
  openPdf?(request: RpcMap['pdf:open']['req'], owner?: string): Promise<RpcMap['pdf:open']['res']>;
  closePdf?(request: RpcMap['pdf:close']['req'], owner?: string): Promise<RpcMap['pdf:close']['res']>;
  dispose?(): void | Promise<void>;
  status?(): { ocr?: boolean; subtitles?: boolean; pdf?: boolean };
}
export interface BackendServiceOptions {
  dictionary?: Dictionary;
  alignment?: AlignmentService;
  rules?: RuleService;
  sync?: SyncService;
  store?: SyncStore;
  storage?: LocalArea;
  providerIds?: string[];
  media?: MediaBackend;
  schedule?: (when: number | undefined) => void | Promise<void>;
  onStatus?: () => void;
}

/** 业务模块和核心调度器通过这一处接线，避免 RPC 各自创建不一致的缓存与存储实例。 */
export class BackendServices {
  readonly dictionary: Dictionary;
  readonly alignment: AlignmentService;
  readonly rules: RuleService;
  readonly sync: SyncService;
  media?: MediaBackend;
  private storage: LocalArea;
  private initialization: Promise<void>;
  constructor(private core: BackendCore, options: BackendServiceOptions = {}) {
    this.storage = options.storage ?? chrome.storage.local;
    this.dictionary = options.dictionary ?? new Dictionary();
    this.alignment = options.alignment ?? new AlignmentService({ dictionary: this.dictionary });
    this.rules = options.rules ?? new RuleService({ storage: this.storage });
    this.media = options.media;
    const vault = core.getVault();
    const store = options.store ?? new ChromeSyncStore({ storage: this.storage, tm: core.storage, rules: this.rules, vault,
      providerIds: options.providerIds ?? (async () => [...new Set((await core.list()).filter((provider) => provider.id !== 'pseudo').map((provider) => provider.id).concat('align'))]),
      onUsageImported: (counters) => this.core.mergeUsage(counters),
      onSecretsImported: async (ids) => { await this.core.refreshStoredState(); if (ids.includes('align')) await this.loadAlignment(); } });
    this.sync = options.sync ?? new SyncService({ vault, store, storage: this.storage, schedule: options.schedule, onStatus: options.onStatus });
    this.initialization = this.initialize();
    void this.initialization.catch(() => undefined);
  }
  private async initialize() {
    await this.core.ready();
    await Promise.all([this.rules.ready(), this.sync.ready(), this.loadAlignment(), this.dictionary.ready().catch(() => undefined)]);
  }
  ready() { return this.initialization; }
  private async loadAlignment() {
    const stored = (await this.storage.get('backend.alignment'))['backend.alignment'];
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
    const settings = stored as { enabled?: boolean; remoteUrl?: string };
    try {
      const secrets = await this.core.getVault().get('align');
      this.alignment.configure({ enabled: settings.enabled !== false, remoteUrl: settings.remoteUrl ?? '', token: secrets.token ?? '' });
    } catch { this.alignment.configure({ enabled: false, remoteUrl: '', token: '' }); }
  }
  async configureAlignment(value: RpcMap['align:configure']['req']) {
    if (!value || typeof value.enabled !== 'boolean' || (value.remoteUrl !== undefined && typeof value.remoteUrl !== 'string')
      || (value.token !== undefined && typeof value.token !== 'string')) throw new ProviderError({ code: 'bad_input', message: '词对齐设置格式不正确', retryable: false });
    await this.ready();
    const current = (await this.storage.get('backend.alignment'))['backend.alignment'] as { remoteUrl?: string } | undefined;
    const remoteUrl = value.remoteUrl ?? current?.remoteUrl ?? '';
    let sameOrigin = false;
    try { sameOrigin = !!remoteUrl && !!current?.remoteUrl && new URL(remoteUrl).origin === new URL(current.remoteUrl).origin; } catch { /* configure 会统一验证地址 */ }
    const previous = await this.core.getVault().get('align');
    const token = value.token !== undefined && value.token !== '••••' ? value.token : sameOrigin ? previous.token ?? '' : '';
    try { this.alignment.configure({ enabled: value.enabled, remoteUrl, token }); }
    catch { throw new ProviderError({ code: 'bad_input', message: '词对齐节点地址格式不正确', retryable: false }); }
    await this.core.getVault().set('align', { token });
    await this.storage.set({ 'backend.alignment': { enabled: value.enabled, remoteUrl } });
    return { ok: true as const };
  }
  capabilities(): BackendCapabilities {
    const dictionary = this.dictionary.status(), alignment = this.alignment.status(), media = this.media?.status?.();
    const sync = this.sync.status();
    return { protocol: PROTOCOL_VERSION, dictionary: { ready: dictionary.ready, entries: dictionary.entries },
      alignment: { ready: alignment.modelReady, ...(alignment.mode ? { model: alignment.mode === 'wasm' ? 'Xenova/multilingual-e5-small' : 'remote' } : {}),
        ...(alignment.error ? { error: alignment.error } : {}) },
      media: { ocr: media?.ocr ?? !!this.media?.ocr, subtitles: media?.subtitles ?? !!this.media?.subtitles, pdf: media?.pdf ?? !!this.media?.pdf,
        ...(this.media?.cancel ? { cancel: true } : {}), ...(this.media?.openPdf && this.media?.closePdf ? { pdfSessions: true } : {}) },
      sync: { enabled: sync.enabled, lastSyncAt: sync.lastSyncAt, lastError: sync.lastError } };
  }
  async configureSync(config: Omit<SyncConfig, 'url'> & { url?: string }) {
    await this.ready(); await this.sync.configure({ ...config, url: config.url ?? this.sync.status().url });
    return { ok: true as const };
  }
  async runSync() {
    await this.ready(); const status = await this.sync.run();
    if (status.lastError) throw new ProviderError({ code: 'network', message: status.lastError, retryable: true });
    await this.core.refreshStoredState(); return { ok: true as const };
  }
  async refresh() { await this.core.refreshStoredState(); await this.loadAlignment(); }
  async dispose() { this.sync.dispose(); this.alignment.dispose(); await this.dictionary.dispose(); await this.media?.dispose?.(); }
}
