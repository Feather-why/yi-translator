/**
 * Google 网页接口（非官方），核实日期：2026-11-03。
 * 官方产品：https://translate.google.com/；官方开发接口：https://docs.cloud.google.com/translate/docs/api-overview
 * 此网页端点没有公开开发协议、免费额度或稳定性承诺；不得当作 Cloud Translation API。
 * 仅用户主动开启后兜底；固定每 5 秒最多一次，429 由调度器持久暂停。
 */
import { defineProvider, ProviderError, classifyError, responseJson } from '../types';

export default defineProvider({
  id: 'google-web', name: 'Google 网页翻译（可选兜底）', version: '1.0.0',
  kind: 'mt', official: false, usedFor: ['fast', 'combined'], auth: [],
  limits: { maxChars: 1000, maxSegments: 1, concurrency: 1, qps: 0.2 },
  placeholders: 'prompt', classifyError,
  async translate(request, context) {
    context.signal.throwIfAborted();
    if (request.texts.length !== 1 || !request.texts[0]?.trim() || request.targetLang === 'auto') {
      throw new ProviderError({ code: 'bad_input', message: 'Google 网页接口每次只接受一个非空片段及明确的目标语言', retryable: false });
    }
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    for (const [key, value] of Object.entries({ client: 'gtx', sl: request.sourceLang, tl: request.targetLang, dt: 't', q: request.texts[0] })) url.searchParams.set(key, value);
    const response = await context.fetch(url.href, { credentials: 'omit', redirect: 'error', signal: context.signal, timeoutMs: 8000 });
    if (response.status === 429) throw new ProviderError({ code: 'rate_limit', message: 'Google 网页接口返回 429，已暂停；请稍后在设置中手动恢复', retryable: false });
    const data: unknown = await responseJson(response);
    const rows: unknown = Array.isArray(data) ? data[0] : undefined;
    if (!Array.isArray(rows) || !rows.length || rows.some((row: unknown) => !Array.isArray(row) || typeof row[0] !== 'string')) {
      throw new ProviderError({ code: 'server', message: 'Google 网页接口返回格式变化，已改用其他翻译服务', retryable: false });
    }
    const text = rows.map((row: string[]) => row[0]).join('');
    if (!text.trim()) throw new ProviderError({ code: 'server', message: 'Google 网页接口没有返回译文', retryable: false });
    return [text];
  },
});
