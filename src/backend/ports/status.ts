import type { StatusSnapshot } from '../../shared/protocol';

export interface StatusService {
  snapshot(): StatusSnapshot;
  subscribe(callback: (immediate?: boolean) => void): () => void;
  probe(id?: string): Promise<void>;
  action(id: string, action: 'pin' | 'unpin' | 'pause' | 'resume'): Promise<void>;
}

const hubs = new WeakMap<StatusService, StatusHub>();
/** 多个标签页共享一次快照计算；普通活跃计数合并，错误与人工操作即时通知。 */
class StatusHub {
  private listeners = new Set<(snapshot: StatusSnapshot) => void>();
  private cached?: StatusSnapshot;
  private timer?: ReturnType<typeof setTimeout>;
  private periodic: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  private closed = false;
  constructor(private service: StatusService) {
    this.unsubscribe = service.subscribe((immediate) => {
      this.cached = undefined;
      if (this.closed || !this.listeners.size) return;
      if (immediate) this.flush();
      else if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), 100);
    });
    this.periodic = setInterval(() => { this.cached = undefined; this.flush(); }, 5000);
  }
  subscribe(listener: (snapshot: StatusSnapshot) => void) {
    this.listeners.add(listener);
    try { listener(this.cached ??= this.service.snapshot()); } catch { /* 暂时无法读取状态时等待后续通知。 */ }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size || this.closed) return;
      this.closed = true; this.unsubscribe(); clearInterval(this.periodic);
      if (this.timer !== undefined) clearTimeout(this.timer);
      hubs.delete(this.service);
    };
  }
  flush = () => {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || !this.listeners.size) return;
    let snapshot: StatusSnapshot;
    try { snapshot = this.cached ??= this.service.snapshot(); } catch { return; }
    for (const listener of [...this.listeners]) listener(snapshot);
  };
  refresh = () => { this.cached = undefined; this.flush(); };
}

export class StatusPort {
  private closed = false;
  private unsubscribe: () => void = () => {};
  private hub: StatusHub;
  constructor(private port: chrome.runtime.Port, private service: StatusService) {
    port.onMessage.addListener(this.message); port.onDisconnect.addListener(this.dispose);
    let hub = hubs.get(service);
    if (!hub) { hub = new StatusHub(service); hubs.set(service, hub); }
    this.hub = hub;
    this.unsubscribe = hub.subscribe(this.push);
    if (this.closed) this.unsubscribe();
  }
  private push = (status: StatusSnapshot) => {
    if (this.closed) return;
    try { this.port.postMessage({ type: 'snapshot', status }); } catch { this.dispose(); }
  };
  private message = (message: unknown) => {
    if (this.closed || !message || typeof message !== 'object' || Array.isArray(message)) return;
    const input = message as Record<string, unknown>;
    let work: () => Promise<void>;
    if (input.type === 'probe' && (input.providerId === undefined || typeof input.providerId === 'string')) {
      work = () => this.service.probe(input.providerId as string | undefined);
    } else if (input.type === 'provider-action' && typeof input.providerId === 'string' &&
      typeof input.action === 'string' && ['pin', 'unpin', 'pause', 'resume'].includes(input.action)) {
      work = () => this.service.action(input.providerId as string, input.action as 'pin' | 'unpin' | 'pause' | 'resume');
    } else return;
    const refresh = () => { if (!this.closed) this.hub.refresh(); };
    void Promise.resolve().then(() => { if (!this.closed) return work(); }).then(refresh, refresh);
  };
  dispose = () => {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.port.onMessage.removeListener(this.message);
    this.port.onDisconnect.removeListener(this.dispose);
  };
}
