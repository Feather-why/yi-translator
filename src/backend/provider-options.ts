import type { Mode, ProviderOptions, ProviderTemplate } from '../shared/protocol';
import { ProviderError, type ProviderDef } from './providers/types';
import openai from './providers/openai-compatible';
import llamacpp from './providers/llamacpp';
import remote from './providers/remote-node';
import libretranslate, { validateLibreTranslateConfig } from './providers/libretranslate';
import customHttp, { validateCustomHttpConfig } from './providers/custom-http';

const clones = new WeakMap<ProviderDef, ProviderTemplate>();
const templates: Record<ProviderTemplate, ProviderDef> = { 'openai-compatible': openai, llamacpp, 'remote-node': remote, libretranslate, 'custom-http': customHttp };
const common: (keyof ProviderOptions)[] = ['usedFor', 'weight', 'timeoutMs', 'concurrency', 'qps', 'maxChars', 'quota'];
const urls: Record<string, string> = {
  microsoft: 'https://learn.microsoft.com/azure/ai-services/translator/text-translation/reference/v3/translate',
  deepl: 'https://developers.deepl.com/api-reference/translate/request-translation',
  niutrans: 'https://niutrans.com/documents/contents/trans_text',
  tencent: 'https://cloud.tencent.com/document/product/551/104415',
  'openai-compatible': 'https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create',
  llamacpp: 'https://github.com/ggml-org/llama.cpp/tree/master/tools/server',
  gemini: 'https://ai.google.dev/api/generate-content',
  'browser-translator': 'https://developer.chrome.com/docs/ai/translator-api',
  'google-web': 'https://translate.google.com/',
  libretranslate: 'https://docs.libretranslate.com/',
  'custom-http': 'https://www.rfc-editor.org/rfc/rfc8259',
};
const fail = (message: string): never => { throw new ProviderError({ code: 'bad_input', message, retryable: false }); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function providerTemplate(provider: ProviderDef): ProviderTemplate | undefined {
  return clones.get(provider) ?? (Object.hasOwn(templates, provider.id) ? provider.id as ProviderTemplate : undefined);
}

export function providerTemplates(): ProviderTemplate[] { return Object.keys(templates) as ProviderTemplate[]; }

/** 在写入密钥库前验证合并后的配置，错误消息不能包含模板或凭据原文。 */
export function validateProviderConfig(provider: ProviderDef, config: Record<string, string>) {
  const template = providerTemplate(provider);
  if (template === 'libretranslate') validateLibreTranslateConfig(config);
  else if (template === 'custom-http') validateCustomHttpConfig(config);
}

/** 新实例不沿用原服务的地址，避免用户启用尚未配置的实例时请求到原服务器。 */
export function cloneProvider(template: ProviderTemplate, id: string, name: string): ProviderDef {
  if (!Object.hasOwn(templates, template)) return fail('不支持的自定义服务模板');
  if (typeof id !== 'string' || !/^custom-[a-zA-Z0-9-]{1,100}$/.test(id)) return fail('自定义服务编号无效');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) return fail('服务名称须为 1 至 100 个字符');
  const base = templates[template];
  const defaults = { ...base.defaults };
  // LibreTranslate明确约定默认本机5000端口；其他克隆仍要求填写自己的地址。
  if (template !== 'libretranslate') delete defaults.url;
  const clone: ProviderDef = { ...base, id, name: name.trim(), auth: base.auth.map((field) => ({ ...field })),
    usedFor: [...base.usedFor], limits: { ...base.limits }, defaults };
  if (template === 'openai-compatible') clone.auth = clone.auth.map((field) => field.key === 'key' ? { ...field, required: false } : field);
  clones.set(clone, template);
  return clone;
}

export function providerMetadata(provider: ProviderDef, template = providerTemplate(provider)): {
  editable: (keyof ProviderOptions)[]; defaults: ProviderOptions; docsUrl?: string;
} {
  // 非官方兜底的限速、最低权重与参与档位不能被高级设置抬高。
  const editable: (keyof ProviderOptions)[] = !provider.official ? ['timeoutMs', 'maxChars']
    : provider.kind === 'builtin' ? ['timeoutMs', 'maxChars'] : [...common];
  if (template) editable.unshift('endpoint', ...(['libretranslate', 'custom-http'].includes(template) ? [] : ['model' as const]));
  else if (provider.auth.some((field) => field.key === 'model')) editable.unshift('model');
  if (template === 'openai-compatible' || template === 'llamacpp') editable.push('prompt', 'temperature');
  const defaults: ProviderOptions = { usedFor: [...provider.usedFor], weight: provider.official ? 50 : 0,
    timeoutMs: ['llm', 'local', 'remote'].includes(provider.kind) ? 60_000 : 15_000,
    concurrency: provider.limits.concurrency, maxChars: provider.limits.maxChars,
    ...(provider.limits.qps !== undefined ? { qps: provider.limits.qps } : {}),
    ...(provider.freeQuota ? { quota: { ...provider.freeQuota } } : {}) };
  if (template) { defaults.endpoint = provider.defaults?.url ?? ''; if (editable.includes('model')) defaults.model = provider.defaults?.model ?? ''; }
  else if (editable.includes('model')) defaults.model = provider.defaults?.model ?? '';
  if (template === 'llamacpp') defaults.temperature = 0.7;
  const docsUrl = urls[template ?? provider.id] ?? provider.auth.find((field) => !!field.helpUrl)?.helpUrl;
  return { editable, defaults, ...(docsUrl ? { docsUrl } : {}) };
}

