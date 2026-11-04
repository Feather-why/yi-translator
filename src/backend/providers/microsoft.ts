/**
 * 官方协议：https://learn.microsoft.com/azure/ai-services/translator/text-translation/reference/v3/translate
 * F0 免费额度：https://azure.microsoft.com/en-us/pricing/details/translator/（每月 200 万字符）
 * 核实：2026-11-03。50,000 字符/请求；这里取更小的批量，降低首段延迟。
 */
import { defineProvider, classifyError, ProviderError, responseJson } from './types';
import { stripPlaceholders } from '../../shared/placeholders';

const mapLang = (code: string): string => /^(zh-CN|zh-Hans|zh)$/i.test(code) ? 'zh-Hans'
  : /^(zh-TW|zh-HK|zh-Hant)$/i.test(code) ? 'zh-Hant' : code;
const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function unescape(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, value: string) => {
    if (value[0] === '#') {
      const number = value.charAt(1).toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10);
      return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[value.toLowerCase()] || entity;
  });
}

export function encodeHtml(text: string): string {
  // 官方 HTML 模式要求完整元素；根节点也让普通文本始终使用同一还原路径。
  return '<div data-tx-root="1">' + text.split(/(<\/?g\d+>|<x\d+\/>)/g).map((part, i) => {
    if (i % 2 === 0) return escape(part);
    if (/^<\/g/.test(part)) return '</span>';
    const number = part.match(/\d+/)![0];
    return part.startsWith('<x') ? `<span class="notranslate" data-tx-x="${number}">TX${number}</span>` : `<span data-tx-g="${number}">`;
  }).join('') + '</div>';
}

export function decodeHtml(text: string): string {
  const root = /^\s*<div\b[^>]*\bdata-tx-root\s*=\s*["']1["'][^>]*>([\s\S]*)<\/div>\s*$/i.exec(text);
  if (!root) throw new ProviderError({ code: 'placeholder', message: '微软返回的 HTML 根结构异常', retryable: true });
  const stack: { name: string; atom: boolean }[] = [];
  let out = '';
  for (const token of root[1]!.split(/(<[^>]*>)/g)) {
    if (!token.startsWith('<')) { if (!stack.at(-1)?.atom) out += unescape(token); continue; }
    if (/^<\/span\s*>$/i.test(token)) {
      const item = stack.pop();
      if (!item) throw new ProviderError({ code: 'placeholder', message: '微软返回的标签未配对', retryable: true });
      if (!item.atom) out += `</${item.name}>`;
      continue;
    }
    const match = /^<span\b[^>]*\bdata-tx-([gx])\s*=\s*["'](\d+)["'][^>]*>$/i.exec(token);
    if (!match || stack.at(-1)?.atom) throw new ProviderError({ code: 'placeholder', message: '微软返回的标签格式异常', retryable: true });
    const atom = match[1]!.toLowerCase() === 'x';
    const name = match[1]!.toLowerCase() + match[2]!;
    stack.push({ name, atom });
    out += atom ? `<${name}/>` : `<${name}>`;
  }
  if (stack.length) throw new ProviderError({ code: 'placeholder', message: '微软返回的标签未闭合', retryable: true });
  return out;
}

export default defineProvider({
  id: 'microsoft', name: '微软 Azure Translator', version: '1.0.2', kind: 'mt', official: true, usedFor: ['fast', 'combined'],
  auth: [{ key: 'key', label: '订阅密钥', secret: true, required: true, helpUrl: 'https://portal.azure.com/' }, { key: 'region', label: '资源地域（多服务资源必填）', placeholder: 'eastasia' }],
  freeQuota: { unit: 'char', amount: 2_000_000, period: 'month' },
  limits: { maxChars: 4000, maxSegments: 50, concurrency: 3 }, placeholders: 'html', mapLang,
  async translate(req, ctx) {
    if (!ctx.config.key) throw new ProviderError({ code: 'auth', message: '请先配置微软订阅密钥', retryable: false });
    const query = new URLSearchParams({ 'api-version': '3.0', to: mapLang(req.targetLang), textType: 'html' });
    if (req.sourceLang !== 'auto') query.set('from', mapLang(req.sourceLang));
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'Ocp-Apim-Subscription-Key': ctx.config.key };
    if (ctx.config.region) headers['Ocp-Apim-Subscription-Region'] = ctx.config.region;
    const response = await ctx.fetch(`https://api.cognitive.microsofttranslator.com/translate?${query}`, { method: 'POST', headers, body: JSON.stringify(req.texts.map((text) => ({ Text: encodeHtml(text) }))) });
    if (!response.ok) {
      let azureCode = 0;
      try { azureCode = Number((await response.clone().json())?.error?.code); } catch { /* HTTP 分类仍可提供可靠错误 */ }
      if (azureCode === 403001) throw new ProviderError({ code: 'quota', message: '微软翻译字符额度已用完', retryable: false });
    }
    const json = await responseJson(response);
    if (!Array.isArray(json) || json.length !== req.texts.length || json.some((item: any) => typeof item?.translations?.[0]?.text !== 'string')) {
      throw new ProviderError({ code: 'server', message: '微软翻译返回的片段数量或格式异常', retryable: true });
    }
    return json.map((item: any) => decodeHtml(item.translations[0].text));
  }, classifyError,
  cost: (req) => req.texts.reduce((sum, text) => sum + Array.from(stripPlaceholders(text)).length, 0),
});
