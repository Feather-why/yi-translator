/**
 * 输入框翻译（反向翻译）：在网页的输入框里用母语写好，一键翻成要发出去的语言。
 *
 * - 光标在输入框里时，右下角（单行输入框是右上角）出现一个小圆球，点一下就翻译；
 *   鼠标停在小圆球上会展开一条小面板：临时换语言、撤销、在本站隐藏；
 * - 快捷键（默认 Alt+T，可在设置里换）；可选「连按三下空格」；
 * - 选中了一部分文字时只翻选中的部分，否则翻整个输入框；多行文字逐行翻译，保留换行；
 * - 用 execCommand('insertText') 替换：网页自己的撤销（Ctrl+Z）照常能撤回，React / Vue 等框架也能收到 input 事件；
 *   个别网站不认这个命令时，退回直接改 value 并补发 input 事件，这时用小面板上的「撤销」恢复。
 * - 翻译期间用户又改了输入框，就放弃这次结果，不覆盖用户刚打的字。
 */
import type { ErrorInfo, Mode, Stage } from '../../shared/protocol';
import { uid } from '../../shared/rpc';
import { hostMatches, saveUiSettings, type UiSettings } from '../../shared/settings';
import type { TranslateClient } from '../content/port';
import { LANGS, shortLang } from '../langs';
import { LANG_PICKER_CSS, langPicker, type LangPicker } from './lang-picker';
import { h, type UiHost } from './host';
import { logoElement } from './logo';
import { L } from '../i18n';

const CSS = `
/* 面板不占小圆球的位置：小圆球大小、位置始终不变（面板展开时球不会被挤动） */
.ib { position: absolute; display: none; width: 24px; height: 24px; z-index: 3; }
.ib.on { display: block; }
.ib .go {
  width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; flex: none;
  background: var(--surface); color: var(--ink); --logo-accent: var(--accent); border: 1px solid var(--line);
  box-shadow: 0 1px 4px rgba(15, 20, 40, .16); opacity: .78; transition: opacity .15s, background .15s, color .15s;
  position: relative;
}
.ib:hover .go, .ib.busy .go, .ib.open .go { opacity: 1; }
.ib .go { touch-action: none; }
.ib.dragging .go { cursor: grabbing; opacity: 1; box-shadow: 0 4px 14px rgba(15, 20, 40, .28); }
.ib.dragging .panel { display: none !important; }
.ib .go:hover { background: var(--accent); color: var(--accent-ink); --logo-accent: color-mix(in srgb, var(--accent-ink) 65%, transparent); border-color: transparent; }
.ib .go .code { position: absolute; right: -5px; bottom: -5px; min-width: 15px; height: 13px; padding: 0 3px; border-radius: 7px; font-size: 8.5px; line-height: 13px;
  font-weight: 700; text-align: center; background: var(--accent); color: var(--accent-ink); letter-spacing: .02em; text-transform: uppercase; }
.ib.busy .go::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--accent); animation: tx-ib-spin .8s linear infinite; }
@keyframes tx-ib-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ib.busy .go::after { animation: none; border-color: var(--accent); border-style: dashed; } }
.ib .panel {
  position: absolute; right: calc(100% + 4px); top: 50%; transform: translateY(-50%);
  display: none; align-items: center; gap: 4px; padding: 3px 4px 3px 8px; border-radius: 99px; font-size: 12px; white-space: nowrap;
  background: color-mix(in srgb, var(--surface) 90%, transparent); backdrop-filter: blur(14px) saturate(1.5); -webkit-backdrop-filter: blur(14px) saturate(1.5);
  border: 1px solid var(--line); box-shadow: var(--shadow); color: var(--ink-2);
}
.ib.open .panel { display: flex; }
/* 鼠标从小圆球移到面板要经过 4px 的空隙：用一条透明的桥接住，不然会当成离开而收起 */
.ib .panel::after { content: ""; position: absolute; left: 100%; top: 0; bottom: 0; width: 6px; }
/* 左边放不下时面板改到右边 */
.ib.flip .panel { right: auto; left: calc(100% + 4px); }
.ib.flip .panel::after { left: auto; right: 100%; }
.ib .panel .lp { background: var(--hover); color: var(--ink); }
.ib .panel button { border-radius: 6px; padding: 2px 6px; color: var(--ink-2); }
.ib .panel button:hover { background: var(--hover); color: var(--ink); }
.ib .panel .msg { color: var(--muted); max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.ib .panel .msg.bad { color: var(--danger); }
`;

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

