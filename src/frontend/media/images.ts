/**
 * 图片翻译：「抹掉原字，按原样写上译文」。
 *
 * 1. 后端 ocr:image（本地 PP-OCRv5，只识别不翻译）给出每行文字和四边形坐标；
 * 2. 前端把相邻的行合并成段落，再走普通翻译端口翻译（有上下文，综合模式先浅后深）；
 * 3. 读得到图片像素时（同源或允许跨域），用框外的背景色（左右渐变）抹掉原字，
 *    用原文的颜色和大致字重写译文，看起来就像图片本身是中文的；
 *    读不到像素时，退回到深色毛玻璃卡片。
 *
 * 译文画在浮在图片上方的覆盖层里，不改图片、不影响排版；覆盖层内部按原图像素坐标排版，
 * 图片缩放时整体缩放。识别时图上有一道扫描线，译文到达时逐字定格。
 */
import type { OcrBlock, OcrResult } from '../../shared/backend-v2';
import type { Stage, TranslateJob } from '../../shared/protocol';
import { rpc, uid } from '../../shared/rpc';
import { hostMatches, type UiSettings } from '../../shared/settings';
import type { TranslateClient } from '../content/port';
import { looksLikeTarget } from '../content/scanner';
import { h, pageZoom, type UiHost } from '../ui/host';
import { logoElement } from '../ui/logo';
import { estimateLength, revealText, startScramble, stopScramble } from '../ui/scramble';
import { mediaCaps } from './capabilities';
import { blobImageDataUrl, readImagePixels, rgb, sampleBox, type BoxColors, type Pixels } from './pixels';
import { L } from '../i18n';

const MIN_W = 140;
const MIN_H = 60;
const AUTO_MIN_W = 220;
const AUTO_MIN_H = 100;
const AUTO_LIMIT = 30;
const BUTTON_HEIGHT = 28;
const BUTTON_INSET = 8;
const TOP_RIGHT = { x: 1, y: 0 };
type ButtonPoint = typeof TOP_RIGHT;

/** 按钮在图内可见区域的相对位置；网页缩放或图片改宽时仍贴着原来的部位。 */
function buttonFrame(img: HTMLImageElement) {
  const r = img.getBoundingClientRect();
  const left = Math.max(0, r.left) + BUTTON_INSET;
  const top = Math.max(0, r.top) + BUTTON_INSET;
  return {
    left, top,
    width: Math.min(innerWidth, r.right) - BUTTON_INSET - left,
    height: Math.min(innerHeight, r.bottom) - BUTTON_INSET - top,
  };
}

type Status = 'loading' | 'shown' | 'hidden' | 'error';

interface OLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  h: number;
  angle: number;
  text: string;
}

