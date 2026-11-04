/**
 * 划词翻译：
 * - 选中文字后，在选区末尾右下方出现一个不挡字的小圆点；鼠标移上去就开始预取，点击打开小窗；
 * - 小窗是毛玻璃，可拖动、可固定（固定的小窗不限数量），显示原文和译文（综合模式先浅后深）；
 * - 顶上可以随手改原文语言和目标语言；选中的已经是目标语言时，自动翻成「输入框翻译」的语言；
 * - 鼠标停在小窗里的某个词上，另一侧对应的词同步高亮（本地词对齐）；
 * - 只选了一个英文单词时显示词典卡片（离线 ECDICT），可再请求「在这句里的意思」。
 */
import type { AlignResult, DictEntry, ErrorInfo, Mode, Stage } from '../../shared/protocol';
import { rpc, uid } from '../../shared/rpc';
import { saveUiSettings, type UiSettings } from '../../shared/settings';
import type { TranslateClient } from '../content/port';
import { looksLikeTarget } from '../content/scanner';
import { LANGS, SOURCE_LANGS } from '../langs';
import { LANG_PICKER_CSS, langPicker } from './lang-picker';
import { h, iconButton, type UiHost } from './host';
import { logoElement } from './logo';
import { estimateLength, revealText, scrambleEnabled, startScramble, stopScramble } from './scramble';
import { L } from '../i18n';

const CSS = `
.dot {
  position: absolute; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
  background: var(--surface); color: var(--ink); --logo-accent: var(--accent); border: 1px solid var(--line); box-shadow: var(--shadow);
  opacity: .9; animation: tx-pop .14s ease-out;
}
.dot:hover { opacity: 1; background: var(--accent); color: var(--accent-ink); --logo-accent: color-mix(in srgb, var(--accent-ink) 65%, transparent); }
@keyframes tx-pop { from { transform: scale(.6); opacity: 0 } }
.pop {
  position: absolute; width: min(440px, calc(100vw - 24px)); border-radius: 12px; overflow: hidden;
  /* 毛玻璃：底色只透一点，背后的字被模糊掉，不会和译文抢眼（不能再给整个小窗设 opacity，否则背后清晰的字会透出来） */
  background: color-mix(in srgb, var(--surface) 76%, transparent);
  backdrop-filter: blur(18px) saturate(1.6); -webkit-backdrop-filter: blur(18px) saturate(1.6);
  border: 1px solid var(--line); box-shadow: var(--shadow); transition: background-color .18s, box-shadow .18s;
  animation: tx-pop .14s ease-out;
}
.pop:hover, .pop:focus-within, .pop.pinned { background: color-mix(in srgb, var(--surface) 90%, transparent); }
.pop.pinned { box-shadow: var(--shadow), 0 0 0 1.5px color-mix(in srgb, var(--accent) 40%, transparent); }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { .pop, .pop:hover { background: var(--surface); } }
.pop.above { transform: translateY(-100%); }
.pop:focus { outline: none; }
.pop:focus-visible { box-shadow: var(--shadow), 0 0 0 2px var(--accent); }
.pop header { display: flex; align-items: center; gap: 2px; padding: 4px 6px 0 8px; cursor: grab; user-select: none; }
.pop header:active { cursor: grabbing; }
.pop .langs { display: flex; align-items: center; gap: 0; flex: none; font-size: 11.5px; margin-right: 4px; }
.pop .langs .arr { color: var(--muted); font-size: 11px; margin: 0 1px; }
.pop .langs.swapped .lp:last-child { color: var(--accent); }
.pop .tag { font-size: 11px; color: var(--muted); flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pop .body { padding: 2px 14px 12px; display: grid; gap: 6px; max-height: min(60vh, 420px); overflow: auto; }
.pop .src { color: var(--muted); font-size: 12.5px; line-height: 1.55; }
.pop .tgt { font-size: 15px; line-height: 1.65; color: var(--ink); transition: opacity .25s; white-space: pre-wrap; }
.pop .tgt[data-stage="fast"], .pop .tgt[data-stage="streaming"] { opacity: .6; }
.pop .tgt[data-stage="streaming"]::after { content: ""; display: inline-block; width: .5em; height: 1em; margin-left: 2px; vertical-align: -.12em; border-radius: 1px; background: currentColor; opacity: .5; animation: tx-caret .9s steps(2, start) infinite; }
@keyframes tx-caret { to { visibility: hidden; } }
.pop .tgt .tx-scr { opacity: .35; user-select: none; }
.pop .tgt[data-stage="pending"]:not([data-fx])::after { content: "\\2022\\2022\\2022"; letter-spacing: .12em; opacity: .4; animation: tx-pulse 1.1s infinite; }
@keyframes tx-pulse { 50% { opacity: .9 } }
.pop .err { color: var(--danger); font-size: 12.5px; }
.tok { border-radius: 3px; transition: background-color .08s; }
.tok.hl { background: var(--mark); }
.dict .head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dict .word { font-size: 19px; font-weight: 650; }
.dict .phon { color: var(--muted); font-size: 13px; }
.dict .chips { display: flex; gap: 4px; flex-wrap: wrap; }
.dict .chip { font-size: 10.5px; padding: 1px 6px; border-radius: 99px; background: var(--hover); color: var(--muted); }
.dict ul { margin: 2px 0 0; padding: 0; list-style: none; display: grid; gap: 2px; font-size: 14px; }
.dict .forms { font-size: 12px; color: var(--muted); }
.dict .defs { font-size: 12px; color: var(--muted); }
.more { justify-self: start; font-size: 12px; color: var(--accent); padding: 2px 0; }
.explain { font-size: 13.5px; line-height: 1.6; border-top: 1px dashed var(--line); padding-top: 6px; }
`;

