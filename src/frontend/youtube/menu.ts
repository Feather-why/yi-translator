/**
 * 播放器里的字幕设置小菜单（点播放器右下角的「译」按钮打开），样式和 YouTube 自己的设置菜单一致：
 *   双语字幕开关 · 显示（双语 / 只译文）· 顺序（译文在上 / 原文在上）· 字号 · 背景透明度 · 恢复默认位置 · 字幕稿
 */
import type { UiSettings } from '../../shared/settings';
import { L } from '../i18n';

type Sub = UiSettings['subtitles'];

const CSS = `
:host { all: initial; position: absolute; right: 12px; bottom: 60px; z-index: 70; display: none; }
:host(.on) { display: block; }
.m { width: 260px; padding: 8px 0; border-radius: 12px; background: rgba(28, 28, 28, .92); color: #eee;
  font: 13px/1.4 "YouTube Noto", Roboto, Arial, "PingFang SC", "Microsoft YaHei", sans-serif; box-shadow: 0 4px 24px rgba(0,0,0,.4);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.r { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 14px; }
.r > span { white-space: nowrap; }
.r small { color: #aaa; }
.seg { display: inline-flex; background: rgba(255,255,255,.1); border-radius: 8px; padding: 2px; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
button:hover { background: rgba(255,255,255,.12); }
button:focus-visible { outline: 2px solid #96a3d9; outline-offset: 1px; }
.seg button[aria-pressed="true"] { background: rgba(255,255,255,.22); font-weight: 600; }
.sw { width: 34px; height: 18px; border-radius: 99px; background: rgba(255,255,255,.3); position: relative; padding: 0; }
.sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
.sw[aria-checked="true"] { background: #96a3d9; }
.sw[aria-checked="true"]::after { transform: translateX(16px); }
.step { display: inline-flex; align-items: center; gap: 4px; }
.step b { min-width: 42px; text-align: center; font-variant-numeric: tabular-nums; font-weight: 500; }
input[type=range] { width: 110px; accent-color: #96a3d9; }
.sep { height: 1px; background: rgba(255,255,255,.12); margin: 6px 0; }
.hint { padding: 2px 14px 4px; color: #aaa; font-size: 12px; }
`;

export class SubtitleMenu {
  readonly host: HTMLElement;
  private root: ShadowRoot;
  private box: HTMLDivElement;

  constructor(private onChange: (patch: Partial<Sub>) => void) {
    this.host = document.createElement('tx-yt-menu');
    this.host.setAttribute('translate', 'no');
    this.root = this.host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = CSS;
    this.box = document.createElement('div');
    this.box.className = 'm';
    this.box.setAttribute('role', 'dialog');
    this.box.setAttribute('aria-label', L('双语字幕设置', 'Bilingual subtitle settings'));
    this.root.append(st, this.box);
    // 菜单里的点击不要传给播放器（否则会暂停 / 播放）
    for (const t of ['click', 'mousedown', 'pointerdown', 'dblclick', 'keydown']) {
      this.host.addEventListener(t, (e) => {
        e.stopPropagation();
        if (t === 'keydown' && (e as KeyboardEvent).key === 'Escape') this.close();
      });
    }
    document.addEventListener('pointerdown', (e) => {
      if (this.isOpen && !e.composedPath().some((n) => n === this.host || (n as Element)?.classList?.contains?.('tx-yt-btn'))) this.close();
    }, true);
  }

  get isOpen(): boolean {
    return this.host.classList.contains('on');
  }

  mount(player: HTMLElement): void {
    if (this.host.parentElement !== player) player.appendChild(this.host);
  }

  toggle(s: Sub): void {
    if (this.isOpen) this.close();
    else {
      this.render(s);
      this.host.classList.add('on');
      (this.box.querySelector('button') as HTMLButtonElement | null)?.focus({ preventScroll: true });
    }
  }

  close(): void {
    this.host.classList.remove('on');
  }

  /** 设置变化时刷新（菜单开着才需要）。 */
  update(s: Sub): void {
    if (this.isOpen) this.render(s);
  }

  private render(s: Sub) {
    const row = (label: string, ...ctrl: Node[]) => {
      const r = document.createElement('div');
      r.className = 'r';
      const l = document.createElement('span');
      l.textContent = label;
      r.append(l, ...ctrl);
      return r;
    };
    const btn = (label: string, fn: () => void, attrs: Record<string, string> = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
      b.addEventListener('click', fn);
      return b;
    };
    const seg = <T extends string>(items: [T, string][], v: T, set: (v: T) => void) => {
      const g = document.createElement('div');
      g.className = 'seg';
      g.setAttribute('role', 'group');
      for (const [k, label] of items) g.append(btn(label, () => set(k), { 'aria-pressed': String(v === k) }));
      return g;
    };
    const sw = btn('', () => this.onChange({ enabled: !s.enabled }), { class: 'sw', role: 'switch', 'aria-checked': String(s.enabled), 'aria-label': L('双语字幕', 'Bilingual subtitles') });
    const fsLabel = document.createElement('b');
    fsLabel.textContent = Math.round(s.fontScale * 100) + '%';
    const step = document.createElement('span');
    step.className = 'step';
    step.append(
      btn('−', () => this.onChange({ fontScale: Math.max(0.6, Math.round((s.fontScale - 0.1) * 10) / 10) }), { 'aria-label': L('字号减小', 'Smaller text') }),
      fsLabel,
      btn('+', () => this.onChange({ fontScale: Math.min(1.8, Math.round((s.fontScale + 0.1) * 10) / 10) }), { 'aria-label': L('字号增大', 'Larger text') }),
    );
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.step = '5';
    range.value = String(Math.round(s.bgOpacity * 100));
    range.setAttribute('aria-label', L('字幕背景不透明度', 'Subtitle background opacity'));
    range.addEventListener('input', () => this.onChange({ bgOpacity: Number(range.value) / 100 }));
    const sep = () => Object.assign(document.createElement('div'), { className: 'sep' });
    const hint = Object.assign(document.createElement('div'), { className: 'hint', textContent: L('拖动字幕可以调整上下位置，双击字幕恢复。', 'Drag the subtitles to move them up or down; double-click to reset.') });
    this.box.replaceChildren(
      row(L('双语字幕', 'Bilingual subtitles'), sw),
      row(L('显示', 'Show'), seg([['bilingual', L('双语', 'Both')], ['translation', L('只译文', 'Translation only')]], s.display, (display) => this.onChange({ display }))),
      row(L('顺序', 'Order'), seg([['tr-first', L('译文在上', 'Translation on top')], ['src-first', L('原文在上', 'Original on top')]], s.order, (order) => this.onChange({ order }))),
      sep(),
      row(L('字号', 'Size'), step),
      row(L('背景', 'Background'), range),
      ...(s.offsetY !== null ? [row(L('位置', 'Position'), btn(L('恢复默认', 'Reset'), () => this.onChange({ offsetY: null })))] : []),
      hint,
      sep(),
      row(L('字幕稿', 'Transcript'), btn(s.panel ? L('关闭侧栏', 'Close sidebar') : L('打开侧栏', 'Open sidebar'), () => this.onChange({ panel: !s.panel }), { 'aria-pressed': String(s.panel) })),
    );
  }
}
