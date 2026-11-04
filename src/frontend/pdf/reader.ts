/**
 * PDF 双栏阅读器（扩展页面 pdf.html）—— 保留原排版。
 *
 *   pdf.html?url=https://…/paper.pdf     打开网上的 PDF
 *   pdf.html                              拖入或选择本地文件
 *
 * 右栏不是另起一张白纸，而是「在原页上换字」：
 * - 先把原页完整画出来（图、表、公式、页眉页码都在）；
 * - 只把正文段落所在的行抹成原背景色，再用原字号、原行距、原文字颜色和粗细写上译文，
 *   正文两端对齐，标题加粗，衬线 / 无衬线跟原文一致；
 * - 公式、表格、纯数字、参考文献条目原样保留；段落里夹的行内公式把原图裁下来嵌回译文；
 * - 段落由前端用 PDF.js 文本层分析（./layout.ts），译文走普通翻译端口（综合模式先浅后深）；
 *   没有文本层的扫描页交给后端 pdf:translate（本地 OCR）。
 * 鼠标停在任一侧的段落上，两侧同时高亮。只处理滚动到附近的页。
 *
 * 阅读功能：书签目录 / 缩略图侧栏、跳页、缩放、左栏原文可以选中复制、记住上次读到哪一页、
 * 打印或另存译文版（先把整本翻完，再只打印右栏，一页对一页）。
 */
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import type { Mode, Stage, TranslateJob } from '../../shared/protocol';
import { rpc, uid } from '../../shared/rpc';
import { hostMatches, loadUiSettings, type UiSettings } from '../../shared/settings';
import { TranslateClient } from '../content/port';
import { mediaCaps } from '../media/capabilities';
import { fromCanvas, rgb, sampleBox, type BoxColors, type Pixels } from '../media/pixels';
import { h, UI_FONT, UiHost } from '../ui/host';
import { SelectionUi } from '../ui/selection';
import { logoElement } from '../ui/logo';
import { estimateLength, revealText, startScramble, stopScramble } from '../ui/scramble';
import { extractLayout, scanSections, type Para, type Sections } from './layout';
import { ReaderLifetime, distantPages } from './lifetime';
import { PdfBackendDocument } from './backend-document';
import { accentCss, PAGE_THEME_CSS } from '../theme';
import { L, setUiLang } from '../i18n';

const MAX_BACKEND_BYTES = 25 * 1024 * 1024;
const SERIF = '"Times New Roman", "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", STSong, SimSun, serif';
const SANS = 'Helvetica, Arial, "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif';

const CSS = `
${PAGE_THEME_CSS}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg-deep); color: var(--ink); font: 14px/1.5 ${UI_FONT}; }
.bar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 14px; padding: 10px 18px; background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
.bar .mark { width: 28px; height: 28px; border-radius: 8px; background: var(--accent); color: #fff; --logo-accent: rgba(255,255,255,.7); display: grid; place-items: center; flex: none; }
.bar .name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 34vw; }
.bar .meta { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.linkbtn { color: var(--danger, #c0392b); text-decoration: underline; text-underline-offset: 2px; font: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.bar .grow { flex: 1; }
.seg { display: inline-flex; background: color-mix(in srgb, var(--ink) 6%, transparent); border-radius: 8px; padding: 2px; }
.seg button { font: inherit; font-size: 12.5px; border: 0; background: none; color: var(--muted); padding: 4px 10px; border-radius: 6px; cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
select, .btn { font: inherit; font-size: 12.5px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; cursor: pointer; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.pages { display: grid; gap: 26px; padding: 22px 18px 80px; justify-content: center; }
.pg { display: grid; grid-template-columns: var(--w) var(--w); gap: 14px; }
body[data-view="translation"] .pg, body[data-view="original"] .pg { grid-template-columns: var(--w); }
body[data-view="translation"] .orig, body[data-view="original"] .trans { display: none; }
.pglabel { grid-column: 1 / -1; font-size: 12px; color: var(--muted); margin-bottom: -8px; }
.orig, .trans { position: relative; width: 100%; height: var(--h); background: #fff; border-radius: 3px; box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 8px 24px -12px rgba(0,0,0,.18); overflow: hidden; }
.orig canvas.page, .trans canvas.page { position: absolute; inset: 0; width: 100%; height: 100%; }
.layer { position: absolute; inset: 0; }
.hl-layer div { position: absolute; border-radius: 2px; }
.hl-layer div.on, .tp.on { background: var(--mark); }
.tp { position: absolute; margin: 0; overflow-wrap: break-word; hyphens: auto; text-align-last: left; transition: opacity .25s; cursor: default; border-radius: 2px; }
.tp[data-stage="pending"] .tx-scr { opacity: .35; }
.tp[data-stage="fast"] { opacity: .72; }
.tp canvas { display: inline-block; vertical-align: var(--va, -0.2em); }
.fail { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); color: var(--critical); background: #fff; border: 1px solid #f3c2c2; border-radius: 8px; padding: 6px 10px; font-size: 12.5px; z-index: 2; }
.empty { max-width: 560px; margin: 12vh auto; background: var(--surface); border: 1px dashed var(--line); border-radius: 14px; padding: 36px; text-align: center; }
.empty h2 { margin: 0 0 6px; font-size: 18px; }
.empty p { color: var(--muted); margin: 0 0 20px; }
.empty .row { display: flex; gap: 8px; }
.empty input[type=url] { flex: 1; font: inherit; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); }
.empty.drag { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--surface)); }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--ink); color: var(--surface); padding: 8px 14px; border-radius: 8px; font-size: 13px; max-width: 80vw; z-index: 20; }
.iconbtn { font: inherit; font-size: 13px; width: 30px; height: 30px; display: inline-grid; place-items: center; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 8px; cursor: pointer; flex: none; }
.iconbtn[aria-pressed="true"] { background: var(--hover); }
.iconbtn svg { width: 16px; height: 16px; }
.pnav { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; color: var(--muted); }
.pnav input { width: 52px; font: inherit; font-size: 12.5px; text-align: right; padding: 4px 6px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--ink); }
.zoom { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.zoom button { font: inherit; font-size: 12.5px; border: 0; background: var(--surface); color: var(--ink); padding: 4px 9px; cursor: pointer; min-width: 30px; }
.zoom button + button { border-left: 1px solid var(--line); }
.zoom .z { min-width: 54px; font-variant-numeric: tabular-nums; }
.side { position: fixed; left: 0; top: var(--bar-h, 50px); bottom: 0; width: 252px; z-index: 4; background: var(--surface); border-right: 1px solid var(--line); display: flex; flex-direction: column; transform: translateX(-100%); transition: transform .18s ease; }
body.side-open .side { transform: none; }
body.side-open .pages { margin-left: 252px; }
.side .tabs { display: flex; gap: 2px; padding: 8px; border-bottom: 1px solid var(--line); }
.side .tabs button { flex: 1; font: inherit; font-size: 12.5px; border: 0; background: none; color: var(--muted); padding: 5px; border-radius: 6px; cursor: pointer; }
.side .tabs button[aria-pressed="true"] { background: var(--hover); color: var(--ink); font-weight: 600; }
.side .body { flex: 1; overflow: auto; padding: 6px 8px 24px; }
.outline a { display: block; padding: 4px 8px; border-radius: 6px; color: var(--ink); text-decoration: none; font-size: 12.5px; line-height: 1.4; }
.outline a:hover, .outline a[aria-current="true"] { background: var(--hover); }
.outline a span { color: var(--muted); float: right; margin-left: 8px; font-variant-numeric: tabular-nums; }
.outline .empty-note { color: var(--muted); font-size: 12.5px; padding: 10px 8px; }
.thumbs { display: grid; gap: 12px; justify-items: center; padding-top: 6px; }
.thumb { display: grid; gap: 4px; justify-items: center; font-size: 11.5px; color: var(--muted); cursor: pointer; border: 0; background: none; padding: 4px; border-radius: 8px; }
.thumb .tc { width: 160px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.18); border-radius: 2px; overflow: hidden; }
.thumb .tc canvas { display: block; width: 100%; height: 100%; }
.thumb[aria-current="true"] { background: var(--hover); color: var(--ink); font-weight: 600; }
.pg { scroll-margin-top: calc(var(--bar-h, 50px) + 12px); }
/* 左栏原文可以选中复制：PDF.js 文本层（透明文字叠在画布上） */
.orig .textLayer { position: absolute; inset: 0; overflow: clip; line-height: 1; text-align: initial; -webkit-text-size-adjust: none; text-size-adjust: none; forced-color-adjust: none; transform-origin: 0 0; z-index: 2;
  --user-unit: 1; --total-scale-factor: calc(var(--scale-factor) * var(--user-unit)); --scale-round-x: 1px; --scale-round-y: 1px;
  --min-font-size: 1; --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size)); --min-font-size-inv: calc(1 / var(--min-font-size)); }
.orig .textLayer :is(span, br) { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; user-select: text; }
.orig .textLayer > :not(.markedContent), .orig .textLayer .markedContent span:not(.markedContent) { z-index: 1; --font-height: 0; font-size: calc(var(--text-scale-factor) * var(--font-height)); --scale-x: 1; --rotate: 0deg; transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv)); }
.orig .textLayer .markedContent { display: contents; }
.orig .textLayer span::selection { background: color-mix(in srgb, var(--accent) 30%, transparent); }
.orig .textLayer br::selection { background: transparent; }
.orig .textLayer .endOfContent { display: block; position: absolute; inset: 100% 0 0; z-index: 0; cursor: default; user-select: none; }
.hl-layer { pointer-events: none; }
/* 最后的保险：译文框可以拖开（版面分析没分好、挡住公式时） */
.grip { position: absolute; z-index: 3; width: 18px; height: 22px; display: none; place-items: center; cursor: grab; user-select: none; touch-action: none;
  color: var(--muted); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; box-shadow: var(--shadow); font-size: 12px; line-height: 1; }
.grip.on { display: grid; }
.grip:active { cursor: grabbing; }
.tp.moved { outline: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 2px; }
@media print { .grip { display: none !important; } .tp.moved { outline: none; } }
.modal { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; background: rgba(0,0,0,.28); }
.modal .box { background: var(--surface); color: var(--ink); border-radius: 14px; padding: 22px 24px; width: min(420px, 90vw); box-shadow: 0 20px 60px -20px rgba(0,0,0,.4); }
.modal h3 { margin: 0 0 6px; font-size: 16px; }
.modal p { margin: 0 0 16px; color: var(--muted); font-size: 13px; }
.modal .acts { display: flex; gap: 8px; justify-content: flex-end; }
.modal progress { width: 100%; margin: 4px 0 14px; }
@media print {
  body { background: #fff; }
  .bar, .side, .pglabel, .orig, .toast, .modal, .fail { display: none !important; }
  body.side-open .pages { margin: 0; }
  .pages { display: block; padding: 0; }
  .pg { display: block; margin: 0; break-after: page; break-inside: avoid; }
  .trans { zoom: var(--pz, 1); box-shadow: none; border-radius: 0; width: var(--w); height: var(--h); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .tp.on { background: none; }
}
`;

