/**
 * 找出页面上要翻译的「段落单元」。
 *
 * 单元 = 一个只含行内内容的块级元素（whole），或者块级元素里夹在块级子元素之间的
 * 一串行内节点（run，例如 <div>文字 <b>粗</b><p>…</p></div> 里的「文字 粗」）。
 */
import { hasLetters, isInlineFlow, isOurs, isSkipped } from './dom';

export interface UnitSpec {
  root: Element;
  nodes: Node[];
  whole: boolean;
}

export interface ScanOptions {
  /** 站点规则里的 include：只在这些容器里找。 */
  include?: string[];
  exclude?: string[];
  /** 已经认领过的节点，跳过。 */
  claimed: (n: Node) => boolean;
  /** 「只翻正文」的过滤：0 跳过整棵子树，1 只往里找，2 正常。 */
  filter?: (el: Element) => 0 | 1 | 2;
}

function meaningful(nodes: Node[]): boolean {
  let text = '';
  for (const n of nodes) {
    text += n.textContent ?? '';
    if (text.length > 64) break;
  }
  const t = text.trim();
  return t.length >= 2 && hasLetters(t);
}

const isBr = (n: Node) => n.nodeType === 1 && (n as Element).tagName === 'BR';
const isBlank = (n: Node) => n.nodeType === 3 && !(n.textContent ?? '').trim();
const END_PUNCT = /[.!?:;。！？：；…]["'”’)）\]]*$/;
const ITEM_START = /^\s*([•·▪‣◦●○■□\-–—*]|\(?\d{1,3}[.)、]|\(?[a-zA-Z][.)])\s/;

/**
 * 按 <br> 把一串行内节点分成段落。
 * - 连续两个以上 <br>（中间只有空白）：一定分段；
 * - 单个 <br>：前一行以句号、冒号等收尾，或者下一行是列表项（• / 1. / a)）时分段；
 *   否则是同一段里的手动折行（诗、地址），不拆，<br> 留在段里原样保留。
 * 分出的段落不含分隔用的 <br>，它们留在原处。只有一段时返回原样。
 */
export function splitAtBreaks(nodes: Node[]): Node[][] {
  if (!nodes.some(isBr)) return [nodes];
  const groups: Node[][] = [];
  let cur: Node[] = [];
  const textOf = (ns: Node[]) => ns.map((n) => n.textContent ?? '').join('');
  for (let i = 0; i < nodes.length; ) {
    if (!isBr(nodes[i])) {
      cur.push(nodes[i++]);
      continue;
    }
    let j = i;
    let brs = 0;
    while (j < nodes.length && (isBr(nodes[j]) || isBlank(nodes[j]))) {
      if (isBr(nodes[j])) brs++;
      j++;
    }
    const before = textOf(cur).trim();
    const after = textOf(nodes.slice(j, j + 3));
    if (cur.length && (brs >= 2 || END_PUNCT.test(before) || ITEM_START.test(after))) {
      groups.push(cur);
      cur = [];
    } else if (cur.length) cur.push(...nodes.slice(i, j));
    i = j;
  }
  if (cur.length) groups.push(cur);
  const real = groups.filter(meaningful);
  return real.length > 1 ? real : [nodes];
}

export function scan(root: Element, opts: ScanOptions): UnitSpec[] {
  const out: UnitSpec[] = [];
  const excludeSel = opts.exclude?.length ? opts.exclude.join(',') : '';

  const visit = (el: Element) => {
    if (isSkipped(el) || opts.claimed(el)) return;
    if (excludeSel && el.matches(excludeSel)) return;
    const f = opts.filter ? opts.filter(el) : 2;
    if (f === 0) return;
    const children = el.childNodes;
    let hasBlock = false;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.nodeType === 1 && !isOurs(c) && !isSkipped(c as Element) && !isInlineFlow(c as Element)) {
        hasBlock = true;
        break;
      }
    }
    if (!hasBlock) {
      const nodes = Array.from(children).filter((n) => !isOurs(n));
      if (f !== 2 || !meaningful(nodes)) return;
      // 用 <br> 分成好几段的块（很多论坛、课程网站的正文就是这样）：每一段后面跟自己的译文
      const parts = splitAtBreaks(nodes);
      if (parts.length > 1) for (const p of parts) out.push({ root: el, nodes: p, whole: false });
      else out.push({ root: el, nodes, whole: true });
      return;
    }
    let run: Node[] = [];
    const flush = () => {
      if (f === 2 && run.length && meaningful(run) && !run.some(opts.claimed)) {
        for (const p of splitAtBreaks(run)) out.push({ root: el, nodes: p, whole: false });
      }
      run = [];
    };
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.nodeType === 3) run.push(c);
      else if (c.nodeType === 1) {
        const ce = c as Element;
        if (isOurs(ce)) continue;
        if (isSkipped(ce)) {
          flush();
          continue;
        }
        if (isInlineFlow(ce)) run.push(ce);
        else {
          flush();
          visit(ce);
        }
      }
    }
    flush();
  };

  if (opts.include?.length) {
    const seen = new Set<Element>();
    for (const sel of opts.include) {
      root.querySelectorAll(sel).forEach((e) => {
        if (!seen.has(e)) {
          seen.add(e);
          visit(e);
        }
      });
    }
  } else visit(root);
  return out;
}

/* ------------------------------------------------------------------ */
/* 已是目标语言的段落跳过                                                 */
/* ------------------------------------------------------------------ */

export function baseLang(code: string): string {
  return code.toLowerCase().split('-')[0];
}

const RE_HAN = /\p{Script=Han}/gu;
const RE_KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const RE_HANGUL = /\p{Script=Hangul}/gu;
const RE_LETTER = /\p{L}/gu;

function count(re: RegExp, s: string): number {
  re.lastIndex = 0;
  return s.match(re)?.length ?? 0;
}

/** 粗判一段文字是否已经是目标语言。只对中日韩这类能按文字系统区分的语言下结论。 */
export function looksLikeTarget(text: string, target: string, elLang?: string | null): boolean {
  const t = baseLang(target);
  if (elLang && baseLang(elLang) === t) {
    // lang 属性常常写错，只在文字系统也吻合时才信
    if (t !== 'zh' && t !== 'ja' && t !== 'ko') return true;
  }
  const sample = text.slice(0, 400);
  const letters = count(RE_LETTER, sample);
  if (!letters) return true;
  if (t === 'zh') {
    const kana = count(RE_KANA, sample);
    if (kana / letters > 0.05) return false; // 日文
    return count(RE_HAN, sample) / letters > 0.4;
  }
  if (t === 'ja') return count(RE_KANA, sample) / letters > 0.1;
  if (t === 'ko') return count(RE_HANGUL, sample) / letters > 0.4;
  return false;
}
