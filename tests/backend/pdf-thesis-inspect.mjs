/** 本机只读检查：不上传PDF、不调用翻译，输出布局统计而非整本正文。 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const input = process.env.SOURCE_PDF || process.argv[2];
assert.ok(input, '请通过 SOURCE_PDF 或第一个命令行参数提供本机 PDF；不会自动读取个人文档。');
const source = path.resolve(input);
const sourceRoot = path.resolve(process.env.SOURCE_ROOT || root);
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work/pdf-thesis-inspect'));
const scratch = path.join(root, 'work/pdf-thesis-inspect-runtime');
await mkdir(output, { recursive: true }); await mkdir(scratch, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['src/frontend/pdf/layout.ts', 'src/frontend/pdf/reader.ts', 'src/frontend/content/scanner.ts'];
const before = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, hash(await readFile(path.join(sourceRoot, file)))])));
// 只编译现有布局代码到临时目录，原文件保持不动，PDF不进入构建或repo fixture。
await build({ configFile: false, root, logLevel: 'warn', publicDir: false,
  build: { outDir: scratch, emptyOutDir: false, target: 'esnext', lib: { entry: path.join(sourceRoot, 'src/frontend/pdf/layout.ts'), formats: ['es'], fileName: () => 'layout.mjs' }, rolldownOptions: { external: ['pdfjs-dist'] } } });
const { extractLayout } = await import(pathToFileURL(path.join(scratch, 'layout.mjs')).href + '?v=' + before[sourceFiles[0]]);
// 所有依赖与字体都是本机文件，任何意外网络读取直接失败。
globalThis.fetch = async () => { throw new Error('Read-only thesis inspection prohibits network access'); };
const bytes = await readFile(source), metadata = await stat(source);
const pdfPackage = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true,
  cMapUrl: path.join(pdfPackage, 'cmaps').replaceAll('\\', '/') + '/', cMapPacked: true,
  standardFontDataUrl: path.join(pdfPackage, 'standard_fonts').replaceAll('\\', '/') + '/',
  wasmUrl: path.join(pdfPackage, 'wasm').replaceAll('\\', '/') + '/' });
const doc = await loading.promise;
const report = { inspectedAt: new Date().toISOString(), sourceFile: 'provided-document.pdf', sourceBytes: metadata.size, sourceSha256: hash(bytes), pages: doc.numPages,
  exceedsBackend25MiB: bytes.length > 25 * 1024 * 1024, frontendHashes: before, pageReports: [], noNetwork: true, noTranslation: true };
const preview = (text, limit = 90) => text.replace(/\s+/g, ' ').trim().slice(0, limit);
const round = (value) => Math.round(value * 100) / 100;
const compactPara = (para) => ({ id: para.id, kind: para.kind, chars: para.text.length,
  textLetterRatio: round((para.text.replace(/<x\d+\/>/g, '').match(/\p{L}/gu) ?? []).length / Math.max(1, para.text.replace(/<x\d+\/>/g, '').length)),
  lineCount: para.lines.length, fs: round(para.fs), pitch: round(para.pitch),
  box: [para.x0, para.y0, para.x1, para.y1].map(round), align: para.align, bold: para.bold, atoms: para.atoms.length });
try {
  const labels = await doc.getPageLabels();
  const outline = await doc.getOutline();
  const outlineRows = [];
  for (const entry of outline || []) {
    const destination = typeof entry.dest === 'string' ? await doc.getDestination(entry.dest) : entry.dest;
    const page = destination?.[0] ? await doc.getPageIndex(destination[0]) + 1 : null;
    outlineRows.push({ title: preview(entry.title), page, label: page ? labels?.[page - 1] : null });
  }
  report.outline = outlineRows;
  let refsFrom = Infinity;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n), tc = await page.getTextContent();
    // 与reader先render后的状态一致地加载字体元数据，不为全论文生成图像。
    await page.getOperatorList({ intent: 'print' });
    const layout = await extractLayout(page, 'zh-CN');
    const plain = tc.items.filter((item) => 'str' in item).map((item) => item.str).join(' ');
    const links = (await page.getAnnotations({ intent: 'display' })).filter((annotation) => annotation.subtype === 'Link');
    const references = layout.paras.filter((para) => /^\s*(\d+\.?\s*)?(references|bibliography|literature cited|参考文献)\s*$/i.test(para.text.replace(/<x\d+\/>/g, '')));
    if (layout.references) refsFrom = Math.min(refsFrom, n);
    const counts = Object.fromEntries(['body', 'heading', 'caption', 'skip'].map((kind) => [kind, layout.paras.filter((para) => para.kind === kind).length]));
    const eligible = layout.paras.filter((para) => para.kind !== 'skip');
    const pageReport = { page: n, label: labels?.[n - 1] ?? String(n), hasText: layout.hasText, rawItems: tc.items.filter((item) => 'str' in item && item.str.trim()).length,
      rawChars: plain.length, width: round(layout.width), height: round(layout.height), counts, eligible: eligible.length,
      layoutReferences: layout.references, references: references.map((para) => ({ ...compactPara(para), text: para.text })),
      readerRefsFromIfSequential: Number.isFinite(refsFrom) ? refsFrom : null,
      readerWouldSendIfSequential: n > refsFrom ? 0 : eligible.length,
      internalLinks: links.filter((link) => link.dest).length,
      headings: layout.paras.filter((para) => para.kind === 'heading').slice(0, 6).map((para) => ({ ...compactPara(para), text: preview(para.text) })),
      paragraphGeometry: layout.paras.map(compactPara),
    };
    if (n <= 17 || [18, 19, ...outlineRows.map((entry) => entry.page)].includes(n)) {
      pageReport.relevantParagraphs = layout.paras.filter((para) => n <= 17 || para.kind === 'heading').map((para) => ({ ...compactPara(para), text: preview(para.text, n === 9 ? 150 : 95),
        lines: para.lines.map((line) => ({ text: preview(line.items.map((item) => item.str).join(''), 100), box: [line.x0, line.y0, line.x1, line.y1].map(round), base: round(line.base), fs: round(line.fs), tabular: !!line.tabular })) }));
    }
    report.pageReports.push(pageReport); page.cleanup();
    if (n % 10 === 0 || layout.references) console.log(JSON.stringify({ page: n, label: pageReport.label, eligible: eligible.length, references: layout.references, refsFrom: Number.isFinite(refsFrom) ? refsFrom : null }));
  }
  report.firstReferenceFlagPage = Number.isFinite(refsFrom) ? refsFrom : null;
  report.referencesFlagPages = report.pageReports.filter((page) => page.layoutReferences).map((page) => ({ page: page.page, label: page.label }));
  report.eligibleButGloballySuppressedPages = report.pageReports.filter((page) => page.eligible > 0 && page.readerWouldSendIfSequential === 0).map((page) => ({ page: page.page, label: page.label, eligible: page.eligible }));
  report.pagesWithoutText = report.pageReports.filter((page) => !page.hasText).map((page) => ({ page: page.page, label: page.label }));
  assert.deepEqual(Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, hash(await readFile(path.join(sourceRoot, file)))]))), before);
  assert.equal(hash(await readFile(source)), report.sourceSha256);
  assert.equal((await stat(source)).size, metadata.size);
  report.ok = true;
  console.log(JSON.stringify({ ok: true, pages: report.pages, firstReferenceFlagPage: report.firstReferenceFlagPage, referenceFlagPages: report.referencesFlagPages, suppressedPages: report.eligibleButGloballySuppressedPages.length, pagesWithoutText: report.pagesWithoutText }));
} finally {
  await writeFile(path.join(output, 'pdf-thesis-inspect.json'), JSON.stringify(report, null, 2));
  await loading.destroy();
}