interface RPara {
  p: Para;
  colors: BoxColors;
  el?: HTMLElement;
  mark?: HTMLElement;
  stage: 'pending' | Stage | 'error';
  text?: string;
}

interface Shell {
  n: number;
  el: HTMLElement;
  orig: HTMLElement;
  trans: HTMLElement;
  hl: HTMLElement;
  textLayer: HTMLElement;
  /** 左栏透明文字层（可以选中复制原文）。 */
  origText: HTMLElement;
  width: number;
  height: number;
  /** orig：单栏阅读（仅原文）时只画了原页和文字层，没有翻译。 */
  state: 'idle' | 'working' | 'done' | 'error' | 'orig';
  canvas?: HTMLCanvasElement;
  sheet?: HTMLCanvasElement;
  scale: number; // CSS 像素 / PDF 点
  dpr: number;
  paras: RPara[];
  jobId?: string;
  token: number;
  /** 这一页送去翻译的段数 / 已出最终译文 / 失败。 */
  total?: number;
  ok?: number;
  failed?: number;
  pageFailed?: boolean;
  failure?: string;
  evicted?: boolean;
  controller?: AbortController;
  textTask?: TextLayer;
}

const readers = new WeakMap<HTMLElement, ReaderLifetime>();

export async function mountPdfReader(root: HTMLElement): Promise<void> {
  document.head.appendChild(h('style', null, CSS));
  GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('assets/pdf/pdf.worker.min.mjs');
  const settings = await loadUiSettings();
  setUiLang(settings.uiLang);
  // 用户选的主题色
  document.head.appendChild(h('style', null, `@media not (forced-colors: active) { ${accentCss(settings.appearance.accent, ':root', ':root[data-theme="dark"]')} }`));
  const url = new URLSearchParams(location.search).get('url');
  if (url) await openPdf(root, settings, { url });
  else showPicker(root, settings);
}

function showPicker(root: HTMLElement, settings: UiSettings) {
  const input = h('input', { type: 'url', placeholder: 'https://arxiv.org/pdf/…' }) as HTMLInputElement;
  const go = h('button', { class: 'btn primary', type: 'button' }, L('打开', 'Open'));
  const file = h('input', { type: 'file', accept: 'application/pdf,.pdf', style: 'display:none' }) as HTMLInputElement;
  const pick = h('button', { class: 'btn', type: 'button' }, L('选择本地文件', 'Choose a local file'));
  const box = h('div', { class: 'empty' },
    h('h2', null, L('PDF 双栏对照阅读', 'PDF side-by-side reader')),
    h('p', null, L('右边在原页上换成译文：图、表、公式和排版都保持不变。拖入 PDF 文件，或者粘贴网址。', 'The right side replaces the text on the original page with the translation, keeping figures, tables, formulas and layout. Drop a PDF here or paste a URL.')),
    h('div', { class: 'row' }, input, go),
    h('div', { style: 'margin-top:12px' }, pick, file),
  );
  readers.get(root)?.dispose();
  root.replaceChildren(box);
  const openUrl = () => {
    const u = input.value.trim();
    if (!u) return;
    history.replaceState(null, '', `?url=${encodeURIComponent(u)}`);
    void openPdf(root, settings, { url: u });
  };
  go.addEventListener('click', openUrl);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && openUrl());
  pick.addEventListener('click', () => file.click());
  file.addEventListener('change', () => file.files?.[0] && void openPdf(root, settings, { file: file.files[0] }));
  box.addEventListener('dragover', (e) => {
    e.preventDefault();
    box.classList.add('drag');
  });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('drag');
    const f = e.dataTransfer?.files?.[0];
    if (f) void openPdf(root, settings, { file: f });
  });
}

