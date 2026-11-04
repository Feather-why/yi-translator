import { ProviderError } from '../providers/types';

export interface BatchScheduling { priority(): number; lane(): 'fast' | 'final'; manual?(): boolean }
export interface SlotRuntime { active: number; nextRequest: number; nextDispatch?: number; cooldown: number; failures: number; halfOpen?: boolean; exhaustedUntil?: number }
export interface DispatchPermit { (): void; validate?(): void }
export interface ProviderLease { (): void; dispatch(): Promise<DispatchPermit> }
interface Access { runtime(): SlotRuntime | undefined; limits(): { concurrency: number; qps?: number }; allowed?(manual: boolean): boolean }
interface Waiter { signal: AbortSignal; access: Access; scheduling?: BatchScheduling; sequence: number; resolve(release: () => void): void; reject(error: unknown): void; abort(): void; settled: boolean }
interface Lane { waiters: Waiter[]; fastBurst: number; timer?: ReturnType<typeof setTimeout> }
interface DispatchLane extends Lane { current?: Waiter }

export function readScheduling(value?: BatchScheduling) {
  let priority = 100, lane: 'fast' | 'final' = 'final';
  try { const current = value?.priority(); if (typeof current === 'number' && Number.isFinite(current)) priority = current; } catch { /* 调度提示异常不能阻断业务。 */ }
  try { if (value?.lane() === 'fast') lane = 'fast'; } catch { /* 缺省走最终档。 */ }
  let manual = false; try { manual = value?.manual?.() === true; } catch { /* 普通任务不能借坏的提示绕过暂停。 */ }
  return { priority, lane, manual };
}

