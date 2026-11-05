/**
 * 悬浮球：贴在屏幕边缘，平时稍微收进去一点；点击翻译 / 还原本页，外圈显示进度。
 * 悬停展开小窗：
 *   顶部  本页进度 + 设置齿轮
 *   模式  快速 / 精确 / 综合
 *   显示  双语 / 译文 / 原文
 *   引擎  每一档用哪家（自动，或指定某家；指定的失败时后台仍会自动换）
 *   用量  剩余免费额度、各家占比与剩余
 * 可上下拖动，拖过屏幕中线会换到另一侧。
 *
 * 球本身固定在一个 40×40 的容器里，小窗绝对定位浮在球旁边，展开时不会挤动球。
 */
import type { Mode, ProviderStatus, StatusSnapshot } from '../../shared/protocol';
import { rpc } from '../../shared/rpc';
import { saveUiSettings, type DisplayMode, type TxStyle, type UiSettings } from '../../shared/settings';
import type { Progress } from '../content/page';
import { h, icon, iconButton, type UiHost } from './host';
import { logoElement } from './logo';
import { monthly, PERIOD_LABEL, seriesColors, UNIT_LABEL, wan } from './palette';
import { onDark } from '../theme';
import { StatusFeed, type Tier } from './status-feed';
import { L } from '../i18n';

const SIZE = 40;
const EDGE = 10;

const CHEVRON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7 10l5 5 5-5'/%3E%3C/svg%3E";

