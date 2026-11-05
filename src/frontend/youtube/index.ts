/**
 * YouTube 双语字幕（内容脚本，隔离环境）。
 *
 * 主路径：MAIN world 钩子（./hook.ts）转来播放器自己拿到的整条字幕 → 按句合并 →
 *   后端 subtitle:translate 批量翻译（当前播放位置附近的先翻）→ 在播放器里画我们自己的双语字幕，
 *   同时隐藏原生字幕。时间轴完全来自原字幕，模型不生成时间。
 * 兜底：没拿到整条字幕（例如扩展是在视频播放中途装上的），就读页面上正在显示的原生字幕，
 *   逐行翻译，把译文显示在原生字幕上方。
 *
 * 只有用户在播放器里打开了字幕（CC）时才工作。播放器右下角的「译」按钮打开字幕设置小菜单：
 * 开关、显示方式、译文/原文谁在上、字号、背景透明度、双语字幕稿侧栏；字幕本身可以上下拖动。
 */
import type { SubtitleInput } from '../../shared/backend-v2';
import { rpc } from '../../shared/rpc';
import { hostMatches, loadUiSettings, onUiSettingsChanged, saveUiSettings, type UiSettings } from '../../shared/settings';
import { mediaCaps } from '../media/capabilities';
import { logoSvg } from '../ui/logo';
import { YT_MESSAGE } from './hook';
import { SubtitleMenu } from './menu';
import { TranscriptPanel } from './panel';
import { L, setUiLang } from '../i18n';

interface Cue {
  id: string;
  start: number;
  end: number;
  text: string;
}

interface Track {
  videoId: string;
  lang: string;
  cues: Cue[];
  tr: Map<string, string>;
  requested: Set<string>;
}

const PAGE_CSS = `
html[data-tx-yt-track] .ytp-caption-window-container { visibility: hidden !important; }
.tx-yt-btn { display: inline-flex !important; align-items: center; justify-content: center; vertical-align: top; color: #fff; --logo-accent: #fff; opacity: .9; }
.tx-yt-btn[aria-pressed="false"] { opacity: .55; }
.tx-yt-btn[aria-pressed="true"] { --logo-accent: #96a3d9; }
.tx-yt-btn svg { width: 24px; height: 24px; }
`;

const OVERLAY_CSS = `
:host { all: initial; position: absolute; left: 0; right: 0; z-index: 60; pointer-events: none; display: flex; justify-content: center; }
.box { max-width: 86%; display: flex; flex-direction: column; align-items: center; gap: .12em; text-align: center; pointer-events: auto; cursor: grab; touch-action: none; user-select: none; }
.box.drag { cursor: grabbing; }
.line { display: inline; padding: .08em .45em; border-radius: .18em; background: rgba(8, 8, 8, var(--bg-a, .72)); color: #fff;
  font-family: "YouTube Noto", Roboto, Arial, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; line-height: 1.32;
  box-decoration-break: clone; -webkit-box-decoration-break: clone; white-space: pre-line; text-shadow: 0 0 2px rgba(0,0,0,.4); }
.tr { font-weight: 500; }
.src { opacity: .86; }
`;

const SENTENCE_END = /[.!?。！？…♪]["'”’)\]]*$/;

/* ------------------------------------------------------------------ */
/* 解析字幕                                                             */
/* ------------------------------------------------------------------ */

interface Word {
  t: number;
  end?: number;
  text: string;
}

function parseTimedText(body: string): Word[] {
  const s = body.trim();
  if (s.startsWith('{')) {
    const j = JSON.parse(s) as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number }[] }[] };
    const out: Word[] = [];
    for (const ev of j.events ?? []) {
      if (!ev.segs) continue;
      const t0 = ev.tStartMs ?? 0;
      for (const seg of ev.segs) {
        const text = (seg.utf8 ?? '').replace(/\n/g, ' ');
        if (!text.trim()) continue;
        out.push({ t: t0 + (seg.tOffsetMs ?? 0), end: ev.segs.length === 1 && ev.dDurationMs ? t0 + ev.dDurationMs : undefined, text });
      }
    }
    return out;
  }
  // srv3 / 旧版 XML：<p t="" d="">…</p> 或 <text start="" dur="">…</text>
  const doc = new DOMParser().parseFromString(s, 'text/xml');
  const out: Word[] = [];
  doc.querySelectorAll('p, text').forEach((el) => {
    const isP = el.tagName === 'p';
    const t = isP ? Number(el.getAttribute('t')) : Number(el.getAttribute('start')) * 1000;
    const d = isP ? Number(el.getAttribute('d')) : Number(el.getAttribute('dur')) * 1000;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text && Number.isFinite(t)) out.push({ t, end: Number.isFinite(d) ? t + d : undefined, text });
  });
  return out;
}