function toast(text: string, ms = 4000) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function openPdf(root: HTMLElement, settings: UiSettings, src: { url?: string; file?: File }) {
  readers.get(root)?.dispose();
  const life = new ReaderLifetime();
  readers.set(root, life);
  window.addEventListener('pagehide', () => life.dispose(), { once: true, signal: life.signal });
  document.body.classList.remove('side-open');
  root.replaceChildren(h('div', { class: 'empty' }, h('p', null, L('正在打开…', 'Opening…'))));
  let bytes: Uint8Array;
  let name: string;
  try {
    if (src.file) {
      bytes = new Uint8Array(await src.file.arrayBuffer());
      name = src.file.name;
    } else {
      const res = await fetch(src.url!, { credentials: 'omit', signal: life.signal });
      if (!res.ok) throw new Error(L(`下载失败：HTTP ${res.status}`, `Download failed: HTTP ${res.status}`));
      bytes = new Uint8Array(await res.arrayBuffer());
      name = decodeURIComponent(new URL(src.url!).pathname.split('/').pop() || 'document.pdf');
    }
  } catch (e) {
    if (!life.active) return;
    root.replaceChildren(h('div', { class: 'empty' }, h('h2', null, L('打不开这个 PDF', 'Can\'t open this PDF')), h('p', null, String((e as Error).message ?? e))));
    return;
  }
  if (!life.active) return;
  document.title = L(`${name} · 译`, `${name} · translated`);
  const caps = await mediaCaps();
  if (!life.active) return;
  const backendSrc =
    src.url ? { url: src.url }
    : bytes.byteLength <= MAX_BACKEND_BYTES ? { dataUrl: 'data:application/pdf;base64,' + base64(bytes) }
    : null;

  let doc: PDFDocumentProxy;
  try {
    const loading = getDocument({
      data: bytes.slice(),
      cMapUrl: chrome.runtime.getURL('assets/pdf/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL('assets/pdf/standard_fonts/'),
      wasmUrl: chrome.runtime.getURL('assets/pdf/wasm/'),
      // 要字体的原名（CMMI、STIX 这类数学字体靠名字认）；PDF.js 6.5 起默认不再导出
      fontExtraProperties: true,
    });
    life.add(() => { void loading.destroy().catch(() => {}); });
    doc = await loading.promise;
    if (!life.active) return;
  } catch (e) {
    if (!life.active) return;
    root.replaceChildren(h('div', { class: 'empty' }, h('h2', null, L('无法解析这个 PDF', 'Can\'t parse this PDF')), h('p', null, String((e as Error).message ?? e))));
    return;
  }

  const client = new TranslateClient();
  life.add(() => client.dispose());
  // 划词浮窗属于阅读器页面，跨文档只保留一份 UI 和独立连接。
  selectionClient ??= new TranslateClient();
  life.add(() => selectionClient?.cancelAll());
  const noCache = !!src.url && hostMatches(new URL(src.url).hostname, settings.sensitive);
  const backend = backendSrc ? new PdfBackendDocument(backendSrc, caps, noCache) : null;
  if (backend) life.add(() => backend.close());
  // 划词翻译：左栏原文（文字层）里选中文字就出现小圆点，和网页上一样
  selectionUi ??= new SelectionUi(new UiHost(), selectionClient, settings);
  selectionUi.apply(settings);
  const target = settings.targetLang;
  const source = settings.sourceLang || 'auto';
  let mode: Mode = settings.mode;
  // ?view=original：单栏阅读，不整篇翻译，选中文字时再翻
  const wantView = new URLSearchParams(location.search).get('view');
  let view: 'both' | 'translation' | 'original' = wantView === 'original' || wantView === 'translation' ? wantView : 'both';
  // 记住每个文件读到第几页、缩放多少（本机，最多记 40 个文件）
  const docKey = src.url ? 'u:' + src.url : `f:${name}:${bytes.byteLength}`;
  const resume = await loadResume(docKey);
  const moves = await loadMoves(docKey);
  if (!life.active) return;
  let zoom = resume?.zoom && resume.zoom >= 0.5 && resume.zoom <= 3 ? resume.zoom : 1;
  let sideOpen = false;
  // 无书签时只扫描到所读页；前缀文字层会复用，文献区不会因为先跳后页而误判。
  const sectionsFor = (n: number): Promise<Sections | null> => scanSections(doc, { throughPage: n, signal: life.signal }).catch(() => null);
  const sectionsP = sectionsFor(1);

  /* ---------------- 顶栏 ---------------- */
  const meta = h('span', { class: 'meta' });
  const viewSeg = h('div', { class: 'seg', role: 'group', 'aria-label': L('显示方式', 'View') });
  for (const [v, label] of [['both', L('对照', 'Side by side')], ['translation', L('仅译文', 'Translation only')], ['original', L('仅原文', 'Original only')]] as const) {
    const b = h('button', { type: 'button', 'aria-pressed': String(v === view) }, label);
    b.addEventListener('click', () => {
      view = v;
      viewSeg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      document.body.dataset.view = v;
      // 从单栏阅读切到对照 / 仅译文：只画了原页的页重新处理（这时才翻译）
      if (v !== 'original') for (const sh of shells) if (sh.state === 'orig') resetShell(sh);
      relayout();
    });
    viewSeg.append(b);
  }
  const modeSel = h('select', { 'aria-label': L('翻译模式', 'Translation mode') }) as HTMLSelectElement;
  for (const [v, label] of [['combined', L('综合', 'Combined')], ['accurate', L('精确', 'Accurate')], ['fast', L('快速', 'Fast')]] as const) modeSel.append(h('option', { value: v, selected: v === mode }, label));
  modeSel.addEventListener('change', () => {
    mode = modeSel.value as Mode;
    for (const s of shells) if (s.state !== 'idle') resetShell(s);
    io.disconnect();
    shells.forEach((s) => io.observe(s.el));
  });
  // 侧栏（书签目录 / 缩略图）
  const sideBtn = h('button', { class: 'iconbtn', type: 'button', title: L('目录和缩略图', 'Outline and thumbnails'), 'aria-label': L('目录和缩略图', 'Outline and thumbnails'), 'aria-pressed': 'false' });
  sideBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
  sideBtn.addEventListener('click', () => toggleSide());
  // 跳页
  const pageInput = h('input', { type: 'number', min: '1', max: String(doc.numPages), value: '1', 'aria-label': L('页码', 'Page') }) as HTMLInputElement;
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goTo(Number(pageInput.value));
  });
  pageInput.addEventListener('change', () => goTo(Number(pageInput.value)));
  const pnav = h('span', { class: 'pnav' }, pageInput, `/ ${doc.numPages}`);
  // 缩放
  const zLabel = h('button', { class: 'z', type: 'button', title: L('恢复适合宽度', 'Fit width') }, '100%');
  const zOut = h('button', { type: 'button', title: L('缩小（Ctrl + -）', 'Zoom out (Ctrl + -)'), 'aria-label': L('缩小', 'Zoom out') }, '−');
  const zIn = h('button', { type: 'button', title: L('放大（Ctrl + =）', 'Zoom in (Ctrl + =)'), 'aria-label': L('放大', 'Zoom in') }, '+');
  zOut.addEventListener('click', () => setZoom(stepZoom(zoom, -1)));
  zIn.addEventListener('click', () => setZoom(stepZoom(zoom, 1)));
  zLabel.addEventListener('click', () => setZoom(1));
  const zoomBox = h('span', { class: 'zoom', role: 'group', 'aria-label': L('缩放', 'Zoom') }, zOut, zLabel, zIn);
  // 打印 / 另存为 PDF
  const printBtn = h('button', { class: 'btn', type: 'button', title: L('打印右栏的译文版，或在打印对话框里选「另存为 PDF」', 'Print the translated (right) side, or choose “Save as PDF” in the print dialog') }, L('打印 / 存 PDF', 'Print / Save PDF'));
  printBtn.addEventListener('click', () => void printTranslated());
  const openBtn = h('button', { class: 'btn', type: 'button' }, L('打开其他文件', 'Open another file'));
  openBtn.addEventListener('click', () => {
    life.dispose();
    history.replaceState(null, '', location.pathname);
    showPicker(root, settings);
  });
  const pagesEl = h('div', { class: 'pages' });
  const sideBody = h('div', { class: 'body' });
  const tabOutline = h('button', { type: 'button', 'aria-pressed': 'true' }, L('目录', 'Outline'));
  const tabThumbs = h('button', { type: 'button', 'aria-pressed': 'false' }, L('缩略图', 'Thumbnails'));
  const side = h('aside', { class: 'side', 'aria-label': L('目录和缩略图', 'Outline and thumbnails') }, h('div', { class: 'tabs' }, tabOutline, tabThumbs), sideBody);
  const bar = h('div', { class: 'bar' },
    h('span', { class: 'mark' }, logoElement({ size: 18 })),
    sideBtn,
    h('span', { class: 'name', title: name }, name),
    meta,
    h('span', { class: 'grow' }),
    pnav, zoomBox, viewSeg, modeSel, printBtn, openBtn,
  );
  root.replaceChildren(bar, side, pagesEl);
  document.body.dataset.view = view;
  const barH = () => document.documentElement.style.setProperty('--bar-h', `${bar.offsetHeight}px`);
  barH();

  /* ---------------- 页面外壳 ---------------- */
  const vp1 = (await doc.getPage(1)).getViewport({ scale: 1 });
  if (!life.active) return;
  const shells: Shell[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const hl = h('div', { class: 'layer hl-layer' });
    const origText = h('div', { class: 'textLayer' });
    const orig = h('div', { class: 'orig' }, hl, origText);
    const textLayer = h('div', { class: 'layer', lang: target });
    const trans = h('div', { class: 'trans' }, textLayer);
    const el = h('section', { class: 'pg', 'data-page': String(n) }, h('div', { class: 'pglabel' }, L(`第 ${n} 页`, `Page ${n}`)), orig, trans);
    pagesEl.append(el);
    const shell: Shell = { n, el, orig, trans, hl, textLayer, origText, width: vp1.width, height: vp1.height, state: 'idle', scale: 1, dpr: 1, paras: [], token: 0, total: 0, ok: 0, failed: 0 };
    shells.push(shell);
    // 原文一侧：文本层盖在上面（为了能选中复制），按坐标找到鼠标下面的段落，两侧一起高亮
    orig.addEventListener('mousemove', (e) => {
      const r = orig.getBoundingClientRect();
      const x = (e.clientX - r.left) / shell.scale;
      const y = (e.clientY - r.top) / shell.scale;
      const hit = shell.paras.find((q) => x >= q.p.x0 - 2 && x <= q.p.x1 + 2 && y >= q.p.y0 - 2 && y <= q.p.y1 + 2 && q.el);
      setHover(hit ?? null);
    });
    orig.addEventListener('mouseleave', () => setHover(null));
  }
  let hovered: RPara | null = null;
  function setHover(r: RPara | null) {
    if (hovered === r) return;
    hovered?.el?.classList.remove('on');
    hovered?.mark?.classList.remove('on');
    hovered = r;
    r?.el?.classList.add('on');
    r?.mark?.classList.add('on');
  }
  const updateMeta = () => {
    // 分开统计：真正翻译了的页、按规则保留原文的页（空白页、只有公式 / 参考文献）、失败的段
    const done = shells.filter((s) => s.state === 'done' && !s.pageFailed);
    const translated = done.filter((s) => (s.ok ?? 0) > 0).length;
    const kept = done.filter((s) => !(s.total ?? 0)).length;
    const failed = shells.reduce((n, s) => n + (s.failed ?? 0), 0);
    const failedPages = shells.filter((s) => s.pageFailed || s.state === 'error').length;
    const working = shells.filter((s) => s.state === 'working').length;
    if (view === 'original' && !translated) {
      meta.replaceChildren(L(`共 ${doc.numPages} 页 · 单栏阅读：选中文字就能翻译，切到「对照」再整篇翻译`, `${doc.numPages} pages · single view: select text to translate it; switch to “Side by side” to translate everything`));
      return;
    }
    meta.replaceChildren(
      L(`共 ${doc.numPages} 页 · 已翻译 ${translated} 页`, `${doc.numPages} pages · ${translated} translated`),
      kept ? L(` · 原样保留 ${kept} 页`, ` · ${kept} kept as is`) : '',
      working ? L(` · 正在翻译 ${working} 页`, ` · translating ${working}`) : '',
    );
    if (failed || failedPages) {
      const retry = h('button', { class: 'linkbtn', type: 'button', title: L('重新处理失败的页，成功结果可复用后端缓存', 'Retry failed pages; successful results can reuse the backend cache') }, L(`${failedPages} 页 / ${failed} 段失败，重试`, `${failedPages} pages / ${failed} paragraphs failed, retry`));
      retry.addEventListener('click', () => {
        for (const s of shells) if (s.failed || s.pageFailed || s.state === 'error') { resetShell(s); queuePage(s, true); }
        io.disconnect();
        shells.forEach((x) => io.observe(x.el));
      });
      meta.append(' · ', retry);
    }
  };
  updateMeta();
  // 测试和排查用：?debug 时把文档和版面分析挂到 window 上
  if (new URLSearchParams(location.search).has('debug')) {
    (window as unknown as Record<string, unknown>).__txPdf = { doc, shells, sectionsP, extractLayout, target };
  }

  const colWidth = () => {
    const avail = Math.min(window.innerWidth - 36 - (sideOpen ? 252 : 0), 1640);
    const fit = view === 'both' ? Math.floor((avail - 14) / 2) : Math.min(avail, 980);
    return Math.round(fit * zoom);
  };
  const sizeShell = (s: Shell) => {
    const w = colWidth();
    s.el.style.setProperty('--w', `${w}px`);
    s.el.style.setProperty('--h', `${Math.round((w * s.height) / s.width)}px`);
  };
  shells.forEach(sizeShell);
  const relayout = () => {
    for (const s of shells) {
      sizeShell(s);
      if (s.state !== 'idle' && Math.abs(colWidth() / s.width - s.scale) > 0.01) {
        if (s.state === 'working') resetShell(s);
        else evictShell(s);
      }
    }
    io.disconnect();
    shells.forEach((x) => io.observe(x.el));
  };
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    barH();
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => life.active && relayout(), 250);
  }, { signal: life.signal });

  /* ---------------- 跳页、当前页、记住读到哪里 ---------------- */
  let current = 1;
  function goTo(n: number) {
    if (!Number.isFinite(n)) return;
    const k = Math.max(1, Math.min(doc.numPages, Math.round(n)));
    shells[k - 1].el.scrollIntoView({ block: 'start' });
    pageInput.value = String(k);
  }
  let saveTimer = 0;
  let scrollRaf = 0;
  const trackPage = () => {
    scrollRaf = 0;
    const top = bar.offsetHeight + 40;
    // 二分找第一个底边在顶栏下面的页
    let lo = 0;
    let hi = shells.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (shells[mid].el.getBoundingClientRect().bottom > top) hi = mid;
      else lo = mid + 1;
    }
    const n = lo + 1;
    if (n === current) return;
    current = n;
    if (document.activeElement !== pageInput) pageInput.value = String(n);
    markCurrent();
    trimPages();
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void saveResume(docKey, { page: current, zoom }), 600);
  };
  window.addEventListener('scroll', () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(trackPage); }, { passive: true, signal: life.signal });

  /* ---------------- 缩放 ---------------- */
  function setZoom(z: number) {
    const keep = current;
    zoom = Math.max(0.5, Math.min(3, z));
    zLabel.textContent = `${Math.round(zoom * 100)}%`;
    relayout();
    goTo(keep);
    void saveResume(docKey, { page: keep, zoom });
  }
  zLabel.textContent = `${Math.round(zoom * 100)}%`;
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(stepZoom(zoom, 1)); }
    else if (e.key === '-') { e.preventDefault(); setZoom(stepZoom(zoom, -1)); }
    else if (e.key === '0') { e.preventDefault(); setZoom(1); }
  }, { signal: life.signal });

  /* ---------------- 侧栏：书签目录 / 缩略图 ---------------- */
  let sideTab: 'outline' | 'thumbs' = 'outline';
  let sideBuilt = false;
  const outlineBox = h('nav', { class: 'outline' });
  const thumbsBox = h('div', { class: 'thumbs' });
  const thumbIo = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { thumbIo.unobserve(e.target); void renderThumb(e.target as HTMLElement); }
  }, { root: sideBody, rootMargin: '200px 0px' });
  let thumbQueue = Promise.resolve();
  function renderThumb(el: HTMLElement) {
    thumbQueue = thumbQueue.then(async () => {
      if (!life.active) return;
      const n = Number(el.dataset.page);
      const page = await doc.getPage(n);
      if (!life.active) return;
      const vp = page.getViewport({ scale: 1 });
      const c = await renderCanvas(page, (160 / vp.width) * Math.min(2, window.devicePixelRatio || 1), life.signal);
      if (!life.active) { c.width = c.height = 0; return; }
      c.className = '';
      el.querySelector('.tc')!.replaceChildren(c);
      // 缩略图也有上限，重新滚回时由 observer 恢复。
      const thumbs = [...thumbsBox.querySelectorAll<HTMLCanvasElement>('canvas')];
      for (const old of thumbs.sort((a, b) => Math.abs(Number(b.closest<HTMLElement>('[data-page]')?.dataset.page) - n) - Math.abs(Number(a.closest<HTMLElement>('[data-page]')?.dataset.page) - n)).slice(0, Math.max(0, thumbs.length - 32))) {
        const button = old.closest<HTMLElement>('[data-page]'); old.width = old.height = 0; old.remove();
        if (button) thumbIo.observe(button);
      }
    }).catch(() => {});
    return thumbQueue;
  }
  async function buildSide() {
    if (sideBuilt) return;
    sideBuilt = true;
    for (let n = 1; n <= doc.numPages; n++) {
      const tc = h('div', { class: 'tc' });
      tc.style.aspectRatio = `${shells[n - 1].width} / ${shells[n - 1].height}`;
      const b = h('button', { class: 'thumb', type: 'button', 'data-page': String(n) }, tc, String(n));
      b.addEventListener('click', () => goTo(n));
      thumbsBox.append(b);
      thumbIo.observe(b);
    }
    const items = await loadOutline(doc).catch(() => []);
    if (!life.active) return;
    if (!items.length) {
      outlineBox.append(h('div', { class: 'empty-note' }, L('这个 PDF 没有书签目录，可以看缩略图。', 'This PDF has no bookmarks; use the thumbnails.')));
      if (sideTab === 'outline') showTab('thumbs');
    }
    for (const it of items) {
      const a = h('a', { href: '#', 'data-page': String(it.page) }, it.title, h('span', null, String(it.page)));
      a.style.paddingLeft = `${8 + it.depth * 14}px`;
      if (it.depth === 0) a.style.fontWeight = '600';
      a.addEventListener('click', (e) => { e.preventDefault(); goTo(it.page); });
      outlineBox.append(a);
    }
    markCurrent();
  }
  function showTab(t: 'outline' | 'thumbs') {
    sideTab = t;
    tabOutline.setAttribute('aria-pressed', String(t === 'outline'));
    tabThumbs.setAttribute('aria-pressed', String(t === 'thumbs'));
    sideBody.replaceChildren(t === 'outline' ? outlineBox : thumbsBox);
    markCurrent();
  }
  tabOutline.addEventListener('click', () => showTab('outline'));
  tabThumbs.addEventListener('click', () => showTab('thumbs'));
  function markCurrent() {
    thumbsBox.querySelectorAll('[aria-current]').forEach((x) => x.removeAttribute('aria-current'));
    const t = thumbsBox.querySelector(`[data-page="${current}"]`);
    t?.setAttribute('aria-current', 'true');
    if (sideOpen && sideTab === 'thumbs') t?.scrollIntoView({ block: 'nearest' });
    // 目录里标出当前所在的章节：页码不超过当前页的最后一条
    let best: Element | null = null;
    outlineBox.querySelectorAll('a').forEach((a) => {
      a.removeAttribute('aria-current');
      if (Number((a as HTMLElement).dataset.page) <= current) best = a;
    });
    (best as HTMLElement | null)?.setAttribute('aria-current', 'true');
  }
  function toggleSide(on = !sideOpen) {
    sideOpen = on;
    document.body.classList.toggle('side-open', on);
    sideBtn.setAttribute('aria-pressed', String(on));
    if (on) {
      void buildSide();
      if (!sideBody.firstChild) showTab(sideTab);
    }
    const keep = current;
    relayout();
    goTo(keep);
  }

  /* ---------------- 打印 / 另存译文版 ---------------- */
  let printing = false;
  async function printTranslated() {
    if (printing || !life.active) return;
    printing = true;
    let box: HTMLElement | undefined;
    let stop = false;
    let release = () => {};
    try {
      if (view === 'original') (viewSeg.querySelector('button') as HTMLButtonElement | null)?.click();
      const pending = () => shells.filter((s) => s.state !== 'done' || s.evicted || s.pageFailed || s.failed);
      if (pending().length) {
        const prog = h('progress', { max: String(doc.numPages), value: String(doc.numPages - pending().length) }) as HTMLProgressElement;
        const note = h('p', null, L('打印前会补齐所有页并重试失败页；如果仍有失败，不会自动打印。', 'Before printing, all pages are completed and failed pages retried. Printing will not start if any page still fails.'));
        const cancel = h('button', { class: 'btn', type: 'button' }, L('取消', 'Cancel'));
        const go = h('button', { class: 'btn primary', type: 'button' }, L('开始翻译', 'Start translating'));
        box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'box' }, h('h3', null, L('打印译文版', 'Print translation')), note, prog, h('div', { class: 'acts' }, cancel, go)));
        document.body.append(box);
        let resolveStart: (v: boolean) => void = () => {};
        const close = () => { stop = true; box?.remove(); resolveStart(false); };
        release = life.add(close);
        cancel.addEventListener('click', close);
        box.addEventListener('keydown', (e) => e.key === 'Escape' && close());
        go.focus();
        const started = await new Promise<boolean>((resolve) => { resolveStart = resolve; go.addEventListener('click', () => resolve(true), { once: true }); });
        if (!started || stop || !life.active) return;
        go.disabled = true;
        const queue = pending();
        const worker = async () => {
          for (let sh = queue.shift(); sh && !stop && life.active; sh = queue.shift()) {
            if (sh.pageFailed || sh.failed || sh.state === 'error') resetShell(sh);
            await runPage(sh);
            while (!stop && life.active && sh.state === 'working') await new Promise((r) => setTimeout(r, 100));
            prog.value = doc.numPages - pending().length;
            note.textContent = L('正在准备：', 'Preparing: ') + prog.value + ' / ' + doc.numPages;
          }
        };
        await Promise.all([worker(), worker(), worker()]);
      }
      if (stop || !life.active) return;
      if (shells.some((sh) => sh.state !== 'done' || sh.pageFailed || sh.failed || !sh.sheet)) {
        toast(L('仍有页面翻译失败，请使用页上的「重试这一页」后再打印。', 'Some pages failed. Use “Retry this page” before printing.'));
        return;
      }
      let ps = document.getElementById('tx-print-page');
      if (!ps) { ps = h('style', { id: 'tx-print-page' }); document.head.append(ps); }
      ps.textContent = '@page { size: ' + shells[0].width + 'pt ' + shells[0].height + 'pt; margin: 0; }';
      const w = colWidth();
      for (const sh of shells) sh.el.style.setProperty('--pz', String((sh.width * 96) / 72 / w));
      window.print();
    } finally {
      release(); box?.remove(); printing = false;
      if (life.active) trimPages();
    }
  }

  function freeCanvases(el: HTMLElement) {
    el.querySelectorAll('canvas').forEach((c) => { c.width = c.height = 0; c.remove(); });
  }

  function evictShell(sh: Shell) {
    if (sh.state === 'working') return;
    sh.textTask?.cancel(); sh.textTask = undefined;
    sh.paras.forEach((r) => { if (r.el) stopScramble(r.el); r.el = r.mark = undefined; });
    freeCanvases(sh.orig); freeCanvases(sh.trans);
    sh.canvas = sh.sheet = undefined;
    sh.textLayer.replaceChildren(); sh.hl.replaceChildren(); sh.origText.replaceChildren();
    sh.evicted = true;
  }

  function trimPages() {
    if (printing || !life.active) return;
    for (const sh of distantPages(shells, current, visible)) evictShell(sh);
  }

  function pageFailure(sh: Shell, message: string) {
    sh.pageFailed = true;
    sh.failure = message;
    sh.trans.querySelector('.fail')?.remove();
    const retry = h('button', { class: 'linkbtn', type: 'button' }, L('重试这一页', 'Retry this page'));
    retry.addEventListener('click', () => { resetShell(sh); queuePage(sh, true); });
    sh.trans.append(h('div', { class: 'fail' }, message, ' · ', retry));
    updateMeta();
  }

  function resetShell(s: Shell) {
    s.token++;
    s.controller?.abort();
    s.textTask?.cancel();
    s.textTask = undefined;
    freeCanvases(s.orig); freeCanvases(s.trans);
    s.canvas = s.sheet = undefined;
    s.evicted = s.pageFailed = false;
    s.failure = undefined;
    if (s.jobId) client.cancel(s.jobId);
    s.jobId = undefined;
    s.paras.forEach((r) => r.el && stopScramble(r.el));
    s.paras = [];
    s.textLayer.replaceChildren();
    s.hl.replaceChildren();
    s.origText.replaceChildren();
    s.trans.querySelector('.fail')?.remove();
    s.state = 'idle';
    s.total = s.ok = s.failed = 0;
    updateMeta();
  }

  /* ---------------- 处理一页 ---------------- */
  async function processPage(s: Shell) {
    if (!life.active || (s.state !== 'idle' && !s.evicted)) return;
    const previous = s.state;
    const restoring = s.evicted;
    s.evicted = false;
    s.state = 'working';
    s.controller?.abort();
    s.controller = new AbortController();
    const token = ++s.token;
    const page = await doc.getPage(s.n);
    if (!life.active || token !== s.token) return;
    const vp = page.getViewport({ scale: 1 });
    s.width = vp.width;
    s.height = vp.height;
    sizeShell(s);
    s.scale = colWidth() / vp.width;
    s.dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = await renderCanvas(page, s.scale * s.dpr, s.controller.signal);
    if (!life.active || token !== s.token) { canvas.width = canvas.height = 0; return; }
    s.orig.querySelector('canvas.page')?.remove();
    s.orig.insertBefore(canvas, s.hl);
    s.canvas = canvas;
    // 左栏的透明文字层：可以选中、复制原文
    s.origText.replaceChildren();
    s.origText.style.setProperty('--scale-factor', String(s.scale));
    s.textTask = new TextLayer({ textContentSource: page.streamTextContent(), container: s.origText, viewport: page.getViewport({ scale: s.scale }) });
    void s.textTask.render().catch(() => {});
    if (view === 'original') {
      // 单栏阅读：不翻译，省额度；切到对照时再处理
      s.state = 'orig';
      updateMeta();
      return;
    }

    // 右栏先放一张原页的拷贝，后面在上面抹字、换字
    const sheet = document.createElement('canvas');
    sheet.className = 'page';
    sheet.width = canvas.width;
    sheet.height = canvas.height;
    const sctx = sheet.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(canvas, 0, 0);
    s.trans.querySelector('canvas.page')?.remove();
    s.trans.insertBefore(sheet, s.textLayer);
    s.sheet = sheet;
    const px = fromCanvas(canvas.getContext('2d', { willReadFrequently: true })!, s.scale * s.dpr);

    if (restoring && previous !== 'orig' && previous !== 'idle') {
      for (const r of s.paras) {
        if (r.text && r.stage !== 'error') { const stage = r.stage as Stage; place(s, r); fill(s, r, r.text, stage); }
      }
      s.state = previous;
      if (s.failure) pageFailure(s, s.failure);
      trimPages();
      return;
    }
    const sec = await sectionsFor(s.n);
    if (!life.active || token !== s.token) return;
    const layout = await extractLayout(page, target, sec ? { refZone: sec.zones.get(s.n) ?? null, toc: sec.toc.has(s.n) || undefined } : {});
    if (!life.active || token !== s.token) return;
    if (!layout.hasText) return scanned(s, token, px);
    // 混合页：文字层只有页码 / 页眉，正文是扫描图（后端第 30.10 节）。文字层照常翻，正文再交给 OCR，
    // OCR 出来的段落和已有的文字层段落重叠的丢掉（不重复盖字）
    const imageBody = !!(caps.pdf && backendSrc) && imageBodyPage(layout.paras, layout.height, px);
    let parts = imageBody ? 2 : 1;
    const done = () => {
      if (life.active && token === s.token && --parts <= 0) finish(s);
    };

    const paras = layout.paras.filter((p) => p.kind !== 'skip');
    s.total = paras.length;
    s.ok = s.failed = 0;
    updateMeta();
    s.paras = paras.map((p) => ({ p, colors: sampleBox(px, p.x0, p.y0, p.x1, p.y1), stage: 'pending' as const }));
    for (const r of s.paras) place(s, r);
    if (imageBody) void scanned(s, token, px, layout.paras, done);
    if (!s.paras.length) return done();

    const jobId = uid('pdf');
    s.jobId = jobId;
    const job: TranslateJob = {
      jobId,
      sourceLang: source,
      targetLang: target,
      mode,
      priority: 0,
      noCache: noCache || undefined,
      context: { url: src.url ?? name, title: name, summary: s.paras.slice(0, 3).map((r) => r.p.text.replace(/<x\d+\/>/g, '')).join(' ').slice(0, 300) },
      segments: s.paras.map((r, i) => ({ id: String(i), text: r.p.text, kind: 'pdf' as const })),
    };
    let left = s.paras.length;
    client.send(job, {
      onResult: (id, text, stage) => {
        if (!life.active || token !== s.token) return;
        const r = s.paras[Number(id)];
        const first = r && r.stage !== 'final';
        fill(s, r, text, stage);
        if (first && (stage === 'final' || mode === 'fast' || mode === 'accurate')) {
          s.ok = (s.ok ?? 0) + 1;
          if (--left === 0) done();
          else updateMeta();
        }
      },
      onError: (id, stage) => {
        if (!life.active || token !== s.token || (stage === 'fast' && mode === 'combined')) return;
        const r = s.paras[Number(id)];
        if (r?.stage === 'fast') {
          // 精确译文失败：保留已有的快速译文，算作已翻译
          r.stage = 'final';
          s.ok = (s.ok ?? 0) + 1;
        } else {
          restore(s, r);
          s.failed = (s.failed ?? 0) + 1;
        }
        if (--left === 0) done();
        else updateMeta();
      },
    });
  }

  function finish(s: Shell) {
    if (!life.active) return;
    s.state = 'done';
    if (s.failed) pageFailure(s, L('部分段落翻译失败', 'Some paragraphs failed to translate'));
    updateMeta();
    trimPages();
  }

  /**
   * 扫描页：没有文本层，交给后端本地 OCR。
   * 混合页（native 给出文字层里已有的段落）：和它们重叠的 OCR 段落不要，避免页码、页眉重复。
   */
  async function scanned(s: Shell, token: number, px: Pixels, native: Para[] = [], onDone: () => void = () => finish(s)) {
    if (!life.active || token !== s.token) return;
    if (!caps.pdf || !backend) {
      pageFailure(s, !caps.pdf ? L('这一页是扫描图片，后端暂不支持识别', 'This page is a scanned image; the backend cannot recognize it yet') : L('文件超过 25 MB，扫描页无法识别', 'File is over 25 MB; scanned pages cannot be recognized'));
      return onDone();
    }
    try {
      const r = await backend.translate({ pages: [s.n], sourceLang: source, targetLang: target, mode }, s.controller?.signal);
      if (!life.active || token !== s.token) return;
      for (const w of r.warnings) toast(w);
      const page = r.pages.find((p) => p.page === s.n);
      if (!page) throw new Error(L('后端没有返回这一页', 'The backend did not return this page'));
      const k = page ? s.width / page.width : 1;
      for (const para of page?.paragraphs ?? []) {
        const [x0, y0, x1, y1] = para.box.map((v) => v * k);
        const area = Math.max(1, (x1 - x0) * (y1 - y0));
        const dup = native.some((q) => {
          const w = Math.min(x1, q.x1) - Math.max(x0, q.x0);
          const hh = Math.min(y1, q.y1) - Math.max(y0, q.y0);
          return w > 0 && hh > 0 && (w * hh) / Math.min(area, Math.max(1, (q.x1 - q.x0) * (q.y1 - q.y0))) > 0.4;
        });
        if (dup) continue;
        s.total = (s.total ?? 0) + 1;
        if (!para.translation || para.error) { s.failed = (s.failed ?? 0) + 1; continue; }
        s.ok = (s.ok ?? 0) + 1;
        const n = Math.max(1, Math.round((y1 - y0) / 14));
        const fs = (y1 - y0) / n / 1.25;
        const p: Para = {
          id: para.id, x0, y0, x1, y1, text: para.source, atoms: [], fs, pitch: fs * 1.25, kind: 'body', bold: false, serif: false,
          align: n > 1 ? 'justify' : 'left',
          lines: Array.from({ length: n }, (_, i) => ({ items: [], x0, x1, y0: y0 + i * fs * 1.25, y1: y0 + (i + 1) * fs * 1.25, fs, base: y0 + i * fs * 1.25 + fs }) as Para['lines'][number]),
        };
        const rp: RPara = { p, colors: sampleBox(px, x0, y0, x1, y1), stage: 'pending' };
        s.paras.push(rp);
        place(s, rp);
        fill(s, rp, para.translation, 'final');
      }
    } catch (e) {
      if (!life.active || token !== s.token) return;
      pageFailure(s, L('扫描页识别失败：', 'Scanned page recognition failed: ') + String((e as Error).message ?? e));
    }
    if (life.active && token === s.token) onDone();
  }

  /** 抹掉原文所在的行，放一个等待中的译文框。 */
  function place(s: Shell, r: RPara) {
    const { p, colors } = r;
    const k = s.scale * s.dpr;
    const ctx = s.sheet!.getContext('2d')!;
    ctx.fillStyle = rgb(colors.bg);
    // 目录条目只抹标题，编号、点线和页码留着
    for (const l of p.toc ? [{ ...p.lines[0], x0: p.x0, x1: p.x1 }] : p.lines) {
      const padX = l.fs * 0.12;
      const padY = l.fs * 0.14;
      ctx.fillRect((l.x0 - padX) * k, (l.y0 - padY) * k, (l.x1 - l.x0 + padX * 2) * k, (l.y1 - l.y0 + padY * 2) * k);
    }
    const el = h('div', { class: 'tp', 'data-stage': 'pending' });
    styleBox(s, r, el, 1);
    startScramble(el, estimateLength(p.text.replace(/<x\d+\/>/g, '').length, target, 400), target);
    s.textLayer.append(el);
    r.el = el;
    const mark = h('div');
    Object.assign(mark.style, { left: `${p.x0 * s.scale}px`, top: `${p.y0 * s.scale}px`, width: `${(p.x1 - p.x0) * s.scale}px`, height: `${(p.y1 - p.y0) * s.scale}px` });
    s.hl.append(mark);
    r.mark = mark;
    // 译文一侧直接悬停；原文一侧被文本层盖住，由 orig 上的 mousemove 按坐标找段落
    el.addEventListener('mouseenter', () => { setHover(r); showGrip(s, r); });
    el.addEventListener('mouseleave', () => { setHover(null); hideGripSoon(); });
    applyMove(s, r);
  }

  /* ---------------- 拖动译文框（最后的保险） ---------------- */
  const grip = h('div', { class: 'grip', title: L('拖动可以挪开这段译文；双击恢复原位', 'Drag to move this translation out of the way; double-click to put it back'), 'aria-hidden': 'true' }, '⠿');
  let gripFor: { s: Shell; r: RPara } | null = null;
  let gripTimer = 0;
  const moveKey = (s: Shell, r: RPara) => `${s.n}:${r.p.id}`;
  function applyMove(s: Shell, r: RPara) {
    const m = moves[moveKey(s, r)];
    if (!r.el) return;
    r.el.style.translate = m ? `${m[0] * s.scale}px ${m[1] * s.scale}px` : '';
    r.el.classList.toggle('moved', !!m);
  }
  function placeGrip() {
    if (!gripFor?.r.el) return;
    const { s, r } = gripFor;
    const m = moves[moveKey(s, r)] ?? [0, 0];
    grip.style.left = `${r.el!.offsetLeft + m[0] * s.scale - 22}px`;
    grip.style.top = `${r.el!.offsetTop + m[1] * s.scale}px`;
  }
  function showGrip(s: Shell, r: RPara) {
    clearTimeout(gripTimer);
    gripFor = { s, r };
    if (grip.parentElement !== s.textLayer) s.textLayer.append(grip);
    placeGrip();
    grip.classList.add('on');
  }
  function hideGripSoon() {
    clearTimeout(gripTimer);
    gripTimer = window.setTimeout(() => grip.classList.remove('on'), 400);
  }
  grip.addEventListener('mouseenter', () => clearTimeout(gripTimer));
  grip.addEventListener('mouseleave', hideGripSoon);
  grip.addEventListener('pointerdown', (e) => {
    if (!gripFor) return;
    e.preventDefault();
    const { s, r } = gripFor;
    const start = moves[moveKey(s, r)] ?? [0, 0];
    const x0 = e.clientX;
    const y0 = e.clientY;
    grip.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      moves[moveKey(s, r)] = [start[0] + (ev.clientX - x0) / s.scale, start[1] + (ev.clientY - y0) / s.scale];
      applyMove(s, r);
      placeGrip();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      void saveMoves(docKey, moves);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => {
    if (!gripFor) return;
    delete moves[moveKey(gripFor.s, gripFor.r)];
    applyMove(gripFor.s, gripFor.r);
    placeGrip();
    void saveMoves(docKey, moves);
  });

  /** 按原文排版设置译文框：字号 × f（f 用于缩小）、行距、颜色、字体、对齐、第一行基线对齐原文。 */
  function styleBox(s: Shell, r: RPara, el: HTMLElement, f: number, lhScale = 1) {
    const { p, colors } = r;
    const k = s.scale;
    const fs = p.fs * k * 0.96 * f;
    const lh = Math.max(fs * 1.12, p.pitch * k * lhScale);
    const firstBase = (p.lines[0]?.base ?? p.y1) * k;
    // 单行的：目录条目、表格格子
    const one = p.toc ?? p.cell;
    Object.assign(el.style, {
      left: `${p.x0 * k}px`,
      top: `${firstBase - (lh - fs) / 2 - fs * 0.88}px`,
      width: one ? 'max-content' : `${(p.x1 - p.x0) * k}px`,
      maxWidth: one ? `${Math.max(p.x1 - p.x0, one.limit - p.x0) * k}px` : '',
      // 至少盖住原标题（译文更短时原标题的尾巴不露出来）
      minWidth: one ? `${(p.x1 - p.x0) * k}px` : '',
      whiteSpace: one ? 'nowrap' : '',
      overflow: one ? 'hidden' : '',
      textOverflow: one ? 'ellipsis' : '',
      // 目录：译文比原标题长时盖住后面的一段点线
      background: p.toc ? rgb(colors.bg) : '',
      paddingRight: p.toc ? `${fs * 0.3}px` : '',
      textIndent: p.indent ? `${p.indent * k}px` : '',
      // 悬挂缩进：整段往右缩，首行再往左伸出去（项目符号留在原位置）
      paddingLeft: p.indent && p.indent < 0 ? `${-p.indent * k}px` : '',
      boxSizing: 'border-box',
      fontSize: `${fs}px`,
      lineHeight: `${lh}px`,
      fontFamily: p.serif ? SERIF : SANS,
      fontWeight: p.bold || p.kind === 'heading' ? '700' : '400',
      color: rgb(colors.fg),
      textAlign: p.align,
      textAlignLast: p.align === 'justify' ? 'left' : p.align,
    });
  }

  /** 写入译文：<xN/> 换成从原页裁下来的公式片段；然后缩小字号直到放进原段落的高度。 */
  function fill(s: Shell, r: RPara | undefined, text: string, stage: Stage) {
    if (!r?.el || (r.stage === 'final' && stage === 'fast')) return;
    const el = r.el;
    text = tidyCjk(text, target);
    r.text = text;
    stopScramble(el);
    el.replaceChildren();
    const re = /<x(\d+)\/>|<\/?g\d+>/g;
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > last) el.append(text.slice(last, m.index));
      last = m.index + m[0].length;
      const atom = m[1] !== undefined ? r.p.atoms[Number(m[1])] : undefined;
      if (atom && s.canvas) el.append(cropAtom(s, atom, r.p.fs));
      else if (atom) el.append(atom.text);
    }
    if (last < text.length) el.append(text.slice(last));
    el.dataset.stage = stage;
    r.stage = stage;
    fitBox(s, r);
    revealText(el, target, 260);
  }

  function cropAtom(s: Shell, a: { x0: number; y0: number; x1: number; y1: number }, fs: number) {
    const k = s.scale * s.dpr;
    const pad = 1;
    const sx = Math.max(0, Math.floor(a.x0 * k) - pad);
    const sy = Math.max(0, Math.floor(a.y0 * k) - pad);
    const sw = Math.min(s.canvas!.width - sx, Math.ceil((a.x1 - a.x0) * k) + pad * 2);
    const sh = Math.min(s.canvas!.height - sy, Math.ceil((a.y1 - a.y0) * k) + pad * 2);
    const c = document.createElement('canvas');
    c.width = Math.max(1, sw);
    c.height = Math.max(1, sh);
    c.getContext('2d')!.drawImage(s.canvas!, sx, sy, sw, sh, 0, 0, sw, sh);
    // 用 em 表示高度：译文缩字号时公式片段跟着等比缩小，不会把行撑高、也不会挤到上下行
    c.style.height = `${(sh / (s.scale * s.dpr)) / fs}em`;
    c.style.width = 'auto';
    c.style.verticalAlign = `${-((a.y1 - a.y0) * 0.22) / fs}em`;
    return c;
  }

  /** 允许的高度 = 原段落从第一行到最后一行占的高度；先缩字号（最多到 0.74 倍），再压行距。 */
  function fitBox(s: Shell, r: RPara) {
    const { p } = r;
    const k = s.scale;
    if (p.toc || p.cell) {
      // 单行：放不下就缩字号（最多到 0.7 倍），再放不下用省略号
      let f = 1;
      styleBox(s, r, r.el!, f);
      while (r.el!.scrollWidth > r.el!.clientWidth + 1 && f > 0.7) {
        f -= 0.05;
        styleBox(s, r, r.el!, f);
      }
      return;
    }
    const lines = p.lines.length;
    const allowed = (lines > 1 ? (p.lines[lines - 1].base - p.lines[0].base + p.pitch) : p.pitch) * k * 1.04;
    let f = 1;
    styleBox(s, r, r.el!, f);
    while (r.el!.scrollHeight > allowed && f > 0.74) {
      f -= 0.04;
      styleBox(s, r, r.el!, f);
    }
    if (r.el!.scrollHeight > allowed) styleBox(s, r, r.el!, f, 0.9);
  }

  /** 翻译失败：把这一段在右栏恢复成原文。 */
  function restore(s: Shell, r: RPara | undefined) {
    if (!r || r.stage === 'fast') return;
    r.stage = 'error';
    if (r.el) {
      stopScramble(r.el);
      r.el.remove();
    }
    r.mark?.remove();
    const k = s.scale * s.dpr;
    const ctx = s.sheet?.getContext('2d');
    if (!ctx || !s.canvas) return;
    for (const l of r.p.lines) {
      const pad = l.fs * 0.2;
      const [x, y, w, hh] = [(l.x0 - pad) * k, (l.y0 - pad) * k, (l.x1 - l.x0 + pad * 2) * k, (l.y1 - l.y0 + pad * 2) * k];
      ctx.drawImage(s.canvas, x, y, w, hh, x, y, w, hh);
    }
  }

  /* ---------------- 懒加载与有界画布 ---------------- */
  const visible = new Set<number>();
  const pending = new Set<Shell>();
  let active = 0;
  async function runPage(sh: Shell) {
    const before = sh.token;
    try { await processPage(sh); }
    catch (err) {
      // processPage 开始时仅递增一次；重试/换文件会再次递增，不接收旧 catch。
      if (!life.active || sh.token !== before + 1) return;
      sh.state = 'error';
      pageFailure(sh, L('处理这一页时出错：', 'Error while processing this page: ') + String((err as Error).message ?? err));
    }
  }
  function pump() {
    if (!life.active) return;
    const ordered = [...pending].sort((a, b) => Math.abs(a.n - current) - Math.abs(b.n - current) || a.n - b.n);
    for (const sh of ordered) {
      if (active >= 3) break;
      pending.delete(sh);
      active++;
      void runPage(sh).finally(() => { active--; if (life.active) { trimPages(); pump(); } });
    }
  }
  function queuePage(sh: Shell, explicit = false) {
    if (!life.active || (!explicit && !visible.has(sh.n))) return;
    if (sh.state === 'idle' || sh.evicted) { pending.add(sh); pump(); }
  }
  const io = new IntersectionObserver((entries) => {
    if (!life.active) return;
    for (const e of entries) {
      const sh = shells[Number((e.target as HTMLElement).dataset.page) - 1];
      if (!sh) continue;
      if (e.isIntersecting) visible.add(sh.n);
      else { visible.delete(sh.n); pending.delete(sh); }
    }
    for (const n of visible) queuePage(shells[n - 1]);
    trimPages();
  }, { rootMargin: '80% 0px' });
  life.add(() => {
    io.disconnect(); thumbIo.disconnect(); pending.clear();
    clearTimeout(resizeTimer); clearTimeout(saveTimer); clearTimeout(gripTimer);
    cancelAnimationFrame(scrollRaf);
    for (const sh of shells) {
      sh.token++; sh.controller?.abort(); sh.textTask?.cancel();
      sh.paras.forEach((r) => r.el && stopScramble(r.el));
      freeCanvases(sh.orig); freeCanvases(sh.trans);
      sh.canvas = sh.sheet = undefined; sh.paras = [];
    }
    freeCanvases(thumbsBox);
    if ((window as unknown as Record<string, unknown>).__txPdf) delete (window as unknown as Record<string, unknown>).__txPdf;
  });
  shells.forEach((sh) => io.observe(sh.el));
  if (resume?.page && resume.page > 1 && resume.page <= doc.numPages) {
    goTo(resume.page);
    toast(L(`已回到上次读到的第 ${resume.page} 页`, `Back to page ${resume.page}, where you left off`), 2500);
  }
}