const CSS = `
.ball-wrap { position: fixed; z-index: 1; width: ${SIZE}px; height: ${SIZE}px; transition: transform .22s ease-out; }
.ball-wrap.right { right: ${EDGE}px; }
.ball-wrap.left { left: ${EDGE}px; }
.ball-wrap.right.docked { transform: translateX(${EDGE + 12}px); }
.ball-wrap.left.docked { transform: translateX(-${EDGE + 12}px); }
.ball-wrap.hidden { display: none; }
.ball-wrap.dragging { transition: none; }
/* 滚动时淡出，停下后再出现，少挡内容 */
.ball-wrap.scrolling.scrolling:not(.open):not(:hover) .ball { opacity: .12; }
.ball-wrap.scrolling:not(.open):not(:hover) .pill { opacity: 0; }
/* 个性化：悬浮球样式、大小、不用时的透明度 */
.ball-wrap[data-ball="accent"] .ball { background: var(--accent); color: var(--accent-ink); --logo-accent: color-mix(in srgb, var(--accent-ink) 62%, transparent); border-color: transparent; }
/* 主题色球本来就是实心的：已翻译时加一圈白色内环来区分 */
.ball-wrap[data-ball="accent"] .ball.on { box-shadow: var(--shadow), inset 0 0 0 2px color-mix(in srgb, var(--accent-ink) 55%, transparent); }
/* 半透明球：底色是透的，图标必须一直用深色 / 主题色，不能跟着 .on 变成白色（否则白底网页上会消失） */
.ball-wrap[data-ball="glass"] .ball { background: color-mix(in srgb, var(--surface) 62%, transparent); color: var(--ink); --logo-accent: var(--accent);
  border-color: color-mix(in srgb, var(--ink) 14%, transparent); backdrop-filter: blur(10px) saturate(1.4); -webkit-backdrop-filter: blur(10px) saturate(1.4); }
.ball-wrap[data-ball="glass"] .ball.on { background: color-mix(in srgb, var(--accent) 18%, color-mix(in srgb, var(--surface) 66%, transparent)); color: var(--accent); --logo-accent: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.ball-wrap[data-size="s"] .ball { transform: scale(.85); }
.ball-wrap[data-size="l"] .ball { transform: scale(1.2); }
.ball-wrap:not(.open):not(:hover):not(:focus-within) .ball { opacity: var(--idle, 1); }
.ball {
  position: relative; width: ${SIZE}px; height: ${SIZE}px; border-radius: 50%;
  display: grid; place-items: center; background: var(--surface); color: var(--ink); --logo-accent: var(--accent);
  box-shadow: var(--shadow); border: 1px solid var(--line); touch-action: none; user-select: none;
  transition: background .2s, color .2s, opacity .22s, box-shadow .2s;
}
.ball-wrap.docked .ball { opacity: .55; box-shadow: 0 2px 8px rgba(15, 20, 40, .14); }
.ball:hover { box-shadow: var(--shadow), 0 0 0 4px color-mix(in srgb, var(--accent) 14%, transparent); }
.ball.on { background: var(--accent); color: var(--accent-ink); --logo-accent: color-mix(in srgb, var(--accent-ink) 65%, transparent); border-color: transparent; }
.ball .logo { display: block; }
.ball svg.ring { position: absolute; inset: -4px; width: 48px; height: 48px; transform: rotate(-90deg); pointer-events: none; }
.ball svg.ring circle { fill: none; stroke-width: 2.5; }
.ball svg.ring .bar { stroke: var(--accent); stroke-linecap: round; transition: stroke-dashoffset .3s ease, opacity .3s; }
.ball .badge { position: absolute; top: 0; right: 0; width: 10px; height: 10px; border-radius: 50%; background: var(--danger); border: 2px solid var(--surface); display: none; }
.ball.err .badge { display: block; }
/* 三种状态一眼分清：未翻译（默认的样子）、翻译中（浅主题色底 + 转圈 / 进度环）、已翻译（实心 + 角上的小对勾）。
   角标放在靠页面内侧的那一边：球贴边半藏时也看得见 */
.ball svg.ring .track { stroke: color-mix(in srgb, var(--accent) 22%, transparent); opacity: 0; transition: opacity .3s; }
.ball-wrap[data-state="busy"] .ball svg.ring .track { opacity: 1; }
.ball .spin { position: absolute; inset: -4px; width: 48px; height: 48px; pointer-events: none; opacity: 0; transition: opacity .2s; }
.ball .spin circle { fill: none; stroke: var(--accent); stroke-width: 2.5; stroke-linecap: round; }
.ball-wrap[data-state="busy"][data-progress="0"] .ball .spin { opacity: 1; animation: tx-spin 1s linear infinite; }
@keyframes tx-spin { to { transform: rotate(360deg); } }
.ball-wrap[data-ball="light"][data-state="busy"] .ball:not(.err) { background: color-mix(in srgb, var(--accent) 13%, var(--surface)); color: var(--accent); --logo-accent: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
.ball-wrap[data-ball="glass"][data-state="busy"] .ball:not(.err) { background: color-mix(in srgb, var(--accent) 10%, color-mix(in srgb, var(--surface) 64%, transparent)); }
.ball-wrap[data-ball="accent"][data-state="busy"] .ball:not(.err) { box-shadow: var(--shadow); }
.ball .ok { position: absolute; top: -3px; width: 15px; height: 15px; border-radius: 50%; display: none; place-items: center;
  background: var(--surface); color: var(--accent); box-shadow: 0 1px 3px rgba(15, 20, 40, .25), 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent); }
.ball .ok svg { width: 9px; height: 9px; }
.ball-wrap[data-state="done"] .ball:not(.err) .ok { display: grid; animation: tx-pop .2s ease-out; }
.ball-wrap.right .ball .ok, .ball-wrap.right .ball .badge { left: -3px; right: auto; }
.ball-wrap.left .ball .ok, .ball-wrap.left .ball .badge { right: -3px; left: auto; }
@keyframes tx-pop { from { transform: scale(.4); opacity: 0; } }
.ball-wrap.docked:not([data-state="idle"]) .ball { opacity: .9; }
@media (prefers-reduced-motion: reduce) {
  .ball-wrap[data-state="busy"][data-progress="0"] .ball .spin { animation: none; }
  .ball .spin circle { stroke-dasharray: 3 6 !important; }
}
.ball.dead { opacity: .4; }

.localhint { display: none; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-2); padding: 6px 10px; border-radius: 10px;
  background: color-mix(in srgb, var(--warning, #c98a00) 12%, transparent); }
.localhint.on { display: flex; }
.localhint span { flex: 1; min-width: 0; }
.localhint button { padding: 2px 10px; border-radius: 99px; background: var(--surface); border: 1px solid var(--line); color: var(--ink); font-size: 12px; }
.localhint button:hover { border-color: var(--accent); color: var(--accent); }
.menu {
  position: absolute; display: none; flex-direction: column; gap: 12px; padding: 12px; border-radius: 16px; width: 272px;
  background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(20px) saturate(1.6);
  -webkit-backdrop-filter: blur(20px) saturate(1.6); border: 1px solid var(--line);
  box-shadow: 0 22px 48px -16px rgba(15, 20, 40, .38), 0 6px 16px -6px rgba(15, 20, 40, .12), inset 0 1px 0 rgba(255, 255, 255, .5);
  animation: tx-menu-in .16s cubic-bezier(.2, .8, .3, 1);
  transition: top .22s cubic-bezier(.2, .8, .3, 1);
}
${onDark('.menu', 'box-shadow: 0 22px 48px -16px rgba(0, 0, 0, .7), inset 0 1px 0 rgba(255, 255, 255, .06);')}
@keyframes tx-menu-in { from { opacity: 0; transform: translateY(4px) scale(.98); } }
.ball-wrap.right .menu { right: calc(100% + 10px); transform-origin: right center; }
.ball-wrap.left .menu { left: calc(100% + 10px); transform-origin: left center; }
/* 球和小窗之间的空隙也算悬停区，鼠标移过去不会关掉 */
.menu::after { content: ""; position: absolute; top: 0; bottom: 0; width: 14px; }
.ball-wrap.right .menu::after { left: 100%; }
.ball-wrap.left .menu::after { right: 100%; }
.ball-wrap.open .menu { display: flex; }

.mhead { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 9px; }
.mhead .mk { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; background: var(--accent); color: var(--accent-ink);
  --logo-accent: color-mix(in srgb, var(--accent-ink) 65%, transparent); box-shadow: 0 2px 6px -2px color-mix(in srgb, var(--accent) 60%, transparent); }
.mhead .t { min-width: 0; line-height: 1.25; }
.mhead .t b { display: block; font-size: 13px; font-weight: 650; color: var(--ink); }
.mhead .t span { display: block; font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mhead .t.err span { color: var(--danger); }
.prog { grid-column: 1 / -1; height: 3px; border-radius: 2px; background: var(--hover); overflow: hidden; margin-top: 1px; }
.prog i { display: block; height: 100%; width: 0; border-radius: 2px; background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 70%, #fff), var(--accent)); transition: width .35s ease; }
.prog.off { visibility: hidden; }

.ctrl { display: grid; grid-template-columns: minmax(30px, max-content) minmax(0, 1fr); align-items: center; gap: 7px 8px; }
.ctrl .lab { font-size: 11.5px; color: var(--muted); }
.seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; background: var(--hover); border-radius: 10px; padding: 3px; gap: 2px; }
.seg.seg5 button { padding: 5px 2px; font-size: 11.5px; }
.seg button { padding: 5px 4px; border-radius: 7px; font-size: 12px; color: var(--muted); white-space: nowrap; transition: background .15s, color .15s, box-shadow .15s; }
.seg button:hover { color: var(--ink); }
.seg button[aria-pressed="true"] { background: var(--surface); color: var(--ink); font-weight: 600; box-shadow: 0 1px 3px rgba(15, 20, 40, .14), 0 0 0 .5px rgba(15, 20, 40, .06); }

.eng { position: relative; min-width: 0; }
.eng .edot { position: absolute; left: 10px; top: 50%; width: 7px; height: 7px; margin-top: -3.5px; border-radius: 50%; background: var(--st, var(--muted));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--st, var(--muted)) 20%, transparent); pointer-events: none; }
.sel {
  appearance: none; -webkit-appearance: none; width: 100%; height: 30px; border: 0; border-radius: 10px; margin: 0;
  padding: 0 26px 0 25px; background: var(--hover) url("${CHEVRON}") no-repeat right 9px center / 12px;
  font-size: 12px; line-height: 30px; font-family: inherit; color: var(--ink); cursor: pointer; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;
  transition: background-color .15s;
}
.sel:hover { background-color: color-mix(in srgb, var(--ink) 9%, transparent); }
.sel:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.sel:disabled { cursor: default; color: var(--muted); }

.usage { border-radius: 12px; background: var(--hover); transition: background .2s; }
.usage.open { background: color-mix(in srgb, var(--ink) 5%, transparent); }
.usum { display: grid; grid-template-columns: auto minmax(0, 1fr) auto 14px; align-items: center; gap: 8px; width: 100%; height: 34px; padding: 0 10px; border-radius: 12px; text-align: left; }
.usum:hover { background: color-mix(in srgb, var(--ink) 5%, transparent); }
.usum .k { font-size: 11.5px; color: var(--muted); }
.usum .mini { display: flex; gap: 1.5px; height: 4px; opacity: 1; transition: opacity .2s; }
.usage.open .usum .mini, .usage.open .usum .v { opacity: 0; }
.usum .v { transition: opacity .2s; }
.usum .v { font-size: 12px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; white-space: nowrap; }
.usum .chev { width: 14px; height: 14px; color: var(--muted); transition: transform .22s ease; }
.usage.open .usum .chev { transform: rotate(180deg); }
.uwrap { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .26s cubic-bezier(.2, .8, .3, 1); }
.usage.open .uwrap { grid-template-rows: 1fr; }
.uwrap > div { overflow: hidden; min-height: 0; }
.ubody { padding: 0 10px 10px; }
.ubody .big { display: flex; align-items: baseline; gap: 6px; margin: 0 0 8px; }
.ubody .big b { font-size: 22px; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; color: var(--ink); }
.ubody .big span { font-size: 11.5px; color: var(--muted); }
.qbar { display: flex; gap: 2px; height: 6px; margin-bottom: 9px; }
.qseg { position: relative; min-width: 4px; background: color-mix(in srgb, var(--c) 24%, transparent); overflow: hidden; }
.qseg:first-child { border-radius: 3px 0 0 3px; }
.qseg:last-child { border-radius: 0 3px 3px 0; }
.qseg:only-child { border-radius: 3px; }
.qseg i { position: absolute; inset: 0 auto 0 0; background: var(--c); }
.mini .qseg:first-child { border-radius: 2px 0 0 2px; }
.mini .qseg:last-child { border-radius: 0 2px 2px 0; }
.qrow { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: 12px; line-height: 22px; }
.qrow .sw { width: 7px; height: 7px; border-radius: 2px; background: var(--c); }
.qrow .nm { color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qrow .rt { color: var(--muted); font-variant-numeric: tabular-nums; }
.qrow.out .nm { color: var(--muted); }
.ufoot { display: flex; justify-content: flex-end; margin-top: 4px; }
.ufoot a { font-size: 11.5px; color: var(--accent); text-decoration: none; }
.ufoot a:hover { text-decoration: underline; }
.uempty { font-size: 12px; color: var(--muted); padding: 2px 0 2px; }

.acts { display: none; gap: 6px; margin-top: -4px; }
.acts.on { display: flex; }
.acts button { flex: 1; height: 28px; border-radius: 8px; font-size: 12px; font-weight: 600; background: var(--hover); color: var(--ink); }
.acts button:hover { background: color-mix(in srgb, var(--ink) 10%, transparent); }
.acts button.primary { background: var(--accent); color: var(--accent-ink); }
.acts button.primary:hover { filter: brightness(1.06); }
.pill { position: absolute; top: 50%; display: none; align-items: center; gap: 8px; padding: 7px 8px 7px 12px; border-radius: 12px; white-space: nowrap;
  transform: translateY(-50%); background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); font-size: 12.5px; color: var(--ink);
  animation: tx-menu-in .16s ease-out; }
.pill.on { display: inline-flex; }
.ball-wrap.right .pill { right: calc(100% + 10px); }
.ball-wrap.left .pill { left: calc(100% + 10px); }
.ball-wrap.open .pill { display: none; }
.pill::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--danger); flex: none; }
.pill button { font-size: 12px; font-weight: 600; padding: 4px 9px; border-radius: 8px; background: var(--accent); color: var(--accent-ink); }
.pill .x { background: none; color: var(--muted); padding: 4px 4px; font-weight: 400; }
.mfoot { display: flex; justify-content: space-between; align-items: center; padding: 0 2px; margin-top: -2px; }
.mfoot .hide { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--muted); padding: 3px 6px; border-radius: 7px; margin-left: -6px; }
.mfoot .hide:hover { color: var(--ink); background: var(--hover); }
.mfoot .hide svg { width: 13px; height: 13px; }
.mfoot .chip { margin-left: auto; margin-right: 8px; font-size: 11.5px; padding: 3px 8px; border-radius: 99px; color: var(--muted); border: 1px solid var(--line); }
.mfoot .chip:hover { color: var(--ink); }
.mfoot .chip[aria-pressed="true"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: var(--accent-soft); }
.mfoot kbd { font: 10.5px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted); padding: 3px 6px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface); box-shadow: 0 1px 0 var(--line); }
`;

