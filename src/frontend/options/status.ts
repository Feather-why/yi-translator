/**
 * 「服务状态」页：订阅后端的 tx:status 端口，每 5 秒刷新。
 * - 顶部：当前在用的服务、首屏耗时、剩余免费额度、同步；
 * - 额度总览：每家服务在全部免费额度里占多少（宽度），以及还剩多少（实心部分）；
 * - 排名表：按调度排名列出每家的状态、延迟、成功率、额度、适配器文件，可置顶/暂停/检测；
 * - 模型节点：本机与远程主机的在线状态、显存（本机对照 2 GB 预算）、速度；
 * - 最近事件。
 */
import {
  PORT_STATUS,
  type ModelNodeStatus,
  type ProviderHealth,
  type ProviderStatus,
  type QuotaInfo,
  type StatusClientMsg,
  type StatusServerMsg,
  type StatusSnapshot,
} from '../../shared/protocol';
import { h } from '../ui/host';
import { rpc } from '../../shared/rpc';
import { PERF_LOG_KEY, parsePerfLog, type PerfEntry } from '../content/perf';
import { L } from '../i18n';
import { wan } from '../ui/palette';
import { loadUiSettings } from '../../shared/settings';
import { builtinTestPair } from './builtin-pack';
import { patchStatusChildren } from './status-patch';

const CSS = `
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; }
.tile .k { color: var(--muted); font-size: 12.5px; }
.tile .v { font-size: 20px; font-weight: 650; margin-top: 2px; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.tile .v.name { font-size: 15.5px; line-height: 1.35; margin-top: 5px; }
.tile .sub { color: var(--muted); font-size: 12px; margin-top: 1px; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
.qtitle { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.qtitle .note { color: var(--muted); font-size: 12px; }
.qbar { display: flex; gap: 2px; height: 22px; margin: 10px 0 12px; }
.qseg { position: relative; min-width: 6px; background: color-mix(in srgb, var(--c) 22%, var(--surface)); overflow: hidden; cursor: default; }
.qseg:first-child { border-radius: 4px 0 0 4px; }
.qseg:last-child { border-radius: 0 4px 4px 0; }
.qseg:only-child { border-radius: 4px; }
.qseg .rem { position: absolute; inset: 0 auto 0 0; background: var(--c); }
.qseg:hover { filter: brightness(1.08); }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12.5px; color: var(--ink-2); }
.legend .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; background: var(--c); margin-right: 6px; vertical-align: -1px; }
.legend b { color: var(--ink); font-weight: 600; }
.qempty { color: var(--muted); font-size: 13px; margin: 8px 0 4px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 9px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
th.num { text-align: right; }
td .err { color: var(--critical); font-size: 12px; margin-top: 2px; }
/* 「检测」的结果：名字下面一枚小标签（和名字对齐），成功是淡绿底 + 延迟，失败是淡红底 + 一行原因（全文在鼠标提示里） */
td .chk { display: inline-flex; align-items: center; gap: 6px; margin: 5px 0 0 16px; padding: 0 9px 0 7px; border-radius: 99px; font-size: 11.5px; line-height: 20px;
  max-width: 300px; background: var(--hover); color: var(--ink-2); font-variant-numeric: tabular-nums; }
td .chk i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); flex: none; }
td .chk.ok { background: color-mix(in srgb, var(--good) 11%, transparent); }
td .chk.ok i { background: var(--good); }
td .chk.bad { background: color-mix(in srgb, var(--critical) 9%, transparent); color: color-mix(in srgb, var(--critical) 85%, var(--ink)); }
td .chk.bad i { background: var(--critical); }
td .chk .m { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
td .chk .t { color: var(--muted); flex: none; }
td .chk.busy i { animation: chk-pulse 1s ease-in-out infinite; }
@keyframes chk-pulse { 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) { td .chk.busy i { animation: none; } }
.head-acts { display: inline-flex; gap: 8px; margin-left: 12px; vertical-align: middle; }
.quota-note { font-size: 12px; color: var(--muted); margin: 6px 2px 0; }
td .file { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; color: var(--muted); }
td.rank { font-weight: 650; width: 36px; color: var(--ink-2); }
tr.active td.rank { color: var(--accent); }
.name-cell { display: flex; align-items: center; gap: 8px; }
.dotc { width: 8px; height: 8px; border-radius: 2px; background: var(--c, transparent); flex: none; }
.badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; padding: 1px 8px; border-radius: 99px; white-space: nowrap; color: var(--ink); background: color-mix(in srgb, var(--st) 16%, transparent); }
.badge::before { content: attr(data-icon); color: var(--st); font-weight: 700; }
.meter { width: 90px; height: 4px; border-radius: 2px; background: var(--hover); overflow: hidden; margin-top: 4px; margin-left: auto; }
.meter i { display: block; height: 100%; background: var(--seq); border-radius: 2px; }
.acts { display: flex; gap: 4px; justify-content: flex-end; }
.acts .btn { white-space: nowrap; padding: 2px 8px; font-size: 12px; }
td .file { white-space: nowrap; }
.chip { font-size: 11px; padding: 0 7px; border-radius: 99px; background: var(--hover); color: var(--ink-2); white-space: nowrap; }
.nodes { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.node { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.node .top { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.node .model { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--ink-2); margin-top: 6px; }
.vram { margin-top: 10px; font-size: 12px; color: var(--muted); }
.vram .track { position: relative; height: 8px; border-radius: 4px; background: var(--hover); margin-top: 4px; }
.vram .fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: var(--seq); }
.vram .budget { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--ink-2); border-radius: 1px; }
.events { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.events li { display: grid; grid-template-columns: 54px 22px 1fr; padding: 6px 0; border-bottom: 1px solid var(--line); }
.events li:last-child { border-bottom: 0; }
.events time { color: var(--muted); font-variant-numeric: tabular-nums; }
.tip { position: fixed; pointer-events: none; z-index: 10; background: var(--surface); color: var(--ink); border: 1px solid var(--line);
  border-radius: 8px; padding: 8px 10px; font-size: 12.5px; box-shadow: 0 8px 24px -6px rgba(0,0,0,.25); display: none; min-width: 180px; }
.tip .t { font-weight: 600; margin-bottom: 2px; }
.tip .r { display: flex; justify-content: space-between; gap: 16px; color: var(--ink-2); }
.tip .r span:last-child { font-variant-numeric: tabular-nums; color: var(--ink); }
.conn { color: var(--muted); font-size: 12.5px; }
.diag { margin-top: 26px; }
.diag > summary { cursor: pointer; color: var(--muted); font-size: 13px; padding: 6px 0; list-style: none; display: flex; gap: 10px; align-items: baseline; }
.diag > summary::-webkit-details-marker { display: none; }
.diag > summary::before { content: '▸'; font-size: 11px; transition: transform .15s; }
.diag[open] > summary::before { transform: rotate(90deg); }
.diag > summary .sum { font-size: 12px; opacity: .85; font-variant-numeric: tabular-nums; }
.diag-lead { color: var(--muted); font-size: 12.5px; margin: 4px 0 8px; }
.pf { display: grid; gap: 7px; }
.pf .legend { margin: 0 0 6px; }
.pf .pr { display: grid; grid-template-columns: minmax(120px, 190px) 1fr 92px; gap: 12px; align-items: center; font-size: 12.5px; }
.pf .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
.pf .who small { color: var(--muted); margin-left: 6px; }
.pf .track { position: relative; height: 12px; border-radius: 4px; background: var(--hover); }
.pf .segs { position: absolute; inset: 0; display: flex; gap: 2px; height: 100%; }
.pf .segs > div { flex: none; }
.pf .segs > div { height: 100%; border-radius: 3px; min-width: 2px; }
.pf .mark { position: absolute; top: -3px; bottom: -3px; width: 2px; border-radius: 1px; background: var(--ink); opacity: .55; }
.pf .num { text-align: right; font-variant-numeric: tabular-nums; color: var(--ink); font-weight: 600; }
.pf .num small { display: block; font-weight: 400; color: var(--muted); font-size: 11px; }
.pf .empty { color: var(--muted); font-size: 12.5px; padding: 6px 0; }
.pf .note { color: var(--muted); font-size: 12px; margin-top: 4px; }
`;

