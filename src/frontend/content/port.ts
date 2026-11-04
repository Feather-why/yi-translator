/**
 * 翻译端口的客户端：一个内容脚本一条长连接。
 * service worker 被浏览器回收后连接会断开，这里自动重连并把没收到最终结果的片段重新提交。
 */
import {
  PORT_TRANSLATE,
  type ErrorInfo,
  type SegmentTiming,
  type Stage,
  type TranslateClientMsg,
  type TranslateJob,
  type TranslateServerMsg,
} from '../../shared/protocol';

export interface JobHandlers {
  onResult(segmentId: string, text: string, stage: Stage, provider: string, cached: boolean, timing?: SegmentTiming): void;
  /** 流式的中间结果：text 是到目前为止的完整译文（可能停在半个占位符上）。 */
  onPartial?(segmentId: string, text: string, stage: Stage): void;
  onError(segmentId: string, stage: Stage, error: ErrorInfo): void;
  onDone?(stage: Stage): void;
}

interface JobState {
  job: TranslateJob;
  handlers: JobHandlers;
  /** 还没收到最终结果（或最终错误）的片段。 */
  open: Set<string>;
}

export class TranslateClient {
  private port: chrome.runtime.Port | null = null;
  private jobs = new Map<string, JobState>();
  private failures = 0;
  private reconnectTimer = 0;
  /** 扩展被重新加载或卸载后，旧页面上的内容脚本再也连不上。 */
  dead = false;
  onDead?: () => void;

  send(job: TranslateJob, handlers: JobHandlers): void {
    if (this.dead || !job.segments.length) return;
    this.jobs.set(job.jobId, { job, handlers, open: new Set(job.segments.map((s) => s.id)) });
    this.post({ type: 'job', job });
  }

  cancel(jobId: string, segmentIds?: string[]): void {
    const st = this.jobs.get(jobId);
    if (!st) return;
    if (segmentIds) {
      segmentIds.forEach((id) => st.open.delete(id));
      if (!st.open.size) this.jobs.delete(jobId);
    } else this.jobs.delete(jobId);
    this.post({ type: 'cancel', jobId, segmentIds });
  }

  /** 提前连上后台（唤醒 service worker），点下去时不用再等。 */
  warm(): void {
    this.ensure();
  }

  cancelAll(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  /** 独立阅读器关闭后不再重连；先取消任务，再断开端口。 */
  dispose(): void {
    this.cancelAll();
    this.dead = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    const port = this.port;
    this.port = null;
    try { port?.disconnect(); } catch { /* 扩展可能已重载 */ }
  }

  setPriority(jobId: string, segmentIds: string[], priority: number): void {
    if (this.jobs.has(jobId)) this.post({ type: 'priority', jobId, segmentIds, priority });
  }

  private post(msg: TranslateClientMsg): void {
    const port = this.ensure();
    if (!port) return;
    try {
      port.postMessage(msg);
    } catch {
      this.port = null;
      this.scheduleReconnect();
    }
  }

  private ensure(): chrome.runtime.Port | null {
    if (this.port) return this.port;
    if (this.dead) return null;
    if (!chrome.runtime?.id) {
      this.markDead();
      return null;
    }
    try {
      const port = chrome.runtime.connect({ name: PORT_TRANSLATE });
      port.onMessage.addListener((m: TranslateServerMsg) => this.onMessage(m));
      port.onDisconnect.addListener(() => {
        if (this.port === port) this.port = null;
        void chrome.runtime.lastError;
        this.scheduleReconnect();
      });
      this.port = port;
      return port;
    } catch {
      this.markDead();
      return null;
    }
  }

  private markDead() {
    if (this.dead) return;
    this.dead = true;
    this.jobs.clear();
    this.onDead?.();
  }

  private scheduleReconnect() {
    if (!this.jobs.size || this.reconnectTimer || this.dead) return;
    this.failures++;
    if (this.failures > 6) return this.markDead();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      for (const st of this.jobs.values()) {
        const segments = st.job.segments.filter((s) => st.open.has(s.id));
        if (segments.length) this.post({ type: 'job', job: { ...st.job, segments } });
      }
    }, 150 * this.failures);
  }

  private onMessage(m: TranslateServerMsg): void {
    this.failures = 0;
    const st = this.jobs.get(m.jobId);
    if (!st) return;
    if (m.type === 'result') {
      if (!st.open.has(m.segmentId)) return;
      if (m.stage === 'final') st.open.delete(m.segmentId);
      st.handlers.onResult(m.segmentId, m.text, m.stage, m.provider, m.cached, m.timing);
    } else if (m.type === 'partial') {
      if (!st.open.has(m.segmentId) || typeof m.text !== 'string') return;
      st.handlers.onPartial?.(m.segmentId, m.text, m.stage);
    } else if (m.type === 'error') {
      if (!st.open.has(m.segmentId)) return;
      if (m.stage === 'final' || st.job.mode !== 'combined') st.open.delete(m.segmentId);
      st.handlers.onError(m.segmentId, m.stage, m.error);
    } else if (m.type === 'job-done') {
      st.handlers.onDone?.(m.stage);
      if (m.stage === 'final' || st.job.mode !== 'combined') {
        st.open.clear();
        this.jobs.delete(m.jobId);
      }
    }
  }
}
