/**
 * 声明式JSON接口，语法依据：https://www.rfc-editor.org/rfc/rfc8259
 * HTTP依据：https://fetch.spec.whatwg.org/；额度由用户填写，不声明免费额度。
 * 核实：2026-11-04。仅允许POST JSON和固定路径取值，不解释JavaScript或远程代码。
 */
import { defineProvider, classifyError, ProviderError, responseJson } from './types';
import { checkPlaceholders, stripPlaceholders, tokenize } from '../../shared/placeholders';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type PathPart = string | number | '*';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const bad = (message: string): never => { throw new ProviderError({ code: 'bad_input', message, retryable: false }); };
const responseError = (): never => { throw new ProviderError({ code: 'server', message: '自定义接口返回路径、译文类型或片段数量不匹配', retryable: true }); };
const defaultBody = (batch: string) => batch === 'array' ? '{"q":"{{texts}}","source":"{{from}}","target":"{{to}}"}' : '{"q":"{{text}}","source":"{{from}}","target":"{{to}}"}';

function endpoint(value = '') {
  if (!value.trim()) return '';
  let url: URL;
  try { url = new URL(value); } catch { return bad('自定义接口地址须为 HTTP(S) 地址'); }
  if (value.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return bad('自定义接口地址不能包含凭据、查询参数或片段');
  return url.href;
}
function headers(value = ''): Record<string, string> {
  if (value.length > 32_000) return bad('请求头 JSON 超过 32KB');
  let parsed: unknown;
  try { parsed = value.trim() ? JSON.parse(value) : {}; } catch { return bad('请求头必须是 JSON 对象'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bad('请求头必须是 JSON 对象');
  const result: Record<string, string> = Object.create(null), names = new Set<string>();
  for (const [key, content] of Object.entries(parsed)) {
    const name = key.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) || forbidden.has(name) || names.has(name) || typeof content !== 'string' || /[\u0000-\u001f\u007f]/.test(content)
      || /^(host|content-length|cookie2?|set-cookie|origin|referer|connection|upgrade|transfer-encoding|keep-alive|trailer|te|expect|accept-charset|accept-encoding|access-control-request-.+|proxy-.+|sec-.+)$/i.test(name)) return bad('请求头包含重复、非法或浏览器禁止设置的字段');
    if (name === 'content-type' && !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;\s*charset=utf-8)?$/i.test(content)) return bad('自定义接口只支持 JSON 请求体');
    result[key] = content; names.add(name);
  }
  if (!names.has('content-type')) result['Content-Type'] = 'application/json';
  return result;
}
function pathParts(value = 'translatedText'): PathPart[] {
  if (value.length > 512 || !value.trim()) return bad('返回路径不能为空或超过512字符');
  const text = value.trim(), parts: PathPart[] = []; let offset = text.startsWith('$') ? 1 : 0;
  if (offset && text[offset] && !['.', '['].includes(text[offset]!)) return bad('返回路径语法无效');
  while (offset < text.length) {
    if (parts.length >= 32) return bad('返回路径层级过多');
    if (text[offset] === '.') { offset++; if (offset === text.length) return bad('返回路径语法无效'); }
    else if (parts.length && text[offset] !== '[') return bad('返回路径语法无效');
    if (text[offset] === '[') {
      const rest = text.slice(offset), numeric = /^\[(\d+|\*)\]/.exec(rest), quoted = /^\[("(?:[^"\\]|\\.)*")\]/.exec(rest);
      if (numeric) {
        const part = numeric[1] === '*' ? '*' : Number(numeric[1]);
        if (typeof part === 'number' && (!Number.isSafeInteger(part) || part > 1_000_000)) return bad('返回路径数组下标无效');
        parts.push(part); offset += numeric[0].length;
      } else if (quoted) {
        let part: string; try { part = JSON.parse(quoted[1]!); } catch { return bad('返回路径字段无效'); }
        if (!part || forbidden.has(part) || /[\u0000-\u001f]/.test(part)) return bad('返回路径字段不允许');
        // 星号字段与数组展开有歧义，拒绝而非读取错误位置。
        if (part === '*') return bad('返回路径星号只允许用于数组展开');
        parts.push(part); offset += quoted[0].length;
      } else return bad('返回路径只支持字段、数组下标和 [*]');
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(offset));
      if (!match || forbidden.has(match[0])) return bad('返回路径字段不允许');
      parts.push(match[0]); offset += match[0].length;
    }
  }
  return parts;
}
function body(value: string | undefined, batch: string): Json {
  const raw = value?.trim() ? value : defaultBody(batch);
  if (raw.length > 64_000) return bad('请求体模板超过64KB');
  let parsed: Json; try { parsed = JSON.parse(raw) as Json; } catch { return bad('请求体模板必须是有效 JSON，变量须放在字符串值中'); }
  let nodes = 0, textVariables = 0;
  const inspect = (entry: Json, depth: number): void => {
    if (++nodes > 2000 || depth > 24) bad('请求体模板过于复杂');
    if (typeof entry === 'string') for (const match of entry.matchAll(/\{\{([^{}]+)\}\}/g)) {
      const key = match[1]!;
      if (!['text', 'texts', 'from', 'to'].includes(key)) bad('请求体模板包含未知变量');
      if (key === 'texts' && entry !== '{{texts}}') bad('{{texts}} 必须作为完整 JSON 字符串值，以便替换为数组');
      if (key === 'text' && batch === 'array') bad('数组批量模式请使用 {{texts}}，不能使用 {{text}}');
      if (key === 'text' || key === 'texts') textVariables++;
    }
    else if (Array.isArray(entry)) entry.forEach((child) => inspect(child, depth + 1));
    else if (entry && typeof entry === 'object') for (const [key, child] of Object.entries(entry)) {
      if (forbidden.has(key) || key.includes('{{')) bad('请求体字段名不允许原型字段或模板变量');
      inspect(child, depth + 1);
    }
  };
  inspect(parsed, 0); if (!textVariables) bad('请求体模板必须包含 {{text}} 或 {{texts}}');
  return parsed;
}
function settings(config: Record<string, string>) {
  if (['url', 'headers', 'body', 'resultPath', 'batch'].some((key) => config[key] !== undefined && typeof config[key] !== 'string')) return bad('自定义接口配置必须是文本');
  const batch = config.batch || 'single'; if (!['single', 'array'].includes(batch)) return bad('批量方式须为 single 或 array');
  return { url: endpoint(config.url), headers: headers(config.headers), body: body(config.body, batch), path: pathParts(config.resultPath || 'translatedText'), batch };
}
export function validateCustomHttpConfig(config: Record<string, string>) { settings(config); }
function render(template: Json, variables: { text: string; texts: string[]; from: string; to: string }): Json {
  if (typeof template === 'string') {
    if (template === '{{texts}}') return variables.texts.slice();
    // 只替换模板一次；原文里的变量样式字符串不会被二次解释。
    return template.replace(/\{\{(text|from|to)\}\}/g, (_match, key: 'text' | 'from' | 'to') => variables[key]);
  }
  if (Array.isArray(template)) return template.map((entry) => render(entry, variables));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([key, entry]) => [key, render(entry, variables)]));
  return template;
}
function extract(json: unknown, parts: PathPart[]): unknown[] {
  let current: unknown[] = [json];
  for (const part of parts) {
    current = current.flatMap((value): unknown[] => {
    if (part === '*') { if (!Array.isArray(value) || value.length > 256) return responseError(); return value; }
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part) || typeof part === 'number' && !Array.isArray(value)) return responseError();
    return [(value as Record<string | number, unknown>)[part]];
    });
    if (current.length > 256) responseError();
  }
  return current.length === 1 && Array.isArray(current[0]) ? current[0] : current;
}
function structure(text: string) {
  const stack: string[] = [], parents: string[] = [];
  for (const token of tokenize(text)) { if (token.kind === 'close') stack.pop(); else { parents.push(`${token.name}:${stack.join('/')}`); if (token.kind === 'open') stack.push(token.name); } }
  return parents.sort().join('|');
}

