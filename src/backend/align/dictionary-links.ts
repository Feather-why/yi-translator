import type { AlignPair, AlignResult, DictEntry } from '../../shared/protocol';
import { sentenceGroups } from './sentence-alignment';
import { pairedQuotes, quoteLinkAllowed } from './quote-boundaries';
export interface AlignmentDictionary { lookup(word: string, lang: string, targetLang: string): Promise<DictEntry | null>; status?(): { ready: boolean; revision?: number } }

function english(pair: AlignPair): boolean {
  if (/^en(?:-|$)/i.test(pair.sourceLang)) return true;
  if (pair.sourceLang !== 'auto') return false;
  const letters = [...pair.source.matchAll(/\p{L}/gu)];
  if (!letters.length || letters.filter(([letter]) => /[A-Za-z]/.test(letter)).length / letters.length < 0.8) return false;
  const words = pair.source.match(/[A-Za-z]+/g) ?? [];
  // auto 是前端的常见输入；只有词典的完整中文词义实际出现在对应句时才加锚点。
  return words.length > 0;
}

/** 词典命中的完整词组优先，避免把“browser”只连到“浏览器”的“器”。 */
export async function refineWithDictionary(pair: AlignPair, alignment: AlignResult, dictionary?: AlignmentDictionary): Promise<AlignResult> {
  if (!dictionary || !english(pair) || !/^zh(?:-|$)/i.test(pair.targetLang)) return alignment;
  const groups = sentenceGroups(pair);
  const quotes = pairedQuotes(pair, alignment, groups);
  const lookups = new Map<string, Promise<DictEntry | null>>();
  for (const [a, b] of alignment.srcTokens.slice(0, 160)) {
    const word = pair.source.slice(a, b);
    if (/^[A-Za-z][A-Za-z'-]*$/.test(word) && !lookups.has(word.toLowerCase())) lookups.set(word.toLowerCase(), Promise.resolve().then(() => dictionary.lookup(word, 'en', pair.targetLang)).catch(() => null));
  }
  await Promise.all(lookups.values());
  const candidates: { source: number; target: number[]; score: number }[] = [];
  for (let source = 0; source < Math.min(alignment.srcTokens.length, 160); source++) {
    const word = pair.source.slice(...alignment.srcTokens[source]!);
    if (!/^[A-Za-z][A-Za-z'-]*$/.test(word)) continue;
    const group = groups.find(({ source: [a, b] }) => alignment.srcTokens[source]![0] >= a && alignment.srcTokens[source]![0] < b);
    if (!group) continue;
    const targetText = pair.target.slice(...group.target);
    const modelTargets = new Set(alignment.links.filter(([index]) => index === source).map(([, index]) => index));
    const repeated = alignment.srcTokens.filter(([a, b]) => a >= group.source[0] && a < group.source[1] && pair.source.slice(a, b).toLowerCase() === word.toLowerCase()).length > 1;
    const entry = await lookups.get(word.toLowerCase());
    const meanings = new Set(entry?.translations.flatMap((line) => line.split(/[,;，；]/).map((part) => part.replace(/^\s*(?:(?:\[[^\]]+\]|[a-z]+\.)\s*)+/i, '').trim())
      .filter((part) => /^[\p{Script=Han}]{1,12}$/u.test(part))) ?? []);
    for (const meaning of [...meanings]) if (meaning.length > 2 && /[的地]$/u.test(meaning)) meanings.add(meaning.slice(0, -1));
    // 老词库的“浏览程序”和现代译文“浏览器”可共享词干；只扩展页面里实际存在的构词后缀。
    for (const meaning of [...meanings]) {
      const prefix = meaning.slice(0, 2);
      if (prefix.length === 2) {
        const at = targetText.indexOf(prefix);
        const suffix = at >= 0 ? targetText[at + prefix.length] : undefined;
        if (suffix && /^[器者性化法学术机式子]$/u.test(suffix)) meanings.add(prefix + suffix);
      }
      if (meaning.length === 1 && targetText.includes(meaning + '子')) meanings.add(meaning + '子');
      if (meaning.length === 1) for (const [a, b] of alignment.tgtTokens) {
        if (a < group.target[0] || b > group.target[1]) continue;
        const token = pair.target.slice(a, b);
        if (new RegExp(`^[小大老新旧红黑白]${meaning}$`, 'u').test(token)) meanings.add(token);
      }
    }
    for (const phrase of meanings) {
      let position = pair.target.indexOf(phrase, group.target[0]);
      while (position >= 0) {
        const end = position + phrase.length;
        if (end > group.target[1]) break;
        const indices = alignment.tgtTokens.map(([a, b], index) => b > position && a < end ? index : -1).filter((index) => index >= 0);
        if (indices.some((index) => !quoteLinkAllowed(alignment.srcTokens[source]!, alignment.tgtTokens[index]!, quotes))) { position = pair.target.indexOf(phrase, position + 1); continue; }
        if (indices.length) {
          const exact = alignment.tgtTokens[indices[0]!]![0] === position && alignment.tgtTokens[indices.at(-1)!]![1] === end;
          // “小”不能抢走“狗→小狗”的整个词区间，单字释义只接受完整分词。
          if (phrase.length === 1 && !exact) { position = pair.target.indexOf(phrase, position + 1); continue; }
          const supported = indices.some((index) => modelTargets.has(index));
          // 重复术语不能按出现顺序硬分配；只扩展该次出现已有的语义证据。
          if (repeated && !supported) { position = pair.target.indexOf(phrase, position + 1); continue; }
          candidates.push({ source, target: indices, score: phrase.length * 10 + (exact ? 2 : 0) + (supported ? 100 : 0) });
        }
        position = pair.target.indexOf(phrase, position + 1);
      }
    }
  }
  const alternatives = new Map<number, Set<string>>();
  for (const candidate of candidates) {
    const values = alternatives.get(candidate.source) ?? new Set<string>();
    values.add(candidate.target.join(',')); alternatives.set(candidate.source, values);
  }
  // 先固定 auditory→听觉 这样的唯一义项，acoustic 再从剩余“声学/听觉”中消歧。
  candidates.sort((a, b) => alternatives.get(a.source)!.size - alternatives.get(b.source)!.size || b.score - a.score);
  const sourceClaims = new Set<number>(), targetClaims = new Set<number>();
  const added: [number, number][] = [];
  for (const candidate of candidates) {
    if (sourceClaims.has(candidate.source) || candidate.target.some((index) => targetClaims.has(index))) continue;
    sourceClaims.add(candidate.source);
    for (const target of candidate.target) { targetClaims.add(target); added.push([candidate.source, target]); }
  }
  return { ...alignment, links: [...alignment.links.filter(([source, target]) => !sourceClaims.has(source) && !targetClaims.has(target)), ...added].sort((a, b) => a[0] - b[0] || a[1] - b[1]) };
}
