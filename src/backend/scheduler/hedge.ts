/** 首选超时或失败时才发第二份；获胜或父任务取消后终止另一份。 */
export function raceWithHedge<T>(first: (signal: AbortSignal) => Promise<T>, second: (signal: AbortSignal) => Promise<T>, delayMs: number, parent: AbortSignal): Promise<T> {
  if (parent.aborted) return Promise.reject(parent.reason ?? new DOMException('取消', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const controllers = [new AbortController(), new AbortController()];
    let settled = false, secondaryStarted = false, failures = 0;
    const cleanup = () => { clearTimeout(timer); parent.removeEventListener('abort', abort); };
    const abort = () => {
      if (settled) return;
      settled = true; cleanup(); controllers.forEach((controller) => controller.abort());
      reject(parent.reason ?? new DOMException('取消', 'AbortError'));
    };
    const run = (index: number) => {
      const controller = controllers[index]!;
      Promise.resolve().then(() => (index === 0 ? first : second)(controller.signal)).then((value) => {
        if (settled) return;
        settled = true; cleanup(); controllers[1 - index]!.abort(); resolve(value);
      }, (error: unknown) => {
        if (settled) return;
        failures++;
        if (failures === 2) { settled = true; cleanup(); reject(error); }
        else if (index === 0 && !secondaryStarted) startSecond();
      });
    };
    const startSecond = () => { if (!settled && !secondaryStarted) { secondaryStarted = true; clearTimeout(timer); run(1); } };
    const timer = setTimeout(startSecond, Math.max(0, delayMs));
    parent.addEventListener('abort', abort, { once: true });
    if (parent.aborted) { abort(); return; }
    run(0);
  });
}
