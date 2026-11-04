/**
 * 悬浮球小窗用的状态订阅：鼠标移到球上时连上后台的 tx:status 端口，菜单收起几秒后断开，
 * 平时不占用连接。快速切换引擎也走这个端口（provider-action 置顶 / 取消置顶）。
 */
import { PORT_STATUS, type StatusClientMsg, type StatusServerMsg, type StatusSnapshot } from '../../shared/protocol';

export type Tier = 'fast' | 'accurate';

export class StatusFeed {
  private port: chrome.runtime.Port | null = null;
  private wanted = false;
  private closeTimer = 0;
  latest: StatusSnapshot | null = null;
  onSnapshot?: (s: StatusSnapshot) => void;

  open(): void {
    clearTimeout(this.closeTimer);
    this.wanted = true;
    if (this.port || !chrome.runtime?.id) return;
    try {
      const port = chrome.runtime.connect({ name: PORT_STATUS });
      port.onMessage.addListener((m: StatusServerMsg) => {
        if (m.type !== 'snapshot') return;
        this.latest = m.status;
        this.onSnapshot?.(m.status);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (this.port === port) this.port = null;
        if (this.wanted) window.setTimeout(() => this.wanted && this.open(), 1500);
      });
      this.port = port;
    } catch {
      this.port = null;
    }
  }

  /** 延迟断开：菜单反复开合时不重复建连接。 */
  close(delay = 4000): void {
    clearTimeout(this.closeTimer);
    this.closeTimer = window.setTimeout(() => {
      this.wanted = false;
      this.port?.disconnect();
      this.port = null;
    }, delay);
  }

  private send(m: StatusClientMsg) {
    this.open();
    try {
      this.port?.postMessage(m);
    } catch {
      /* 端口刚断开，下次连上后状态会自动刷新 */
    }
  }

  /**
   * 指定某一档用哪家：置顶它、取消同档其他服务的置顶；传 null 表示交给自动调度。
   * 置顶的服务失败或额度用尽时，后台仍会自动换下一家。
   */
  setEngine(tier: Tier, providerId: string | null): void {
    const s = this.latest;
    if (!s) return;
    for (const p of s.providers) {
      if (!p.usedFor.includes(tier)) continue;
      const want = p.id === providerId;
      if (!!p.pinned !== want) this.send({ type: 'provider-action', providerId: p.id, action: want ? 'pin' : 'unpin' });
      p.pinned = want; // 先在本地更新，界面立刻反映
    }
    this.onSnapshot?.(s);
  }
}
