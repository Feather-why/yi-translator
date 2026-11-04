/**
 * 「翻译服务」页：左边是服务列表（按高速档 / 精确档 / 已停用分组，带实时健康状态），
 * 右边是选中服务的详细设置：账号、接口地址与模型、调度参数、额度、提示词。
 * 还可以添加自定义服务（OpenAI 兼容接口、另一台 llama-server、另一个远程节点）。
 *
 * 高级设置需要后端支持协议 v2（ProviderInfo.editable）；后端还不支持时只显示账号字段。
 */
import {
  PORT_STATUS,
  type Mode,
  type ProviderInfo,
  type ProviderKind,
  type ProviderOptions,
  type ProviderStatus,
  type ProviderTemplate,
  type ExtraProviderTemplate,
  type QuotaInfo,
  type StatusServerMsg,
} from '../../shared/protocol';
import { rpc } from '../../shared/rpc';
import { h } from '../ui/host';
import { apiGuides } from './guides';
import { L } from '../i18n';
import { wan } from '../ui/palette';
import { builtinPackCard, builtinTestPair, PACK_CSS } from './builtin-pack';
import { loadUiSettings } from '../../shared/settings';

const CSS = `
.pv-layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 18px; align-items: start; }
@media (max-width: 900px) { .pv-layout { grid-template-columns: 1fr; } .pv-list { position: static !important; } }
/* 调度板：上面两条「档」，下面是服务库；从库里拖进档里，或者点卡片上的「高速 / 精确」 */
.pv-board { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 4px; }
.pv-hint { font-size: 11.5px; color: var(--muted); padding: 4px 8px 0; line-height: 1.5; }
.lane { border: 1.5px dashed var(--line); border-radius: 12px; padding: 6px; min-height: 52px; transition: border-color .12s, background .12s; }
.lane.has { border-style: solid; }
.lane.drop, .lib.drop { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 7%, transparent); }
.lane-h { display: flex; align-items: baseline; gap: 6px; padding: 2px 6px 6px; }
.lane-h b { font-size: 12.5px; }
.lane-h span { font-size: 11px; color: var(--muted); }
.lane-empty { font-size: 12px; color: var(--muted); padding: 8px 6px 10px; text-align: center; }
.chip-row { display: flex; align-items: center; gap: 2px; border-radius: 9px; background: var(--bg); border: 1px solid var(--line); margin: 3px 0; }
.chip-row[aria-selected="true"] { box-shadow: inset 3px 0 0 var(--accent); }
.chip-row.dragging, .lib-card.dragging { opacity: .45; }
.chip-row .pv-item, .lib-card .pv-item { width: auto; flex: 1; min-width: 0; }
.chip-row .pv-item { padding: 6px 4px 6px 6px; cursor: grab; gap: 7px; }
/* 「优先」平时藏起来（置顶了的一直显示），鼠标移上去或键盘到这一行时出现 */
.chip-row .pin { opacity: 0; }
.chip-row:hover .pin, .chip-row:focus-within .pin, .chip-row .pin[aria-pressed="true"] { opacity: 1; }
.chip-row .rk { font-size: 11px; color: var(--muted); width: 16px; text-align: center; font-variant-numeric: tabular-nums; flex: none; }
.chip-row .x { border: 0; background: none; color: var(--muted); width: 22px; height: 22px; font-size: 12px; border-radius: 6px; cursor: pointer; font: inherit; flex: none; line-height: 1; }
.chip-row .x:hover { background: var(--hover); color: var(--ink); }
/* 「优先」：平平的文字小标签，不用图标；选中后变成主题色的实底标签 */
.chip-row .pin { border: 1px solid var(--line); background: none; color: var(--muted); font: inherit; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 99px; cursor: pointer; flex: none; white-space: nowrap; }
.chip-row .pin:hover { color: var(--ink); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
.chip-row .pin[aria-pressed="true"] { background: color-mix(in srgb, var(--accent) 14%, transparent); border-color: transparent; color: var(--accent); font-weight: 600; }
.chip-row .warn { font-size: 11px; color: #8a5a00; white-space: nowrap; }
.lib { border: 1.5px solid transparent; border-radius: 12px; padding: 2px 0; transition: border-color .12s, background .12s; }
.lib-card { display: flex; align-items: center; gap: 2px; border-radius: 9px; }
.lib-card .pv-item { cursor: grab; }
.lib-card .tg { border: 1px solid var(--line); background: var(--surface); color: var(--muted); font: inherit; font-size: 11px; padding: 1px 6px; border-radius: 99px; cursor: pointer; flex: none; }
.lib-card .tg[aria-pressed="true"] { background: color-mix(in srgb, var(--accent) 14%, transparent); border-color: transparent; color: var(--accent); font-weight: 600; }
.lib-card .tg:disabled { opacity: .5; cursor: default; }
.lib-card .tags { display: flex; gap: 3px; padding-right: 6px; }
/* 左栏跟着页面一起滚（不再套第二个滚动区：滚起来不会一会儿滚里面、一会儿滚外面）。
   列表长的时候拖动：拖到窗口上下边缘会自动滚，越靠边越快 */
.pv-list { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 6px; min-width: 0; }
.lanes { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.pv-group { font-size: 11.5px; color: var(--muted); padding: 10px 10px 4px; }
.pv-item { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: 8px; cursor: pointer; border: 0; background: none; width: 100%; text-align: left; font: inherit; color: var(--ink); }
.pv-item:hover { background: var(--hover); }
.pv-item[aria-selected="true"], .pv-item[aria-current="true"] { background: var(--hover); box-shadow: inset 3px 0 0 var(--accent); }
.pv-item .hd { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.pv-item .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-item .lt { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.pv-item.off .nm { color: var(--muted); }
.pv-add { margin: 8px 6px 4px; width: calc(100% - 12px); }
.pv-detail { display: grid; gap: 14px; min-width: 0; }
.pv-card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
.pv-card h3 { font-size: 13.5px; margin: 0 0 12px; font-weight: 650; }
.pv-card h3 small { font-weight: 400; color: var(--muted); margin-left: 6px; }
.pv-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pv-head .title { font-size: 18px; font-weight: 650; }
.pv-head input.title { font: inherit; font-size: 18px; font-weight: 650; min-width: 0; width: 260px; }
.pv-head .grow { flex: 1; }
.pv-meta { color: var(--muted); font-size: 12.5px; margin-top: 6px; }
.pv-meta code { font-size: 11.5px; }
.chip { font-size: 11.5px; padding: 1px 8px; border-radius: 99px; background: var(--hover); color: var(--ink-2); white-space: nowrap; }
.chip.warn { color: #8a5a00; background: color-mix(in srgb, var(--warning) 22%, transparent); }
.stats { display: flex; gap: 28px; flex-wrap: wrap; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
.stats .k { font-size: 11.5px; color: var(--muted); }
.stats .v { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; padding: 1px 8px; border-radius: 99px; color: var(--ink); background: color-mix(in srgb, var(--st) 16%, transparent); }
.badge::before { content: attr(data-icon); color: var(--st); font-weight: 700; }
.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px 18px; }
.field { display: grid; gap: 5px; align-content: start; font-size: 12.5px; color: var(--ink-2); }
.field.wide { grid-column: 1 / -1; }
.field .lab { display: flex; gap: 8px; align-items: baseline; }
.field .lab a, .field .lab button.link { color: var(--accent); font-size: 12px; background: none; border: 0; padding: 0; cursor: pointer; font-family: inherit; }
.field .hint { color: var(--muted); font-size: 11.5px; }
.field input, .field select, .field textarea { min-width: 0; width: 100%; }
.field textarea { min-height: 110px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.inline { display: flex; gap: 8px; align-items: center; }
.inline > input { flex: 1; }
.checks { display: flex; gap: 16px; flex-wrap: wrap; color: var(--ink); }
.checks label { display: flex; gap: 6px; align-items: center; }
.checks input { accent-color: var(--accent); width: auto; }
.range2 { display: flex; gap: 10px; align-items: center; }
.range2 input { flex: 1; accent-color: var(--accent); }
.range2 output { min-width: 2.5em; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
.note { color: var(--muted); font-size: 12.5px; background: var(--hover); border-radius: 8px; padding: 10px 12px; }
.bar { position: sticky; bottom: 0; z-index: 2; display: flex; gap: 8px; align-items: center; padding: 10px 2px; background: var(--bg); border-top: 1px solid var(--line); box-shadow: 0 -8px 16px -12px rgba(0, 0, 0, .25); }
.bar .msg { font-size: 12.5px; color: var(--muted); }
.bar .msg.ok { color: var(--good); }
.bar .msg.bad { color: var(--critical); }
.bar .grow { flex: 1; }
.btn.danger { color: var(--critical); }
.tpls { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.tpl { text-align: left; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; background: var(--bg); cursor: pointer; font: inherit; color: var(--ink); }
.tpl[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.tpl b { display: block; margin-bottom: 2px; }
.tpl span { font-size: 12px; color: var(--muted); }
${PACK_CSS}
`;

