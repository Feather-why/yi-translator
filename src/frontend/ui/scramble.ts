/**
 * 等待效果：译文还没到时，在译文的位置显示一串快速跳动的字符；译文到达时从左到右「定格」成真正的文字。
 *
 * - 跳动的字符数按原文长度估算，提前占好位置，译文出现时版面几乎不跳；
 * - 只更新在屏幕上的元素（IntersectionObserver），屏幕外的不耗 CPU；
 * - 系统开启「减少动态效果」时自动退回静态省略号；
 * - 页面和 Shadow DOM（划词小窗）都能用。
 */

const POOLS: Record<string, string> = {
  zh: '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经之进着等部度家电力里如水化高自理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天四日那',
  ja: 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんアイウカキクサシスタチツナニハヒフマミムラリル日本語文字時間',
  ko: '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호',
  latin: 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzetaoinshr',
};

function poolFor(lang: string): string {
  const l = lang.toLowerCase();
  if (l.startsWith('zh')) return POOLS.zh;
  if (l.startsWith('ja')) return POOLS.ja;
  if (l.startsWith('ko')) return POOLS.ko;
  return POOLS.latin;
}

/** 目标语言大约是原文长度的多少倍（英文 → 中文约 0.45）。 */
export function estimateLength(sourceChars: number, targetLang: string, max = 80): number {
  const l = targetLang.toLowerCase();
  const ratio = l.startsWith('zh') || l.startsWith('ja') || l.startsWith('ko') ? 0.45 : 1;
  return Math.max(2, Math.min(max, Math.round(sourceChars * ratio)));
}

const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const scrambleEnabled = !reduceMotion;

interface Spinner {
  node: Text;
  len: number;
  pool: string;
}

const spinners = new Map<Element, Spinner>();
const visible = new WeakSet<Element>();
let io: IntersectionObserver | null = null;
let timer = 0;

function rand(pool: string, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += pool[(Math.random() * pool.length) | 0];
  return s;
}

function observer(): IntersectionObserver {
  if (!io) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
    });
  }
  return io;
}

function tick() {
  for (const [el, sp] of spinners) {
    if (!el.isConnected) {
      spinners.delete(el);
      io?.unobserve(el);
      continue;
    }
    if (visible.has(el)) sp.node.data = rand(sp.pool, sp.len);
  }
  timer = spinners.size ? window.setTimeout(tick, 70) : 0;
}

/**
 * 在 el 里显示跳动的字符（会替换 el 的内容）。
 * 字符放在一个 aria-hidden 的 span 里，读屏软件不会读出乱码。
 */
export function startScramble(el: HTMLElement, len: number, lang: string): void {
  if (!scrambleEnabled) return;
  const pool = poolFor(lang);
  const span = document.createElement('span');
  span.className = 'tx-scr';
  span.setAttribute('aria-hidden', 'true');
  const node = document.createTextNode(rand(pool, len));
  span.appendChild(node);
  el.replaceChildren(span);
  el.setAttribute('aria-busy', 'true');
  spinners.set(el, { node, len, pool });
  observer().observe(el);
  if (!timer) timer = window.setTimeout(tick, 70);
}

export function stopScramble(el: Element): void {
  if (spinners.delete(el)) io?.unobserve(el);
  el.removeAttribute('aria-busy');
}

/* ------------------------------------------------------------------ */

const SKIP_REVEAL = 'code,kbd,samp,var,pre,.tx-autolink';
const KEEP = /[\s\p{P}\p{S}\p{N}]/u;

interface Reveal {
  nodes: { node: Text; final: string; start: number }[];
  total: number;
  t0: number;
  dur: number;
  pool: string;
}

const reveals = new Map<Element, Reveal>();
let raf = 0;

function frame(now: number) {
  for (const [el, r] of reveals) {
    const p = (now - r.t0) / r.dur;
    if (p >= 1 || !el.isConnected) {
      for (const n of r.nodes) n.node.data = n.final;
      reveals.delete(el);
      continue;
    }
    for (const n of r.nodes) {
      let s = '';
      for (let i = 0; i < n.final.length; i++) {
        const c = n.final[i];
        // 每个字在自己的时刻定格：越靠后越晚，带一点随机，看起来像逐字解码
        const lockAt = ((n.start + i) / r.total) * 0.75 + ((n.start + i) * 0.618 % 1) * 0.25;
        s += p >= lockAt || KEEP.test(c) ? c : r.pool[(Math.random() * r.pool.length) | 0];
      }
      n.node.data = s;
    }
  }
  raf = reveals.size ? requestAnimationFrame(frame) : 0;
}

/**
 * el 的内容刚换成译文：把其中的文字先打乱，再在 dur 毫秒内从左到右定格。
 * 只改文本节点的内容、不改结构，链接、加粗、代码都保持原样；代码和网址不参与打乱。
 */
export function revealText(el: HTMLElement, lang: string, dur = 140): void {
  stopScramble(el);
  if (!scrambleEnabled) return;
  const pool = poolFor(lang);
  const nodes: Reveal['nodes'] = [];
  let total = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!n.data.trim() || n.parentElement?.closest(SKIP_REVEAL)) continue;
    nodes.push({ node: n, final: n.data, start: total });
    total += n.data.length;
  }
  if (!total) return;
  // 定格要快：读者在等的是译文，不是动画。字多时略长一点，最长 0.26 秒
  const d = Math.min(dur + total * 0.6, 260);
  reveals.set(el, { nodes, total, t0: performance.now(), dur: d, pool });
  if (!raf) raf = requestAnimationFrame(frame);
}

/** 立即结束 el 上正在进行的定格动画（例如内容又要被替换）。 */
export function finishReveal(el: Element): void {
  const r = reveals.get(el);
  if (!r) return;
  for (const n of r.nodes) n.node.data = n.final;
  reveals.delete(el);
}