const WORD_RE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}][\p{L}\p{M}'’-]{0,39}$/u;
const MODE_LABEL: Record<Mode, string> = {
  get fast() { return L('快速', 'Fast'); },
  get accurate() { return L('精确', 'Accurate'); },
  get combined() { return L('综合', 'Combined'); },
};

interface Anchor {
  rect: DOMRect;
  text: string;
  context: string;
}

interface Pop {
  el: HTMLDivElement;
  anchor: Anchor;
  state: PopState;
  pinned: boolean;
  /** 这个小窗实际用的语言（原文已是目标语言时，目标换成「输入框翻译」的语言）。 */
  source: string;
  target: string;
  swapped: boolean;
  /** 换了状态（重翻、换语言）以后重新绑定显示。 */
  bind(state: PopState): void;
}

export class SelectionUi {
  private dot: HTMLButtonElement;
  /** 没固定的那个小窗（同时最多一个）；固定的小窗不限数量，各自独立，点 ✕ 才关。 */
  private current: Pop | null = null;
  private pinnedPops = new Set<Pop>();
  private anchor: Anchor | null = null;
  private prefetched: { key: string; state: PopState } | null = null;
  private settings: UiSettings;
  /** 新固定的小窗错开一点，不完全叠在一起。 */
  private stagger = 0;

  constructor(private ui: UiHost, private client: TranslateClient, settings: UiSettings) {
    this.settings = settings;
    ui.addStyle(CSS + LANG_PICKER_CSS);
    this.dot = h('button', { class: 'dot', title: L('翻译选中内容（Alt+S）', 'Translate selection (Alt+S)'), 'aria-label': L('翻译选中内容', 'Translate selection') }, logoElement({ size: 15, lines: 1 }));
    this.dot.style.display = 'none';
    this.dot.addEventListener('mouseenter', () => this.prefetch());
    this.dot.addEventListener('mousedown', (e) => e.preventDefault()); // 不让选区消失
    this.dot.addEventListener('click', () => this.open());
    ui.layer.appendChild(this.dot);

    document.addEventListener('mouseup', this.onMouseUp, true);
    document.addEventListener('keyup', this.onKeyUp, true);
    document.addEventListener('mousedown', this.onMouseDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
  }

  apply(s: UiSettings): void {
    this.settings = s;
    if (!s.selection.enabled) this.hideDot();
  }

  /** 快捷键 / 右键菜单：直接打开当前选区的小窗。 */
  openForSelection(text?: string): void {
    const a = this.readSelection(true);
    if (!a) {
      if (text) this.openForText(text);
      return;
    }
    this.anchor = a;
    this.open();
    // 用快捷键打开时把焦点给小窗：Tab 能在按钮之间切换，Esc 关闭
    this.current?.el.focus({ preventScroll: true });
  }

  /**
   * 没有 DOM 选区、只有文字时开小窗（浏览器自带 PDF 查看器里右键「翻译」）。
   * 小窗放在视口右上方，直接固定（没有选区可以对照，点页面别处时不自动关）。
   */
  openForText(text: string, context = ''): void {
    const t = text.replace(/\s+/g, ' ').trim().slice(0, 3000);
    if (!t || !/\p{L}/u.test(t)) return;
    const x = Math.max(16, window.innerWidth - 440);
    this.anchor = { rect: new DOMRect(x, 72, 1, 1), text: t, context };
    this.open();
    if (this.current) this.pin(this.current, true);
  }

  /* ---------------------------------------------------------------- */

  private onMouseDown = (e: MouseEvent) => {
    if (this.ui.contains(e)) return;
    this.hideDot();
    if (this.current) this.closePop(this.current);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (this.current || this.dot.style.display !== 'none') {
      if (this.current) this.closePop(this.current);
      this.hideDot();
      return;
    }
    // 只剩固定的小窗：焦点在哪个里面就关哪个
    for (const p of this.pinnedPops) {
      if (p.el.matches(':focus-within')) {
        this.closePop(p);
        return;
      }
    }
  };

  private onMouseUp = (e: MouseEvent) => {
    if (!this.settings.selection.enabled || this.ui.contains(e) || e.button !== 0) return;
    setTimeout(() => this.maybeShowDot(), 0);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (!this.settings.selection.enabled || !e.shiftKey) return;
    this.maybeShowDot();
  };

  private readSelection(force = false): Anchor | null {
    const sel = getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text || text.length > 3000 || !/\p{L}/u.test(text)) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!force && !this.settings.selection.inEditable) {
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return null;
      if (el?.closest('[contenteditable=""],[contenteditable="true"]')) return null;
    }
    const rects = range.getClientRects();
    const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    return { rect: rects.length ? new DOMRect(rect.x, rect.y, rect.width, rect.height) : last, text, context: contextOf(range, text) };
  }

  private maybeShowDot() {
    const a = this.readSelection();
    if (!a) return this.hideDot();
    this.anchor = a;
    const sel = getSelection()!;
    const rects = sel.getRangeAt(0).getClientRects();
    const end = rects[rects.length - 1] ?? a.rect;
    // 放在选区最后一行的右下方，不挡住选中的字
    const x = Math.min(window.innerWidth - 30, end.right + 4) + window.scrollX;
    const y = end.bottom + 4 + window.scrollY;
    this.dot.style.left = `${Math.round(x)}px`;
    this.dot.style.top = `${Math.round(y)}px`;
    this.dot.style.display = '';
  }

  private hideDot() {
    this.dot.style.display = 'none';
  }

  /* ---------------------------------------------------------------- */
  /* 翻译                                                              */
  /* ---------------------------------------------------------------- */

  private isWord(text: string) {
    return WORD_RE.test(text);
  }

  /** 这段文字实际翻译用的语言：原文已经是目标语言（自动识别时）就翻成「输入框翻译」的语言，默认英语。 */
  private langsFor(text: string): { source: string; target: string; swapped: boolean } {
    const source = this.settings.sourceLang || 'auto';
    const target = this.settings.targetLang;
    if (source === 'auto' && looksLikeTarget(text, target)) {
      const alt = this.settings.input?.targetLang || 'en';
      const other = alt.split('-')[0] === target.split('-')[0] ? 'en' : alt;
      if (other.split('-')[0] !== target.split('-')[0]) return { source, target: other, swapped: true };
    }
    return { source, target, swapped: false };
  }

  private prefetch() {
    const a = this.anchor;
    if (!a) return;
    const key = a.text;
    if (this.prefetched?.key === key) return;
    if (this.prefetched) this.client.cancel(this.prefetched.state.jobId);
    this.prefetched = { key, state: this.startTranslate(a, this.langsFor(a.text)) };
  }

  private startTranslate(a: Anchor, langs: { source: string; target: string }, noCache = false, providerHint?: string): PopState {
    const state = new PopState();
    if (this.isWord(a.text)) {
      state.dict = rpc('dict:lookup', { word: a.text, lang: langs.source, targetLang: langs.target }).catch(() => null);
    }
    const mode = this.settings.selection.mode;
    const jobId = uid('s');
    state.jobId = jobId;
    state.langs = { ...langs };
    this.client.send(
      {
        jobId,
        sourceLang: langs.source,
        targetLang: langs.target,
        mode,
        priority: 0,
        context: { url: location.href, title: document.title, summary: a.context },
        segments: [{ id: 'sel', text: a.text, kind: 'selection' }],
        noCache: noCache || undefined,
        providerHint,
        stream: true,
      },
      {
        onResult: (_id, text, stage, provider) => state.set({ text, stage, provider }),
        onPartial: (_id, text) => state.set({ partial: text }),
        onError: (_id, stage, error) => {
          if (stage === 'fast' && mode === 'combined') return;
          state.set({ error });
        },
      },
    );
    state.mode = mode;
    return state;
  }

  private open() {
    const a = this.anchor;
    if (!a) return;
    this.hideDot();
    const langs = this.langsFor(a.text);
    const pre = this.prefetched?.key === a.text && this.prefetched.state.langs?.target === langs.target ? this.prefetched.state : null;
    if (this.prefetched && !pre) this.client.cancel(this.prefetched.state.jobId);
    this.prefetched = null;
    if (this.current) this.closePop(this.current);
    this.current = this.render(a, pre ?? this.startTranslate(a, langs), langs);
  }

  private closePop(p: Pop) {
    this.client.cancel(p.state.jobId);
    p.state.onChange = null;
    p.el.remove();
    this.pinnedPops.delete(p);
    if (this.current === p) this.current = null;
  }

  /** 固定：从「当前小窗」里拿出来，之后再划词会另开一个，这个留着。 */
  private pin(p: Pop, on: boolean) {
    p.pinned = on;
    p.el.classList.toggle('pinned', on);
    p.el.querySelector('[data-act="pin"]')?.setAttribute('aria-pressed', String(on));
    if (on) {
      this.pinnedPops.add(p);
      if (this.current === p) this.current = null;
    } else {
      this.pinnedPops.delete(p);
      if (this.current && this.current !== p) this.closePop(this.current);
      this.current = p;
    }
  }

  private render(a: Anchor, state: PopState, langs: { source: string; target: string; swapped: boolean }): Pop {
    const tag = h('div', { class: 'tag' }, MODE_LABEL[state.mode]);
    const srcSel = langPicker(SOURCE_LANGS, langs.source, L('原文语言', 'Source language'), () => relang());
    const tgtSel = langPicker(LANGS, langs.target, langs.swapped ? L('原文已经是目标语言，翻成这个语言（改这里会改「输入框翻译」的语言）', 'The text is already in the target language — translate it into this one (also changes the input-box language)') : L('目标语言（改这里会改设置里的目标语言）', 'Target language (also changes the target language in Settings)'), () => relang());
    const langBox = h('div', { class: 'langs' }, srcSel.el, h('span', { class: 'arr', 'aria-hidden': 'true' }, '→'), tgtSel.el);
    if (langs.swapped) langBox.classList.add('swapped');

    const pinBtn = iconButton('pin', L('固定小窗（可以同时固定好几个）', 'Pin (you can pin several at once)'), () => this.pin(pop, !pop.pinned));
    pinBtn.dataset.act = 'pin';
    const copyBtn = iconButton('copy', L('复制译文', 'Copy translation'), () => {
      void navigator.clipboard.writeText(pop.state.text.replace(/<\/?[gx]\d+\/?>/g, ''));
    });
    const retryBtn = iconButton('retry', L('换一次重翻', 'Retranslate'), () => pop.bind(this.startTranslate(a, pop, true)));
    const badBtn = iconButton('thumbDown', L('翻得不好（会记录并换一家）', 'Bad translation (logs it and switches service)'), () => {
      if (!pop.state.text) return;
      void rpc('feedback:bad', {
        source: a.text,
        translation: pop.state.text,
        provider: pop.state.provider,
        sourceLang: pop.source,
        targetLang: pop.target,
      }).catch(() => {});
      pop.bind(this.startTranslate(a, pop, true));
    });
    const closeBtn = iconButton('close', L('关闭（Esc）', 'Close (Esc)'), () => this.closePop(pop));
    const header = h('header', null, langBox, tag, badBtn, retryBtn, copyBtn, pinBtn, closeBtn);

    const src = h('div', { class: 'src' }, a.text);
    const tgt = h('div', { class: 'tgt', 'data-stage': 'pending' });
    const err = h('div', { class: 'err' });
    err.style.display = 'none';
    const body = h('div', { class: 'body' });
    const dictBox = h('div', { class: 'dict' });
    dictBox.style.display = 'none';
    body.append(dictBox, src, tgt, err);

    const el = h('div', { class: 'pop', role: 'dialog', 'aria-label': L('划词翻译', 'Selection translation'), tabindex: '-1' }, header, body) as HTMLDivElement;
    this.ui.layer.appendChild(el);
    this.position(el, a.rect);

    const isWord = this.isWord(a.text);
    if (isWord) src.style.display = 'none';

    const pop: Pop = {
      el,
      anchor: a,
      state,
      pinned: false,
      source: langs.source,
      target: langs.target,
      swapped: langs.swapped,
      bind: (st: PopState) => {
        if (pop.state !== st) {
          this.client.cancel(pop.state.jobId);
          pop.state.onChange = null;
        }
        pop.state = st;
        show(st);
      },
    };
    this.bindDrag(pop, header);

    // 小窗里换语言：存进设置（以后的划词、整页都用它），这个小窗立刻按新语言重翻
    const relang = () => {
      const source = srcSel.select.value;
      const target = tgtSel.select.value;
      if (source !== this.settings.sourceLang) {
        this.settings = { ...this.settings, sourceLang: source };
        void saveUiSettings({ sourceLang: source });
      }
      if (target !== pop.target) {
        if (pop.swapped) {
          this.settings = { ...this.settings, input: { ...this.settings.input, targetLang: target } };
          void saveUiSettings({ input: { ...this.settings.input, targetLang: target } });
        } else {
          this.settings = { ...this.settings, targetLang: target };
          void saveUiSettings({ targetLang: target });
        }
      }
      pop.source = source;
      pop.target = target;
      pop.bind(this.startTranslate(a, pop));
    };

    const show = (st: PopState) => {
      const lang = pop.target;
      const fx = scrambleEnabled && this.settings.loadingEffect === 'scramble';
      err.style.display = 'none';
      tgt.style.display = '';
      tgt.dataset.stage = 'pending';
      tgt.textContent = '';
      stopScramble(tgt);
      delete tgt.dataset.fx;
      if (fx && !st.text) {
        tgt.dataset.fx = 'scramble';
        startScramble(tgt, estimateLength(a.text.length, lang, isWord ? 8 : 90), lang);
      }
      let shown = '';
      let alignedFor = '';
      st.onChange = () => {
        if (pop.state !== st) return;
        if (st.error && !st.text) {
          stopScramble(tgt);
          err.textContent = '⚠ ' + st.error.message;
          err.style.display = '';
          tgt.style.display = 'none';
          return;
        }
        const streaming = !st.text && !!st.partial;
        tgt.dataset.stage = streaming ? 'streaming' : st.stage;
        tag.textContent = `${MODE_LABEL[st.mode]}${st.provider ? ' · ' + st.provider : ''}`;
        const raw = st.text || st.partial.replace(/<\/?(?:[gx]\d*\/?)?$/, '');
        const clean = raw.replace(/<\/?[gx]\d+\/?>/g, '');
        if (clean && clean !== shown) {
          const first = !shown;
          shown = clean;
          stopScramble(tgt);
          delete tgt.dataset.fx;
          tgt.textContent = clean;
          // 只有第一次从跳字变成译文时定格；流式和快速→精确替换不再跳字
          if (fx && first && !streaming && !st.partial) revealText(tgt, lang);
        }
        // 拿到最终译文后取词对齐，渲染成可悬停联动的词
        if (st.stage === 'final' && clean && !isWord && alignedFor !== clean) {
          alignedFor = clean;
          rpc('align:get', {
            pairs: [{ id: 'sel', source: a.text, target: clean, sourceLang: pop.source, targetLang: pop.target }],
          })
            .then((r) => r[0] && pop.state === st && el.isConnected && renderAligned(src, tgt, a.text, clean, r[0]))
            .catch(() => {});
        }
      };
      st.onChange();
      if (st.dict) {
        void st.dict.then((d) => {
          if (pop.state !== st || !el.isConnected) return;
          if (d) {
            renderDict(dictBox, d, a, pop.target);
            dictBox.style.display = '';
            tgt.style.fontSize = '13.5px';
          } else src.style.display = '';
        });
      } else if (isWord) {
        dictBox.style.display = 'none';
        src.style.display = '';
      }
    };
    show(state);
    return pop;
  }

  private position(pop: HTMLElement, rect: DOMRect) {
    const w = Math.min(440, window.innerWidth - 24);
    // 已经有固定的小窗时错开一点，免得完全叠在一起
    const shift = this.pinnedPops.size ? (this.stagger = (this.stagger + 1) % 6) * 18 : 0;
    const left = Math.max(12, Math.min(rect.left + shift, window.innerWidth - w - 12));
    const below = window.innerHeight - rect.bottom;
    pop.style.left = `${Math.round(left + window.scrollX)}px`;
    if (below < 220 && rect.top > below) {
      pop.classList.add('above');
      pop.style.top = `${Math.round(rect.top - 10 + window.scrollY)}px`;
    } else pop.style.top = `${Math.round(rect.bottom + 10 + shift + window.scrollY)}px`;
  }

  private bindDrag(p: Pop, handle: HTMLElement) {
    const pop = p.el;
    let sx = 0, sy = 0, ox = 0, oy = 0, on = false, moved = false;
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).closest('button, select')) return;
      on = true;
      moved = false;
      sx = e.clientX;
      sy = e.clientY;
      const r = pop.getBoundingClientRect();
      ox = r.left + window.scrollX;
      oy = r.top + window.scrollY;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!on) return;
      if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 3) return;
      if (!moved) {
        moved = true;
        pop.classList.remove('above');
        pop.style.top = `${oy}px`;
      }
      pop.style.left = `${ox + e.clientX - sx}px`;
      pop.style.top = `${oy + e.clientY - sy}px`;
    });
    handle.addEventListener('pointerup', () => {
      if (!on) return;
      on = false;
      if (moved && !p.pinned) this.pin(p, true); // 拖过就固定
    });
  }
}


