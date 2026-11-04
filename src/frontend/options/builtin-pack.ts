/**
 * 浏览器内置翻译的语言包：在设置页里直接看状态、直接下载。
 *
 * 为什么放在前端：后台的「准备页」（offscreen.html?translatorSetup=1）只在「翻译服务」里点「测试」时才会弹出，
 * 新手指引里的检测为了不弹窗是不准备的；以前一开始没启用内置翻译的用户，就没有顺手的地方下载语言包。
 * 语言包是整个浏览器共用的，在设置页下载和在准备页下载效果一样，后台翻译时直接能用。
 * 「其他语言」用两个下拉框选（不再让用户手填 en、zh-Hant 这种代码）。
 * 下载必须由真实的点击启动（浏览器要求用户手势），所以 create() 在点击处理里第一时间调用，前面不等任何异步操作。
 */
import { PORT_STATUS, type ProviderInfo } from '../../shared/protocol';
import { rpc } from '../../shared/rpc';
import { L } from '../i18n';
import { LANGS, shortLang } from '../langs';
import { h } from '../ui/host';

type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable';
interface TranslatorApi {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(o: { sourceLanguage: string; targetLanguage: string; monitor?: (m: EventTarget) => void; signal?: AbortSignal }): Promise<{ destroy(): void }>;
}

const api = (): TranslatorApi | undefined => (self as unknown as { Translator?: TranslatorApi }).Translator;
/** 扩展里的语言代码 → 浏览器 Translator 接口用的代码。 */
const tag = (code: string) => (code === 'zh-CN' ? 'zh' : code === 'zh-TW' ? 'zh-Hant' : code);

export const PACK_CSS = `
.bp { display: grid; gap: 6px; font-size: 12.5px; }
.bp .bp-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.bp progress { width: 180px; height: 8px; }
.bp .ok { color: var(--good); } .bp .bad { color: var(--critical); } .bp .muted { color: var(--muted); }
.bp a.more { font-size: 12px; color: var(--muted); }
.bp .bp-pick select { max-width: 46%; font-size: 12.5px; }
`;

/**
 * 语言包卡片：默认看「英语 ↔ 目标语言」；「其他语言」展开两个下拉框，选了一边，另一边的每个选项后面标出
 * 已下载 / 可下载 / 不支持（不支持的不能选），一眼看出能下哪些。没下载时给「下载语言包」按钮和进度条，
 * 下好后如果内置翻译还没启用，顺手启用（provider 传进来时）。
 */
/**
 * 卡片被外面重画（比如下好语言包后自动启用服务，详情页整页重画）时，记住用户在「其他语言」里选的方向和刚才的结果，
 * 新卡片接着显示，不会跳回默认方向、让人以为刚才没下成功。只在这一页打开期间有效。
 */
let memo: { target: string; pair: { source: string; target: string }; open: boolean; done?: string } | null = null;

/** 检测沿用当前卡片方向，不写回全局翻译语言。 */
export function builtinTestPair(target: string) {
  const pair = memo?.target === target ? memo.pair : { source: target === 'en' ? 'zh-CN' : 'en', target };
  return { sourceLang: pair.source, targetLang: pair.target };
}