interface Snapshot {
  el: Field;
  /** 翻译前整个输入框的内容（用来判断用户中途有没有改，以及撤销）。 */
  before: string;
  /** 要翻的那一部分。 */
  text: string;
  start: number;
  end: number;
  whole: boolean;
  /** 可编辑区域里选中的范围。 */
  range: Range | null;
}

const TEXT_TYPES = new Set(['', 'text', 'search']);

/** 焦点所在的可编辑元素（会钻进网页组件的 Shadow DOM）。 */
function activeEditable(): Field | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return editableOf(el);
}

export function editableOf(el: Element | null): Field | null {
  if (!el || el.localName.startsWith('tx-')) return null;
  if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : el;
  if (el instanceof HTMLInputElement) {
    if (!TEXT_TYPES.has((el.getAttribute('type') || '').toLowerCase()) || el.readOnly || el.disabled) return null;
    return el;
  }
  const he = el as HTMLElement;
  if (!he.isContentEditable) return null;
  let root: HTMLElement = he;
  while (root.parentElement?.isContentEditable) root = root.parentElement;
  return root;
}

const isTextControl = (el: Field): el is HTMLInputElement | HTMLTextAreaElement => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

function valueOf(el: Field): string {
  return isTextControl(el) ? el.value : (el.innerText ?? el.textContent ?? '');
}

function snapshot(el: Field): Snapshot | null {
  const before = valueOf(el);
  if (isTextControl(el)) {
    const s = el.selectionStart ?? 0;
    const e = el.selectionEnd ?? 0;
    const part = e > s ? el.value.slice(s, e) : '';
    if (part.trim()) return { el, before, text: part, start: s, end: e, whole: false, range: null };
    return before.trim() ? { el, before, text: before, start: 0, end: before.length, whole: true, range: null } : null;
  }
  const sel = getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    const r = sel.getRangeAt(0);
    if (el.contains(r.commonAncestorContainer) && sel.toString().trim()) {
      return { el, before, text: sel.toString(), start: 0, end: 0, whole: false, range: r.cloneRange() };
    }
  }
  return before.trim() ? { el, before, text: before, start: 0, end: 0, whole: true, range: null } : null;
}

/** 按行拆开：空行和行首尾的空白原样保留，只翻有字的部分。 */
function splitLines(text: string): { parts: string[]; slots: number[] } {
  const parts = text.split(/(\r?\n)/);
  const slots: number[] = [];
  parts.forEach((p, i) => {
    if (!/\r?\n/.test(p) && p.trim()) slots.push(i);
  });
  return { parts, slots };
}

/** 替换输入框里的文字；返回 true 表示走的是浏览器原生编辑（Ctrl+Z 可撤销）。 */
function replaceText(snap: Snapshot, translated: string): boolean {
  const el = snap.el;
  el.focus({ preventScroll: true });
  if (isTextControl(el)) {
    const start = snap.whole ? 0 : snap.start;
    const end = snap.whole ? el.value.length : snap.end;
    el.setSelectionRange(start, end);
    let native = false;
    try {
      native = document.execCommand('insertText', false, translated);
    } catch {
      native = false;
    }
    if (!native || el.value.slice(start, start + translated.length) !== translated) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const next = snap.before.slice(0, start) + translated + snap.before.slice(end);
      if (setter) setter.call(el, next);
      else el.value = next;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: translated }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.setSelectionRange(start + translated.length, start + translated.length);
      return false;
    }
    return true;
  }
  const sel = getSelection();
  if (!sel) return false;
  let range = snap.range;
  if (!range || snap.whole) {
    range = document.createRange();
    range.selectNodeContents(el);
  }
  sel.removeAllRanges();
  sel.addRange(range);
  let native = false;
  try {
    native = document.execCommand('insertText', false, translated);
  } catch {
    native = false;
  }
  if (!native) {
    range.deleteContents();
    range.insertNode(document.createTextNode(translated));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: translated }));
  }
  return native;
}

