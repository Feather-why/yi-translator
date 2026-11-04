/**
 * 全部界面共用的设计变量：悬浮球和小窗（网页里的 Shadow DOM）、设置页、PDF 阅读器。
 * 改配色、圆角、阴影只改这一个文件。
 *
 * 变量的含义：
 *   --bg       页面底色（设置页）；--bg-deep 更深一点的底（PDF 阅读器里衬托白色页面）
 *   --surface  浮起来的面：卡片、小窗、菜单
 *   --ink / --ink-2 / --muted   正文 / 次要文字 / 说明文字
 *   --line / --hover            分隔线 / 悬停底色（半透明，叠在任何底色上都合适）
 *   --accent / --accent-ink     主色 / 主色上的文字
 *   --good / --warning / --serious / --critical   状态色（--danger 是 --critical 的别名）
 *   --mark     联动高亮的底色
 *   --s1…--s8 / --other / --seq 图表分类色（已用色觉障碍模拟检查过区分度）
 *   --r-s / --r-m / --r-l       圆角
 *   --shadow   浮层阴影
 */
import { L } from './i18n';

type Tokens = Record<string, string>;

/**
 * 主题色预设。默认「雾蓝」：比之前的靛蓝（#4256d6）饱和度低、稍亮，放在网页上不抢眼，
 * 但和白色、浅灰底都还有 5:1 左右的对比度，悬浮球、按钮一眼能找到。
 * 每个预设在白字上都有 ≥ 4.5:1 的对比度；深色界面用同色调的浅色版。
 */
export const ACCENTS: { id: string; name: string; light: string }[] = [
  { id: 'mist', get name() { return L('雾蓝', 'Mist'); }, light: '#5065c0' },
  { id: 'slate', get name() { return L('青石', 'Slate'); }, light: '#3f7a8c' },
  { id: 'pine', get name() { return L('松绿', 'Pine'); }, light: '#2f7a6a' },
  { id: 'dusk', get name() { return L('暮紫', 'Dusk'); }, light: '#7b5cc4' },
  { id: 'ochre', get name() { return L('赭石', 'Ochre'); }, light: '#a55e26' },
  { id: 'rose', get name() { return L('玫瑰', 'Rose'); }, light: '#b14a68' },
  { id: 'graphite', get name() { return L('石墨', 'Graphite'); }, light: '#55606e' },
];

const LIGHT: Tokens = {
  accent: '#5065c0',
  'accent-ink': '#ffffff',
  'accent-soft': 'rgba(80, 101, 192, .12)',
  bg: '#f6f6f5',
  'bg-deep': '#eceef1',
  surface: '#ffffff',
  ink: '#1d2230',
  'ink-2': '#4a5062',
  muted: '#697084',
  line: 'rgba(20, 26, 45, .10)',
  hover: 'rgba(20, 26, 45, .06)',
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
  danger: '#d03b3b',
  mark: 'rgba(250, 204, 21, .5)',
  shadow: '0 10px 30px -8px rgba(15, 20, 40, .28), 0 2px 6px rgba(15, 20, 40, .08)',
  s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', s4: '#eda100', s5: '#e87ba4', s6: '#008300', s7: '#6250d6', s8: '#e34948',
  other: '#a3a29a', seq: '#2a78d6',
  'r-s': '7px', 'r-m': '10px', 'r-l': '12px',
};

const DARK: Tokens = {
  ...LIGHT,
  accent: '#96a3d9',
  'accent-ink': '#10142a',
  'accent-soft': 'rgba(150, 163, 217, .16)',
  bg: '#17181b',
  'bg-deep': '#111214',
  surface: '#202228',
  ink: '#e8eaf0',
  'ink-2': '#c3c6d0',
  muted: '#9aa1b5',
  line: 'rgba(255, 255, 255, .12)',
  hover: 'rgba(255, 255, 255, .07)',
  mark: 'rgba(250, 204, 21, .35)',
  shadow: '0 12px 32px -8px rgba(0, 0, 0, .6), 0 2px 6px rgba(0, 0, 0, .3)',
  s1: '#3987e5', s2: '#d95926', s3: '#199e70', s4: '#c98500', s5: '#d55181', s6: '#008300', s7: '#9085e9', s8: '#e66767',
  other: '#6b6a63', seq: '#3987e5',
};

