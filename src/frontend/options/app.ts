/** 设置页：常用 / 服务 / 服务状态 / 关于。纯 DOM，不依赖框架。 */
import { PROTOCOL_VERSION } from '../../shared/protocol';
import { rpc } from '../../shared/rpc';
import { loadUiSettings, saveUiSettings, type TxStyle, type UiSettings } from '../../shared/settings';
import { TX_PREVIEW_CSS } from '../content/style';
import { h, UI_FONT } from '../ui/host';
import { LANGS, SOURCE_LANGS } from '../langs';
import { logoElement } from '../ui/logo';
import { mountAdvanced } from './advanced';
import { mountProviders } from './providers';
import { mountWelcome } from './welcome';
import { mountStatus } from './status';
import { ACCENTS, accentCss, PAGE_THEME_CSS, resolveAccent } from '../theme';
import { L, setUiLang } from '../i18n';

const CSS = `
${PAGE_THEME_CSS}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.55 ${UI_FONT}; -webkit-font-smoothing: antialiased; }
/* 侧栏 + 内容作为一个整体在宽屏上居中；窄屏时侧栏变成顶部横排 */
.shell { display: grid; grid-template-columns: 210px minmax(0, 1fr); min-height: 100vh; max-width: 1260px; margin: 0 auto; }
.side { padding: 28px 14px; position: sticky; top: 0; height: 100vh; }
.brand { display: flex; align-items: center; gap: 10px; padding: 0 10px 22px; font-weight: 650; font-size: 15px; }
.brand .mark { width: 30px; height: 30px; border-radius: 9px; background: var(--accent); color: #fff; --logo-accent: rgba(255,255,255,.7); display: grid; place-items: center; }
.nav a { display: block; padding: 7px 10px; border-radius: 8px; color: var(--ink-2); text-decoration: none; margin-bottom: 2px; }
.nav a:hover { background: var(--hover); }
.nav a[aria-current="page"] { background: var(--hover); color: var(--ink); font-weight: 600; }
main { padding: 32px 40px 80px; min-height: 100vh; border-left: 1px solid var(--line); min-width: 0; }
main > * { max-width: 980px; margin-left: auto; margin-right: auto; }
@media (min-width: 1300px) { main { border-right: 1px solid var(--line); } }
@media (max-width: 760px) {
  .shell { grid-template-columns: 1fr; }
  .side { position: sticky; height: auto; padding: 10px 12px; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 8px; overflow-x: auto; }
  .brand { padding: 0 8px 0 2px; white-space: nowrap; }
  .nav { display: flex; gap: 2px; }
  .nav a { white-space: nowrap; margin: 0; }
  main { padding: 20px 16px 60px; border-left: 0; }
  .row { grid-template-columns: 1fr; gap: 8px; }
}
h1 { font-size: 22px; margin: 0 0 4px; font-weight: 650; letter-spacing: -.01em; }
h2 { font-size: 15px; margin: 32px 0 10px; font-weight: 650; }
.lead { color: var(--muted); margin: 0 0 20px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 4px 18px; }
.row { display: grid; grid-template-columns: 220px 1fr; gap: 16px; align-items: center; padding: 12px 0; border-top: 1px solid var(--line); }
.row:first-child { border-top: 0; }
.row .hint { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
.row label.name { font-weight: 550; }
select, input[type=text], input[type=url], input[type=password], input[type=number], textarea {
  font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; min-width: 220px;
}
textarea { width: 100%; min-height: 70px; font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
input:focus, select:focus, textarea:focus { outline: 2px solid color-mix(in srgb, var(--accent) 50%, transparent); outline-offset: 0; border-color: var(--accent); }
.seg { display: inline-flex; background: var(--hover); border-radius: 9px; padding: 3px; gap: 2px; }
.seg button { font: inherit; border: 0; background: none; color: var(--ink-2); padding: 5px 12px; border-radius: 7px; cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.12); font-weight: 550; }
.switch { appearance: none; width: 36px; height: 20px; border-radius: 99px; background: var(--line); position: relative; cursor: pointer; transition: background .15s; margin: 0; }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.switch:checked { background: var(--accent); }
.switch:checked::after { transform: translateX(16px); }
.range { display: flex; align-items: center; gap: 10px; }
.range input { width: 200px; accent-color: var(--accent); }
.range output { font-variant-numeric: tabular-nums; color: var(--muted); min-width: 3em; }
.swatches { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.swatches .sw { width: 26px; height: 26px; border-radius: 50%; background: var(--c); border: 2px solid var(--surface); box-shadow: 0 0 0 1px var(--line); cursor: pointer; padding: 0; position: relative; }
.swatches .sw[aria-checked="true"] { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--c, var(--accent)); }
.swatches .sw.custom { display: inline-grid; place-items: center; background: conic-gradient(#e66, #ec6, #6c6, #6cc, #66e, #c6c, #e66); overflow: hidden; }
.swatches .sw.custom input { opacity: 0; position: absolute; inset: 0; width: 100%; height: 100%; cursor: pointer; }
.pv-ballbox { position: relative; height: 92px; border: 1px dashed var(--line); border-radius: 10px; overflow: hidden; background: var(--bg); }
.pv-ballbox .pv-text { position: absolute; left: 14px; top: 12px; right: 80px; color: var(--muted); font-size: 13px; }
.pv-ball { position: absolute; right: 18px; top: 50%; width: 40px; height: 40px; margin-top: -20px; border-radius: 50%; display: grid; place-items: center; background: var(--surface); color: var(--ink); --logo-accent: var(--accent); box-shadow: var(--shadow); border: 1px solid var(--line); transition: transform .2s, opacity .2s, background .2s; }
.pv-ball[data-ball="accent"] { background: var(--accent); color: var(--accent-ink); --logo-accent: color-mix(in srgb, var(--accent-ink) 62%, transparent); border-color: transparent; }
.pv-ball[data-ball="glass"] { background: color-mix(in srgb, var(--surface) 62%, transparent); border-color: color-mix(in srgb, var(--ink) 14%, transparent); backdrop-filter: blur(10px) saturate(1.4); }
.pv-ball[data-size="s"] { transform: scale(.85); }
.pv-ball[data-size="l"] { transform: scale(1.2); }
.stylegrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }
.stylecard { all: unset; box-sizing: border-box; display: grid; gap: 8px; padding: 12px 14px; border-radius: var(--r-l); border: 1px solid var(--line); background: var(--surface); cursor: pointer; color: var(--ink); transition: border-color .15s, box-shadow .15s; }
.stylecard:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
.stylecard:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.stylecard[aria-checked="true"] { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.stylecard .nm { font-weight: 600; font-size: 13px; display: flex; flex-direction: column; }
.stylecard .nm small { font-weight: 400; color: var(--muted); font-size: 11.5px; }
.stylecard .sample { font: 14px/1.55 Georgia, serif; color: var(--ink); }
.stylecard .sample tx-t { font-family: ${UI_FONT}; }
.preview { margin-top: 10px; padding: 12px 14px; border-radius: 10px; border: 1px dashed var(--line); font-family: Georgia, serif; font-size: 15px; }
.preview .t { display: block; margin-top: 4px; font-family: ${UI_FONT}; transition: opacity .3s; }
.btn { font: inherit; border: 1px solid var(--line); background: var(--surface); color: var(--ink); padding: 6px 14px; border-radius: 8px; cursor: pointer; }
.btn:hover { background: var(--hover); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.small { padding: 3px 10px; font-size: 12.5px; }
.saved { color: var(--muted); font-size: 12px; margin-left: 8px; opacity: 0; transition: opacity .2s; }
.saved.on { opacity: 1; }
`;


