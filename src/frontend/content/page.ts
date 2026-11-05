/**
 * 整页翻译：扫描段落 → 进入视口才请求 → 流式渲染 → 跟踪页面变化。
 */
import type { ErrorInfo, Mode, SegmentTiming, SiteRule, Stage, TranslateJob } from '../../shared/protocol';
import { rpc, uid } from '../../shared/rpc';
import { hostMatches, type UiSettings } from '../../shared/settings';
import { displayOf, hasLetters, insideOurs, isOurs, isSkipped, isPinnedLabel, isVisiblyRendered } from './dom';
import { installLinkForwarding } from './links';
import type { JobHandlers, TranslateClient } from './port';
import { hasBlockChild, looksLikeTarget, scanSteps, type UnitSpec } from './scanner';
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
  /** 超长逐句段落在两批插入间等待的任务。 */
  mountTimer?: number;
}

export interface Progress {
  active: boolean;
  total: number;
  done: number;
  errors: number;
  lastError?: ErrorInfo;
}

// 给输入、页面动画及浏览器布局留出时间。单个段落保持原子处理。
const DOM_BUDGET_MS = 6;
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
  private session: AbortController | null = null;
  private batch = new Map<number, { unit: Unit; part: Part }[]>();
  private flushTimer = 0;
  private scanRoots = new Set<Element>();
  private scanning: { root: Element; steps: Generator<UnitSpec | null> } | null = null;
  private scanTimer = 0;
  private viewportQueue = [new Set<Unit>(), new Set<Unit>()];
  private viewportTimer = 0;
  private dirty = new Set<Unit>();
  private regroup = new Set<Unit>();
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

  async start(verifiedRule?: SiteRule | null): Promise<void> {
    if (this.active) return;
    this.active = true;
    const session = new AbortController();
    this.session = session;
    const { signal } = session;
    this.t0 = performance.now();
    this.perf = new FirstScreenPerf(this.t0, this.settings.mode);
    this.sensitive = hostMatches(location.hostname, this.settings.sensitive);
    this.progress = { active: true, total: 0, done: 0, errors: 0 };
    this.emit();
    // 站点规则：有缓存就直接用、后台再核对；没缓存才等后台（最多 0.4 秒）
    if (verifiedRule !== undefined) {
      this.rule = verifiedRule;
    } else {
      const href = location.href;
      const fresh = rpc('rules:forUrl', { url: href }).then(
        (r) => {
          if (!signal.aborted) void storeRule(href, r ?? null);
          return { ok: true as const, rule: r ?? null };
        },
        () => ({ ok: false as const, rule: null }),
      );
      const cached = await cachedRule(href);
      if (signal.aborted) return;
      if (cached.hit) {
        this.rule = cached.rule;
        this.perf.ruleCached = true;
        void fresh.then((f) => {
          // 只更新发起查询的这一轮；直接使用新规则，避免重新读到还没写完的缓存。
          if (f.ok && !signal.aborted && !sameEffect(f.rule, this.rule)) { this.stop(); void this.start(f.rule); }
        });
      } else {
        const rule = await Promise.race([fresh.then((f) => f.rule), new Promise<null>((r) => setTimeout(() => r(null), 400))]);
        if (signal.aborted) return;
        this.rule = rule;
      }
    }
    if (this.rule?.waitFor) await waitFor(this.rule.waitFor, 3000, signal);
    if (signal.aborted) return;
    // 有些单页应用会替换整个 body。旧观察器仍绑定旧树，换页时需要取消这轮任务并重新扫描。
    const originalBody = document.body;
    let restartTimer = 0;
    const bodyChanges = new MutationObserver(() => {
      if (!document.body || document.body === originalBody || restartTimer) return;
      restartTimer = window.setTimeout(() => {
        restartTimer = 0;
        if (signal.aborted || !document.body || document.body === originalBody) return;
        this.stop();
        void this.start();
      }, 0);
    });
    bodyChanges.observe(document.documentElement, { childList: true });
    signal.addEventListener('abort', () => { bodyChanges.disconnect(); clearTimeout(restartTimer); }, { once: true });
    if (!originalBody) return;
    const s = this.rule?.display === 'replace' ? { ...this.settings, display: 'translation' as const } : this.settings;
    installPageStyle(s);
    this.context = { url: location.href, title: document.title, summary: '' };

    this.io = new IntersectionObserver((entries) => { if (!signal.aborted) this.onIntersect(entries); }, { rootMargin: '120% 0px 120% 0px' });
    this.mo = new MutationObserver((recs) => { if (!signal.aborted) this.onMutations(recs); });
    this.mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributeFilter: ['href', 'target', 'hidden'], attributeOldValue: true });
    this.scope = this.settings.mainOnly && !this.rule?.include?.length ? detectContent() : null;
    this.scanRoots.add(document.body);
    this.drainScan();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.session?.abort();
    this.session = null;
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
    clearTimeout(this.scanTimer);
    clearTimeout(this.viewportTimer);
    this.scanTimer = this.viewportTimer = 0;
    this.scanRoots.clear();
    this.scanning = null;
    this.viewportQueue.forEach(queue => queue.clear());
    this.dirty.clear();
    this.regroup.clear();
    this.added.clear();
    for (const u of this.units.values()) if (u.parts.length) this.resetUnit(u);
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

  private addUnit(spec: UnitSpec) {
    if (!spec.root.isConnected || spec.nodes.some(node => node.parentNode !== spec.root)) return;
    const unit: Unit = {
      id: uid('u'), root: spec.root, nodes: spec.nodes, whole: spec.whole,
      ser: { text: '', slots: [], pos: [], letters: 0 }, parts: [],
      state: 'idle', mode: 'block', version: 0, splits: [],
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
    // 遍历时积累最开始的正文。首屏可先送出，后续批次接着使用同一份摘要。
    if (this.scanning?.root === document.body && this.context.summary.length < 300) {
      const text = (spec.root.textContent || '').trim();
      if (text.length > 40) this.context.summary = (this.context.summary + text.replace(/\s+/g, ' ') + ' ').slice(0, 300);
    }
  }

  private drainScan() {
    this.scanTimer = 0;
    if (!this.active) return;
    const deadline = performance.now() + DOM_BUDGET_MS;
    do {
      if (!this.scanning) {
        const root = this.scanRoots.values().next().value;
        if (!root) return;
        this.scanRoots.delete(root);
        if (!root.isConnected || insideOurs(root) || this.unitOf(root)) continue;
        if (this.scope && !scopeAllows(this.scope, root)) continue;
        this.scanning = { root, steps: scanSteps(root, this.scanOpts()) };
      }
      if (!this.scanning.root.isConnected) { this.scanning = null; continue; }
      const next = this.scanning.steps.next();
      if (next.done) this.scanning = null;
      else if (next.value) this.addUnit(next.value);
    } while (performance.now() < deadline);
    if (this.scanning || this.scanRoots.size) this.scanTimer = window.setTimeout(() => this.drainScan(), 0);
  }

  private onIntersect(entries: IntersectionObserverEntry[]) {
    const vh = window.innerHeight;
    for (const e of entries) {
      const units = this.byTarget.get(e.target);
      if (!units) continue;
      const priority = e.boundingClientRect.bottom > 0 && e.boundingClientRect.top < vh ? 0 : 1;
      for (const unit of units) {
        this.viewportQueue[1 - priority].delete(unit);
        if (e.isIntersecting && unit.state === 'idle') this.viewportQueue[priority].add(unit);
        else this.viewportQueue[priority].delete(unit);
      }
    }
    if (!this.viewportTimer) this.drainViewport();
  }

  private drainViewport() {
    this.viewportTimer = 0;
    if (!this.active) return;
    const deadline = performance.now() + DOM_BUDGET_MS;
    const before = this.progress.total;
    do {
      const priority = this.viewportQueue[0].size ? 0 : 1;
      const queue = this.viewportQueue[priority];
      const unit = queue.values().next().value;
      if (!unit) break;
      queue.delete(unit);
      if (unit.state === 'idle' && unit.root.isConnected && this.units.has(unit.id)) this.request(unit, priority);
    } while (performance.now() < deadline);
    if (this.progress.total !== before) this.emit();
    if (this.viewportQueue.some(queue => queue.size)) this.viewportTimer = window.setTimeout(() => this.drainViewport(), 0);
  }

  private request(unit: Unit, priority: number) {
    unit.nodes = unit.whole ? Array.from(unit.root.childNodes).filter((n) => !isOurs(n)) : unit.nodes.filter((n) => n.isConnected);
    // 隐藏/尚未布局的节点可能在下一次展开后进入视口，保留 idle 也省去当前的序列化。
    if (!unit.nodes.length || !isVisiblyRendered(unit.root)) return;
    unit.ser = serialize(unit.nodes);
    const plain = unit.ser.text.replace(/<\/?[gx]\d+\/?>/g, '');
    const elLang = unit.root.closest('[lang]')?.getAttribute('lang');
    // 网格容器里夹在块之间的文字（页面骨架上的「跳到正文」之类）：译文插进去会变成一个新的网格项，
    // 被拉到整行那么高、还会挤乱整页布局，不翻
    const gridRun = !unit.whole && /grid/.test(displayOf(unit.root));
    if (unit.ser.letters < 2 || looksLikeTarget(plain, this.settings.targetLang, elLang) || gridRun || isPinnedLabel(unit.root)) {
      unit.state = 'skipped';
      return;
    }
    unit.state = 'requested';
    const v = ++unit.version;
    const s = this.settings;
    const chunks = s.bilingualStyle === 'sentence' && s.display === 'bilingual' ? splitSentences(unit.ser) : [];

    if (unit.whole) unit.root.setAttribute('data-tx-root', '');
    let css = '';
    const mount = (part: Part) => {
      part.tx.setAttribute('data-tx-seg', part.segId);
      if (!css) {
        styleTranslation(part.tx, unit.root, s.targetLang, unit.mode === 'block', this.rule);
        css = part.tx.style.cssText;
      } else part.tx.style.cssText = css;
      unit.parts.push(part);
      this.progress.total++;
    };
    const send = () => {
      for (const part of unit.parts) {
        this.segIndex.set(part.segId, { unit, part });
        this.enqueue(unit, part, priority);
      }
    };

    if (chunks.length >= 2) {
      unit.mode = 'sentence';
      let index = chunks.length;
      const batched = chunks.length > 96;
      const insert = () => {
        unit.mountTimer = undefined;
        // 本轮若遇到网页替换原文，留给变更队列按新结构重建，旧的字符位置不再可用。
        if (!unit.root.isConnected || this.dirty.has(unit) || this.regroup.has(unit)) {
          this.removeUnit(unit);
          if (unit.root.isConnected) this.added.add(unit.root);
          return;
        }
        const deadline = performance.now() + DOM_BUDGET_MS;
        const first = index;
        do {
          const i = --index;
          const chunk = chunks[i];
          // 从后往前拆，仍未插入的句子继续使用原来的 UTF-16 位置。
          const tx = this.makeTx('sentence', chunk.text.replace(/<\/?[gx]\d+\/?>/g, '').length);
          const split = insertAfterChunk(unit.ser, chunk, tx);
          if (split) unit.splits.push([split[0], split[1], split[0].data]);
          mount({ segId: `${unit.id}.${v}.${i}`, tx, text: chunk.text, slots: chunk.slots, stage: 'pending', priority });
        } while (index && (!batched || (first - index < 96 && performance.now() < deadline)));
        this.mo?.takeRecords();
        if (index) {
          unit.mountTimer = window.setTimeout(() => { insert(); this.emit(); }, 0);
        } else {
          unit.parts.reverse();
          send();
        }
      };
      insert();
    } else {
      unit.mode = this.pickMode(unit, plain);
      const tx = this.makeTx(unit.mode, plain.length);
      if (unit.whole) unit.root.appendChild(tx);
      else (unit.nodes[unit.nodes.length - 1] as ChildNode).after(tx);
      mount({ segId: `${unit.id}.${v}.0`, tx, text: unit.ser.text, stage: 'pending', priority });
      this.mo?.takeRecords();
      send();
    }
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
    // fast / streaming 到 final 的透明度由 CSS transition 过渡，浏览器可以一次排版整批译文。
    if (!visible && this.scramble) revealText(part.tx, this.settings.targetLang, 140);
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
    clearTimeout(unit.mountTimer);
    unit.mountTimer = undefined;
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
    if (unit.whole) this.nodeUnit.delete(unit.root);
    else for (const n of unit.nodes) this.nodeUnit.delete(n);
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

  /** 虚拟列表可用相同文字重建 DOM。保留现有请求与译文，改用当前原文节点还原链接、代码及位置。 */
  private restoreRecycled(unit: Unit, nodes: Node[], fresh: Serialized) {
    unit.nodes = nodes;
    unit.ser = fresh;
    const detached = unit.parts.some(part => !unit.root.contains(part.tx));
    if (detached && unit.mode === 'sentence') {
      const chunks = splitSentences(fresh);
      unit.splits = unit.splits.filter(([head, tail]) => unit.root.contains(head) && unit.root.contains(tail));
      for (let i = unit.parts.length - 1; i >= 0; i--) {
        const part = unit.parts[i];
        if (unit.root.contains(part.tx) || !chunks[i]) continue;
        const split = insertAfterChunk(fresh, chunks[i], part.tx);
        if (split) unit.splits.push([split[0], split[1], split[0].data]);
      }
      // splitText 会产生原文变更记录，和首次逐句挂载一样在这里丢弃。
      this.mo?.takeRecords();
    } else if (detached) {
      (nodes[nodes.length - 1] as ChildNode).after(unit.parts[0].tx);
    }
    if (fresh.slots.length) {
      for (const part of unit.parts) {
        if (part.translated !== undefined && !part.tx.isContentEditable) {
          finishReveal(part.tx);
          part.tx.replaceChildren(restore(part.translated, fresh, part.slots).frag);
        } else if (part.streamText !== undefined && !part.streamRaf) this.paintPartial({ unit, part });
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

  /** 混合内容容器中的行内片段，只有被插入/移除操作碰到的相邻片段需要重新分组。 */
  private changedRun(root: Node, node: Node | null, direction: 'previousSibling' | 'nextSibling') {
    while (node && isOurs(node)) node = node[direction];
    const u = node && this.nodeUnit.get(node);
    if (u && !u.whole && u.root === root) this.regroup.add(u);
  }

  private onMutations(records: MutationRecord[]) {
    // 一批更新里很多目标共享祖先。只在这次通知内记住判断，下一批仍读最新页面结构。
    type TargetInfo = { owner: Unit | null; ours: boolean; excluded: boolean };
    const infos = new WeakMap<Node, TargetInfo>();
    const filter = this.scope ? scopeFilter(this.scope) : undefined;
    const excludedByRule = this.rule?.exclude?.join(',');
    const rootInfo: TargetInfo = { owner: null, ours: false, excluded: false };
    const ownUiInfo: TargetInfo = { owner: null, ours: true, excluded: true };
    const classify = (node: Node): TargetInfo => {
      const chain: Node[] = [];
      let parent: Node | null = node;
      while (parent && !infos.has(parent)) {
        if (isOurs(parent)) { infos.set(parent, ownUiInfo); break; }
        chain.push(parent);
        parent = parent.parentNode;
      }
      let info = (parent && infos.get(parent)) || rootInfo;
      for (let i = chain.length - 1; i >= 0; i--) {
        const item = chain[i];
        if (!info.ours && item.nodeType === 1) {
          const el = item as Element;
          if (!info.excluded && (isSkipped(el) || (excludedByRule && el.matches(excludedByRule)) || filter?.(el) === 0)) {
            info = { ...info, excluded: true };
          }
        }
        const owner = this.nodeUnit.get(item);
        if (owner && !info.ours) info = { ...info, owner };
        infos.set(item, info);
      }
      return info;
    };
    let relevant = false;
    const previousDirtyCount = this.dirty.size;
    let visitedRemoved = 0;
    let sweepDetached = false;
    for (const r of records) {
      const info = classify(r.target);
      if (info.ours) continue;
      // 已认领的段内仍需更新代码/图标占位符；未认领的编辑器、SVG、站点排除区域不会产生新段落。
      const accept = !info.excluded || !!info.owner;
      if (r.type === 'characterData' || r.type === 'attributes') {
        if (!accept) continue;
        if (r.type === 'attributes') {
          const el = r.target as Element;
          if (el.getAttribute(r.attributeName!) === r.oldValue) continue;
          // 预渲染并隐藏的菜单在首次扫描时被跳过；只扫描刚展开的子树。
          if (r.attributeName === 'hidden' && !el.hasAttribute('hidden')) {
            this.added.add(el);
            relevant = true;
          }
        }
        const u = info.owner;
        if (u) {
          this.dirty.add(u);
          relevant = true;
        } else if (r.type === 'characterData' && hasLetters((r.target as Text).data)) {
          // 聊天流/虚拟列表常先创建空文本节点，随后只改 data，首次写入也需要被发现。
          this.added.add(r.target);
          relevant = true;
        }
        continue;
      }
      let changed = false;
      if (accept) r.addedNodes.forEach((n) => {
        if (isOurs(n)) return;
        changed = true;
        this.added.add(n);
      });
      r.removedNodes.forEach((n) => {
        if (isOurs(n)) return;
        if (accept) changed = true;
        const owner = this.nodeUnit.get(n);
        if (owner) {
          this.dirty.add(owner);
          if (!owner.whole && owner.root === r.target) this.regroup.add(owner);
        }
        if (!sweepDetached && n.nodeType === 1 && !n.isConnected) {
          // 小子树按节点检查；被删除的图表可能远大于所有已跟踪的段落，此时只查一次索引。
          const walker = document.createTreeWalker(n, NodeFilter.SHOW_ELEMENT);
          do {
            if (++visitedRemoved > this.byTarget.size) { sweepDetached = true; break; }
            this.byTarget.get(walker.currentNode as Element)?.forEach((u) => this.dirty.add(u));
          } while (walker.nextNode());
        }
      });
      if (changed) {
        this.changedRun(r.target, r.previousSibling, 'previousSibling');
        this.changedRun(r.target, r.nextSibling, 'nextSibling');
        relevant = true;
        if (info.owner) this.dirty.add(info.owner);
      }
    }
    if (sweepDetached) {
      for (const [el, units] of this.byTarget) {
        if (!el.isConnected) for (const unit of units) this.dirty.add(unit);
      }
    }
    if (!relevant && this.dirty.size === previousDirtyCount) return;
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
    for (const u of this.regroup) {
      if (!this.units.has(u.id)) continue;
      this.removeUnit(u);
      if (u.root.isConnected) this.added.add(u.root);
    }
    this.regroup.clear();
    // 内容变了的单元：重新序列化，文字真的变了才重翻
    for (const u of this.dirty) {
      if (!this.units.has(u.id)) continue;
      if (!u.root.isConnected || u.mountTimer !== undefined) {
        this.removeUnit(u);
        if (u.root.isConnected) this.added.add(u.root);
        continue;
      }
      if (u.whole && this.added.size && hasBlockChild(u.root)) {
        // 菜单展开时，原来的短标签可能变成容器。按新结构分段，避免每次更新重翻整个菜单。
        this.removeUnit(u);
        this.added.add(u.root);
        continue;
      }
      const nodes = u.whole ? Array.from(u.root.childNodes).filter((n) => !isOurs(n)) : u.nodes.filter((n) => n.parentNode === u.root);
      if (!nodes.length) { this.removeUnit(u); continue; }
      if (!u.whole) {
        for (const n of u.nodes) if (n.parentNode !== u.root) this.nodeUnit.delete(n);
        u.nodes = nodes;
      }
      if (u.state === 'idle') { u.nodes = nodes; continue; }
      const fresh = serialize(nodes);
      if (fresh.text !== u.ser.text) {
        this.resetUnit(u);
        u.nodes = nodes;
        if (!u.whole) nodes.forEach((n) => this.nodeUnit.set(n, u));
        if (this.io) {
          this.io.unobserve(u.root);
          this.io.observe(u.root);
        }
      } else if (u.state === 'requested') {
        this.restoreRecycled(u, nodes, fresh);
      }
    }
    this.dirty.clear();
    // 新加入的内容
    const roots = new Set<Element>();
    // 单页应用换了一整页内容：正文容器已不在，重新认一次
    if (this.scope?.root && !this.scope.root.isConnected) this.scope = detectContent();
    for (const n of this.added) {
      if (!n.isConnected) continue;
      const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
      if (el && el !== document.documentElement) roots.add(el);
    }
    this.added.clear();
    // 框架常在同一轮先挂容器再加子孙。每棵子树只扫一次，立即认领找到的段落。
    for (const el of roots) {
      let parent = el.parentElement;
      while (parent && !roots.has(parent)) parent = parent.parentElement;
      if (!parent) this.scanRoots.add(el);
    }
    if (!this.scanTimer && this.scanRoots.size) this.drainScan();
    this.emit();
  }

  private emit() {
    this.onProgress?.({ ...this.progress, active: this.active });
  }
}

function waitFor(selector: string, timeout: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || document.querySelector(selector)) return resolve();
    const finish = () => {
      mo.disconnect();
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const mo = new MutationObserver(() => {
      if (document.querySelector(selector)) finish();
    });
    const timer = window.setTimeout(finish, timeout);
    signal.addEventListener('abort', finish, { once: true });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  });
}
