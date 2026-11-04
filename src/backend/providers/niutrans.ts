/**
 * 官方协议：https://niutrans.com/documents/contents/trans_json
 * 免费额度：https://niutrans.com/documents/contents/trans_text（每日 100 积分 = 200,000 字符）
 * 核实：2026-11-03。免费用户 5 QPS、单次最多 5000 字符。
 */
import { defineProvider, classifyError, ProviderError, responseJson } from './types';
import { stripPlaceholders } from '../../shared/placeholders';

const mapLang = (code: string): string => /^(zh|zh-CN|zh-Hans)$/i.test(code) ? 'zh'
  : /^(zh-TW|zh-HK|zh-Hant)$/i.test(code) ? 'cht' : (code.split('-')[0] ?? code).toLowerCase();

export default defineProvider({
  id: 'niutrans', name: '小牛翻译', version: '1.0.2', kind: 'mt', official: true, usedFor: ['fast', 'combined'],
  auth: [{ key: 'key', label: 'API Key', secret: true, required: true, helpUrl: 'https://niutrans.com/cloud/account_info/info' }],
  freeQuota: { unit: 'char', amount: 200_000, period: 'day' },
  limits: { maxChars: 4000, maxSegments: 20, concurrency: 2, qps: 5 }, placeholders: 'strip-reinsert', mapLang,
  async translate(req, ctx) {
    if (!ctx.config.key) throw new ProviderError({ code: 'auth', message: '请先配置小牛 API Key', retryable: false });
    // JSON 接口锁定键与层级，把标签留在本地，避免按叶子逐次请求浪费 QPS。
    const parts = req.texts.map((text) => text.split(/(<\/?g\d+>|<x\d+\/>)/g));
    const leaves: Record<string, string> = {};
    const positions: [number, number][] = [];
    parts.forEach((segments, i) => segments.forEach((leaf, j) => {
      if (j % 2 === 0 && leaf.trim()) { leaves[`s${positions.length}`] = leaf; positions.push([i, j]); }
    }));
    if (!positions.length) return req.texts.slice();
    const json = await responseJson(await ctx.fetch('https://api.niutrans.com/NiuTransServer/translationJson', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: mapLang(req.sourceLang), to: mapLang(req.targetLang), apikey: ctx.config.key, src_text: leaves }),
    }));
    if (json?.error_code) {
      const number = String(json.error_code);
      const code = number === '10001' ? 'rate_limit' : number === '13001' ? 'quota'
        : number === '13002' ? 'auth' : number === '13008' ? 'network'
        : ['10000', '10003', '10005', '13003', '13005', '13006', '13007', '000000', '000001'].includes(number) ? 'bad_input' : 'server';
      throw new ProviderError({ code, message: `小牛翻译请求失败（${code}）`, retryable: ['rate_limit', 'network', 'server'].includes(code) });
    }
    if (!json?.tgt_text || typeof json.tgt_text !== 'object' || Array.isArray(json.tgt_text)
      || Object.keys(json.tgt_text).length !== positions.length || positions.some((_, i) => typeof json.tgt_text[`s${i}`] !== 'string')) {
      throw new ProviderError({ code: 'server', message: '小牛翻译返回的 JSON 片段格式异常', retryable: true });
    }
    positions.forEach(([i, j], index) => {
      const row = parts[i]!;
      const original = row[j]!;
      row[j] = (original.match(/^\s*/)?.[0] || '') + json.tgt_text[`s${index}`].trim() + (original.match(/\s*$/)?.[0] || '');
    });
    return parts.map((segments) => segments.join(''));
  }, classifyError,
  cost: (req) => req.texts.reduce((sum, text) => sum + Array.from(stripPlaceholders(text)).length, 0),
});
