/**
 * 新手指引（设置页 #welcome）。五步，每步都有自己的地址（#welcome/plan、#welcome/api/microsoft……）：
 *   ① 基础设置：语言、模式、显示、划词 / 输入框翻译、快捷键
 *   ② 选择方案：检测浏览器内置翻译、显卡、本地模型，给出推荐组合；说明要不要部署本地模型
 *   ③ 本地模型：硬件要求、放在哪里、下载哪几个文件、怎么启动、开机自启、常见问题
 *   ④ 云端服务：各家对比；每家都有一步一步的注册 / 开通 / 拿密钥教程，可以直接在教程页里填密钥并测试
 *   ⑤ 试译并完成
 * 第一次打开设置页、或页面上提示「没有可用的翻译服务」时会来到这里。
 */
import type { ProviderInfo } from '../../shared/protocol';
import { rpc, uid } from '../../shared/rpc';
import { loadUiSettings, saveUiSettings, type UiSettings } from '../../shared/settings';
import { TranslateClient } from '../content/port';
import { h } from '../ui/host';
import { LANGS, SOURCE_LANGS } from '../langs';
import { apiGuides, LLAMA_BUILDS, MODEL_FILE, renderRich, type ApiGuide } from './guides';
import { localModelCard } from './providers';
import { builtinPackCard, builtinTestPair, PACK_CSS } from './builtin-pack';
import { L } from '../i18n';

const CSS = `
.gd { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 24px; align-items: start; max-width: 1060px; }
@media (max-width: 900px) { .gd { grid-template-columns: 1fr; } .gd-steps { position: static !important; display: flex !important; overflow-x: auto; } }
.gd-steps { position: sticky; top: 20px; display: grid; gap: 2px; }
.gd-steps a { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 9px; color: var(--ink-2); text-decoration: none; white-space: nowrap; }
.gd-steps a:hover { background: var(--hover); }
.gd-steps a[aria-current="step"] { background: var(--hover); color: var(--ink); font-weight: 600; }
.gd-steps .n { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; background: var(--line); color: var(--ink-2); flex: none; }
.gd-steps a[aria-current="step"] .n { background: var(--accent); color: #fff; }
.gd-steps a.done .n { background: var(--good); color: #fff; }
.gd-body { display: grid; gap: 16px; min-width: 0; }
.gd a.btn { text-decoration: none; }
.gd-body a:not(.btn):not(.gd-opt) { color: var(--accent); text-underline-offset: 2px; }
.gd-body .gd-links a { color: var(--ink); }
.gd-body h2 { margin: 0; font-size: 19px; }
.gd-body h3 { margin: 0 0 8px; font-size: 14.5px; }
.gd-body p { margin: 0 0 8px; line-height: 1.65; }
.gd-card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; min-width: 0; }
.gd-card.soft { background: color-mix(in srgb, var(--accent) 6%, var(--surface)); border-color: color-mix(in srgb, var(--accent) 25%, var(--line)); }
.gd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
.gd-opt { display: grid; gap: 7px; align-content: start; border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; background: var(--surface); color: var(--ink); text-decoration: none; }
a.gd-opt:hover, a.gd-opt:focus-visible { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
.gd-opt b { font-size: 14.5px; }
.gd-opt .meta { font-size: 12.5px; color: var(--muted); line-height: 1.55; }
.gd-opt .st { font-size: 12.5px; }
.gd-body .ok { color: var(--good); } .gd-body .bad { color: var(--critical); } .gd-body .muted { color: var(--muted); }
.gd-row { display: grid; grid-template-columns: minmax(150px, 34%) 1fr; gap: 16px; align-items: center; padding: 11px 0; border-top: 1px solid var(--line); }
.gd-row:first-child { border-top: 0; padding-top: 2px; }
.gd-row .hint { color: var(--muted); font-size: 12.5px; line-height: 1.5; margin-top: 2px; }
@media (max-width: 760px) { .gd-row { grid-template-columns: 1fr; gap: 6px; } }
.gd-nav { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.gd-nav .grow { flex: 1; }
.gd-nav .skip { font-size: 12.5px; color: var(--muted); }
ol.gd-st { margin: 0; padding: 0; list-style: none; counter-reset: st; display: grid; gap: 16px; }
ol.gd-st > li { counter-increment: st; display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 12px; }
ol.gd-st > li::before { content: counter(st); width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: #fff; font-weight: 700; font-size: 13px; display: grid; place-items: center; }
ol.gd-st b.t { display: block; margin: 3px 0 5px; }
ol.gd-st p, ol.gd-st ul { margin: 0 0 6px; color: var(--ink-2); line-height: 1.65; }
ol.gd-st ul { padding-left: 18px; }
.gd-body code { font-size: 12.5px; padding: 1px 6px; border-radius: 5px; background: var(--hover); overflow-wrap: anywhere; }
.gd-tree { font: 12.5px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; white-space: pre; overflow-x: auto; margin: 8px 0; }
.gd-tips { margin: 0; padding-left: 18px; color: var(--ink-2); font-size: 13px; display: grid; gap: 6px; line-height: 1.6; }
.gd-tips p { margin: 0; display: inline; }
.gd-links { display: flex; flex-wrap: wrap; gap: 8px; }
.gd-links a { font-size: 12.5px; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--line); text-decoration: none; color: var(--ink); background: var(--surface); }
.gd-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.gd-table th, .gd-table td { text-align: left; padding: 8px 10px; border-top: 1px solid var(--line); vertical-align: top; line-height: 1.5; }
.gd-table thead th { color: var(--muted); font-weight: 500; font-size: 12px; border-top: 0; }
.gd-table td:first-child, .gd-table td.nw, .gd-table th.nw { white-space: nowrap; }
.gd-table.api td:first-child { white-space: normal; min-width: 210px; }
.gd-table tr.pick { cursor: pointer; }
.gd-table tr.pick:hover td, .gd-table tr.pick:focus-visible td { background: var(--hover); }
.gd-table tr.pick:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.gd-table .hint { color: var(--muted); font-size: 12px; white-space: normal; }
.gd-form { display: grid; gap: 12px; }
.gd-form label { display: grid; gap: 5px; font-size: 12.5px; color: var(--ink-2); }
.gd-form input, .gd-form select { width: 100%; max-width: 480px; box-sizing: border-box; }
.gd-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.gd-pill { font-size: 11.5px; padding: 1px 8px; border-radius: 99px; background: var(--hover); color: var(--ink-2); white-space: nowrap; }
.gd-pill.acc { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); font-weight: 600; }
.gd-kbd { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; font-size: 13px; }
@media (max-width: 700px) { .gd-kbd { grid-template-columns: 1fr; } }
.kbd { display: inline-block; font: 12px ui-monospace, monospace; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--line); border-bottom-width: 2px; background: var(--bg); }
.gd-inline { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.try textarea { width: 100%; box-sizing: border-box; min-height: 60px; font-family: inherit; font-size: 14px; }
.try .out { min-height: 44px; padding: 10px 12px; border-radius: 10px; background: var(--bg); border: 1px dashed var(--line); font-size: 15px; margin-top: 10px; }
.try .out[data-stage="fast"] { opacity: .7; }
.try .out .by { display: block; font-size: 11.5px; color: var(--muted); margin-top: 4px; }
/* 本机模型卡片（和「翻译服务」页共用组件） */
.pv-card { background: var(--bg); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin-top: 8px; }
.pv-card h3 small { font-weight: 400; color: var(--muted); margin-left: 6px; font-size: 12px; }
.pv-card .inline { display: flex; gap: 8px; align-items: center; }
.pv-card .hint { color: var(--muted); font-size: 12.5px; }
${PACK_CSS}
`;

type Step = 'basics' | 'plan' | 'local' | 'api' | 'done';
const STEPS: [Step, string][] = [['basics', L('基础设置', 'Basics')], ['plan', L('选择方案', 'Choose a setup')], ['local', L('本地模型', 'Local model')], ['api', L('云端服务', 'Cloud services')], ['done', L('试译并完成', 'Try it and finish')]];

interface Env {
  /** 浏览器内置翻译接口（Chrome 138+ 桌面版 / 新版 Edge）。 */
  builtin: boolean;
  gpu: { vendor: string; label: string } | null;
  memoryGb?: number;
  providers: ProviderInfo[];
  /** 本地模型现在能不能用；null = 后端没有本地模型服务。 */
  local: boolean | null;
  /** 不需要密钥、检测可用并已自动启用的服务。 */
  autoEnabled: string[];
  /** 不需要密钥的服务的真实检测结果（服务 id → 结果）。「已启用」不等于「能用」。 */
  tests: Map<string, TestResult>;
}

interface TestResult {
  ok: boolean;
  latencyMs?: number;
  message?: string;
  code?: string;
}