const R = 21;
const CIRC = 2 * Math.PI * R;
const HEALTH_COLOR: Record<string, string> = { ok: 'var(--good, #0ca30c)', degraded: 'var(--warning, #fab219)', error: 'var(--danger)', exhausted: '#ec835a', disabled: 'var(--muted)', unconfigured: 'var(--muted)' };
const UNAVAILABLE: Record<string, string> = {
  get exhausted() { return L('额度用尽', 'quota used up'); },
  get error() { return L('出错', 'error'); },
  get unconfigured() { return L('未配置', 'not set up'); },
  get disabled() { return L('已停用', 'disabled'); },
};

type Quota = NonNullable<ProviderStatus['quota']>;
type WithQuota = ProviderStatus & { quota: Quota };

export interface BallActions {
  toggle(): void;
  setMode(m: Mode): void;
  setDisplay(d: DisplayMode): void;
  /** 重试所有失败的段落。 */
  retryErrors(): void;
  /** 打开首次设置向导（没有可用服务、密钥无效时）。 */
  openSetup(): void;
  /** 鼠标移到球上：提前唤醒后台和模型，点下去时不用再等。 */
  warm?(): void;
  /** 一键切换译文样式。 */
  setStyle?(s: TxStyle): void;
  /** 只翻正文 开 / 关。 */
  setMainOnly?(on: boolean): void;
}

export class Ball {
  private wrap: HTMLDivElement;
  private ball: HTMLButtonElement;
  private bar: SVGCircleElement;
  private menu: HTMLDivElement;
  private pageLine: HTMLDivElement;
  private modeSeg: HTMLDivElement;
  private displaySeg: HTMLDivElement;
  private engineBox: HTMLDivElement;
  /** 本地模型没启动时的一行提示 +「启动」（后端支持 local:start 时才显示按钮）。 */
  private localBox = h('div', { class: 'localhint' });
  private canStartLocal: boolean | null = null;
  private startingLocal = false;
  private usageBox: HTMLDivElement;
  private progEl: HTMLDivElement;
  private acts: HTMLDivElement;
  private pill: HTMLDivElement;
  private pillShown = false;
  /** 免费额度详情默认收起，点一下展开；本页内记住。 */
  private usageOpen = false;
  private usageSig = '';
  private engineKey = '';
  private engineDots = new Map<Tier, HTMLElement>();
  private engineSig = new Map<Tier, string>();
  private picking: HTMLSelectElement | null = null;
  private dockTimer = 0;
  private openTimer = 0;
  private closeTimer = 0;
  private dragging = false;
  private scrollTimer = 0;
  private settings: UiSettings;
  private feed = new StatusFeed();
  private selects = new Map<Tier, HTMLSelectElement>();

