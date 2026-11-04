import type { Segment, SegmentTiming, Stage, TranslateJob, TranslateServerMsg } from '../../shared/protocol';
import { ProviderError } from '../providers/types';
import { PriorityQueue } from '../scheduler/queue';
import { OrderedDelivery } from './ordered-delivery';
import type { TranslationObserver } from '../translation-observer';

export interface TranslationValue { text: string; provider: string; cached: boolean; finalOnly?: boolean; timing?: SegmentTiming }
export interface CombinedTranslation { translate(tier: 'fast' | 'accurate', signal: AbortSignal, observer?: TranslationObserver): Promise<TranslationValue>; dispose(): void }
export interface TranslationService {
  translate(job: TranslateJob, segment: Segment, tier: 'fast' | 'accurate', signal: AbortSignal, observer?: TranslationObserver): Promise<TranslationValue>;
  createCombined?(job: TranslateJob, segment: Segment): CombinedTranslation | Promise<CombinedTranslation>;
}

interface SegmentState {
  controllers: Map<Stage, AbortController>;
  fastDone: boolean;
  finalDone: boolean;
  cancelled: boolean;
  priorities: Map<Stage, (priority: number) => void>;
  combined?: Promise<CombinedTranslation>;
  combinedDisposed?: boolean;
  partialTimer?: ReturnType<typeof setTimeout>;
  pendingPartial?: { message: Extract<TranslateServerMsg, { type: 'partial' }>; controller: AbortController };
  lastPartialAt?: number;
  lastPartial?: string;
  finalPreview: boolean;
  fastResult: boolean;
}
type OutputMessage = Extract<TranslateServerMsg, { type: 'result' | 'error' }>;
interface JobState { job: TranslateJob; receivedAt: number; segments: Map<string, SegmentState>; done: Set<Stage>; delivery?: OrderedDelivery<OutputMessage> }

const segmentKinds = new Set(['paragraph', 'sentence', 'subtitle', 'selection', 'ocr', 'pdf']);
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function isStrings(value: unknown): value is string[] { return Array.isArray(value) && Array.from(value).every((item) => typeof item === 'string'); }
function isJob(value: unknown): value is TranslateJob {
  if (!isRecord(value) || typeof value.jobId !== 'string' || !value.jobId ||
    typeof value.sourceLang !== 'string' || !value.sourceLang || typeof value.targetLang !== 'string' || !value.targetLang ||
    typeof value.mode !== 'string' || !['fast', 'accurate', 'combined'].includes(value.mode) || typeof value.priority !== 'number' || !Number.isFinite(value.priority) ||
    !isRecord(value.context) || typeof value.context.url !== 'string' ||
    (value.context.title !== undefined && typeof value.context.title !== 'string') ||
    (value.context.summary !== undefined && typeof value.context.summary !== 'string') ||
    (value.providerHint !== undefined && typeof value.providerHint !== 'string') ||
    (value.noCache !== undefined && typeof value.noCache !== 'boolean') ||
    (value.stream !== undefined && typeof value.stream !== 'boolean') || !Array.isArray(value.segments)) return false;
  return Array.from(value.segments).every((segment) => isRecord(segment) && typeof segment.id === 'string' && !!segment.id &&
    typeof segment.text === 'string' && typeof segment.kind === 'string' && segmentKinds.has(segment.kind) &&
    (segment.groupId === undefined || typeof segment.groupId === 'string'));
}

export class TranslatePort {
  private jobs = new Map<string, JobState>();
  private closed = false;
  private queue: PriorityQueue;
  constructor(private port: chrome.runtime.Port, private service: TranslationService, concurrency = 4, queue?: PriorityQueue) {
    this.queue = queue ?? new PriorityQueue(concurrency);
    port.onMessage.addListener(this.message);
    port.onDisconnect.addListener(this.dispose);
  }

  private post(message: TranslateServerMsg) {
    if (this.closed) return;
    try { this.port.postMessage(message); } catch { this.dispose(); }
  }

