/**
 * 「只翻正文」：认出文章主体，跳过导航、侧栏、页脚、评论区、分享和推荐。
 *
 * 做法很保守：
 *   1. 找候选容器（<main>、<article>、role=main、常见的正文 class），按其中段落文字的多少打分；
 *      最好的那个包含全页 55% 以上的段落文字、且有一定长度，才当作正文，只翻它（再加上它外面的大标题）；
 *   2. 找不到有把握的正文时，整页照翻，只去掉明显的导航 / 侧栏 / 页脚 / 评论区。
 * 站点规则写了 include 时以规则为准，不走这里。
 */

/** 不管在不在正文里都跳过的区域。 */
const ALWAYS_SKIP = [
  'nav', '[role="navigation"]', '[aria-label*="breadcrumb" i]', '.breadcrumb', '.breadcrumbs',
  '#comments', '.comments', '#disqus_thread', '.comment-list', '.comments-area', '#respond',
  '.share', '.sharing', '.social-share', '.share-buttons', '.related', '.related-posts', '.recommended',
  '.newsletter', '.subscribe', '[class*="cookie-banner"]', '[id*="cookie-banner"]', '.advertisement', '.ad-slot',
  '.sidebar', '#sidebar', '[role="complementary"]', '[role="contentinfo"]', 'body > footer', '.site-footer', '#footer',
  // 文章外面的 <aside> 是侧栏；文章里面的 <aside> 常常是正文的提示框，保留
  'aside:not(article aside):not(main aside)',
];
/** 找不到正文时额外跳过的整页级区域。 */
const PAGE_CHROME = ['aside', 'footer', '.site-header'];

const CANDIDATES = [
  'main', '[role="main"]', 'article', '[itemprop="articleBody"]',
  '.post-content', '.entry-content', '.article-body', '.article-content', '.post-body', '.story-body',
  '.markdown-body', '.prose', '#content', '#main-content', '.content',
];

const BLOCKS = 'p, li, blockquote, dd, pre, td, h2, h3, h4';

function textIn(el: Element, skip: string): number {
  let n = 0;
  el.querySelectorAll(BLOCKS).forEach((b) => {
    if (skip && b.closest(skip)) return;
    // 嵌套的块（li 里的 p）只算最内层
    if (b.querySelector(BLOCKS)) return;
    n += (b.textContent || '').trim().length;
  });
  return n;
}

export interface ContentScope {
  /** 正文容器；null = 整页 */
  root: Element | null;
  /** 正文外也要翻译的元素（文章大标题等） */
  extra: Element[];
  /** 要整块跳过的区域选择器 */
  skip: string;
}

export function detectContent(doc: Document = document): ContentScope {
  const always = ALWAYS_SKIP.join(',');
  const body = doc.body;
  if (!body) return { root: null, extra: [], skip: always };
  const total = textIn(body, always);
  const scored: [Element, number][] = [];
  const seen = new Set<Element>();
  for (const sel of CANDIDATES) {
    doc.querySelectorAll(sel).forEach((el) => {
      if (seen.has(el) || el === body || el === doc.documentElement) return;
      seen.add(el);
      scored.push([el, textIn(el, always)]);
    });
  }
  scored.sort((a, b) => b[1] - a[1]);
  let [best, bestLen] = scored[0] ?? [null, 0];
  // 外层容器（如 .content）往往把侧栏也包进去：里面有一个几乎同样多文字的候选时，换成里面那个
  for (let changed = true; best && changed; ) {
    changed = false;
    for (const [el, len] of scored) {
      if (el !== best && best.contains(el) && len >= bestLen * 0.8) {
        best = el;
        bestLen = len;
        changed = true;
        break;
      }
    }
  }
  const root = best;
  // 文章目录（维基百科左栏的 Contents 等）：链接几乎都跳到本页的小标题，内容就是正文的标题，照常翻译
  const tocs = findTocs(doc);
  if (root && bestLen >= 400 && bestLen >= total * 0.55) {
    const extra: Element[] = [...tocs];
    const h1 = doc.querySelector('h1');
    if (h1 && !root.contains(h1) && !h1.closest(always)) extra.push(h1);
    return { root, extra, skip: always };
  }
  return { root: null, extra: tocs, skip: [...ALWAYS_SKIP, ...PAGE_CHROME].join(',') };
}

const TOC_SEL = 'nav, [role="navigation"], aside, .sidebar, #sidebar, [role="complementary"], [id*="toc" i], [class*="toc" i], [class*="table-of-contents" i]';

/** 页内目录：至少 3 个链接、七成以上指向本页存在的锚点。只保留最外层。 */
export function findTocs(doc: Document = document): Element[] {
  const found: Element[] = [];
  doc.querySelectorAll(TOC_SEL).forEach((el) => {
    if (found.some((f) => f.contains(el))) return;
    const links = el.querySelectorAll('a[href]');
    if (links.length < 3 || links.length > 400) return;
    let inPage = 0;
    for (const a of links) {
      const h = a.getAttribute('href') ?? '';
      if (h.length < 2 || h[0] !== '#') continue;
      let id = h.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        /* 保留原样 */
      }
      if (doc.getElementById(id)) inPage++;
    }
    if (inPage >= 3 && inPage >= links.length * 0.7) {
      for (let i = found.length - 1; i >= 0; i--) if (el.contains(found[i])) found.splice(i, 1);
      found.push(el);
    }
  });
  return found;
}

/** 后来插入的节点是否在要翻译的范围里（祖先在跳过区域、或在正文之外都不翻）。 */
export function scopeAllows(scope: ContentScope, el: Element): boolean {
  if (scope.extra.some((x) => x.contains(el))) return true;
  if (scope.skip && el.closest(scope.skip)) return false;
  const root = scope.root;
  if (!root || !root.isConnected) return true;
  return root.contains(el) || el.contains(root) || scope.extra.some((x) => x.contains(el) || el.contains(x));
}

/**
 * 扫描时的过滤：0 = 整棵子树跳过，1 = 只往里找（自己的零散文字不翻），2 = 正常。
 */
export function scopeFilter(scope: ContentScope): (el: Element) => 0 | 1 | 2 {
  return (el) => {
    // 目录、文章大标题这些「正文外也要翻的」优先：它们可能就在 <nav> 里
    for (const x of scope.extra) if (x === el || x.contains(el)) return 2;
    const wrapsExtra = scope.extra.some((x) => el.contains(x));
    if (scope.skip && el.matches(scope.skip)) return wrapsExtra ? 1 : 0;
    const root = scope.root;
    if (!root || !root.isConnected) return 2;
    if (root === el || root.contains(el)) return 2;
    if (wrapsExtra || el.contains(root)) return 1;
    return 0;
  };
}
