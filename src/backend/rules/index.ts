import type { SiteRule } from '../../shared/protocol';
import type { RuleSubscriptionInfo, RuleSubscriptionVersion } from '../../shared/backend-v2';
import { ProviderError } from '../providers/types';

export interface RuleStorage {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
interface Subscription { url: string; version?: RuleSubscriptionVersion; previousVersion?: RuleSubscriptionVersion; etag?: string; updatedAt?: number; lastError?: string; rules: SiteRule[]; previous?: SiteRule[] }
interface RuleState { version: 1; local: SiteRule[]; subscriptions: Subscription[] }
const KEY = 'backend.rules';
const MAX_BYTES = 2 * 1024 * 1024;
const properties = new Set(['id', 'match', 'include', 'exclude', 'display', 'waitFor', 'shadowHosts', 'style', 'autoTranslate', 'source']);
const styles = new Set(['font-size', 'font-family', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent', 'white-space', 'word-break', 'overflow-wrap', 'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'margin-inline', 'margin-block', 'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'padding-inline', 'padding-block']);
const bad = (message: string): never => { throw new ProviderError({ code: 'bad_input', message, retryable: false }); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validVersion = (value: unknown): value is RuleSubscriptionVersion => typeof value === 'number' ? Number.isFinite(value)
  : typeof value === 'string' && value.length <= 128 && !!value.trim() && !/[\u0000-\u001f]/.test(value);
async function contentVersion(rules: SiteRule[]): Promise<string> {
  // ETag 只是 HTTP 校验标记；无文档版本的旧订阅也需要能识别真实规则内容的版本。
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rules)));
  return 'sha256:' + Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('规则订阅超过 2MB 上限');
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { await reader.cancel(); throw new Error('规则订阅超过 2MB 上限'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

function strings(value: unknown, required = false): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.length > 64 || (required && !value.length)
    || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 512 || /[\u0000-\u001f]/.test(item))) return bad('规则选择器或匹配列表格式不正确');
  return [...value] as string[];
}

export function validateRule(value: unknown, source?: SiteRule['source']): SiteRule {
  if (!object(value) || Object.keys(value).some((key) => !properties.has(key)) || typeof value.id !== 'string'
    || !/^[\w.:-]{1,128}$/.test(value.id)) return bad('站点规则结构不正确');
  const match = strings(value.match, true)!;
  for (const pattern of match) if (!/^(\*|https?|file):\/\//.test(pattern) || pattern.length > 512) return bad('规则只允许 HTTP(S) 或本机文件的匹配模式');
  if (value.display !== undefined && !['append', 'hover', 'replace'].includes(String(value.display))) return bad('规则显示方式不正确');
  if (value.autoTranslate !== undefined && typeof value.autoTranslate !== 'boolean') return bad('规则自动翻译选项不正确');
  if (value.waitFor !== undefined && (typeof value.waitFor !== 'string' || value.waitFor.length > 512 || /[\u0000-\u001f]/.test(value.waitFor))) return bad('规则等待选择器不正确');
  let style: Record<string, string> | undefined;
  if (value.style !== undefined) {
    if (!object(value.style) || Object.keys(value.style).length > 32) return bad('规则样式格式不正确');
    style = {};
    for (const [key, entry] of Object.entries(value.style)) {
      if (!styles.has(key) || typeof entry !== 'string' || entry.length > 256
        || /(?:url\s*\(|expression\s*\(|@import|javascript:|behavior\s*:|[{};\\\u0000-\u001f])/i.test(entry)) return bad('规则包含不允许的样式');
      style[key] = entry;
    }
  }
  const rule: SiteRule = { id: value.id, match, source: source ?? (['local', 'subscription', 'builtin'].includes(String(value.source)) ? value.source as SiteRule['source'] : 'local') };
  const include = strings(value.include), exclude = strings(value.exclude), shadowHosts = strings(value.shadowHosts);
  if (include) rule.include = include;
  if (exclude) rule.exclude = exclude;
  if (shadowHosts) rule.shadowHosts = shadowHosts;
  if (value.display !== undefined) rule.display = value.display as SiteRule['display'];
  if (typeof value.waitFor === 'string') rule.waitFor = value.waitFor;
  if (typeof value.autoTranslate === 'boolean') rule.autoTranslate = value.autoTranslate;
  if (style) rule.style = style;
  return rule;
}

function parseRules(value: unknown, source: SiteRule['source']): SiteRule[] {
  const list = Array.isArray(value) ? value : object(value) && Object.keys(value).every((key) => ['version', 'rules'].includes(key)) ? value.rules : undefined;
  if (!Array.isArray(list) || list.length > 10_000) return bad('规则订阅必须是 JSON 规则数组');
  const rules = list.map((entry) => validateRule(entry, source));
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) return bad('规则 ID 重复');
  return rules;
}

function localPatterns(pattern: string): string[] {
  if (/^(\*|https?|file):\/\//.test(pattern)) return [pattern];
  // 高级页允许输入裸域；只在人工保存入口补模式，不放宽订阅 JSON 的验证。
  if (/[\s\\/?#@%]/u.test(pattern) || /^(?:javascript|data|vbscript|about|chrome|file|https?):/i.test(pattern)) return bad('网站简写只能包含域名和可选端口，不能包含路径、凭据或脚本');
  const wildcard = pattern.startsWith('*.'), authority = wildcard ? pattern.slice(2) : pattern;
  if (!authority || authority.includes('*')) return bad('网站通配符只能写在域名开头，例如 *.example.org');
  const parts = authority.startsWith('[') ? /^(\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/i.exec(authority) : /^([^:]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!parts) return bad('网站域名或端口不正确');
  const host = parts[1]!, port = parts[2] === undefined ? undefined : Number(parts[2]);
  if (port !== undefined && (port < 1 || port > 65535)) return bad('网站端口必须在 1 到 65535 之间');
  let parsed: URL;
  try { parsed = new URL(`http://${authority}/`); } catch { return bad('网站域名或端口不正确'); }
  const hostname = parsed.hostname;
  if (!hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return bad('网站域名不正确');
  const ipv6 = hostname.startsWith('['), ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  if (ipv6 ? wildcard : hostname.length > 253 || hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return bad('网站域名不正确');
  if (ipv4 && (wildcard || hostname !== host)) return bad('IP 地址必须使用明确的完整地址，不能使用通配或数字简写');
  const canonical = `${wildcard ? '*.' : ''}${hostname}`;
  // URL 会省略各协议默认端口；分成两种协议才能精确匹配用户指定的 80/443。
  if (port === 80 || port === 443) return ['http:', 'https:'].map((scheme) => `${scheme}//${canonical}${(scheme === 'http:' && port === 80) || (scheme === 'https:' && port === 443) ? '' : ':' + port}/*`);
  return [`*://${canonical}${port === undefined ? '' : ':' + port}/*`];
}
function normalizeLocalRule(value: unknown): unknown {
  if (!object(value)) return value;
  return { ...value, match: strings(value.match, true)!.flatMap(localPatterns) };
}

const compiled = new Map<string, RegExp>();
function matches(pattern: string, url: string): boolean {
  let re = compiled.get(pattern);
  if (!re) {
    re = new RegExp('^' + pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    if (compiled.size >= 10_000) compiled.clear();
    compiled.set(pattern, re);
  }
  return re.test(url);
}

export class RuleService {
  private state: RuleState = { version: 1, local: [], subscriptions: [] };
  private initialized: Promise<void>;
  private mutations = Promise.resolve();
  private storage: RuleStorage;
  private fetcher: typeof fetch;
  private now: () => number;
  private builtin: SiteRule[];
  constructor(options: { storage?: RuleStorage; fetch?: typeof fetch; now?: () => number; builtin?: SiteRule[] } = {}) {
    this.storage = options.storage ?? chrome.storage.local;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.builtin = (options.builtin ?? [
      { id: 'builtin.wikipedia', match: ['https://*.wikipedia.org/wiki/*'], include: ['#mw-content-text'], exclude: ['.navbox', '.reflist'], source: 'builtin' },
      { id: 'builtin.mdn', match: ['https://developer.mozilla.org/*/docs/*'], include: ['main article', '.main-page-content'], exclude: ['nav', '.sidebar'], source: 'builtin' },
    ]).map((rule) => validateRule(rule, 'builtin'));
    this.initialized = this.initialize();
  }
  private async initialize() {
    const stored = (await this.storage.get(KEY))[KEY];
    if (!object(stored) || stored.version !== 1) return;
    try {
      this.state.local = parseRules(stored.local, 'local');
      if (Array.isArray(stored.subscriptions)) for (const entry of stored.subscriptions) {
        if (!object(entry) || typeof entry.url !== 'string') continue;
        try {
          const url = this.subscriptionUrl(entry.url);
          const rules = parseRules(entry.rules, 'subscription'), previous = Array.isArray(entry.previous) ? parseRules(entry.previous, 'subscription') : undefined;
          this.state.subscriptions.push({ url, rules,
            ...(validVersion(entry.version) ? { version: entry.version } : rules.length || typeof entry.updatedAt === 'number' ? { version: await contentVersion(rules) } : {}),
            ...(typeof entry.etag === 'string' ? { etag: entry.etag } : {}), ...(typeof entry.updatedAt === 'number' ? { updatedAt: entry.updatedAt } : {}),
            ...(typeof entry.lastError === 'string' ? { lastError: entry.lastError.slice(0, 512) } : {}),
            ...(previous ? { previous, previousVersion: validVersion(entry.previousVersion) ? entry.previousVersion : await contentVersion(previous) } : {}) });
        } catch { /* 单个坏订阅不抹掉其他来源的有效规则 */ }
      }
    } catch { this.state = { version: 1, local: [], subscriptions: [] }; }
  }
  ready() { return this.initialized; }
  forUrl(url: string): SiteRule | null {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) return null;
    const tiers = [this.state.local, this.state.subscriptions.flatMap((entry) => entry.rules), this.builtin];
    for (const tier of tiers) {
      const candidates = tier.flatMap((rule) => rule.match.filter((pattern) => matches(pattern, parsed.href)).map((pattern) => ({ rule, score: pattern.replace(/\*/g, '').length })));
      candidates.sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id));
      if (candidates[0]) return structuredClone(candidates[0].rule);
    }
    return null;
  }
  async save(value: unknown): Promise<SiteRule> {
    await this.ready();
    const rule = validateRule(normalizeLocalRule(value), 'local');
    this.state.local = [...this.state.local.filter((entry) => entry.id !== rule.id), rule];
    await this.persist(); return structuredClone(rule);
  }
  async remove(id: string) { await this.ready(); this.state.local = this.state.local.filter((rule) => rule.id !== id); await this.persist(); }
  list(): { local: SiteRule[]; subscriptions: RuleSubscriptionInfo[] } {
    return { local: structuredClone(this.state.local), subscriptions: this.state.subscriptions.map(({ rules, previous, previousVersion: _previousVersion, ...entry }) => ({ ...entry, version: entry.version ?? null, count: rules.length, canRollback: !!previous })) };
  }
  all(): SiteRule[] { return structuredClone([...this.state.local, ...this.state.subscriptions.flatMap((entry) => entry.rules), ...this.builtin]); }
  exportLocal(): SiteRule[] { return structuredClone(this.state.local); }
  async importLocal(rules: unknown) { await this.ready(); this.state.local = parseRules(rules, 'local'); await this.persist(); }
  private subscriptionUrl(value: string): string {
    let url: URL;
    try { url = new URL(value); } catch { return bad('规则订阅地址不正确'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) return bad('规则订阅只支持不带凭据的 HTTP(S) 地址');
    return url.href;
  }
  async subscribe(value: string) {
    await this.ready(); const url = this.subscriptionUrl(value);
    if (!this.state.subscriptions.some((entry) => entry.url === url)) { this.state.subscriptions.push({ url, rules: [] }); await this.persist(); }
    await this.refresh(url); return this.list();
  }
  async unsubscribe(value: string) { await this.ready(); this.state.subscriptions = this.state.subscriptions.filter((entry) => entry.url !== value); await this.persist(); }
  async refresh(value?: string) {
    await this.ready();
    for (const entry of this.state.subscriptions.filter((subscription) => !value || subscription.url === value)) {
      try {
        const response = await this.fetcher(entry.url, { headers: entry.etag ? { 'If-None-Match': entry.etag } : {}, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (response.status === 304) { entry.updatedAt = this.now(); entry.lastError = undefined; continue; }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await boundedText(response);
        const document: unknown = JSON.parse(body), rules = parseRules(document, 'subscription');
        const version = object(document) && validVersion(document.version) ? document.version : await contentVersion(rules);
        entry.previous = entry.rules;
        entry.previousVersion = entry.version;
        entry.rules = rules;
        entry.version = version;
        entry.etag = response.headers.get('etag') ?? undefined;
        entry.updatedAt = this.now(); entry.lastError = undefined;
      } catch { entry.lastError = '规则更新失败，继续使用上次有效规则'; }
    }
    await this.persist(); return this.list();
  }
  async rollback(url: string) {
    await this.ready(); const entry = this.state.subscriptions.find((item) => item.url === url);
    if (!entry?.previous) return bad('没有可以回退的规则版本');
    const current = entry.rules, version = entry.version;
    entry.rules = entry.previous; entry.version = entry.previousVersion; entry.previous = current; entry.previousVersion = version; entry.etag = undefined; entry.updatedAt = this.now();
    await this.persist(); return this.list();
  }
  private persist() {
    const value = structuredClone(this.state);
    const mutation = this.mutations.then(() => this.storage.set({ [KEY]: value }));
    this.mutations = mutation.catch(() => undefined); return mutation;
  }
}
