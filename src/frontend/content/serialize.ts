/**
 * 把一段 DOM 变成带占位符的文本，再把译文还原成 DOM。
 *
 *   <p>See <a href="/x">the <b>docs</b></a> at https://a.b/c or run <code>npm i</code>.</p>
 *   → "See <g0>the <g1>docs</g1></g0> at <x2/> or run <x3/>."
 *
 * - <gN>…</gN>：链接、加粗等，译文里用原元素的浅拷贝包住，链接因此仍可点击；
 * - <xN/>：代码、图片、换行、网址等，原样拷贝；纯文本网址在译文里变成可点的链接；
 * - 网址永远取自原文，绝不取自模型输出。
 */
import { isAtom, isInline, isOurs, isOutOfFlow, isSkipped } from './dom';

export type Slot =
  | { kind: 'g'; el: Element }
  | { kind: 'x'; node: Node }
  | { kind: 'u'; url: string; node: Text; end: number };

export interface DomPos {
  node: Text;
  offset: number;
}

export interface Serialized {
  /** 带占位符的文本，发给后端。 */
  text: string;
  /** 下标就是占位符编号（g 与 x 共用编号）。 */
  slots: Slot[];
  /** 与 text 的每个字符对应的 DOM 位置；占位符字符为 null。 */
  pos: (DomPos | null)[];
  /** 不含占位符的可见文字长度。 */
  letters: number;
}

const URL_RE =
  /\b(?:https?:\/\/|www\.)[^\s<>"'，。、；：！？）】》]*[^\s<>"'.,;:!?)\]}，。、；：！？）】》]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

const LEVEL1 = new Set(['B', 'STRONG', 'EM', 'I', 'U', 'MARK', 'S', 'DEL', 'INS', 'SUB', 'SUP', 'Q', 'CITE', 'STRIKE']);
const LEVEL2 = new Set(['SMALL', 'ABBR', 'DFN', 'TIME', 'FONT', 'BIG', 'LABEL', 'BDI', 'DATA']);

function wantsPair(el: Element, level: number): boolean {
  if (el.tagName === 'A') return (el as HTMLAnchorElement).hasAttribute('href') || level >= 2;
  if (level >= 1 && LEVEL1.has(el.tagName)) return true;
  if (level >= 2) {
    if (LEVEL2.has(el.tagName)) return true;
    if (el.tagName === 'SPAN' && (el.hasAttribute('class') || el.hasAttribute('style'))) return true;
  }
  return false;
}

function serializeAt(nodes: Node[], level: number): Serialized & { pairs: number } {
  let text = '';
  const pos: (DomPos | null)[] = [];
  const slots: Slot[] = [];
  let lastSpace = true;
  let pairs = 0;
  let letters = 0;

  const tag = (s: string) => {
    text += s;
    for (let i = 0; i < s.length; i++) pos.push(null);
  };
  const char = (c: string, node: Text, offset: number) => {
    text += c;
    pos.push({ node, offset });
  };
  const emitText = (node: Text, from: number, to: number) => {
    const d = node.data;
    for (let i = from; i < to; i++) {
      const c = d[i];
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f' || c === ' ') {
        if (!lastSpace) {
          char(' ', node, i);
          lastSpace = true;
        }
      } else {
        char(c, node, i);
        lastSpace = false;
        letters++;
      }
    }
  };
  /** 收尾标签前的空格挪到标签后面：「<g0>docs </g0>」→「<g0>docs</g0> 」 */
  const closeTag = (s: string) => {
    const n = text.length;
    if (n && text[n - 1] === ' ' && pos[n - 1]) {
      const p = pos.pop()!;
      text = text.slice(0, -1);
      tag(s);
      char(' ', p.node, p.offset);
    } else tag(s);
  };

  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      const t = node as Text;
      const d = t.data;
      let last = 0;
      URL_RE.lastIndex = 0;
      for (let m = URL_RE.exec(d); m; m = URL_RE.exec(d)) {
        emitText(t, last, m.index);
        const n = slots.push({ kind: 'u', url: m[0], node: t, end: m.index + m[0].length }) - 1;
        tag(`<x${n}/>`);
        lastSpace = false;
        letters += 1;
        last = m.index + m[0].length;
      }
      emitText(t, last, d.length);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (isOurs(el)) return;
    if (isSkipped(el)) {
      // 跳过的元素如果是可见的（例如行内 svg 图标），原样保留
      if (el.localName === 'svg' || el.localName === 'math') {
        const n = slots.push({ kind: 'x', node: el }) - 1;
        tag(`<x${n}/>`);
      }
      return;
    }
    // 绝对 / 固定定位的零件（图表里的刻度线、色块、角标）：位置和高度是相对原来的定位容器算的，
    // 拷进译文后会改成相对整页的某个容器——高度 100% 的 1px 刻度线就成了贯穿整页的一条竖线。
    // 这种原样保留的零件直接不要；成对的标签（链接、加粗）只取里面的文字，不拷外壳。
    if (isAtom(el)) {
      if (el.tagName !== 'BR' && isOutOfFlow(el)) return;
      const n = slots.push({ kind: 'x', node: el }) - 1;
      tag(`<x${n}/>`);
      lastSpace = el.tagName === 'BR' ? true : false;
      return;
    }
    if (wantsPair(el, level) && !isOutOfFlow(el)) {
      const n = slots.push({ kind: 'g', el }) - 1;
      pairs++;
      tag(`<g${n}>`);
      el.childNodes.forEach(walk);
      closeTag(`</g${n}>`);
      return;
    }
    el.childNodes.forEach(walk);
  };

  nodes.forEach(walk);
  while (text.length && text[text.length - 1] === ' ' && pos[pos.length - 1]) {
    text = text.slice(0, -1);
    pos.pop();
  }
  return { text, pos, slots, letters, pairs };
}

