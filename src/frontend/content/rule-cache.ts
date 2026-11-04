/**
 * 站点规则的本地缓存：点翻译时直接用上次查到的规则立刻开始，不用等后台醒来（最多省 0.4 秒）；
 * 同时在后台重新查一次，规则变了再按新规则重来。设置页改规则时清空缓存。
 */
import type { SiteRule } from '../../shared/protocol';
import { rpc } from '../../shared/rpc';

export const RULE_CACHE_KEY = 'ui.ruleCache';
const MAX = 300;
const TTL = 7 * 86_400_000;

interface Entry { rule: SiteRule | null; at: number }
type Cache = Record<string, Entry>;

function keysFor(url: URL): { page: string; host: string } {
  return { page: `p:${url.origin}${url.pathname}`, host: `h:${url.host}` };
}

/** 规则只按域名匹配（没有写具体路径）时可以整个网站共用。 */
function hostWide(rule: SiteRule | null): boolean {
  if (!rule) return true;
  return rule.match.every((m) => {
    const i = m.indexOf('://');
    const rest = i >= 0 ? m.slice(i + 3) : m;
    const slash = rest.indexOf('/');
    return slash < 0 || rest.slice(slash) === '/*' || rest.slice(slash) === '/';
  });
}

async function read(): Promise<Cache> {
  try {
    const got: Record<string, unknown> = await chrome.storage.local.get(RULE_CACHE_KEY);
    const v = got[RULE_CACHE_KEY];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Cache) : {};
  } catch {
    return {};
  }
}

function valid(e: unknown): e is Entry {
  if (!e || typeof e !== 'object') return false;
  const o = e as Entry;
  return typeof o.at === 'number' && Date.now() - o.at < TTL
    && (o.rule === null || (typeof o.rule === 'object' && Array.isArray(o.rule.match) && typeof o.rule.id === 'string'));
}

export async function cachedRule(href: string): Promise<{ hit: boolean; rule: SiteRule | null }> {
  let url: URL;
  try { url = new URL(href); } catch { return { hit: false, rule: null }; }
  const cache = await read();
  const { page, host } = keysFor(url);
  const e = cache[page] ?? cache[host];
  return valid(e) ? { hit: true, rule: e.rule } : { hit: false, rule: null };
}

export async function storeRule(href: string, rule: SiteRule | null): Promise<void> {
  let url: URL;
  try { url = new URL(href); } catch { return; }
  const cache = await read();
  const { page, host } = keysFor(url);
  delete cache[page];
  cache[hostWide(rule) ? host : page] = { rule, at: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > MAX) {
    keys.sort((a, b) => (cache[a]?.at ?? 0) - (cache[b]?.at ?? 0));
    for (const k of keys.slice(0, keys.length - MAX)) delete cache[k];
  }
  try { await chrome.storage.local.set({ [RULE_CACHE_KEY]: cache }); } catch { /* 存不下就算了 */ }
}

export async function clearRuleCache(): Promise<void> {
  try { await chrome.storage.local.remove(RULE_CACHE_KEY); } catch { /* ignore */ }
}

/** 两条规则对翻译结果的影响是否一样（只比较会改变扫描和显示的字段）。 */
export function sameEffect(a: SiteRule | null, b: SiteRule | null): boolean {
  const pick = (r: SiteRule | null) => r && JSON.stringify([r.include ?? [], r.exclude ?? [], r.waitFor ?? '', r.display ?? '', r.style ?? {}]);
  return pick(a) === pick(b);
}

/** 提前查好规则写进缓存（鼠标移到悬浮球上时调用）。 */
export async function prefetchRule(href: string): Promise<void> {
  try {
    const rule = await rpc('rules:forUrl', { url: href });
    await storeRule(href, rule ?? null);
  } catch { /* 后台没醒或不支持就算了 */ }
}
