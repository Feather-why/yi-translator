import { ProviderError } from '../providers/types';
import type { SecretVault } from '../secrets';
import { validateRule } from '../rules';
import type { RuleService } from '../rules';
import { mergeDocuments, validateDocument } from './merge';
import type { LocalArea, LwwRecord, SyncDocument, SyncStore, UsageCounters } from './types';

export interface SyncTmEntry { key: string; updatedAt: number; deleted?: boolean; value?: { sourceLang: string; targetLang: string; source: string; target: string } }
export interface TmSyncAdapter { exportEntries(): Promise<SyncTmEntry[]>; importEntries(entries: SyncTmEntry[]): Promise<void> }
interface LedgerCounter { used: number; resetAt: number; devices: Record<string, number> }
const META = 'backend.sync.document';
const danger = (key: string) => ['__proto__', 'prototype', 'constructor'].includes(key);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
const unescape = (key: string) => key.replace(/~1/g, '/').replace(/~0/g, '~');
function flatten(value: unknown, prefix: string, out: Record<string, unknown>) {
  if (object(value) && Object.keys(value).length) {
    for (const [key, entry] of Object.entries(value)) {
      if (danger(key)) throw new ProviderError({ code: 'bad_input', message: '同步设置含保留字段', retryable: false });
      flatten(entry, prefix + '/' + escape(key), out);
    }
  } else out[prefix] = structuredClone(value);
}
function setPath(root: Record<string, unknown>, pointer: string, record: LwwRecord) {
  const parts = pointer.split('/').slice(1).map(unescape);
  if (!parts.length || parts.some(danger)) return;
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    if (!object(parent[part])) parent[part] = {};
    parent = parent[part] as Record<string, unknown>;
  }
  const last = parts.at(-1)!;
  if (record.deleted) delete parent[last];
  else parent[last] = structuredClone(record.value);
}

