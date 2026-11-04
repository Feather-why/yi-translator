/**
 * 官方协议：https://developers.deepl.com/api-reference/translate/request-translation
 * XML：https://developers.deepl.com/docs/translate/translating-xml
 * 免费额度：https://support.deepl.com/hc/en-us/articles/360020685720-Usage-count-and-billing-in-DeepL-API
 * 套餐：https://support.deepl.com/hc/en-us/articles/360021200939-DeepL-API-plans
 * 鉴权：https://developers.deepl.com/docs/getting-started/auth
 * 核实：2026-11-04。Developer 总计 1,000,000 字符不重置；存量 Free 每月 500,000；/usage 为账户实际额度。
 */
import { defineProvider, classifyError, ProviderError, responseJson } from './types';
import { stripPlaceholders } from '../../shared/placeholders';

const mapLang = (code: string): string => /^(zh|zh-CN|zh-Hans)$/i.test(code) ? 'ZH'
  : /^(zh-TW|zh-HK|zh-Hant)$/i.test(code) ? 'ZH-HANT' : code.toUpperCase();
function credentials(config: Record<string, string>): { key: string; endpoint: string } {
  const key = config.key?.trim();
  if (!key) throw new ProviderError({ code: 'auth', message: '请先配置 DeepL API 密钥', retryable: false });
  // Free 与其他套餐不能混用主机；翻译和用量检查共用规则，避免测试成功后实际翻译仍报403。
  return { key, endpoint: key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com' };
}
function accountResetAt(value: unknown): number | undefined {
  if (typeof value !== 'string') return;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || +match[2]! > 23 || +match[3]! > 59 || +match[4]! > 59) return;
  // Date.parse会把2月30日自动滚到3月，不能把这种响应当成真实账期边界。
  const calendar = new Date(match[1]! + 'T00:00:00Z');
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== match[1]) return;
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp) && timestamp > Date.now()) return timestamp;
}
function xml(text: string): string {
  return '<txroot>' + text.split(/(<\/?g\d+>|<x\d+\/>)/g).map((part, i) => i % 2 ? part
    : part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('') + '</txroot>';
}
function fromXml(text: string): string {
  const match = /^\s*<txroot>([\s\S]*)<\/txroot>\s*$/.exec(text);
  if (!match) throw new ProviderError({ code: 'placeholder', message: 'DeepL 返回的 XML 结构异常', retryable: true });
  return match[1]!.replace(/<(x\d+)\s*\/>/g, '<$1/>').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    if (code.startsWith('#')) {
      const number = code.charAt(1).toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[code.toLowerCase()] || entity;
  });
}

export default defineProvider({
  id: 'deepl', name: 'DeepL API', version: '1.0.2', kind: 'mt', official: true, usedFor: ['fast', 'combined'],
  auth: [{ key: 'key', label: 'API 密钥', secret: true, required: true, helpUrl: 'https://www.deepl.com/your-account/keys' }],
  freeQuota: { unit: 'char', amount: 500_000, period: 'month' },
  quotaText: 'API Developer：总计100万字符，不按月重置；存量API Free：每月50万字符；实际上限以账户/usage为准。',
  limits: { maxChars: 4000, maxSegments: 50, concurrency: 2 }, placeholders: 'xml', mapLang,
  async translate(req, ctx) {
    const { key, endpoint } = credentials(ctx.config);
    const body: Record<string, unknown> = { text: req.texts.map(xml), target_lang: mapLang(req.targetLang), tag_handling: 'xml', tag_handling_version: 'v2', split_sentences: 'nonewlines' };
    if (req.sourceLang !== 'auto') body.source_lang = mapLang(req.sourceLang).split('-')[0];
    const json = await responseJson(await ctx.fetch(endpoint + '/v2/translate', {
      method: 'POST', headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));
    if (!Array.isArray(json?.translations) || json.translations.length !== req.texts.length || json.translations.some((item: any) => typeof item?.text !== 'string')) {
      throw new ProviderError({ code: 'server', message: 'DeepL 返回的片段数量或格式异常', retryable: true });
    }
    return json.translations.map((item: any) => fromXml(item.text));
  },
  async health(ctx) {
    const { key, endpoint } = credentials(ctx.config);
    const start = performance.now();
    const json = await responseJson(await ctx.fetch(endpoint + '/v2/usage', { headers: { Authorization: `DeepL-Auth-Key ${key}` } }));
    if (!Number.isSafeInteger(json?.character_count) || !Number.isSafeInteger(json?.character_limit) || json.character_count < 0 || json.character_limit < 0) {
      throw new ProviderError({ code: 'server', message: 'DeepL 用量格式异常', retryable: true });
    }
    const quotaResetAt = accountResetAt(json.end_time);
    return { ok: true, latencyMs: performance.now() - start, used: json.character_count, amount: json.character_limit,
      ...(quotaResetAt !== undefined ? { quotaResetAt } : {}) };
  }, classifyError,
  cost: (req) => req.texts.reduce((sum, text) => sum + Array.from(stripPlaceholders(text)).length, 0),
});