const test = async (id: string): Promise<TestResult> => {
  const settings = await loadUiSettings();
  const pair = id === 'browser-translator' ? builtinTestPair(settings.targetLang) : { sourceLang: settings.sourceLang, targetLang: settings.targetLang };
  return rpc('providers:test', { id, ...pair }).then(
    (r) => ({ ok: r.ok, latencyMs: r.latencyMs === undefined ? undefined : Math.round(r.latencyMs), message: r.error?.message, code: r.error?.code }),
    (e) => ({ ok: false, message: String((e as Error).message) }),
  );
};

/** 测试失败时告诉用户下一步该查什么：密钥错和网络不通的处理完全不一样。 */
function nextStep(code: string | undefined): string {
  switch (code) {
    case 'auth':
      return L('检查一下密钥（和地域、模型名）是不是填对了，对照上面的步骤再看一遍。', 'Check the key (and region / model name) against the steps above.');
    case 'network':
      return L('检查网络和代理（在中国大陆访问部分海外服务要代理）。密钥已经保存，网络好了会自动用上。', 'Check your network and proxy. The key is saved and will be used once the connection works.');
    case 'quota':
      return L('这个账号的额度用完了：到服务商的账户页看看。按月 / 按天重置的等下个周期就恢复；一次性的总额度（如 DeepL API Developer）用完不会自动恢复，请换一家或升级套餐。', 'This account’s quota is used up — check the provider’s account page. Monthly / daily quotas come back next period; one-time totals (e.g. DeepL API Developer) do not, so switch services or upgrade.');
    case 'rate_limit':
      return L('请求太快被限流了，过一分钟再点一次测试。', 'Rate-limited — try the test again in a minute.');
    case 'server':
      return L('服务方暂时出错，过一会儿再试。', 'The service had an error — try again later.');
    default:
      return L('对照上面的步骤再检查一下。', 'Check the steps above again.');
  }
}

const isLocal = (p: ProviderInfo) => p.kind === 'local' && !p.custom;
/** 找到教程对应的内置服务（真实后端和演示后端的 id 不完全一样，所以也按适配器文件名找）。 */
const builtinFor = (providers: ProviderInfo[], id: string) =>
  providers.find((p) => !p.custom && (p.id === id || p.adapter.file.endsWith(`/${id}.ts`)));

let envP: Promise<Env> | null = null;
/**
 * 检测一次就够（在步骤之间切换不重复检测），保存服务后清掉重来。
 * 不需要密钥的官方服务（浏览器内置、本地模型、远程节点）检测可用就直接启用——和以前的快速设置一样。
 */
function detect(): Promise<Env> {
  return (envP ??= (async () => {
    let gpu: Env['gpu'] = null;
    try {
      type Adapter = { info?: { vendor?: string; architecture?: string; description?: string } } | null;
      const nav = navigator as Navigator & { gpu?: { requestAdapter(o?: { powerPreference?: string }): Promise<Adapter> } };
      const info = (await nav.gpu?.requestAdapter({ powerPreference: 'high-performance' }))?.info;
      if (info?.vendor) gpu = { vendor: info.vendor.toLowerCase(), label: [info.vendor, info.architecture, info.description].filter(Boolean).join(' · ') };
    } catch {
      /* 没有 WebGPU：当作没检测到 */
    }
    const providers = await rpc('providers:list', undefined).catch(() => [] as ProviderInfo[]);
    const keyless = providers.filter((p) => p.official && !p.custom && (p.kind === 'builtin' || p.kind === 'local' || p.kind === 'remote') && p.configured);
    const results = await Promise.all(keyless.map(async (p) => [p, await test(p.id)] as const));
    const autoEnabled: string[] = [];
    for (const [p, r] of results) {
      if (r.ok && !p.enabled) {
        await rpc('providers:save', { id: p.id, enabled: true, config: p.config }).then(() => {
          p.enabled = true;
          autoEnabled.push(p.name);
        }, () => {});
      }
    }
    const localP = providers.find(isLocal);
    const localR = results.find(([p]) => p === localP)?.[1];
    return {
      builtin: 'Translator' in self,
      gpu,
      memoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
      providers,
      local: localP ? !!localR?.ok : null,
      autoEnabled,
      tests: new Map(results.map(([p, r]) => [p.id, r])),
    };
  })());
}

export async function mountWelcome(main: HTMLElement): Promise<void> {
  const parts = location.hash.slice(1).split('/');
  const step: Step = STEPS.some(([s]) => s === parts[1]) ? (parts[1] as Step) : 'basics';
  const at = STEPS.findIndex(([x]) => x === step);
  const s = await loadUiSettings();
  const nav = h('nav', { class: 'gd-steps', 'aria-label': L('指引步骤', 'Guide steps') });
  STEPS.forEach(([id, label], i) => {
    nav.append(h('a', { href: `#welcome/${id}`, 'aria-current': id === step ? 'step' : undefined, class: i < at ? 'done' : undefined }, h('span', { class: 'n' }, String(i + 1)), label));
  });
  const body = h('div', { class: 'gd-body' }, h('p', { class: 'muted' }, L('正在检测…', 'Detecting…')));
  main.append(
    h('style', null, CSS),
    h('h1', null, L('新手指引', 'Get started')),
    h('p', { class: 'lead' }, L('五步配好：先定基础设置，再选翻译方案——浏览器内置翻译、本地大模型、云端服务，三种可以组合。配好后打开任何外文网页，点右下角的圆球（或按 Alt+A）就能翻译。', 'Five steps: basics first, then pick how to translate — the browser’s built-in translator, a local LLM, cloud services, or a mix. Then open any foreign-language page and click the ball in the bottom-right corner (or press Alt+A).')),
    h('div', { class: 'gd' }, nav, body),
  );
  window.scrollTo({ top: 0 });

  const bar = (to: Step | null, label = L('下一步', 'Next')) => {
    const el = h('div', { class: 'gd-nav' });
    if (at > 0) el.append(h('a', { class: 'btn', href: `#welcome/${STEPS[at - 1][0]}` }, L('上一步', 'Back')));
    el.append(h('span', { class: 'grow' }));
    const skip = h('a', { href: '#general', class: 'skip' }, L('跳过指引', 'Skip the guide'));
    skip.addEventListener('click', () => void saveUiSettings({ onboarded: true }));
    el.append(skip);
    if (to) el.append(h('a', { class: 'btn primary', href: `#welcome/${to}` }, label));
    return el;
  };
  let content: HTMLElement[];
  if (step === 'basics') content = [...basics(s), bar('plan')];
  else if (step === 'plan') {
    const env = await detect();
    const wantsLocal = env.local !== true;
    content = [...plan(env, s.targetLang), bar(wantsLocal ? 'local' : 'api', wantsLocal ? L('下一步：本地模型', 'Next: local model') : L('下一步：云端服务', 'Next: cloud services'))];
  } else if (step === 'local') content = [...local(await detect()), bar('api', L('下一步：云端服务', 'Next: cloud services'))];
  else if (step === 'api') content = [...api(await detect(), parts[2]), bar('done')];
  else content = await done(s);
  body.replaceChildren(...content);
}

/* ------------------------------------------------------------------ */
/* ① 基础设置                                                          */
/* ------------------------------------------------------------------ */