interface OPara {
  lines: OLine[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  lineH: number;
  pitch: number;
  align: 'left' | 'center';
  text: string;
  colors?: BoxColors;
  el?: HTMLDivElement;
  patches: HTMLDivElement[];
  stage: 'pending' | Stage | 'error';
}

interface ImgState {
  status: Status;
  sourceUrl: string;
  inputAbort?: AbortController;
  result?: OcrResult;
  host?: HTMLElement;
  stage?: HTMLDivElement;
  paras?: OPara[];
  jobId?: string;
  requestId?: string;
  error?: string;
  /** 已经出最终结果（或失败）的段数。 */
  done?: number;
}

const BTN_CSS = `
.img-btn {
  position: absolute; height: ${BUTTON_HEIGHT}px; min-width: 28px; padding: 0 7px; border-radius: 9px; display: inline-flex; align-items: center; gap: 5px;
  background: color-mix(in srgb, var(--surface) 86%, transparent); color: var(--ink); --logo-accent: var(--accent);
  border: 1px solid var(--line); box-shadow: var(--shadow); backdrop-filter: blur(10px) saturate(1.4); -webkit-backdrop-filter: blur(10px) saturate(1.4);
  font-size: 12px; font-weight: 600; line-height: 1; white-space: nowrap; opacity: 0; pointer-events: none;
  /* 在右边向左展开，在左边向右展开，拖动后的按钮和文字始终留在图内。 */
  transform: translateX(var(--anchor-x, -100%)); transition: opacity .15s;
  cursor: grab; user-select: none; touch-action: none;
}
.img-btn svg { flex: none; }
.img-btn .lbl { display: none; overflow: hidden; text-overflow: ellipsis; }
.img-btn:hover .lbl, .img-btn.dragging .lbl { display: inline; }
.img-btn.on { opacity: .94; pointer-events: auto; }
.img-btn.dragging { cursor: grabbing; }
.img-btn:hover { opacity: 1; }
.img-btn[data-state="shown"] { background: var(--accent); color: var(--accent-ink); --logo-accent: color-mix(in srgb, var(--accent-ink) 65%, transparent); border-color: transparent; }
.img-btn:is([data-state="loading"], [data-state="translating"]) .logo { animation: tx-breathe 1s ease-in-out infinite; }
.img-btn:is([data-state="loading"], [data-state="translating"]) .lbl { display: inline; font-variant-numeric: tabular-nums; }
.img-btn[data-state="error"] { color: var(--danger); }
@keyframes tx-breathe { 50% { opacity: .35; } }
`;

const OVERLAY_CSS = `
:host { all: initial; position: absolute; z-index: 2147483646; pointer-events: none; overflow: hidden; contain: layout paint; }
.stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; transition: opacity .2s; }
:host([data-peek]) .stage { opacity: 0; }
.scan { position: absolute; inset: 0; overflow: hidden; }
.scan::before { content: ""; position: absolute; left: 0; right: 0; height: 28%; top: -28%;
  background: linear-gradient(to bottom, transparent, rgba(150, 163, 217, .16) 70%, rgba(150, 163, 217, .55) 98%, transparent);
  animation: tx-scan 1.6s cubic-bezier(.45, 0, .55, 1) infinite; }
.scan::after { content: ""; position: absolute; inset: 0; box-shadow: inset 0 0 0 2px rgba(150, 163, 217, .35); border-radius: inherit; }
@keyframes tx-scan { to { top: 100%; } }
.patch { position: absolute; border-radius: 3px; opacity: 0; transition: opacity .25s; }
.p { position: absolute; display: flex; flex-direction: column; justify-content: safe center; box-sizing: border-box; overflow: visible;
  font-family: -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  letter-spacing: .01em; overflow-wrap: anywhere; opacity: 0; transition: opacity .25s; }
.p.left { text-align: left; }
.p.center { text-align: center; }
.on .patch, .on .p { opacity: 1; }
.p[data-stage="pending"] .tx-scr { opacity: .4; }
.p[data-stage="fast"] { opacity: .72; }
.glass { background: rgba(16, 18, 24, .66); backdrop-filter: blur(14px) saturate(1.3); -webkit-backdrop-filter: blur(14px) saturate(1.3);
  color: #fff; border-radius: .32em; padding: .12em .32em; box-shadow: 0 2px 10px rgba(0, 0, 0, .18); }
`;

/* ------------------------------------------------------------------ */

function toLine(b: OcrBlock): OLine {
  const xs = b.box.map((p) => p[0]);
  const ys = b.box.map((p) => p[1]);
  const [p0, p1, , p3] = b.box;
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
    h: Math.hypot(p3[0] - p0[0], p3[1] - p0[1]),
    angle: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]),
    text: b.text.trim(),
  };
}