export class ChromeSyncStore implements SyncStore {
  private area: LocalArea;
  private now: () => number;
  private device = '';
  private metadata: SyncDocument = { version: 1, fields: {}, usage: {} };
  private initialized: Promise<void>;
  private operations = Promise.resolve();
  constructor(private options: { storage?: LocalArea; now?: () => number; deviceId?: string; tm?: TmSyncAdapter;
    rules?: Pick<RuleService, 'exportLocal' | 'importLocal'>; vault?: Pick<SecretVault, 'get' | 'set'>; providerIds?: string[] | (() => string[] | Promise<string[]>);
    onUsageImported?: (counters: Record<string, LedgerCounter>) => Promise<void>;
    onSecretsImported?: (ids: string[]) => void | Promise<void> } = {}) {
    this.area = options.storage ?? chrome.storage.local;
    this.now = options.now ?? Date.now;
    this.initialized = this.initialize();
  }
  private async initialize() {
    const stored = await this.area.get([META, 'backend.sync.device', 'backend.device']);
    this.device = this.options.deviceId ?? (typeof stored['backend.sync.device'] === 'string' ? stored['backend.sync.device']
      : typeof stored['backend.device'] === 'string' ? stored['backend.device'] : crypto.randomUUID());
    try { if (stored[META]) this.metadata = validateDocument(stored[META]); } catch { /* 本机坏元数据可由当前真实设置重建 */ }
    await this.area.set({ 'backend.sync.device': this.device });
  }
  ready() { return this.initialized; }
  private async providerIds() { return typeof this.options.providerIds === 'function' ? this.options.providerIds() : this.options.providerIds ?? []; }
  private async capture(includeSecrets = false): Promise<SyncDocument> {
    await this.ready();
    const stored = await this.area.get(['settings.ui', 'settings.core', 'backend.rules', 'backend.usage']);
    const current: Record<string, unknown> = {};
    for (const namespace of ['settings.ui', 'settings.core']) if (object(stored[namespace])) flatten(stored[namespace], namespace + ':', current);
    const ruleState = stored['backend.rules'];
    const rules = this.options.rules?.exportLocal() ?? (object(ruleState) && Array.isArray(ruleState.local) ? ruleState.local : []);
    for (const value of rules) { const rule = validateRule(value, 'local'); current['rule:' + rule.id] = rule; }
    const tmEntries = await this.options.tm?.exportEntries() ?? [];
    for (const entry of tmEntries) {
      if (!entry.deleted && entry.value) current['tm:' + entry.key] = entry.value;
    }
    const observed = (key: string) => key.startsWith('settings.ui:/') || key.startsWith('settings.core:/') || key.startsWith('rule:') || (!!this.options.tm && key.startsWith('tm:'));
    for (const [key, value] of Object.entries(current)) {
      const previous = this.metadata.fields[key];
      if (!previous || previous.deleted || !same(previous.value, value)) {
        const entry = key.startsWith('tm:') ? tmEntries.find((item) => item.key === key.slice(3)) : undefined;
        this.metadata.fields[key] = { value, updatedAt: Math.max(entry?.updatedAt ?? this.now(), (previous?.updatedAt ?? -1) + 1), deviceId: this.device };
      }
    }
    for (const [key, previous] of Object.entries(this.metadata.fields)) if (observed(key) && !Object.hasOwn(current, key) && !previous.deleted) {
      const entry = key.startsWith('tm:') ? tmEntries.find((item) => item.key === key.slice(3)) : undefined;
      this.metadata.fields[key] = { deleted: true, updatedAt: Math.max(entry?.updatedAt ?? this.now(), previous.updatedAt + 1), deviceId: this.device };
    }
    const usage: UsageCounters = {};
    if (object(stored['backend.usage'])) for (const [provider, raw] of Object.entries(stored['backend.usage'])) {
      if (!object(raw) || !Number.isSafeInteger(raw.resetAt) || !object(raw.devices)) continue;
      const devices = Object.fromEntries(Object.entries(raw.devices).filter((pair): pair is [string, number] => Number.isSafeInteger(pair[1]) && Number(pair[1]) >= 0));
      usage[provider] = { [String(raw.resetAt)]: devices };
    }
    this.metadata = mergeDocuments(this.metadata, { version: 1, fields: {}, usage });
    await this.area.set({ [META]: this.metadata });
    const result = structuredClone(this.metadata);
    if (includeSecrets) {
      if (!this.options.vault || !this.options.providerIds) throw new ProviderError({ code: 'internal', message: '尚未接入密钥同步适配器', retryable: false });
      result.secrets = {};
      for (const id of await this.providerIds()) if (id !== 'sync') result.secrets[id] = await this.options.vault.get(id);
    }
    return result;
  }
  export(includeSecrets = false): Promise<SyncDocument> {
    const operation = this.operations.then(() => this.capture(includeSecrets));
    this.operations = operation.then(() => undefined, () => undefined); return operation;
  }
  import(document: SyncDocument): Promise<void> {
    const operation = this.operations.then(() => this.apply(document));
    this.operations = operation.catch(() => undefined); return operation;
  }
  private async apply(document: SyncDocument) {
    const current = await this.capture();
    const merged = mergeDocuments(current, document);
    const stored = await this.area.get(['settings.ui', 'settings.core', 'backend.rules', 'backend.usage']);
    const updates: Record<string, unknown> = {};
    for (const namespace of ['settings.ui', 'settings.core']) {
      const value = object(stored[namespace]) ? structuredClone(stored[namespace]) : {};
      for (const [key, record] of Object.entries(merged.fields)) if (key.startsWith(namespace + ':/')) setPath(value, key.slice(namespace.length + 1), record);
      if (!same(value, stored[namespace]) && Object.keys(value).length) updates[namespace] = value;
    }
    const rules = Object.entries(merged.fields).filter(([key, record]) => key.startsWith('rule:') && !record.deleted).map(([, record]) => validateRule(record.value, 'local'));
    const existingRuleState = object(stored['backend.rules']) ? stored['backend.rules'] : { version: 1, local: [], subscriptions: [] };
    const previousRules = this.options.rules?.exportLocal() ?? existingRuleState.local;
    if (!same(previousRules, rules)) {
      if (this.options.rules) await this.options.rules.importLocal(rules);
      else updates['backend.rules'] = { ...existingRuleState, local: rules };
    }
    if (this.options.tm) {
      const entries: SyncTmEntry[] = [];
      for (const [key, record] of Object.entries(merged.fields)) if (key.startsWith('tm:') && !same(record, current.fields[key])) {
        if (record.deleted) entries.push({ key: key.slice(3), updatedAt: record.updatedAt, deleted: true });
        else {
          const value = record.value;
          if (!object(value) || !['sourceLang', 'targetLang', 'source', 'target'].every((name) => typeof value[name] === 'string')) throw new ProviderError({ code: 'bad_input', message: '译文记忆同步格式不正确', retryable: false });
          entries.push({ key: key.slice(3), updatedAt: record.updatedAt, value: value as unknown as SyncTmEntry['value'] });
        }
      }
      if (entries.length) await this.options.tm.importEntries(entries);
    }
    const ledger: Record<string, LedgerCounter> = object(stored['backend.usage']) ? structuredClone(stored['backend.usage']) as unknown as Record<string, LedgerCounter> : {};
    for (const [provider, periods] of Object.entries(merged.usage)) {
      // 周期键是 UTC 毫秒 resetAt，绝不把上个月的设备计数累计到新月份。
      const latest = Object.keys(periods).filter((period) => Number.isSafeInteger(Number(period)) && Number(period) > this.now()).sort((a, b) => Number(b) - Number(a))[0];
      if (!latest || (ledger[provider]?.resetAt ?? 0) > Number(latest)) continue;
      const devices = periods[latest]!;
      ledger[provider] = { resetAt: Number(latest), devices, used: Object.values(devices).reduce((sum, count) => sum + count, 0) };
    }
    if (!same(ledger, stored['backend.usage']) && Object.keys(ledger).length) updates['backend.usage'] = ledger;
    if (updates['backend.usage'] && this.options.onUsageImported) {
      // 额度账本合并内存中尚未落盘的计数并串行持久化，此处不再覆盖它写出的值。
      await this.options.onUsageImported(structuredClone(ledger));
      delete updates['backend.usage'];
    }
    if (document.secrets) {
      if (!this.options.vault || !this.options.providerIds) throw new ProviderError({ code: 'internal', message: '尚未接入密钥同步适配器', retryable: false });
      const imported: string[] = [];
      const allowed = await this.providerIds();
      for (const [id, value] of Object.entries(document.secrets)) if (id !== 'sync' && allowed.includes(id)) { await this.options.vault.set(id, value); imported.push(id); }
      if (imported.length) await this.options.onSecretsImported?.(imported);
    }
    this.metadata = merged; updates[META] = merged;
    await this.area.set(updates);
  }
}
