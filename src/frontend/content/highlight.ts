/**
 * 联动高亮：在原文里划选，译文里对应的词/词组同步高亮；反过来也一样。
 *
 * - 立即：先把对应的整句/整段淡淡地标出来（不需要任何计算）；
 * - 随后：用后端的本地词对齐结果（align:get，后端在译文到达后空闲时预先算好）
 *   把对应的词或词组标亮。鼠标按下时就预取对齐结果，松开时通常已经就绪。
 * - 按住 Alt 把鼠标停在一个词上，不用划选，这个词和另一边对应的词一起亮起来；松开 Alt 就消失。
 * - 用 CSS Custom Highlight API 画高亮，不改页面 DOM。
 */
import type { AlignResult } from '../../shared/protocol';
import { rpc } from '../../shared/rpc';
import { finishReveal } from '../ui/scramble';
import { isOurs } from './dom';
import { MappedText, runBefore, type TextRun } from './text-runs';
import type { PageTranslator, Part, Unit } from './page';

interface TextMap {
  text: string;
  runs: TextRun[];
  first: Map<Text, { start: number; end: number; runStart: number; runEnd: number }>;
  bounds: Map<Element, number>;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

export function buildMap(nodes: Iterable<Node>): TextMap {
  const out = new MappedText(true);
  const first: TextMap['first'] = new Map();
  const bounds: TextMap['bounds'] = new Map();
  const stack = Array.from(nodes).reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (n.nodeType === 3) {
      const t = n as Text;
      const start = out.length, runStart = out.runs.length;
      out.add(t);
      first.set(t, { start, end: out.length, runStart, runEnd: out.runs.length });
    } else if (n.nodeType === 1) {
      const el = n as Element;
      if (el.localName === 'tx-t') bounds.set(el, out.length);
      else if (!isOurs(el) && !SKIP.has(el.tagName)) {
        for (let child = el.lastChild; child; child = child.previousSibling) stack.push(child);
      }
    }
  }
  return { text: out.text(), runs: out.runs, first, bounds };
}

/** 选区端点 → 文本下标。折叠的空白落在下一个保留字符之前。 */
function indexOf(map: TextMap, container: Node, offset: number): number {
  if (container.nodeType === 3) {
    const t = map.first.get(container as Text);
    if (!t) return -1;
    let lo = t.runStart, hi = t.runEnd;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1, r = map.runs[mid];
      if (r.offset + r.end - r.start <= offset) lo = mid + 1;
      else hi = mid;
    }
    if (lo === t.runEnd) return t.end;
    const r = map.runs[lo];
    return r.start + Math.max(0, offset - r.offset);
  }
  const child = container.childNodes[offset] ?? null;
  for (const [t, idx] of map.first) {
    if (child) {
      if (child === t || child.contains(t) || child.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) return idx.start;
    } else if (!container.contains(t) && container.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) return idx.start;
  }
  return -1;
}

function rangeOf(map: TextMap, from: number, to: number): Range | null {
  if (to <= from || from < 0 || to > map.text.length) return null;
  const first = runBefore(map.runs, from + 1), last = runBefore(map.runs, to);
  if (!first || !last) return null;
  const r = document.createRange();
  try {
    r.setStart(first.node, first.offset + from - first.start);
    r.setEnd(last.node, last.offset + to - last.start);
  } catch {
    return null;
  }
  return r;
}

function srcNodes(unit: Unit): Node[] {
  return unit.whole ? Array.from(unit.root.childNodes) : unit.nodes;
}

/** 每个 part 在原文文本里的区间（逐句模式下以译文元素为界）。 */
function spans(unit: Unit, map: TextMap): [number, number][] {
  const out: [number, number][] = [];
  let prev = 0;
  for (const p of unit.parts) {
    const end = map.bounds.get(p.tx) ?? map.text.length;
    out.push([prev, end]);
    prev = end;
  }
  return out;
}

export const highlightSupported = typeof Highlight === 'function' && typeof CSS !== 'undefined' && !!(CSS as any).highlights;

export function setHighlight(name: string, ranges: Range[], priority = 0): void {
  if (!highlightSupported) return;
  if (!ranges.length) {
    CSS.highlights.delete(name);
    return;
  }
  const h = new Highlight(...ranges);
  h.priority = priority;
  CSS.highlights.set(name, h);
}

/** 词下标集合 → 合并相邻的词后转成区间。 */
function tokenRanges(tokens: [number, number][], picked: Set<number>, base: number): [number, number][] {
  const idx = [...picked].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const i of idx) {
    const t = tokens[i];
    if (!t) continue;
    const last = out[out.length - 1];
    if (last && t[0] + base - last[1] <= 1) last[1] = t[1] + base;
    else out.push([t[0] + base, t[1] + base]);
  }
  return out;
}

