/**
 * 整页翻译：扫描段落 → 进入视口才请求 → 流式渲染 → 跟踪页面变化。
 */
import type { ErrorInfo, Mode, SegmentTiming, SiteRule, Stage, TranslateJob } from '../../shared/protocol';
import { rpc, uid } from '../../shared/rpc';
import { hostMatches, type UiSettings } from '../../shared/settings';
import { displayOf, insideOurs, isOurs, isPinnedLabel, isVisiblyRendered } from './dom';
import { installLinkForwarding } from './links';
import type { JobHandlers, TranslateClient } from './port';
import { looksLikeTarget, scan, type UnitSpec } from './scanner';
import { insertAfterChunk, restore, serialize, splitSentences, type Serialized } from './serialize';
import { installPageStyle, removePageStyle, styleTranslation } from './style';
import { FirstScreenPerf } from './perf';
import { cachedRule, sameEffect, storeRule } from './rule-cache';
import { detectContent, scopeAllows, scopeFilter, type ContentScope } from './main-content';
import { estimateLength, finishReveal, revealText, scrambleEnabled, startScramble, stopScramble } from '../ui/scramble';
import { L } from '../i18n';

export type PartStage = 'pending' | Stage | 'error';
export type UnitMode = 'block' | 'inline' | 'sentence';

export interface Part {
  segId: string;
  tx: HTMLElement;
  /** 发给后端的带占位符文本。 */
  text: string;
  /** 逐句模式下这一句用到的占位符。 */
  slots?: Set<number>;
  stage: PartStage;
  translated?: string;
  provider?: string;
  jobId?: string;
  error?: ErrorInfo;
  priority: number;
  /** 流式：正在显示哪个阶段的中间结果、最新的中间文本、待画的帧。 */
  streamStage?: Stage;
  streamText?: string;
  streamRaf?: number;
}

export interface Unit {
  id: string;
  root: Element;
  nodes: Node[];
  whole: boolean;
  ser: Serialized;
  parts: Part[];
  state: 'idle' | 'requested' | 'skipped';
  mode: UnitMode;
  version: number;
  /** 逐句模式拆开的文本节点：[原节点, 新节点, 拆开后原节点的内容]。 */
  splits: [Text, Text, string][];
}

export interface Progress {
  active: boolean;
  total: number;
  done: number;
  errors: number;
  lastError?: ErrorInfo;
}

const HEADING = /^H[1-6]$/;
const SENTENCE_PUNCT = /[.!?。！？;；:：]/;

export class PageTranslator {
  active = false;
  private settings: UiSettings;
  private rule: SiteRule | null = null;
  private units = new Map<string, Unit>();
  private byTarget = new Map<Element, Set<Unit>>();
  private nodeUnit = new WeakMap<Node, Unit>();
  private segIndex = new Map<string, { unit: Unit; part: Part }>();
  private jobs = new Set<string>();
  private io: IntersectionObserver | null = null;
  private mo: MutationObserver | null = null;
  private batch = new Map<number, { unit: Unit; part: Part }[]>();
  private flushTimer = 0;
  private dirty = new Set<Unit>();
  private added = new Set<Node>();
  private moTimer = 0;
  private moFirst = 0;
  private progress: Progress = { active: false, total: 0, done: 0, errors: 0 };
  private t0 = 0;
  private perf: FirstScreenPerf | null = null;
  /** 「只翻正文」时认出来的正文范围；null = 整页 */
  private scope: ContentScope | null = null;
  private sensitive = false;
  private context = { url: location.href, title: document.title, summary: '' };

  onProgress?: (p: Progress) => void;

  constructor(private client: TranslateClient, settings: UiSettings) {
    this.settings = settings;
    installLinkForwarding();
    document.addEventListener('click', this.onClick, true);
  }