/** 很短、看起来像标签的一行：英文 ≤ 2 个词且不到 16 个字母，或中日韩不到 6 个字，并且不以连字符 / 逗号结尾（那是被折行的正文）。 */
function isShortLabel(text: string): boolean {
  const t = text.trim();
  if (/[-,，、]$/.test(t)) return false;
  const cjk = (t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  if (cjk) return cjk < 6;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length <= 2 && t.replace(/[^\p{L}]/gu, '').length < 16;
}

/** 相邻、字高相近、水平对齐的行合并成段落。 */
function groupLines(blocks: OcrBlock[]): OPara[] {
  const lines = blocks.map(toLine).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const paras: OPara[] = [];
  for (const l of lines) {
    let p: OPara | undefined;
    for (let i = paras.length - 1; i >= 0 && i >= paras.length - 6; i--) {
      const q = paras[i];
      const last = q.lines[q.lines.length - 1];
      const gap = l.y0 - last.y1;
      const overlap = Math.min(l.x1, q.x1) - Math.max(l.x0, q.x0);
      const centered = Math.abs((l.x0 + l.x1) / 2 - (q.x0 + q.x1) / 2) < l.h;
      // 地图、图表上的独立短标签（地名、年份、图例）不拼成一段：两行都很短时不合并
      if (isShortLabel(last.text) && isShortLabel(l.text)) continue;
      if (
        Math.abs(l.h - q.lineH) < 0.35 * q.lineH && gap > -0.3 * l.h && gap < 0.9 * l.h &&
        Math.abs(l.angle - last.angle) < 0.05 &&
        (overlap > 0.5 * Math.min(l.x1 - l.x0, q.x1 - q.x0) || Math.abs(l.x0 - q.x0) < l.h || centered)
      ) {
        p = q;
        break;
      }
    }
    if (p) {
      const prev = p.lines[p.lines.length - 1];
      p.pitch = p.lines.length === 1 ? l.y0 - prev.y0 : (p.pitch * (p.lines.length - 1) + (l.y0 - prev.y0)) / p.lines.length;
      p.lines.push(l);
      p.x0 = Math.min(p.x0, l.x0);
      p.x1 = Math.max(p.x1, l.x1);
      p.y1 = Math.max(p.y1, l.y1);
      const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(p.text) && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(l.text);
      p.text = /[a-z]-$/.test(p.text) ? p.text.slice(0, -1) + l.text : p.text + (cjk ? '' : ' ') + l.text;
    } else {
      paras.push({ lines: [l], x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, lineH: l.h, pitch: l.h * 1.25, align: 'left', text: l.text, patches: [], stage: 'pending' });
    }
  }
  for (const p of paras) {
    const cs = p.lines.map((l) => (l.x0 + l.x1) / 2);
    const lefts = p.lines.map((l) => l.x0);
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    p.align = p.lines.length > 1 && spread(cs) < p.lineH * 0.6 && spread(lefts) > p.lineH ? 'center' : p.lines.length === 1 ? 'center' : 'left';
    p.lineH = p.lines.reduce((n, l) => n + l.h, 0) / p.lines.length;
  }
  return paras;
}

/* ------------------------------------------------------------------ */

export class ImageTranslator {
  private states = new WeakMap<HTMLImageElement, ImgState>();
  private live = new Set<HTMLImageElement>();
  private visible = new Set<HTMLImageElement>();
  private btn: HTMLButtonElement;
  private lbl: HTMLSpanElement;
  private hoverImg: HTMLImageElement | null = null;
  private buttonPos = TOP_RIGHT;
  private savedPositions = new WeakMap<HTMLImageElement, ButtonPoint>();
  private dragging = false;
  private suppressPointerClick = false;
  private hideTimer = 0;
  private raf = 0;
  private ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const img = entry.target as HTMLImageElement;
      if (!img.isConnected && this.live.has(img)) this.remove(img);
    }
    this.schedule();
  });
  private visibility = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const img = entry.target as HTMLImageElement;
      const host = this.states.get(img)?.host;
      if (!host) continue;
      if (!img.isConnected) { this.remove(img); continue; }
      if (entry.isIntersecting) this.visible.add(img);
      else {
        this.visible.delete(img);
        host.style.display = 'none';
      }
    }
    this.schedule();
  });
  private cleanupTimer = 0;
  private removals = new MutationObserver(records => {
    if (this.cleanupTimer || !records.some(record => record.removedNodes.length)) return;
    // display:none 的图片在真正卸载时可能没有新的尺寸/相交事件。只核对已挂覆盖层的图片。
    this.cleanupTimer = window.setTimeout(() => {
      this.cleanupTimer = 0;
      for (const img of this.live) if (!img.isConnected) this.remove(img);
    }, 100);
  });
  private io: IntersectionObserver | null = null;
  private queue: { img: HTMLImageElement; st: ImgState }[] = [];
  private running = 0;
  private autoCount = 0;
  private enabled = false;
  private canCancel = false;

  constructor(private ui: UiHost, private client: TranslateClient, private settings: UiSettings) {
    ui.addStyle(BTN_CSS);
    this.lbl = h('span', { class: 'lbl' }, L('翻译图片', 'Translate image'));
    this.btn = h('button', { type: 'button', class: 'img-btn', 'aria-label': L('翻译图片中的文字', 'Translate the text in this image') }, logoElement({ size: 16 }), this.lbl);
    this.bindButtonDrag();
    this.btn.addEventListener('mousedown', (e) => e.preventDefault());
    this.btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.detail > 0 && this.suppressPointerClick) return;
      if (this.hoverImg) void this.toggle(this.hoverImg);
    });
    // 鼠标停在按钮上时临时看原图
    this.btn.addEventListener('mouseenter', () => {
      clearTimeout(this.hideTimer);
      this.peek(true);
    });
    this.btn.addEventListener('mouseleave', () => {
      this.peek(false);
      this.hideButtonSoon();
    });
    ui.layer.appendChild(this.btn);
    void mediaCaps().then((c) => {
      this.enabled = c.ocr;
      this.canCancel = !!c.cancel;
      if (!c.ocr) return;
      document.addEventListener('mouseover', this.onOver, true);
      document.addEventListener('load', this.onImageSourceChange, true);
      document.addEventListener('error', this.onImageSourceChange, true);
      document.addEventListener('scroll', this.schedule, { capture: true, passive: true });
      window.addEventListener('resize', this.schedule);
    });
  }

  apply(s: UiSettings): void {
    this.settings = s;
    if (!s.imageButton) this.btn.classList.remove('on');
  }

  /** 整页翻译开 / 关时调用。 */
  setAuto(on: boolean): void {
    if (on && this.enabled && this.settings.imageTranslate) {
      this.io ??= new IntersectionObserver((es) => {
        for (const e of es) {
          if (!e.isIntersecting) continue;
          const img = e.target as HTMLImageElement;
          this.io?.unobserve(img);
          if (this.autoCount < AUTO_LIMIT && !this.states.has(img) && this.bigEnough(img, AUTO_MIN_W, AUTO_MIN_H)) {
            this.autoCount++;
            this.enqueue(img);
          }
        }
      }, { rootMargin: '200px 0px' });
      document.querySelectorAll('img').forEach((img) => this.io!.observe(img));
    } else if (!on) {
      this.io?.disconnect();
      this.io = null;
      this.queue = [];
      this.autoCount = 0;
      for (const img of [...this.live]) this.remove(img);
    }
  }

  /** 右键菜单「翻译这张图片」。 */
  translateBySrc(srcUrl: string): void {
    if (!this.enabled) return;
    const img = [...document.images].find((i) => i.currentSrc === srcUrl || i.src === srcUrl);
    if (!img) return;
    const st = this.states.get(img);
    if (st && st.status !== 'error') return void this.toggle(img);
    this.enqueue(img, true);
  }

  private onImageSourceChange = (event: Event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    const st = this.states.get(img);
    if (!st || st.sourceUrl === (img.currentSrc || img.src)) return;
    // 虚拟画廊可能反复给同一个 img 换地址。图变了必须释放上一张的覆盖层和在途请求。
    this.remove(img);
    if (this.hoverImg === img) this.placeButton();
    if (this.autoCount < AUTO_LIMIT) this.io?.observe(img);
  };

  /* ---------------- 按钮 ---------------- */

  private bigEnough(img: HTMLImageElement, w: number, hgt: number): boolean {
    const r = img.getBoundingClientRect();
    return r.width >= w && r.height >= hgt && (img.naturalWidth || 0) >= 80 && (img.naturalHeight || 0) >= 40;
  }

  private onOver = (e: MouseEvent) => {
    if (!this.settings.imageButton || this.dragging || this.ui.contains(e)) return;
    const t = e.target as Element | null;
    const img = t instanceof HTMLImageElement ? t : null;
    if (!img) {
      if (this.hoverImg && !(t && this.covers(t, this.hoverImg))) this.hideButtonSoon();
      return;
    }
    if (!img.complete || !this.bigEnough(img, MIN_W, MIN_H)) return this.hideButtonSoon();
    clearTimeout(this.hideTimer);
    if (this.hoverImg !== img) {
      if (this.hoverImg && !this.live.has(this.hoverImg)) this.ro.unobserve(this.hoverImg);
      this.buttonPos = this.savedPositions.get(img) ?? this.freeCorner(img);
      this.ro.observe(img);
    }
    this.hoverImg = img;
    this.placeButton();
    this.btn.classList.add('on');
  };

  private covers(el: Element, img: HTMLImageElement): boolean {
    const a = el.getBoundingClientRect();
    const b = img.getBoundingClientRect();
    return a.left <= b.left + 2 && a.top <= b.top + 2 && a.right >= b.right - 2 && a.bottom >= b.bottom - 2 && a.width * a.height < b.width * b.height * 4;
  }

  private hideButtonSoon() {
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (this.dragging) return;
      this.btn.classList.remove('on');
      if (this.hoverImg && !this.live.has(this.hoverImg)) this.ro.unobserve(this.hoverImg);
      this.hoverImg = null;
    }, 500);
  }

  private freeCorner(img: HTMLImageElement): ButtonPoint {
    const f = buttonFrame(img);
    // 只在刚进入图片时检查几个落点。图片上网站自己的下载 / 放大按钮常在右上角。
    for (const corner of [TOP_RIGHT, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]) {
      const left = f.left + (f.width - 32) * corner.x;
      const top = f.top + (f.height - BUTTON_HEIGHT) * corner.y;
      const isImageAt = (dx: number, dy: number) => document.elementsFromPoint(left + dx, top + dy)
        .find((el) => el !== this.ui.host && el.localName !== 'tx-ocr') === img;
      if (isImageAt(16, 14) && isImageAt(2, 2) && isImageAt(30, 2) && isImageAt(2, 26) && isImageAt(30, 26)) return corner;
    }
    return TOP_RIGHT;
  }

  private bindButtonDrag() {
    let gesture: { id: number; img: HTMLImageElement; x: number; y: number; grabX: number; grabY: number; moved: boolean; initial: ButtonPoint } | null = null;
    this.btn.addEventListener('pointerdown', (e) => {
      if (!this.hoverImg || !e.isPrimary || e.button !== 0) return;
      clearTimeout(this.hideTimer);
      this.suppressPointerClick = false;
      const b = this.btn.getBoundingClientRect();
      gesture = { id: e.pointerId, img: this.hoverImg, x: e.clientX, y: e.clientY, grabX: e.clientX - b.left, grabY: e.clientY - b.top, moved: false, initial: this.buttonPos };
      this.dragging = true;
      this.btn.setPointerCapture(e.pointerId);
    });
    this.btn.addEventListener('pointermove', (e) => {
      if (!gesture || e.pointerId !== gesture.id) return;
      if (!gesture.moved && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) < 4) return;
      gesture.moved = true;
      this.btn.classList.add('dragging');
      const frame = buttonFrame(gesture.img);
      const clamp = (value: number, travel: number) => Math.max(0, Math.min(1, value / Math.max(1, travel)));
      this.buttonPos = {
        x: clamp(e.clientX - gesture.grabX - frame.left, frame.width - this.btn.offsetWidth),
        y: clamp(e.clientY - gesture.grabY - frame.top, frame.height - BUTTON_HEIGHT),
      };
      this.positionButton(frame);
    });
    const finish = (e: PointerEvent) => {
      if (!gesture || e.pointerId !== gesture.id) return;
      this.dragging = false;
      this.btn.classList.remove('dragging');
      this.suppressPointerClick = gesture.moved;
      if (gesture.moved && e.type === 'pointerup') this.savedPositions.set(gesture.img, this.buttonPos);
      else this.buttonPos = gesture.initial;
      gesture = null;
      this.placeButton();
      if (!this.btn.matches(':hover') && !this.hoverImg?.matches(':hover')) this.hideButtonSoon();
    };
    this.btn.addEventListener('pointerup', finish);
    this.btn.addEventListener('pointercancel', finish);
    this.btn.addEventListener('lostpointercapture', finish);
  }

  private placeButton() {
    const img = this.hoverImg;
    if (!img) return;
    const st = this.states.get(img);
    const total = st?.paras?.length ?? 0;
    const translating = st?.status === 'shown' && total > 0 && (st.done ?? 0) < total;
    this.btn.dataset.state = translating ? 'translating' : st?.status ?? 'idle';
    // 分阶段显示：识别文字 → 翻译 k/n → 完成（识别完不等于翻译完）
    this.lbl.textContent =
      st?.status === 'loading' ? L('识别文字…', 'Reading text…')
      : translating ? L(`翻译 ${st!.done ?? 0}/${total}`, `Translating ${st!.done ?? 0}/${total}`)
      : st?.status === 'shown' ? L('看原图', 'Show original')
      : st?.status === 'hidden' ? L('看译图', 'Show translated')
      : st?.status === 'error' ? L('重试', 'Retry')
      : L('翻译图片', 'Translate image');
    this.btn.title = st?.status === 'error' ? L(`识别失败：${st.error ?? ''}`, `Recognition failed: ${st.error ?? ''}`) : st?.status === 'shown' ? L('悬停看原图，点击切换，拖动移位', 'Hover to peek, click to switch, drag to move') : L('拖动可调整按钮位置', 'Drag to move the button');
    this.positionButton(buttonFrame(img));
  }

  private positionButton(frame: ReturnType<typeof buttonFrame>) {
    this.btn.style.visibility = frame.width < 32 || frame.height < BUTTON_HEIGHT ? 'hidden' : '';
    // 以界面层左上角为原点（网页滚动、html 有边距或 zoom 时都对得上）
    this.ui.fixZoom();
    const o = this.ui.origin();
    const { x, y } = this.buttonPos;
    this.btn.style.maxWidth = `${Math.max(0, frame.width)}px`;
    this.btn.style.setProperty('--anchor-x', `${-100 * x}%`);
    this.btn.style.left = `${Math.round(frame.left + frame.width * x - o.x)}px`;
    this.btn.style.top = `${Math.round(frame.top + (frame.height - BUTTON_HEIGHT) * y - o.y)}px`;
  }

  private peek(on: boolean) {
    const st = this.hoverImg && this.states.get(this.hoverImg);
    if (st?.status === 'shown') st.host?.toggleAttribute('data-peek', on);
  }

  private async toggle(img: HTMLImageElement) {
    const st = this.states.get(img);
    if (!st || st.status === 'error') return this.enqueue(img, true);
    if (st.status === 'loading') { this.remove(img); this.placeButton(); return; }
    st.host?.removeAttribute('data-peek');
    if (st.status === 'shown') {
      st.status = 'hidden';
      if (st.host) st.host.style.display = 'none';
    } else if (st.status === 'hidden') {
      st.status = 'shown';
      if (st.host) st.host.style.display = '';
      this.schedule();
    }
    this.placeButton();
  }

  /* ---------------- 识别与翻译 ---------------- */

  private enqueue(img: HTMLImageElement, front = false) {
    this.remove(img);
    const st: ImgState = { status: 'loading', sourceUrl: img.currentSrc || img.src };
    this.states.set(img, st);
    this.mountHost(img, st);
    st.host!.shadowRoot!.append(h('div', { class: 'scan' }));
    if (img === this.hoverImg) this.placeButton();
    if (front) this.queue.unshift({ img, st });
    else this.queue.push({ img, st });
    this.pump();
  }

  private pump() {
    while (this.running < 2 && this.queue.length) {
      const { img, st } = this.queue.shift()!;
      if (!this.current(img, st)) continue;
      this.running++;
      void this.recognize(img, st).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async source(img: HTMLImageElement, signal: AbortSignal): Promise<{ url: string } | { dataUrl: string } | null> {
    const src = img.currentSrc || img.src;
    if (/^https?:/i.test(src)) return { url: src };
    if (/^data:image\//i.test(src)) return { dataUrl: src };
    if (/^blob:/i.test(src)) return {dataUrl: await blobImageDataUrl(img, src, signal)};
    return null;
  }

  private current(img: HTMLImageElement, st: ImgState): boolean {
    return img.isConnected && this.states.get(img) === st && st.sourceUrl === (img.currentSrc || img.src);
  }

  private fail(img: HTMLImageElement, st: ImgState, msg: string) {
    if (!this.current(img, st)) return;
    st.status = 'error';
    st.error = msg;
    st.host?.remove();
    st.host = undefined;
    this.untrack(img);
    if (img === this.hoverImg) this.placeButton();
  }

  private async recognize(img: HTMLImageElement, st: ImgState) {
    const inputAbort = st.inputAbort = new AbortController();
    try {
      const src = await this.source(img, inputAbort.signal);
      if (!this.current(img, st)) return;
      if (!src) throw new Error(L('不支持这种图片地址', 'This image address is not supported'));
      st.requestId = this.canCancel ? uid('ocr') : undefined;
      const [r, pixels] = await Promise.all([
        rpc('ocr:image', { ...src, translate: false, requestId: st.requestId, noCache: hostMatches(location.hostname, this.settings.sensitive) || undefined }),
        readImagePixels(img, img.naturalWidth, img.naturalHeight, inputAbort.signal),
      ]);
      if (!this.current(img, st)) return;
      st.requestId = undefined;
      st.result = r;
      const target = this.settings.targetLang;
      const lines = r.blocks.filter((b) => b.confidence >= 0.5 && /\p{L}/u.test(b.text) && !looksLikeTarget(b.text, target));
      const paras = groupLines(lines).filter((p) => !looksLikeTarget(p.text, target));
      if (!paras.length) return this.fail(img, st, L('没有识别到需要翻译的文字', 'No text to translate was found'));
      // 像素坐标按 OCR 返回的原图尺寸换算
      const px: Pixels | null = pixels && { ...pixels, scale: pixels.width / r.width };
      for (const p of paras) if (px) p.colors = sampleBox(px, p.x0, p.y0, p.x1, p.y1);
      st.paras = paras;
      this.buildStage(img, st);
    } catch (e) {
      return this.fail(img, st, String((e as Error).message ?? e));
    } finally { st.inputAbort = undefined; }
    st.status = 'shown';
    if (img === this.hoverImg) this.placeButton();

    // 段落走普通翻译端口：有上下文，综合模式先浅后深
    const jobId = uid('img');
    st.jobId = jobId;
    const job: TranslateJob = {
      jobId,
      sourceLang: this.settings.sourceLang || 'auto',
      targetLang: this.settings.targetLang,
      mode: this.settings.mode,
      priority: 0,
      context: { url: location.href, title: document.title, summary: st.paras!.map((p) => p.text).join(' ').slice(0, 300) },
      segments: st.paras!.map((p, i) => ({ id: String(i), text: p.text, kind: 'ocr' as const })),
      noCache: hostMatches(location.hostname, this.settings.sensitive) || undefined,
    };
    this.client.send(job, {
      onResult: (id, text, stage) => {
        if (this.current(img, st)) this.fill(img, Number(id), text.replace(/<\/?[gx]\d+\/?>/g, ''), stage);
      },
      onError: (id, stage) => {
        if (this.current(img, st) && (stage === 'final' || job.mode !== 'combined')) this.drop(img, Number(id));
      },
    });
  }

  private mountHost(img: HTMLImageElement, st: ImgState) {
    const host = document.createElement('tx-ocr');
    host.setAttribute('translate', 'no');
    host.setAttribute('lang', this.settings.targetLang);
    const root = host.attachShadow({ mode: 'open' });
    root.append(h('style', null, OVERLAY_CSS));
    document.documentElement.appendChild(host);
    st.host = host;
    if (!this.live.size) this.removals.observe(document, {childList:true, subtree:true});
    this.live.add(img);
    this.visible.add(img); // 初次立即定位，之后由浏览器维护可见列表。
    this.visibility.observe(img);
    this.ro.observe(img);
    this.position([img]);
  }

  /** 在原图像素坐标里摆好每段的抹除块和译文框（先显示跳动字符）。 */
  private buildStage(img: HTMLImageElement, st: ImgState) {
    const r = st.result!;
    const root = st.host!.shadowRoot!;
    root.querySelector('.scan')?.remove();
    const stage = h('div', { class: 'stage' });
    stage.style.width = `${r.width}px`;
    stage.style.height = `${r.height}px`;
    for (const p of st.paras!) {
      const c = p.colors;
      if (c) {
        for (const l of p.lines) {
          const f = l.h * 0.16; // 羽化宽度
          const patch = h('div', { class: 'patch' });
          Object.assign(patch.style, {
            left: `${l.x0 - f * 0.5}px`,
            top: `${l.y0 - f * 0.4}px`,
            width: `${l.x1 - l.x0 + f}px`,
            height: `${l.y1 - l.y0 + f * 0.8}px`,
            background: `linear-gradient(90deg, ${rgb(c.bgL)}, ${rgb(c.bgR)})`,
            boxShadow: `0 0 ${f}px ${f * 0.6}px ${rgb(c.bg)}`,
            transform: Math.abs(l.angle) > 0.04 ? `rotate(${l.angle}rad)` : '',
          });
          stage.append(patch);
          p.patches.push(patch);
        }
      }
      const el = h('div', { class: `p ${p.align}${c ? '' : ' glass'}`, 'data-stage': 'pending' }) as HTMLDivElement;
      const pad = c ? 0 : p.lineH * 0.18;
      Object.assign(el.style, {
        left: `${p.x0 - pad}px`,
        top: `${p.y0 - pad}px`,
        width: `${p.x1 - p.x0 + pad * 2}px`,
        height: `${p.y1 - p.y0 + pad * 2}px`,
        color: c ? rgb(c.fg) : '',
        fontWeight: c ? (c.ink > 0.3 ? '700' : c.ink > 0.2 ? '600' : '500') : '500',
      });
      const angle = p.lines[0].angle;
      if (Math.abs(angle) > 0.04) el.style.transform = `rotate(${angle}rad)`;
      stage.append(el);
      p.el = el;
      el.style.fontSize = `${p.lineH * 0.78}px`;
      startScramble(el, estimateLength(p.text.length, this.settings.targetLang, 60), this.settings.targetLang);
    }
    root.append(stage);
    st.stage = stage;
    requestAnimationFrame(() => stage.classList.add('on'));
    if (this.visible.has(img)) this.position([img]);
  }

  private fill(img: HTMLImageElement, i: number, text: string, stage: Stage) {
    const st = this.states.get(img);
    const p = st?.paras?.[i];
    if (!p?.el || (p.stage === 'final' && stage === 'fast')) return;
    const first = p.stage === 'pending' || (p.stage === 'fast' && stage === 'final');
    const counts = stage === 'final' || this.settings.mode !== 'combined';
    stopScramble(p.el);
    p.el.textContent = text;
    p.el.dataset.stage = stage;
    if (first && counts && st) st.done = (st.done ?? 0) + 1;
    p.stage = stage;
    fitPara(p);
    revealText(p.el, this.settings.targetLang, 200);
    if (img === this.hoverImg) this.placeButton();
  }

  /** 这一段翻译失败：去掉抹除块和译文框，露出原图。 */
  private drop(img: HTMLImageElement, i: number) {
    const p = this.states.get(img)?.paras?.[i];
    if (!p || p.stage === 'fast' || p.stage === 'error') return;
    const st = this.states.get(img);
    if (st && p.stage !== 'final') st.done = (st.done ?? 0) + 1;
    p.stage = 'error';
    if (p.el) stopScramble(p.el);
    p.el?.remove();
    p.patches.forEach((x) => x.remove());
  }

  private remove(img: HTMLImageElement) {
    const st = this.states.get(img);
    // 先使旧代际失效，取消 RPC 的回包即使随后到达也不能复活图片。
    this.states.delete(img);
    st?.inputAbort?.abort();
    this.queue = this.queue.filter((q) => q.img !== img);
    if (st?.jobId) this.client.cancel(st.jobId);
    if (st?.requestId && this.canCancel) void rpc('media:cancel', { requestId: st.requestId }).catch(() => {});
    st?.paras?.forEach((p) => p.el && stopScramble(p.el));
    st?.host?.remove();
    this.untrack(img);
  }

  private untrack(img: HTMLImageElement) {
    this.live.delete(img);
    this.visible.delete(img);
    this.visibility.unobserve(img);
    if (!img.isConnected && this.hoverImg === img) {
      this.btn.classList.remove('on');
      this.hoverImg = null;
    }
    if (img !== this.hoverImg) this.ro.unobserve(img);
    if (!this.live.size) {
      this.removals.disconnect();
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = 0;
    }
  }

  private schedule = () => {
    if (this.raf || (!this.visible.size && !this.hoverImg)) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.visible.size) this.position(this.visible);
      if (this.hoverImg) this.placeButton();
    });
  };

  /** 覆盖层对齐图片；内部舞台按原图像素排版，这里只换算缩放（考虑 object-fit）。 */
  private position(images: Iterable<HTMLImageElement>) {
    // 内部滚动列表里的所有覆盖层都会移动。先读完可见图片，再统一写位置、测量和校正。
    // 若对每张图交错写宿主样式和读边界，浏览器会为每张图强制布局。
    const z = pageZoom();
    const zoom = z !== 1 ? String(1 / z) : '';
    const scrollX = window.scrollX, scrollY = window.scrollY;
    const measured = [];
    const hidden: HTMLElement[] = [];
    for (const img of images) {
      const st = this.states.get(img);
      if (!st?.host) continue;
      if (!img.isConnected) { this.remove(img); continue; }
      if (st.status === 'hidden') continue;
      const rect = img.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) { hidden.push(st.host); continue; }
      const style = getComputedStyle(img);
      measured.push({ st, host: st.host, rect, radius: style.borderRadius, fit: style.objectFit });
    }
    for (const host of hidden) host.style.display = 'none';
    for (const { st, host, rect, radius, fit } of measured) {
      host.style.display = '';
      if (host.style.zoom !== zoom) host.style.zoom = zoom;
      Object.assign(host.style, {
        left: `${rect.left + scrollX + Number(host.dataset.dx || 0)}px`,
        top: `${rect.top + scrollY + Number(host.dataset.dy || 0)}px`,
        width: `${rect.width}px`, height: `${rect.height}px`, borderRadius: radius,
      });
      if (st.stage && st.result) {
        const box = contentBox(fit, rect, st.result.width, st.result.height);
        st.stage.style.transform = `translate(${box.x}px, ${box.y}px) scale(${box.w / st.result.width}, ${box.h / st.result.height})`;
      }
    }
    const corrections = [];
    for (const { host, rect } of measured) {
      const hr = host.getBoundingClientRect();
      if (Math.abs(hr.left - rect.left) > 0.5 || Math.abs(hr.top - rect.top) > 0.5) {
        corrections.push({ host, rect, dx: Number(host.dataset.dx || 0) + rect.left - hr.left, dy: Number(host.dataset.dy || 0) + rect.top - hr.top });
      }
    }
    for (const { host, rect, dx, dy } of corrections) {
      host.dataset.dx = String(dx);
      host.dataset.dy = String(dy);
      host.style.left = `${rect.left + scrollX + dx}px`;
      host.style.top = `${rect.top + scrollY + dy}px`;
    }
  }
}