const KIND: Record<ProviderKind, string> = { mt: L('机器翻译', 'Machine translation'), llm: L('大模型', 'LLM'), local: L('本地模型', 'Local model'), remote: L('远程节点', 'Remote node'), builtin: L('浏览器内置', 'Built into the browser') };
const HEALTH: Record<string, [string, string, string]> = {
  ok: [L('正常', 'OK'), '✓', 'var(--good)'],
  degraded: [L('波动', 'Unstable'), '!', 'var(--warning)'],
  error: [L('出错', 'Error'), '✕', 'var(--critical)'],
  exhausted: [L('额度用尽', 'Quota used up'), '◔', 'var(--serious)'],
  disabled: [L('已停用', 'Disabled'), '–', 'var(--muted)'],
  unconfigured: [L('未配置', 'Not set up'), '○', 'var(--muted)'],
};
const TEMPLATES: [ProviderTemplate | ExtraProviderTemplate, string, string][] = [
  ['openai-compatible', L('OpenAI 兼容接口', 'OpenAI-compatible API'), L('DeepSeek、硅基流动、智谱、通义、Kimi、Ollama、LM Studio、vLLM 等', 'DeepSeek, SiliconFlow, Zhipu, Qwen, Kimi, Ollama, LM Studio, vLLM and more')],
  ['llamacpp', L('另一台 llama-server', 'Another llama-server'), L('局域网或本机其他端口上的 llama.cpp 服务', 'A llama.cpp server in your LAN or on another local port')],
  ['remote-node', L('远程节点', 'Remote node'), L('另一台运行本项目 gateway 的电脑', 'Another computer running this project’s gateway')],
  ['libretranslate', 'LibreTranslate', L('开源机器翻译，可以自己在本机或局域网部署，免费、离线', 'Open-source machine translation you can host on your computer or LAN — free, offline')],
  ['custom-http', L('自定义 HTTP 接口', 'Custom HTTP API'), L('任意翻译接口：按模板填写请求地址、请求体和译文在返回里的位置', 'Any translation API: fill in the URL, request body and where the translation is in the response')],
];
/** 老后端（没有 providers:templates）只支持这三个。 */
const BASE_TEMPLATES: (ProviderTemplate | ExtraProviderTemplate)[] = ['openai-compatible', 'llamacpp', 'remote-node'];

/**
 * OpenAI 兼容接口的常用服务：选一个就填好接口地址，名字也先起好；之后只要填密钥、点「查询模型」选一个。
 * 地址核实：2026-11（各家文档）。模型名变化快，不预填，在详细设置里查询。
 */
