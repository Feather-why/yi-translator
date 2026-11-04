/** 优先按完整句/从句/词分块；代理对和本机恢复标记必须保持完整。 */
export function splitTranslationText(text: string, maxChars: number, language = 'auto'): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('翻译分块上限无效');
  if (text.length <= maxChars) return [text];
  let locale = 'en';
  try { locale = Intl.getCanonicalLocales(language === 'auto' ? 'en' : language)[0] ?? 'en'; } catch { /* 非标准检测语言使用通用断句 */ }
  const protectedSpans = [...text.matchAll(/\[TXP\d+_\d+\]|<\/?[gx]\d+\/?\s*>/g)].map((match) => [match.index!, match.index! + match[0].length] as const);
  const permitted = (position: number) => !protectedSpans.some(([a, b]) => a < position && position < b)
    && !(position > 0 && position < text.length && /[\uD800-\uDBFF]/.test(text[position - 1]!) && /[\uDC00-\uDFFF]/.test(text[position]!));
  const sentences = [...new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(text)].map(({ index, segment }) => index + segment.length);
  const words = [...new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)].map(({ index, segment }) => index + segment.length);
  const clauses = [...text.matchAll(/[;,，；、:]\s*/g)].map((match) => match.index! + match[0].length);
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const limit = Math.min(text.length, start + maxChars);
    const lastBoundary = (boundaries: number[], minimum = start) => boundaries.filter((position) => position > minimum && position <= limit && permitted(position)).at(-1);
    let end = limit === text.length ? limit : lastBoundary(sentences) ?? lastBoundary(clauses, start + maxChars / 3) ?? lastBoundary(words);
    if (end === undefined) {
      end = limit;
      while (end > start && !permitted(end)) end--;
    }
    if (end <= start) throw new Error('翻译原子超过分块上限');
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
