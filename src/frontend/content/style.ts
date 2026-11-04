/**
 * 译文样式：继承原文的字体、颜色、字号，只做少量必要调整。
 *
 * - 译文就插在原段落里面（或紧随其后），自然继承原文的 font / color / line-height；
 * - 综合模式：高速译文较浅（opacity），精确译文覆盖后接近原文颜色；
 * - 中日韩译文：在原字体后面补上对应的 CJK 字体，关掉斜体、字距和大小写变换；
 * - 所有规则都挂在 tx- 前缀的元素和 html[data-tx-*] 上，不碰页面自己的元素。
 */
import type { SiteRule } from '../../shared/protocol';
import type { UiSettings } from '../../shared/settings';
import { resolveAccent } from '../theme';
import { baseLang } from './scanner';

const STYLE_ID = 'tx-page-style';

const CSS = `
html[data-tx-display="original"] tx-t { display: none !important; }
tx-t {
  /* 落在弹性 / 网格布局里时不要被拉伸到整行那么高（否则「竖线」样式会变成一条贯穿页面的长线）。
     用 height: fit-content 挡住拉伸（拉伸只作用于 auto 高度），不再用 align-self: flex-start：
     那样会无视容器的 align-items，居中 / 靠下的标签栏里译文被顶到最上面，和原文不在一条线上。 */
  height: fit-content; justify-self: start; min-height: 0; max-height: none; flex: 0 1 auto;
  color: color-mix(in srgb, currentColor var(--tx-final-pct, 90%), transparent);
  font-size: calc(1em * var(--tx-scale, 1));
  transition: opacity .28s ease;
  word-break: normal;
  overflow-wrap: anywhere;
}
tx-t[data-tx-mode="block"] { display: block; margin: .3em 0 0; }
/* 用 <br> 分段的正文：块级译文本身已经换行，紧跟着的第一个 <br> 再换一次就多出一个空行 */
tx-t[data-tx-mode="block"] + br { display: none; }
tx-t[data-tx-mode="inline"] { display: inline; margin-inline-start: .45em; }
tx-t[data-tx-mode="sentence"] {
  display: inline;
  margin-inline: .2em .35em;
  padding: 0 .15em;
  border-radius: .2em;
  background: color-mix(in srgb, currentColor 6%, transparent);
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
tx-t[data-tx-stage="fast"], tx-t[data-tx-stage="streaming"] { opacity: var(--tx-fast-opacity, .6); }
tx-t[data-tx-stage="streaming"]::after {
  content: ""; display: inline-block; width: .5em; height: 1em; margin-inline-start: .12em; vertical-align: -.12em;
  border-radius: 1px; background: currentColor; opacity: .45; animation: tx-caret .9s steps(2, start) infinite;
}
@keyframes tx-caret { to { visibility: hidden; } }
/* 最终译文替换快速译文 / 流式结果：只轻轻淡入，不再跳字 */
tx-t[data-tx-swap] { animation: tx-swap .22s ease-out; }
@keyframes tx-swap { from { opacity: .55; } }
tx-t[data-tx-stage="pending"]:not([data-tx-fx]), tx-t[data-tx-stage="error"] {
  display: inline !important; margin: 0 0 0 .4em !important; padding: 0 !important; background: none !important;
}
tx-t[data-tx-stage="pending"][data-tx-fx] { opacity: .34; }
tx-t .tx-scr { user-select: none; pointer-events: none; }
tx-t[data-tx-stage="pending"]:not([data-tx-fx])::after {
  content: "\\2022\\2022\\2022";
  letter-spacing: .12em;
  font-size: .8em;
  animation: tx-pulse 1.1s ease-in-out .35s infinite both;
}
@keyframes tx-pulse { 0%, 100% { opacity: .15 } 50% { opacity: .6 } }
tx-t[data-tx-stage="error"] { cursor: pointer; }
tx-t[data-tx-stage="error"]::after {
  content: "!"; display: inline-grid; place-items: center; width: 1.25em; height: 1.25em; border-radius: 50%;
  font: 700 .72em/1 -apple-system, "Segoe UI", sans-serif; vertical-align: .1em;
  color: #fff; background: color-mix(in srgb, #d43c3c 72%, transparent); opacity: .55; transition: opacity .15s;
}
tx-t[data-tx-stage="error"]:hover::after { opacity: 1; }
tx-t[contenteditable] { outline: 1.5px solid color-mix(in srgb, var(--tx-accent, #5065c0) 60%, transparent); outline-offset: 2px; border-radius: 3px; opacity: 1 !important; cursor: text; }
/* ---- 样式预设（html 或预览卡片上的 data-tx-style）---- */
[data-tx-style="bar"] tx-t[data-tx-mode="block"] {
  border-inline-start: 2px solid color-mix(in srgb, currentColor 24%, transparent);
  padding-inline-start: .6em;
}
[data-tx-style="bar"] tx-t:is([data-tx-mode="inline"], [data-tx-mode="sentence"]) {
  border-inline-start: 2px solid color-mix(in srgb, currentColor 24%, transparent); padding-inline-start: .3em; border-radius: 0;
}
[data-tx-style="tint"] tx-t[data-tx-mode="block"] {
  background: color-mix(in srgb, currentColor 6%, transparent); border-radius: .45em; padding: .3em .6em; margin-top: .35em;
}
[data-tx-style="tint"] tx-t[data-tx-mode="inline"] { background: color-mix(in srgb, currentColor 7%, transparent); border-radius: .3em; padding: 0 .3em; }
[data-tx-style="underline"] tx-t:not([data-tx-stage="pending"]):not([data-tx-stage="error"]) {
  text-decoration: underline dashed color-mix(in srgb, currentColor 38%, transparent);
  text-decoration-thickness: 1px; text-underline-offset: .3em; text-decoration-skip-ink: none;
}
/* 学习模式：译文先模糊，鼠标移上去（或按 Tab 聚焦）才看得清 */
[data-tx-style="blur"] tx-t:is([data-tx-stage="final"], [data-tx-stage="fast"]) {
  filter: blur(.28em); transition: filter .16s ease; cursor: help; border-radius: .2em;
}
[data-tx-style="blur"] tx-t:is(:hover, :focus, :focus-within, [contenteditable], [data-tx-peek]) { filter: none; }
html[data-tx-display="translation"] tx-t { filter: none !important; }
@media (forced-colors: active) { [data-tx-style="blur"] tx-t { filter: none !important; text-decoration: underline dotted; } }
html[data-tx-display="translation"] [data-tx-root][data-tx-done] { font-size: 0 !important; }
html[data-tx-display="translation"] [data-tx-root][data-tx-done] > :not(tx-t) { display: none !important; }
html[data-tx-display="translation"] [data-tx-root][data-tx-done]::marker { font-size: var(--tx-fs, 1rem); }
html[data-tx-display="translation"] [data-tx-root][data-tx-done] > tx-t {
  font-size: calc(var(--tx-fs, 16px) * var(--tx-scale, 1)) !important; margin: 0 !important;
  opacity: 1; color: inherit; border: 0 !important; padding: 0 !important;
}
tx-t:is(:lang(zh), :lang(ja), :lang(ko)) :is(em, i, cite, dfn, var, q) { font-style: normal; }
tx-t a.tx-autolink { color: inherit; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: .15em; }
::highlight(tx-link) { background-color: rgba(250, 204, 21, .5); }
::highlight(tx-link-soft) { background-color: rgba(250, 204, 21, .14); }
`;