/** 把逐词 / 逐行的字幕合并成句子：遇到句末标点、停顿超过 1.2 秒或太长就断开。 */
function buildCues(words: Word[]): Cue[] {
  words.sort((a, b) => a.t - b.t);
  const cues: Cue[] = [];
  let cur: { start: number; end: number; parts: string[] } | null = null;
  const flush = (nextStart?: number) => {
    if (!cur) return;
    const text = cur.parts.join('').replace(/\s+/g, ' ').trim();
    if (text) cues.push({ id: `c${cues.length}`, start: cur.start, end: Math.max(cur.end, Math.min(nextStart ?? cur.end + 1500, cur.end + 1500)), text });
    cur = null;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (cur && (w.t - cur.end > 1200 || cur.parts.join('').length > 110)) flush(w.t);
    if (!cur) cur = { start: w.t, end: w.end ?? w.t, parts: [] };
    const needSpace = cur.parts.length && !/\s$/.test(cur.parts[cur.parts.length - 1]) && !/^\s/.test(w.text) && /[\p{L}\p{N}]$/u.test(cur.parts[cur.parts.length - 1]) && /^[\p{L}\p{N}]/u.test(w.text) && !/\p{Script=Han}/u.test(w.text);
    cur.parts.push((needSpace ? ' ' : '') + w.text);
    cur.end = Math.max(cur.end, w.end ?? w.t + 300);
    if (SENTENCE_END.test(w.text.trim())) flush(words[i + 1]?.t);
  }
  flush();
  // 结束时间不超过下一句开始
  for (let i = 0; i < cues.length - 1; i++) cues[i].end = Math.min(cues[i].end, cues[i + 1].start);
  return cues;
}

/* ------------------------------------------------------------------ */