/** 行内元素过多时逐级降级：先去掉带样式的 span，再只保留链接。 */
export function serialize(nodes: Node[]): Serialized {
  let s = serializeAt(nodes, 2);
  if (s.pairs > 12) s = serializeAt(nodes, 1);
  if (s.pairs > 20) s = serializeAt(nodes, 0);
  return s;
}

/* ------------------------------------------------------------------ */
/* 还原                                                                 */
/* ------------------------------------------------------------------ */

/** 译文里的链接拷贝 → 页面上的原链接，用于把点击转发给原链接（SPA 路由）。 */
export const linkOrigin = new WeakMap<Element, Element>();

function cleanClone(node: Node, deep: boolean): Node {
  const clone = node.cloneNode(deep);
  if (clone.nodeType !== 1) return clone;
  const el = clone as Element;
  el.removeAttribute('id');
  if (deep) el.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
  const orig = node as Element;
  if (orig.tagName === 'A') {
    linkOrigin.set(el, orig);
    el.setAttribute('data-tx-link', '');
  }
  if (deep) {
    const oa = orig.querySelectorAll('a');
    const ca = el.querySelectorAll('a');
    ca.forEach((a, i) => {
      if (oa[i]) {
        linkOrigin.set(a, oa[i]);
        a.setAttribute('data-tx-link', '');
      }
    });
  }
  return el;
}

function urlNode(url: string, insideLink: boolean): Node {
  const isWeb = /^(?:https?:\/\/|www\.)/i.test(url);
  if (!isWeb || insideLink) return document.createTextNode(url);
  const a = document.createElement('a');
  a.href = /^www\./i.test(url) ? 'https://' + url : url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer nofollow';
  a.className = 'tx-autolink';
  a.textContent = url;
  return a;
}

const TOKEN_RE = /<(\/?)([gx])(\d+)(\/?)>/g;

export interface Restored {
  frag: DocumentFragment;
  /** 所有占位符都按原样对上了。 */
  ok: boolean;
}

/**
 * 把带占位符的译文还原成 DOM 片段。容错：多余或错位的占位符忽略，
 * 丢失的原样内容（代码、网址）和链接补在末尾，保证链接仍可点击。
 */
