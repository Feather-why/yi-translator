import { ProviderError } from '../providers/types';
import type { SecretVault } from '../secrets';
import { decryptSecrets, encryptSecrets, type EncryptedSecrets } from '../secrets-backup';
import { mergeDocuments, validateDocument } from './merge';
import type { LocalArea, LwwRecord, SyncConfig, SyncDocument, SyncStore } from './types';
export type { SyncConfig, SyncDocument, SyncStore, LwwRecord, UsageCounters } from './types';

const KEY = 'backend.sync';
const INTERVAL = 10 * 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
interface SavedConfig { enabled: boolean; url: string; syncSecrets: boolean; nextRunAt?: number; lastSyncAt?: number; lastError?: string }
interface SecretClock { hash: string; updatedAt: number; deviceId: string }
interface Wire extends Omit<SyncDocument, 'secrets'> { encryptedSecrets?: EncryptedSecrets }
interface ClockState { device: string; fields: Record<string, SecretClock> }
export interface SyncStatus { enabled: boolean; url: string; syncSecrets: boolean; lastSyncAt?: number; lastError?: string; nextRunAt?: number; running: boolean }
const fail = (message: string): never => { throw new ProviderError({ code: 'bad_input', message, retryable: false }); };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function endpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return fail('WebDAV 地址格式不正确'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail('WebDAV 地址必须是不含凭据、查询参数或片段的 HTTP(S) 地址');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return fail('非本机 WebDAV 必须使用 HTTPS');
  if (!url.pathname.endsWith('.json')) url.pathname = url.pathname.replace(/\/?$/, '/') + 'translate-state-v1.json';
  return url.href;
}
function encodeBasic(username: string, password: string): string {
  let value = '';
  for (const byte of new TextEncoder().encode(username + ':' + password)) value += String.fromCharCode(byte);
  return 'Basic ' + btoa(value);
}
async function hash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class SyncService {
  private storage: LocalArea;
  private fetcher: typeof fetch;
  private now: () => number;
  private timer: unknown;
  private initialized: Promise<void>;
  private running?: Promise<SyncStatus>;
  private config: SavedConfig = { enabled: false, url: '', syncSecrets: false };
  private secretClock: ClockState = { device: '', fields: {} };
  private disposed = false;
  private controller?: AbortController;
  private dirtyDuringRun = false;
  private scheduleVersion = 0;
  private planned?: { when: number | undefined; version: number };
  private scheduling = Promise.resolve();
  private setTimer: (callback: () => void, delay: number) => unknown;
  private clearTimer: (handle: unknown) => void;

  constructor(private options: { vault: Pick<SecretVault, 'get' | 'set'>; store: SyncStore; storage?: LocalArea; fetch?: typeof fetch; now?: () => number;
    setTimer?: (callback: () => void, delay: number) => unknown; clearTimer?: (handle: unknown) => void;
    schedule?: (when: number | undefined) => void | Promise<void>; onStatus?: () => void }) {
    this.storage = options.storage ?? chrome.storage.local;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delay) => {
      const handle = setTimeout(callback, delay);
      (handle as unknown as { unref?(): void }).unref?.(); return handle;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.initialized = this.initialize();
  }
  private async initialize() {
    const stored = await this.storage.get([KEY, 'backend.sync.secretClock', 'backend.device']);
    if (isObject(stored[KEY])) {
      const saved = stored[KEY];
      try { this.config = { enabled: saved.enabled === true, url: saved.url ? endpoint(String(saved.url)) : '', syncSecrets: saved.syncSecrets === true,
        ...(typeof saved.lastSyncAt === 'number' ? { lastSyncAt: saved.lastSyncAt } : {}), ...(typeof saved.nextRunAt === 'number' ? { nextRunAt: saved.nextRunAt } : {}) }; }
      catch { this.config.lastError = '保存的 WebDAV 地址无效，同步已关闭'; }
    }
    const device = typeof stored['backend.device'] === 'string' ? stored['backend.device'] : crypto.randomUUID();
    this.secretClock = { device, fields: isObject(stored['backend.sync.secretClock']) ? stored['backend.sync.secretClock'] as Record<string, SecretClock> : {} };
    if (this.config.enabled && this.config.url) await this.schedule(this.config.nextRunAt ?? this.now() + INTERVAL);
  }
  ready() { return this.initialized; }
  status(): SyncStatus { return { enabled: this.config.enabled, url: this.config.url, syncSecrets: this.config.syncSecrets,
    lastSyncAt: this.config.lastSyncAt, lastError: this.config.lastError, nextRunAt: this.config.nextRunAt, running: !!this.running }; }
  async configure(value: SyncConfig) {
    await this.ready();
    if (!value || typeof value.enabled !== 'boolean' || typeof value.url !== 'string') return fail('同步设置格式不正确');
    const url = value.url ? endpoint(value.url) : '';
    if (value.enabled && !url) return fail('请先填写 WebDAV 地址');
    const previous = await this.options.vault.get('sync');
    const sameOrigin = !!url && !!this.config.url && new URL(url).origin === new URL(this.config.url).origin;
    const choose = (key: 'username' | 'password' | 'passphrase') => {
      const incoming = value[key];
      if (incoming !== undefined && typeof incoming !== 'string') return fail('WebDAV 凭据格式不正确');
      if (incoming !== undefined && incoming !== '••••') return incoming;
      return key === 'passphrase' || sameOrigin ? previous[key] ?? '' : '';
    };
    const credentials = { username: choose('username'), password: choose('password'), passphrase: choose('passphrase') };
    if (value.syncSecrets === true && Array.from(credentials.passphrase).length < 8) return fail('开启密钥同步需要至少 8 个字符的加密口令');
    this.controller?.abort();
    await this.options.vault.set('sync', credentials);
    this.config = { ...this.config, enabled: value.enabled, url, syncSecrets: value.syncSecrets === true, lastError: undefined };
    await this.schedule(value.enabled ? this.now() + INTERVAL : undefined);
    return this.status();
  }
  notifyChange() {
    if (!this.config.enabled || this.disposed) return;
    if (this.running) this.dirtyDuringRun = true;
    const when = Math.min(this.config.nextRunAt ?? Infinity, this.now() + 30_000);
    if (this.planned?.when === when) return;
    void this.schedule(when).catch(() => { this.config.lastError = '无法保存同步计划'; this.options.onStatus?.(); });
  }
  private schedule(when: number | undefined) {
    const version = ++this.scheduleVersion;
    this.planned = { when, version };
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined; this.config.nextRunAt = when;
    const saved = structuredClone(this.config);
    // 串行化落盘与alarm更新，旧的异步计划不能覆盖后来关闭/改期的结果。
    const work = this.scheduling.then(async () => {
      if (this.disposed || version !== this.scheduleVersion) return;
      await this.storage.set({ [KEY]: saved });
      if (this.disposed || version !== this.scheduleVersion) return;
      this.options.onStatus?.();
      if (this.options.schedule) await this.options.schedule(when);
      else if (when !== undefined) this.timer = this.setTimer(() => { this.timer = undefined; this.planned = undefined; void this.run(); }, Math.max(0, when - this.now()));
    }).catch((error) => { if (this.planned?.version === version) this.planned = undefined; throw error; });
    this.scheduling = work.catch(() => undefined);
    return work;
  }
  run(): Promise<SyncStatus> {
    if (this.running) return this.running;
    this.running = this.perform().then((status) => ({ ...status, running: false })).finally(() => { this.running = undefined; this.options.onStatus?.(); });
    return this.running;
  }
  private async request(url: string, init: RequestInit) {
    return this.fetcher(url, { ...init, credentials: 'omit', redirect: 'error', signal: this.controller
      ? AbortSignal.any([this.controller.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  }
  private async read(response: Response): Promise<Wire> {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) return fail('同步文件超过 8MB 上限');
    if (!response.body) return fail('同步文件内容为空');
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0, text = '';
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); return fail('同步文件超过 8MB 上限'); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return fail('WebDAV 同步文件不是有效 JSON'); }
    if (!isObject(parsed) || parsed.secrets !== undefined) return fail('拒绝含明文密钥的同步文件');
    const document = validateDocument(parsed);
    return { ...document, ...(parsed.encryptedSecrets !== undefined ? { encryptedSecrets: parsed.encryptedSecrets as EncryptedSecrets } : {}) };
  }
  private async secretRecords(secrets: Record<string, Record<string, string>>) {
    const result: Record<string, Record<string, string>> = {};
    for (const [provider, fields] of Object.entries(secrets)) {
      const output: Record<string, string> = {};
      for (const [field, value] of Object.entries(fields)) {
        const id = JSON.stringify([provider, field]);
        const digest = await hash(value);
        let clock = this.secretClock.fields[id];
        if (!clock || clock.hash !== digest) clock = { hash: digest, updatedAt: Math.max(this.now(), (clock?.updatedAt ?? -1) + 1), deviceId: this.secretClock.device };
        this.secretClock.fields[id] = clock;
        output[field] = JSON.stringify({ value, updatedAt: clock.updatedAt, deviceId: clock.deviceId });
      }
      result[provider] = output;
    }
    await this.storage.set({ 'backend.sync.secretClock': this.secretClock.fields });
    return result;
  }
  private async mergeSecrets(local: Record<string, Record<string, string>>, remote: Record<string, Record<string, string>>) {
    const a: SyncDocument = { version: 1, fields: {}, usage: {} }, b: SyncDocument = { version: 1, fields: {}, usage: {} };
    for (const [document, secrets] of [[a, local], [b, remote]] as const) for (const [provider, fields] of Object.entries(secrets)) for (const [field, encoded] of Object.entries(fields)) {
      let value: unknown;
      try { value = JSON.parse(encoded); } catch { return fail('加密密钥同步记录格式不正确'); }
      if (!isObject(value) || typeof value.value !== 'string') return fail('加密密钥同步记录格式不正确');
      document.fields[JSON.stringify([provider, field])] = value as unknown as LwwRecord;
    }
    const merged = mergeDocuments(a, b), encoded: Record<string, Record<string, string>> = {}, plain: Record<string, Record<string, string>> = {};
    for (const [id, record] of Object.entries(merged.fields)) {
      const [provider, field] = JSON.parse(id) as [string, string];
      (plain[provider] ??= {})[field] = String(record.value);
      (encoded[provider] ??= {})[field] = JSON.stringify(record);
      this.secretClock.fields[id] = { hash: await hash(String(record.value)), updatedAt: record.updatedAt, deviceId: record.deviceId };
    }
    return { encoded, plain };
  }
  private async perform() {
    await this.ready();
    if (!this.config.enabled || !this.config.url || this.disposed) return this.status();
    const configuration = { ...this.config };
    this.controller = new AbortController();
    this.dirtyDuringRun = false;
    try {
      const credentials = await this.options.vault.get('sync');
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (credentials.username || credentials.password) headers.Authorization = encodeBasic(credentials.username ?? '', credentials.password ?? '');
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.controller.signal.aborted) throw new DOMException('同步已取消', 'AbortError');
        const local = await this.options.store.export(configuration.syncSecrets);
        const response = await this.request(configuration.url, { headers });
        if (response.status !== 404 && !response.ok) throw new Error(`HTTP ${response.status}`);
        const remote: Wire = response.status === 404 ? { version: 1, fields: {}, usage: {} } : await this.read(response);
        const etag = response.headers.get('etag');
        if (response.status !== 404 && (!etag || etag.startsWith('W/'))) return fail('WebDAV 必须提供强 ETag 才能安全同步，请更换服务或配置');
        const merged = mergeDocuments(local, remote);
        let encryptedSecrets = remote.encryptedSecrets;
        let secrets: Record<string, Record<string, string>> | undefined;
        if (configuration.syncSecrets) {
          const passphrase = credentials.passphrase ?? '';
          const previous = encryptedSecrets ? await decryptSecrets(encryptedSecrets, passphrase) : {};
          const secretMerge = await this.mergeSecrets(await this.secretRecords(local.secrets ?? {}), previous);
          encryptedSecrets = await encryptSecrets(secretMerge.encoded, passphrase); secrets = secretMerge.plain;
        }
        const wire: Wire = { ...merged, ...(encryptedSecrets ? { encryptedSecrets } : {}) };
        const body = JSON.stringify(wire);
        if (new TextEncoder().encode(body).byteLength > MAX_BYTES) return fail('合并后的同步文件超过 8MB 上限');
        if (this.controller.signal.aborted) throw new DOMException('同步已取消', 'AbortError');
        const put = await this.request(configuration.url, { method: 'PUT', body,
          headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...(response.status === 404 ? { 'If-None-Match': '*' } : { 'If-Match': etag! }) } });
        if (put.status === 412 || put.status === 409) continue;
        if (!put.ok) throw new Error(`HTTP ${put.status}`);
        if (this.controller.signal.aborted) throw new DOMException('同步已取消', 'AbortError');
        await this.options.store.import({ ...merged, ...(secrets ? { secrets } : {}) });
        await this.storage.set({ 'backend.sync.secretClock': this.secretClock.fields });
        this.config.lastSyncAt = this.now(); this.config.lastError = undefined;
        await this.schedule(this.now() + (this.dirtyDuringRun ? 30_000 : INTERVAL)); return this.status();
      }
      throw new Error('冲突次数过多');
    } catch {
      if (this.controller.signal.aborted || !this.config.enabled || this.config.url !== configuration.url || this.disposed) return this.status();
      this.config.lastError = 'WebDAV 同步失败；请检查地址、凭据、加密口令、ETag 和网络后重试';
      await this.schedule(this.now() + INTERVAL); return this.status();
    } finally {
      this.controller = undefined;
    }
  }
  dispose() { this.disposed = true; this.scheduleVersion++; this.planned = undefined; this.controller?.abort(); if (this.timer !== undefined) this.clearTimer(this.timer); this.timer = undefined; }
}