  private message = (message: unknown) => {
    if (this.closed || !isRecord(message)) return;
    if (message.type === 'job') {
      const job = message.job;
      if (!isJob(job)) return;
      const old = this.jobs.get(job.jobId);
      if (old) this.cancel(old);
      const state: JobState = { job, receivedAt: performance.now(), segments: new Map(), done: new Set() };
      this.jobs.set(job.jobId, state);
      for (const segment of job.segments) {
        if (state.segments.has(segment.id)) continue;
        state.segments.set(segment.id, { controllers: new Map(), fastDone: job.mode !== 'combined', finalDone: false, cancelled: false, priorities: new Map(), finalPreview: false, fastResult: false });
      }
      if (state.segments.size > 1 && job.segments.every((segment) => ['paragraph', 'sentence', 'pdf'].includes(segment.kind))) {
        state.delivery = new OrderedDelivery([...state.segments.keys()], (value) => this.post(value), () => this.done(state));
      }
      for (const segment of job.segments) {
        const item = state.segments.get(segment.id)!;
        if (item.priorities.size) continue;
        if (job.mode === 'combined') this.enqueue(state, segment, item, 'fast', 'fast');
        this.enqueue(state, segment, item, job.mode === 'fast' ? 'fast' : 'accurate', 'final');
      }
      this.done(state);
    } else {
      if (typeof message.jobId !== 'string') return;
      const state = this.jobs.get(message.jobId);
      if (!state) return;
      if (message.type === 'cancel' && (message.segmentIds === undefined || isStrings(message.segmentIds))) {
        this.cancel(state, message.segmentIds); this.done(state);
      } else if (message.type === 'priority' && typeof message.priority === 'number' && Number.isFinite(message.priority) && isStrings(message.segmentIds)) {
        const priority = message.priority;
        for (const id of message.segmentIds) state.segments.get(id)?.priorities.forEach((set) => set(priority));
      }
    }
  };

  private enqueue(state: JobState, segment: Segment, item: SegmentState, tier: 'fast' | 'accurate', stage: Stage) {
    const controller = new AbortController();
    item.controllers.set(stage, controller);
    let currentPriority = state.job.priority;
    const observer: TranslationObserver = { receivedAt: state.receivedAt, priority: () => currentPriority,
      ...(state.job.stream === true ? { onPartial: (value: Parameters<NonNullable<TranslationObserver['onPartial']>>[0]) => {
        const outputStage = stage === 'fast' && value.finalOnly === true ? 'final' : stage;
        this.partial(state, item, controller, { type: 'partial', jobId: state.job.jobId, segmentId: segment.id,
          stage: outputStage, text: value.text, provider: value.provider });
      } } : {}) };
    const task = this.queue.add(state.job.priority, controller.signal, () => {
      if (state.job.mode !== 'combined' || !this.service.createCombined) return this.service.translate(state.job, segment, tier, controller.signal, observer);
      // 延迟到逻辑槽真正出队才建立共享状态，不为整页的所有待办提前分配调用表。
      if (!item.combined) item.combined = Promise.resolve().then(() => this.service.createCombined!(state.job, segment));
      return item.combined.then((combined) => { controller.signal.throwIfAborted(); return combined.translate(tier, controller.signal, observer); });
    }, tier === 'fast' ? 'fast' : 'final');
    item.priorities.set(stage, (priority) => { currentPriority = priority; task.priority(priority); });
    void task.promise.then((value) => {
      const outputStage = stage === 'fast' && value.finalOnly === true ? 'final' : stage;
      if (!this.complete(state, item, outputStage, stage)) return;
      if (outputStage === 'fast') { item.fastResult = true; this.clearPartial(item); }
      this.output(state, segment.id, { type: 'result', jobId: state.job.jobId, segmentId: segment.id, stage: outputStage,
        text: value.text, provider: value.provider, cached: value.cached, ...(value.timing ? { timing: value.timing } : {}) });
      this.done(state);
    }, (error: unknown) => {
      if (!this.complete(state, item, stage)) return;
      if (stage === 'final') this.output(state, segment.id, { type: 'error', jobId: state.job.jobId, segmentId: segment.id, stage, error: error instanceof ProviderError ? error.info : { code: 'internal', message: '翻译任务执行失败', retryable: true } });
      this.done(state);
    });
  }

