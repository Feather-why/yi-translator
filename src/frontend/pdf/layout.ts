/**
 * PDF 版面分析（前端，用 PDF.js 的文本层）：把一页里的文字分成段落，并判断哪些该翻译。
 *
 * - 文字项 → 行：基线相近、水平相连（间隔大于 1.2 个字高就断开，所以双栏不会连成一行）；
 * - 行 → 段落：字号相近、上下间距不超过约一个字高、水平范围重叠或左对齐；
 *   上一行明显没写满（远短于这一栏的宽度）时是硬换行，不合并——日期 / 署名、地址、诗行等各自成段；
 * - 目录页：每一条单独成段，只翻标题，编号、点线和页码原样保留；
 * - 对齐：按每一行的左右边缘判断，不按整段外框离页面中心多远（两端对齐的正文外框也接近居中）；
 * - 不翻译、原样保留：公式（数学字体或符号占比高）、表格单元格、纯数字（页码等）、
 *   已是目标语言的文字、单独一行的人名，以及参考文献区（范围由 scanSections 整本预先算好，和滚动顺序无关）；
 * - 段落里夹的数学字体片段换成 <xN/> 占位，译文里再把原图裁下来嵌回去。
 *
 * 坐标单位都是页面 scale=1 的 PDF 点，原点在左上角。
 */
import { Util, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import { looksLikeTarget } from '../content/scanner';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Item extends Box {
  str: string;
  fs: number;
  base: number;
  math: boolean;
  bold: boolean;
  italic: boolean;
  serif: boolean;
}

export interface Line extends Box {
  items: Item[];
  fs: number;
  base: number;
  tabular?: boolean;
  /** 目录条目的拆分（只在目录页上有）。 */
  toc?: TocParts;
}

interface TocParts {
  /** 标题文字的范围（不含编号、点线、页码）。 */
  title: Box;
  titleText: string;
  /** 译文最多能写到哪里（页码左边留一点空）。 */
  limit: number;
  hasPage: boolean;
}

export interface Atom extends Box {
  text: string;
}

export type ParaKind = 'body' | 'heading' | 'caption' | 'toc' | 'skip';

export interface Para extends Box {
  id: string;
  lines: Line[];
  /** 发给翻译的文本，公式片段已换成 <xN/>。 */
  text: string;
  atoms: Atom[];
  fs: number;
  /** 行距（相邻两行基线的距离）。 */
  pitch: number;
  kind: ParaKind;
  bold: boolean;
  serif: boolean;
  align: 'justify' | 'left' | 'center' | 'right';
  /** 首行缩进（PDF 点）；负数是悬挂缩进（项目符号、编号列表）。 */
  indent?: number;
  /** 目录条目：译文只写在标题的位置，最多写到 limit（页码前），单行。 */
  toc?: { limit: number };
  /** 表格里的单行格子：译文单行，最多写到 limit（右边下一个格子前）。 */
  cell?: { limit: number };
  /** 不翻译的原因（统计、调试用）。 */
  reason?: string;
}

export interface PageLayout {
  width: number;
  height: number;
  hasText: boolean;
  paras: Para[];
  /** 本页出现了真正的「参考文献」标题（目录里的那一条不算）。 */
  references: boolean;
  /** 这一页是目录页。 */
  toc: boolean;
}

/** 参考文献区在某一页上的纵向范围：y0 落在 [start, end) 之间的段落是文献条目。 */
export interface RefZone {
  start: number;
  end: number;
}

const MATH_FONT = /CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|Math|Symbol|STIX|Euclid|rsfs|wasy|esint|txsy|pxsy|MT ?Extra/i;
const BOLD_FONT = /Bold|Black|Heavy|Semibold|Demi|CMBX|CMB10/i;
const ITALIC_FONT = /Italic|Oblique|-It\b|It$|CMMI|CMTI|CMBXTI/i;
/** Unicode 的数学字母（𝑁、𝐱、𝜃……）：只会是公式里的符号。 */
const MATH_ALNUM = /[\u{1D400}-\u{1D7FF}]/u;
/** 公式里常出现、但本身不是要翻译的正文的词（行间公式左边的 min、subject to……）。 */
const MATH_WORDS = new Set('min max minimize maximize minimise maximise argmin argmax arg subject to s.t. st sup inf lim liminf limsup exp log ln sin cos tan sinh cosh tanh det diag tr trace rank sign sgn sat mod var cov where for all and if otherwise with such that s t'.split(' '));
const SERIF_FONT = /Times|Roman|CMR|CMBX|CMTI|Nimbus|Serif|Garamond|Palatino|Minion|Libertine|Georgia|Cambria|Utopia|Charter|Baskerville|Bookman|Century|LMRoman|Computer Modern/i;
const MATH_CHARS = /[=+\-−×÷±∓∑∏∫∮√∞≈≠≤≥∈∉⊂⊃∪∩∀∃∂∇αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ^_|‖⟨⟩·∘→←↔⇒⇔]/g;
export const REFS = /^\s*((\d+|[A-Z])(\.\d+)*\.?\s*)?(references|bibliography|literature cited|works cited|参考文献)\s*$/i;
const MAJOR = /^\s*(appendix|appendices|附录|chapter\s+\d+|index|索引)\b/i;
const CAPTION = /^(fig\.?|figure|table|tab\.|algorithm|listing)\s*[\dIVX]+/i;
const PAGE_NO = /^(\d{1,4}|[ivxlcdm]{1,8})$/i;
const LEADER = /^[\s.·…_\-‧∙]+$/;
const SECTION_NO = /^((\d+|[A-Z])(\.\d+)*\.?|[IVX]+\.)$/;
/** 「单独一行的人名」判断时排除的常见标题词。 */
const TITLE_WORDS = new Set(
  ('abstract acknowledgements acknowledgments appendix background chapter conclusion conclusions contents discussion ' +
    'figure figures future introduction list method methods methodology overview part preface references related ' +
    'results section summary table tables theory work learning analysis model models system systems design data ' +
    'experiments evaluation implementation and of the for in on with to a an thesis master masters degree project ' +
    'report final university institute school department faculty engineering science sciences technology computer ' +
    'electrical mechanical royal college program programme course lab laboratory paper draft version supervisor ' +
    'examiner author date keywords nomenclature glossary notation symbols index').split(' '),
);

interface FontInfo {
  name: string;
  bold: boolean;
  italic: boolean;
}

/**
 * 字体的名字和粗 / 斜体。
 * PDF.js 6.5 起字体对象默认不再带 `name`（要在 getDocument 里开 fontExtraProperties 才有），
 * 但一直带着从字体描述里读出的 `bold` / `italic` / `black`；`loadedName` 只是内部编号（如 g_d0_f3）或通用的 Times，不能拿来判断样式。
 * 所以样式以这几个布尔属性为准，名字只用来认数学字体（CMMI、STIX……），并保留按名字认粗 / 斜体的旧路子。
 */
function fontInfo(page: PDFPageProxy, id: string): FontInfo {
  try {
    const f = page.commonObjs.get(id) as { name?: string; bold?: boolean; italic?: boolean; black?: boolean } | undefined;
    const name = typeof f?.name === 'string' ? f.name : '';
    return { name, bold: f?.bold === true || f?.black === true || BOLD_FONT.test(name), italic: f?.italic === true || ITALIC_FONT.test(name) };
  } catch {
    return { name: '', bold: false, italic: false }; // 字体还没加载（先渲染再分析就不会出现）
  }
}

/* ------------------------------------------------------------------ */
/* 文字项和行（整页分析和整本预扫描共用）                                 */
/* ------------------------------------------------------------------ */

async function readItems(page: PDFPageProxy, withFonts: boolean) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items: Item[] = [];
  for (const raw of tc.items) {
    if (!('str' in raw) || !raw.str.trim()) continue;
    const t = Util.transform(vp.transform, raw.transform);
    if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue; // 旋转的文字（坐标轴标签等）不动
    const fs = Math.hypot(t[2], t[3]);
    if (fs < 2) continue;
    const font = withFonts ? fontInfo(page, raw.fontName) : { name: '', bold: false, italic: false };
    const name = font.name;
    const family = (tc.styles as Record<string, { fontFamily?: string }>)[raw.fontName]?.fontFamily ?? '';
    const x0 = t[4];
    const base = t[5];
    items.push({
      str: raw.str,
      x0,
      x1: x0 + raw.width,
      y0: base - fs * 0.82,
      y1: base + fs * 0.22,
      base,
      fs,
      math: MATH_FONT.test(name) || MATH_ALNUM.test(raw.str),
      bold: font.bold,
      italic: font.italic,
      serif: SERIF_FONT.test(name) || (/serif/i.test(family) && !/sans/i.test(family)),
    });
  }
  return { vp, items };
}