export function restore(translated: string, ser: Serialized, only?: Set<number>, opts?: { partial?: boolean }): Restored {
  const frag = document.createDocumentFragment();
  const stack: { node: Node; n: number; isLink: boolean }[] = [{ node: frag, n: -1, isLink: false }];
  const used = new Set<number>();
  let ok = true;
  const top = () => stack[stack.length - 1];
  const linkOpen = () => stack.some((s) => s.isLink);
  const appendText = (s: string) => {
    if (s) top().node.appendChild(document.createTextNode(s));
  };

  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(translated); m; m = TOKEN_RE.exec(translated)) {
    appendText(translated.slice(last, m.index));
    last = m.index + m[0].length;
    const [, close, kind, num, self] = m;
    const n = Number(num);
    const slot = ser.slots[n];
    if (!slot || (only && !only.has(n))) {
      ok = false;
      continue;
    }
    if (kind === 'g' && slot.kind === 'g') {
      if (close) {
        const idx = stack.findIndex((s) => s.n === n);
        if (idx > 0) stack.length = idx;
        else ok = false;
      } else if (!self && !used.has(n)) {
        used.add(n);
        const clone = cleanClone(slot.el, false) as Element;
        clone.setAttribute('data-tx-slot', String(n));
        top().node.appendChild(clone);
        stack.push({ node: clone, n, isLink: slot.el.tagName === 'A' });
      } else ok = false;
    } else if (kind === 'x' && self && !close && !used.has(n)) {
      used.add(n);
      const node = slot.kind === 'u' ? urlNode(slot.url, linkOpen()) : slot.kind === 'x' ? cleanClone(slot.node, true) : document.createTextNode('');
      if (node.nodeType === 1) {
        (node as Element).setAttribute('data-tx-slot', String(n));
        if (slot.kind === 'x') (node as Element).setAttribute('data-tx-atom', '');
      }
      else if (slot.kind === 'u') {
        // 纯文本网址：包一层不可见的标记元素，修改译文时才能还原成占位符
        const w = document.createElement('tx-x');
        w.setAttribute('data-tx-slot', String(n));
        w.appendChild(node);
        top().node.appendChild(w);
        continue;
      }
      top().node.appendChild(node);
    } else ok = false;
  }
  appendText(translated.slice(last));
  if (stack.length > 1) ok = false;

  // 流式的中间结果：后面的内容还没生成，不补
  if (opts?.partial) return { frag, ok: false };
  // 补回丢失的内容
  ser.slots.forEach((slot, n) => {
    if (used.has(n) || (only && !only.has(n))) return;
    ok = false;
    if (slot.kind === 'u') {
      frag.append(' ', urlNode(slot.url, false));
    } else if (slot.kind === 'x' && slot.node.nodeType === 1 && (slot.node as Element).tagName !== 'BR') {
      frag.append(' ', cleanClone(slot.node, true));
    } else if (slot.kind === 'g' && slot.el.tagName === 'A' && slot.el.hasAttribute('href')) {
      frag.append(' ', cleanClone(slot.el, true));
    }
  });
  return { frag, ok };
}

/* ------------------------------------------------------------------ */
/* 逐句对照：切句与插入位置                                               */
/* ------------------------------------------------------------------ */

export interface Chunk {
  /** 这一句的带占位符文本（已去掉首尾空格）。 */
  text: string;
  start: number;
  end: number;
  /** 这一句用到的占位符编号。 */
  slots: Set<number>;
}

const segmenters = new Map<string, Intl.Segmenter>();
function sentenceSegmenter(lang?: string): Intl.Segmenter {
  const key = lang || '';
  let s = segmenters.get(key);
  if (!s) {
    s = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' });
    segmenters.set(key, s);
  }
  return s;
}

/**
 * 按句切开。切点只落在占位符嵌套深度为 0 的地方（不会把一个链接切成两半）；
 * 太短的句子（如「Fig. 1.」）并入前一句。
 */
