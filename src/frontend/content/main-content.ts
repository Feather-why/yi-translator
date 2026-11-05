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

const CANDIDATE_SELECTOR = CANDIDATES.join(',');

export interface ContentScope {
  /** 正文容器；null = 整页 */
  root: Element | null;
  /** 正文外也要翻译的元素（文章大标题等） */
  extra: ReadonlySet<Element>;
  /** 要整块跳过的区域选择器 */
  skip: string;
}

/** Cookie 详情等可访问性组件会预装大量隐藏文本。只在计分时跳过实际没有布局的区域。
 * 可见的 aria-hidden 文字、打开的对话框、display:contents 的子元素仍可参与正文识别。
 */
function inHiddenPanel(block: Element, cache: Map<Element, boolean>): boolean {
  let el = block.closest('[hidden],[aria-hidden="true" i],dialog,[role="dialog" i],[role="alertdialog" i]');
  if (!el) return false;
  const visited: Element[] = [];
  let hidden = false;
  while (el) {
    const known = cache.get(el);
    if (known !== undefined) { hidden = known; break; }
    visited.push(el);
    if (getComputedStyle(el).display === 'none') { hidden = true; break; }
    el = el.parentElement;
  }
  for (const item of visited) cache.set(item, hidden);
  return hidden;
}

export function detectContent(doc: Document = document): ContentScope {
  const always = ALWAYS_SKIP.join(',');
  const body = doc.body;
  if (!body) return { root: null, extra: new Set(), skip: always };
  const candidates = Array.from(body.querySelectorAll(CANDIDATE_SELECTOR));
  const scores = new Map<Element, number>();
  let total = 0;
  if (candidates.length) {
    // 一个叶子段落只计一次。先归入最近的候选祖先，再从内向外合计，避免每层重复扫描全文。
    for (const el of candidates) scores.set(el, 0);
    const panelVisibility = new Map<Element, boolean>();
    for (const block of body.querySelectorAll(BLOCKS)) {
      if (block.querySelector(BLOCKS) || block.closest(always) || inHiddenPanel(block, panelVisibility)) continue;
      const length = (block.textContent || '').trim().length;
      total += length;
      const owner = block.parentElement?.closest(CANDIDATE_SELECTOR);
      if (owner && scores.has(owner)) scores.set(owner, scores.get(owner)! + length);
    }
    for (let i = candidates.length - 1; i >= 0; i--) {
      const parent = candidates[i].parentElement?.closest(CANDIDATE_SELECTOR);
      if (parent && scores.has(parent)) scores.set(parent, scores.get(parent)! + scores.get(candidates[i])!);
    }
  }
  const scored = [...scores].sort((a, b) => b[1] - a[1]);
  let [best, bestLen] = scored[0] ?? [null, 0];
  // 按文字量从大到小进入更集中的容器，保留原有的 80% / 55% 选择规则。
  for (const [el, length] of scored) {
    if (best && el !== best && best.contains(el) && length >= bestLen * 0.8) {
      best = el;
      bestLen = length;
    }
  }
  const root = best;
  // 文章目录（维基百科左栏的 Contents 等）：链接几乎都跳到本页的小标题，内容就是正文的标题，照常翻译
  const tocs = findTocs(doc);
  if (root && bestLen >= 400 && bestLen >= total * 0.55) {
    const extra = new Set(tocs);
    const h1 = doc.querySelector('h1');
    if (h1 && !root.contains(h1) && !h1.closest(always)) extra.add(h1);
    return { root, extra, skip: always };
  }
  return { root: null, extra: new Set(tocs), skip: [...ALWAYS_SKIP, ...PAGE_CHROME].join(',') };
}

const TOC_SEL = 'nav, [role="navigation"], aside, .sidebar, #sidebar, [role="complementary"], [id*="toc" i], [class*="toc" i], [class*="table-of-contents" i]';

/** 页内目录：至少 3 个链接、七成以上指向本页存在的锚点。只保留最外层。 */
export function findTocs(doc: Document = document): Element[] {
  const found: Element[] = [];
  doc.querySelectorAll(TOC_SEL).forEach((el) => {
    // 查询结果按文档顺序排列，只有最后一个接纳的外层目录可能包含当前元素。
    if (found[found.length - 1]?.contains(el)) return;
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
      found.push(el);
    }
  });
  return found;
}

function insideExtra(scope: ContentScope, el: Element): boolean {
  if (scope.extra.size) {
    for (let p: Element | null = el; p; p = p.parentElement) if (scope.extra.has(p)) return true;
  }
  return false;
}

function wrapsExtra(scope: ContentScope, el: Element): boolean {
  if (el.firstElementChild) for (const extra of scope.extra) if (el.contains(extra)) return true;
  return false;
}

/** 后来插入的节点是否在要翻译的范围里（祖先在跳过区域、或在正文之外都不翻）。 */
export function scopeAllows(scope: ContentScope, el: Element): boolean {
  if (insideExtra(scope, el)) return true;
  if (scope.skip && el.closest(scope.skip)) return false;
  const root = scope.root;
  if (!root || !root.isConnected) return true;
  return root.contains(el) || el.contains(root) || wrapsExtra(scope, el);
}

/**
 * 扫描时的过滤：0 = 整棵子树跳过，1 = 只往里找（自己的零散文字不翻），2 = 正常。
 */
export function scopeFilter(scope: ContentScope): (el: Element) => 0 | 1 | 2 {
  return (el) => {
    // 目录、文章大标题这些「正文外也要翻的」优先：它们可能就在 <nav> 里
    if (insideExtra(scope, el)) return 2;
    if (scope.skip && el.matches(scope.skip)) return wrapsExtra(scope, el) ? 1 : 0;
    const root = scope.root;
    if (!root || !root.isConnected) return 2;
    if (root === el || root.contains(el)) return 2;
    if (el.contains(root) || wrapsExtra(scope, el)) return 1;
    return 0;
  };
}