/** 每个文件读到第几页、缩放多少（chrome.storage.local，最多 40 个文件）。 */
interface Resume { page: number; zoom: number; at?: number }
const RESUME_KEY = 'ui.pdfResume';
async function loadResume(key: string): Promise<Resume | null> {
  try {
    const got: Record<string, unknown> = await chrome.storage.local.get(RESUME_KEY);
    const all = got[RESUME_KEY];
    const r = all && typeof all === 'object' ? (all as Record<string, unknown>)[key] : null;
    if (!r || typeof r !== 'object') return null;
    const { page, zoom } = r as Partial<Resume>;
    return { page: typeof page === 'number' ? page : 1, zoom: typeof zoom === 'number' ? zoom : 1 };
  } catch {
    return null;
  }
}
async function saveResume(key: string, r: Resume): Promise<void> {
  try {
    const got: Record<string, unknown> = await chrome.storage.local.get(RESUME_KEY);
    const all = (got[RESUME_KEY] && typeof got[RESUME_KEY] === 'object' ? got[RESUME_KEY] : {}) as Record<string, Resume>;
    all[key] = { page: r.page, zoom: r.zoom, at: Date.now() };
    const keys = Object.keys(all).sort((a, b) => (all[b].at ?? 0) - (all[a].at ?? 0));
    for (const k of keys.slice(40)) delete all[k];
    await chrome.storage.local.set({ [RESUME_KEY]: all });
  } catch { /* 存不了就算了 */ }
}