/** 设置页的样式预览用：同一份译文样式。 */
export const TX_PREVIEW_CSS = CSS;

export function installPageStyle(s: UiSettings): void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(el);
  }
  const fastOpacity = Math.max(0.2, Math.min(1, s.fastColorPercent / Math.max(1, s.finalColorPercent)));
  el.textContent =
    `:root{--tx-accent:${resolveAccent(s.appearance?.accent)};--tx-final-pct:${s.finalColorPercent}%;--tx-fast-opacity:${fastOpacity.toFixed(2)};--tx-scale:${s.fontScale}}` + CSS;
  const html = document.documentElement;
  html.setAttribute('data-tx-display', s.display);
  html.setAttribute('data-tx-style', s.txStyle);
}

export function removePageStyle(): void {
  document.getElementById(STYLE_ID)?.remove();
  const html = document.documentElement;
  html.removeAttribute('data-tx-display');
  html.removeAttribute('data-tx-style');
}

/* ------------------------------------------------------------------ */

const CJK_SANS: Record<string, string> = {
  'zh-cn': '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif',
  'zh-tw': '"PingFang TC","Microsoft JhengHei","Noto Sans CJK TC","Source Han Sans TC",sans-serif',
  ja: '"Hiragino Sans","Yu Gothic","Meiryo","Noto Sans CJK JP",sans-serif',
  ko: '"Apple SD Gothic Neo","Malgun Gothic","Noto Sans CJK KR",sans-serif',
};
const CJK_SERIF: Record<string, string> = {
  'zh-cn': '"Songti SC","Noto Serif CJK SC","Source Han Serif SC","SimSun",serif',
  'zh-tw': '"Songti TC","Noto Serif CJK TC","Source Han Serif TC","PMingLiU",serif',
  ja: '"Hiragino Mincho ProN","Yu Mincho","Noto Serif CJK JP",serif',
  ko: '"AppleMyungjo","Batang","Noto Serif CJK KR",serif',
};
const SERIF_RE = /(^|[\s,"'])serif|Georgia|Times|Garamond|Merriweather|Lora|Palatino|Cambria|Charter|Source Serif|Noto Serif|Baskerville|Didot|Tiempos|Iowan/i;

function cjkKey(target: string): string | null {
  const t = target.toLowerCase();
  if (t.startsWith('zh')) return /tw|hk|hant|mo/.test(t) ? 'zh-tw' : 'zh-cn';
  const b = baseLang(t);
  return b === 'ja' || b === 'ko' ? b : null;
}

/** 禁止站点规则通过 style 做排版以外的事。 */
const RULE_STYLE_ALLOW = /^(font-size|font-weight|line-height|margin(-\w+)?|padding(-\w+)?|display|text-align|letter-spacing|white-space|opacity)$/;

/** 根据原文计算并设置一个译文元素的少量内联样式。 */
export function styleTranslation(tx: HTMLElement, root: Element, targetLang: string, block: boolean, rule?: SiteRule | null): void {
  const cs = getComputedStyle(root);
  const key = cjkKey(targetLang);
  tx.style.setProperty('--tx-fs', cs.fontSize);
  // 「仅译文」模式把原段落字号设为 0 来隐藏原文；列表符号要用原字号
  (root as HTMLElement).style?.setProperty('--tx-fs', cs.fontSize);
  if (key) {
    const ff = cs.fontFamily;
    const fallback = SERIF_RE.test(ff) && !/sans-serif/i.test(ff.split(',').pop() || '') ? CJK_SERIF[key] : CJK_SANS[key];
    tx.style.fontFamily = `${ff}, ${fallback}`;
    if (cs.fontStyle !== 'normal') tx.style.fontStyle = 'normal';
    if (cs.letterSpacing !== 'normal' && cs.letterSpacing !== '0px') tx.style.letterSpacing = 'normal';
    if (cs.textTransform !== 'none') tx.style.textTransform = 'none';
    if (block) {
      const fs = parseFloat(cs.fontSize) || 16;
      const lh = cs.lineHeight === 'normal' ? 1.2 : (parseFloat(cs.lineHeight) || fs * 1.2) / fs;
      if (lh < 1.5 && fs < 28) tx.style.lineHeight = '1.65';
    }
  }
  if (rule?.style) {
    for (const [k, v] of Object.entries(rule.style)) {
      if (RULE_STYLE_ALLOW.test(k) && !/url\(|expression|javascript:/i.test(v)) tx.style.setProperty(k, v);
    }
  }
}