export function splitSentences(ser: Serialized, lang?: string): Chunk[] {
  const text = ser.text;
  const cuts: number[] = [];
  for (const seg of sentenceSegmenter(lang).segment(text)) {
    if (seg.index > 0) cuts.push(seg.index);
  }
  // 计算每个位置的嵌套深度
  const depthAt = new Int16Array(text.length + 1);
  let depth = 0;
  TOKEN_RE.lastIndex = 0;
  let lastIdx = 0;
  // 标签结束处深度才变化：切点落在「</g0>」之前仍算在链接里面
  const marks: [number, number][] = [];
  for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
    if (m[2] === 'g') marks.push([m.index + m[0].length, m[1] ? -1 : 1]);
  }
  for (const [at, delta] of marks) {
    for (let i = lastIdx; i < at; i++) depthAt[i] = depth;
    depth += delta;
    lastIdx = at;
  }
  for (let i = lastIdx; i <= text.length; i++) depthAt[i] = depth;

  const chunks: Chunk[] = [];
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (!t) return;
    const s = start + lead;
    const used = new Set<number>();
    TOKEN_RE.lastIndex = 0;
    for (let m = TOKEN_RE.exec(t); m; m = TOKEN_RE.exec(t)) used.add(Number(m[3]));
    const letters = t.replace(TOKEN_RE, '').replace(/[\s\p{P}\p{N}]/gu, '').length;
    const prev = chunks[chunks.length - 1];
    if (prev && letters < 4) {
      // 并入前一句
      prev.text = text.slice(prev.start, s + t.length);
      prev.end = s + t.length;
      used.forEach((n) => prev.slots.add(n));
    } else chunks.push({ text: t, start: s, end: s + t.length, slots: used });
  };
  for (const c of cuts) {
    if (depthAt[c] !== 0) continue;
    push(c);
    start = c;
  }
  push(text.length);
  return chunks;
}

/**
 * 一句结束处在 DOM 里的插入点：在那里插入 el。
 * 返回被拆开的文本节点（[原节点, 新节点]），供还原时合并。
 */
export function insertAfterChunk(ser: Serialized, chunk: Chunk, el: Element): [Text, Text] | null {
  const tail = ser.text.slice(chunk.start, chunk.end);
  // 以收尾标签结尾：插到那个元素后面
  const closeM = /<\/g(\d+)>$/.exec(tail);
  if (closeM) {
    const slot = ser.slots[Number(closeM[1])];
    if (slot?.kind === 'g' && slot.el.isConnected) {
      slot.el.after(el);
      return null;
    }
  }
  const atomM = /<x(\d+)\/>$/.exec(tail);
  if (atomM) {
    const slot = ser.slots[Number(atomM[1])];
    if (slot?.kind === 'x' && slot.node.isConnected) {
      (slot.node as ChildNode).after(el);
      return null;
    }
    if (slot?.kind === 'u') return splitAndInsert(slot.node, slot.end, el);
  }
  for (let i = chunk.end - 1; i >= chunk.start; i--) {
    const p = ser.pos[i];
    if (p) return splitAndInsert(p.node, p.offset + 1, el);
  }
  return null;
}

function splitAndInsert(node: Text, offset: number, el: Element): [Text, Text] | null {
  if (!node.isConnected) return null;
  if (offset >= node.length) {
    node.after(el);
    return null;
  }
  const rest = node.splitText(offset);
  rest.before(el);
  return [node, rest];
}

/**
 * 用户手动修改译文后，把译文元素里的 DOM 还原成带占位符的文本（链接、代码仍用原来的编号），
 * 用于写入译文记忆。
 */
export function toPlaceholderText(root: Element): string {
  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      out += (n as Text).data;
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    const slot = el.getAttribute('data-tx-slot');
    if (slot === null) {
      if (el.tagName === 'BR') out += ' ';
      el.childNodes.forEach(walk);
      return;
    }
    if (el.localName === 'tx-x' || el.hasAttribute('data-tx-atom') || !el.firstChild || isAtomClone(el)) {
      out += `<x${slot}/>`;
      return;
    }
    out += `<g${slot}>`;
    el.childNodes.forEach(walk);
    out += `</g${slot}>`;
  };
  root.childNodes.forEach(walk);
  return out.replace(/\s+/g, ' ').trim();
}

function isAtomClone(el: Element): boolean {
  return ['CODE', 'KBD', 'SAMP', 'VAR', 'IMG', 'BR', 'SVG', 'svg', 'MATH', 'math'].includes(el.tagName) || el.classList.contains('tx-autolink');
}