  constructor(private ui: UiHost, settings: UiSettings, private actions: BallActions) {
    this.settings = settings;
    ui.addStyle(CSS);
    this.ball = h('button', { class: 'ball', title: L('翻译本页（Alt+A）', 'Translate page (Alt+A)'), 'aria-label': L('翻译本页', 'Translate page'), 'aria-haspopup': 'dialog' });
    this.ball.innerHTML =
      `<svg class="ring" viewBox="0 0 48 48"><circle class="track" cx="24" cy="24" r="${R}"/><circle class="bar" cx="24" cy="24" r="${R}" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"/></svg>` +
      `<svg class="spin" viewBox="0 0 48 48"><circle cx="24" cy="24" r="${R}" stroke-dasharray="${(CIRC * 0.22).toFixed(1)} ${CIRC.toFixed(1)}"/></svg>`;
    const ok = h('span', { class: 'ok', 'aria-hidden': 'true' });
    ok.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3.2 8.6l3 3 6.6-7.2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    this.ball.append(logoElement({ size: 22 }), h('span', { class: 'badge' }), ok);
    this.bar = this.ball.querySelector('.bar') as SVGCircleElement;

    this.modeSeg = this.segmented<Mode>(
      [
        ['fast', L('快速', 'Fast')],
        ['accurate', L('精确', 'Accurate')],
        ['combined', L('综合', 'Combined')],
      ],
      () => this.settings.mode,
      (m) => this.actions.setMode(m),
    );
    this.displaySeg = this.segmented<DisplayMode>(
      [
        ['bilingual', L('双语', 'Bilingual')],
        ['translation', L('译文', 'Translation')],
        ['original', L('原文', 'Original')],
      ],
      () => this.settings.display,
      (d) => this.actions.setDisplay(d),
    );
    this.pageLine = h('div', { class: 't' });
    this.progEl = h('div', { class: 'prog off' }, h('i'));
    this.engineBox = h('div', { class: 'ctrl' });
    this.usageBox = h('div', { class: 'usage' });
    this.acts = h('div', { class: 'acts' });
    this.pill = h('div', { class: 'pill', role: 'alert' });

    const hide = h('button', { class: 'hide', type: 'button', title: L('在本站隐藏悬浮球（可在设置里恢复）', 'Hide the ball on this site (you can bring it back in Settings)') }, icon('eyeOff'), L('在本站隐藏', 'Hide on this site'));
    hide.addEventListener('click', () => void this.hideOnSite());
    this.menu = h('div', { class: 'menu', role: 'dialog', 'aria-label': L('翻译设置', 'Translation settings') },
      h('div', { class: 'mhead' },
        h('span', { class: 'mk' }, logoElement({ size: 16 })),
        this.pageLine,
        iconButton('gear', L('设置', 'Settings'), () => rpc('ui:openOptions', { tab: 'general' }).catch(() => {})),
        this.progEl,
      ),
      this.acts,
      h('div', { class: 'ctrl' },
        h('span', { class: 'lab' }, L('模式', 'Mode')), this.modeSeg,
        h('span', { class: 'lab' }, L('显示', 'Display')), this.displaySeg,
      ),
      this.engineBox,
      this.localBox,
      this.usageBox,
      h('div', { class: 'mfoot' }, hide, h('kbd', { title: L('翻译 / 还原本页的快捷键', 'Shortcut to translate / restore this page') }, 'Alt+A')),
    );
    this.wrap = h('div', { class: 'ball-wrap docked', 'data-state': 'idle', 'data-progress': '0' }, this.ball, this.menu, this.pill);
    ui.layer.appendChild(this.wrap);

    this.feed.onSnapshot = (s) => {
      this.renderEngines(s);
      this.renderLocal(s);
      this.renderUsage(s);
      if (this.wrap.classList.contains('open')) this.positionMenu(true);
    };
    this.renderEngines(null);
    this.renderUsage(null);

    this.bindDrag();
    this.wrap.addEventListener('mouseenter', () => this.hover(true));
    this.wrap.addEventListener('mouseleave', () => this.hover(false));
    window.addEventListener('resize', () => this.place());
    // 任何可滚动区域滚动都算（很多网页滚的是内部容器，不是 window）
    document.addEventListener('scroll', () => this.onScroll(), { capture: true, passive: true });
    this.apply(settings);
  }

  apply(s: UiSettings): void {
    const modeChanged = s.mode !== this.settings.mode;
    this.settings = s;
    this.wrap.classList.toggle('right', s.ball.side === 'right');
    this.wrap.classList.toggle('left', s.ball.side === 'left');
    this.wrap.classList.toggle('hidden', s.ball.hiddenOn.includes(location.hostname));
    const a = s.appearance;
    this.wrap.dataset.ball = a?.ball ?? 'light';
    this.wrap.dataset.size = a?.ballSize ?? 'm';
    this.wrap.style.setProperty('--idle', String(Math.max(0.35, Math.min(1, a?.idleOpacity ?? 1))));
    this.ui.setAccent(a?.accent);
    this.refreshSeg(this.modeSeg, s.mode);
    this.refreshSeg(this.displaySeg, s.display);
    if (modeChanged) {
      this.renderEngines(this.feed.latest);
      if (this.wrap.classList.contains('open')) this.positionMenu();
    }
    if (!this.dragging) this.place();
  }

  private progressFrame = 0;
  private pendingProgress?: Progress;
  private disconnected = false;

  setProgress(p: Progress): void {
    if (this.disconnected) return;
    if (!p.active) {
      cancelAnimationFrame(this.progressFrame);
      this.progressFrame = 0;
      this.pendingProgress = undefined;
      this.paintProgress(p);
      return;
    }
    // 一帧内可以收到许多快速/最终结果。状态栏只需画用户下一帧能看到的最新进度。
    this.pendingProgress = p;
    if (this.progressFrame) return;
    this.progressFrame = requestAnimationFrame(() => {
      this.progressFrame = 0;
      const latest = this.pendingProgress;
      this.pendingProgress = undefined;
      if (latest) this.paintProgress(latest);
    });
  }

