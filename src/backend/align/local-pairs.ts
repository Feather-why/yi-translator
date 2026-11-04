import type { AlignPair, AlignResult } from '../../shared/protocol';
import { alignEmbeddings, wordTokens } from './algorithm';
import { alignmentWindows, constrainSentenceLinks } from './sentence-alignment';
import { pairedQuotes, quoteLinkAllowed } from './quote-boundaries';

/** 每句/窗口单独做词语义匹配，避免重复词或长段截断把链接带到别的句子。 */
export async function alignSentencePair(pair: AlignPair, embed: (text: string, language: string) => Promise<number[][]>): Promise<AlignResult> {
  const srcTokens = wordTokens(pair.source, pair.sourceLang), tgtTokens = wordTokens(pair.target, pair.targetLang);
  const sourceIndex = new Map(srcTokens.map(([a, b], index) => [`${a}:${b}`, index]));
  const targetIndex = new Map(tgtTokens.map(([a, b], index) => [`${a}:${b}`, index]));
  const links: [number, number][] = [];
  // 仅在这一次请求内复用完全相同的窗口，不跨页面/noCache请求保留正文向量。
  const vectors = new Map<string, number[][]>(); let retained = 0;
  const embedding = async (text: string, language: string) => {
    const key = JSON.stringify([text, language]), existing = vectors.get(key);
    if (existing) { vectors.delete(key); vectors.set(key, existing); return existing; }
    const value = await embed(text, language);
    if (value.length <= 2048) {
      vectors.set(key, value); retained += value.length;
      while (vectors.size > 64 || retained > 2048) {
        const oldest = vectors.keys().next().value!; retained -= vectors.get(oldest)!.length; vectors.delete(oldest);
      }
    }
    return value;
  };
  for (const window of alignmentWindows(pair)) {
    const local: AlignPair = { ...pair, source: pair.source.slice(...window.source), target: pair.target.slice(...window.target) };
    let aligned: AlignResult;
    try {
      const sourceVectors = await embedding(local.source, local.sourceLang), targetVectors = await embedding(local.target, local.targetLang);
      aligned = alignEmbeddings(local, sourceVectors, targetVectors);
      const quotes = pairedQuotes(local, aligned);
      // 用同一份真实向量在可信引号范围内重选词，不把先前错到范围外的词直接丢成空白。
      if (quotes.length) aligned = alignEmbeddings(local, sourceVectors, targetVectors, 0.15, (source, target) => quoteLinkAllowed(source, target, quotes));
    }
    catch (error) {
      if (!(error instanceof Error) || !/token 上限/.test(error.message)) throw error;
      // 单个超长单词无法再沿词界切分，只跳过这一块，其他句子仍使用模型。
      continue;
    }
    for (const [a, b] of aligned.links) {
      const source = aligned.srcTokens[a]!, target = aligned.tgtTokens[b]!;
      const src = sourceIndex.get(`${source[0] + window.source[0]}:${source[1] + window.source[0]}`);
      const tgt = targetIndex.get(`${target[0] + window.target[0]}:${target[1] + window.target[0]}`);
      if (src !== undefined && tgt !== undefined) links.push([src, tgt]);
    }
  }
  return constrainSentenceLinks(pair, { id: pair.id, srcTokens, tgtTokens, links }, { coverage: false });
}