function buildLines(items: Item[], pageW: number): Line[] {
  items.sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const lines: Line[] = [];
  for (const it of items) {
    let line: Line | undefined;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 12; i--) {
      const l = lines[i];
      const sameBase = Math.abs(it.base - l.base) < 0.35 * l.fs || (it.fs < 0.85 * l.fs && Math.abs(it.base - l.base) < 0.6 * l.fs); // 上下标
      const gap = it.x0 - l.x1;
      // 同一行的字基线常有零点几的差别（斜体变量、换了字体的数字），按基线排序后左边的字可能比右边的晚到：
      // 紧贴在这一行左边的字也接上（否则「where 𝑢 is…」会被拆成两行、两段，译文互相压住）
      const before = l.x0 - it.x1;
      const fsMax = Math.max(it.fs, l.fs);
      // 目录的点线常常和标题、页码隔得很远，也算同一行
      const leader = LEADER.test(it.str) || LEADER.test(l.items[l.items.length - 1]?.str ?? '');
      // 目录行尾的页码：前面是点线，或者落在页面右侧（章标题那一行没有点线，中间只有一大段空白）
      const pageNo = PAGE_NO.test(it.str.trim()) && (/[.·…]\s*[.·…]\s*$/.test(lineText(l)) || (it.x0 > pageW * 0.7 && gap < pageW * 0.65));
      // 目录里的章节号和标题之间常常隔得比较远（固定宽度的编号栏）
      const secNo = SECTION_NO.test(lineText(l).trim()) && gap < 3 * Math.max(it.fs, l.fs) && /\p{L}/u.test(it.str);
      const right = it.x0 > l.x0 - l.fs && (gap < 1.2 * fsMax || leader || pageNo || secNo);
      const left = it.x0 <= l.x0 - l.fs && before < 1.2 * fsMax;
      if (sameBase && (right || left)) {
        line = l;
        break;
      }
    }
    if (line) {
      line.items.push(it);
      line.x0 = Math.min(line.x0, it.x0);
      line.x1 = Math.max(line.x1, it.x1);
      line.y0 = Math.min(line.y0, it.y0);
      line.y1 = Math.max(line.y1, it.y1);
      if (it.fs > line.fs * 0.85) line.fs = Math.max(line.fs, it.fs);
    } else lines.push({ items: [it], x0: it.x0, x1: it.x1, y0: it.y0, y1: it.y1, fs: it.fs, base: it.base });
  }
  for (const l of lines) l.items.sort((a, b) => a.x0 - b.x0);
  return joinAdjacent(lines);
}

/**
 * 同一基线上挨着的两段接成一行。按基线排序逐字归行时，基线差零点几的字（换了字体的数字、斜体变量）
 * 可能先在右边开了一行，左边的字再来时已经接不上，于是「planning, trajectory generation, | NMPC, …」
 * 被拆成两行、分进两段，两段的框互相重叠。
 */
function joinAdjacent(lines: Line[]): Line[] {
  const bands: Line[][] = [];
  for (const l of [...lines].sort((a, b) => a.base - b.base)) {
    const band = bands[bands.length - 1];
    if (band && Math.abs(band[0].base - l.base) < 0.35 * Math.max(band[0].fs, l.fs)) band.push(l);
    else bands.push([l]);
  }
  const out: Line[] = [];
  for (const band of bands) {
    band.sort((a, b) => a.x0 - b.x0);
    let cur = band[0];
    for (const l of band.slice(1)) {
      if (l.x0 - cur.x1 < 1.2 * Math.max(cur.fs, l.fs)) {
        cur.items.push(...l.items);
        cur.items.sort((a, b) => a.x0 - b.x0);
        cur.x1 = Math.max(cur.x1, l.x1);
        cur.y0 = Math.min(cur.y0, l.y0);
        cur.y1 = Math.max(cur.y1, l.y1);
        cur.fs = Math.max(cur.fs, l.fs);
      } else {
        out.push(cur);
        cur = l;
      }
    }
    out.push(cur);
  }
  return out;
}

/** 公式编号：「(2.13)」这样单独一段、通常在行尾。 */
const EQ_NO = /^\(\s*[A-Z]?\d+(\.\d+)*[a-z]?\s*\)$/;
function isEqNumber(l: Line): boolean {
  return EQ_NO.test(lineText(l).trim());
}
/** 以数学字体为主的一行（行间公式的一部分）。 */
function mathHeavy(l: Line): boolean {
  let m = 0;
  let n = 0;
  for (const it of l.items) {
    const c = it.str.replace(/\s/g, '').length;
    n += c;
    // 数学字体、上下标（比本行小一号的字）都算公式
    if (it.math || it.fs < 0.85 * l.fs) m += c;
    else m += (it.str.match(MATH_CHARS) ?? []).length;
  }
  return n > 0 && m / n >= 0.4;
}

/**
 * 行间公式的一行：以公式为主，或者除了 min / subject to / where 这类词以外没有一个正文的词、又带着公式符号。
 * 「u_min ≤ u_i ≤ u_max」「subject to x₀ = x̂(t)」都算；正文句子里夹着几个变量的不算。
 */
