import type { AlignPair, AlignResult } from '../../shared/protocol';
import { alignmentLinkAllowed, heuristicAlignment, wordTokens } from './algorithm';
import { contentWord, pairedQuotes, quoteLinkAllowed } from './quote-boundaries';

export interface SentenceGroup { source: [number, number]; target: [number, number] }

/** 保留相对原串的 UTF-16 边界，缩写与小数不会被按单个点粗切。 */
export function sentenceSpans(text: string, language: string): [number, number][] {
  let locale = language === 'auto' ? 'en' : language;
  try { locale = Intl.getCanonicalLocales(locale)[0] ?? 'en'; } catch { locale = 'en'; }
  const result: [number, number][] = [];
  for (const item of new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(text)) {
    const left = item.segment.length - item.segment.trimStart().length;
    const right = item.segment.trimEnd().length;
    if (right <= left) continue;
    const span: [number, number] = [item.index + left, item.index + right];
    const previous = result.at(-1);
    if (previous) {
      const preceding = text.slice(...previous);
      const dangling = /[.!?。！？]["'”’)]*\s*\[$/.test(preceding);
      if (dangling || /[.!?。！？]["'”’)]*$/.test(preceding)) {
        const at = dangling ? previous[1] - 1 : span[0];
        const citation = /^(?:\[\s*(?:\d+[a-z]?|[a-z]|note\s+\d+|citation needed)\s*\]\s*)+/i.exec(text.slice(at));
        if (citation) previous[1] = at + citation[0].trimEnd().length;
      }
      // ICU 会把“句末.[1][2] 下一句”切在第一个左括号后，修正而不改变原串。
      span[0] = Math.max(span[0], previous[1]);
      while (span[0] < span[1] && /\s/.test(text[span[0]]!)) span[0]++;
      if (span[0] >= span[1]) continue;
    }
    if (previous && /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.["'”’)]?$/i.test(text.slice(...previous))) previous[1] = span[1];
    else result.push(span);
  }
  return result;
}

const mass = (text: string) => Math.max(1, [...text.matchAll(/[\p{L}\p{N}]/gu)].length);

/** 单调句配对允许一对多/多对一；长度只用于配句，不把位置匹配伪称语义推理。 */
export function sentenceGroups(pair: AlignPair): SentenceGroup[] {
  const source = sentenceSpans(pair.source, pair.sourceLang), target = sentenceSpans(pair.target, pair.targetLang);
  if (!source.length || !target.length) return [];
  if (source.length === target.length) return source.map((span, index) => ({ source: span, target: target[index]! }));
  if (source.length === 1 || target.length === 1) return [{ source: [source[0]![0], source.at(-1)![1]], target: [target[0]![0], target.at(-1)![1]] }];
  // 极端碎片不建立平方级矩阵；按累计长度单调归组，仍不扩展到整段 token。
  if (source.length * target.length > 40_000) {
    const count = Math.min(source.length, target.length);
    return Array.from({ length: count }, (_, index) => ({
      source: [source[Math.floor(index * source.length / count)]![0], source[Math.floor((index + 1) * source.length / count) - 1]![1]],
      target: [target[Math.floor(index * target.length / count)]![0], target[Math.floor((index + 1) * target.length / count) - 1]![1]],
    }));
  }
  const sourceMass = [0], targetMass = [0];
  for (const span of source) sourceMass.push(sourceMass.at(-1)! + mass(pair.source.slice(...span)));
  for (const span of target) targetMass.push(targetMass.at(-1)! + mass(pair.target.slice(...span)));
  const width = target.length + 1;
  const costs = new Float64Array((source.length + 1) * width).fill(Infinity);
  const previous = new Int32Array(costs.length).fill(-1);
  costs[0] = 0;
  const moves = [[1, 1], [1, 2], [2, 1], [1, 3], [3, 1], [1, 4], [4, 1]] as const;
  for (let src = 0; src <= source.length; src++) for (let tgt = 0; tgt <= target.length; tgt++) {
    const at = src * width + tgt;
    if (!Number.isFinite(costs[at])) continue;
    for (const [a, b] of moves) {
      if (src + a > source.length || tgt + b > target.length) continue;
      const left = (sourceMass[src + a]! - sourceMass[src]!) / sourceMass.at(-1)!;
      const right = (targetMass[tgt + b]! - targetMass[tgt]!) / targetMass.at(-1)!;
      const cost = costs[at]! + Math.abs(Math.log(left / right)) + (a + b - 2) * 0.42;
      const next = (src + a) * width + tgt + b;
      if (cost < costs[next]!) { costs[next] = cost; previous[next] = at; }
    }
  }
  const result: SentenceGroup[] = [];
  let at = costs.length - 1;
  while (at > 0) {
    const before = previous[at]!;
    if (before < 0) return [{ source: [source[0]![0], source.at(-1)![1]], target: [target[0]![0], target.at(-1)![1]] }];
    const a = Math.floor(before / width), b = before % width, c = Math.floor(at / width), d = at % width;
    result.push({ source: [source[a]![0], source[c - 1]![1]], target: [target[b]![0], target[d - 1]![1]] });
    at = before;
  }
  return result.reverse();
}

const inside = ([start, end]: [number, number], [a, b]: [number, number]) => start < b && end > a;

/** 缺句号时，仅凭实词锚点及下一句起首词的真实已知译词拆界，找不到依据就保留原句组。 */
export function semanticSentenceGroups(pair: AlignPair, result: AlignResult): SentenceGroup[] {
  const sourceSentences = sentenceSpans(pair.source, pair.sourceLang), targetSentences = sentenceSpans(pair.target, pair.targetLang);
  const output: SentenceGroup[] = [];
  for (const group of sentenceGroups(pair)) {
    const source = sourceSentences.filter(([a, b]) => a >= group.source[0] && b <= group.source[1]);
    const target = targetSentences.filter(([a, b]) => a >= group.target[0] && b <= group.target[1]);
    if (source.length < 2 || source.length > 16 || target.length !== 1) { output.push(group); continue; }
    const byTarget = new Map<number, Set<number>>();
    const evidence: { source: number; target: number; sentence: number }[] = [];
    for (const [a, b] of result.links) {
      const span = result.srcTokens[a]!, other = result.tgtTokens[b]!;
      const sentence = source.findIndex(([x, y]) => span[0] >= x && span[1] <= y);
      if (sentence < 0 || other[0] < group.target[0] || other[1] > group.target[1]
        || !contentWord(pair.source.slice(...span)) || !contentWord(pair.target.slice(...other))) continue;
      evidence.push({ source: a, target: b, sentence });
      const owners = byTarget.get(b) ?? new Set<number>(); owners.add(sentence); byTarget.set(b, owners);
    }
    const anchors = source.map((_, index) => evidence.filter((item) => item.sentence === index && byTarget.get(item.target)!.size === 1));
    if (anchors.some((items) => new Set(items.map((item) => pair.source.slice(...result.srcTokens[item.source]!).toLowerCase())).size < 2 || new Set(items.map((item) => item.target)).size < 2)) { output.push(group); continue; }
    const boundaries: number[] = [];
    for (let index = 1; index < source.length; index++) {
      const left = Math.max(...anchors[index - 1]!.map((item) => result.tgtTokens[item.target]![1]));
      const right = Math.min(...anchors[index]!.map((item) => result.tgtTokens[item.target]![0]));
      const first = result.srcTokens.findIndex(([a, b]) => a >= source[index]![0] && b <= source[index]![1] && contentWord(pair.source.slice(a, b)));
      if (left > right || first < 0) break;
      const starts = new Set(result.links.filter(([a, b]) => a === first && result.tgtTokens[b]![0] >= left && result.tgtTokens[b]![0] <= right).map(([, b]) => result.tgtTokens[b]![0]));
      if (!starts.size) {
        const word = pair.source.slice(...result.srcTokens[first]!).normalize('NFKC').toLowerCase();
        const aliases = new Set<string>();
        result.srcTokens.forEach((span, token) => {
          if (token === first || pair.source.slice(...span).normalize('NFKC').toLowerCase() !== word) return;
          for (const [a, b] of result.links) if (a === token) {
            const value = pair.target.slice(...result.tgtTokens[b]!);
            if (/^[\p{L}\p{N}]{2,}$/u.test(value)) aliases.add(value);
          }
        });
        for (const alias of aliases) {
          let at = pair.target.indexOf(alias, left);
          while (at >= 0 && at + alias.length <= right) { starts.add(at); at = pair.target.indexOf(alias, at + 1); }
        }
      }
      if (starts.size !== 1) break;
      const at = [...starts][0]!;
      if (at <= (boundaries.at(-1) ?? group.target[0]) || at >= group.target[1]) break;
      boundaries.push(at);
    }
    if (boundaries.length !== source.length - 1) { output.push(group); continue; }
    for (let index = 0; index < source.length; index++) output.push({ source: source[index]!, target: [index ? boundaries[index - 1]! : group.target[0], boundaries[index] ?? group.target[1]] });
  }
  return output;
}

/** 冷启动只返回可验证的字面/词典锚点，未知词宁可不连接。 */
export function sentenceAlignmentFallback(pair: AlignPair): AlignResult {
  return constrainSentenceLinks(pair, heuristicAlignment(pair));
}

/** 移除跨句和词↔标点噪声，不按字符位置制造词语对应。 */
export function constrainSentenceLinks(pair: AlignPair, result: AlignResult, _options: { coverage?: boolean } = {}): AlignResult {
  const groups = semanticSentenceGroups(pair, result), quotes = pairedQuotes(pair, result, groups);
  const links = new Set<string>();
  for (const group of groups) {
    const src = result.srcTokens.map((span, index) => inside(span, group.source) ? index : -1).filter((index) => index >= 0);
    const tgt = result.tgtTokens.map((span, index) => inside(span, group.target) ? index : -1).filter((index) => index >= 0);
    if (!src.length || !tgt.length) continue;
    const sourceSet = new Set(src), targetSet = new Set(tgt);
    const existing = result.links.filter(([a, b]) => sourceSet.has(a) && targetSet.has(b) && alignmentLinkAllowed(pair, result.srcTokens[a]!, result.tgtTokens[b]!)
      && quoteLinkAllowed(result.srcTokens[a]!, result.tgtTokens[b]!, quotes));
    for (const [a, b] of existing) links.add(`${a}:${b}`);
  }
  return { ...result, links: [...links].map((value) => value.split(':').map(Number) as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    spans: [...groups.map((group) => ({ kind: 'sentence' as const, ...group })), ...quotes.map((quote) => ({ kind: 'phrase' as const, ...quote }))] };
}

/** 给模型的局部窗口沿真实词边界切分，不改变最终返回给前端的分词。 */
export function alignmentWindows(pair: AlignPair, maxCharacters = 160): SentenceGroup[] {
  const output: SentenceGroup[] = [];
  const sourceTokens = wordTokens(pair.source, pair.sourceLang), targetTokens = wordTokens(pair.target, pair.targetLang);
  for (const group of sentenceGroups(pair)) {
    const source = sourceTokens.filter((span) => inside(span, group.source)), target = targetTokens.filter((span) => inside(span, group.target));
    const count = Math.max(1, Math.ceil((group.source[1] - group.source[0]) / maxCharacters), Math.ceil((group.target[1] - group.target[0]) / maxCharacters));
    const parts = Math.min(count, source.length, target.length);
    for (let index = 0; index < parts; index++) output.push({
      source: [source[Math.floor(index * source.length / parts)]![0], source[Math.floor((index + 1) * source.length / parts) - 1]![1]],
      target: [target[Math.floor(index * target.length / parts)]![0], target[Math.floor((index + 1) * target.length / parts) - 1]![1]],
    });
  }
  return output;
}