  private paintProgress(p: Progress): void {
    const ratio = p.active && p.total ? p.done / p.total : 0;
    const failed = !!(p.active && p.errors && p.lastError);
    const state = !p.active ? 'idle' : failed ? 'error' : p.total && p.done >= p.total ? 'done' : 'busy';
    // 已翻译：实心；翻译中：浅底 + 进度（还没有进度时转圈）；未翻译：默认样子
    this.ball.classList.toggle('on', state === 'done' || state === 'error');
    this.wrap.dataset.state = state;
    this.wrap.dataset.progress = ratio > 0 ? '1' : '0';
    this.bar.style.strokeDashoffset = String(CIRC * (1 - ratio));
    this.bar.style.opacity = p.active && ratio < 1 ? '1' : '0';
    const fatal = p.lastError && ['no_provider', 'auth', 'quota'].includes(p.lastError.code);
    this.ball.classList.toggle('err', !!(p.active && (fatal || p.errors)));
    this.ball.title = state === 'idle' ? L('翻译本页（Alt+A）', 'Translate page (Alt+A)') : state === 'busy' ? L('正在翻译…（点击还原，Alt+A）', 'Translating… (click to restore, Alt+A)') : L('已翻译 · 点击还原（Alt+A）', 'Translated · click to restore (Alt+A)');
    this.ball.setAttribute('aria-label', state === 'idle' ? L('翻译本页', 'Translate page') : state === 'busy' ? L('正在翻译，点击还原', 'Translating, click to restore') : L('已翻译，点击还原', 'Translated, click to restore'));
    this.pageLine.classList.toggle('err', failed);
    const title = !p.active ? L('本页未翻译', 'Not translated') : failed ? L(`${p.errors} 段失败`, `${p.errors} failed`) : !p.total ? L('正在扫描页面', 'Scanning page') : p.done >= p.total ? L('本页已翻译', 'Page translated') : L('正在翻译', 'Translating');
    const sub = !p.active
      ? L('点击圆球或按 Alt+A 翻译本页', 'Click the ball or press Alt+A to translate this page')
      : failed
        ? p.lastError!.message
        : p.total ? L(`${p.done} / ${p.total} 段 · 视口附近`, `${p.done} / ${p.total} paragraphs · near viewport`) : L('稍等片刻…', 'Just a moment…');
    this.pageLine.replaceChildren(h('b', null, title), h('span', null, sub));
    this.progEl.classList.toggle('off', !p.active || !p.total || p.done >= p.total);
    this.renderActions(p, failed);
    (this.progEl.firstElementChild as HTMLElement).style.width = `${ratio * 100}%`;
  }

  /** 出错时：小窗顶部给出能直接点的操作；严重错误（没有可用服务、密钥无效）时球旁边弹一次提示。 */
  private renderActions(p: Progress, failed: boolean) {
    const code = p.lastError?.code;
    const setupLabel = code === 'no_provider' ? L('去设置服务', 'Set up a service') : code === 'auth' ? L('检查密钥', 'Check the key') : code === 'quota' ? L('换一个引擎', 'Try another engine') : '';
    this.acts.classList.toggle('on', failed);
    if (failed) {
      const retry = h('button', { type: 'button', class: setupLabel ? '' : 'primary' }, L(`全部重试（${p.errors}）`, `Retry all (${p.errors})`));
      retry.addEventListener('click', () => this.actions.retryErrors());
      const nodes: HTMLElement[] = [retry];
      if (setupLabel) {
        const fix = h('button', { type: 'button', class: 'primary' }, setupLabel);
        fix.addEventListener('click', () => {
          if (code === 'quota') this.selects.values().next().value?.focus();
          else this.actions.openSetup();
        });
        nodes.unshift(fix);
      }
      this.acts.replaceChildren(...nodes);
    }
    const fatal = failed && (code === 'no_provider' || code === 'auth');
    if (fatal && !this.pillShown) {
      this.pillShown = true;
      const go = h('button', { type: 'button' }, L('去设置', 'Settings'));
      go.addEventListener('click', () => {
        this.pill.classList.remove('on');
        this.actions.openSetup();
      });
      const x = h('button', { type: 'button', class: 'x', 'aria-label': L('关闭', 'Close') }, '✕');
      x.addEventListener('click', () => this.pill.classList.remove('on'));
      this.pill.replaceChildren(code === 'auth' ? L('翻译服务的密钥无效', 'The translation service key is invalid') : L('还没有可用的翻译服务', 'No translation service is available yet'), go, x);
      this.pill.classList.add('on');
      this.wrap.classList.remove('docked');
      window.setTimeout(() => this.pill.classList.remove('on'), 12000);
    }
    if (!failed) this.pill.classList.remove('on');
  }

  setDead(): void {
    this.disconnected = true;
    cancelAnimationFrame(this.progressFrame);
    this.progressFrame = 0;
    this.pendingProgress = undefined;
    this.ball.classList.add('dead');
    this.ball.title = L('扩展已更新，请刷新页面', 'Extension updated — please reload the page');
    this.pageLine.replaceChildren(h('b', null, L('扩展已更新', 'Extension updated')), h('span', null, L('请刷新页面后再用', 'Reload the page to keep using it')));
  }

  /* ---------------------------------------------------------------- */
  /* 引擎                                                              */
  /* ---------------------------------------------------------------- */

  /** 当前模式用得到哪几档：快速只有高速档，精确只有精确档，综合两档都有。 */
  private tiers(): Tier[] {
    const m = this.settings.mode;
    return m === 'fast' ? ['fast'] : m === 'accurate' ? ['accurate'] : ['fast', 'accurate'];
  }

