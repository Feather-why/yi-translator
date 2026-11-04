export interface OcrWorker<T> {
  initialize(signal: AbortSignal): Promise<void>;
  predict(dataUrl: string, signal: AbortSignal): Promise<T>;
  destroy(): void;
}
export class OcrTimeoutError extends Error {}
export class OcrWorkerUnavailableError extends Error {}
interface OcrRunnerOptions<T> {
  create(): OcrWorker<T>;
  now?: () => number;
  timeoutMs?: number;
  initializeMs?: number;
  predictMs?: number;
  idleMs?: number;
  maxQueued?: number;
}
interface Task<T> {
  dataUrl: string;
  deadline: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  detach?: () => void;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** 超时销毁整个推理容器，而非只丢掉回信；等待时间也计入总预算。 */
export class OcrRunner<T> {
  private worker?: OcrWorker<T>;
  private initialized = false;
  private generation = 0;
  private queue: Task<T>[] = [];
  private active?: Task<T>;
  private running = false;
  private disposed = false;
  private idle?: ReturnType<typeof setTimeout>;
  private now: () => number;
  private timeoutMs: number;
  private initializeMs: number;
  private predictMs: number;
  private idleMs: number;
  private maxQueued: number;
  constructor(private options: OcrRunnerOptions<T>) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 270_000;
    this.initializeMs = options.initializeMs ?? 200_000;
    this.predictMs = options.predictMs ?? 180_000;
    this.idleMs = options.idleMs ?? 600_000;
    this.maxQueued = options.maxQueued ?? 3;
    if ([this.timeoutMs, this.initializeMs, this.predictMs, this.idleMs].some((value) => !Number.isSafeInteger(value) || value < 1)
      || !Number.isSafeInteger(this.maxQueued) || this.maxQueued < 0) throw new Error('OCR 运行预算无效');
  }
  run(dataUrl: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.disposed) return Promise.reject(new Error('OCR 运行器已关闭'));
    if (this.queue.length >= this.maxQueued && this.running) return Promise.reject(new Error('OCR 等待请求过多，请稍后再试'));
    clearTimeout(this.idle); this.idle = undefined;
    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = { dataUrl, deadline: this.now() + this.timeoutMs, controller: new AbortController(), settled: false,
        timer: setTimeout(() => {
          const error = new OcrTimeoutError('OCR 总处理时间已超过限制');
          task.controller.abort(error); this.finish(task, false, error);
        }, this.timeoutMs), resolve, reject };
      if (signal) {
        const abort = () => { task.controller.abort(signal.reason); this.finish(task, false, signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        task.detach = () => signal.removeEventListener('abort', abort);
      }
      this.queue.push(task); void this.drain();
    });
  }
  private finish(task: Task<T>, ok: boolean, value: unknown) {
    if (task.settled) return;
    task.settled = true; clearTimeout(task.timer); task.detach?.(); task.dataUrl = '';
    const index = this.queue.indexOf(task); if (index >= 0) this.queue.splice(index, 1);
    if (ok) task.resolve(value as T); else task.reject(value);
  }
  private reset(worker = this.worker) {
    if (!worker || worker !== this.worker) return;
    this.worker = undefined; this.initialized = false; this.generation++;
    try { worker.destroy(); } catch { /* 容器已导航或被移除也应允许下一次重新创建。 */ }
  }
  private async stage<R>(task: Task<T>, budget: number, run: (signal: AbortSignal) => Promise<R>): Promise<R> {
    task.controller.signal.throwIfAborted();
    const remaining = task.deadline - this.now();
    if (remaining <= 0) throw new OcrTimeoutError('OCR 总处理时间已超过限制');
    const controller = new AbortController(), deadline = Math.min(task.deadline, this.now() + budget);
    const abort = () => controller.abort(task.controller.signal.reason);
    task.controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new OcrTimeoutError('OCR 本地推理超时')), Math.min(budget, remaining));
    try {
      return await new Promise<R>((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        void Promise.resolve().then(() => { controller.signal.throwIfAborted(); return run(controller.signal); }).then((value) => {
          if (controller.signal.aborted) reject(controller.signal.reason);
          else if (this.now() > deadline) reject(new OcrTimeoutError('OCR 本地推理超时'));
          else resolve(value);
        }, reject);
        if (task.controller.signal.aborted) abort();
      });
    } finally {
      clearTimeout(timer); task.controller.signal.removeEventListener('abort', abort);
      // 初始化含并行模型读取，一路失败后也要停止另一条，不留下旧代下载。
      controller.abort(new DOMException('OCR 阶段已结束', 'AbortError'));
    }
  }
  private async execute(task: Task<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      task.controller.signal.throwIfAborted();
      const worker = this.worker ??= this.options.create(), generation = this.generation;
      try {
        if (!this.initialized) {
          await this.stage(task, this.initializeMs, (signal) => worker.initialize(signal));
          if (generation !== this.generation || worker !== this.worker) throw new OcrWorkerUnavailableError('OCR 容器已更新');
          this.initialized = true;
        }
        const result = await this.stage(task, this.predictMs, (signal) => worker.predict(task.dataUrl, signal));
        if (generation !== this.generation || worker !== this.worker) throw new OcrWorkerUnavailableError('OCR 容器已更新');
        return result;
      } catch (error) {
        this.reset(worker);
        // 仅超时/容器通信失效允许自动重试一次，坏图片或模型明确报错不重复执行。
        if (attempt > 0 || task.controller.signal.aborted || this.now() >= task.deadline
          || !(error instanceof OcrTimeoutError || error instanceof OcrWorkerUnavailableError)) throw error;
      }
    }
    throw new Error('OCR 恢复失败');
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const task = this.queue.shift()!;
        if (task.settled) continue;
        this.active = task;
        try { this.finish(task, true, await this.execute(task)); }
        catch (error) { this.finish(task, false, error); }
        finally { this.active = undefined; }
      }
    } finally {
      this.running = false;
      if (this.worker && !this.disposed) this.idle = setTimeout(() => {
        this.idle = undefined;
        if (!this.running && !this.queue.length) this.reset();
      }, this.idleMs);
    }
  }
  dispose() {
    this.disposed = true; clearTimeout(this.idle); this.idle = undefined;
    const error = new Error('OCR 运行器已关闭');
    for (const task of [...this.queue, ...(this.active ? [this.active] : [])]) { task.controller.abort(error); this.finish(task, false, error); }
    this.reset();
  }
}