function formulaLine(l: Line): boolean {
  if (mathHeavy(l)) return true;
  let symbols = 0;
  let words = 0;
  for (const it of l.items) {
    if (it.math || it.fs < 0.85 * l.fs) {
      symbols++;
      continue;
    }
    symbols += (it.str.match(MATH_CHARS) ?? []).length;
    for (const w of it.str.match(/[\p{L}][\p{L}.'’-]*/gu) ?? []) {
      const lw = w.toLowerCase().replace(/[.'’-]+$/, '');
      if (lw.length >= 3 && !MATH_WORDS.has(lw)) words++;
    }
  }
  return words === 0 && symbols > 0;
}

/**
 * 段落里接着上一行的短尾巴（「…counted when |uₓ| ≥ 0.9 and」+「and |u_y|.」）：上一行是正文、没以句号收尾，
 * 这一行从段落左边开始。这种看起来像公式的行仍属于这段正文。行间公式一般缩进或居中，不受影响。
 */
function textContinues(box: Box, last: Line, l: Line): boolean {
  return !formulaLine(last) && !/[.:;!?。：；！？]\s*$/.test(lineText(last).trim()) && Math.abs(l.x0 - box.x0) < 1.5 * l.fs;
}

/** 本行里哪些字是公式符号：数学字体、上下标、组合附加符号（x̂ 的帽子）、和正文字体不同的单个斜体 / 粗体字母（变量 N、向量 x）。 */
function symbolItems(l: Line): boolean[] {
  let italicN = 0;
  let boldN = 0;
  let total = 0;
  for (const it of l.items) {
    const c = it.str.trim().length;
    total += c;
    if (it.italic) italicN += c;
    if (it.bold) boldN += c;
  }
  const bodyItalic = italicN > total * 0.5;
  const bodyBold = boldN > total * 0.5;
  const out = l.items.map(() => false);
  l.items.forEach((it, k) => {
    const prev = l.items[k - 1];
    const attached = !!prev && it.x0 - prev.x1 < 0.3 * l.fs;
    if (it.math) out[k] = true;
    else if (/^\p{M}+$/u.test(it.str) && prev) out[k] = true;
    else if (it.fs < 0.85 * l.fs && attached && /\S/.test(it.str) && (out[k - 1] || /^\s*\p{L}\p{M}*$/u.test(prev.str))) {
      out[k] = true;
      out[k - 1] = true; // 带下标的字母（u_min、x_ref）整个算一个符号
    } else if (/^\s*[A-Za-z\u0370-\u03ff]\p{M}*['′]?\s*$/u.test(it.str) && ((it.italic && !bodyItalic) || (it.bold && !bodyBold))) out[k] = true;
  });
  return out;
}

const BOLD_UP = 0x1d400;
const ITALIC_UP = 0x1d434;
const BOLD_ITALIC_UP = 0x1d468;
/** 一组符号能不能直接写成文字：没有上下标、最多两个字母。能就返回 Unicode 数学字母写法，不能返回 null。 */
function simpleSymbol(group: Item[], l: Line): string | null {
  if (group.some((g) => g.fs < 0.85 * l.fs)) return null;
  const raw = group.map((g) => g.str).join('').trim();
  if (!raw || raw.length > 8 || (raw.match(/\p{L}/gu) ?? []).length > 2) return null;
  if (!/^[\p{L}\p{M}\p{N}()[\]′'*,.+\-−]+$/u.test(raw)) return null;
  return group
    .map((g) => {
      const base = g.bold && g.italic ? BOLD_ITALIC_UP : g.bold ? BOLD_UP : g.italic && !g.math ? ITALIC_UP : 0;
      if (!base) return g.str;
      return g.str.replace(/[A-Za-z]/g, (c) => {
        if (base === ITALIC_UP && c === 'h') return '\u210e';
        const code = c.charCodeAt(0);
        return String.fromCodePoint(base + (code >= 97 ? 26 + code - 97 : code - 65));
      });
    })
    .join('')
    .trim();
}

/**
 * 表格里一行就是一条记录：上下两行都在同一基线上有别的格子，而且其中一行有数字格子（3.39、49.8 %），
 * 这两行就不并成一段（否则「Near-front / Right-side / Direct-front」被并成一段、两端对齐、字被拉开）。
 * 文字表格里一个格子写了好几行时，旁边的格子也是文字，不受影响。
 */
function rowBreak(last: Line, l: Line, lines: Line[]): boolean {
  const row = (x: Line) => lines.filter((o) => o !== x && Math.abs(o.base - x.base) < 0.35 * Math.max(o.fs, x.fs));
  const a = row(last);
  if (!a.length) return false;
  const b = row(l);
  if (!b.length) return false;
  const numeric = (o: Line) => /^[\s\d.,:%±+\-−–—()*/<>≤≥~×x]+$/i.test(lineText(o)) && /\d/.test(lineText(o));
  return a.some(numeric) || b.some(numeric) || numeric(last) || numeric(l);
}

/**
 * 表头一行里两个格子挨得很近时会被接成一行（「Last position error (cm) Near-limit samples (%)」）。
 * 下面几行表格（同一基线上有好几个格子）在这里都留着空白（一条竖着的「河」），左右两边都有格子，就从这里拆开。
 * 只拆本身就在表格行里（同一基线上还有别的格子）的行，正文段落不受影响。
 */
function splitByRivers(lines: Line[]): Line[] {
  const sameRow = (a: Line, b: Line) => a !== b && Math.abs(a.base - b.base) < 0.35 * Math.max(a.fs, b.fs);
  const rowLines = lines.filter((l) => lines.some((o) => sameRow(l, o)));
  const out: Line[] = [];
  for (const l of lines) {
    if (!rowLines.includes(l) || l.items.length < 2) {
      out.push(l);
      continue;
    }
    const near = rowLines.filter((o) => !sameRow(l, o) && o !== l && Math.abs(o.base - l.base) > 0.5 * l.fs && Math.abs(o.base - l.base) < 8 * l.fs);
    const bases = new Set(near.map((o) => Math.round(o.base)));
    if (bases.size < 2) {
      out.push(l);
      continue;
    }
    const cuts: number[] = [];
    for (let k = 1; k < l.items.length; k++) {
      const a = l.items[k - 1];
      const b = l.items[k];
      if (b.x0 - a.x1 < 0.2 * l.fs) continue;
      const x = (a.x1 + b.x0) / 2;
      if (near.some((o) => o.items.some((i) => i.x0 < x && i.x1 > x))) continue;
      const left = new Set(near.filter((o) => o.x1 <= x).map((o) => Math.round(o.base))).size;
      const right = new Set(near.filter((o) => o.x0 >= x).map((o) => Math.round(o.base))).size;
      if (left >= 2 && right >= 2) cuts.push(k);
    }
    if (!cuts.length) {
      out.push(l);
      continue;
    }
    let from = 0;
    for (const c of [...cuts, l.items.length]) {
      const items = l.items.slice(from, c);
      from = c;
      out.push({ ...l, items, x0: Math.min(...items.map((i) => i.x0)), x1: Math.max(...items.map((i) => i.x1)), y0: Math.min(...items.map((i) => i.y0)), y1: Math.max(...items.map((i) => i.y1)) });
    }
  }
  return out;
}

/**
 * 两端对齐的正文里，句号后面的空隙有时比 1.2 个字高还宽，同一行会被切成两段。
 * 同一基线、间隔不到 4 个字高、而且页面上有好几行横跨这个空隙（说明这里不是分栏的栏间距）时接回去。
 */
function mergeFragments(lines: Line[]): Line[] {
  const sorted = [...lines].sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const out: Line[] = [];
  for (const l of sorted) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.base - l.base) < 0.35 * Math.max(prev.fs, l.fs) && !isEqNumber(l) && !mathHeavy(l) && !mathHeavy(prev)) {
      const gap = l.x0 - prev.x1;
      const fs = Math.max(prev.fs, l.fs);
      // 表格的单元格也是「同一基线、中间一段空白、上下有横跨的行（表题、正文）」：
      // 句子之间的宽空隙前面一般是标点；上下几行也从同一个位置开始的，是表格的一栏，不接
      const sentenceGap = /[.!?;:,)\]…。！？；：，]$/.test(lineText(prev).trim()) || gap < 1.8 * fs;
      const column = sorted.some((o) => o !== l && Math.abs(o.base - l.base) > 0.5 * fs && Math.abs(o.base - l.base) < 5 * fs && Math.abs(o.x0 - l.x0) < 1.5);
      if (gap > 0 && gap < 4 * fs && sentenceGap && !column) {
        const spanning = sorted.filter((o) => o !== prev && o !== l && o.x0 < prev.x1 - fs && o.x1 > l.x0 + fs).length;
        if (spanning >= 3) {
          prev.items.push(...l.items);
          prev.x1 = Math.max(prev.x1, l.x1);
          prev.y0 = Math.min(prev.y0, l.y0);
          prev.y1 = Math.max(prev.y1, l.y1);
          prev.fs = Math.max(prev.fs, l.fs);
          continue;
        }
      }
    }
    out.push(l);
  }
  return out;
}

/**
 * 表格的两栏之间有时只隔一个多字宽，逐字归行时会被接成一行（「time-dependent references. Final interaction」）。
 * 行里有一段超过 0.8 个字宽的空白、空白后面那个字的位置正好是附近好几行的行首（一栏的左边），就从这里拆开。
 * 左边只是章节号、项目符号、编号（目录、列表的悬挂缩进）时不拆。
 */
function splitColumns(lines: Line[]): Line[] {
  const starts = lines.map((l) => ({ x: l.x0, base: l.base }));
  const out: Line[] = [];
  for (const l of lines) {
    let cur: Item[] = [];
    const parts: Item[][] = [];
    l.items.forEach((it, i) => {
      const prev = l.items[i - 1];
      if (prev && cur.length && it.x0 - prev.x1 > 0.8 * l.fs) {
        const left = cur.map((c) => c.str).join('').trim();
        const aligned = starts.filter((s) => s.base !== l.base && Math.abs(s.base - l.base) < 6 * l.fs && Math.abs(s.x - it.x0) < 1.5).length;
        if (aligned >= 2 && !SECTION_NO.test(left) && !LIST_START.test(left + ' ') && !LEADER.test(left)) {
          parts.push(cur);
          cur = [];
        }
      }
      cur.push(it);
    });
    parts.push(cur);
    if (parts.length === 1) {
      out.push(l);
      continue;
    }
    for (const items of parts) {
      out.push({
        ...l,
        items,
        x0: Math.min(...items.map((i) => i.x0)),
        x1: Math.max(...items.map((i) => i.x1)),
        y0: Math.min(...items.map((i) => i.y0)),
        y1: Math.max(...items.map((i) => i.y1)),
        fs: Math.max(...items.map((i) => i.fs)),
      });
    }
  }
  return out;
}

/** 按字符数加权的字号中位数（正文字号）。 */
function bodySize(lines: Line[]): number {
  const sizes = lines.flatMap((l) => l.items.map((it) => [it.fs, it.str.length] as const)).sort((a, b) => a[0] - b[0]);
  const total = sizes.reduce((n, [, c]) => n + c, 0);
  let acc = 0;
  for (const [fs, c] of sizes) {
    acc += c;
    if (acc >= total / 2) return fs;
  }
  return sizes[0]?.[0] ?? 10;
}

/**
 * 目录条目：「编号 标题 …… 页码」。页码是行尾的数字或罗马数字，前面要么有点线，要么隔着一大段空白。
 * 没有页码、但缩进和标题一致的行是长标题折下来的续行（hasPage=false）。
 */
function tocParts(l: Line): TocParts | null {
  const its = l.items;
  if (its.length < 2) return null;
  const last = its[its.length - 1];
  const lastStr = last.str.trim();
  let pageItem: Item | null = null;
  let titleEnd = its.length;
  if (PAGE_NO.test(lastStr)) {
    pageItem = last;
    titleEnd = its.length - 1;
  } else {
    // 页码和点线挤在同一个文字项里：「. . . . 17」
    const m = /^(.*?)[\s.·…]{3,}(\d{1,4}|[ivxlcdm]{1,8})$/i.exec(last.str);
    if (!m) return null;
    pageItem = last;
    titleEnd = its.length - (m[1].trim() ? 0 : 1);
  }
  // 去掉标题后面的点线
  let leaders = false;
  while (titleEnd > 0 && LEADER.test(its[titleEnd - 1].str)) {
    titleEnd--;
    leaders = true;
  }
  let titleStart = 0;
  while (titleStart < titleEnd && SECTION_NO.test(its[titleStart].str.trim())) titleStart++;
  const titleItems = its.slice(titleStart, titleEnd);
  if (!titleItems.length) return null;
  // 点线和标题在同一个文字项里：「Background . . . . . .」
  const lastTitle = titleItems[titleItems.length - 1];
  let cut: number | null = null;
  const inner = /^(.*?\S)\s*[.·…](\s*[.·…]){2,}\s*$/.exec(lastTitle.str);
  if (inner && lastTitle !== pageItem) {
    leaders = true;
    // 按大致字宽分配：字母宽、点和空格窄；再多留一点，宁可多盖两个点也不要露出半个字母
    const wt = (str: string) => [...str].reduce((n, c) => n + (c === ' ' ? 0.25 : /[.·…]/.test(c) ? 0.3 : /[A-Z]/.test(c) ? 0.7 : /[mwMW]/.test(c) ? 0.8 : /[ijlt.,:;'|!]/.test(c) ? 0.3 : 0.52), 0);
    const frac = wt(inner[1]) / Math.max(0.01, wt(lastTitle.str));
    cut = Math.min(lastTitle.x1, lastTitle.x0 + (lastTitle.x1 - lastTitle.x0) * frac + l.fs * 0.9);
  }
  let titleText = '';
  let prev: Item | null = null;
  for (const it of titleItems) {
    const str = pageItem === it ? it.str.replace(/[\s.·…]{3,}(\d{1,4}|[ivxlcdm]{1,8})$/i, '') : it.str;
    titleText += (prev && it.x0 - prev.x1 > 0.12 * l.fs && !/\s$/.test(titleText) && !/^\s/.test(str) ? ' ' : '') + str;
    prev = it;
  }
  titleText = titleText.replace(/[\s.·…]+$/, '').replace(/\s+/g, ' ').trim();
  if (!/\p{L}{2}/u.test(titleText)) return null;
  const tEnd = Math.max(...titleItems.map((it) => (it === pageItem ? it.x0 + Math.min(it.x1 - it.x0, titleText.length * l.fs * 0.5) : it === lastTitle && cut !== null ? cut : it.x1)));
  const gap = pageItem.x0 - tEnd;
  if (!leaders && gap < 3 * l.fs && !/[.·…]{3,}/.test(last.str)) return null;
  return {
    title: { x0: titleItems[0].x0, y0: l.y0, x1: tEnd, y1: l.y1 },
    titleText,
    limit: pageItem.x0 - l.fs * 0.8,
    hasPage: true,
  };
}

function isTocPage(lines: Line[]): boolean {
  const withLetters = lines.filter((l) => /\p{L}{2}/u.test(lineText(l)));
  const toc = lines.filter((l) => l.toc).length;
  return toc >= 4 && toc >= withLetters.length * 0.3;
}

/** 这一栏的宽度：本页长行宽度的高分位数（双栏时就是单栏宽度）。 */
function columnWidth(lines: Line[], bodyFs: number): number {
  const ws = lines.filter((l) => Math.abs(l.fs - bodyFs) < bodyFs * 0.2).map((l) => l.x1 - l.x0).sort((a, b) => a - b);
  if (!ws.length) return 0;
  return ws[Math.floor(ws.length * 0.9)] ?? ws[ws.length - 1];
}

/** 和 l 水平重叠的长行的左右边界（这一栏的边界）；没有就用整页。 */
function columnOf(l: Box, longLines: Line[], pageW: number, self?: Line[]): { x0: number; x1: number } {
  const xs0: number[] = [];
  const xs1: number[] = [];
  for (const o of longLines) {
    if (self?.includes(o)) continue; // 不拿自己当这一栏的边界
    if (Math.min(o.x1, l.x1) - Math.max(o.x0, l.x0) > 0) {
      xs0.push(o.x0);
      xs1.push(o.x1);
    }
  }
  if (!xs0.length) return { x0: pageW * 0.12, x1: pageW * 0.88 };
  return { x0: median(xs0), x1: median(xs1) };
}

/* ------------------------------------------------------------------ */
/* 整页分析                                                             */
/* ------------------------------------------------------------------ */

export interface LayoutOptions {
  /** 参考文献区。undefined：不知道，按本页自己的标题判断；null：本页没有文献区。 */
  refZone?: RefZone | null;
  /** 整本预扫描认出的目录页（目录的最后一页条目少，单看本页可能认不出）。 */
  toc?: boolean;
}

export async function extractLayout(page: PDFPageProxy, targetLang: string, opts: LayoutOptions = {}): Promise<PageLayout> {
  const { vp, items } = await readItems(page, true);
  const layout: PageLayout = { width: vp.width, height: vp.height, hasText: items.length > 0, paras: [], references: false, toc: false };
  if (!items.length) return layout;

  const lines = splitByRivers(splitColumns(mergeFragments(buildLines(items, vp.width))));
  // 表格：同一基线上有 3 段以上的短文字
  const byBase = new Map<number, Line[]>();
  for (const l of lines) {
    const k = Math.round(l.base / 3);
    byBase.set(k, [...(byBase.get(k) ?? []), l]);
  }
  for (const group of byBase.values()) {
    if (group.length >= 3) for (const l of group) if (lineText(l).length < 32) l.tabular = true;
  }
  for (const l of lines) l.toc = tocParts(l) ?? undefined;
  layout.toc = opts.toc === undefined ? isTocPage(lines) : opts.toc && lines.some((l) => l.toc);
  if (!layout.toc) for (const l of lines) l.toc = undefined;

  const bodyFs = bodySize(lines);
  const colW = columnWidth(lines, bodyFs);
  const longLines = lines.filter((l) => l.x1 - l.x0 >= colW * 0.7);
  const starts = lines.map((l) => l.x0);

  /* ---------- 段落 ---------- */
  lines.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  let paras: { lines: Line[]; box: Box; fs: number }[] = [];
  for (const l of lines) {
    let target: (typeof paras)[number] | undefined;
    if (!(layout.toc && l.toc)) {
      for (let i = paras.length - 1; i >= 0 && i >= paras.length - 8; i--) {
        const p = paras[i];
        const last = p.lines[p.lines.length - 1];
        const gap = l.y0 - last.y1;
        const overlap = Math.min(l.x1, p.box.x1) - Math.max(l.x0, p.box.x0);
        const narrow = Math.min(l.x1 - l.x0, p.box.x1 - p.box.x0);
        // 往回找段落时只能跳过别的栏里的段落：中间隔着同一栏的另一段，就不能再接到更早的段落上（否则两段的框重叠）
        const between = i < paras.length - 1 && paras.slice(i + 1).some((q) => q.box.y0 < l.y0 && Math.min(l.x1, q.box.x1) - Math.max(l.x0, q.box.x0) > 0.3 * Math.min(l.x1 - l.x0, q.box.x1 - q.box.x0));
        if (between) break;
        if (layout.toc && last.toc) continue; // 目录条目不和别的行合并
        if (
          Math.abs(l.fs - p.fs) <= 0.15 * p.fs &&
          gap <= 0.9 * p.fs && gap >= -0.4 * p.fs &&
          (overlap >= 0.6 * narrow || Math.abs(l.x0 - p.box.x0) < 2 * p.fs) &&
          overlap > 0 && !!l.tabular === !!last.tabular &&
          isBold(l) === isBold(last) && // 加粗的小标题不并进下面的正文
          !isEqNumber(l) && !isEqNumber(last) && (formulaLine(l) && !textContinues(p.box, last, l)) === p.lines.every(formulaLine) && // 行间公式和公式编号不和正文合并
          !rowBreak(last, l, lines) && // 表格里一行一条记录（同一行还有数字格子），不把上下几行并成一段
          !hardBreak(last, l, rightEdge(last, lines, columnOf(last, longLines, layout.width, [last]).x1)) &&
          !indentBreak(p.lines, last, l)
        ) {
          target = p;
          break;
        }
      }
    }
    if (target) {
      target.lines.push(l);
      target.box = union(target.box, l);
    } else paras.push({ lines: [l], box: { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 }, fs: l.fs });
  }

  // 最后的保险：还有两段的框互相重叠（表格、图里的文字），这两段改成一行一段，译文互不遮挡
  const over = (a: Box, b: Box) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1;
  const split = new Set<number>();
  for (let i = 0; i < paras.length; i++) {
    for (let j = i + 1; j < paras.length; j++) {
      if (over(paras[i].box, paras[j].box)) split.add(i).add(j);
    }
  }
  if (split.size) {
    paras = paras.flatMap((p, i) => (split.has(i) && p.lines.length > 1 ? p.lines.map((l) => ({ lines: [l], box: { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 }, fs: l.fs })) : [p]));
  }

  let afterRefs = false;
  paras.forEach((p, i) => {
    const single = p.lines.length === 1;
    const tocLine = layout.toc && single ? p.lines[0].toc : undefined;
    const atoms: Atom[] = [];
    let text = '';
    let mathChars = 0;
    let letters = 0;
    let boldChars = 0;
    let serifChars = 0;
    let chars = 0;
    p.lines.forEach((l, li) => {
      let prev: Item | null = null;
      const sym = symbolItems(l);
      for (let k = 0; k < l.items.length; k++) {
        const it = l.items[k];
        const n = it.str.length;
        chars += n;
        if (it.bold) boldChars += n;
        if (it.serif) serifChars += n;
        if (sym[k]) {
          // 变量、公式片段：连着的几个合成一组。简单的单个符号（𝑁、𝐱̂(𝑡)）直接写成 Unicode 数学字母，
          // 翻译服务会原样抄过去；带上下标、分式这些复杂的，用占位符 <xN/>，显示时从原页裁图
          let j = k;
          const group = [it];
          while (j + 1 < l.items.length && sym[j + 1] && l.items[j + 1].x0 - l.items[j].x1 < 0.35 * l.fs) {
            j++;
            group.push(l.items[j]);
          }
          k = j;
          const box: Box = group.reduce<Box>((b, g) => union(b, g), { x0: it.x0, y0: it.y0, x1: it.x1, y1: it.y1 });
          const raw = group.map((g) => g.str).join('');
          mathChars += raw.length;
          const sep = prev && box.x0 - prev.x1 > 0.12 * l.fs && !/\s$/.test(text) ? ' ' : '';
          const literal = simpleSymbol(group, l);
          if (literal !== null) text += sep + literal;
          else {
            text += `${sep}<x${atoms.length}/>`;
            atoms.push({ ...box, text: raw });
          }
          prev = l.items[j];
          continue;
        }
        letters += (it.str.match(/\p{L}/gu) ?? []).length;
        mathChars += (it.str.match(MATH_CHARS) ?? []).length;
        const sep = prev && it.x0 - prev.x1 > 0.12 * l.fs && !/\s$/.test(text) && !/^\s/.test(it.str) ? ' ' : '';
        text += sep + it.str;
        prev = it;
      }
      if (li < p.lines.length - 1) {
        // 行尾连字符：trans-\nlation → translation
        if (/[a-z]-$/.test(text) && /^[a-z]/.test(p.lines[li + 1].items[0]?.str ?? '')) text = text.slice(0, -1);
        else if (!/\s$/.test(text)) text += ' ';
      }
    });
    text = text.replace(/\s+/g, ' ').trim();
    if (tocLine) {
      // 目录条目：只翻标题；点线和页码不进模型
      text = tocLine.titleText;
      letters = (text.match(/\p{L}/gu) ?? []).length;
      mathChars = 0;
    }
    const plain = text.replace(/<x\d+\/>/g, '');
    const pitch = p.lines.length > 1 ? median(p.lines.slice(1).map((l, k) => l.base - p.lines[k].base)) : p.fs * 1.2;
    const bold = boldChars / Math.max(1, chars) > 0.6;
    const headingLike = single && plain.length < 90 && (p.fs >= bodyFs * 1.1 || bold);

    let kind: ParaKind = 'body';
    let reason: string | undefined;
    const zone = opts.refZone;
    const inZone = zone === undefined ? afterRefs : zone ? p.box.y0 >= zone.start - 0.5 && p.box.y0 < zone.end - 0.5 : false;
    if (!layout.toc && REFS.test(plain) && headingLike) {
      layout.references = true;
      afterRefs = true;
      kind = 'heading';
    } else if (inZone && !MAJOR.test(plain)) {
      kind = 'skip';
      reason = 'references';
    } else if (letters < 3 || letters / Math.max(1, plain.length) < 0.45) {
      kind = 'skip';
      reason = 'symbols';
    } else if (!tocLine && p.lines.every(formulaLine)) {
      // 行间公式（包括「u_min ≤ u_i ≤ u_max」「subject to x₀ = …」）：原样保留，不翻译
      kind = 'skip';
      reason = 'formula';
    } else if (mathChars / Math.max(1, text.length) > 0.35) {
      kind = 'skip';
      reason = 'math';
    } else if ((atoms.length > 0 || mathChars > 0) && !/\p{L}{3,}/u.test(text.replace(/<x\d+\/>/g, ' '))) {
      // 行间公式「p˙ = R(q) v」：只有单个字母的变量加公式符号，没有一个真正的词
      kind = 'skip';
      reason = 'formula';
    } else if (p.lines.every((l) => l.tabular) && !tocLine && !/\p{L}{4,}/u.test(plain)) {
      // 表格里只有缩写、单位、数字的格子不翻；有词的格子（「Goal」「Implemented work」）照常翻译
      kind = 'skip';
      reason = 'table';
    } else if (looksLikeTarget(plain, targetLang)) {
      kind = 'skip';
      reason = 'target-language';
    } else if (single && !tocLine && isPersonName(plain)) {
      kind = 'skip';
      reason = 'name';
    } else if (tocLine) kind = 'toc';
    else if (CAPTION.test(plain)) kind = 'caption';
    else if (p.fs >= bodyFs * 1.15 || (bold && single && plain.length < 90)) kind = 'heading';

    const box = tocLine ? { ...tocLine.title } : p.box;
    const { align, indent } = tocLine ? { align: 'left' as const, indent: 0 } : alignment(p.lines, p.box, longLines, layout.width, kind, starts);
    layout.paras.push({
      id: `p${i}`,
      lines: p.lines,
      ...box,
      text,
      atoms,
      fs: p.fs,
      pitch: Math.max(p.fs, Math.min(p.fs * 2.2, pitch)),
      kind,
      bold,
      serif: serifChars / Math.max(1, chars) > 0.5,
      align,
      ...(indent ? { indent } : {}),
      ...(tocLine ? { toc: { limit: tocLine.limit } } : {}),
      ...(reason ? { reason } : {}),
    });
  });

  const sameRow = (a: Box & { fs: number }, b: Line) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0);
  // 行间公式左边、同一行上的 min / subject to / where 这些词跟着公式一起原样保留
  for (const p of layout.paras) {
    if (p.kind === 'skip' || p.toc || p.lines.length > 2) continue;
    const words = p.text.replace(/<x\d+\/>/g, ' ').match(/[\p{L}][\p{L}.'’-]*/gu) ?? [];
    if (!words.length || words.length > 4) continue;
    if (!words.every((w) => w.length <= 2 || MATH_WORDS.has(w.toLowerCase().replace(/[.'’-]+$/, '')))) continue;
    const formulaRow = layout.paras.some((q) => q !== p && q.kind === 'skip' && q.reason !== 'references' && q.reason !== 'name' && q.lines.some((ql) => sameRow(p, ql)));
    if (formulaRow) {
      p.kind = 'skip';
      p.reason = 'formula';
    }
  }
  // 表格里的单行格子：译文不换行，放不下先缩字号，最多写到右边下一个格子前面
  for (const p of layout.paras) {
    if (p.kind === 'skip' || p.toc || p.lines.length !== 1) continue;
    const l = p.lines[0];
    const row = lines.filter((o) => o !== l && Math.abs(o.base - l.base) < 0.35 * Math.max(o.fs, l.fs));
    if (!row.length) continue;
    const right = row.filter((o) => o.x0 >= l.x1 - 1).map((o) => o.x0);
    const limit = right.length ? Math.min(...right) - 0.6 * l.fs : Math.max(...lines.map((o) => o.x1));
    p.cell = { limit: Math.max(l.x1, limit) };
    if (p.align === 'justify') p.align = 'left';
  }
  return layout;
}

/**
 * 判断「这一行有没有写满」时用的右边界。普通段落用整栏的右边；表格里（同一基线上还有别的格子）
 * 用这个格子所在那一栏的右边：同一栏（行首对齐）附近几行里最靠右的位置。
 * 否则表格格子里的每一行都像「没写满」，一个格子被拆成好几段分别翻译。
 */
function rightEdge(last: Line, lines: Line[], colRight: number): number {
  const fs = last.fs;
  const inRow = lines.some((o) => o !== last && Math.abs(o.base - last.base) < 0.35 * fs);
  if (!inRow) return colRight;
  let r = last.x1;
  for (const o of lines) {
    if (Math.abs(o.x0 - last.x0) < 1.5 && Math.abs(o.base - last.base) < 10 * fs) r = Math.max(r, o.x1);
  }
  return Math.min(colRight, r);
}

/**
 * 作者有意换行（日期 / 署名、地址、「导师：」「标题：」这类条目、没有段间距的两段）：
 * 上一行右边还空着一大截，下一行的第一个词明明放得下却换了行。
 * 正常排版的段落里，一行只有在下一个词放不下时才折行，所以这个判断不会拆开普通段落。
 */
function hardBreak(last: Line, l: Line, colRight: number): boolean {
  const a = lineText(last).trim();
  if (/[-‐‑]$/.test(a)) return false; // 行尾连字符：单词被拆开了
  const first = l.items[0];
  if (!first) return false;
  const word = /^\s*\S+/.exec(first.str)?.[0] ?? first.str;
  const wordW = (first.x1 - first.x0) * (word.length / Math.max(1, first.str.length));
  const room = colRight - last.x1;
  return room > wordW * 1.3 + last.fs * 1.2;
}

const LIST_START = /^\s*([•·▪‣◦●○■□\-–—*]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\[\d+\])\s/;
/**
 * 首行缩进开始新的一段：上一行从段落左边开始，这一行往里缩了将近一个字到几个字。
 * 项目符号 / 编号列表的续行（悬挂缩进）也是往里缩，但那一段的第一行以列表符号开头，不算。
 */
function indentBreak(paraLines: Line[], last: Line, l: Line): boolean {
  const left = Math.min(...paraLines.map((x) => x.x0));
  const d = l.x0 - last.x0;
  if (Math.abs(last.x0 - left) > 1 || d < 0.8 * l.fs || d > 4 * l.fs) return false;
  return !LIST_START.test(lineText(paraLines[0]));
}

/** 单独一行、2–3 个首字母大写的词、没有数字和常见标题词：多半是人名（署名、作者），保留原文。 */
function isPersonName(s: string): boolean {
  const t = s.trim();
  if (t.length > 40 || /\d/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  return words.every((w) => /^(\p{Lu}[\p{Ll}'’-]+|\p{Lu}{2,14}|\p{Lu}\.)$/u.test(w) && !TITLE_WORDS.has(w.toLowerCase().replace(/\.$/, '')));
}

/** 按每一行的左右边缘判断对齐方式和首行缩进。 */
function alignment(lines: Line[], box: Box, longLines: Line[], pageW: number, kind: ParaKind, starts: number[] = []): { align: Para['align']; indent: number } {
  const col = columnOf(box, longLines, pageW, lines);
  const colW = Math.max(1, col.x1 - col.x0);
  const fs = lines[0]?.fs ?? 10;
  const tol = Math.max(1.5, fs * 0.6);
  if (lines.length === 1) {
    const l = lines[0];
    const leftGap = l.x0 - col.x0;
    const rightGap = col.x1 - l.x1;
    const w = l.x1 - l.x0;
    // 和页面上别的行从同一个位置开始（列表项、段落里的短行）：是左对齐，不是居中
    const sharedStart = starts.filter((x) => Math.abs(x - l.x0) < 1).length > 1;
    if (sharedStart && Math.abs(leftGap - rightGap) > fs) return { align: 'left', indent: 0 };
    // 两边都明显留白、而且左右留白差不多：居中（封面标题、图题、居中的单行）
    // 两边都明显留白（各超过 2.5 个字高）、而且左右留白差不多：居中。快写满一行的列表项不算
    if (w < colW * 0.85 && leftGap > 2.5 * fs && rightGap > 2.5 * fs && Math.abs(leftGap - rightGap) < Math.max(2.5 * fs, colW * 0.05)) return { align: 'center', indent: 0 };
    // 单行、不从这一栏的左边开始、中心又正好在页面中线上（封面、致谢页上的居中短行）
    if (leftGap > 2 * fs && Math.abs((l.x0 + l.x1) / 2 - pageW / 2) < pageW * 0.02) return { align: 'center', indent: 0 };
    if (w < colW * 0.7 && leftGap > colW * 0.3 && Math.abs(rightGap) < tol * 2) return { align: 'right', indent: 0 };
    return { align: 'left', indent: 0 };
  }
  const lefts = lines.map((l) => l.x0);
  const rights = lines.map((l) => l.x1);
  const centers = lines.map((l) => (l.x0 + l.x1) / 2);
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  const restLefts = lefts.slice(1);
  const d = lefts[0] - Math.min(...restLefts);
  // 首行缩进（正数）或悬挂缩进（负数：项目符号、编号列表、参考文献条目）
  const indent = spread(restLefts) < tol && Math.abs(d) > fs * 0.5 && Math.abs(d) < colW * 0.2 ? d : 0;
  const leftAligned = spread(indent ? restLefts : lefts) < tol;
  const rightAligned = spread(rights.slice(0, -1)) < tol || lines.length === 2 && Math.abs(rights[0] - col.x1) < tol;
  // 左边、右边都明显不齐，但每行中心几乎一样：真正的居中段落
  if (!leftAligned && spread(lefts) > 1.5 * fs && spread(rights) > 1.5 * fs && spread(centers) < fs * 0.8) return { align: 'center', indent: 0 };
  if (!leftAligned && spread(rights) < tol && Math.min(...lefts) > col.x0 + 2 * fs) return { align: 'right', indent: 0 };
  if (kind === 'heading') return { align: 'left', indent };
  return { align: leftAligned && rightAligned ? 'justify' : 'left', indent };
}

/* ------------------------------------------------------------------ */
/* 整本预扫描：参考文献区从哪里到哪里                                    */
/* ------------------------------------------------------------------ */

/**
 * 找出参考文献区：优先用 PDF 书签；没有书签就扫一遍每页的文字。
 * 目录页里的「References」不算；文献区在下一个大标题（附录、索引、更大字号的章标题）处结束。
 * 结果和用户先看哪一页无关。返回：页码 → 这一页上文献区的纵向范围。
 */
export interface Sections {
  /** 页码 → 这一页上参考文献区的纵向范围。 */
  zones: Map<number, RefZone>;
  /** 目录页。 */
  toc: Set<number>;
}

const sectionLines = new WeakMap<PDFDocumentProxy, Map<number, Promise<Line[]>>>();
const sectionOutlines = new WeakMap<PDFDocumentProxy, Promise<Map<number, RefZone> | null>>();

export async function scanSections(doc: PDFDocumentProxy, opts: { throughPage?: number; signal?: AbortSignal } = {}): Promise<Sections> {
  const zones = new Map<number, RefZone>();
  let outline = sectionOutlines.get(doc);
  if (!outline) { outline = outlineZones(doc).catch(() => null); sectionOutlines.set(doc, outline); }
  const fromOutline = await outline;
  opts.signal?.throwIfAborted();
  // 阅读器只需要当前页：可靠书签已给出文献边界，不必等待全书文字扫描。
  if (fromOutline && opts.throughPage !== undefined) return { zones: fromOutline, toc: new Set() };
  let cached = sectionLines.get(doc);
  if (!cached) { cached = new Map(); sectionLines.set(doc, cached); }

  interface PageInfo { refs: number[]; majors: number[]; toc: boolean }
  const info: PageInfo[] = [];
  const sizes: number[] = [];
  const N = Math.min(doc.numPages, opts.throughPage ?? 600);
  const pageLines: Line[][] = new Array(N);
  let next = 1;
  // 只读文字层、不渲染，四页一起读：一百页大约一两秒
  const worker = async () => {
    for (let n = next++; n <= N; n = next++) {
      opts.signal?.throwIfAborted();
      let lines = cached!.get(n);
      if (!lines) {
        lines = (async () => {
          const page = await doc.getPage(n);
          opts.signal?.throwIfAborted();
          const { items } = await readItems(page, false);
          const result = buildLines(items, page.getViewport({ scale: 1 }).width);
          for (const l of result) l.toc = tocParts(l) ?? undefined;
          return result;
        })();
        cached!.set(n, lines);
        void lines.catch(() => cached!.delete(n));
      }
      pageLines[n - 1] = await lines;
      opts.signal?.throwIfAborted();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  for (const lines of pageLines) sizes.push(bodySize(lines));
  const docBody = median(sizes.filter((s) => s > 0)) || 10;
  pageLines.forEach((lines) => {
    const toc = isTocPage(lines);
    const refs: number[] = [];
    const majors: number[] = [];
    for (const l of lines) {
      const t = lineText(l).replace(/\s+/g, ' ').trim();
      if (t.length > 60 || (toc && l.toc)) continue;
      const big = l.fs >= docBody * 1.25;
      if (REFS.test(t) && !toc && !l.toc && (big || l.fs >= docBody * 1.05)) refs.push(l.y0);
      else if (big && (MAJOR.test(t) || l.fs >= docBody * 1.6) && /\p{L}{3}/u.test(t)) majors.push(l.y0);
    }
    info.push({ refs, majors, toc });
  });
  // 目录的最后一页条目少：紧跟在目录页后面、也有目录条目的页也算
  const tocPages = new Set<number>();
  info.forEach((pi, i) => {
    if (pi.toc || (i > 0 && info[i - 1].toc && pageLines[i].filter((l) => l.toc).length >= 2)) {
      tocPages.add(i + 1);
      pi.toc = true;
    }
  });
  if (fromOutline) return { zones: fromOutline, toc: tocPages };
  // 从每个「参考文献」标题往后，到下一个大标题为止
  for (let n = 1; n <= info.length; n++) {
    for (const y of info[n - 1].refs) {
      let page = n;
      let start = y + 0.5;
      for (;;) {
        const pi = info[page - 1];
        const end = pi.majors.filter((m) => m > start).sort((a, b) => a - b)[0] ?? Infinity;
        const prev = zones.get(page);
        zones.set(page, prev ? { start: Math.min(prev.start, start), end: Math.max(prev.end, end) } : { start, end });
        if (end !== Infinity || page >= info.length) break;
        page++;
        start = -Infinity;
        if (info[page - 1].refs.length) break; // 下一个文献区自己会处理
      }
    }
  }
  return { zones, toc: tocPages };
}

/** 用书签找文献区：标题是 References / 参考文献 的书签，到它之后的下一个书签为止。 */
async function outlineZones(doc: PDFDocumentProxy): Promise<Map<number, RefZone> | null> {
  const outline = await doc.getOutline();
  if (!outline?.length) return null;
  interface Flat { title: string; page: number; y: number | null }
  const flat: Flat[] = [];
  const walk = async (nodes: typeof outline) => {
    for (const o of nodes) {
      const dest = typeof o.dest === 'string' ? await doc.getDestination(o.dest) : o.dest;
      if (Array.isArray(dest) && dest[0] !== undefined && dest[0] !== null) {
        try {
          const ref = dest[0] as Parameters<PDFDocumentProxy['getPageIndex']>[0] | number;
          const idx = typeof ref === 'number' ? ref : await doc.getPageIndex(ref);
          const page = await doc.getPage(idx + 1);
          const vp = page.getViewport({ scale: 1 });
          const yTop = (dest[1] as { name?: string })?.name === 'XYZ' && typeof dest[3] === 'number' ? vp.convertToViewportPoint(0, dest[3] as number)[1] : null;
          flat.push({ title: o.title, page: idx + 1, y: yTop });
        } catch { /* 坏书签跳过 */ }
      }
      if (o.items?.length) await walk(o.items);
    }
  };
  await walk(outline);
  const refIdx = flat.map((f, i) => (REFS.test(f.title) ? i : -1)).filter((i) => i >= 0);
  if (!refIdx.length) return null;
  const sorted = [...flat].sort((a, b) => a.page - b.page || (a.y ?? 0) - (b.y ?? 0));
  const zones = new Map<number, RefZone>();
  for (const i of refIdx) {
    const r = flat[i];
    const k = sorted.indexOf(r);
    const next = sorted.slice(k + 1).find((f) => f.page > r.page || (f.y !== null && r.y !== null && f.y > r.y + 1));
    // 标题本身照常翻译：从标题下方开始
    const start = (r.y ?? 0) + 1;
    const lastPage = next ? next.page : doc.numPages;
    for (let p = r.page; p <= lastPage; p++) {
      const s = p === r.page ? start : -Infinity;
      const e = next && p === next.page ? (next.y ?? -Infinity) : Infinity;
      if (e <= s) continue;
      zones.set(p, { start: s, end: e });
    }
  }
  return zones;
}

function isBold(l: Line): boolean {
  let b = 0;
  let n = 0;
  for (const it of l.items) {
    n += it.str.length;
    if (it.bold) b += it.str.length;
  }
  return b > n * 0.6;
}

function lineText(l: Line): string {
  return l.items.map((i) => i.str).join('');
}

function union(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}