/** 拖开过的译文框（PDF 点为单位，缩放后照样对得上）。每个文件一份，最多记 40 个文件。 */
const MOVES_KEY = 'ui.pdfMoves';
async function loadMoves(key: string): Promise<Record<string, [number, number]>> {
  try {
    const got: Record<string, unknown> = await chrome.storage.local.get(MOVES_KEY);
    const all = got[MOVES_KEY] as Record<string, { m?: Record<string, [number, number]> }> | undefined;
    const m = all && typeof all === 'object' ? all[key]?.m : undefined;
    if (!m || typeof m !== 'object') return {};
    const out: Record<string, [number, number]> = {};
    for (const [k, v] of Object.entries(m)) if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) out[k] = [v[0], v[1]];
    return out;
  } catch {
    return {};
  }
}
async function saveMoves(key: string, moves: Record<string, [number, number]>): Promise<void> {
  try {
    const got: Record<string, unknown> = await chrome.storage.local.get(MOVES_KEY);
    const all = (got[MOVES_KEY] && typeof got[MOVES_KEY] === 'object' ? got[MOVES_KEY] : {}) as Record<string, { m: Record<string, [number, number]>; at: number }>;
    if (Object.keys(moves).length) all[key] = { m: moves, at: Date.now() };
    else delete all[key];
    const keys = Object.keys(all).sort((a, b) => (all[b].at ?? 0) - (all[a].at ?? 0));
    for (const k of keys.slice(40)) delete all[k];
    await chrome.storage.local.set({ [MOVES_KEY]: all });
  } catch { /* 存不了就算了 */ }
}

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOMS.find((v) => v > z + 0.001) ?? 3;
  return [...ZOOMS].reverse().find((v) => v < z - 0.001) ?? 0.5;
}