/** 图片内容在元素里的实际位置（object-fit: contain / cover / none 时和元素框不一样）。 */
function contentBox(fitMode: string, r: DOMRect, nw: number, nh: number) {
  let w = r.width;
  let hh = r.height;
  if (fitMode === 'contain' || fitMode === 'scale-down' || fitMode === 'cover' || fitMode === 'none') {
    const s =
      fitMode === 'cover' ? Math.max(r.width / nw, r.height / nh)
      : fitMode === 'none' ? 1
      : Math.min(r.width / nw, r.height / nh, fitMode === 'scale-down' ? 1 : Infinity);
    w = nw * s;
    hh = nh * s;
  }
  return { x: (r.width - w) / 2, y: (r.height - hh) / 2, w, h: hh };
}

/** 在原图像素坐标里排字：从接近原字高的字号开始缩小，直到放进段落框；多行时行距跟原文一致。 */
function fitPara(p: OPara) {
  const el = p.el!;
  const boxH = p.y1 - p.y0;
  const multi = p.lines.length > 1;
  let fs = Math.max(6, p.lineH * 0.8);
  const lh = multi ? Math.max(1.1, Math.min(1.7, p.pitch / fs)) : 1.15;
  el.style.lineHeight = String(lh);
  el.style.fontSize = `${fs}px`;
  for (let i = 0; i < 14 && fs > p.lineH * 0.32 && (el.scrollHeight > boxH * 1.08 + 1 || el.scrollWidth > el.clientWidth + 1); i++) {
    fs *= 0.92;
    el.style.fontSize = `${fs}px`;
  }
}