  private renderEngines(s: StatusSnapshot | null) {
    const tiers = this.tiers();
    const key = tiers.join(',');
    // 档位变了才重建这一栏；平时只更新选项和状态点。
    // 不能把 <select> 从 DOM 里拿下来再放回去：浏览器会把已经展开的下拉框收起来（翻译过程中快照很频繁）。
    if (this.engineKey !== key) {
      this.engineKey = key;
      for (const t of [...this.selects.keys()]) if (!tiers.includes(t)) this.selects.delete(t);
      this.engineBox.textContent = '';
      this.engineDots.clear();
      this.engineSig.clear();
      for (const tier of tiers) {
        let sel = this.selects.get(tier);
        if (!sel) {
          const el = h('select', { class: 'sel', 'aria-label': tier === 'fast' ? L('高速档引擎', 'Fast-tier engine') : L('精确档引擎', 'Accurate-tier engine') }) as HTMLSelectElement;
          el.addEventListener('pointerdown', () => (this.picking = el));
          el.addEventListener('blur', () => { if (this.picking === el) this.picking = null; });
          el.addEventListener('change', () => {
            this.picking = null;
            this.feed.setEngine(tier, el.value || null);
            el.blur();
            if (!this.wrap.matches(':hover')) this.hover(false);
          });
          this.selects.set(tier, el);
          sel = el;
        }
        const dot = h('span', { class: 'edot' });
        this.engineDots.set(tier, dot);
        this.engineBox.append(h('span', { class: 'lab' }, tiers.length > 1 ? (tier === 'fast' ? L('高速', 'Fast') : L('精确', 'Accurate')) : L('引擎', 'engine')), h('div', { class: 'eng' }, dot, sel));
      }
    }
    for (const tier of tiers) {
      const sel = this.selects.get(tier)!;
      // 用户正在下拉选择时不动选项
      const busy = this.picking === sel || this.ui.root.activeElement === sel;
      const sig = engineSignature(tier, s);
      if (!busy && this.engineSig.get(tier) !== sig) {
        this.engineSig.set(tier, sig);
        this.fillEngine(sel, tier, s);
      }
      const st = this.effective(tier, s);
      const dot = this.engineDots.get(tier);
      if (dot) dot.style.setProperty('--st', st ? HEALTH_COLOR[st.health] ?? 'var(--muted)' : 'var(--muted)');
    }
  }

  /** 启用了本地模型、但它离线（重启电脑后没开）：提示一下，后端能启动时给个「启动」按钮。 */
  private renderLocal(s: StatusSnapshot | null) {
    const local = s?.providers.find((p) => p.kind === 'local' && p.enabled);
    const offline = !!local && local.health === 'error';
    if (!offline) {
      if (!this.startingLocal) this.localBox.classList.remove('on');
      return;
    }
    if (this.canStartLocal === null) {
      this.canStartLocal = false;
      void rpc('local:autostart', {}).then((r) => {
        this.canStartLocal = !!r.canStart;
        this.renderLocal(this.feed.latest);
      }, () => {});
    }
    if (this.localBox.classList.contains('on') && this.localBox.dataset.can === String(this.canStartLocal)) return;
    this.localBox.dataset.can = String(this.canStartLocal);
    const text = h('span', null, L(`${local!.name} 没有启动`, `${local!.name} is not running`));
    const nodes: (HTMLElement | string)[] = [text];
    if (this.canStartLocal) {
      const go = h('button', { type: 'button' }, L('启动', 'Start'));
      go.addEventListener('click', () => {
        this.startingLocal = true;
        go.disabled = true;
        text.textContent = L('正在启动本地模型…', 'Starting the local model…');
        void rpc('local:start', undefined).then(
          (r) => {
            this.startingLocal = false;
            text.textContent = r.ok ? L('已启动，稍等几秒就能用', 'Started — ready in a few seconds') : L('启动失败：', 'Failed to start: ') + (r.message ?? '');
            go.remove();
          },
          (e) => {
            this.startingLocal = false;
            go.disabled = false;
            text.textContent = L('启动失败：', 'Failed to start: ') + String((e as Error).message);
          },
        );
      });
      nodes.push(go);
    } else {
      const how = h('button', { type: 'button', title: L('在设置里看怎么开机自动启动', 'See how to start it automatically in Settings') }, L('怎么开', 'How?'));
      how.addEventListener('click', () => void rpc('ui:openOptions', { tab: 'providers' }).catch(() => {}));
      nodes.push(how);
    }
    this.localBox.replaceChildren(...nodes);
    this.localBox.classList.add('on');
  }

  /** 这一档实际在用的服务：指定的优先，否则是自动调度的当前服务。 */
  private effective(tier: Tier, s: StatusSnapshot | null): ProviderStatus | undefined {
    const ps = s?.providers.filter((p) => p.usedFor.includes(tier) && p.enabled) ?? [];
    return ps.find((p) => p.pinned) ?? ps.find((p) => p.active) ?? ps.find((p) => p.rank === 1);
  }

  private fillEngine(sel: HTMLSelectElement, tier: Tier, s: StatusSnapshot | null) {
    sel.textContent = '';
    if (!s) {
      sel.append(h('option', { value: '' }, L('自动', 'Auto')));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    const ps = s.providers
      .filter((p) => p.usedFor.includes(tier) && p.enabled)
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.name.localeCompare(b.name));
    const pinned = ps.find((p) => p.pinned);
    const active = ps.find((p) => p.active) ?? ps.find((p) => p.rank === 1);
    sel.append(h('option', { value: '', selected: !pinned }, L(`自动${active && !pinned ? ' · 当前 ' + active.name : ' · 按速度和额度'}`, `Auto${active && !pinned ? ' · now ' + active.name : ' · by speed and quota'}`)));
    for (const p of ps) {
      const bad = UNAVAILABLE[p.health];
      const label = `${p.name}${bad ? `（${bad}）` : p.latencyP50Ms ? ` · ${p.latencyP50Ms} ms` : ''}`;
      sel.append(h('option', { value: p.id, selected: p === pinned, disabled: !!bad && p !== pinned }, label));
    }
    sel.title = pinned ? L(`优先用 ${pinned.name}；失败或额度用尽时自动换下一家`, `Prefer ${pinned.name}; switch to the next one on errors or when its quota runs out`) : L('自动选择最快且还有额度的服务', 'Pick the fastest service that still has quota');
  }

  /* ---------------------------------------------------------------- */
  /* 用量                                                              */
  /* ---------------------------------------------------------------- */

