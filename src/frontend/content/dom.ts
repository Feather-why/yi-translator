/** 页面 DOM 分类：哪些跳过、哪些是行内、哪些原样保留。 */

/** 整个子树都不碰。 */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
  'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'HEAD', 'META', 'LINK',
  'TITLE', 'BASE', 'DIALOG',
]);

/** 行内元素（按标签判断就够了）。 */
const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'BIG', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I',
  'IMG', 'INS', 'KBD', 'LABEL', 'MARK', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE',
  'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U', 'VAR', 'WBR', 'PICTURE', 'BUTTON', 'svg', 'MATH',
]);

/** 这些行内元素可能被 CSS 改成块级，需要看一眼计算样式。 */
const MAYBE_BLOCK = new Set(['A', 'SPAN', 'LABEL', 'FONT', 'BUTTON', 'PICTURE', 'IMG', 'CODE']);

/** 原样克隆到译文里、内部不翻译的元素。 */
const ATOM_TAGS = new Set([
  'CODE', 'KBD', 'SAMP', 'VAR', 'TT', 'IMG', 'PICTURE', 'BR', 'WBR', 'INPUT', 'BUTTON', 'SELECT',
  'TEXTAREA', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'RUBY', 'svg', 'SVG', 'MATH',
]);

export function isOurs(node: Node | null): boolean {
  return !!node && node.nodeType === 1 && (node as Element).localName.startsWith('tx-');
}

/** 节点在我们插入的译文里（或就是我们的 UI）。 */
export function insideOurs(node: Node | null): boolean {
  for (let n: Node | null = node; n; n = n.parentNode) if (isOurs(n)) return true;
  return false;
}

export function isSkipped(el: Element, parentKnownNonEditable = false): boolean {
  if (SKIP_TAGS.has(el.tagName) || el.localName === 'svg' || el.localName === 'math') return true;
  if (isOurs(el)) return true;
  const cls = el.classList;
  if (cls.contains('tx-ignore')) return true;
  // AAU 等站点会在整个文档上关闭自动翻译。用户开启本页翻译后，仍尊重各局部区域的免译标记。
  if (cls.contains('notranslate') || el.getAttribute('translate')?.toLowerCase() === 'no') {
    if (el !== el.ownerDocument.body && el !== el.ownerDocument.documentElement) return true;
  }
  if ((!parentKnownNonEditable || el.hasAttribute('contenteditable')) && (el as HTMLElement).isContentEditable) return true;
  if ((el as HTMLElement).hidden) return true;
  if (el.getAttribute('aria-hidden') === 'true' && !el.textContent?.trim()) return true;
  return false;
}

const displayCache = new WeakMap<Element, string>();
export function displayOf(el: Element): string {
  let d = displayCache.get(el);
  if (d === undefined) {
    d = getComputedStyle(el).display;
    displayCache.set(el, d);
  }
  return d;
}

export function isInline(el: Element): boolean {
  const tag = el.tagName;
  if (INLINE_TAGS.has(tag) || el.localName === 'svg') {
    if (!MAYBE_BLOCK.has(tag)) return true;
    const d = displayOf(el);
    return d.startsWith('inline') || d === 'contents' || d === 'none';
  }
  // 自定义元素：看计算样式
  if (el.localName.includes('-')) {
    const d = displayOf(el);
    return d.startsWith('inline') || d === 'contents';
  }
  return false;
}

/** 脱离文档流（绝对 / 固定定位）的元素：它的位置和高度是相对某个定位祖先算的。 */
export function isOutOfFlow(el: Element): boolean {
  const p = getComputedStyle(el).position;
  return p === 'absolute' || p === 'fixed';
}

const BLOCK_SEL = 'div,p,ul,ol,dl,table,section,article,aside,header,footer,nav,figure,blockquote,h1,h2,h3,h4,h5,h6,li,hr,form,fieldset,details,main';

/**
 * 行内标签里包着真正的块（例如维基百科信息框里 <span class="noprint"> 包着整条地质年代图）：
 * 这种 span 不能当一段话里的行内片段，要当块继续往里拆，否则图表里的零件会被整个拷进译文。
 * 绝对定位的块（悬停提示之类）和隐藏的块不算。
 */
export function containsBlock(el: Element): boolean {
  if (!el.firstElementChild) return false;
  const found = el.querySelectorAll(BLOCK_SEL);
  for (let i = 0; i < found.length && i < 8; i++) {
    const d = displayOf(found[i]);
    if (d.startsWith('inline') || d === 'none' || d === 'contents') continue;
    if (isOutOfFlow(found[i])) continue;
    return true;
  }
  return false;
}

/** 当作一段话里的行内片段：行内元素，且里面没有包着块。 */
export function isInlineFlow(el: Element): boolean {
  return isInline(el) && !containsBlock(el);
}

/**
 * 图表、时间轴、徽标上的小标签：自己是绝对定位的单行盒子，所在的定位容器也只有一两行高。
 * 往里插译文只会把图撑乱（文字互相压住），不翻。
 */
export function isPinnedLabel(el: Element): boolean {
  if (!isOutOfFlow(el)) return false;
  const cs = getComputedStyle(el);
  const fs = parseFloat(cs.fontSize) || 16;
  const lh = parseFloat(cs.lineHeight) || fs * 1.3;
  if (el.getBoundingClientRect().height > lh * 2) return false;
  const host = (el as HTMLElement).offsetParent ?? el.parentElement;
  if (!host) return true;
  return host.getBoundingClientRect().height < lh * 3;
}

/** 数字脚注、页码这类，整个当作原样保留。 */
const FOOTNOTE_RE = /^\s*[\[(]?\d{1,3}[\])]?\s*$/;

export function isAtom(el: Element, knownText?: string): boolean {
  if (ATOM_TAGS.has(el.tagName) || el.localName === 'svg' || el.localName === 'math') return true;
  const text = knownText ?? el.textContent ?? '';
  if (!/\S/.test(text)) return true; // 图标、空 span
  if ((el.tagName === 'SUP' || el.tagName === 'A') && FOOTNOTE_RE.test(text)) return true;
  return false;
}

/** 至少有一个字母（任何文字系统），且不是纯数字/符号。 */
export function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}

export function closestElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/**
 * 这一块在页面上真的看得见、放得下译文吗？
 * 读屏专用的隐藏文字（1px 宽、clip 掉）、宽度几乎为 0 的绝对定位元素、透明 / 0 字号的文字都不翻：
 * 否则块级译文会在一个零宽的盒子里一字一行地排下去，「竖线」样式的左边框就成了贯穿整页的一条线。
 */
export function isVisiblyRendered(el: Element): boolean {
  let box: Element | null = el;
  let cs = getComputedStyle(el);
  // display: contents 自己没有盒子，看父元素
  while (box && cs.display === 'contents') {
    box = box.parentElement;
    if (box) cs = getComputedStyle(box);
  }
  if (!box) return false;
  if (cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) === 0) return false;
  if (parseFloat(cs.fontSize) < 4) return false;
  if (/rgba\([^)]*,\s*0\)$/.test(cs.color) || cs.color === 'transparent') return false;
  const r = box.getBoundingClientRect();
  if (r.width < 24 || r.height < 4) return false;
  if (cs.clip && cs.clip !== 'auto' && /rect\(0(px)?,?\s*0(px)?/.test(cs.clip)) return false;
  if (/inset\(\s*50%/.test(cs.clipPath)) return false;
  return true;
}