type Span = NonNullable<AlignResult['spans']>[number];

/** 去掉区间两端的空白（选区常常多带一个空格或换行）。 */
function trimRange(text: string, s: number, e: number): [number, number] {
  while (s < e && /\s/.test(text[s] ?? '')) s++;
  while (e > s && /\s/.test(text[e - 1] ?? '')) e--;
  return [s, e];
}

/**
 * 用后端给的整句 / 短语范围（spans）对应选区：
 * - 只有「完整选中」一个源端句组时才用它的整句范围（选区落在句子里不算）；多句选择只合并完整覆盖的句子；
 * - 引用里的短语要基本正好选中整个短语才用；
 * - 返回：另一边要连续绘制的区间、这一边已被范围覆盖的区间（剩下的部分继续按词对应），以及淡底色用的最小可信句范围。
 * side 是选区所在的一边；坐标都相对于这一段的纯文本（UTF-16）。
 */
function matchSpans(spans: Span[] | undefined, text: string, s: number, e: number, side: 'src' | 'tgt') {
  const out = { other: [] as [number, number][], covered: [] as [number, number][], soft: [] as [number, number][] };
  if (!spans?.length) return out;
  const [ss, se] = trimRange(text, s, e);
  if (se <= ss) return out;
  const mine = (sp: Span) => (side === 'src' ? sp.source : sp.target);
  const theirs = (sp: Span) => (side === 'src' ? sp.target : sp.source);
  const full = (sp: Span) => {
    const [a, b] = trimRange(text, mine(sp)[0], mine(sp)[1]);
    // 句末标点可以没选上
    const end = /[.!?。！？;；]$/.test(text.slice(a, b)) ? b - 1 : b;
    return b > a && ss <= a && se >= end;
  };
  const sentences = spans.filter((sp) => sp.kind === 'sentence');
  for (const sp of sentences) {
    const [a, b] = mine(sp);
    if (b > ss && a < se) out.soft.push(theirs(sp)); // 选区碰到的句子：淡底色只铺这些句子
    if (full(sp)) {
      out.other.push(theirs(sp));
      out.covered.push([a, b]);
    }
  }
  for (const sp of spans) {
    if (sp.kind !== 'phrase') continue;
    const [a, b] = trimRange(text, mine(sp)[0], mine(sp)[1]);
    if (out.covered.some(([x, y]) => a >= x && b <= y)) continue; // 已经在完整选中的句子里
    // 短语：选区和短语基本重合（两头最多多出 2 个字符）
    if (full(sp) && ss >= a - 2 && se <= b + 2) {
      out.other.push(theirs(sp));
      out.covered.push([a, b]);
    }
  }
  return out;
}

export class LinkedHighlighter {
  private cache = new Map<string, Promise<AlignResult | null>>();
  private raf = 0;
  private ticket = 0;

  constructor(private page: PageTranslator) {}

  /** 后台说词对齐变了（重新导入了词典）：下次悬停 / 划选时重新取。 */
  reset(): void {
    this.cache.clear();
  }

  private mouse: [number, number] | null = null;
  private hovering = false;
  private hoverRaf = 0;
  private hoverKey = '';
  private hoverNode: Text | null = null;

  start(): void {
    if (!highlightSupported) return;
    document.addEventListener('selectionchange', this.onSelection);
    document.addEventListener('mousedown', this.onDown, true);
    document.addEventListener('mousemove', this.onMove, { passive: true, capture: true });
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('keyup', this.onKey, true);
    window.addEventListener('blur', this.endHover);
  }

  stop(): void {
    document.removeEventListener('selectionchange', this.onSelection);
    document.removeEventListener('mousedown', this.onDown, true);
    document.removeEventListener('mousemove', this.onMove, true);
    document.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('keyup', this.onKey, true);
    window.removeEventListener('blur', this.endHover);
    this.clear();
  }

  /* ---------------- 按住 Alt 悬停 ---------------- */

  private onMove = (e: MouseEvent) => {
    this.mouse = [e.clientX, e.clientY];
    if (e.altKey && !e.buttons) this.scheduleHover();
    else if (this.hovering) this.endHover();
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Alt') return;
    if (e.type === 'keydown') {
      if (!e.repeat) this.scheduleHover();
    } else if (this.hovering) {
      // 单独按一下 Alt 会让浏览器把焦点移到菜单栏，悬停高亮用过 Alt 时拦下来
      e.preventDefault();
      this.endHover();
    }
  };

