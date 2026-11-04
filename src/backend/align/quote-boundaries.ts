import type { AlignPair, AlignResult } from '../../shared/protocol';

export interface QuoteBoundary { outer: [number, number]; inner: [number, number] }
export interface QuotePair { source: [number, number]; target: [number, number] }
const functionWords = new Set('a an the am is are was were be been being of and or as in on at to for with by from it its this that these those he she they we you i who which'.split(' '));
export const contentWord = (value: string) => /[\p{L}\p{N}]/u.test(value) && !functionWords.has(value.toLowerCase());
const inside = ([a, b]: [number, number], [x, y]: [number, number]) => a >= x && b <= y;

/** 双引号/中文引号保留UTF16偏移；英文词内撇号不是短语边界。 */
export function quotedSpans(text: string): QuoteBoundary[] {
  const output: QuoteBoundary[] = [];
  for (const pattern of [/"([^"\r\n]+)"/gu, /“([^“”\r\n]+)”/gu, /「([^「」\r\n]+)」/gu, /『([^『』\r\n]+)』/gu, /‘([^‘’\r\n]+)’/gu]) {
    for (const match of text.matchAll(pattern)) output.push({ outer: [match.index!, match.index! + match[0].length], inner: [match.index! + 1, match.index! + match[0].length - 1] });
  }
  return output.sort((a, b) => a.outer[0] - b.outer[0]);
}

/** 两个以上实词锚点支持并且互为唯一最佳才配引号，不能按引号的顺序硬配。 */
export function pairedQuotes(pair: AlignPair, alignment: AlignResult, groups?: QuotePair[]): QuotePair[] {
  const source = quotedSpans(pair.source), target = quotedSpans(pair.target);
  if (!source.length || !target.length || source.length > 128 || target.length > 128) return [];
  const sourceOwners = alignment.srcTokens.map((span) => source.flatMap((quote, index) => inside(span, quote.inner) ? [index] : []));
  const targetOwners = alignment.tgtTokens.map((span) => target.flatMap((quote, index) => inside(span, quote.inner) ? [index] : []));
  const cells = new Map<number, { src: Set<string>; tgt: Set<string> }>();
  // 按真实links累积证据，避免“引号数² × links数”拖慢长段的首次划选。
  for (const [a, b] of alignment.links) {
    const left = pair.source.slice(...alignment.srcTokens[a]!), right = pair.target.slice(...alignment.tgtTokens[b]!);
    if (!contentWord(left) || !contentWord(right)) continue;
    for (const x of sourceOwners[a]!) for (const y of targetOwners[b]!) {
      if (groups && !groups.some((group) => inside(source[x]!.inner, group.source) && inside(target[y]!.inner, group.target))) continue;
      const key = x * target.length + y, cell = cells.get(key) ?? { src: new Set<string>(), tgt: new Set<string>() };
      cell.src.add(left.normalize('NFKC').toLowerCase()); cell.tgt.add(right.normalize('NFKC').toLowerCase()); cells.set(key, cell);
    }
  }
  const score = source.map((_, a) => target.map((_, b) => {
    const cell = cells.get(a * target.length + b);
    return cell && cell.src.size >= 2 && cell.tgt.size >= 2 ? Math.min(cell.src.size, cell.tgt.size) : 0;
  }));
  const output: QuotePair[] = [];
  for (let a = 0; a < source.length; a++) {
    const row = score[a]!, best = Math.max(...row);
    if (best < 2 || row.filter((value) => value === best).length !== 1) continue;
    const b = row.indexOf(best), column = score.map((values) => values[b]!);
    if (column.filter((value) => value >= best).length !== 1) continue;
    output.push({ source: source[a]!.inner, target: target[b]!.inner });
  }
  return output;
}

/** 只限制已被实词证据确认的引号；其余引号保留原有语义链接，不作顺序推测。 */
export function quoteLinkAllowed(source: [number, number], target: [number, number], quotes: QuotePair[]): boolean {
  const role = (span: [number, number], inner: [number, number]) => inside(span, inner) ? 'inside'
    : span[0] === inner[0] - 1 && span[1] === inner[0] ? 'open'
      : span[0] === inner[1] && span[1] === inner[1] + 1 ? 'close' : 'outside';
  return quotes.every((quote) => role(source, quote.source) === role(target, quote.target));
}
