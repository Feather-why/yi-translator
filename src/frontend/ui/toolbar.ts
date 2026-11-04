/**
 * 段落悬停工具条：鼠标停在一段译文上约 0.35 秒，右上角出现一个小工具条：
 *   重新翻译 · 换一家翻译 · 复制 · 修改译文 · 翻得不好
 * 修改译文时链接、代码保持不动（占位符编号不变），保存后写入译文记忆，以后同一句原文直接用它。
 */
import { rpc } from '../../shared/rpc';
import type { UiSettings } from '../../shared/settings';
import type { PageTranslator } from '../content/page';
import { toPlaceholderText } from '../content/serialize';
import { h, icon, type UiHost } from './host';
import type { StatusFeed } from './status-feed';
import { L } from '../i18n';

const CSS = `
.ptb { position: absolute; display: none; align-items: center; gap: 1px; padding: 3px; border-radius: 10px; z-index: 2;
  background: color-mix(in srgb, var(--surface) 92%, transparent); border: 1px solid var(--line); box-shadow: var(--shadow);
  backdrop-filter: blur(12px) saturate(1.4); -webkit-backdrop-filter: blur(12px) saturate(1.4); animation: tx-ptb-in .12s ease-out; }
.ptb.on { display: inline-flex; }
@keyframes tx-ptb-in { from { opacity: 0; transform: translateY(3px); } }
.ptb .icon-btn { width: 26px; height: 26px; }
.ptb .sep { width: 1px; height: 16px; background: var(--line); margin: 0 2px; }
.ptb .save { width: auto; padding: 0 9px; gap: 4px; color: var(--accent-ink); background: var(--accent); font-size: 12px; font-weight: 600; display: inline-flex; }
.ptb .save:hover { background: var(--accent); color: var(--accent-ink); filter: brightness(1.06); }
.ptb .save svg { width: 13px; height: 13px; }
.engs { position: absolute; display: none; min-width: 180px; max-width: 260px; padding: 4px; border-radius: 10px; z-index: 3;
  background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); }
.engs.on { display: block; }
.engs .hd { font-size: 11px; color: var(--muted); padding: 4px 8px 2px; }
.engs button { display: flex; width: 100%; justify-content: space-between; gap: 10px; padding: 6px 8px; border-radius: 7px; font-size: 12.5px; text-align: left; }
.engs button:hover { background: var(--hover); }
.engs button span:last-child { color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.engs button[aria-current="true"] span:first-child { color: var(--accent); font-weight: 600; }
.engs .empty { font-size: 12px; color: var(--muted); padding: 6px 8px; }
.flash { position: absolute; padding: 5px 10px; border-radius: 8px; font-size: 12px; z-index: 3; background: var(--ink); color: var(--surface); box-shadow: var(--shadow); animation: tx-ptb-in .12s ease-out; }
`;

const BAD = new Set(['exhausted', 'error', 'unconfigured', 'disabled']);

/** 译文文字实际占的范围。块级译文的元素框是整栏宽，文字可能只占一半，按文字的行框来放工具条。 */
function textBox(el: Element): { top: number; right: number } {
  const box = el.getBoundingClientRect();
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    let top = Infinity;
    let right = -Infinity;
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
    }
    if (Number.isFinite(top) && Number.isFinite(right)) return { top, right: Math.min(right, box.right) };
  } catch { /* 取不到就用元素框 */ }
  return { top: box.top, right: box.right };
}

export class ParaToolbar {
  private bar: HTMLDivElement;
  private engs: HTMLDivElement;
  private tx: HTMLElement | null = null;
  private showTimer = 0;
  private hideTimer = 0;
  private editing: { tx: HTMLElement; html: string } | null = null;
  private normal: HTMLElement[];
  private editBtns: HTMLElement[];
  private swapBtn!: HTMLButtonElement;

