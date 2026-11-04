import { validTranslation } from './validation';

interface Node {
  name: string;
  kind: 'root' | 'group' | 'atom';
  parent?: string;
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
  children: Node[];
}
interface Parsed { root: Node; nodes: Map<string, Node> }

/** 只修“合法结构里少了原子”，不把损坏的XML或模型添出的标记猜成合法输入。 */
function parse(text: string): Parsed | undefined {
  const root: Node = { name: '', kind: 'root', start: 0, end: text.length, innerStart: 0, innerEnd: text.length, children: [] };
  const stack = [root], nodes = new Map<string, Node>();
  let previous = 0;
  for (const match of text.matchAll(/<[^>]*>/g)) {
    if (text.slice(previous, match.index).includes('<')) return undefined;
    const raw = match[0], end = match.index + raw.length;
    previous = end;
    const token = /^(<\/g(\d+)>|<g(\d+)>|<x(\d+)\/>)$/.exec(raw);
    if (!token) return undefined;
    if (token[2] !== undefined) {
      const group = stack.pop();
      if (!group || group.kind !== 'group' || group.name !== 'g' + token[2]) return undefined;
      group.innerEnd = match.index; group.end = end;
      continue;
    }
    const name = token[3] !== undefined ? 'g' + token[3] : 'x' + token[4];
    if (nodes.has(name)) return undefined;
    const parent = stack[stack.length - 1];
    if (!parent) return undefined;
    const node: Node = { name, kind: token[3] !== undefined ? 'group' : 'atom', parent: parent.name,
      start: match.index, end, innerStart: end, innerEnd: end, children: [] };
    nodes.set(name, node); parent.children.push(node);
    if (node.kind === 'group') stack.push(node);
  }
  if (stack.length !== 1 || text.slice(previous).includes('<')) return undefined;
  // 转义或改写的x标记不是“单纯遗漏”；保留原来的严格重试/降级来处理它。
  if (/&(?:lt|#0*60|#x0*3c);\s*\/?\s*[gx]\d/i.test(text)) return undefined;
  return { root, nodes };
}

const withoutAtoms = (text: string) => text.replace(/<x\d+\/>/g, '');

/** 按字素计算目标距离，再吸附到词边界；不切开代理对、组合字符或ZWJ表情。 */
function insertionBoundary(text: string, fraction: number): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return text.length;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(({ index }) => index);
  graphemes.push(text.length);
  const indices = new Map(graphemes.map((index, order) => [index, order]));
  const candidates = new Set([0, text.length]);
  for (const segment of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) {
    if (indices.has(segment.index)) candidates.add(segment.index);
    const end = segment.index + segment.segment.length;
    if (indices.has(end)) candidates.add(end);
  }
  const wanted = fraction * (graphemes.length - 1);
  let best = 0, distance = Infinity;
  for (const candidate of candidates) {
    const next = Math.abs(indices.get(candidate)! - wanted);
    if (next < distance || next === distance && candidate < best) { best = candidate; distance = next; }
  }
  return best;
}

/**
 * 保留整句译文，仅按原文相对位置补回缺失的<xN/>。现存组/原子是边界锚点；
 * 无法维持父子关系或锚点相对顺序时返回undefined，调用方仍走原来的严格降级。
 * 此函数不规范化、改写或删除任何原文/译文字符。
 */
export function restoreMissingAtoms(source: string, target: unknown): string | undefined {
  if (typeof target !== 'string') return undefined;
  const original = parse(source), translated = parse(target);
  if (!original || !translated) return undefined;
  const missing: Node[] = [];
  for (const node of original.nodes.values()) {
    const other = translated.nodes.get(node.name);
    if (!other) { if (node.kind !== 'atom') return undefined; missing.push(node); }
    else if (other.kind !== node.kind || other.parent !== node.parent) return undefined;
  }
  for (const name of translated.nodes.keys()) if (!original.nodes.has(name)) return undefined;
  if (!missing.length) return validTranslation(source, target) ? target : undefined;
  const edits: { index: number; order: number; text: string }[] = [];
  for (const parent of [original.root, ...original.nodes.values()].filter(node => node.kind !== 'atom')) {
    const translatedParent = parent.kind === 'root' ? translated.root : translated.nodes.get(parent.name)!;
    let left: Node | undefined, pending: Node[] = [];
    const gap = (right?: Node): boolean => {
      if (!pending.length) return true;
      const sourceStart = left?.end ?? parent.innerStart, sourceEnd = right?.start ?? parent.innerEnd;
      const targetStart = left ? translated.nodes.get(left.name)!.end : translatedParent.innerStart;
      const targetEnd = right ? translated.nodes.get(right.name)!.start : translatedParent.innerEnd;
      if (targetStart > targetEnd || translatedParent.children.some(node => node.start >= targetStart && node.end <= targetEnd)) return false;
      const sourceText = withoutAtoms(source.slice(sourceStart, sourceEnd)), targetText = target.slice(targetStart, targetEnd);
      // 不能靠补一个原子来掩盖整块文字也被删掉的模型失败。
      if (sourceText.trim() && !targetText.trim() || !sourceText.trim() && targetText.trim()) return false;
      const count = Array.from(sourceText).length;
      for (const atom of pending) {
        const before = Array.from(withoutAtoms(source.slice(sourceStart, atom.start))).length;
        const offset = insertionBoundary(targetText, count ? before / count : 0);
        edits.push({ index: targetStart + offset, order: atom.start, text: source.slice(atom.start, atom.end) });
      }
      pending = [];
      return true;
    };
    for (const child of parent.children) {
      if (child.kind === 'atom' && !translated.nodes.has(child.name)) pending.push(child);
      else { if (!gap(child)) return undefined; left = child; }
    }
    if (!gap()) return undefined;
  }
  edits.sort((a, b) => a.index - b.index || a.order - b.order);
  const pieces: string[] = []; let previous = 0;
  for (const edit of edits) { pieces.push(target.slice(previous, edit.index), edit.text); previous = edit.index; }
  pieces.push(target.slice(previous));
  const repaired = pieces.join('');
  return validTranslation(source, repaired) ? repaired : undefined;
}