  private partial(state: JobState, item: SegmentState, controller: AbortController, message: Extract<TranslateServerMsg, { type: 'partial' }>) {
    if (state.job.stream !== true || !this.current(state, item) || controller.signal.aborted || item.finalDone
      || item.fastResult || message.stage === 'fast' && item.finalPreview) return;
    // 心跳、空role和未写完的纯标记不算“首字”；预览仍允许正文末尾的半个g/x标记。
    if (typeof message.text !== 'string' || !message.text.replace(/<\/?[gx]\d+\/?>/g, '').replace(/<\/?(?:[gx]\d*\/?)?$/g, '').trim()) return;
    if (message.stage === 'final') item.finalPreview = true;
    const key = JSON.stringify([message.stage, message.provider, message.text]);
    if (key === item.lastPartial) { this.clearPartial(item); return; }
    item.pendingPartial = { message, controller };
    const flush = () => {
      item.partialTimer = undefined;
      const pending = item.pendingPartial; item.pendingPartial = undefined;
      if (!pending || !this.current(state, item) || pending.controller.signal.aborted || item.finalDone
        || item.fastResult || pending.message.stage === 'fast' && item.finalPreview) return;
      item.lastPartialAt = performance.now(); item.lastPartial = JSON.stringify([pending.message.stage, pending.message.provider, pending.message.text]);
      // 中间预览不进入完整结果的250ms阅读顺序缓冲，避免一批预览同时补发或误记完成。
      this.post(pending.message);
    };
    const wait = item.lastPartialAt === undefined ? 0 : Math.max(0, 80 - (performance.now() - item.lastPartialAt));
    if (item.partialTimer !== undefined) return;
    if (wait <= 0) flush(); else item.partialTimer = setTimeout(flush, wait);
  }

  private clearPartial(item: SegmentState) {
    if (item.partialTimer !== undefined) clearTimeout(item.partialTimer);
    item.partialTimer = undefined; item.pendingPartial = undefined;
  }

  private output(state: JobState, id: string, value: OutputMessage) {
    if (state.delivery) state.delivery.push(id, value); else this.post(value);
  }

  private complete(state: JobState, item: SegmentState, stage: Stage, finishedStage = stage): boolean {
    item.controllers.delete(finishedStage);
    item.priorities.delete(finishedStage);
    if (!this.current(state, item) || (stage === 'fast' ? item.fastDone || item.finalDone : item.finalDone)) return false;
    if (stage === 'final' || item.pendingPartial?.message.stage === 'fast') this.clearPartial(item);
    if (stage === 'final') {
      // 精确缓存或记忆也直接完成 final，并在回包前关掉另一路，避免重复 final 或浅色覆盖。
      item.finalDone = true;
      item.fastDone = true;
      item.controllers.forEach((controller) => controller.abort());
      item.controllers.clear();
      item.priorities.clear();
      this.disposeCombined(item);
    } else item.fastDone = true;
    return true;
  }

  private current(state: JobState, item: SegmentState) { return !this.closed && this.jobs.get(state.job.jobId) === state && !item.cancelled; }
  private disposeCombined(item: SegmentState) {
    if (item.combinedDisposed) return;
    item.combinedDisposed = true;
    if (item.combined) void item.combined.then((combined) => combined.dispose(), () => undefined);
  }
  private cancel(state: JobState, ids?: string[]) {
    const selected = ids ? new Set(ids) : undefined;
    for (const [id, item] of state.segments) if (!selected || selected.has(id)) {
      item.cancelled = true;
      this.clearPartial(item);
      item.controllers.forEach((controller) => controller.abort());
      item.controllers.clear();
      item.priorities.clear();
      this.disposeCombined(item);
    }
    if (ids) state.delivery?.cancel(ids); else state.delivery?.dispose();
  }
  private done(state: JobState) {
    if (this.closed || this.jobs.get(state.job.jobId) !== state) return;
    const items = [...state.segments.values()];
    // 全部取消的 job 不再发消息；部分取消的 job 仍需让存活片段正常结束。
    if (items.length && items.every((item) => item.cancelled)) { this.jobs.delete(state.job.jobId); return; }
    if (state.delivery?.waiting) return;
    for (const stage of state.job.mode === 'combined' ? ['fast', 'final'] as const : ['final'] as const) {
      if (!state.done.has(stage) && items.every((item) => item.cancelled || (stage === 'fast' ? item.fastDone : item.finalDone))) {
        state.done.add(stage);
        this.post({ type: 'job-done', jobId: state.job.jobId, stage });
      }
    }
    if (state.done.has('final')) { state.delivery?.dispose(); this.jobs.delete(state.job.jobId); }
  }

  dispose = () => {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.jobs.values()) this.cancel(state);
    this.jobs.clear();
    this.port.onMessage.removeListener(this.message);
    this.port.onDisconnect.removeListener(this.dispose);
  };
}