/** 输入框小圆球拖过的位置，按网站存：{ [hostname]: { dx, dy } }。 */
const BALL_KEY = 'ui.inputBall';

export class InputTranslator {
  private wrap: HTMLDivElement;
  private go: HTMLButtonElement;
  private code: HTMLSpanElement;
  private panel: HTMLDivElement;
  private lang: LangPicker;
  private msg: HTMLSpanElement;
  private undoBtn: HTMLButtonElement;
  private hideBtn: HTMLButtonElement;
  private field: Field | null = null;
  private busy: { jobId: string; snap: Snapshot } | null = null;
  private undo: { snap: Snapshot; after: string; native: boolean } | null = null;
  private spaces: number[] = [];
  private raf = 0;
  private hideTimer = 0;
  private openTimer = 0;
  /** 用户拖过的位置：相对默认位置的偏移，按网站记住（chrome.storage.local['ui.inputBall']）。 */
  private offset: { dx: number; dy: number } | null = null;
  private drag: { id: number; x: number; y: number; base: { dx: number; dy: number }; moved: boolean } | null = null;
  private justDragged = false;
  private resetBtn: HTMLButtonElement;

  constructor(private ui: UiHost, private client: TranslateClient, private settings: UiSettings) {
    ui.addStyle(CSS + LANG_PICKER_CSS);
    this.code = h('span', { class: 'code' });
    this.go = h('button', { class: 'go', type: 'button' }, logoElement({ size: 14, lines: 1 }), this.code) as HTMLButtonElement;
    this.lang = langPicker(LANGS, settings.input?.targetLang || 'en', L('翻成什么语言（会记住）', 'Translate into (remembered)'), (targetLang) => {
      this.settings = { ...this.settings, input: { ...this.settings.input, targetLang } };
      void saveUiSettings({ input: this.settings.input });
      this.paintCode();
      this.field?.focus({ preventScroll: true });
    });
    this.msg = h('span', { class: 'msg' });
    this.undoBtn = h('button', { type: 'button', title: L('恢复翻译前的文字', 'Restore the text from before translation') }, L('撤销', 'Undo')) as HTMLButtonElement;
    this.hideBtn = h('button', { type: 'button', title: L('在这个网站不显示输入框小圆球（快捷键照常可用）', 'Don\'t show the input ball on this site (the shortcut still works)') }, L('本站隐藏', 'Hide here')) as HTMLButtonElement;
    this.resetBtn = h('button', { type: 'button', title: L('小圆球回到默认位置', 'Move the ball back to its default position') }, L('复位', 'Reset position')) as HTMLButtonElement;
    this.resetBtn.style.display = 'none';
    this.panel = h('div', { class: 'panel' }, h('span', null, L('翻成', 'Into')), this.lang.el, this.undoBtn, this.resetBtn, this.hideBtn, this.msg) as HTMLDivElement;
    this.wrap = h('div', { class: 'ib', 'data-tx': 'input-ball' }, this.go, this.panel) as HTMLDivElement;
    ui.layer.appendChild(this.wrap);

    // 点小圆球不抢走输入框的焦点和选区
    this.go.addEventListener('mousedown', (e) => e.preventDefault());
    this.undoBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.hideBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.go.addEventListener('click', () => {
      // 刚拖完松手也会触发 click：这次不翻译
      if (this.justDragged) return void (this.justDragged = false);
      if (this.busy) this.cancel(L('已取消', 'Cancelled'));
      else void this.translate();
    });
    this.resetBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.resetBtn.addEventListener('click', () => {
      this.offset = null;
      void this.saveOffset();
      this.place();
      this.field?.focus({ preventScroll: true });
    });
    this.bindDrag();
    void chrome.storage.local.get(BALL_KEY).then((got) => {
      const o = (got[BALL_KEY] as Record<string, { dx: number; dy: number }> | undefined)?.[location.hostname];
      if (o && Number.isFinite(o.dx) && Number.isFinite(o.dy)) {
        this.offset = { dx: o.dx, dy: o.dy };
        this.resetBtn.style.display = '';
        this.place();
      }
    }, () => {});
    this.undoBtn.addEventListener('click', () => this.doUndo());
    this.hideBtn.addEventListener('click', () => {
      const list = [...new Set([...this.settings.input.hiddenOn, location.hostname])];
      this.settings = { ...this.settings, input: { ...this.settings.input, hiddenOn: list } };
      void saveUiSettings({ input: this.settings.input });
      this.hide();
    });
    this.wrap.addEventListener('mouseenter', () => {
      clearTimeout(this.openTimer);
      this.openTimer = window.setTimeout(() => this.showPanel(), 260);
    });
    this.wrap.addEventListener('mouseleave', () => {
      clearTimeout(this.openTimer);
      if (!this.panel.matches(':focus-within')) this.wrap.classList.remove('open');
    });
    // 面板里的键盘：←→ 在控件之间走（下拉框自己用上下键），Esc 收起并回到输入框
    this.panel.addEventListener('keydown', (e) => {
      const items = [this.lang.select, this.undoBtn, this.resetBtn, this.hideBtn].filter((x) => !x.disabled && x.offsetParent !== null) as HTMLElement[];
      const i = items.indexOf(this.ui.root.activeElement as HTMLElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closePanel();
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && i >= 0 && items.length > 1) {
        e.preventDefault();
        items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length].focus();
      }
    });
    this.wrap.addEventListener('focusout', (e) => {
      const to = (e as FocusEvent).relatedTarget as Node | null;
      if (!to || !this.wrap.contains(to)) window.setTimeout(() => !this.wrap.matches(':hover') && !this.panel.matches(':focus-within') && this.wrap.classList.remove('open'), 0);
    });