  get mode(): Mode {
    return this.settings.mode;
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.t0 = performance.now();
    this.perf = new FirstScreenPerf(this.t0, this.settings.mode);
    this.sensitive = hostMatches(location.hostname, this.settings.sensitive);
    this.progress = { active: true, total: 0, done: 0, errors: 0 };
    this.emit();
    // 站点规则：有缓存就直接用、后台再核对；没缓存才等后台（最多 0.4 秒）
    const href = location.href;
    const fresh = rpc('rules:forUrl', { url: href }).then(
      (r) => (void storeRule(href, r ?? null), { ok: true as const, rule: r ?? null }),
      () => ({ ok: false as const, rule: null }),
    );
    const cached = await cachedRule(href);
    if (cached.hit) {
      this.rule = cached.rule;
      this.perf.ruleCached = true;
      void fresh.then((f) => {
        // 规则在别处改过：按新规则重来（通常发生在开始后几百毫秒内，几乎看不出来）
        if (f.ok && this.active && !sameEffect(f.rule, this.rule)) { this.stop(); void this.start(); }
      });
    } else {
      this.rule = await Promise.race([fresh.then((f) => f.rule), new Promise<null>((r) => setTimeout(() => r(null), 400))]);
    }
    if (!this.active) return;
    if (this.rule?.waitFor) await waitFor(this.rule.waitFor, 3000);
    if (!this.active) return;
    const s = this.rule?.display === 'replace' ? { ...this.settings, display: 'translation' as const } : this.settings;
    installPageStyle(s);
    this.context = { url: location.href, title: document.title, summary: '' };

    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: '120% 0px 120% 0px' });
    this.mo = new MutationObserver((recs) => this.onMutations(recs));
    this.mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    this.scope = this.settings.mainOnly && !this.rule?.include?.length ? detectContent() : null;
    this.addUnits(scan(document.body, this.scanOpts()));
    this.context.summary = this.makeSummary();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.perf = null;
    for (const j of this.jobs) this.client.cancel(j);
    this.jobs.clear();
    this.io?.disconnect();
    this.mo?.disconnect();
    this.io = this.mo = null;
    clearTimeout(this.flushTimer);
    clearTimeout(this.moTimer);
    this.flushTimer = this.moTimer = 0;
    this.batch.clear();
    this.dirty.clear();
    this.added.clear();
    for (const u of this.units.values()) this.resetUnit(u);
    this.units.clear();
    this.byTarget.clear();
    this.segIndex.clear();
    this.nodeUnit = new WeakMap();
    removePageStyle();
    this.progress = { active: false, total: 0, done: 0, errors: 0 };
    this.emit();
  }

  toggle(): Promise<void> | void {
    return this.active ? this.stop() : this.start();
  }

  /** 设置变化：影响译文内容的（语言、模式、逐句）就重新翻译；只影响样式的直接换样式。 */
  async updateSettings(next: UiSettings): Promise<void> {
    const prev = this.settings;
    this.settings = next;
    if (!this.active) return;
    if (prev.targetLang !== next.targetLang || (prev.sourceLang || 'auto') !== (next.sourceLang || 'auto') || prev.mode !== next.mode || prev.bilingualStyle !== next.bilingualStyle || prev.mainOnly !== next.mainOnly) {
      this.stop();
      await this.start();
    } else installPageStyle(this.rule?.display === 'replace' ? { ...next, display: 'translation' } : next);
  }

  getProgress(): Progress {
    return this.progress;
  }

  /* ---------------------------------------------------------------- */
  /* 给联动高亮用                                                       */
  /* ---------------------------------------------------------------- */

  /** 一个节点属于哪个单元、在原文侧还是译文侧。 */
  locate(node: Node | null): { unit: Unit; side: 'src' | 'tgt'; part?: Part } | null {
    for (let n: Node | null = node; n && n !== document.body; n = n.parentNode) {
      if (n.nodeType === 1 && (n as Element).localName === 'tx-t') {
        const hit = this.segIndex.get((n as Element).getAttribute('data-tx-seg') || '');
        return hit ? { unit: hit.unit, side: 'tgt', part: hit.part } : null;
      }
      const u = this.nodeUnit.get(n);
      if (u) return u.state === 'requested' ? { unit: u, side: 'src' } : null;
    }
    return null;
  }

  get targetLang(): string {
    return this.settings.targetLang;
  }

  /* ---------------------------------------------------------------- */

  private scanOpts() {
    return {
      include: this.rule?.include,
      exclude: this.rule?.exclude,
      claimed: (n: Node) => this.nodeUnit.has(n),
      filter: this.scope ? scopeFilter(this.scope) : undefined,
    };
  }

  private addUnits(specs: UnitSpec[]) {
    for (const spec of specs) {
      const unit: Unit = {
        id: uid('u'),
        root: spec.root,
        nodes: spec.nodes,
        whole: spec.whole,
        ser: { text: '', slots: [], pos: [], letters: 0 },
        parts: [],
        state: 'idle',
        mode: 'block',
        version: 0,
        splits: [],
      };
      this.units.set(unit.id, unit);
      if (spec.whole) this.nodeUnit.set(spec.root, unit);
      else spec.nodes.forEach((n) => this.nodeUnit.set(n, unit));
      let set = this.byTarget.get(spec.root);
      if (!set) {
        set = new Set();
        this.byTarget.set(spec.root, set);
        this.io?.observe(spec.root);
      }
      set.add(unit);
    }
  }

  private makeSummary(): string {
    let s = '';
    for (const u of this.units.values()) {
      const t = (u.root.textContent || '').trim();
      if (t.length > 40) s += t.replace(/\s+/g, ' ') + ' ';
      if (s.length > 300) break;
    }
    return s.slice(0, 300);
  }

  private onIntersect(entries: IntersectionObserverEntry[]) {
    const vh = window.innerHeight;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const r = e.boundingClientRect;
      const prio = r.bottom > 0 && r.top < vh ? 0 : 1;
      const set = this.byTarget.get(e.target);
      if (!set) continue;
      for (const u of set) if (u.state === 'idle') this.request(u, prio);
    }
  }

  private request(unit: Unit, priority: number) {
    unit.nodes = unit.whole ? Array.from(unit.root.childNodes).filter((n) => !isOurs(n)) : unit.nodes.filter((n) => n.isConnected);
    if (!unit.nodes.length) return;
    unit.ser = serialize(unit.nodes);
    const plain = unit.ser.text.replace(/<\/?[gx]\d+\/?>/g, '');
    const elLang = unit.root.closest('[lang]')?.getAttribute('lang');
    // 网格容器里夹在块之间的文字（页面骨架上的「跳到正文」之类）：译文插进去会变成一个新的网格项，
    // 被拉到整行那么高、还会挤乱整页布局，不翻
    const gridRun = !unit.whole && /grid/.test(displayOf(unit.root));
    if (unit.ser.letters < 2 || looksLikeTarget(plain, this.settings.targetLang, elLang) || gridRun || !isVisiblyRendered(unit.root) || isPinnedLabel(unit.root)) {
      unit.state = 'skipped';
      return;
    }
    unit.state = 'requested';
    const v = ++unit.version;
    const s = this.settings;
    const chunks = s.bilingualStyle === 'sentence' && s.display === 'bilingual' ? splitSentences(unit.ser) : [];

    if (chunks.length >= 2) {
      unit.mode = 'sentence';
      const parts: Part[] = new Array(chunks.length);
      // 从后往前插：前面句子的文本偏移不受影响
      for (let i = chunks.length - 1; i >= 0; i--) {
        const tx = this.makeTx('sentence', chunks[i].text.replace(/<\/?[gx]\d+\/?>/g, '').length);
        const split = insertAfterChunk(unit.ser, chunks[i], tx);
        if (split) unit.splits.push([split[0], split[1], split[0].data]);
        parts[i] = { segId: `${unit.id}.${v}.${i}`, tx, text: chunks[i].text, slots: chunks[i].slots, stage: 'pending', priority };
      }
      unit.parts = parts;
    } else {
      unit.mode = this.pickMode(unit, plain);
      const tx = this.makeTx(unit.mode, plain.length);
      if (unit.whole) unit.root.appendChild(tx);
      else (unit.nodes[unit.nodes.length - 1] as ChildNode).after(tx);
      unit.parts = [{ segId: `${unit.id}.${v}.0`, tx, text: unit.ser.text, stage: 'pending', priority }];
    }
    this.mo?.takeRecords(); // 丢掉我们自己造成的变化

    if (unit.whole) unit.root.setAttribute('data-tx-root', '');
    let css = '';
    for (const p of unit.parts) {
      p.tx.setAttribute('data-tx-seg', p.segId);
      if (!css) {
        styleTranslation(p.tx, unit.root, s.targetLang, unit.mode === 'block', this.rule);
        css = p.tx.style.cssText;
      } else p.tx.style.cssText = css;
      this.segIndex.set(p.segId, { unit, part: p });
      this.enqueue(unit, p, priority);
    }
    this.progress.total += unit.parts.length;
    this.emit();
  }

  private pickMode(unit: Unit, plain: string): UnitMode {
    if (HEADING.test(unit.root.tagName)) return 'block';
    if (!unit.whole) return plain.length > 40 ? 'block' : 'inline';
    const d = getComputedStyle(unit.root).display;
    if (d.includes('flex') || d.includes('grid') || d.startsWith('inline') || d === 'table-cell' && plain.length < 30) return 'inline';
    if (plain.length <= 30 && !SENTENCE_PUNCT.test(plain)) return 'inline';
    return 'block';
  }

  private get scramble(): boolean {
    return scrambleEnabled && this.settings.loadingEffect === 'scramble';
  }

  /** 新建一个等待中的译文元素；srcLen 用来估算跳动字符的长度，提前占好位置。 */
  private makeTx(mode: UnitMode, srcLen: number): HTMLElement {
    const tx = document.createElement('tx-t');
    tx.setAttribute('data-tx-mode', mode);
    tx.setAttribute('data-tx-stage', 'pending');
    tx.setAttribute('translate', 'no');
    tx.setAttribute('lang', this.settings.targetLang);
    tx.setAttribute('data-tx-len', String(srcLen));
    // 学习模式下可以用 Tab 聚焦到译文上看清它
    if (this.settings.txStyle === 'blur') tx.tabIndex = 0;
    this.setPending(tx);
    return tx;
  }

  private setPending(tx: HTMLElement) {
    tx.setAttribute('data-tx-stage', 'pending');
    tx.removeAttribute('data-tx-swap');
    if (this.scramble) {
      tx.setAttribute('data-tx-fx', 'scramble');
      const mode = tx.getAttribute('data-tx-mode');
      const max = mode === 'block' ? 160 : 28;
      startScramble(tx, estimateLength(Number(tx.getAttribute('data-tx-len')) || 10, this.settings.targetLang, max), this.settings.targetLang);
    } else {
      tx.removeAttribute('data-tx-fx');
      tx.textContent = '';
    }
  }

  private enqueue(unit: Unit, part: Part, priority: number) {
    if (priority === 0) this.perf?.expect(part.segId);
    let list = this.batch.get(priority);
    if (!list) this.batch.set(priority, (list = []));
    list.push({ unit, part });
    if (!this.flushTimer) this.flushTimer = window.setTimeout(() => this.flush(), priority === 0 ? 16 : 60);
  }

  private flush() {
    this.flushTimer = 0;
    const prios = [...this.batch.keys()].sort((a, b) => a - b);
    for (const pr of prios) {
      const items = this.batch.get(pr)!;
      this.batch.delete(pr);
      let group: { unit: Unit; part: Part }[] = [];
      let chars = 0;
      const send = () => {
        if (!group.length) return;
        const job: TranslateJob = {
          jobId: uid('j'),
          sourceLang: this.settings.sourceLang || 'auto',
          targetLang: this.settings.targetLang,
          mode: this.settings.mode,
          priority: pr,
          context: this.context,
          segments: group.map(({ unit, part }) => ({
            id: part.segId,
            text: part.text,
            kind: unit.mode === 'sentence' ? 'sentence' : 'paragraph',
            groupId: unit.mode === 'sentence' ? `${unit.id}.${unit.version}` : undefined,
          })),
          noCache: this.sensitive || undefined,
          stream: true,
        };
        group.forEach(({ part }) => (part.jobId = job.jobId));
        this.jobs.add(job.jobId);
        this.client.send(job, this.handlersFor(job.jobId));
        if (pr === 0) this.perf?.sent();
        group = [];
        chars = 0;
      };
      for (const it of items) {
        if (it.part.stage !== 'pending' || !this.segIndex.has(it.part.segId)) continue;
        group.push(it);
        chars += it.part.text.length;
        if (group.length >= 40 || chars > 6000) send();
      }
      send();
    }
  }

  private handlersFor(jobId: string): JobHandlers {
    return {
      onResult: (segId, text, stage, provider, cached, timing) => this.onResult(segId, text, stage, provider, cached, timing),
      onPartial: (segId, text, stage) => this.onPartial(segId, text, stage),
      onError: (segId, stage, err) => this.onError(segId, stage, err),
      onDone: (stage) => {
        if (stage === 'final' || this.settings.mode !== 'combined') this.jobs.delete(jobId);
      },
    };
  }

  private onResult(segId: string, text: string, stage: Stage, provider: string, cached = false, timing?: SegmentTiming) {
    const hit = this.segIndex.get(segId);
    if (!hit) return;
    const { unit, part } = hit;
    if (part.stage === 'final' && stage === 'fast') return;
    const { frag } = restore(text, unit.ser, part.slots);
    const wasDone = part.stage === 'final' || part.stage === 'error';
    // 已经有字在屏幕上（快速译文或流式中间结果）：直接换掉、轻轻淡入；还在跳字：从左到右定格
    const visible = part.stage === 'fast' || part.streamText !== undefined;
    this.endStream(part);
    finishReveal(part.tx);
    stopScramble(part.tx);
    part.tx.replaceChildren(frag);
    part.tx.setAttribute('data-tx-stage', stage);
    part.tx.removeAttribute('data-tx-swap');
    if (visible) {
      void part.tx.offsetWidth;
      part.tx.setAttribute('data-tx-swap', '');
    } else if (this.scramble) revealText(part.tx, this.settings.targetLang, 140);
    part.tx.removeAttribute('title');
    part.stage = stage;
    part.translated = text;
    part.provider = provider;
    if (unit.whole) unit.root.setAttribute('data-tx-done', '');
    this.mo?.takeRecords();
    if (stage === 'final' && !wasDone) this.progress.done++;
    this.perf?.result(segId, stage, cached, timing);
    this.emit();
  }

  /** 流式中间结果：只在这一段还没有任何译文时显示，按帧合并更新。 */
  private onPartial(segId: string, text: string, stage: Stage) {
    const hit = this.segIndex.get(segId);
    if (!hit) return;
    const { part } = hit;
    if (part.stage !== 'pending') return;
    // 综合模式两档都在流式时，精确档优先；已在显示精确档就不再切回快速档
    if (part.streamStage === 'final' && stage === 'fast') return;
    part.streamStage = stage;
    part.streamText = text;
    this.perf?.partial(segId);
    if (!part.streamRaf) part.streamRaf = requestAnimationFrame(() => this.paintPartial(hit));
  }

  private paintPartial({ unit, part }: { unit: Unit; part: Part }) {
    part.streamRaf = 0;
    if (part.stage !== 'pending' || part.streamText === undefined || !part.tx.isConnected) return;
    // 去掉末尾还没写完的半个占位符（如「<g1」「</g」）
    const text = part.streamText.replace(/<\/?(?:[gx]\d*\/?)?$/, '');
    if (!text.replace(/<\/?[gx]\d+\/?>/g, '').trim()) return;
    const { frag } = restore(text, unit.ser, part.slots, { partial: true });
    finishReveal(part.tx);
    stopScramble(part.tx);
    part.tx.removeAttribute('data-tx-fx');
    part.tx.replaceChildren(frag);
    part.tx.setAttribute('data-tx-stage', 'streaming');
    this.mo?.takeRecords();
  }

  private endStream(part: Part) {
    if (part.streamRaf) cancelAnimationFrame(part.streamRaf);
    part.streamRaf = 0;
    part.streamText = undefined;
    part.streamStage = undefined;
  }

  private onError(segId: string, stage: Stage, err: ErrorInfo) {
    const hit = this.segIndex.get(segId);
    if (!hit) return;
    const { part } = hit;
    this.perf?.error(segId, stage);
    if (stage === 'fast' && this.settings.mode === 'combined') return; // 等精确结果
    this.endStream(part);
    if (part.stage === 'fast') {
      // 精确翻译失败，保留浅色的高速译文
      part.tx.title = L('精确翻译失败：', 'Accurate translation failed: ') + err.message;
      part.stage = 'final';
      this.progress.done++;
    } else {
      part.stage = 'error';
      part.error = err;
      // 悬浮球上显示最严重的那个原因（没有可用服务 / 密钥无效 > 额度用尽 > 其他）
      const sev = (e?: ErrorInfo) => (!e ? 0 : e.code === 'no_provider' || e.code === 'auth' ? 3 : e.code === 'quota' ? 2 : 1);
      if (sev(err) >= sev(this.progress.lastError)) this.progress.lastError = err;
      stopScramble(part.tx);
      part.tx.setAttribute('data-tx-stage', 'error');
      // 页面上只留一个不显眼的小标记；原因汇总到悬浮球
      part.tx.textContent = '';
      part.tx.title = L(`翻译失败：${err.message || '未知错误'}${err.provider ? `（${err.provider}）` : ''}\n点击重试`, `Translation failed: ${err.message || 'unknown error'}${err.provider ? ` (${err.provider})` : ''}\nClick to retry`);
      this.progress.errors++;
      this.progress.done++;
    }
    this.mo?.takeRecords();
    this.emit();
  }

  private onClick = (e: MouseEvent) => {
    const tx = (e.target as Element | null)?.closest?.('tx-t[data-tx-stage="error"]');
    if (!tx) return;
    e.preventDefault();
    e.stopPropagation();
    const hit = this.segIndex.get(tx.getAttribute('data-tx-seg') || '');
    if (!hit) return;
    this.resend([hit]);
  };

  /** 重新翻译若干段（不用缓存）；providerHint 指定用哪家。 */
  resend(hits: { unit: Unit; part: Part }[], providerHint?: string): void {
    if (!hits.length) return;
    for (const { part } of hits) {
      if (part.stage === 'error') this.progress.errors = Math.max(0, this.progress.errors - 1);
      if (part.stage === 'final' || part.stage === 'error') this.progress.done = Math.max(0, this.progress.done - 1);
      if (part.jobId && part.stage !== 'final' && part.stage !== 'error') this.client.cancel(part.jobId, [part.segId]);
      part.stage = 'pending';
      this.endStream(part);
      this.setPending(part.tx);
    }
    if (!this.progress.errors) this.progress.lastError = undefined;
    const job: TranslateJob = {
      jobId: uid('j'),
      sourceLang: this.settings.sourceLang || 'auto',
      targetLang: this.settings.targetLang,
      mode: providerHint ? 'accurate' : this.settings.mode,
      priority: 0,
      context: this.context,
      segments: hits.map(({ unit, part }) => ({ id: part.segId, text: part.text, kind: unit.mode === 'sentence' ? 'sentence' : 'paragraph' })),
      noCache: true,
      providerHint,
      stream: true,
    };
    hits.forEach(({ part }) => (part.jobId = job.jobId));
    this.jobs.add(job.jobId);
    this.client.send(job, this.handlersFor(job.jobId));
    this.emit();
  }

  /** 重试所有失败的段落。 */
  retryErrors(): void {
    this.resend([...this.segIndex.values()].filter((h) => h.part.stage === 'error'));
  }

  /** 译文元素对应的段落。 */
  hitFor(tx: Element | null): { unit: Unit; part: Part } | null {
    return tx ? this.segIndex.get(tx.getAttribute('data-tx-seg') || '') ?? null : null;
  }

  /** 用户手动改了译文：记下来，并写入译文记忆（以后同一句原文直接用它）。 */
  saveEdit(hit: { unit: Unit; part: Part }, text: string): Promise<unknown> {
    hit.part.translated = text;
    hit.part.provider = 'tm';
    hit.part.tx.setAttribute('data-tx-stage', 'final');
    return rpc('tm:save', { source: hit.part.text, target: text, sourceLang: this.settings.sourceLang || 'auto', targetLang: this.settings.targetLang });
  }

  private resetUnit(unit: Unit) {
    const byJob = new Map<string, string[]>();
    for (const p of unit.parts) {
      this.segIndex.delete(p.segId);
      if (p.jobId && (p.stage === 'pending' || p.stage === 'fast')) {
        const l = byJob.get(p.jobId) ?? [];
        l.push(p.segId);
        byJob.set(p.jobId, l);
      }
      stopScramble(p.tx);
      this.endStream(p);
      this.perf?.drop(p.segId);
      p.tx.remove();
    }
    for (const [j, ids] of byJob) this.client.cancel(j, ids);
    // 合并逐句模式拆开的文本节点（倒序）
    for (let i = unit.splits.length - 1; i >= 0; i--) {
      const [a, b, aData] = unit.splits[i];
      if (a.nextSibling === b && a.data === aData) {
        a.appendData(b.data);
        b.remove();
      } else if (a.data !== aData && b.isConnected) b.remove(); // 站点自己改了原节点，剩下的半截已过时
    }
    unit.splits = [];
    if (unit.state === 'requested') this.progress.total -= unit.parts.length;
    this.progress.done -= unit.parts.filter((p) => p.stage === 'final' || p.stage === 'error').length;
    unit.parts = [];
    unit.state = 'idle';
    if (unit.whole) {
      unit.root.removeAttribute('data-tx-root');
      unit.root.removeAttribute('data-tx-done');
      (unit.root as HTMLElement).style?.removeProperty('--tx-fs');
      if (unit.root.getAttribute('style') === '') unit.root.removeAttribute('style');
    }
    this.mo?.takeRecords();
  }

  private removeUnit(unit: Unit) {
    this.resetUnit(unit);
    this.units.delete(unit.id);
    const set = this.byTarget.get(unit.root);
    if (set) {
      set.delete(unit);
      if (!set.size) {
        this.byTarget.delete(unit.root);
        this.io?.unobserve(unit.root);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* 页面变化                                                           */
  /* ---------------------------------------------------------------- */

  private unitOf(node: Node | null): Unit | null {
    for (let n: Node | null = node; n && n !== document.body; n = n.parentNode) {
      const u = this.nodeUnit.get(n);
      if (u) return u;
    }
    return null;
  }

  private onMutations(records: MutationRecord[]) {
    let relevant = false;
    for (const r of records) {
      if (insideOurs(r.target)) continue;
      if (r.type === 'characterData') {
        const u = this.unitOf(r.target);
        if (u) {
          this.dirty.add(u);
          relevant = true;
        }
        continue;
      }
      let changed = false;
      r.addedNodes.forEach((n) => {
        if (isOurs(n)) return;
        changed = true;
        this.added.add(n);
      });
      r.removedNodes.forEach((n) => {
        if (!isOurs(n)) changed = true;
      });
      if (changed) {
        relevant = true;
        const u = this.unitOf(r.target);
        if (u) this.dirty.add(u);
      }
    }
    if (!relevant) return;
    const now = performance.now();
    if (!this.moTimer) this.moFirst = now;
    clearTimeout(this.moTimer);
    // 防抖 250ms，但连续变化时最多等 1 秒
    const wait = Math.max(0, Math.min(250, 1000 - (now - this.moFirst)));
    this.moTimer = window.setTimeout(() => this.processMutations(), wait);
  }

  private processMutations() {
    this.moTimer = 0;
    if (!this.active) return;
    // 已移除的单元
    for (const u of this.units.values()) if (!u.root.isConnected) this.removeUnit(u);
    // 内容变了的单元：重新序列化，文字真的变了才重翻
    for (const u of this.dirty) {
      if (!this.units.has(u.id)) continue;
      const nodes = u.whole ? Array.from(u.root.childNodes).filter((n) => !isOurs(n)) : u.nodes.filter((n) => n.isConnected);
      if (!nodes.length) {
        this.removeUnit(u);
        continue;
      }
      const ser = serialize(nodes);
      if (ser.text !== u.ser.text || u.state === 'idle') {
        const wasRequested = u.state !== 'idle';
        this.resetUnit(u);
        u.nodes = nodes;
        if (!u.whole) nodes.forEach((n) => this.nodeUnit.set(n, u));
        if (wasRequested && this.io) {
          this.io.unobserve(u.root);
          this.io.observe(u.root);
        }
      }
    }
    this.dirty.clear();
    // 新加入的内容
    const specs: UnitSpec[] = [];
    // 单页应用换了一整页内容：正文容器已不在，重新认一次
    if (this.scope?.root && !this.scope.root.isConnected) this.scope = detectContent();
    const opts = this.scanOpts();
    for (const n of this.added) {
      if (!n.isConnected || insideOurs(n) || this.unitOf(n)) continue;
      const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
      if (!el || el === document.documentElement) continue;
      if (this.scope && !scopeAllows(this.scope, el)) continue;
      specs.push(...scan(el, opts));
    }
    this.added.clear();
    if (specs.length) this.addUnits(specs);
    this.emit();
  }

  private emit() {
    this.onProgress?.({ ...this.progress, active: this.active });
  }
}

function waitFor(selector: string, timeout: number): Promise<void> {
  return new Promise((resolve) => {
    if (document.querySelector(selector)) return resolve();
    const mo = new MutationObserver(() => {
      if (document.querySelector(selector)) {
        mo.disconnect();
        resolve();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      mo.disconnect();
      resolve();
    }, timeout);
  });
}