const PRESETS: { name: string; url: string; note: string; docs: string; local?: boolean }[] = [
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1', note: L('国内直连，价格低', 'Direct in China, low price'), docs: 'https://api-docs.deepseek.com/zh-cn/' },
  { name: L('硅基流动', 'SiliconFlow'), url: 'https://api.siliconflow.cn/v1', note: L('有免费的小模型', 'Has free small models'), docs: 'https://docs.siliconflow.cn/' },
  { name: L('智谱 BigModel', 'Zhipu BigModel'), url: 'https://open.bigmodel.cn/api/paas/v4', note: L('Flash 系列免费', 'Flash models are free'), docs: 'https://docs.bigmodel.cn/' },
  { name: L('阿里云百炼（通义）', 'Alibaba Cloud Model Studio (Qwen)'), url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', note: L('北京地域；其他地域在控制台查看地址', 'Beijing region; see the console for other regions’ addresses'), docs: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope' },
  { name: L('月之暗面 Kimi', 'Moonshot Kimi'), url: 'https://api.moonshot.cn/v1', note: L('长文本', 'Long context'), docs: 'https://platform.moonshot.cn/' },
  { name: L('火山方舟（豆包）', 'Volcano Ark (Doubao)'), url: 'https://ark.cn-beijing.volces.com/api/v3', note: L('模型名填接入点或模型 ID', 'Use the endpoint or model ID as the model name'), docs: 'https://www.volcengine.com/product/ark' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', note: L('一个密钥用多家模型', 'One key for many providers’ models'), docs: 'https://openrouter.ai/docs' },
  { name: 'Groq', url: 'https://api.groq.com/openai/v1', note: L('速度很快', 'Very fast'), docs: 'https://console.groq.com/docs' },
  { name: 'Mistral', url: 'https://api.mistral.ai/v1', note: L('欧洲服务', 'European service'), docs: 'https://docs.mistral.ai/' },
  { name: 'OpenAI', url: 'https://api.openai.com/v1', note: '', docs: 'https://platform.openai.com/docs' },
  { name: L('Ollama（本机）', 'Ollama (local)'), url: 'http://127.0.0.1:11434/v1', note: L('本机运行，密钥随便填', 'Runs locally; any key works'), docs: 'https://ollama.com/', local: true },
  { name: L('LM Studio（本机）', 'LM Studio (local)'), url: 'http://127.0.0.1:1234/v1', note: L('本机运行，密钥随便填', 'Runs locally; any key works'), docs: 'https://lmstudio.ai/docs', local: true },
  { name: L('vLLM / 其他自建', 'vLLM / other self-hosted'), url: 'http://127.0.0.1:8000/v1', note: L('改成你的服务地址', 'Change to your server address'), docs: 'https://docs.vllm.ai/', local: true },
];
const UNIT: Record<QuotaInfo['unit'], string> = { char: L('字符', 'chars'), token: 'token', request: L('次请求', 'requests') };
const PERIOD: Record<QuotaInfo['period'], string> = { day: L('每天', 'per day'), month: L('每月', 'per month'), cycle: L('每个计费周期', 'per billing cycle') };

const tierOf = (usedFor: Mode[]) => ({ fast: usedFor.includes('fast'), accurate: usedFor.includes('accurate') });
const usedForOf = (fast: boolean, accurate: boolean): Mode[] => [
  ...(fast ? (['fast'] as Mode[]) : []),
  ...(accurate ? (['accurate'] as Mode[]) : []),
  ...(fast || accurate ? (['combined'] as Mode[]) : []),
];

export async function mountProviders(main: HTMLElement): Promise<() => void> {
  const style = document.createElement('style');
  style.textContent = CSS;
  const listEl = h('div', { class: 'pv-list', 'aria-label': L('翻译服务调度', 'Service scheduling') });
  const detail = h('div', { class: 'pv-detail' });
  main.append(
    style,
    h('h1', null, L('翻译服务', 'Services')),
    h('p', { class: 'lead' }, L('密钥只保存在本机。非官方接口默认关闭，开启前请了解它随时可能失效。', 'Keys are stored only on this device. Unofficial APIs are off by default — they can stop working at any time.')),
    h('div', { class: 'pv-layout' }, listEl, detail),
  );

  let list: ProviderInfo[] = [];
  const status = new Map<string, ProviderStatus>();
  let selected = decodeURIComponent(location.hash.split('/')[1] ?? '');
  let view: Detail | null = null;

  const load = async () => {
    try {
      list = await rpc('providers:list', undefined);
    } catch (e) {
      detail.replaceChildren(h('div', { class: 'note' }, L('读取服务列表失败：', 'Could not load services: ') + String((e as Error).message)));
      return false;
    }
    return true;
  };

  // 拖动中不重画（状态快照每几秒来一次，重画会把正在拖的元素换掉）
  let dragging = false;
  let pendingRender = false;
  type Tier = 'fast' | 'accurate';
  type From = Tier | 'lib';
  const DND = 'text/x-tx-provider';
  const effTier = (p: ProviderInfo) => tierOf(p.options?.usedFor ?? p.usedFor);
  const inTier = (p: ProviderInfo, t: Tier) => p.enabled && effTier(p)[t];
  const canEdit = (p: ProviderInfo) => !!p.editable?.includes('usedFor');
  const TIER_LABEL: Record<Tier, [string, string]> = {
    fast: [L('高速档', 'Fast tier'), L('快速模式、综合模式第一遍', 'fast mode, combined first pass')],
    accurate: [L('精确档', 'Accurate tier'), L('精确模式、综合模式第二遍', 'accurate mode, combined second pass')],
  };

  /** 改某家服务在两档里的位置：add / remove 是要加进 / 拿出的档。两档都不在了就停用；本来停用的，加进来时只放进这一档。 */
  const moveTier = async (id: string, add: Tier | null, remove: Tier | null) => {
    const p = list.find((x) => x.id === id);
    if (!p || add === remove) return;
    if (!canEdit(p)) {
      view?.say('bad', L('当前后端不支持调整这家服务参与哪一档。', 'This backend cannot change which tier this service is in.'));
      return;
    }
    if (view?.id === id && view.dirty() && !confirm(L('这家服务有未保存的修改，调整档位会丢掉这些修改，继续吗？', 'This service has unsaved changes that will be lost. Continue?'))) return;
    const cur = p.enabled ? effTier(p) : { fast: false, accurate: false };
    const next = { ...cur };
    if (remove) next[remove] = false;
    if (add) next[add] = true;
    if (add && !p.official && !p.enabled && !confirm(L(`「${p.name}」是非官方接口，随时可能失效或被限流。确定启用吗？`, `“${p.name}” is an unofficial API that can stop working or be rate-limited at any time. Enable it?`))) return;
    const enabled = next.fast || next.accurate;
    try {
      await rpc('providers:save', {
        id: p.id,
        enabled,
        config: p.config,
        // 两档都不在时保留原来的参与设置，下次启用还是原样
        options: { ...(p.options ?? {}), ...(enabled ? { usedFor: usedForOf(next.fast, next.accurate) } : {}) },
      });
    } catch (e) {
      view?.say('bad', L('调整失败：', 'Failed: ') + String((e as Error).message));
      return;
    }
    await load();
    // 刚放进档里的服务还没填账号：打开它的详情，让用户接着填
    const after = list.find((x) => x.id === id);
    if (add && after && !after.configured) {
      select(id, true);
      view?.say('bad', L('已加入，但还没填账号信息：在下面填好后点「保存并测试」。', 'Added, but its account details are missing — fill them in below and click “Save and test”.'));
    } else if (selected === id) select(id, true);
    else renderList();
  };

  /**
   * 「优先」是按服务记的（后台只存服务级的置顶，不分档）：同一家在两档里时，两档都会优先用它。
   * 置顶一家时，取消和它同在一档的其他服务的置顶，保证每档最多一家「优先」。
   */
  const setPin = (id: string, want: boolean) => {
    const st = status.get(id);
    if (!!st?.pinned === want) return;
    try {
      port?.postMessage({ type: 'provider-action', providerId: id, action: want ? 'pin' : 'unpin' });
    } catch {
      /* 端口刚断开：下次快照会恢复真实状态 */
    }
    if (st) st.pinned = want;
  };
  const togglePin = (id: string) => {
    const target = list.find((p) => p.id === id);
    if (!target) return;
    if (status.get(id)?.pinned) setPin(id, false);
    else {
      const tiers = (['fast', 'accurate'] as const).filter((t) => inTier(target, t));
      for (const p of list) if (p.id !== id && tiers.some((t) => inTier(p, t))) setPin(p.id, false);
      setPin(id, true);
    }
    renderList();
  };

  const dot = (p: ProviderInfo) => {
    const st = status.get(p.id);
    const d = h('span', { class: 'hd', title: HEALTH[st?.health ?? (p.configured ? 'disabled' : 'unconfigured')][0] });
    if (st) d.style.background = HEALTH[st.health][2];
    return d;
  };
  const dragSource = (el: HTMLElement, id: string, from: From) => {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      dragging = true;
      e.dataTransfer?.setData(DND, JSON.stringify({ id, from }));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      dragging = false;
      autoScroll.stop();
      el.classList.remove('dragging');
      listEl.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop'));
      if (pendingRender) {
        pendingRender = false;
        renderList();
      }
    });
  };
  const dropTarget = (el: HTMLElement, to: From) => {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(DND)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget as Node | null)) el.classList.remove('drop');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop');
      let data: { id: string; from: From };
      try {
        data = JSON.parse(e.dataTransfer?.getData(DND) || '');
      } catch {
        return;
      }
      if (data.from === to) return;
      // 库 → 档：加进这一档；档 → 另一档：挪过去；档 → 库：从那一档拿出来
      void moveTier(data.id, to === 'lib' ? null : to, data.from === 'lib' ? null : data.from);
    });
  };

  /**
   * 拖动时靠近窗口上下边缘就自动滚：离边越近滚得越快，速度平滑地加减，不一顿一顿。
   * dragover 大约每 50ms 来一次；超过 200ms 没来（拖出窗口）就停。
   */
  const autoScroll = (() => {
    let raf = 0, want = 0, v = 0, last = 0;
    const EDGE = 72, MAX = 18;
    const speed = (d: number) => (d <= 0 ? 0 : MAX * Math.min(1, d / EDGE) ** 1.7);
    const scroller = () => {
      for (let el: HTMLElement | null = listEl.parentElement; el; el = el.parentElement) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      }
      return (document.scrollingElement as HTMLElement) ?? document.documentElement;
    };
    const tick = () => {
      if (performance.now() - last > 200) want = 0;
      v += (want - v) * 0.25; // 平滑加减速
      if (Math.abs(v) < 0.3 && !want) {
        raf = v = 0;
        return;
      }
      scroller().scrollBy(0, v);
      raf = requestAnimationFrame(tick);
    };
    return {
      update(e: DragEvent) {
        last = performance.now();
        const y = e.clientY;
        want = y < EDGE ? -speed(EDGE - y) : y > innerHeight - EDGE ? speed(y - (innerHeight - EDGE)) : 0;
        if (want && !raf) raf = requestAnimationFrame(tick);
      },
      stop() {
        want = 0;
      },
    };
  })();
  const onDragOver = (e: DragEvent) => {
    if (dragging) autoScroll.update(e);
  };
  document.addEventListener('dragover', onDragOver, true);

  // 状态快照每几秒来一次；内容没变就不重画（重画会打断悬停、按钮焦点和两条档里的滚动位置）
  let lastSig = '';
  const signature = () =>
    JSON.stringify([selected, list.map((p) => [p.id, p.name, p.enabled, p.configured, p.options?.usedFor ?? p.usedFor]),
      [...status.values()].map((st) => [st.id, st.health, st.rank, st.pinned, st.latencyP50Ms ? Math.round(st.latencyP50Ms / 20) : 0])]);

  const renderList = (force = true) => {
    if (dragging) {
      pendingRender = true;
      return;
    }
    const sig = signature();
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const board = h('div', { class: 'pv-board' });
    board.append(h('div', { class: 'pv-hint' }, L('从下面的服务库拖进高速档或精确档，或点卡片上的「高速」「精确」。每档里先用哪家由调度按速度、成功率和剩余额度实时决定；鼠标移到某一行点「优先」，就先用它。', 'Drag services from the library below into a tier, or click “Fast” / “Accurate” on a card. Within a tier the scheduler picks by speed, success rate and remaining quota in real time; hover a row and click “Prefer” to use it first.')));
    const lanesBox = h('div', { class: 'lanes' });
    board.append(lanesBox);
    for (const tier of ['fast', 'accurate'] as const) {
      const members = list.filter((p) => inTier(p, tier)).sort((a, b) => {
        const sa = status.get(a.id), sb = status.get(b.id);
        // 后台快照里的 rank 是按高速档排的；精确档没有自己的排名，按「优先 → 权重 → 延迟」排，不显示名次
        const byRank = tier === 'fast' ? (sa?.rank ?? 999) - (sb?.rank ?? 999) : (b.options?.weight ?? b.defaults?.weight ?? 50) - (a.options?.weight ?? a.defaults?.weight ?? 50);
        return Number(!!sb?.pinned) - Number(!!sa?.pinned) || byRank || (sa?.latencyP50Ms ?? 9e9) - (sb?.latencyP50Ms ?? 9e9) || a.name.localeCompare(b.name);
      });
      const lane = h('div', { class: 'lane' + (members.length ? ' has' : ''), 'data-tier': tier, role: 'group', 'aria-label': TIER_LABEL[tier][0] },
        h('div', { class: 'lane-h' }, h('b', null, TIER_LABEL[tier][0]), h('span', null, TIER_LABEL[tier][1])));
      if (!members.length) lane.append(h('div', { class: 'lane-empty' }, L('把服务拖到这里', 'Drag a service here')));
      members.forEach((p, i) => {
        const st = status.get(p.id);
        const item = h('button', { class: 'pv-item', type: 'button', title: L('点开看详情；拖到另一档或拖回服务库', 'Click for details; drag to the other tier or back to the library') },
          h('span', { class: 'rk', title: tier === 'fast' ? L('调度的实时名次', 'Live scheduling rank') : '' }, tier === 'fast' && st?.rank ? String(st.rank) : '·'), dot(p), h('span', { class: 'nm' }, p.name),
          !p.configured ? h('span', { class: 'warn' }, L('未配置', 'not set up')) : h('span', { class: 'lt' }, st?.latencyP50Ms ? `${st.latencyP50Ms} ms` : ''));
        item.addEventListener('click', () => select(p.id));
        const both = inTier(p, 'fast') && inTier(p, 'accurate');
        const pin = h('button', { class: 'pin', type: 'button', 'aria-pressed': String(!!st?.pinned), title: st?.pinned ? L('取消优先', 'Stop preferring it') : L(`优先用它（失败或额度用尽时仍会自动换下一家）${both ? '；它在两档里，两档都会优先' : ''}`, `Prefer it (still falls back on errors or when quota runs out)${both ? '; it is in both tiers, so both prefer it' : ''}`) }, L('优先', 'Prefer'));
        pin.addEventListener('click', () => togglePin(p.id));
        // 本地模型、浏览器内置翻译是兜底：移出某一档后平时不用，但别的服务全都不可用时后台仍会用它，免得整段翻译失败
        const fallback = p.kind === 'local' || p.kind === 'builtin';
        const x = h('button', { class: 'x', type: 'button', title: L(`从${TIER_LABEL[tier][0]}拿出`, `Remove from the ${TIER_LABEL[tier][0]}`) + (fallback ? L('（这一档平时不用它；别的服务都不可用时仍会拿它兜底）', ' (not used normally; still a last resort when nothing else works)') : ''), 'aria-label': L('移出', 'Remove') }, '✕');
        x.addEventListener('click', () => void moveTier(p.id, null, tier));
        const row = h('div', { class: 'chip-row', 'aria-selected': String(p.id === selected) }, item, pin, x);
        if (canEdit(p)) dragSource(row, p.id, tier);
        lane.append(row);
      });
      dropTarget(lane, tier);
      lanesBox.append(lane);
    }
    // 服务库：全部服务（已配置的在前，未配置、非官方在后）
    const lib = h('div', { class: 'lib', role: 'group', 'aria-label': L('服务库', 'Library') });
    const groups: [string, ProviderInfo[]][] = [
      [L('服务库', 'Library'), list.filter((p) => p.official && p.configured)],
      [L('还没配置', 'Not set up yet'), list.filter((p) => p.official && !p.configured)],
      [L('非官方（默认关闭）', 'Unofficial (off by default)'), list.filter((p) => !p.official)],
    ];
    for (const [title, ps] of groups) {
      if (!ps.length) continue;
      lib.append(h('div', { class: 'pv-group' }, title));
      for (const p of ps) {
        const st = status.get(p.id);
        // 库里不显示延迟（档里有），给名字多留点地方
        const item = h('button', { class: 'pv-item' + (p.enabled ? '' : ' off'), 'aria-current': p.id === selected ? 'true' : undefined, type: 'button', title: p.name + (st?.latencyP50Ms ? ` · ${st.latencyP50Ms} ms` : '') },
          dot(p), h('span', { class: 'nm' }, p.name));
        item.addEventListener('click', () => select(p.id));
        const tags = h('span', { class: 'tags' });
        for (const tier of ['fast', 'accurate'] as const) {
          const on = inTier(p, tier);
          const tg = h('button', { class: 'tg', type: 'button', 'aria-pressed': String(on), disabled: !canEdit(p),
            title: on ? L(`从${TIER_LABEL[tier][0]}拿出`, `Remove from the ${TIER_LABEL[tier][0]}`) : L(`加进${TIER_LABEL[tier][0]}`, `Add to the ${TIER_LABEL[tier][0]}`) },
            tier === 'fast' ? L('高速', 'Fast') : L('精确', 'Accurate'));
          tg.addEventListener('click', () => void (on ? moveTier(p.id, null, tier) : moveTier(p.id, tier, null)));
          tags.append(tg);
        }
        const card = h('div', { class: 'lib-card' }, item, tags);
        if (canEdit(p)) dragSource(card, p.id, 'lib');
        lib.append(card);
      }
    }
    dropTarget(lib, 'lib');
    board.append(lib);
    const add = h('button', { class: 'btn small pv-add', type: 'button' }, L('＋ 添加服务', '＋ Add service'));
    add.addEventListener('click', () => showAdd());
    board.append(add);
    listEl.replaceChildren(board);
  };



  const select = (id: string, force = false) => {
    if (!force && view?.dirty() && !confirm(L('有未保存的修改，确定离开？', 'You have unsaved changes. Leave anyway?'))) return;
    selected = id;
    history.replaceState(null, '', `#providers/${encodeURIComponent(id)}`);
    renderList();
    const p = list.find((x) => x.id === id);
    view = p
      ? new Detail(p, status.get(id), {
          reload: async (keep, flash) => {
            await load();
            select(keep ?? id, true);
            if (flash) view?.say(flash[0], flash[1]);
          },
          removed: async () => {
            await load();
            select(list[0]?.id ?? '', true);
          },
        })
      : null;
    detail.replaceChildren(view ? view.el : h('div', { class: 'note' }, L('还没有任何服务。', 'No services yet.')));
  };

  const showAdd = () => {
    if (view?.dirty() && !confirm(L('有未保存的修改，确定离开？', 'You have unsaved changes. Leave anyway?'))) return;
    view = null;
    selected = '';
    renderList();
    let tpl: ProviderTemplate | ExtraProviderTemplate = 'openai-compatible';
    let preset: (typeof PRESETS)[number] | null = null;
    const name = h('input', { type: 'text', placeholder: L('例如：DeepSeek、家里的台式机', 'e.g. DeepSeek, my desktop at home') }) as HTMLInputElement;
    const msg = h('span', { class: 'msg' });
    const cards = h('div', { class: 'tpls' });
    const presetBox = h('div', { class: 'pv-card presets' },
      h('h3', null, L('常用的 OpenAI 兼容服务', 'Popular OpenAI-compatible services'), h('small', null, L('选一个就填好接口地址；添加后填密钥、点「查询模型」', 'Pick one to fill in the endpoint; after adding, enter the key and click “Fetch models”'))),
    );
    const presetGrid = h('div', { class: 'tpls' });
    for (const ps of PRESETS) {
      const c = h('button', { class: 'tpl', type: 'button', 'aria-pressed': 'false', 'data-preset': ps.name },
        h('b', null, ps.name), h('span', null, [ps.url.replace(/^https?:\/\//, ''), ps.note].filter(Boolean).join(' · ')));
      c.addEventListener('click', () => {
        preset = preset === ps ? null : ps;
        presetGrid.querySelectorAll('.tpl').forEach((x) => x.setAttribute('aria-pressed', String(preset && x === c)));
        if (preset && (!name.value.trim() || PRESETS.some((x) => x.name === name.value.trim()))) name.value = preset.name;
      });
      presetGrid.append(c);
    }
    presetBox.append(presetGrid);
    const paintTpl = () => {
      cards.querySelectorAll<HTMLElement>('.tpl').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.tpl === tpl)));
      presetBox.style.display = tpl === 'openai-compatible' ? '' : 'none';
    };
    const addCard = (id: ProviderTemplate | ExtraProviderTemplate, label: string, desc: string) => {
      const c = h('button', { class: 'tpl', type: 'button', 'data-tpl': id }, h('b', null, label), h('span', null, desc));
      c.addEventListener('click', () => {
        tpl = id;
        if (id !== 'openai-compatible') preset = null;
        paintTpl();
      });
      cards.append(c);
    };
    for (const [id, label, desc] of TEMPLATES) if (BASE_TEMPLATES.includes(id)) addCard(id, label, desc);
    paintTpl();
    // 新后端支持更多模板（LibreTranslate、自定义 HTTP）时再显示
    void rpc('providers:templates', undefined)
      .then((list) => {
        for (const [id, label, desc] of TEMPLATES) if (!BASE_TEMPLATES.includes(id) && list.includes(id)) addCard(id, label, desc);
        paintTpl();
      })
      .catch(() => {});
    const ok = h('button', { class: 'btn primary', type: 'button' }, L('添加', 'Add'));
    ok.addEventListener('click', async () => {
      const n = name.value.trim() || preset?.name || TEMPLATES.find((t) => t[0] === tpl)![1];
      msg.className = 'msg';
      msg.textContent = L('正在添加…', 'Adding…');
      try {
        // 新模板要后端在 ProviderTemplate 里登记后才算正式支持；这里只在 providers:templates 列出时才会选到
        const p = await rpc('providers:add', { template: tpl as ProviderTemplate, name: n });
        if (preset && tpl === 'openai-compatible') {
          await rpc('providers:save', { id: p.id, enabled: false, config: { ...p.config }, ...(p.editable?.includes('endpoint') ? { options: { ...(p.options ?? {}), endpoint: preset.url } } : {}), name: n });
        }
        await load();
        select(p.id, true);
        if (preset) view?.say('ok', L(`已填好 ${preset.name} 的接口地址。填上密钥后点「查询模型」选一个，再启用。`, `Endpoint for ${preset.name} filled in. Enter the key, click “Fetch models”, pick one, then enable it.`));
      } catch (e) {
        msg.className = 'msg bad';
        msg.textContent = L('添加失败：', 'Add failed: ') + String((e as Error).message);
      }
    });
    detail.replaceChildren(
      h('div', { class: 'pv-card' },
        h('h3', null, L('添加服务', 'Add service')),
        cards,
        h('div', { class: 'fields', style: 'margin-top:14px' }, h('label', { class: 'field' }, h('span', { class: 'lab' }, L('名称', 'Name')), name)),
      ),
      presetBox,
      h('div', { class: 'bar' }, ok, msg),
    );
    name.focus();
  };

  if (!(await load())) return () => {};
  if (!list.some((p) => p.id === selected)) selected = list[0]?.id ?? '';
  select(selected, true);

  // 订阅状态：列表里的健康点和延迟、详情里的用量实时更新
  let port: chrome.runtime.Port | null = null;
  let closed = false;
  const connect = () => {
    if (closed) return;
    try {
      port = chrome.runtime.connect({ name: PORT_STATUS });
    } catch {
      return;
    }
    port.onMessage.addListener((m: StatusServerMsg) => {
      if (m.type !== 'snapshot') return;
      status.clear();
      for (const p of m.status.providers) status.set(p.id, p);
      if (!view?.dirty()) renderList(false);
      view?.setStatus(status.get(view.id));
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      if (!closed) window.setTimeout(connect, 2000);
    });
  };
  connect();
  return () => {
    closed = true;
    port?.disconnect();
    document.removeEventListener('dragover', onDragOver, true);
  };
}