/** 书签目录拍平成一列：标题、页码、层级。 */
async function loadOutline(doc: PDFDocumentProxy): Promise<{ title: string; page: number; depth: number }[]> {
  const outline = await doc.getOutline();
  const out: { title: string; page: number; depth: number }[] = [];
  const walk = async (nodes: NonNullable<typeof outline>, depth: number) => {
    for (const o of nodes) {
      try {
        const dest = typeof o.dest === 'string' ? await doc.getDestination(o.dest) : o.dest;
        if (Array.isArray(dest) && dest[0] !== undefined && dest[0] !== null) {
          const ref = dest[0] as Parameters<PDFDocumentProxy['getPageIndex']>[0] | number;
          const idx = typeof ref === 'number' ? ref : await doc.getPageIndex(ref);
          out.push({ title: o.title, page: idx + 1, depth });
        }
      } catch { /* 坏书签跳过 */ }
      if (o.items?.length && depth < 4) await walk(o.items, depth + 1);
    }
  };
  if (outline?.length) await walk(outline, 0);
  return out;
}

let selectionUi: SelectionUi | undefined;
let selectionClient: TranslateClient | undefined;

async function renderCanvas(page: PDFPageProxy, scale: number, signal?: AbortSignal): Promise<HTMLCanvasElement> {
  signal?.throwIfAborted();
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.className = 'page';
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvas, viewport });
  const cancel = () => task.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try { await task.promise; signal?.throwIfAborted(); return canvas; }
  catch (e) { canvas.width = canvas.height = 0; throw e; }
  finally { signal?.removeEventListener('abort', cancel); }
}

