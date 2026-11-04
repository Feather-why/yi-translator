import type { AlignPair, AlignResult } from '../../shared/protocol';

export function wordTokens(text: string, language: string): [number, number][] {
  let locale: string;
  try { locale = Intl.getCanonicalLocales(language === 'auto' ? 'en' : language)[0] ?? 'en'; } catch { locale = 'en'; }
  return Array.from(new Intl.Segmenter(locale, { granularity: 'word' }).segment(text))
    .filter(({ segment }) => segment.trim()).map(({ index, segment }) => [index, index + segment.length]);
}

export function heuristicAlignment(pair: AlignPair): AlignResult {
  const srcTokens = wordTokens(pair.source, pair.sourceLang), tgtTokens = wordTokens(pair.target, pair.targetLang);
  const links: [number, number][] = [];
  srcTokens.forEach(([start, end], src) => {
    const value = pair.source.slice(start, end).normalize('NFKC').toLocaleLowerCase();
    if (!/[\p{L}\p{N}]/u.test(value)) return;
    tgtTokens.forEach(([a, b], tgt) => { if (value === pair.target.slice(a, b).normalize('NFKC').toLocaleLowerCase()) links.push([src, tgt]); });
  });
  return { id: pair.id, srcTokens, tgtTokens, links };
}

/** 用完整前缀定位子词，避免 SentencePiece 把单独标点编码成额外的词首空格。 */
export function tokenPieceRanges(text: string, language: string, encode: (text: string) => number[], prefix = ''): [number, number][] {
  const total = encode(prefix + text).length;
  return wordTokens(text, language).map(([a, b]) => {
    const end = Math.min(total, encode(prefix + text.slice(0, b)).length);
    // 相邻中文词偶尔共享一个子词，保留重叠范围比伪造不存在的子词更可靠。
    const start = Math.max(0, Math.min(end - 1, encode(prefix + text.slice(0, a)).length));
    if (end <= start) throw new Error('无法确定分词字符边界');
    return [start, end];
  });
}