type Tab = 'welcome' | 'general' | 'providers' | 'status' | 'advanced' | 'about';
const TABS = (): [Tab, string][] => [['welcome', L('新手指引', 'Get started')], ['general', L('常用', 'Settings')], ['providers', L('翻译服务', 'Services')], ['status', L('服务状态', 'Status')], ['advanced', L('高级', 'Advanced')], ['about', L('关于', 'About')]];

/** 设置页自己也用用户选的主题色。 */
export function applyPageAccent(accent: string | undefined): void {
  let st = document.getElementById('tx-accent');
  if (!st) {
    st = h('style', { id: 'tx-accent' });
    document.head.append(st);
  }
  st.textContent = `@media not (forced-colors: active) { ${accentCss(accent, ':root', ':root[data-theme="dark"]')} }`;
}

export async function mountOptions(root: HTMLElement): Promise<void> {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const first = await loadUiSettings();
  applyPageAccent(first.appearance.accent);
  setUiLang(first.uiLang);
  document.documentElement.lang = L('zh-CN', 'en');
  document.title = L('译 · 设置', 'Yi · Settings');

  const nav = h('nav', { class: 'nav' });
  const main = h('main');
  root.append(
    h('div', { class: 'shell' },
      h('aside', { class: 'side' }, h('div', { class: 'brand' }, h('span', { class: 'mark' }, logoElement({ size: 20 })), L('本地优先翻译', 'Local-first Translate')), nav),
      main,
    ),
  );
  let cleanup: (() => void) | null = null;

  const show = async (tab: Tab) => {
    cleanup?.();
    cleanup = null;
    nav.textContent = '';
    for (const [id, label] of TABS()) {
      nav.append(h('a', { href: '#' + id, 'aria-current': id === tab ? 'page' : undefined }, label));
    }
    main.textContent = '';
    if (tab === 'general') await renderGeneral(main);
    else if (tab === 'providers') cleanup = await mountProviders(main);
    else if (tab === 'status') cleanup = mountStatus(main);
    else if (tab === 'welcome') await mountWelcome(main);
    else if (tab === 'advanced') await mountAdvanced(main);
    else await renderAbout(main);
  };
  // 还没走过首次引导、又没指定页面时，先到「新手指引」
  const firstRun = !first.onboarded;
  const fromHash = (): Tab => {
    const t = location.hash.slice(1).split('/')[0] as Tab;
    return TABS().some(([id]) => id === t) ? t : firstRun && !location.hash ? 'welcome' : 'general';
  };
  window.addEventListener('hashchange', () => void show(fromHash()));
  await show(fromHash());
}

