import { ProviderError, type ProviderContext, type ProviderDef, type ProviderRequest } from '../providers/types';
import type { RequestObservation } from '../translation-trace';
import { readScheduling, type BatchScheduling, type DispatchPermit } from './provider-slots';

/** 同批leases由第一个lease所属协调器统一校验并原子提交，不逐项先扣费再发现后一项失效。 */
export interface DispatchLifecycle { prepare(): Promise<void>; dispatch(batch?: readonly DispatchLifecycle[]): void }

interface Item {
  provider: ProviderDef;
  request: ProviderRequest;
  context: (signal: AbortSignal) => ProviderContext;
  signal: AbortSignal;
  abort: () => void;
  resolve: (texts: string[]) => void;
  reject: (error: unknown) => void;
  results: string[];
  remaining: number;
  settled: boolean;
  batches: Set<Batch>;
  observation?: RequestObservation;
  scheduling?: BatchScheduling;
  lifecycle?: DispatchLifecycle;
}

interface Unit { item: Item; index: number; text: string }
interface Batch { units: Unit[]; controller: AbortController }
type BatchExecutor = (provider: ProviderDef, signal: AbortSignal, run: (dispatch?: () => Promise<DispatchPermit>) => Promise<string[]>, scheduling?: BatchScheduling) => Promise<string[]>;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('请求已取消', 'AbortError');
}

/** 留出5ms聚合同组请求；额度预备仅在真实出槽后落盘，不为等槽任务永久计费。 */
export class ProviderBatcher {
  private pending = new Map<string, Unit[]>();
  private scheduled = false;

  constructor(private readonly executeBatch?: BatchExecutor) {}