/* ------------------------------------------------------------------ */

type Flash = ['' | 'ok' | 'bad', string];

interface DetailHooks {
  reload(keepId?: string, flash?: Flash): Promise<void>;
  removed(): Promise<void>;
}

/** 新手指引里这家服务的一步一步教程（注册、拿密钥、填写）。 */
function guideHref(p: ProviderInfo): string | null {
  if (p.kind === 'local' && !p.custom) return '#welcome/local';
  const url = p.options?.endpoint || p.config.url;
  const g = apiGuides().find((g) =>
    p.custom ? (g.preset && g.preset.url === url) || (!g.providerId && !g.preset && p.template === 'libretranslate')
      : g.providerId && (p.id === g.providerId || p.adapter.file.endsWith(`/${g.providerId}.ts`)));
  return g ? `#welcome/api/${g.id}` : null;
}

/**
 * 本机模型：开机自动启动、立即启动。扩展自己启动不了电脑上的程序，要后端的本机助手（协议 v2.2 的 local:*）；
 * 后端还不支持时，告诉用户怎么手动启动。
 */
export function localModelCard(): HTMLElement {
  const sw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': L('开机自动启动本地模型', 'Start the local model automatically'), disabled: true }) as HTMLInputElement;
  const start = h('button', { class: 'btn small', type: 'button', disabled: true }, L('立即启动', 'Start now'));
  const msg = h('span', { class: 'hint' }, L('正在检查…', 'Checking…'));
  const manual = L('后端还不能从扩展里控制本地模型（需要本机助手，后端下一版提供）。现在可以双击项目文件夹里的 gateway\\scripts\\start-local.cmd 启动；重启电脑后要再启动一次。', 'The backend cannot control the local model from the extension yet (needs the local helper). For now double-click gateway\\scripts\\start-local.cmd in the project folder; after a reboot, start it again.');
  const refresh = (r: { supported: boolean; enabled: boolean; canStart?: boolean; hint?: string } | null) => {
    sw.disabled = !r?.supported;
    sw.checked = !!r?.enabled;
    start.disabled = !r?.canStart;
    msg.textContent = !r ? manual : !r.supported ? (r.hint || manual)
      : !r.canStart && r.hint ? r.hint
      : r.enabled ? L('已设置：登录 Windows 后在后台自动启动（闲置 10 分钟会卸载模型、释放显存，下次翻译时自动加载）。', 'Set: starts in the background after you log in to Windows (unloads after 10 idle minutes to free VRAM, loads again on the next translation).')
      : L('开机后不会自动启动；需要时点「立即启动」。', 'Does not start automatically; click “Start now” when needed.');
  };
  void rpc('local:autostart', {}).then(refresh, () => refresh(null));
  sw.addEventListener('change', () => {
    sw.disabled = true;
    msg.textContent = sw.checked ? L('正在设置开机启动…', 'Enabling autostart…') : L('正在取消开机启动…', 'Disabling autostart…');
    void rpc('local:autostart', { enable: sw.checked }).then(refresh, (e) => {
      sw.checked = !sw.checked;
      sw.disabled = false;
      msg.textContent = L('设置失败：', 'Failed: ') + String((e as Error).message);
    });
  });
  start.addEventListener('click', () => {
    start.disabled = true;
    msg.textContent = L('正在启动本地模型…', 'Starting the local model…');
    void rpc('local:start', undefined).then(
      (r) => {
        start.disabled = false;
        msg.textContent = r.ok ? L('本地模型已启动。', 'Local model started.') : L('启动失败：', 'Failed to start: ') + (r.message ?? L('未知原因', 'unknown reason'));
      },
      (e) => {
        start.disabled = false;
        msg.textContent = L('启动失败：', 'Failed to start: ') + String((e as Error).message);
      },
    );
  });
  return h('div', { class: 'pv-card local-card' },
    h('h3', null, L('本机模型', 'Local model'), h('small', null, L('不想每次重启电脑后都手动开', 'No more starting it by hand after every reboot'))),
    h('div', { class: 'inline', style: 'justify-content:space-between;gap:16px' },
      h('label', { class: 'inline', style: 'font-size:13px' }, sw, L('开机自动启动', 'Start at login')),
      start),
    h('div', { style: 'margin-top:8px' }, msg),
  );
}