  private scheduleHover() {
    if (this.hoverRaf || !this.mouse) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0;
      if (this.mouse) void this.hoverAt(this.mouse[0], this.mouse[1]);
    });
  }

  private endHover = () => {
    if (!this.hovering) return;
    this.hovering = false;
    this.hoverKey = '';
    this.hoverNode = null;
    this.ticket++;
    this.clear();
    // 有划选的话恢复划选的高亮
    this.onSelection();
  };

  private async hoverAt(x: number, y: number): Promise<void> {
    const pos = caretAt(x, y);
    const hit = pos && this.page.locate(pos.node);
    if (!pos || !hit) {
      if (this.hovering) {
        this.ticket++;
        this.hoverKey = '';
        this.hoverNode = null;
        this.clear();
      }
      return;
    }
    const key = `${(pos.node as Text).data?.length}|${pos.offset}`;
    if (this.hovering && pos.node === this.hoverNode && key === this.hoverKey) return;
    this.hovering = true;
    this.hoverKey = key;
    this.hoverNode = pos.node;
    await this.link(hit, pos.node, pos.offset, pos.node, pos.offset + 1, true);
  }

  clear(): void {
    setHighlight('tx-link', []);
    setHighlight('tx-link-soft', []);
  }

  private onSelection = () => {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => void this.update());
  };

  /** 按下鼠标时就开始取对齐结果。 */
  private onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const hit = this.page.locate(e.target as Node);
    if (!hit || !hit.unit.parts.length) return;
    const map = buildMap(srcNodes(hit.unit));
    const sp = spans(hit.unit, map);
    // 逐句模式可能有很多译文。只预取实际按下的这一句，真正的选区仍走 selectionchange。
    let i = hit.part ? hit.unit.parts.indexOf(hit.part) : 0;
    if (!hit.part && hit.unit.parts.length > 1) {
      const at = caretAt(e.clientX, e.clientY);
      if (!at) return;
      const offset = indexOf(map, at.node, at.offset);
      i = sp.findIndex(([start, end]) => offset >= start && offset < end);
    }
    const part = hit.unit.parts[i];
    if (part?.translated) void this.align(part, map.text.slice(sp[i][0], sp[i][1]));
  };

  private targetMap(part: Part): TextMap {
    finishReveal(part.tx);
    return buildMap(part.tx.childNodes);
  }

  private align(part: Part, source: string, target = this.targetMap(part).text): Promise<AlignResult | null> {
    // 正式对齐服务每侧接受至多一万个 UTF-16 字符。超出时保留整句提示，避免重复发送超限消息。
    if (source.length > 10_000 || target.length > 10_000) return Promise.resolve(null);
    // 键里放完整的原文和译文：同样长度的改译、重翻、换服务后都会重新取
    const key = `${part.segId}|${part.stage}|${source}\u0000${target}`;
    let p = this.cache.get(key);
    if (!p) {
      const req = rpc('align:get', {
        pairs: [{ id: part.segId, source, target, sourceLang: 'auto', targetLang: this.page.targetLang }],
      })
        .then((r) => r[0] ?? null)
        .catch(() => null);
      p = req.then((r) => {
        // 失败或空结果不缓存：模型可能还在加载，下次再取
        if (!r || !r.links.length) this.cache.delete(key);
        return r;
      });
      this.cache.set(key, p);
      if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  private async update(): Promise<void> {
    if (this.hovering) return;
    const sel = getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) {
      this.ticket++;
      return this.clear();
    }
    const r = sel.getRangeAt(0);
    const hit = this.page.locate(r.startContainer);
    if (!hit) {
      this.ticket++;
      return this.clear();
    }
    await this.link(hit, r.startContainer, r.startOffset, r.endContainer, r.endOffset, false);
  }

  /**
   * 把一段（划选或鼠标下的那个字）对应到另一边。
   * word=true：只取那个字所在的词，并把这个词自己也标亮（悬停时没有选区作提示）。
   */
  private async link(hit: NonNullable<ReturnType<PageTranslator['locate']>>, sc: Node, so: number, ec: Node, eo: number, word: boolean): Promise<void> {
    const t = ++this.ticket;
    const unit = hit.unit;
    const src = buildMap(srcNodes(unit));
    const sp = spans(unit, src);

    if (hit.side === 'src') {
      const s = indexOf(src, sc, so);
      let e = indexOf(src, ec, eo);
      if (s < 0) return this.clear();
      const pi = Math.max(0, sp.findIndex(([a, b]) => s >= a && s < b));
      const part = unit.parts[pi];
      if (!part?.translated) return this.clear();
      const [a, b] = sp[pi];
      if (e < 0 || e > b) e = b;
      const tgt = this.targetMap(part);
      const soft = document.createRange();
      soft.selectNodeContents(part.tx);
      setHighlight('tx-link-soft', [soft], 0);
      if (!word) setHighlight('tx-link', []);
      const al = await this.align(part, src.text.slice(a, b), tgt.text);
      if (t !== this.ticket || !al) return;
      // 整句 / 短语范围（只在划选时用；Alt 悬停和单词选择保持词级）
      const m = word ? null : matchSpans(al.spans, src.text.slice(a, b), s - a, e - a, 'src');
      if (m?.soft.length) setHighlight('tx-link-soft', m.soft.map(([x, y]) => rangeOf(tgt, x, y)).filter((x): x is Range => !!x), 0);
      const inSpan = (x: number, y: number) => !!m?.covered.some(([c, d]) => x >= c && y <= d);
      const picked = new Set<number>();
      al.srcTokens.forEach(([x, y], i) => {
        if (x + a < e && y + a > s && !inSpan(x, y)) picked.add(i);
      });
      if (word && !picked.size) return setHighlight('tx-link', []);
      const linked = new Set<number>();
      for (const [si, ti] of al.links) if (picked.has(si)) linked.add(ti);
      const ranges = [...(m?.other ?? []), ...tokenRanges(al.tgtTokens, linked, 0)]
        .map(([x, y]) => rangeOf(tgt, x, y))
        .filter((x): x is Range => !!x);
      if (word) ranges.push(...tokenRanges(al.srcTokens, picked, a).map(([x, y]) => rangeOf(src, x, y)).filter((x): x is Range => !!x));
      setHighlight('tx-link', ranges, 1);
    } else {
      const part = hit.part!;
      const pi = unit.parts.indexOf(part);
      if (pi < 0 || !part.translated) return this.clear();
      const [a, b] = sp[pi];
      const tgt = this.targetMap(part);
      const s = indexOf(tgt, sc, so);
      let e = indexOf(tgt, ec, eo);
      if (s < 0) return this.clear();
      if (e < 0) e = tgt.text.length;
      const soft = rangeOf(src, a, b);
      setHighlight('tx-link-soft', soft ? [soft] : [], 0);
      if (!word) setHighlight('tx-link', []);
      const al = await this.align(part, src.text.slice(a, b), tgt.text);
      if (t !== this.ticket || !al) return;
      const m = word ? null : matchSpans(al.spans, tgt.text, s, e, 'tgt');
      if (m?.soft.length) setHighlight('tx-link-soft', m.soft.map(([x, y]) => rangeOf(src, x + a, y + a)).filter((x): x is Range => !!x), 0);
      const inSpan = (x: number, y: number) => !!m?.covered.some(([c, d]) => x >= c && y <= d);
      const picked = new Set<number>();
      al.tgtTokens.forEach(([x, y], i) => {
        if (x < e && y > s && !inSpan(x, y)) picked.add(i);
      });
      if (word && !picked.size) return setHighlight('tx-link', []);
      const linked = new Set<number>();
      for (const [si, ti] of al.links) if (picked.has(ti)) linked.add(si);
      const ranges = [...(m?.other ?? []).map(([x, y]) => [x + a, y + a] as [number, number]), ...tokenRanges(al.srcTokens, linked, a)]
        .map(([x, y]) => rangeOf(src, x, y))
        .filter((x): x is Range => !!x);
      if (word) ranges.push(...tokenRanges(al.tgtTokens, picked, 0).map(([x, y]) => rangeOf(tgt, x, y)).filter((x): x is Range => !!x));
      setHighlight('tx-link', ranges, 1);
    }
  }
}

/** 鼠标下的字：只在真的指着文字时返回（指着空白处返回 null）。 */
function caretAt(x: number, y: number): { node: Text; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  const p = d.caretPositionFromPoint?.(x, y);
  if (p) {
    node = p.offsetNode;
    offset = p.offset;
  } else {
    const r = d.caretRangeFromPoint?.(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (!node || node.nodeType !== 3) return null;
  const t = node as Text;
  // 光标落在两个字之间：看鼠标在前一个字还是后一个字上
  for (const o of [offset, offset - 1]) {
    if (o < 0 || o >= t.length || /\s/.test(t.data[o])) continue;
    const r = document.createRange();
    r.setStart(t, o);
    r.setEnd(t, o + 1);
    for (const b of r.getClientRects()) {
      if (x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 1 && y <= b.bottom + 1) return { node: t, offset: o };
    }
  }
  return null;
}