/** 只调度尚未发送的真实批次；运行中的推理不抢断，取消/释放立即唤醒。 */
export class ProviderSlots {
  private lanes = new Map<string, Lane>();
  private dispatches = new Map<string, DispatchLane>();
  private scheduled = false;
  private sequence = 0;
  constructor(private now: () => number = Date.now, private changed: () => void = () => {}) {}
  acquire(id: string, access: Access, signal: AbortSignal, scheduling?: BatchScheduling): Promise<ProviderLease> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('取消', 'AbortError'));
    return new Promise<ProviderLease>((resolve, reject) => {
      const lane = this.lanes.get(id) ?? { waiters: [], fastBurst: 0 };
      this.lanes.set(id, lane);
      const waiter: Waiter = { signal, access, scheduling, sequence: this.sequence++, resolve: (release) => resolve(release as ProviderLease), reject, settled: false, abort: () => {} };
      waiter.abort = () => { this.reject(lane, waiter, signal.reason ?? new DOMException('取消', 'AbortError')); this.wake(); };
      lane.waiters.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
      if (signal.aborted) waiter.abort(); else this.wake();
    });
  }
  wake() {
    if (this.scheduled || !this.lanes.size && !this.dispatches.size) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const [id, lane] of this.lanes) this.drain(id, lane);
      for (const [id, lane] of this.dispatches) this.drainDispatch(id, lane);
    });
  }
  private reject(lane: Lane, waiter: Waiter, error: unknown) {
    if (waiter.settled) return;
    waiter.settled = true; waiter.signal.removeEventListener('abort', waiter.abort);
    const index = lane.waiters.indexOf(waiter); if (index >= 0) lane.waiters.splice(index, 1);
    waiter.reject(error);
  }
  private drain(id: string, lane: Lane) {
    clearTimeout(lane.timer); lane.timer = undefined;
    for (const waiter of [...lane.waiters]) {
      if (waiter.signal.aborted) { waiter.abort(); continue; }
      const runtime = waiter.access.runtime();
      if (!runtime || runtime.cooldown > this.now() || (runtime.exhaustedUntil ?? 0) > this.now()) this.reject(lane, waiter, new ProviderError({ code: 'no_provider', provider: id,
        message: !runtime ? '翻译服务已删除' : (runtime.exhaustedUntil ?? 0) > this.now() ? '服务预算已用尽' : '服务正在冷却，稍后自动探测', retryable: !!runtime }));
      else if (waiter.access.allowed && !waiter.access.allowed(readScheduling(waiter.scheduling).manual)) this.reject(lane, waiter,
        new ProviderError({ code: 'no_provider', provider: id, message: '服务已暂停、停用或配置已变更', retryable: false }));
    }
    while (lane.waiters.length) {
      const ranked = lane.waiters.map((waiter) => ({ waiter, ...readScheduling(waiter.scheduling) }))
        .sort((a, b) => a.priority - b.priority || (a.lane === b.lane ? 0 : a.lane === 'fast' ? -1 : 1) || a.waiter.sequence - b.waiter.sequence);
      const first = ranked[0]!, fair = lane.fastBurst >= 3 ? ranked.find((entry) => entry.priority === first.priority && entry.lane === 'final') : undefined;
      const selected = fair ?? first, waiter = selected.waiter, runtime = waiter.access.runtime();
      if (!runtime) { this.reject(lane, waiter, new ProviderError({ code: 'no_provider', provider: id, message: '翻译服务已删除', retryable: false })); continue; }
      const limits = waiter.access.limits();
      if (runtime.active >= limits.concurrency || runtime.halfOpen) break;
      const wait = Math.max(runtime.nextRequest, runtime.nextDispatch ?? 0) - this.now();
      if (wait > 0) { lane.timer = setTimeout(() => this.wake(), wait); break; }
      lane.waiters.splice(lane.waiters.indexOf(waiter), 1); waiter.settled = true; waiter.signal.removeEventListener('abort', waiter.abort);
      const probe = runtime.failures >= 3 || runtime.cooldown > 0;
      if (probe) runtime.halfOpen = true;
      runtime.active++;
      const previousRequest = runtime.nextRequest;
      if (limits.qps) runtime.nextRequest = this.now() + 1000 / limits.qps;
      const grantRequest = runtime.nextRequest;
      lane.fastBurst = selected.lane === 'fast' ? lane.fastBurst + 1 : 0;
      let released = false, dispatched = false, cancelDispatch = () => {};
      let gate: Promise<DispatchPermit> | undefined;
      const release = (() => {
        if (released) return; released = true;
        cancelDispatch();
        // 只有仍是最后一份预约时才撤销；不能撤掉其他在途批次的QPS预约。
        if (!dispatched && limits.qps && runtime.nextRequest === grantRequest) runtime.nextRequest = Math.max(previousRequest, runtime.nextDispatch ?? 0);
        runtime.active--; if (probe) runtime.halfOpen = false;
        this.changed(); this.wake();
      }) as ProviderLease;
      release.dispatch = () => {
        if (released || waiter.signal.aborted) return Promise.reject(waiter.signal.reason ?? new DOMException('取消', 'AbortError'));
        if (!waiter.access.limits().qps) {
          const permit: DispatchPermit = () => { dispatched = true; };
          permit.validate = () => { if (released) throw new DOMException('取消', 'AbortError'); this.dispatchRuntime(id, waiter); };
          try { permit.validate(); return Promise.resolve(permit); } catch (error) { return Promise.reject(error); }
        }
        if (!gate) {
          const request = this.dispatch(id, waiter.access, waiter.signal, waiter.scheduling, () => { dispatched = true; });
          cancelDispatch = request.cancel; gate = request.promise;
        }
        return gate;
      };
      waiter.resolve(release);
      this.changed();
    }
    // 无待办即释放队列元数据；实际在途数量继续由runtime持有。
    if (!lane.waiters.length && !lane.timer) this.lanes.delete(id);
  }
  private dispatch(id: string, access: Access, signal: AbortSignal, scheduling: BatchScheduling | undefined, sent: () => void) {
    const lane: DispatchLane = this.dispatches.get(id) ?? { waiters: [], fastBurst: 0 };
    this.dispatches.set(id, lane);
    let waiter!: Waiter;
    const promise = new Promise<DispatchPermit>((resolve, reject) => {
      waiter = { signal, access, scheduling, sequence: this.sequence++, settled: false, resolve: (mark) => {
        const permit: DispatchPermit = () => { sent(); mark(); }; permit.validate = (mark as DispatchPermit).validate; resolve(permit);
      }, reject, abort: () => {} };
      waiter.abort = () => { this.reject(lane, waiter, signal.reason ?? new DOMException('取消', 'AbortError')); this.wake(); };
      lane.waiters.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
      if (signal.aborted) waiter.abort(); else this.wake();
    });
    return { promise, cancel: () => {
      if (lane.current === waiter) lane.current = undefined;
      else this.reject(lane, waiter, signal.reason ?? new DOMException('取消', 'AbortError'));
      this.wake();
    } };
  }
  private dispatchRuntime(id: string, waiter: Waiter) {
    waiter.signal.throwIfAborted();
    const runtime = waiter.access.runtime();
    if (!runtime || runtime.cooldown > this.now() || (runtime.exhaustedUntil ?? 0) > this.now()
      || waiter.access.allowed && !waiter.access.allowed(readScheduling(waiter.scheduling).manual)) {
      throw new ProviderError({ code: 'no_provider', provider: id, message: '服务当前无法发送请求', retryable: !!runtime });
    }
    return runtime;
  }
  private drainDispatch(id: string, lane: DispatchLane) {
    clearTimeout(lane.timer); lane.timer = undefined;
    for (const waiter of [...lane.waiters]) {
      if (waiter.signal.aborted) { waiter.abort(); continue; }
      try { this.dispatchRuntime(id, waiter); } catch (error) { this.reject(lane, waiter, error); }
    }
    if (!lane.current && lane.waiters.length) {
      const ranked = lane.waiters.map((waiter) => ({ waiter, ...readScheduling(waiter.scheduling) }))
        .sort((a, b) => a.priority - b.priority || (a.lane === b.lane ? 0 : a.lane === 'fast' ? -1 : 1) || a.waiter.sequence - b.waiter.sequence);
      const first = ranked[0]!, selected = lane.fastBurst >= 3 ? ranked.find((entry) => entry.priority === first.priority && entry.lane === 'final') ?? first : first;
      const waiter = selected.waiter, runtime = waiter.access.runtime()!;
      // grant的预约与最终发送各自记时；已足够间隔的正常准备不会再多等一轮。
      const wait = (runtime.nextDispatch ?? 0) - this.now();
      if (wait > 0) lane.timer = setTimeout(() => this.wake(), wait);
      else {
        lane.waiters.splice(lane.waiters.indexOf(waiter), 1); waiter.settled = true; waiter.signal.removeEventListener('abort', waiter.abort); lane.current = waiter;
        let marked = false;
        const mark: DispatchPermit = () => {
          if (marked || lane.current !== waiter) return; marked = true; lane.current = undefined;
          const qps = waiter.access.limits().qps;
          if (qps) runtime.nextDispatch = this.now() + 1000 / qps;
          lane.fastBurst = selected.lane === 'fast' ? lane.fastBurst + 1 : 0;
          this.changed(); this.wake();
        };
        mark.validate = () => {
          if (lane.current !== waiter) throw new DOMException('取消', 'AbortError');
          this.dispatchRuntime(id, waiter);
        };
        waiter.resolve(mark);
      }
    }
    if (!lane.waiters.length && !lane.current && !lane.timer) this.dispatches.delete(id);
  }
}