class Detail {
  readonly el: HTMLElement;
  readonly id: string;
  private initial = '';
  private collectors: (() => void)[] = [];
  private config: Record<string, string> = {};
  private options: ProviderOptions = {};
  private enabled: HTMLInputElement;
  private nameInput: HTMLInputElement | null = null;
  private statsEl: HTMLElement;
  private msg: HTMLElement;

  constructor(private p: ProviderInfo, st: ProviderStatus | undefined, private hooks: DetailHooks) {
    this.id = p.id;
    const editable = new Set(p.editable ?? []);
    const d = p.defaults ?? {};
    const o = p.options ?? {};

    this.enabled = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': L('启用', 'Enabled') }) as HTMLInputElement;
    this.enabled.checked = p.enabled;
    this.statsEl = h('div', { class: 'stats' });
    this.msg = h('span', { class: 'msg' });

    const title = p.custom
      ? (this.nameInput = h('input', { type: 'text', class: 'title', 'aria-label': L('名称', 'Name') }) as HTMLInputElement)
      : h('span', { class: 'title' }, p.name);
    if (this.nameInput) this.nameInput.value = p.name;
    const head = h('div', { class: 'pv-card' },
      h('div', { class: 'pv-head' },
        title,
        h('span', { class: 'chip' }, KIND[p.kind]),
        p.official ? null : h('span', { class: 'chip warn' }, L('非官方', 'Unofficial')),
        p.custom ? h('span', { class: 'chip' }, L('自定义', 'Custom')) : null,
        h('span', { class: 'grow' }),
        h('label', { class: 'inline', style: 'font-size:12.5px;color:var(--ink-2)' }, L('启用', 'Enabled'), this.enabled),
      ),
      h('div', { class: 'pv-meta' },
        [p.quotaText ? L('免费额度：', 'Free quota: ') + p.quotaText : '', L(`适配器 ${p.adapter.file.split('/').pop()} @${p.adapter.version}`, `Adapter ${p.adapter.file.split('/').pop()} @${p.adapter.version}`)].filter(Boolean).join(' · '),
        guideHref(p) ? h('span', null, ' · ', h('a', { href: guideHref(p)! }, L('详细教程', 'Step-by-step guide'))) : null,
        p.docsUrl ? h('span', null, ' · ', h('a', { href: p.docsUrl, target: '_blank', rel: 'noopener' }, L('官方文档', 'Official docs'))) : null,
      ),
      this.statsEl,
    );
    this.setStatus(st);

    const cards: HTMLElement[] = [head];

    // 账号
    if (p.auth.length) {
      const fields = h('div', { class: 'fields' });
      for (const f of p.auth) {
        let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        if (f.type === 'select') {
          input = h('select') as HTMLSelectElement;
          for (const opt of f.options ?? []) input.append(h('option', { value: opt.value, selected: p.config[f.key] === opt.value }, opt.label));
        } else if (f.type === 'textarea') {
          input = h('textarea', { placeholder: f.placeholder, spellcheck: 'false', rows: '6' }) as HTMLTextAreaElement;
          input.value = p.config[f.key] ?? '';
        } else {
          input = h('input', {
            type: f.secret ? 'password' : f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text',
            placeholder: f.placeholder,
            autocomplete: 'off',
            spellcheck: 'false',
          }) as HTMLInputElement;
          input.value = p.config[f.key] ?? '';
        }
        const inp = input;
        this.collectors.push(() => (this.config[f.key] = inp.value.trim()));
        fields.append(this.field(f.label + (f.required ? ' *' : ''), input, f.secret ? L('已保存的密钥显示为 ••••，不改就保持原样', 'Saved keys show as ••••; leave them unchanged to keep them') : undefined,
          f.helpUrl ? h('a', { href: f.helpUrl, target: '_blank', rel: 'noopener' }, L('如何申请', 'How to get one')) : null, f.type === 'textarea'));
      }
      cards.push(h('div', { class: 'pv-card' }, h('h3', null, L('账号', 'Account')), fields));
    }

    if (p.kind === 'local' && !p.custom) cards.push(localModelCard());
    if (p.kind === 'builtin') {
      // 语言包：在这里直接下载（不用先点「测试」等后台弹准备页）
      const box = h('div', { class: 'pv-card' }, h('h3', null, L('语言包', 'Language pack')), h('div', { class: 'hint', style: 'margin-bottom:8px' },
        L('浏览器内置翻译要先下载对应语言的语言包，只下一次，之后离线可用；整个浏览器共用。', 'The browser translator needs a language pack per language — downloaded once, then works offline; shared by the whole browser.')));
      void loadUiSettings().then((s) => box.append(builtinPackCard(s.targetLang, p, () => void this.hooks.reload(p.id))));
      cards.push(box);
    }

    if (!p.editable) {
      cards.push(h('div', { class: 'note' }, L('当前后端还不支持修改接口地址、模型、调度参数等高级设置（需要协议 v2）。后端更新后这里会自动出现。', 'This backend cannot change the endpoint, model or scheduling yet (needs protocol v2). These settings appear here once the backend is updated.')));
    }

    // 接口
    if (editable.has('endpoint') || editable.has('model') || editable.has('timeoutMs')) {
      const fields = h('div', { class: 'fields' });
      if (editable.has('endpoint')) {
        const input = this.text('url', o.endpoint, d.endpoint, (v) => (this.options.endpoint = v || undefined));
        const reset = h('button', { class: 'link', type: 'button' }, L('恢复默认', 'Reset'));
        reset.addEventListener('click', () => { input.value = ''; });
        fields.append(this.field(L('接口地址', 'Endpoint'), input, d.endpoint ? L('留空使用默认地址；可填代理或区域端点', 'Leave empty for the default; you can use a proxy or regional endpoint') : L('例如 http://127.0.0.1:8081 或 https://api.deepseek.com', 'e.g. http://127.0.0.1:8081 or https://api.deepseek.com'), reset, true));
      }
      if (editable.has('model')) {
        const listId = `models-${p.id}`;
        const input = this.text('text', o.model, d.model, (v) => (this.options.model = v || undefined));
        input.setAttribute('list', listId);
        const dl = h('datalist', { id: listId });
        const hint = h('span', { class: 'hint' }, L('可手动填写，或从接口获取可用模型', 'Type it in or fetch the available models from the API'));
        const fetchBtn = h('button', { class: 'btn small', type: 'button' }, L('获取模型', 'Fetch models'));
        fetchBtn.addEventListener('click', async () => {
          this.collect();
          hint.textContent = L('正在查询…', 'Querying…');
          try {
            const models = await rpc('providers:models', { id: p.id, endpoint: this.options.endpoint, config: { ...this.config } });
            dl.replaceChildren(...models.map((m) => h('option', { value: m })));
            hint.textContent = models.length ? L(`找到 ${models.length} 个模型，点输入框选择`, `Found ${models.length} models — pick one in the box`) : L('接口没有返回模型', 'The API returned no models');
          } catch (e) {
            hint.textContent = L('查询失败：', 'Query failed: ') + String((e as Error).message);
          }
        });
        const f = this.field(L('模型', 'Model'), h('div', { class: 'inline' }, input, fetchBtn), undefined, null, true);
        f.append(dl, hint);
        fields.append(f);
      }
      if (editable.has('timeoutMs')) {
        fields.append(this.field(L('超时（毫秒）', 'Timeout (ms)'), this.num(o.timeoutMs, d.timeoutMs, 100, (v) => (this.options.timeoutMs = v))));
      }
      cards.push(h('div', { class: 'pv-card' }, h('h3', null, L('接口', 'API')), fields));
    }

    // 调度
    if (['usedFor', 'weight', 'concurrency', 'qps', 'maxChars'].some((k) => editable.has(k as keyof ProviderOptions))) {
      const fields = h('div', { class: 'fields' });
      if (editable.has('usedFor')) {
        const cur = tierOf(o.usedFor ?? d.usedFor ?? p.usedFor);
        const fast = h('input', { type: 'checkbox' }) as HTMLInputElement;
        const acc = h('input', { type: 'checkbox' }) as HTMLInputElement;
        fast.checked = cur.fast;
        acc.checked = cur.accurate;
        const def = JSON.stringify(d.usedFor ?? p.usedFor);
        this.collectors.push(() => {
          const u = usedForOf(fast.checked, acc.checked);
          this.options.usedFor = JSON.stringify(u) === def ? undefined : u;
        });
        fields.append(this.field(L('参与', 'Used for'), h('div', { class: 'checks' },
          h('label', null, fast, L('高速档（快速模式、综合第一遍）', 'Fast tier (fast mode, combined first pass)')),
          h('label', null, acc, L('精确档（精确模式、综合第二遍）', 'Accurate tier (accurate mode, combined second pass)')),
        ), undefined, null, true));
      }
      if (editable.has('weight')) {
        const defW = d.weight ?? 50;
        const r = h('input', { type: 'range', min: '0', max: '100', step: '5' }) as HTMLInputElement;
        r.value = String(o.weight ?? defW);
        const out = h('output', null, r.value);
        r.addEventListener('input', () => (out.textContent = r.value));
        this.collectors.push(() => (this.options.weight = Number(r.value) === defW ? undefined : Number(r.value)));
        fields.append(this.field(L('调度权重', 'Scheduling weight'), h('div', { class: 'range2' }, r, out), L(`越大越优先，默认 ${defW}；置顶相当于 100`, `Higher is preferred, default ${defW}; pinning equals 100`)));
      }
      if (editable.has('concurrency')) fields.append(this.field(L('并发数', 'Concurrency'), this.num(o.concurrency, d.concurrency, 1, (v) => (this.options.concurrency = v)), L('同时进行的请求数', 'Requests in flight at once')));
      if (editable.has('qps')) fields.append(this.field(L('每秒请求数上限', 'Max requests per second'), this.num(o.qps, d.qps, 1, (v) => (this.options.qps = v))));
      if (editable.has('maxChars')) fields.append(this.field(L('每次最多字符', 'Max characters per request'), this.num(o.maxChars, d.maxChars, 100, (v) => (this.options.maxChars = v)), L('一次请求合并多少文字', 'How much text one request may batch')));
      cards.push(h('div', { class: 'pv-card' }, h('h3', null, L('调度', 'Scheduling')), fields));
    }

    // 额度
    if (editable.has('quota')) {
      const dq = d.quota;
      const q = o.quota;
      const amount = this.num(q?.amount, dq?.amount, 1, () => {});
      const unit = h('select') as HTMLSelectElement;
      for (const [k, v] of Object.entries(UNIT)) unit.append(h('option', { value: k, selected: (q?.unit ?? dq?.unit ?? 'char') === k }, v));
      const period = h('select') as HTMLSelectElement;
      for (const [k, v] of Object.entries(PERIOD)) period.append(h('option', { value: k, selected: (q?.period ?? dq?.period ?? 'month') === k }, v));
      this.collectors.push(() => {
        const a = amount.value.trim();
        this.options.quota = a === '' ? undefined : { amount: Number(a), unit: unit.value as QuotaInfo['unit'], period: period.value as QuotaInfo['period'] };
      });
      const def = dq ? L(`默认 ${wan(dq.amount)} ${UNIT[dq.unit]} / ${PERIOD[dq.period]}`, `Default ${wan(dq.amount)} ${UNIT[dq.unit]} / ${PERIOD[dq.period]}`) : L('适配器没有默认免费额度', 'The adapter has no default free quota');
      cards.push(h('div', { class: 'pv-card' },
        h('h3', null, L('免费额度', 'Free quota'), h('small', null, L('按你账号的实际额度填写，调度会据此决定用多少；留空用默认', 'Enter your account’s actual quota; scheduling uses it to decide how much to send. Leave empty for the default'))),
        h('div', { class: 'fields' },
          this.field(L('额度', 'Quota'), amount, def + L('；填 0 表示没有免费额度', '; 0 means no free quota')),
          this.field(L('单位', 'Unit'), unit),
          this.field(L('周期', 'Period'), period),
        ),
      ));
    }

    // 提示词
    if (editable.has('prompt') || editable.has('temperature')) {
      const fields = h('div', { class: 'fields' });
      if (editable.has('prompt')) {
        const t = h('textarea', { placeholder: d.prompt ?? '', spellcheck: 'false' }) as HTMLTextAreaElement;
        t.value = o.prompt ?? '';
        this.collectors.push(() => (this.options.prompt = t.value.trim() || undefined));
        fields.append(this.field(L('提示词', 'Prompt'), t, L('留空使用默认（占位文字即默认提示词）。可用变量 {{from}} {{to}} {{text}} {{context}}；必须要求模型原样保留 <g0></g0>、<x0/> 这类标记', 'Leave empty for the default (shown as placeholder). Variables: {{from}} {{to}} {{text}} {{context}}; it must tell the model to keep markers like <g0></g0> and <x0/> unchanged'), null, true));
      }
      if (editable.has('temperature')) fields.append(this.field('temperature', this.num(o.temperature, d.temperature, 0.1, (v) => (this.options.temperature = v))));
      cards.push(h('div', { class: 'pv-card' }, h('h3', null, L('提示词', 'Prompt')), fields));
    }

    // 操作栏
    const save = h('button', { class: 'btn primary', type: 'button' }, L('保存', 'Save'));
    const saveTest = h('button', { class: 'btn', type: 'button' }, L('保存并测试', 'Save and test'));
    save.addEventListener('click', () => void this.save(false));
    saveTest.addEventListener('click', () => void this.save(true));
    const bar = h('div', { class: 'bar' }, save, saveTest, this.msg, h('span', { class: 'grow' }));
    if (p.custom) {
      const del = h('button', { class: 'btn danger', type: 'button' }, L('删除此服务', 'Delete this service'));
      del.addEventListener('click', async () => {
        if (!confirm(L(`删除「${p.name}」？`, `Delete “${p.name}”?`))) return;
        try {
          await rpc('providers:remove', { id: p.id });
          await this.hooks.removed();
        } catch (e) {
          this.say('bad', L('删除失败：', 'Delete failed: ') + String((e as Error).message));
        }
      });
      bar.append(del);
    }
    this.enabled.addEventListener('change', () => void this.save(false));

    this.el = h('div', { class: 'pv-detail' }, ...cards, bar);
    this.el.addEventListener('input', () => this.markDirty());
    this.el.addEventListener('change', () => this.markDirty());
    this.initial = this.snapshot();
  }