function cosine(a: number[], b: number[]) {
  let dot = 0, aa = 0, bb = 0;
  for (let index = 0; index < a.length; index++) { const x = a[index]!, y = b[index]!; dot += x * y; aa += x * x; bb += y * y; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}

const punctuation = (text: string) => text.normalize('NFKC').replace(/。/g, '.').replace(/、/g, ',').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
const functionMeanings: Record<string, RegExp> = {
  a: /^(?:一|一个|一种|一只|一次|一项|一类|一位|一名|某|某个)$/u,
  an: /^(?:一|一个|一种|一只|一次|一项|一类|一位|一名|某|某个)$/u,
  the: /^(?:这|那|这个|那个|这些|那些|该|此|本)$/u,
  am: /^(?:是|在|正在|为|成为)$/u, is: /^(?:是|在|正在|为|成为|属于)$/u,
  are: /^(?:是|在|正在|为|成为|属于)$/u, was: /^(?:是|在|曾|曾经|原为)$/u,
  were: /^(?:是|在|曾|曾经|原为)$/u, be: /^(?:是|在|为|成为|被)$/u,
  been: /^(?:是|在|过|曾|曾经)$/u, being: /^(?:是|在|正在|被)$/u,
  of: /^(?:的|之)$/u, and: /^(?:和|与|及|并|又|且|而|以及|而且)$/u,
  or: /^(?:或|或者|还是|抑或)$/u, not: /^(?:不|无|非|没|没有|未|否)$/u,
};

/** 词不能被标成逗号；中文省略的英语虚词也不能硬贴到旁边实词上。 */
export function alignmentLinkAllowed(pair: AlignPair, source: [number, number], target: [number, number]): boolean {
  const a = pair.source.slice(...source).normalize('NFKC'), b = pair.target.slice(...target).normalize('NFKC');
  const lexicalSource = /[\p{L}\p{N}]/u.test(a), lexicalTarget = /[\p{L}\p{N}]/u.test(b);
  if (lexicalSource !== lexicalTarget) return false;
  if (!lexicalSource) return punctuation(a) === punctuation(b);
  if (a.toLowerCase() === b.toLowerCase()) return true;
  if (/^[\d.,]+$/u.test(a)) return false;
  const constrained = functionMeanings[a.toLowerCase()];
  return !constrained || (!/^zh(?:-|$)/i.test(pair.targetLang) && !/\p{Script=Han}/u.test(b)) || constrained.test(b);
}

/** 双向最佳匹配加有区分度的单向词组；不为并列未知候选制造对应。 */
export function alignEmbeddings(pair: AlignPair, source: number[][], target: number[][], threshold = 0.15, allowed: (source: [number, number], target: [number, number]) => boolean = () => true): AlignResult {
  const result = heuristicAlignment(pair);
  if (source.length !== result.srcTokens.length || target.length !== result.tgtTokens.length) throw new Error('词向量数量与字符区间不一致');
  const dimension = source[0]?.length ?? target[0]?.length ?? 0;
  if (!dimension || [...source, ...target].some((vector) => vector.length !== dimension || vector.some((value) => !Number.isFinite(value)))) throw new Error('词向量格式无效');
  const scores = source.map((a, src) => target.map((b, tgt) => alignmentLinkAllowed(pair, result.srcTokens[src]!, result.tgtTokens[tgt]!) && allowed(result.srcTokens[src]!, result.tgtTokens[tgt]!) ? cosine(a, b) : -Infinity));
  const best = (row: number[]) => row.reduce((selected, value, index) => value > (row[selected] ?? -Infinity) ? index : selected, 0);
  const forward = scores.map(best);
  const backward = target.map((_, index) => best(scores.map((row) => row[index]!)));
  const margin = (values: number[]) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => b - a);
    return sorted.length > 1 ? sorted[0]! - sorted[1]! : sorted.length ? Infinity : 0;
  };
  const forwardMargin = scores.map(margin);
  const backwardMargin = target.map((_, index) => margin(scores.map((row) => row[index]!)));
  const links = new Set(result.links.filter(([a, b]) => allowed(result.srcTokens[a]!, result.tgtTokens[b]!)).map(([a, b]) => `${a}:${b}`));
  forward.forEach((tgt, src) => {
    const score = scores[src]![tgt]!;
    if (score >= threshold && backward[tgt] === src && Math.max(forwardMargin[src]!, backwardMargin[tgt]!) >= 0.005) links.add(`${src}:${tgt}`);
    // 译文一个词可能属于源端词组，不能要求双向都唯一；但单向必须有清晰的语义差距。
    if (score >= Math.max(threshold, 0.35) && forwardMargin[src]! >= 0.02) links.add(`${src}:${tgt}`);
  });
  backward.forEach((src, tgt) => {
    if (scores[src]![tgt]! >= Math.max(threshold, 0.35) && backwardMargin[tgt]! >= 0.02) links.add(`${src}:${tgt}`);
  });
  const marks = new Set(result.srcTokens.map((span) => pair.source.slice(...span)).filter((text) => !/[\p{L}\p{N}]/u.test(text)).map(punctuation));
  for (const mark of marks) {
    const left = result.srcTokens.map((span, index) => punctuation(pair.source.slice(...span)) === mark ? index : -1).filter((index) => index >= 0);
    const right = result.tgtTokens.map((span, index) => punctuation(pair.target.slice(...span)) === mark ? index : -1).filter((index) => index >= 0);
    if (left.length === right.length) left.forEach((src, index) => { if (allowed(result.srcTokens[src]!, result.tgtTokens[right[index]!]!)) links.add(`${src}:${right[index]}`); });
  }
  result.links = [...links].map((value) => value.split(':').map(Number) as [number, number]);
  return result;
}

export function validAlignment(pair: AlignPair, result: unknown): result is AlignResult {
  if (!result || typeof result !== 'object') return false;
  const value = result as AlignResult;
  const spans = (tokens: unknown, text: string) => Array.isArray(tokens) && tokens.length <= 1024 && tokens.every((token) => Array.isArray(token) && token.length === 2 && Number.isInteger(token[0]) && Number.isInteger(token[1]) && token[0] >= 0 && token[0] < token[1] && token[1] <= text.length);
  return value.id === pair.id && spans(value.srcTokens, pair.source) && spans(value.tgtTokens, pair.target)
    && (value.spans === undefined || (Array.isArray(value.spans) && value.spans.length <= 2048 && value.spans.every((item) => !!item && ['sentence', 'phrase'].includes(item.kind)
      && spans([item.source], pair.source) && spans([item.target], pair.target))))
    && Array.isArray(value.links) && value.links.length <= 100000 && value.links.every((link) => Array.isArray(link) && link.length === 2 && Number.isInteger(link[0]) && Number.isInteger(link[1]) && link[0] >= 0 && link[0] < value.srcTokens.length && link[1] >= 0 && link[1] < value.tgtTokens.length);
}