/** Windows 高对比度等强制配色模式：交给系统颜色。 */
const FORCED: Tokens = {
  accent: 'Highlight', 'accent-ink': 'HighlightText', 'accent-soft': 'Highlight',
  bg: 'Canvas', surface: 'Canvas', ink: 'CanvasText', 'ink-2': 'CanvasText', muted: 'GrayText',
  line: 'CanvasText', hover: 'Canvas', mark: 'Mark', shadow: 'none',
};

function vars(t: Tokens): string {
  return Object.entries(t).map(([k, v]) => `--${k}:${v};`).join('');
}

export const LIGHT_VARS = vars(LIGHT);
export const DARK_VARS = vars(DARK);

/** 扩展自己的页面（设置页、PDF 阅读器）：跟随系统深浅色。 */
export const PAGE_THEME_CSS = `
:root { ${LIGHT_VARS} --panel: var(--surface); color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { ${DARK_VARS} color-scheme: dark; } }
@media (forced-colors: active) { :root { ${vars(FORCED)} } }
`;

/**
 * 网页里的 Shadow DOM：.layer 上的 data-theme 由 host.ts 按网页背景亮度设置；
 * 还没检测出来时跟随系统。
 */
export const LAYER_THEME_CSS = `
.layer { ${LIGHT_VARS} --panel: var(--surface); color-scheme: light; }
.layer[data-theme="dark"] { ${DARK_VARS} color-scheme: dark; }
@media (prefers-color-scheme: dark) { .layer:not([data-theme]) { ${DARK_VARS} color-scheme: dark; } }
@media (forced-colors: active) { .layer, .layer[data-theme] { ${vars(FORCED)} } }
`;

/* ------------------------------------------------------------------ */
/* 自定义主题色                                                          */
/* ------------------------------------------------------------------ */

function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const toHex = (c: [number, number, number]) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as [number, number, number];

/** 预设 id 或 #rrggbb → 浅色界面用的主色；认不出来就用默认。 */
export function resolveAccent(v: string | undefined): string {
  const preset = ACCENTS.find((a) => a.id === v);
  if (preset) return preset.light;
  return v && hexRgb(v) ? v : ACCENTS[0].light;
}

/** 一种主色在浅色 / 深色界面里的几个变量：深色用同色调的浅色版；主色上的文字按对比度选白或黑。 */
export function accentTokens(hex: string, dark: boolean): Tokens {
  const rgb = hexRgb(hex) ?? hexRgb(ACCENTS[0].light)!;
  const c = dark ? mix(rgb, [255, 255, 255], 0.42) : rgb;
  const l = luminance(c);
  const ink = (1.05 / (l + 0.05)) >= 4.5 ? '#ffffff' : '#10142a';
  return { accent: toHex(c), 'accent-ink': ink, 'accent-soft': `rgba(${c.map(Math.round).join(', ')}, ${dark ? 0.16 : 0.12})` };
}

/** 覆盖主色的 CSS。scope 是浅色时的选择器，darkScope 是深色时的。 */
export function accentCss(accent: string | undefined, scope: string, darkScope: string, systemDark = true): string {
  const hex = resolveAccent(accent);
  const L = vars(accentTokens(hex, false));
  const D = vars(accentTokens(hex, true));
  return `${scope} { ${L} } ${darkScope} { ${D} }` + (systemDark ? ` @media (prefers-color-scheme: dark) { ${scope.split(',').map((x) => `${x.trim()}:not([data-theme="light"])`).join(',')} { ${D} } }` : '');
}

/** 某个组件只在深色时才要的样式（Shadow DOM 里用）。 */
export function onDark(selector: string, body: string): string {
  return `.layer[data-theme="dark"] ${selector} { ${body} }
@media (prefers-color-scheme: dark) { .layer:not([data-theme]) ${selector} { ${body} } }`;
}