/* ------------------------------------------------------------------ */

function row(name: string, hint: string | null, control: Node): HTMLElement {
  return h('div', { class: 'row' }, h('div', null, h('label', { class: 'name' }, name), hint ? h('div', { class: 'hint' }, hint) : null), h('div', null, control));
}

function seg<T extends string>(items: [T, string][], value: T, onChange: (v: T) => void): HTMLElement {
  const el = h('div', { class: 'seg', role: 'group' });
  for (const [v, label] of items) {
    const b = h('button', { type: 'button', 'aria-pressed': String(v === value) }, label);
    b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      onChange(v);
    });
    el.append(b);
  }
  return el;
}

function toggle(value: boolean, onChange: (v: boolean) => void, disabled = false): HTMLInputElement {
  const i = h('input', { type: 'checkbox', class: 'switch', role: 'switch', disabled }) as HTMLInputElement;
  i.checked = value;
  i.addEventListener('change', () => onChange(i.checked));
  return i;
}

function range(min: number, max: number, step: number, value: number, fmt: (v: number) => string, onChange: (v: number) => void): HTMLElement {
  const i = h('input', { type: 'range', min: String(min), max: String(max), step: String(step) }) as HTMLInputElement;
  i.value = String(value);
  const out = h('output', null, fmt(value));
  i.addEventListener('input', () => {
    out.textContent = fmt(Number(i.value));
    onChange(Number(i.value));
  });
  return h('div', { class: 'range' }, i, out);
}

function lines(list: string[], onChange: (v: string[]) => void, placeholder: string): HTMLTextAreaElement {
  const t = h('textarea', { placeholder, spellcheck: 'false' }) as HTMLTextAreaElement;
  t.value = list.join('\n');
  t.addEventListener('change', () => onChange(t.value.split(/\s*\n\s*/).map((s) => s.trim()).filter(Boolean)));
  return t;
}