/** 一次划词翻译的结果，可能先于小窗出现（预取）。 */
class PopState {
  jobId = '';
  langs: { source: string; target: string } | null = null;
  text = '';
  stage: Stage | 'pending' = 'pending';
  provider = '';
  mode: Mode = 'accurate';
  error: ErrorInfo | null = null;
  /** 流式的中间结果（还没有完整译文时显示） */
  partial = '';
  dict: Promise<DictEntry | null> | null = null;
  onChange: (() => void) | null = null;

  set(p: { text?: string; stage?: Stage; provider?: string; error?: ErrorInfo; partial?: string }) {
    if (p.partial !== undefined) {
      if (this.text) return;
      this.partial = p.partial;
    }
    if (p.text !== undefined) {
      if (this.stage === 'final' && p.stage === 'fast') return;
      this.text = p.text;
    }
    if (p.stage) this.stage = p.stage;
    if (p.provider) this.provider = p.provider;
    if (p.error) this.error = p.error;
    this.onChange?.();
  }
}

/** 选区所在的那句话，作为上下文。 */
function contextOf(range: Range, text: string): string {
  const block = (range.commonAncestorContainer.nodeType === 1
    ? (range.commonAncestorContainer as Element)
    : range.commonAncestorContainer.parentElement
  )?.closest('p,li,td,dd,blockquote,h1,h2,h3,h4,h5,h6,div,section,article');
  const full = (block?.textContent || '').replace(/\s+/g, ' ').trim();
  if (!full || full.length <= text.length) return '';
  const at = full.indexOf(text);
  if (at < 0) return full.slice(0, 300);
  const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  for (const s of seg.segment(full)) {
    if (s.index <= at && s.index + s.segment.length >= at + Math.min(text.length, 20)) return s.segment.trim().slice(0, 400);
  }
  return full.slice(Math.max(0, at - 150), at + text.length + 150);
}