const HEALTH: Record<ProviderHealth, [string, string, string]> = {
  ok: [L('正常', 'OK'), '✓', 'var(--good)'],
  degraded: [L('波动', 'Unstable'), '!', 'var(--warning)'],
  error: [L('出错', 'Error'), '✕', 'var(--critical)'],
  exhausted: [L('额度用尽', 'Quota used up'), '◔', 'var(--serious)'],
  disabled: [L('已停用', 'Disabled'), '–', 'var(--muted)'],
  unconfigured: [L('未配置', 'Not set up'), '○', 'var(--muted)'],
};
const PERIOD: Record<QuotaInfo['period'], string> = { day: L('日', 'day'), month: L('月', 'month'), cycle: L('周期', 'cycle') };
const UNIT: Record<QuotaInfo['unit'], string> = { char: L('字符', 'chars'), token: 'token', request: L('次请求', 'requests') };
const SERIES = 8;
const LOCAL_VRAM_BUDGET_MB = 2048;

function ago(t?: number): string {
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return L('刚刚', 'just now');
  if (s < 3600) return Math.round(s / 60) + L(' 分钟前', ' min ago');
  if (s < 86400) return Math.round(s / 3600) + L(' 小时前', ' h ago');
  return Math.round(s / 86400) + L(' 天前', ' d ago');
}