async function renderGeneral(main: HTMLElement) {
  let s: UiSettings = await loadUiSettings();
  const saved = h('span', { class: 'saved' }, L('已保存', 'Saved'));
  let savedTimer = 0;
  const save = async (patch: Partial<UiSettings>) => {
    s = await saveUiSettings(patch);
    saved.classList.add('on');
    clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => saved.classList.remove('on'), 1200);
    updatePreview();
  };

  /* ---------- 个性化：主题色、悬浮球 ---------- */
  const ap = () => s.appearance;
  const saveAp = (patch: Partial<UiSettings['appearance']>) => void save({ appearance: { ...ap(), ...patch } }).then(() => { applyPageAccent(s.appearance.accent); paintAp(); });
  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': L('主题色', 'Accent color') });
  const custom = h('input', { type: 'color', title: L('自定义颜色', 'Custom color'), 'aria-label': L('自定义颜色', 'Custom color') }) as HTMLInputElement;
  for (const a of ACCENTS) {
    const b = h('button', { type: 'button', class: 'sw', role: 'radio', title: a.name, 'aria-label': a.name, 'data-v': a.id });
    b.style.setProperty('--c', a.light);
    b.addEventListener('click', () => saveAp({ accent: a.id }));
    swatches.append(b);
  }
  custom.addEventListener('input', () => saveAp({ accent: custom.value }));
  swatches.append(h('label', { class: 'sw custom', title: L('自定义颜色', 'Custom color') }, custom));
  // 悬浮球预览（和网页上的一样：浅色 / 主题色 / 半透明，三种大小，不用时的透明度）
  const pvBall = h('span', { class: 'pv-ball' }, logoElement({ size: 18 }));
  const pvBox = h('div', { class: 'pv-ballbox' }, h('span', { class: 'pv-text' }, L('The quick brown fox jumps over the lazy dog. 敏捷的棕色狐狸跳过了懒狗。', 'The quick brown fox jumps over the lazy dog. Le renard brun rapide saute par-dessus le chien paresseux.')), pvBall);
  const paintAp = () => {
    const a = ap();
    swatches.querySelectorAll<HTMLElement>('.sw[data-v]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.v === a.accent)));
    const isCustom = !ACCENTS.some((x) => x.id === a.accent);
    custom.value = resolveAccent(a.accent);
    custom.parentElement?.setAttribute('aria-checked', String(isCustom));
    pvBall.dataset.ball = a.ball;
    pvBall.dataset.size = a.ballSize;
    pvBall.style.opacity = String(a.idleOpacity);
  };
  paintAp();

  const select = (list: [string, string][], value: string, onChange: (v: string) => void) => {
    const el = h('select') as HTMLSelectElement;
    for (const [v, label] of list) el.append(h('option', { value: v, selected: v === value }, label));
    el.addEventListener('change', () => onChange(el.value));
    return el;
  };
  const lang = select(LANGS, s.targetLang, (targetLang) => void save({ targetLang }));
  const srcLang = select(SOURCE_LANGS, s.sourceLang, (sourceLang) => void save({ sourceLang }));
  const inp = () => s.input;
  const saveIn = (patch: Partial<UiSettings['input']>) => void save({ input: { ...inp(), ...patch } });

  // 综合模式预览：高速（浅）→ 精确（深）
  const pvFast = h('span', { class: 't' }, L('高速译文：先出现，颜色较浅。', 'Fast translation: appears first, lighter.'));
  const pvFinal = h('span', { class: 't' }, L('精确译文：随后覆盖，接近原文颜色。', 'Accurate translation: replaces it, close to the original color.'));
  const preview = h('div', { class: 'preview' }, 'The fast result appears first, then the accurate one replaces it.', pvFast, pvFinal);
  let updatePreview = () => {
    pvFast.style.opacity = String(Math.max(0.2, s.fastColorPercent / Math.max(1, s.finalColorPercent)));
    pvFast.style.color = `color-mix(in srgb, currentColor ${s.finalColorPercent}%, transparent)`;
    pvFinal.style.color = `color-mix(in srgb, currentColor ${s.finalColorPercent}%, transparent)`;
    pvFast.style.fontSize = pvFinal.style.fontSize = `${s.fontScale}em`;
  };
  updatePreview();

  // 译文样式预设：每张卡片就是一段真实样式的预览，点哪张用哪张
  if (!document.getElementById('tx-preview-css')) {
    const st = h('style', { id: 'tx-preview-css' });
    st.textContent = TX_PREVIEW_CSS;
    document.head.append(st);
  }
  const STYLES: [TxStyle, string, string][] = [
    ['plain', L('默认', 'Default'), L('颜色略浅，最不打扰', 'Slightly lighter, least distracting')],
    ['bar', L('左侧竖线', 'Left bar'), L('一眼分清原文和译文', 'Tell original and translation apart at a glance')],
    ['tint', L('淡底色块', 'Tinted block'), L('译文放在浅色底上', 'Translation on a light background')],
    ['underline', L('虚线下划线', 'Dotted underline'), L('行文连贯，标记清楚', 'Reads smoothly, clearly marked')],
    ['blur', L('学习模式', 'Study mode'), L('先模糊，鼠标移上去才显示', 'Blurred until you hover')],
  ];
  const styleGrid = h('div', { class: 'stylegrid', role: 'radiogroup', 'aria-label': L('译文样式', 'Translation style') });
  const styleCards = STYLES.map(([v, name, hint]) => {
    const tx = document.createElement('tx-t');
    tx.setAttribute('data-tx-mode', 'block');
    tx.setAttribute('data-tx-stage', 'final');
    tx.setAttribute('lang', 'zh-CN');
    tx.textContent = L('本地优先的翻译让阅读又快又私密。', 'Local-first translation keeps your reading fast and private.');
    const card = h('button', { class: 'stylecard', type: 'button', role: 'radio', 'data-tx-style': v, 'aria-checked': String(s.txStyle === v) },
      h('span', { class: 'nm' }, name, h('small', null, hint)),
      h('span', { class: 'sample' }, 'Local-first translation keeps reading fast and private.', tx));
    card.addEventListener('click', () => {
      void save({ txStyle: v });
      styleCards.forEach((c) => c.setAttribute('aria-checked', String(c === card)));
    });
    return card;
  });
  styleGrid.append(...styleCards);
  const syncStyleVars = () => {
    styleGrid.style.setProperty('--tx-final-pct', `${s.finalColorPercent}%`);
    styleGrid.style.setProperty('--tx-scale', String(s.fontScale));
  };
  syncStyleVars();
  const prevUpdate = updatePreview;
  updatePreview = () => (prevUpdate(), syncStyleVars());

  main.append(
    h('h1', null, L('常用设置', 'Settings'), saved),
    h('p', { class: 'lead' }, L('修改即时生效，已打开的页面会自动套用新的显示方式。', 'Changes apply immediately; open pages pick up the new display automatically.')),
    h('h2', null, L('翻译', 'Translation')),
    h('div', { class: 'card' },
      row(L('原文语言', 'Source language'), L('默认自动识别。很短的文字（比如一句瑞典语）偶尔会认错，可以在这里或划词小窗里直接指定。', 'Detected automatically by default. Very short text (say, one Swedish sentence) is sometimes misdetected — set it here or in the selection popup.'), srcLang),
      row(L('目标语言', 'Target language'), L('整页、划词、PDF、字幕都翻成这个语言。划词小窗顶上也能随手改。', 'Pages, selections, PDFs and subtitles are all translated into this language. You can also change it at the top of the selection popup.'), lang),
      row(L('整页翻译模式', 'Page translation mode'), L('综合：先用高速服务出浅色译文，再用精确服务覆盖成深色。', 'Combined: a fast service shows a light translation first, then an accurate service replaces it in a darker color.'), seg([['fast', L('快速', 'Fast')], ['accurate', L('精确', 'Accurate')], ['combined', L('综合', 'Combined')]], s.mode, (mode) => void save({ mode }))),
      row(L('划词翻译模式', 'Selection mode'), L('小窗里用的模式；单个英文单词会显示词典。', 'Mode used in the popup; a single English word shows the dictionary.'), seg([['fast', L('快速', 'Fast')], ['accurate', L('精确', 'Accurate')], ['combined', L('综合', 'Combined')]], s.selection.mode, (mode) => void save({ selection: { ...s.selection, mode } }))),
      row(L('只翻正文', 'Main content only'), L('自动认出文章主体，跳过导航、侧栏、页脚和评论区，页面更清爽，也省额度。认不准的网站可以在「高级」里给它写站点规则。', 'Finds the article body and skips navigation, sidebars, footers and comments — cleaner, and saves quota. For sites it gets wrong, write a site rule under “Advanced”.'), toggle(s.mainOnly, (mainOnly) => void save({ mainOnly }))),
      row(L('划词翻译', 'Selection translation'), L('选中文字后在旁边显示小圆点。', 'Show a small dot next to selected text.'), toggle(s.selection.enabled, (enabled) => void save({ selection: { ...s.selection, enabled } }))),
      row(L('输入框里也划词', 'Also in input boxes'), null, toggle(s.selection.inEditable, (inEditable) => void save({ selection: { ...s.selection, inEditable } }))),
      row(L('图片上的翻译按钮', 'Translate button on images'), L('鼠标移到较大的图片上时，右上角出现按钮，点一下翻译图里的文字（本地 OCR）。', 'Hovering a large image shows a button in its corner; click it to translate the text in the image (local OCR).'), toggle(s.imageButton, (imageButton) => void save({ imageButton }))),
      row(L('整页翻译时也翻译图片', 'Also translate images with the page'), L('进入视口的大图自动识别并翻译，每页最多 30 张。第一次使用要下载 PP-OCRv5 识别模型，之后离线可用。', 'Large images entering the viewport are recognized and translated, up to 30 per page. The PP-OCRv5 model is downloaded on first use, then works offline.'), toggle(s.imageTranslate, (imageTranslate) => void save({ imageTranslate }))),
      row(L('YouTube 双语字幕', 'YouTube bilingual subtitles'), L('打开视频字幕（CC）后，自动显示译文；播放器右下角也有开关。', 'Turn on captions (CC) and the translation appears automatically; there is also a switch in the player.'), toggle(s.subtitles.enabled, (enabled) => void save({ subtitles: { ...s.subtitles, enabled } }))),
      row(L('字幕显示', 'Subtitles'), null, seg([['bilingual', L('译文 + 原文', 'Translation + original')], ['translation', L('只显示译文', 'Translation only')]], s.subtitles.display, (display) => void save({ subtitles: { ...s.subtitles, display } }))),
      row(L('PDF 双栏阅读', 'PDF side-by-side reader'), L('左边原文、右边译文，段落位置对应。在浏览器打开 PDF 时右下角也会出现入口。', 'Original on the left, translation on the right, paragraphs lined up. A ball also appears on PDFs opened in the browser.'), h('a', { class: 'btn small', href: chrome.runtime.getURL('pdf.html'), target: '_blank' }, L('打开 PDF 阅读器', 'Open the PDF reader'))),
    ),
    h('h2', null, L('输入框翻译', 'Input box translation')),
    h('div', { class: 'card' },
      row(L('输入框翻译', 'Input box translation'), L('在网页的输入框里用母语写好，一键翻成要发出去的语言（替换输入框里的文字，Ctrl+Z 可以撤销）。', 'Write in your own language in a web page input box and turn it into the language you want to send in one step (replaces the text; Ctrl+Z undoes it).'), toggle(s.input.enabled, (enabled) => saveIn({ enabled }))),
      row(L('翻成', 'Into'), L('划词时如果选中的文字已经是目标语言，也会翻成这个语言。', 'When the selected text is already in the target language, it is translated into this language too.'), select(LANGS, s.input.targetLang, (targetLang) => saveIn({ targetLang }))),
      row(L('模式', 'Mode'), null, seg([['fast', L('快速', 'Fast')], ['accurate', L('精确', 'Accurate')]], s.input.mode === 'fast' ? 'fast' : 'accurate', (mode) => saveIn({ mode }))),
      row(L('输入框里的小圆球', 'Ball in input boxes'), L('光标在输入框里时，右下角出现一个小圆球，点一下就翻译；旁边可以临时换语言。', 'While the cursor is in an input box, a small ball appears in its corner; click it to translate. You can switch the language there too.'), toggle(s.input.ball, (ball) => saveIn({ ball }))),
      row(L('快捷键', 'Shortcut'), L('光标在输入框里时按。', 'Press it while the cursor is in an input box.'), seg([['Alt+T', 'Alt+T'], ['Alt+Y', 'Alt+Y'], ['Ctrl+Shift+Y', 'Ctrl+Shift+Y'], ['off', L('不用', 'Off')]], s.input.shortcut, (shortcut) => saveIn({ shortcut }))),
      row(L('连按三下空格', 'Triple space'), L('在输入框里快速按三下空格也会翻译（多出来的空格会去掉）。', 'Pressing space three times quickly in an input box also translates (the extra spaces are removed).'), toggle(s.input.tripleSpace, (tripleSpace) => saveIn({ tripleSpace }))),
      row(L('不显示小圆球的网站', 'Sites without the input ball'), L('快捷键在这些网站照常可用。', 'The shortcut still works on these sites.'), lines(s.input.hiddenOn, (hiddenOn) => saveIn({ hiddenOn }), 'docs.google.com')),
    ),
    h('h2', null, L('显示', 'Display')),
    h('div', { class: 'card' },
      row(L('界面语言', 'Interface language'), L('扩展自己的按钮、小窗和设置页用的语言。「跟随浏览器」：中文浏览器用中文，其他用英文。改了以后刷新页面生效。', 'Language of the extension’s own buttons, popups and settings. “Follow browser”: Chinese for a Chinese browser, English otherwise. Reload pages to apply.'),
        seg([['auto', L('跟随浏览器', 'Follow browser')], ['zh-CN', '中文'], ['en', 'English']], s.uiLang, (uiLang) => void save({ uiLang }).then(() => location.reload()))),
      row(L('显示方式', 'Display mode'), null, seg([['bilingual', L('双语对照', 'Bilingual')], ['translation', L('仅译文', 'Translation only')], ['original', L('仅原文', 'Original only')]], s.display, (display) => void save({ display }))),
      row(L('对照粒度', 'Bilingual granularity'), L('逐句：每句原文后面紧跟它的译文。', 'By sentence: each original sentence is followed by its translation.'), seg([['paragraph', L('逐段', 'By paragraph')], ['sentence', L('逐句', 'By sentence')]], s.bilingualStyle, (bilingualStyle) => void save({ bilingualStyle }))),
      row(L('高速译文浓度', 'Fast translation strength'), L('综合模式下先出现的浅色译文。', 'The light translation shown first in combined mode.'), range(25, 90, 5, s.fastColorPercent, (v) => v + '%', (fastColorPercent) => void save({ fastColorPercent }))),
      row(L('精确译文浓度', 'Accurate translation strength'), L('相对原文颜色，100% 即与原文一致。', 'Relative to the original text color; 100% matches it.'), range(60, 100, 5, s.finalColorPercent, (v) => v + '%', (finalColorPercent) => void save({ finalColorPercent }))),
      row(L('译文字号', 'Translation font size'), L('相对原文字号。', 'Relative to the original font size.'), range(0.8, 1.1, 0.05, s.fontScale, (v) => Math.round(v * 100) + '%', (fontScale) => void save({ fontScale }))),
      row(L('译文样式', 'Translation style'), L('点一下卡片就换，卡片里就是实际效果；学习模式下译文先模糊，鼠标移上去才显示。', 'Click a card to switch — each card shows the real effect. In study mode the translation stays blurred until you hover it.'), styleGrid),
      row(L('悬浮球和小窗的颜色', 'Ball and popup colors'), L('跟随网页：在深色网页上自动用深色，浅色网页上用浅色。', 'Follow page: dark on dark pages, light on light pages.'), seg([['auto', L('跟随网页', 'Follow page')], ['light', L('浅色', 'Light')], ['dark', L('深色', 'Dark')]], s.theme, (theme) => void save({ theme }))),
      row(L('主题色', 'Accent color'), L('悬浮球、按钮、选中状态用的颜色。默认雾蓝：不抢眼，又容易找到。也可以自己选一个颜色。', 'Used for the ball, buttons and selection. The default mist blue is easy to find without being loud. You can also pick your own.'), swatches),
      row(L('悬浮球样式', 'Ball style'), L('浅色：白底配主题色标志（最低调）；主题色：整颗球是主题色（最好找）；半透明：毛玻璃。', 'Light: white with an accent logo (most subtle); Accent: the whole ball in the accent color (easiest to find); Glass: frosted glass.'), seg([['light', L('浅色', 'Light')], ['accent', L('主题色', 'Accent')], ['glass', L('半透明', 'Glass')]], s.appearance.ball, (ball) => saveAp({ ball }))),
      row(L('悬浮球大小', 'Ball size'), null, seg([['s', L('小', 'S')], ['m', L('中', 'M')], ['l', L('大', 'L')]], s.appearance.ballSize, (ballSize) => saveAp({ ballSize }))),
      row(L('不用时的透明度', 'Opacity when idle'), L('鼠标移上去、或者小窗打开时恢复完全不透明。', 'Fully opaque again on hover or while a popup is open.'), range(0.35, 1, 0.05, s.appearance.idleOpacity, (v) => Math.round(v * 100) + '%', (idleOpacity) => saveAp({ idleOpacity }))),
      row(L('效果预览', 'Preview'), null, pvBox),
      row(L('等待效果', 'Loading effect'), L('字符跳动：在译文位置先显示快速变化的字符，译文到达时逐字定格。系统开启「减少动态效果」时自动用省略号。', 'Scramble: shows quickly changing characters where the translation will go, settling letter by letter when it arrives. Uses an ellipsis when the system asks for reduced motion.'), seg([['scramble', L('字符跳动', 'Scramble')], ['dots', L('省略号', 'Ellipsis')]], s.loadingEffect, (loadingEffect) => void save({ loadingEffect }))),
      row(L('预览', 'Preview'), null, preview),
    ),
    h('h2', null, L('网站', 'Sites')),
    h('div', { class: 'card' },
      row(L('总是自动翻译', 'Always translate'), L('每行一个域名，支持 *，如 *.medium.com', 'One domain per line, * allowed, e.g. *.medium.com'), lines(s.sites.always, (always) => void save({ sites: { ...s.sites, always } }), 'news.ycombinator.com')),
      row(L('从不自动翻译', 'Never translate'), null, lines(s.sites.never, (never) => void save({ sites: { ...s.sites, never } }), 'example.com')),
      row(L('敏感网站', 'Sensitive sites'), L('不自动翻译，译文不写缓存、不进同步。', 'Not translated automatically; translations are not cached or synced.'), lines(s.sensitive, (sensitive) => void save({ sensitive }), '*.bank.com')),
      row(L('隐藏悬浮球的网站', 'Sites without the ball'), null, lines(s.ball.hiddenOn, (hiddenOn) => void save({ ball: { ...s.ball, hiddenOn } }), 'docs.google.com')),
    ),
    h('h2', null, L('快捷键', 'Shortcuts')),
    h('div', { class: 'card' },
      row(L('翻译 / 还原本页', 'Translate / restore page'), L('默认 Alt+A；划词翻译默认 Alt+S。', 'Alt+A by default; selection translation is Alt+S.'), h('a', { href: '#', class: 'btn small', id: 'shortcuts' }, L('修改快捷键', 'Change shortcuts'))),
    ),
  );
  main.querySelector('#shortcuts')?.addEventListener('click', (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

async function renderAbout(main: HTMLElement) {
  let backend = L('未连接', 'Not connected');
  try {
    const r = await rpc('ping', undefined);
    backend = L(`${r.backend}（协议 v${r.protocol}）`, `${r.backend} (protocol v${r.protocol})`);
  } catch {
    /* 后端未就绪 */
  }
  main.append(
    h('h1', null, L('关于', 'About')),
    h('p', { class: 'lead' }, L('开源、本地优先的网页翻译扩展。', 'An open-source, local-first web page translation extension.')),
    h('div', { class: 'card' },
      row(L('前端协议版本', 'Frontend protocol'), null, document.createTextNode('v' + PROTOCOL_VERSION)),
      row(L('后端', 'Backend'), null, document.createTextNode(backend)),
      row(L('隐私', 'Privacy'), null, document.createTextNode(L('密钥只保存在本机；同步默认不包含密钥，开启后会加密。敏感网站的内容不写缓存。', 'Keys are stored only on this device; sync leaves keys out by default and encrypts them when enabled. Content of sensitive sites is never cached.'))),
    ),
  );
}