  constructor(private ui: UiHost, private page: PageTranslator, private feed: StatusFeed, private settings: UiSettings) {
    ui.addStyle(CSS);
    const btn = (name: string, label: string, fn: () => void) => {
      const b = h('button', { class: 'icon-btn', title: label, 'aria-label': label, type: 'button' }, icon(name));
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    const save = h('button', { class: 'icon-btn save', type: 'button', title: L('保存（Enter）', 'Save (Enter)') }, icon('check'), L('保存', 'Save'));
    save.addEventListener('mousedown', (e) => e.preventDefault());
    save.addEventListener('click', () => this.finishEdit(true));
    this.normal = [
      btn('retry', L('重新翻译', 'Retranslate'), () => this.retry()),
      (this.swapBtn = btn('swap', L('换一家翻译', 'Translate with another service'), () => this.toggleEngines())),
      btn('copy', L('复制译文', 'Copy translation'), () => this.copy()),
      btn('pencil', L('修改译文（会记住，以后同一句直接用）', 'Edit translation (remembered for the same sentence next time)'), () => this.startEdit()),
      h('span', { class: 'sep' }),
      btn('thumbDown', L('翻得不好（记一次差评并换一家重翻）', 'Bad translation (logs it and retranslates with another service)'), () => this.bad()),
    ];
    this.editBtns = [save, btn('close', L('取消（Esc）', 'Cancel (Esc)'), () => this.finishEdit(false))];
    this.bar = h('div', { class: 'ptb', role: 'toolbar', 'aria-label': L('这段译文', 'This translation') }, ...this.normal, ...this.editBtns);
    this.engs = h('div', { class: 'engs', role: 'menu' });
    ui.layer.append(this.bar, this.engs);
    this.mode(false);

    this.bar.addEventListener('mouseenter', () => clearTimeout(this.hideTimer));
    this.bar.addEventListener('mouseleave', () => this.hideSoon());
    this.engs.addEventListener('mouseenter', () => clearTimeout(this.hideTimer));
    this.engs.addEventListener('mouseleave', () => this.hideSoon());
    document.addEventListener('mouseover', this.onOver, true);
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('keydown', this.onOpenKey, true);
    document.addEventListener('contextmenu', this.onContextMenu, true);
    this.bindKeyboard();
    document.addEventListener('scroll', () => this.place(), { capture: true, passive: true });
  }

  apply(s: UiSettings): void {
    this.settings = s;
  }

  private mode(edit: boolean) {
    this.normal.forEach((b) => (b.style.display = edit ? 'none' : ''));
    this.editBtns.forEach((b) => (b.style.display = edit ? '' : 'none'));
  }

  private onOver = (e: MouseEvent) => {
    if (this.editing || this.ui.contains(e)) return;
    const tx = (e.target as Element | null)?.closest?.('tx-t') as HTMLElement | null;
    const stage = tx?.getAttribute('data-tx-stage');
    if (tx && (stage === 'final' || stage === 'fast')) {
      clearTimeout(this.hideTimer);
      if (tx === this.tx && this.bar.classList.contains('on')) return;
      clearTimeout(this.showTimer);
      this.showTimer = window.setTimeout(() => this.show(tx), 350);
    } else if (this.tx) {
      clearTimeout(this.showTimer);
      this.hideSoon();
    }
  };

  private show(tx: HTMLElement) {
    this.tx = tx;
    this.engs.classList.remove('on');
    this.bar.classList.add('on');
    this.place();
  }

  private hideSoon() {
    if (this.editing) return;
    // 键盘正在工具条里操作时，鼠标移开不收起
    if (this.bar.matches(':focus-within') || this.engs.matches(':focus-within')) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.bar.classList.remove('on');
      this.engs.classList.remove('on');
      this.tx = null;
      this.feed.close();
    }, 450);
  }

  /* ---------------- 键盘 ---------------- */

  private menuKeyAt = 0;
  private engsByKey = false;

  /**
   * 键盘打开工具条：光标 / 选区在某段译文里时按 Shift+F10 或菜单键（和系统「右键菜单」同一个键），
   * 焦点移到工具条的第一个按钮。浏览器自己的右键菜单这一次不弹。
   */
  private onOpenKey = (e: KeyboardEvent) => {
    if (this.editing || !(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey))) return;
    const node = getSelection()?.anchorNode;
    const tx = (node instanceof Element ? node : node?.parentElement)?.closest?.('tx-t') as HTMLElement | null;
    const stage = tx?.getAttribute('data-tx-stage');
    if (!tx || (stage !== 'final' && stage !== 'fast')) return;
    e.preventDefault();
    e.stopPropagation();
    this.menuKeyAt = Date.now();
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    this.show(tx);
    this.buttons()[0]?.focus();
  };

  private onContextMenu = (e: MouseEvent) => {
    if (Date.now() - this.menuKeyAt < 800) {
      e.preventDefault();
      this.menuKeyAt = 0;
    }
  };

  private buttons(): HTMLButtonElement[] {
    return [...this.bar.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.style.display !== 'none');
  }

  /** 工具条：←→ / Home / End 在按钮之间走，Esc 收起；换引擎菜单：↑↓ 选，Esc 回到「换一家」按钮。 */
  private bindKeyboard() {
    this.bar.addEventListener('keydown', (e) => {
      if (this.editing) return; // 修改译文时的 Enter / Esc 由 onKey 处理
      const items = this.buttons();
      const i = items.indexOf(this.ui.root.activeElement as HTMLButtonElement);
      let next = -1;
      if (e.key === 'ArrowRight') next = (i + 1) % items.length;
      else if (e.key === 'ArrowLeft') next = (i + items.length - 1) % items.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      else if (e.key === 'ArrowDown' && this.engs.classList.contains('on')) return void (e.preventDefault(), this.engItems()[0]?.focus());
      else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // 先收起换引擎菜单，再按一次才收起工具条
        if (this.engs.classList.contains('on')) return void this.engs.classList.remove('on');
        return this.closeByKeyboard();
      }
      if (next >= 0 && items.length) {
        e.preventDefault();
        items[next].focus();
      }
    });
    this.engs.addEventListener('keydown', (e) => {
      const items = this.engItems();
      const i = items.indexOf(this.ui.root.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.engs.classList.remove('on');
        this.swapBtn.focus();
      }
    });
    // Tab 出去（焦点离开工具条和菜单）就收起
    const out = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null;
      if (to && (this.bar.contains(to) || this.engs.contains(to))) return;
      if (this.editing) return;
      window.setTimeout(() => {
        if (!this.bar.matches(':focus-within') && !this.engs.matches(':focus-within') && !this.bar.matches(':hover')) this.hideSoon();
      }, 0);
    };
    this.bar.addEventListener('focusout', out);
    this.engs.addEventListener('focusout', out);
  }

  private engItems(): HTMLButtonElement[] {
    return [...this.engs.querySelectorAll<HTMLButtonElement>('button')];
  }

  private closeByKeyboard() {
    const tx = this.tx;
    this.bar.classList.remove('on');
    this.engs.classList.remove('on');
    this.tx = null;
    this.feed.close();
    // 焦点放回页面：把光标放在这段译文末尾，键盘用户能接着往下读
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (tx?.isConnected) getSelection()?.collapse(tx, tx.childNodes.length);
  }

  /** 放在译文的右上角上方；上方没地方就放到译文里面的右上角。 */
  private place() {
    if (!this.tx || !this.bar.classList.contains('on')) return;
    if (!this.tx.isConnected) return this.bar.classList.remove('on');
    const r = textBox(this.tx);
    const w = this.bar.offsetWidth;
    const hh = this.bar.offsetHeight;
    // 右边有空白就放在译文右侧，不压住任何文字；否则放在译文上方靠右
    const side = r.right + w + 14 < window.innerWidth;
    const x = side ? r.right + 8 : Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    const y = side ? Math.max(4, r.top - 2) : r.top - hh - 4 >= 0 ? r.top - hh - 4 : r.top + 4;
    this.bar.style.left = `${Math.round(x + window.scrollX)}px`;
    this.bar.style.top = `${Math.round(y + window.scrollY)}px`;
    if (this.engs.classList.contains('on')) {
      this.engs.style.left = `${Math.round(Math.min(window.innerWidth - 268, x) + window.scrollX)}px`;
      this.engs.style.top = `${Math.round(y + hh + 4 + window.scrollY)}px`;
    }
  }

  private flash(text: string) {
    const r = this.bar.getBoundingClientRect();
    const f = h('div', { class: 'flash', role: 'status' }, text);
    f.style.left = `${Math.round(r.left + window.scrollX)}px`;
    f.style.top = `${Math.round(r.top - 34 + window.scrollY)}px`;
    this.ui.layer.append(f);
    setTimeout(() => f.remove(), 1800);
  }

  private hit() {
    return this.page.hitFor(this.tx);
  }

  private retry() {
    const hit = this.hit();
    if (hit) this.page.resend([hit]);
    this.done();
  }

  /** 按完会收起工具条的按钮：键盘操作时把光标放回这段译文，焦点不丢到页面开头。 */
  private done() {
    if (this.bar.matches(':focus-within') || this.engs.matches(':focus-within')) this.closeByKeyboard();
    else this.bar.classList.remove('on');
  }

  private async copy() {
    if (!this.tx) return;
    await navigator.clipboard.writeText(this.tx.innerText.trim()).catch(() => {});
    this.flash(L('已复制', 'Copied'));
  }

  private bad() {
    const hit = this.hit();
    if (!hit) return;
    void rpc('feedback:bad', {
      source: hit.part.text,
      translation: hit.part.translated ?? '',
      provider: hit.part.provider ?? '',
      sourceLang: this.settings.sourceLang || 'auto',
      targetLang: this.settings.targetLang,
    }).catch(() => {});
    this.page.resend([hit]);
    this.done();
  }

  /* ---------------- 换引擎 ---------------- */

  private toggleEngines() {
    if (this.engs.classList.contains('on')) return void this.engs.classList.remove('on');
    this.feed.open();
    this.renderEngines();
    this.feed.onSnapshot = () => this.engs.classList.contains('on') && this.renderEngines();
    this.engs.classList.add('on');
    this.place();
    // 从键盘按的（焦点在「换一家」按钮上）：焦点进菜单；服务列表还没到时，到了再进
    this.engsByKey = this.ui.root.activeElement === this.swapBtn;
    if (this.engsByKey && this.engItems()[0]) {
      this.engItems()[0].focus();
      this.engsByKey = false;
    }
  }

  private renderEngines() {
    // 用量快照到了会重画：键盘焦点在菜单里时，画完放回同一个位置
    const focused = this.engItems().indexOf(this.ui.root.activeElement as HTMLButtonElement);
    const hit = this.hit();
    const ps = (this.feed.latest?.providers ?? []).filter((p) => p.enabled && !BAD.has(p.health) && p.usedFor.some((m) => m === 'fast' || m === 'accurate'));
    ps.sort((a, b) => (a.latencyP50Ms ?? 9e9) - (b.latencyP50Ms ?? 9e9));
    this.engs.replaceChildren(h('div', { class: 'hd' }, L('用这一家重新翻译这段', 'Retranslate this paragraph with this service')));
    if (!this.feed.latest) this.engs.append(h('div', { class: 'empty' }, L('正在读取服务列表…', 'Loading services…')));
    else if (!ps.length) this.engs.append(h('div', { class: 'empty' }, L('没有其他可用的服务', 'No other service available')));
    for (const p of ps) {
      const b = h('button', { type: 'button', role: 'menuitem', 'aria-current': String(p.id === hit?.part.provider) }, h('span', null, p.name), h('span', null, p.latencyP50Ms ? `${p.latencyP50Ms} ms` : ''));
      b.addEventListener('click', () => {
        const cur = this.hit();
        if (cur) this.page.resend([cur], p.id);
        this.done();
      });
      this.engs.append(b);
    }
    if (focused >= 0) (this.engItems()[focused] ?? this.engItems()[0] ?? this.swapBtn).focus();
    else if (this.engsByKey && this.engItems()[0] && this.ui.root.activeElement === this.swapBtn) {
      this.engItems()[0].focus();
      this.engsByKey = false;
    }
  }

  /* ---------------- 修改译文 ---------------- */

  private startEdit() {
    const tx = this.tx;
    if (!tx) return;
    this.engs.classList.remove('on');
    this.editing = { tx, html: tx.innerHTML };
    tx.setAttribute('contenteditable', 'true');
    tx.setAttribute('spellcheck', 'false');
    tx.focus();
    const sel = getSelection();
    sel?.selectAllChildren(tx);
    sel?.collapseToEnd();
    this.mode(true);
    this.place();
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.editing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.finishEdit(false);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.finishEdit(true);
    }
  };

  private finishEdit(save: boolean) {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    ed.tx.removeAttribute('contenteditable');
    ed.tx.removeAttribute('spellcheck');
    this.mode(false);
    if (!save) {
      ed.tx.innerHTML = ed.html;
      this.hideSoon();
      return;
    }
    const hit = this.page.hitFor(ed.tx);
    const text = toPlaceholderText(ed.tx);
    if (!hit || !text) {
      ed.tx.innerHTML = ed.html;
      return;
    }
    void this.page.saveEdit(hit, text).then(
      () => this.flash(L('已保存，以后同一句会直接用这个译文', 'Saved — the same sentence will use this translation from now on')),
      () => this.flash(L('已修改，但没能写入译文记忆', 'Edited, but could not be saved to translation memory')),
    );
    this.hideSoon();
  }
}