function basics(start: UiSettings): HTMLElement[] {
  let s = start;
  const save = async (patch: Partial<UiSettings>) => void (s = await saveUiSettings(patch));
  const select = (list: readonly (readonly [string, string])[], value: string, label: string, on: (v: string) => void) => {
    const el = h('select', { 'aria-label': label }) as HTMLSelectElement;
    for (const [v, text] of list) el.append(h('option', { value: v, selected: v === value }, text));
    el.addEventListener('change', () => on(el.value));
    return el;
  };
  const seg = <T extends string>(items: [T, string][], value: T, on: (v: T) => void) => {
    const box = h('div', { class: 'seg', role: 'group' });
    for (const [v, label] of items) {
      const b = h('button', { type: 'button', 'aria-pressed': String(v === value) }, label);
      b.addEventListener('click', () => {
        box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        on(v);
      });
      box.append(b);
    }
    return box;
  };
  const toggle = (value: boolean, label: string, on: (v: boolean) => void) => {
    const i = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': label }) as HTMLInputElement;
    i.checked = value;
    i.addEventListener('change', () => on(i.checked));
    return i;
  };
  const row = (name: string, hint: string, control: Node) =>
    h('div', { class: 'gd-row' }, h('div', null, h('b', null, name), h('div', { class: 'hint' }, hint)), h('div', null, control));
  return [
    h('h2', null, L('① 基础设置', '① Basics')),
    h('div', { class: 'gd-card' },
      row(L('翻译成', 'Translate into'), L('整页、划词、PDF、字幕都翻成这个语言。', 'Pages, selections, PDFs and subtitles are all translated into this language.'), select(LANGS, s.targetLang, L('翻译成', 'Translate into'), (targetLang) => void save({ targetLang }))),
      row(L('原文语言', 'Source language'), L('一般选「自动识别」；很短的文字偶尔认错时再手动指定。划词小窗里也能随时改。', 'Usually “Detect language”; set it by hand only when very short text gets misdetected. You can also change it in the selection popup.'), select(SOURCE_LANGS, s.sourceLang, L('原文语言', 'Source language'), (sourceLang) => void save({ sourceLang }))),
      row(L('整页翻译模式', 'Page translation mode'), L('综合（推荐）：先用最快的服务出浅色译文，再用质量最好的服务换成深色译文。快速：只用快的。精确：只用好的。', 'Combined (recommended): the fastest service shows a light translation first, then the best one replaces it in a darker color. Fast: fast services only. Accurate: the best services only.'),
        seg([['combined', L('综合', 'Combined')], ['fast', L('快速', 'Fast')], ['accurate', L('精确', 'Accurate')]], s.mode, (mode) => void save({ mode }))),
      row(L('显示方式', 'Display'), L('双语对照：原文下面跟着译文。仅译文：直接替换原文，鼠标移上去看原文。', 'Bilingual: the translation follows each original paragraph. Translation only: replaces the original; hover to see it.'),
        seg([['bilingual', L('双语对照', 'Bilingual')], ['translation', L('仅译文', 'Translation only')]], s.display === 'translation' ? 'translation' : 'bilingual', (display) => void save({ display }))),
      row(L('只翻正文', 'Main content only'), L('自动跳过导航、侧栏、广告和评论区（文章目录照翻），更省额度也更清爽。', 'Skips navigation, sidebars, ads and comments automatically (article outlines are still translated) — saves quota and looks cleaner.'), toggle(s.mainOnly, L('只翻正文', 'Main content only'), (mainOnly) => void save({ mainOnly }))),
      row(L('划词翻译', 'Selection translation'), L('选中文字后旁边出现小圆点，点开看译文；单个英文单词会显示词典。', 'A small dot appears next to selected text; click it to see the translation. A single English word shows the dictionary.'), toggle(s.selection.enabled, L('划词翻译', 'Selection translation'), (enabled) => void save({ selection: { ...s.selection, enabled } }))),
      row(L('输入框翻译', 'Input box translation'), L('在网页输入框里写好中文，按 Alt+T 或点输入框角上的小圆球，翻成右边的语言再发出去。', 'Write in your own language in a page input box, press Alt+T or click the small ball in its corner, and it is translated into the language on the right before you send it.'),
        h('div', { class: 'gd-inline' },
          toggle(s.input.enabled, L('输入框翻译', 'Input box translation'), (enabled) => void save({ input: { ...s.input, enabled } })),
          select(LANGS, s.input.targetLang, L('输入框翻译成', 'Translate input boxes into'), (targetLang) => void save({ input: { ...s.input, targetLang } })))),
    ),
    h('div', { class: 'gd-card soft' },
      h('h3', null, L('记住这几个快捷键', 'Remember these shortcuts')),
      h('div', { class: 'gd-kbd' },
        h('div', null, h('span', { class: 'kbd' }, 'Alt+A'), L(' 翻译 / 还原整页', ' translate / restore the page')),
        h('div', null, h('span', { class: 'kbd' }, 'Alt+S'), L(' 翻译选中的文字', ' translate the selected text')),
        h('div', null, h('span', { class: 'kbd' }, 'Alt+T'), L(' 翻译输入框里写的文字', ' translate what you typed in an input box')),
        h('div', null, L('按住 ', 'Hold '), h('span', { class: 'kbd' }, 'Alt'), L(' 停在词上：原文和译文对应的词一起高亮', ' and rest on a word: the matching words in the original and translation light up')),
        h('div', null, h('span', { class: 'kbd' }, 'Shift+F10'), L(' 光标在译文里时：打开这段译文的工具条（重翻、换一家、复制、修改）', ' with the caret in a translation: open its toolbar (retranslate, switch service, copy, edit)')),
        h('div', null, h('span', { class: 'kbd' }, 'Alt+Shift+T'), L(' 在输入框里：打开小圆球的面板（换语言、撤销）', ' in an input box: open the small ball’s panel (language, undo)')),
      ),
      h('p', { class: 'hint muted', style: 'margin:10px 0 0;font-size:12.5px' }, L('浏览器里打开的 PDF 右下角也有一个小圆球（可以拖动）：点一下用双栏对照阅读，公式和符号保持原样。整页快捷键可以在 chrome://extensions/shortcuts 里改；输入框快捷键在「常用 → 输入框翻译」里改。', 'PDFs opened in the browser get a small (draggable) ball too: click it for the side-by-side reader; formulas and symbols stay as they are. Change the page shortcuts at chrome://extensions/shortcuts and the input-box shortcut under Settings → Input box translation.')),
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* ② 选择方案                                                          */
/* ------------------------------------------------------------------ */

function plan(env: Env, target: string): HTMLElement[] {
  const builtinP = env.providers.find((p) => p.kind === 'builtin' && !p.custom);
  const cloud = env.providers.filter((p) => p.configured && p.enabled && (p.kind === 'mt' || p.kind === 'llm') && p.official);
  const vendor = env.gpu?.vendor ?? '';
  const dGpu = /nvidia|amd|ati/.test(vendor);
  const gpuText = env.gpu ? L(`检测到显卡：${env.gpu.label}。`, `Detected GPU: ${env.gpu.label}. `) : L('没有检测到显卡信息（浏览器可能没开 WebGPU）。', 'No GPU information (WebGPU may be off in this browser). ');
  const rec: [string, string] = dGpu
    ? [L('推荐：本地模型当高速档 + 一家大模型当精确档', 'Recommended: local model as the fast tier + one LLM as the accurate tier'),
      L(`${gpuText}本地模型只占约 1.4 GB 显存，翻一段通常不到 0.2 秒，离线、私密、不限量；再接一家大模型（中国大陆：智谱免费模型；海外：Gemini），综合模式下先出本地译文，再换成更好的译文。`, `${gpuText}The local model needs only about 1.4 GB of VRAM and usually translates a paragraph in under 0.2 s — offline, private, unlimited. Add one LLM (mainland China: Zhipu’s free models; elsewhere: Gemini); in combined mode you see the local translation first, then a better one.`)]
    : /intel|apple|qualcomm/.test(vendor)
      ? [L('推荐：浏览器内置翻译 / 微软翻译当高速档 + 一家大模型当精确档', 'Recommended: browser translator / Microsoft as the fast tier + one LLM as the accurate tier'),
        L(`${gpuText}核显也能跑本地模型（用 Vulkan 版），只是慢一些；更省事的是浏览器内置翻译（本机运行、不要密钥）或微软翻译（每月 200 万字符免费）。`, `${gpuText}Integrated graphics can run the local model too (Vulkan build), just slower; easier options are the browser’s built-in translator (runs locally, no key) or Microsoft (2 million free characters a month).`)]
      : [L('推荐：浏览器内置翻译 / 微软翻译当高速档 + 一家大模型当精确档', 'Recommended: browser translator / Microsoft as the fast tier + one LLM as the accurate tier'),
        L(`${gpuText}本地模型可以用 CPU 跑，但会比较慢；先用浏览器内置翻译（不要密钥）或微软翻译，确实需要离线再部署本地模型。`, `${gpuText}The local model can run on the CPU but is fairly slow; start with the browser’s built-in translator (no key) or Microsoft, and deploy the local model later if you really need offline.`)];

  // 浏览器内置翻译分三件事说清楚：浏览器有没有这个接口、扩展里启用了没有、要用的语言包下好了没有
  const builtinState = h('div', { class: 'st' });
  const builtinR = builtinP ? env.tests.get(builtinP.id) : undefined;
  if (!env.builtin || !builtinP) builtinState.append(h('span', { class: 'muted' }, L('这个浏览器不支持（需要 Chrome 138 以上的桌面版或新版 Edge）', 'Not supported in this browser (needs desktop Chrome 138+ or a recent Edge)')));
  // 语言包没下好的原因由下面的语言包卡片说明并给下载按钮；其他原因（如浏览器窗口没准备好）才把后台的说法显示出来
  else if (builtinR && !builtinR.ok && !/语言包|language pack/i.test(builtinR.message ?? '')) builtinState.append(h('div', { class: 'muted' }, L('暂时不能用：', 'Not usable right now: ') + (builtinR.message ?? '')));
  else {
    builtinState.append(h('div', { class: builtinP.enabled ? 'ok' : 'muted' }, builtinP.enabled ? L('✓ 浏览器支持，已启用', '✓ Supported by the browser, enabled') : L('浏览器支持，还没启用', 'Supported, not enabled yet')));
  }
  // 语言包：状态 + 「下载语言包」按钮（新手指引里的检测不会弹后台的准备页，所以在这里直接给下载入口）
  if (env.builtin && builtinP) builtinState.append(builtinPackCard(target, builtinP));

  const card = (title: string, pills: string[], desc: string, state: Node, href?: string) =>
    h(href ? 'a' : 'div', { class: 'gd-opt', ...(href ? { href } : {}) },
      h('b', null, title),
      h('div', { class: 'gd-pills' }, ...pills.map((p, i) => h('span', { class: 'gd-pill' + (i === 0 ? ' acc' : '') }, p))),
      h('div', { class: 'meta' }, desc),
      state);
  const tr = (...cells: string[]) => h('tr', null, ...cells.map((c) => h('td', null, c)));
  return [
    h('h2', null, L('② 选择翻译方案', '② Choose a setup')),
    h('div', { class: 'gd-card soft' }, h('h3', null, rec[0]), h('p', { class: 'muted', style: 'margin:0' }, rec[1])),
    env.autoEnabled.length ? h('p', { class: 'ok', style: 'margin:0' }, L(`已自动启用检测可用的服务：${env.autoEnabled.join('、')}`, `Detected and enabled automatically: ${env.autoEnabled.join(', ')}`)) : h('span'),
    h('div', { class: 'gd-grid' },
      card(L('浏览器内置翻译', 'Browser translator'), [L('零配置', 'Zero setup'), L('离线', 'Offline')], L('Chrome / Edge 自带的离线翻译，不用注册、不用密钥。质量一般，适合当高速档。', 'The offline translator built into Chrome / Edge. No sign-up, no key. Average quality — good as the fast tier.'), builtinState),
      card(L('本地大模型', 'Local LLM'), [L('离线', 'Offline'), L('私密', 'Private'), L('有显卡更好', 'Better with a GPU')], L('在自己电脑上跑腾讯开源的 Hy-MT2 翻译模型（1.13 GB）。下载两个文件、双击一个脚本，大约 10 分钟。', 'Runs Tencent’s open-source Hy-MT2 translation model (1.13 GB) on your own computer. Download two files and double-click a script — about 10 minutes.'),
        h('span', { class: 'st ' + (env.local ? 'ok' : 'muted') }, env.local ? L('✓ 已经在运行', '✓ Already running') : env.local === false ? L('还没部署或没启动 → 看部署教程', 'Not deployed or not running → see the setup guide') : L('当前后端没有本地模型服务', 'This backend has no local model service')), '#welcome/local'),
      card(L('云端服务', 'Cloud services'), [L('质量好', 'High quality'), L('要注册', 'Sign-up needed')], L('微软、小牛、DeepL 等机器翻译，或 Gemini、智谱、DeepSeek 等大模型。注册拿密钥，多数有免费额度。', 'Machine translation like Microsoft, NiuTrans and DeepL, or LLMs like Gemini, Zhipu and DeepSeek. Sign up for a key; most have a free quota.'),
        h('span', { class: 'st ' + (cloud.length ? 'ok' : 'muted') }, cloud.length ? L(`✓ 已配置 ${cloud.length} 家：${cloud.map((p) => p.name).join('、')}`, `✓ ${cloud.length} set up: ${cloud.map((p) => p.name).join(', ')}`) : L('还没有配置 → 选一家看教程', 'None yet → pick one and follow the guide')), '#welcome/api'),
    ),
    h('div', { class: 'gd-card' },
      h('h3', null, L('要不要部署本地模型？', 'Should you deploy a local model?')),
      h('table', { class: 'gd-table' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, L('本地模型', 'Local model')), h('th', null, L('云端服务', 'Cloud services')))),
        h('tbody', null,
          tr(L('速度', 'Speed'), L('有独立显卡时最快（一段约 0.1–0.2 秒）；只用 CPU 会慢', 'Fastest with a dedicated GPU (about 0.1–0.2 s per paragraph); slow on CPU only'), L('看网络，一般 0.3–1 秒', 'Depends on the network, usually 0.3–1 s')),
          tr(L('费用 / 额度', 'Cost / quota'), L('免费、不限量', 'Free, unlimited'), L('多数有免费额度，用完要等下个周期或付费', 'Most have a free quota; then wait for the next period or pay')),
          tr(L('隐私', 'Privacy'), L('内容不出电脑', 'Content never leaves your computer'), L('网页内容会发给服务商（银行等敏感网站默认不翻、不缓存）', 'Page content is sent to the provider (sensitive sites such as banks are not translated or cached by default)')),
          tr(L('质量', 'Quality'), L('日常网页够用；专业长句不如大模型', 'Good enough for everyday pages; weaker than LLMs on long technical sentences'), L('大模型最好，机器翻译次之', 'LLMs are best, machine translation next')),
          tr(L('准备', 'Requirements'), L('Windows；约 3 GB 硬盘；有独立显卡更好', 'Windows; about 3 GB of disk; a dedicated GPU helps'), L('注册账号；部分要信用卡或实名', 'An account; some need a credit card or real-name verification')),
        ),
      ),
      h('p', { class: 'muted', style: 'margin:10px 0 0;font-size:12.5px' }, L('两种可以一起用：综合模式下本地模型先出译文，大模型随后换成更好的译文；哪家出错或额度用完会自动换下一家。只想先试试：浏览器内置翻译加一家免费的云端服务就够了，以后随时可以回来部署本地模型。', 'You can use both: in combined mode the local model shows a translation first and an LLM then replaces it with a better one; if one fails or runs out of quota, the next takes over. Just want to try it? The browser translator plus one free cloud service is enough — you can deploy the local model any time later.')),
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* ③ 本地模型                                                          */
/* ------------------------------------------------------------------ */

type Build = 'nvidia' | 'nvidiaOld' | 'vulkan' | 'cpu';

function local(env: Env): HTMLElement[] {
  const vendor = env.gpu?.vendor ?? '';
  const pick: Build = /nvidia/.test(vendor) ? 'nvidia' : /amd|ati|intel/.test(vendor) ? 'vulkan' : 'cpu';
  const builds: [Build, string][] = [
    ['nvidia', L('NVIDIA 显卡（推荐，驱动较新）', 'NVIDIA GPU (recommended, recent driver)')],
    ['nvidiaOld', L('NVIDIA 显卡（驱动较旧时）', 'NVIDIA GPU (older driver)')],
    ['vulkan', L('AMD / Intel 显卡（Vulkan）', 'AMD / Intel GPU (Vulkan)')],
    ['cpu', L('没有独立显卡（CPU）', 'No dedicated GPU (CPU)')],
  ];
  const files = h('div');
  const showFiles = (k: Build) => {
    const list = LLAMA_BUILDS[k];
    files.replaceChildren(
      h('p', null, list.length > 1 ? L('要下载这两个文件（在发布页最下面的 Assets 里，点「Show all assets」展开找同名文件）：', 'Download these two files (under Assets at the bottom of the release page — click “Show all assets” and find the same names):') : L('要下载这个文件（在发布页最下面的 Assets 里，点「Show all assets」展开找同名文件）：', 'Download this file (under Assets at the bottom of the release page — click “Show all assets” and find the same name):')),
      h('ul', null, ...list.map((f) => h('li', null, h('code', null, f)))),
      k === 'nvidia' ? h('p', { class: 'muted' }, L('启动就报错、又不想更新显卡驱动时，换成「驱动较旧时」那一版。', 'If it fails to start and you don’t want to update the GPU driver, use the “older driver” build.')) : h('span'),
      k === 'cpu' ? h('p', { class: 'muted' }, L('启动时要加 -Cpu 参数，见第 3 步。', 'Start it with the -Cpu option, see step 3.')) : h('span'),
    );
  };
  const sel = h('select', { 'aria-label': L('选择显卡类型', 'Choose your GPU type') }) as HTMLSelectElement;
  for (const [k, label] of builds) sel.append(h('option', { value: k, selected: k === pick }, label));
  sel.addEventListener('change', () => showFiles(sel.value as Build));
  showFiles(pick);

  const status = h('span', { class: env.local ? 'ok' : 'muted' }, env.local ? L('✓ 本地模型已经在运行，并已启用', '✓ The local model is running and enabled') : L('还没有检测到本地模型', 'No local model detected yet'));
  const check = h('button', { class: 'btn primary', type: 'button' }, L('检测并启用', 'Detect and enable'));
  check.addEventListener('click', async () => {
    check.disabled = true;
    status.className = 'muted';
    status.textContent = L('正在检测…', 'Detecting…');
    const providers = await rpc('providers:list', undefined).catch(() => [] as ProviderInfo[]);
    const p = providers.find(isLocal);
    if (!p) {
      status.className = 'bad';
      status.textContent = L('当前后端没有本地模型服务', 'This backend has no local model service');
    } else {
      const r = await test(p.id);
      if (r.ok) {
        if (!p.enabled) await rpc('providers:save', { id: p.id, enabled: true, config: p.config }).catch(() => {});
        envP = null;
        status.className = 'ok';
        status.textContent = L(`✓ 连上了${r.latencyMs ? `（${r.latencyMs} ms）` : ''}，已启用本地模型`, `✓ Connected${r.latencyMs ? ` (${r.latencyMs} ms)` : ''}, local model enabled`);
      } else {
        status.className = 'bad';
        status.textContent = L(`✕ 没连上${r.message ? '：' + r.message : ''}。先完成第 3 步，看到「本地模型已就绪」后再点一次。`, `✕ Could not connect${r.message ? ': ' + r.message : ''}. Finish step 3 first and click again once it says the local model is ready (本地模型已就绪).`);
      }
    }
    check.disabled = false;
  });

  const rich = (t: string) => h('div', null, renderRich(t));
  const step = (title: string, ...content: Node[]) => h('li', null, h('div', null, h('b', { class: 't' }, title), ...content));
  const dir = `llama-${LLAMA_BUILDS.version}`;
  return [
    h('h2', null, L('③ 部署本地模型（Windows）', '③ Deploy the local model (Windows)')),
    h('div', { class: 'gd-card' },
      h('h3', null, L('推荐：独立安装包', 'Recommended: standalone installer')),
      h('p', null, L('取得与扩展一起发布的 yi-local-setup-0.2.17-windows-x64.zip，解压到一个固定文件夹，双击里面的 setup.cmd，按提示输入扩展 ID。安装器会下载并校验模型和运行程序，不需要 Node.js 或项目源码。', 'Get yi-local-setup-0.2.17-windows-x64.zip distributed with this extension, extract it into a permanent folder, run setup.cmd, and enter the extension ID when prompted. It downloads and verifies the model and runtime; Node.js and the source project are not required.')),
      h('p', { class: 'muted' }, L('下面保留源码方式的手动部署步骤；已用独立安装包完成安装的话，可以直接检测并启用。', 'The manual source-project instructions remain below. If the standalone installer has completed, continue with Detect and enable.')),
    ),
    h('div', { class: 'gd-card' },
      h('h3', null, L('先看看电脑够不够', 'Check your computer first')),
      h('table', { class: 'gd-table' },
        h('tbody', null,
          h('tr', null, h('td', null, L('系统', 'System')), h('td', null, L('Windows 10 / 11（64 位）。启动脚本只支持 Windows；macOS / Linux 见最下面的常见问题。', 'Windows 10 / 11 (64-bit). The start scripts are Windows-only; for macOS / Linux see the FAQ at the bottom.'))),
          h('tr', null, h('td', null, L('显卡', 'GPU')), h('td', null, L(`NVIDIA 显卡最理想（模型实际只占约 1.4 GB 显存）；AMD / Intel 用 Vulkan 版；没有也能用 CPU，慢一些。${env.gpu ? `这台电脑：${env.gpu.label}。` : ''}`, `An NVIDIA GPU is ideal (the model only uses about 1.4 GB of VRAM); AMD / Intel use the Vulkan build; without a GPU the CPU works too, just slower.${env.gpu ? ` This computer: ${env.gpu.label}.` : ''}`))),
          h('tr', null, h('td', null, L('硬盘', 'Disk')), h('td', null, L('至少留 3 GB：模型 1.13 GB，程序 0.1–0.8 GB（NVIDIA 版带 CUDA 运行库，最大）。', 'At least 3 GB free: model 1.13 GB, program 0.1–0.8 GB (the NVIDIA build with CUDA runtime is the largest).'))),
          h('tr', null, h('td', null, L('内存', 'Memory')), h('td', null, L(`8 GB 以上。${env.memoryGb ? `（浏览器报告这台电脑至少有 ${env.memoryGb} GB）` : ''}`, `8 GB or more.${env.memoryGb ? ` (the browser reports at least ${env.memoryGb} GB on this computer)` : ''}`))),
        ),
      ),
    ),
    h('div', { class: 'gd-card' },
      h('h3', null, L('放在哪里', 'Where to put the files')),
      rich(L('所有文件都放在**项目文件夹**里——就是你下载 / 解压这个扩展的那个文件夹（例如 `D:\\YiProject`，里面有 `gateway`、`.output` 等文件夹）。启动脚本固定到这里找模型和程序，不用改任何配置。', 'Everything goes into the **project folder** — the folder you downloaded / unpacked this extension into (e.g. `D:\\YiProject`, containing `gateway`, `.output` and so on). The start scripts always look for the model and program there; nothing to configure.')),
      h('div', { class: 'gd-tree' }, L(`项目文件夹（例如 D:\\YiProject）
├─ .output\\chrome-mv3\\        ← 扩展本身（浏览器「加载已解压的扩展」选的就是它）
├─ gateway\\scripts\\           ← 启动、停止、开机自启脚本（已经有了）
└─ runtime\\                   ← 没有就新建
   ├─ models\\
   │  └─ ${MODEL_FILE.name}
   └─ ${dir}\\
      ├─ llama-server.exe
      └─ ggml-*.dll、llama.dll 等（压缩包里的全部文件）`, `Project folder (e.g. D:\\YiProject)
├─ .output\\chrome-mv3\\        ← the extension itself (what you chose in “Load unpacked”)
├─ gateway\\scripts\\           ← start / stop / autostart scripts (already there)
└─ runtime\\                   ← create it if missing
   ├─ models\\
   │  └─ ${MODEL_FILE.name}
   └─ ${dir}\\
      ├─ llama-server.exe
      └─ ggml-*.dll, llama.dll … (everything in the zip)`)),
      h('ul', { class: 'gd-tips' },
        h('li', null, L('放在空间够的本地硬盘上（固态硬盘加载更快）；不要放在 OneDrive / 网盘同步的文件夹里，同步会锁住文件。', 'Use a local drive with enough space (an SSD loads faster); not a OneDrive / cloud-synced folder — syncing locks the files.')),
        h('li', null, L('路径尽量短、最好不带空格，例如 D:\\YiProject；不要放进「下载」这种会被清理的文件夹。', 'Keep the path short, ideally without spaces, e.g. D:\\YiProject; avoid folders that get cleaned up, like Downloads.')),
        h('li', null, L('以后要挪项目文件夹：先在**原位置**双击 uninstall-helper.cmd 卸载本机助手，再挪文件夹，然后在 chrome://extensions 里重新加载扩展，最后在新位置双击 install-helper.cmd（扩展 ID 跟路径有关，助手只认装它的那个位置）。', 'To move the project folder later: first double-click uninstall-helper.cmd in the **old location**, then move the folder, reload the extension at chrome://extensions, and finally double-click install-helper.cmd in the new location (the extension ID depends on the path, and the helper only trusts the location it was installed from).')),
      ),
    ),
    h('div', { class: 'gd-card' },
      h('h3', null, L('一步一步来（大约 10 分钟）', 'Step by step (about 10 minutes)')),
      h('ol', { class: 'gd-st' },
        step(L('下载模型文件', 'Download the model file'),
          rich(L(`打开 [腾讯官方模型页面](${MODEL_FILE.page})，点 **Files and versions**，下载 \`${MODEL_FILE.name}\`（${MODEL_FILE.size}），也可以直接点 [下载链接](${MODEL_FILE.url})。在中国大陆下载慢或打不开时用镜像：[hf-mirror 下载链接](${MODEL_FILE.mirror})。`, `Open [Tencent’s official model page](${MODEL_FILE.page}), click **Files and versions** and download \`${MODEL_FILE.name}\` (${MODEL_FILE.size}), or use the [direct download link](${MODEL_FILE.url}). If it is slow or blocked in mainland China, use the mirror: [hf-mirror download link](${MODEL_FILE.mirror}).`)),
          rich(L('下载好后放进 `项目文件夹\\runtime\\models\\`（文件名不要改）。想核对文件是否完整：在文件所在的文件夹里按住 Shift 右键 →「在终端中打开」，运行 `Get-FileHash ', 'Put it into `project folder\\runtime\\models\\` (keep the file name). To check the file: in its folder, Shift + right-click → “Open in Terminal” and run `Get-FileHash ') + MODEL_FILE.name + L('`，结果应为：', '`; the result should be:')),
          h('div', { class: 'gd-tree', style: 'white-space:normal;overflow-wrap:anywhere' }, MODEL_FILE.sha256.toUpperCase())),
        step(L('下载 llama.cpp 推理程序', 'Download the llama.cpp inference program'),
          rich(L(`打开 [llama.cpp ${LLAMA_BUILDS.version} 发布页](${LLAMA_BUILDS.release})，按你的显卡选（已经按检测到的显卡选好，不对可以改）：`, `Open the [llama.cpp ${LLAMA_BUILDS.version} release page](${LLAMA_BUILDS.release}) and pick the build for your GPU (pre-selected from the detected GPU; change it if wrong):`)),
          h('div', { class: 'gd-form', style: 'margin:6px 0' }, sel),
          files,
          rich(L(`把压缩包里的**所有文件**解压到 \`项目文件夹\\runtime\\${dir}\\\`（NVIDIA 版的两个压缩包解压到同一个文件夹）。解压完打开这个文件夹应该直接看到 \`llama-server.exe\`，不要多套一层文件夹。`, `Extract **all files** from the zip into \`project folder\\runtime\\${dir}\\\` (both NVIDIA zips into the same folder). Afterwards you should see \`llama-server.exe\` directly in that folder — no extra nested folder.`))),
        step(L('启动本地模型', 'Start the local model'),
          rich(L('双击 `项目文件夹\\gateway\\scripts\\start-local.cmd`，等窗口里出现「**本地模型已就绪**」后按任意键关掉窗口（模型在后台继续运行）。第一次启动要初始化显卡，可能要等半分钟。', 'Double-click `project folder\\gateway\\scripts\\start-local.cmd` and wait until the window says “**本地模型已就绪**” (local model ready), then press any key to close it (the model keeps running in the background). The first start initializes the GPU and may take half a minute.')),
          rich(L('只用 CPU：在 `gateway\\scripts` 文件夹的地址栏输入 `cmd` 回车，运行 `start-local.cmd -Cpu`。启动成功后这些参数会被记住，以后双击、点「立即启动」和开机自启都沿用，不用每次再加。', 'CPU only: type `cmd` into the address bar of the `gateway\\scripts` folder, press Enter and run `start-local.cmd -Cpu`. Once it starts successfully the options are remembered — later double-clicks, “Start now” and autostart reuse them.')),
          rich(L('想确认一下：浏览器打开 `http://127.0.0.1:8081/health`，显示 `{"status":"ok"}` 就对了。不用的时候双击 `stop-local.cmd` 停止。', 'To double-check: open `http://127.0.0.1:8081/health` in the browser; `{"status":"ok"}` means it works. Double-click `stop-local.cmd` to stop it when not needed.'))),
        step(L('在扩展里启用', 'Enable it in the extension'), h('div', { class: 'gd-inline' }, check, status)),
        step(L('开机自动启动（推荐）', 'Start automatically at login (recommended)'),
          rich(L('双击一次 `项目文件夹\\gateway\\scripts\\install-helper.cmd`，安装「本机助手」（只装一次，不需要管理员权限；Chrome 和 Edge 都能用）。装好后**刷新本页**，下面的开关就能用了：打开后每次登录 Windows 都会在后台自动启动模型；闲置 10 分钟自动卸载、释放显存，下次翻译时自动加载。', 'Double-click `project folder\\gateway\\scripts\\install-helper.cmd` once to install the local helper (only once, no admin rights needed; works for Chrome and Edge). Then **reload this page** and the switch below works: once on, the model starts in the background every time you log in to Windows; it unloads after 10 idle minutes to free VRAM and loads again on the next translation.')),
          rich(L('不想装助手也可以：双击 `enable-autostart.cmd` 加到开机启动，`disable-autostart.cmd` 取消。', 'Without the helper: double-click `enable-autostart.cmd` to add it to startup, `disable-autostart.cmd` to remove it.')),
          localModelCard()),
      ),
    ),
    h('div', { class: 'gd-card' },
      h('h3', null, L('常见问题', 'FAQ')),
      h('ul', { class: 'gd-tips' },
        ...[
          L('**提示「端口 8081 已被其他服务占用」**：有别的程序在用这个端口，脚本不会去动它。关掉那个程序；或者换端口：运行 `start-local.cmd -Port 8082`，再到「翻译服务 → 本地模型」把接口地址改成 `http://127.0.0.1:8082`。', '**“Port 8081 is already in use”**: another program uses the port and the script leaves it alone. Close that program, or switch ports: run `start-local.cmd -Port 8082`, then change the endpoint under Services → local model to `http://127.0.0.1:8082`.'),
          L('**NVIDIA 版一启动就退出**：多半是显卡驱动太旧。更新驱动，或者换成「驱动较旧时」那一版。', '**The NVIDIA build exits right away**: usually the GPU driver is too old. Update it, or use the “older driver” build.'),
          L('**一直等不到「已就绪」**：双击 `stop-local.cmd` 停掉再启动一次；还不行就看 `项目文件夹\\runtime\\logs\\` 里最新的 `.stderr.log`，常见原因是文件放错位置（找不到模型 / 找不到 llama-server.exe）。', '**It never says ready**: double-click `stop-local.cmd` and start again; if it still fails, read the newest `.stderr.log` in `project folder\\runtime\\logs\\` — usually a file is in the wrong place (model or llama-server.exe not found).'),
          L('**显存不够**：关掉游戏、视频剪辑这类占显存的程序，或者用 CPU 版。', '**Not enough VRAM**: close games, video editors and other VRAM-heavy programs, or use the CPU build.'),
          L('**开机自启开关是灰的**：还没运行 `install-helper.cmd`，或者运行后没刷新本页。挪过项目文件夹的话：回到原位置运行 `uninstall-helper.cmd`（原位置已经没有了就把文件夹先挪回去），再在新位置运行 `install-helper.cmd`。', '**The autostart switch is greyed out**: install-helper.cmd has not been run, or this page was not reloaded afterwards. If you moved the project folder: run `uninstall-helper.cmd` from the old location (move the folder back first if needed), then `install-helper.cmd` in the new one.'),
          L('**macOS / Linux**：到同一个发布页下载对应系统的版本，自己运行 `llama-server -m 模型文件路径 --host 127.0.0.1 --port 8081 -ngl 99`，再点上面的「检测并启用」。开机自启暂时只有 Windows 版。', '**macOS / Linux**: download the build for your system from the same release page, run `llama-server -m path-to-model --host 127.0.0.1 --port 8081 -ngl 99` yourself, then click “Detect and enable” above. Autostart is Windows-only for now.'),
        ].map((t) => h('li', null, renderRich(t))),
      ),
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* ④ 云端服务                                                          */
/* ------------------------------------------------------------------ */

const KIND_LABEL: Record<ApiGuide['kind'], string> = { mt: L('机器翻译', 'Machine translation'), llm: L('大模型', 'LLM'), self: L('自己部署', 'Self-hosted') };

function presetProvider(providers: ProviderInfo[], url: string) {
  return providers.find((p) => p.custom && (p.options?.endpoint === url || p.config.url === url));
}

function api(env: Env, id?: string): HTMLElement[] {
  const g = apiGuides().find((x) => x.id === id);
  if (g) return guidePage(g);
  const configured = (g: ApiGuide) =>
    g.providerId ? !!builtinFor(env.providers, g.providerId)?.configured
      : g.preset ? !!presetProvider(env.providers, g.preset.url)?.configured
        : env.providers.some((p) => p.template === 'libretranslate' && p.configured);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  const inChina = /^Asia\/(Shanghai|Chongqing|Harbin|Urumqi|Kashgar)$/.test(tz) || navigator.language === 'zh-CN';
  const recIds = inChina ? ['niutrans', 'microsoft', 'zhipu'] : ['microsoft', 'gemini', 'deepl'];
  const rows = apiGuides().map((g) => {
    const go = () => (location.hash = `#welcome/api/${g.id}`);
    const tr = h('tr', { class: 'pick', tabindex: '0', role: 'link', 'aria-label': L(`${g.name} 教程`, `${g.name} guide`) },
      h('td', null, h('b', null, g.name), configured(g) ? h('span', { class: 'ok' }, L(' ✓ 已配置', ' ✓ set up')) : null,
        recIds.includes(g.id) ? h('span', { class: 'gd-pill acc', style: 'margin-left:6px' }, L('推荐', 'Recommended')) : null,
        h('div', { class: 'hint' }, g.tagline)),
      h('td', { class: 'nw' }, KIND_LABEL[g.kind]),
      h('td', null, g.free),
      h('td', null, g.needs),
      h('td', null, g.region));
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
    return tr;
  });
  return [
    h('h2', null, L('④ 接入云端服务', '④ Connect cloud services')),
    h('div', { class: 'gd-card soft' },
      h('h3', null, inChina ? L('在中国大陆：推荐小牛（每天 20 万字符）+ 微软（每月 200 万）当高速档，智谱免费模型当精确档', 'In mainland China: NiuTrans (200,000 chars a day) + Microsoft (2 million a month) as the fast tier, a free Zhipu model as the accurate tier') : L('推荐：微软（每月 200 万字符）当高速档，Gemini 当精确档', 'Recommended: Microsoft (2 million chars a month) as the fast tier, Gemini as the accurate tier')),
      h('p', { class: 'muted', style: 'margin:0' }, L('机器翻译快、额度大，适合整页；大模型更懂上下文，适合精确档。多配一两家最稳：一家额度用完或出错，扩展会自动换下一家。点下面任意一行看详细教程——每一步在哪个页面点什么都写清楚了，教程页里可以直接填密钥测试。', 'Machine translation is fast with big quotas — good for whole pages; LLMs understand context better — good for the accurate tier. One or two extra services make it robust: when one runs out or fails, the extension switches to the next. Click any row for a detailed guide — every step says which page to open and what to click, and you can enter and test the key right there.')),
    ),
    h('div', { class: 'gd-card', style: 'padding:6px 8px;overflow-x:auto' },
      h('table', { class: 'gd-table api' },
        h('thead', null, h('tr', null, h('th', null, L('服务', 'Service')), h('th', { class: 'nw' }, L('类型', 'Type')), h('th', null, L('免费额度', 'Free quota')), h('th', null, L('需要准备', 'You need')), h('th', null, L('地区', 'Region')))),
        h('tbody', null, ...rows)),
    ),
    h('p', { class: 'muted', style: 'margin:0;font-size:12.5px' }, L('额度和政策以各家官网为准（这里核实于 2026 年 11 月）。腾讯云机器翻译从 2026 年 10 月起不再给新用户免费额度，所以没有列出；老用户可以在「翻译服务」里直接填。其他 OpenAI 兼容的服务（Kimi、通义千问、OpenRouter、Ollama 等）在「翻译服务 → 添加服务」里选。', 'Quotas and policies are as published by each provider (checked November 2026). Tencent Cloud MT stopped giving new users free quota in October 2026, so it is not listed; existing users can still fill it in under Services. Other OpenAI-compatible services (Kimi, Qwen, OpenRouter, Ollama…) are under Services → Add service.')),
  ];
}

function guidePage(g: ApiGuide): HTMLElement[] {
  const steps = h('ol', { class: 'gd-st' }, ...g.steps.map((st) => h('li', null, h('div', null, h('b', { class: 't' }, st.title), renderRich(st.body)))));
  const form = h('div', { class: 'gd-form' }, h('span', { class: 'muted' }, L('正在读取…', 'Loading…')));
  void fillForm(g, form);
  return [
    h('div', null, h('a', { href: '#welcome/api' }, L('← 返回服务列表', '← Back to all services'))),
    h('h2', null, g.name),
    h('div', { class: 'gd-pills' }, h('span', { class: 'gd-pill acc' }, KIND_LABEL[g.kind]), h('span', { class: 'gd-pill' }, L('免费：', 'Free: ') + g.free), h('span', { class: 'gd-pill' }, g.region)),
    h('p', { class: 'muted', style: 'margin:0' }, L(`${g.tagline}需要准备：${g.needs}。适合：${g.bestFor}。`, `${g.tagline} You need: ${g.needs}. Best for: ${g.bestFor}.`)),
    h('div', { class: 'gd-card' }, h('h3', null, L('详细步骤', 'Step by step')), steps),
    h('div', { class: 'gd-card soft', id: 'gd-form' }, h('h3', null, g.providerId ? L('在这里填密钥', 'Enter your key here') : g.preset ? L('在这里填密钥，一键添加', 'Enter your key here — added in one click') : L('在这里添加', 'Add it here')), form),
    g.tips?.length ? h('div', { class: 'gd-card' }, h('h3', null, L('注意事项', 'Good to know')), h('ul', { class: 'gd-tips' }, ...g.tips.map((t) => h('li', null, renderRich(t))))) : h('span'),
    h('div', { class: 'gd-links' }, ...g.links.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.label + ' ↗'))),
  ];
}

/** 教程页里的表单：内置服务直接填它的账号字段；大模型预设新建一个 OpenAI 兼容服务；LibreTranslate 用模板添加。 */
async function fillForm(g: ApiGuide, form: HTMLElement): Promise<void> {
  const msg = h('span', { class: 'muted', role: 'status' });
  const say = (cls: string, t: string) => {
    msg.className = cls;
    msg.textContent = t;
  };
  const check = async (id: string) => {
    say('muted', L('已保存，正在测试…', 'Saved, testing…'));
    const r = await test(id);
    envP = null;
    if (r.ok) say('ok', L(`✓ 可以用了${r.latencyMs ? `（延迟 ${r.latencyMs} ms）` : ''}，已启用。`, `✓ Works${r.latencyMs ? ` (latency ${r.latencyMs} ms)` : ''} — enabled.`));
    else say('bad', L('✕ 还不能用：', '✕ Not working yet: ') + (r.message ?? L('未知原因', 'unknown reason')) + L('。', '. ') + nextStep(r.code));
  };
  const fail = (e: unknown) => say('bad', L('保存失败：', 'Save failed: ') + String((e as Error).message));
  const providers = await rpc('providers:list', undefined).catch(() => [] as ProviderInfo[]);
  form.replaceChildren();

  if (g.providerId) {
    const p = builtinFor(providers, g.providerId);
    if (!p) {
      form.append(h('span', { class: 'bad' }, L('当前后端没有这个服务。', 'This backend does not have this service.')));
      return;
    }
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    for (const f of p.auth) {
      let input: HTMLInputElement | HTMLSelectElement;
      const saved = p.config[f.key] ?? '';
      if (f.type === 'select') {
        input = h('select') as HTMLSelectElement;
        for (const o of f.options ?? []) input.append(h('option', { value: o.value, selected: saved === o.value }, o.label));
      } else {
        input = h('input', { type: f.secret ? 'password' : 'text', placeholder: f.secret && saved ? L('已保存，不改就留空', 'Saved — leave empty to keep it') : f.placeholder ?? '', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
        if (!f.secret) input.value = saved;
      }
      inputs.set(f.key, input);
      form.append(h('label', null, f.label + (f.required ? L('（必填）', ' (required)') : L('（可选）', ' (optional)')), input));
    }
    const save = h('button', { class: 'btn primary', type: 'button' }, L('保存并测试', 'Save and test'));
    save.addEventListener('click', async () => {
      // 从已保存的配置开始：密钥字段返回的是 ••••，原样传回去后端就保留原密钥
      const config: Record<string, string> = { ...p.config };
      for (const f of p.auth) {
        const v = inputs.get(f.key)!.value.trim();
        if (!f.secret || v) config[f.key] = v;
      }
      const missing = p.auth.find((f) => f.required && !config[f.key]);
      if (missing) return say('bad', L(`先填「${missing.label}」`, `Fill in “${missing.label}” first`));
      say('muted', L('正在保存…', 'Saving…'));
      save.disabled = true;
      try {
        await rpc('providers:save', { id: p.id, enabled: true, config });
        await check(p.id);
      } catch (e) {
        fail(e);
      }
      save.disabled = false;
    });
    form.append(h('div', { class: 'gd-inline' }, save, msg));
    return;
  }

  if (g.preset) {
    const preset = g.preset;
    let current = presetProvider(providers, preset.url);
    const key = h('input', { type: 'password', placeholder: current?.configured ? L('已保存，不改就留空', 'Saved — leave empty to keep it') : L('粘贴 API Key', 'Paste the API key'), autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
    const model = h('input', { type: 'text', spellcheck: 'false', list: `gd-models-${g.id}` }) as HTMLInputElement;
    model.value = current?.options?.model || current?.config.model || preset.model;
    const dl = h('datalist', { id: `gd-models-${g.id}` });
    const add = h('button', { class: 'btn primary', type: 'button' }, current ? L('保存并测试', 'Save and test') : L('添加并测试', 'Add and test'));
    const query = h('button', { class: 'btn', type: 'button' }, L('查询可用模型', 'List available models'));
    form.append(
      h('label', null, L('API Key（必填）', 'API key (required)'), key),
      h('label', null, L(`模型名称（${preset.modelHint}）`, `Model name (${preset.modelHint})`), model, dl),
      h('div', { class: 'muted', style: 'font-size:12.5px' }, L('接口地址（已填好）：', 'Endpoint (pre-filled): '), h('code', null, preset.url)),
      h('div', { class: 'gd-inline' }, add, query, msg),
    );
    /** 没有就新建一个 OpenAI 兼容服务。 */
    const ensure = async () => (current ??= await rpc('providers:add', { template: 'openai-compatible', name: g.name }));
    const saveIt = async (enabled: boolean) => {
      const p = await ensure();
      const config: Record<string, string> = { ...p.config, url: preset.url, model: model.value.trim() };
      if (key.value.trim()) config.key = key.value.trim();
      const options = p.editable?.includes('endpoint') ? { ...(p.options ?? {}), endpoint: preset.url, model: model.value.trim() } : undefined;
      await rpc('providers:save', { id: p.id, enabled, config, ...(options ? { options } : {}), name: p.name });
      // 刷新本地这条服务的信息：不然 configured 还是添加时的 false，再改模型名保存会被要求重填密钥
      current = (await rpc('providers:list', undefined).catch(() => [] as ProviderInfo[])).find((x) => x.id === p.id) ?? current;
      return p.id;
    };
    add.addEventListener('click', async () => {
      if (!current?.configured && !key.value.trim()) return say('bad', L('先粘贴 API Key', 'Paste the API key first'));
      if (!model.value.trim()) return say('bad', L('先填模型名称', 'Fill in the model name first'));
      say('muted', L('正在保存…', 'Saving…'));
      add.disabled = true;
      try {
        await check(await saveIt(true));
        add.textContent = L('保存并测试', 'Save and test');
        key.value = '';
        key.placeholder = L('已保存，不改就留空', 'Saved — leave empty to keep it');
      } catch (e) {
        fail(e);
      }
      add.disabled = false;
    });
    query.addEventListener('click', async () => {
      say('muted', L('正在查询…', 'Querying…'));
      try {
        const p = await ensure();
        const list = await rpc('providers:models', { id: p.id, endpoint: preset.url, config: key.value.trim() ? { key: key.value.trim(), url: preset.url } : undefined });
        dl.replaceChildren(...list.map((m) => h('option', { value: m })));
        say(list.length ? 'ok' : 'muted', list.length ? L(`查到 ${list.length} 个模型：点「模型名称」输入框可以直接选`, `Found ${list.length} models — pick one in the model name box`) : L('没有查到模型（先填对密钥再查）', 'No models found (enter a valid key first)'));
      } catch (e) {
        say('bad', L('查询失败：', 'Query failed: ') + String((e as Error).message));
      }
    });
    return;
  }

  // 自己部署的 LibreTranslate：用模板添加
  const templates = await rpc('providers:templates', undefined).catch(() => [] as string[]);
  if (!templates.includes('libretranslate')) {
    form.append(h('span', { class: 'muted' }, L('当前后端还不支持添加 LibreTranslate，更新扩展后再试。', 'This backend cannot add LibreTranslate yet; update the extension and try again.')));
    return;
  }
  let current = providers.find((p) => p.template === 'libretranslate');
  const url = h('input', { type: 'text', spellcheck: 'false' }) as HTMLInputElement;
  url.value = current?.options?.endpoint || current?.config.url || 'http://127.0.0.1:5000';
  const key = h('input', { type: 'password', placeholder: L('自己部署的一般留空', 'Usually empty for self-hosted'), autocomplete: 'off' }) as HTMLInputElement;
  const add = h('button', { class: 'btn primary', type: 'button' }, current ? L('保存并测试', 'Save and test') : L('添加并测试', 'Add and test'));
  form.append(h('label', null, L('LibreTranslate 地址', 'LibreTranslate address'), url), h('label', null, L('API key（可选）', 'API key (optional)'), key), h('div', { class: 'gd-inline' }, add, msg));
  add.addEventListener('click', async () => {
    if (!/^https?:\/\/\S+$/.test(url.value.trim())) return say('bad', L('地址要以 http:// 或 https:// 开头', 'The address must start with http:// or https://'));
    say('muted', L('正在保存…', 'Saving…'));
    add.disabled = true;
    try {
      const p = (current ??= await rpc('providers:add', { template: 'libretranslate', name: 'LibreTranslate' }));
      const config: Record<string, string> = { ...p.config, url: url.value.trim() };
      if (key.value.trim()) config.key = key.value.trim();
      const options = p.editable?.includes('endpoint') ? { ...(p.options ?? {}), endpoint: url.value.trim() } : undefined;
      await rpc('providers:save', { id: p.id, enabled: true, config, ...(options ? { options } : {}), name: p.name });
      current = (await rpc('providers:list', undefined).catch(() => [] as ProviderInfo[])).find((x) => x.id === p.id) ?? current;
      await check(p.id);
      add.textContent = L('保存并测试', 'Save and test');
    } catch (e) {
      fail(e);
    }
    add.disabled = false;
  });
}

/* ------------------------------------------------------------------ */
/* ⑤ 试译并完成                                                        */
/* ------------------------------------------------------------------ */

async function done(s: UiSettings): Promise<HTMLElement[]> {
  const providers = await rpc('providers:list', undefined).catch(() => [] as ProviderInfo[]);
  const ready = providers.filter((p) => p.enabled && p.configured && p.official);
  const input = h('textarea', { spellcheck: 'false', 'aria-label': L('试译的文字', 'Text to try') }) as HTMLTextAreaElement;
  input.value = 'Local-first translation keeps your reading fast and private.';
  const out = h('div', { class: 'out', role: 'status' }, h('span', { class: 'muted' }, L('点「试译」看看效果', 'Click “Try” to see the result')));
  const tryBtn = h('button', { class: 'btn primary', type: 'button' }, L('试译', 'Try'));
  const client = new TranslateClient();
  const run = () => {
    const text = input.value.trim();
    if (!text) return;
    out.replaceChildren(h('span', { class: 'muted' }, L('翻译中…', 'Translating…')));
    delete out.dataset.stage;
    client.send(
      {
        jobId: uid('wz'),
        sourceLang: s.sourceLang || 'auto',
        targetLang: s.targetLang,
        mode: s.mode,
        priority: 0,
        context: { url: location.href },
        segments: [{ id: 'try', text, kind: 'selection' }],
        noCache: true,
      },
      {
        onResult: (_id, t, stage, provider) => {
          out.dataset.stage = stage;
          out.replaceChildren(t.replace(/<\/?[gx]\d+\/?>/g, ''), h('span', { class: 'by' }, L(`${stage === 'fast' ? '快速' : '最终'}译文 · ${provider}`, `${stage === 'fast' ? 'Fast' : 'Final'} translation · ${provider}`)));
        },
        onError: (_id, stage, err) => {
          if (stage === 'fast' && s.mode === 'combined') return;
          out.replaceChildren(h('span', { class: 'bad' }, L(`翻译失败：${err.message}`, `Translation failed: ${err.message}`)));
        },
      },
    );
  };
  tryBtn.addEventListener('click', run);
  // 不自动试译：浏览器内置翻译第一次用某个语言时会弹出下载语言包的页面，要用户自己点了再弹
  const finish = h('button', { class: 'btn primary', type: 'button' }, L('完成，开始使用', 'Done — start using it'));
  finish.addEventListener('click', async () => {
    await saveUiSettings({ onboarded: true });
    location.hash = '#general';
  });
  return [
    h('h2', null, L('⑤ 试一下', '⑤ Try it')),
    h('div', { class: 'gd-card' },
      h('h3', null, ready.length ? L(`已启用的服务（${ready.length} 家）`, `Enabled services (${ready.length})`) : L('还没有可以用的服务', 'Nothing is ready yet')),
      ready.length
        ? h('div', { class: 'gd-pills' }, ...ready.map((p) => {
          // 启用了不代表连得上：逐个测一下，标出能用的和不能用的
          const pill = h('span', { class: 'gd-pill', title: L('正在检测…', 'Checking…') }, p.name, ' …');
          void test(p.id).then((r) => {
            pill.lastChild!.textContent = r.ok ? ' ✓' : ' ✕';
            pill.classList.toggle('acc', r.ok);
            pill.title = r.ok ? L('可以用', 'Works') + (r.latencyMs ? ` · ${r.latencyMs} ms` : '') : (r.message ?? '') + ' ' + nextStep(r.code);
          });
          return pill;
        }))
        : h('p', { class: 'bad', style: 'margin:0' }, L('至少配一家：浏览器内置翻译（② 选择方案）、本地模型（③）或者任意一家云端服务（④）。', 'Set up at least one: the browser translator (② Choose a setup), the local model (③) or any cloud service (④).')),
    ),
    h('div', { class: 'gd-card try' }, input, h('div', { style: 'margin-top:8px' }, tryBtn), out),
    h('div', { class: 'gd-card soft' },
      h('h3', null, L('开始用吧', 'Off you go')),
      h('ul', { class: 'gd-tips' },
        h('li', null, L('打开任何外文网页，点右下角的圆球或按 Alt+A。圆球转圈表示正在翻译，带小对勾表示已翻译，再点一下还原。', 'Open any foreign-language page and click the ball in the bottom-right corner or press Alt+A. A spinning ring means translating, a small check means translated; click again to restore.')),
        h('li', null, L('选中文字后点旁边的小圆点看译文；小窗可以固定，可以同时固定好几个，顶部能快速换原文 / 目标语言。', 'Select text and click the small dot next to it for the translation; popups can be pinned — several at once — and the top bar switches source / target language.')),
        h('li', null, L('在网页输入框里写好中文，按 Alt+T（或点输入框角上的小圆球）翻成外语再发出去；不满意可以撤销。', 'Write in your own language in a page input box, press Alt+T (or click the small ball in its corner) to translate it before sending; you can undo it.')),
        h('li', null, L('以后想换服务、看额度：设置页的「翻译服务」「服务状态」。随时可以从左侧「新手指引」回到这里。', 'To change services or check quotas later: Services and Status in the settings. Come back here any time via “Get started” on the left.')),
      ),
      h('div', { class: 'gd-nav', style: 'margin-top:14px' }, h('a', { class: 'btn', href: '#welcome/api' }, L('上一步', 'Back')), h('span', { class: 'grow' }), finish),
    ),
  ];
}
