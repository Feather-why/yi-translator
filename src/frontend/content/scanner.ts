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
  let lineStart = 0;
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
    // 前面软换行的位置已经检查过句末，若当时有标点就已经分段。只读刚走过的一行。
    const before = textOf(nodes.slice(lineStart, i)).trimEnd();
    const after = textOf(nodes.slice(j, j + 3));
    if (cur.length && (brs >= 2 || END_PUNCT.test(before) || ITEM_START.test(after))) {
      groups.push(cur);
      cur = [];
    } else if (cur.length) {
      for (let k = i; k < j; k++) cur.push(nodes[k]);
    }
    lineStart = j;
    i = j;
  }
  if (cur.length) groups.push(cur);
  const real = groups.filter(meaningful);
  return real.length > 1 ? real : [nodes];
}

export function hasBlockChild(el: Element): boolean {
  for (const child of el.children) {
    if (!isSkipped(child) && !isInlineFlow(child)) return true;
  }
  return false;
}

/** 每遇到一个子树或段落就交还控制权；调用方可以在节点之间暂停。 */
export function* scanSteps(root: Element, opts: ScanOptions): Generator<UnitSpec | null> {
  const excludeSel = opts.exclude?.join(',') ?? '';
  type ScanItem = Element | UnitSpec;

  function* visit(el: Element): Generator<ScanItem> {
    if (isSkipped(el) || opts.claimed(el) || (excludeSel && el.matches(excludeSel))) return;
    const f = opts.filter ? opts.filter(el) : 2;
    if (f === 0) return;
    // 扫描可跨多个浏览器任务；快照不会因中途插入译文或网页删除兄弟节点而错位。
    const children = Array.from(el.childNodes);
    if (!hasBlockChild(el)) {
      const nodes = children.filter((n) => !isOurs(n));
      if (f !== 2 || !meaningful(nodes)) return;
      const parts = splitAtBreaks(nodes);
      for (const part of parts) {
        if (!part.some(opts.claimed)) yield { root: el, nodes: part, whole: parts.length === 1 };
      }
      return;
    }
    let run: Node[] = [];
    function* flush(): Generator<UnitSpec> {
      if (f === 2 && run.length && meaningful(run) && !run.some(opts.claimed)) {
        for (const nodes of splitAtBreaks(run)) yield { root: el, nodes, whole: false };
      }
      run = [];
    }
    for (const child of children) {
      if (child.parentNode !== el) continue;
      if (child.nodeType === 3) run.push(child);
      else if (child.nodeType === 1) {
        const element = child as Element;
        if (isOurs(element)) continue;
        if (isSkipped(element)) { yield* flush(); continue; }
        if (isInlineFlow(element)) run.push(element);
        else {
          yield* flush();
          yield element;
        }
      }
    }
    yield* flush();
  }

  const canEnter = (el: Element) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (isSkipped(p) || opts.claimed(p) || (excludeSel && p.matches(excludeSel))) return false;
    }
    return true;
  };
  if (!canEnter(root)) return;
  const includeSel = opts.include?.join(',');
  const roots = includeSel && !root.closest(includeSel)
    ? Array.from(root.querySelectorAll(includeSel)).filter(el => !el.parentElement?.closest(includeSel) && canEnter(el))
    : [root];
  const stack: Iterator<ScanItem>[] = [roots.values()];
  // 用迭代器栈保留下一项的位置。深层页面不会把浏览器的调用栈填满。
  while (stack.length) {
    const next = stack[stack.length - 1].next();
    if (next.done) { stack.pop(); continue; }
    if ('nodeType' in next.value) {
      stack.push(visit(next.value));
      yield null;
    } else yield next.value;
  }
}

export function scan(root: Element, opts: ScanOptions): UnitSpec[] {
  return Array.from(scanSteps(root, opts)).filter((unit): unit is UnitSpec => unit !== null);
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
