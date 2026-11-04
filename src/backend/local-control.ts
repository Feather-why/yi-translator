import type { LocalAutostart } from '../shared/protocol';
import { ProviderError } from './providers/types';

export const LOCAL_HOST = 'com.translate.local_model';
export const HELPER_HINT = '先双击 gateway\\scripts\\install-helper.cmd 一次';
type Action = { action: 'status' } | { action: 'start' } | { action: 'autostart'; enable: boolean };
export interface LocalControl {
  status(): Promise<LocalAutostart>;
  autostart(enable: boolean): Promise<LocalAutostart>;
  start(): Promise<{ ok: boolean; message?: string }>;
}
interface NativeOptions {
  connect?: (host: string) => chrome.runtime.Port;
  timeoutMs?: number;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const unavailable = () => new ProviderError({ code: 'no_provider', message: `无法连接本机助手；${HELPER_HINT}`, retryable: true });

/** 仅向固定助手发送三个声明式动作；网页地址、正文和服务密钥不进入本机通道。 */
export class NativeLocalControl implements LocalControl {
  private pendingStatus?: Promise<LocalAutostart>;
  private pendingStart?: Promise<{ ok: boolean; message?: string }>;
  private operations = Promise.resolve();
  private active = new Set<() => void>();
  private disposed = false;
  constructor(private options: NativeOptions = {}) {}
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const work = this.operations.then(run);
    this.operations = work.then(() => undefined, () => undefined);
    return work;
  }
  status(): Promise<LocalAutostart> {
    if (!this.pendingStatus) {
      const work = this.enqueue(async () => {
        try { return this.state(await this.request({ action: 'status' })); }
        catch { return { supported: false, enabled: false, canStart: false, hint: HELPER_HINT }; }
      });
      this.pendingStatus = work;
      void work.finally(() => { if (this.pendingStatus === work) this.pendingStatus = undefined; });
    }
    return this.pendingStatus;
  }
  autostart(enable: boolean): Promise<LocalAutostart> {
    // 串行设置避免两个设置页的 enable/disable 在磁盘上反序完成；不缓存虚构的开机状态。
    this.pendingStatus = undefined;
    return this.enqueue(async () => this.state(await this.request({ action: 'autostart', enable })));
  }
  start(): Promise<{ ok: boolean; message?: string }> {
    if (!this.pendingStart) {
      const work = this.enqueue(async () => {
        try {
          const data = await this.request({ action: 'start' });
          if (!object(data) || typeof data.ok !== 'boolean' || data.message !== undefined && typeof data.message !== 'string') throw unavailable();
          return { ok: data.ok, ...(typeof data.message === 'string' ? { message: data.message.slice(0, 500) } : {}) };
        } catch (error) { return { ok: false, message: error instanceof ProviderError ? error.info.message : HELPER_HINT }; }
      });
      this.pendingStart = work;
      void work.finally(() => { if (this.pendingStart === work) this.pendingStart = undefined; });
    }
    return this.pendingStart;
  }
  private state(data: unknown): LocalAutostart {
    if (!object(data) || data.supported !== true || typeof data.enabled !== 'boolean'
      || data.canStart !== undefined && typeof data.canStart !== 'boolean' || data.hint !== undefined && typeof data.hint !== 'string') throw unavailable();
    return { supported: true, enabled: data.enabled, canStart: data.canStart === true,
      ...(typeof data.hint === 'string' ? { hint: data.hint.slice(0, 500) } : {}) };
  }
  private request(message: Action): Promise<unknown> {
    if (this.disposed) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      let port: chrome.runtime.Port;
      try {
        const runtime = chrome.runtime as typeof chrome.runtime & { connectNative?: (host: string) => chrome.runtime.Port };
        const connect = this.options.connect ?? runtime.connectNative?.bind(runtime);
        if (!connect) throw unavailable();
        port = connect(LOCAL_HOST);
      } catch { reject(unavailable()); return; }
      let settled = false;
      const finish = (error?: ProviderError, data?: unknown) => {
        if (settled) return; settled = true;
        clearTimeout(timer); this.active.delete(cancel);
        port.onMessage.removeListener(receive); port.onDisconnect.removeListener(disconnect);
        try { port.disconnect(); } catch { /* 助手已经退出也要完成当前调用。 */ }
        if (error) reject(error); else resolve(data);
      };
      const cancel = () => finish(unavailable());
      const receive = (reply: unknown) => {
        if (!object(reply) || typeof reply.ok !== 'boolean') { finish(unavailable()); return; }
        if (reply.ok) finish(undefined, reply.data);
        else finish(new ProviderError({ code: 'no_provider', message: message.action === 'start'
          ? '本地模型未能启动，请检查模型文件与本机助手日志' : `本机助手未能完成操作；${HELPER_HINT}`, retryable: true }));
      };
      const disconnect = () => { void chrome.runtime.lastError; finish(unavailable()); };
      const timer = setTimeout(() => finish(new ProviderError({ code: 'network', message: '本机助手响应超时，请检查本地模型状态', retryable: true })),
        // 冷启动脚本最多等待互斥锁15秒和模型加载60秒，另留进程启动余量。
        this.options.timeoutMs ?? (message.action === 'start' ? 90_000 : message.action === 'autostart' ? 30_000 : 15_000));
      this.active.add(cancel); port.onMessage.addListener(receive); port.onDisconnect.addListener(disconnect);
      try { port.postMessage(message); } catch { finish(unavailable()); }
    });
  }
  dispose() { this.disposed = true; for (const cancel of [...this.active]) cancel(); }
}