function until(t?: number): string {
  if (!t) return '—';
  const d = new Date(t);
  return L(`${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, `${d.toLocaleDateString('en', { month: 'short', day: 'numeric' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
}

/** 日额度按 30 天折算成月，便于把不同周期的服务放在同一条里比较。 */
function monthly(q: QuotaInfo): number {
  return q.period === 'day' ? q.amount * 30 : q.amount;
}

export function mountStatus(main: HTMLElement): () => void {
  const style = document.createElement('style');
  style.textContent = CSS;
  const conn = h('span', { class: 'conn' }, L('正在连接后台…', 'Connecting to the background…'));
  const body = h('div', { class: 'viz' });
  const tip = h('div', { class: 'tip', role: 'tooltip' });
  main.append(style, h('h1', null, L('服务状态 ', 'Status '), conn), h('p', { class: 'lead' }, L('混合调度会按速度、成功率和剩余额度给各家排名；额度快用完时自动换下一家。', 'Combined scheduling ranks the services by speed, success rate and remaining quota; when one is nearly out of quota, the next takes over.')), body, tip);

  let port: chrome.runtime.Port | null = null;
  let closed = false;
  let retry = 0;
  const colorOf = new Map<string, string>();

  const send = (m: StatusClientMsg) => {
    try {
      port?.postMessage(m);
    } catch {
      /* 端口刚断开，重连后会自动刷新 */
    }
  };

  /**
   * 「检测」：后台的健康检查（probe）只看连得通、顺便从账户同步额度，不会改延迟和成功率（那两项只用真实翻译的样本）。
   * 所以这里同时真的翻一句测试（providers:test），把这一次的结果直接写在这一行下面，按了就有反应。
   */
  const checks = new Map<string, { state: 'busy' | 'ok' | 'bad'; ms?: number; msg?: string; at: number }>();
  let last: StatusSnapshot | null = null;
  const rerender = () => last && render(last);
  const check = async (id: string, translate = true) => {
    if (checks.get(id)?.state === 'busy') return;
    checks.set(id, { state: 'busy', at: Date.now() });
    rerender();
    send({ type: 'probe', providerId: id });
    if (!translate) {
      checks.delete(id);
      rerender();
      return;
    }
    const settings = await loadUiSettings();
    const pair = last?.providers.find((p) => p.id === id)?.kind === 'builtin' ? builtinTestPair(settings.targetLang) : { sourceLang: settings.sourceLang, targetLang: settings.targetLang };
    const r = await rpc('providers:test', { id, ...pair }).catch((e) => ({ ok: false, latencyMs: undefined, error: { message: String((e as Error).message) } }));
    checks.set(id, r.ok
      ? { state: 'ok', ms: r.latencyMs ? Math.round(r.latencyMs) : undefined, at: Date.now() }
      : { state: 'bad', msg: r.error?.message ?? L('不可用', 'not working'), at: Date.now() });
    rerender();
  };
  const checkAll = async () => {
    const ps = (last?.providers ?? []).filter((p) => p.enabled && p.configured && p.official);
    // 浏览器内置翻译只做健康检查：真翻一句可能会弹出下载语言包的页面
    const queue = [...ps];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) await check(p.id, p.kind !== 'builtin');
    };
    await Promise.all([worker(), worker(), worker()]);
  };
  const checkPill = (c: { state: 'busy' | 'ok' | 'bad'; ms?: number; msg?: string; at: number }) => {
    const when = new Date(c.at).toLocaleTimeString(L('zh-CN', 'en'), { hour12: false });
    if (c.state === 'busy') return h('div', null, h('span', { class: 'chk busy', role: 'status' }, h('i'), L('检测中', 'Checking')));
    if (c.state === 'ok') {
      return h('div', null, h('span', { class: 'chk ok', role: 'status', title: L(`刚才检测：可用${c.ms ? ` · 这次 ${c.ms} ms` : ''} · ${when}`, `Checked: works${c.ms ? ` · ${c.ms} ms this time` : ''} · ${when}`) },
        h('i'), c.ms ? `${c.ms} ms` : L('可用', 'Works'), h('span', { class: 't' }, ago(c.at))));
    }
    return h('div', null, h('span', { class: 'chk bad', role: 'status', title: L(`刚才检测：不可用 · ${when}\n`, `Checked: not working · ${when}\n`) + (c.msg ?? '') },
      h('i'), h('span', { class: 'm' }, c.msg ?? ''), h('span', { class: 't' }, ago(c.at))));
  };
  const allBtn = h('button', { class: 'btn small', type: 'button', title: L('把已启用的服务都检测一遍（每家真翻一句测试文字，并从账户同步剩余额度）', 'Check every enabled service (translates one test sentence each and syncs remaining quota from the account)') }, L('全部检测', 'Check all'));
  allBtn.addEventListener('click', async () => {
    allBtn.disabled = true;
    await checkAll();
    allBtn.disabled = false;
  });
  main.querySelector('h1')?.append(h('span', { class: 'head-acts' }, allBtn));

  // 剩余额度自动同步：打开这页时、之后每 5 分钟，请后台做一次健康检查（能查账户的服务会顺便同步实际用量）
  let synced = false;
  const syncTimer = window.setInterval(() => send({ type: 'probe' }), 5 * 60_000);

  const connect = () => {
    if (closed) return;
    port = chrome.runtime.connect({ name: PORT_STATUS });
    port.onMessage.addListener((m: StatusServerMsg) => {
      if (m.type !== 'snapshot') return;
      conn.textContent = L('· 更新于 ', '· updated ') + new Date(m.status.at).toLocaleTimeString('zh-CN', { hour12: false });
      last = m.status;
      render(m.status);
      if (!synced) {
        synced = true;
        send({ type: 'probe' });
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      if (closed) return;
      conn.textContent = L('· 与后台断开，正在重连…', '· disconnected from the background, reconnecting…');
      window.setTimeout(connect, Math.min(5000, 500 * ++retry));
    });
  };

  const assignColors = (providers: ProviderStatus[]) => {
    // 颜色跟着服务走，不跟排名走：按 id 排序后固定分配，超过 8 家的归入「其他」
    const ids = providers.filter((p) => p.quota).map((p) => p.id).sort();
    ids.forEach((id) => {
      if (!colorOf.has(id)) colorOf.set(id, colorOf.size < SERIES ? `var(--s${colorOf.size + 1})` : 'var(--other)');
    });
  };

  const showTip = (e: MouseEvent, title: string, rows: [string, string][]) => {
    tip.replaceChildren(h('div', { class: 't' }, title), ...rows.map(([k, v]) => h('div', { class: 'r' }, h('span', null, k), h('span', null, v))));
    tip.style.display = 'block';
    const x = Math.min(window.innerWidth - tip.offsetWidth - 12, e.clientX + 14);
    tip.style.left = `${x}px`;
    tip.style.top = `${e.clientY + 16}px`;
  };
  const hideTip = () => (tip.style.display = 'none');

  // 首屏耗时：内容脚本每次整页翻译记一条，存在本机；和后台快照分开刷新
  const perfBox = h('div');
  // 普通用户不需要看：放在页面最下面、默认收起
  const perfSummary = h('span', { class: 'sum' });
  const perfDetails = h('details', { class: 'diag' }, h('summary', null, L('诊断：最近几次首屏耗时', 'Diagnostics: recent first-screen times'), perfSummary), perfBox);
  const renderPerf = async () => {
    let list: PerfEntry[] = [];
    try {
      const got: Record<string, unknown> = await chrome.storage.local.get(PERF_LOG_KEY);
      list = parsePerfLog(got[PERF_LOG_KEY]);
    } catch { /* ignore */ }
    perfBox.replaceChildren(...perfPanel(list.slice(0, 8)));
    const med = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    const recent = list.slice(0, 8);
    const firsts = recent.map((e) => e.firstMs).filter((x): x is number => x !== undefined);
    perfSummary.textContent = recent.length
      ? L(`中位 首字 ${firsts.length ? fmtMs(med(firsts)) : '—'} · 出齐 ${fmtMs(med(recent.map((e) => e.finalMs)))}（最近 ${recent.length} 次）`, `Median first text ${firsts.length ? fmtMs(med(firsts)) : '—'} · all done ${fmtMs(med(recent.map((e) => e.finalMs)))} (last ${recent.length})`)
      : L('还没有记录', 'Nothing recorded yet');
  };
  const onStore = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[PERF_LOG_KEY]) void renderPerf();
  };
  chrome.storage.onChanged.addListener(onStore);
  void renderPerf();

  function render(st: StatusSnapshot) {
    assignColors(st.providers);
    const group = (key: string, nodes: HTMLElement[]) => h('div', { 'data-status-key': key, style: 'display:contents' }, ...nodes);
    patchStatusChildren(body, [group('tiles', [tiles(st)]), group('quota', quotaPanels(st)), group('providers', rankTables(st)),
      group('nodes', nodesPanel(st.nodes)), group('events', eventsPanel(st)), perfDetails]);
  }

  function perfPanel(list: PerfEntry[]): HTMLElement[] {
    const PARTS = [
      { key: 'prep', label: L('准备', 'Prepare'), c: 'var(--s1)', tip: L('查站点规则、找段落、发出请求', 'Site rules, finding paragraphs, sending requests') },
      { key: 'queue', label: L('排队', 'Queue'), c: 'var(--s4)', tip: L('后台排队、等空闲的并发槽、查缓存', 'Background queue, waiting for a free slot, cache lookup') },
      { key: 'prov', label: L('翻译', 'Translate'), c: 'var(--s3)', tip: L('翻译服务本身的耗时（最慢的那一段）', 'Time spent by the translation service itself (slowest segment)') },
      { key: 'rest', label: L('其他', 'Other'), c: 'var(--other)', tip: L('传输、重试、显示', 'Transfer, retries, rendering') },
    ] as const;
    const head = h('p', { class: 'diag-lead' }, L('整页翻译时，从点下悬浮球到首屏译文出齐，时间花在了哪里（只存在本机）。', 'For whole-page translation: where the time went from clicking the ball until the first screen is fully translated (stored only on this device).'));
    if (!list.length) {
      return [head, h('div', { class: 'panel pf' }, h('div', { class: 'empty' }, L('还没有记录。打开任意网页点一下悬浮球翻译，这里会显示时间都花在了哪里。', 'Nothing recorded yet. Open any page and click the ball to translate; this shows where the time went.')))];
    }
    const max = Math.max(...list.map((e) => e.finalMs), 1);
    const legend = h('div', { class: 'legend' });
    for (const p of PARTS) legend.append(h('span', { title: p.tip }, h('span', { class: 'sw', style: `--c:${p.c}` }), p.label));
    legend.append(h('span', null, h('span', { class: 'sw', style: '--c:var(--ink);width:2px;opacity:.55' }), L('第一段出字', 'First text')));
    const rows = list.map((e) => {
      const prep = Math.min(e.prepareMs, e.finalMs);
      const hasSplit = e.queueMs !== undefined || e.providerMs !== undefined;
      const queue = hasSplit ? Math.max(0, e.queueMs ?? 0) : 0;
      const prov = hasSplit ? Math.max(0, e.providerMs ?? 0) : 0;
      const rest = Math.max(0, e.finalMs - prep - queue - prov);
      const vals: Record<string, number> = { prep, queue, prov, rest };
      const segs = h('div', { class: 'segs' });
      for (const p of PARTS) {
        const v = vals[p.key];
        if (v <= 0) continue;
        const d = h('div');
        d.style.width = `${(v / max) * 100}%`;
        d.style.background = !hasSplit && p.key === 'rest' ? 'var(--s7)' : p.c;
        segs.append(d);
      }
      const track = h('div', { class: 'track' }, segs);
      if (e.firstMs !== undefined) {
        const m = h('div', { class: 'mark' });
        m.style.left = `calc(${(Math.min(e.firstMs, max) / max) * 100}% - 1px)`;
        track.append(m);
      }
      const modeName = e.mode === 'fast' ? L('快速', 'Fast') : e.mode === 'accurate' ? L('精确', 'Accurate') : L('综合', 'Combined');
      const row = h('div', { class: 'pr' },
        h('div', { class: 'who', title: e.host }, e.host, h('small', null, L(`${modeName} · ${e.segments} 段`, `${modeName} · ${e.segments} segments`))),
        track,
        h('div', { class: 'num' }, fmtMs(e.finalMs), h('small', null, e.firstMs !== undefined ? L(`首字 ${fmtMs(e.firstMs)}`, `First text ${fmtMs(e.firstMs)}`) : '')));
      const tipRows: [string, string][] = [
        [L('准备', 'Prepare'), fmtMs(prep) + (e.ruleCached ? L('（规则已缓存）', ' (rules cached)') : '')],
        ...(hasSplit ? [[L('排队', 'Queue'), fmtMs(queue)], [L('翻译', 'Translate'), fmtMs(prov)], [L('其他', 'Other'), fmtMs(rest)]] as [string, string][] : [[L('后台（未拆分）', 'Background (not split)'), fmtMs(e.finalMs - prep)]] as [string, string][]),
        ...(e.firstMs !== undefined ? [[L('第一段出字', 'First text'), fmtMs(e.firstMs)]] as [string, string][] : []),
        ...(e.fastMs !== undefined ? [[L('快速译文出齐', 'Fast translation done'), fmtMs(e.fastMs)]] as [string, string][] : []),
        [L('最终译文出齐', 'Final translation done'), fmtMs(e.finalMs)],
        [L('缓存命中', 'Cache hits'), `${e.cached} / ${e.segments}`],
        ...(e.streamed ? [[L('流式输出', 'Streamed'), L(`${e.streamed} 段`, `${e.streamed} segments`)]] as [string, string][] : []),
        ...(e.retries ? [[L('格式重试', 'Format retries'), L(`${e.retries} 次`, `${e.retries}×`)]] as [string, string][] : []),
        ...(e.errors ? [[L('失败', 'Failed'), L(`${e.errors} 段`, `${e.errors} segments`)]] as [string, string][] : []),
      ];
      row.addEventListener('mousemove', (ev) => showTip(ev, `${e.host} · ${new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}`, tipRows));
      row.addEventListener('mouseleave', hideTip);
      return row;
    });
    const slow = list[0];
    const advice = slow.prepareMs > 300 ? L('准备阶段偏长：通常是后台刚被唤醒。把鼠标先移到悬浮球上会提前唤醒。', 'Long prepare phase: usually the background had just woken up. Hovering the ball first wakes it in advance.')
      : slow.queueMs !== undefined && slow.providerMs !== undefined && slow.queueMs > slow.providerMs ? L('排队比翻译本身还久：同时翻译的段落太多、并发槽不够。', 'Queueing took longer than translating: too many paragraphs at once for the available slots.')
      : '';
    return [head, h('div', { class: 'panel pf' }, legend, ...rows, advice ? h('div', { class: 'note' }, advice) : null)];
  }

  function tiles(st: StatusSnapshot): HTMLElement {
    const pick = (mode: 'fast' | 'accurate') =>
      st.providers.filter((p) => p.active && p.usedFor.includes(mode)).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0];
    const fast = pick('fast');
    const acc = pick('accurate');
    const charQ = st.providers.filter((p) => p.quota?.unit === 'char' && p.enabled && p.configured && p.health !== 'disabled' && p.health !== 'unconfigured');
    const left = charQ.reduce((s, p) => s + Math.max(0, p.quota!.amount - p.quota!.used), 0);
    const tile = (k: string, v: string, sub?: string, name = false) =>
      h('div', { class: 'tile' }, h('div', { class: 'k' }, k), h('div', { class: name ? 'v name' : 'v' }, v), sub ? h('div', { class: 'sub' }, sub) : null);
    return h('div', { class: 'tiles' },
      tile(L('高速服务', 'Fast service'), fast?.name ?? L('无', 'None'), fast?.latencyP50Ms ? `P50 ${fast.latencyP50Ms} ms` : undefined, true),
      tile(L('精确服务', 'Accurate service'), acc?.name ?? L('无', 'None'), acc?.latencyP50Ms ? `P50 ${acc.latencyP50Ms} ms` : undefined, true),
      tile(L('首屏出译文', 'First screen translated'), st.perf?.firstScreenMsP50 ? `${st.perf.firstScreenMsP50} ms` : '—', st.perf ? L(`中位数 · ${st.perf.samples} 次`, `median · ${st.perf.samples} runs`) : undefined),
      tile(L('剩余免费字符', 'Free characters left'), wan(left), L('各服务当前周期合计', 'All services, current period')),
      tile(L('同步', 'Sync'), st.sync?.lastError ? L('失败', 'Failed') : ago(st.sync?.lastSyncAt), st.sync?.lastError ?? 'WebDAV'),
    );
  }

  function quotaPanels(st: StatusSnapshot): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const unit of ['char', 'token', 'request'] as const) {
      const ps = st.providers.filter((p) => p.quota?.unit === unit && p.configured && p.health !== 'unconfigured').sort((a, b) => monthly(b.quota!) - monthly(a.quota!));
      if (!ps.length) continue;
      const total = ps.reduce((s, p) => s + monthly(p.quota!), 0);
      const bar = h('div', { class: 'qbar', role: 'img', 'aria-label': L(`免费额度构成（${UNIT[unit]}）`, `Free quota breakdown (${UNIT[unit]})`) });
      const legend = h('div', { class: 'legend' });
      for (const p of ps) {
        const q = p.quota!;
        const share = monthly(q) / total;
        const remain = Math.max(0, 1 - q.used / Math.max(1, q.amount));
        const c = colorOf.get(p.id) ?? 'var(--other)';
        const seg = h('div', { class: 'qseg' });
        seg.style.setProperty('--c', c);
        seg.style.flexGrow = String(share);
        const rem = h('div', { class: 'rem' });
        rem.style.width = `${remain * 100}%`;
        seg.append(rem);
        const rows: [string, string][] = [
          [L('占总额度', 'Share of total'), `${(share * 100).toFixed(1)}%`],
          [L('本期额度', 'Quota this period'), `${wan(q.amount)} / ${PERIOD[q.period]}`],
          [L('已用', 'Used'), `${wan(q.used)}（${Math.round((q.used / Math.max(1, q.amount)) * 100)}%）`],
          [L('剩余', 'Left'), wan(Math.max(0, q.amount - q.used))],
          [L('重置', 'Resets'), until(q.resetAt)],
          [L('状态', 'Status'), HEALTH[p.health][0]],
        ];
        seg.onmousemove = (e) => showTip(e, p.name, rows);
        seg.onmouseleave = hideTip;
        bar.append(seg);
        const sw = h('span', { class: 'sw' });
        sw.style.setProperty('--c', c);
        legend.append(h('span', null, sw, h('b', null, p.name), L(` ${Math.round(share * 100)}% · 剩 ${Math.round(remain * 100)}%`, ` ${Math.round(share * 100)}% · ${Math.round(remain * 100)}% left`)));
      }
      const hasDaily = ps.some((p) => p.quota!.period === 'day');
      out.push(
        h('h2', null, L(`免费额度总览（${UNIT[unit]}）`, `Free quota overview (${UNIT[unit]})`)),
        h('div', { class: 'panel' },
          h('div', { class: 'qtitle' },
            h('span', null, L(`合计约 ${wan(total)} ${UNIT[unit]} / 月`, `about ${wan(total)} ${UNIT[unit]} / month in total`)),
            h('span', { class: 'note' }, L('宽度 = 占总额度的比例 · 实心 = 本期还剩的部分', 'Width = share of the total · solid = what is left this period') + (hasDaily ? L(' · 日额度按 30 天折算', ' · daily quotas counted as 30 days') : '')),
          ),
          bar,
          legend,
          h('p', { class: 'quota-note' }, L('剩余额度怎么来的：能查询账户的服务（如 DeepL）打开这页时和每 5 分钟会自动从账户同步实际用量，点「检测」也会同步；其他服务按扩展自己发出的字数累计（开了 WebDAV 同步会合并几台电脑的计数），在服务商网页或别的程序里用掉的算不进来。', 'Where the remaining numbers come from: services with an account API (e.g. DeepL) sync their real usage when this page opens, every 5 minutes, and on “Check”; others are counted from what the extension has sent (merged across computers if WebDAV sync is on), so usage on the provider’s website or in other apps is not included.')),
        ),
      );
    }
    return out;
  }

  function rankTables(st: StatusSnapshot): HTMLElement[] {
    // 只列在「翻译服务」里启用了的（暂停的照样列出来，好在这里点「恢复」）；没启用的只在最后提一句
    const on = st.providers.filter((p) => p.enabled);
    const off = st.providers.filter((p) => !p.enabled);
    const groups: [string, ProviderStatus[], boolean][] = [
      [L('高速池（快速 / 综合模式第一遍）', 'Fast pool (fast / combined first pass)'), on.filter((p) => p.official && p.usedFor.includes('fast')), true],
      // 后台快照里的名次是按高速档排的：精确档不显示名次，免得误会
      [L('精确（精确 / 综合模式第二遍）', 'Accurate (accurate / combined second pass)'), on.filter((p) => p.official && p.usedFor.includes('accurate')), false],
      [L('非官方', 'Unofficial'), on.filter((p) => !p.official), true],
    ];
    const out: HTMLElement[] = [];
    for (const [title, ps, ranked] of groups) {
      if (!ps.length) continue;
      ps.sort((a, b) => ranked
        ? (a.rank ?? 999) - (b.rank ?? 999) || a.name.localeCompare(b.name)
        : Number(!!b.pinned) - Number(!!a.pinned) || (a.latencyP50Ms ?? 9e9) - (b.latencyP50Ms ?? 9e9) || a.name.localeCompare(b.name));
      const tbody = h('tbody');
      for (const p of ps) tbody.append(providerRow(p, ranked));
      out.push(
        h('h2', { 'data-status-key': title + '-title' }, title),
        h('div', { class: 'panel', 'data-status-key': title, style: 'padding: 6px 10px; overflow-x: auto' },
          h('table', null,
            h('thead', null, h('tr', null,
              h('th', null, ranked ? L('排名', 'Rank') : ''), h('th', null, L('服务', 'Service')), h('th', null, L('状态', 'Status')),
              h('th', { class: 'num' }, L('延迟 P50', 'Latency P50')), h('th', { class: 'num' }, L('成功率', 'Success rate')), h('th', { class: 'num' }, L('额度', 'Quota')),
              h('th', null, L('适配器', 'Adapter')), h('th', null, ''),
            )),
            tbody,
          ),
        ),
      );
    }
    if (off.length) {
      out.push(h('p', { class: 'quota-note' },
        L(`另有 ${off.length} 个服务没有启用（${off.map((p) => p.name).join('、')}），不在这里显示；到 `, `${off.length} more services are not enabled (${off.map((p) => p.name).join(', ')}) and are not shown here; manage them under `),
        h('a', { href: '#providers' }, L('翻译服务', 'Services')), L(' 里把它们加进高速档或精确档。', '.')));
    }
    return out;
  }

  function providerRow(p: ProviderStatus, ranked = true): HTMLElement {
    const [label, ic, color] = HEALTH[p.health];
    const badge = h('span', { class: 'badge', 'data-icon': ic }, label);
    badge.style.setProperty('--st', color);
    const dot = h('span', { class: 'dotc' });
    if (colorOf.has(p.id)) dot.style.setProperty('--c', colorOf.get(p.id)!);
    const q = p.quota;
    const quotaCell = h('td', { class: 'num' });
    if (q) {
      const used = Math.min(1, q.used / Math.max(1, q.amount));
      const meter = h('div', { class: 'meter', title: L(`已用 ${Math.round(used * 100)}%`, `${Math.round(used * 100)}% used`) });
      const fill = h('i');
      fill.style.width = `${used * 100}%`;
      meter.append(fill);
      quotaCell.append(`${wan(q.used)} / ${wan(q.amount)} · ${PERIOD[q.period]}`, meter);
    } else quotaCell.append(h('span', { style: 'color:var(--muted)' }, p.kind === 'local' || p.kind === 'remote' || p.kind === 'builtin' ? L('不限量', 'Unlimited') : '—'));
    const act = (text: string, m: StatusClientMsg) => {
      const b = h('button', { class: 'btn small', type: 'button' }, text);
      b.onclick = () => send(m);
      return b;
    };
    const paused = p.health === 'disabled' || !p.enabled;
    const chk = checks.get(p.id);
    const checkBtn = h('button', { class: 'btn small', type: 'button', disabled: chk?.state === 'busy', title: L('真翻一句测试文字看能不能用、延迟多少，并从账户同步剩余额度', 'Translate one test sentence to see whether it works and how fast, and sync remaining quota from the account') }, chk?.state === 'busy' ? L('检测中…', 'Checking…') : L('检测', 'Check'));
    checkBtn.onclick = () => void check(p.id);
    return h('tr', { class: p.active ? 'active' : '', 'data-status-key': p.id },
      h('td', { class: 'rank' }, ranked && p.rank ? String(p.rank) : ranked ? '—' : ''),
      h('td', null,
        h('div', { class: 'name-cell' }, dot, h('span', null, p.name), p.active ? h('span', { class: 'chip' }, L('在用', 'Active')) : null, p.official ? null : h('span', { class: 'chip' }, L('非官方', 'Unofficial'))),
        p.lastError ? h('div', { class: 'err' }, `${p.lastError.message} · ${ago(p.lastError.at)}`) : null,
        chk ? checkPill(chk) : null,
      ),
      h('td', null, badge),
      h('td', { class: 'num' }, p.latencyP50Ms ? `${p.latencyP50Ms} ms` : '—'),
      h('td', { class: 'num' }, p.successRate !== undefined ? `${(p.successRate * 100).toFixed(1)}%` : '—'),
      quotaCell,
      h('td', null, h('div', { class: 'file', title: L('这家接口失效时，只需替换这个文件', 'If this API breaks, only this file needs replacing') }, `${p.adapter.file.split('/').pop()} @${p.adapter.version}`)),
      h('td', null, h('div', { class: 'acts' },
        act(L('置顶', 'Pin'), { type: 'provider-action', providerId: p.id, action: 'pin' }),
        act(paused ? L('恢复', 'Resume') : L('暂停', 'Pause'), { type: 'provider-action', providerId: p.id, action: paused ? 'resume' : 'pause' }),
        checkBtn,
      )),
    );
  }

  function nodesPanel(nodes: ModelNodeStatus[]): HTMLElement[] {
    if (!nodes.length) return [];
    const wrap = h('div', { class: 'nodes' });
    for (const n of nodes) {
      const st = h('span', { class: 'badge', 'data-icon': n.online ? '✓' : '✕' }, n.online ? L('在线', 'Online') : L('离线', 'Offline'));
      st.style.setProperty('--st', n.online ? 'var(--good)' : 'var(--critical)');
      const card = h('div', { class: 'node' },
        h('div', { class: 'top' }, h('span', null, n.name), h('span', { class: 'chip' }, n.location === 'local' ? L('本机', 'Local') : L('远程', 'Remote')), h('span', { style: 'flex:1' }), st),
        ...n.models.map((m) => h('div', { class: 'model' }, h('span', null, (m.loaded ? '● ' : '○ ') + m.id), h('span', null, m.vramMB ? `${m.vramMB} MB` : ''))),
        h('div', { class: 'model' }, h('span', null, L('速度', 'Speed')), h('span', null, n.tokensPerSec ? `${n.tokensPerSec} token/s` : '—')),
        h('div', { class: 'model' }, h('span', null, L('排队', 'Queue')), h('span', null, n.queue !== undefined ? String(n.queue) : '—')),
      );
      if (n.location === 'local') {
        const used = n.models.reduce((s, m) => s + (m.vramMB ?? 0), 0);
        const max = Math.max(LOCAL_VRAM_BUDGET_MB * 1.25, used);
        const fill = h('div', { class: 'fill' });
        fill.style.width = `${(used / max) * 100}%`;
        const budget = h('div', { class: 'budget', title: L('2 GB 预算', '2 GB budget') });
        budget.style.left = `${(LOCAL_VRAM_BUDGET_MB / max) * 100}%`;
        card.append(h('div', { class: 'vram' }, L(`显存 ${used} MB / 预算 ${LOCAL_VRAM_BUDGET_MB} MB`, `VRAM ${used} MB / budget ${LOCAL_VRAM_BUDGET_MB} MB`), h('div', { class: 'track' }, fill, budget)));
      }
      if (n.lastError) card.append(h('div', { class: 'err', style: 'color:var(--critical);font-size:12px;margin-top:6px' }, n.lastError.message));
      wrap.append(card);
    }
    return [h('h2', null, L('模型节点', 'Model nodes')), wrap];
  }

  function eventsPanel(st: StatusSnapshot): HTMLElement[] {
    if (!st.events.length) return [];
    const icon = { info: ['·', 'var(--muted)'], warn: ['!', 'var(--warning)'], error: ['✕', 'var(--critical)'] } as const;
    const ul = h('ul', { class: 'events' });
    for (const e of st.events.slice(0, 20)) {
      const d = new Date(e.at);
      const i = h('span', { style: `color:${icon[e.level][1]};font-weight:700` }, icon[e.level][0]);
      ul.append(h('li', null, h('time', null, `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`), i, h('span', null, e.message)));
    }
    return [h('h2', null, L('最近事件', 'Recent events')), h('div', { class: 'panel', style: 'padding: 6px 16px' }, ul)];
  }

  connect();
  return () => {
    closed = true;
    chrome.storage.onChanged.removeListener(onStore);
    clearInterval(syncTimer);
    port?.disconnect();
  };
}

function fmtMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
