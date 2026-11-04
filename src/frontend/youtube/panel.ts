/**
 * 双语字幕稿侧栏：整条字幕按句列出（时间 · 译文 · 原文），点哪一句就跳到哪里；
 * 播放时当前句高亮并自动滚到视野里（用户刚手动滚动过的 4 秒内不抢滚动）。
 * 放在 YouTube 右侧栏（#secondary）最上面，找不到时贴在页面右侧。
 */
import { LIGHT_VARS, DARK_VARS } from '../theme';
import { detectPageTheme } from '../ui/host';
import { L } from '../i18n';

export interface PanelCue {
  id: string;
  start: number;
  end: number;
  text: string;
}

const CSS = `
:host { all: initial; display: block; margin-bottom: 12px; }
:host(.float) { position: fixed; right: 16px; top: 72px; width: 380px; z-index: 2100; }
.p { ${LIGHT_VARS} font: 13px/1.5 -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; color: var(--ink);
  background: var(--surface); border: 1px solid var(--line); border-radius: 12px; display: flex; flex-direction: column; max-height: min(70vh, 640px); overflow: hidden; }
.p.dark { ${DARK_VARS} }
.hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.hd b { font-size: 14px; flex: 1; }
.hd small { color: var(--muted); font-weight: 400; margin-left: 6px; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 4px 8px; border-radius: 7px; }
button:hover { background: var(--hover); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button[aria-pressed="true"] { color: var(--accent); }
.list { overflow-y: auto; padding: 4px 6px 8px; overscroll-behavior: contain; }
.cue { display: grid; grid-template-columns: 46px 1fr; gap: 2px 8px; padding: 7px 8px; border-radius: 8px; cursor: pointer; text-align: left; width: 100%; }
.cue:hover { background: var(--hover); }
.cue.now { background: var(--accent-soft); }
.cue time { grid-row: span 2; color: var(--accent); font-variant-numeric: tabular-nums; font-size: 12px; padding-top: 1px; }
.cue .tr { font-size: 14px; color: var(--ink); }
.cue .tr.wait { color: var(--muted); }
.cue .src { color: var(--muted); font-size: 12.5px; }
.empty { padding: 18px 14px; color: var(--muted); }
`;

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export class TranscriptPanel {
  readonly host: HTMLElement;
  private wrap: HTMLDivElement;
  private list: HTMLDivElement;
  private count: HTMLElement;
  private follow = true;
  private userScrollAt = 0;
  private rows = new Map<string, { el: HTMLButtonElement; tr: HTMLElement }>();
  private current = '';
  private cuesKey = '';

  constructor(private onSeek: (ms: number) => void, private onClose: () => void, private onCopy: () => string) {
    this.host = document.createElement('tx-yt-panel');
    this.host.setAttribute('translate', 'no');
    const root = this.host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = CSS;
    this.wrap = document.createElement('div');
    this.wrap.className = 'p';
    this.wrap.setAttribute('role', 'region');
    this.wrap.setAttribute('aria-label', L('双语字幕稿', 'Bilingual transcript'));
    const hd = document.createElement('div');
    hd.className = 'hd';
    const title = document.createElement('b');
    title.textContent = L('双语字幕稿', 'Bilingual transcript');
    this.count = document.createElement('small');
    title.append(this.count);
    const follow = this.button(L('跟随播放', 'Follow playback'), () => {
      this.follow = !this.follow;
      follow.setAttribute('aria-pressed', String(this.follow));
      if (this.follow) this.scrollToCurrent(true);
    });
    follow.setAttribute('aria-pressed', 'true');
    const copy = this.button(L('复制', 'Copy'), () => {
      void navigator.clipboard?.writeText(this.onCopy()).then(() => {
        copy.textContent = L('已复制', 'Copied');
        setTimeout(() => (copy.textContent = L('复制', 'Copy')), 1200);
      });
    });
    copy.title = L('复制整条双语字幕（带时间）', 'Copy the whole bilingual transcript (with timestamps)');
    const close = this.button('✕', () => this.onClose());
    close.setAttribute('aria-label', L('关闭字幕稿', 'Close transcript'));
    hd.append(title, follow, copy, close);
    this.list = document.createElement('div');
    this.list.className = 'list';
    this.list.addEventListener('wheel', () => (this.userScrollAt = Date.now()), { passive: true });
    this.list.addEventListener('touchmove', () => (this.userScrollAt = Date.now()), { passive: true });
    this.wrap.append(hd, this.list);
    root.append(st, this.wrap);
  }

  private button(label: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  }

  /** 挂到 YouTube 右侧栏最上面；没有右侧栏（剧场模式、窄屏）就浮在页面右侧。 */
  mount(): void {
    const side = document.querySelector('#secondary-inner') ?? document.querySelector('#secondary');
    if (side) {
      this.host.classList.remove('float');
      if (this.host.parentElement !== side || side.firstElementChild !== this.host) side.prepend(this.host);
    } else {
      this.host.classList.add('float');
      if (!this.host.isConnected) document.body.append(this.host);
    }
    // 跟着 YouTube 自己的深浅色
    this.wrap.classList.toggle('dark', document.documentElement.hasAttribute('dark') || detectPageTheme() === 'dark');
  }

  remove(): void {
    this.host.remove();
  }

  /** 字幕或译文有变化时调用。 */
  setCues(cues: PanelCue[] | null, tr: Map<string, string>): void {
    if (!cues) {
      this.rows.clear();
      this.cuesKey = '';
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = L('还没拿到这个视频的整条字幕。打开字幕（CC）后，如果还是没有，刷新一下页面。', 'The full captions for this video are not available yet. Turn on captions (CC); if they still don’t show up, reload the page.');
      this.list.replaceChildren(e);
      this.count.textContent = '';
      return;
    }
    const key = cues.length + ':' + (cues[0]?.id ?? '') + ':' + (cues[cues.length - 1]?.start ?? 0);
    if (key !== this.cuesKey) {
      this.cuesKey = key;
      this.rows.clear();
      const frag = document.createDocumentFragment();
      for (const c of cues) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'cue';
        el.dataset.id = c.id;
        const time = document.createElement('time');
        time.textContent = fmt(c.start);
        const t = document.createElement('div');
        t.className = 'tr wait';
        t.textContent = '…';
        const s = document.createElement('div');
        s.className = 'src';
        s.textContent = c.text;
        el.append(time, t, s);
        el.addEventListener('click', () => this.onSeek(c.start));
        frag.append(el);
        this.rows.set(c.id, { el, tr: t });
      }
      this.list.replaceChildren(frag);
      this.current = '';
    }
    let done = 0;
    for (const [id, row] of this.rows) {
      const text = tr.get(id);
      if (text) {
        done++;
        if (row.tr.textContent !== text) {
          row.tr.textContent = text;
          row.tr.classList.remove('wait');
        }
      }
    }
    this.count.textContent = done < this.rows.size ? L(`已翻译 ${done} / ${this.rows.size}`, `${done} / ${this.rows.size} translated`) : L(`${this.rows.size} 句`, `${this.rows.size} lines`);
  }

  /** 播放位置变化：高亮当前句。 */
  setCurrent(id: string | null): void {
    if ((id ?? '') === this.current) return;
    if (this.current) this.rows.get(this.current)?.el.classList.remove('now');
    this.current = id ?? '';
    if (id) this.rows.get(id)?.el.classList.add('now');
    this.scrollToCurrent(false);
  }

  private scrollToCurrent(force: boolean) {
    if (!this.follow || !this.current) return;
    if (!force && Date.now() - this.userScrollAt < 4000) return;
    const el = this.rows.get(this.current)?.el;
    if (!el) return;
    const lr = this.list.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (force || er.top < lr.top + 8 || er.bottom > lr.bottom - 8) {
      this.list.scrollTop += er.top - lr.top - lr.height / 3;
    }
  }
}