function renderAligned(srcEl: HTMLElement, tgtEl: HTMLElement, src: string, tgt: string, al: AlignResult) {
  const spansFor = (el: HTMLElement, text: string, tokens: [number, number][]) => {
    el.textContent = '';
    let pos = 0;
    const out: HTMLSpanElement[] = [];
    tokens.forEach(([s, e], i) => {
      if (s > pos) el.append(text.slice(pos, s));
      const sp = h('span', { class: 'tok', 'data-i': String(i) }, text.slice(s, e));
      out[i] = sp;
      el.append(sp);
      pos = e;
    });
    if (pos < text.length) el.append(text.slice(pos));
    return out;
  };
  const s = spansFor(srcEl, src, al.srcTokens);
  const t = spansFor(tgtEl, tgt, al.tgtTokens);
  const s2t = new Map<number, number[]>();
  const t2s = new Map<number, number[]>();
  for (const [a, b] of al.links) {
    (s2t.get(a) ?? s2t.set(a, []).get(a)!).push(b);
    (t2s.get(b) ?? t2s.set(b, []).get(b)!).push(a);
  }
  const clear = () => [...s, ...t].forEach((x) => x?.classList.remove('hl'));
  const bind = (mine: HTMLSpanElement[], other: HTMLSpanElement[], map: Map<number, number[]>) => {
    mine.forEach((sp, i) => {
      if (!sp) return;
      sp.addEventListener('mouseenter', () => {
        clear();
        const linked = map.get(i);
        if (!linked?.length) return;
        sp.classList.add('hl');
        linked.forEach((j) => other[j]?.classList.add('hl'));
      });
      sp.addEventListener('mouseleave', clear);
    });
  };
  bind(s, t, s2t);
  bind(t, s, t2s);
}