  request(provider: ProviderDef, request: ProviderRequest, signal: AbortSignal,
    context: (signal: AbortSignal) => ProviderContext, observation?: RequestObservation, scheduling?: BatchScheduling, lifecycle?: DispatchLifecycle): Promise<string[]> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    if (!request.texts.length) return Promise.resolve([]);
    const { maxChars, maxSegments } = provider.limits;
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || !Number.isSafeInteger(maxSegments) || maxSegments < 1
      || request.texts.some((text) => typeof text !== 'string' || text.length > maxChars)) {
      return Promise.reject(new ProviderError({ code: 'bad_input', message: '翻译片段超过服务批量限制', retryable: false }));
    }

    // 按协议字段确定上下文，调用方构造对象时的属性顺序不影响是否可以合批。
    const page = request.context;
    const key = JSON.stringify([provider.id, provider.version, request.sourceLang, request.targetLang,
      page ? [page.url, page.title ?? null, page.summary ?? null] : null, request.strictPlaceholders ?? false,
      request.terminology?.map(({ source, target }) => [source, target]) ?? null, request.stream === true, request.quality ?? 'accurate', readScheduling(scheduling).manual]);
    return new Promise<string[]>((resolve, reject) => {
      const item: Item = { provider, request: { ...request, texts: request.texts.slice(), ...(page ? { context: { ...page } } : {}) },
        context, signal, abort: () => {}, resolve, reject, results: new Array<string>(request.texts.length),
        remaining: request.texts.length, settled: false, batches: new Set(), observation, scheduling, lifecycle };
      item.abort = () => this.fail(item, abortReason(signal));
      signal.addEventListener('abort', item.abort, { once: true });
      // 监听器安装前后的取消都生效，不能让已取消任务占用下一个共享请求。
      if (signal.aborted) { item.abort(); return; }
      const queue = this.pending.get(key) ?? [];
      item.request.texts.forEach((text, index) => queue.push({ item, index, text }));
      this.pending.set(key, queue);
      if (!this.scheduled) { this.scheduled = true; setTimeout(() => this.flush(), 5); }
    });
  }

  private fail(item: Item, error: unknown): void {
    if (item.settled) return;
    item.settled = true;
    item.signal.removeEventListener('abort', item.abort);
    item.reject(error);
    for (const batch of item.batches) this.abortIfUnused(batch);
  }

  private abortIfUnused(batch: Batch): void {
    // 一个消费者取消不能中止其他消费者的翻译；全部退出才中断实际网络请求。
    if (batch.units.every(({ item }) => item.settled)) batch.controller.abort();
  }

  private flush(): void {
    const pending = this.pending;
    this.pending = new Map();
    this.scheduled = false;
    for (const queue of pending.values()) {
      let batch: Unit[] = [];
      let chars = 0;
      for (const unit of queue) {
        if (unit.item.settled) continue;
        const limits = unit.item.provider.limits;
        if (batch.length && (batch.length >= limits.maxSegments || chars + unit.text.length > limits.maxChars)) {
          void this.execute(batch);
          batch = [];
          chars = 0;
        }
        batch.push(unit);
        chars += unit.text.length;
      }
      if (batch.length) void this.execute(batch);
    }
  }

  private async execute(units: Unit[]): Promise<void> {
    const first = units[0];
    if (!first) return;
    const batch: Batch = { units, controller: new AbortController() };
    const consumers = new Set(units.map(({ item }) => item));
    for (const item of consumers) item.batches.add(batch);
    try {
      this.abortIfUnused(batch);
      batch.controller.signal.throwIfAborted();
      let dispatched = units;
      const best = () => [...consumers].filter((item) => !item.settled && !item.signal.aborted).map((item) => readScheduling(item.scheduling))
        .sort((a, b) => a.priority - b.priority || (a.lane === b.lane ? 0 : a.lane === 'fast' ? -1 : 1))[0] ?? { priority: 100, lane: 'final' as const, manual: false };
      const scheduling: BatchScheduling = { priority: () => best().priority, lane: () => best().lane, manual: () => best().manual };
      const run = async (dispatch?: () => Promise<DispatchPermit>) => {
        // 批次可能在限流队列等待期间被全部取消，获得执行槽后也不能再发送请求。
        batch.controller.signal.throwIfAborted();
        await Promise.all([...consumers].filter((item) => !item.settled && !item.signal.aborted).map(async (item) => {
          try { await item.lifecycle?.prepare(); }
          catch (error) { if (!item.settled && !item.signal.aborted) throw error; }
        }));
        // 预备记录落盘时可以取消成员；只有最后仍存活的成员进入真实请求和永久用量。
        batch.controller.signal.throwIfAborted();
        const markDispatch = await dispatch?.();
        batch.controller.signal.throwIfAborted();
        dispatched = units.filter(({ item }) => !item.settled && !item.signal.aborted);
        const active = dispatched[0]!;
        if (!active) throw new DOMException('取消', 'AbortError');
        const req: ProviderRequest = { ...active.item.request, texts: dispatched.map(({ text }) => text) };
        const contexts = new Map([...consumers].filter((item) => !item.settled && !item.signal.aborted).map((item) => [item, item.context(batch.controller.signal)]));
        const callbacks = new Map([...contexts].map(([item, value]) => [item, { onPartial: value.onPartial, onRequestStart: value.onRequestStart, onRequestEnd: value.onRequestEnd }]));
        const context = contexts.get(active.item)!;
        let requested = false;
        const broadcast = (start: boolean, at: number) => {
          if (start) requested = true;
          for (const item of consumers) {
            if (item.settled || item.signal.aborted) continue;
            try { if (start) callbacks.get(item)?.onRequestStart?.(); else callbacks.get(item)?.onRequestEnd?.(); } catch { /* 时序观察独立于业务。 */ }
            try { if (start) item.observation?.onRequestStart?.(at); else item.observation?.onRequestEnd?.(at); } catch { /* 统计异常隔离。 */ }
          }
        };
        // 保留gate所有权到首次真实HTTP：适配器内部异步签名不能把两个发送起点收拢。
        context.onRequestStart = () => { markDispatch?.(); broadcast(true, performance.now()); };
        context.onRequestEnd = () => broadcast(false, performance.now());
        context.onPartial = (text, offset) => {
          if (typeof text !== 'string' || !Number.isSafeInteger(offset)) return;
          const unit = dispatched[offset];
          if (req.stream !== true || !unit || unit.item.settled || unit.item.signal.aborted || batch.controller.signal.aborted) return;
          try { callbacks.get(unit.item)?.onPartial?.(text, unit.index); } catch { /* 单段预览不影响其余成员。 */ }
          try { unit.item.observation?.onPartial?.(text, unit.index); } catch { /* 单段观察者异常隔离。 */ }
        };
        const dispatchStarted = performance.now();
        try {
          const lifecycles = [...new Set(dispatched.map(({ item }) => item))].flatMap((item) => item.lifecycle ? [item.lifecycle] : []);
          markDispatch?.validate?.();
          lifecycles[0]?.dispatch(lifecycles);
          if (active.item.provider.kind === 'builtin') markDispatch?.();
          const result = await active.item.provider.translate(req, context);
          if (!Array.isArray(result) || result.length !== dispatched.length || result.some((text) => typeof text !== 'string')) {
            throw new ProviderError({ code: 'server', message: '翻译服务返回的批量片段数量或格式异常', retryable: true });
          }
          if (!requested) markDispatch?.();
          return result;
        }
        finally {
          // 原生Window翻译不经过ctx.fetch；补计真正出槽后的服务调用区间，不算HTTP。
          if (!requested) { broadcast(true, dispatchStarted); broadcast(false, performance.now()); }
        }
      };
      const result = this.executeBatch
        ? await this.executeBatch(first.item.provider, batch.controller.signal, run, scheduling)
        : await run();
      if (!Array.isArray(result) || result.length !== dispatched.length || result.some((text) => typeof text !== 'string')) {
        throw new ProviderError({ code: 'server', message: '翻译服务返回的批量片段数量或格式异常', retryable: true });
      }
      dispatched.forEach(({ item, index }, offset) => {
        if (item.settled) return;
        item.results[index] = result[offset]!;
        item.remaining--;
        if (item.remaining === 0) {
          item.settled = true;
          item.signal.removeEventListener('abort', item.abort);
          item.resolve(item.results);
        }
      });
    } catch (error) {
      for (const item of consumers) this.fail(item, error);
    } finally {
      for (const item of consumers) item.batches.delete(batch);
    }
  }
}