    document.addEventListener('focusin', this.onFocus, true);
    document.addEventListener('focusout', this.onBlur, true);
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('input', this.onInput, true);
    window.addEventListener('scroll', this.reposition, { capture: true, passive: true });
    window.addEventListener('resize', this.reposition, { passive: true });
    this.apply(settings);
    const now = activeEditable();
    if (now) this.attach(now);
  }

  apply(s: UiSettings): void {
    this.settings = s;
    this.lang.set(s.input.targetLang);
    this.paintCode();
    if (!this.ballAllowed()) this.hide();
    else if (this.field) this.show();
  }

  /** 设置页、测试里直接调用：翻译当前焦点所在的输入框。 */
  translateActive(): void {
    const el = activeEditable();
    if (el) {
      this.attach(el);
      void this.translate();
    }
  }

  /* ---------------------------------------------------------------- */

  private ballAllowed(): boolean {
    const i = this.settings.input;
    return !!i?.enabled && i.ball && !hostMatches(location.hostname, i.hiddenOn);
  }

  private paintCode() {
    const t = this.settings.input?.targetLang || 'en';
    this.code.textContent = t.split('-')[0].slice(0, 2);
    const sc = this.settings.input?.shortcut ?? 'off';
    const menuKey = sc === 'off' ? '' : `Alt+Shift+${sc.slice(-1)}`;
    this.go.title = L(
      `翻成${shortLang(t)}（${sc !== 'off' ? sc : '点击'}）· 鼠标停一下${menuKey ? `或按 ${menuKey} ` : ''}可以换语言 · 按住可以拖动`,
      `Translate into ${shortLang(t)} (${sc !== 'off' ? sc : 'click'}) · hover${menuKey ? ` or press ${menuKey}` : ''} to change language · drag to move`,
    );
    this.go.setAttribute('aria-label', L(`把输入框里的文字翻成${shortLang(t)}`, `Translate the text in this box into ${shortLang(t)}`));
  }

  private onFocus = (e: FocusEvent) => {
    const path = e.composedPath();
    if (path.includes(this.ui.host)) {
      clearTimeout(this.hideTimer); // 焦点进了我们的小面板（语言下拉框）
      return;
    }
    const el = activeEditable();
    if (el) this.attach(el);
  };

  private onBlur = () => {
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      const el = activeEditable();
      if (el) return this.attach(el);
      if (document.activeElement === this.ui.host) return; // 在我们的面板里
      if (!this.busy) {
        this.field = null;
        this.hide();
      }
    }, 150);
  };

  private onInput = (e: Event) => {
    if (!this.field) return;
    const t = e.target as Node;
    if (t === this.field || (t instanceof Node && this.field.contains(t))) {
      this.reposition();
      // 用户改了文字：之前的「撤销」就不准了
      if (this.undo && valueOf(this.field) !== this.undo.after) this.setUndo(null);
    }
  };

  private attach(el: Field) {
    if (this.field !== el) {
      this.field = el;
      this.setUndo(null);
      this.say('');
    }
    if (this.ballAllowed()) this.show();
  }

  private show() {
    if (!this.field || !this.ballAllowed()) return;
    const r = this.field.getBoundingClientRect();
    if (r.width < 60 || r.height < 16) return this.hide();
    this.wrap.classList.add('on');
    this.place();
  }

  private hide() {
    this.wrap.classList.remove('on', 'open');
  }

  private reposition = () => {
    if (!this.wrap.classList.contains('on')) return;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.place());
  };

  /** 展开面板；左边（视口外）放不下就放到小圆球右边。 */
  private showPanel() {
    this.wrap.classList.remove('flip');
    this.wrap.classList.add('open');
    if (this.panel.getBoundingClientRect().left < 4) this.wrap.classList.add('flip');
  }

  private openPanel() {
    clearTimeout(this.openTimer);
    clearTimeout(this.hideTimer);
    this.showPanel();
    this.lang.select.focus({ preventScroll: true });
  }

  private closePanel() {
    this.wrap.classList.remove('open');
    this.field?.focus({ preventScroll: true });
  }

  /** 多行输入框、可编辑区域：放在右下角里面；单行输入框：骑在右上角的边框上，不挡住输入框自己的按钮。 */
  private place() {
    const el = this.field;
    if (!el || !el.isConnected) return this.hide();
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
      this.wrap.style.visibility = 'hidden';
      return;
    }
    this.wrap.style.visibility = '';
    const multi = !(el instanceof HTMLInputElement) && r.height >= 40;
    const right = Math.min(r.right, innerWidth - 4);
    const bottom = Math.min(r.bottom, innerHeight - 4);
    // 多行：避开右下角拖动改大小的小三角
    let x = multi ? right - 40 : right - 22;
    let y = multi ? bottom - 32 : Math.max(2, r.top - 12);
    if (this.offset) {
      // 拖过的位置：在默认位置上加偏移，但不离开这个输入框太远（换到大小不同的输入框也不会飘走），也不出屏幕
      x = Math.min(Math.max(x + this.offset.dx, r.left - 30, 2), Math.min(r.right + 6, innerWidth - 26));
      y = Math.min(Math.max(y + this.offset.dy, r.top - 30, 2), Math.min(r.bottom + 6, innerHeight - 26));
    }
    this.wrap.style.left = `${Math.round(x + scrollX)}px`;
    this.wrap.style.top = `${Math.round(y + scrollY)}px`;
  }

  /**
   * 拖动小圆球：按下后移动超过 4px 才算拖（否则是普通点击，照常翻译）；松手时按网站记住位置。
   * 按下时不抢输入框的焦点（mousedown 已经 preventDefault），拖的时候面板收起。
   */
  private bindDrag() {
    this.go.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, base: this.offset ?? { dx: 0, dy: 0 }, moved: false };
      this.go.setPointerCapture(e.pointerId);
    });
    this.go.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) {
        d.moved = true;
        clearTimeout(this.openTimer);
        this.wrap.classList.remove('open');
        this.wrap.classList.add('dragging');
      }
      this.offset = { dx: d.base.dx + dx, dy: d.base.dy + dy };
      this.place();
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      this.wrap.classList.remove('dragging');
      if (!d.moved) return;
      this.justDragged = e.type === 'pointerup';
      window.setTimeout(() => (this.justDragged = false), 400);
      // 松手后实际停在哪里（夹在输入框附近之后的位置），就记住那里
      this.offset = this.clampedOffset() ?? this.offset;
      this.resetBtn.style.display = '';
      void this.saveOffset();
    };
    this.go.addEventListener('pointerup', end);
    this.go.addEventListener('pointercancel', end);
  }

  /** 把夹过之后的实际位置换回偏移，免得记住一个被夹住、看不出来的大偏移。 */
  private clampedOffset(): { dx: number; dy: number } | null {
    const o = this.offset;
    if (!o) return null;
    const saved = this.offset;
    this.offset = null;
    this.place();
    const x0 = parseFloat(this.wrap.style.left), y0 = parseFloat(this.wrap.style.top);
    this.offset = saved;
    this.place();
    const x1 = parseFloat(this.wrap.style.left), y1 = parseFloat(this.wrap.style.top);
    return Number.isFinite(x0) && Number.isFinite(x1) ? { dx: x1 - x0, dy: y1 - y0 } : o;
  }

  private async saveOffset() {
    try {
      const got = await chrome.storage.local.get(BALL_KEY);
      const all = { ...((got[BALL_KEY] as Record<string, { dx: number; dy: number }> | undefined) ?? {}) };
      if (this.offset && (Math.abs(this.offset.dx) > 1 || Math.abs(this.offset.dy) > 1)) all[location.hostname] = { dx: Math.round(this.offset.dx), dy: Math.round(this.offset.dy) };
      else {
        delete all[location.hostname];
        this.offset = null;
        this.resetBtn.style.display = 'none';
      }
      await chrome.storage.local.set({ [BALL_KEY]: all });
    } catch {
      /* 扩展刚更新、存储不可用：这次的位置只在本页有效 */
    }
  }

  /* ---------------------------------------------------------------- */
  /* 快捷键                                                            */
  /* ---------------------------------------------------------------- */

  private onKey = (e: KeyboardEvent) => {
    const cfg = this.settings.input;
    if (!cfg?.enabled || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape' && this.busy) {
      this.cancel(L('已取消', 'Cancelled'));
      return;
    }
    const sc = cfg.shortcut;
    const hit =
      (sc === 'Alt+T' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyT') ||
      (sc === 'Alt+Y' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyY') ||
      (sc === 'Ctrl+Shift+Y' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyY');
    if (hit) {
      const el = activeEditable();
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      this.attach(el);
      if (this.busy) this.cancel(L('已取消', 'Cancelled'));
      else void this.translate();
      return;
    }
    // 键盘打开小圆球的面板：快捷键再加 Shift（Alt+Shift+T / Alt+Shift+Y），焦点进语言下拉框；Esc 回到输入框
    const letter = sc === 'off' ? '' : sc.slice(-1);
    if (letter && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === `Key${letter}`) {
      const el = activeEditable();
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      this.attach(el);
      this.openPanel();
      return;
    }
    // 连按三下空格：第三下不进输入框，前两下在替换时一起去掉
    if (cfg.tripleSpace && e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const el = activeEditable();
      if (!el) return;
      const now = performance.now();
      this.spaces = [...this.spaces.filter((t) => now - t < 650), now];
      const v = valueOf(el);
      if (this.spaces.length >= 3 && /\s{2}$/.test(v.replace(/\n$/, '')) && v.trim()) {
        e.preventDefault();
        this.spaces = [];
        this.attach(el);
        void this.translate(true);
      }
    } else if (e.key !== ' ') this.spaces = [];
  };

  /* ---------------------------------------------------------------- */
  /* 翻译                                                              */
  /* ---------------------------------------------------------------- */

  private async translate(trimTrailingSpaces = false): Promise<void> {
    const el = this.field ?? activeEditable();
    if (!el || this.busy) return;
    const snap = snapshot(el);
    if (!snap) {
      this.say(L('输入框里还没有文字', 'The box is empty'));
      return;
    }
    if (trimTrailingSpaces && snap.whole) snap.text = snap.text.replace(/[  ]{2,}$/, '');
    const cfg = this.settings.input;
    const { parts, slots } = splitLines(snap.text);
    if (!slots.length) return;
    const jobId = uid('in');
    this.busy = { jobId, snap };
    this.wrap.classList.add('busy');
    this.say(L('正在翻译…', 'Translating…'));
    const mode: Mode = cfg.mode === 'fast' ? 'fast' : 'accurate';
    const out = new Map<string, string>();
    const done = (fail?: ErrorInfo) => {
      if (this.busy?.jobId !== jobId) return;
      this.busy = null;
      this.wrap.classList.remove('busy');
      if (fail) return this.say(fail.message || L('翻译失败', 'Translation failed'), true);
      if (valueOf(el) !== snap.before) return this.say(L('输入框里的文字已经改了，这次结果没有替换', 'The text changed meanwhile, so it was not replaced'), true);
      const translated = parts.map((p, i) => (slots.includes(i) ? keepEdges(p, out.get(`l${i}`) ?? p) : p)).join('');
      const native = replaceText(snap, translated);
      this.setUndo({ snap, after: valueOf(el), native });
      this.say(native ? L('已替换 · Ctrl+Z 可撤销', 'Replaced · Ctrl+Z to undo') : L('已替换', 'Replaced'));
    };
    this.client.send(
      {
        jobId,
        sourceLang: 'auto',
        targetLang: cfg.targetLang || 'en',
        mode,
        priority: 0,
        context: { url: location.href, title: document.title },
        segments: slots.map((i) => ({ id: `l${i}`, text: parts[i].trim(), kind: 'selection' as const })),
        // 在敏感网站（邮箱、银行）上写的东西不进缓存
        noCache: hostMatches(location.hostname, this.settings.sensitive) || undefined,
        stream: false,
      },
      {
        onResult: (id: string, text: string, stage: Stage) => {
          if (mode === 'accurate' && stage === 'fast') return;
          out.set(id, text.replace(/<\/?[gx]\d+\/?>/g, ''));
          if (out.size >= slots.length) done();
        },
        onError: (_id: string, stage: Stage, error: ErrorInfo) => {
          if (mode === 'accurate' && stage === 'fast') return;
          done(error);
        },
      },
    );
  }

  private cancel(why: string) {
    if (!this.busy) return;
    this.client.cancel(this.busy.jobId);
    this.busy = null;
    this.wrap.classList.remove('busy');
    this.say(why);
  }

  private setUndo(u: InputTranslator['undo']) {
    this.undo = u;
    this.undoBtn.style.display = u ? '' : 'none';
  }

  private doUndo() {
    const u = this.undo;
    if (!u || !u.snap.el.isConnected) return this.setUndo(null);
    const el = u.snap.el;
    if (valueOf(el) !== u.after) {
      this.setUndo(null);
      return this.say(L('文字已经改过，不能撤销了', 'The text has changed since, so it can\'t be undone'), true);
    }
    if (u.native) {
      el.focus({ preventScroll: true });
      try {
        if (document.execCommand('undo')) {
          this.setUndo(null);
          return this.say(L('已撤销', 'Undone'));
        }
      } catch {
        /* 退回手动恢复 */
      }
    }
    replaceText({ ...u.snap, whole: true, start: 0, end: valueOf(el).length, range: null, before: valueOf(el) }, u.snap.before);
    this.setUndo(null);
    this.say(L('已撤销', 'Undone'));
  }

  private say(text: string, bad = false) {
    this.msg.textContent = text;
    this.msg.classList.toggle('bad', bad);
    if (text && bad) this.wrap.classList.add('open');
  }
}

/** 保留一行首尾的空白（缩进、行尾空格）。 */
function keepEdges(orig: string, translated: string): string {
  const lead = /^\s*/.exec(orig)?.[0] ?? '';
  const trail = /\s*$/.exec(orig)?.[0] ?? '';
  return lead + translated.trim() + trail;
}
