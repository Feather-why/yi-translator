import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const revision = '39cfb9672c0906b63569e0453c2e6abfb9ab182a';
const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const limit = Number(option('--limit', '100000'));
if (!Number.isSafeInteger(limit) || limit < 1000 || limit > 1000000) throw new Error('--limit 必须为 1000 到 1000000');
const csvPath = path.resolve(option('--csv', path.join(root, 'work/ecdict.csv')));
const output = path.resolve(option('--out', path.join(root, 'public/dict')));
if (args.includes('--download')) {
  const response = await fetch(`https://raw.githubusercontent.com/skywind3000/ECDICT/${revision}/ecdict.csv`);
  if (!response.ok) throw new Error(`下载 ECDICT 失败：HTTP ${response.status}`);
  await fs.mkdir(path.dirname(csvPath), { recursive: true });
  await fs.writeFile(csvPath, Buffer.from(await response.arrayBuffer()));
}

export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
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
  if (quoted) throw new Error('CSV 引号未闭合');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const csv = await fs.readFile(csvPath);
const rows = parseCsv(csv.toString('utf8').replace(/^\uFEFF/, ''));
const header = rows.shift();
const column = (name) => { const index = header.indexOf(name); if (index < 0) throw new Error(`CSV 缺少 ${name}`); return index; };
const columns = ['word', 'phonetic', 'translation', 'definition', 'exchange', 'tag', 'collins', 'oxford', 'bnc', 'frq'].map(column);
const rank = (value) => Number(value) > 0 ? Number(value) : 10000000;
const candidates = rows.filter((row) => row[columns[0]] && row[columns[2]] && row[columns[0]].length <= 100)
  .map((row) => ({ rank: Math.min(rank(row[columns[8]]), rank(row[columns[9]])), row: columns.slice(0, 8).map((index) => row[index] || '') }));
candidates.sort((a, b) => a.rank - b.rank || Number(b.row[6]) - Number(a.row[6]) || a.row[0].localeCompare(b.row[0]));
const entries = []; const unique = new Set();
for (const { row } of candidates) {
  const word = row[0].normalize('NFKC').trim().toLowerCase();
  if (!word || unique.has(word)) continue;
  unique.add(word); entries.push(row); if (entries.length >= limit) break;
}
const source = `https://github.com/skywind3000/ECDICT/tree/${revision}`;
const json = Buffer.from(JSON.stringify({ version: 1, source, revision, count: entries.length, entries }));
const gzip = gzipSync(json, { level: 9 });
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'ecdict-100k.json.gz'), gzip);
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ version: 1, source, revision, license: 'MIT', count: entries.length,
  columns: ['word', 'phonetic', 'translation', 'definition', 'exchange', 'tag', 'collins', 'oxford'],
  csvSha256: createHash('sha256').update(csv).digest('hex'), gzipSha256: createHash('sha256').update(gzip).digest('hex'),
  compressedBytes: gzip.length, jsonBytes: json.length }, null, 2) + '\n');
const license = await fetch(`https://raw.githubusercontent.com/skywind3000/ECDICT/${revision}/LICENSE`);
if (!license.ok) throw new Error('无法获取必须随词典分发的许可证');
await fs.writeFile(path.join(output, 'LICENSE-ECDICT.txt'), await license.text());
console.log(`ECDICT: ${entries.length} 条，压缩后 ${(gzip.length / 1024 / 1024).toFixed(2)} MiB，来源 ${revision}`);