export async function startYoutube(): Promise<void> {
  if (window.top !== window) return;
  let settings = await loadUiSettings();
  setUiLang(settings.uiLang);
  const saveSub = (patch: Partial<UiSettings['subtitles']>) => void saveUiSettings({ subtitles: { ...settings.subtitles, ...patch } });
  const menu = new SubtitleMenu(saveSub);
  const panel = new TranscriptPanel(
    (ms) => {
      const v = video();
      if (v) v.currentTime = ms / 1000 + 0.01;
    },
    () => saveSub({ panel: false }),
    () => (track ? track.cues.map((c) => `[${fmtTime(c.start)}] ${track!.tr.get(c.id) ?? ''}\n${c.text}`).join('\n\n') : ''),
  );
  const style = document.createElement('style');
  style.textContent = PAGE_CSS;
  (document.head || document.documentElement).appendChild(style);

  let track: Track | null = null;
  const pendingBodies: { url: string; body: string }[] = [];
  let ready = false;
  const stopWatchingSettings = onUiSettingsChanged((s) => {
    settings = s;
    if (ready) {
      menu.update(s.subtitles);
      attach(true);
    }
  });

  const receiveTimedText = (e: MessageEvent) => {
    if (e.source !== window || !e.data || e.data[YT_MESSAGE] !== true) return;
    const { url, body } = e.data as { url: string; body: string };
    if (typeof url !== 'string' || typeof body !== 'string') return;
    if (!ready) pendingBodies.push({ url, body });
    else onTimedText(url, body);
  };
  window.addEventListener('message', receiveTimedText);

  const caps = await mediaCaps();
  if (!caps.subtitles) {
    window.removeEventListener('message', receiveTimedText);
    stopWatchingSettings();
    return;
  }

  const videoId = () => new URL(location.href).searchParams.get('v') || '';
  const player = () => document.querySelector<HTMLElement>('#movie_player, .html5-video-player');
  const video = () => player()?.querySelector<HTMLVideoElement>('video') ?? null;
  const ccOn = () => document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'true';
  const sensitive = () => hostMatches(location.hostname, settings.sensitive);

  function onTimedText(url: string, body: string) {
    let u: URL;
    try {
      u = new URL(url, location.href);
    } catch {
      return;
    }
    const v = u.searchParams.get('v') || videoId();
    if (!v || v !== videoId()) return;
    const tlang = u.searchParams.get('tlang');
    const lang = tlang || u.searchParams.get('lang') || 'auto';
    if (lang.split('-')[0].toLowerCase() === settings.targetLang.split('-')[0].toLowerCase()) {
      track = null; // 字幕已经是目标语言（包括 YouTube 自带的自动翻译）
      document.documentElement.removeAttribute('data-tx-yt-track');
      return;
    }
    let cues: Cue[];
    try {
      cues = buildCues(parseTimedText(body));
    } catch {
      return;
    }
    if (!cues.length) return;
    track = { videoId: v, lang, cues, tr: new Map(), requested: new Set() };
    fallbackLines.clear();
    void translateAround();
    render(true);
  }

  /* ---------------- 翻译 ---------------- */

  let translating = false;
  async function translateAround() {
    if (translating || !track || !settings.subtitles.enabled) return;
    translating = true;
    try {
      while (track && settings.subtitles.enabled) {
        const t = track;
        const now = (video()?.currentTime ?? 0) * 1000;
        // 当前位置往后的先翻，再翻前面的
        const order = [...t.cues].filter((c) => !t.requested.has(c.id)).sort((a, b) => {
          const da = a.end < now ? 1e12 + (now - a.end) : Math.max(0, a.start - now);
          const db = b.end < now ? 1e12 + (now - b.end) : Math.max(0, b.start - now);
          return da - db;
        });
        if (!order.length) break;
        const batch: Cue[] = [];
        let chars = 0;
        for (const c of order) {
          // 超过后端单行上限时保留原文，继续处理后续字幕，不能反复派发空批次。
          if (c.text.length > 12_000) { t.requested.add(c.id); continue; }
          if (batch.length >= 80 || chars + c.text.length > 12000) break;
          batch.push(c);
          chars += c.text.length;
        }
        if (!batch.length) break;
        batch.sort((a, b) => a.start - b.start); // 按时间顺序发，后端用相邻行做上下文
        batch.forEach((c) => t.requested.add(c.id));
        try {
          const segments: SubtitleInput[] = batch.map((c) => ({ id: c.id, text: c.text, startMs: Math.round(c.start), endMs: Math.round(c.end) }));
          const r = await rpc('subtitle:translate', {
            videoId: t.videoId,
            segments,
            sourceLang: t.lang === 'auto' ? 'auto' : t.lang,
            targetLang: settings.targetLang,
            mode: settings.mode,
            context: { url: location.href, title: document.title },
            noCache: sensitive() || undefined,
          });
          for (const s of r.segments) if (s.text && !s.error) t.tr.set(s.id, s.text);
          render(true);
        } catch {
          batch.forEach((c) => t.requested.delete(c.id));
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    } finally {
      translating = false;
    }
  }

  /* ---------------- 兜底：读原生字幕 ---------------- */

  const fallbackLines = new Map<string, string | null>(); // 原文 → 译文（null = 翻译中）
  let fallbackText = '';
  let captionRoot: Element | null = null;
  let captionTimer = 0;
  // 原生字幕常逐词改 DOM。合并短时间内的变化，只翻译当前仍可见的最新文本。
  function scheduleCaptionRead() {
    if (!captionTimer && !track && settings.subtitles.enabled) captionTimer = window.setTimeout(readCaption, 80);
  }
  const fallbackObserver = new MutationObserver(scheduleCaptionRead);
  function readCaption() {
    captionTimer = 0;
    if (!captionRoot?.isConnected || track || !settings.subtitles.enabled || !ccOn()) return;
    const segs = [...captionRoot.querySelectorAll('.ytp-caption-segment')];
    const text = segs.map((s) => s.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
    if (text === fallbackText) return;
    fallbackText = text;
    if (text && !fallbackLines.has(text)) {
      fallbackLines.set(text, null);
      rpc('subtitle:translate', {
        videoId: videoId() || 'unknown',
        segments: [{ id: 'l' + fallbackLines.size, text }],
        sourceLang: 'auto',
        targetLang: settings.targetLang,
        mode: 'fast',
        context: { url: location.href, title: document.title },
        noCache: sensitive() || undefined,
      })
        .then((r) => {
          fallbackLines.set(text, r.segments[0]?.text || null);
          render(true);
        })
        .catch(() => fallbackLines.delete(text));
    }
    render(true);
  }

  /* ---------------- 显示 ---------------- */

  let host: HTMLElement | null = null;
  let box: HTMLDivElement | null = null;
  let lastKey = '';

  function ensureOverlay(p: HTMLElement) {
    if (host && host.parentElement === p) return;
    host?.remove();
    host = document.createElement('tx-yt');
    host.setAttribute('translate', 'no');
    const root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = OVERLAY_CSS;
    box = document.createElement('div');
    box.className = 'box';
    box.title = L('拖动调整位置，双击恢复', 'Drag to move, double-click to reset');
    root.append(st, box);
    p.appendChild(host);
    lastKey = '';
    // 拖动字幕：上下移动，松手后记住位置（距底部的比例）。事件不传给播放器，免得拖一下就暂停
    const h = host;
    const b = box;
    for (const t of ['click', 'mousedown', 'dblclick', 'contextmenu']) h.addEventListener(t, (e) => e.stopPropagation());
    b.addEventListener('dblclick', () => saveSub({ offsetY: null }));
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const ph = p.clientHeight || 360;
      const startY = e.clientY;
      const startBottom = parseFloat(h.style.bottom) || 0;
      let moved = false;
      b.setPointerCapture(e.pointerId);
      b.classList.add('drag');
      dragging = true;
      const move = (ev: PointerEvent) => {
        const nb = Math.max(4, Math.min(ph * 0.9, startBottom - (ev.clientY - startY)));
        if (Math.abs(ev.clientY - startY) > 3) moved = true;
        h.style.bottom = `${Math.round(nb)}px`;
      };
      const up = () => {
        b.removeEventListener('pointermove', move);
        b.removeEventListener('pointerup', up);
        b.removeEventListener('pointercancel', up);
        b.classList.remove('drag');
        dragging = false;
        if (moved) saveSub({ offsetY: Math.round(((parseFloat(h.style.bottom) || 0) / ph) * 1000) / 1000 });
      };
      b.addEventListener('pointermove', move);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    });
  }
  let dragging = false;

  function render(force = false) {
    const p = player();
    const sub = settings.subtitles;
    if (force) syncPanel();
    const on = sub.enabled && ccOn() && !!p;
    const useTrack = on && !!track && track.videoId === videoId();
    document.documentElement.toggleAttribute('data-tx-yt-track', useTrack);
    if (track && track.videoId === videoId() && sub.panel) {
      const cue = findCue(track.cues, (video()?.currentTime ?? 0) * 1000);
      panel.setCurrent(cue?.id ?? null);
    }
    if (!on || !p) {
      if (host) host.style.display = 'none';
      return;
    }
    ensureOverlay(p);
    if (dragging) return;
    const ph = p.clientHeight || 360;
    const fs = Math.max(14, Math.min(34, ph * 0.042)) * (sub.fontScale || 1);
    let src = '';
    let tr = '';
    let bottom: number;
    if (useTrack) {
      const now = (video()?.currentTime ?? 0) * 1000;
      const cue = findCue(track!.cues, now);
      src = cue?.text ?? '';
      tr = cue ? track!.tr.get(cue.id) ?? '' : '';
      bottom = sub.offsetY !== null && sub.offsetY !== undefined ? sub.offsetY * ph : ph * 0.06 + (p.classList.contains('ytp-autohide') ? 0 : 48);
    } else {
      // 兜底：译文放在原生字幕上方
      tr = fallbackText ? fallbackLines.get(fallbackText) ?? '' : '';
      const cap = document.querySelector('.ytp-caption-window-container .caption-window');
      const pr = p.getBoundingClientRect();
      const cr = cap?.getBoundingClientRect();
      bottom = cr && cr.height ? pr.bottom - cr.top + 4 : ph * 0.18;
    }
    const showSrc = useTrack && sub.display === 'bilingual';
    const key = `${src}|${tr}|${fs}|${bottom}|${showSrc}|${sub.order}|${sub.bgOpacity}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    host!.style.display = src || tr ? '' : 'none';
    host!.style.bottom = `${Math.round(bottom)}px`;
    host!.style.setProperty('--bg-a', String(Math.max(0, Math.min(1, sub.bgOpacity ?? 0.72))));
    const lines: HTMLElement[] = [];
    if (tr) lines.push(line('tr', tr, fs));
    if (showSrc && src) {
      const l = line('src', src, fs * 0.78);
      if (sub.order === 'src-first') lines.unshift(l);
      else lines.push(l);
    }
    if (useTrack && !tr && src && !showSrc) lines.push(line('src', src, fs)); // 还没翻好时先显示原文
    box!.replaceChildren(...lines);
  }

  /** 字幕稿侧栏：打开时挂到右侧栏，字幕或译文变了就刷新。 */
  function syncPanel() {
    if (!settings.subtitles.panel || !videoId()) return panel.remove();
    panel.mount();
    const t = track && track.videoId === videoId() ? track : null;
    panel.setCues(t?.cues ?? null, t?.tr ?? new Map());
  }

  function line(cls: string, text: string, fs: number) {
    const wrap = document.createElement('div');
    const s = document.createElement('span');
    s.className = 'line ' + cls;
    s.textContent = text;
    s.style.fontSize = `${fs}px`;
    wrap.appendChild(s);
    return wrap;
  }

  function findCue(cues: Cue[], t: number): Cue | null {
    let lo = 0;
    let hi = cues.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const c = ans >= 0 ? cues[ans] : null;
    return c && t < c.end ? c : null;
  }

  // 播放时 10 次/秒刷新；暂停、跳转时也刷新一次
  let ticker = 0;
  const tick = () => {
    render();
    const v = video();
    ticker = v && !v.paused ? window.setTimeout(tick, 100) : 0;
  };
  const kick = () => {
    if (!ticker) tick();
  };
  document.addEventListener('play', kick, true);
  document.addEventListener('seeked', () => render(true), true);
  document.addEventListener('pause', () => render(true), true);

  /* ---------------- 播放器按钮 ---------------- */

  function syncButton(controls: Element) {
    let btn = controls.querySelector<HTMLButtonElement>('.tx-yt-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'ytp-button tx-yt-btn';
      btn.innerHTML = logoSvg({ size: 24 });
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = player();
        if (p) menu.mount(p);
        menu.toggle(settings.subtitles);
      });
      controls.insertBefore(btn, controls.firstChild);
    }
    btn.setAttribute('aria-pressed', String(settings.subtitles.enabled));
    btn.title = settings.subtitles.enabled ? L('双语字幕：已开（点击调整）', 'Bilingual subtitles: on (click to adjust)') : L('双语字幕：已关（点击打开设置）', 'Bilingual subtitles: off (click to open settings)');
    btn.setAttribute('aria-label', btn.title);
    if (settings.subtitles.enabled) void translateAround();
    return btn;
  }

  let controls: Element | null = null;
  let button: HTMLButtonElement | null = null;
  let repairTimer = 0;
  let retryDelay = 0;
  let lastRepair = -Infinity;

  function attach(force = false) {
    const nextControls = document.querySelector('.ytp-right-controls');
    const controlsChanged = controls !== nextControls || (!!nextControls && button?.parentElement !== nextControls);
    if (controlsChanged || force) {
      const now = performance.now();
      if (controlsChanged) {
        retryDelay = nextControls === controls && now - lastRepair < 5000 ? Math.min(2000, Math.max(100, retryDelay * 2)) : 0;
        lastRepair = now;
      }
      controls = nextControls;
      button = controls && syncButton(controls);
    }
    const cont = document.querySelector('.ytp-caption-window-container');
    const captionsChanged = cont !== captionRoot;
    if (captionsChanged) {
      fallbackObserver.disconnect();
      captionRoot = cont;
      fallbackText = '';
      if (cont) fallbackObserver.observe(cont, { childList: true, subtree: true, characterData: true });
    }
    if (captionsChanged || force) scheduleCaptionRead();
    if (controlsChanged || captionsChanged || force) render(true);
  }
  // 单页应用：换视频时清空，播放器控件出现后再挂按钮
  document.addEventListener('yt-navigate-finish', () => {
    if (track && track.videoId !== videoId()) track = null;
    fallbackLines.clear();
    fallbackText = '';
    attach(true);
  });
  const mo = new MutationObserver(() => {
    if (repairTimer || (controls?.isConnected && button?.parentElement === controls && captionRoot?.isConnected)) return;
    // 播放器可能立即删除自定义控件。把修复留给后续任务，重复删除时延长重试间隔。
    // 首页/播放列表没有播放器时，连续 DOM 更新也只合并为一次查询。
    repairTimer = window.setTimeout(() => {
      repairTimer = 0;
      attach();
    }, controls?.isConnected && button?.parentElement !== controls ? Math.max(80, retryDelay) : 80);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  // CC 按钮状态变化
  document.addEventListener('click', (e) => {
    if ((e.target as Element | null)?.closest?.('.ytp-subtitles-button')) setTimeout(() => { scheduleCaptionRead(); render(true); }, 50);
  }, true);
  // 播放器可在能力探测完成前返回整轨字幕，所有渲染与调度状态就绪后再消费。
  ready = true;
  pendingBodies.splice(0).forEach(({ url, body }) => onTimedText(url, body));
  attach(true);
  kick();
}

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const __test = { parseTimedText, buildCues };