  private renderUsage(s: StatusSnapshot | null) {
    // 快照里和用量相关的内容没变就不重画（翻译时快照很频繁，重画会吞掉点击）
    const sig = usageSignature(s);
    if (sig === this.usageSig) return;
    this.usageSig = sig;
    const chev = icon('chevron');
    chev.classList.add('chev');
    const sum = h('button', { class: 'usum', type: 'button', 'aria-expanded': String(this.usageOpen) }, h('span', { class: 'k' }, L('免费额度', 'Free quota')));
    sum.addEventListener('click', () => {
      this.usageOpen = !this.usageOpen;
      this.usageBox.classList.toggle('open', this.usageOpen);
      sum.setAttribute('aria-expanded', String(this.usageOpen));
      // 展开 / 收起后小窗高度变了：保持顶部不动，超出屏幕时再往上挪
      window.setTimeout(() => this.positionMenu(true), 280);
    });
    const body = h('div', { class: 'ubody' });
    this.usageBox.classList.toggle('open', this.usageOpen);
    this.usageBox.replaceChildren(sum, h('div', { class: 'uwrap' }, h('div', null, body)));

    if (!s) {
      sum.append(h('span'), h('span', { class: 'v', style: 'color:var(--muted);font-weight:400' }, L('读取中…', 'Loading…')), chev);
      body.append(h('div', { class: 'uempty' }, L('正在读取各服务的用量…', 'Reading usage of each service…')));
      return;
    }
    const withQuota = s.providers.filter((p): p is WithQuota => !!p.quota && p.enabled && p.configured !== false && p.health !== 'unconfigured' && p.quota.amount > 0);
    if (!withQuota.length) {
      sum.append(h('span'), h('span', { class: 'v' }, L('不限量', 'Unlimited')), chev);
      body.append(h('div', { class: 'uempty' }, L('当前启用的服务都没有额度限制。', 'None of the enabled services has a quota limit.')));
      return;
    }
    const colors = seriesColors(s.providers);
    const left = (p: WithQuota) => Math.max(0, p.quota.amount - p.quota.used);
    const chars = withQuota.filter((p) => p.quota.unit === 'char').sort((a, b) => monthly(b.quota) - monthly(a.quota));
    const others = withQuota.filter((p) => p.quota.unit !== 'char');
    const remaining = chars.reduce((n, p) => n + left(p), 0);

    // 宽度 = 占全部免费额度的比例（日额度按 30 天折算），实心 = 本期还剩的部分
    const bar = (cls: string) => {
      const total = chars.reduce((n, p) => n + monthly(p.quota), 0);
      const el = h('div', { class: cls, role: 'img', 'aria-label': L('各家免费额度占比与剩余', 'Share and remaining free quota per service') });
      for (const p of chars) {
        const seg = h('div', { class: 'qseg', title: L(`${p.name}：剩 ${wan(left(p))} / ${wan(p.quota.amount)} ${UNIT_LABEL.char}（每${PERIOD_LABEL[p.quota.period]}）`, `${p.name}: ${wan(left(p))} / ${wan(p.quota.amount)} ${UNIT_LABEL.char} left (per ${PERIOD_LABEL[p.quota.period]})`) });
        seg.style.setProperty('--c', colors.get(p.id) ?? 'var(--other)');
        seg.style.flexGrow = String(monthly(p.quota) / total);
        const fill = h('i');
        fill.style.width = `${(left(p) / p.quota.amount) * 100}%`;
        seg.append(fill);
        el.append(seg);
      }
      return el;
    };
    sum.append(chars.length ? bar('mini') : h('span'), h('span', { class: 'v' }, chars.length ? L(`剩 ${wan(remaining)}`, `${wan(remaining)} left`) : L(`${others.length} 家`, `${others.length} services`)), chev);

    if (chars.length) {
      body.append(h('div', { class: 'big' }, h('b', null, wan(remaining)), h('span', null, L('字符剩余 · 各家本期合计', 'characters left · all services, this period'))), bar('qbar'));
    }
    const rows = [...chars, ...others];
    const shown = rows.slice(0, 5);
    for (const p of shown) {
      const out = left(p) <= 0 || p.health === 'exhausted';
      const right = out
        ? L('已用尽', 'Used up')
        : p.quota.unit === 'char'
          ? L(`剩 ${Math.round((left(p) / p.quota.amount) * 100)}%`, `${Math.round((left(p) / p.quota.amount) * 100)}% left`)
          : L(`剩 ${wan(left(p))} ${UNIT_LABEL[p.quota.unit]}/${PERIOD_LABEL[p.quota.period]}`, `${wan(left(p))} ${UNIT_LABEL[p.quota.unit]}/${PERIOD_LABEL[p.quota.period]} left`);
      const row = h('div', { class: 'qrow' + (out ? ' out' : '') }, h('span', { class: 'sw' }), h('span', { class: 'nm' }, p.name), h('span', { class: 'rt' }, right));
      row.style.setProperty('--c', colors.get(p.id) ?? 'var(--other)');
      body.append(row);
    }
    const more = h('a', { href: '#', role: 'button' }, rows.length > shown.length ? L(`全部 ${rows.length} 家 · 服务状态 →`, `All ${rows.length} services · Status →`) : L('服务状态 →', 'Status →'));
    more.addEventListener('click', (e) => {
      e.preventDefault();
      rpc('ui:openOptions', { tab: 'status' }).catch(() => {});
    });
    body.append(h('div', { class: 'ufoot' }, more));
  }

  /* ---------------------------------------------------------------- */

