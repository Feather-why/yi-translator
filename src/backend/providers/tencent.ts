/**
 * 官方协议（存量版本）：https://github.com/TencentCloud/tencentcloud-sdk-nodejs/blob/4.0.1054/src/services/tmt/v20180321/tmt_models.ts
 * 免费额度来源：https://cloud.tencent.com/document/product/551/104415
 * 核实：2026-11-04。2026-10-01 起不再发新免费包；文本接口已停止接入新用户。
 * 因此不声明每月 500 万免费额度，必须由用户填写存量预算，默认为 0。
 */
import { defineProvider, classifyError, ProviderError, responseJson, type ProviderContext, type ProviderRequest } from './types';
import { stripPlaceholders } from '../../shared/placeholders';
import { signTc3 } from './signers/tc3';

const mapLang = (code: string): string => /^(zh-CN|zh-Hans|zh)$/i.test(code) ? 'zh'
  : /^(zh-TW|zh-HK|zh-Hant)$/i.test(code) ? 'zh-TW' : (code.split('-')[0] ?? code).toLowerCase();

// 存量 TextTranslateBatch 的语言对有方向限制，不能把普通 ISO 代码一律当作可用。
const european = ['fr', 'es', 'it', 'de', 'tr', 'ru', 'pt'];
const targets: Record<string, readonly string[]> = {
  zh: ['en', 'ja', 'ko', ...european, 'vi', 'id', 'th', 'ms', 'ar'],
  'zh-TW': ['en', 'ja', 'ko', ...european, 'vi', 'id', 'th', 'ms', 'ar'],
  en: ['zh', 'zh-TW', 'ja', 'ko', ...european, 'vi', 'id', 'th', 'ms', 'ar', 'hi'],
  ja: ['zh', 'zh-TW', 'en', 'ko'], ko: ['zh', 'zh-TW', 'en', 'ja'], hi: ['en'],
  ...Object.fromEntries(european.map((source) => [source, ['zh', 'zh-TW', 'en', ...european.filter((target) => target !== source)]])),
  ...Object.fromEntries(['vi', 'id', 'th', 'ms', 'ar'].map((source) => [source, ['zh', 'zh-TW', 'en']])),
};
const supports = (source: string, target: string): boolean => {
  const from = mapLang(source), to = mapLang(target);
  return from === 'auto' ? Object.values(targets).some((values) => values.includes(to)) : targets[from]?.includes(to) === true;
};

async function translate(req: ProviderRequest, ctx: ProviderContext): Promise<string[]> {
  if (!supports(req.sourceLang, req.targetLang)) throw new ProviderError({ code: 'bad_input', message: `腾讯存量翻译接口不支持 ${req.sourceLang} → ${req.targetLang}，请选择其他翻译服务`, retryable: false });
  if (!ctx.config.secretId || !ctx.config.secretKey) throw new ProviderError({ code: 'auth', message: '请先配置腾讯云密钥', retryable: false });
  // 旧接口不承诺 HTML 透传，标签始终留在本地，只把文本叶子送到服务端。
  const parts = req.texts.map((text) => text.split(/(<\/?g\d+>|<x\d+\/>)/g));
  const positions: [number, number][] = [];
  const leaves: string[] = [];
  parts.forEach((segments, i) => segments.forEach((text, j) => {
    if (j % 2 === 0 && text.trim()) { positions.push([i, j]); leaves.push(text); }
  }));
  if (!leaves.length) return req.texts.slice();
  if (leaves.reduce((sum, text) => sum + Array.from(text).length, 0) >= 6000) {
    throw new ProviderError({ code: 'bad_input', message: '腾讯批量文本超过字符限制', retryable: false });
  }
  const body = JSON.stringify({ SourceTextList: leaves, Source: mapLang(req.sourceLang), Target: mapLang(req.targetLang), ProjectId: 0 });
  const timestamp = Math.floor(Date.now() / 1000);
  const authorization = await signTc3({ secretId: ctx.config.secretId, secretKey: ctx.config.secretKey, host: 'tmt.tencentcloudapi.com', service: 'tmt', action: 'TextTranslateBatch', body, timestamp });
  const json = await responseJson(await ctx.fetch('https://tmt.tencentcloudapi.com/', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: authorization,
      'X-TC-Action': 'TextTranslateBatch', 'X-TC-Version': '2018-03-21', 'X-TC-Timestamp': String(timestamp), 'X-TC-Region': ctx.config.region || 'ap-shanghai' }, body,
  }));
  const response = json?.Response;
  if (response?.Error) {
    const value = String(response.Error.Code || '');
    const code = /RequestLimitExceeded/.test(value) ? 'rate_limit'
      : /LimitExceeded|ResourceInsufficient|NoFreeAmount|NoAvailableAmount|Balance|Arrears/.test(value) ? 'quota'
      : /AuthFailure|UnauthorizedOperation/.test(value) ? 'auth'
      : /Invalid|Unsupported|MissingParameter/.test(value) ? 'bad_input' : 'server';
    throw new ProviderError({ code, message: `腾讯翻译请求失败（${code}）`, retryable: code === 'rate_limit' || code === 'server' });
  }
  if (!Array.isArray(response?.TargetTextList) || response.TargetTextList.length !== leaves.length || response.TargetTextList.some((text: unknown) => typeof text !== 'string')) {
    throw new ProviderError({ code: 'server', message: '腾讯翻译返回的片段数量或格式异常', retryable: true });
  }
  positions.forEach(([i, j], index) => {
    const row = parts[i]!;
    const original = row[j]!;
    row[j] = (original.match(/^\s*/)?.[0] || '') + response.TargetTextList[index].trim() + (original.match(/\s*$/)?.[0] || '');
  });
  return parts.map((segments) => segments.join(''));
}

export default defineProvider({
  id: 'tencent', name: '腾讯云翻译（存量用户）', version: '1.0.3', kind: 'mt', official: true, usedFor: ['fast', 'combined'],
  auth: [
    { key: 'secretId', label: 'SecretId', required: true, helpUrl: 'https://console.cloud.tencent.com/cam/capi' },
    { key: 'secretKey', label: 'SecretKey', secret: true, required: true },
    { key: 'region', label: '地域', placeholder: 'ap-shanghai' },
    { key: 'monthlyQuota', label: '存量账户每月字符预算（0 为不调用）', type: 'number', required: true },
  ], defaults: { region: 'ap-shanghai', monthlyQuota: '0' },
  limits: { maxChars: 5000, maxSegments: 20, concurrency: 2, qps: 1 }, placeholders: 'strip-reinsert', mapLang, supports, translate, classifyError,
  cost: (req) => req.texts.reduce((sum, text) => sum + Array.from(stripPlaceholders(text)).length, 0),
});