function renderDict(box: HTMLElement, d: DictEntry, a: Anchor, targetLang: string) {
  box.textContent = '';
  const head = h('div', { class: 'head' }, h('span', { class: 'word' }, d.word), d.phonetic ? h('span', { class: 'phon' }, `/${d.phonetic}/`) : null);
  const speak = iconButton('speaker', L('朗读', 'Read aloud'), () => {
    const u = new SpeechSynthesisUtterance(d.word);
    u.lang = 'en-US';
    speechSynthesis.speak(u);
  });
  head.append(speak);
  box.append(head);
  const chips: string[] = [...(d.tags ?? [])];
  if (d.collins) chips.push(L('柯林斯 ', 'Collins ') + '★'.repeat(d.collins));
  if (d.oxford) chips.push(L('牛津 3000', 'Oxford 3000'));
  if (chips.length) box.append(h('div', { class: 'chips' }, ...chips.map((c) => h('span', { class: 'chip' }, c))));
  box.append(h('ul', null, ...d.translations.slice(0, 6).map((t) => h('li', null, t))));
  if (d.forms && Object.keys(d.forms).length) {
    box.append(h('div', { class: 'forms' }, Object.entries(d.forms).map(([k, v]) => `${k} ${v}`).join(' · ')));
  }
  if (a.context) {
    const more = h('button', { class: 'more' }, L('在这句话里是什么意思？', 'What does it mean in this sentence?'));
    more.addEventListener('click', async () => {
      more.textContent = L('正在解释…', 'Explaining…');
      try {
        const r = await rpc('explain', { text: a.text, context: a.context, kind: 'word', targetLang });
        more.replaceWith(h('div', { class: 'explain' }, r.text));
      } catch (e) {
        more.textContent = L('解释失败：', 'Could not explain: ') + String((e as Error).message);
      }
    });
    box.append(more);
  }
}