  private segmented<T extends string>(items: [T, string][], get: () => T, set: (v: T) => void): HTMLDivElement {
    const seg = h('div', { class: 'seg', role: 'group' });
    for (const [v, label] of items) {
      const b = h('button', { 'data-v': v, 'aria-pressed': String(get() === v) }, label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        set(v);
      });
      seg.appendChild(b);
    }
    return seg;
  }

  private refreshSeg(seg: HTMLElement, v: string) {
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  }

  private topFor(y: number): number {
    return Math.round(Math.min(window.innerHeight - SIZE - 12, Math.max(12, y * window.innerHeight - SIZE / 2)));
  }

  private place() {
    this.wrap.style.top = `${this.topFor(this.settings.ball.y)}px`;
  }

  /**
   * 小窗默认与球垂直居中；靠近屏幕上下边时整体挪进屏幕里，球不动。
   * keepTop：展开 / 收起额度详情时保持顶部不动（只在超出屏幕时调整），避免内容上下跳。
   */
  private positionMenu(keepTop = false) {
    const mh = this.menu.offsetHeight;
    const top = this.wrap.getBoundingClientRect().top;
    let offset = keepTop && this.menu.style.top ? parseFloat(this.menu.style.top) : (SIZE - mh) / 2;
    offset = Math.max(8 - top, Math.min(window.innerHeight - 8 - mh - top, offset));
    this.menu.style.top = `${Math.round(offset)}px`;
  }

  private onScroll() {
    if (this.dragging || this.wrap.classList.contains('open')) return;
    this.wrap.classList.add('scrolling');
    clearTimeout(this.scrollTimer);
    this.scrollTimer = window.setTimeout(() => this.wrap.classList.remove('scrolling'), 650);
  }

  private hover(on: boolean) {
    if (this.dragging) return;
    clearTimeout(this.dockTimer);
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    if (on) {
      this.wrap.classList.remove('docked');
      this.feed.open(); // 提前连上，小窗展开时用量多半已经到了
      this.actions.warm?.();
      this.openTimer = window.setTimeout(() => {
        this.wrap.classList.add('open');
        this.positionMenu();
      }, 320);
    } else {
      // 下拉框展开时鼠标会「离开」小窗，这时不收起
      if ([...this.selects.values()].some((s) => this.ui.root.activeElement === s)) return;
      this.closeTimer = window.setTimeout(() => {
        this.wrap.classList.remove('open');
        this.feed.close();
      }, 300);
      this.dockTimer = window.setTimeout(() => this.wrap.classList.add('docked'), 1600);
    }
  }

  private async hideOnSite() {
    const list = [...new Set([...this.settings.ball.hiddenOn, location.hostname])];
    await saveUiSettings({ ball: { ...this.settings.ball, hiddenOn: list } });
  }

  private bindDrag() {
    let startY = 0;
    let startX = 0;
    let startTop = 0;
    let pressed = false;
    this.ball.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pressed = true;
      this.dragging = false;
      startY = e.clientY;
      startX = e.clientX;
      startTop = this.wrap.getBoundingClientRect().top;
      this.ball.setPointerCapture(e.pointerId);
    });
    this.ball.addEventListener('pointermove', (e) => {
      if (!pressed) return;
      if (!this.dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
      if (!this.dragging) {
        this.dragging = true;
        clearTimeout(this.openTimer);
        this.wrap.classList.remove('open', 'docked');
        this.wrap.classList.add('dragging');
      }
      const top = Math.min(window.innerHeight - SIZE - 12, Math.max(12, startTop + e.clientY - startY));
      this.wrap.style.top = `${Math.round(top)}px`;
      const side = e.clientX < window.innerWidth / 2 ? 'left' : 'right';
      this.wrap.classList.toggle('left', side === 'left');
      this.wrap.classList.toggle('right', side === 'right');
    });
    const end = (e: PointerEvent) => {
      if (!pressed) return;
      pressed = false;
      if (!this.dragging) {
        if (e.type === 'pointerup') this.actions.toggle();
        return;
      }
      this.dragging = false;
      this.wrap.classList.remove('dragging');
      const side = e.clientX < window.innerWidth / 2 ? 'left' : 'right';
      const rect = this.wrap.getBoundingClientRect();
      const y = Math.min(0.95, Math.max(0.03, (rect.top + SIZE / 2) / window.innerHeight));
      void saveUiSettings({ ball: { ...this.settings.ball, side, y } });
    };
    this.ball.addEventListener('pointerup', end);
    this.ball.addEventListener('pointercancel', end);
    this.ball.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.actions.toggle();
      } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ContextMenu'].includes(e.key)) {
        // 键盘也能打开设置小窗：方向键（或菜单键）展开并把焦点移进去
        e.preventDefault();
        this.openMenu(true);
      }
    });
    this.bindKeyboard();
  }

  /** 展开设置小窗；focus = true 时把焦点放到第一个可操作的控件上。 */
  private openMenu(focus: boolean) {
    clearTimeout(this.closeTimer);
    clearTimeout(this.openTimer);
    clearTimeout(this.dockTimer);
    this.wrap.classList.remove('docked');
    this.feed.open();
    this.wrap.classList.add('open');
    this.positionMenu();
    if (focus) this.focusables()[0]?.focus();
  }

  private focusables(): HTMLElement[] {
    return [...this.menu.querySelectorAll<HTMLElement>('button, select, a[href], input, [tabindex="0"]')].filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
  }

  /**
   * 小窗里的键盘操作：Tab / Shift+Tab 在控件之间走，↑↓ 也行；分段按钮里 ←→ 换选项；Esc 收起并回到圆球。
   * 焦点离开整个悬浮球（Tab 出去）时收起。
   */
  private bindKeyboard() {
    this.menu.addEventListener('keydown', (e) => {
      const items = this.focusables();
      const cur = this.ui.root.activeElement as HTMLElement | null;
      const i = cur ? items.indexOf(cur) : -1;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.wrap.classList.remove('open');
        this.ball.focus();
        return;
      }
      if (cur?.tagName === 'SELECT' || cur?.tagName === 'INPUT') return; // 让下拉框自己处理方向键
      const seg = cur?.closest('.seg');
      if (seg && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const bs = [...seg.querySelectorAll<HTMLButtonElement>('button')];
        const j = bs.indexOf(cur as HTMLButtonElement);
        const next = bs[(j + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length];
        e.preventDefault();
        next.focus();
        next.click();
        return;
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
        e.preventDefault();
        // 同一组分段按钮算一项：跳到下一组的第一个
        const step = e.key === 'ArrowDown' ? 1 : -1;
        let j = i;
        do j = (j + step + items.length) % items.length;
        while (seg && items[j].closest('.seg') === seg && j !== i);
        items[j].focus();
      }
    });
    this.wrap.addEventListener('focusout', (e) => {
      const to = (e as FocusEvent).relatedTarget as Node | null;
      if (to && this.wrap.contains(to)) return;
      // 下拉框展开时焦点还在 select 上；真正离开才收起
      window.setTimeout(() => {
        if (!this.wrap.matches(':focus-within') && !this.wrap.matches(':hover')) this.wrap.classList.remove('open');
      }, 0);
    });
  }
}

function engineSignature(tier: Tier, s: StatusSnapshot | null): string {
  if (!s) return 'none';
  return s.providers
    .filter((p) => p.usedFor.includes(tier) && p.enabled)
    .map((p) => [p.id, p.name, p.health, p.pinned ? 1 : 0, p.active ? 1 : 0, p.rank ?? '', p.latencyP50Ms ? Math.round(p.latencyP50Ms / 50) : ''].join(':'))
    .join('|');
}

function usageSignature(s: StatusSnapshot | null): string {
  if (!s) return 'none';
  return s.providers
    .filter((p) => p.enabled && p.configured !== false && p.health !== 'unconfigured' && p.quota && p.quota.amount > 0)
    .map((p) => [p.id, p.name, p.health, p.quota!.unit, p.quota!.amount, Math.round(p.quota!.used / 100), p.quota!.period].join(':'))
    .join('|') || 'unlimited';
}
