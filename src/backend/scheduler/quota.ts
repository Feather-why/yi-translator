import type { QuotaInfo } from '../../shared/protocol';
import { ProviderError } from '../providers/types';
import type { DispatchLifecycle } from './batcher';

export type QuotaDefinition = Omit<QuotaInfo, 'used' | 'resetAt'> & { account?: string; windowEnd?: number | null };
/** 仅在后端传递，不能把账户摘要或内部无限期标记发给前端。 */
export interface QuotaSnapshot { scope: string; used: number; resetAt: number; localSent: number }
interface Counter { used: number; resetAt: number; devices: Record<string, number>; localSent?: number; limit?: number }
interface JournalEntry { provider: string; device: string; amount: number; resetAt: number }
interface Pending { token: string; provider: string; scope: string; quota: QuotaDefinition; amount: number; state: 'reserved' | 'prepared' | 'sent' | 'released'; resetAt?: number; durable?: boolean; preparing?: Promise<void>; write?: Promise<void> }
const UNKNOWN_END = Number.MAX_SAFE_INTEGER;
const accountScope = (id: string) => /@[a-f0-9]{64}$/.test(id);
export interface QuotaReservation extends DispatchLifecycle { release(): Promise<void> }
/** 本机预算/持久化拒绝不是上游服务故障，不能触发上游熔断或耗尽全部免费额度。 */
export class QuotaReservationError extends ProviderError {}
export class QuotaLedger {
  private device = '';
  private counters: Record<string, Counter> = {};
  private writes = Promise.resolve();
  private reservations = new Map<string, Pending>();
  private journal: Record<string, JournalEntry> = {};
  private leases = new WeakMap<DispatchLifecycle, Pending>();
  constructor(private now: () => number = Date.now) {}
  async ready() {
    const stored = await chrome.storage.local.get(['backend.device', 'backend.usage', 'backend.usage.pending']);
    this.device = typeof stored['backend.device'] === 'string' ? stored['backend.device'] : crypto.randomUUID();
    this.counters = (stored['backend.usage'] as Record<string, Counter> | undefined) ?? {};
    // journal在发送前已落盘；不确定是否发出时保守记一次，单次set提交用量与清理快照。
    const journal = stored['backend.usage.pending'];
    if (journal && typeof journal === 'object' && !Array.isArray(journal)) for (const value of Object.values(journal) as JournalEntry[]) {
      if (!value || typeof value.provider !== 'string' || typeof value.device !== 'string' || !value.device || !Number.isFinite(value.amount)
        || value.amount <= 0 || !Number.isFinite(value.resetAt) || !accountScope(value.provider) && value.resetAt <= this.now()) continue;
      let counter = this.counters[value.provider];
      if (accountScope(value.provider)) {
        if (!counter) counter = this.counters[value.provider] = { used: 0, resetAt: value.resetAt > this.now() ? value.resetAt : UNKNOWN_END, devices: {}, localSent: 0 };
        else if (counter.resetAt <= this.now()) counter.resetAt = UNKNOWN_END;
      } else {
        if (counter && counter.resetAt > value.resetAt) continue;
        if (!counter || counter.resetAt < value.resetAt) counter = this.counters[value.provider] = { used: 0, resetAt: value.resetAt, devices: {} };
      }
      counter.devices[value.device] = (counter.devices[value.device] ?? 0) + value.amount;
      counter.used = Object.values(counter.devices).reduce((a, b) => a + b, 0);
      if (accountScope(value.provider)) counter.localSent = (counter.localSent ?? 0) + value.amount;
    }
    await chrome.storage.local.set({ 'backend.device': this.device, 'backend.usage': structuredClone(this.counters), 'backend.usage.pending': {} });
  }
  async reload() {
    await this.writes;
    const stored = await chrome.storage.local.get('backend.usage');
    const incoming = stored['backend.usage'] as Record<string, Counter> | undefined;
    await this.mergeCounters(incoming ?? {}, false);
    if (JSON.stringify(this.counters) !== JSON.stringify(incoming ?? {})) await this.persist();
  }
  async mergeCounters(incoming: Record<string, Counter>, persist = true) {
    for (const [id, value] of Object.entries(incoming ?? {})) {
      if (!value || !Number.isFinite(value.resetAt) || !value.devices) continue;
      const previous = this.counters[id];
      // 账户官方计数允许下降，不参与跨设备G-counter合并；reload只读取本机已完成写入的快照。
      if (accountScope(id)) {
        if (!persist && Number.isFinite(value.used) && value.used >= 0 && Number.isFinite(value.localSent) && value.localSent! >= (previous?.localSent ?? 0)) this.counters[id] = structuredClone(value);
        continue;
      }
      if (previous && previous.resetAt > value.resetAt) continue;
      const devices = { ...value.devices };
      if (previous?.resetAt === value.resetAt) for (const [device, amount] of Object.entries(previous.devices)) devices[device] = Math.max(devices[device] ?? 0, amount);
      this.counters[id] = { resetAt: value.resetAt, devices, used: Object.values(devices).reduce((a, b) => a + b, 0) };
    }
    if (persist) await this.persist();
  }
  async remove(id: string) {
    for (const reservation of this.reservations.values()) if (reservation.provider === id) {
      reservation.state = 'released'; this.reservations.delete(reservation.token); delete this.journal[reservation.token];
    }
    for (const key of Object.keys(this.counters)) if (key === id || key.startsWith(id + '@') && accountScope(key)) delete this.counters[key];
    await this.persist();
  }
  private scope(id: string, quota: QuotaDefinition): string {
    if (quota.account === undefined) {
      if (quota.windowEnd !== undefined) throw new QuotaReservationError({ code: 'bad_input', provider: id, message: '官方额度缺少账户标识', retryable: false });
      return id;
    }
    if (typeof quota.account !== 'string' || !/^[a-f0-9]{64}$/.test(quota.account) || quota.windowEnd !== undefined && quota.windowEnd !== null && (!Number.isSafeInteger(quota.windowEnd) || quota.windowEnd < 0)) {
      throw new QuotaReservationError({ code: 'bad_input', provider: id, message: '官方额度账户或周期格式无效', retryable: false });
    }
    return id + '@' + quota.account;
  }
  info(id: string, quota?: QuotaDefinition): QuotaInfo | undefined {
    return this.infoAt(id, quota, this.now());
  }
  private infoAt(id: string, quota: QuotaDefinition | undefined, now: number): QuotaInfo | undefined {
    if (!quota) return undefined;
    const scope = this.scope(id, quota);
    let counter = this.counters[scope];
    if (quota.account !== undefined) {
      const knownEnd = typeof quota.windowEnd === 'number' && quota.windowEnd > now ? quota.windowEnd : undefined;
      if (!counter) counter = this.counters[scope] = { used: 0, devices: {}, resetAt: knownEnd ?? UNKNOWN_END, localSent: 0, limit: quota.amount };
      else if (counter.resetAt <= now) {
        // 到期也保留用量，等待可信usage重新定基准，避免旧窗口数据在月界误放额度。
        counter.resetAt = UNKNOWN_END;
      }
    } else if (!counter || counter.resetAt <= now) {
      const date = new Date(now);
      if (quota.period === 'day') date.setDate(date.getDate() + 1);
      else date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
      counter = this.counters[scope] = { used: 0, devices: {}, resetAt: date.getTime() };
    }
    // 可信usage下调上限后，已排队任务的旧副本也必须遵守新限额；读取本身不能恢复旧上限。
    const amount = quota.account !== undefined ? Math.min(quota.amount, counter.limit ?? quota.amount) : quota.amount;
    return { unit: quota.unit, amount, period: quota.period, used: counter.used,
      ...(counter.resetAt === UNKNOWN_END ? {} : { resetAt: counter.resetAt }) };
  }
  private reserved(scope: string) {
    let value = 0; for (const item of this.reservations.values()) if (item.scope === scope) value += item.amount; return value;
  }
  available(id: string, quota?: QuotaDefinition) {
    const info = this.info(id, quota); return !info || info.used + this.reserved(this.scope(id, quota!)) < info.amount;
  }
  reserve(id: string, quota: QuotaDefinition | undefined, amount: number): QuotaReservation | undefined {
    if (!quota) return undefined;
    if (!Number.isFinite(amount) || amount < 0) throw new QuotaReservationError({ code: 'bad_input', provider: id, message: '服务计费用量无效', retryable: false });
    const info = this.info(id, quota)!;
    const scope = this.scope(id, quota);
    if (info.used + this.reserved(scope) + amount > info.amount) throw this.denied(id);
    const item: Pending = { token: crypto.randomUUID(), provider: id, scope, quota: { ...quota }, amount, state: 'reserved' };
    this.reservations.set(item.token, item);
    const validate = () => {
      if (item.state === 'released' || !this.reservations.has(item.token)) throw new QuotaReservationError({ code: 'no_provider', provider: id, message: '额度预留已取消', retryable: true });
      const current = this.info(id, item.quota)!;
      if (current.used + this.reserved(scope) > current.amount) throw this.denied(id);
      return current;
    };
    const lease: QuotaReservation = {
      prepare: () => {
        if (item.preparing) return item.preparing;
        item.preparing = (async () => {
          // 周期在存储等待中跨界时再写一次新周期；有界重试不允许无限等待午夜/时钟抖动。
          for (let attempt = 0; attempt < 2; attempt++) {
            validate(); item.resetAt = this.counters[scope]!.resetAt; item.state = 'prepared'; item.durable = false;
            this.journal[item.token] = { provider: scope, device: this.device, amount, resetAt: item.resetAt };
            item.write = this.persist();
            try { await item.write; } catch { throw new QuotaReservationError({ code: 'internal', provider: id, message: '额度预备记录无法保存，未发送翻译请求', retryable: true }); }
            item.durable = true;
            if (!this.reservations.has(item.token)) return;
            validate();
            if (this.counters[scope]!.resetAt === item.resetAt) return;
          }
          throw new QuotaReservationError({ code: 'no_provider', provider: id, message: '额度周期刚刚切换，请重试', retryable: true });
        })();
        return item.preparing;
      },
      dispatch: (batch = [lease]) => this.dispatch(batch),
      release: async () => {
        if (item.state === 'sent') { await item.write; return; }
        if (item.state === 'released') { await item.write; return; }
        const prepared = item.state === 'prepared';
        item.state = 'released'; this.reservations.delete(item.token); delete this.journal[item.token];
        if (prepared) item.write = this.persist();
        await item.write;
      },
    };
    this.leases.set(lease, item); return lease;
  }
  private dispatch(batch: readonly DispatchLifecycle[]) {
    const now = this.now(), items: Pending[] = [];
    for (const lease of new Set(batch)) {
      const item = this.leases.get(lease);
      if (!item) throw new QuotaReservationError({ code: 'internal', message: '额度预留不属于本批协调器，未发送请求', retryable: false });
      if (item.state === 'sent') continue;
      const current = this.infoAt(item.provider, item.quota, now)!;
      if (item.state !== 'prepared' || !item.durable || !this.reservations.has(item.token) || this.counters[item.scope]!.resetAt !== item.resetAt) throw new QuotaReservationError({ code: 'no_provider', provider: item.provider, message: '额度预备记录已失效，请重试', retryable: true });
      if (current.used + this.reserved(item.scope) > current.amount) throw this.denied(item.provider);
      items.push(item);
    }
    // 所有可失败的校验先完成；同一时刻的批次之后只做无await的状态提交。
    for (const item of items) {
      const counter = this.counters[item.scope]!;
      counter.devices[this.device] = (counter.devices[this.device] ?? 0) + item.amount;
      counter.used = Object.values(counter.devices).reduce((a, b) => a + b, 0);
      if (item.quota.account !== undefined) counter.localSent = (counter.localSent ?? 0) + item.amount;
      item.state = 'sent'; this.reservations.delete(item.token); delete this.journal[item.token];
    }
    if (items.length) {
      // 不在持久化await后再发送；预备journal已耐久化，提交失败也能在重启时保守归账。
      const write = this.persist(); for (const item of items) item.write = write; void write.catch(() => undefined);
    }
  }
  private denied(id: string) { return new QuotaReservationError({ code: 'quota', provider: id, message: '服务剩余额度不足，含正在等待的预留', retryable: false }); }
  async charge(id: string, quota: QuotaDefinition | undefined, amount: number) {
    const info = this.info(id, quota);
    if (!info) return;
    const counter = this.counters[this.scope(id, quota!)]!;
    counter.devices[this.device] = (counter.devices[this.device] ?? 0) + amount;
    counter.used = Object.values(counter.devices).reduce((a, b) => a + b, 0);
    if (quota!.account !== undefined) counter.localSent = (counter.localSent ?? 0) + amount;
    await this.persist();
  }
  async exhaust(id: string, quota?: QuotaDefinition) {
    const info = this.info(id, quota);
    if (info && quota?.account) {
      const counter = this.counters[this.scope(id, quota)]!;
      counter.used = Math.max(info.amount, info.used); counter.devices = { [this.device]: counter.used };
      await this.persist(); return;
    }
    if (info) await this.charge(id, quota, Math.max(0, info.amount - info.used));
  }
  async calibrate(id: string, quota: QuotaDefinition | undefined, used?: number) {
    const info = this.info(id, quota);
    // 官方用量只向上校准，避免覆盖正在计费的并发请求。
    if (info && used !== undefined && Number.isFinite(used) && used > info.used) await this.charge(id, quota, used - info.used);
  }
  snapshot(id: string, quota?: QuotaDefinition): QuotaSnapshot | undefined {
    if (!this.info(id, quota)) return undefined;
    const scope = this.scope(id, quota!), counter = this.counters[scope]!;
    return { scope, used: counter.used, resetAt: counter.resetAt, localSent: counter.localSent ?? 0 };
  }
  async calibrateOfficial(id: string, quota: QuotaDefinition, used: number, snapshot: QuotaSnapshot | undefined) {
    const scope = this.scope(id, quota);
    if (!quota.account || !snapshot || snapshot.scope !== scope || !Number.isSafeInteger(used) || used < 0
      || !Number.isSafeInteger(quota.amount) || quota.amount < 0
      || !Number.isSafeInteger(snapshot.localSent) || snapshot.localSent < 0 || !Number.isSafeInteger(snapshot.used) || snapshot.used < 0
      || !Number.isSafeInteger(snapshot.resetAt)) throw new QuotaReservationError({ code: 'bad_input', provider: id, message: '官方额度校准快照无效', retryable: false });
    this.info(id, quota);
    const counter = this.counters[scope]!;
    // 用独立单调发送量保住探测期间已经发出的请求，不把官方基准变动误算为本机新增。
    const increment = (counter.localSent ?? 0) - snapshot.localSent;
    if (increment < 0) throw new QuotaReservationError({ code: 'bad_input', provider: id, message: '官方额度校准快照已失效', retryable: false });
    const total = used + increment;
    if (!Number.isSafeInteger(total)) throw new QuotaReservationError({ code: 'bad_input', provider: id, message: '官方额度校准用量无效', retryable: false });
    // 已有账户的窗口只能由可信探测更新；旧排队任务的quota副本不能倒写新账期。
    if (typeof quota.windowEnd === 'number' && quota.windowEnd > this.now()) counter.resetAt = quota.windowEnd;
    counter.used = total; counter.devices = { [this.device]: total }; counter.limit = quota.amount;
    await this.persist();
  }
  private persist() {
    const value = structuredClone(this.counters);
    const pending = structuredClone(this.journal);
    const next = this.writes.then(() => chrome.storage.local.set({ 'backend.usage': value, 'backend.usage.pending': pending }));
    this.writes = next.catch(() => undefined);
    return next;
  }
}
