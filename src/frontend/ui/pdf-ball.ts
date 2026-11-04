/**
 * 浏览器自带的 PDF 查看器里的入口：和网页上的悬浮球同样子的小圆球。
 * - 点一下：用扩展的阅读器双栏对照翻译；
 * - 鼠标停在上面：旁边展开「双栏对照翻译 / 单栏阅读 · 可划词 / 隐藏」；
 * - 可以拖到任何位置，位置记住（chrome.storage.local 的 ui.pdfBall，所有 PDF 共用）。
 */
import type { UiSettings } from '../../shared/settings';
import { h, type UiHost } from './host';
import { logoElement } from './logo';
import { L } from '../i18n';

const KEY = 'ui.pdfBall';
const SIZE = 40;

const CSS = `
.pb { position: fixed; z-index: 2; width: ${SIZE}px; height: ${SIZE}px; touch-action: none; }
.pb .b {
  width: ${SIZE}px; height: ${SIZE}px; border-radius: 50%; display: grid; place-items: center; cursor: grab; user-select: none;
  background: var(--surface); color: var(--ink); --logo-accent: var(--accent); border: 1px solid var(--line); box-shadow: var(--shadow);
  transition: background .2s, color .2s, box-shadow .2s;
}
.pb .b:hover, .pb.open .b { box-shadow: var(--shadow), 0 0 0 4px color-mix(in srgb, var(--accent) 14%, transparent); }
.pb.drag .b { cursor: grabbing; transition: none; }
.pb[data-ball="accent"] .b { background: var(--accent); color: var(--accent-ink); --logo-accent: color-mix(in srgb, var(--accent-ink) 62%, transparent); border-color: transparent; }
.pb[data-ball="glass"] .b { background: color-mix(in srgb, var(--surface) 62%, transparent); border-color: color-mix(in srgb, var(--ink) 14%, transparent);
  backdrop-filter: blur(10px) saturate(1.4); -webkit-backdrop-filter: blur(10px) saturate(1.4); }
.pb .m {
  position: absolute; top: 50%; transform: translateY(-50%); display: none; align-items: center; gap: 2px; padding: 4px; border-radius: 99px; white-space: nowrap;
  background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(16px) saturate(1.5); -webkit-backdrop-filter: blur(16px) saturate(1.5);
  border: 1px solid var(--line); box-shadow: var(--shadow); font-size: 13px;
}
.pb.right .m { right: calc(100% + 8px); }
.pb.left .m { left: calc(100% + 8px); }
.pb.open:not(.drag) .m { display: flex; }
.pb .m button { padding: 6px 12px; border-radius: 99px; color: var(--ink); font-weight: 600; }
.pb .m button:hover, .pb .m button:focus-visible { background: var(--hover); }
.pb .m button.primary { background: var(--accent); color: var(--accent-ink); }
.pb .m button.primary:hover { background: color-mix(in srgb, var(--accent) 88%, #000); }
.pb .m .x { font-weight: 400; color: var(--muted); padding: 6px 9px; }
`;

interface Pos {
  /** 球心离视口左边、上边的比例 0~1（窗口大小变了也大致在原处）。 */
  x: number;
  y: number;
}

export function showPdfBall(ui: UiHost, settings: UiSettings, open: (view?: 'original') => void): void {
  ui.addStyle(CSS);
  const both = h('button', { type: 'button', class: 'primary', title: L('左边原文、右边在原页上换成译文', 'Original on the left, translation drawn onto the page on the right') }, L('双栏对照翻译', 'Side-by-side translation'));
  const single = h('button', { type: 'button', title: L('用扩展的阅读器打开：不整篇翻译，选中文字就能翻译。在这里选中文字后右键「翻译」也可以', 'Open in the extension\'s reader: no full translation, select text to translate it. You can also select text here and right-click “Translate”') }, L('单栏阅读 · 可划词', 'Single view · select to translate'));
  const hide = h('button', { type: 'button', class: 'x', title: L('这次先隐藏（刷新页面后再出现）', 'Hide for now (comes back after reload)'), 'aria-label': L('隐藏', 'Hide') }, '✕');
  const menu = h('div', { class: 'm', role: 'menu' }, both, single, hide);
  const ball = h('div', { class: 'b', role: 'button', tabindex: '0', title: L('翻译这个 PDF（点一下双栏对照；鼠标停一下看更多；可以拖动）', 'Translate this PDF (click for side-by-side; hover for more; drag to move)'), 'aria-label': L('翻译这个 PDF', 'Translate this PDF') }, logoElement({ size: 20 }));
  const wrap = h('div', { class: 'pb right', 'data-ball': settings.appearance?.ball ?? 'light' }, menu, ball);
  ui.layer.appendChild(wrap);

  both.addEventListener('click', () => open());
  single.addEventListener('click', () => open('original'));
  hide.addEventListener('click', () => wrap.remove());
  ball.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      wrap.classList.add('open');
      both.focus();
    }
  });
  menu.addEventListener('keydown', (e) => {
    const items = [both, single, hide];
    const i = items.indexOf(e.target as HTMLButtonElement);
    if (e.key === 'Escape') {
      wrap.classList.remove('open');
      ball.focus();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length].focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + items.length - 1) % items.length].focus();
    }
  });

  let pos: Pos = { x: 1, y: 1 };
  const place = () => {
    const cx = Math.min(innerWidth - SIZE / 2 - 12, Math.max(SIZE / 2 + 12, pos.x * innerWidth));
    const cy = Math.min(innerHeight - SIZE / 2 - 12, Math.max(SIZE / 2 + 12, pos.y * innerHeight));
    wrap.style.left = `${Math.round(cx - SIZE / 2)}px`;
    wrap.style.top = `${Math.round(cy - SIZE / 2)}px`;
    // 菜单往球离边远的那一侧展开
    const right = cx > innerWidth / 2;
    wrap.classList.toggle('right', right);
    wrap.classList.toggle('left', !right);
  };
  place();
  void chrome.storage.local.get(KEY).then((got) => {
    const p = got[KEY] as Pos | undefined;
    if (p && typeof p.x === 'number' && typeof p.y === 'number') {
      pos = { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
      place();
    }
  }).catch(() => {});
  addEventListener('resize', place);

  // 悬停展开（稍等一下，免得划过就弹出）
  let timer = 0;
  wrap.addEventListener('mouseenter', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => wrap.classList.add('open'), 220);
  });
  wrap.addEventListener('mouseleave', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!menu.matches(':focus-within')) wrap.classList.remove('open');
    }, 260);
  });

  // 拖动：移动超过 4px 才算拖，否则是点击
  let start: { x: number; y: number; left: number; top: number } | null = null;
  let moved = false;
  ball.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = wrap.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    moved = false;
    ball.setPointerCapture(e.pointerId);
  });
  ball.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    wrap.classList.add('drag');
    pos = { x: (start.left + dx + SIZE / 2) / innerWidth, y: (start.top + dy + SIZE / 2) / innerHeight };
    place();
  });
  const end = () => {
    if (!start) return;
    start = null;
    wrap.classList.remove('drag');
    if (moved) void chrome.storage.local.set({ [KEY]: pos }).catch(() => {});
    else open();
  };
  ball.addEventListener('pointerup', end);
  ball.addEventListener('pointercancel', () => {
    if (start && moved) void chrome.storage.local.set({ [KEY]: pos }).catch(() => {});
    start = null;
    wrap.classList.remove('drag');
  });
}
