import type { ProviderDef } from './providers/types';
import { QuotaLedger, type QuotaDefinition } from './scheduler/quota';

interface Account { identity: string; amount?: number; windowEnd?: number | null }
const KEY = 'backend.accountQuota';
/** 官方账户额度独立于用户每日/月度预算，不能用日历月为一次性试用补充额度。 */
export class AccountQuota {
  private account?: Account;
  private saved?: Account;
  private generation = 0;
  private sequence = 0;
  private canonical?: string;
  private writes = Promise.resolve();
  constructor(private ledger: QuotaLedger) {}
  async ready() {
    const stored: unknown = (await chrome.storage.local.get(KEY))[KEY];
    const candidate = stored && typeof stored === 'object' ? (stored as Record<string, unknown>).deepl : undefined;
    if (!candidate || typeof candidate !== 'object') return;
    const value = candidate as Partial<Account>;
    if (typeof value.identity === 'string' && /^[a-f0-9]{64}$/.test(value.identity) && typeof value.amount === 'number' && Number.isSafeInteger(value.amount) && value.amount >= 0
      && (value.windowEnd === null || typeof value.windowEnd === 'number' && Number.isFinite(value.windowEnd) && value.windowEnd > 0)) this.saved = { identity: value.identity, amount: value.amount, windowEnd: value.windowEnd };
  }
  async configure(provider: ProviderDef, config: Record<string, string>): Promise<boolean> {
    if (provider.id !== 'deepl') return false;
    const key = config.key?.trim() ?? '';
    const canonical = JSON.stringify(['deepl', key, config.url ?? '']);
    if (this.canonical === canonical) return false;
    this.canonical = canonical; const generation = ++this.generation; this.sequence++; this.account = undefined;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    if (generation !== this.generation) return false;
    const identity = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
    this.account = this.saved?.identity === identity ? { ...this.saved } : { identity };
    return true;
  }
  definition(provider: ProviderDef, trackBeforeFirstProbe = false): QuotaDefinition | undefined {
    return provider.id === 'deepl' && this.account && (this.account.amount !== undefined || trackBeforeFirstProbe)
      ? { unit: 'char', period: 'cycle', amount: this.account.amount ?? Number.MAX_SAFE_INTEGER, account: this.account.identity, windowEnd: this.account.windowEnd ?? null } : undefined;
  }
  begin(provider: ProviderDef) {
    if (provider.id !== 'deepl' || !this.account) return undefined;
    const policy = this.definition(provider, true)!;
    return { identity: this.account.identity, generation: this.generation, sequence: ++this.sequence, snapshot: this.ledger.snapshot(provider.id, policy) };
  }
  current(token: NonNullable<ReturnType<AccountQuota['begin']>>) {
    return token.identity === this.account?.identity && token.generation === this.generation && token.sequence === this.sequence;
  }
  async accept(provider: ProviderDef, token: ReturnType<AccountQuota['begin']>, health: { used?: number; amount?: number; quotaResetAt?: number }): Promise<boolean> {
    if (!token || !this.current(token)) return false;
    if (!Number.isSafeInteger(health.amount) || health.amount! < 0 || !Number.isSafeInteger(health.used) || health.used! < 0) return false;
    this.account = { identity: token.identity, amount: health.amount!, windowEnd: health.quotaResetAt ?? null };
    await this.ledger.calibrateOfficial(provider.id, this.definition(provider)!, health.used!, token.snapshot);
    if (!this.current(token)) return false;
    this.saved = { ...this.account };
    const value = { deepl: { ...this.account } };
    const write = this.writes.then(() => chrome.storage.local.set({ [KEY]: value }));
    this.writes = write.catch(() => undefined); await write;
    return this.current(token);
  }
}