export function builtinPackCard(target: string, provider?: ProviderInfo, onChange?: () => void): HTMLElement {
  const kept = memo && memo.target === target ? memo : null;
  const requested = new URLSearchParams(location.search);
  const requestedSource = requested.get('sourceLang'), requestedTarget = requested.get('targetLang');
  const supplied = requestedSource && requestedTarget && LANGS.some(([code]) => code === requestedSource) && LANGS.some(([code]) => code === requestedTarget)
    ? { source: requestedSource, target: requestedTarget } : undefined;
  let pair = kept?.pair ?? supplied ?? { source: target === 'en' ? 'zh-CN' : 'en', target };
  let revision = 0, refreshing = 0, downloading = false;
  const marks = new WeakMap<HTMLSelectElement, number>();
  const remember = (patch: Partial<NonNullable<typeof memo>>) => {
    memo = { target, pair, open: !picker.hidden, ...(memo && memo.target === target ? { done: memo.done } : {}), ...patch };
  };
  const name = () => `${shortLang(pair.source)} → ${shortLang(pair.target)}`;
  const line = h('span', { class: 'muted' }, L('正在查看语言包…', 'Checking the language pack…'));
  const btn = h('button', { class: 'btn small primary', type: 'button', hidden: true }, L('下载语言包', 'Download language pack')) as HTMLButtonElement;
  const enable = h('button', { class: 'btn small', type: 'button', hidden: true }, L('启用浏览器内置翻译', 'Enable the browser translator')) as HTMLButtonElement;
  const bar = h('progress', { max: '1', value: '0', hidden: true }) as HTMLProgressElement;

  // 其他语言：两个下拉框
  const srcSel = h('select', { 'aria-label': L('原文语言', 'Source language') }) as HTMLSelectElement;
  const tgtSel = h('select', { 'aria-label': L('译文语言', 'Target language') }) as HTMLSelectElement;
  const fill = (sel: HTMLSelectElement, value: string) => {
    sel.replaceChildren(...LANGS.map(([code, label]) => h('option', { value: code, selected: code === value }, label)));
  };
  fill(srcSel, pair.source);
  fill(tgtSel, pair.target);
  const picker = h('div', { class: 'bp-row bp-pick', hidden: !kept?.open }, srcSel, h('span', { class: 'muted' }, '→'), tgtSel);
  const more = h('a', { class: 'more', href: '#' }, L('其他语言…', 'Other languages…'));
  if (kept?.open) more.textContent = L('收起', 'Hide');
  more.addEventListener('click', (e) => {
    e.preventDefault();
    picker.hidden = !picker.hidden;
    more.textContent = picker.hidden ? L('其他语言…', 'Other languages…') : L('收起', 'Hide');
    remember({});
    if (!picker.hidden) void mark(tgtSel, srcSel.value, 'target');
  });
  const el = h('div', { class: 'bp' }, h('div', { class: 'bp-row' }, line), picker, h('div', { class: 'bp-row' }, btn, enable, bar, more));
  let enabled = provider?.enabled ?? true;

  const say = (cls: string, text: string) => {
    line.className = cls;
    line.textContent = text;
  };
  const showEnable = () => (enable.hidden = !provider || enabled);
  const availability = async (source: string, targetLang: string): Promise<Availability> => {
    try {
      return await api()!.availability({ sourceLanguage: tag(source), targetLanguage: tag(targetLang) });
    } catch {
      return 'unavailable';
    }
  };
  /** 选了一边以后，给另一边的每个语言标上状态；不支持的灰掉。 */
  const mark = async (sel: HTMLSelectElement, fixed: string, side: 'source' | 'target') => {
    if (!api() || downloading) return;
    const generation = revision, markId = (marks.get(sel) ?? 0) + 1;
    marks.set(sel, markId);
    const current = () => !downloading && generation === revision && marks.get(sel) === markId;
    const tags: Record<Availability, string> = {
      available: L('已下载', 'downloaded'),
      downloadable: L('可下载', 'downloadable'),
      downloading: L('下载中', 'downloading'),
      unavailable: L('不支持', 'unsupported'),
    };
    await Promise.all([...sel.options].map(async (o) => {
      const base = LANGS.find(([c]) => c === o.value)?.[1] ?? o.value;
      if (o.value === fixed) {
        o.textContent = base;
        o.disabled = true;
        return;
      }
      const a = await (side === 'target' ? availability(fixed, o.value) : availability(o.value, fixed));
      if (!current()) return;
      o.textContent = `${base} · ${tags[a]}`;
      o.disabled = a === 'unavailable';
    }));
    // 当前选的这个不能用了（比如和另一边一样），换成第一个能用的
    if (current() && sel.selectedOptions[0]?.disabled) {
      const ok = [...sel.options].find((o) => !o.disabled);
      if (ok) sel.value = ok.value;
    }
  };
  const choose = async (side: 'source' | 'target') => {
    if (downloading) { srcSel.value = pair.source; tgtSel.value = pair.target; return; }
    const generation = ++revision;
    pair = { source: srcSel.value, target: tgtSel.value };
    remember({ done: undefined });
    void refresh();
    if (side === 'source') await mark(tgtSel, pair.source, 'target');
    else await mark(srcSel, pair.target, 'source');
    if (generation !== revision || downloading) return;
    pair = { source: srcSel.value, target: tgtSel.value };
    remember({ done: undefined });
    void refresh();
  };
  srcSel.addEventListener('change', () => void choose('source'));
  tgtSel.addEventListener('change', () => void choose('target'));

  const refresh = async () => {
    const generation = revision, refreshId = ++refreshing;
    const selected = { ...pair };
    if (!api()) {
      say('muted', L('这个浏览器没有内置翻译（需要 Chrome 138 以上的桌面版或新版 Edge）。', 'This browser has no built-in translator (needs desktop Chrome 138+ or a recent Edge).'));
      btn.hidden = enable.hidden = true;
      more.hidden = true;
      return;
    }
    const a = await availability(selected.source, selected.target);
    if (generation !== revision || refreshId !== refreshing || downloading) return;
    btn.hidden = !(a === 'downloadable' || a === 'downloading');
    if (a === 'available') say('ok', L(`✓ ${name()} 语言包已下载，可以离线翻译。`, `✓ ${name()} language pack is downloaded — works offline.`));
    else if (a === 'downloading') say('muted', L(`${name()} 语言包正在下载…（可以点按钮看进度）`, `${name()} language pack is downloading… (click the button to see progress)`));
    else if (a === 'downloadable') say('muted', L(`${name()} 语言包还没下载（只下一次，之后离线可用）。`, `${name()} language pack is not downloaded yet (one-time; works offline afterwards).`));
    else say('muted', L(`浏览器内置翻译不支持 ${name()}，这个组合会自动用别的服务。`, `The browser translator does not support ${name()}; other services will be used for it.`));
    showEnable();
  };

  btn.addEventListener('click', () => {
    const t = api();
    if (!t || downloading) return;
    const started = { ...pair };
    downloading = true; revision++; refreshing++;
    btn.disabled = srcSel.disabled = tgtSel.disabled = true;
    bar.hidden = false;
    bar.value = 0;
    say('muted', L(`正在下载 ${name()} 语言包，请别关这一页…`, `Downloading the ${name()} language pack — keep this page open…`));
    // 必须在点击里第一时间调用 create（浏览器要求用户手势），前面不能 await 任何东西
    const creation = (() => { try { return t.create({
      sourceLanguage: tag(started.source),
      targetLanguage: tag(started.target),
      monitor: (m) => m.addEventListener('downloadprogress', (e) => {
        const p = e as ProgressEvent;
        const v = p.total > 0 ? p.loaded / p.total : p.loaded;
        if (Number.isFinite(v)) bar.value = Math.max(0, Math.min(1, v));
      }),
    }); } catch (error) { return Promise.reject(error); } })();
    void creation.then(
      async (session) => {
        session.destroy();
        bar.value = 1;
        // 下好了而内置翻译还没启用：顺手启用（用户点下载就是想用它）
        const wasEnabled = enabled;
        if (provider && !enabled) {
          await rpc('providers:save', { id: provider.id, enabled: true, config: provider.config }).then(() => (enabled = true), () => {});
        }
        // 下载成功只影响启动时的方向；通知后台清短负缓存，不额外产生试译。
        downloading = false;
        try {
          const port = chrome.runtime.connect({ name: PORT_STATUS });
          port.postMessage({ type: 'probe', providerId: provider?.id ?? 'browser-translator' });
          setTimeout(() => port.disconnect(), 3000);
        } catch { /* 后台短暂重启时缓存仍会在十五秒内失效。 */ }
        await refresh();
        if (enabled && provider) say('ok', L(`✓ ${name()} 语言包已下载，浏览器内置翻译已启用。`, `✓ ${name()} language pack downloaded; the browser translator is enabled.`));
        remember({ done: line.textContent ?? '' });
        bar.hidden = true;
        if (!picker.hidden) void mark(tgtSel, srcSel.value, 'target');
        // 只有启用状态变了才通知外面（外面会重画详情页，没必要时别把刚显示的结果冲掉）
        if (enabled !== wasEnabled) onChange?.();
      },
      (e: unknown) => {
        bar.hidden = true;
        const n = (e as DOMException)?.name;
        say('bad', n === 'NotAllowedError'
          ? L('浏览器要求再点一次按钮才能下载。', 'The browser needs another click on the button to start the download.')
          : L('浏览器暂时下载不了（检查网络，或这个语言组合不支持）。别的翻译服务照常能用。', 'The browser could not download it right now (check the network, or the pair is unsupported). Other services still work.'));
      },
    ).finally(() => { downloading = false; btn.disabled = srcSel.disabled = tgtSel.disabled = false; });
  });

  enable.addEventListener('click', async () => {
    if (!provider) return;
    enable.disabled = true;
    await rpc('providers:save', { id: provider.id, enabled: true, config: provider.config }).then(() => (enabled = true), () => {});
    enable.disabled = false;
    showEnable();
    onChange?.();
  });

  // 重画后的新卡片：先查一遍状态，再把刚才的结果（如「已下载，已启用」）接着显示
  remember({});
  void refresh().then(() => {
    if (kept?.done && line.className === 'ok') say('ok', kept.done);
  });
  if (kept?.open) void mark(tgtSel, srcSel.value, 'target');
  return el;
}