/** 中日韩译文：去掉汉字和标点之间多余的空格（换行到行首时会像缩进），全角空格、不换行空格换成普通空格。 */
function tidyCjk(text: string, lang: string): string {
  if (!/^(zh|ja|ko)/i.test(lang)) return text;
  return text
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。！？；：、）」』”])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}（「『“，。！？；：、])/gu, '$1');
}

/**
 * 「正文是扫描图」的混合页：文字层里的段落都挤在页面最上 / 最下 12%（页眉、页码），
 * 而中间大片区域（去掉这些段落）有不少「墨水」，并且看起来像一行行的字。
 * 标题页、矢量图表页的文字在中间，不算；整页的工程图、照片（线条长）也不算。
 */
export function imageBodyPage(paras: Para[], hgt: number, px: Pixels): boolean {
  if (!paras.length) return false;
  if (!paras.every((p) => p.y1 < hgt * 0.12 || p.y0 > hgt * 0.88)) return false;
  const k = px.scale;
  const boxes = paras.map((p) => [p.x0 * k - 4, p.y0 * k - 4, p.x1 * k + 4, p.y1 * k + 4]);
  const d = px.data;
  // 按纸张底色判断「墨水」（扫描件的纸常常发灰发黄），和渲染比例无关
  const hist = new Uint32Array(256);
  let total = 0;
  const step = 3;
  for (let y = Math.floor(px.height * 0.12); y < px.height * 0.88; y += step) {
    for (let x = Math.floor(px.width * 0.06); x < px.width * 0.94; x += step) {
      if (boxes.some((b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3])) continue;
      const i = (y * px.width + x) * 4;
      hist[Math.round(0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2])]++;
      total++;
    }
  }
  if (!total) return false;
  let acc = 0;
  let paper = 255;
  for (let l = 255; l >= 0; l--) {
    acc += hist[l];
    if (acc >= total / 2) {
      paper = l;
      break;
    }
  }
  let ink = 0;
  const thr = Math.max(0, paper - 50);
  for (let l = 0; l < thr; l++) ink += hist[l];
  if (ink / total <= 0.015) return false;
  // 像文字吗：有墨水的那些行里，深浅交替的次数多（一个个字的笔画）；工程图、照片的线条长、交替少
  const trans: number[] = [];
  for (let y = Math.floor(px.height * 0.12); y < px.height * 0.88; y += 4) {
    let t = 0;
    let inkN = 0;
    let prev = false;
    for (let x = Math.floor(px.width * 0.06); x < px.width * 0.94; x++) {
      const i = (y * px.width + x) * 4;
      const dark = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2] < thr;
      if (dark) inkN++;
      if (dark !== prev) t++;
      prev = dark;
    }
    if (inkN) trans.push(t);
  }
  trans.sort((a, b) => a - b);
  return trans.length > 0 && trans[trans.length >> 1] >= 28;
}
