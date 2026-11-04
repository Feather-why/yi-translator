interface Task {
  priority: number;
  lane: 'fast' | 'final';
  queuedAt: number;
  sequence: number;
  signal: AbortSignal;
  run(): Promise<unknown>;
  finish(ok: boolean, value: unknown): void;
  abort(): void;
  started: boolean;
  settled: boolean;
}

/** 延后一轮出队，让同一批消息中的首屏任务先于预取任务。 */
export class PriorityQueue {
  private tasks: Task[] = [];
  private running = 0;
  private sequence = 0;
  private scheduled = false;
  private fastBurst = 0;
  private runningFinal = 0;
  private reservedFast: number;
  constructor(private concurrency = 4, private now: () => number = Date.now) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('并发数必须是正整数');
    this.reservedFast = concurrency > 4 ? Math.min(8, Math.floor(concurrency / 4)) : 0;
  }

  add<T>(priority: number, signal: AbortSignal, run: () => Promise<T>, lane: 'fast' | 'final' = 'fast'): { promise: Promise<T>; priority(value: number): void } {
    let task: Task;
    const promise = new Promise<T>((resolve, reject) => {
      task = {
        priority: Number.isFinite(priority) ? priority : 100, lane, queuedAt: this.now(), sequence: this.sequence++, signal, run,
        started: false, settled: false,
        finish: (ok, value) => {
          if (task.settled) return;
          task.settled = true;
          signal.removeEventListener('abort', task.abort);
          if (task.started) { this.running--; if (task.lane === 'final') this.runningFinal--; }
          else {
            const index = this.tasks.indexOf(task);
            if (index >= 0) this.tasks.splice(index, 1);
          }
          if (ok) resolve(value as T); else reject(value);
          this.schedule();
        },
        abort: () => task.finish(false, new DOMException('取消', 'AbortError')),
      };
      if (signal.aborted) { task.abort(); return; }
      signal.addEventListener('abort', task.abort, { once: true });
      this.tasks.push(task);
      this.schedule();
    });
    return { promise, priority: (value) => { if (!task.settled && Number.isFinite(value)) { task.priority = value; this.schedule(); } } };
  }

  private schedule() {
    if (this.scheduled || !this.tasks.length) return;
    this.scheduled = true;
    setTimeout(() => { this.scheduled = false; this.drain(); }, 0);
  }

  private drain() {
    this.tasks.sort((a, b) => a.priority - b.priority || (a.lane === b.lane ? 0 : a.lane === 'fast' ? -1 : 1) || a.sequence - b.sequence);
    while (this.running < this.concurrency && this.tasks.length) {
      const first = this.tasks[0]!;
      // 数值视口优先级始终先于档位；同层每三次浅译给精确档一个槽，等待时长不能抬高后台任务。
      const aged = first.lane === 'final' || this.fastBurst >= 3
        ? this.tasks.filter((task) => task.lane === 'final' && task.priority <= first.priority && this.now() - task.queuedAt >= 1000)
          .sort((a, b) => a.queuedAt - b.queuedAt || a.sequence - b.sequence)[0] : undefined;
      const fair = this.fastBurst >= 3 ? this.tasks.find((task) => task.lane === 'final' && task.priority <= first.priority) : undefined;
      let task = aged ?? fair ?? first;
      if (task.lane === 'final' && this.runningFinal >= this.concurrency - this.reservedFast) {
        // 保留入口不允许低视口优先级fast越过高优先级final；默认四槽不保留。
        const fast = this.tasks.find((candidate) => candidate.lane === 'fast' && candidate.priority === first.priority);
        if (!fast) break;
        task = fast;
      }
      this.tasks.splice(this.tasks.indexOf(task), 1);
      if (task.signal.aborted) { task.abort(); continue; }
      this.fastBurst = task.lane === 'fast' ? this.fastBurst + 1 : 0;
      task.started = true;
      this.running++;
      if (task.lane === 'final') this.runningFinal++;
      // 取消时立即释放逻辑槽；即使某个适配器迟迟不结束，也不挡住其他页面。
      void Promise.resolve().then(() => {
        if (task.signal.aborted) throw new DOMException('取消', 'AbortError');
        return task.run();
      }).then((value) => task.finish(true, value), (error: unknown) => task.finish(false, error));
    }
  }
}