export default defineProvider({
  id: 'custom-http', name: '自定义 HTTP 翻译', version: '1.0.0', kind: 'mt', official: true, usedFor: ['fast', 'combined'],
  defaults: { batch: 'single', resultPath: 'translatedText' },
  auth: [
    { key: 'url', label: 'POST 接口地址', type: 'url', required: true, placeholder: 'http://127.0.0.1:5000/translate' },
    { key: 'headers', label: '请求头 JSON（加密保存）', type: 'textarea', secret: true, placeholder: '{"Authorization":"Bearer 你的密钥"}' },
    { key: 'body', label: '请求体 JSON 模板（加密保存；留空使用默认）', type: 'textarea', secret: true, placeholder: '{"q":"{{text}}","source":"{{from}}","target":"{{to}}"}' },
    { key: 'resultPath', label: '译文 JSON 路径', placeholder: 'data.translations[*].text' },
    { key: 'batch', label: '批量方式', type: 'select', options: [{ value: 'single', label: '一段一个请求' }, { value: 'array', label: '一次发送数组（使用 {{texts}}）' }] },
  ],
  limits: { maxChars: 6000, maxSegments: 1, concurrency: 2, qps: 2 }, placeholders: 'prompt',
  async translate(req, ctx) {
    const config = settings(ctx.config);
    if (!config.url) bad('请先填写自定义 HTTP 接口地址');
    if (!req.texts.length) return [];
    if (req.texts.some((text) => typeof text !== 'string') || req.texts.length > (config.batch === 'array' ? 16 : 1)
      || req.texts.reduce((n, text) => n + text.length, 0) > 6000) bad('自定义接口请求超过当前批量方式的限制');
    if (![req.sourceLang, req.targetLang].every((code) => typeof code === 'string' && /^(auto|[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)$/.test(code)) || req.targetLang === 'auto') bad('自定义接口的语言代码无效');
    const payload = render(config.body, { text: req.texts[0]!, texts: req.texts, from: req.sourceLang, to: req.targetLang });
    const json = await responseJson(await ctx.fetch(config.url, { method: 'POST', headers: config.headers, credentials: 'omit', redirect: 'error', body: JSON.stringify(payload) }));
    const values = extract(json, config.path);
    if (values.length !== req.texts.length) responseError();
    return values.map((value, index) => {
      const source = req.texts[index]!;
      if (typeof value !== 'string' || value.length > 2_000_000 || source.trim() && !value.trim()) return responseError();
      if (!checkPlaceholders(source, value).ok || structure(source) !== structure(value)) throw new ProviderError({ code: 'placeholder', message: '自定义接口未保留原文占位符', retryable: true });
      return value;
    });
  }, classifyError,
  cost: (req) => req.texts.reduce((sum, text) => sum + Array.from(stripPlaceholders(text)).length, 0),
});