  setStatus(st: ProviderStatus | undefined) {
    this.statsEl.textContent = '';
    if (!st) {
      this.statsEl.style.display = 'none';
      return;
    }
    this.statsEl.style.display = '';
    const [label, ic, color] = HEALTH[st.health];
    const badge = h('span', { class: 'badge', 'data-icon': ic }, label);
    badge.style.setProperty('--st', color);
    const stat = (k: string, v: Node | string) => h('div', null, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
    this.statsEl.append(
      stat(L('状态', 'Status'), badge),
      stat(L('排名', 'Rank'), st.rank ? L(`第 ${st.rank}`, `#${st.rank}`) : '—'),
      stat(L('延迟 P50', 'Latency P50'), st.latencyP50Ms ? `${st.latencyP50Ms} ms` : '—'),
      stat(L('成功率', 'Success rate'), st.successRate !== undefined ? `${(st.successRate * 100).toFixed(1)}%` : '—'),
      stat(L('本期用量', 'Usage this period'), st.quota ? `${wan(st.quota.used)} / ${wan(st.quota.amount)} ${UNIT[st.quota.unit]}` : L('不限量', 'Unlimited')),
    );
    if (st.lastError) this.statsEl.append(stat(L('最近错误', 'Last error'), h('span', { style: 'color:var(--critical);font-weight:500' }, st.lastError.message)));
  }

  dirty(): boolean {
    return this.snapshot() !== this.initial;
  }

  private snapshot(): string {
    this.collect();
    return JSON.stringify([this.enabled.checked, this.nameInput?.value, this.config, this.options]);
  }

  private collect() {
    this.config = {};
    this.options = {};
    for (const c of this.collectors) c();
  }

  private markDirty() {
    if (this.dirty()) this.say('', L('有未保存的修改', 'Unsaved changes'));
    else if (this.msg.textContent === L('有未保存的修改', 'Unsaved changes')) this.say('', '');
  }

  say(kind: '' | 'ok' | 'bad', text: string) {
    this.msg.className = 'msg' + (kind ? ' ' + kind : '');
    this.msg.textContent = text;
  }

  private async save(test: boolean) {
    this.collect();
    this.say('', L('正在保存…', 'Saving…'));
    try {
      await rpc('providers:save', {
        id: this.p.id,
        enabled: this.enabled.checked,
        config: { ...this.config },
        ...(this.p.editable ? { options: { ...this.options } } : {}),
        ...(this.nameInput ? { name: this.nameInput.value.trim() || this.p.name } : {}),
      });
      this.initial = this.snapshot();
    } catch (e) {
      this.say('bad', L('保存失败：', 'Save failed: ') + String((e as Error).message));
      return;
    }
    let flash: Flash = ['ok', L('已保存', 'Saved')];
    if (test) {
      this.say('', L('已保存，正在测试…', 'Saved, testing…'));
      try {
        const settings = await loadUiSettings();
        const direction = this.p.kind === 'builtin' ? builtinTestPair(settings.targetLang) : { sourceLang: settings.sourceLang, targetLang: settings.targetLang };
        const r = await rpc('providers:test', { id: this.p.id, ...direction });
        flash = r.ok ? ['ok', L(`✓ 已保存，可用，延迟 ${r.latencyMs ?? '?'} ms`, `✓ Saved and working, latency ${r.latencyMs ?? '?'} ms`)] : ['bad', L(`✕ 已保存，但不可用：${r.error?.message ?? '未知错误'}`, `✕ Saved, but not working: ${r.error?.message ?? 'unknown error'}`)];
      } catch (e) {
        flash = ['bad', '✕ ' + String((e as Error).message)];
      }
    }
    // 重新读取列表：分组、名称、默认值可能都变了
    await this.hooks.reload(this.p.id, flash).catch(() => this.say(flash[0], flash[1]));
  }

  private field(label: string, control: Node, hint?: string, extra?: Node | null, wide = false): HTMLElement {
    return h('label', { class: 'field' + (wide ? ' wide' : '') },
      h('span', { class: 'lab' }, label, extra ?? null),
      control,
      hint ? h('span', { class: 'hint' }, hint) : null,
    );
  }

  private text(type: string, value: string | undefined, placeholder: string | undefined, set: (v: string) => void): HTMLInputElement {
    const i = h('input', { type, placeholder: placeholder ? L(`默认 ${placeholder}`, `Default ${placeholder}`) : '', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
    i.value = value ?? '';
    this.collectors.push(() => set(i.value.trim()));
    return i;
  }

  private num(value: number | undefined, placeholder: number | undefined, step: number, set: (v: number | undefined) => void): HTMLInputElement {
    const i = h('input', { type: 'number', step: String(step), min: '0', placeholder: placeholder !== undefined ? L(`默认 ${placeholder}`, `Default ${placeholder}`) : '' }) as HTMLInputElement;
    i.value = value !== undefined ? String(value) : '';
    this.collectors.push(() => set(i.value.trim() === '' ? undefined : Number(i.value)));
    return i;
  }
}
