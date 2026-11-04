/**
 * 官方协议：https://docs.libretranslate.com/api/operations/translate/
 * 部署及额度：https://docs.libretranslate.com/guides/installation/；自建实例的资源/额度由用户管理。
 * 核实：2026-11-04。不使用公共免密钥镜像，也不声明免费字符额度。
 */
import { defineProvider, classifyError, ProviderError, responseJson, type ProviderRequest } from './types';
import { checkPlaceholders, stripPlaceholders, tokenize } from '../../shared/placeholders';

const fail = (message: string): never => { throw new ProviderError({ code: 'bad_input', message, retryable: false }); };
const mapLang = (code: string): string => /^(zh|zh-CN|zh-Hans)$/i.test(code) ? 'zh'
  : /^(zt|zh-TW|zh-HK|zh-Hant)$/i.test(code) ? 'zt' : code.split('-')[0]!.toLowerCase();
function base(config: Record<string, string>) {
  let url: URL;
  try { url = new URL(config.url || 'http://127.0.0.1:5000'); } catch { return fail('LibreTranslate 地址须为 HTTP(S) 地址'); }
  if (url.href.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail('LibreTranslate 地址不能包含凭据、查询参数或片段');
  return url.href.replace(/\/+$/, '');
}
export function validateLibreTranslateConfig(config: Record<string, string>) {
  base(config);
  if (config.key !== undefined && (typeof config.key !== 'string' || config.key.length > 16_000)) fail('LibreTranslate 密钥格式无效或过长');
}
function languages(req: ProviderRequest) {
  if (![req.sourceLang, req.targetLang].every((code) => typeof code === 'string' && /^(auto|[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)$/.test(code))
    || req.targetLang === 'auto') fail('LibreTranslate 的原文或目标语言无效');
  return { source: mapLang(req.sourceLang), target: mapLang(req.targetLang) };
}
function structure(text: string) {
  const stack: string[] = [], parents: string[] = [];
  for (const token of tokenize(text)) {
    if (token.kind === 'close') stack.pop();
    else { parents.push(`${token.name}:${stack.join('/')}`); if (token.kind === 'open') stack.push(token.name); }
  }
  return parents.sort().join('|');
}
function output(source: string, text: unknown): string {
  if (typeof text !== 'string' || text.length > 2_000_000 || source.trim() && !text.trim()) throw new ProviderError({ code: 'server', message: 'LibreTranslate 返回了无效或空译文', retryable: true });
  if (!checkPlaceholders(source, text).ok || structure(source) !== structure(text)) throw new ProviderError({ code: 'placeholder', message: 'LibreTranslate 未保留原文占位符', retryable: true });
  return text;
}

export default defineProvider({
  id: 'libretranslate', name: 'LibreTranslate 自建翻译', version: '1.0.0', kind: 'mt', official: true, usedFor: ['fast', 'combined'],
  defaults: { url: 'http://127.0.0.1:5000' },
  auth: [{ key: 'url', label: 'LibreTranslate 基础地址', type: 'url', required: true, placeholder: 'http://127.0.0.1:5000', helpUrl: 'https://docs.libretranslate.com/' },
    { key: 'key', label: 'API key（自建实例可留空）', secret: true }],
  limits: { maxChars: 6000, maxSegments: 16, concurrency: 2, qps: 2 }, placeholders: 'prompt', mapLang,
  async translate(req, ctx) {
    validateLibreTranslateConfig(ctx.config);
    const language = languages(req);
    if (!req.texts.length) return [];
    if (req.texts.length > 16 || req.texts.some((text) => typeof text !== 'string') || req.texts.reduce((n, text) => n + text.length, 0) > 6000) fail('LibreTranslate 请求超过批量限制');
    // 保留整段上下文；失标由Core统一恢复，不能默认按链接拆碎自然句子。
    const response = await ctx.fetch(`${base(ctx.config)}/translate`, {
      method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: req.texts, ...language, format: 'text', ...(ctx.config.key ? { api_key: ctx.config.key } : {}) }),
    });
    if (response.status === 400) throw new ProviderError({ code: 'bad_input', message: '此 LibreTranslate 实例不支持该请求或语言对，请检查已安装的语言模型', retryable: false });
    const json = await responseJson(response);
    if (json?.error) throw new ProviderError({ code: 'server', message: 'LibreTranslate 未能完成翻译，请检查实例配置和语言模型', retryable: true });
    if (!Array.isArray(json?.translatedText) || json.translatedText.length !== req.texts.length) throw new ProviderError({ code: 'server', message: 'LibreTranslate 返回的译文数量不匹配', retryable: true });
    return req.texts.map((source, index) => output(source, json.translatedText[index]));
  }, classifyError,
  cost: (req) => req.texts.reduce((sum, text) => sum + Array.from(stripPlaceholders(text)).length, 0),
  async health(ctx) {
    validateLibreTranslateConfig(ctx.config);
    const started = performance.now();
    const json = await responseJson(await ctx.fetch(`${base(ctx.config)}/languages`, { credentials: 'omit', redirect: 'error' }));
    if (!Array.isArray(json) || !json.length || json.some((value: unknown) => !value || typeof value !== 'object' || !('code' in value) || typeof value.code !== 'string')) throw new ProviderError({ code: 'server', message: 'LibreTranslate 没有返回有效语言列表', retryable: true });
    return { ok: true, latencyMs: performance.now() - started };
  },
});
