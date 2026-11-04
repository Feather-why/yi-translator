import type { DictionaryRow } from './index';

/** RFC 4180 引号内允许逗号、换行和双引号，不能简单按行 split。 */
export function parseEcDictCsv(text: string): DictionaryRow[] {
  if (typeof text !== 'string' || text.length > 150_000_000) throw new Error('ECDICT CSV 过大或格式无效');
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(cell); cell = '';
      if (char !== ',') { if (row.some(Boolean)) rows.push(row); row = []; if (char === '\r' && text[index + 1] === '\n') index++; }
    } else cell += char;
  }
  if (quoted) throw new Error('ECDICT CSV 引号未闭合');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const header = rows.shift(); if (!header) return [];
  const indexOf = (name: string) => header.indexOf(name);
  const word = indexOf('word'), translation = indexOf('translation');
  if (word < 0 || translation < 0) throw new Error('ECDICT CSV 缺少 word/translation 字段');
  const get = (row: string[], name: string) => row[indexOf(name)] ?? '';
  return rows.filter((row) => row[word] && row[translation]).map((row) => ({ word: row[word]!, translation: row[translation]!,
    phonetic: get(row, 'phonetic'), definition: get(row, 'definition'), exchange: get(row, 'exchange'), tag: get(row, 'tag'),
    collins: Number(get(row, 'collins')) || undefined, oxford: get(row, 'oxford') === '1' }));
}
