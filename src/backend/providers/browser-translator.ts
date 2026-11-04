/**
 * Chrome 官方：https://developer.chrome.com/docs/ai/translator-api
 * Edge 官方：https://learn.microsoft.com/microsoft-edge/web-platform/translator-api
 * 核实：2026-11-03。桌面 Chrome138+/Edge148+；无云 API 额度，语言包需浏览器准备。
 * Window 专属 API 不在 service worker 中伪调用，真实能力由注入的本机 bridge 检查。
 */
import { defineProvider, ProviderError, type ProviderContext } from './types';

const unavailable = (message: string) => new ProviderError({ code: 'no_provider', message, retryable: true });
function bridge(ctx: ProviderContext) {
  if (!ctx.builtin) throw unavailable('当前后台未连接浏览器内置翻译窗口，将使用其他服务');
  return ctx.builtin;
}
export default defineProvider({
  id: 'browser-translator', name: '浏览器内置翻译（Chrome / Edge）', version: '1.0.2', kind: 'builtin', official: true,
  usedFor: ['fast', 'combined'], auth: [], limits: { maxChars: 2000, maxSegments: 1, concurrency: 1 }, placeholders: 'prompt',
  async translate(request, ctx) {
    ctx.signal.throwIfAborted();
    const result = await bridge(ctx).translate(request, ctx.signal);
    ctx.signal.throwIfAborted();
    if (!Array.isArray(result) || result.length !== request.texts.length || result.some((text) => typeof text !== 'string' || !text.trim())) throw unavailable('浏览器内置翻译未返回完整结果');
    return result;
  },
  async health(ctx) {
    const start = performance.now();
    const source = ctx.config.probeSourceLang || 'en', target = ctx.config.probeTargetLang || 'zh-CN';
    const state = await bridge(ctx).availability(source, target, ctx.signal);
    if (state.status !== 'available') throw unavailable(state.reason || (state.status === 'downloadable' || state.status === 'downloading'
      ? `${source} → ${target} 的内置语言包尚未准备，请在设置→翻译服务→浏览器内置翻译的语言包卡片点击下载后再测试`
      : '此浏览器或语言对不支持内置翻译，将使用其他服务'));
    return { ok: true, latencyMs: performance.now() - start };
  },
  classifyError(error) {
    if (error instanceof ProviderError) return error.info;
    if (error instanceof DOMException && error.name === 'AbortError') return { code: 'cancelled', message: '浏览器内置翻译已取消', retryable: false };
    return { code: 'no_provider', message: '浏览器内置翻译当前不可用，将使用其他服务', retryable: true };
  },
});
