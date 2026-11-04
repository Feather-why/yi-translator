/**
 * 所有界面（悬浮球、划词圆点、小窗）都放在同一个 Shadow DOM 里，和页面样式互不影响。
 * 注意：内容脚本里 customElements 不可用，这里只用未注册的 tx-ui 标签 + attachShadow。
 */

export const UI_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

import { accentCss, LAYER_THEME_CSS } from '../theme';

const BASE_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
${LAYER_THEME_CSS}
.layer {
  font: 13px/1.5 ${UI_FONT};
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.icon-btn {
  width: 26px; height: 26px; border-radius: 7px; display: inline-grid; place-items: center; color: var(--muted);
}
.icon-btn:hover { background: var(--hover); color: var(--ink); }
.icon-btn[aria-pressed="true"] { color: var(--accent); }
.icon-btn svg { width: 15px; height: 15px; }
`;

export class UiHost {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  /** 所有界面元素都放在这里。 */
  readonly layer: HTMLDivElement;

  constructor() {
    this.host = document.createElement('tx-ui');
    this.host.setAttribute('translate', 'no');
    this.host.style.cssText =
      'all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;display:block;';
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = BASE_CSS;
    this.root.appendChild(style);
    this.layer = document.createElement('div');
    this.layer.className = 'layer';
    this.root.appendChild(this.layer);
    this.attach();
    // 有些单页应用会整体替换 <body>，我们挂在 <html> 下，并在被移除时挂回去
    new MutationObserver(() => {
      if (!this.host.isConnected) this.attach();
    }).observe(document.documentElement, { childList: true });
    this.watchTheme();
  }

  /* ---------------- 深浅色：跟随网页背景，而不只是系统设置 ---------------- */

  private themePref: 'auto' | 'light' | 'dark' = 'auto';
  private themeTimer = 0;

  setThemePreference(pref: 'auto' | 'light' | 'dark'): void {
    this.themePref = pref;
    this.refreshTheme();
  }

  /** 重新判断一次（小窗打开前也会调用，网页切了深浅色马上跟上）。 */
  refreshTheme(): void {
    const t = this.themePref === 'auto' ? detectPageTheme() : this.themePref;
    if (t) this.layer.dataset.theme = t;
    else delete this.layer.dataset.theme;
  }

  private watchTheme() {
    const later = () => {
      clearTimeout(this.themeTimer);
      this.themeTimer = window.setTimeout(() => this.refreshTheme(), 150);
    };
    this.refreshTheme();
    // 网页常用 html/body 上的 class、data-theme、style 切换深浅色
    const mo = new MutationObserver(later);
    const opts = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-mode', 'theme', 'dark'] };
    mo.observe(document.documentElement, opts);
    if (document.body) mo.observe(document.body, opts);
    else document.addEventListener('DOMContentLoaded', () => document.body && mo.observe(document.body, opts), { once: true });
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', later);
    // 单页应用加载完、图片和样式表到齐以后再看一次
    window.setTimeout(later, 1200);
    window.addEventListener('load', later, { once: true });
  }

  private accentStyle: HTMLStyleElement | null = null;
  /** 个性化主题色：覆盖 .layer 上的主色变量（高对比度模式下不覆盖，交给系统颜色）。 */
  setAccent(accent: string | undefined): void {
    if (!this.accentStyle) {
      this.accentStyle = document.createElement('style');
      this.root.insertBefore(this.accentStyle, this.layer);
    }
    this.accentStyle.textContent = `@media not (forced-colors: active) { ${accentCss(accent, '.layer', '.layer[data-theme="dark"]')} }`;
  }

  addStyle(css: string): void {
    const s = document.createElement('style');
    s.textContent = css;
    this.root.insertBefore(s, this.layer);
  }

  /** 事件是否发生在我们的界面里。 */
  contains(e: Event): boolean {
    return e.composedPath().includes(this.host);
  }

  private attach() {
    document.documentElement.appendChild(this.host);
    this.fixZoom();
  }

  /**
   * 有的网站给 <html> 设了 CSS zoom（整页放大 / 缩小）。我们的界面挂在 <html> 下会跟着被缩放，
   * 悬浮球变形、按钮和图片对不上。这里反向抵消，让界面里的 1px 永远等于视口里的 1px。
   */
  fixZoom(): void {
    const z = pageZoom();
    const want = z !== 1 ? String(1 / z) : '';
    if (this.host.style.zoom !== want) this.host.style.zoom = want;
    if (!this.zoomBound) {
      this.zoomBound = true;
      window.addEventListener('resize', () => this.fixZoom());
    }
  }
  private zoomBound = false;

  /** 界面层左上角在视口里的位置。用来把视口坐标换成界面层里的坐标（网页给 html 加了边距、定位时不为 0）。 */
  origin(): { x: number; y: number } {
    const r = this.host.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }
}

/** <html> 上的 CSS zoom（没有就是 1）。 */
export function pageZoom(): number {
  const z = parseFloat(getComputedStyle(document.documentElement).zoom || '1');
  return Number.isFinite(z) && z > 0.05 ? z : 1;
}

/** 小工具：创建元素。 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> | null = null,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (k === 'class') el.className = String(v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** 线条图标（24×24 视窗，stroke 用 currentColor）。 */
const ICONS: Record<string, string> = {
  pin: '<path d="M9 4h6l-1 6 4 4H6l4-4z"/><path d="M12 14v6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  retry: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  // 齿轮：8 个齿用粗虚线圆画出，再加齿圈和中心孔
  gear: '<circle cx="12" cy="12" r="7.6" stroke-width="3.2" stroke-linecap="butt" stroke-dasharray="2.98 2.99" transform="rotate(-11 12 12)"/><circle cx="12" cy="12" r="5.6" stroke-width="1.9"/><circle cx="12" cy="12" r="2" stroke-width="1.9"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A9.9 9.9 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3.2 3.7M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.1"/>',
  thumbDown: '<path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H6.7a2 2 0 0 0-2 1.7l-1.4 9A2 2 0 0 0 5.3 15z"/><path d="M17 2h3v11h-3"/>',
  speaker: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a3 3 0 0 1 0 6M18.5 6.5a7 7 0 0 1 0 11"/>',
  status: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
};

export function icon(name: keyof typeof ICONS | string): SVGSVGElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

export function iconButton(name: string, label: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = h('button', { class: 'icon-btn', title: label, 'aria-label': label });
  b.append(icon(name));
  b.addEventListener('click', onClick);
  return b;
}

/* ------------------------------------------------------------------ */
/* 网页深浅色检测                                                        */
/* ------------------------------------------------------------------ */

function parseColor(c: string): [number, number, number, number] | null {
  const m = c.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (!m) return null;
  let a = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (m[4]?.endsWith('%')) a /= 100;
  return [+m[1], +m[2], +m[3], a];
}

function luminance([r, g, b]: [number, number, number, number]): number {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** 某一点上「看得见的背景」的亮度：从最上层往下找第一个不透明的背景色。 */
function backgroundAt(x: number, y: number): number | null {
  if (typeof document.elementsFromPoint !== 'function') return null;
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.localName === 'tx-ui') continue;
    const c = parseColor(getComputedStyle(el).backgroundColor);
    if (c && c[3] >= 0.6) return luminance(c);
  }
  // 一路都是透明：画布的颜色。html 没背景时 body 的背景会铺满整个画布
  if (document.body) {
    const c = parseColor(getComputedStyle(document.body).backgroundColor);
    if (c && c[3] >= 0.6) return luminance(c);
  }
  // 根元素声明了 color-scheme: dark 时画布是深色
  const scheme = getComputedStyle(document.documentElement).colorScheme || '';
  return /dark/.test(scheme) && !/light/.test(scheme) ? 0.02 : 1;
}

/** 按网页背景亮度判断深浅色：取中间、悬浮球附近、顶部三个点。 */
export function detectPageTheme(): 'light' | 'dark' | null {
  if (!document.documentElement) return null;
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  if (!w || !hgt) return null;
  const pts: [number, number][] = [[w / 2, hgt / 2], [w - 48, hgt * 0.62], [w / 2, Math.min(60, hgt / 4)]];
  const vals = pts.map(([x, y]) => backgroundAt(x, y)).filter((v): v is number => v !== null);
  if (!vals.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return avg < 0.3 ? 'dark' : 'light';
}