export function validateEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return fail('接口地址格式无效');
  if (!value.trim()) return '';
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { return fail('接口地址须为 HTTP(S) 地址'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return fail('接口地址不能包含凭据、查询参数或片段');
  return parsed.href.replace(/\/+$/, '');
}

export function normalizeOptions(provider: ProviderDef, value: unknown, template = providerTemplate(provider)): ProviderOptions {
  if (!object(value)) return fail('服务高级设置格式无效');
  const editable = new Set(providerMetadata(provider, template).editable);
  for (const key of Object.keys(value)) if (!editable.has(key as keyof ProviderOptions)) return fail('服务不支持此高级设置：' + key);
  const out: ProviderOptions = {};
  if (Object.hasOwn(value, 'endpoint')) out.endpoint = validateEndpoint(value.endpoint);
  for (const key of ['model', 'prompt'] as const) if (Object.hasOwn(value, key)) {
    const entry = value[key];
    if (typeof entry !== 'string' || entry.length > (key === 'prompt' ? 16_000 : 512)) return fail(key === 'prompt' ? '提示词过长或格式无效' : '模型名称过长或格式无效');
    out[key] = entry.trim();
  }
  if (Object.hasOwn(value, 'usedFor')) {
    const modes = value.usedFor;
    if (!Array.isArray(modes) || !modes.length || modes.length > 3 || modes.some((mode) => !['fast', 'accurate', 'combined'].includes(mode))) return fail('参与档位格式无效');
    out.usedFor = (['fast', 'accurate', 'combined'] as Mode[]).filter((mode) => modes.includes(mode));
  }
  const limits: Record<'weight' | 'timeoutMs' | 'concurrency' | 'qps' | 'maxChars' | 'temperature', [number, number, boolean]> = {
    weight: [0, 100, false], timeoutMs: [1000, 180_000, true], concurrency: [1, 16, true], qps: [0.1, 100, false],
    maxChars: [16, Math.max(16, provider.limits.maxChars), true], temperature: [0, 2, false],
  };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) if (Object.hasOwn(value, key)) {
    const entry = value[key], [min, max, integer] = limits[key];
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return fail('服务数值设置须为有限数字');
    const clamped = Math.max(min, Math.min(max, entry)); out[key] = integer ? Math.round(clamped) : clamped;
  }
  if (Object.hasOwn(value, 'quota')) {
    const quota = value.quota;
    if (!object(quota) || Object.keys(quota).some((key) => !['amount', 'unit', 'period'].includes(key))
      || typeof quota.amount !== 'number' || !Number.isSafeInteger(quota.amount) || quota.amount < 0
      || quota.unit !== 'char' || !['day', 'month'].includes(String(quota.period))) return fail('当前额度只支持按天或按月的字符计量');
    out.quota = { amount: quota.amount, unit: quota.unit as NonNullable<ProviderOptions['quota']>['unit'], period: quota.period as NonNullable<ProviderOptions['quota']>['period'] };
  }
  return out;
}

function fingerprint(options: ProviderOptions): string {
  const stable = (value: unknown): string => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
    : object(value) ? '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}' : JSON.stringify(value) ?? '';
  let hash = 2166136261;
  for (const char of stable(options)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 批处理按版本隔离，设置修改后不会把两份不同模型请求合进同一批次。 */
export function effectiveProvider(provider: ProviderDef, options: ProviderOptions, config?: Record<string, string>): ProviderDef {
  const result: ProviderDef = { ...provider, limits: { ...provider.limits }, usedFor: options.usedFor ? [...options.usedFor] : [...provider.usedFor],
    ...(Object.keys(options).length ? { version: provider.version + '+options.' + fingerprint(options) } : {}) };
  if (options.concurrency !== undefined) result.limits.concurrency = options.concurrency;
  if (options.qps !== undefined) result.limits.qps = options.qps;
  if (options.maxChars !== undefined) result.limits.maxChars = options.maxChars;
  if (options.quota !== undefined) result.freeQuota = { ...options.quota };
  const template = providerTemplate(provider);
  // 单段模式不能在一个批次里循环发HTTP，否则会绕过按实际请求计数的QPS。
  if (template === 'custom-http') result.limits.maxSegments = config?.batch === 'array' ? 16 : 1;
  if (template) clones.set(result, template);
  return result;
}

export function providerConfig(provider: ProviderDef, config: Record<string, string>, options: ProviderOptions): Record<string, string> {
  const result = { ...config };
  if (options.endpoint !== undefined) result.url = options.endpoint;
  if (options.model !== undefined) result.model = options.model;
  if (options.prompt !== undefined) result.prompt = options.prompt;
  if (options.temperature !== undefined) result.temperature = String(options.temperature);
  return result;
}
