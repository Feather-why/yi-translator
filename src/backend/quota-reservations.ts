import type { DispatchLifecycle } from './scheduler/batcher';
import { QuotaLedger, type QuotaDefinition, type QuotaReservation } from './scheduler/quota';
const groups = new WeakMap<DispatchLifecycle, QuotaReservation[]>();
/** 同一批次的账户限额和本机预算一起检查、一起提交，避免只扣一层后再发现另一层不足。 */
export async function reserveQuotas(ledger: QuotaLedger, id: string, policies: (QuotaDefinition | undefined)[], cost: number): Promise<QuotaReservation | undefined> {
  const leases: QuotaReservation[] = [];
  try { for (const policy of policies) { const lease = ledger.reserve(id, policy, cost); if (lease) leases.push(lease); } }
  catch (error) { await Promise.all(leases.map(lease => lease.release())); throw error; }
  if (leases.length < 2) return leases[0];
  const combined: QuotaReservation = {
    prepare: async () => { await Promise.all(leases.map(lease => lease.prepare())); },
    dispatch: (batch = [combined]) => {
      const flattened = batch.flatMap(lease => groups.get(lease) ?? [lease]);
      flattened[0]!.dispatch(flattened);
    },
    release: async () => { await Promise.all(leases.map(lease => lease.release())); },
  };
  groups.set(combined, leases); return combined;
}
